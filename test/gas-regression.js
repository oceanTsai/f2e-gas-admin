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
let uuidSeq = 0;   // Utilities.getUuid 的可預期替身（測試要能對照快取鍵）
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
      Utilities: { formatDate: () => '12:00:00', getUuid: () => 'uuid-' + (uuidSeq++) },
      UrlFetchApp: { fetch: () => { throw new Error('測試不該打真的網路'); } },
      console: console,
    }
  };
}

// mock provider 的共用片段。core 呼叫的 provider 介面少一個方法，症狀就是
// TypeError——集中一份，才不會每加一個測試節就漏掉。
//
// 刻意複製 SlackProvider.mention 的行為而不是引用它：多數測試節不載入
// providers/slack.js（那會連帶拉進一堆網路呼叫），而斷言裡的 `<@U1>` 要對得上。
const MENTION = (id) => (id ? '<@' + id + '>' : '');

// core 只交給 provider「文字 ＋ 要不要附按鈕的快取鍵」，卡片由 provider 組
// （見 providers/slack.js 的 postIntentHelp）。多數測試節只在意那則文字，
// 所以轉呼 postMessage 就夠；驗按鈕的那一節（3f）另外接真的 SlackProvider。
//
// 這裡手算 replyTarget 而不用 _replyTarget_：那支住在 eval 出來的 GAS scope 裡，
// 這個 helper 在 node 這一側，取不到它。
const INTENT_HELP = function (conv, o) {
  return this.postMessage(conv.channel, o.text, conv.thread || conv.replyTo || null, null);
};

function src(files) {
  return files.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
}

// 入向那一側的完整載入順序。分類器工廠與規則層是分開的檔案，少載一個的症狀是
// 「getClassifier is not defined」——與 GAS 上少推一個檔完全一樣。
const INTENT_SRC = [
  'slackBotProxy/core/text.js',
  'slackBotProxy/core/conv.js',
  'slackBotProxy/core/github.js',
  'slackBotProxy/core/decision.js',
  'slackBotProxy/core/answer.js',
  'slackBotProxy/core/ask.js',
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
    'INTENT_CLASSIFIER',  // rules / llm（與 ANSWER_PARSER 分開，曝光面不同）
    'ASK_PASSPHRASE',     // 自由提問的通關密語；設成 off 才是關閉閘門
    'ASK_OWNER',          // 被擋下時要找誰拿密語
    'MEMORY_CHANNEL'      // 記憶決策卡片要貼到哪個頻道——每日 cron 沒有
                          // conversation 錨點（沒有任何人發過訊息），所以
                          // 必須有一個設定好的固定頻道。見 messageDispatch/core/memory.js
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

    // 掃描前先去掉註解。不去的話，光是在註解裡提到 `_foo_()` 就會被算成呼叫，
    // 而這份 codebase 的註解密度很高——那種誤報會讓人開始忽略這條檢查。
    //
    // ⚠️ 用**逐行**狀態機，不要用 /\*[\s\S]*?\*\/ 那種跨行 regex：程式碼裡的
    //    regex literal 會誤觸（某個 pattern 裡的 `*` 加上結尾的 `/` 剛好組成
    //    `*/`），一吃就吃掉幾十 KB 的程式碼，然後所有真的定義都「消失」了。
    //    這份 codebase 的區塊註解一律獨占整行，逐行判斷就夠且不會誤傷。
    const NL = String.fromCharCode(10);
    let inBlock = false;
    const code = blob.split(NL).map(function (line) {
      if (inBlock) {
        if (line.indexOf('*/') >= 0) inBlock = false;
        return '';
      }
      if (/^\s*\/\*/.test(line)) {
        if (line.indexOf('*/') < 0) inBlock = true;
        return '';
      }
      // `://` 要保護，否則 URL 會被當成行註解而吃掉整行（可能藏著真的呼叫）
      return line.replace(/(^|[^:])\/\/.*$/, '$1');
    }).join(NL);

    const seen = {};
    let m;
    DECL.lastIndex = 0;
    while ((m = DECL.exec(code)) !== null) seen[m[1]] = (seen[m[1]] || 0) + 1;
    const dup = Object.keys(seen).filter(k => seen[k] > 1);
    assert.strictEqual(dup.length, 0,
      proj + ' 有重複的頂層宣告（GAS 會拒絕載入）: ' + dup.join(', '));

    // 被呼叫但沒有定義的內部輔助函式。
    //
    // 這條是實戰換來的：入向／出向拆分（ae4d37a）把 `_emptyResponse_()` 的定義
    // 連帶刪掉，但 handleInteraction 裡九個呼叫點全部留著。GAS 不會在載入時
    // 抱怨——ReferenceError 要等真的執行到那一行才發生，而那一行只有「有人按了
    // 卡片按鈕」時才會跑到。症狀還是破壞性的：doPost 的 catch 回一段純文字，
    // Slack 拿它把整張卡片換掉，其他題的按鈕一起消失。
    //
    // 只掃 `_xxx_()` 這種本專案的內部命名慣例——GAS 內建服務（ContentService…）
    // 與 provider 物件的方法不在此列，那些掃了只會是誤報。
    const CALLED = /(?<![.\w$])(_[A-Za-z]\w*_)\s*\(/g;
    const missing = new Set();
    let cm;
    CALLED.lastIndex = 0;
    while ((cm = CALLED.exec(code)) !== null) {
      if (!seen[cm[1]]) missing.add(cm[1]);
    }
    assert.strictEqual(missing.size, 0,
      proj + ' 呼叫了未定義的內部函式（執行到那一行才會炸）: ' + [...missing].join(', '));

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
console.log('\n[0b] provider 邊界 — core 不准自己組平台語法');
//
// 這一節守的是「切 provider 時要不要動 core」。兩條都是實戰教訓的預防：
//
//   ① core/intent.js 曾經自己組 Slack Block Kit（_askOfferBlocks_），
//      而同一個 codebase 的 messageDispatch 那側是交給 provider.postDecision。
//      同一件事兩套做法，其中一套切平台時要改 core。
//   ② `<@id>` 曾經散在 core 的三十幾處。Google Chat 的 mention 是 `<users/id>`，
//      寫死的那一種在另一個平台會渲染成一段沒人看得懂的純文字——那個症狀看
//      起來像 bug 而不像「provider 沒實作完」，所以最難查。
//
// 這種邊界靠 code review 守不住（加一行 postMessage(..., blocks) 太自然了），
// 所以做成靜態檢查。
// ══════════════════════════════════════════════════════════════════
{
  const NL = String.fromCharCode(10);

  // 逐行剝掉註解。理由與 [0] 節相同：這份 codebase 的註解密度很高，
  // 光是在註解裡提到 `<@U123>` 就會誤報，而誤報會讓人開始忽略這條檢查。
  function stripComments(text) {
    let inBlock = false;
    return text.split(NL).map(function (line) {
      if (inBlock) {
        if (line.indexOf('*/') >= 0) inBlock = false;
        return '';
      }
      if (/^\s*\/\*/.test(line)) {
        if (line.indexOf('*/') < 0) inBlock = true;
        return '';
      }
      return line.replace(/(^|[^:])\/\/.*$/, '$1');
    }).join(NL);
  }

  // Slack Block Kit 的結構標記。core 出現任何一個，就是把卡片語法寫進了
  // 業務邏輯——卡片長什麼樣是 provider 的事（見 providers/slack.js 的
  // postIntentHelp，以及 messageDispatch 那側的 postDecision）。
  const BLOCK_KIT = ["type: 'section'", "type: 'actions'", "type: 'button'",
                     'mrkdwn', 'plain_text', 'action_id', 'block_id'];

  // 允許保留 `<@` 的兩行。兩者都不是「顯示給人看的字串」：
  const MENTION_OK = [
    // progress.json 的 answered_by 是跨專案契約（augma 的 update-progress.sh
    // 會寫它、_alreadyAnswered_ 會讀它），格式不能單方面改。
    "const answeredBy = '<@' + user + '>'",
    // 入向解析：Slack 傳回的原文帶著 mention 前綴，樣式要允許它。
    //
    // 它還留在 core 是因為入向事件解析整層都還沒抽進 provider 介面
    // （doPost 直接吃 e.parameter.payload / body.event_id / app_mention），
    // 而那個介面的形狀取決於 GAS 對 Google Chat 的原生觸發長什麼樣。
    // 抽的時候這一行要跟著改成允許 `<users/…>`。
    'const ASK_TRIGGER_IN_ROOT_RE'
  ];

  const CORE_DIR = path.join(ROOT, 'slackBotProxy', 'core');
  const coreFiles = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.js$/.test(e.name)) coreFiles.push(full);
    }
  })(CORE_DIR);
  coreFiles.sort();

  const kitHits = [], mentionHits = [];
  for (const f of coreFiles) {
    const rel = path.relative(ROOT, f);
    const lines = stripComments(fs.readFileSync(f, 'utf8')).split(NL);
    lines.forEach(function (line, i) {
      const where = rel + ':' + (i + 1);
      for (const tok of BLOCK_KIT) {
        if (line.indexOf(tok) >= 0) kitHits.push(where + ' → ' + tok);
      }
      if (line.indexOf('<@') >= 0 && !MENTION_OK.some(a => line.indexOf(a) >= 0)) {
        mentionHits.push(where + ' → ' + line.trim().slice(0, 60));
      }
    });
  }

  assert.strictEqual(kitHits.length, 0,
    'core 出現 Block Kit 語法（卡片該由 provider 組）：' + NL + kitHits.join(NL));
  ok('core 沒有任何 Block Kit 語法（' + coreFiles.length + ' 檔）');

  assert.strictEqual(mentionHits.length, 0,
    'core 自己組了 mention（請改用 provider.mention）：' + NL + mentionHits.join(NL));
  ok('core 一律走 provider.mention（只有 answered_by 與入向樣式例外）');

  // ── GoogleChatProvider 的 stub 要涵蓋 SlackProvider 的公開介面 ──
  //
  // 這條防的是「加了新 provider 方法，但忘了同步另一份 stub」。那個漏洞的症狀
  // 正是 googleChat.js 檔頭在講的靜默失敗：切過去之後某一條路徑呼叫到
  // undefined，而它可能好幾天才被走到一次。
  //
  // 只比對公開 key：`_` 開頭的是各 provider 的私有輔助（_askOfferBlocks_、
  // _fetchThreadReplies_），本來就不必對齊。
  for (const proj of ['slackBotProxy', 'messageDispatch']) {
    const sandbox = { PropertiesService: null, UrlFetchApp: null, console: console,
                      _replyTarget_: () => null };
    require('vm').createContext(sandbox);
    require('vm').runInContext(
      fs.readFileSync(path.join(ROOT, proj, 'providers', 'slack.js'), 'utf8') + NL +
      fs.readFileSync(path.join(ROOT, proj, 'providers', 'googleChat.js'), 'utf8') + NL +
      'this.__slack = SlackProvider; this.__gchat = GoogleChatProvider;', sandbox);

    const pub = o => Object.keys(o).filter(k => k.charAt(0) !== '_');
    const missing = pub(sandbox.__slack).filter(k => pub(sandbox.__gchat).indexOf(k) < 0);
    assert.strictEqual(missing.length, 0,
      proj + '/providers/googleChat.js 少了 stub（切過去會靜默呼叫到 undefined）：' +
      missing.join('、'));
    ok(proj + '：GoogleChat stub 涵蓋 Slack 的全部 ' +
       pub(sandbox.__slack).length + ' 個公開方法');
  }
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
    mention: MENTION,
    postIntentHelp: INTENT_HELP,
    fetchThreadRoot: () => { rootCalls++; return '\u{1F680} 收到 <@U1> 的任務請求，正在啟動 RA-PIPELINE (VIPOP-46703)...'; },
    postMessage: () => ({}),
  };
  const providerNoThread = { name:'slack', mention: MENTION, postIntentHelp: INTENT_HELP, fetchThreadRoot: () => '', postMessage: () => ({}) };

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

  // 規則 4 的對稱分支：有動詞但沒單號。以前缺這一段，'幫我RA流程' 會掉到
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
  // 複製結果的第一行 '## VIPOP-46703 PO 補問回覆' 同時帶了單號（讓規則 3 的
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

  // 單行訊息不受規則 1 影響
  assert.strictEqual(c('VIPOP-99999 補問清單好了嗎').action, 'run_ra');
  ok('單行訊息不受規則 1 影響（只有多行 + 行首題號才算貼上）');

  // 在決策 thread 裡講同一句話仍然是答覆：規則 3 看的是狀態，排在動詞之前。
  // 這條要守住，否則 PM 在 thread 裡打「我覺得要重跑 RA」會變成開新任務。
  assert.strictEqual(c('幫我RA流程').action, 'answer_question');
  ok('thread 有待決問題時，動詞不搶走答覆（規則 3 優先）');

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
  const failingProvider = { name:'slack', mention: MENTION, postIntentHelp: INTENT_HELP, fetchThreadRoot: () => null, postMessage: () => ({}) };
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

  assert.ok(_intentHelpText_(provider, 'U1', { restate:'' }).split(String.fromCharCode(10)).length > 5);
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
    mention: MENTION,
    postIntentHelp: INTENT_HELP,
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
    mention: MENTION,
    postIntentHelp: INTENT_HELP,
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
console.log('\n[3e] slackBotProxy — 自由提問（ask）');
// 這條路刻意不經過意圖分類，也刻意不是 catch-all：規則層分不出「這是給 agent
// 的任務」與「這是人在聊天」，自動放行等於閒聊也燒一個 runner。
// ══════════════════════════════════════════════════════════════════
{
  const env = mkEnv();
  Object.assign(global, env.globals);
  const posted = [], dispatched = [];
  let dispatchOk = true;
  const provider = {
    name: 'slack',
    mention: MENTION,
    postIntentHelp: INTENT_HELP,
    fetchThreadRoot: () => '',
    postMessage: (ch, text) => { posted.push(text); return { ts: '1700.9' }; },
    postAccepted: (conv, text) => {
      posted.push(text);
      return { provider:'slack', channel: conv.channel, thread: conv.thread || '1700.9', status_ts: '1700.9' };
    },
  };

  eval(src(INTENT_SRC) + `
  dispatchAsk = function (prompt, uid, conv, askId) {
    dispatched.push({ prompt: prompt, uid: uid, conv: conv, askId: askId });
    return dispatchOk;
  };

  const CH = { provider:'slack', channel:'C1', thread:null };

  posted.length = 0; dispatched.length = 0;
  handleAskRequest('', CH, 'U1', provider);
  assert.strictEqual(dispatched.length, 0);
  assert.ok(posted.some(t => t.indexOf('要問什麼') >= 0));
  ok('空提問 → 給用法，不 dispatch');

  posted.length = 0; dispatched.length = 0;
  handleAskRequest('速速前 ' + 'X'.repeat(2500), CH, 'U1', provider);
  assert.strictEqual(dispatched.length, 0);
  assert.ok(posted.some(t => t.indexOf('太長') >= 0));
  ok('超長提問 → 擋下（多半是貼錯整份 log，讓 agent 讀八分鐘沒有意義）');

  posted.length = 0; dispatched.length = 0;
  handleAskRequest('速速前 幫我查 ui 的 code 裡登入流程怎麼寫的', CH, 'U1', provider);
  assert.strictEqual(dispatched.length, 1);
  assert.ok(dispatched[0].prompt.indexOf('登入流程') >= 0);
  assert.ok(dispatched[0].prompt.indexOf('速速前') < 0,
    '密語要在送出前拿掉——agent 收到它只會困惑，甚至拿去查');
  assert.ok(posted.some(t => t.indexOf('正在查') >= 0));
  ok('正常提問 → 先貼受理訊息取得 thread 錨點，再 dispatch');

  // 答案是幾分鐘後由 augma 主動貼回來的，那時已經沒有任何 Slack 事件
  // 可以推導「要回到哪裡」，所以 conversation 必須在 dispatch 當下就定案
  assert.strictEqual(dispatched[0].conv.channel, 'C1');
  assert.strictEqual(dispatched[0].conv.thread, '1700.9', '在頻道裡問時要用受理訊息當 thread 錨點');
  ok('conversation 錨點在 dispatch 前定案（答案回得來、且不洗頻）');

  posted.length = 0; dispatched.length = 0;
  handleAskRequest('速速前 再問一題', CH, 'U1', provider);
  assert.strictEqual(dispatched.length, 0);
  assert.ok(posted.some(t => t.indexOf('剛剛才問過') >= 0));
  ok('同一人 60 秒內再問 → 節流（每題佔一台 runner）');

  // 節流是 per-user：別人不該被連坐
  posted.length = 0; dispatched.length = 0;
  handleAskRequest('速速前 我也想問', CH, 'U2', provider);
  assert.strictEqual(dispatched.length, 1);
  ok('節流是 per-user，不會連坐其他人');

  // dispatch 失敗時不可留下節流標記——那會讓他連重試都被擋住
  CacheService.getScriptCache().remove('ask_U3');
  dispatchOk = false;
  posted.length = 0; dispatched.length = 0;
  handleAskRequest('速速前 會失敗的一題', CH, 'U3', provider);
  assert.ok(posted.some(t => t.indexOf('觸發 GitHub Actions 失敗') >= 0));
  assert.strictEqual(CacheService.getScriptCache().get('ask_U3'), null,
    'dispatch 失敗不該寫節流標記，否則他連重試都被擋住');
  dispatchOk = true;
  posted.length = 0; dispatched.length = 0;
  handleAskRequest('速速前 重試', CH, 'U3', provider);
  assert.strictEqual(dispatched.length, 1);
  ok('dispatch 失敗 → 不寫節流標記，可立刻重試');

  // ── 通關密語（測試期間的閘門）──────────────────────────────
  // 每觸發一次就佔一台 runner，而整台機器只有 3 個
  CacheService.getScriptCache().remove('ask_U9');
  posted.length = 0; dispatched.length = 0;
  handleAskRequest('幫我查 ui 的 code', CH, 'U9', provider);
  assert.strictEqual(dispatched.length, 0, '沒有密語就不該送出');
  assert.ok(posted.some(t => t.indexOf('測試中') >= 0));
  assert.ok(posted.every(t => t.indexOf('速速前') < 0),
    '擋下的訊息不可以洩漏密語本身——洩漏了就等於沒有閘門');
  // ASK_OWNER 沒設時不可以生出 <@某個名字>：Slack 只認 user id，
  // 名字會渲染成壞掉的 mention，看起來像 bug 而不是提示
  assert.ok(posted.some(t => t.indexOf('找專案負責人拿') >= 0));
  PropertiesService.getScriptProperties().setProperty('ASK_OWNER', 'U0PEDRO');
  posted.length = 0;
  handleAskRequest('幫我查 X', CH, 'U9', provider);
  assert.ok(posted.some(t => t.indexOf('<@U0PEDRO>') >= 0));
  PropertiesService.getScriptProperties().deleteProperty('ASK_OWNER');
  ok('沒有密語 → 擋下、不洩漏密語，且沒設 ASK_OWNER 時不生出壞掉的 mention');

  // 只打密語沒有問題本文
  posted.length = 0; dispatched.length = 0;
  handleAskRequest('速速前', CH, 'U9', provider);
  assert.strictEqual(dispatched.length, 0);
  assert.ok(posted.some(t => t.indexOf('還沒說要問什麼') >= 0));
  ok('只打密語沒有問題 → 提示他補上（而不是送一個空問題）');

  // 密語可以出現在句子任何位置
  CacheService.getScriptCache().remove('ask_U9');
  posted.length = 0; dispatched.length = 0;
  handleAskRequest('幫我查 ui 的 code 速速前', CH, 'U9', provider);
  assert.strictEqual(dispatched.length, 1);
  assert.strictEqual(dispatched[0].prompt, '幫我查 ui 的 code');
  ok('密語在句尾也算，且送出前被剝掉');

  // 預設開啟：忘記設定時應該是「沒人能用」而不是「所有人都能用」
  PropertiesService.getScriptProperties().deleteProperty('ASK_PASSPHRASE');
  assert.strictEqual(_askAllowed_('沒有密語'), false, '未設定屬性時閘門必須是開著的');
  // 空字串不算關閉——「不小心清空」與「刻意關閉」看起來會一模一樣
  PropertiesService.getScriptProperties().setProperty('ASK_PASSPHRASE', '   ');
  assert.strictEqual(_askAllowed_('沒有密語'), false, '留空不算關閉');
  // 要關必須明確寫 off
  PropertiesService.getScriptProperties().setProperty('ASK_PASSPHRASE', 'off');
  assert.strictEqual(_askAllowed_('沒有密語'), true);
  // 也可以換一個密語
  PropertiesService.getScriptProperties().setProperty('ASK_PASSPHRASE', '芝麻開門');
  assert.strictEqual(_askAllowed_('芝麻開門 查一下'), true);
  assert.strictEqual(_askAllowed_('速速前 查一下'), false, '換了密語之後舊的就該失效');
  PropertiesService.getScriptProperties().deleteProperty('ASK_PASSPHRASE');
  ok('閘門預設開啟、留空不算關閉、要關必須明確寫 off、密語可替換');

  // ask 與意圖分類是兩條獨立的路：意圖層掛掉時 ask 還能用
  assert.strictEqual(classifyIntent('幫我查ui的code', { channel:'C9', thread:null }, provider).matchedBy, 'no-match');
  ok('同一句話在意圖層仍是 no-match —— ask 刻意不是 catch-all');
  `);
}


// ══════════════════════════════════════════════════════════════════
console.log('\n[3e-2] slackBotProxy — 續問接續同一支 ask 分支');
// 實戰換來的：在 ask 的 thread 底下說「再試一次」，以前每次都開一支新分支、
// 全新的空白工作區，於是 agent 只能反問「我看不到這句話是回覆給哪一則訊息」。
// 修法是從串文裡 Alice 自己的訊息（受理訊息會被 notify-progress 更新成帶提問
// 編號的看板）反查編號，讓 augma 沿用同一支分支。
//
// 要掃**整串**而不是第一則：Alice 的受理訊息是貼在觸發者那則底下的回覆，所以
// 第一則永遠是人打的那句話。這一節的假 thread 就照那個形狀組（H＝人、B＝Alice）。
//
// 同一個反查也決定了密語豁免：受理過的 thread 內追問不再要密語（串文裡每一句
// 都打「速速前 再試一次」體感太差），所以兩者放在同一節一起驗。
// ══════════════════════════════════════════════════════════════════
{
  const env = mkEnv();
  Object.assign(global, env.globals);
  const posted = [], dispatched = [];
  // null＝讀不到（scope／token／網路）。其餘是由舊到新的整串訊息。
  let threadMsgs = [];
  let rootCalls = 0;
  const H = t => ({ text: t, bot: false });   // 人打的
  const B = t => ({ text: t, bot: true });    // Alice 自己發的
  const provider = {
    name: 'slack',
    mention: MENTION,
    postIntentHelp: INTENT_HELP,
    fetchThreadTexts: () => { rootCalls++; return threadMsgs; },
    postMessage: (ch, text) => { posted.push(text); return { ts: '1700.9' }; },
    postAccepted: (conv, text) => {
      posted.push(text);
      return { provider:'slack', channel: conv.channel, thread: conv.thread || '1700.9', status_ts: '1700.9' };
    },
  };

  eval(src(INTENT_SRC) + `
  dispatchAsk = function (prompt, uid, conv, askId) {
    dispatched.push({ prompt: prompt, askId: askId });
    return true;
  };
  const reset = function () { posted.length = 0; dispatched.length = 0; rootCalls = 0; };
  const IN_THREAD  = { provider:'slack', channel:'C1', thread:'1700.1' };
  // 進度看板的真實形狀（messageDispatch 的 updateProgress 組的）
  const BOARD = '\u{1F680} *U0BP6PJQGKB-20260820-132620*\u3000\`ask\`\u3000(1/1)';

  // ── 串文追問 → 帶上第一輪的編號 ────────────────────────────────
  // 真實形狀：第一則是人打的提問，看板是它的回覆
  threadMsgs = [H('速速前 幫我查登入流程'), B(BOARD)];
  reset();
  handleAskRequest('速速前 再試一次', IN_THREAD, 'U1', provider);
  assert.strictEqual(dispatched.length, 1);
  assert.strictEqual(dispatched[0].askId, 'U0BP6PJQGKB-20260820-132620',
    '續問必須沿用第一輪的提問編號，否則會開新分支、看不到上文');
  assert.ok(posted.some(t => t.indexOf('追問') >= 0 && t.indexOf('上文') >= 0),
    '受理訊息要講明這是續問——反查失敗時他要能立刻看出來，而不是等幾分鐘後收到答非所問');
  ok('ask thread 內追問 → 反查出第一輪編號並帶進 dispatch');

  // ── 反查結果要快取：同一個 thread 不該每次都打一次 Slack API ────
  CacheService.getScriptCache().remove('ask_U2');
  reset();
  handleAskRequest('速速前 那第二點再展開一下', IN_THREAD, 'U2', provider);
  assert.strictEqual(rootCalls, 0, '同一個 thread 的第二次追問應命中快取，不再打 API');
  assert.strictEqual(dispatched[0].askId, 'U0BP6PJQGKB-20260820-132620');
  ok('反查命中後快取，同 thread 後續追問不再打 Slack API');

  // ── 在頻道裡直接問 → 沒有 thread，連 API 都不該打 ──────────────
  CacheService.getScriptCache().remove('ask_U3');
  reset();
  handleAskRequest('速速前 幫我查登入流程', { provider:'slack', channel:'C1', thread:null }, 'U3', provider);
  assert.strictEqual(rootCalls, 0, '不在 thread 裡就不必反查');
  assert.strictEqual(dispatched[0].askId, '', '沒有上文＝開新的一輪');
  ok('頻道內直接提問 → 不反查、開新的一輪');

  // ── 非 ask 的 thread（RA 看板）→ 不可誤認 ───────────────────────
  // 這是最重要的一條：認錯的話追問會被寫到別人的 ask 分支上。
  CacheService.getScriptCache().remove('ask_U4');
  reset();
  threadMsgs = [H('@Alice ra VIPOP-46703'), B('\u{1F680} *VIPOP-46703*\u3000\`ra-pipeline\`\u3000(2/4)')];
  handleAskRequest('速速前 這張單的登入流程在哪', { provider:'slack', channel:'C1', thread:'1700.2' }, 'U4', provider);
  assert.strictEqual(dispatched[0].askId, '', 'JIRA 單號不可被當成提問編號');
  ok('RA/SA 的 thread → 不誤認成 ask 續問（單號樣式與提問編號無交集）');

  // ── 反查失敗（缺 scope／讀不到）→ 降級成新的一輪，不可擋下提問 ──
  CacheService.getScriptCache().remove('ask_U5');
  reset();
  threadMsgs = null;
  handleAskRequest('速速前 再試一次', { provider:'slack', channel:'C1', thread:'1700.3' }, 'U5', provider);
  assert.strictEqual(dispatched.length, 1, '反查失敗絕不能擋下提問——沒有上文的答案仍然有用');
  assert.strictEqual(dispatched[0].askId, '');
  ok('反查失敗 → 降級開新的一輪，提問仍然送出');

  // ── miss 不可以被快取 ──────────────────────────────────────────
  // 第一輪的 thread root 此刻可能還是「正在查…」（看板還沒推上來）。
  // 快取了那次的 miss，這個 thread 從此再也接不起來。
  CacheService.getScriptCache().remove('ask_U6');
  reset();
  threadMsgs = [H('速速前 第一題'), B('\u{1F50D} 收到 <@U6> 的提問，正在查…')];
  handleAskRequest('速速前 第一題', { provider:'slack', channel:'C1', thread:'1700.4' }, 'U6', provider);
  assert.strictEqual(dispatched[0].askId, '');
  CacheService.getScriptCache().remove('ask_U6');
  reset();
  threadMsgs = [H('速速前 第一題'), B(BOARD)];   // 看板推上來了
  handleAskRequest('速速前 追問', { provider:'slack', channel:'C1', thread:'1700.4' }, 'U6', provider);
  assert.strictEqual(dispatched[0].askId, 'U0BP6PJQGKB-20260820-132620',
    'miss 不可被快取，否則看板推上來之後這個 thread 永遠接不起來');
  ok('反查 miss 不寫快取（看板還沒推上來時不該把 thread 判死）');

  // ── 一串只要一次密語 ────────────────────────────────────────────
  // 體感換來的：串文裡每一句都要打「速速前 再試一次」很荒謬，而那正是最自然
  // 的追問情境。已經受理過的 thread 就當作整串放行——第一句仍然要密語，
  // 而能打出那一句的人本來就有。
  CacheService.getScriptCache().remove('ask_U7');
  reset();
  threadMsgs = [H('速速前 第一題'), B(BOARD)];
  handleAskRequest('再試一次', { provider:'slack', channel:'C1', thread:'1700.7' }, 'U7', provider);
  assert.strictEqual(dispatched.length, 1, '受理過的 thread 內追問不該再要密語');
  assert.strictEqual(dispatched[0].prompt, '再試一次');
  assert.strictEqual(dispatched[0].askId, 'U0BP6PJQGKB-20260820-132620');
  assert.strictEqual(rootCalls, 1, '豁免與續問共用同一次反查，不該打兩次 API');
  ok('ask thread 內追問 → 免密語（且只反查一次）');

  // 豁免的來源是「這串受理過」，不是「在 thread 裡」——RA 看板底下不算
  CacheService.getScriptCache().remove('ask_U8');
  reset();
  threadMsgs = [H('@Alice ra VIPOP-46703'), B('\u{1F680} *VIPOP-46703*\u3000\`ra-pipeline\`\u3000(2/4)')];
  handleAskRequest('幫我查登入流程', { provider:'slack', channel:'C1', thread:'1700.8' }, 'U8', provider);
  assert.strictEqual(dispatched.length, 0, 'RA thread 不是 ask thread，沒有豁免');
  assert.ok(posted.some(t => t.indexOf('測試中') >= 0));
  ok('非 ask 的 thread → 沒有豁免，仍然要密語');

  // 頻道裡直接問永遠沒有豁免（連反查都不必打）
  CacheService.getScriptCache().remove('ask_U8');
  reset();
  threadMsgs = [H('速速前 第一題'), B(BOARD)];
  handleAskRequest('幫我查登入流程', { provider:'slack', channel:'C1', thread:null }, 'U8', provider);
  assert.strictEqual(dispatched.length, 0, '頻道裡的第一句一定要密語');
  assert.strictEqual(rootCalls, 0);
  ok('頻道內直接提問 → 一定要密語（豁免只在串文內成立）');

  // 反問按鈕的判斷要跟著同一條規則：這裡說不行而 handleAskRequest 其實會受理，
  // 等於在最需要那顆按鈕的地方（追問只打了「再試一次」）反而不附
  threadMsgs = [H('速速前 第一題'), B(BOARD)];
  assert.strictEqual(_askAllowed_('再試一次'), false, '不給 conv 就只看密語');
  assert.strictEqual(
    _askAllowed_('再試一次', { provider:'slack', channel:'C1', thread:'1700.7' }, provider), true);
  assert.strictEqual(
    _askAllowed_('再試一次', { provider:'slack', channel:'C1', thread:null }, provider), false);
  ok('_askAllowed_ 與 handleAskRequest 同一條豁免規則（按鈕不會該附時不附）');

  // ── 人打的字不算 ────────────────────────────────────────────────
  // 提問編號會直接變成 git 分支名。貼一段別人的編號就能把追問寫進別人的分支，
  // 而且順帶連密語都不用打——所以只認 Alice 自己發的訊息。
  CacheService.getScriptCache().remove('ask_U9');
  reset();
  threadMsgs = [H('速速前 第一題'), H('我看到的編號是 U0BP6PJQGKB-20260820-132620')];
  handleAskRequest('速速前 追問', { provider:'slack', channel:'C1', thread:'1700.10' }, 'U9', provider);
  assert.strictEqual(dispatched[0].askId, '', '人貼的編號不可以決定要寫進哪一支分支');
  CacheService.getScriptCache().remove('ask_U9');
  reset();
  handleAskRequest('沒有密語', { provider:'slack', channel:'C1', thread:'1700.10' }, 'U9', provider);
  assert.strictEqual(dispatched.length, 0, '也不能靠貼編號繞過密語');
  ok('人打的編號一律不算（分支歸屬與密語豁免都只認 Alice 自己的訊息）');

  // ── 由舊到新取第一個命中 ────────────────────────────────────────
  // 串裡若有兩個看板（第一輪反查失敗而新開了一輪），歸屬要留在最早那一支，
  // 否則同一串會在兩支分支之間跳。
  CacheService.getScriptCache().remove('ask_U10');
  reset();
  threadMsgs = [
    H('速速前 第一題'),
    B('\u{1F680} *UAAA-20260820-100000*\u3000\`ask\`\u3000(1/1)'),
    B('\u{1F680} *UBBB-20260820-200000*\u3000\`ask\`\u3000(1/1)')
  ];
  handleAskRequest('速速前 追問', { provider:'slack', channel:'C1', thread:'1700.11' }, 'U10', provider);
  assert.strictEqual(dispatched[0].askId, 'UAAA-20260820-100000',
    '歸屬留在最早那一支，否則同一串會在兩支分支之間跳');
  ok('串裡有多個看板 → 取最早那一個');
  `);
}


// ══════════════════════════════════════════════════════════════════
console.log('\n[3e-4] slackBotProxy — thread 的歸屬：ask 串 vs 任務串');
// 實戰換來的一整條連鎖。使用者在一支已中止的 ask 串底下打「@Alice 再試一次」，
// 收到的是「暫時讀不到 U0BP6PJQGKB-20260820 的流程狀態，請改成明確指定題號：
// @Alice answer Q-001 …」——他只是要它重跑一次，而那個單號根本不存在。
//
// 成因是三段，每一段單獨看都合理：
//   1. JIRA_IN_TEXT_RE 把提問編號 `U0BP6PJQGKB-20260820-132620` 吃成
//      `U0BP6PJQGKB-20260820`（`-` 是非 word 字元，所以 \b 在那裡成立）
//   2. 於是 route 有「單號」→ 規則 3（thread 有待決問題）命中、信心 high
//   3. handleTextAnswer 讀不到那張不存在的單的 progress.json → 要人指定題號
// 所以這一節同時鎖住三件事：樣式不可以再吃到提問編號、ask 串的歸屬優先於單號、
// 兩種 thread 的分類結果不可以互相污染。
// ══════════════════════════════════════════════════════════════════
{
  const env = mkEnv();
  Object.assign(global, env.globals);
  const posted = [], dispatched = [];
  let threadMsgs = [];
  let fetchCalls = 0;
  const H = t => ({ text: t, bot: false });
  const B = t => ({ text: t, bot: true });
  const provider = {
    name: 'slack',
    mention: MENTION,
    postIntentHelp: INTENT_HELP,
    fetchThreadTexts: () => { fetchCalls++; return threadMsgs; },
    postMessage: (ch, text) => { posted.push(text); return { ts: '1700.9' }; },
    postAccepted: (conv, text) => {
      posted.push(text);
      return { provider:'slack', channel: conv.channel, thread: conv.thread || '1700.9', status_ts: '1700.9' };
    },
  };

  eval(src(INTENT_SRC) + `
  dispatchAsk = function (prompt, uid, conv, askId) {
    dispatched.push({ kind: 'ask', prompt: prompt, askId: askId });
    return true;
  };
  dispatchResume = function () {
    dispatched.push({ kind: 'resume', args: Array.prototype.slice.call(arguments, 0, 3) });
    return true;
  };
  fetchProgress = function () { return null; };

  const BOARD_ASK  = '\u{1F680} *U0BP6PJQGKB-20260820-132620*\u3000\`ask\`\u3000(0/1)';
  const BOARD_RA   = '\u{1F680} *VIPOP-46703*\u3000\`ra-pipeline\`\u3000(2/4)';
  const reset = function () { posted.length = 0; dispatched.length = 0; fetchCalls = 0; };
  const conv = function (ts) { return { provider:'slack', channel:'C1', thread: ts }; };

  // ── ① 樣式：提問編號不可以被吃成單號 ───────────────────────────
  assert.strictEqual(_extractJiraKey_('U0BP6PJQGKB-20260820-132620 再試一次'), '',
    '提問編號的前半段長得像單號，但它不是單號');
  assert.strictEqual(_extractJiraKey_('幫 VIPOP-46703 寫規格書'), 'VIPOP-46703',
    '真的單號還是要撈得到');
  assert.strictEqual(_extractJiraKey_('VIPOP-46703 的事'), 'VIPOP-46703');
  ok('單號樣式排除 ask 提問編號（而且只有一份樣式，router 與反查共用）');

  // ── ② ask 串：任何一句都是追問，不是答覆 ───────────────────────
  // 這就是那則「請改成明確指定題號」的原始情境。
  threadMsgs = [H('<@UALICE> ask 幫我查登入流程'), B(BOARD_ASK)];
  reset();
  const r1 = _resolveRouteFromThread_(conv('1700.1'), provider);
  assert.strictEqual(r1.kind, 'ask');
  assert.strictEqual(r1.ask, 'U0BP6PJQGKB-20260820-132620');
  assert.strictEqual(r1.j, '', 'ask 串沒有單號可言');

  const i1 = classifyIntent('再試一次', conv('1700.1'), provider);
  assert.strictEqual(i1.action, 'ask_followup');
  assert.strictEqual(i1.matchedBy, 'ask-thread');
  assert.notStrictEqual(i1.action, 'answer_question');

  reset();
  routeByIntent('再試一次', conv('1700.1'), 'U1', provider);
  assert.strictEqual(dispatched.length, 1);
  assert.strictEqual(dispatched[0].kind, 'ask', '要接續 ask，不可以走 dispatchResume');
  assert.strictEqual(dispatched[0].prompt, '再試一次');
  assert.strictEqual(dispatched[0].askId, 'U0BP6PJQGKB-20260820-132620',
    '追問要回到同一支分支，否則 agent 看不到上文');
  assert.ok(!posted.some(t => t.indexOf('指定題號') >= 0),
    '這一則就是 bug 的長相：ask 串裡不該出現「請指定題號」');
  ok('ask 串內「再試一次」→ 接續同一支分支，不再被要求指定題號');

  // ── ③ 提問句自帶單號 → 那是提問內容，不是這串的歸屬 ─────────────
  // Alice 回在觸發訊息底下，所以第一則是人打的那句話。它帶著單號時，
  // 舊寫法會把整串判成那張單的決策 thread——而那個判斷還會被快取六小時。
  threadMsgs = [H('<@UALICE> ask VIPOP-46703 的規格寫到哪了'), B(BOARD_ASK)];
  reset();
  const r2 = _resolveRouteFromThread_(conv('1700.2'), provider);
  assert.strictEqual(r2.kind, 'ask');
  assert.strictEqual(r2.j, '', '單號在提問內容裡，不代表這串是那張單的 thread');
  assert.strictEqual(classifyIntent('再試一次', conv('1700.2'), provider).action, 'ask_followup');
  ok('ask 的提問句自帶單號 → 仍然是 ask 串（ask 優先於單號）');

  // ── ④ 看板還沒推上來 → 照樣認定是 ask 串，而且不快取 ───────────
  // 不快取是關鍵：看板一到就要接得起來。而「認定是 ask 串」也是必要的——
  // 提問句帶著單號時，退回去當任務串會把整串鎖死成錯的歸屬。
  threadMsgs = [H('<@UALICE> ask VIPOP-46703 的規格寫到哪了'),
                B('\u{1F50D} 收到 <@U1> 的提問，正在查…')];
  reset();
  const r3 = _resolveRouteFromThread_(conv('1700.3'), provider);
  assert.strictEqual(r3.kind, 'ask');
  assert.strictEqual(r3.ask, '', '還沒有編號＝當新的一輪');
  threadMsgs = [H('<@UALICE> ask VIPOP-46703 的規格寫到哪了'), B(BOARD_ASK)];
  const r3b = _resolveRouteFromThread_(conv('1700.3'), provider);
  assert.strictEqual(r3b.ask, 'U0BP6PJQGKB-20260820-132620',
    '看板推上來之後要接得起來（所以剛才那次不可以進快取）');
  ok('看板還沒推上來 → 仍是 ask 串、不快取，看板一到就接上');

  // ── ⑤ 任務串不可以被 ask 規則搶走 ───────────────────────────────
  // 決策 thread 裡的「用 A 方案」必須還是答覆。歸屬看**第一則**，所以就算
  // 有人在同一串裡打過 @Alice ask（串裡因此多了一則 ask 看板），也不會變。
  threadMsgs = [H('<@UALICE> ra VIPOP-46703'), B(BOARD_RA), B(BOARD_ASK)];
  reset();
  const r4 = _resolveRouteFromThread_(conv('1700.4'), provider);
  assert.strictEqual(r4.kind, 'jira');
  assert.strictEqual(r4.j, 'VIPOP-46703');
  const i4 = classifyIntent('用 A 方案', conv('1700.4'), provider);
  assert.strictEqual(i4.action, 'answer_question');
  assert.strictEqual(i4.jiraId, 'VIPOP-46703');
  ok('任務串仍然是答覆（歸屬看第一則——串裡多一則 ask 看板不會改變歸屬）');

  // ── ⑥ 兩種歸屬都只反查一次 ──────────────────────────────────────
  // 這一條擋的是效能回歸：3 秒預算很緊，而「答覆決策」是最熱的那條路。
  threadMsgs = [H('<@UALICE> ask 幫我查登入流程'), B(BOARD_ASK)];
  reset();
  classifyIntent('再試一次', conv('1700.5'), provider);
  assert.strictEqual(fetchCalls, 1);
  classifyIntent('那第二點再展開', conv('1700.5'), provider);
  assert.strictEqual(fetchCalls, 1, 'ask 串的歸屬要進快取');
  threadMsgs = [H('<@UALICE> ra VIPOP-46703'), B(BOARD_RA)];
  reset();
  classifyIntent('用 A 方案', conv('1700.6'), provider);
  assert.strictEqual(fetchCalls, 1);
  classifyIntent('改用 B', conv('1700.6'), provider);
  assert.strictEqual(fetchCalls, 1, '任務串的歸屬也要進快取（同一份，不是兩份）');
  ok('兩種歸屬共用同一份快取，同一 thread 只反查一次');

  // ── ⑦ 反查失敗 → 兩邊都降級，不可以自作聰明 ─────────────────────
  threadMsgs = null;
  reset();
  const r5 = _resolveRouteFromThread_(conv('1700.7'), provider);
  assert.strictEqual(r5.err, 'fetch-failed');
  assert.strictEqual(r5.kind, '');
  assert.strictEqual(classifyIntent('再試一次', conv('1700.7'), provider).matchedBy, 'route-failed');
  ok('反查失敗 → 講出原因（缺 scope），不當成任何一種歸屬');
  `);
}


// ══════════════════════════════════════════════════════════════════
console.log('\n[3e-3] github.js — dispatchAsk 的 ask_id 契約');
// ask-workflow.yml 的 Validate input 有一份同樣的樣式檢查。兩邊都要驗：
// 這邊擋下就降級成新的一輪（人拿得到答案），那邊是因為不能相信呼叫端。
// ══════════════════════════════════════════════════════════════════
{
  const env = mkEnv();
  Object.assign(global, env.globals);
  const sent = [];
  env.props.set('GITHUB_TOKEN', 'gh-token');
  global.UrlFetchApp = { fetch: (url, opt) => {
    sent.push(JSON.parse(opt.payload));
    return { getResponseCode: () => 204, getContentText: () => '' };
  }};

  eval(src(['slackBotProxy/core/github.js']) + `
  const CONV = { provider:'slack', channel:'C1', thread:'1.1' };

  sent.length = 0;
  dispatchAsk('查一下', 'U1', CONV, 'U1-20260820-132620');
  assert.strictEqual(sent[0].client_payload.ask_id, 'U1-20260820-132620');
  ok('合法的 ask_id → 放進 client_payload');

  // 沒有續問時**不放這個欄位**（不是放空字串）：ask-workflow 那邊用
  // \`[ -n "$ASK_CONTINUE_ID" ]\` 判斷，兩邊的真值表要一致才不會日後對不上
  sent.length = 0;
  dispatchAsk('查一下', 'U1', CONV, '');
  assert.ok(!('ask_id' in sent[0].client_payload), '沒有續問就不該有 ask_id 欄位');
  sent.length = 0;
  dispatchAsk('查一下', 'U1', CONV);
  assert.ok(!('ask_id' in sent[0].client_payload), '未傳參數時同理');
  ok('無續問 → 不放 ask_id 欄位（不是放空字串）');

  // 樣式不符一律降級。ask_id 會直接變成 git 分支名，這是安全邊界。
  sent.length = 0;
  dispatchAsk('查一下', 'U1', CONV, '../../etc/passwd');
  assert.ok(!('ask_id' in sent[0].client_payload), '非法字元不可進 payload——它會變成分支名');
  sent.length = 0;
  dispatchAsk('查一下', 'U1', CONV, 'VIPOP-46703');
  assert.ok(!('ask_id' in sent[0].client_payload), 'JIRA 單號不是提問編號');
  ok('樣式不符 → 降級成新的一輪（ask_id 會變成分支名，這是安全邊界）');

  // client_payload 的 top-level 屬性上限是 10 個
  sent.length = 0;
  dispatchAsk('查一下', 'U1', CONV, 'U1-20260820-132620');
  assert.ok(Object.keys(sent[0].client_payload).length <= 10,
    'client_payload top-level 屬性上限 10 個，實際 ' + Object.keys(sent[0].client_payload).length);
  ok('client_payload 屬性數仍在 GitHub 的 10 個上限內');
  `);
}


// ══════════════════════════════════════════════════════════════════
console.log('\n[3f] slackBotProxy — 反問時的「當成一般提問送出」按鈕');
// 保留「規則接不住就反問，不猜」這個原則，同時讓那個能力離一次點擊。
// ══════════════════════════════════════════════════════════════════
{
  const env = mkEnv();
  Object.assign(global, env.globals);
  const posted = [], dispatched = [], transient = [];
  const provider = {
    name: 'slack',
    mention: MENTION,
    fetchThreadRoot: () => '',
    postMessage: (ch, text, thread, blocks) => { posted.push({ text: text, blocks: blocks }); return { ts: '1700.9' }; },
    postAccepted: (conv, text) => { posted.push({ text: text, blocks: null });
      return { provider:'slack', channel: conv.channel, thread: '1700.9', status_ts: '1700.9' }; },
    notifyTransient: (i, t) => { transient.push(t); },
    parseInteraction: (p) => p,
  };

  // 這一節要驗 parseInteraction 的相容性，所以連 provider 一起載入
  eval(src(INTENT_SRC.concat(['slackBotProxy/providers/slack.js'])) + `
  dispatchAsk = function (prompt, uid, conv) { dispatched.push(prompt); return true; };

  // 這一節驗的是按鈕本身，所以 blocks 交給**真的** SlackProvider 去組：
  // value 的 2000 字上限、kind / k 的結構都是它的責任（core 只給 offerKey）。
  // 在 eval 內覆寫是必要的——mock 住在 node 這一側，取不到 SlackProvider。
  provider.postIntentHelp = function (conv, o) {
    posted.push({ text: o.text, blocks: SlackProvider._askOfferBlocks_(o.offerKey) });
    return { ts: '1700.9' };
  };

  const OUT = { provider:'slack', channel:'C9', thread:null };
  const findBtn = () => {
    for (const p of posted) {
      const b = (p.blocks || []).find(x => x.type === 'actions');
      if (b) return JSON.parse(b.elements[0].value);
    }
    return null;
  };

  // 真的沒聽懂 → 給按鈕
  posted.length = 0;
  routeByIntent('速速前 幫我查ui的code', OUT, 'U1', provider);
  const btn = findBtn();
  assert.ok(btn, 'no-match ＋ 有密語時要附上按鈕');
  assert.strictEqual(btn.kind, 'ask_confirm');
  assert.ok(btn.k && btn.k.indexOf('askq_') === 0, 'value 只放快取鍵');
  assert.ok(JSON.stringify(btn).length < 2000, 'Slack 按鈕 value 上限 2000 字元');
  ok('no-match ＋ 有密語 → 附「當成一般提問送出」按鈕（value 只放快取鍵）');

  // 沒有密語就不附按鈕：附一顆按下去會被擋的按鈕，只會讓人以為壞了
  posted.length = 0;
  routeByIntent('幫我查ui的code', OUT, 'U1', provider);
  assert.strictEqual(findBtn(), null, '沒有密語時不該附按鈕');
  ok('沒有密語 → 連按鈕都不附（不給按不動的東西）');

  // 有更具體下一步的 unknown 不給按鈕：補上缺的那半就能跑對的流程，
  // 丟給通用 agent 只會得到一個比較差的答案
  posted.length = 0;
  routeByIntent('幫我RA流程', OUT, 'U1', provider);
  assert.strictEqual(findBtn(), null, 'verb-no-jira 有更好的下一步，不該給按鈕');
  posted.length = 0;
  routeByIntent('VIPOP-12345', OUT, 'U1', provider);
  assert.strictEqual(findBtn(), null, 'jira-no-verb 同理');
  ok('verb-no-jira / jira-no-verb 不給按鈕（反問本身就是更好的下一步）');

  // 按下去 → 走與 @Alice ask 完全相同的入口
  posted.length = 0; dispatched.length = 0;
  routeByIntent('速速前 幫我查ui的code', OUT, 'U2', provider);
  const btn2 = findBtn();
  const click = { kind:'ask_confirm', askKey: btn2.k, userId:'U2', user:'<@U2>',
                  conversation:{ provider:'slack', channel:'C9', thread:null } };
  handleInteraction(click, provider, null);
  assert.strictEqual(dispatched.length, 1);
  assert.strictEqual(dispatched[0], '幫我查ui的code', '要送出原句（去掉密語），不是按鈕的文字');
  ok('按下按鈕 → 用原句走 handleAskRequest（與 @Alice ask 同一條路）');

  // 連點兩下不該送兩次——那是再燒一台 runner
  transient.length = 0; dispatched.length = 0;
  handleInteraction(click, provider, null);
  assert.strictEqual(dispatched.length, 0);
  assert.ok(transient.some(t => t.indexOf('送出過') >= 0));
  ok('連點第二下 → 擋下（先刪快取再送，所以第二次讀不到）');

  // 快取過期（TTL 15 分鐘）
  transient.length = 0; dispatched.length = 0;
  handleInteraction({ kind:'ask_confirm', askKey:'askq_不存在', userId:'U2',
                      conversation:{ channel:'C9', thread:null } }, provider, null);
  assert.strictEqual(dispatched.length, 0);
  assert.ok(transient.some(t => t.indexOf('15 分鐘') >= 0));
  ok('快取過期 → 請他重講一次，不送出一句他早就忘了的話');

  // 舊卡片的 value 裡沒有 kind，必須仍被當成決策按鈕
  const legacy = SlackProvider.parseInteraction({
    actions: [{ value: JSON.stringify({ question_id:'Q-001', choice:'A', jira_id:'VIPOP-1' }) }],
    user: { id:'U1' }, channel: { id:'C1' }, message: { ts:'1.1' }
  });
  assert.strictEqual(legacy.kind, 'decision', '沒有 kind 的舊卡片要退回 decision');
  ok('舊卡片（value 無 kind）仍走決策路徑——那些卡片可能已躺在 thread 裡好幾天');
  `);
}


// ══════════════════════════════════════════════════════════════════
console.log('\n[3g] slackBotProxy — Alice 回在觸發訊息底下');
// 實戰體感換來的：人在頻道貼一段長提問，Alice 卻在頻道裡**另起一則新訊息**才
// 開始回，於是提問與回答變成兩件看起來不相干的事，提問越長越明顯。
//
// 修法是把「我在哪個 thread」與「我要回哪裡」拆成兩個欄位（core/conv.js）：
//   thread  ── 真的在 thread 裡才有值。null 是兩支反查省掉一次 Slack API 的依據，
//              也是「不在 thread 裡」與「在 thread 裡但查不到單號」的分界
//   replyTo ── 觸發訊息自己的 ts。Alice 貼在它底下，讓它成為那則的 thread
// ══════════════════════════════════════════════════════════════════
{
  const env = mkEnv({ SLACK_TOKEN: 'xoxb-fake' });
  Object.assign(global, env.globals);

  eval(src(['slackBotProxy/core/conv.js', 'slackBotProxy/providers/slack.js']) + `
  // ── 錨點優先序 ──────────────────────────────────────────────────
  assert.strictEqual(_replyTarget_({ channel:'C1', thread:'1700.1', replyTo:'1700.5' }), '1700.1',
    '已經在 thread 裡就回那個 thread——Slack 不支援 thread 內再開 thread');
  assert.strictEqual(_replyTarget_({ channel:'C1', thread:null, replyTo:'1700.5' }), '1700.5',
    '頻道裡直接 @ → 回在他那則底下');
  assert.strictEqual(_replyTarget_({ channel:'C1', thread:null }), null,
    'slash command 沒有訊息可掛 → 頻道層級');
  assert.strictEqual(_replyTarget_(null), null);
  ok('_replyTarget_：thread ＞ replyTo ＞ 頻道層級');

  // ── postAccepted 要把受理訊息貼在觸發訊息底下 ────────────────────
  const sent = [];
  SlackProvider.postMessage = function (ch, text, threadTs) {
    sent.push({ ch: ch, threadTs: threadTs });
    return { ts: '1700.9' };   // Alice 自己那則的 ts
  };

  sent.length = 0;
  let anchored = SlackProvider.postAccepted({ channel:'C1', thread:null, replyTo:'1700.5' }, '受理');
  assert.strictEqual(sent[0].threadTs, '1700.5', '受理訊息要掛在觸發訊息底下');
  assert.strictEqual(anchored.thread, '1700.5',
    '後續（進度、答案、追問）全部回到同一串——這個值幾分鐘後就沒有事件可以重新推導');
  assert.strictEqual(anchored.status_ts, '1700.9',
    'status_ts 必須是 Alice 自己那則：拿別人的訊息去 chat.update 會被 Slack 拒絕');
  ok('頻道內觸發 → 受理訊息成為觸發訊息的 thread，狀態列仍指向 Alice 自己那則');

  sent.length = 0;
  anchored = SlackProvider.postAccepted({ channel:'C1', thread:'1700.1', replyTo:'1700.5' }, '受理');
  assert.strictEqual(sent[0].threadTs, '1700.1', '既有 thread 內觸發 → 沿用那個 thread');
  assert.strictEqual(anchored.thread, '1700.1');
  ok('既有 thread 內觸發 → 沿用原 thread（不會拆成另一串）');

  sent.length = 0;
  anchored = SlackProvider.postAccepted({ channel:'C1', thread:null }, '受理');
  assert.strictEqual(sent[0].threadTs, null, 'slash command 沒有可掛的訊息');
  assert.strictEqual(anchored.thread, '1700.9', '那時才退回用自己的 ts 當錨點');
  ok('slash command → 頻道層級，並用自己那則當後續錨點');

  // ── fetchThreadRoot 仍然只看第一則 ─────────────────────────────
  // 這一條是安全邊界：單號反查絕不能改成掃整串。Alice 自己的訊息裡有**範例**
  // 單號（「例：\`@Alice ra VIPOP-12345\`」），掃到它的後果是答案被寫進別張單。
  const realFetchTexts = SlackProvider.fetchThreadTexts;
  SlackProvider.fetchThreadTexts = function () {
    return [
      { text: '@Alice ra VIPOP-46703', bot: false },
      { text: '⚠️ 請提供 Jira ID（例：\`@Alice ra VIPOP-12345\`）', bot: true }
    ];
  };
  assert.strictEqual(SlackProvider.fetchThreadRoot('C1', '1700.1'), '@Alice ra VIPOP-46703',
    '單號只認第一則——Alice 訊息裡的範例單號不可以參與反查');
  SlackProvider.fetchThreadTexts = function () { return null; };
  assert.strictEqual(SlackProvider.fetchThreadRoot('C1', '1700.1'), null,
    '讀不到要回 null（不是空字串）：上層靠這個分辨「缺 scope」與「沒有單號」');
  SlackProvider.fetchThreadTexts = function () { return []; };
  assert.strictEqual(SlackProvider.fetchThreadRoot('C1', '1700.1'), '');
  ok('fetchThreadRoot 只取第一則（範例單號不會被誤認）、讀不到回 null');

  // ── 同一次執行只打一次 conversations.replies ─────────────────────
  // 單號反查與提問編號反查是兩支獨立的邏輯，但問的是同一串。3 秒預算下多打一次
  // API 就可能讓 Slack 判逾時並重送整個事件（重送的後果見 _isDuplicateEvent_）。
  SlackProvider.fetchThreadTexts = realFetchTexts;   // 還原成真的實作
  let fetches = 0;
  UrlFetchApp.fetch = function (url) {
    fetches++;
    assert.ok(url.indexOf('limit=' + THREAD_SCAN_LIMIT) > 0, 'limit 要帶上：' + url);
    return { getContentText: () => JSON.stringify({ ok: true, messages: [
      { text: '速速前 幫我查登入流程', user: 'U1' },
      { text: '\u{1F680} *U1-20260820-132620*\u3000\`ask\`\u3000(1/1)', bot_id: 'B123' }
    ]})};
  };

  const msgs = SlackProvider.fetchThreadTexts('C1', '1700.5');
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].bot, false, '人打的那則不可以被標成 bot');
  assert.strictEqual(msgs[1].bot, true, 'bot_id 就是 Alice 自己發的憑據');
  SlackProvider.fetchThreadTexts('C1', '1700.5');
  SlackProvider.fetchThreadRoot('C1', '1700.5');
  assert.strictEqual(fetches, 1, '同一次執行、同一串 → 只打一次 API');
  SlackProvider.fetchThreadTexts('C1', '1700.6');
  assert.strictEqual(fetches, 2, '不同串當然要各打一次');
  ok('fetchThreadTexts 標出 bot 訊息，且同一次執行內共用同一次 API 呼叫');
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
  global.getProvider = () => ({ name: 'slack', mention: MENTION, postIntentHelp: INTENT_HELP, postMessage: () => ({}) });

  eval(src(['slackBotProxy/core/conv.js', 'slackBotProxy/core/github.js',
            'slackBotProxy/core/decision.js', 'slackBotProxy/core/intent.js',
            'slackBotProxy/slackBotProxy.js']) + `
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

  // 自由提問的答案
  outCalls.length = 0;
  doPost({ parameter:{ k:'secret' }, postData:{ contents: JSON.stringify({
    action:'ask_result', ask_id:'U1-20260820-143000',
    conversation:{ channel:'C1', thread:'1700.1' },
    answer:'登入流程在 src/auth/login.ts:42（OAuth2 授權碼流程）。', status:'completed', truncated:false
  })}});
  assert.ok(outCalls.join('').indexOf('src/auth/login.ts:42') >= 0);
  ok('ask_result → 答案原樣貼回 thread');

  // 沒答案時**一定要**發訊息：人收到的最後一則是「已收到，正在查」，
  // 沉默會讓他一直等，然後再問一次——又燒一次 runner。
  outCalls.length = 0;
  doPost({ parameter:{ k:'secret' }, postData:{ contents: JSON.stringify({
    action:'ask_result', ask_id:'U1-x', conversation:{ channel:'C1' },
    answer:'', status:'failed', error:'agent 逾時', run_url:'https://x/runs/1'
  })}});
  let am = outCalls.join(String.fromCharCode(10));
  assert.ok(am.indexOf('沒能回答') >= 0, '沒有答案也必須明講，不能沉默');
  assert.ok(am.indexOf('agent 逾時') >= 0, '有錯誤訊息就要帶出來');
  assert.ok(am.indexOf('runs/1') >= 0, '要給執行記錄連結');
  ok('ask_result 無答案 → 明講失敗 ＋ 原因 ＋ 執行記錄（不沉默）');

  // 逾時與「出錯」的下一步不同，訊息要分得開
  outCalls.length = 0;
  doPost({ parameter:{ k:'secret' }, postData:{ contents: JSON.stringify({
    action:'ask_result', ask_id:'U1-y', conversation:{ channel:'C1' },
    answer:'', status:'unknown'
  })}});
  assert.ok(outCalls.join('').indexOf('換個更具體的問法') >= 0);
  ok('無答案且無錯誤 → 給可行動的建議，而不是只說失敗');

  // 截斷時要說清楚完整版在哪，以及那個位置會過期
  outCalls.length = 0;
  doPost({ parameter:{ k:'secret' }, postData:{ contents: JSON.stringify({
    action:'ask_result', ask_id:'U1-z', conversation:{ channel:'C1' },
    answer:'很長的答案', status:'completed', truncated:true
  })}});
  am = outCalls.join('');
  assert.ok(am.indexOf('ask/U1-z') >= 0 && am.indexOf('三天') >= 0,
    '截斷時要指出完整版在哪支分支，並說明它會被清掉');
  ok('ask_result 截斷 → 指出分支位置與保留期限');

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


// ══════════════════════════════════════════════════════════════════
console.log('\n[7] messageDispatch — 記憶決策卡片（出向）');
// 記憶決策沒有 jira_id、也**沒有 conversation 錨點**（每日 cron 沒有任何人
// 發過訊息）。缺 MEMORY_CHANNEL 時必須明確報錯——靜默降級的症狀是
// 「卡片永遠不出現」，而沒有人會想到是少設一個 Script Property。
// ══════════════════════════════════════════════════════════════════
{
  const env = mkEnv({ NOTIFY_KEY: 'secret', MEMORY_CHANNEL: 'C-MEM' });
  Object.assign(global, env.globals);
  const calls = [];
  const provider = {
    name: 'slack',
    postMemoryDecision: (conv, ctx) => {
      calls.push({ kind: 'card', channel: conv.channel, memoryId: ctx.memoryId,
                   n: ctx.questions.length });
      return '1800.1';
    },
    postMessage: (ch, text, thread) => { calls.push({ kind: 'msg', ch, text, thread }); return {}; },
  };
  global.getProvider = () => provider;

  eval(src(['messageDispatch/core/outbound.js',
            'messageDispatch/core/memory.js',
            'messageDispatch/MessageDispatch.gs.js']) + `
  const Q = [{ id:'M-001', question:'A 與 B 標了衝突', context:'矛盾點',
               atoms:['a.rule.x','b.rule.y'],
               options:['A: 以《A》為準','B: 以《B》為準','C: 其實不衝突'] }];

  // ① conversation 是空物件（augma 一律這樣送）→ 退回 MEMORY_CHANNEL
  let res = doPost({ parameter:{ k:'secret' }, postData:{ contents: JSON.stringify({
    action:'memory', memory_id:'mem.20260824.031500', conversation:{}, questions:Q })}});
  assert.deepStrictEqual(calls[0], { kind:'card', channel:'C-MEM',
                                     memoryId:'mem.20260824.031500', n:1 });
  assert.ok(res._t.indexOf('"status":"ok"') >= 0);
  ok('memory → 沒有錨點時貼到 MEMORY_CHANNEL');

  // ② 缺 memory_id → 不貼卡片。發一張按了沒反應的卡片比不發更糟。
  calls.length = 0;
  res = doPost({ parameter:{ k:'secret' }, postData:{ contents: JSON.stringify({
    action:'memory', conversation:{}, questions:Q })}});
  assert.strictEqual(calls.length, 0);
  assert.ok(res._t.indexOf('Missing memory_id') >= 0, res._t);
  ok('缺 memory_id → 明確報錯且不貼卡片');

  // ③ 錯的 NOTIFY_KEY → 擋下
  calls.length = 0;
  res = doPost({ parameter:{ k:'wrong' }, postData:{ contents: JSON.stringify({
    action:'memory', memory_id:'mem.20260824.031500', conversation:{}, questions:Q })}});
  assert.strictEqual(calls.length, 0);
  assert.ok(res._t.indexOf('Unauthorized') >= 0);
  ok('錯誤的 NOTIFY_KEY → 擋下且不貼任何東西');

  // ④ memory_result 走 conversation 帶回來的錨點，不是預設頻道
  calls.length = 0;
  res = doPost({ parameter:{ k:'secret' }, postData:{ contents: JSON.stringify({
    action:'memory_result', memory_id:'mem.20260824.031500', question_id:'M-001',
    status:'ok', text:'✓ b.rule.y → deprecated',
    conversation:{ channel:'C-MEM', thread:'1800.1' } })}});
  assert.strictEqual(calls[0].kind, 'msg');
  assert.strictEqual(calls[0].thread, '1800.1', '結果要掛在卡片底下，不是另開一則');
  assert.ok(calls[0].text.indexOf('M-001') >= 0);
  assert.ok(calls[0].text.indexOf('deprecated') >= 0, '原樣貼 kg.py 的輸出');
  ok('memory_result → 掛在卡片的 thread 底下並原樣貼出圖譜改動');

  // ⑤ 失敗也必須發訊息。人看到的最後一則是卡片上的「已定案」——
  //    沉默的話他會以為裁決生效了。
  calls.length = 0;
  doPost({ parameter:{ k:'secret' }, postData:{ contents: JSON.stringify({
    action:'memory_result', question_id:'M-001', status:'failed', text:'卡片已過期',
    conversation:{ channel:'C-MEM', thread:'1800.1' } })}});
  assert.strictEqual(calls.length, 1, '失敗不可以沉默');
  assert.ok(calls[0].text.indexOf('沒有套用成功') >= 0, calls[0].text);
  ok('memory_result 失敗 → 明講沒有套用成功（不沉默）');
  `);
}

// 卡片的連結要真的可點。只印原子 id 等於要人自己去 grep 中文檔名——
// 實戰第一張卡片就踩到了，所以這條要有測試守著。
{
  // NL 是各節自己宣告的區域變數（見 [0] / [2] 節），這一節也要一份
  const NL = String.fromCharCode(10);
  const sandbox = { PropertiesService: null, UrlFetchApp: null, console: console,
                    _replyTarget_: () => null };
  require('vm').createContext(sandbox);
  require('vm').runInContext(
    fs.readFileSync(path.join(ROOT, 'messageDispatch/providers/slack.js'), 'utf8') + NL +
    'this.__slack = SlackProvider;', sandbox);

  let posted = null;
  const P = sandbox.__slack;
  P.postMessage = function (ch, text, thread, blocks) { posted = { ch, text, blocks }; return { ts: '1' }; };

  P.postMemoryDecision({ channel: 'C-MEM' }, {
    memoryId: 'mem.20260824.031500',
    repo: '104corp/104.vip.f2e.augma',
    questions: [{
      id: 'M-002', question: 'A 與 B 衝突',
      atoms: ['vipadm.pitfall.script-setup-gap', 'vipadm.convention.eslint-and-coding'],
      refs: [
        { id: 'vipadm.pitfall.script-setup-gap', title: '規範說用 script setup',
          path: 'docs/repo_knowledge/vipadm_2022/knowledge/平台共通/規範說用 script setup，但 137 個 .vue 只有 1 個是.md' },
        { id: 'vipadm.convention.eslint-and-coding', title: 'ESLint、coding.md 約定',
          path: 'docs/repo_knowledge/vipadm_2022/knowledge/平台共通/ESLint、coding.md 約定與 Commit／PR 規範.md' }
      ],
      options: ['A: 以前者為準', 'B: 以後者為準', 'C: 其實不衝突', 'D: 兩者都對']
    }]
  });

  const blob = JSON.stringify(posted.blocks);
  assert.ok(blob.indexOf('https://github.com/104corp/104.vip.f2e.augma/blob/main/') >= 0,
    '必須給 GitHub 連結，不能只印 id');
  assert.ok(blob.indexOf('%20') >= 0 || blob.indexOf('%E') >= 0,
    '路徑含中文與空白，必須 encodeURI——不編碼 Slack 會把連結截在第一個空白處');
  assert.ok(blob.indexOf('規範說用 script setup<') < 0, '連結文字要用 title');
  ok('卡片給可點的 GitHub 連結，且路徑經過 encodeURI');

  // 四個選項要各自對應一顆按鈕，而且送出的 choice 是**字母**
  const actions = posted.blocks.filter(function (b) { return b.type === 'actions'; })[0];
  assert.strictEqual(actions.elements.length, 4, '四個選項＝四顆按鈕');
  const vals = actions.elements.map(function (e) { return JSON.parse(e.value).choice; });
  assert.deepStrictEqual(vals, ['A', 'B', 'C', 'D'], '送字母，且與選項索引對稱');
  ok('四個選項各一顆按鈕，choice 是 A/B/C/D（與 augma 的索引對稱）');

  // 舊 payload（只有 atoms、沒有 refs）要退回印 id，不能爆掉
  posted = null;
  P.postMemoryDecision({ channel: 'C-MEM' }, {
    memoryId: 'mem.20260824.031500', repo: '104corp/x',
    questions: [{ id: 'M-001', question: 'x', atoms: ['a.b.c'], options: ['A: a', 'B: b'] }]
  });
  assert.ok(JSON.stringify(posted.blocks).indexOf('a.b.c') >= 0, '沒有 refs 時退回印 id');
  ok('舊 payload（無 refs）退回印 id，不爆掉');
}

// 缺 MEMORY_CHANNEL 要單獨一個 env——它是「沒設定」而不是「設成空字串」。
{
  const env = mkEnv({ NOTIFY_KEY: 'secret' });
  Object.assign(global, env.globals);
  const calls = [];
  global.getProvider = () => ({ name:'slack',
    postMemoryDecision: () => { calls.push('card'); return '1'; },
    postMessage: () => { calls.push('msg'); return {}; } });

  eval(src(['messageDispatch/core/outbound.js',
            'messageDispatch/core/memory.js',
            'messageDispatch/MessageDispatch.gs.js']) + `
  const res = doPost({ parameter:{ k:'secret' }, postData:{ contents: JSON.stringify({
    action:'memory', memory_id:'mem.20260824.031500', conversation:{},
    questions:[{ id:'M-001', question:'x', options:['A: a','B: b'] }] })}});
  assert.strictEqual(calls.length, 0, '沒有頻道就不該貼任何東西');
  assert.ok(res._t.indexOf('MEMORY_CHANNEL') >= 0, '錯誤訊息要指名要設哪個 key：' + res._t);
  ok('缺 MEMORY_CHANNEL → 明確報錯並指名要設哪個 key（不靜默降級）');
  `);
}


// ══════════════════════════════════════════════════════════════════
console.log('\n[8] slackBotProxy — 記憶裁決按鈕（入向）');
// 這一節守的是**分岔**：kind:'memory' 必須在所有決策邏輯之前被接走。
// 流過去的話會拿 undefined 的 jiraId 去組去重鍵（`ans_undefined_M-001`，
// 所有記憶題共用同一把鎖）、去讀 fetchProgress(undefined)、走 dispatchResume。
// 症狀是「按了沒反應，而且 Actions 完全沒有紀錄」。
// ══════════════════════════════════════════════════════════════════
{
  const env = mkEnv({ NOTIFY_KEY: 'secret', GITHUB_TOKEN: 'gh' });
  Object.assign(global, env.globals);

  const dispatched = [];
  const resolved = [];
  const transient = [];
  let dispatchOk = true;

  eval(src(INTENT_SRC.concat(['slackBotProxy/core/memory.js'])) + `
  // 只替換掉真正打網路的那一支，dispatchMemoryAnswer 本體（含樣式驗證）要真的跑
  dispatchWorkflow = function (payload) {
    dispatched.push(payload);
    return dispatchOk;
  };
  const provider = {
    notifyTransient: (i, t) => transient.push(t),
    resolveDecision: (conv, mid, info) => resolved.push(info),
    parseInteraction: () => null,
  };
  const mk = (over) => Object.assign({
    kind: 'memory', memoryId: 'mem.20260824.031500', questionId: 'M-001',
    choice: 'B', choiceLabel: 'B: 以《B》為準', user: '<@U1>', userId: 'U1',
    conversation: { provider:'slack', channel:'C-MEM', thread:'1800.1' },
    messageId: '1800.1', blocks: [{ block_id:'decision_actions_M-001' }], responseUrl: null
  }, over || {});

  // ① 正常路徑：dispatch 的是 memory-answer，不是 resume
  let res = handleMemoryInteraction(mk(), provider);
  assert.strictEqual(dispatched.length, 1);
  assert.strictEqual(dispatched[0].event_type, 'memory-answer');
  assert.strictEqual(dispatched[0].client_payload.memory_id, 'mem.20260824.031500');
  assert.strictEqual(dispatched[0].client_payload.choice, 'B', '送字母，不送選項全文');
  assert.strictEqual(dispatched[0].client_payload.conversation.thread, '1800.1',
    'augma 沒有 progress.json 可以反查錨點，錨點必須隨答案一起送');
  assert.strictEqual(resolved[0].choice, 'B: 以《B》為準',
    '卡片上要顯示人話，不是一個字母');
  assert.strictEqual(res._t, '', '互動回應必須是空 body，否則 Slack 會用它替換整張卡片');
  ok('memory 按鈕 → dispatch memory-answer（帶錨點、送字母、卡片顯示人話）');

  // ② 連點：第二次不再 dispatch
  handleMemoryInteraction(mk(), provider);
  assert.strictEqual(dispatched.length, 1, '連點不可以重複 dispatch');
  assert.ok(transient.join('|').indexOf('本次點擊不生效') >= 0, transient.join('|'));
  ok('連點 → 去重，且告訴點擊者是誰先答的');

  // ③ 樣式陷阱：JIRA 形狀與 ask 形狀的 id 都必須被擋掉。
  //    這兩種在通訊層會被 thread 反查誤認（然後快取六小時），所以連 dispatch
  //    都不該送出去。
  dispatched.length = 0; transient.length = 0;
  handleMemoryInteraction(mk({ memoryId: 'MEM-20260824' }), provider);
  handleMemoryInteraction(mk({ memoryId: 'mem-20260824-031500' }), provider);
  assert.strictEqual(dispatched.length, 0,
    'JIRA 形狀與 ask 形狀的 memory_id 都必須被擋掉');
  assert.strictEqual(transient.length, 2);
  ok('memory_id 樣式不符（JIRA 形狀／ask 形狀）→ 擋下且不 dispatch');

  // ④ dispatch 失敗時**不可**把卡片標成已定案，而且要撤掉去重讓他能重試
  dispatched.length = 0; transient.length = 0; resolved.length = 0;
  dispatchOk = false;
  handleMemoryInteraction(mk({ questionId: 'M-002' }), provider);
  assert.strictEqual(resolved.length, 0, 'dispatch 失敗不可以標成已定案');
  assert.ok(transient.join('|').indexOf('沒有套用') >= 0, transient.join('|'));
  dispatchOk = true;
  handleMemoryInteraction(mk({ questionId: 'M-002' }), provider);
  assert.strictEqual(dispatched.length, 2, '失敗後要能再點一次（去重標記已撤掉）');
  ok('dispatch 失敗 → 不標定案、撤去重、可重試');
  `);
}

console.log('\n✅ ' + passed + ' 項全部通過\n');
