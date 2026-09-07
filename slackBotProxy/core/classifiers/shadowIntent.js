// ═══════════════════════════════════════════════════════════════════
//  意圖「影子」分類——只觀察、不執行
//
//  這支**不是**接進 core/classifiers/index.js 工廠的分類器，刻意不實作
//  `{name, classify(ctx)}` 介面：它不負責、也不應該影響 routeByIntent 的路由
//  決策。它唯一的工作是「這句話模型會怎麼分類」，結果只拿去記錄與回報，
//  給人事後比對「模型準不準」——見 core/intent.js 的 runShadowIntent_。
//  日後真的要把 LLM 接進生產路由，是另一支 core/classifiers/llm.js，不是
//  這支的延伸。
//
//  打哪一家模型不在這裡決定：這支只組 prompt、脫敏、驗分類結果，實際的
//  端點與 payload 形狀交給 core/llm/*（由 SHADOW_LLM 屬性選）。這條界線是
//  刻意的——影子分類存在的理由就是「比較哪個模型準」，換一家不該動到分類
//  邊、prompt、log 格式任何一行。
//
//  ⚠️ 送出去的東西一定要先用 core/text.js 的 _redactCode_() 脫敏，而且對
//     **所有** provider 一視同仁。使用者貼的程式碼常帶業務邏輯或內部命名，
//     而這裡是把它交給公司外的服務；免費的 Gemini key 更會直接拿輸入去訓練。
//     只留自然語言的意圖描述就夠了（分類器只需要知道「他在問程式碼」，不需要
//     知道程式碼寫了什麼）。脫敏放在這一層而不是各 provider 裡，就是為了不讓
//     「換成付費 provider」順手變成「悄悄少脫敏一層」。
//     這支完全不碰脫敏邏輯本身（也不重寫一份），純粹依賴 text.js 那支——
//     兩份實作不一致的代價，是脫敏補了新規則、這裡卻沒吃到，程式碼還是照樣
//     送出去了。
//
//  ⚠️ 當前 provider 沒設金鑰就是「這個功能關閉」，不會有第二個開關。
//     多一個 SHADOW_ENABLED 之類的旗標只是多一種「金鑰設了但功能沒開」的
//     組合，徒增困惑——拔掉金鑰本身就是最直接的關閉方式，跟 dispatchWorkflow
//     沒有 GITHUB_TOKEN 就直接回 false 是同一個立場（core/github.js）。
// ═══════════════════════════════════════════════════════════════════

// 模型只能回這幾個字串之一——這是跟使用者對過的業務分類，不是
// routeByIntent 內部的 action 名稱（那是另一套詞彙，見 core/classifiers/rules.js）。
const SHADOW_CATEGORIES = [
  'RA', 'SA', 'RA-LITE', 'SA-LITE', 'ASK', '查額度', '查進度', '回答問題', '不相關閒聊'
];

const SHADOW_CATEGORY_HINTS =
  'RA＝需求分析／規格分析/\n' +
  'SA＝系統分析／架構設計／架構分析/拆 task/拆工項/等等的架構開發類型意圖\n' +
  'RA-LITE＝輕量需求分析/輕量RA\n' +
  'SA-LITE＝輕量系統分析/輕量SA\n' +
  'ASK＝自由提問，請 agent 查一個東西\n' +
  '查額度＝問用量／額度還剩多少\n' +
  '查進度＝問某張單目前跑到哪、狀態如何\n' +
  '回答問題＝在回覆先前的一個待決問題或補充答案\n' +
  '不相關閒聊＝以上皆非，單純聊天或跟任務無關';

// prompt 對所有 provider 共用一份。分開寫「OpenAI 版」「Gemini 版」的話，
// 比較結果就不再是在比模型，而是在比兩份漂移中的 prompt。
function _shadowIntentPrompt_(sanitizedText, jiraInText) {
  return '你是內部 Slack bot 的意圖分類器。請把使用者這句話分類成下列九種之一，' +
    '只能回下面列出的字串，不能自己發明新的分類：\n\n' +
    SHADOW_CATEGORY_HINTS + '\n\n' +
    (jiraInText ? ('這句話裡偵測到的單號：' + jiraInText + '\n') : '') +
    '使用者的話（程式碼片段已用 <code> 取代，不代表原句只有這麼短）：\n' +
    sanitizedText + '\n\n' +
    '請嚴格回傳 JSON，格式為 {"category": "<九選一>", "reason": "<不超過 30 字的中文理由>"}，' +
    '不要有任何額外文字。';
}

/**
 * 回傳 { category, reason, sanitized, provider, model }
 *      或 { error, sanitized, provider, model }。
 *
 * `provider` / `model` 一律帶上（連 'no-key' 也帶）：log 是所有 provider 共用
 * 一份的，沒有這兩個欄位就沒辦法在同一份記錄裡分辨「這筆是誰答的」——而那正是
 * 共用一份 log 的全部意義（見 core/intent.js 的 SHADOW_LOG_KEY）。
 *
 * `sanitized` 是實際送給模型的脫敏後文字——只要真的呼叫過 _redactCode_
 * 就會帶上（連失敗的情況也帶，例如模型回 500 或格式跑掉），讓呼叫端
 * （core/intent.js 的 runShadowIntent_）能把「這次真的送出去的內容」記錄下來
 * 並回報給使用者核對，而不是只能相信單元測試。`no-key`／`empty` 這兩種一開始
 * 就沒打 API 的情況，因為根本沒跑到脫敏，不會有這個欄位。
 *
 * error 的可能值：'no-key'（當前 provider 沒設金鑰，功能關閉）、'empty'（空
 * 字串，沒打 API）、provider 回的 'http-<code>' / 'bad-envelope' / 'exception'
 * （見 core/llm/index.js）、'bad-json'（模型吐的不是合法 JSON）、'bad-category'
 * （模型自己編了一個不在枚舉裡的分類）。呼叫端一律把有 error 的結果當「這次
 * 觀察不到，靜默跳過」，不當成使用者看得到的錯誤。
 */
function classifyIntentShadow(text, jiraInText) {
  const llm = getShadowLlm();
  const stamp = { provider: llm.name, model: llm.model };

  if (!text) return Object.assign({ error: 'empty' }, stamp);

  const key = llm.apiKey();
  if (!key) return Object.assign({ error: 'no-key' }, stamp);

  const sanitized = _redactCode_(text);
  const out = llm.complete(_shadowIntentPrompt_(sanitized, jiraInText), key);
  const base = Object.assign({ sanitized: sanitized }, stamp);

  if (out.error) return Object.assign({ error: out.error }, base);

  let parsed;
  try {
    parsed = JSON.parse(out.text);
  } catch (parseErr) {
    return Object.assign({ error: 'bad-json' }, base);
  }

  if (SHADOW_CATEGORIES.indexOf(parsed && parsed.category) < 0) {
    return Object.assign({ error: 'bad-category' }, base);
  }

  return Object.assign({
    category: parsed.category,
    reason: String(parsed.reason || '').slice(0, 80)
  }, base);
}
