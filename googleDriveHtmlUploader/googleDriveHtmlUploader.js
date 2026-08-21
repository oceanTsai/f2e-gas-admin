/**
 * googleDriveHtmlUploader — 把 HTML 存進 Google Drive，回傳資料夾 ID
 *
 * 與 googleDriveHtmlPreviewer 成對：這支負責寫入，那支負責算繪與權限把關。
 * 命名依能力而非消費端（本 repo 是團隊共用，不只 augma 會用）。
 *
 * 呼叫端是 augma 的 .claude/scripts/publish-html.sh（CI 上由 agent 執行）。
 * 那邊沒有任何 GAS 原始碼，只有打這支 WebApp 的 shell script——所以這裡是
 * 唯一的真相來源，改動不必同步到別的 repo。
 *
 * ── 部署前必做 ────────────────────────────────────────────────
 * 1. 部署為「網頁應用程式」：
 *      執行身分  ：我（指令碼擁有者）—— 檔案才會存進你的 Drive、由你去分享
 *      存取權限  ：任何人 —— CI 沒有 Google 帳號可登入，擋門的是下面的簽章
 *    ⚠️ 與 previewer 相反（那支是「存取者身分 + 任何擁有 Google 帳號的人」）。
 *       設反了不會報錯，只會安靜地全開或安靜地壞掉。
 * 2. 指令碼屬性 AUGMA_HTML_UPLOAD_KEY：HMAC 簽章密鑰。
 *    **呼叫端的環境變數同名同值**（CI 是 GitHub Secret，本機是 ~/.claude/settings.json
 *    的 env）——刻意不換名字：同一個值用兩個名字，唯一的效果就是讓人設錯。
 *    沒設就整支拒絕服務——預設放行的話，任何人都能往你的 Drive 寫檔，
 *    再透過 previewer 從 Google 網域提供任意 HTML，那是現成的釣魚頁。
 * 3. ROOT_FOLDER_ID **必須與 previewer 的 ARCHIVE_FOLDER_ID 相同**。
 *    previewer 是從那個資料夾往下用「名稱」逐層找檔（?p=<資料夾名>/<檔名>），
 *    寫到別處它一律回「找不到這個頁面」——而且是 200 的正常頁面，不是錯誤，
 *    這裡完全看不出連結是死的。
 *
 * ── 誰看得到：在 Drive 上分享「根資料夾」，本服務不管權限 ──────
 * previewer 以「存取者身分」執行，且從根資料夾開始走訪，所以**必須把
 * ROOT_FOLDER_ID 那個資料夾分享給要看的人**——只分享某一張票的子資料夾沒有用，
 * Drive 不會連帶給父資料夾權限，對方會在第一行 getFolderById 就拋例外。
 *
 * 代價是粒度只有「全有或全無」：被分享的人看得到所有票。要做到逐票控管，
 * previewer 得改成以資料夾 ID 定址（不再碰根目錄），本服務也要跟著把
 * 分享邏輯加回來。目前刻意不做——沒有實際需求，而半套的分享程式碼
 * 會讓人誤以為權限有在管。
 *
 * ── 契約 ──────────────────────────────────────────────────────
 * POST ?sig=<HMAC-SHA256(AUGMA_HTML_UPLOAD_KEY, 原始 body 字串) 的 hex>
 * Content-Type: application/json; charset=utf-8      ← charset 必須帶，理由見驗簽段
 * {
 *   "ts": 1755740000,
 *   "jira_id": "VIPOP-12345",
 *   "files": [ { "name": "VIPOP-12345-overview.html", "content": "<!doctype html>..." } ]
 * }
 *
 * 成功 200 { "ok": true, "folder_id": "1AbC...", "folder_name": "VIPOP-12345",
 *            "files": [ { "name": "...", "file_id": "..." } ] }
 * 失敗 200 { "error": "訊息" }   ← GAS 無法自訂 HTTP 狀態碼，錯誤一律走 error 欄位
 *
 * 檢視網址由呼叫端組成：{PREVIEWER}/exec?p=<folder_name>/<name>
 * 用的是 folder_name 不是 folder_id——previewer 從自己的 ARCHIVE_FOLDER_ID 起步，
 * 用 getFoldersByName／getFilesByName 按「名稱」逐層往下找，不吃 Drive ID。
 * folder_id 與 file_id 只用來確認寫入成功，previewer 兩個都不吃。
 *
 * **密鑰本身永遠不會出現在請求裡**——網址只帶簽章。簽章綁死這一份 body，
 * 沒有密鑰就偽造不出下一個，因此它進執行記錄也無妨。
 * ts 放在 body 內（才會被簽章涵蓋），偏離現在時間超過 MAX_SKEW_SEC 一律拒收。
 * 重放同一份請求不構成威脅：內容相同、路徑相同，結果是把同一個檔覆寫成一樣的內容。
 */

// 檔案存放位置。previewer 以資料夾 ID 定位，不依賴這個值。
var ROOT_FOLDER_ID = '1VgZA9Y1P6w5GafKDQPgXTZ-XpfpzBtsc';

// ROOT_FOLDER_ID 留空時才會用到（自動在雲端硬碟根目錄建這個資料夾）
var ROOT_FOLDER_NAME = 'augma-html';

// 允許的時鐘偏差（秒）。runner 與 Google 之間通常同步良好，300 秒已很寬鬆；
// 調太大等於把重放的時間窗撐大。
var MAX_SKEW_SEC = 300;

// 大小上限。**這是本服務自訂的保守值，不是 Google 的硬限制**——目的是在超量時
// 給出看得懂的錯誤，而不是讓它在 GAS 內部某處以難懂的方式失敗。
// 單位是「字元數」而非位元組：內容多為中文，UTF-8 下實際位元組約為此值的三倍。
var MAX_FILE_CHARS = 3000000;
var MAX_TOTAL_CHARS = 8000000;

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    // 同一張票的 phase3 / phase4 若時間上重疊，兩邊都在 upsert 同名檔會互相覆寫成半套。
    // 等最多 30 秒；拿不到鎖寧可回錯讓呼叫端重試，也不要盲寫。
    if (!lock.tryLock(30000)) return json_({ error: '伺服器忙碌中（取得鎖逾時），請稍後重試' });

    var secret = PropertiesService.getScriptProperties().getProperty('AUGMA_HTML_UPLOAD_KEY');
    if (!secret) return json_({ error: '伺服器未設定 AUGMA_HTML_UPLOAD_KEY，拒絕服務' });

    if (!e || !e.postData || !e.postData.contents) return json_({ error: '缺少 request body' });
    var raw = e.postData.contents;

    // ── 驗簽：對「原始 body 字串」重算，不要先 parse 再重新序列化 ──
    // 重新序列化後的鍵順序／空白／Unicode 跳脫都可能與呼叫端不同，那會讓驗簽
    // 間歇性失敗，症狀是「有時候可以上傳有時候不行」，極難查。
    //
    // ⚠️ 呼叫端**必須**送 Content-Type: application/json; charset=utf-8。
    //    payload 幾乎整包是中文，charset 沒宣告時這裡拿到的字串可能與呼叫端
    //    簽章時的位元組不同 → 每一次上傳都回 unauthorized，而錯誤訊息完全
    //    不會指向編碼問題。
    var got = (e.parameter && e.parameter.sig) || '';
    if (!safeEquals_(got, hmacHex_(secret, raw))) return json_({ error: 'unauthorized' });

    var body;
    try { body = JSON.parse(raw); }
    catch (err) { return json_({ error: 'request body 不是合法 JSON：' + err.message }); }

    // ── 時間窗：擋掉重放舊請求 ──
    var ts = Number(body.ts);
    if (!isFinite(ts)) return json_({ error: '缺少或非法的 ts' });
    var skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
    if (skew > MAX_SKEW_SEC) {
      return json_({ error: '請求時間偏差過大（' + skew + ' 秒），請確認呼叫端時鐘' });
    }

    var jiraId = String(body.jira_id || '').trim();
    // 會被拿來當資料夾名稱，擋掉路徑分隔字元與空字串
    if (!/^[A-Z][A-Z0-9]+-[0-9]+$/.test(jiraId)) return json_({ error: '非法的 jira_id：' + jiraId });

    // ══ 先驗完整批，全部通過才開始寫 ══════════════════════════════
    // 邊驗邊寫的話，第 2 個檔名不合法時第 1 個已經進 Drive 了——呼叫端收到
    // error 會當成「這次什麼都沒發生」，但 Drive 裡的內容已經被改掉，
    // 事後排查會完全對不上。Drive 沒有交易可用，至少讓常見的驗證失敗不留痕跡。
    var validated = validateFiles_(body.files);
    if (validated.error) return json_({ error: validated.error });

    var folder = getOrCreateFolder_(jiraId);
    var out = [];
    for (var i = 0; i < validated.files.length; i++) {
      var f = validated.files[i];
      out.push({ name: f.name, file_id: upsert_(folder, f.name, f.content) });
    }

    // folder_name 才是呼叫端組檢視網址的依據（?p=<資料夾名>/<檔名>）。
    // previewer 以存取者身分執行，從自己的 ARCHIVE_FOLDER_ID 起步按名稱逐層往下找，
    // 不吃 Drive ID——所以那個常數兩邊必須指向同一個資料夾。
    // folder_id 一併回傳純粹是給呼叫端確認寫到哪裡，組網址用不到。
    return json_({ ok: true, folder_id: folder.getId(), folder_name: folder.getName(), files: out });
  } catch (err) {
    return json_({ error: '未預期錯誤：' + (err && err.message ? err.message : String(err)) });
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

/**
 * 整批檢查檔名與內容，回傳 { files: [...] } 或 { error: '...' }。
 * 純函式、不碰 Drive——「驗證」與「寫入」分開才擋得住部分寫入。
 */
function validateFiles_(files) {
  if (!Array.isArray(files) || files.length === 0) return { error: 'files 必須是非空陣列' };

  var out = [];
  var total = 0;

  for (var i = 0; i < files.length; i++) {
    var item = files[i] || {};
    var name = String(item.name || '').trim();
    var content = item.content;

    // 只收單層檔名：帶路徑分隔字元的話 Drive 會建出名字含斜線的怪檔案
    if (!/^[A-Za-z0-9._-]+\.html?$/i.test(name)) return { error: '非法的檔名：' + name };
    if (typeof content !== 'string' || content.length === 0) return { error: name + ' 的 content 為空' };
    if (content.length > MAX_FILE_CHARS) {
      return { error: name + ' 過大（' + content.length + ' 字元，上限 ' + MAX_FILE_CHARS + '）' };
    }

    total += content.length;
    if (total > MAX_TOTAL_CHARS) {
      return { error: '本批總量過大（累計 ' + total + ' 字元，上限 ' + MAX_TOTAL_CHARS + '）' };
    }

    out.push({ name: name, content: content });
  }

  return { files: out };
}

/**
 * 依檔名 upsert —— 這是「網址不會變」的關鍵。
 *
 * Phase 會重跑（帶著決策答案續作那條路），每跑一次就會再上傳一次。
 * 若每次都 createFile，Drive 會疊出一堆同名檔，而 getFilesByName 取的是第一個，
 * previewer 可能一直服務到舊的那份，沒有人會發現。
 */
function upsert_(folder, name, content) {
  var it = folder.getFilesByName(name);
  if (it.hasNext()) {
    var f = it.next();
    f.setContent(content);
    return f.getId();
  }
  return folder.createFile(name, content, MimeType.HTML).getId();
}

/**
 * 每張票一個資料夾，名稱就是單號。
 *
 * 名稱不需要不可猜——權限由 Drive 原生 ACL 判定（沒分享給你就讀不到），
 * 而網址帶的是 Drive 的資料夾 ID，本來就是隨機長字串。
 * 名稱保持可讀，你在 Drive 裡才分得出哪個資料夾是哪張票。
 */
function getOrCreateFolder_(jiraId) {
  var root;
  if (ROOT_FOLDER_ID) {
    root = DriveApp.getFolderById(ROOT_FOLDER_ID);
  } else {
    var rit = DriveApp.getRootFolder().getFoldersByName(ROOT_FOLDER_NAME);
    root = rit.hasNext() ? rit.next() : DriveApp.getRootFolder().createFolder(ROOT_FOLDER_NAME);
  }
  var it = root.getFoldersByName(jiraId);
  return it.hasNext() ? it.next() : root.createFolder(jiraId);
}

function hmacHex_(secret, message) {
  // ⚠️ 一定要用 3 參數版、明確指定 UTF_8。
  //
  // 2 參數版 computeHmacSha256Signature(value, key) 的預設編碼**官方文件沒有寫**，
  // 實測結果是：純 ASCII 內容驗簽會過，一旦內容含中文就一律 unauthorized——
  // 因為兩端對「同一個字串」取到的位元組不同。而本專案的 payload 幾乎整包是中文，
  // 等於實務上永遠過不了，但錯誤訊息只會說 unauthorized，完全指不到編碼。
  //
  // 呼叫端是 openssl 對 UTF-8 位元組計算，這裡對齊成同一個編碼。
  var raw = Utilities.computeHmacSha256Signature(message, secret, Utilities.Charset.UTF_8);
  var out = '';
  for (var i = 0; i < raw.length; i++) {
    // Apps Script 的位元組是有號的（-128..127），先轉回 0..255 再補零成兩位
    var v = (raw[i] < 0 ? raw[i] + 256 : raw[i]).toString(16);
    out += (v.length === 1 ? '0' : '') + v;
  }
  return out;
}

/**
 * 定時比較——不要用 ===。
 * 字串比較會在第一個相異字元就返回，攻擊者可藉回應時間逐字元試出正確簽章。
 * 這裡一律走完全長度，只累積差異。
 */
function safeEquals_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return diff === 0;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
