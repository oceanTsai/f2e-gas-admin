// ═══════════════════════════════════════════
//  Alice - 一個 GAS URL 接所有 Slack 觸發
// ═══════════════════════════════════════════

const props = PropertiesService.getScriptProperties();
const SLACK_TOKEN = props.getProperty('SLACK_TOKEN');

// 測試用 webhook(綁死一個頻道,免 token)
const TEST_WEBHOOK_URL = props.getProperty('TEST_WEBHOOK_URL');

// ── 入口：所有 Slack 請求都進這 ──
function doPost(e) {

  // 【A】Slash command → 表單格式
  if (e.parameter && e.parameter.command) {
    return _routeSlash_(e);
  }

  // 【B】Event(@Alice…) → JSON 格式
  const body = JSON.parse(e.postData.contents);

  if (body.type === 'url_verification') {
    return ContentService.createTextOutput(body.challenge);
  }

  if (body.event && body.event.type === 'app_mention' && !body.event.bot_id) {
    return _routeMention_(body.event);
  }

  return ContentService.createTextOutput('ok');
}


// ── Slash command 分流 ──
function _routeSlash_(e) {
  const command = e.parameter.command;    // "/coding"
  const text    = e.parameter.text;       // "VIPOP-123"
  const user    = e.parameter.user_id;
  const channel = e.parameter.channel_id;

  switch (command) {
    case '/test':
      _postWebhook_(
        '🧪 /test 測試\n' +
        '• 收到參數：`' + (text || '(無)') + '`\n' +
        '• 觸發者：<@' + user + '>\n' +
        '• 來源頻道：`' + channel + '`\n' +
        '（走 webhook,固定回這頻道）'
      );
      return ContentService.createTextOutput('🧪 test 已送出(webhook)');

    case '/ra':
      _doRa_(text, channel, user);
      return ContentService.createTextOutput('🚀 收到，RA 任務已派發…');

    case '/coding':
      _doCoding_(text, channel, user);
      return ContentService.createTextOutput('🚀 收到，coding 處理中…');
    case '/deploy':
      _doDeploy_(text, channel, user);
      return ContentService.createTextOutput('🚀 收到，deploy 處理中…');
    case '/bug':
      _doBug_(text, channel, user);
      return ContentService.createTextOutput('🐛 收到，已送進 triage…');
    default:
      return ContentService.createTextOutput('未知指令：' + command);
  }
}


// ── @提及 分流 ──
function _routeMention_(event) {
  const text = event.text.replace(/<@[^>]+>\s*/, '').trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const args = rest.join(' ');

  switch (cmd) {
    case 'test':
      _postWebhook_(
        '🧪 @Alice test 測試\n' +
        '• 收到參數：`' + (args || '(無)') + '`\n' +
        '• 觸發者：<@' + event.user + '>\n' +
        '• 來源頻道：`' + event.channel + '`\n' +
        '（走 webhook,固定回這頻道）'
      );
      break;

    // ★ 新增 ra 指令
    case 'ra':
      _doRa_(args, event.channel, event.user);
      break;

    case 'coding': _doCoding_(args, event.channel, event.user); break;
    case 'deploy': _doDeploy_(args, event.channel, event.user); break;
    case 'bug':    _doBug_(args, event.channel, event.user);    break;

    default:
      _postSlack_(event.channel,
        '👋 收到你的 @，GAS 正常運作！\n' +
        '• 指令：`' + (cmd || '(空)') + '`\n' +
        '• 參數：`' + (args || '(無)') + '`\n' +
        '• 頻道：`' + event.channel + '`'
      );
  }
  return ContentService.createTextOutput('ok');
}


// ═══════════════════════════════════════════
//  各服務處理
// ═══════════════════════════════════════════

// ★ 觸發 GitHub Actions 的 RA Workflow
function _doRa_(jiraId, channel, user) {
  if (!jiraId) {
    _postSlack_(channel, `<@${user}> ⚠️ 請提供 Jira ID 或需求訊息（例：\`@Alice ra VIPOP-12345\`）`);
    return;
  }

  const githubToken = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!githubToken) {
    _postSlack_(channel, `❌ 錯誤：GAS 指令碼屬性中尚未設定 \`GITHUB_TOKEN\``);
    return;
  }

  const repoUrl = 'https://api.github.com/repos/104corp/104.vip.f2e.augma/dispatches';
  
  const payload = {
    event_type: 'ra-workflow',
    client_payload: {
      jira_id: jiraId.trim()
    }
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': `token ${githubToken}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'GAS-Slack-Bot'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const res = UrlFetchApp.fetch(repoUrl, options);
    const code = res.getResponseCode();

    if (code === 204) {
      _postSlack_(
        channel,
        `🤖 <@${user}> 已成功觸發 RA Workflow！\n` +
        `• **Jira ID**：\`${jiraId}\`\n` +
        `• **Repo**：\`104corp/104.vip.f2e.augma\`\n` +
        `• [查看 Actions 執行進度](https://github.com/104corp/104.vip.f2e.augma/actions)`
      );
    } else {
      _postSlack_(
        channel,
        `⚠️ <@${user}> 觸發 GitHub Workflow 失敗 (HTTP ${code})\n` +
        `錯誤訊息：\`${res.getContentText()}\``
      );
    }
  } catch (err) {
    _postSlack_(channel, `❌ 呼叫 GitHub API 發生異常：\`${err.message}\``);
  }
}

function _doCoding_(args, channel, user) {
  _postSlack_(channel, '<@' + user + '> ✅ coding 任務已收到\n參數：`' + (args || '(無)') + '`');
}

function _doDeploy_(args, channel, user) {
  _postSlack_(channel, '<@' + user + '> ✅ deploy 任務已收到\n參數：`' + (args || '(無)') + '`');
}

function _doBug_(args, channel, user) {
  _postSlack_(channel, '<@' + user + '> 🐛 bug 已送進 triage\n內容：`' + (args || '(無)') + '`');
}


// ── 發送方式一：webhook(免 token,固定頻道,測試用)──
function _postWebhook_(text) {
  UrlFetchApp.fetch(TEST_WEBHOOK_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: text }),
    muteHttpExceptions: true
  });
}

// ── 發送方式二：chat.postMessage(需 token,回指定頻道)──
function _postSlack_(channel, text) {
  UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + SLACK_TOKEN },
    payload: JSON.stringify({ channel: channel, text: text }),
    muteHttpExceptions: true
  });
}