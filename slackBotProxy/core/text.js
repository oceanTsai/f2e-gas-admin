// ═══════════════════════════════════════════════════════════════════
//  純文字工具
//
//  這個檔案裡的每一支都是**純函式**——不讀 ScriptProperties、不打網路、
//  不碰 CacheService。理由不是潔癖：GAS 沒有本機執行環境，能在
//  test/gas-regression.js 裡餵字串直接驗的，只有純函式。
//  一旦混進 I/O，驗證就得整套部署上去、在 Slack 裡手動觸發。
// ═══════════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════════
//  全形 → 半形
//
//  PM 在中文輸入法下打「第一題選Ａ」，那個 Ａ 是 U+FF21，與選項的 A 完全
//  不同字元。不轉的話所有「選項字母」比對都會失敗，而失敗的樣子是「看起來
//  有答但系統當作沒答」——最難查的那種。
//
//  ⚠️ 刻意**只轉英數與全形空白**，不碰全形標點。
//     ，。（）！？ 在中文句子裡是正確的寫法，轉成半形只會讓答案讀起來很怪；
//     而且答案本文會被原樣寫進 progress.json 再顯示給人看。
//     全形冒號 ： 也保留——需要吃它的地方（題號樣式）自己在 regex 裡列出來。
// ═══════════════════════════════════════════════════════════════════

function _toHalfWidth_(text) {
  return String(text == null ? '' : text).replace(/[０-９Ａ-Ｚａ-ｚ　]/g, function (ch) {
    if (ch === '　') return ' ';
    return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
  });
}


// ═══════════════════════════════════════════════════════════════════
//  題號正規化
//
//  ⚠️ 這支與 augma 的 `update-progress.sh answer-batch` 裡的 jq `norm` 是
//     **同一套規則的兩份實作**，必須一起改。兩邊不一致時的症狀是
//     「GAS 鎖了 5 題但 augma 只寫進 3 題」——去重鎖擋住了按鈕，答案卻沒落地。
//
//  規則：去掉前導零後，不足三位補到三位，已達三位以上原樣保留。
//    Q3 / q-3 / Q-003 / Q-0003  →  Q-003
//    Q-1000                      →  Q-1000（不截斷）
//
//  連字號吃半形與全形兩種（`Q-001` 與 `Ｑ－００１`）。中文輸入法下打出來的是
//  全形，而 _toHalfWidth_ 刻意不轉全形標點（那會動到答案本文），所以在這裡收。
//
//  補到三位是為了相容既有資料：decision-gateway.sh 的自動編號是三位零填充。
//  不截斷是因為題號現在由 checkList 決定，位數不再由我們控制。
// ═══════════════════════════════════════════════════════════════════

function _normalizeQid_(raw) {
  const m = String(raw == null ? '' : raw).toUpperCase().match(/^Q[-\uFF0D]?(\d+)$/);
  if (!m) return null;
  const n = String(parseInt(m[1], 10));
  return 'Q-' + (n.length >= 3 ? n : ('00' + n).slice(-3));
}


// ═══════════════════════════════════════════════════════════════════
//  題號行首樣式
//
//  ⚠️ 只認**行首**，不做寬鬆掃描。checklist.js 的 buildReply() 會吐一行
//
//      > ⚠️ 尚未回答:Q-003, Q-004
//
//  那行含題號但語意完全相反。寬鬆掃描會把這兩題也算進批次、也寫進去重快取
//  （TTL 6 小時），而它們明確標示為「尚未回答」，卡片上的按鈕必須留著能點。
//  行首樣式吃不到它：該行以 `>` 開頭，且題號在冒號之後。
//
//  同理 `### AI 假設(勾選 = 同意)` 區塊用的是 A-00X 命名空間，Q- 樣式天然
//  吃不到；那些由 _parseAnswerText_ 另外撈出來回報，不靜默丟掉。
//
//  可接受的行首裝飾：縮排、- / * 項目符號、** 粗體、# 標題記號。
//  冒號半形全形都吃——PM 手打時很常是全形。
// ═══════════════════════════════════════════════════════════════════

const QID_LINE_RE = /^[ \t]*[-*]?[ \t]*\*{0,2}#{0,2}[ \t]*([Qq][-\uFF0D]?\d{1,4})\*{0,2}[ \t]*[:：][ \t]*(.+)$/;
const AID_LINE_RE = /^[ \t]*[-*]?[ \t]*\*{0,2}#{0,2}[ \t]*([Aa][-\uFF0D]?\d{1,4})\*{0,2}[ \t]*[:：]/;


/** 把一段文字切成行，逐行套用行首題號樣式。回傳 [{ qid, answerText }]，同一題取最後一筆。 */
function _scanQidLines_(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const seen = {};
  const order = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(QID_LINE_RE);
    if (!m) continue;
    const qid = _normalizeQid_(m[1]);
    if (!qid) continue;
    // 同一題重複出現時取最後一筆——PM 在同一則訊息裡改過的那個才是他要的
    if (!(qid in seen)) order.push(qid);
    seen[qid] = m[2].replace(/[ \t]+$/, '');
  }
  return order.map(function (qid) { return { qid: qid, answerText: seen[qid] }; });
}


/** 撈出 AI 假設確認的編號（A-00X）。這些目前沒有落點，但要明確回報而不是靜默丟掉。 */
function _scanAssumptionIds_(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(AID_LINE_RE);
    if (m) {
      const id = m[1].toUpperCase().replace(/^A[-\uFF0D]?/, 'A-');
      if (out.indexOf(id) === -1) out.push(id);
    }
  }
  return out;
}


// ═══════════════════════════════════════════════════════════════════
//  UTF-8 位元組長度與截斷
//
//  repository_dispatch 的 client_payload 上限 64 KB。中文一個字 3 bytes，
//  用字元數估會低估三倍——「看起來才一萬字，怎麼會爆」就是這樣來的。
//
//  截斷從**尾巴**截：checkList 的複製結果是由前往後逐題排的，截尾巴只會少
//  後面幾題（那些會留在 still_pending，人看得到），截開頭則會連標題與前面
//  所有題一起消失。
// ═══════════════════════════════════════════════════════════════════

function _utf8Length_(text) {
  const s = String(text == null ? '' : text);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; }   // surrogate pair（emoji）
    else n += 3;
  }
  return n;
}

/** 回傳 { text, truncated, originalBytes }。text 保證 UTF-8 長度不超過 maxBytes。 */
function _truncateUtf8_(text, maxBytes) {
  const s = String(text == null ? '' : text);
  const total = _utf8Length_(s);
  if (total <= maxBytes) return { text: s, truncated: false, originalBytes: total };

  let n = 0;
  let cut = s.length;
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
  // 切在行界上，避免把最後一題砍成半句話後又被當成合法答案寫進去
  const sliced = s.slice(0, cut);
  const lastNl = sliced.lastIndexOf('\n');
  return {
    text: (lastNl > 0 ? sliced.slice(0, lastNl) : sliced),
    truncated: true,
    originalBytes: total
  };
}


// ═══════════════════════════════════════════════════════════════════
//  程式碼脫敏（送 LLM 之前把 code 換成 <code>）
//
//  為什麼需要這支：core/classifiers/geminiShadow.js 打的是**免費**的 Gemini
//  API key——免費 key 的輸入會被拿去訓練。使用者貼上來問「這段在幹嘛」的程式碼
//  常常帶著業務邏輯或內部命名，不能照樣送出去，只留自然語言的意圖描述就夠了
//  （分類器只需要知道「他在問程式碼」，不需要知道程式碼寫了什麼）。
//
//  演算法（純字串／regex，刻意不用 AST parser——這個 repo 目前沒有任何 build
//  step，clasp push 純檔案就結束，不想為了脫敏第一次引入套件與編譯流程）：
//    1. Markdown fenced code block（```…```）與 inline backtick（`…`）先換成 <code>。
//    2. 剩下的文字依「是不是 ASCII」切成交錯區塊——CJK 字元不算 ASCII。這條邊界
//       天然對應「中文說明」與「程式碼」的邊界（中文使用者混貼程式碼時，程式碼
//       本身幾乎全是 ASCII），不需要額外斷詞。
//    3. 每個 ASCII 區塊再用 `:`／換行切一層（讓「這段 code:」與後面真正的程式碼
//       分開判斷），對每個子片段套一組「強程式碼指標」regex，命中就整片換成 <code>。
//    4. 收斂相鄰的 <code>（中間只有空白／標點）成一個，避免逐行程式碼變成
//       一長串 <code><code><code>。
//
//  ⚠️ 已知限制（刻意留著，不假裝沒有——見 test/gas-regression.js 對應斷言）：
//    a) 純英文句子裡混一段「沒有冒號或換行隔開」的程式碼，會被整句吃掉
//       （例：`please review this code const a = 1` 整句變 <code>）。這個 repo
//       中文為主，寧可誤殺一句英文說明，也不要漏放程式碼——跟
//       core/classifiers/rules.js 的 RE_PURE_USAGE「寧緊勿鬆」是同一個立場。
//       同一條規則也會誤殺純中文句子尾端剛好接一個 ASCII 分號的情況
//       （例：`單價是 100;` → `單價是 <code>`）：這條副作用是接受的，不修，
//       因為「結尾分號」是偵測 `foo();` 這類無其他信號的裸呼叫式唯一的線索。
//    b) 程式碼字面值裡混中文（`const msg = "你好"`）時，中文片段落在「非 ASCII」
//       那一段，不會被一起收進 <code>。中文變數名/字串外流的風險比整段商業邏輯
//       外流小得多，先接受這個已知限制。
//    c) `_CODE_HARD_RE_` 幾乎是純 JS/TS 語法（const/let/var/function/=>/…）。
//       實測過 Python、SQL、單行 shell 指令**完全不會被攔到**——它們既沒有這些
//       關鍵字，也常常沒有結尾分號。下面的 `_looksLikeCodeByDensity_` 是補強，
//       靠「符號密度」抓一部分（Java／C 家族的大括號、`if (...) { ... }` 這種），
//       但**不是萬能解**：單純的 SQL `SELECT … FROM …`、或被逐行拆開後每行只剩
//       零星幾個符號的 shell 迴圈（`for` / `do` / `done` 各自一行），密度算下來
//       太低，還是會漏放。純 regex／字串啟發式在不維護逐語言關鍵字清單的前提下，
//       這是能做到的上限——見 test/gas-regression.js 的對應斷言。
// ═══════════════════════════════════════════════════════════════════

// 「強程式碼指標」：只認會實際出現在程式碼裡的語法符號／保留字組合，
// 不認裸字（例如單獨的 "code" 或 "class" 這種在英文句子裡也常見的字）。
// 幾乎是 JS/TS 專屬——見上面已知限制 (c)。
const _CODE_HARD_RE_ = /=>|===|!==|&&|\|\||\bconst\b|\blet\b|\bvar\b|\bfunction\b|\bclass\s+\w|\bimport\s[\s\S]*\bfrom\b|\brequire\(|;\s*$/;

// 「符號密度」：不認關鍵字，只看這段 ASCII 文字裡「像程式碼的符號」佔比夠不夠
// 高，補 _CODE_HARD_RE_ 語言侷限的洞（見已知限制 (c)）。門檻是拿真實正／負例
// 調出來的（test/gas-regression.js `[12]`）：
//   - 長度 < 8 的片段不判——太短時像 "1+1=2" 這種算式也會被誤觸，資訊量不夠。
//   - 符號數 ≥ 2 **且**密度 ≥ 10%：兩個條件都要，才擋得住 URL
//     （`https://…?x=1&y=2` 含 = 與 &，但密度通常 < 10%）跟正常中文句子。
const _CODE_SYMBOLS_RE_ = /[(){}\[\]<>=+!&|*%^~;_]/g;
const _CODE_DENSITY_MIN_LEN_ = 8;
const _CODE_DENSITY_MIN_SYMS_ = 2;
const _CODE_DENSITY_MIN_RATIO_ = 0.10;

function _looksLikeCodeByDensity_(piece) {
  if (piece.length < _CODE_DENSITY_MIN_LEN_) return false;
  const n = (piece.match(_CODE_SYMBOLS_RE_) || []).length;
  return n >= _CODE_DENSITY_MIN_SYMS_ && (n / piece.length) >= _CODE_DENSITY_MIN_RATIO_;
}

function _redactCode_(text) {
  const s = (text == null) ? '' : String(text);
  if (!s) return s;

  let out = s.replace(/```[\s\S]*?```/g, '<code>');
  out = out.replace(/`[^`\n]+`/g, '<code>');

  // 交錯切 ASCII／CJK。split 帶 capture group 時，命中的群組固定落在奇數索引
  // （[前段, 群組1, 中段, 群組2, …]），不用另外判斷「這段是不是 ASCII」。
  const parts = out.split(/([\x00-\x7F]+)/);
  for (let i = 1; i < parts.length; i += 2) {
    parts[i] = _redactAsciiRun_(parts[i]);
  }
  out = parts.join('');

  let prev;
  do {
    prev = out;
    out = out.replace(/<code>[ \t\r\n,.;:、，。；：]*<code>/g, '<code>');
  } while (out !== prev);

  return out;
}

// 只處理**單一 ASCII 區塊**。前後空白留著不進判斷——那通常是跟中文之間的
// 分隔（見 _redactCode_ 檔頭的例子：「程式碼 <code>」中間那個空格），
// 吃掉會讓脫敏後的文字黏在一起，肉眼校對時反而看不出斷點在哪。
function _redactAsciiRun_(run) {
  const m = run.match(/^(\s*)([\s\S]*?)(\s*)$/);
  const lead = m[1], core = m[2], trail = m[3];
  if (!core) return run;

  const pieces = core.split(/([:\n])/);
  for (let i = 0; i < pieces.length; i += 2) {
    if (_CODE_HARD_RE_.test(pieces[i])) { pieces[i] = '<code>'; continue; }

    // 密度檢查跳過「URL 的 scheme 冒號之後那一段」（https 這個字被 `:` 切走後，
    // 剩下的 //host/path?x=1&y=2 分母變短，很容易被查詢字串裡的 = 與 & 撐過
    // 密度門檻）。這裡只跳過密度檢查，_CODE_HARD_RE_ 還是照跑——如果有人把
    // URL 包在真正的程式碼裡（`const url = "https://...";`），前面那段還是會
    // 被 const 抓到。
    const prevScheme = (i >= 2 ? pieces[i - 2] : '').trim().split(/\s+/).pop() || '';
    const isUrlRemainder = /^\/\//.test(pieces[i]) && /^(https?|ftp)$/i.test(prevScheme);
    if (!isUrlRemainder && _looksLikeCodeByDensity_(pieces[i])) pieces[i] = '<code>';
  }
  return lead + pieces.join('') + trail;
}
