// ═══════════════════════════════════════════════════════════════════
//  意圖分類器工廠
//
//  形狀刻意與 providers/index.js 一致（讀指令碼屬性、未實作的一律明確拋錯
//  而不是靜默降級）。這個 repo 已經有那個慣例，不另創一套。
//
//  INTENT_CLASSIFIER 預設 rules。之後要接 LLM 時：
//    1. 新增 core/classifiers/llm.js，同樣實作 { name, classify(ctx) }
//    2. 這裡打開 fallback：規則回 unknown 才問模型
//    3. 把屬性設成 llm
//  呼叫端（core/intent.js 的 routeByIntent）一行都不用改。
//
//  ⚠️ fallback 的位置刻意放在這裡，不是放在 llm.js 的 try/catch 裡。
//     放在工廠層才能保證「規則吃掉絕大多數流量，模型只處理尾巴」——
//     那同時是省錢設計與降低曝光面的設計。
//
//  ⚠️ 這個開關與答案正規化的開關（ANSWER_PARSER）**必須分開**，因為送出去的
//     內容完全不同：
//       INTENT_CLASSIFIER → 只有使用者那一句話，幾乎無業務資料
//       ANSWER_PARSER     → 那句話 ＋ 未答題的 question / options，
//                           含業務術語與內部系統命名（例如 repo 名）
//     你可能核可前者而不核可後者。合成一個開關就沒得選了。
// ═══════════════════════════════════════════════════════════════════

function getClassifier() {
  const props = PropertiesService.getScriptProperties();
  const name = (props.getProperty('INTENT_CLASSIFIER') || 'rules').toLowerCase();

  if (name === 'rules') return RulesClassifier;

  if (name === 'llm') {
    // 尚未實作。這裡明確拋錯而不是靜默退回 rules——設定錯誤要當場知道，
    // 否則你會以為模型在跑、實際上一直是規則在回答。
    throw new Error(
      'INTENT_CLASSIFIER 設為 llm，但 core/classifiers/llm.js 尚未實作；' +
      '請設回 rules。（接模型前要先確認 LLM 端點與資料留存政策）'
    );
  }

  throw new Error(`未知的 INTENT_CLASSIFIER: ${name}（目前支援 rules）`);
}
