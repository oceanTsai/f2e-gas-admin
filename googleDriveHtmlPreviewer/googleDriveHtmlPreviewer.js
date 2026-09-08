/**
 * googleDriveHtmlPreviewer — 把 Drive 裡的 HTML 檔算繪出來給人看
 *
 * ⚠️ ARCHIVE_FOLDER_ID 必須與 gas/augma-html-upload 的 ROOT_FOLDER_ID 一致。
 *    上傳端寫到別的資料夾時，這裡一律回「找不到這個頁面」——而且是 200 的正常
 *    頁面，不是錯誤，上傳端完全看不出有問題。
 */

const ARCHIVE_FOLDER_ID = '1VgZA9Y1P6w5GafKDQPgXTZ-XpfpzBtsc';  // 專門放這些頁面的資料夾

function doGet(e) {
  const path = (e && e.parameter && e.parameter.p) || '';
  const segments = path.split('/').filter((s) => s !== '');
  const fileName = segments.pop();
  // 檔案所在的資料夾路徑：改寫相對連結時要把它接回去
  const folderPath = segments.join('/');

  try {
    const folder = segments.reduce((acc, name) => {
      let next = null;
      if (acc !== null) {
        const subs = acc.getFoldersByName(name);
        if (subs.hasNext()) {
          next = subs.next();
        }
      }
      return next;
    }, DriveApp.getFolderById(ARCHIVE_FOLDER_ID));

    let file = null;
    if (folder !== null && fileName) {
      const files = folder.getFilesByName(fileName);
      if (files.hasNext()) {
        file = files.next();
      }
    }

    if (file !== null) {
      const html = file.getBlob().getDataAsString('UTF-8');
      return HtmlService.createHtmlOutput(rewriteLinks_(html, folderPath))
        .setTitle(file.getName());
    }
  } catch (err) {
    // 以存取者身分執行時，沒有 Drive 權限的人一開啟就會在 DriveApp 這裡拋例外，
    // 這是常態路徑而非意外。不讓它冒到最上層的理由有二：
    //   1. GAS 的原始錯誤頁會把 ARCHIVE_FOLDER_ID 顯示出來，沒必要送給無權限的人。
    //   2. 「無權限」與「不存在」刻意回同一句話，否則兩者的差異可以被拿來
    //      逐一試誤、探測哪些路徑真的存在。
    // 真正的原因寫進 Cloud Logging，排查時用 clasp logs 看，使用者端看不到。
    console.error('doGet 讀取失敗 p=' + path + '：' + ((err && err.message) || err));
  }

  return HtmlService.createHtmlOutput('<h1>找不到這個頁面</h1>');
}

// ═══════════════════════════════════════════════════════════════════
//  補問清單的「送出答案」
//
//  checkList.html 是這支 GAS 用 HtmlService 算繪的，所以頁面跑在本專案的 sandbox
//  裡，google.script.run 直接到得了下面這支函式：不必處理 CORS，更重要的是
//  **不必把任何金鑰放進 HTML**——那份 HTML 躺在 Drive 上、分享給整個根資料夾的
//  名單，內嵌金鑰等於發給所有看得到任一張票的人。
//
//  ── 為什麼直接打 GitHub，而不是轉一手給 slackBotProxy ──
//  digest 模式下這一頁是**唯一**的作答入口：Slack 那則訊息沒有按鈕（走
//  notify-ra-result.sh），而文字回覆已被 slackBotProxy 依 notify_mode 封掉。
//  沒有第二個寫入者，就不需要跨專案共用去重鎖，也就不必為此改動 Slack 機器人主幹。
//
//  ⚠️ 這個結論綁死在「card 模式不使用」這個前提上。哪天 AUGMA_DECISION_MODE 真的
//     被切成 card，Slack 卡片會長出按鈕，而那些按鈕的題號**與這一頁完全相同**
//     （ra-phase4 規定卡片題號原樣沿用 checkList 的題號）。屆時兩個入口各有一顆
//     快取、互相看不見，就會回到 slackBotProxy/core/answer.js 開頭記的那個競態。
//     真要啟用 card，正解是把這裡改回「轉一手給 slackBotProxy」共用同一把鎖。
//
//  ── Script Properties ──
//    GITHUB_TOKEN   能對 augma repo 發 repository_dispatch 的 PAT
//
//  ⚠️ 本檔因此引入 UrlFetchApp，這支 web app 會多要一個 script.external_request
//     權限。部署是 executeAs USER_ACCESSING，所以**既有使用者下次開啟時會被要求
//     重新授權一次**。這是預期內的一次性摩擦，不是故障。
// ═══════════════════════════════════════════════════════════════════

const AUGMA_GITHUB_REPO = '104corp/104.vip.f2e.augma';

// 與 slackBotProxy 的 ANSWER_CACHE_TTL 同值（6 小時）。兩邊不必共用同一顆快取，
// 但存活時間要一致——不然「這題已經收過了」在兩處的有效期不同，行為會不好解釋。
const ANSWER_CACHE_TTL = 21600;

// client_payload 上限 64 KB。中文一個字 3 bytes，用字元數估會低估三倍。
// 留給其他欄位與 JSON 包裝的餘裕之後，答案本體上限抓 40 KB。
const BATCH_PAYLOAD_MAX_BYTES = 40000;

const VALID_PIPELINES = ['ra-pipeline', 'sa-pipeline', 'full-pipeline', 'light-ra'];

// checklist.js 的 buildReply() 產出的行首形狀：`- **Q-001**: A. 甲案`。
// 放寬到「可有縮排／項目符號／粗體、半形或全形冒號」，與 augma 的
// update-progress.sh answer-batch 那條正規表達式同一個寬容度。
//
// ⚠️ 只撈題號，**不解讀答案**。答案格式的知識歸 augma（它跟 checklist.js 在同一個
//    repo、同一次 review），這裡多解讀一分就多一分兩邊不同步的機會。
const QID_LINE_RE = /^[ \t]*[-*]?[ \t]*\*{0,2}#{0,2}[ \t]*([Qq][-－]?\d{1,4})\*{0,2}[ \t]*[:：]/;

/**
 * 由 checkList.html 內的 google.script.run 呼叫。
 *
 * @param {{jira_id: string, pipeline: string, answer_batch: string}} payload
 * @return {{ok: boolean, applied: (number|undefined), note: (string|undefined),
 *           error: (string|undefined)}}
 *         一律回物件、不丟例外——前端的 withFailureHandler 只拿得到訊息字串，
 *         分不出「送失敗」與「送到了但被拒絕」，而那兩者對 PO 的下一步完全不同。
 */
function submitChecklistAnswers(payload) {
  const p = payload || {};
  const jiraId = String(p.jira_id || '').trim().toUpperCase();
  const pipeline = String(p.pipeline || '').trim();
  const batch = String(p.answer_batch || '');

  // 三道格式檢查與 resume-workflow.yml 的 Validate inputs 同一組。擋在這裡的好處是
  // PO 當場看得到原因；送出去才被打回來的話，Actions log 裡那則 error 沒有人會看到。
  if (!/^[A-Z][A-Z0-9]+-[0-9]+$/.test(jiraId)) {
    return { ok: false, error: '單號格式不正確（' + jiraId + '）' };
  }
  if (VALID_PIPELINES.indexOf(pipeline) === -1) {
    return { ok: false, error: '不支援的 pipeline（' + pipeline + '）' };
  }
  if (!batch.trim()) {
    return { ok: false, error: '沒有任何答案內容' };
  }

  // 設定問題要在這裡就分辨出來，不能等到 dispatch 失敗才一起回「請稍後再試」——
  // 沒設 token 是設定問題，再試一百次都不會好，那句話會把人引去等待而不是去修。
  if (!PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN')) {
    console.error('未在 Script Properties 設定 GITHUB_TOKEN');
    return { ok: false, error: '系統尚未設定 GITHUB_TOKEN，請聯絡負責人（重試不會有幫助）' };
  }

  const qids = _scanQidsForDedup_(batch);
  if (!qids.length) {
    // 頁面組出來的形狀就是上面那條樣式認得的，走到這裡代表兩邊已經對不上了
    // （多半是 checklist.js 的 buildReply 改過而這裡沒跟上）。
    return { ok: false, error: '讀不出任何題號，格式可能已變更，請聯絡負責人' };
  }

  // ── 為什麼要 LockService ────────────────────────────────────────
  // 同一份清單在兩個視窗（或兩個人）同時按下送出時，兩邊會**雙雙**讀到空快取、
  // 雙雙 dispatch。CacheService 沒有「讀了就鎖住」的原子操作，光靠它擋不住這一瞬間。
  // 後果不是答案錯亂（augma 端對已答的題是冪等的），而是第二次 dispatch 會把
  // 正在跑的 agent 砍掉——phase job 是 cancel-in-progress。
  //
  // 前端的按鈕 disabled 只鎖得住同一個頁面實例，跨視窗完全無效，所以這道鎖必須
  // 在伺服器端。getScriptLock 是整個 script 共用的，正是需要的粒度。
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { ok: false, error: '另一份答案正在送出中，請稍候幾秒再試一次' };
  }

  try {
    const cache = CacheService.getScriptCache();
    const already = qids.filter(function (qid) { return !!cache.get(_answerKey_(jiraId, qid)); });

    if (already.length === qids.length) {
      // 全部都收過了＝多半是重新整理或另一個視窗已經送過。不是錯誤，但也不能再送。
      return { ok: true, applied: 0, note: '這些題稍早都已經收下過了，未重複送出。' };
    }

    const cut = _truncateUtf8ForPayload_(batch, BATCH_PAYLOAD_MAX_BYTES);

    // 作答者。executeAs USER_ACCESSING 才拿得到，同網域內會是 email。
    // 這個值原樣寫進 progress.json 的 answered_by，而走 Slack 那條路送進去的是
    // `<@U…>`——**兩種格式都要收**。augma 那側從不解析它、只顯示
    // （update-progress.sh 直接存字串、phase-guard.sh 只印出來），所以這裡不做
    // 任何正規化：硬要統一格式反而會讓既有 progress.json 裡躺著的舊值對不上。
    let answeredBy = 'checklist';
    try {
      answeredBy = Session.getActiveUser().getEmail() || 'checklist';
    } catch (err) {
      console.warn('取不到作答者身分：' + ((err && err.message) || err));
    }

    // 先寫快取再 dispatch。順序反過來的話，dispatch 與寫快取之間又是一個窗口——
    // 那正是這把鎖要消滅的東西，別在鎖裡面自己重新製造一個。
    qids.forEach(function (qid) { cache.put(_answerKey_(jiraId, qid), answeredBy, ANSWER_CACHE_TTL); });

    const sent = _dispatchResumeBatch_(jiraId, pipeline, cut.text, answeredBy);
    if (!sent.ok) {
      // 快取一定要收回，否則這批題號會被記成「已收下」，PO 重按也不會再送。
      qids.forEach(function (qid) { cache.remove(_answerKey_(jiraId, qid)); });
      return {
        ok: false,
        error: '答案沒有送出：' + sent.detail +
               (sent.retryable ? '。請稍後再試一次。' : '，請聯絡負責人（重試不會有幫助）。')
      };
    }

    // 刻意**不報「寫進幾題」**：這裡只撈了題號，沒有配對答案、也沒查閘門，
    // 並不知道 augma 實際會寫幾題。有資訊的那則回報由 augma 在寫完之後發
    // （notify-answer-result.sh → messageDispatch 的 answer_result）。
    const res = { ok: true, applied: qids.length - already.length };
    if (already.length) {
      res.note = '其中 ' + already.join('、') + ' 稍早已經收過，這次不會重複寫入。';
    }
    if (cut.truncated) {
      res.note = (res.note ? res.note + ' ' : '') +
        '內容超過 ' + Math.round(BATCH_PAYLOAD_MAX_BYTES / 1024) + ' KB 已從尾端截斷，' +
        '沒被涵蓋的題會留在待回覆清單裡。';
    }
    return res;
  } catch (err) {
    console.error('submitChecklistAnswers 發生異常：' + ((err && err.message) || err));
    return { ok: false, error: '送出時發生異常，請稍後再試' };
  } finally {
    lock.releaseLock();
  }
}


// 去重鍵。**格式必須與 slackBotProxy 的 _answerKey_ 一致**：兩個專案各有一顆快取，
// 但哪天要合回去共用同一把鎖時，鍵不同就會變成一場無聲的資料遷移。
function _answerKey_(jiraId, questionId) {
  return 'ans_' + jiraId + '_' + questionId;
}


// 撈出這份答案涵蓋哪些題號（正規化成 Q-001 三位數）。只撈題號、不解讀答案。
function _scanQidsForDedup_(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(QID_LINE_RE);
    if (!m) continue;
    const n = m[1].replace(/^[Qq][-－]?/, '');
    const qid = 'Q-' + ('00' + n).slice(-3);
    if (out.indexOf(qid) === -1) out.push(qid);
  }
  return out;
}


// 依 UTF-8 位元組截斷，並且**切在行界上**——把最後一題砍成半句話後，那半句仍是
// 合法的 `- **Q-00X**: …` 形狀，會被 augma 當成完整答案寫進去。
function _truncateUtf8ForPayload_(text, maxBytes) {
  const s = String(text == null ? '' : text);
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) total += 1;
    else if (c < 0x800) total += 2;
    else if (c >= 0xD800 && c <= 0xDBFF) { total += 4; i++; }
    else total += 3;
  }
  if (total <= maxBytes) return { text: s, truncated: false, originalBytes: total };

  let n = 0, cut = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let w;
    if (c < 0x80) w = 1;
    else if (c < 0x800) w = 2;
    else if (c >= 0xD800 && c <= 0xDBFF) w = 4;
    else w = 3;
    if (n + w > maxBytes) { cut = i; break; }
    n += w;
    if (c >= 0xD800 && c <= 0xDBFF) i++;
  }
  const sliced = s.slice(0, cut);
  const lastNl = sliced.lastIndexOf('\n');
  return {
    text: (lastNl > 0 ? sliced.slice(0, lastNl) : sliced),
    truncated: true,
    originalBytes: total
  };
}


// 整份答案原封不動送去 augma，由它的 answer-batch 自行拆解。
//
// 為什麼不在這裡先拆好再送逐題答案：格式知識屬於 augma。
// `- **Q-001**: A. …` 這個形狀是 checklist.js 的 buildReply() 決定的，它跟
// update-progress.sh 在同一個 repo、同一次 review 裡。放在 GAS 的話，格式改一次
// 就要重新部署 Apps Script，而且沒有 CI 會告訴你兩邊不同步。
//
// ⚠️ 欄位與 slackBotProxy 的 dispatchResumeBatch **必須一致**：resume-workflow.yml
//    兩邊都吃同一組 client_payload，這裡少一個欄位的症狀是 Actions 起得來但
//    續跑的是錯的 pipeline。
// 回傳 { ok: true } 或 { ok: false, detail: '<可以顯示給人看的原因>' }。
//
// 刻意不回 boolean：呼叫端只拿得到 true/false 的話，「沒設 token」「token 過期」
// 「repo 打錯」全部塌成同一句「請稍後再試」，而那三種的下一步完全不同。
// detail 只放狀態碼與分類，不放回應內容——GitHub 的錯誤訊息可能含 repo 路徑等
// 不必要外流給頁面訪客的資訊，完整內容留在執行記錄裡。
function _dispatchResumeBatch_(jiraId, pipeline, rawText, user) {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) {
    console.error('未在 Script Properties 設定 GITHUB_TOKEN');
    return { ok: false, detail: '尚未設定 GITHUB_TOKEN' };
  }

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'token ' + token,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'GAS-Augma-Checklist'
    },
    payload: JSON.stringify({
      event_type: 'resume',
      client_payload: {
        jira_id: jiraId,
        pipeline: pipeline,
        answer_batch: rawText,
        user: user,
        resume: true,
        // 這批答案從哪個通道來的。resume-workflow.yml 用它決定要不要補一則
        // 「收到了」的回執——Slack 那條路由 slackBotProxy 當場回，補了會變兩則；
        // 這條路沒有任何人回，不補的話 thread 會安靜到套用完成為止。
        //
        // client_payload 的 top-level 屬性上限是 10 個，這裡用掉 6 個。
        source: 'checklist'
      }
    }),
    muteHttpExceptions: true
  };

  try {
    const res = UrlFetchApp.fetch(
      'https://api.github.com/repos/' + AUGMA_GITHUB_REPO + '/dispatches', options);
    const code = res.getResponseCode();
    if (code !== 204) {
      console.error('repository_dispatch 失敗（HTTP ' + code + '）：' +
                    res.getContentText().slice(0, 300));
      // 401/403/404 都是「這把 token 不對」的變體（無效／權限不足／看不到這個 repo），
      // 對人的下一步一樣：去檢查 token，而不是等一下再按一次。
      const why = (code === 401 || code === 403 || code === 404)
        ? 'GITHUB_TOKEN 無效或權限不足（HTTP ' + code + '）'
        : 'GitHub 回應 HTTP ' + code;
      return { ok: false, detail: why, retryable: !(code === 401 || code === 403 || code === 404) };
    }
    return { ok: true };
  } catch (err) {
    // 例外訊息原樣帶回頁面，**刻意不收斂成一句籠統的話**。
    //
    // 這裡最常見的例外不是網路問題，是「缺權限」——本專案以 executeAs
    // USER_ACCESSING 部署，每個開頁面的人都要各自授權，而這次新增 UrlFetchApp
    // 等於多要一個 script.external_request。沒授權時 GAS 拋的訊息會直接寫出
    // 缺哪一個 scope，那正是人需要看到的東西。吞掉它的話，症狀會是
    // 「按了送出說失敗，但 token、權限、SSO 查一輪都是對的」——實際踩過。
    //
    // 不怕外流：這裡是 Google 的例外訊息，不含 token，也不含 GitHub 的回應內容。
    const msg = (err && err.message) ? String(err.message) : String(err);
    console.error('呼叫 GitHub API 發生異常：' + msg);
    return { ok: false, detail: msg.slice(0, 300), retryable: true };
  }
}


/**
 * 把 HTML 內指向同資料夾其他 .html 的相對連結，改寫成本服務的絕對網址。
 *
 * ── 為什麼改寫要放在這裡，而不是產檔時就寫死絕對網址 ──
 * 產出的 HTML 保持乾淨的相對路徑，才能在本機直接開、在 git diff 裡讀、
 * 日後換別的託管方式也不必重產一輪。這裡是唯一知道「自己被掛在哪個網址」
 * 的地方，改寫的責任就該在這裡。
 *
 * 而且上傳端的資料夾名含一段 HMAC 後綴（防列舉），產檔時根本還算不出來——
 * 要在產檔時寫死絕對網址，就得先上傳拿到資料夾名、改寫、再上傳一次。
 *
 * ── 為什麼要設 <base target="_top"> ──
 * HtmlService 的輸出跑在 sandbox iframe 裡。不設的話點連結會試圖在 iframe 內
 * 載入 script.google.com，被 X-Frame-Options 擋掉，使用者看到一片空白、
 * 沒有任何錯誤訊息。
 *
 * 用 <base> 而不是逐個 <a> 加 target：頁面裡若已有 <a target="...">，逐個加會
 * 產生重複屬性，而 HTML 規範是**先出現的那個生效**——也就是原本的值贏，
 * 這裡加的被忽略。<base> 只設「預設值」，不會跟顯式 target 打架。
 *
 * ── 沒有處理的情況 ──
 * 只改寫 .html / .htm。指向 .md、圖片等未發佈檔案的連結會原樣保留、點了會壞——
 * 那要在產檔端（spec-md-to-po-html）解決：發佈用的頁面不該連到沒發佈的東西。
 */
function rewriteLinks_(html, folderPath) {
  const base = ScriptApp.getService().getUrl();
  const prefix = folderPath ? folderPath + '/' : '';

  const rewritten = html.replace(
    // href="x.html" / href="./x.html"，可帶 #anchor。
    // 開頭字元類別不含 "/" 與 ":"，所以 /absolute/path.html 與 https://… 都不會被匹配。
    /href\s*=\s*"(?:\.\/)?([A-Za-z0-9._-]+\.html?)(#[^"]*)?"/gi,
    function (match, name, hash) {
      return 'href="' + base + '?p=' +
        encodeURIComponent(prefix + name) + (hash || '') + '"';
    }
  );

  return injectBaseTarget_(rewritten);
}

function injectBaseTarget_(html) {
  if (/<base\b/i.test(html)) return html;          // 已有 <base> 就不動，避免衝突
  const tag = '<base target="_top">';
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, function (m) { return m + tag; });
  }
  // 沒有 <head> 的片段式 HTML：擺最前面，瀏覽器仍會併進隱含的 head
  return tag + html;
}
