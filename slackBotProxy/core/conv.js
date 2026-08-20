// ═══════════════════════════════════════════════════════════════════
//  Conversation 錨點：三個 ts，三種用途，混用任何兩個都會壞
//
//  Slack 的 thread 只有一層，所以「Alice 要把話說在哪裡」這件事看起來很單純，
//  實際上牽涉三個不同的 ts。它們曾經被混用過，而每一種混用的症狀都很難查：
//
//    thread    ── 真正的 thread_ts。**null 代表這句話不在任何 thread 裡**。
//                 兩支反查（「這個 thread 是哪張單」「是哪一支 ask 分支」）就是
//                 靠這個 null 判斷「連 Slack API 都不必打」，所以它不能被借去
//                 表達「我要回哪裡」——一借，每次在頻道裡講話都會多打一次 API，
//                 而且「不在 thread 裡」與「在 thread 裡但查不到單號」會混成
//                 同一件事（後者要告訴使用者原因，前者是完全正常的情況）。
//
//    replyTo   ── 觸發這件事的**那一則人的訊息**自己的 ts。
//                 人在頻道裡直接 @Alice 時，Alice 應該回在他那則底下（讓它成為
//                 那則的 thread），而不是在頻道裡另起一則新訊息——後者會把提問
//                 與回答拆成兩段看起來不相干的東西，而且提問越長越明顯。
//
//    status_ts ── 進度看板要 chat.update 的目標，**必須**是 Alice 自己發的那則。
//                 拿 thread 去 update 會失敗：在既有 thread 內觸發時那是別人的
//                 訊息，bot 無權更新。這一個由 postAccepted 回傳，不在這裡。
//
//  ⚠️ replyTo 只由入口層（app_mention）填。slash command 沒有訊息可以掛，按鈕
//     互動則本來就拿得到 thread_ts，兩者都不需要它。
//
//  ⚠️ 這個轉向有一個連帶後果：thread 的第一則訊息從此是**人打的那句話**，
//     不再是 Alice 的受理訊息。任何「反查第一則訊息」的邏輯都要重新確認——
//     ask 的提問編號就是因此改成掃整串（見 ask.js 的 _resolveAskIdFromThread_）。
// ═══════════════════════════════════════════════════════════════════

/**
 * 「這句話的回覆要貼到哪裡」的唯一答案。
 *
 * 已經在 thread 裡就回那個 thread（Slack 不支援 thread 內再開 thread），
 * 否則回在觸發訊息底下。兩者都沒有（slash command）才回 null＝貼在頻道層級。
 */
function _replyTarget_(conv) {
  if (!conv) return null;
  return conv.thread || conv.replyTo || null;
}
