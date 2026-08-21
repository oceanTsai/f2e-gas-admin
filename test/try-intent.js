#!/usr/bin/env node
/**
 * 本機試打意圖分類——不需要部署、不需要憑證、不會碰到任何真的 API。
 *
 *   node test/try-intent.js "幫 VIPOP-12345 寫規格書"
 *   node test/try-intent.js --thread VIPOP-46703 "用 A 方案"    # 模擬在決策 thread 內
 *   node test/try-intent.js --ask U1-20260820-132620 "再試一次"  # 模擬在 ask 串內
 *   node test/try-intent.js --suite                              # 跑一份對照表
 *   node test/try-intent.js --classifier=llm "…"                 # 換分類器（尚未實作，會拋錯）
 *   node test/try-intent.js                                      # 互動模式
 *
 * --thread 是關鍵：同一句話在「有待決問題的 thread 裡」和「空頻道裡」的分類
 * 完全不同，因為規則看的是狀態而不是語意。
 *
 * --ask 是同一件事的另一半：「再試一次」在 ask 串裡是追問、在決策 thread 裡是
 * 答覆、在空頻道裡什麼都不是。三種情境的分類結果完全不同，而它們的差別**只**
 * 來自 thread 反查——所以要在本機看得出來，就必須連 thread 的形狀一起模擬。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
let uuidSeq = 0;   // Utilities.getUuid 的可預期替身（測試要能對照快取鍵）

const argv = process.argv.slice(2);
let threadJira = null;
let askThreadId = null;   // 有值＝這個 thread 是 ask 串（值就是提問編號＝分支名後半段）
let classifierName = null;
const flags = [];
const words = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--thread') { threadJira = argv[++i]; }
  else if (argv[i] === '--ask') { askThreadId = argv[++i]; }
  else if (argv[i].startsWith('--classifier=')) { classifierName = argv[i].split('=')[1]; }
  else if (argv[i].startsWith('--')) { flags.push(argv[i]); }
  else { words.push(argv[i]); }
}

// ── mock GAS 服務 ──────────────────────────────────────────────────
const props = new Map(), cache = new Map();
Object.assign(global, {
  PropertiesService: { getScriptProperties: () => ({
    getProperty: k => (props.has(k) ? props.get(k) : null),
    setProperty: (k, v) => props.set(k, String(v)),
    deleteProperty: k => props.delete(k),
    getKeys: () => [...props.keys()],
  })},
  CacheService: { getScriptCache: () => ({
    get: k => (cache.has(k) ? cache.get(k) : null),
    put: (k, v) => cache.set(k, String(v)),
    remove: k => cache.delete(k),
  })},
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  ContentService: { createTextOutput: t => ({ _t: t, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
  Utilities: { formatDate: () => '12:00:00', getUuid: () => 'uuid-' + (uuidSeq++) },
  UrlFetchApp: { fetch: () => { throw new Error('試打模式不該打網路'); } },
});

if (classifierName) props.set('INTENT_CLASSIFIER', classifierName);

// 載入順序要與 GAS 上一致：分類器工廠與規則層是分開的檔案。
const code = [
  'slackBotProxy/core/text.js',
  'slackBotProxy/core/conv.js',
  'slackBotProxy/core/github.js',
  'slackBotProxy/core/decision.js',
  'slackBotProxy/core/answer.js',
  'slackBotProxy/core/ask.js',
  'slackBotProxy/core/classifiers/rules.js',
  'slackBotProxy/core/classifiers/index.js',
  'slackBotProxy/core/intent.js',
].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join(String.fromCharCode(10));

// 撈出 eval scope 內的函式。刻意走 getClassifier() 而不是直接叫具體實作——
// 這支就是用來比較 rules 與 llm 差異的，寫死實作等於失去它的用途。
const api = eval(code + String.fromCharCode(10) +
  '({ classify: function (t, c, p) { return classifyIntent(t, c, p); },' +
  '   parse: function (raw, pending) { return _parseAnswerText_(raw, pending); },' +
  '   which: function () { return getClassifier().name; } })');
const classify = api.classify;

const H = t => ({ text: t, bot: false });   // 人打的
const B = t => ({ text: t, bot: true });    // Alice 自己發的

const provider = {
  name: 'slack',
  // 模擬整串訊息（由舊到新，帶 bot 旗標）。要整串而不只是第一則：ask 串是靠
  // Alice 自己的看板標題認出來的，而 Alice 現在回在觸發訊息底下，所以第一則
  // 永遠是人打的那句話。
  // --thread-fail 模擬 conversations.replies 失敗（缺 channels:history）。
  fetchThreadTexts: () => {
    if (flags.includes('--thread-fail')) return null;
    if (askThreadId) {
      // 真實形狀：人那句提問是第一則，看板是它的回覆（messageDispatch 組的標題）
      return [H('<@U_ALICE> ask 幫我查登入流程怎麼寫的'),
              B('\u{1F680} *' + askThreadId + '*\u3000`ask`\u3000(1/1)')];
    }
    // 要用 --thread 給的單號，不能寫死：規則 1 會比對「貼上內容的單號」與
    // 「thread 的單號」，寫死的話每次都看起來像貼錯 thread。
    return threadJira ? [H(threadJira + ' ra-pipeline（1/2）')] : [];
  },
  postMessage: () => ({}),
  // 這支工具只跑 classifyIntent、不派發，所以這兩個永遠不會被呼叫到。
  // 放著是為了讓 mock 與真的 provider 介面對齊——哪天這裡改成走 routeByIntent，
  // 缺了它們的症狀是 TypeError，而那會看起來像分類器壞了。
  mention: (id) => (id ? '<@' + id + '>' : ''),
  postIntentHelp: () => ({}),
};

const ACTION_EFFECT = {
  empty:           '回一句「請一併給出答覆內容」',
  answer_question: '→ handleTextAnswer（會再查 progress.json 確認真的有待答的題）',
  ask_followup:    '→ handleAskRequest（接續同一支 ask/<id> 分支，會燒一台 runner）',
  run_ra:          '→ 觸發 ra-pipeline（RA 兩階）',
  run_sa:          '→ 觸發 sa-pipeline（SA 五階）',
  run_full:        '→ 觸發 full-pipeline（RA+SA 七階）',
  status:          '→ 讀 progress.json 回報狀態摘要',
  unknown:         '→ 反問，不執行任何動作',
  route_failed:    '→ 反問並點出可能是缺 channels:history',
};

// 模擬 progress.json 的待答題。答案解析看得到它才判斷得出歧義——
// 「第一題」在只剩一題時沒有歧義，剩兩題以上就必須反問。
const PENDING = [
  { id: 'Q-001', question: '要調整哪個 repo 的 env？' },
  { id: 'Q-002', question: 'copilot 網址要換成什麼？' },
];

const PARSE_EFFECT = {
  batch:    '→ dispatchResumeBatch（整串轉送，由 augma 拆解）',
  single:   '→ dispatchResume（單題，所有既有保護都在）',
  unparsed: '→ 反問並列出待答清單，不 dispatch（猜錯會寫到別題上）',
};

function show(text) {
  cache.clear();                                  // 每次都重新反查，避免上一句的 route 快取影響
  const inThread = !!(threadJira || askThreadId);
  const conv = inThread
    ? { provider: 'slack', channel: 'C_TEST', thread: '1700.1' }
    : { provider: 'slack', channel: 'C_TEST', thread: null };
  const r = classify(text, conv, provider);
  const where = askThreadId ? ('ask 串內（' + askThreadId + '）')
              : threadJira  ? ('決策 thread 內（' + threadJira + '）')
              : '一般頻道';
  console.log('  輸入   ' + JSON.stringify(text) + '   [' + where + ']');
  console.log('  分類   ' + r.action + (r.jiraId ? '  單號=' + r.jiraId : '') +
              '   信心=' + r.confidence + '   命中=' + r.matchedBy +
              '   (' + api.which() + ')');
  console.log('  結果   ' + (ACTION_EFFECT[r.action] || '?'));
  if (r.restate) console.log('  反問   ' + r.restate);

  // 意圖對了不代表答案解析對了——這兩層的失敗長相完全不同：
  //   意圖分類錯 → 走錯 handler
  //   答案解析錯 → 走對 handler 但答錯題
  // 所以 answer_question 一定要把下一層也印出來，否則看不出真正的問題在哪。
  if (r.action === 'answer_question') {
    const p = api.parse(r.answerText, PENDING);
    console.log('  解析   ' + p.mode + '   信心=' + p.confidence +
                (p.reason ? '   原因=' + p.reason : ''));
    p.items.forEach(function (it) {
      console.log('         ' + (it.qid || '(挑第一個未答的題)') + ' ← ' + JSON.stringify(it.answerText));
    });
    if (p.ignoredAssumptions.length) {
      console.log('  已忽略 AI 假設 ' + p.ignoredAssumptions.join(', '));
    }
    console.log('  下一步 ' + (PARSE_EFFECT[p.mode] || '?'));
  }
  console.log();
}

// ── --suite：一份涵蓋所有分支的對照表 ──────────────────────────────
if (flags.includes('--suite')) {
  const SUITE = [
    ['一般頻道：開新任務', null, [
      '幫 VIPOP-12345 寫規格書',
      'VIPOP-12345 需求分析',
      'VIPOP-12345 做系統分析',
      'VIPOP-12345 拆 task',
      'VIPOP-12345 整套跑',
      'VIPOP-12345 ra 到 sa 一路跑完',
    ]],
    ['一般頻道：查狀態', null, [
      'VIPOP-12345 進度',
      'VIPOP-12345 現在跑到哪了',
      '進度？',
    ]],
    ['一般頻道：規則接不住 → 反問', null, [
      'VIPOP-12345',
      '幫我看一下那張單',
      '今天天氣真好',
    ]],
    ['決策 thread 內：回答', 'VIPOP-46703', [
      '用 A 方案',
      'A',
      '不行，改用 B，因為跨行清算那段要保留',
      '用 A 方案，因為進度上比較快',
    ]],
    ['決策 thread 內：查狀態（不該被當成答覆）', 'VIPOP-46703', [
      '跑到哪了',
      '進度如何',
      '這張單現在跑到哪了？',
    ]],
    ['決策 thread 內：自帶單號 → 視為新任務', 'VIPOP-46703', [
      '幫 VIPOP-99999 寫規格書',
    ]],
    ['一般頻道：有動詞但沒單號 → 反問缺的那一半（不需要 LLM）', null, [
      '幫我RA流程',
      '幫我看一下系統分析',
      '這個要整套跑',
    ]],
    ['決策 thread 內：整份 checkList 貼上 → 批次', 'VIPOP-46703', [
      ['## VIPOP-46703 PO 補問回覆',
       '',
       '- **Q-001**: A. recruitment',
       '- **Q-002**: B. 改用新網址 https://example.com',
       '',
       '> \u26a0\ufe0f 尚未回答:Q-003',
       '',
       '### AI 假設(勾選 = 同意)',
       '- A-001: \u2713 同意'].join(String.fromCharCode(10)),
    ]],
    ['決策 thread 內：指了某一題但沒題號 → 不猜', 'VIPOP-46703', [
      '第一題選Ａ',
      '1. B  2. C',
    ]],
    // 同一批句子在兩種 thread 裡的分類必須不同——這一節與上面那幾節是對照組。
    // 「再試一次」在 ask 串裡是追問；在決策 thread 裡是答覆（會 dispatch 出去）。
    ['ask 串內：任何一句都是追問（含「進度？」——看板就在同一串上面）',
     { ask: 'U0BP6PJQGKB-20260820-132620' }, [
      '再試一次',
      '那第二點再展開一下',
      '進度？',
    ]],
  ];

  for (const [title, where, inputs] of SUITE) {
    console.log('═══ ' + title + ' ═══');
    threadJira  = (where && where.ask) ? null : where;
    askThreadId = (where && where.ask) ? where.ask : null;
    inputs.forEach(show);
  }
  process.exit(0);
}

// ── 單句模式 ───────────────────────────────────────────────────────
if (words.length) {
  show(words.join(' '));
  process.exit(0);
}

// ── 互動模式 ───────────────────────────────────────────────────────
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const whereLabel = () => askThreadId ? ('ask 串內（' + askThreadId + '）')
                     : threadJira ? ('決策 thread 內（' + threadJira + '）')
                     : '一般頻道';
console.log('意圖分類試打（Ctrl+C 離開）  分類器=' + api.which());
console.log('目前情境：' + whereLabel());
console.log('輸入 :thread VIPOP-46703 切換到決策 thread，:ask U1-20260820-132620 切換到 ask 串');
console.log('     :thread off / :ask off 切回一般頻道');
console.log();
rl.setPrompt('> ');
rl.prompt();
rl.on('line', (line) => {
  const t = line.trim();
  if (t.startsWith(':thread')) {
    const v = t.split(/\s+/)[1];
    threadJira = (!v || v === 'off') ? null : v.toUpperCase();
    if (threadJira) askThreadId = null;   // 一個 thread 只能是其中一種
    console.log('情境改為：' + whereLabel());
    console.log();
  } else if (t.startsWith(':ask')) {
    const v = t.split(/\s+/)[1];
    askThreadId = (!v || v === 'off') ? null : v;
    if (askThreadId) threadJira = null;
    console.log('情境改為：' + whereLabel());
    console.log();
  } else if (t) {
    show(t);
  }
  rl.prompt();
});
