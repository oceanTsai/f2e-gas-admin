// ═══════════════════════════════════════════════════════════════════
//  Slack Provider 實作
//  負責 Slack Block Kit 卡片建置、訊息發布、更新與互動解析
// ═══════════════════════════════════════════════════════════════════

//
//  【入向專用】只負責解析人的動作並回應。把訊息貼給人看的出向流程
//  （決策卡片、進度看板）已拆到 messageDispatch 專案。

const SlackProvider = {
  name: 'slack',

  // 1. 發送任務受理訊息並回傳補齊 thread 錨點的 conversation
  postAccepted: function(conv, text) {
    const channel = conv.channel;
    const threadTs = conv.thread || null;
    const res = this.postMessage(channel, text, threadTs);
    const acceptedTs = res ? res.ts : null;
    return {
      provider: 'slack',
      channel: channel,
      // thread：後續訊息要掛在哪。使用者在既有 thread 內 @ 時沿用那個 thread
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
  // 再靠「貼卡片時存、答覆時讀」。thread 的第一則訊息（任務受理訊息或決策卡片
  // 的 summary）本來就帶著單號，反查它就不需要任何跨專案共享狀態。
  //
  // 需要 channels:history（公開頻道）／groups:history（私人頻道）scope。
  fetchThreadRoot: function (channel, threadTs) {
    const token = PropertiesService.getScriptProperties().getProperty('SLACK_TOKEN');
    if (!token) {
      console.error('未設定 SLACK_TOKEN，無法反查 thread 單號');
      return null;
    }

    const url = 'https://slack.com/api/conversations.replies' +
                '?channel=' + encodeURIComponent(channel) +
                '&ts=' + encodeURIComponent(threadTs) +
                '&limit=1';
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
      const first = (json.messages && json.messages[0]) || null;
      return first ? (first.text || '') : '';
    } catch (err) {
      console.error('conversations.replies 異常:', err);
      return null;
    }
  }
};
