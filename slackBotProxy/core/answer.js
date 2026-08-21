// ═══════════════════════════════════════════════════════════════════
//  答案正規化與派發
//
//  分成刻意獨立的兩半，中間用 items[] 這個契約銜接：
//
//    _parseAnswerText_   純函式。文字 → items[]。不做 I/O、不寫狀態。
//    _applyAnswerItems_  吃 items[]。驗證、去重、dispatch、回覆。
//                        **不管 items 從哪來。**
//
//  為什麼一定要拆、而且一定要用陣列：
//
//  用純量（一個 questionId + 一段 answerText）在「一次一題」時完全正確，但
//  之後要接模型時，流程會被回讀確認切成兩個獨立的 HTTP 請求：
//
//      第一次（app_mention）  解析 → 暫存 items[] → 回卡片問「對嗎？」
//                             ⏸ 流程結束，等人點按鈕
//      第二次（interactivity） 讀暫存 → 驗證 → dispatch → 回覆
//
//  第二次是另一個請求，所以「驗證＋派發＋回覆」必須是一個能被獨立呼叫、
//  吃 items[] 的函式。形狀定錯的話那不是抽換，是重寫。
//  單題就是長度 1 的陣列——現在看起來多此一舉，那正是重點。
// ═══════════════════════════════════════════════════════════════════


// 舊的單題語法：`Q-002 我的答覆`（空白分隔，沒有冒號）。
// 這是 `@Alice answer Q-002 …` 一直以來的寫法，熟練使用者還在用，不能拿掉。
// 位數從 \d{1,3} 放寬到 \d{1,4}：題號現在由 checkList 決定，位數不再由我們控制。
const SINGLE_QID_RE = /^([Qq][-\uFF0D]?\d{1,4})[ \t:：]+([\s\S]+)$/;

// 「這句話在指某一題，但沒用題號」的偵測。命中就不猜，走反問。
//
// 為什麼要偵測而不是沿用「挑第一個未答的題」：
// PM 心裡的「第一題」不一定是 Q-001。若 Q-001 已經答掉，他說的「第一題」
// 指的是畫面上剩下的第一題。猜錯的後果是答案寫到別題上、然後 phase-guard
// 照樣放行——靜默、事後無從還原。反問只是多一次往返。
const ORDINAL_RE  = /第\s*[一二三四五六七八九十百千0-9]+\s*題/;
const NUMBERED_RE = /(^|[\s，,])\d+\s*[.、)）]\s*[A-Za-z一-鿿]/g;


/**
 * 文字 → items[]。**純函式**：不反查、不讀 progress、不寫語料。
 *
 * pendingQuestions 只用來判斷歧義（只剩一題時「第一題」不可能指錯），
 * 不用來配對答案——配對是 augma 的事（格式知識歸它）。
 *
 * 回傳 {
 *   mode: 'batch' | 'single' | 'unparsed',
 *   items: [ { qid, answerText } ],   // qid 可為 null＝「挑第一個未答的題」
 *   ignoredAssumptions: ['A-001', …], // 明確回報，不靜默丟掉
 *   confidence: 'high' | 'low',
 *   reason: ''                        // unparsed 時說明為什麼
 * }
 */
function _parseAnswerText_(raw, pendingQuestions) {
  const text = _toHalfWidth_(raw == null ? '' : raw).trim();
  const pendingCount = (pendingQuestions || []).length;
  const assumptions = _scanAssumptionIds_(text);

  const out = function (o) {
    return {
      mode: o.mode,
      items: o.items || [],
      ignoredAssumptions: assumptions,
      confidence: o.confidence || 'high',
      reason: o.reason || ''
    };
  };

  if (!text) return out({ mode: 'unparsed', confidence: 'low', reason: 'empty' });

  // ── 1. 行首題號樣式（checkList 按「複製」貼上的形狀）────────────────
  const scanned = _scanQidLines_(text);

  if (scanned.length >= 2) {
    return out({ mode: 'batch', items: scanned });
  }

  // 只命中一題也要用行內容當答案，不能把整串（含標題、含「尚未回答」那行）
  // 當成那一題的答案——那正是現在的 bug。走 single 還能保有逐題的閘門檢查。
  if (scanned.length === 1) {
    return out({ mode: 'single', items: scanned });
  }

  // ── 2. 舊的單題語法：`Q-002 我的答覆` ─────────────────────────────
  const m = text.match(SINGLE_QID_RE);
  if (m) {
    const qid = _normalizeQid_(m[1]);
    if (qid) return out({ mode: 'single', items: [{ qid: qid, answerText: m[2].trim() }] });
  }

  // ── 3. 指了某一題但沒給題號 → 不猜 ────────────────────────────────
  // 只剩一題時沒有歧義（「第一題」只可能是那一題），照舊放行。
  if (pendingCount > 1) {
    NUMBERED_RE.lastIndex = 0;
    const numbered = text.match(NUMBERED_RE) || [];
    if (ORDINAL_RE.test(text)) {
      return out({
        mode: 'unparsed', confidence: 'low', reason: 'ordinal',
        items: []
      });
    }
    if (numbered.length >= 2) {
      return out({
        mode: 'unparsed', confidence: 'low', reason: 'numbered-list',
        items: []
      });
    }
  }

  // ── 4. 一般自由文字 → 交給下游挑第一個未答的題 ─────────────────────
  return out({ mode: 'single', items: [{ qid: null, answerText: text }] });
}


// ═══════════════════════════════════════════════════════════════════
//  驗證 ＋ 派發 ＋ 回覆
//
//  ctx = { mode, jiraId, pipeline, progress, conv, user, provider,
//          rawBatch, ignoredAssumptions }
// ═══════════════════════════════════════════════════════════════════

// client_payload 上限 64 KB。中文一個字 3 bytes，用字元數估會低估三倍。
// 留給其他欄位與 JSON 包裝的餘裕之後，答案本體上限抓 40 KB。
const BATCH_PAYLOAD_MAX_BYTES = 40000;

function _applyAnswerItems_(items, ctx) {
  if (ctx.mode === 'batch') return _applyBatch_(items, ctx);
  return _applySingle_(items, ctx);
}


// ── 單題：所有既有保護原封不動 ────────────────────────────────────────
function _applySingle_(items, ctx) {
  const provider = ctx.provider, conv = ctx.conv, user = ctx.user;
  const jiraId = ctx.jiraId, progress = ctx.progress;

  let questionId = items[0] ? items[0].qid : null;
  let answerText = items[0] ? items[0].answerText : '';
  let question = null;

  if (questionId) {
    question = progress ? _findQuestion_(progress, questionId) : null;
    if (progress && !question) {
      provider.postMessage(conv.channel,
        provider.mention(user) + ' 找不到 ' + jiraId + ' 的 ' + questionId + ' 這一題。', _replyTarget_(conv));
      return;
    }
    // progress 讀不到（產物還沒 push）但有明確題號 → 照樣 dispatch，只是跳過閘門
    // 檢查與進度顯示。augma 的 update-progress.sh answer 找不到該題會自己失敗，
    // 不會靜默寫錯。
  } else {
    if (!progress) {
      provider.postMessage(conv.channel,
        provider.mention(user) + ' 暫時讀不到 ' + jiraId +
        ' 的流程狀態，請改成明確指定題號：`@Alice answer Q-001 <你的答覆>`',
        _replyTarget_(conv));
      return;
    }
    const pendingCache = CacheService.getScriptCache();
    const pending = ((progress.pending_questions) || []).filter(function (q) {
      return q && !q.answered && !pendingCache.get(_answerKey_(jiraId, q.id));
    });
    if (pending.length === 0) {
      provider.postMessage(conv.channel,
        provider.mention(user) + ' ' + jiraId + ' 目前沒有待回覆的問題。', _replyTarget_(conv));
      return;
    }
    question = pending[0];
    questionId = question.id;
  }

  // pipeline 由 augma 寫進 progress.json（update-progress.sh init --pipeline）。
  // 讀不到就不能 dispatch：猜錯會重觸發錯的 pipeline，而那是不可逆的
  // （ra-pipeline 只跑兩階，full-pipeline 跑七階）。按鈕的 value 帶著正確的
  // pipeline，所以請使用者改點按鈕，而不是替他賭一把。
  //
  // 順序刻意排在題目解析**之後**：先讓「找不到這一題」「沒有待回覆的問題」
  // 這些更具體的訊息有機會先出來。
  if (!ctx.pipeline) {
    provider.postMessage(conv.channel,
      provider.mention(user) + ' 讀不到 ' + jiraId + ' 要接續哪條 pipeline，沒辦法安全地用文字接續。' +
      '請直接點卡片上的按鈕（按鈕本身帶著這個資訊）。', _replyTarget_(conv));
    return;
  }

  // 閘門型問題只能點按鈕，不能用文字回覆。
  // 原因：resume_action = complete 時，phase-guard 只要看到「有答覆」就會判定
  // COMPLETE_ONLY 直接放行下一階段——它不會（也不該）去解讀答覆的語意。
  // 若允許文字回覆，使用者打「先不要跑」反而會讓下一階段跑起來，與意圖完全相反。
  if (question && question.resume_action === 'complete') {
    provider.postMessage(conv.channel,
      provider.mention(user) + ' ℹ️ ' + questionId +
      ' 是放行閘門，請直接點卡片上的按鈕。' + '\u000a' +
      '若還不想放行，就先不要動作——卡片會留在這裡等你。' + '\u000a' +
      '需要補充說明時請直接在 thread 討論，那不會觸發任何流程。',
      _replyTarget_(conv));
    return;
  }

  const cache = CacheService.getScriptCache();
  const cacheKey = _answerKey_(jiraId, questionId);
  const dup = _alreadyAnswered_(jiraId, questionId, question);
  if (dup.answered) {
    provider.postMessage(conv.channel,
      provider.mention(user) + ' ℹ️ ' + questionId + ' 已由 ' + dup.by + ' 回答，本次回覆不生效。',
      _replyTarget_(conv));
    return;
  }
  // ⚠️ 這裡刻意**不用** provider.mention()——它存的是「誰回答的」，而那個值會
  //    一路寫進 progress.json 的 answered_by（augma 的 update-progress.sh），
  //    所以是跨專案契約，不是我們自己的顯示字串。
  //
  //    快取值必須與 answered_by 同格式：_alreadyAnswered_（core/decision.js）把
  //    「快取命中」與「progress.json 說已答」當成同一種東西回傳同一個 by 欄位，
  //    兩邊格式不一致的話，顯示出來的「已由 X 回答」會時而是 mention、時而是
  //    一串 raw id。
  //
  //    正解是存 raw user id、顯示時才 mention()，但那要 augma 那側一起改，而且
  //    既有的 progress.json 裡已經躺著舊格式的值——所以需要一個「兩種格式都認得」
  //    的過渡期，不能單方面改這一行。切 provider 時一併處理。
  const answeredBy = '<@' + user + '>';
  cache.put(cacheKey, answeredBy, ANSWER_CACHE_TTL);

  // 1. 先觸發 resume（唯一不可失敗的動作）
  const ok = dispatchResume(jiraId, ctx.pipeline, questionId, answerText, answeredBy);

  // 2. 刻意**不動原卡片**：文字回覆走 app_mention 事件，拿不到 payload.message.blocks，
  //    只能整張替換——那會把同一張卡片上其他題的按鈕一起吃掉。
  //    該題若被重複點擊，會被去重擋下並收到提示，所以按鈕留著不會造成重複處理。

  if (ok) {
    let tail = '正在接續 ' + ctx.pipeline + '（' + jiraId + '）…';
    if (progress && question) {
      // cacheKey 已寫入，所以這裡算出的 remaining 已排除本題
      const p = _phaseProgress_(progress, question.phase, jiraId);
      if (p.remaining.length > 0) {
        tail = '（本階段還有 ' + p.remaining.length + ' 題待回覆，全部答完才會接續）';
      }
    }
    provider.postMessage(conv.channel,
      '✅ 已收下 ' + provider.mention(user) + ' 對 ' + questionId + ' 的回覆。' + tail, _replyTarget_(conv));
  } else {
    cache.remove(cacheKey);   // dispatch 失敗要讓人能重試
    provider.postMessage(conv.channel,
      '⚠️ ' + provider.mention(user) + ' 回覆已記錄，但觸發 GitHub Actions 失敗，' +
      '請確認 GITHUB_TOKEN 或稍後重試。', _replyTarget_(conv));
  }
}


// ── 批次：只撈題號共用去重鎖，配對與閘門交給 augma ──────────────────────
//
// GAS 刻意**不**配對答案、**不**做閘門檢查。理由是責任切在「誰擁有格式知識」：
//   題號格式（Q-\d+）是最穩定的部分  → 兩邊共用，GAS 撈得起
//   答案格式（選項字串、假設區塊…）  → 只有 augma 知道，它跟 checklist.js 同一個 repo
// 格式改一次，改 augma 有 git、有 review；改 GAS 要重新部署 Apps Script。
//
// 那 GAS 為什麼還是得撈題號？因為**去重鎖必須與按鈕路徑共用**。競態長這樣：
//   t0 有人點 Q-001 的按鈕 → GAS 寫 cache、dispatch(A)
//   t1 另一人貼整串（含 Q-001）→ 不查 cache 就 dispatch(B)
//   t2 兩個 job 併發，讀到的 progress.json 裡 Q-001 都還是 answered=false
//   t3 push 競爭 → reset --hard 重套 → 後到的覆蓋前面的
// 結果：一個答案無聲消失，而 GAS 已經對兩個人都回了「已收下」。
// self-hosted runner 要排隊，這個窗口是分鐘級的，不是理論風險。
function _applyBatch_(items, ctx) {
  const provider = ctx.provider, conv = ctx.conv, user = ctx.user, jiraId = ctx.jiraId;

  if (!ctx.pipeline) {
    provider.postMessage(conv.channel,
      provider.mention(user) + ' 讀不到 ' + jiraId + ' 要接續哪條 pipeline，沒辦法安全地用文字接續。' +
      '請直接點卡片上的按鈕（按鈕本身帶著這個資訊）。', _replyTarget_(conv));
    return;
  }

  const cache = CacheService.getScriptCache();

  const qids = items.map(function (it) { return it.qid; });
  const already = qids.filter(function (qid) { return !!cache.get(_answerKey_(jiraId, qid)); });

  if (already.length === qids.length) {
    provider.postMessage(conv.channel,
      provider.mention(user) + ' ℹ️ 這 ' + qids.length + ' 題稍早都已經收下過了（' +
      qids.join('、') + '），本次貼上不重複送出。', _replyTarget_(conv));
    return;
  }

  const cut = _truncateUtf8_(ctx.rawBatch, BATCH_PAYLOAD_MAX_BYTES);

  // 先寫快取再 dispatch：順序反過來的話，dispatch 與寫快取之間又是一個競態窗口。
  // 與單題同一個理由：這是 progress.json 的 answered_by，不是顯示字串。
  const answeredBy = '<@' + user + '>';
  qids.forEach(function (qid) { cache.put(_answerKey_(jiraId, qid), answeredBy, ANSWER_CACHE_TTL); });

  const ok = dispatchResumeBatch(jiraId, ctx.pipeline, cut.text, answeredBy);

  if (!ok) {
    qids.forEach(function (qid) { cache.remove(_answerKey_(jiraId, qid)); });
    provider.postMessage(conv.channel,
      '⚠️ ' + provider.mention(user) + ' 觸發 GitHub Actions 失敗，這份回覆沒有送出。' +
      '請確認 GITHUB_TOKEN 或稍後再貼一次。', _replyTarget_(conv));
    return;
  }

  // 這裡刻意**不報數字**。GAS 只撈了題號，沒有配對答案、也沒查閘門，
  // 所以它不知道實際會寫進幾題。有資訊的那則由 augma 在寫完之後發
  // （notify-answer-result.sh → messageDispatch 的 answer_result）。
  const lines = ['\uD83D\uDCE5 已收下 ' + provider.mention(user) + ' 的批次回覆（' + qids.length +
                 ' 題），正在套用到 ' + jiraId + '…'];

  if (already.length) {
    lines.push('ℹ️ 其中 ' + already.join('、') + ' 稍早已經收過，這次不會重複寫入。');
  }
  if (cut.truncated) {
    lines.push('⚠️ 內容超過 ' + Math.round(BATCH_PAYLOAD_MAX_BYTES / 1024) +
               ' KB 上限（原本 ' + Math.round(cut.originalBytes / 1024) +
               ' KB），已從尾端截斷。沒被涵蓋的題會留在待回覆清單裡。');
  }
  if (ctx.ignoredAssumptions && ctx.ignoredAssumptions.length) {
    lines.push('ℹ️ 已忽略 ' + ctx.ignoredAssumptions.length +
               ' 條 AI 假設確認（' + ctx.ignoredAssumptions.join('、') +
               '）——目前沒有地方記錄它們，需要的話請直接在 thread 說明。');
  }
  lines.push('ℹ️ 卡片上這幾題的按鈕可以忽略，點了會被擋下。');

  provider.postMessage(conv.channel, lines.join('\u000a'), _replyTarget_(conv));
}
