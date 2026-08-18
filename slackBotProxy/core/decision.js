// ═══════════════════════════════════════════════════════════════════
//  決策核心處理模組 (Decision Core)
//  負責決策請求驗證、卡片發布、LockService 防連點去重與 Pipeline 恢復
// ═══════════════════════════════════════════════════════════════════

function handleDecisionRequest(body, key, provider) {
  const notifyKey = PropertiesService.getScriptProperties().getProperty('NOTIFY_KEY');

  // 金鑰驗證
  if (notifyKey && key !== notifyKey) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'Unauthorized: invalid notify key' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const jiraId = body.jira_id;
  const phase = body.phase || 'unknown';
  const pipeline = body.pipeline || 'sa-pipeline';
  const conv = body.conversation || {};
  const questionObj = body.question || {};

  if (!conv.channel && !conv.space) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'Missing channel or space in conversation' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 透過 Provider 貼出互動卡片
  const messageId = provider.postDecision(conv, questionObj, jiraId, phase, pipeline);

  // 存下決策上下文，供文字回覆（@Alice answer）反查。
  // 按鈕點擊不需要這個（jira_id / pipeline 就藏在 button value 裡），但文字回覆只有
  // 一句話，必須靠 thread 或 question_id 才能回推是哪張單、要接續哪個 pipeline。
  _saveDecisionContext_({
    question_id: questionObj.id,
    jira_id: jiraId,
    phase: phase,
    pipeline: pipeline,
    // 閘門型（complete）問題不接受文字回覆，見 handleTextAnswer 的說明
    resume_action: questionObj.resume_action || 'continue',
    conversation: conv,
    message_id: messageId
  });

  return ContentService.createTextOutput(JSON.stringify({
    status: 'ok',
    message: 'Decision card posted successfully',
    message_id: messageId
  })).setMimeType(ContentService.MimeType.JSON);
}


// ═══════════════════════════════════════════════════════════════════
//  決策上下文存取（供 @Alice answer 文字回覆使用）
//
//  用 ScriptProperties 而非 CacheService：決策可能隔天才回覆，
//  CacheService 最長只有 6 小時。答覆後即刪除，避免無限累積。
// ═══════════════════════════════════════════════════════════════════

function _ctxKeys_(ctx) {
  const keys = [];
  if (ctx.question_id) keys.push(`dctx_q_${ctx.question_id}`);
  const thread = ctx.conversation && (ctx.conversation.thread || ctx.conversation.channel);
  if (thread) keys.push(`dctx_t_${thread}`);
  return keys;
}

function _saveDecisionContext_(ctx) {
  const props = PropertiesService.getScriptProperties();
  const value = JSON.stringify(ctx);
  _ctxKeys_(ctx).forEach(function (k) { props.setProperty(k, value); });
}

function _loadDecisionContext_(questionId, thread) {
  const props = PropertiesService.getScriptProperties();
  let raw = null;
  if (questionId) raw = props.getProperty(`dctx_q_${questionId}`);
  if (!raw && thread) raw = props.getProperty(`dctx_t_${thread}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (err) { return null; }
}

function _clearDecisionContext_(ctx) {
  const props = PropertiesService.getScriptProperties();
  _ctxKeys_(ctx).forEach(function (k) { props.deleteProperty(k); });
}


// ═══════════════════════════════════════════════════════════════════
//  文字回覆：@Alice answer [Q-00X] <自由描述>
//
//  按鈕只能傳回預設選項，表達不了「要改成什麼」。SA 步驟七這類問題的本質就是
//  「請人給方向」，因此保留一條文字通道。走 app_mention 事件，沒有 Slack 的
//  3 秒限制，可從容完成 dispatch 與卡片更新。
// ═══════════════════════════════════════════════════════════════════

function handleTextAnswer(args, conv, user, provider) {
  const raw = (args || '').trim();

  const USAGE = [
    '用法：@Alice answer <你的答覆>',
    '在決策卡片所在的 thread 內回覆可省略問題編號；',
    '在其他地方請明確指定：@Alice answer Q-002 <你的答覆>'
  ].join('\u000a');

  if (!raw) {
    provider.postMessage(conv.channel, '<@' + user + '> \u26a0\ufe0f 請一併給出答覆內容。' + '\u000a' + USAGE, conv.thread);
    return;
  }

  // 第一個 token 若形如 Q-002 / q2 就當作問題編號，其餘全部視為答案本文
  let questionId = null;
  let answerText = raw;
  const m = raw.match(/^[Qq]-?(\d{1,3})\s+([\s\S]+)$/);
  if (m) {
    questionId = 'Q-' + String(parseInt(m[1], 10)).padStart(3, '0');
    answerText = m[2].trim();
  }

  const ctx = _loadDecisionContext_(questionId, conv.thread || conv.channel);
  if (!ctx) {
    provider.postMessage(conv.channel,
      '<@' + user + '> \u26a0\ufe0f 找不到對應的待決問題。' + '\u000a' + USAGE, conv.thread);
    return;
  }

  // 閘門型問題只能點按鈕，不能用文字回覆。
  // 原因：resume_action = complete 時，phase-guard 只要看到「有答覆」就會判定
  // COMPLETE_ONLY 直接放行下一階段——它不會（也不該）去解讀答覆的語意。
  // 若允許文字回覆，使用者打「先不要跑」反而會讓下一階段跑起來，與意圖完全相反。
  if (ctx.resume_action === 'complete') {
    provider.postMessage(conv.channel,
      '<@' + user + '> \u2139\ufe0f ' + ctx.question_id +
      ' 是放行閘門，請直接點卡片上的按鈕。' + '\u000a' +
      '若還不想放行，就先不要動作——卡片會留在這裡等你。' + '\u000a' +
      '需要補充說明時請直接在 thread 討論，那不會觸發任何流程。',
      conv.thread);
    return;
  }

  // 與按鈕共用同一把去重鎖與快取鍵：同一題只受理一次
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    provider.postMessage(conv.channel, '<@' + user + '> \u23f3 系統忙碌中，請稍後再試。', conv.thread);
    return;
  }

  try {
    const cache = CacheService.getScriptCache();
    const cacheKey = 'answered_' + ctx.question_id;
    const answeredBy = cache.get(cacheKey);
    if (answeredBy) {
      provider.postMessage(conv.channel,
        '<@' + user + '> \u2139\ufe0f ' + ctx.question_id + ' 已由 ' + answeredBy + ' 回答，本次回覆不生效。',
        conv.thread);
      return;
    }
    cache.put(cacheKey, '<@' + user + '>', 21600);

    // 1. 先觸發 resume（唯一不可失敗的動作）
    const ok = dispatchResume(ctx.jira_id, ctx.pipeline, ctx.question_id, answerText, '<@' + user + '>');

    // 2. 更新原卡片消除按鈕，避免有人又去點
    const timeStr = Utilities.formatDate(new Date(), 'Asia/Taipei', 'HH:mm:ss');
    provider.resolveDecision(ctx.conversation, ctx.message_id,
      '（文字回覆）' + answerText, '<@' + user + '>', timeStr, ctx.jira_id);

    if (ok) {
      _clearDecisionContext_(ctx);
      provider.postMessage(conv.channel,
        '\u2705 已收下 <@' + user + '> 對 ' + ctx.question_id + ' 的回覆，正在接續 ' +
        ctx.pipeline + '（' + ctx.jira_id + '）…', conv.thread);
    } else {
      cache.remove(cacheKey);   // dispatch 失敗要讓人能重試
      provider.postMessage(conv.channel,
        '\u26a0\ufe0f <@' + user + '> 回覆已記錄，但觸發 GitHub Actions 失敗，' +
        '請確認 GITHUB_TOKEN 或稍後重試。', conv.thread);
    }
  } finally {
    lock.releaseLock();
  }
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
    const cacheKey = `answered_${questionId}`;

    const answeredBy = cache.get(cacheKey);
    if (answeredBy) {
      // 已有人先點過：只對這位使用者顯示提示，不動原卡片
      provider.notifyTransient(interaction, `ℹ️ 此問題已由 ${answeredBy} 回答，本次點擊不生效。`);
      return _emptyResponse_();
    }

    // 標記為已回答並記下回答者 (快取 6 小時)，供後到者的提示使用
    cache.put(cacheKey, String(user), 21600);

    const now = new Date();
    const timeStr = Utilities.formatDate(now, 'Asia/Taipei', 'HH:mm:ss');

    // ── 3 秒預算內的執行順序（順序是刻意的）──
    // 1. 先觸發 resume：這是唯一不可失敗的動作。若整體超過 3 秒被 Slack 判逾時，
    //    GAS 本身仍會跑完，但把最關鍵的一步放在前面可將風險降到最低。
    dispatchResume(jiraId, pipeline, questionId, choice, user);

    // 清掉文字回覆用的上下文（該題已定案）
    _clearDecisionContext_({ question_id: questionId, conversation: conv });

    // 2. 再更新卡片消除按鈕。優先走 response_url（免 token、少一次認證握手），
    //    失敗才退回 chat.update。
    //    若日後實測仍常逾時，升級路徑是把 dispatch 丟進 PropertiesService 佇列，
    //    改由 ScriptApp.newTrigger(...).after(1000) 非同步送出——代價是需要
    //    script.scriptapp 授權，且多出「trigger 沒跑就永遠不 resume」的靜默失敗模式，
    //    因此目前不採用。
    provider.resolveDecision(conv, messageId, choice, user, timeStr, jiraId, interaction.responseUrl);

  } finally {
    lock.releaseLock();
  }

  return _emptyResponse_();
}
