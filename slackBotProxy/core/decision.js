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

  return ContentService.createTextOutput(JSON.stringify({
    status: 'ok',
    message: 'Decision card posted successfully',
    message_id: messageId
  })).setMimeType(ContentService.MimeType.JSON);
}

// 互動回應必須是空 body：Slack 會把任何非空回應當成「替換原訊息」的內容，
// 一旦回傳純文字，整張卡片（含按鈕）就會被那行字取代——問題還沒回答，按鈕卻永久消失。
// 所有要給使用者看的提示，一律走 response_url 的 ephemeral 訊息。
function _emptyResponse_() {
  return ContentService.createTextOutput('');
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
