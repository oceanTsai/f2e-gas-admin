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
