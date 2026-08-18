// ═══════════════════════════════════════════════════════════════════
//  Alice - GAS 統一入口主程式 (main.js)
//  負責 HTTP doPost 請求路由分流、Provider 調用與業務轉發
// ═══════════════════════════════════════════════════════════════════

function doPost(e) {
  try {
    const provider = getProvider();

    // 【分支 1】Decision Gateway 通知請求 (來自 Runner / notify-question.sh)
    if (e.parameter && e.parameter.action === 'decision') {
      let body = {};
      if (e.postData && e.postData.contents) {
        try { body = JSON.parse(e.postData.contents); } catch (err) {}
      }
      return handleDecisionRequest(body, e.parameter.k, provider);
    }

    // 【分支 2】按鈕互動 (Interactivity)
    // 注意：/exec 為 ANYONE_ANONYMOUS 且 GAS 的 doPost(e) 取不到 HTTP headers，
    // 無法驗 X-Slack-Signature；改以 URL 的 ?k= 作為唯一憑據，故必須往下傳。
    if (e.parameter && e.parameter.payload) {
      const payload = JSON.parse(e.parameter.payload);
      return handleInteraction(payload, provider, e.parameter.k);
    }

    // 【分支 3】Slash Command
    if (e.parameter && e.parameter.command) {
      return _routeSlashCommand_(e, provider);
    }

    // 【分支 4】Event (如 @Alice app_mention) 或 JSON Body
    if (e.postData && e.postData.contents) {
      let body;
      try {
        body = JSON.parse(e.postData.contents);
      } catch (err) {
        return ContentService.createTextOutput('Invalid JSON body');
      }

      // JSON Body 傳送之 decision / progress 請求（皆來自 runner）
      if (body && body.action === 'decision') {
        const key = e.parameter ? e.parameter.k : null;
        return handleDecisionRequest(body, key, provider);
      }
      if (body && body.action === 'progress') {
        const key = e.parameter ? e.parameter.k : null;
        return handleProgressUpdate(body, key, provider);
      }

      // URL Verification 挑戰 (Slack 驗證)
      if (body.type === 'url_verification') {
        return ContentService.createTextOutput(body.challenge);
      }

      // app_mention 事件
      if (body.event && body.event.type === 'app_mention' && !body.event.bot_id) {
        return _routeMentionEvent_(body.event, provider);
      }
    }

    return ContentService.createTextOutput('ok');
  } catch (error) {
    console.error('doPost 執行異常:', error);
    return ContentService.createTextOutput('Error: ' + error.message);
  }
}


// ═══════════════════════════════════════════════════════════════════
//  Slash Command 與 Mention 路由
// ═══════════════════════════════════════════════════════════════════

function _routeSlashCommand_(e, provider) {
  const command = e.parameter.command;
  const text    = (e.parameter.text || '').trim();
  const user    = e.parameter.user_id;
  const channel = e.parameter.channel_id;

  const conv = { channel: channel, thread: null };

  switch (command) {
    case '/test':
      provider.postWebhook(
        '🧪 /test 測試\n' +
        '• 收到參數：`' + (text || '(無)') + '`\n' +
        '• 觸發者：<@' + user + '>\n' +
        '• 來源頻道：`' + channel + '`\n'
      );
      return ContentService.createTextOutput('🧪 test 已送出');

    case '/ra':
      _triggerPipelineTask_('ra-pipeline', text, conv, user, provider);
      return ContentService.createTextOutput('🚀 收到，RA 需求分析任務派發中…');

    case '/sa':
      _triggerPipelineTask_('sa-pipeline', text, conv, user, provider);
      return ContentService.createTextOutput('🚀 收到，SA 系統分析任務派發中…');

    case '/answer':
      handleTextAnswer(text, conv, user, provider);
      return ContentService.createTextOutput('📝 已收到你的答覆，正在處理…');

    case '/coding':
      provider.postMessage(channel, `<@${user}> ✅ coding 任務已收到\n參數：\`${text || '(無)'}\``);
      return ContentService.createTextOutput('🚀 收到，coding 處理中…');

    case '/deploy':
      provider.postMessage(channel, `<@${user}> ✅ deploy 任務已收到\n參數：\`${text || '(無)'}\``);
      return ContentService.createTextOutput('🚀 收到，deploy 處理中…');

    case '/bug':
      provider.postMessage(channel, `<@${user}> 🐛 bug 已送進 triage\n內容：\`${text || '(無)'}\``);
      return ContentService.createTextOutput('🐛 收到，已送進 triage…');

    default:
      return ContentService.createTextOutput('未知指令：' + command);
  }
}

function _routeMentionEvent_(event, provider) {
  const text = event.text.replace(/<@[^>]+>\s*/, '').trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const args = rest.join(' ').trim();

  const conv = {
    channel: event.channel,
    thread: event.thread_ts || null
  };

  switch (cmd.toLowerCase()) {
    case 'test':
      provider.postWebhook(
        '🧪 @Alice test 測試\n' +
        '• 收到參數：`' + (args || '(無)') + '`\n' +
        '• 觸發者：<@' + event.user + '>\n' +
        '• 來源頻道：`' + event.channel + '`'
      );
      break;

    case 'ra':
      _triggerPipelineTask_('ra-pipeline', args, conv, event.user, provider);
      break;

    case 'sa':
      _triggerPipelineTask_('sa-pipeline', args, conv, event.user, provider);
      break;

    // 以文字回覆待決問題（按鈕只能傳回預設選項，表達不了「要改成什麼」）
    case 'answer':
    case 'ans':
      handleTextAnswer(args, conv, event.user, provider);
      break;

    case 'coding':
      provider.postMessage(event.channel, `<@${event.user}> ✅ coding 任務已收到\n參數：\`${args || '(無)'}\``, event.thread_ts);
      break;

    case 'deploy':
      provider.postMessage(event.channel, `<@${event.user}> ✅ deploy 任務已收到\n參數：\`${args || '(無)'}\``, event.thread_ts);
      break;

    case 'bug':
      provider.postMessage(event.channel, `<@${event.user}> 🐛 bug 已送進 triage\n內容：\`${args || '(無)'}\``, event.thread_ts);
      break;

    default:
      provider.postMessage(
        event.channel,
        '👋 收到你的 @！\n' +
        '• 啟動分析：`@Alice ra <JIRA_ID>`、`@Alice sa <JIRA_ID>`\n' +
        '• 回覆待決問題：`@Alice answer <你的答覆>`（在決策卡片的 thread 內）\n' +
        '• 當前收到：`' + (cmd || '(空)') + ' ' + (args || '') + '`',
        event.thread_ts
      );
  }
  return ContentService.createTextOutput('ok');
}

function _triggerPipelineTask_(pipelineType, jiraId, conv, user, provider) {
  if (!jiraId) {
    provider.postMessage(conv.channel, `<@${user}> ⚠️ 請提供 Jira ID（例：\`@Alice ${pipelineType === 'ra-pipeline' ? 'ra' : 'sa'} VIPOP-12345\`）`, conv.thread);
    return;
  }

  const cleanJiraId = jiraId.trim().toUpperCase();

  // 1. 發送「任務受理」訊息，取得 thread 錨點
  const acceptMsg = `🚀 收到 <@${user}> 的任務請求，正在啟動 ${pipelineType.toUpperCase()} (\`${cleanJiraId}\`)...`;
  const anchoredConv = provider.postAccepted(conv, acceptMsg);

  // 2. 觸發 GitHub Actions Pipeline
  const ok = dispatchPipeline(pipelineType, cleanJiraId, anchoredConv);

  if (ok) {
    // 刻意不再發第二則訊息：上面那則「任務受理」會被 notify-progress 持續更新成
    // 進度看板（含階段清單與 Actions 連結），再發一則只是洗頻。
    console.log('已觸發 ' + pipelineType + '：' + cleanJiraId);
  } else {
    provider.postMessage(
      anchoredConv.channel,
      `⚠️ <@${user}> 觸發 GitHub Actions 失敗，請確認 GITHUB_TOKEN 配置與日誌。`,
      anchoredConv.thread
    );
  }
}
