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
  const ok = dispatchUsage(conv, userId);

  if (!ok) {
    // dispatch 失敗（缺 GITHUB_TOKEN、API 掛了）要當場說。這條路沒有任何
    // 後續訊息會來——augma 根本沒被觸發，沉默等於這個功能看起來壞掉但沒人知道。
    provider.postMessage(conv.channel,
      provider.mention(userId) + ' ⚠️ 查額度的請求送不出去（GitHub dispatch 失敗）。',
      _replyTarget_(conv));
    return;
  }

  provider.postMessage(conv.channel,
    provider.mention(userId) + ' 📊 正在跟 runner 要額度…',
    _replyTarget_(conv));
}
