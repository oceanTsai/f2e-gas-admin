// ═══════════════════════════════════════════════════════════════════
//  Alice - GAS 統一入口主程式 (main.js)
//  負責 HTTP doPost 請求路由分流、Provider 調用與業務轉發
// ═══════════════════════════════════════════════════════════════════

function doPost(e) {
  try {
    const provider = getProvider();

    // 出向（貼卡片、進度看板）已拆到 messageDispatch 專案。收到出向請求時必須
    // 明確報錯——notify-question.sh 只看 HTTP 狀態與「body 是不是帶 error 的
    // JSON」，這支 Web App 預設會回純文字 'ok'（HTTP 200），那會被判定成
    // 「卡片送出成功」而實際上什麼都沒發生：單子就這樣無聲卡死。
    const qsAction = (e && e.parameter) ? e.parameter.action : null;
    if (qsAction === 'decision' || qsAction === 'progress') {
      return _outboundMovedError_(qsAction);
    }

    // 【分支 1】按鈕互動 (Interactivity)
    // 注意：/exec 為 ANYONE_ANONYMOUS 且 GAS 的 doPost(e) 取不到 HTTP headers，
    // 無法驗 X-Slack-Signature；改以 URL 的 ?k= 作為唯一憑據，故必須往下傳。
    if (e.parameter && e.parameter.payload) {
      const payload = JSON.parse(e.parameter.payload);
      return handleInteraction(payload, provider, e.parameter.k);
    }

    // 【分支 2】Slash Command
    if (e.parameter && e.parameter.command) {
      return _routeSlashCommand_(e, provider);
    }

    // 【分支 3】Event（@Alice app_mention）
    // 出向的 decision / progress 已拆到 messageDispatch 專案，這裡不再受理。
    if (e.postData && e.postData.contents) {
      let body;
      try {
        body = JSON.parse(e.postData.contents);
      } catch (err) {
        return ContentService.createTextOutput('Invalid JSON body');
      }

      // URL Verification 挑戰 (Slack 驗證)
      if (body.type === 'url_verification') {
        return ContentService.createTextOutput(body.challenge);
      }

      // 同上，但走 JSON body——notify-question.sh / notify-progress.sh 用的是這種
      if (body && (body.action === 'decision' || body.action === 'progress')) {
        return _outboundMovedError_(body.action);
      }

      // ── Slack Events API 重送去重 ──
      // Slack 在 3 秒內沒收到 200 就重送（最多 3 次）。而 _triggerPipelineTask_ 要先貼
      // 受理訊息再 dispatch（兩次 UrlFetch），撞上 GAS 冷啟動就可能破 3 秒——同一句話
      // 會觸發兩三次 pipeline，而 phase job 的 concurrency 是 cancel-in-progress，
      // 後到的那次會在前一次 commit 中途把它砍掉。
      //
      // 只有 Events API 需要這層：slash command 與 interactivity 逾時只是顯示錯誤，
      // Slack 不會重送；decision / progress / url_verification 也都沒有 event_id。
      if (_isDuplicateEvent_(body.event_id)) {
        console.log('略過 Slack 重送事件：' + body.event_id);
        return ContentService.createTextOutput('duplicate ignored');
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


function _outboundMovedError_(action) {
  const msg = '出向請求（' + action + '）已改由 messageDispatch 專案處理。' +
              '請把 augma 的 AUGMA_NOTIFY_ENDPOINT 指向 messageDispatch 的 /exec。';
  console.error(msg);
  return ContentService
    .createTextOutput(JSON.stringify({ error: msg }))
    .setMimeType(ContentService.MimeType.JSON);
}


// ═══════════════════════════════════════════════════════════════════
//  重送去重
//
//  競態說明：Slack 的重送至少間隔一秒，而 cache.put 在進入實際處理之前就完成，
//  所以這裡刻意不上鎖——為每個事件取一次 LockService 的排隊成本，大於這點殘餘風險。
// ═══════════════════════════════════════════════════════════════════

function _isDuplicateEvent_(eventId) {
  if (!eventId) return false;
  const cache = CacheService.getScriptCache();
  const key = 'evt_' + eventId;
  if (cache.get(key)) return true;
  cache.put(key, '1', 600);   // Slack 的重送都在數十秒內結束，10 分鐘綽綽有餘
  return false;
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
        '• 觸發者：' + provider.mention(user) + '\n' +
        '• 來源頻道：`' + channel + '`\n'
      );
      return ContentService.createTextOutput('🧪 test 已送出');

    case '/light-ra':
      _triggerPipelineTask_('light-ra', text, conv, user, provider);
      return ContentService.createTextOutput('🚀 收到，Light-RA 輕量審查任務派發中…');

    case '/ra':
      _triggerPipelineTask_('ra-pipeline', text, conv, user, provider);
      return ContentService.createTextOutput('🚀 收到，RA 需求分析任務派發中…');

    case '/sa':
      _triggerPipelineTask_('sa-pipeline', text, conv, user, provider);
      return ContentService.createTextOutput('🚀 收到，SA 系統分析任務派發中…');

    case '/answer':
      handleTextAnswer(text, conv, user, provider);
      return ContentService.createTextOutput('📝 已收到你的答覆，正在處理…');

    case '/ask':
      handleAskRequest(text, conv, user, provider);
      return ContentService.createTextOutput('🔍 收到，正在查…');

    case '/coding':
      provider.postMessage(channel, `${provider.mention(user)} ✅ coding 任務已收到\n參數：\`${text || '(無)'}\``, _replyTarget_(conv));
      return ContentService.createTextOutput('🚀 收到，coding 處理中…');

    case '/deploy':
      provider.postMessage(channel, `${provider.mention(user)} ✅ deploy 任務已收到\n參數：\`${text || '(無)'}\``, _replyTarget_(conv));
      return ContentService.createTextOutput('🚀 收到，deploy 處理中…');

    case '/bug':
      provider.postMessage(channel, `${provider.mention(user)} 🐛 bug 已送進 triage\n內容：\`${text || '(無)'}\``, _replyTarget_(conv));
      return ContentService.createTextOutput('🐛 收到，已送進 triage…');

    default:
      return ContentService.createTextOutput('未知指令：' + command);
  }
}

function _routeMentionEvent_(event, provider) {
  const text = event.text.replace(/<@[^>]+>\s*/, '').trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const args = rest.join(' ').trim();

  // 他上傳的檔案／截圖。正規化交給 provider（那裡才認得 Slack 的欄位名），
  // 往下傳的已經是中性形狀 [{name, mime, size, url}]。
  //
  // ⚠️ 只有 **app_mention 事件**拿得到 files——slash command 的 payload 裡沒有
  //    這個欄位（Slack 不給），所以 `/ask` 那條路永遠沒有附件。要附檔就得
  //    `@Alice ask …`。這不是我們能修的，但值得知道，否則會以為壞了。
  const files = provider.parseFiles(event.files);

  // thread 與 replyTo 是兩件事，不能合併（見 core/conv.js 的說明）：
  //   thread  ── 真的在 thread 裡才有值，null 是反查用來省掉一次 Slack API 的依據
  //   replyTo ── 他那則訊息自己的 ts。Alice 的回覆要掛在它底下，而不是在頻道裡
  //              另起一則新訊息——提問與回答被拆成兩段時，越長的提問越難看
  const conv = {
    channel: event.channel,
    thread: event.thread_ts || null,
    replyTo: event.ts || null
  };

  switch (cmd.toLowerCase()) {
    case 'test':
      provider.postWebhook(
        '🧪 @Alice test 測試\n' +
        '• 收到參數：`' + (args || '(無)') + '`\n' +
        '• 觸發者：' + provider.mention(event.user) + '\n' +
        '• 來源頻道：`' + event.channel + '`'
      );
      break;

    case 'ra':
      _triggerPipelineTask_('ra-pipeline', args, conv, event.user, provider, files);
      break;

    case 'sa':
      _triggerPipelineTask_('sa-pipeline', args, conv, event.user, provider, files);
      break;

    case 'light-ra':
      _triggerPipelineTask_('light-ra', args, conv, event.user, provider, files);
      break;

    // 以文字回覆待決問題（按鈕只能傳回預設選項，表達不了「要改成什麼」）
    case 'answer':
    case 'ans':
      handleTextAnswer(args, conv, event.user, provider);
      break;

    // 自由提問。與 ra / sa / answer 同一層級，不經過意圖分類——
    // 意圖層掛掉時它還能用，熟手直接打也更快。
    case 'ask':
      handleAskRequest(args, conv, event.user, provider, files);
      break;

    case 'coding':
      provider.postMessage(event.channel, `${provider.mention(event.user)} ✅ coding 任務已收到\n參數：\`${args || '(無)'}\``, _replyTarget_(conv));
      break;

    case 'deploy':
      provider.postMessage(event.channel, `${provider.mention(event.user)} ✅ deploy 任務已收到\n參數：\`${args || '(無)'}\``, _replyTarget_(conv));
      break;

    case 'bug':
      provider.postMessage(event.channel, `${provider.mention(event.user)} 🐛 bug 已送進 triage\n內容：\`${args || '(無)'}\``, _replyTarget_(conv));
      break;

    // 不是已知指令 → 交給意圖識別（規則層）。
    // 已知指令刻意不走這條：意圖層掛掉時系統還能用，熟練使用者打指令也更快。
    default:
      routeByIntent(text, conv, event.user, provider, files);
      break;
  }
  return ContentService.createTextOutput('ok');
}

function _triggerPipelineTask_(pipelineType, jiraId, conv, user, provider, files) {
  if (!jiraId) {
    const hintMap = {
      'ra-pipeline': 'ra',
      'sa-pipeline': 'sa',
      'light-ra': 'light-ra'
    };
    const hint = hintMap[pipelineType] || 'ra';
    provider.postMessage(conv.channel, `${provider.mention(user)} ⚠️ 請提供 Jira ID（例：\`@Alice ${hint} VIPOP-12345\`）`, _replyTarget_(conv));
    return;
  }

  const cleanJiraId = jiraId.trim().toUpperCase();

  // 第二層防線：同一張單短時間內只觸發一次。上面的 event_id 去重擋 Slack 重送，
  // 這一層擋「使用者手滑連打兩次」以及去重漏網的情況。下游完全沒有保護——
  // GitHub 的 repository_dispatch 不去重，而 cancel-in-progress 會讓後到的那次
  // 砍掉前一次進行中的 commit。
  const trigCache = CacheService.getScriptCache();
  const trigKey = 'trig_' + pipelineType + '_' + cleanJiraId;
  if (trigCache.get(trigKey)) {
    provider.postMessage(
      conv.channel,
      `${provider.mention(user)} ⏳ ${cleanJiraId} 的 ${pipelineType} 剛剛已經觸發過了。若確定要重跑，請稍待一分鐘。`,
      _replyTarget_(conv)
    );
    return;
  }
  trigCache.put(trigKey, '1', 60);

  // 1. 發送「任務受理」訊息，取得 thread 錨點
  const acceptMsg = `🚀 收到 ${provider.mention(user)} 的任務請求，正在啟動 ${pipelineType.toUpperCase()} (\`${cleanJiraId}\`)...`;
  const anchoredConv = provider.postAccepted(conv, acceptMsg);

  // 2. 觸發 GitHub Actions Pipeline
  //    files 只有 app_mention 路徑有值（slash command 拿不到附件）。
  //    附一張規格截圖再說「@Alice ra VIPOP-123」是實際會發生的用法。
  const ok = dispatchPipeline(pipelineType, cleanJiraId, anchoredConv, user, files);

  if (ok) {
    // 刻意不再發第二則訊息：上面那則「任務受理」會被 notify-progress 持續更新成
    // 進度看板（含階段清單與 Actions 連結），再發一則只是洗頻。
    console.log('已觸發 ' + pipelineType + '：' + cleanJiraId);
  } else {
    provider.postMessage(
      anchoredConv.channel,
      `⚠️ ${provider.mention(user)} 觸發 GitHub Actions 失敗，請確認 GITHUB_TOKEN 配置與日誌。`,
      anchoredConv.thread
    );
  }
}
