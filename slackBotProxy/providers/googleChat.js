// ═══════════════════════════════════════════════════════════════════
//  Google Chat Provider 實作 (Cards v2 & Spaces API 抽象)
// ═══════════════════════════════════════════════════════════════════

const GoogleChatProvider = {
  name: 'googlechat',

  postAccepted: function(conv, text) {
    console.log('[GoogleChat] postAccepted:', conv, text);
    // 預留 Google Chat Spaces API 實作
    return {
      provider: 'googlechat',
      space: conv.space || conv.channel,
      thread: conv.thread || null
    };
  },

  postDecision: function(conv, questionObj, jiraId, phase, pipeline) {
    console.log('[GoogleChat] postDecision:', jiraId, questionObj);
    // 預留 Cards v2 格式建置
    return 'msg-' + new Date().getTime();
  },

  resolveDecision: function(conv, messageId, choice, user, timeStr, jiraId) {
    console.log('[GoogleChat] resolveDecision:', messageId, choice);
    // 預留 spaces.messages.patch 更新卡片
  },

  parseInteraction: function(payload) {
    // 預留 CARD_CLICKED 事件解析
    return null;
  },

  postMessage: function(channel, text, threadTs, blocks) {
    console.log('[GoogleChat] postMessage:', channel, text);
  },

  updateMessage: function(channel, ts, text, blocks) {
    console.log('[GoogleChat] updateMessage:', channel, ts, text);
  },

  postWebhook: function(text) {
    console.log('[GoogleChat] postWebhook:', text);
  }
};
