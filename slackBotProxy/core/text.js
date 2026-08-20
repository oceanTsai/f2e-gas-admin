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
