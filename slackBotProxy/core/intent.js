// ═══════════════════════════════════════════════════════════════════
//  意圖路由層
//
//  職責邊界（這是這次重構的重點）：
//
//    這一層（router）        分類器（core/classifiers/*）
//    ─────────────────────  ──────────────────────────────
//    準備事實：正規化、撈    只做判斷，吃 ctx 回 intent
//    單號、反查 thread       **純函式**：不打網路、不寫狀態
//    記錄「沒接住」的語料
//    依 action 派發
//
//  為什麼要這樣切：以前 classifyIntent 裡面同時做網路 I/O（反查 thread）與
//  持久化（寫 miss 語料）。那讓「換一個分類器」實際上變成「連副作用一起複製
//  一份」——LLM 版**也**需要單號反查，卻不該再實作一次。
//
//  副作用移出來還順手修掉一個浪費：反查以前會做兩次（分類器一次、
//  handleTextAnswer 再一次）。成功時第二次只是多讀一次 CacheService，但**反查
//  失敗時不進快取**，於是缺 channels:history 的情況下每則訊息真的會打兩次
//  Slack API、兩次都失敗。現在 router 做一次、結果往下傳。
//
//  slash command 一律不經過這一層（見 slackBotProxy.js 的 default 分支）：
//  意圖層掛掉時系統還能用，熟練使用者打指令也更快。
// ═══════════════════════════════════════════════════════════════════

const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/;


function _extractJiraKey_(text) {
  const m = (text || '').toUpperCase().match(JIRA_KEY_RE);
  return m ? m[1] : '';
}


/**
 * 準備事實 → 交給分類器判斷。**無副作用**，可安全地在測試裡重複呼叫。
 *
 * 回傳的意圖契約（每個分類器都必須回這個形狀）：
 *   {
 *     action,       // empty | answer_question | run_ra | run_sa | run_full | status | unknown
 *     jiraId,
 *     answerText,   // action = answer_question 時的原句
 *     items,        // 正規化後的答案 [{ qid, answerText }]。
 *                   // 規則層一律 null＝「我沒解析，交給下游」。
 *                   // 放在意圖契約裡而不是純粹留給下游，是因為 LLM 版可以
 *                   // 一次呼叫同時產出 action 與正規化結果（它手上已經有句子、
 *                   // thread 狀態、待答題清單）——拆成兩次呼叫是白付一次延遲與成本。
 *     confidence,   // high | low
 *     matchedBy,    // provenance：'pure-status' | 'thread-has-pending' | 'llm' | …
 *     restate       // 反問用的「我理解成…」
 *   }
 */
function classifyIntent(text, conv, provider) {
  return getClassifier().classify(_buildIntentCtx_(text, conv, provider));
}


/**
 * 把分類器需要的事實準備好。反查在這裡做**一次**，結果隨 ctx 往下傳到
 * handleTextAnswer——以前那邊會自己再查一次，成功時只是多讀一次 CacheService，
 * 但反查失敗時（缺 channels:history）不進快取，於是每則訊息真的會打兩次
 * Slack API，然後兩次都失敗。
 */
function _buildIntentCtx_(text, conv, provider) {
  // 全形轉半形要在**所有**判斷之前：「第一題選Ａ」的 Ａ 是 U+FF21，
  // 不轉的話後面每一層的字元比對都會失敗，而且失敗得很安靜。
  const raw = _toHalfWidth_(text || '').trim();
  const route = _resolveRouteFromThread_(conv, provider);

  return {
    raw: raw,
    jiraInText: _extractJiraKey_(raw),
    route: route,
    // thunk 而不是值：它背後是 fetchProgress（一次網路呼叫）。規則層完全不需要
    // 它，不該為了統一介面就每次都付那個成本。
    getPending: function () {
      const jira = (route && route.j) ? route.j : '';
      if (!jira) return [];
      const progress = fetchProgress(jira);
      return ((progress && progress.pending_questions) || []).filter(function (q) {
        return q && !q.answered;
      });
    }
  };
}


// 真正「規則沒接住、值得收進語料」的命中原因。
//
// 刻意不含 route-failed / pure-status-route-failed：那是 scope 或 token 的問題
// （讀不到 thread 第一則訊息），不是「人這樣講話而規則接不住」。混進去只會讓
// 語料被基礎設施故障洗版，而那份語料唯一的用途就是判斷要不要接模型。
const GENUINE_MISS = ['no-match', 'jira-no-verb', 'verb-no-jira', 'answer-unparsed'];


/**
 * 依意圖派發。這一層只做路由，實際動作全部交給既有的 handler——
 * 意圖層錯了最多是走錯 handler，不會產生新的失敗模式。
 */
function routeByIntent(text, conv, userId, provider) {
  const ctx = _buildIntentCtx_(text, conv, provider);
  const intent = getClassifier().classify(ctx);
  console.log('意圖分類：' + JSON.stringify(intent));

  // 記錄「沒接住」是**路由層**的職責：只有它知道最終 outcome。
  // 之後串上 LLM fallback 時，被模型接住的句子不該進語料，而分類器自己
  // 判斷不了這件事——它不知道自己是不是最後一棒。
  if (intent.action === 'unknown' && GENUINE_MISS.indexOf(intent.matchedBy) >= 0) {
    _recordIntentMiss_(text, conv, intent.matchedBy);
  }

  switch (intent.action) {
    case 'answer_question':
      // route 已經反查過了，往下傳避免再打一次 Slack API。
      // handleTextAnswer 自己會再查一次 progress.json 確認有沒有待答的題，
      // 所以這裡判斷錯了也不會亂寫——最壞情況是回一句「目前沒有待回覆的問題」。
      handleTextAnswer(intent.answerText, conv, userId, provider, {
        route: ctx.route,
        // 貼上的補問清單自帶單號，即使不在 thread 裡也認得出是哪張單。
        // 沒有它的話，貼到頻道（而不是 thread）就會被回「這裡沒有待決問題」。
        jiraId: intent.jiraId,
        items: intent.items
      });
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

    default: {
      // 規則真的沒聽懂時，多給一顆「當成一般提問送出」的按鈕。
      //
      // 為什麼是按鈕而不是自動放行：規則層分不出「這是給 agent 的任務」與
      // 「這是人在聊天」——`幫我查ui的code` 與 `今天天氣真好` 的分類結果完全
      // 一樣（都是 no-match）。自動放行等於閒聊也燒掉一個 runner。
      // 按鈕保留了「不猜」這個原則，同時讓那個能力離一次點擊。
      //
      // 只在 no-match 時給。其餘的 unknown 都有更具體的下一步：
      //   jira-no-verb / verb-no-jira → 反問缺的那一半，補上就能跑對的流程
      //   route-failed                → 那是缺 scope，丟給 agent 也解決不了
      // 還要通過通關密語：測試期間沒有密語的人按了也會被擋，
      // 附一顆按不動的按鈕只會讓人以為壞了。conv / provider 要一起傳——
      // ask thread 內的追問是靠「這串受理過」豁免密語的，不傳就會在最需要
      // 這顆按鈕的地方（追問時只打了「再試一次」）反而不附。
      const offerAsk = (intent.matchedBy === 'no-match') && _askAllowed_(text, conv, provider);
      const blocks = offerAsk ? _askOfferBlocks_(text, conv, userId) : null;
      provider.postMessage(conv.channel, _intentHelpText_(userId, intent), _replyTarget_(conv), blocks);
    }
  }
}


// 按鈕的 value 上限 2000 字元，而使用者那句話可能很長——所以 value 只放
// 快取鍵，原句存 CacheService。TTL 15 分鐘：這是「看到反問、決定要不要送」
// 的合理猶豫時間，超過就讓他重講一次，而不是送出一句他早就忘了的話。
const ASK_OFFER_TTL = 900;

function _askOfferBlocks_(rawText, conv, userId) {
  const key = 'askq_' + Utilities.getUuid();
  CacheService.getScriptCache().put(key, String(rawText || ''), ASK_OFFER_TTL);
  return [
    { type: 'section', text: { type: 'mrkdwn', text: '_或者，我可以直接當成一般提問去查：_' } },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '\uD83D\uDD0D 當成一般提問送出', emoji: true },
        action_id: 'ask_confirm',
        // kind 是必要的：parseInteraction 以前靠 question_id 判斷這是決策按鈕，
        // 多一種按鈕之後就分不出來了（見 handleInteraction 開頭的分岔）
        value: JSON.stringify({ kind: 'ask_confirm', k: key })
      }]
    }
  ];
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
    '• 在補問清單按「複製」，整份貼進決策卡片的 thread（一次回答多題）',
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
//
//  `verb-no-jira` 正是那個結論的第一個例子：`@Alice 幫我RA流程` 看起來像
//  「需要 LLM 才接得住的自然語言」，實際上規則只是缺了對稱的那一半，五行就解決。
//  所以**先看語料再談模型**，不要反過來。
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
