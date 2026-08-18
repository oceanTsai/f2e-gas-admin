// ═══════════════════════════════════════════════════════════════════
//  Google Chat Provider（骨架 — 尚未實作）
//
//  ⚠️ 目前每個方法都會 throw，這是刻意的。
//  先前版本只 console.log 然後回傳假值，導致把 CHAT_PROVIDER 切成 googlechat 時
//  整條流程「靜默降級」：postAccepted 回傳沒有 channel 的物件、postDecision 回假
//  message id、dispatch 仍照送——表面上一切正常，實際上沒有人收到任何卡片。
//  明確失敗遠優於靜默失敗。
//
//  實作時的對應關係（介面與 SlackProvider 相同）：
//    postAccepted    → spaces.messages.create（取得 thread.name 當錨點）
//    postDecision    → Cards v2 的 buttonList；button 帶 question_id / choice / jira_id / pipeline
//    resolveDecision → spaces.messages.patch，把 buttonList 換成純文字（等同消除按鈕）
//    parseInteraction→ CARD_CLICKED 事件；GAS 對 Google Chat 有原生 onMessage /
//                      onCardClick 觸發，不走 doPost，因此入口層要另外接（見規劃文件第十二章第 4 節）
//    notifyTransient → privateMessageViewer 的 ephemeral 回覆
// ═══════════════════════════════════════════════════════════════════

const GOOGLE_CHAT_NOT_IMPLEMENTED =
  'GoogleChatProvider 尚未實作。請將 Script Property CHAT_PROVIDER 設回 slack，' +
  '或先完成 providers/googleChat.js（介面請對齊 SlackProvider）。';

function _googleChatNotImplemented_(method) {
  throw new Error(`${GOOGLE_CHAT_NOT_IMPLEMENTED}（缺少：${method}）`);
}

const GoogleChatProvider = {
  name: 'googlechat',
  implemented: false,

  postAccepted:     function() { _googleChatNotImplemented_('postAccepted'); },
  postDecision:     function() { _googleChatNotImplemented_('postDecision'); },
  resolveDecision:  function() { _googleChatNotImplemented_('resolveDecision'); },
  parseInteraction: function() { _googleChatNotImplemented_('parseInteraction'); },
  notifyTransient:  function() { _googleChatNotImplemented_('notifyTransient'); },
  postMessage:      function() { _googleChatNotImplemented_('postMessage'); },
  updateMessage:    function() { _googleChatNotImplemented_('updateMessage'); },
  postWebhook:      function() { _googleChatNotImplemented_('postWebhook'); },
};
