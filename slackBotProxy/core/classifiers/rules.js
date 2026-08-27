// ═══════════════════════════════════════════════════════════════════
//  意圖分類器：規則層
//
//  目的：讓人可以直接 @Alice 講話，不必記 `/ra`、`/sa`、`answer Q-002` 這些
//  語法——那些是 pipeline 目錄結構長在使用者介面上，不是人的心智模型。
//
//  為什麼規則優先、而且大概永遠是主力：
//    1. 規則能吃掉大部分流量，零延遲、零成本、零資料外流。
//    2. 沒接住的句子會被路由層記錄下來。那份清單就是日後設計 LLM prompt 的
//       真實語料——憑想像寫的 prompt 一定是錯的。
//    3. slash command 一律保留，永遠不經過這一層：意圖層掛掉時系統還能用。
//
//  ⚠️ 規則接不住時的正確行為是**反問**，不是猜。猜錯會跑錯 pipeline，
//     那是不可逆的（會建分支、跑 agent、燒 runner）；反問只是多一次往返。
//
//  ⚠️ 這支必須是**純函式**：不打網路、不寫 ScriptProperties。
//     單號反查與 miss 記錄都由路由層負責（見 core/intent.js 的說明）。
//     以前這兩件事寫在分類器裡，導致「換一個分類器」實際上要連副作用一起複製。
// ═══════════════════════════════════════════════════════════════════

// 反查失敗時給出可行動的下一步。實務上幾乎都是 scope 沒補、或補了沒重新安裝 App。
const ROUTE_HINT = '請直接說單號（例：`@Alice VIPOP-12345 進度`），'
  + '或確認 Alice 有 `channels:history` 權限（改過 scope 後要重新安裝 App 才生效）。';

// full 要排在 sa / ra 之前判斷：「ra 到 sa 一路跑完」同時命中三者
const RE_FULL   = /(full|整套|全部跑|從頭跑|一路跑|端到端|ra\s*(到|＋|\+|and|then)\s*sa)/i;
const RE_SA     = /(\bsa\b|系統分析|系統設計|架構分析|拆\s*task|工項拆解|design\s*doc)/i;
const RE_RA     = /(\bra\b|需求分析|規格書|寫規格|產規格|\bspec\b|補問)/i;
const RE_STATUS = /(狀態|進度|跑到哪|到哪了|做完了嗎|完成了嗎|\bstatus\b|\bprogress\b)/i;

// 只有「整句就是一個狀態查詢」才優先當 status。
// 這是為了不讓「用 A 方案，因為進度上比較快」被誤判——那句含「進度」但不是查詢。
//
// ⚠️ 這條 regex 寧鬆勿緊，因為兩個方向的失敗代價不對稱：
//   認錯成 status → 使用者看到狀態摘要，再說一次就好（無副作用）
//   漏認成答覆   → 在決策 thread 裡問「跑到哪了」會被 dispatch 出去當成答覆
// 所以前綴與尾綴都允許組合（「這張單現在跑到哪了？」）。
// 前綴後面允許「的」：「這張單的進度」「它現在的狀態」都是很自然的問法，
// 而漏認的代價是把問句 dispatch 成答覆。
const RE_PURE_STATUS =
  /^((?:現在|目前|這張單|這單|這個單|它|他)\s*(?:的)?\s*){0,3}(狀態|進度|跑到哪|到哪|怎麼樣|怎樣|如何|status|progress)\s*((?:了|嗎|呢|如何|怎樣|怎麼樣|喔|吧|哦)\s*){0,2}[?？!！]*$/i;

// 「整句就是在問額度」。與 RE_PURE_STATUS 同一個立場：只認整句，不認句中出現。
//
// ⚠️ 一定要**整句**匹配。「額度」是個會出現在正常討論裡的詞（「額度快用完了，
//    這張單先別跑」在決策 thread 裡是答覆，不是查詢）。認錯成查詢只是白跑一個
//    幾秒的 job，但漏認成答覆會把一句閒聊寫進某一題的答案——兩個方向的代價不對稱，
//    所以這條寧緊勿鬆（`RE_PURE_STATUS` 的取捨方向剛好相反，因為那邊反過來）。
const RE_PURE_USAGE =
  /^(claude\s*)?(的)?\s*(額度|用量|扣打|殘量|quota|usage)\s*((?:還剩多少|剩多少|還有多少|多少|如何|怎樣|怎麼樣|了|嗎|呢)\s*){0,2}[?？!！]*$/i;


const RulesClassifier = {
  name: 'rules',

  /**
   * ctx = {
   *   raw,            // 已去 mention、已全形轉半形、已 trim
   *   jiraInText,     // 句子裡自帶的單號（路由層撈好）
   *   route,          // thread 反查結果 { kind, j, ask, err } 或 null（路由層做好）
   *   askThread,      // 這一串是不是 ask 串（route.kind === 'ask'）
   *   getPending      // thunk：回 progress.json 的待答題清單。規則層不呼叫，
   *                   //        LLM 層才需要——它背後是一次網路呼叫，不該為了
   *                   //        統一介面就每次都付那個成本
   * }
   *
   * 回傳見 core/intent.js 的意圖契約說明。
   */
  classify: function (ctx) {
    const raw = (ctx && ctx.raw) || '';
    if (!raw) {
      return _intent_({ action: 'empty', confidence: 'high', matchedBy: 'empty' });
    }

    const jiraInText = (ctx && ctx.jiraInText) || '';
    const route = ctx && ctx.route;
    // 反查失敗（讀不到 thread 第一則訊息）與「這個 thread 本來就沒有任務」是兩件
    // 完全不同的事，但都會讓 route 沒有單號。分開才給得出可行動的訊息。
    const routeFailed = !!(route && route.err);
    const routeJira = (route && route.j) ? route.j : '';

    // ── 規則 0：這一串是 ask 串 → 任何一句都是追問 ─────────────────
    //
    // 排在**所有**規則之前，因為 thread 的歸屬是比句子語意更強的事實
    // （與規則 3 同一個立場：看狀態而不是看語意）。實戰踩到的形狀：在 ask 串
    // 底下打「再試一次」，被判成「回答某一題」，然後回一句「請改成明確指定
    // 題號 Q-001」——人只是要它重跑一次。
    //
    // ask 串裡不可能有待決問題（那條路不建分支、不跑 phase-guard），所以這裡
    // 不必再讓後面的規則有機會插手：查狀態看板就在同一串上面，貼補問清單貼錯
    // 串本來就該被擋。
    //
    // ⚠️ 這是唯一一條會**自動燒掉一台 runner** 的規則（其餘 unknown 都只反問）。
    //    可以這樣做是因為門檻早就在別的地方付過了：開出這一串的第一句要通關
    //    密語，而追問仍然吃同一份 60 秒節流與 2000 字上限。代價是「在 ask 串裡
    //    打一句『謝謝』也會觸發一次查詢」——節流擋得住連發，而那一串本來就是
    //    為了問問題才存在的，所以這個誤觸換到的是「追問不必記語法」。
    if (ctx && ctx.askThread) {
      return _intent_({
        action: 'ask_followup',
        answerText: raw,
        confidence: 'high',
        matchedBy: 'ask-thread'
      });
    }

    // ── 規則 1：整份補問清單貼上 ──────────────────────────────────
    //
    // 必須排在**所有**規則之前，而且這條是實測換來的，不是設計時想到的：
    //
    // checkList 按「複製」吐出來的第一行是 `## VIPOP-46703 PO 補問回覆`。
    // 那行同時做了兩件壞事——
    //   1. 帶了單號 → 規則 3 的 `!jiraInText` 守衛失效（它以為你要開新任務）
    //   2. 含「補問」→ 命中 RE_RA
    // 於是「PM 貼上七題答案」會被判成 run_ra，**整條 RA pipeline 重跑一次**。
    // 那是不可逆的：建分支、跑 agent、燒 runner，而答案一題都沒進去。
    //
    // 判準是「多行 ＋ 至少一行是行首題號樣式」。單行不算，所以一般對話完全
    // 不受影響；而任何一份複製結果都必然同時滿足這兩個條件。
    const pastedQids = (raw.indexOf('\n') >= 0) ? _scanQidLines_(raw) : [];
    if (pastedQids.length >= 1) {
      // 目標單號：thread 優先——thread 是路由的權威來源（見 decision.js 開頭）。
      // 沒有 thread 時退回貼上內容自帶的單號，那讓「貼到頻道而不是 thread 裡」
      // 也能運作，而所有下游保護（pipeline 讀 progress.json、去重、閘門）不變。
      const target = routeJira || jiraInText;
      if (!target) {
        return _intent_({
          action: 'unknown', confidence: 'low', matchedBy: 'batch-no-jira',
          restate: '這看起來是補問清單的回覆，但我認不出是哪張單。' +
                   '請貼在決策卡片的 thread 裡，或確認貼上的內容含有單號。'
        });
      }
      // 貼錯 thread 是會靜默寫錯單的：VIPOP-1 的答案寫進 VIPOP-2。
      // 兩邊都有單號而且不一致時一律拒收，不替他選一個。
      if (routeJira && jiraInText && routeJira !== jiraInText) {
        return _intent_({
          action: 'unknown', jiraId: routeJira, confidence: 'low', matchedBy: 'batch-jira-mismatch',
          restate: `你貼的是 ${jiraInText} 的補問回覆，但這個 thread 是 ${routeJira} 的。` +
                   '請貼到對應的 thread，我不替你猜要寫哪一張。'
        });
      }
      return _intent_({
        action: 'answer_question',
        jiraId: target,
        answerText: raw,
        confidence: 'high',
        matchedBy: 'pasted-checklist'
      });
    }

    // ── 規則 1.5：整句就是問額度 ──────────────────────────────────
    //
    // 排在規則 3 之前的理由與規則 2 一模一樣：在決策 thread 裡問「額度？」
    // 會被 `thread-has-pending` 當成答覆 dispatch 出去。
    //
    // 與其他規則不同的是它**完全不需要單號**——額度是 runner 的屬性，跟任何
    // JIRA 單無關。所以它也不吃 routeJira，貼在哪裡問都成立。
    if (RE_PURE_USAGE.test(raw)) {
      return _intent_({
        action: 'usage',
        confidence: 'high',
        matchedBy: 'pure-usage'
      });
    }

    // ── 規則 2：整句就是狀態查詢 ──────────────────────────────────
    // 排在答覆之前，否則在決策 thread 裡問「進度？」會被當成答覆送出去。
    if (RE_PURE_STATUS.test(raw)) {
      const jira = jiraInText || routeJira;
      return _intent_({
        action: jira ? 'status' : 'unknown',
        jiraId: jira,
        confidence: jira ? 'high' : 'low',
        matchedBy: routeFailed ? 'pure-status-route-failed' : 'pure-status',
        restate: jira ? '' : (routeFailed
          ? '我讀不到這個 thread 的第一則訊息，所以不知道這是哪張單。' + ROUTE_HINT
          : '你想查哪張單的狀態？')
      });
    }

    // ── 規則 3：thread 有待決問題 → 這句話極可能是答覆 ─────────────
    // 這是準確率最高的一條，因為它看的是**狀態**而不是語意：
    // 「用 A 方案」在決策 thread 裡是答覆，在空頻道裡毫無意義。
    // 句子自帶單號時不套用——那更像是要開新任務。
    if (routeJira && !jiraInText) {
      return _intent_({
        action: 'answer_question',
        jiraId: routeJira,
        answerText: raw,
        confidence: 'high',
        matchedBy: 'thread-has-pending'
        // items 維持 null：規則層不解析答案，交給下游的 _parseAnswerText_。
        // LLM 版可以在這裡一次填好（它手上已經有句子與待答題清單），
        // 那時 routeByIntent 一行都不用改。
      });
    }

    // ── 規則 4：有單號 + 動作關鍵字 ───────────────────────────────
    if (jiraInText) {
      if (RE_FULL.test(raw)) {
        return _intent_({ action: 'run_full', jiraId: jiraInText, confidence: 'high', matchedBy: 'jira+full' });
      }
      if (RE_SA.test(raw)) {
        return _intent_({ action: 'run_sa', jiraId: jiraInText, confidence: 'high', matchedBy: 'jira+sa' });
      }
      if (RE_RA.test(raw)) {
        return _intent_({ action: 'run_ra', jiraId: jiraInText, confidence: 'high', matchedBy: 'jira+ra' });
      }
      if (RE_STATUS.test(raw)) {
        return _intent_({ action: 'status', jiraId: jiraInText, confidence: 'high', matchedBy: 'jira+status' });
      }

      // 有單號但沒說要做什麼 → 反問，不要猜
      return _intent_({
        action: 'unknown',
        jiraId: jiraInText,
        confidence: 'low',
        matchedBy: 'jira-no-verb',
        restate: `你想對 ${jiraInText} 做什麼？（需求分析 / 系統分析 / 查狀態）`
      });
    }

    // ── 規則 5：有動詞但沒單號 → 反問缺的那一半 ────────────────────
    //
    // 這是規則 4 的對稱分支，以前缺了。`@Alice 幫我RA流程` 其實**命中**
    // RE_RA（中文字是非 \w，所以 RA 前後都有 word boundary），但因為沒有
    // 這一段，它會一路掉到 no-match、回一則通用求助訊息——看起來像「意圖
    // 分類接不住自然語言」，實際上只是規則缺一半。
    //
    // 補這五行的價值在於：它證明了「接不住」不等於「需要 LLM」。
    // 先把規則補完，再看語料決定要不要接模型。
    if (RE_FULL.test(raw) || RE_SA.test(raw) || RE_RA.test(raw)) {
      const what = RE_FULL.test(raw) ? '跑整套流程（RA → SA）'
                 : RE_SA.test(raw)   ? '做系統分析'
                 : '做需求分析';
      return _intent_({
        action: 'unknown',
        confidence: 'low',
        matchedBy: 'verb-no-jira',
        restate: `你想對哪張單${what}？（例：\`@Alice VIPOP-12345 ${RE_SA.test(raw) && !RE_FULL.test(raw) ? '做系統分析' : '寫規格書'}\`）`
      });
    }

    // ── 沒接住 ───────────────────────────────────────────────────
    // 在 thread 內卻反查不到單號時，這是最常見的真正原因，直接講出來而不是說「沒把握」
    if (routeFailed) {
      return _intent_({
        action: 'unknown',
        confidence: 'low',
        matchedBy: 'route-failed',
        restate: '我讀不到這個 thread 的第一則訊息，所以不知道這是哪張單。' + ROUTE_HINT
      });
    }
    return _intent_({ action: 'unknown', confidence: 'low', matchedBy: 'no-match' });
  }
};


/**
 * 意圖契約的唯一建構點。
 *
 * 集中在這裡是為了保證每個分支回傳的形狀完全一致——欄位漏填時，下游拿到的是
 * undefined 而不是 null，而 `intent.items` 是 undefined 還是 null 會走到不同
 * 的分支。分類器有九個 return，靠人肉對齊遲早會漏。
 */
function _intent_(o) {
  return {
    action:     o.action,
    jiraId:     o.jiraId || '',
    answerText: o.answerText || '',
    items:      (o.items === undefined) ? null : o.items,
    confidence: o.confidence || 'low',
    matchedBy:  o.matchedBy || '',
    restate:    o.restate || ''
  };
}
