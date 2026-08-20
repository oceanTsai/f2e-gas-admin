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


// ═══════════════════════════════════════════════════════════════════
//  批次回覆結果回報（由 augma 的 notify-answer-result.sh 呼叫）
//
//  為什麼這則要由 augma 發、而不是通訊層自己回：
//  入向的 GAS 收到整串貼上時，只用行首樣式**撈題號**去查去重快取——它不配對
//  答案、不查閘門、也不知道 progress.json 裡那些題現在是什麼狀態。所以它只能
//  回一句中性的「已收下，正在套用」。實際寫進幾題、哪幾題被閘門擋下、哪幾題
//  對不上，要等 update-progress.sh answer-batch 跑完才知道。
//
//  卡片按鈕的說明也放在這裡：文字回覆路徑刻意不動原卡片（app_mention 拿不到
//  payload.message.blocks，只能整張替換，那會把其他題的按鈕一起吃掉）。
//  去重鎖已經保證按了不會重複處理，所以這只是體感問題——用一句話講清楚就好。
// ═══════════════════════════════════════════════════════════════════

function handleAnswerResult(body, key, provider) {
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

  const s = body.summary || {};
  const jiraId = body.jira_id || '';
  const list = function (a) { return (a || []).join('、'); };
  const n = function (a) { return (a || []).length; };

  const lines = [];
  const by = s.by ? (s.by + ' ') : '';

  if (n(s.applied)) {
    lines.push('✅ ' + by + '的批次回覆已寫入 ' + jiraId + '：' + list(s.applied));
  } else {
    lines.push('ℹ️ ' + by + '貼上的內容沒有寫入任何一題（' + jiraId + '）。');
  }

  if (n(s.skipped_already_answered)) {
    lines.push('• ' + list(s.skipped_already_answered) + ' 先前已有答覆，這次未覆蓋。');
  }
  if (n(s.rejected_gate)) {
    lines.push('• ' + list(s.rejected_gate) + ' 是放行閘門，只能點卡片按鈕——' +
               '文字回覆不生效（phase-guard 看到「有答覆」就會放行，不解讀語意）。');
  }
  if (n(s.unmatched)) {
    lines.push('⚠️ ' + list(s.unmatched) + ' 在這張單裡找不到對應的題，已忽略。' +
               '（補問清單與流程的題號可能不同步，請回報）');
  }
  if (n(s.ignored_assumptions)) {
    lines.push('• 已忽略 ' + n(s.ignored_assumptions) + ' 條 AI 假設確認（' +
               list(s.ignored_assumptions) + '）——目前沒有地方記錄它們。');
  }

  if (n(s.still_pending)) {
    lines.push('');
    lines.push('🔴 還有 ' + n(s.still_pending) + ' 題待回覆，全部答完才會接續：' +
               list(s.still_pending));
  } else if (n(s.applied)) {
    lines.push('');
    lines.push('🎉 本階段全部答完，流程接續中…');
  }

  if (n(s.applied)) {
    lines.push('_卡片上這幾題的按鈕可以忽略，點了會被擋下。_');
  }

  provider.postMessage(conv.channel, lines.join('\u000a'), conv.thread || conv.thread_ts || null);

  return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
    .setMimeType(ContentService.MimeType.JSON);
}


// ═══════════════════════════════════════════════════════════════════
//  自由提問的答案（由 augma 的 notify-ask-result.sh 呼叫）
//
//  ⚠️ 這支必須對「沒有答案」也發訊息。呼叫端是 `if: always()`，因為人在 Slack
//     收到的最後一則是「已收到，正在查」——沉默的話他會一直等，然後再問一次，
//     又燒一次 runner。所以 agent 掛掉、逾時、沒寫出檔案，這裡都要講出來。
// ═══════════════════════════════════════════════════════════════════

function handleAskResult(body, key, provider) {
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

  const answer = String(body.answer || '').trim();
  const lines = [];

  if (answer) {
    lines.push(answer);
    if (body.truncated) {
      lines.push('');
      lines.push('_（答案過長已截斷。完整內容在分支 `ask/' + (body.ask_id || '') + '` 的 `workspace/ask-outputs/answer.md`，保留三天。）_');
    }
  } else {
    // 沒有答案時要分辨原因——兩種的下一步完全不同
    const failed = (body.status === 'failed') || !!body.error;
    lines.push(failed
      ? '⚠️ 這次沒能回答，過程中出錯了。'
      : '⚠️ 這次沒能回答（可能是逾時，或問題太發散）。換個更具體的問法再試一次通常有效。');
    if (body.error) {
      lines.push('```' + String(body.error).slice(0, 300) + '```');
    }
    if (body.run_url) {
      lines.push('<' + body.run_url + '|執行記錄>');
    }
  }

  provider.postMessage(conv.channel, lines.join('\u000a'), conv.thread || conv.thread_ts || null);

  return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
    .setMimeType(ContentService.MimeType.JSON);
}
