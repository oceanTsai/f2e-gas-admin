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

function handleInteraction(payload, provider) {
  const interaction = provider.parseInteraction(payload);
  if (!interaction) {
    return ContentService.createTextOutput('');
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
    return ContentService.createTextOutput('系統忙碌中，請稍後');
  }

  try {
    const cache = CacheService.getScriptCache();
    const cacheKey = `answered_${questionId}`;

    if (cache.get(cacheKey)) {
      // 該問題已經回答過，直接略過
      return ContentService.createTextOutput('');
    }

    // 標記為已回答 (快取 6 小時)
    cache.put(cacheKey, 'true', 21600);

    const now = new Date();
    const timeStr = Utilities.formatDate(now, 'Asia/Taipei', 'HH:mm:ss');

    // 1. 即時將卡片按鈕替換為純文字，消除按鈕防止再次點擊
    provider.resolveDecision(conv, messageId, choice, user, timeStr, jiraId);

    // 2. 觸發 GitHub Actions 恢復 Pipeline (repository_dispatch: resume)
    dispatchResume(jiraId, pipeline, questionId, choice, user);

  } finally {
    lock.releaseLock();
  }

  return ContentService.createTextOutput('');
}
