

// ═══════════════════════════════════════════════════════════════════
//  反查「這個 thread 是哪張單」
//
//  ⚠️ 這裡沒有任何持久狀態，是刻意的。
//
//  出向（貼卡片）已拆到 messageDispatch 專案，而 ScriptProperties 是 per-script
//  的——兩個 GAS 專案完全不共用。所以「貼卡片時記下 thread 對應哪張單、答覆時
//  讀出來」一拆就壞：寫在那邊，這邊讀不到。
//
//  正解不是找一個共享儲存，而是不要有狀態：thread 的第一則訊息本來就帶著單號
//  （任務受理訊息、決策卡片的 summary 都有），反查它即可；其餘一切——pipeline、
//  有哪些題、誰答過——都在 augma 的 progress.json 裡，那份有版控、是唯一真相。
//
//  CacheService 只是純快取：thread root 永遠不會變，同一個 thread 的第二次回覆
//  就不必再打一次 Slack API。掉了隨時可重建，所以不是狀態。
// ═══════════════════════════════════════════════════════════════════

const ROUTE_CACHE_TTL = 21600;   // 6 小時，CacheService 上限
const JIRA_IN_TEXT_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/;

// 回傳 null＝根本不在 thread 裡（正常情況，不是錯誤）。
// 回傳 { j: '', err: '<原因>' }＝在 thread 裡但反查不出單號——這種情況要讓使用者
// 知道原因，最常見的是缺 channels:history scope。
function _resolveRouteFromThread_(conv, provider) {
  const channel = conv && conv.channel;
  // 只認真正的 thread_ts。舊版把 channel 當 fallback，但拿 channel id 去問
  // conversations.replies 沒有意義，只是白打一次 API。
  const thread = conv && conv.thread;
  if (!channel || !thread) return null;

  const cache = CacheService.getScriptCache();
  const ck = 'route_' + thread;
  const hit = cache.get(ck);
  if (hit) return { j: hit };

  if (!provider || !provider.fetchThreadRoot) return { j: '', err: 'no-provider' };

  const rootText = provider.fetchThreadRoot(channel, thread);
  if (rootText === null) return { j: '', err: 'fetch-failed' };   // API 失敗（scope／token／網路）
  if (!rootText) return { j: '', err: 'empty-root' };             // 讀到了但沒有文字

  const m = String(rootText).toUpperCase().match(JIRA_IN_TEXT_RE);
  if (!m) {
    console.log('thread 第一則訊息裡沒有單號：' + String(rootText).slice(0, 120));
    return { j: '', err: 'no-jira-in-root' };
  }

  cache.put(ck, m[1], ROUTE_CACHE_TTL);
  return { j: m[1] };
}


// ═══════════════════════════════════════════════════════════════════
//  progress.json 查詢輔助
// ═══════════════════════════════════════════════════════════════════

// 同一張單內 Q 編號唯一，所以 jira_id + question_id 就是去重的正確鍵；
// 不必再靠 message_id（文字回覆走 app_mention，本來就拿不到卡片的 ts）。
function _answerKey_(jiraId, questionId) {
  return 'ans_' + jiraId + '_' + questionId;
}

function _findQuestion_(progress, questionId) {
  const list = (progress && progress.pending_questions) || [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].id === questionId) return list[i];
  }
  return null;
}

// 兩層去重：CacheService 擋 6 小時內的連點與 in-flight（答案已 dispatch 但
// resume workflow 還沒把 answered 寫回 progress.json 並 push）；progress.json
// 的 answered 接手長期。舊版只有前者，所以 6 小時後同一顆按鈕可以再點一次。
function _alreadyAnswered_(jiraId, questionId, question) {
  const by = CacheService.getScriptCache().get(_answerKey_(jiraId, questionId));
  if (by) return { answered: true, by: by };
  if (question && question.answered) {
    return { answered: true, by: question.answered_by || '（先前已回覆）' };
  }
  return { answered: false, by: null };
}

// 供 handleInteraction 顯示卡片進度用。刻意回傳與舊 ctx 相同的形狀
// （question_ids / phase / pipeline），讓既有的顯示邏輯一行都不用改。
function _cardProgress_(jiraId, questionId, progress, pipeline) {
  if (!progress) return null;
  const q = _findQuestion_(progress, questionId);
  if (!q) return null;
  const ids = ((progress.pending_questions) || [])
    .filter(function (x) { return x && x.phase === q.phase; })
    .map(function (x) { return x.id; });
  return { question_ids: ids, phase: q.phase, pipeline: pipeline };
}

// 某個 phase 的整體進度：全部答完才會接續後續 Phase，人需要看得到還剩幾題
function _phaseProgress_(progress, phase, jiraId) {
  const cache = CacheService.getScriptCache();
  const all = ((progress && progress.pending_questions) || []).filter(function (q) {
    return q && q.phase === phase;
  });
  const remaining = all.filter(function (q) {
    return !q.answered && !cache.get(_answerKey_(jiraId, q.id));
  });
  return { total: all.length, remaining: remaining, answered: all.length - remaining.length };
}


// ═══════════════════════════════════════════════════════════════════
//  文字回覆：@Alice answer [Q-00X] <自由描述>
//
//  按鈕只能傳回預設選項，表達不了「要改成什麼」。SA 步驟七這類問題的本質就是
//  「請人給方向」，因此保留一條文字通道。走 app_mention 事件，沒有 Slack 的
//  3 秒限制，可從容完成 dispatch 與卡片更新。
// ═══════════════════════════════════════════════════════════════════

function handleTextAnswer(args, conv, user, provider) {
  const raw = (args || '').trim();

  const USAGE = [
    '用法：在決策卡片所在的 thread 內回覆 `@Alice answer <你的答覆>`',
    '要指定題號時：`@Alice answer Q-002 <你的答覆>`',
    '（答覆要在卡片的 thread 內——Alice 靠 thread 才知道這是哪張單、要接續哪條 pipeline）'
  ].join('\u000a');

  if (!raw) {
    provider.postMessage(conv.channel, '<@' + user + '> \u26a0\ufe0f 請一併給出答覆內容。' + '\u000a' + USAGE, conv.thread);
    return;
  }

  // 第一個 token 若形如 Q-002 / q2 就當作問題編號，其餘全部視為答案本文
  let questionId = null;
  let answerText = raw;
  const m = raw.match(/^[Qq]-?(\d{1,3})\s+([\s\S]+)$/);
  if (m) {
    questionId = 'Q-' + String(parseInt(m[1], 10)).padStart(3, '0');
    answerText = m[2].trim();
  }

  // thread → 哪張單（反查訊息，不存狀態；見上面的說明）
  const route = _resolveRouteFromThread_(conv, provider);
  if (!route || !route.j) {
    provider.postMessage(conv.channel,
      '<@' + user + '> \u26a0\ufe0f ' + ((route && route.err === 'fetch-failed')
        ? '我讀不到這個 thread 的第一則訊息（多半是缺 `channels:history` 權限，改過 scope 後要重新安裝 App）。'
        : '這裡沒有待決問題。') + '\u000a' + USAGE, conv.thread);
    return;
  }

  const jiraId = route.j;
  const progress = fetchProgress(jiraId);
  // pipeline 由 augma 寫進 progress.json（update-progress.sh init --pipeline）。
  // 讀不到就不能 dispatch：猜錯會重觸發錯的 pipeline，而那是不可逆的
  // （ra-pipeline 只跑兩階，full-pipeline 跑七階）。按鈕的 value 帶著正確的
  // pipeline，所以請使用者改點按鈕，而不是替他賭一把。
  const pipeline = (progress && progress.pipeline) || '';

  // 決定要回答哪一題：指定了就用指定的，沒指定就挑第一個未答的
  let question = null;
  if (questionId) {
    question = progress ? _findQuestion_(progress, questionId) : null;
    if (progress && !question) {
      provider.postMessage(conv.channel,
        '<@' + user + '> 找不到 ' + jiraId + ' 的 ' + questionId + ' 這一題。', conv.thread);
      return;
    }
    // progress 讀不到（產物還沒 push）但有明確題號 → 照樣 dispatch，只是跳過閘門
    // 檢查與進度顯示。augma 的 update-progress.sh answer 找不到該題會自己失敗，
    // 不會靜默寫錯。
  } else {
    if (!progress) {
      provider.postMessage(conv.channel,
        '<@' + user + '> 暫時讀不到 ' + jiraId +
        ' 的流程狀態，請改成明確指定題號：`@Alice answer Q-001 <你的答覆>`',
        conv.thread);
      return;
    }
    const pendingCache = CacheService.getScriptCache();
    const pending = ((progress.pending_questions) || []).filter(function (q) {
      return q && !q.answered && !pendingCache.get(_answerKey_(jiraId, q.id));
    });
    if (pending.length === 0) {
      provider.postMessage(conv.channel,
        '<@' + user + '> ' + jiraId + ' 目前沒有待回覆的問題。', conv.thread);
      return;
    }
    question = pending[0];
    questionId = question.id;
  }

  if (!pipeline) {
    provider.postMessage(conv.channel,
      '<@' + user + '> 讀不到 ' + jiraId + ' 要接續哪條 pipeline，沒辦法安全地用文字接續。' +
      '請直接點卡片上的按鈕（按鈕本身帶著這個資訊）。', conv.thread);
    return;
  }

  // 閘門型問題只能點按鈕，不能用文字回覆。
  // 原因：resume_action = complete 時，phase-guard 只要看到「有答覆」就會判定
  // COMPLETE_ONLY 直接放行下一階段——它不會（也不該）去解讀答覆的語意。
  // 若允許文字回覆，使用者打「先不要跑」反而會讓下一階段跑起來，與意圖完全相反。
  if (question && question.resume_action === 'complete') {
    provider.postMessage(conv.channel,
      '<@' + user + '> \u2139\ufe0f ' + questionId +
      ' 是放行閘門，請直接點卡片上的按鈕。' + '\u000a' +
      '若還不想放行，就先不要動作——卡片會留在這裡等你。' + '\u000a' +
      '需要補充說明時請直接在 thread 討論，那不會觸發任何流程。',
      conv.thread);
    return;
  }

  // 與按鈕共用同一把去重鎖與快取鍵：同一題只受理一次
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    provider.postMessage(conv.channel, '<@' + user + '> \u23f3 系統忙碌中，請稍後再試。', conv.thread);
    return;
  }

  try {
    const cache = CacheService.getScriptCache();
    const cacheKey = _answerKey_(jiraId, questionId);
    const dup = _alreadyAnswered_(jiraId, questionId, question);
    if (dup.answered) {
      provider.postMessage(conv.channel,
        '<@' + user + '> \u2139\ufe0f ' + questionId + ' 已由 ' + dup.by + ' 回答，本次回覆不生效。',
        conv.thread);
      return;
    }
    cache.put(cacheKey, '<@' + user + '>', 21600);

    // 1. 先觸發 resume（唯一不可失敗的動作）
    const ok = dispatchResume(jiraId, pipeline, questionId, answerText, '<@' + user + '>');

    // 2. 刻意**不動原卡片**：文字回覆走 app_mention 事件，拿不到 payload.message.blocks，
    //    只能整張替換——那會把同一張卡片上其他題的按鈕一起吃掉。
    //    該題若被重複點擊，會被去重擋下並收到提示，所以按鈕留著不會造成重複處理。

    if (ok) {
      let tail = '正在接續 ' + pipeline + '（' + jiraId + '）…';
      if (progress && question) {
        // cacheKey 已寫入，所以這裡算出的 remaining 已排除本題
        const p = _phaseProgress_(progress, question.phase, jiraId);
        if (p.remaining.length > 0) {
          tail = '（本階段還有 ' + p.remaining.length + ' 題待回覆，全部答完才會接續）';
        }
      }
      provider.postMessage(conv.channel,
        '\u2705 已收下 <@' + user + '> 對 ' + questionId + ' 的回覆。' + tail, conv.thread);
    } else {
      cache.remove(cacheKey);   // dispatch 失敗要讓人能重試
      provider.postMessage(conv.channel,
        '\u26a0\ufe0f <@' + user + '> 回覆已記錄，但觸發 GitHub Actions 失敗，' +
        '請確認 GITHUB_TOKEN 或稍後重試。', conv.thread);
    }
  } finally {
    lock.releaseLock();
  }
}


function handleInteraction(payload, provider, key) {
  // 金鑰驗證：與 decision 請求同一把 NOTIFY_KEY（Slack 的 Interactivity URL 可帶 query param）
  const notifyKey = PropertiesService.getScriptProperties().getProperty('NOTIFY_KEY');
  if (notifyKey && key !== notifyKey) {
    console.error('handleInteraction: 未授權的請求（notify key 不符）');
    return _emptyResponse_();
  }

  const interaction = provider.parseInteraction(payload);
  if (!interaction) {
    return _emptyResponse_();
  }

  const questionId = interaction.questionId;
  const choice = interaction.choice;
  const jiraId = interaction.jiraId;
  const pipeline = interaction.pipeline;
  const user = interaction.user;
  const conv = interaction.conversation;
  const messageId = interaction.messageId;

  // 使用 LockService 防止同時間多人連點競態。
  // 等鎖時間刻意壓到 1.5 秒：Slack 要求 3 秒內回應，等太久會讓使用者看到 operation_timeout。
  const lock = LockService.getScriptLock();
  const hasLock = lock.tryLock(1500);

  if (!hasLock) {
    provider.notifyTransient(interaction, '⏳ 系統正在處理其他決策，請稍候幾秒再點一次。');
    return _emptyResponse_();
  }

  try {
    const cache = CacheService.getScriptCache();
    const cacheKey = _answerKey_(jiraId, questionId);

    // 短期去重先查：連點是最常見的重複，本機命中就不必為它多打一次 GitHub。
    const recentBy = cache.get(cacheKey);
    if (recentBy) {
      provider.notifyTransient(interaction, `ℹ️ 此問題已由 ${recentBy} 回答，本次點擊不生效。`);
      return _emptyResponse_();
    }

    // 長期去重與進度都靠 progress.json——CacheService 只有 6 小時，過期後同一顆
    // 按鈕會變成可以再點一次（舊版的破口）。這次讀取（約 250ms）刻意放在 dispatch
    // 之前：去重放在觸發之後就沒有意義了。讀不到就降級成只有短期去重，dispatch 照做。
    const progress = fetchProgress(jiraId);
    const question = _findQuestion_(progress, questionId);

    const answeredBy = (question && question.answered)
      ? (question.answered_by || '（先前已回覆）')
      : null;
    if (answeredBy) {
      // 已有人先點過：只對這位使用者顯示提示，不動原卡片
      provider.notifyTransient(interaction, `ℹ️ 此問題已由 ${answeredBy} 回答，本次點擊不生效。`);
      return _emptyResponse_();
    }

    // 標記為已回答並記下回答者 (快取 6 小時)，供後到者的提示使用
    cache.put(cacheKey, String(user), 21600);

    const now = new Date();
    const timeStr = Utilities.formatDate(now, 'Asia/Taipei', 'HH:mm:ss');

    // ── 3 秒預算內的執行順序（順序是刻意的）──
    // 0. 去重（cache 零延遲，必要時再讀 progress.json）——必須在觸發之前。
    // 1. 先觸發 resume：這是唯一不可失敗的動作。若整體超過 3 秒被 Slack 判逾時，
    //    GAS 本身仍會跑完，但把最關鍵的一步放在前面可將風險降到最低。
    const dispatched = dispatchResume(jiraId, pipeline, questionId, choice, user);

    if (!dispatched) {
      // 觸發失敗時**不可**把卡片標成已定案——那會讓人以為流程在跑。
      // 同時撤掉去重標記，讓他可以再點一次重試。
      cache.remove(cacheKey);
      provider.notifyTransient(interaction,
        '⚠️ 已記錄你的選擇，但觸發 GitHub Actions 失敗，流程沒有接續。請稍後再點一次，' +
        '或確認 GAS 的 GITHUB_TOKEN 是否有效。');
      return _emptyResponse_();
    }

    // 算出這張卡片的整體進度：全部答完才會接續後續 Phase，人需要看得到還剩幾題
    const ctx = _cardProgress_(jiraId, questionId, progress, pipeline);
    let progressText = '';
    if (ctx && ctx.question_ids && ctx.question_ids.length) {
      const total = ctx.question_ids.length;
      const remaining = ctx.question_ids.filter(function (qid) {
        return !_alreadyAnswered_(jiraId, qid, _findQuestion_(progress, qid)).answered;
      });
      const answered = total - remaining.length;
      progressText = (remaining.length === 0)
        ? '*執行階段*：`' + (ctx.phase || '') + '`\n✅ 全部 *' + total +
          '* 題已回答完畢，正在接續 `' + (ctx.pipeline || '') + '`…'
        : '*執行階段*：`' + (ctx.phase || '') + '`\n共 *' + total + '* 題待決議（已回答 ' +
          answered + '／' + total + '），**每題都回答完**才會接續後續流程。';
    }

    // 不需要清任何上下文：答覆狀態的真相在 progress.json，thread 映射由 GC 淘汰。

    // 2. 再更新卡片：替換這一題的按鈕區塊、就地更新進度行。
    //    以 chat.update 為主、response_url 為 fallback（見 slack.js 的說明）。
    //    若日後實測常逾時，升級路徑是把 dispatch 丟進 PropertiesService 佇列，
    //    改由 ScriptApp.newTrigger(...).after(1000) 非同步送出——代價是需要
    //    script.scriptapp 授權，且多出「trigger 沒跑就永遠不 resume」的靜默失敗模式，
    //    因此目前不採用。
    provider.resolveDecision(conv, messageId, {
      questionId: questionId,
      choice: choice,
      user: user,
      timeStr: timeStr,
      jiraId: jiraId,
      blocks: interaction.blocks,          // 逐題替換用
      progressText: progressText,          // 就地更新的進度行
      responseUrl: interaction.responseUrl
    });

  } finally {
    lock.releaseLock();
  }

  return _emptyResponse_();
}


// ═══════════════════════════════════════════════════════════════════
//  狀態查詢：@Alice VIPOP-12345 進度
//
//  順便補上一個一直存在的信任缺口：unattended 模式下 agent 採預設值續跑時，
//  會用 record-assumption 把假設寫進 progress.json 的 assumptions，但通訊層
//  從來沒有顯示過它——人不知道 AI 幫他假設了什麼。這裡一併列出來。
// ═══════════════════════════════════════════════════════════════════

const PHASE_LABEL = {
  'ra-phase1': 'RA① 資料抓取',
  'ra-phase2': 'RA② 規格分析',
  'sa-phase1': 'SA① 範疇判讀',
  'sa-phase2': 'SA② Codebase 分析',
  'sa-phase3': 'SA③ SA 文件',
  'sa-phase4': 'SA④ Design 文件',
  'sa-phase5': 'SA⑤ 工項拆解'
};

const PHASE_ICON = {
  completed: '\u2705',
  running: '\u23f3',
  awaiting_decision: '\U0001f534',
  failed: '\u274c'
};

function handleStatusQuery(jiraId, conv, user, provider) {
  if (!jiraId) {
    provider.postMessage(conv.channel,
      '<@' + user + '> 要查哪張單？例：`@Alice VIPOP-12345 進度`', conv.thread);
    return;
  }

  const progress = fetchProgress(jiraId);
  if (!progress) {
    provider.postMessage(conv.channel,
      '<@' + user + '> 讀不到 ' + jiraId + ' 的狀態。可能還沒開始跑，或產物尚未推上分支。',
      conv.thread);
    return;
  }

  const lines = [];
  lines.push('*' + jiraId + '* — 目前狀態');

  const phases = progress.phases || {};
  const keys = Object.keys(phases);
  if (keys.length) {
    keys.forEach(function (k) {
      const st = (phases[k] && phases[k].status) || 'pending';
      const icon = PHASE_ICON[st] || '\u26aa';
      lines.push(icon + ' ' + (PHASE_LABEL[k] || k) + ' \u2014 ' + st);
    });
  } else {
    lines.push('_尚無階段紀錄_');
  }

  const pend = (progress.pending_questions || []).filter(function (q) {
    return q && !q.answered;
  });
  if (pend.length) {
    lines.push('');
    lines.push('\U0001f534 *' + pend.length + ' 題待回覆*（全部答完才會接續）：');
    pend.slice(0, 5).forEach(function (q) {
      lines.push('\u2022 `' + q.id + '` ' + String(q.question || '').slice(0, 90));
    });
    if (pend.length > 5) lines.push('_…另有 ' + (pend.length - 5) + ' 題_');
  }

  const assumptions = progress.assumptions || [];
  if (assumptions.length) {
    lines.push('');
    lines.push('\u2139\ufe0f *採用了 ' + assumptions.length + ' 項假設*（無人值守下自動續跑）：');
    assumptions.slice(0, 5).forEach(function (a) {
      const note = (a && a.note) ? a.note : JSON.stringify(a);
      const ph = (a && a.phase) ? ('`' + a.phase + '` ') : '';
      lines.push('\u2022 ' + ph + String(note).slice(0, 90));
    });
    if (assumptions.length > 5) lines.push('_…另有 ' + (assumptions.length - 5) + ' 項_');
  }

  if (progress.last_error) {
    lines.push('');
    lines.push('\u274c *最近一次錯誤*（`' + (progress.last_error.phase || '') + '`）：' +
               String(progress.last_error.message || '').slice(0, 160));
  }

  if (progress.updated_at) {
    lines.push('');
    lines.push('_最後更新：' + progress.updated_at + '_');
  }

  provider.postMessage(conv.channel, lines.join('\n'), conv.thread);
}


// ═══════════════════════════════════════════════════════════════════
//  一次性清理：移除舊版留下的 ScriptProperties
//
//  舊版每一題都存一份完整的決策上下文（dctx_q_<qid>），thread 再存一份
//  （dctx_t_<thread>），而且只有「成功答覆」時才刪——沒答的、被放棄的單、
//  dispatch 失敗的那些，全部永久留著。約 150 張單就會撞到 500 KB 上限，
//  然後 setProperty 開始拋錯、卡片再也發不出去。
//
//  現在這兩種 key 都沒有人讀了（thread 路由改成反查 Slack 訊息 + 讀
//  progress.json），但它們不會自己消失。部署後在 GAS 編輯器手動執行這支一次，
//  之後可以刪掉這段程式碼。
// ═══════════════════════════════════════════════════════════════════

function cleanupLegacyKeys() {
  const props = PropertiesService.getScriptProperties();
  const keys = props.getKeys();
  const legacy = keys.filter(function (k) {
    return k.indexOf('dctx_q_') === 0 || k.indexOf('dctx_t_') === 0;
  });

  if (!legacy.length) {
    console.log('沒有舊版 key 需要清理（共 ' + keys.length + ' 個 property）。');
    return;
  }

  let bytes = 0;
  legacy.forEach(function (k) {
    const v = props.getProperty(k);
    bytes += k.length + (v ? v.length : 0);
  });

  legacy.forEach(function (k) { props.deleteProperty(k); });
  console.log('已清除 ' + legacy.length + ' 個舊版 key，釋放約 ' +
              Math.round(bytes / 1024 * 10) / 10 + ' KB（上限 500 KB）。');
}
