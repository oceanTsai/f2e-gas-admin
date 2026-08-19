// ═══════════════════════════════════════════════════════════════════
//  messageDispatch — 出向通訊層入口
//
//  方向：GitHub Actions (runner) → 這裡 → Slack
//
//  為什麼與 slackBotProxy 分成兩個專案：
//
//  1. 信任邊界不同。入向要驗「這真的是 Slack 嗎」，出向要驗「這真的是 runner
//     嗎」。混在同一個 /exec 裡意味著一把 key 洩漏就兩邊全開。
//  2. LockService 是 per-script 的單一鎖。拆開後，出向貼卡片不會和入向的答覆
//     處理（未來還有意圖識別的 LLM 呼叫）搶同一把鎖。
//  3. 部署節奏不同。卡片長相會一直調，入向的路由邏輯穩定。
//
//  這一側完全無狀態——原因見 core/outbound.js 的說明。
// ═══════════════════════════════════════════════════════════════════

function doPost(e) {
  try {
    // GAS 的 doPost 取不到 HTTP headers，所以驗證只能靠 URL 的 ?k=。
    // 這把 key 與 slackBotProxy 的互動金鑰刻意分開：一把洩漏不會兩邊全開。
    const key = (e && e.parameter) ? e.parameter.k : null;

    let body = {};
    if (e && e.postData && e.postData.contents) {
      try {
        body = JSON.parse(e.postData.contents);
      } catch (err) {
        return _json_({ error: 'Invalid JSON body' });
      }
    }

    // action 走 query string（?action=decision）或 JSON body（{"action":"decision"}）
    // 都接受：notify-question.sh 走 body，早期版本走 query string。
    const action = (e && e.parameter && e.parameter.action) || body.action;
    if (!action) {
      return _json_({ error: 'Missing action（預期 decision 或 progress）' });
    }

    const provider = getProvider();

    switch (action) {
      case 'decision':
        return handleDecisionRequest(body, key, provider);

      case 'progress':
        return handleProgressUpdate(body, key, provider);

      default:
        return _json_({ error: 'Unknown action: ' + action });
    }
  } catch (error) {
    console.error('doPost 執行異常:', error);
    return _json_({ error: String((error && error.message) || error) });
  }
}


// GET 只用來確認部署是否存活。
function doGet() {
  return _json_({ status: 'ok', role: 'outbound message dispatcher' });
}


function _json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
