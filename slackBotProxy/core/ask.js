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

/** 反問訊息要不要附上「當成一般提問送出」按鈕——沒有密語就不附，附了也按不動。 */
function _askAllowed_(rawText) {
  return _checkAskPassphrase_(String(rawText || '')).ok;
}


function handleAskRequest(args, conv, user, provider) {
  const prompt = _toHalfWidth_(args || '').trim();

  const USAGE = [
    '用法：`@Alice ask <你想問的事>`',
    '例：`@Alice ask 幫我查 ui 的 code 裡登入流程怎麼寫的`',
    '（這條是唯讀的——它只會查與回答，不會改任何 repo）'
  ].join('\u000a');

  if (!prompt) {
    provider.postMessage(conv.channel, '<@' + user + '> ⚠️ 要問什麼？' + '\u000a' + USAGE, conv.thread);
    return;
  }

  const gate = _checkAskPassphrase_(prompt);
  if (!gate.ok) {
    // 不透露密語本身——透露了就等於沒有閘門。
    //
    // ASK_OWNER 要放 Slack **user id**（U 開頭），不是顯示名：`<@pedro>` 在
    // Slack 會渲染成一個壞掉的 mention，看起來像 bug 而不是提示。
    // 沒設就不提人，只說去問專案負責人——比指向一個不存在的人好。
    const owner = PropertiesService.getScriptProperties().getProperty('ASK_OWNER');
    provider.postMessage(conv.channel,
      '<@' + user + '> \uD83D\uDD12 自由提問還在測試中，目前只開放給知道通關密語的人。' +
      (owner ? ('需要用的話找 <@' + owner + '> 拿。') : '需要用的話找專案負責人拿。'),
      conv.thread);
    return;
  }
  const asked = gate.prompt;
  if (!asked) {
    // 只打了密語、沒有問題本文
    provider.postMessage(conv.channel, '<@' + user + '> \u26a0\ufe0f 密語對了，但你還沒說要問什麼。' + '\u000a' + USAGE, conv.thread);
    return;
  }

  if (asked.length > ASK_MAX_CHARS) {
    provider.postMessage(conv.channel,
      '<@' + user + '> ⚠️ 問題太長了（' + asked.length + ' 字，上限 ' + ASK_MAX_CHARS + '）。' +
      '如果是要我看一整份檔案或 log，直接說它的路徑就好，我自己會去讀。', conv.thread);
    return;
  }

  const cache = CacheService.getScriptCache();
  const throttleKey = 'ask_' + user;
  if (cache.get(throttleKey)) {
    provider.postMessage(conv.channel,
      '<@' + user + '> ⏳ 你剛剛才問過一題，等前一題回來再問下一題。' +
      '（每題會佔用一台 runner，而 RA / SA 的工作要排在後面）', conv.thread);
    return;
  }

  // 先貼受理訊息取得 thread 錨點，再 dispatch。
  //
  // 與 _triggerPipelineTask_ 同一個順序，理由也相同：答案要回到哪裡必須在
  // dispatch 之前就定案，而使用者在頻道裡直接 @ 時根本還沒有 thread。
  // postAccepted 會用受理訊息自己的 ts 當錨點，於是幾分鐘後答案回來時是掛在
  // 這則底下，不會洗頻。
  const anchored = provider.postAccepted(conv,
    '🔍 收到 <@' + user + '> 的提問，正在查…' + '\u000a' +
    '_這需要幾分鐘。查完會回在這則底下。_');

  const ok = dispatchAsk(asked, user, anchored);

  if (ok) {
    // 節流標記只在真的送出去之後才寫：dispatch 失敗時他應該可以立刻重試
    cache.put(throttleKey, '1', ASK_THROTTLE_SEC);
  } else {
    provider.postMessage(anchored.channel,
      '⚠️ <@' + user + '> 觸發 GitHub Actions 失敗，這題沒有送出。' +
      '請確認 GITHUB_TOKEN 或稍後再問一次。', anchored.thread);
  }
}
