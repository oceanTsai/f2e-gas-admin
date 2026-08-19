// ═══════════════════════════════════════════════════════════════════
//  出向處理：GitHub Actions (runner) → Slack
//
//  這一側刻意**完全無狀態**。
//
//  ScriptProperties 是 per-script 的：兩個 GAS 專案完全不共用。所以「貼卡片時
//  記下 thread 對應哪張單、答覆時讀出來」這種做法一拆就壞——寫在這邊，那邊讀不到。
//  正確的解法不是找一個共享儲存，而是**不要有狀態**：thread 的第一則訊息裡就有
//  單號，入向自己反查得到；其餘一切（pipeline、有哪些題、誰答過）都在 augma 的
//  progress.json 裡。
//
//  另一個好處：這支 Web App 只出不入、無狀態、只認一把 NOTIFY_KEY，攻擊面極小。
// ═══════════════════════════════════════════════════════════════════

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
  // questions 為多題陣列；question 是舊版單題欄位，保留相容
  const questions = (body.questions && body.questions.length)
    ? body.questions
    : [body.question || {}];
  const attachments = body.attachments || [];

  if (!conv.channel && !conv.space) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'Missing channel or space in conversation' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 透過 Provider 貼出互動卡片（一張訊息、逐題一組按鈕）
  const messageId = provider.postDecision(conv, {
    questions: questions,
    jiraId: jiraId,
    phase: phase,
    pipeline: pipeline,
    attachments: attachments
  });

  return ContentService.createTextOutput(JSON.stringify({
    status: 'ok',
    message: 'Decision card posted successfully',
    message_id: messageId
  })).setMimeType(ContentService.MimeType.JSON);
}


// ═══════════════════════════════════════════════════════════════════
//  進度回報：更新同一則「任務受理」訊息（由 notify-progress.sh 呼叫）
// ═══════════════════════════════════════════════════════════════════

function handleProgressUpdate(body, key, provider) {
  const notifyKey = PropertiesService.getScriptProperties().getProperty('NOTIFY_KEY');
  if (notifyKey && key !== notifyKey) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'Unauthorized: invalid notify key' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const conv = body.conversation || {};
  if (!conv.channel && !conv.space) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'Missing channel or space' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  provider.updateProgress(conv, {
    jiraId: body.jira_id,
    pipeline: body.pipeline,
    phases: body.phases || [],
    pendingQuestions: body.pending_questions || 0,
    runUrl: body.run_url || ''
  });

  return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
    .setMimeType(ContentService.MimeType.JSON);
}
