// ═══════════════════════════════════════════════════════════════════
//  意圖識別（規則層）
//
//  目的：讓人可以直接 @Alice 講話，不必記 `/ra`、`/sa`、`answer Q-002` 這些
//  語法——那些是 pipeline 目錄結構長在使用者介面上，不是人的心智模型。
//
//  這一層刻意**只有規則、沒有 LLM**：
//    1. 規則能吃掉大部分流量，零延遲、零成本、零資料外流。
//    2. 沒接住的句子會被記錄下來（見 _recordIntentMiss_）。那份清單就是日後
//       設計 LLM 分類 prompt 的真實語料——憑想像寫的 prompt 一定是錯的。
//    3. slash command 一律保留，永遠不經過這一層：意圖層掛掉時系統還能用，
//       熟練使用者打指令也更快。
//
//  ⚠️ 規則接不住時的正確行為是**反問**，不是猜。猜錯會跑錯 pipeline，
//     那是不可逆的（會建分支、跑 agent、燒 runner）；反問只是多一次往返。
// ═══════════════════════════════════════════════════════════════════

const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/;

// 反查失敗時給出可行動的下一步。實務上幾乎都是 scope 沒補、或補了沒重新安裝 App。
const ROUTE_HINT = '請直接說單號（例：`@Alice VIPOP-12345 進度`），'
  + '或確認 Alice 有 `channels:history` 權限（改過 scope 後要重新安裝 App 才生效）。';

// full 要排在 sa / ra 之前判斷：「ra 到 sa 一路跑完」同時命中三者
const RE_FULL   = /(full|整套|全部跑|從頭跑|一路跑|端到端|ra\s*(到|＋|\+|and|then)\s*sa)/i;
const RE_SA     = /(\bsa\b|系統分析|系統設計|架構分析|拆\s*task|工項拆解|design\s*doc)/i;
const RE_RA     = /(\bra\b|需求分析|規格書|寫規格|產規格|\bspec\b|補問)/i;
const RE_STATUS = /(狀態|進度|跑到哪|到哪了|做完了嗎|完成了嗎|\bstatus\b|\bprogress\b)/i;

// 只有「整句就是一個狀態查詢」才優先當 status。
// 這是為了不讓「用 A 方案，因為進度上比較快」被誤判——那句含「進度」但不是查詢。
//
// ⚠️ 這條 regex 寧鬆勿緊，因為兩個方向的失敗代價不對稱：
//   認錯成 status → 使用者看到狀態摘要，再說一次就好（無副作用）
//   漏認成答覆   → 在決策 thread 裡問「跑到哪了」會被 dispatch 出去當成答覆
// 所以前綴與尾綴都允許組合（「這張單現在跑到哪了？」）。
// 前綴後面允許「的」：「這張單的進度」「它現在的狀態」都是很自然的問法，
// 而漏認的代價是把問句 dispatch 成答覆。
const RE_PURE_STATUS =
  /^((?:現在|目前|這張單|這單|這個單|它|他)\s*(?:的)?\s*){0,3}(狀態|進度|跑到哪|到哪|怎麼樣|怎樣|如何|status|progress)\s*((?:了|嗎|呢|如何|怎樣|怎麼樣|喔|吧|哦)\s*){0,2}[?？!！]*$/i;


function _extractJiraKey_(text) {
  const m = (text || '').toUpperCase().match(JIRA_KEY_RE);
  return m ? m[1] : '';
}


/**
 * 把一句自由文字分類成一個結構化意圖。
 *
 * provider 是必要的：判斷「thread 裡有沒有待決問題」要反查 thread 的第一則訊息。
 * 回傳 { action, jiraId, answerText, confidence, matchedBy, restate }
 * action ∈ empty | answer_question | run_ra | run_sa | run_full | status | unknown
 */
function classifyIntent(text, conv, provider) {
  const raw = (text || '').trim();
  if (!raw) {
    return { action: 'empty', jiraId: '', answerText: '', confidence: 'high', matchedBy: 'empty' };
  }

  const jiraInText = _extractJiraKey_(raw);
  const route = _resolveRouteFromThread_(conv, provider);
  // 反查失敗（讀不到 thread 第一則訊息）與「這個 thread 本來就沒有任務」是兩件
  // 完全不同的事，但都會讓 route 沒有單號。分開才給得出可行動的訊息。
  const routeFailed = !!(route && route.err);
  const routeJira = (route && route.j) ? route.j : '';

  // ── 規則 1：整句就是狀態查詢 ──────────────────────────────────
  // 排在答覆之前，否則在決策 thread 裡問「進度？」會被當成答覆送出去。
  if (RE_PURE_STATUS.test(raw)) {
    const jira = jiraInText || routeJira;
    return {
      action: jira ? 'status' : 'unknown',
      jiraId: jira,
      answerText: '',
      confidence: jira ? 'high' : 'low',
      matchedBy: routeFailed ? 'pure-status-route-failed' : 'pure-status',
      restate: jira ? '' : (routeFailed
        ? '我讀不到這個 thread 的第一則訊息，所以不知道這是哪張單。' + ROUTE_HINT
        : '你想查哪張單的狀態？')
    };
  }

  // ── 規則 2：thread 有待決問題 → 這句話極可能是答覆 ─────────────
  // 這是準確率最高的一條，因為它看的是**狀態**而不是語意：
  // 「用 A 方案」在決策 thread 裡是答覆，在空頻道裡毫無意義。
  // 句子自帶單號時不套用——那更像是要開新任務。
  if (routeJira && !jiraInText) {
    return {
      action: 'answer_question',
      jiraId: routeJira,
      answerText: raw,
      confidence: 'high',
      matchedBy: 'thread-has-pending'
    };
  }

  // ── 規則 3：有單號 + 動作關鍵字 ───────────────────────────────
  if (jiraInText) {
    if (RE_FULL.test(raw)) {
      return { action: 'run_full', jiraId: jiraInText, answerText: '', confidence: 'high', matchedBy: 'jira+full' };
    }
    if (RE_SA.test(raw)) {
      return { action: 'run_sa', jiraId: jiraInText, answerText: '', confidence: 'high', matchedBy: 'jira+sa' };
    }
    if (RE_RA.test(raw)) {
      return { action: 'run_ra', jiraId: jiraInText, answerText: '', confidence: 'high', matchedBy: 'jira+ra' };
    }
    if (RE_STATUS.test(raw)) {
      return { action: 'status', jiraId: jiraInText, answerText: '', confidence: 'high', matchedBy: 'jira+status' };
    }

    // 有單號但沒說要做什麼 → 反問，不要猜
    _recordIntentMiss_(raw, conv, 'jira-no-verb');
    return {
      action: 'unknown',
      jiraId: jiraInText,
      answerText: '',
      confidence: 'low',
      matchedBy: 'jira-no-verb',
      restate: `你想對 ${jiraInText} 做什麼？（需求分析 / 系統分析 / 查狀態）`
    };
  }

  // ── 沒接住：記錄語料 ─────────────────────────────────────────
  // 在 thread 內卻反查不到單號時，這是最常見的真正原因，直接講出來而不是說「沒把握」
  if (routeFailed) {
    return {
      action: 'unknown', jiraId: '', answerText: '', confidence: 'low',
      matchedBy: 'route-failed',
      restate: '我讀不到這個 thread 的第一則訊息，所以不知道這是哪張單。' + ROUTE_HINT
    };
  }
  _recordIntentMiss_(raw, conv, 'no-match');
  return { action: 'unknown', jiraId: '', answerText: '', confidence: 'low', matchedBy: 'no-match', restate: '' };
}


/**
 * 依意圖派發。這一層只做路由，實際動作全部交給既有的 handler——
 * 意圖層錯了最多是走錯 handler，不會產生新的失敗模式。
 */
function routeByIntent(text, conv, userId, provider) {
  const intent = classifyIntent(text, conv, provider);
  console.log('意圖分類：' + JSON.stringify(intent));

  switch (intent.action) {
    case 'answer_question':
      // handleTextAnswer 自己會再查一次 progress.json 確認有沒有待答的題，
      // 所以這裡判斷錯了也不會亂寫——最壞情況是回一句「目前沒有待回覆的問題」。
      handleTextAnswer(intent.answerText, conv, userId, provider);
      return;

    case 'run_ra':
      _triggerPipelineTask_('ra-pipeline', intent.jiraId, conv, userId, provider);
      return;

    case 'run_sa':
      _triggerPipelineTask_('sa-pipeline', intent.jiraId, conv, userId, provider);
      return;

    case 'run_full':
      _triggerPipelineTask_('full-pipeline', intent.jiraId, conv, userId, provider);
      return;

    case 'status':
      handleStatusQuery(intent.jiraId, conv, userId, provider);
      return;

    default:
      provider.postMessage(conv.channel, _intentHelpText_(userId, intent), conv.thread);
  }
}


function _intentHelpText_(userId, intent) {
  const head = intent.restate
    ? `<@${userId}> ${intent.restate}`
    : `<@${userId}> 這句我沒把握，怕猜錯跑錯流程，先跟你確認。`;

  return [
    head,
    '',
    '可以這樣說：',
    '• `@Alice 幫 VIPOP-12345 寫規格書`（需求分析）',
    '• `@Alice VIPOP-12345 做系統分析`',
    '• `@Alice VIPOP-12345 進度`（查狀態）',
    '• 在決策卡片的 thread 裡直接回覆你的決定',
    '',
    '或用指令：`/ra <單號>`、`/sa <單號>`'
  ].join('\u000a');
}


// ═══════════════════════════════════════════════════════════════════
//  未命中語料
//
//  這是這一層最有價值的產出。兩週後在 GAS 編輯器手動執行 dumpIntentMisses()，
//  就會拿到一份「同仁實際怎麼講話、而規則接不住」的清單。到那時候再決定要不要
//  接 LLM、要接哪個模型、prompt 怎麼寫——都會比現在憑空設計準得多。
//  有可能結論是「再加三條規則就夠了」。
// ═══════════════════════════════════════════════════════════════════

const INTENT_MISS_KEY = 'intent_misses';
const INTENT_MISS_MAX = 60;      // ScriptProperties 單筆上限 9 KB，一筆約 140 bytes

function _recordIntentMiss_(text, conv, reason) {
  try {
    const props = PropertiesService.getScriptProperties();
    let list = [];
    try {
      list = JSON.parse(props.getProperty(INTENT_MISS_KEY) || '[]');
      if (!Array.isArray(list)) list = [];
    } catch (err) {
      list = [];
    }

    list.push({
      t: new Date().toISOString(),
      why: reason,
      s: String(text).slice(0, 120),
      ch: conv && conv.channel ? conv.channel : '',
      th: conv && conv.thread ? '1' : '0'
    });

    if (list.length > INTENT_MISS_MAX) list = list.slice(-INTENT_MISS_MAX);
    props.setProperty(INTENT_MISS_KEY, JSON.stringify(list));
  } catch (err) {
    // 記錄失敗不該影響回覆使用者
    console.error('記錄意圖 miss 失敗:', err);
  }
}

/** 在 GAS 編輯器裡手動執行，把累積的未命中語料印到執行記錄。 */
function dumpIntentMisses() {
  const raw = PropertiesService.getScriptProperties().getProperty(INTENT_MISS_KEY) || '[]';
  let list = [];
  try { list = JSON.parse(raw); } catch (err) { list = []; }

  if (!list.length) {
    console.log('目前沒有未命中的語料。');
    return;
  }

  console.log(`未命中語料共 ${list.length} 筆（新到舊）：`);
  list.slice().reverse().forEach(function (m, i) {
    console.log(`${i + 1}. [${m.t}] (${m.why}${m.th === '1' ? ', in-thread' : ''}) ${m.s}`);
  });
}

/** 語料看完、規則調整過之後用這支清掉，重新開始收集。 */
function clearIntentMisses() {
  PropertiesService.getScriptProperties().deleteProperty(INTENT_MISS_KEY);
  console.log('已清空未命中語料。');
}
