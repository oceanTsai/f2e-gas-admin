// ═══════════════════════════════════════════════════════════════════
//  記憶圖譜的決策卡片（出向）
//
//  方向：augma 的 memory-daily.yml → notify-memory.sh → 這裡 → Slack
//
//  ── 為什麼不能沿用 handleDecisionRequest ────────────────────────────────
//
//  那支有兩個硬前提，每日記憶 job 兩個都不成立：
//
//    1. **有 jira_id。** 卡片標題、按鈕 payload、答案回傳鏈（dispatchResume →
//       resume-workflow.yml → apply-answer.sh）全部以單號為鍵。記憶決策沒有單號。
//    2. **有 conversation 錨點。** 那來自「觸發這條 pipeline 的那則 Slack 訊息」。
//       每日 cron 沒有任何人發過訊息，所以沒有錨點可以推導。
//
//  第 2 點是真正的分歧點，而且它不是可以繞的——**必須有一個設定好的固定頻道**。
//  所以這條通道要求 Script Property `MEMORY_CHANNEL`。
//
//  ── 為什麼不給一個合成單號（例如 MEM-20260824）走既有那條鏈 ──────────────
//
//  augma 側幾乎不用改，但代價是這裡與 slackBotProxy 兩邊都要容忍一個不存在於
//  Jira 的 key：fetchProgress 會去讀 `feature/MEM-20260824` 分支的 progress.json
//  然後 404，thread 反查會把它當成真單號並快取六小時。漏加一處例外的症狀是
//  「答案送出了但什麼都沒發生」，而且錯得離事發點很遠。
//
//  ── 記憶決策只能按按鈕，不支援文字回覆 ─────────────────────────────────
//
//  選項是列舉的（以哪一顆為準／其實不衝突），按鈕就夠。而少了文字通道就少掉
//  整個「這個 thread 屬於誰」的反查——那是通訊層最容易出錯的地方
//  （見 slackBotProxy/core/decision.js 開頭那一大段）。這是刻意的取捨。
// ═══════════════════════════════════════════════════════════════════

function _memoryConversation_(body) {
  // augma 送過來的 conversation 一律是空物件（它沒有錨點可以帶）。
  // 但還是先看一眼：手動觸發 workflow 時有人可能刻意指定一個頻道，
  // 那應該優先於預設值。
  const given = body.conversation || {};
  if (given.channel || given.space) return given;

  const ch = PropertiesService.getScriptProperties().getProperty('MEMORY_CHANNEL');
  if (!ch) return null;
  // 沒有 thread：這是一則新的頂層訊息。後續的結果回報會掛在它底下
  // （augma 把 conversation 隨答案一起帶回來，見 handleMemoryResult）。
  return { provider: 'slack', channel: String(ch).trim() };
}


function handleMemoryRequest(body, key, provider) {
  const notifyKey = PropertiesService.getScriptProperties().getProperty('NOTIFY_KEY');
  if (notifyKey && key !== notifyKey) {
    return _json_({ error: 'Unauthorized: invalid notify key' });
  }

  const memoryId = String(body.memory_id || '').trim();
  if (!memoryId) {
    // memory_id 是答案回傳的路由鍵。空的話卡片會是一張按了沒反應的卡片，
    // 那比不發更糟——人以為已經裁決了。
    return _json_({ error: 'Missing memory_id' });
  }

  const questions = (body.questions && body.questions.length) ? body.questions : [];
  if (!questions.length) {
    return _json_({ error: 'No questions to post' });
  }

  const conv = _memoryConversation_(body);
  if (!conv) {
    // 明確失敗，不要靜默降級。設錯的症狀若是「卡片永遠不出現」，
    // 沒有人會想到是少設一個 Script Property。
    return _json_({
      error: '未設定 Script Property MEMORY_CHANNEL——記憶決策沒有 conversation ' +
             '錨點（每日 cron 沒有任何人發過訊息），必須有一個設定好的固定頻道。' +
             '請填 Slack channel id（C 開頭），並確認 Alice 已被邀請進那個頻道。'
    });
  }

  const messageId = provider.postMemoryDecision(conv, {
    memoryId: memoryId,
    questions: questions,
    repo: body.repo || '',
    runUrl: body.run_url || ''
  });

  return _json_({ status: 'ok', message: 'Memory decision card posted',
                  message_id: messageId, channel: conv.channel });
}


// ═══════════════════════════════════════════════════════════════════
//  裁決結果回報（由 augma 的 notify-memory-result.sh 呼叫）
//
//  為什麼這則要由 augma 發、而不是入向那側按下按鈕時就回：
//  入向只知道「使用者選了 B」，不知道套用之後圖譜變成什麼樣——哪顆被降級、
//  哪條關聯被拿掉、validate 有沒有過。那些只有 kg.py decisions apply 跑完才知道。
//
//  ⚠️ 這支必須對「失敗」也發訊息。呼叫端是 `if: always()`，因為人在 Slack 看到的
//     最後一則是卡片上的「已定案」——沉默的話他會以為裁決生效了，而實際上可能
//     卡片已過期、或 validate 沒過而整批沒 push。
// ═══════════════════════════════════════════════════════════════════

function handleMemoryResult(body, key, provider) {
  const notifyKey = PropertiesService.getScriptProperties().getProperty('NOTIFY_KEY');
  if (notifyKey && key !== notifyKey) {
    return _json_({ error: 'Unauthorized: invalid notify key' });
  }

  // 錨點隨答案一起回來：記憶決策沒有 progress.json 可以讀（那一份以 jira_key
  // 為鍵、住在 feature 分支上）。拿不到就退回 MEMORY_CHANNEL，至少讓訊息落地。
  const conv = _memoryConversation_(body);
  if (!conv) {
    return _json_({ error: 'Missing conversation and MEMORY_CHANNEL not set' });
  }

  const ok = String(body.status || 'ok') === 'ok';
  const qid = String(body.question_id || '');
  const text = String(body.text || '').trim();

  const lines = [];
  lines.push((ok ? '✅ ' : '⚠️ ') + '記憶決策 `' + qid + '`' +
             (ok ? ' 已套用到圖譜：' : ' 沒有套用成功：'));
  if (text) {
    // 原樣貼 kg.py 的輸出。它已經逐行說明了「哪顆被降級、哪條關聯被加上」，
    // 在這裡重新組句只會讓兩邊的說法不一致。
    lines.push('```' + text.slice(0, 2500) + '```');
  }
  if (!ok) {
    lines.push('_多半是卡片已過期（中間跑過另一輪每日 job），或 validate 沒過。' +
               '請等下一輪每日 job 發出新卡片。_');
  }

  // 這份 codebase 一律用 '\u000a' 而不是字面換行——GAS 編輯器貼上時字面換行
  // 在單引號字串裡是語法錯誤，而那個錯誤只有部署上去才看得到。
  provider.postMessage(conv.channel, lines.join('\u000a'),
                       conv.thread || conv.thread_ts || null);

  return _json_({ status: 'ok' });
}
