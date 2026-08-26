

// ═══════════════════════════════════════════════════════════════════
//  反查「這個 thread 屬於誰」
//
//  ⚠️ 這裡沒有任何持久狀態，是刻意的。
//
//  出向（貼卡片）已拆到 messageDispatch 專案，而 ScriptProperties 是 per-script
//  的——兩個 GAS 專案完全不共用。所以「貼卡片時記下 thread 對應哪張單、答覆時
//  讀出來」一拆就壞：寫在那邊，這邊讀不到。
//
//  正解不是找一個共享儲存，而是不要有狀態：thread 的第一則訊息本來就帶著單號
//  （任務受理訊息、決策卡片的 summary 都有），反查它即可；其餘一切——pipeline、
//  有哪些題、誰答過——都在 augma 的 progress.json 裡，那份有版控、是唯一真相。
//
//  CacheService 只是純快取：thread root 永遠不會變，同一個 thread 的第二次回覆
//  就不必再打一次 Slack API。掉了隨時可重建，所以不是狀態。
//
//  ⚠️ thread 的歸屬有**兩種**，而且必須在同一個函式裡決定：
//
//    任務串  第一則訊息帶 JIRA 單號（受理訊息、決策卡片 summary、人打的
//            `@Alice ra VIPOP-46703`）→ 串裡的話是「答覆待決問題」
//    ask 串  Alice 的看板標題帶提問編號 `<uid>-8碼-6碼`（＝分支名 ask/<id>）
//            → 串裡的話是「同一支分支的追問」
//
//  拆成兩個函式各自反查、各自快取的話，會出現「這一則判成 ask、下一則判成
//  任務」——同一串的歸屬在兩次 HTTP 請求之間跳掉。實測踩過的形狀是這樣：
//  `@Alice ask VIPOP-46703 的規格寫到哪`，第一則（人那句）**帶著單號**，
//  於是單號反查成功、ask 反查根本不會被呼叫，整串被當成 VIPOP-46703 的決策
//  thread，之後每一句追問都被當成答覆送去 dispatch。
//  所以 ask 優先：那個單號是提問**內容**，不是這串的歸屬。
// ═══════════════════════════════════════════════════════════════════

const ROUTE_CACHE_TTL = 21600;   // 6 小時，CacheService 上限
// 快取鍵刻意從 `route_` 換成 `rt2_`：舊鍵裡可能存著被截斷的假單號（見
// JIRA_IN_TEXT_RE 的說明），而它會活 6 小時。換鍵等於部署即失效，不必等它過期，
// 也不必寫相容邏輯去分辨新舊格式。
const ROUTE_CACHE_PREFIX = 'rt2_';
// 答案去重鎖的存活時間。與 ROUTE_CACHE_TTL 同值但意義完全不同：route 掉了可以
// 重建，這一把掉了同一題就能被重複回答一次。按鈕路徑與文字路徑共用同一把。
const ANSWER_CACHE_TTL = 21600;

// JIRA 單號。尾端的 `(?!-\d)` 是實戰換來的，不是防禦性寫法：
// ask 的提問編號長成 `U0BP6PJQGKB-20260820-132620`，而它的前半段剛好符合單號
// 形狀——`-` 是非 word 字元，所以 `\b` 在那裡**成立**。沒有這個斷言，ask 串會被
// 反查成一張根本不存在的單 `U0BP6PJQGKB-20260820`，然後：
//   規則 3（thread 有待決問題）命中 → 每句話都被判成答覆，信心 high
//   → handleTextAnswer 讀不到那張單的 progress.json
//   → 回一句「暫時讀不到流程狀態，請改成明確指定題號」
// 人只是在 ask 串裡說「再試一次」，卻被要求指定題號。錯得離事發點很遠，
// 所以修在最上游。
const JIRA_IN_TEXT_RE = /\b([A-Z][A-Z0-9]+-\d+)\b(?!-\d)/;

// 提問編號（＝分支名 ask/<id> 的後半段）。樣式要夠緊，否則會把別的 thread 認成
// ask 串：這裡要求 `-8位數-6位數` 兩段，與 JIRA 單號（VIPOP-46703）無交集。
const ASK_ID_IN_TEXT_RE = /([A-Za-z0-9]+-[0-9]{8}-[0-9]{6})/;

// 「第一則訊息就是 ask 的觸發句」。需要它的唯一理由是上面那個
// `@Alice ask VIPOP-46703 …` 的情況：單號反查會成功，但那串其實是 ask 串。
// Slack 傳回的原文帶著 `<@U…>` 形式的 mention，所以前綴要允許它。
const ASK_TRIGGER_IN_ROOT_RE = /^\s*(?:<@[^>]+>\s*)*ask\b/i;

// 回傳 null＝根本不在 thread 裡（正常情況，不是錯誤）。
// 回傳 { j: '', ask: '', err: '<原因>' }＝在 thread 裡但反查不出歸屬——這種情況要
// 讓使用者知道原因，最常見的是缺 channels:history scope。
// 把失敗的參數記下來（覆蓋式，只留最後一筆），讓 diagnoseSlackAccess() 能用
// 同一組 channel / thread_ts 重打一次 Slack API 並印出完整回應。否則使用者只
// 看到「讀不到第一則訊息」，無從分辨是 scope 沒生效、token 沒更新，還是 Alice
// 不在那個頻道——這三種的修法完全不同。
function _routeFail_(channel, thread, err) {
  try {
    PropertiesService.getScriptProperties().setProperty('last_route_fail', JSON.stringify({
      ch: channel, ts: thread, err: err, at: new Date().toISOString()
    }));
  } catch (e) {
    // 記錄失敗不該影響主流程
  }
  return { kind: '', j: '', ask: '', err: err };
}


/**
 * 取整串訊息（由舊到新，每則帶 bot 旗標）。
 *
 * 兩支 provider 介面都吃：fetchThreadTexts 是完整的那個（ask 串要看 Alice 自己
 * 的看板才認得出來，那不會是第一則），fetchThreadRoot 只夠反查單號。
 * SlackProvider 兩支都有，而且同一次執行內共用同一次 API 呼叫（見
 * providers/slack.js 的 THREAD_FETCH_MEMO），所以先問哪一支都不會多打網路。
 *
 * 回傳 undefined＝這個 provider 沒有反查能力（googleChat 目前就是），
 * null＝讀得到介面但讀不到內容（scope／token／網路）。兩者的下一步不同。
 */
function _threadMessages_(channel, thread, provider) {
  if (provider && provider.fetchThreadTexts) {
    return provider.fetchThreadTexts(channel, thread);
  }
  if (provider && provider.fetchThreadRoot) {
    const root = provider.fetchThreadRoot(channel, thread);
    if (root === null) return null;
    // 只有第一則、而且一定不是 Alice 發的（bot 旗標要靠整串那支才拿得到），
    // 所以這條路認得出任務串、認不出 ask 串。
    return root ? [{ text: root, bot: false }] : [];
  }
  return undefined;
}


function _resolveRouteFromThread_(conv, provider) {
  const channel = conv && conv.channel;
  // 只認真正的 thread_ts。舊版把 channel 當 fallback，但拿 channel id 去問
  // conversations.replies 沒有意義，只是白打一次 API。
  const thread = conv && conv.thread;
  if (!channel || !thread) return null;

  const cache = CacheService.getScriptCache();
  const ck = ROUTE_CACHE_PREFIX + thread;
  const hit = cache.get(ck);
  if (hit) {
    return (hit.indexOf('a:') === 0)
      ? { kind: 'ask',  j: '', ask: hit.slice(2) }
      : { kind: 'jira', j: hit.slice(2), ask: '' };
  }

  const msgs = _threadMessages_(channel, thread, provider);
  if (msgs === undefined) return { kind: '', j: '', ask: '', err: 'no-provider' };
  if (msgs === null) return _routeFail_(channel, thread, 'fetch-failed');   // scope／token／網路
  if (!msgs.length) return _routeFail_(channel, thread, 'empty-root');      // 讀到了但沒訊息

  const root = String((msgs[0] && msgs[0].text) || '');
  if (!root) return _routeFail_(channel, thread, 'empty-root');

  const jiraHit = root.toUpperCase().match(JIRA_IN_TEXT_RE);
  const jira = jiraHit ? jiraHit[1] : '';

  // 只在「可能是 ask 串」時才掃整串找提問編號。三種可能，都判得出來：
  //   ① 第一則就是看板 → 用 /ask 指令起頭的那種（沒有訊息可以掛，Alice 自己起串）
  //   ② 第一則是 `@Alice ask …` → Alice 回在他那則底下，所以人那句是第一則
  //   ③ 反查不到單號 → 按鈕送出的 ask（第一則是那句沒被規則接住的話）
  // 反過來說，`@Alice ask …` 打在**決策 thread 裡**時三條都不成立（第一則是
  // 受理訊息／卡片 summary），所以那串不會因為多了一則 ask 看板就變成 ask 串——
  // 這正是要用「第一則」而不是「串裡有沒有」來判斷歸屬的原因。
  const askRoot = ASK_ID_IN_TEXT_RE.test(root) || ASK_TRIGGER_IN_ROOT_RE.test(root);
  if (askRoot || !jira) {
    const askId = _scanAskId_(msgs);
    if (askId) {
      cache.put(ck, 'a:' + askId, ROUTE_CACHE_TTL);
      return { kind: 'ask', j: '', ask: askId };
    }
    // 第一則就是 ask 的觸發句，但看板還沒推上來（Alice 的訊息此刻還是「正在查…」）。
    // 歸屬不能等看板：`@Alice ask VIPOP-46703 的規格寫到哪` 的第一則帶著單號，
    // 這時若退回去當任務串，那個判斷還會被快取六小時——整串從此把追問當成答覆。
    // 所以照樣認定是 ask 串，只是沒有編號＝當新的一輪；而且**不快取**，
    // 看板一到就接得起來。
    if (askRoot) return { kind: 'ask', j: '', ask: '' };
  }

  if (!jira) {
    console.log('thread 第一則訊息裡沒有單號：' + root.slice(0, 120));
    return _routeFail_(channel, thread, 'no-jira-in-root');
  }

  cache.put(ck, 'j:' + jira, ROUTE_CACHE_TTL);
  return { kind: 'jira', j: jira, ask: '' };
}


/**
 * 從整串裡撈提問編號。
 *
 * ⚠️ 只認 Alice 自己發的訊息（bot 旗標）。提問編號會直接變成 git 分支名，人打的
 *    字不該有那個權力——否則貼一段別人的編號就能把追問寫進別人的分支。
 *
 * ⚠️ 由舊到新取**第一個**命中的：那是開出這一串的那一輪，也就是這個 thread 真正
 *    歸屬的分支。取最新的話，串裡任何一次「反查失敗而新開的輪次」都會把歸屬搶走，
 *    於是同一串會在兩支分支之間跳。
 */
function _scanAskId_(msgs) {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || !m.bot) continue;
    const hit = String(m.text || '').match(ASK_ID_IN_TEXT_RE);
    if (hit) return hit[1];
  }
  return '';
}


// ═══════════════════════════════════════════════════════════════════
//  progress.json 查詢輔助
// ═══════════════════════════════════════════════════════════════════

// 同一張單內 Q 編號唯一，所以 jira_id + question_id 就是去重的正確鍵；
// 不必再靠 message_id（文字回覆走 app_mention，本來就拿不到卡片的 ts）。
function _answerKey_(jiraId, questionId) {
  return 'ans_' + jiraId + '_' + questionId;
}

function _findQuestion_(progress, questionId) {
  const list = (progress && progress.pending_questions) || [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].id === questionId) return list[i];
  }
  return null;
}

// 兩層去重：CacheService 擋 6 小時內的連點與 in-flight（答案已 dispatch 但
// resume workflow 還沒把 answered 寫回 progress.json 並 push）；progress.json
// 的 answered 接手長期。舊版只有前者，所以 6 小時後同一顆按鈕可以再點一次。
function _alreadyAnswered_(jiraId, questionId, question) {
  const by = CacheService.getScriptCache().get(_answerKey_(jiraId, questionId));
  if (by) return { answered: true, by: by };
  if (question && question.answered) {
    return { answered: true, by: question.answered_by || '（先前已回覆）' };
  }
  return { answered: false, by: null };
}

// 供 handleInteraction 顯示卡片進度用。刻意回傳與舊 ctx 相同的形狀
// （question_ids / phase / pipeline），讓既有的顯示邏輯一行都不用改。
function _cardProgress_(jiraId, questionId, progress, pipeline) {
  if (!progress) return null;
  const q = _findQuestion_(progress, questionId);
  if (!q) return null;
  const ids = ((progress.pending_questions) || [])
    .filter(function (x) { return x && x.phase === q.phase; })
    .map(function (x) { return x.id; });
  return { question_ids: ids, phase: q.phase, pipeline: pipeline };
}

// 某個 phase 的整體進度：全部答完才會接續後續 Phase，人需要看得到還剩幾題
function _phaseProgress_(progress, phase, jiraId) {
  const cache = CacheService.getScriptCache();
  const all = ((progress && progress.pending_questions) || []).filter(function (q) {
    return q && q.phase === phase;
  });
  const remaining = all.filter(function (q) {
    return !q.answered && !cache.get(_answerKey_(jiraId, q.id));
  });
  return { total: all.length, remaining: remaining, answered: all.length - remaining.length };
}


// ═══════════════════════════════════════════════════════════════════
//  文字回覆：@Alice answer [Q-00X] <自由描述>，或整份 checkList 貼上
//
//  按鈕只能傳回預設選項，表達不了「要改成什麼」。SA 步驟七這類問題的本質就是
//  「請人給方向」，因此保留一條文字通道。走 app_mention 事件，沒有 Slack 的
//  3 秒限制，可從容完成 dispatch 與卡片更新。
//
//  這支現在只是**接線**：反查 → 讀 progress → 解析 → 派發。
//  解析與派發各自獨立（見 core/answer.js 的說明），因為接模型時流程會被
//  回讀確認切成兩個 HTTP 請求，派發那半必須能被單獨呼叫。
//
//  opts（可省略）：
//    route  路由層已經反查過的結果，傳進來避免重複反查
//    items  分類器已經正規化好的答案。規則層一律 null；LLM 版會填。
// ═══════════════════════════════════════════════════════════════════

function handleTextAnswer(args, conv, user, provider, opts) {
  const raw = _toHalfWidth_(args || '').trim();

  const USAGE = [
    '用法：在決策卡片所在的 thread 內回覆 `@Alice answer <你的答覆>`',
    '要指定題號時：`@Alice answer Q-002 <你的答覆>`',
    '一次回答多題：在補問清單按「複製」，把整份貼進同一個 thread',
    '（答覆要在卡片的 thread 內——Alice 靠 thread 才知道這是哪張單、要接續哪條 pipeline）'
  ].join('\u000a');

  if (!raw) {
    provider.postMessage(conv.channel, provider.mention(user) + ' ⚠️ 請一併給出答覆內容。' + '\u000a' + USAGE, _replyTarget_(conv));
    return;
  }

  // thread → 哪張單（反查訊息，不存狀態；見本檔開頭的說明）。
  // opts.jiraId 是分類器已經定案的單號——貼上的補問清單標題自帶單號，
  // 那條路徑不依賴 thread 反查。
  const route = (opts && opts.route !== undefined)
    ? opts.route
    : _resolveRouteFromThread_(conv, provider);
  const routedJira = (opts && opts.jiraId) || (route && route.j) || '';
  if (!routedJira) {
    provider.postMessage(conv.channel,
      provider.mention(user) + ' ⚠️ ' + ((route && route.err === 'fetch-failed')
        ? '我讀不到這個 thread 的第一則訊息（多半是缺 `channels:history` 權限，改過 scope 後要重新安裝 App）。'
        : '這裡沒有待決問題。') + '\u000a' + USAGE, _replyTarget_(conv));
    return;
  }

  const jiraId = routedJira;
  const progress = fetchProgress(jiraId);
  const pending = ((progress && progress.pending_questions) || []).filter(function (q) {
    return q && !q.answered;
  });

  // 分類器已經正規化好就直接用（LLM 版會填 items）；否則自己解析。
  // 兩條路產出同一個形狀，所以下面的派發完全不知道 items 從哪來。
  let parsed;
  if (opts && opts.items && opts.items.length) {
    parsed = {
      mode: (opts.items.length >= 2) ? 'batch' : 'single',
      items: opts.items,
      ignoredAssumptions: [],
      confidence: 'high',
      reason: ''
    };
  } else {
    parsed = _parseAnswerText_(raw, pending);
  }

  // 指了某一題但沒給題號（「第一題選A」「1. B 2. C」）→ 反問，不猜。
  // 這是規則層的邊界，也是日後接模型的接點：那份語料就是判斷「值不值得接」的依據。
  if (parsed.mode === 'unparsed') {
    _recordIntentMiss_(raw, conv, 'answer-unparsed');
    provider.postMessage(conv.channel,
      _answerAmbiguousText_(provider, user, jiraId, pending), _replyTarget_(conv));
    return;
  }

  _applyAnswerItems_(parsed.items, {
    mode: parsed.mode,
    jiraId: jiraId,
    pipeline: (progress && progress.pipeline) || '',
    progress: progress,
    conv: conv,
    user: user,
    provider: provider,
    rawBatch: raw,
    ignoredAssumptions: parsed.ignoredAssumptions
  });
}


/**
 * 「你指的是哪一題？」——把待答清單列出來，讓人可以直接照著回。
 *
 * 刻意列出**題號與題目**而不是只說「請指定題號」：使用者手上沒有那份清單，
 * 卡片可能已經被洗到很上面。列出來就能直接複製貼上。
 */
function _answerAmbiguousText_(provider, user, jiraId, pending) {
  const lines = [
    provider.mention(user) + ' 這句我看得出是在回答，但不確定是哪一題——猜錯會把答案寫到別題上，' +
    '所以先跟你確認。',
    '',
    jiraId + ' 目前待回覆：'
  ];
  pending.slice(0, 8).forEach(function (q) {
    lines.push('• `' + q.id + '` ' + String(q.question || '').slice(0, 80));
  });
  if (pending.length > 8) lines.push('_…另有 ' + (pending.length - 8) + ' 題_');
  lines.push('');
  lines.push('請帶上題號再說一次，例：`@Alice answer ' + (pending[0] ? pending[0].id : 'Q-001') + ' 用 A 方案`');
  lines.push('或在補問清單按「複製」，把整份貼進來（一次回答多題）。');
  return lines.join('\u000a');
}


// 互動回應必須是空 body：Slack 會把任何非空回應當成「替換原訊息」的內容，
// 一旦回傳純文字，整張卡片（含按鈕）就會被那行字取代——問題還沒回答，按鈕卻永久消失。
// 所有要給使用者看的提示，一律走 response_url 的 ephemeral 訊息。
//
// ⚠️ 這支曾經在入向／出向拆分（ae4d37a）時被連帶刪掉，但 handleInteraction 裡
//    九個呼叫點全部留著。症狀不是靜默的、而是破壞性的：每次點按鈕都會拋
//    ReferenceError，doPost 的 catch 回一段純文字錯誤訊息，Slack 拿它把整張
//    卡片換掉——答案其實已經寫進去了，但那張卡片連同其他題的按鈕一起消失。
//    現在 test/gas-regression.js 的 [0] 節會檢查所有 `_xxx_()` 呼叫都有定義。
function _emptyResponse_() {
  return ContentService.createTextOutput('');
}


// 3 秒預算內只做兩件事：讀回原句、走與 `@Alice ask` 完全相同的入口。
// 共用 handleAskRequest 是刻意的——節流、長度檢查、受理訊息、dispatch 全部
// 一致，這顆按鈕只是換一個觸發方式，不是第二條路。
function _handleAskConfirm_(interaction, provider) {
  // 存的是 { text, files }（見 core/intent.js 的 _stashAskOffer_）。
  // 附件一起帶回來：他那則訊息裡的圖還在畫面上，送出一個沒有附件的提問，
  // 他不會知道附件掉了，只會覺得 agent 沒看圖就亂答。
  const offer = _readAskOffer_(interaction.askKey);

  if (!offer) {
    // 過期或已經按過。兩者都不該重送——重送一次就是再燒一台 runner。
    provider.notifyTransient(interaction,
      'ℹ️ 這個提問已經送出過，或已超過 15 分鐘。要再問請直接說一次。');
    return _emptyResponse_();
  }
  // 先刪再送：連點兩下時第二次會落到上面那個分支
  CacheService.getScriptCache().remove(interaction.askKey);

  handleAskRequest(offer.text, interaction.conversation,
                   interaction.userId || interaction.user, provider, offer.files);
  return _emptyResponse_();
}


function handleInteraction(payload, provider, key) {
  // 金鑰驗證：與 decision 請求同一把 NOTIFY_KEY（Slack 的 Interactivity URL 可帶 query param）
  const notifyKey = PropertiesService.getScriptProperties().getProperty('NOTIFY_KEY');
  if (notifyKey && key !== notifyKey) {
    console.error('handleInteraction: 未授權的請求（notify key 不符）');
    return _emptyResponse_();
  }

  const interaction = provider.parseInteraction(payload);
  if (!interaction) {
    return _emptyResponse_();
  }

  // 「當成一般提問送出」——必須在所有決策邏輯之前分岔。
  // 下面整段（去重鍵、讀 progress.json、改卡片）都假設這是決策按鈕，
  // 讓它流過去的話會拿 undefined 去組快取鍵、然後靜默地什麼都不做。
  if (interaction.kind === 'ask_confirm') {
    return _handleAskConfirm_(interaction, provider);
  }

  // 記憶圖譜的裁決按鈕——同理，也必須在所有決策邏輯之前分岔。
  // 下面整段都假設「這是 pipeline 的決策」：去重鍵是 `ans_<jiraId>_<qid>`
  // （記憶決策沒有 jiraId，會組出 `ans_undefined_M-001` 讓所有記憶題共用同一把鎖）、
  // 讀 fetchProgress(jiraId)（拿 undefined 去打 GitHub contents API 然後 404）、
  // dispatchResume 以 jira_id + pipeline + phase 為鍵（augma 那側直接失敗）。
  // 詳見 core/memory.js 開頭。
  if (interaction.kind === 'memory') {
    return handleMemoryInteraction(interaction, provider);
  }

  const questionId = interaction.questionId;
  const choice = interaction.choice;
  const jiraId = interaction.jiraId;
  const pipeline = interaction.pipeline;
  const user = interaction.user;
  const conv = interaction.conversation;
  const messageId = interaction.messageId;

  // 使用 LockService 防止同時間多人連點競態。
  // 等鎖時間刻意壓到 1.5 秒：Slack 要求 3 秒內回應，等太久會讓使用者看到 operation_timeout。
  const lock = LockService.getScriptLock();
  const hasLock = lock.tryLock(1500);

  if (!hasLock) {
    provider.notifyTransient(interaction, '⏳ 系統正在處理其他決策，請稍候幾秒再點一次。');
    return _emptyResponse_();
  }

  try {
    const cache = CacheService.getScriptCache();
    const cacheKey = _answerKey_(jiraId, questionId);

    // 短期去重先查：連點是最常見的重複，本機命中就不必為它多打一次 GitHub。
    const recentBy = cache.get(cacheKey);
    if (recentBy) {
      provider.notifyTransient(interaction, `ℹ️ 此問題已由 ${recentBy} 回答，本次點擊不生效。`);
      return _emptyResponse_();
    }

    // 長期去重與進度都靠 progress.json——CacheService 只有 6 小時，過期後同一顆
    // 按鈕會變成可以再點一次（舊版的破口）。這次讀取（約 250ms）刻意放在 dispatch
    // 之前：去重放在觸發之後就沒有意義了。讀不到就降級成只有短期去重，dispatch 照做。
    const progress = fetchProgress(jiraId);
    const question = _findQuestion_(progress, questionId);

    const answeredBy = (question && question.answered)
      ? (question.answered_by || '（先前已回覆）')
      : null;
    if (answeredBy) {
      // 已有人先點過：只對這位使用者顯示提示，不動原卡片
      provider.notifyTransient(interaction, `ℹ️ 此問題已由 ${answeredBy} 回答，本次點擊不生效。`);
      return _emptyResponse_();
    }

    // 標記為已回答並記下回答者 (快取 6 小時)，供後到者的提示使用。
    // 與文字／批次路徑共用同一把鎖與同一個 TTL——不共用的話同一題會被寫兩次。
    cache.put(cacheKey, String(user), ANSWER_CACHE_TTL);

    const now = new Date();
    const timeStr = Utilities.formatDate(now, 'Asia/Taipei', 'HH:mm:ss');

    // ── 3 秒預算內的執行順序（順序是刻意的）──
    // 0. 去重（cache 零延遲，必要時再讀 progress.json）——必須在觸發之前。
    // 1. 先觸發 resume：這是唯一不可失敗的動作。若整體超過 3 秒被 Slack 判逾時，
    //    GAS 本身仍會跑完，但把最關鍵的一步放在前面可將風險降到最低。
    const dispatched = dispatchResume(jiraId, pipeline, questionId, choice, user);

    if (!dispatched) {
      // 觸發失敗時**不可**把卡片標成已定案——那會讓人以為流程在跑。
      // 同時撤掉去重標記，讓他可以再點一次重試。
      cache.remove(cacheKey);
      provider.notifyTransient(interaction,
        '⚠️ 已記錄你的選擇，但觸發 GitHub Actions 失敗，流程沒有接續。請稍後再點一次，' +
        '或確認 GAS 的 GITHUB_TOKEN 是否有效。');
      return _emptyResponse_();
    }

    // 算出這張卡片的整體進度：全部答完才會接續後續 Phase，人需要看得到還剩幾題
    const ctx = _cardProgress_(jiraId, questionId, progress, pipeline);
    let progressText = '';
    if (ctx && ctx.question_ids && ctx.question_ids.length) {
      const total = ctx.question_ids.length;
      const remaining = ctx.question_ids.filter(function (qid) {
        return !_alreadyAnswered_(jiraId, qid, _findQuestion_(progress, qid)).answered;
      });
      const answered = total - remaining.length;
      progressText = (remaining.length === 0)
        ? '*執行階段*：`' + (ctx.phase || '') + '`\n✅ 全部 *' + total +
          '* 題已回答完畢，正在接續 `' + (ctx.pipeline || '') + '`…'
        : '*執行階段*：`' + (ctx.phase || '') + '`\n共 *' + total + '* 題待決議（已回答 ' +
          answered + '／' + total + '），**每題都回答完**才會接續後續流程。';
    }

    // 不需要清任何上下文：答覆狀態的真相在 progress.json，thread 映射由 GC 淘汰。

    // 2. 再更新卡片：替換這一題的按鈕區塊、就地更新進度行。
    //    以 chat.update 為主、response_url 為 fallback（見 slack.js 的說明）。
    //    若日後實測常逾時，升級路徑是把 dispatch 丟進 PropertiesService 佇列，
    //    改由 ScriptApp.newTrigger(...).after(1000) 非同步送出——代價是需要
    //    script.scriptapp 授權，且多出「trigger 沒跑就永遠不 resume」的靜默失敗模式，
    //    因此目前不採用。
    provider.resolveDecision(conv, messageId, {
      questionId: questionId,
      choice: choice,
      user: user,
      timeStr: timeStr,
      jiraId: jiraId,
      blocks: interaction.blocks,          // 逐題替換用
      progressText: progressText,          // 就地更新的進度行
      responseUrl: interaction.responseUrl
    });

  } finally {
    lock.releaseLock();
  }

  return _emptyResponse_();
}


// ═══════════════════════════════════════════════════════════════════
//  狀態查詢：@Alice VIPOP-12345 進度
//
//  順便補上一個一直存在的信任缺口：unattended 模式下 agent 採預設值續跑時，
//  會用 record-assumption 把假設寫進 progress.json 的 assumptions，但通訊層
//  從來沒有顯示過它——人不知道 AI 幫他假設了什麼。這裡一併列出來。
// ═══════════════════════════════════════════════════════════════════

// ⚠️ 這份對照只影響**顯示**：查不到 key 時 handleStatusQuery 會退回原樣印出
// phase 名稱（見下方 `PHASE_LABEL[k] || k`），所以漏一個不會壞，只是看板上會
// 出現 `ra-phase3` 這種原始字串。augma 那側新增 Phase 時記得補進來。
const PHASE_LABEL = {
    'light-ra': 'Light-RA 快速審查',
  'ra-phase1': 'RA① 資料抓取',
  'ra-phase2': 'RA② Codebase 現況研讀',
  'ra-phase3': 'RA③ 規格與補問清單',
  'ra-phase4': 'RA④ PO 友善 HTML',
  'sa-phase1': 'SA① 範疇判讀',
  'sa-phase2': 'SA② Codebase 分析',
  'sa-phase3': 'SA③ SA 文件',
  'sa-phase4': 'SA④ Design 文件',
  'sa-phase5': 'SA⑤ 工項拆解'
};

const PHASE_ICON = {
  completed: '\u2705',
  running: '\u23f3',
  awaiting_decision: '\uD83D\uDD34',
  failed: '\u274c'
};

function handleStatusQuery(jiraId, conv, user, provider) {
  if (!jiraId) {
    provider.postMessage(conv.channel,
      provider.mention(user) + ' 要查哪張單？例：`@Alice VIPOP-12345 進度`', _replyTarget_(conv));
    return;
  }

  const progress = fetchProgress(jiraId);
  if (!progress) {
    provider.postMessage(conv.channel,
      provider.mention(user) + ' 讀不到 ' + jiraId + ' 的狀態。可能還沒開始跑，或產物尚未推上分支。',
      _replyTarget_(conv));
    return;
  }

  const lines = [];
  lines.push('*' + jiraId + '* — 目前狀態');

  const phases = progress.phases || {};
  const keys = Object.keys(phases);
  if (keys.length) {
    keys.forEach(function (k) {
      const st = (phases[k] && phases[k].status) || 'pending';
      const icon = PHASE_ICON[st] || '\u26aa';
      lines.push(icon + ' ' + (PHASE_LABEL[k] || k) + ' \u2014 ' + st);
    });
  } else {
    lines.push('_尚無階段紀錄_');
  }

  const pend = (progress.pending_questions || []).filter(function (q) {
    return q && !q.answered;
  });
  if (pend.length) {
    lines.push('');
    lines.push('\uD83D\uDD34 *' + pend.length + ' 題待回覆*（全部答完才會接續）：');
    pend.slice(0, 5).forEach(function (q) {
      lines.push('\u2022 `' + q.id + '` ' + String(q.question || '').slice(0, 90));
    });
    if (pend.length > 5) lines.push('_…另有 ' + (pend.length - 5) + ' 題_');
  }

  const assumptions = progress.assumptions || [];
  if (assumptions.length) {
    lines.push('');
    lines.push('\u2139\ufe0f *採用了 ' + assumptions.length + ' 項假設*（無人值守下自動續跑）：');
    assumptions.slice(0, 5).forEach(function (a) {
      const note = (a && a.note) ? a.note : JSON.stringify(a);
      const ph = (a && a.phase) ? ('`' + a.phase + '` ') : '';
      lines.push('\u2022 ' + ph + String(note).slice(0, 90));
    });
    if (assumptions.length > 5) lines.push('_…另有 ' + (assumptions.length - 5) + ' 項_');
  }

  if (progress.last_error) {
    lines.push('');
    lines.push('\u274c *最近一次錯誤*（`' + (progress.last_error.phase || '') + '`）：' +
               String(progress.last_error.message || '').slice(0, 160));
  }

  if (progress.updated_at) {
    lines.push('');
    lines.push('_最後更新：' + progress.updated_at + '_');
  }

  provider.postMessage(conv.channel, lines.join('\n'), _replyTarget_(conv));
}


// ═══════════════════════════════════════════════════════════════════
//  一次性清理：移除舊版留下的 ScriptProperties
//
//  舊版每一題都存一份完整的決策上下文（dctx_q_<qid>），thread 再存一份
//  （dctx_t_<thread>），而且只有「成功答覆」時才刪——沒答的、被放棄的單、
//  dispatch 失敗的那些，全部永久留著。約 150 張單就會撞到 500 KB 上限，
//  然後 setProperty 開始拋錯、卡片再也發不出去。
//
//  現在這兩種 key 都沒有人讀了（thread 路由改成反查 Slack 訊息 + 讀
//  progress.json），但它們不會自己消失。部署後在 GAS 編輯器手動執行這支一次，
//  之後可以刪掉這段程式碼。
// ═══════════════════════════════════════════════════════════════════

function cleanupLegacyKeys() {
  const props = PropertiesService.getScriptProperties();
  const keys = props.getKeys();
  const legacy = keys.filter(function (k) {
    return k.indexOf('dctx_q_') === 0 || k.indexOf('dctx_t_') === 0;
  });

  if (!legacy.length) {
    console.log('沒有舊版 key 需要清理（共 ' + keys.length + ' 個 property）。');
    return;
  }

  let bytes = 0;
  legacy.forEach(function (k) {
    const v = props.getProperty(k);
    bytes += k.length + (v ? v.length : 0);
  });

  legacy.forEach(function (k) { props.deleteProperty(k); });
  console.log('已清除 ' + legacy.length + ' 個舊版 key，釋放約 ' +
              Math.round(bytes / 1024 * 10) / 10 + ' KB（上限 500 KB）。');
}
