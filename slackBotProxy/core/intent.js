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

// 單號樣式只留一份，在 core/decision.js（JIRA_IN_TEXT_RE）。這裡曾經有一份
// 一模一樣的複本，而複本的代價是實測出來的：那邊補上「不可以是 ask 提問編號的
// 前綴」的斷言時，這邊不會跟著改，於是「thread 反查」與「句子裡撈單號」對同一
// 串字會給出不同答案——而那種不一致只會在某一條路徑上發作，很難查。
function _extractJiraKey_(text) {
  const m = (text || '').toUpperCase().match(JIRA_IN_TEXT_RE);
  return m ? m[1] : '';
}


/**
 * 準備事實 → 交給分類器判斷。**無副作用**，可安全地在測試裡重複呼叫。
 *
 * 回傳的意圖契約（每個分類器都必須回這個形狀）：
 *   {
 *     action,       // empty | answer_question | ask_followup | run_ra | run_sa |
 *                   // run_full | run_ut | status | unknown
 *     jiraId,
 *     answerText,   // action = answer_question / ask_followup 時的原句
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
    // 「這一串是 ask 串」是分類器唯一需要知道的事——續問要接哪一支分支由
    // handleAskRequest 自己反查（同一份快取，不會多打 API）。分類器拿不到
    // 編號也不需要：它只決定走哪一條路。
    askThread: !!(route && route.kind === 'ask'),
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
 *
 * files：他這則訊息附的檔案（已正規化，見 core/files.js）。路由層必須原樣傳下去
 * ——走 `@Alice ask …` 有附件、走「幫我查一下…」沒有，會是最莫名其妙的行為差異。
 */
function routeByIntent(text, conv, userId, provider, files) {
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

    case 'ask_followup':
      // ask 串裡的任何一句都是追問。不經過 _askAllowed_ 的密語判斷是刻意的：
      // handleAskRequest 自己會做，而它套用的是同一條豁免（這串受理過就不再
      // 要密語）——在這裡先判一次只會多打一次反查，還可能給出不一致的答案。
      handleAskRequest(intent.answerText, conv, userId, provider, files);
      return;

    case 'run_ra':
      _triggerPipelineTask_('ra-pipeline', intent.jiraId, conv, userId, provider, files);
      return;

    case 'run_sa':
      _triggerPipelineTask_('sa-pipeline', intent.jiraId, conv, userId, provider, files);
      return;

    case 'run_full':
      _triggerPipelineTask_('full-pipeline', intent.jiraId, conv, userId, provider, files);
      return;

    // 單元測試委派。與上面三條唯一的差別是 pipeline 名稱——augma 那側的
    // ut-pipeline 自己會先確認 SA 跑完了才往下走，不必在這裡先查一次。
    // 這裡多查等於把 augma 的狀態機知識複製一份到 GAS，兩邊遲早會不一致。
    case 'run_ut':
      _triggerPipelineTask_('ut-pipeline', intent.jiraId, conv, userId, provider, files);
      return;

    case 'status':
      handleStatusQuery(intent.jiraId, conv, userId, provider);
      return;

    case 'usage':
      handleUsageQuery(conv, userId, provider);
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
      provider.postIntentHelp(conv, {
        text: _intentHelpText_(provider, userId, intent),
        // 空字串＝不附按鈕。卡片長什麼樣、value 怎麼編碼都是 provider 的事
        // （見 providers/slack.js 的 postIntentHelp）——core 只決定「要不要給」。
        offerKey: offerAsk ? _stashAskOffer_(text, files) : ''
      });
    }
  }
}


// 原句存 CacheService、只把快取鍵交給 provider。
//
// TTL 15 分鐘：這是「看到反問、決定要不要送」的合理猶豫時間，超過就讓他重講
// 一次，而不是送出一句他早就忘了的話。這是業務決策，所以留在 core——按鈕長
// 什麼樣、value 怎麼編碼（上限 2000 字元，所以只放得下快取鍵）才是 provider
// 的事，見 providers/slack.js 的 _askOfferBlocks_。
const ASK_OFFER_TTL = 900;

// ⚠️ 附件要跟著原句一起存。不存的話，「貼一張圖 ＋ 一句規則接不住的話 ＋ 按下
//    按鈕」會送出一個**沒有附件**的提問，而人完全看不出附件掉了——它就在他自己
//    那則訊息裡看得見，於是他會認為 agent 看過那張圖然後亂答。
//
//    值改成 JSON（{ text, files }），但讀回來時要能吃舊格式：15 分鐘 TTL 內
//    可能有部署前寫進去的純字串。
function _stashAskOffer_(rawText, files) {
  const key = 'askq_' + Utilities.getUuid();
  const value = JSON.stringify({
    text: String(rawText || ''),
    files: (files && files.length) ? files : undefined
  });
  CacheService.getScriptCache().put(key, value, ASK_OFFER_TTL);
  return key;
}


// 讀回 _stashAskOffer_ 存的東西。回 null 代表過期或已經按過。
//
// 吃兩種格式：JSON（現行）與純字串（部署前寫進去的）。分不出來就當純字串——
// 那是舊格式唯一可能的形狀，而猜錯的代價只是少了附件，不是整句話送不出去。
function _readAskOffer_(key) {
  const raw = key ? CacheService.getScriptCache().get(key) : null;
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object' && typeof o.text === 'string') return o;
  } catch (e) { /* 舊格式：純字串 */ }
  return { text: String(raw), files: undefined };
}


function _intentHelpText_(provider, userId, intent) {
  const who = provider.mention(userId);
  const head = intent.restate
    ? `${who} ${intent.restate}`
    : `${who} 這句我沒把握，怕猜錯跑錯流程，先跟你確認。`;

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


// ═══════════════════════════════════════════════════════════════════
//  Gemini 影子分類——只記錄、只回報，不接執行
//
//  掛在 slackBotProxy.js 的 _routeMentionEvent_ 最尾端（switch 執行完之後）：
//  不管這句話最後是哪個已知指令、還是走了 routeByIntent，都額外跑一次 Gemini
//  flash-lite 分類，貼出來給人肉眼核對「Gemini 猜得準不準」。
//
//  ⚠️ 從頭到尾**只讀不寫**：不會影響 knownCmd／routeByIntent 已經做的任何決定，
//     這裡拿到的 result 只拿去記錄與回覆，不會被拿去 dispatch 任何 pipeline。
//     真的要把 LLM 接進生產路由是另一個決定（core/classifiers/llm.js，尚未做）。
//
//  ⚠️ 整支包在 try/catch：這是掛在**所有** @Alice 訊息尾端的旁支功能，
//     Gemini 配額用完、UrlFetchApp 逾時、JSON 格式跑掉都不能讓主流程（已經
//     執行完的 ra/sa/ask/…）看起來像失敗了。
// ═══════════════════════════════════════════════════════════════════

const GEMINI_SHADOW_LOG_KEY = 'gemini_shadow_log';
const GEMINI_SHADOW_LOG_MAX = 60;     // 同 INTENT_MISS_MAX 的理由：ScriptProperties 單筆 9KB 上限

// 每分鐘上限，抓保守值——免費配額被一波洗版式的訊息燒光，比少幾筆觀察資料更糟。
const GEMINI_SHADOW_RATE_KEY = 'gemini_shadow_rate';
const GEMINI_SHADOW_RATE_LIMIT = 10;

function runGeminiShadow_(text, conv, userId, provider, knownCmd) {
  try {
    if (!_geminiShadowRateOk_()) return;   // 超過上限就整段跳過，不記錄、不報錯

    const raw = _toHalfWidth_(text || '').trim();
    const jiraInText = _extractJiraKey_(raw);
    const result = classifyWithGeminiShadow(raw, jiraInText);

    // 記脫敏後的文字（result.sanitized），不是原句：這份 log 的用途之一就是
    // 核對脫敏有沒有生效，記原句等於自己把要防的東西寫進另一個地方。
    // 'no-key'／'empty' 沒有 sanitized（根本沒跑到脫敏），退回記原句方便追蹤。
    _recordGeminiShadow_(result.sanitized || raw, conv, knownCmd, result);

    // 失敗（沒設金鑰／配額用完／逾時／格式跑掉）一律靜默：這些在免費配額下是
    // 常態而不是意外，每次都回一則錯誤訊息只會把頻道洗成雜訊。只有成功拿到
    // 合法分類才回覆，讓使用者知道這句話「有」被觀察到、觀察的結果是什麼。
    if (result.error) return;

    // 附上脫敏後實際送出去的內容，讓人能在 Slack 上直接核對「有沒有真的把
    // 程式碼擋下來」，不用只靠信任單元測試——這正是免費 key 會被拿去訓練這件事
    // 最在意的一環。result.sanitized 一定有值（走到這裡代表 API 真的打過了）。
    provider.postMessage(
      conv.channel,
      'Gemini 意圖分析判定為：' + result.category +
        (result.reason ? '（' + result.reason + '）' : '') +
        '\n脫敏後送出：' + result.sanitized,
      _replyTarget_(conv)
    );
  } catch (err) {
    console.error('Gemini 影子分類整體失敗（不影響主流程）:', err);
  }
}

function _geminiShadowRateOk_() {
  const cache = CacheService.getScriptCache();
  const n = parseInt(cache.get(GEMINI_SHADOW_RATE_KEY) || '0', 10);
  if (n >= GEMINI_SHADOW_RATE_LIMIT) return false;
  cache.put(GEMINI_SHADOW_RATE_KEY, String(n + 1), 60);
  return true;
}

// 記 knownCmd 當 ground truth（已知指令本身的名稱；落到 routeByIntent 的自由
//文字則記 '(intent)'），才能跟 result.category 並排比對「Gemini 猜得準不準」。
// 刻意不在這裡重新跑一次規則分類器：routeByIntent 執行當下已經算過一次真正的
// 判斷了，這裡只是要留下「這句話最後被系統怎麼處理」這個粗粒度資訊，重新計算
// 只是白付一次成本。
function _recordGeminiShadow_(text, conv, knownCmd, result) {
  try {
    const props = PropertiesService.getScriptProperties();
    let list = [];
    try {
      list = JSON.parse(props.getProperty(GEMINI_SHADOW_LOG_KEY) || '[]');
      if (!Array.isArray(list)) list = [];
    } catch (err) {
      list = [];
    }

    list.push({
      t: new Date().toISOString(),
      cmd: knownCmd || '',
      cat: result.category || '',
      err: result.error || '',
      s: String(text).slice(0, 120),
      ch: conv && conv.channel ? conv.channel : '',
      th: conv && conv.thread ? '1' : '0'
    });

    if (list.length > GEMINI_SHADOW_LOG_MAX) list = list.slice(-GEMINI_SHADOW_LOG_MAX);
    props.setProperty(GEMINI_SHADOW_LOG_KEY, JSON.stringify(list));
  } catch (err) {
    console.error('記錄 Gemini 影子分類失敗:', err);
  }
}

/** 在 GAS 編輯器裡手動執行，把累積的 Gemini 影子分類記錄印到執行記錄。 */
function dumpGeminiShadowLog() {
  const raw = PropertiesService.getScriptProperties().getProperty(GEMINI_SHADOW_LOG_KEY) || '[]';
  let list = [];
  try { list = JSON.parse(raw); } catch (err) { list = []; }

  if (!list.length) {
    console.log('目前沒有 Gemini 影子分類記錄。');
    return;
  }

  console.log(`Gemini 影子分類記錄共 ${list.length} 筆（新到舊）：`);
  list.slice().reverse().forEach(function (m, i) {
    const verdict = m.err ? ('❌ ' + m.err) : ('→ ' + m.cat);
    console.log(`${i + 1}. [${m.t}] 已知路徑=${m.cmd || '(intent)'}  ${verdict}${m.th === '1' ? ' (in-thread)' : ''}  「${m.s}」`);
  });
}

/** 記錄看完之後用這支清掉，重新開始收集。 */
function clearGeminiShadowLog() {
  PropertiesService.getScriptProperties().deleteProperty(GEMINI_SHADOW_LOG_KEY);
  console.log('已清空 Gemini 影子分類記錄。');
}
