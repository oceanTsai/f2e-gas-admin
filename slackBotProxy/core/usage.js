// ═══════════════════════════════════════════════════════════════════
//  查 runner 的 Claude 額度
//
//  ── 為什麼要繞一趟 GitHub Actions ──────────────────────────────────
//
//  額度是綁在**跑 agent 的那台 runner** 上的訂閱用量（`claude -p /usage` 讀的是
//  該機器的本機 session 統計）。GAS 這側算不出來，也沒有任何 API 可以問——
//  只能請那台機器自己報。所以這條路是：
//
//    Slack →（這裡）→ repository_dispatch(usage) → augma 的 claude-usage.yml
//                                                → notify-usage.sh → 貼回同一個 thread
//
//  ── 為什麼結果不是同步回傳 ─────────────────────────────────────────
//
//  repository_dispatch 只回 204（收到了），不等 job 跑完；而 Slack 的
//  slash command 有 3 秒上限。所以一定是「先受理、之後主動貼回來」的兩段式，
//  與 ask 同構——差別只在 usage 沒有進度看板可以就地 update。
//
//  ⚠️ 受理訊息不能省。額度 job 幾秒就跑完，但那三個 self-hosted runner 可能正被
//     RA／SA 佔滿而排隊。沒有受理訊息的話，那段等待看起來就是「打了沒反應」，
//     而人的下一步是再打一次——又排一個 job。
// ═══════════════════════════════════════════════════════════════════

function handleUsageQuery(conv, userId, provider) {
  // ⚠️ **一定要用 postAccepted，不能用 postMessage + _replyTarget_。**
  //
  // 人在頻道裡直接 `@Alice 額度` 時，conv.thread 是 **null**（那句話不在任何
  // thread 裡，只有 replyTo）。把原始的 conv 送給 augma，幾分鐘後結果回來時
  // conversation.thread 仍然是 null——通訊層就把答案貼成**頻道層級的新訊息**，
  // 與受理訊息拆成兩段看起來不相干的東西。實際踩到過。
  //
  // postAccepted 回傳的 anchored 把這件事在 dispatch **之前**就定案：
  // `thread: threadTs || acceptedTs`——沒有現成 thread 時就用受理訊息自己的 ts
  // 當 thread。這與 ask 完全同構（見 ask.js 的 `anchored`），理由也一樣：
  // 答案回來時已經沒有任何 Slack 事件可以推導「該貼哪裡」。
  const anchored = provider.postAccepted(conv,
    provider.mention(userId) + ' 📊 正在跟 runner 要額度…');

  const ok = dispatchUsage(anchored, userId);

  if (!ok) {
    // dispatch 失敗（缺 GITHUB_TOKEN、API 掛了）要當場說。這條路沒有任何
    // 後續訊息會來——augma 根本沒被觸發，沉默等於這個功能看起來壞掉但沒人知道。
    provider.postMessage(anchored.channel,
      provider.mention(userId) + ' ⚠️ 查額度的請求送不出去（GitHub dispatch 失敗）。',
      anchored.thread);
  }
}
