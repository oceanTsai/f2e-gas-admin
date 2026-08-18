// ═══════════════════════════════════════════════════════════════════
//  Slack Provider 實作
//  負責 Slack Block Kit 卡片建置、訊息發布、更新與互動解析
// ═══════════════════════════════════════════════════════════════════

const SlackProvider = {
  name: 'slack',

  // 1. 發送任務受理訊息並回傳補齊 thread 錨點的 conversation
  postAccepted: function(conv, text) {
    const channel = conv.channel;
    const threadTs = conv.thread || null;
    const res = this.postMessage(channel, text, threadTs);
    const anchor = threadTs || (res ? res.ts : null);
    return {
      provider: 'slack',
      channel: channel,
      thread: anchor
    };
  },

  // 2. 貼出決策互動卡片：一張訊息、逐題一組按鈕
  //    ctx = { questions: [...], jiraId, phase, pipeline, attachments: [...] }
  postDecision: function (conv, ctx) {
    const channel = conv.channel;
    const threadTs = conv.thread || null;
    const questions = (ctx.questions && ctx.questions.length) ? ctx.questions : [ctx.question || {}];

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: '\u{1F534} 人機決策請求 (' + ctx.jiraId + ')', emoji: true }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*執行階段*：`' + ctx.phase + '`\n共 *' + questions.length + '* 題待決議，' +
                '**每題都回答完**才會接續後續流程。'
        }
      },
      { type: 'divider' }
    ];

    questions.forEach(function (q, qi) {
      const qid = q.id || ('Q-' + (qi + 1));
      const qText = q.question || '（缺少問題描述）';
      const options = (q.options && q.options.length) ? q.options : ['A: 同意', 'B: 不同意'];

      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '*' + qid + '*　' + qText }
      });

      if (q.context) {
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: 'ℹ️ ' + q.context }]
        });
      }

      blocks.push({
        type: 'actions',
        // block_id 是逐題更新的依據：答完一題只換掉這個 block，其他題的按鈕要留著
        block_id: 'decision_actions_' + qid,
        elements: options.map(function (opt, oi) {
          return {
            type: 'button',
            text: {
              type: 'plain_text',
              text: opt.length > 70 ? (opt.substring(0, 67) + '...') : opt,
              emoji: true
            },
            action_id: 'decision_' + qid + '_' + oi,
            value: JSON.stringify({
              question_id: qid,
              choice: opt,
              jira_id: ctx.jiraId,
              pipeline: ctx.pipeline
            })
          };
        })
      });

      if (qi < questions.length - 1) blocks.push({ type: 'divider' });
    });

    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: '\u{1F4AC} 選項無法表達時，直接在本 thread 回覆 `@Alice answer ' +
              (questions[0].id || 'Q-001') + ' <你的答覆>`'
      }]
    });

    const summary = '\u{1F534} [' + ctx.jiraId + '] ' + questions.length + ' 題人機決策請求';
    const res = this.postMessage(channel, summary, threadTs, blocks);
    const messageId = res ? res.ts : null;

    // 附件（補問清單 / 阻塞總覽）掛在同一個 thread，供人閱讀
    if (ctx.attachments && ctx.attachments.length) {
      this.uploadFiles({ channel: channel, thread: threadTs || messageId }, ctx.attachments);
    }

    return messageId;
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

    let blocks = info.blocks;
    if (blocks && blocks.length) {
      blocks = blocks.map(function (b) {
        return (b.block_id === 'decision_actions_' + qid) ? resolvedSection : b;
      });
    } else {
      // 拿不到原始 blocks 時退回整張替換（至少要讓按鈕消失）
      blocks = [resolvedSection];
    }

    const fallbackText = '✅ [' + info.jiraId + '] ' + qid + ' 由 ' + info.user + ' 選擇：' + info.choice;

    if (info.responseUrl) {
      try {
        UrlFetchApp.fetch(info.responseUrl, {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify({
            response_type: 'in_channel',
            replace_original: true,
            text: fallbackText,
            blocks: blocks
          }),
          muteHttpExceptions: true
        });
        return;
      } catch (err) {
        console.warn('response_url 更新失敗，改用 chat.update:', err);
      }
    }

    if (!channel || !messageId) {
      console.error('resolveDecision: 缺少 channel/ts 且無 response_url，按鈕未能消除');
      return;
    }
    this.updateMessage(channel, messageId, fallbackText, blocks);
  },

  // 附件上傳：Slack 的 files.upload 已退役，須走 external upload 三步
  // 需要 Bot Token Scope: files:write
  uploadFiles: function (conv, attachments) {
    const token = PropertiesService.getScriptProperties().getProperty('SLACK_TOKEN');
    if (!token) { console.warn('未設定 SLACK_TOKEN，略過附件上傳'); return; }
    const auth = { Authorization: 'Bearer ' + token };

    attachments.forEach(function (a) {
      try {
        const bytes = Utilities.newBlob(a.content).getBytes().length;

        // ① 取得一次性上傳網址
        const r1 = UrlFetchApp.fetch(
          'https://slack.com/api/files.getUploadURLExternal?filename=' +
          encodeURIComponent(a.name) + '&length=' + bytes,
          { headers: auth, muteHttpExceptions: true });
        const j1 = JSON.parse(r1.getContentText());
        if (!j1.ok) { console.error('getUploadURLExternal 失敗:', j1.error, a.name); return; }

        // ② 上傳內容
        UrlFetchApp.fetch(j1.upload_url, {
          method: 'post',
          payload: a.content,
          muteHttpExceptions: true
        });

        // ③ 完成並貼到對話（thread 內）
        const r3 = UrlFetchApp.fetch('https://slack.com/api/files.completeUploadExternal', {
          method: 'post',
          contentType: 'application/json',
          headers: auth,
          payload: JSON.stringify({
            files: [{ id: j1.file_id, title: a.name }],
            channel_id: conv.channel,
            thread_ts: conv.thread || undefined
          }),
          muteHttpExceptions: true
        });
        const j3 = JSON.parse(r3.getContentText());
        if (!j3.ok) console.error('completeUploadExternal 失敗:', j3.error, a.name);
      } catch (err) {
        console.error('附件上傳異常:', a.name, err);
      }
    });
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
      return JSON.parse(res.getContentText());
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
  }
};
