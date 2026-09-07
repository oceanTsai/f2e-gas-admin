// ═══════════════════════════════════════════════════════════════════
//  LLM Provider 抽象工廠
//
//  形狀刻意與 providers/index.js、core/classifiers/index.js 一致（讀指令碼
//  屬性、未知的一律明確拋錯而不是靜默降級）。這個 repo 已經有那個慣例。
//
//  每個 provider 實作同一個介面：
//    {
//      name,            // 'openai' | 'gemini'——只當識別字，會被記進 log
//      model,           // 實際打的模型名，也會被記進 log
//      keyProp,         // 金鑰放在哪個指令碼屬性
//      apiKey(),        // 讀金鑰；空字串＝「這個 provider 沒設定」
//      complete(prompt, key)
//        // 回 { text } 或 { error }。text 是模型吐出來的**原始字串**：
//        // 要不要當 JSON 解、解出來的分類合不合法，都是呼叫端
//        // （core/classifiers/shadowIntent.js）的事——那是業務語彙，
//        // provider 只負責「把 prompt 送出去、把回應的字挖出來」。
//        // error：'http-<code>'（非 200）、'bad-envelope'（200 但回應
//        // 結構不是預期的形狀）、'exception'（UrlFetchApp 自己丟錯）。
//    }
//
//  ⚠️ 換 provider **不該**動到分類邊、prompt、脫敏、log 格式任何一行。
//     這層抽象存在的唯一理由就是那件事：影子分類的用途是「比較哪個模型準」，
//     而每次比較都要改一輪程式碼與 log 鍵名的話，就不會有人真的去比。
// ═══════════════════════════════════════════════════════════════════

function getShadowLlm() {
  const props = PropertiesService.getScriptProperties();
  const name = (props.getProperty('SHADOW_LLM') || 'openai').toLowerCase();

  if (name === 'openai') return OpenAiLlm;
  if (name === 'gemini') return GeminiLlm;

  throw new Error(`未知的 SHADOW_LLM: ${name}（目前支援 openai、gemini）`);
}
