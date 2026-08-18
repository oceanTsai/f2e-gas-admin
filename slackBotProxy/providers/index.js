// ═══════════════════════════════════════════════════════════════════
//  Provider 抽象工廠 (Provider Factory)
//  依據指令碼屬性 CHAT_PROVIDER (預設 slack) 動態取得通訊平台實作
// ═══════════════════════════════════════════════════════════════════

function getProvider() {
  const props = PropertiesService.getScriptProperties();
  const providerName = (props.getProperty('CHAT_PROVIDER') || 'slack').toLowerCase();

  if (providerName === 'googlechat' || providerName === 'google_chat') {
    return GoogleChatProvider;
  }

  // 預設採用 Slack Provider
  return SlackProvider;
}
