

const PROPS = PropertiesService.getScriptProperties();
const SLACK_TOKEN = PROPS.getProperty('SLACK_BOT_TOKEN');
// 測試用 webhook(綁死一個頻道,免 token)
const TEST_WEBHOOK_URL = PROPS.getProperty('TEST_WEBHOOK_URL');

// ── 入口：所有 git actions. 結束時想回應呼叫
function doPost(e) {  
}



// ── 發送方式一：webhook(免 token,固定頻道,測試用)──
function _postWebhook_(text) {
  // UrlFetchApp.fetch(TEST_WEBHOOK_URL, {
  //   method: 'post',
  //   contentType: 'application/json',
  //   payload: JSON.stringify({ text: text }),
  //   muteHttpExceptions: true
  // });
}

// ── 發送方式二：chat.postMessage(需 token,回指定頻道)──
function _postSlack_(channel, text) {
  // UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
  //   method: 'post',
  //   contentType: 'application/json',
  //   headers: { Authorization: 'Bearer ' + SLACK_TOKEN },
  //   payload: JSON.stringify({ channel: channel, text: text }),
  //   muteHttpExceptions: true
  // });
}





