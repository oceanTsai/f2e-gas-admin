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

  // 使用 LockService 防止同時間多人連點競態
  const lock = LockService.getScriptLock();
  const hasLock = lock.tryLock(3000);

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

    // 1. 即時將卡片按鈕替換為純文字，消除按鈕防止再次點擊
    provider.resolveDecision(conv, messageId, choice, user, timeStr, jiraId);

    // 2. 觸發 GitHub Actions 恢復 Pipeline (repository_dispatch: resume)
    dispatchResume(jiraId, pipeline, questionId, choice, user);

  } finally {
    lock.releaseLock();
  }

  return _emptyResponse_();
}
