#!/usr/bin/env node
/**
 * GAS 專案回歸測試（本機跑，不需要 GAS 或任何憑證）
 *
 *   node test/gas-regression.js
 *
 * 為什麼需要它：GAS 沒有本機執行環境，所有邏輯錯誤都要部署上去、在 Slack 裡
 * 手動觸發才會發現。這支測試把 GAS 的服務（PropertiesService / CacheService /
 * UrlFetchApp…）換成 in-memory 假物件，讓純邏輯可以在本機驗證。
 *
 * 它已經抓到過真 bug：入向／出向拆分時，handleTextAnswer 的成功訊息殘留了
 * 三處已經不存在的 ctx.question_id——那條路徑只有「成功 dispatch」時才會走到，
 * 純函式測試看不出來。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

function mkEnv(seedProps) {
  const props = new Map(Object.entries(seedProps || {}));
  const cache = new Map();
  return {
    props, cache,
    globals: {
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
      ContentService: {
        createTextOutput: t => ({ _t: t, setMimeType() { return this; } }),
        MimeType: { JSON: 'json' },
      },
      Utilities: { formatDate: () => '12:00:00' },
      UrlFetchApp: { fetch: () => { throw new Error('測試不該打真的網路'); } },
      console: console,
    }
  };
}

function src(files) {
  return files.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
}

// 入向那一側的完整載入順序。分類器工廠與規則層是分開的檔案，少載一個的症狀是
// 「getClassifier is not defined」——與 GAS 上少推一個檔完全一樣。
const INTENT_SRC = [
  'slackBotProxy/core/text.js',
  'slackBotProxy/core/github.js',
  'slackBotProxy/core/decision.js',
  'slackBotProxy/core/answer.js',
  'slackBotProxy/core/classifiers/rules.js',
  'slackBotProxy/core/classifiers/index.js',
  'slackBotProxy/core/intent.js',
];


// ══════════════════════════════════════════════════════════════════
console.log();
console.log('[0] GAS 全域 scope — 專案內所有檔案能否共存');
// GAS 沒有 import：一個專案的所有檔案共享同一個全域 scope。重複的頂層宣告會在
// 載入時就拋 "Identifier has already been declared"，而那只有部署上去才看得到。
// 這一節把每個專案的檔案串起來解析，等同模擬那個環境。
// ══════════════════════════════════════════════════════════════════
{
  const vm = require('vm');
  const DECL = /^(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gm;
  // 只抓字面 key；getProperty(SOME_CONST) 這種動態形式靜態檢查不到，跳過
  const PROP_KEY = /(?:get|set|delete)Property\(\s*'([^']+)'/g;
  const ALLOWED_PROPS = [
    'SLACK_TOKEN',        // Slack Bot User OAuth Token（xoxb-）
    'GITHUB_TOKEN',       // repository_dispatch + 讀 progress.json
    'NOTIFY_KEY',         // runner → GAS 的共享金鑰
    'CHAT_PROVIDER',      // slack / googlechat
    'TEST_WEBHOOK_URL',   // 測試用固定頻道 webhook
    'last_route_fail',    // 供 diagnoseSlackAccess() 重打的失敗參數
    'intent_misses',      // 意圖規則未命中的語料
    'INTENT_CLASSIFIER'   // rules / llm（與 ANSWER_PARSER 分開，曝光面不同）
  ];
  const badProps = [];

  for (const proj of ['slackBotProxy', 'messageDispatch']) {
    const files = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(js|gs)$/.test(e.name)) files.push(full);
      }
    })(path.join(ROOT, proj));
    files.sort();

    const blob = files.map(f => fs.readFileSync(f, 'utf8')).join(String.fromCharCode(10));
    new vm.Script(blob, { filename: proj + ' (concatenated)' });   // 只解析，不執行

    const seen = {};
    let m;
    DECL.lastIndex = 0;
    while ((m = DECL.exec(blob)) !== null) seen[m[1]] = (seen[m[1]] || 0) + 1;
    const dup = Object.keys(seen).filter(k => seen[k] > 1);
    assert.strictEqual(dup.length, 0,
      proj + ' 有重複的頂層宣告（GAS 會拒絕載入）: ' + dup.join(', '));

    // Script Properties 的 key 必須在白名單裡。
    //
    // 這一條是實戰換來的：fetchThreadRoot 曾經讀 'SLACK_BOT_TOKEN'，而整個
    // codebase 其他地方都是 'SLACK_TOKEN'。getProperty 對不存在的 key 回 null
    // 而不是報錯，所以那段程式碼靜默失敗——症狀是「讀不到 thread 第一則訊息」，
    // 完全看不出是 key 打錯，還一路誤導到 Slack scope 上去查。
    //
    // 新增 property 時要同步更新這份清單，那個摩擦是刻意的。
    PROP_KEY.lastIndex = 0;
    while ((m = PROP_KEY.exec(blob)) !== null) {
      if (ALLOWED_PROPS.indexOf(m[1]) < 0) badProps.push(proj + ' → ' + m[1]);
    }

    ok(proj + '：' + files.length + ' 檔 / ' + Object.keys(seen).length + ' 個頂層宣告，無重複');
  }

  assert.strictEqual(badProps.length, 0,
    '出現不在白名單的 Script Properties key（是不是打錯了？）：' + badProps.join('、'));
  ok('Script Properties 的 key 全部在白名單內（' + ALLOWED_PROPS.length + ' 個）');
}


// ══════════════════════════════════════════════════════════════════
console.log('\n[1] slackBotProxy — progress.json 查詢輔助');
// ══════════════════════════════════════════════════════════════════
{
  const env = mkEnv();
  Object.assign(global, env.globals);

  const PROGRESS = {
    jira_key: 'VIPOP-46703',
    pipeline: 'ra-pipeline',
    pending_questions: [
      { id:'Q-001', phase:'ra-phase2', resume_action:'continue', answered:true,  answered_by:'<@U_A>' },
      { id:'Q-002', phase:'ra-phase2', resume_action:'continue', answered:false, answered_by:null },
      { id:'Q-003', phase:'ra-phase2', resume_action:'complete', answered:false, answered_by:null },
      { id:'Q-004', phase:'sa-phase3', resume_action:'continue', answered:false, answered_by:null },
    ],
  };

  eval(src(['slackBotProxy/core/github.js', 'slackBotProxy/core/decision.js']) + `
  assert.strictEqual(_findQuestion_(PROGRESS, 'Q-002').phase, 'ra-phase2');
  assert.strictEqual(_findQuestion_(PROGRESS, 'Q-999'), null);
  assert.strictEqual(_findQuestion_(null, 'Q-002'), null);
  ok('_findQuestion_（含 progress 為 null 的降級）');

  assert.notStrictEqual(_answerKey_('VIPOP-1','Q-001'), _answerKey_('VIPOP-2','Q-001'));
  ok('_answerKey_ 跨單不互撞（舊版 dctx_q_<qid> 是全域 key，會互相覆蓋）');

  let r = _alreadyAnswered_('VIPOP-46703','Q-001', _findQuestion_(PROGRESS,'Q-001'));
  assert.strictEqual(r.answered, true);
  assert.strictEqual(r.by, '<@U_A>');
  r = _alreadyAnswered_('VIPOP-46703','Q-002', _findQuestion_(PROGRESS,'Q-002'));
  assert.strictEqual(r.answered, false);
  CacheService.getScriptCache().put(_answerKey_('VIPOP-46703','Q-002'), '<@U_B>');
  r = _alreadyAnswered_('VIPOP-46703','Q-002', _findQuestion_(PROGRESS,'Q-002'));
  assert.strictEqual(r.answered, true);
  assert.strictEqual(r.by, '<@U_B>');
  CacheService.getScriptCache().remove(_answerKey_('VIPOP-46703','Q-002'));
  ok('_alreadyAnswered_ 兩層：cache 擋 in-flight、progress.answered 擋長期');

  let p = _phaseProgress_(PROGRESS, 'ra-phase2', 'VIPOP-46703');
  assert.strictEqual(p.total, 3);
  assert.strictEqual(p.remaining.length, 2);
  assert.strictEqual(_phaseProgress_(PROGRESS,'sa-phase3','VIPOP-46703').total, 1);
  ok('_phaseProgress_ 按 phase 隔離');

  const ctx = _cardProgress_('VIPOP-46703','Q-002', PROGRESS, 'ra-pipeline');
  assert.deepStrictEqual(ctx.question_ids, ['Q-001','Q-002','Q-003']);
  assert.strictEqual(ctx.phase, 'ra-phase2');
  assert.strictEqual(_cardProgress_('X-1','Q-002', null, 'ra-pipeline'), null);
  ok('_cardProgress_ 形狀與舊 ctx 相容（顯示邏輯不必改）');
  `);
}


// ══════════════════════════════════════════════════════════════════
console.log('\n[2] slackBotProxy — 意圖識別規則');
// ══════════════════════════════════════════════════════════════════
{
  const env = mkEnv();
  Object.assign(global, env.globals);
  let rootCalls = 0;
  const provider = {
    name: 'slack',
    fetchThreadRoot: () => { rootCalls++; return '\u{1F680} 收到 <@U1> 的任務請求，正在啟動 RA-PIPELINE (VIPOP-46703)...'; },
    postMessage: () => ({}),
  };
  const providerNoThread = { name:'slack', fetchThreadRoot: () => '', postMessage: () => ({}) };

  eval(src(INTENT_SRC) + `
  const IN  = { provider:'slack', channel:'C1', thread:'1700.1' };
  const OUT = { provider:'slack', channel:'C9', thread:null };
  const c  = (t) => classifyIntent(t, IN,  provider);
  const co = (t) => classifyIntent(t, OUT, providerNoThread);

  assert.strictEqual(c('').action, 'empty');
  ok('空字串');

  let r = c('進度？');
  assert.strictEqual(r.action, 'status');
  assert.strictEqual(r.jiraId, 'VIPOP-46703');
  r = co('狀態');
  assert.strictEqual(r.action, 'unknown');
  assert.ok(r.restate.length > 0);
  ok('純狀態查詢：能反查到單號才執行，否則反問');

  // regex 寧鬆勿緊：漏認的代價是「在決策 thread 裡把問句 dispatch 成答覆」
  ['跑到哪了','進度如何','這張單現在跑到哪了？','目前進度呢','進度怎樣','狀態如何？']
    .forEach(function (q) {
      assert.strictEqual(c(q).action, 'status', '應認出狀態查詢：' + q);
    });
  ['用 A 方案，因為進度上比較快','不行，改用 B','這個進度會影響 SA 嗎']
    .forEach(function (a) {
      assert.strictEqual(c(a).action, 'answer_question', '不該誤判成 status：' + a);
    });
  ok('狀態查詢寧鬆勿緊：自然問法都認得，含狀態詞的答覆不誤判');

  r = c('用 A 方案');
  assert.strictEqual(r.action, 'answer_question');
  assert.strictEqual(r.answerText, '用 A 方案');
  ok('thread 有待決問題 → 當成答覆');

  assert.strictEqual(c('用 A 方案，因為進度上比較快').action, 'answer_question');
  ok('含狀態詞但不是查詢 → 仍是答覆（不被 status 攔走）');

  r = c('幫 VIPOP-99999 寫規格書');
  assert.strictEqual(r.action, 'run_ra');
  assert.strictEqual(r.jiraId, 'VIPOP-99999');
  ok('thread 內但自帶單號 → 視為新任務');

  assert.strictEqual(co('幫 VIPOP-12345 寫規格書').action, 'run_ra');
  assert.strictEqual(co('VIPOP-12345 做系統分析').action, 'run_sa');
  assert.strictEqual(co('VIPOP-12345 拆 task').action, 'run_sa');
  assert.strictEqual(co('VIPOP-12345 整套跑').action, 'run_full');
  assert.strictEqual(co('VIPOP-12345 ra 到 sa 一路跑完').action, 'run_full');
  assert.strictEqual(co('VIPOP-12345 現在狀態如何').action, 'status');
  ok('單號 + 動作關鍵字（full 優先於 sa/ra）');

  r = co('VIPOP-12345');
  assert.strictEqual(r.action, 'unknown');
  assert.ok(r.restate.indexOf('VIPOP-12345') >= 0);
  ok('有單號但沒說要幹嘛 → 反問，不猜');

  // 規則 3 的對稱分支：有動詞但沒單號。以前缺這一段，'幫我RA流程' 會掉到
  // no-match 回通用求助訊息——看起來像「需要 LLM」，實際上只是規則缺一半。
  r = co('幫我RA流程');
  assert.strictEqual(r.matchedBy, 'verb-no-jira');
  assert.strictEqual(r.action, 'unknown');
  assert.ok(r.restate.indexOf('需求分析') >= 0, r.restate);
  assert.strictEqual(co('幫我看一下系統分析').matchedBy, 'verb-no-jira');
  assert.strictEqual(co('這個要整套跑').matchedBy, 'verb-no-jira');
  // full 要優先於 sa/ra，反問的說法也要跟著對
  assert.ok(co('這個要整套跑').restate.indexOf('整套') >= 0);
  ok('有動詞沒單號 → 反問缺的那一半（不是 no-match，也不需要 LLM）');

  // ⚠️ 迴歸：貼上整份 checkList 曾經被判成 run_ra，整條 pipeline 重跑一次。
  // 複製結果的第一行 '## VIPOP-46703 PO 補問回覆' 同時帶了單號（讓規則 2 的
  // !jiraInText 守衛失效）與「補問」二字（命中 RE_RA）。這是不可逆的誤判：
  // 建分支、跑 agent、燒 runner，而答案一題都沒進去。
  const PASTED = [
    '## VIPOP-46703 PO 補問回覆',
    '',
    '- **Q-001**: A. recruitment',
    '- **Q-002**: B. 改用新網址'
  ].join(String.fromCharCode(10));
  r = c(PASTED);
  assert.strictEqual(r.action, 'answer_question', '貼上補問回覆絕不能觸發 pipeline');
  assert.strictEqual(r.matchedBy, 'pasted-checklist');
  assert.strictEqual(r.jiraId, 'VIPOP-46703');
  ok('貼上整份 checkList → 答覆（曾經誤判成 run_ra 重跑整條 pipeline）');

  // 不在 thread 裡也認得出來：貼上內容自帶單號
  r = co(PASTED);
  assert.strictEqual(r.action, 'answer_question');
  assert.strictEqual(r.jiraId, 'VIPOP-46703');
  ok('貼到頻道而非 thread → 用貼上內容自帶的單號，仍認得出是答覆');

  // 貼錯 thread 會靜默寫錯單，一律拒收
  r = c(PASTED.replace('VIPOP-46703', 'VIPOP-99999'));
  assert.strictEqual(r.action, 'unknown');
  assert.strictEqual(r.matchedBy, 'batch-jira-mismatch');
  assert.ok(r.restate.indexOf('VIPOP-99999') >= 0 && r.restate.indexOf('VIPOP-46703') >= 0);
  ok('貼到別張單的 thread → 拒收（不替他猜要寫哪一張）');

  // 單行訊息不受規則 0 影響
  assert.strictEqual(c('VIPOP-99999 補問清單好了嗎').action, 'run_ra');
  ok('單行訊息不受規則 0 影響（只有多行 + 行首題號才算貼上）');

  // 在決策 thread 裡講同一句話仍然是答覆：規則 2 看的是狀態，排在動詞之前。
  // 這條要守住，否則 PM 在 thread 裡打「我覺得要重跑 RA」會變成開新任務。
  assert.strictEqual(c('幫我RA流程').action, 'answer_question');
  ok('thread 有待決問題時，動詞不搶走答覆（規則 2 優先）');

  // 分類器是純函式：只 classify 不該寫任何語料
  PropertiesService.getScriptProperties().deleteProperty('intent_misses');
  co('今天天氣真好');
  assert.strictEqual(PropertiesService.getScriptProperties().getProperty('intent_misses'), null,
    'classifyIntent 不該有副作用——記錄語料是路由層的職責');
  ok('classifyIntent 無副作用（換分類器時不必連副作用一起複製）');

  r = co('今天天氣真好');
  assert.strictEqual(r.matchedBy, 'no-match');
  routeByIntent('今天天氣真好', OUT, 'U1', providerNoThread);
  const misses = JSON.parse(PropertiesService.getScriptProperties().getProperty('intent_misses'));
  assert.ok(misses.some(m => m.s.indexOf('今天天氣') >= 0));
  ok('未命中 → 由路由層記錄語料（日後設計 LLM prompt 的素材）');

  // 反查失敗是基礎設施問題，不是「人這樣講話規則接不住」，不該洗版語料
  const failingProvider = { name:'slack', fetchThreadRoot: () => null, postMessage: () => ({}) };
  PropertiesService.getScriptProperties().deleteProperty('intent_misses');
  routeByIntent('隨便講', { provider:'slack', channel:'C1', thread:'7777.7' }, 'U1', failingProvider);
  assert.strictEqual(PropertiesService.getScriptProperties().getProperty('intent_misses'), null,
    'route-failed 不該進語料——那份語料唯一的用途是判斷要不要接模型');
  ok('反查失敗不汙染語料');

  const _log = console.log; console.log = function () {};   // 80 圈的分類日誌會洗版
  for (let i = 0; i < 80; i++) routeByIntent('隨機 ' + i, OUT, 'U1', providerNoThread);
  console.log = _log;
  const raw = PropertiesService.getScriptProperties().getProperty('intent_misses');
  assert.strictEqual(JSON.parse(raw).length, 60);
  assert.ok(raw.length < 9000, 'ScriptProperties 單筆上限 9 KB');
  ok('語料 ring buffer 上限 60 筆（' + raw.length + ' bytes）');

  // 工廠：未實作的分類器要明確拋錯，不能靜默退回 rules
  assert.strictEqual(getClassifier().name, 'rules');
  PropertiesService.getScriptProperties().setProperty('INTENT_CLASSIFIER', 'llm');
  assert.throws(() => getClassifier(), /尚未實作/);
  PropertiesService.getScriptProperties().setProperty('INTENT_CLASSIFIER', 'gemini');
  assert.throws(() => getClassifier(), /未知的 INTENT_CLASSIFIER/);
  PropertiesService.getScriptProperties().deleteProperty('INTENT_CLASSIFIER');
  ok('分類器工廠：預設 rules，未實作／未知一律拋錯（設定錯誤要當場知道）');

  assert.ok(_intentHelpText_('U1', { restate:'' }).split(String.fromCharCode(10)).length > 5);
  ok('help 文字可組出');
  `);
}


// ══════════════════════════════════════════════════════════════════
console.log('\n[3] slackBotProxy — thread 反查與 dispatch 安全性');
// ══════════════════════════════════════════════════════════════════
{
  const env = mkEnv();
  Object.assign(global, env.globals);
  const calls = [], posted = [];
  let progressStub = null;
  let rootCalls = 0;
  const provider = {
    name: 'slack',
    fetchThreadRoot: () => { rootCalls++; return '\u{1F680} 正在啟動 RA-PIPELINE (VIPOP-46703)...'; },
    postMessage: (ch, text) => { posted.push(text); return {}; },
  };

  eval(src(INTENT_SRC) + `
  // github.js 的 function declaration 會蓋掉外部 mock，所以在這個 scope 內覆寫
  fetchProgress = function () { return progressStub; };
  dispatchResume = function () {
    calls.push('dispatch:' + Array.prototype.slice.call(arguments, 0, 3).join(','));
    return true;
  };

  const IN = { provider:'slack', channel:'C1', thread:'1700.1' };

  let r = _resolveRouteFromThread_(IN, provider);
  assert.strictEqual(r.j, 'VIPOP-46703');
  assert.strictEqual(rootCalls, 1);
  _resolveRouteFromThread_(IN, provider);
  assert.strictEqual(rootCalls, 1, 'route 應命中 cache');
  ok('從 thread 第一則訊息反查單號 + cache（零跨專案狀態）');

  // 不在 thread 裡 → null（正常情況，不該打 API）
  const before = rootCalls;
  assert.strictEqual(_resolveRouteFromThread_({ channel:'C1', thread:null }, provider), null);
  assert.strictEqual(rootCalls, before, '沒有 thread_ts 時不該呼叫 Slack API');

  // API 失敗（缺 scope）→ 帶 err，讓上層給得出可行動的訊息
  const failing = { fetchThreadRoot: function () { return null; } };
  const rf = _resolveRouteFromThread_({ channel:'C1', thread:'9999.9' }, failing);
  assert.strictEqual(rf.j, '');
  assert.strictEqual(rf.err, 'fetch-failed');

  // 讀到了但第一則訊息沒有單號
  const noJira = { fetchThreadRoot: function () { return '大家早'; } };
  assert.strictEqual(_resolveRouteFromThread_({ channel:'C1', thread:'8888.8' }, noJira).err, 'no-jira-in-root');

  // 失敗參數要被記下來，diagnoseSlackAccess() 才能用同一組重打
  const rec = JSON.parse(PropertiesService.getScriptProperties().getProperty('last_route_fail'));
  assert.strictEqual(rec.ch, 'C1');
  assert.strictEqual(rec.ts, '8888.8');
  assert.strictEqual(rec.err, 'no-jira-in-root');
  assert.ok(rec.at, '要有時間戳');
  ok('反查失敗能區分原因，且記下參數供診斷函式重打');

  posted.length = 0; calls.length = 0;
  handleTextAnswer('用 A 方案', IN, 'U1', provider);
  assert.ok(posted.some(t => t.indexOf('明確指定題號') >= 0));
  assert.strictEqual(calls.length, 0);
  ok('progress 讀不到 → 不 dispatch');

  progressStub = { jira_key:'VIPOP-46703', pending_questions:[
    { id:'Q-001', phase:'ra-phase2', resume_action:'continue', answered:false }
  ]};
  posted.length = 0; calls.length = 0;
  handleTextAnswer('用 A 方案', IN, 'U1', provider);
  assert.ok(posted.some(t => t.indexOf('哪條 pipeline') >= 0));
  assert.strictEqual(calls.length, 0);
  ok('progress 缺 pipeline → 拒絕文字接續（猜錯是不可逆的）');

  progressStub.pipeline = 'ra-pipeline';
  posted.length = 0; calls.length = 0;
  handleTextAnswer('用 A 方案', IN, 'U1', provider);
  assert.ok(calls.some(c => c === 'dispatch:VIPOP-46703,ra-pipeline,Q-001'), calls.join('|'));
  assert.ok(posted.some(t => t.indexOf('已收下') >= 0));
  ok('pipeline 取自 progress.json，dispatch 參數正確');

  // 閘門型問題只能點按鈕
  progressStub.pending_questions[0].resume_action = 'complete';
  progressStub.pending_questions[0].answered = false;
  CacheService.getScriptCache().remove(_answerKey_('VIPOP-46703','Q-001'));
  posted.length = 0; calls.length = 0;
  handleTextAnswer('好', IN, 'U1', provider);
  assert.ok(posted.some(t => t.indexOf('放行閘門') >= 0));
  assert.strictEqual(calls.length, 0);
  ok('閘門型（complete）拒絕文字回覆，只收按鈕');
  `);
}


// ══════════════════════════════════════════════════════════════════
console.log('\n[3a] slackBotProxy — 純文字工具（答案正規化的地基）');
// 這一節全部是純函式：不需要 provider、不需要 progress、不需要網路。
// 那正是把它們獨立出來的理由——GAS 沒有本機執行環境，能這樣驗的只有純函式。
// ══════════════════════════════════════════════════════════════════
{
  const env = mkEnv();
  Object.assign(global, env.globals);

  eval(src(['slackBotProxy/core/text.js']) + `
  // 全形英數要轉，全形標點不能動——答案本文會原樣寫進 progress.json 再給人看
  assert.strictEqual(_toHalfWidth_('第一題選Ａ'), '第一題選A');
  assert.strictEqual(_toHalfWidth_('Ｑ－００１'), 'Q－001');   // 全形連字號是標點，留給 _normalizeQid_ 收
  assert.strictEqual(_toHalfWidth_('上限２０００字'), '上限2000字');
  assert.strictEqual(_toHalfWidth_('維持現狀（依規格）'), '維持現狀（依規格）');
  assert.strictEqual(_toHalfWidth_('a　b'), 'a b');
  ok('全形轉半形只碰英數與全形空白，標點原樣保留');

  ['Q3','q-3','Q-003','Q-0003','q003'].forEach(function (v) {
    assert.strictEqual(_normalizeQid_(v), 'Q-003', v);
  });
  assert.strictEqual(_normalizeQid_('Q-1000'), 'Q-1000', '四位以上不截斷');
  assert.strictEqual(_normalizeQid_('A-001'), null, 'AI 假設不是題號');
  assert.strictEqual(_normalizeQid_('Q-'), null);
  // 中文輸入法打出來的是全形連字號。_toHalfWidth_ 刻意不轉標點（會動到答案本文），
  // 所以要在這裡收——不收的話「Ｑ－００２ 用 A 方案」會整句變成別題的答案。
  assert.strictEqual(_normalizeQid_(_toHalfWidth_('Ｑ－００２')), 'Q-002');
  ok('_normalizeQid_ 與 augma 的 jq norm 同規則，並吃全形連字號');

  // checkList 按「複製」的真實形狀
  const PASTE = [
    '## VIPOP-45198 PO 補問回覆',
    '',
    '- **Q-001**: C. (未填)',
    '- **Q-002**: A. 已定案，後端回傳資格狀態 + 原因 code',
    '- **Q-005**: A. 上限 2000 字、trim 前後空白',
    '',
    '> \\u26a0\\ufe0f 尚未回答:Q-003, Q-004',
    '',
    '### AI 假設(勾選 = 同意)',
    '- A-001: \\u2713 同意',
    '- A-002: \\u2717 不同意'
  ].join('\\n');

  const scanned = _scanQidLines_(PASTE);
  assert.deepStrictEqual(scanned.map(x => x.qid), ['Q-001','Q-002','Q-005']);
  assert.strictEqual(scanned[0].answerText, 'C. (未填)');
  ok('行首樣式只吃真正的答案行（標題、AI 假設區塊都不誤拆）');

  // 這是整個拆解器最重要的一條：「尚未回答」那行含題號但語意完全相反。
  // 被誤拆成答案的話，明確標示未答的題會被寫成已答，然後 phase-guard 放行。
  assert.ok(scanned.every(x => x.qid !== 'Q-003' && x.qid !== 'Q-004'),
    '「尚未回答:Q-003, Q-004」那行絕不能被當成答案');
  ok('「> 尚未回答:Q-003, Q-004」不被誤拆（行首樣式存在的唯一理由）');

  assert.deepStrictEqual(_scanAssumptionIds_(PASTE), ['A-001','A-002']);
  ok('AI 假設編號撈得出來（要回報，不靜默丟掉）');

  // 同一題重複出現取最後一筆——PM 在同一則訊息裡改過的那個才是他要的
  assert.deepStrictEqual(
    _scanQidLines_('- **Q-001**: A. 舊的\\n- **Q-001**: B. 改成這個').map(x => x.answerText),
    ['B. 改成這個']);
  ok('同一題重複出現取最後一筆');

  // 中文一個字 3 bytes：用字元數估上限會低估三倍，是「怎麼會爆 64KB」的來源
  assert.strictEqual(_utf8Length_('abc'), 3);
  assert.strictEqual(_utf8Length_('中文'), 6);
  const long = ('第一行內容\\n').repeat(50);
  const cut = _truncateUtf8_(long, 100);
  assert.ok(cut.truncated);
  assert.ok(_utf8Length_(cut.text) <= 100);
  assert.ok(cut.text.indexOf('\\n') > 0 && cut.text.slice(-1) !== '第',
    '要切在行界上，不能把最後一題砍成半句話還被當成合法答案');
  assert.strictEqual(_truncateUtf8_('短', 100).truncated, false);
  ok('UTF-8 位元組截斷：按 byte 算、切在行界（' + cut.originalBytes + ' → ' + _utf8Length_(cut.text) + ' bytes）');
  `);
}


// ══════════════════════════════════════════════════════════════════
console.log('\n[3c] slackBotProxy — 答案解析：批次 / 單題 / 不猜');
// ══════════════════════════════════════════════════════════════════
{
  const env = mkEnv();
  Object.assign(global, env.globals);

  eval(src(['slackBotProxy/core/text.js','slackBotProxy/core/answer.js']) + `
  const TWO = [{ id:'Q-001', question:'甲' }, { id:'Q-002', question:'乙' }];
  const ONE = [{ id:'Q-001', question:'甲' }];

  const PASTE = [
    '## VIPOP-45198 PO 補問回覆',
    '',
    '- **Q-001**: C. (未填)',
    '- **Q-002**: A. 已定案',
    '',
    '> \\u26a0\\ufe0f 尚未回答:Q-003, Q-004'
  ].join('\\n');

  let r = _parseAnswerText_(PASTE, TWO);
  assert.strictEqual(r.mode, 'batch');
  assert.deepStrictEqual(r.items.map(x => x.qid), ['Q-001','Q-002']);
  assert.strictEqual(r.items[0].answerText, 'C. (未填)');
  ok('整份貼上 → batch，答案是「行內容」而不是整串');

  // 現行 bug 的直接對照：整串（含標題、含「尚未回答」）曾經被寫成第一題的答案
  assert.ok(r.items[0].answerText.indexOf('PO 補問回覆') < 0);
  assert.ok(r.items[0].answerText.indexOf('尚未回答') < 0);
  ok('標題與「尚未回答」不再被塞進答案本文（這正是現行的 bug）');

  // 只答一題就用複製功能：命中一行也要用行內容，不能整串塞給那一題
  r = _parseAnswerText_('## VIPOP-1 PO 補問回覆\\n\\n- **Q-002**: B. 就這個', TWO);
  assert.strictEqual(r.mode, 'single');
  assert.strictEqual(r.items[0].qid, 'Q-002');
  assert.strictEqual(r.items[0].answerText, 'B. 就這個');
  ok('只答一題也用複製功能 → single，仍保有逐題的閘門檢查');

  r = _parseAnswerText_('Q-002 用 A 方案', TWO);
  assert.strictEqual(r.mode, 'single');
  assert.strictEqual(r.items[0].qid, 'Q-002');
  assert.strictEqual(r.items[0].answerText, '用 A 方案');
  r = _parseAnswerText_('q2 用 A 方案', TWO);
  assert.strictEqual(r.items[0].qid, 'Q-002');
  ok('舊語法 \`Q-002 我的答覆\` 照常（熟練使用者還在用）');

  r = _parseAnswerText_('用 A 方案，因為跨行清算那段要保留', TWO);
  assert.strictEqual(r.mode, 'single');
  assert.strictEqual(r.items[0].qid, null, 'null＝交給下游挑第一個未答的題');
  ok('一般自由文字 → single + qid null（行為不變）');

  // 這是這次唯一「以前會猜、現在不猜」的地方。
  // PM 心裡的「第一題」不一定是 Q-001——Q-001 已答時他指的是剩下的第一題。
  ['第一題選Ａ', '第 2 題改成 B', '第三題我選A'].forEach(function (t) {
    assert.strictEqual(_parseAnswerText_(t, TWO).mode, 'unparsed', t);
  });
  assert.strictEqual(_parseAnswerText_('1. B  2. C', TWO).mode, 'unparsed');
  ok('「第一題選A」「1. B 2. C」→ unparsed，反問而不是猜（會寫到別題上）');

  // 只剩一題時沒有歧義，不該沒事找事反問
  assert.strictEqual(_parseAnswerText_('第一題選A', ONE).mode, 'single');
  assert.strictEqual(_parseAnswerText_('第一題選A', ONE).items[0].qid, null);
  ok('只剩一題時「第一題」沒有歧義 → 照常放行');

  // 全形要在解析之前就轉掉
  r = _parseAnswerText_('Ｑ－００２ 用 A 方案', TWO);
  assert.strictEqual(r.items[0].qid, 'Q-002');
  ok('全形題號也吃得下（正規化在解析之前）');
  `);
}


// ══════════════════════════════════════════════════════════════════
console.log('\n[3d] slackBotProxy — 批次派發與去重（與按鈕共用同一把鎖）');
// ══════════════════════════════════════════════════════════════════
{
  const env = mkEnv();
  Object.assign(global, env.globals);
  const posted = [], dispatched = [];
  let progressStub = null;
  const provider = {
    name: 'slack',
    fetchThreadRoot: () => '\u{1F680} 正在啟動 RA-PIPELINE (VIPOP-46703)...',
    postMessage: (ch, text) => { posted.push(text); return {}; },
  };

  eval(src(INTENT_SRC) + `
  fetchProgress = function () { return progressStub; };
  dispatchResume = function () { dispatched.push('single'); return true; };
  dispatchResumeBatch = function (jira, pipe, raw, user) {
    dispatched.push({ jira: jira, pipe: pipe, raw: raw, user: user });
    return true;
  };

  const IN = { provider:'slack', channel:'C1', thread:'1700.1' };
  const PASTE = [
    '## VIPOP-46703 PO 補問回覆',
    '- **Q-001**: A. 甲案',
    '- **Q-002**: B. 乙案',
    '### AI 假設(勾選 = 同意)',
    '- A-001: \\u2713 同意'
  ].join('\\n');

  progressStub = { jira_key:'VIPOP-46703', pipeline:'ra-pipeline', pending_questions:[
    { id:'Q-001', phase:'ra-phase2', resume_action:'continue', answered:false },
    { id:'Q-002', phase:'ra-phase2', resume_action:'continue', answered:false }
  ]};

  posted.length = 0; dispatched.length = 0;
  handleTextAnswer(PASTE, IN, 'U1', provider);
  assert.strictEqual(dispatched.length, 1);
  assert.strictEqual(dispatched[0].jira, 'VIPOP-46703');
  assert.strictEqual(dispatched[0].pipe, 'ra-pipeline');
  assert.ok(dispatched[0].raw.indexOf('Q-002') > 0, '整串原封不動送過去，由 augma 拆');
  assert.ok(posted.some(t => t.indexOf('批次回覆') >= 0));
  ok('整份貼上 → dispatchResumeBatch，整串原文轉送（格式知識歸 augma）');

  // GAS 刻意不報「寫進幾題」——它只撈題號、沒配對答案、沒查閘門
  assert.ok(posted.every(t => t.indexOf('已寫入 2 題') < 0));
  assert.ok(posted.some(t => t.indexOf('已忽略 1 條 AI 假設') >= 0));
  assert.ok(posted.some(t => t.indexOf('按鈕可以忽略') >= 0));
  ok('回覆保持中性（不報數字），但明講 AI 假設被忽略與按鈕可忽略');

  // 去重鎖必須與按鈕路徑是同一把 key，否則同一題會被兩條路各寫一次
  const cache = CacheService.getScriptCache();
  assert.strictEqual(cache.get(_answerKey_('VIPOP-46703','Q-001')), '<@U1>');
  assert.strictEqual(cache.get(_answerKey_('VIPOP-46703','Q-002')), '<@U1>');
  ok('撈到的題號全部寫進 ans_<jira>_<qid>（與按鈕同一把鎖，擋跨路徑競態）');

  posted.length = 0; dispatched.length = 0;
  handleTextAnswer(PASTE, IN, 'U1', provider);
  assert.strictEqual(dispatched.length, 0, '整份都收過就不該再 dispatch');
  assert.ok(posted.some(t => t.indexOf('已經收下過') >= 0));
  ok('手滑再貼一次 → 不重複 dispatch（避免砍掉正在跑的 agent）');

  // 部分重複仍要送：沒收過的那幾題還是得寫進去
  cache.remove(_answerKey_('VIPOP-46703','Q-002'));
  posted.length = 0; dispatched.length = 0;
  handleTextAnswer(PASTE, IN, 'U1', provider);
  assert.strictEqual(dispatched.length, 1);
  assert.ok(posted.some(t => t.indexOf('Q-001') >= 0 && t.indexOf('稍早已經收過') >= 0));
  ok('部分重複 → 照送，並點名哪幾題稍早已收過');

  // 「第一題選A」→ 反問並收語料，不猜
  cache.remove(_answerKey_('VIPOP-46703','Q-001'));
  cache.remove(_answerKey_('VIPOP-46703','Q-002'));
  PropertiesService.getScriptProperties().deleteProperty('intent_misses');
  posted.length = 0; dispatched.length = 0;
  handleTextAnswer('第一題選Ａ', IN, 'U1', provider);
  assert.strictEqual(dispatched.length, 0, '不確定是哪一題就絕不 dispatch');
  assert.ok(posted.some(t => t.indexOf('不確定是哪一題') >= 0));
  assert.ok(posted.some(t => t.indexOf('Q-001') >= 0), '要列出待答清單讓人直接照著回');
  const miss = JSON.parse(PropertiesService.getScriptProperties().getProperty('intent_misses'));
  assert.ok(miss.some(m => m.why === 'answer-unparsed'));
  ok('「第一題選A」→ 反問 + 列出待答清單 + 收進語料（階段二的接點）');

  // 批次也要擋沒有 pipeline 的情況：猜錯 pipeline 是不可逆的
  progressStub.pipeline = '';
  posted.length = 0; dispatched.length = 0;
  handleTextAnswer(PASTE, IN, 'U1', provider);
  assert.strictEqual(dispatched.length, 0);
  assert.ok(posted.some(t => t.indexOf('哪條 pipeline') >= 0));
  ok('批次同樣拒絕在讀不到 pipeline 時接續');
  `);
}


// ══════════════════════════════════════════════════════════════════
console.log();
console.log('[3b] slackBotProxy — 收到出向請求要明確報錯，不能靜默回 ok');
// 拆分後若 AUGMA_NOTIFY_ENDPOINT 還指向這支，回純文字 'ok'（HTTP 200）會讓
// notify-question.sh 判定「卡片送出成功」——單子就這樣無聲卡死。
// ══════════════════════════════════════════════════════════════════
{
  const env = mkEnv();
  Object.assign(global, env.globals);
  global.getProvider = () => ({ name: 'slack', postMessage: () => ({}) });

  eval(src(['slackBotProxy/core/github.js', 'slackBotProxy/core/decision.js',
            'slackBotProxy/core/intent.js', 'slackBotProxy/slackBotProxy.js']) + `
  ['decision', 'progress'].forEach(function (a) {
    const body = doPost({ parameter: {}, postData: { contents: JSON.stringify({ action: a, jira_id: 'VIPOP-1' }) } })._t;
    assert.ok(body.indexOf('"error"') >= 0, a + ' 應回帶 error 的 JSON，實際：' + body);
    assert.ok(body.indexOf('messageDispatch') >= 0, '訊息要指出改去哪：' + body);
    assert.notStrictEqual(body, 'ok', '絕不能回純文字 ok');
  });

  const qs = doPost({ parameter: { action: 'decision', k: 'x' } })._t;
  assert.ok(qs.indexOf('"error"') >= 0, 'query string 形式也要擋：' + qs);
  ok('出向請求（JSON body 與 query string 兩種）都回明確錯誤');
  `);
}


// ══════════════════════════════════════════════════════════════════
console.log('\n[4] messageDispatch — 出向路由與金鑰驗證');
// ══════════════════════════════════════════════════════════════════
{
  const env = mkEnv({ NOTIFY_KEY: 'secret' });
  Object.assign(global, env.globals);
  const outCalls = [];
  const provider = {
    name: 'slack',
    postDecision: (conv, ctx) => { outCalls.push('postDecision:' + ctx.jiraId + ':' + ctx.questions.length); return '1700.9'; },
    updateProgress: (conv, info) => { outCalls.push('updateProgress:' + info.jiraId); },
    postMessage: (ch, text) => { outCalls.push(text); return {}; },
  };
  global.getProvider = () => provider;

  eval(src(['messageDispatch/core/outbound.js','messageDispatch/MessageDispatch.gs.js']) + `
  let res = doPost({ parameter:{ k:'secret' }, postData:{ contents: JSON.stringify({
    action:'decision', jira_id:'VIPOP-46703', phase:'ra-phase2', pipeline:'ra-pipeline',
    conversation:{ provider:'slack', channel:'C1', thread:'1700.1' },
    questions:[{ id:'Q-001', question:'選 A 還是 B' }]
  })}});
  assert.ok(outCalls.includes('postDecision:VIPOP-46703:1'));
  assert.ok(res._t.indexOf('"status":"ok"') >= 0);
  ok('decision → 貼出決策卡片');

  outCalls.length = 0;
  res = doPost({ parameter:{ k:'wrong' }, postData:{ contents: JSON.stringify({
    action:'decision', jira_id:'VIPOP-1', conversation:{ channel:'C1' }, questions:[{}]
  })}});
  assert.strictEqual(outCalls.length, 0);
  assert.ok(res._t.indexOf('Unauthorized') >= 0);
  ok('錯誤的 NOTIFY_KEY → 擋下且不貼任何東西');

  outCalls.length = 0;
  doPost({ parameter:{ k:'secret' }, postData:{ contents: JSON.stringify({
    action:'progress', jira_id:'VIPOP-46703', pipeline:'ra-pipeline',
    conversation:{ channel:'C1', thread:'1700.1' }, phases:[]
  })}});
  assert.ok(outCalls.includes('updateProgress:VIPOP-46703'));
  ok('progress → 更新進度看板');

  res = doPost({ parameter:{ k:'secret' }, postData:{ contents: JSON.stringify({
    action:'decision', jira_id:'VIPOP-1', conversation:{}, questions:[{}]
  })}});
  assert.ok(res._t.indexOf('Missing channel') >= 0);
  ok('缺 conversation 錨點 → 明確報錯（不靜默）');

  // 批次結果回報：入向送出時不知道實際寫進幾題，這則才是有資訊的那一則
  outCalls.length = 0;
  doPost({ parameter:{ k:'secret' }, postData:{ contents: JSON.stringify({
    action:'answer_result', jira_id:'VIPOP-46703',
    conversation:{ channel:'C1', thread:'1700.1' },
    summary:{
      applied:['Q-001','Q-002'], skipped_already_answered:['Q-005'],
      rejected_gate:['Q-003'], unmatched:['Q-009'], ignored_assumptions:['A-001'],
      still_pending:['Q-003','Q-004'], by:'<@U1>', at:'2026-08-20T00:00:00Z'
    }
  })}});
  const msg = outCalls.join(String.fromCharCode(10));
  assert.ok(msg.indexOf('Q-001、Q-002') >= 0, '要點名寫進哪幾題');
  assert.ok(msg.indexOf('Q-005') >= 0 && msg.indexOf('未覆蓋') >= 0);
  assert.ok(msg.indexOf('Q-003') >= 0 && msg.indexOf('放行閘門') >= 0);
  assert.ok(msg.indexOf('Q-009') >= 0 && msg.indexOf('找不到') >= 0, '對不上的題號要講出來，不能靜默丟掉');
  assert.ok(msg.indexOf('AI 假設') >= 0);
  assert.ok(msg.indexOf('還有 2 題待回覆') >= 0);
  assert.ok(msg.indexOf('按鈕可以忽略') >= 0, '批次答完但按鈕還在，要講清楚');
  ok('answer_result → 逐類回報（寫入／已答／閘門／對不上／假設／仍待回覆）');

  // 一題都沒寫進去也要說清楚，不能沉默——那正是「貼了但什麼都沒發生」的情境
  outCalls.length = 0;
  doPost({ parameter:{ k:'secret' }, postData:{ contents: JSON.stringify({
    action:'answer_result', jira_id:'VIPOP-46703', conversation:{ channel:'C1' },
    summary:{ applied:[], unmatched:['Q-009'], still_pending:['Q-001'], by:'<@U1>' }
  })}});
  assert.ok(outCalls.join('').indexOf('沒有寫入任何一題') >= 0);
  ok('一題都沒寫進去 → 明講，不沉默');

  assert.ok(doPost({ parameter:{ k:'secret', action:'nope' } })._t.indexOf('Unknown action') >= 0);
  assert.ok(doGet()._t.indexOf('outbound') >= 0);
  ok('未知 action / doGet 健康檢查');
  `);
}

// ══════════════════════════════════════════════════════════════════
console.log();
console.log('[5] messageDispatch — 進度看板渲染 activity');
// 長時間的 Phase 在人眼裡是一片空白，running 那一行的 activity 是唯一的訊息。
// ══════════════════════════════════════════════════════════════════
{
  const env = mkEnv({ SLACK_BOT_TOKEN: 'xoxb-test' });
  Object.assign(global, env.globals);

  eval(src(['messageDispatch/providers/slack.js']) + `
  const captured = [];
  SlackProvider.updateMessage = function (ch, ts, text, blocks) {
    captured.push({ text: text, blocks: blocks });
    return {};
  };

  function render(phases, pendingQ) {
    captured.length = 0;
    SlackProvider.updateProgress({ channel: 'C1', status_ts: '1700.1' }, {
      jiraId: 'VIPOP-46789', pipeline: 'ra-pipeline',
      pendingQuestions: pendingQ || 0, runUrl: '', phases: phases
    });
    return captured[0].blocks[1].text.text;
  }

  // 有 activity → 顯示它
  let out = render([
    { command: 'ra-phase1', status: 'completed', activity: '' },
    { command: 'ra-phase2', status: 'running', activity: '抓取 Jira 工單與附件' }
  ]);
  assert.ok(out.indexOf('抓取 Jira 工單與附件') >= 0, '應顯示 activity：' + out);
  assert.ok(out.indexOf('ra-phase1') >= 0 && out.indexOf('ra-phase2') >= 0);

  // 沒有 activity → 退回「執行中…」，不能空著
  out = render([{ command: 'ra-phase2', status: 'running', activity: '' }]);
  assert.ok(out.indexOf('執行中') >= 0, '沒 activity 要退回執行中：' + out);

  // 只有 running 顯示 activity；completed / awaiting_decision 不受影響
  out = render([
    { command: 'ra-phase1', status: 'completed', activity: '不該出現' },
    { command: 'ra-phase2', status: 'awaiting_decision', activity: '也不該出現' }
  ]);
  assert.ok(out.indexOf('不該出現') < 0 && out.indexOf('也不該出現') < 0, out);
  assert.ok(out.indexOf('等待決策') >= 0);

  // 過長要截斷（Slack 那一行不該被單一 activity 撐爆）
  out = render([{ command: 'ra-phase2', status: 'running', activity: 'X'.repeat(120) }]);
  assert.ok(out.length < 200, '過長的 activity 應截斷，實際長度 ' + out.length);
  assert.ok(out.indexOf('…') >= 0, '截斷要有省略號：' + out);

  ok('running 顯示 activity、缺值退回「執行中」、其他狀態不受影響、過長截斷');
  `);
}


// ══════════════════════════════════════════════════════════════════
console.log('[6] messageDispatch — Phase 失敗必須看得出來');
// 實際踩過（VIPOP-46789 / sa-phase2）：Phase 逾時被收掉，但沒有任何腳本把
// status 寫成 failed，於是看板永遠停在「🔄 執行中」——job 早就紅了，而 Slack
// 上的人完全看不出來，還在等。修的是 augma 端（set-error 要同時寫 status），
// 這裡守的是另一半：狀態真的送來 failed 時，看板必須明講發生了什麼。
// ══════════════════════════════════════════════════════════════════
{
  const env = mkEnv({ SLACK_TOKEN: 'xoxb-test' });
  Object.assign(global, env.globals);

  eval(src(['messageDispatch/providers/slack.js']) + `
  const captured = [];
  SlackProvider.updateMessage = function (ch, ts, text, blocks) {
    captured.push({ text: text, blocks: blocks });
    return {};
  };

  function render(phases) {
    captured.length = 0;
    SlackProvider.updateProgress({ channel: 'C1', status_ts: '1700.1' }, {
      jiraId: 'VIPOP-46789', pipeline: 'sa-pipeline',
      pendingQuestions: 0, runUrl: '', phases: phases
    });
    return { header: captured[0].blocks[0].text.text, body: captured[0].blocks[1].text.text };
  }

  // 重現那次的 payload：failed 但 activity 還留著上一次的內容
  let out = render([
    { command: 'sa-phase1', status: 'completed', activity: '', error: '' },
    { command: 'sa-phase2', status: 'failed',
      activity: '讀取既有 codebase 實作、分析規格與架構',
      error: 'Phase 逾時：輪詢達上限 480s 仍未結算，agent 已被收掉' },
    { command: 'sa-phase3', status: 'pending', activity: '', error: '' }
  ]);

  assert.ok(out.body.indexOf('❌') >= 0, '失敗要用 ❌ 圖示：' + out.body);
  assert.ok(out.body.indexOf('逾時') >= 0, '失敗原因要寫在旁邊：' + out.body);
  assert.ok(out.body.indexOf('🔄') < 0, '失敗的 Phase 不該還是 🔄：' + out.body);
  assert.ok(out.body.indexOf('分析規格與架構') < 0,
    'failed 不該再顯示殘留的 activity（那會讓人以為還在跑）：' + out.body);
  assert.ok(out.header.indexOf('已中止') >= 0,
    '標題要明講 pipeline 已中止，只靠圖示太容易被當成還在跑：' + out.header);
  assert.ok(out.header.indexOf('sa-phase2') >= 0, '標題要指出是哪一階失敗：' + out.header);

  // 沒有 error 時也不能空著
  out = render([{ command: 'sa-phase2', status: 'failed', activity: '', error: '' }]);
  assert.ok(out.body.indexOf('失敗') >= 0, '沒有 error 要退回「失敗」：' + out.body);

  // 過長的 error 要截斷
  out = render([{ command: 'sa-phase2', status: 'failed', activity: '', error: 'X'.repeat(200) }]);
  assert.ok(out.body.length < 260, '過長的 error 應截斷，實際 ' + out.body.length);

  // 全部順利時不該出現「已中止」
  out = render([{ command: 'sa-phase1', status: 'completed', activity: '', error: '' }]);
  assert.ok(out.header.indexOf('已中止') < 0, '沒有失敗時不該標中止：' + out.header);

  ok('failed 顯示 ❌ 與原因、不殘留 activity、標題明講已中止、無失敗時不誤標');
  `);
}


console.log('\n✅ ' + passed + ' 項全部通過\n');
