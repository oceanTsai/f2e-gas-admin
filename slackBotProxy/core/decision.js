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

  // 存下決策上下文，供文字回覆（@Alice answer）反查。
  // 按鈕點擊不需要這個（jira_id / pipeline 就藏在 button value 裡），但文字回覆只有
  // 一句話，必須靠 thread 或 question_id 才能回推是哪張單、要接續哪個 pipeline。
  _saveDecisionContext_({
    question_ids: questions.map(function (q) { return q.id; }),
    // 以第一題的 resume_action 代表整組（同一 Phase 的題目型別一致）
    resume_action: questions[0].resume_action || 'continue',
    jira_id: jiraId,
    phase: phase,
    pipeline: pipeline,
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

function _ctxThreadKey_(conv) {
  const thread = conv && (conv.thread || conv.channel);
  return thread ? ('dctx_t_' + thread) : null;
}

function _saveDecisionContext_(ctx) {
  const props = PropertiesService.getScriptProperties();
  // 每題各存一份（供 @Alice answer Q-00X 直接命中）
  (ctx.question_ids || []).forEach(function (qid) {
    if (!qid) return;
    const one = JSON.parse(JSON.stringify(ctx));
    one.question_id = qid;
    props.setProperty('dctx_q_' + qid, JSON.stringify(one));
  });
  // thread 再存一份（供在 thread 內省略編號時反查）
  const tk = _ctxThreadKey_(ctx.conversation);
  if (tk) props.setProperty(tk, JSON.stringify(ctx));
}

function _loadDecisionContext_(questionId, thread) {
  const props = PropertiesService.getScriptProperties();

  if (questionId) {
    const raw = props.getProperty('dctx_q_' + questionId);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (err) { return null; }
  }

  if (!thread) return null;
  const raw = props.getProperty('dctx_t_' + thread);
  if (!raw) return null;

  let ctx;
  try { ctx = JSON.parse(raw); } catch (err) { return null; }

  // 未指定編號時，挑「還沒被回答」的第一題。多題情境下這是最符合直覺的解讀。
  const cache = CacheService.getScriptCache();
  const ids = ctx.question_ids || (ctx.question_id ? [ctx.question_id] : []);
  const msgId = ctx.message_id || '';
  const pending = ids.filter(function (qid) { return !cache.get('answered_' + msgId + '_' + qid); });
  if (pending.length === 0) return null;

  ctx.question_id = pending[0];
  ctx.remaining = pending.length;
  return ctx;
}

// 只清掉「這一題」——同一張卡片的其他題還要能繼續回答
function _clearQuestionContext_(questionId) {
  if (!questionId) return;
  PropertiesService.getScriptProperties().deleteProperty('dctx_q_' + questionId);
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
    const cacheKey = 'answered_' + (ctx.message_id || '') + '_' + ctx.question_id;
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

    // 2. 刻意**不動原卡片**：文字回覆走 app_mention 事件，拿不到 payload.message.blocks，
    //    只能整張替換——那會把同一張卡片上其他題的按鈕一起吃掉。
    //    該題若被重複點擊，會被 answered_<qid> 快取擋下並收到 ephemeral 提示，
    //    所以按鈕留著不會造成重複處理。

    if (ok) {
      _clearQuestionContext_(ctx.question_id);
      const remaining = (ctx.remaining || 1) - 1;
      const tail = remaining > 0
        ? '（本張卡片還有 ' + remaining + ' 題待回覆，全部答完才會接續）'
        : '正在接續 ' + ctx.pipeline + '（' + ctx.jira_id + '）…';
      provider.postMessage(conv.channel,
        '\u2705 已收下 <@' + user + '> 對 ' + ctx.question_id + ' 的回覆。' + tail, conv.thread);
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
    const cacheKey = `answered_${messageId}_${questionId}`;

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
    const ctx = _loadDecisionContext_(questionId, null);
    let progressText = '';
    if (ctx && ctx.question_ids && ctx.question_ids.length) {
      const total = ctx.question_ids.length;
      const remaining = ctx.question_ids.filter(function (qid) {
        return !cache.get('answered_' + messageId + '_' + qid);
      });
      const answered = total - remaining.length;
      progressText = (remaining.length === 0)
        ? '*執行階段*：`' + (ctx.phase || '') + '`\n✅ 全部 *' + total +
          '* 題已回答完畢，正在接續 `' + (ctx.pipeline || '') + '`…'
        : '*執行階段*：`' + (ctx.phase || '') + '`\n共 *' + total + '* 題待決議（已回答 ' +
          answered + '／' + total + '），**每題都回答完**才會接續後續流程。';
    }

    // 只清掉這一題的上下文；同一張卡片的其他題還要能繼續回答
    _clearQuestionContext_(questionId);

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
