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
//    mention         → `<users/{id}>`（Slack 是 `<@{id}>`）。空值要回空字串，
//                      不是 `<users/>`——見 SlackProvider.mention 的說明
//    postIntentHelp  → Cards v2；按鈕文字與 value 結構照 SlackProvider 那份，
//                      因為 value 是與 parseInteraction 的私有契約
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

//
//  ⚠️ 下面的實作指引是**完整清單**，橫跨兩個專案：出向函式在 messageDispatch，
//  入向函式在 slackBotProxy。這份檔案只會有屬於自己那一側的 key。
//  【入向專用】stub，與 messageDispatch 那份同步維護。

const GoogleChatProvider = {
  name: 'googlechat',
  implemented: false,

  // mention 只是字串轉換、不需要任何 API，照樣 throw 是刻意的：implemented 為
  // false 時 getProvider() 就會擋下來，這裡永遠不會被呼叫到。單獨實作它只會讓人
  // 以為這個 provider「部分可用」，而那正是上一版靜默降級的來源。
  mention:          function() { _googleChatNotImplemented_('mention'); },

  postAccepted:     function() { _googleChatNotImplemented_('postAccepted'); },
  postIntentHelp:   function() { _googleChatNotImplemented_('postIntentHelp'); },
  resolveDecision:  function() { _googleChatNotImplemented_('resolveDecision'); },
  parseInteraction: function() { _googleChatNotImplemented_('parseInteraction'); },
  notifyTransient:  function() { _googleChatNotImplemented_('notifyTransient'); },
  postMessage:      function() { _googleChatNotImplemented_('postMessage'); },
  updateMessage:    function() { _googleChatNotImplemented_('updateMessage'); },
  postWebhook:      function() { _googleChatNotImplemented_('postWebhook'); },

  fetchThreadRoot:  function() { _googleChatNotImplemented_('fetchThreadRoot'); },
  fetchThreadTexts: function() { _googleChatNotImplemented_('fetchThreadTexts'); }
};
