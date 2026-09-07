// ═══════════════════════════════════════════════════════════════════
//  Gemini generateContent——LLM provider 實作
//  介面契約見 core/llm/index.js 檔頭。
//
//  ⚠️ 這支通常搭免費 key 用，而**免費 key 的輸入會被拿去訓練**。脫敏因此
//     不是「保險」而是前提——不過脫敏本身不在這裡做，是呼叫端
//     （core/classifiers/shadowIntent.js）的責任，對所有 provider 一視同仁。
//     把它做在這裡等於「換成付費 provider 就悄悄少脫敏一層」，而那個差異
//     不會有人記得。
// ═══════════════════════════════════════════════════════════════════

const GeminiLlm = {
  name: 'gemini',
  // 目前最快的 flash-lite 別名。要釘死版本，改這裡就好。
  model: 'gemini-flash-lite-latest',
  keyProp: 'GEMINI_API_KEY',

  apiKey: function () {
    return PropertiesService.getScriptProperties().getProperty(this.keyProp) || '';
  },

  complete: function (prompt, key) {
    try {
      // ⚠️ Gemini 的 REST 介面只吃 query string 帶 key，而 URL 會進 UrlFetchApp
      //    的執行記錄——所以這支的金鑰**本來就會**出現在 log 裡，不是疏漏。
      //    這也是預設 provider 選 openai（金鑰走 header）的一個理由。
      const resp = UrlFetchApp.fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' + this.model +
        ':generateContent?key=' + encodeURIComponent(key),
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

      if (resp.getResponseCode() !== 200) return { error: 'http-' + resp.getResponseCode() };

      try {
        const body = JSON.parse(resp.getContentText());
        return { text: body.candidates[0].content.parts[0].text };
      } catch (parseErr) {
        return { error: 'bad-envelope' };
      }
    } catch (err) {
      console.error('Gemini 呼叫失敗:', err);
      return { error: 'exception' };
    }
  }
};
