// ═══════════════════════════════════════════════════════════════════
//  手動診斷（在 GAS 編輯器裡選函式 → 執行，看執行記錄）
//
//  為什麼需要它：Slack App 設定頁上「宣告的 scope」與「token 實際帶的 scope」
//  是兩件事。改過 scope 之後必須重新安裝 App，而重新安裝會**發新的 bot token**
//  ——設定頁看起來完全正確，但 Script Properties 裡還是舊 token，症狀就是
//  conversations.replies 一直回 missing_scope。
//
//  這支函式直接印出 token 實際擁有的 scope（來自回應的 x-oauth-scopes header），
//  一眼就能分辨是「沒重新安裝」還是「token 沒更新」。
//
//  ⚠️ 全程不印任何 token 值，只印 scope 與 ok/error。
// ═══════════════════════════════════════════════════════════════════

function diagnoseSlackAccess() {
  const props = PropertiesService.getScriptProperties();

  console.log('── Script Properties（只列 key，不印值）──');
  ['SLACK_BOT_TOKEN', 'GITHUB_TOKEN', 'NOTIFY_KEY', 'CHAT_PROVIDER'].forEach(function (k) {
    const v = props.getProperty(k);
    console.log('  ' + k + ': ' + (v ? '已設定（長度 ' + v.length + '）' : '❌ 未設定'));
  });

  const token = props.getProperty('SLACK_BOT_TOKEN');
  if (!token) {
    console.log('SLACK_BOT_TOKEN 沒設，後面的檢查沒有意義。');
    return;
  }

  console.log('');
  console.log('── token 實際帶的 scope（這是關鍵）──');
  try {
    const res = UrlFetchApp.fetch('https://slack.com/api/auth.test', {
      method: 'post',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });

    // Slack 把 token 真正擁有的 scope 放在回應 header 裡，不在 body。
    // 設定頁上打勾但這裡沒出現，就代表 token 是重新安裝前發的那一把。
    const headers = res.getAllHeaders();
    const scopes = headers['x-oauth-scopes'] || headers['X-OAuth-Scopes'] || '(header 不存在)';
    console.log('  x-oauth-scopes: ' + scopes);

    const need = ['channels:history', 'groups:history', 'chat:write', 'app_mentions:read'];
    const have = String(scopes).split(',').map(function (x) { return x.trim(); });
    need.forEach(function (n) {
      console.log('  ' + (have.indexOf(n) >= 0 ? '✅' : '❌') + ' ' + n);
    });

    const auth = JSON.parse(res.getContentText());
    console.log('  auth.test ok=' + auth.ok + (auth.ok
      ? ('  team=' + auth.team + '  bot=' + auth.user)
      : ('  error=' + auth.error)));
  } catch (err) {
    console.error('  auth.test 呼叫失敗:', err);
  }

  console.log('');
  console.log('── 最近一次 thread 反查失敗（在 Slack 試一次再跑這支）──');
  const raw = props.getProperty('last_route_fail');
  if (!raw) {
    console.log('  沒有紀錄。請先在 Slack 的 thread 裡 @Alice 說句話，再回來執行這支函式。');
    return;
  }

  let fail;
  try { fail = JSON.parse(raw); } catch (e) { console.log('  紀錄壞了：' + raw); return; }
  console.log('  時間：' + fail.at + '　原因代碼：' + fail.err);
  console.log('  channel=' + fail.ch + '　thread_ts=' + fail.ts);

  console.log('');
  console.log('── 用同一組參數重打 conversations.replies，印出完整回應 ──');
  try {
    const url = 'https://slack.com/api/conversations.replies' +
                '?channel=' + encodeURIComponent(fail.ch) +
                '&ts=' + encodeURIComponent(fail.ts) + '&limit=1';
    const res2 = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
    console.log('  HTTP ' + res2.getResponseCode());
    const body = JSON.parse(res2.getContentText());
    if (body.ok) {
      const first = (body.messages && body.messages[0]) || {};
      console.log('  ✅ 讀到了。第一則訊息的 text：');
      console.log('     ' + String(first.text || '(空)').slice(0, 300));
      console.log('  → 若這裡讀得到，代表 scope 已生效，重新在 Slack 試一次即可');
      console.log('    （反查結果有 6 小時快取，可執行 clearRouteCache() 清掉）');
    } else {
      console.log('  ❌ error=' + body.error);
      if (body.error === 'missing_scope') {
        console.log('     needed=' + (body.needed || '?') + '  provided=' + (body.provided || '?'));
        console.log('     → provided 就是這把 token 真正擁有的 scope。');
        console.log('       裡面沒有 channels:history 的話：到 Slack App 設定頁按');
        console.log('       "Reinstall to Workspace"，然後把新的 Bot User OAuth Token');
        console.log('       貼回 Script Properties 的 SLACK_BOT_TOKEN——重新安裝會發新 token。');
      } else if (body.error === 'not_in_channel') {
        console.log('     → 把 Alice 邀請進這個頻道：/invite @F2E-Alice');
      } else if (body.error === 'channel_not_found') {
        console.log('     → 私人頻道需要 groups:history，且 Alice 必須是成員');
      }
    }
  } catch (err) {
    console.error('  重打失敗:', err);
  }
}


/** 清掉 thread → 單號 的反查快取（scope 修好後用，免得等 6 小時）。 */
function clearRouteCache() {
  // CacheService 沒有「列出所有 key」的 API，所以只能清掉有紀錄的那一筆。
  // 這也夠用了——診斷情境下就是那個 thread 反查失敗。
  const raw = PropertiesService.getScriptProperties().getProperty('last_route_fail');
  if (!raw) {
    console.log('沒有失敗紀錄可清。快取本來就只有 6 小時，等它過期也行。');
    return;
  }
  try {
    const fail = JSON.parse(raw);
    CacheService.getScriptCache().remove('route_' + fail.ts);
    console.log('已清掉 route_' + fail.ts + ' 的快取，回 Slack 再試一次。');
  } catch (err) {
    console.error('清快取失敗:', err);
  }
}
