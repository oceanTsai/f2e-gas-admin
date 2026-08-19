#!/usr/bin/env node
/**
 * 本機試打意圖分類——不需要部署、不需要憑證、不會碰到任何真的 API。
 *
 *   node test/try-intent.js "幫 VIPOP-12345 寫規格書"
 *   node test/try-intent.js --thread VIPOP-46703 "用 A 方案"    # 模擬在決策 thread 內
 *   node test/try-intent.js --suite                              # 跑一份對照表
 *   node test/try-intent.js                                      # 互動模式
 *
 * --thread 是關鍵：同一句話在「有待決問題的 thread 裡」和「空頻道裡」的分類
 * 完全不同，因為規則看的是狀態而不是語意。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const argv = process.argv.slice(2);
let threadJira = null;
const flags = [];
const words = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--thread') { threadJira = argv[++i]; }
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
  Utilities: { formatDate: () => '12:00:00' },
  UrlFetchApp: { fetch: () => { throw new Error('試打模式不該打網路'); } },
});

const code = ['slackBotProxy/core/github.js', 'slackBotProxy/core/decision.js', 'slackBotProxy/core/intent.js']
  .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join(String.fromCharCode(10));

// classifyIntent 是 eval scope 內的函式，用一個 getter 把它撈出來
const classify = eval(code + String.fromCharCode(10) + '(function (t, c, p) { return classifyIntent(t, c, p); })');

const provider = {
  name: 'slack',
  // 模擬 thread 的第一則訊息。真實情況是進度看板、受理訊息或決策卡片的 summary。
  // --thread-fail 模擬 conversations.replies 失敗（缺 channels:history）。
  fetchThreadRoot: () => {
    if (flags.includes('--thread-fail')) return null;
    return threadJira ? 'VIPOP-46789 ra-pipeline（1/2）' : '';
  },
  postMessage: () => ({}),
};

const ACTION_EFFECT = {
  empty:           '回一句「請一併給出答覆內容」',
  answer_question: '→ handleTextAnswer（會再查 progress.json 確認真的有待答的題）',
  run_ra:          '→ 觸發 ra-pipeline（RA 兩階）',
  run_sa:          '→ 觸發 sa-pipeline（SA 五階）',
  run_full:        '→ 觸發 full-pipeline（RA+SA 七階）',
  status:          '→ 讀 progress.json 回報狀態摘要',
  unknown:         '→ 反問，不執行任何動作',
  route_failed:    '→ 反問並點出可能是缺 channels:history',
};

function show(text) {
  cache.clear();                                  // 每次都重新反查，避免上一句的 route 快取影響
  const conv = threadJira
    ? { provider: 'slack', channel: 'C_TEST', thread: '1700.1' }
    : { provider: 'slack', channel: 'C_TEST', thread: null };
  const r = classify(text, conv, provider);
  const where = threadJira ? ('決策 thread 內（' + threadJira + '）') : '一般頻道';
  console.log('  輸入   ' + JSON.stringify(text) + '   [' + where + ']');
  console.log('  分類   ' + r.action + (r.jiraId ? '  單號=' + r.jiraId : '') +
              '   信心=' + r.confidence + '   命中=' + r.matchedBy);
  console.log('  結果   ' + (ACTION_EFFECT[r.action] || '?'));
  if (r.restate) console.log('  反問   ' + r.restate);
  if (r.answerText && r.answerText !== text) console.log('  答覆內容 ' + JSON.stringify(r.answerText));
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
  ];

  for (const [title, thread, inputs] of SUITE) {
    console.log('═══ ' + title + ' ═══');
    threadJira = thread;
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
console.log('意圖分類試打（Ctrl+C 離開）');
console.log('目前情境：' + (threadJira ? '決策 thread 內（' + threadJira + '）' : '一般頻道'));
console.log('輸入 :thread VIPOP-46703 切換情境，:thread off 切回一般頻道');
console.log();
rl.setPrompt('> ');
rl.prompt();
rl.on('line', (line) => {
  const t = line.trim();
  if (t.startsWith(':thread')) {
    const v = t.split(/\s+/)[1];
    threadJira = (!v || v === 'off') ? null : v.toUpperCase();
    console.log('情境改為：' + (threadJira ? '決策 thread 內（' + threadJira + '）' : '一般頻道'));
    console.log();
  } else if (t) {
    show(t);
  }
  rl.prompt();
});
