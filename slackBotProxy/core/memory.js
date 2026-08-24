// ═══════════════════════════════════════════════════════════════════
//  記憶圖譜的裁決按鈕（入向）
//
//  方向：Slack 按鈕 → 這裡 → repository_dispatch(memory-answer) → augma
//
//  ── 為什麼不走 handleInteraction 那整段決策邏輯 ──────────────────────────
//
//  那段從第一行起就假設「這是 pipeline 的決策」：
//    · 去重鍵是 `ans_<jiraId>_<questionId>`——記憶決策沒有 jiraId，
//      組出來的鍵長成 `ans_undefined_M-001`，所有記憶題共用同一把鎖
//    · 讀 `fetchProgress(jiraId)` 做長期去重——那會拿 undefined 去打 GitHub
//      contents API，然後 404
//    · dispatchResume 以 jira_id + pipeline + phase 為鍵——augma 那側的
//      resume-workflow.yml 收到沒有單號的 payload 會直接失敗
//
//  所以在 handleInteraction 的**最前面**就分岔（與 ask_confirm 同一層），
//  不要讓它流過去。流過去的症狀是「按了沒反應，而且 Actions 完全沒有紀錄」。
//
//  ── 去重只有一層，而那是刻意的 ────────────────────────────────────────
//
//  pipeline 決策有兩層去重（CacheService 6 小時 ＋ progress.json 的 answered）。
//  這裡只有 CacheService，因為長期去重那一層由 augma 自己做——
//  `kg.py decisions apply` 看到 `answered: true` 就直接回報「已由某某回答」
//  並且**不重複套用**。真相在 main 的 pending-decisions.json，不在這裡。
//
//  這個分工也解掉一個 pipeline 那側花了很久才修好的破口：CacheService 只有
//  6 小時，過期後同一顆按鈕可以再點一次。這裡再點一次也沒關係——
//  augma 會冪等地擋掉。
// ═══════════════════════════════════════════════════════════════════

// 與 pipeline 的答案鎖刻意用不同前綴。共用前綴的話，某張單剛好有一題叫 M-001
// 時兩邊會互相擋掉——而那是靜默的。
function _memoryAnswerKey_(memoryId, questionId) {
  return 'mem_' + memoryId + '_' + questionId;
}

const MEMORY_ANSWER_CACHE_TTL = 21600;   // 6 小時，CacheService 上限


function handleMemoryInteraction(interaction, provider) {
  const memoryId = interaction.memoryId;
  const questionId = interaction.questionId;
  const choice = interaction.choice;
  const label = interaction.choiceLabel || choice;
  const user = interaction.user;

  // memory_id 樣式在這裡驗一次。augma 那側會再驗同一條（它不能相信呼叫端），
  // 但擋在這裡的好處是：對不上就不會白燒一次 Actions，而且人立刻看到提示。
  //
  // ⚠️ 樣式是 `mem.YYYYMMDD.HHMMSS`，**用點不是連字號**。這不是風格問題：
  //    `MEM-20260824` 會被本檔隔壁 decision.js 的 JIRA_IN_TEXT_RE 認成單號，
  //    `mem-20260824-031500` 會被 ASK_ID_IN_TEXT_RE 認成 ask 提問編號。
  //    兩種誤認都會讓這個 thread 的歸屬被快取六小時，然後整串壞掉。
  if (!memoryId || !/^mem\.[0-9]{8}\.[0-9]{6}$/.test(String(memoryId))) {
    provider.notifyTransient(interaction,
      '⚠️ 這張卡片的 memory_id 不合法（' + (memoryId || '空的') + '），沒有送出。' +
      '請等下一輪每日沉澱發出新卡片。');
    return _emptyResponse_();
  }
  if (!questionId || !choice) {
    provider.notifyTransient(interaction, '⚠️ 這顆按鈕缺少題號或選項，沒有送出。');
    return _emptyResponse_();
  }

  const lock = LockService.getScriptLock();
  const hasLock = lock.tryLock(1500);
  if (!hasLock) {
    provider.notifyTransient(interaction, '⏳ 系統正在處理其他決策，請稍候幾秒再點一次。');
    return _emptyResponse_();
  }

  try {
    const cache = CacheService.getScriptCache();
    const ck = _memoryAnswerKey_(memoryId, questionId);
    const recentBy = cache.get(ck);
    if (recentBy) {
      provider.notifyTransient(interaction,
        'ℹ️ 這一題已由 ' + recentBy + ' 裁決，本次點擊不生效。');
      return _emptyResponse_();
    }
    cache.put(ck, String(user), MEMORY_ANSWER_CACHE_TTL);

    // 3 秒預算內的順序與 pipeline 決策相同、理由也相同：
    // **先 dispatch**（唯一不可失敗的動作），再更新卡片。
    //
    // conversation 要一起送過去：記憶決策沒有 progress.json 可以讓 augma 反查
    // 錨點（那一份以 jira_key 為鍵、住在 feature 分支上），所以結果要回到哪裡
    // 必須在 dispatch 時就定案。
    const dispatched = dispatchMemoryAnswer(memoryId, questionId, choice, user,
                                           interaction.conversation);
    if (!dispatched) {
      // 觸發失敗時**不可**把卡片標成已定案——那會讓人以為裁決生效了。
      // 同時撤掉去重標記，讓他可以再點一次重試。
      cache.remove(ck);
      provider.notifyTransient(interaction,
        '⚠️ 已記錄你的選擇，但觸發 GitHub Actions 失敗，裁決沒有套用。' +
        '請稍後再點一次，或確認 GAS 的 GITHUB_TOKEN 是否有效。');
      return _emptyResponse_();
    }

    const timeStr = Utilities.formatDate(new Date(), 'Asia/Taipei', 'HH:mm:ss');

    // 沿用 pipeline 那支 resolveDecision：block_id 命名（`decision_actions_<qid>`
    // 與 `decision_progress`）在出向的 postMemoryDecision 裡是刻意對齊的，
    // 所以逐題替換與進度行更新都直接可用，不必再寫一份。
    provider.resolveDecision(interaction.conversation, interaction.messageId, {
      questionId: questionId,
      choice: label,
      user: user,
      timeStr: timeStr,
      jiraId: memoryId,      // 只用在 fallbackText，這裡放 memory_id
      blocks: interaction.blocks,
      progressText: '正在把裁決套用到記憶圖譜…套用結果會回在這則底下' +
                    '（只有 augma 知道圖譜實際變成什麼樣）。',
      responseUrl: interaction.responseUrl
    });
  } finally {
    lock.releaseLock();
  }

  return _emptyResponse_();
}
