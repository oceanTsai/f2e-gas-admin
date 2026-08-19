// ═══════════════════════════════════════════════════════════════════
//  Slack Provider 實作
//  負責 Slack Block Kit 卡片建置、訊息發布、更新與互動解析
// ═══════════════════════════════════════════════════════════════════

//
//  【出向專用】只負責把訊息貼上 Slack。解析互動、回應使用者屬於入向，
//  留在 slackBotProxy——那兩邊的信任邊界與部署節奏都不同。
//  postMessage / updateMessage 是兩邊共用的低階封裝，刻意各留一份：
//  用 GAS Library 共用的代價（版本綁定、部署順序、除錯困難）大於 50 行重複。

const SlackProvider = {
  name: 'slack',

  // 進度看板：持續更新同一則受理訊息，不洗頻
  updateProgress: function(conv, info) {
    const ts = conv.status_ts;
    if (!conv.channel || !ts) {
      console.warn('updateProgress: 缺少 channel/status_ts，略過');
      return;
    }

    const ICON = {
      completed: '✅',
      running: '🔄',
      awaiting_decision: '🟡',
      failed: '❌',
      pending: '⬜'
    };

    const lines = (info.phases || []).map(function (p) {
      const icon = ICON[p.status] || '⬜';
      const tail = (p.status === 'running') ? '　_執行中…_'
                 : (p.status === 'awaiting_decision') ? '　_等待決策_'
                 : '';
      return icon + ' `' + p.command + '`' + tail;
    });

    const done = (info.phases || []).filter(function (p) { return p.status === 'completed'; }).length;
    const total = (info.phases || []).length;

    let header = '🚀 *' + info.jiraId + '*　`' + info.pipeline + '`　(' + done + '/' + total + ')';
    if (info.pendingQuestions > 0) {
      header += '\n🟡 有 *' + info.pendingQuestions + '* 題待決議，請看本 thread 內的決策卡片';
    }

    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: header } },
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') || '_尚無階段資訊_' } }
    ];
    if (info.runUrl) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '<' + info.runUrl + '|查看 Actions 執行紀錄>' }]
      });
    }

    this.updateMessage(conv.channel, ts,
      info.jiraId + ' ' + info.pipeline + '（' + done + '/' + total + '）', blocks);
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
        // 固定 block_id：定案某題時要就地更新這行的進度（0/2 → 1/2 → 全部完成）
        block_id: 'decision_progress',
        text: {
          type: 'mrkdwn',
          text: '*執行階段*：`' + ctx.phase + '`\n共 *' + questions.length + '* 題待決議（已回答 0／' +
                questions.length + '），**每題都回答完**才會接續後續流程。'
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
  }
};
