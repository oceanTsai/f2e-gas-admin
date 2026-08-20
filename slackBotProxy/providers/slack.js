// ═══════════════════════════════════════════════════════════════════
//  Slack Provider 實作
//  負責 Slack Block Kit 卡片建置、訊息發布、更新與互動解析
// ═══════════════════════════════════════════════════════════════════

//
//  【入向專用】只負責解析人的動作並回應。把訊息貼給人看的出向流程
//  （決策卡片、進度看板）已拆到 messageDispatch 專案。

// 反查要掃幾則。看板一定在最前面（受理當下就貼），所以不必掃完整串；
// 100 則足以涵蓋「人先聊了一段才 @Alice」的情況，又不會讓回應體積失控。
const THREAD_SCAN_LIMIT = 100;

// 同一次執行內的 thread 內容快取（見 fetchThreadTexts）。
const THREAD_FETCH_MEMO = {};

const SlackProvider = {
  name: 'slack',

  // 1. 發送任務受理訊息並回傳補齊 thread 錨點的 conversation
  postAccepted: function(conv, text) {
    const channel = conv.channel;
    // 在既有 thread 內就沿用那個 thread；否則掛在觸發者那則訊息底下（replyTo）。
    // 兩者都沒有（slash command 沒有訊息可掛）才是頻道層級，那時退回用自己的 ts。
    const threadTs = _replyTarget_(conv);
    const res = this.postMessage(channel, text, threadTs);
    const acceptedTs = res ? res.ts : null;
    return {
      provider: 'slack',
      channel: channel,
      // thread：後續訊息（進度、答案、追問）要掛在哪。幾分鐘後答案回來時已經沒有
      // 任何 Slack 事件可以推導這件事，所以必須在 dispatch 之前就定案。
      thread: threadTs || acceptedTs,
      // status_ts：進度回報要 chat.update 的目標，**必須**是我們自己發的受理訊息。
      // 不能用 thread——在既有 thread 內觸發時那是別人的訊息，bot 無權更新。
      status_ts: acceptedTs
    };
  },

  // 3. 定案某一題：只替換該題的按鈕區塊，其餘題目維持可點
  resolveDecision: function (conv, messageId, info) {
    const channel = conv.channel;
    const qid = info.questionId;
    const resolvedSection = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '✅ *' + qid + ' 已定案*　選擇：`' + info.choice + '`　' +
              '（由 ' + info.user + '，' + info.timeStr + '）'
      }
    };

    // 進度行：答完一題就就地更新，讓人不必自己數還剩幾題（不額外發訊息，
    // 才不會增加 Slack 3 秒預算內的 API 呼叫次數）
    const progressSection = info.progressText ? {
      type: 'section',
      block_id: 'decision_progress',
      text: { type: 'mrkdwn', text: info.progressText }
    } : null;

    let blocks = info.blocks;
    if (blocks && blocks.length) {
      blocks = blocks.map(function (b) {
        if (b.block_id === 'decision_actions_' + qid) return resolvedSection;
        if (progressSection && b.block_id === 'decision_progress') return progressSection;
        return b;
      });
    } else {
      // 拿不到原始 blocks 時退回整張替換（至少要讓按鈕消失）
      blocks = [resolvedSection];
    }

    const fallbackText = '✅ [' + info.jiraId + '] ' + qid + ' 由 ' + info.user + ' 選擇：' + info.choice;

    // 以 chat.update 為主：它對 blocks 的支援最完整，且回應可驗證。
    // 先前優先走 response_url，但那次呼叫帶了 muteHttpExceptions，Slack 回錯誤時
    // 不會 throw，程式卻當成功直接 return——卡片永遠不會更新，也不會退回 chat.update。
    if (channel && messageId) {
      const res = this.updateMessage(channel, messageId, fallbackText, blocks);
      if (res && res.ok) return;
      console.error('chat.update 失敗:', res && res.error, '→ 改試 response_url');
    }

    // fallback：response_url（30 分鐘內有效，不需要 token）
    if (info.responseUrl) {
      try {
        const r = UrlFetchApp.fetch(info.responseUrl, {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify({
            replace_original: true,
            text: fallbackText,
            blocks: blocks
          }),
          muteHttpExceptions: true
        });
        const code = r.getResponseCode();
        if (code >= 200 && code < 300) return;
        console.error('response_url 更新失敗 HTTP', code, r.getContentText());
      } catch (err) {
        console.error('response_url 更新異常:', err);
      }
    }

    console.error('resolveDecision: 兩種更新方式都失敗，按鈕未能消除（qid=' + qid + '）');
  },

  // 4. 解析 Slack 按鈕互動 payload
  parseInteraction: function(payload) {
    if (!payload.actions || payload.actions.length === 0) {
      return null;
    }
    const action = payload.actions[0];
    if (!action.value) return null;

    let actionData = {};
    try {
      actionData = JSON.parse(action.value);
    } catch (e) {
      return null;
    }

    const user = payload.user ? (payload.user.username || payload.user.name || payload.user.id) : 'unknown';
    const userId = payload.user ? payload.user.id : '';
    const channel = payload.channel ? payload.channel.id : null;
    const messageTs = payload.message ? payload.message.ts : null;
    // thread 錨點要取 thread_ts；message.ts 是這張卡片自己的 ts，拿它當錨點會讓
    // 後續訊息掛在錯誤的位置。卡片不在 thread 內時才退回 ts。
    const threadTs = (payload.message && payload.message.thread_ts) || messageTs;

    return {
      // 以前只有一種按鈕，靠 question_id 就能判斷。多了「當成一般提問送出」
      // 之後必須明講種類——沒有預設值的話，舊卡片（value 裡沒有 kind）會被
      // 判成未知種類而整個失效，而那些卡片可能已經在 thread 裡躺了好幾天。
      kind: actionData.kind || 'decision',
      askKey: actionData.k || null,
      questionId: actionData.question_id,
      choice: actionData.choice,
      jiraId: actionData.jira_id,
      pipeline: actionData.pipeline || 'sa-pipeline',
      user: userId ? `<@${userId}>` : user,
      userId: userId,
      conversation: {
        provider: 'slack',
        channel: channel,
        thread: threadTs
      },
      messageId: messageTs,
      // 逐題替換需要原始 blocks（只換掉被回答那一題的按鈕區塊）
      blocks: (payload.message && payload.message.blocks) || null,
      // response_url 有效 30 分鐘，用來發只有點擊者看得到的 ephemeral 提示
      responseUrl: payload.response_url || null
    };
  },

  // 5. 對點擊者發送僅自己可見的暫時提示（絕不改動原卡片）
  notifyTransient: function(interaction, text) {
    const url = interaction && interaction.responseUrl;
    if (!url) {
      console.warn('notifyTransient: 缺少 response_url，略過提示');
      return;
    }
    try {
      UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          response_type: 'ephemeral',
          replace_original: false,
          text: text
        }),
        muteHttpExceptions: true
      });
    } catch (err) {
      console.error('notifyTransient 失敗:', err);
    }
  },

  // Slack API 封裝
  postMessage: function(channel, text, threadTs, blocks) {
    const token = PropertiesService.getScriptProperties().getProperty('SLACK_TOKEN');
    if (!token) {
      console.warn('未設定 SLACK_TOKEN');
      return null;
    }

    const postBody = { channel: channel, text: text };
    if (threadTs) postBody.thread_ts = threadTs;
    if (blocks) postBody.blocks = blocks;

    try {
      const res = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
        method: 'post',
        contentType: 'application/json; charset=utf-8',
        headers: { Authorization: 'Bearer ' + token },
        payload: JSON.stringify(postBody),
        muteHttpExceptions: true
      });
      const resJson = JSON.parse(res.getContentText());
      return resJson.ok ? resJson : null;
    } catch (err) {
      console.error('Slack postMessage 失敗:', err);
      return null;
    }
  },

  updateMessage: function(channel, ts, text, blocks) {
    const token = PropertiesService.getScriptProperties().getProperty('SLACK_TOKEN');
    if (!token) return null;

    const updateBody = { channel: channel, ts: ts, text: text };
    if (blocks) updateBody.blocks = blocks;

    try {
      const res = UrlFetchApp.fetch('https://slack.com/api/chat.update', {
        method: 'post',
        contentType: 'application/json; charset=utf-8',
        headers: { Authorization: 'Bearer ' + token },
        payload: JSON.stringify(updateBody),
        muteHttpExceptions: true
      });
      const json = JSON.parse(res.getContentText());
      if (!json.ok) {
        // 常見原因：message_not_found（ts 不對）、cant_update_message（不是 bot 自己發的）、
        // invalid_blocks（blocks 結構被改壞）
        console.error('chat.update 回報失敗:', json.error, 'channel=' + channel, 'ts=' + ts);
      }
      return json;
    } catch (err) {
      console.error('Slack updateMessage 失敗:', err);
      return null;
    }
  },

  postWebhook: function(text) {
    const webhookUrl = PropertiesService.getScriptProperties().getProperty('TEST_WEBHOOK_URL');
    if (!webhookUrl) return;
    UrlFetchApp.fetch(webhookUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ text: text }),
      muteHttpExceptions: true
    });
  },

  // 取 thread 第一則訊息的文字。入向靠它反查「這個 thread 是哪張單」——
  // 出向已拆到 messageDispatch，而 ScriptProperties 是 per-script 的，所以不能
  // 再靠「貼卡片時存、答覆時讀」。thread 的第一則訊息本來就帶著單號（人打的
  // `@Alice ra VIPOP-46703`，或 Alice 自己貼的受理訊息／決策卡片 summary），
  // 反查它就不需要任何跨專案共享狀態。
  //
  // ⚠️ 刻意**只看第一則**。掃整串會把 Alice 自己訊息裡的範例單號吃進來
  //    （「例：`@Alice ra VIPOP-12345`」），而那個誤認的後果是答案被寫到別張單。
  fetchThreadRoot: function (channel, threadTs) {
    const msgs = this.fetchThreadTexts(channel, threadTs);
    if (msgs === null) return null;   // 讀不到（scope／token／網路）
    return msgs.length ? msgs[0].text : '';
  },

  // 取整個 thread 的訊息（由舊到新，含第一則），每則帶 bot 旗標。
  //
  // 為什麼需要「整串」而不只是第一則：Alice 現在回在**觸發訊息底下**，所以
  // thread 的第一則是人打的那句話，帶著提問編號的看板是它的回覆。ask 的續問
  // 反查只讀第一則就永遠找不到編號，每次追問都會開一支新的空白分支。
  //
  // bot 旗標是必要的：提問編號會直接變成 git 分支名，人打的字不該有那個權力。
  //
  // 需要 channels:history（公開頻道）／groups:history（私人頻道）scope。
  fetchThreadTexts: function (channel, threadTs) {
    // 同一次執行內，單號反查與提問編號反查會各叫一次；memo 讓它們共用同一次
    // API 呼叫（3 秒預算很緊）。GAS 每次執行都重新載入腳本，所以不會跨請求殘留。
    const memoKey = String(channel) + '|' + String(threadTs);
    if (Object.prototype.hasOwnProperty.call(THREAD_FETCH_MEMO, memoKey)) {
      return THREAD_FETCH_MEMO[memoKey];
    }
    const out = this._fetchThreadReplies_(channel, threadTs);
    THREAD_FETCH_MEMO[memoKey] = out;
    return out;
  },

  _fetchThreadReplies_: function (channel, threadTs) {
    const token = PropertiesService.getScriptProperties().getProperty('SLACK_TOKEN');
    if (!token) {
      console.error('未設定 SLACK_TOKEN，無法反查 thread 內容');
      return null;
    }

    const url = 'https://slack.com/api/conversations.replies' +
                '?channel=' + encodeURIComponent(channel) +
                '&ts=' + encodeURIComponent(threadTs) +
                '&limit=' + THREAD_SCAN_LIMIT;
    try {
      const res = UrlFetchApp.fetch(url, {
        method: 'get',
        headers: { Authorization: 'Bearer ' + token },
        muteHttpExceptions: true
      });
      const json = JSON.parse(res.getContentText());
      if (!json.ok) {
        // 回 null（不是空字串）讓上層能分辨「讀不到」與「讀到了但沒有單號」——
        // 前者要告訴使用者原因，後者才是真的無從判斷。
        if (json.error === 'missing_scope') {
          console.error('conversations.replies: missing_scope —— Alice 需要 ' +
            'channels:history（公開頻道）／groups:history（私人頻道）。' +
            '改過 scope 後必須重新安裝 App 才生效。needed=' + (json.needed || '?') +
            ' provided=' + (json.provided || '?'));
        } else if (json.error === 'not_in_channel') {
          console.error('conversations.replies: not_in_channel —— 把 Alice 邀請進這個頻道');
        } else {
          console.error('conversations.replies 失敗:', json.error);
        }
        return null;
      }
      // 截掉的是**最新**那一段，而要找的東西（受理訊息／看板）一定在最前面：
      // 它是受理當下就貼出去的。所以截斷不影響反查，但還是要留下痕跡。
      if (json.has_more) {
        console.log('thread 超過 ' + THREAD_SCAN_LIMIT + ' 則，只掃了最前面那些');
      }
      return (json.messages || []).map(function (m) {
        return {
          text: (m && m.text) || '',
          // bot_id 只有 bot 發的訊息才有。app_id 一起看是為了保險：Slack 對
          // 不同發送方式（webhook／bot token）帶的欄位不完全一致。
          bot: !!(m && (m.bot_id || m.app_id))
        };
      });
    } catch (err) {
      console.error('conversations.replies 異常:', err);
      return null;
    }
  }
};
