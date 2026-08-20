// ═══════════════════════════════════════════════════════════════════
//  自由提問：@Alice ask <任何問題>
//
//  規則層的意圖分類只認得四種動作（RA / SA / 查狀態 / 回答問題）。
//  「幫我查 ui 的 code」「這個 bug 你覺得是什麼原因」全部落在 no-match，
//  以前只能回一則「這句我沒把握」。這裡給它一條正式通道。
//
//  ⚠️ 這條路**不經過意圖分類**，與 ra / sa / answer 同一層級。
//     那是刻意的：意圖層掛掉時它還能用，而且熟手直接打指令更快。
//
//  ⚠️ 也刻意**不做 catch-all**——規則接不住時不會自動走到這裡。
//     理由是規則層分不出「這是給 agent 的任務」與「這是人在聊天」：
//     「今天天氣真好」與「幫我查 ui 的 code」的分類結果完全一樣（都是
//     no-match）。自動放行等於閒聊也會燒掉一個 runner，而整套架構最稀缺
//     的資源就是 runner（一台機器只有 3 個）。
//     要降低門檻的話，正確做法是在反問訊息上放一顆按鈕讓人**選擇**送出。
// ═══════════════════════════════════════════════════════════════════

// client_payload 上限 64 KB，但真正的理由不是那個：超過兩千字的「問題」
// 幾乎一定是貼錯東西（整份 log、整個檔案）。與其讓 agent 花八分鐘讀完再說
// 「我不確定你要問什麼」，不如當場擋下來。
const ASK_MAX_CHARS = 2000;

// 同一個人 60 秒內只受理一次。防的是手滑連送與「問完馬上補一句」——
// 每一次都是一個 runner，而 RA / SA 那些真正的工作要排在後面。
const ASK_THROTTLE_SEC = 60;


// ═══════════════════════════════════════════════════════════════════
//  通關密語（測試期間的閘門）
//
//  ask 每觸發一次就佔用一台 runner，而整台機器只有 3 個。測試期間如果有人
//  順手 @Alice 問東問西，RA / SA 那些真正的工作會排不進去。
//
//  預設**開啟**是刻意的：忘記設定時應該是「沒人能用」而不是「所有人都能用」。
//  要關掉必須明確把 ScriptProperties 的 `ASK_PASSPHRASE` 設成 `off`——
//  留空字串不算關閉，因為「不小心清空」與「刻意關閉」看起來會一模一樣。
//
//  密語會在送出前從問題裡拿掉：agent 收到 `速速前 幫我查 ui 的 code` 只會
//  困惑那三個字是什麼意思，甚至可能拿去查。
//
//  ⚠️ **一串只要一次。** 這個 thread 先前已經受理過一次 ask，之後的追問就不再
//     要密語。實戰體感換來的：串文裡每一句都要打「速速前 再試一次」很荒謬，
//     而那是最自然的追問情境。
//
//     閘門沒有因此變鬆——開出這一串的第一句仍然要密語，而能打出那一句的人
//     本來就有密語。拿到豁免的是**這個 thread**、不是某個人：別人順著同一串
//     追問是刻意允許的，那本來就是同一段對話（而且仍然吃同一份節流與長度上限）。
// ═══════════════════════════════════════════════════════════════════

const ASK_PASSPHRASE_DEFAULT = '速速前';

function _askPassphrase_() {
  const v = PropertiesService.getScriptProperties().getProperty('ASK_PASSPHRASE');
  if (v === null || v === undefined) return ASK_PASSPHRASE_DEFAULT;
  if (String(v).trim().toLowerCase() === 'off') return '';
  return String(v).trim() || ASK_PASSPHRASE_DEFAULT;
}

/** 回傳 { ok, prompt }。ok 為 true 時 prompt 已去掉密語。 */
function _checkAskPassphrase_(prompt) {
  const phrase = _askPassphrase_();
  if (!phrase) return { ok: true, prompt: prompt };

  const i = prompt.indexOf(phrase);
  if (i < 0) return { ok: false, prompt: prompt };

  const stripped = (prompt.slice(0, i) + prompt.slice(i + phrase.length))
    .replace(/[ \t]{2,}/g, ' ').trim();
  return { ok: true, prompt: stripped };
}

/**
 * 反問訊息要不要附上「當成一般提問送出」按鈕——沒有密語就不附，附了也按不動。
 *
 * conv / provider 是選用的：給了就套用與 handleAskRequest 同一條豁免規則
 * （這串受理過就不再要密語），否則只看密語。兩邊的答案必須一致——這裡說不行
 * 而那邊其實會受理，等於把一個能用的能力藏起來。
 */
function _askAllowed_(rawText, conv, provider) {
  if (_checkAskPassphrase_(String(rawText || '')).ok) return true;
  return !!(conv && provider && _resolveAskIdFromThread_(conv, provider));
}


// ═══════════════════════════════════════════════════════════════════
//  續問：同一個 thread 的追問要回到同一支 ask/<id> 分支
//
//  問題：一次提問一支分支（ask/<uid>-<timestamp>）是最省事的併發模型，但它
//  讓每一次追問都在**全新的空白工作區**裡開始。人在 thread 底下說「再試一次」
//  「那第二點再展開一下」時，agent 看到的只有那五個字，沒有上文——只能反問
//  「你要我重試什麼」。實際踩到過。
//
//  解法：不引入任何共享儲存，沿用 decision.js 那個「路由資訊就寫在訊息裡」的
//  作法。ask 的受理訊息會被 notify-progress.sh 就地 chat.update 成進度看板，
//  而看板標題帶著提問編號（`🚀 *U1-20260820-132620* \`ask\` (1/1)`）。
//  反查它即可，GAS 這側依舊零狀態。
//
//  ⚠️ 要掃**整串**，不能只讀第一則。Alice 的受理訊息現在是貼在觸發者那則底下
//     的回覆（見 core/conv.js），所以 thread 的第一則是人打的那句話，看板是
//     第二則。只讀第一則的話續問永遠接不起來——而它壞掉的樣子跟「功能沒做」
//     一模一樣：每次都開新分支、agent 每次都反問「要重試什麼」。
//
//  ⚠️ 只認 Alice 自己發的訊息（bot 旗標）。提問編號會直接變成 git 分支名，
//     人打的字不該有那個權力——否則貼一段別人的編號就能把追問寫進別人的分支。
//
//  ⚠️ 由舊到新取**第一個**命中的：那是開出這一串的那一輪，也就是這個 thread
//     真正歸屬的分支。取最新的話，串裡任何一次「反查失敗而新開的輪次」都會把
//     歸屬搶走，於是同一串會在兩支分支之間跳。
//
//  ⚠️ 反查失敗一律回空字串＝開新的一輪，**絕不因此擋下提問**。
//     沒有上文的答案仍然有用；擋下來他就什麼都沒有。
//
//  ⚠️ 只快取命中的結果。第一輪的看板此刻可能還沒推上來（Alice 的訊息還是
//     「正在查…」），快取了那次的 miss 會讓這個 thread 從此再也接不起來。
// ═══════════════════════════════════════════════════════════════════

// 樣式要夠緊，否則會把別的 thread 認成 ask thread。JIRA 單號（VIPOP-46703）
// 與這條無交集：這裡要求 `-8位數-6位數` 兩段。
const ASK_ID_IN_TEXT_RE = /([A-Za-z0-9]+-[0-9]{8}-[0-9]{6})/;
const ASK_ROUTE_CACHE_TTL = 21600;   // 6 小時，CacheService 上限

function _resolveAskIdFromThread_(conv, provider) {
  const channel = conv && conv.channel;
  const thread = conv && conv.thread;
  // 不在 thread 裡＝在頻道直接問＝一定是新的一輪，連 API 都不必打
  if (!channel || !thread) return '';

  const cache = CacheService.getScriptCache();
  const ck = 'askid_' + thread;
  const hit = cache.get(ck);
  if (hit) return hit;

  if (!provider || !provider.fetchThreadTexts) return '';

  // null＝讀不到（scope／token／網路）。當新的一輪。
  const msgs = provider.fetchThreadTexts(channel, thread);
  if (!msgs || !msgs.length) return '';

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || !m.bot) continue;
    const hit = String(m.text || '').match(ASK_ID_IN_TEXT_RE);
    if (!hit) continue;
    cache.put(ck, hit[1], ASK_ROUTE_CACHE_TTL);
    return hit[1];
  }
  return '';
}


function handleAskRequest(args, conv, user, provider) {
  const prompt = _toHalfWidth_(args || '').trim();

  const USAGE = [
    '用法：`@Alice ask <你想問的事>`',
    '例：`@Alice ask 幫我查 ui 的 code 裡登入流程怎麼寫的`',
    '（這條是唯讀的——它只會查與回答，不會改任何 repo）'
  ].join('\u000a');

  if (!prompt) {
    provider.postMessage(conv.channel, '<@' + user + '> ⚠️ 要問什麼？' + '\u000a' + USAGE, _replyTarget_(conv));
    return;
  }

  const gate = _checkAskPassphrase_(prompt);

  // 密語沒對時還有第二條路：這一串先前已經受理過一次 ask（見上面的閘門說明）。
  // 反查是一次 Slack API 呼叫，所以只在**真的需要它來放行**時才提前付這個成本；
  // 密語對了的話留到後面所有廉價檢查之後再查。
  let continueId = gate.ok ? '' : _resolveAskIdFromThread_(conv, provider);

  if (!gate.ok && !continueId) {
    // 不透露密語本身——透露了就等於沒有閘門。
    //
    // ASK_OWNER 要放 Slack **user id**（U 開頭），不是顯示名：`<@pedro>` 在
    // Slack 會渲染成一個壞掉的 mention，看起來像 bug 而不是提示。
    // 沒設就不提人，只說去問專案負責人——比指向一個不存在的人好。
    const owner = PropertiesService.getScriptProperties().getProperty('ASK_OWNER');
    provider.postMessage(conv.channel,
      '<@' + user + '> \uD83D\uDD12 自由提問還在測試中，目前只開放給知道通關密語的人。' +
      (owner ? ('需要用的話找 <@' + owner + '> 拿。') : '需要用的話找專案負責人拿。'),
      _replyTarget_(conv));
    return;
  }
  const asked = gate.prompt;
  if (!asked) {
    // 只打了密語、沒有問題本文
    provider.postMessage(conv.channel, '<@' + user + '> \u26a0\ufe0f 密語對了，但你還沒說要問什麼。' + '\u000a' + USAGE, _replyTarget_(conv));
    return;
  }

  if (asked.length > ASK_MAX_CHARS) {
    provider.postMessage(conv.channel,
      '<@' + user + '> ⚠️ 問題太長了（' + asked.length + ' 字，上限 ' + ASK_MAX_CHARS + '）。' +
      '如果是要我看一整份檔案或 log，直接說它的路徑就好，我自己會去讀。', _replyTarget_(conv));
    return;
  }

  const cache = CacheService.getScriptCache();
  const throttleKey = 'ask_' + user;
  if (cache.get(throttleKey)) {
    provider.postMessage(conv.channel,
      '<@' + user + '> ⏳ 你剛剛才問過一題，等前一題回來再問下一題。' +
      '（每題會佔用一台 runner，而 RA / SA 的工作要排在後面）', _replyTarget_(conv));
    return;
  }

  // 反查放在所有廉價檢查**之後**：它是一次 Slack API 呼叫，而被密語擋下、
  // 被節流擋下、問題太長的那些路徑都不該付這個成本（3 秒預算很緊）。
  // 靠 thread 豁免進來的那條路上面已經查過了，不重複打 API。
  if (!continueId) continueId = _resolveAskIdFromThread_(conv, provider);

  // 先貼受理訊息取得 thread 錨點，再 dispatch。
  //
  // 與 _triggerPipelineTask_ 同一個順序，理由也相同：答案要回到哪裡必須在
  // dispatch 之前就定案——幾分鐘後答案回來時已經沒有任何 Slack 事件可以推導它。
  // 受理訊息會貼在他那則提問底下（見 core/conv.js 的 replyTo），所以看板、答案、
  // 追問全部落在同一串，提問與回答不會被拆成兩件看起來不相干的事。
  //
  // 受理訊息要講明是不是續問：那決定了「他能不能期待我懂上文」。看起來像客套，
  // 但反查失敗時他會直接從這句話看出來，不必等幾分鐘後收到一則答非所問的回覆。
  const anchored = provider.postAccepted(conv,
    (continueId
      ? '🔍 收到 <@' + user + '> 的追問，接續這個 thread 的上文，正在查…'
      : '🔍 收到 <@' + user + '> 的提問，正在查…') + '\u000a' +
    '_這需要幾分鐘。查完會回在這則底下。_');

  const ok = dispatchAsk(asked, user, anchored, continueId);

  if (ok) {
    // 節流標記只在真的送出去之後才寫：dispatch 失敗時他應該可以立刻重試
    cache.put(throttleKey, '1', ASK_THROTTLE_SEC);
  } else {
    provider.postMessage(anchored.channel,
      '⚠️ <@' + user + '> 觸發 GitHub Actions 失敗，這題沒有送出。' +
      '請確認 GITHUB_TOKEN 或稍後再問一次。', anchored.thread);
  }
}
