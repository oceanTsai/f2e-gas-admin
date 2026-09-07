// ═══════════════════════════════════════════════════════════════════
//  OpenAI chat completions——LLM provider 實作
//  介面契約見 core/llm/index.js 檔頭。
// ═══════════════════════════════════════════════════════════════════

const OpenAiLlm = {
  name: 'openai',
  // 影子分類要的是「便宜且夠快」，所以釘在 mini 這一階。要換版本改這裡就好。
  model: 'gpt-4.1-mini',
  keyProp: 'OPENAI_API_KEY',

  apiKey: function () {
    return PropertiesService.getScriptProperties().getProperty(this.keyProp) || '';
  },

  complete: function (prompt, key) {
    try {
      // 金鑰走 Authorization header，不放在 query string——URL 會被寫進
      // UrlFetchApp 的執行記錄，把金鑰塞進 query string 等於順手記進 log。
      const resp = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + key },
        muteHttpExceptions: true,
        payload: JSON.stringify({
          model: this.model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: prompt }]
        })
      });

      if (resp.getResponseCode() !== 200) return { error: 'http-' + resp.getResponseCode() };

      try {
        const body = JSON.parse(resp.getContentText());
        return { text: body.choices[0].message.content };
      } catch (parseErr) {
        return { error: 'bad-envelope' };
      }
    } catch (err) {
      console.error('OpenAI 呼叫失敗:', err);
      return { error: 'exception' };
    }
  }
};
