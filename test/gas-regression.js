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
    'intent_misses'       // 意圖規則未命中的語料
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

  eval(src(['slackBotProxy/core/github.js','slackBotProxy/core/decision.js','slackBotProxy/core/intent.js']) + `
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

  r = co('今天天氣真好');
  assert.strictEqual(r.matchedBy, 'no-match');
  const misses = JSON.parse(PropertiesService.getScriptProperties().getProperty('intent_misses'));
  assert.ok(misses.some(m => m.s.indexOf('今天天氣') >= 0));
  ok('未命中 → 記錄語料（日後設計 LLM prompt 的素材）');

  for (let i = 0; i < 80; i++) co('隨機 ' + i);
  const raw = PropertiesService.getScriptProperties().getProperty('intent_misses');
  assert.strictEqual(JSON.parse(raw).length, 60);
  assert.ok(raw.length < 9000, 'ScriptProperties 單筆上限 9 KB');
  ok('語料 ring buffer 上限 60 筆（' + raw.length + ' bytes）');

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

  eval(src(['slackBotProxy/core/github.js','slackBotProxy/core/decision.js','slackBotProxy/core/intent.js']) + `
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


console.log('\n✅ ' + passed + ' 項全部通過\n');
