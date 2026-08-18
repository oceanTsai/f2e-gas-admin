// ═══════════════════════════════════════════════════════════════════
//  Provider 抽象工廠 (Provider Factory)
//  依據指令碼屬性 CHAT_PROVIDER (預設 slack) 動態取得通訊平台實作
// ═══════════════════════════════════════════════════════════════════

function getProvider() {
  const props = PropertiesService.getScriptProperties();
  const providerName = (props.getProperty('CHAT_PROVIDER') || 'slack').toLowerCase();

  if (providerName === 'googlechat' || providerName === 'google_chat') {
    // 未實作的 provider 一律在此擋下並明確拋錯。讓它回傳一個「會靜默降級」的物件，
    // 等於把設定錯誤變成「卡片永遠不會出現」的無聲故障。
    if (!GoogleChatProvider.implemented) {
      throw new Error(
        'CHAT_PROVIDER 設為 googlechat，但 GoogleChatProvider 尚未實作；' +
        '請設回 slack 或先完成 providers/googleChat.js'
      );
    }
    return GoogleChatProvider;
  }

  if (providerName !== 'slack') {
    throw new Error(`未知的 CHAT_PROVIDER: ${providerName}（目前支援 slack）`);
  }

  return SlackProvider;
}
