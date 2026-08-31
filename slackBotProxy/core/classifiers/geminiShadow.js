// ═══════════════════════════════════════════════════════════════════
//  Gemini flash-lite 意圖「影子」分類——只觀察、不執行
//
//  這支**不是**接進 core/classifiers/index.js 工廠的分類器，刻意不實作
//  `{name, classify(ctx)}` 介面：它不負責、也不應該影響 routeByIntent 的路由
//  決策。它唯一的工作是「這句話 Gemini 會怎麼分類」，結果只拿去記錄與回報，
//  給人事後比對「Gemini 準不準」——見 core/intent.js 的 runGeminiShadow_。
//  日後真的要把 LLM 接進生產路由，是另一支 core/classifiers/llm.js，不是
//  這支的延伸。
//
//  ⚠️ 打的是**免費**的 Gemini API key——免費 key 的輸入會被拿去訓練。
//     使用者貼的程式碼常帶業務邏輯或內部命名，送出去之前一定要先用
//     core/text.js 的 _redactCode_() 脫敏，只留自然語言的意圖描述。
//     這支完全不碰脫敏邏輯本身（也不重寫一份），純粹依賴 text.js 那支——
//     兩份實作不一致的代價，是脫敏補了新規則、這裡卻沒吃到，程式碼還是
//     照樣送出去了。
//
//  ⚠️ 沒有設定 GEMINI_API_KEY 就是「這個功能關閉」，不會有第二個開關。
//     多一個 GEMINI_SHADOW_ENABLED 之類的旗標只是多一種「金鑰設了但功能沒開」
//     的組合，徒增困惑——拔掉金鑰本身就是最直接的關閉方式，跟
//     dispatchWorkflow 沒有 GITHUB_TOKEN 就直接回 false 是同一個立場
//     （core/github.js）。
// ═══════════════════════════════════════════════════════════════════

// 目前最快的 flash-lite 別名。真的打通之後如果要釘死版本，改這裡就好。
const GEMINI_MODEL = 'gemini-flash-lite-latest';

// Gemini 只能回這幾個字串之一——這是跟使用者對過的業務分類，不是
// routeByIntent 內部的 action 名稱（那是另一套詞彙，見 core/classifiers/rules.js）。
const GEMINI_SHADOW_CATEGORIES = [
  'RA', 'SA', 'RA-LITE', 'SA-LITE', 'ASK', '查額度', '查進度', '回答問題', '不相關閒聊'
];

const GEMINI_SHADOW_CATEGORY_HINTS =
  'RA＝需求分析／寫規格書\n' +
  'SA＝系統分析／架構設計／拆 task\n' +
  'RA-LITE＝輕量需求審查\n' +
  'SA-LITE＝輕量系統審查\n' +
  'ASK＝自由提問，請 agent 查一個東西\n' +
  '查額度＝問 Claude 用量／配額還剩多少\n' +
  '查進度＝問某張單目前跑到哪、狀態如何\n' +
  '回答問題＝在回覆先前的一個待決問題或補充答案\n' +
  '不相關閒聊＝以上皆非，單純聊天或跟任務無關';

function _geminiShadowPrompt_(sanitizedText, jiraInText) {
  return '你是內部 Slack bot 的意圖分類器。請把使用者這句話分類成下列九種之一，' +
    '只能回下面列出的字串，不能自己發明新的分類：\n\n' +
    GEMINI_SHADOW_CATEGORY_HINTS + '\n\n' +
    (jiraInText ? ('這句話裡偵測到的單號：' + jiraInText + '\n') : '') +
    '使用者的話（程式碼片段已用 <code> 取代，不代表原句只有這麼短）：\n' +
    sanitizedText + '\n\n' +
    '請嚴格回傳 JSON，格式為 {"category": "<九選一>", "reason": "<不超過 30 字的中文理由>"}，' +
    '不要有任何額外文字。';
}

/**
 * 回傳 { category, reason, sanitized } 或 { error, sanitized }。
 *
 * `sanitized` 是實際送給 Gemini 的脫敏後文字——只要真的呼叫過 _redactCode_
 * 就會帶上（連失敗的情況也帶，例如 Gemini 回 500 或格式跑掉），讓呼叫端
 * （core/intent.js 的 runGeminiShadow_）能把「這次真的送出去的內容」記錄下來
 * 並回報給使用者核對，而不是只能相信單元測試。`no-key`／`empty` 這兩種一開始
 * 就沒打 API 的情況，因為根本沒跑到脫敏，不會有這個欄位。
 *
 * error 的可能值：'no-key'（沒設金鑰，功能關閉）、'empty'（空字串，沒打 API）、
 * 'http-<code>'（Gemini 回非 200）、'bad-json'（回應不是合法 JSON）、
 * 'bad-category'（模型自己編了一個不在枚舉裡的分類）、'exception'（其他例外，
 * 例如 UrlFetchApp 本身丟錯）。呼叫端一律把有 error 的結果當「這次觀察不到，
 * 靜默跳過」，不當成使用者看得到的錯誤。
 */
function classifyWithGeminiShadow(text, jiraInText) {
  if (!text) return { error: 'empty' };

  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) return { error: 'no-key' };

  const sanitized = _redactCode_(text);
  const prompt = _geminiShadowPrompt_(sanitized, jiraInText);

  try {
    const resp = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL +
      ':generateContent?key=' + key,
      {
        method: 'post',
        contentType: 'application/json',
        muteHttpExceptions: true,
        payload: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json' }
        })
      }
    );

    if (resp.getResponseCode() !== 200) {
      return { error: 'http-' + resp.getResponseCode(), sanitized: sanitized };
    }

    let out;
    try {
      const body = JSON.parse(resp.getContentText());
      out = JSON.parse(body.candidates[0].content.parts[0].text);
    } catch (parseErr) {
      return { error: 'bad-json', sanitized: sanitized };
    }

    if (GEMINI_SHADOW_CATEGORIES.indexOf(out && out.category) < 0) {
      return { error: 'bad-category', sanitized: sanitized };
    }

    return { category: out.category, reason: String(out.reason || '').slice(0, 80), sanitized: sanitized };
  } catch (err) {
    console.error('Gemini 影子分類失敗:', err);
    return { error: 'exception', sanitized: sanitized };
  }
}
