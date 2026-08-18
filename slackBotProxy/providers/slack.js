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

  // 2. 貼出決策互動卡片 (Block Kit 按鈕)
  postDecision: function(conv, questionObj, jiraId, phase, pipeline) {
    const channel = conv.channel;
    const threadTs = conv.thread || null;

    const questionId = questionObj.id || ('Q-' + new Date().getTime());
    const questionText = questionObj.question || '有待確認事項需您抉擇';
    const options = questionObj.options || ['A: 同意', 'B: 不同意'];
    const contextText = questionObj.context || '';

    const blocks = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `🔴 人機決策請求 (${jiraId})`,
          emoji: true
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*執行階段*：\`${phase}\`\n*問題描述*：\n> ${questionText.replace(/\n/g, '\n> ')}`
        }
      }
    ];

    if (contextText) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `ℹ️ *背景*：${contextText}`
          }
        ]
      });
    }

    const buttonElements = options.map((opt, index) => {
      const valuePayload = JSON.stringify({
        question_id: questionId,
        choice: opt,
        jira_id: jiraId,
        pipeline: pipeline
      });

      return {
        type: 'button',
        text: {
          type: 'plain_text',
          text: opt.length > 70 ? (opt.substring(0, 67) + '...') : opt,
          emoji: true
        },
        action_id: `decision_choice_${index}`,
        value: valuePayload
      };
    });

    blocks.push({
      type: 'actions',
      block_id: `decision_actions_${questionId}`,
      elements: buttonElements
    });

    const res = this.postMessage(channel, `🔴 [${jiraId}] 人機決策請求: ${questionText}`, threadTs, blocks);
    return res ? res.ts : null;
  },

  // 3. 解決/定案決策（替換卡片為純文字，消除按鈕）
  resolveDecision: function(conv, messageId, choice, user, timeStr, jiraId) {
    const channel = conv.channel;
    const ts = messageId;
    if (!channel || !ts) return;

    const updatedBlocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `✅ *[${jiraId}] 人機決策已定案*\n• **已由**：${user}\n• **選擇**：\`${choice}\`\n• **時間**：${timeStr}`
        }
      }
    ];

    this.updateMessage(channel, ts, `✅ [${jiraId}] 決策已由 ${user} 選擇: ${choice}`, updatedBlocks);
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

    return {
      questionId: actionData.question_id,
      choice: actionData.choice,
      jiraId: actionData.jira_id,
      pipeline: actionData.pipeline || 'sa-pipeline',
      user: `<@${userId}>` || user,
      userId: userId,
      conversation: {
        provider: 'slack',
        channel: channel,
        thread: messageTs
      },
      messageId: messageTs,
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
