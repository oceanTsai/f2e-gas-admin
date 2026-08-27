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
      let tail = '';
      if (p.status === 'running') {
        // activity 是 agent／workflow 用 set-activity 寫的一行字（「抓取 Jira
        // 工單與附件」之類）。沒有時退回「執行中…」——長時間的 Phase 在人眼裡
        // 是一片空白，這一行就是唯一的訊息。
        const act = String(p.activity || '').trim();
        tail = act ? ('　_' + (act.length > 40 ? act.slice(0, 39) + '…' : act) + '…_')
                   : '　_執行中…_';
      } else if (p.status === 'awaiting_decision') {
        tail = '　_等待決策_';
      } else if (p.status === 'failed') {
        // 失敗原因直接寫在旁邊。少了這一行，人只看到一個 ❌ 就得去翻 Actions
        // log 才知道是逾時、agent 掛掉、還是產物沒寫出來。
        const err = String(p.error || '').trim();
        tail = err ? ('　_' + (err.length > 48 ? err.slice(0, 47) + '…' : err) + '_')
                   : '　_失敗_';
      }
      return icon + ' `' + p.command + '`' + tail;
    });

    const done = (info.phases || []).filter(function (p) { return p.status === 'completed'; }).length;
    const total = (info.phases || []).length;

    let header = '🚀 *' + info.jiraId + '*　`' + info.pipeline + '`　(' + done + '/' + total + ')';

    // 有 Phase 失敗時 pipeline 已經停了，後面的階段永遠不會跑。只靠一個 ❌ 圖示
    // 太容易被當成「還在跑」——標題明講，人才知道要處理而不是繼續等。
    const failed = (info.phases || []).filter(function (p) { return p.status === 'failed'; });
    if (failed.length > 0) {
      header += '　❌ *已中止*（`' + failed[0].command + '`）';
    }

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

    // 附件（補問清單 / 阻塞總覽）由呼叫端統一處理——見 core/outbound.js 的
    // _postAttachments_。搬出去的理由：附件失敗時要在 thread 裡講出來，而那段
    // 邏輯對每條通道都一樣，留在這裡只有決策卡片這一條享受得到。
    return messageId;
  },

  // 2b. 記憶圖譜的決策卡片
  //     ctx = { memoryId, questions: [...], repo, runUrl }
  //
  //     與 postDecision 的差別只有三處，但每一處都不能省：
  //       · 沒有 jiraId／phase／pipeline（記憶決策不綁單號）
  //       · 按鈕 value 帶 kind:'memory'——入向靠它分岔到 handleMemoryInteraction；
  //         少了它會落到決策路徑，然後拿 undefined 的 jiraId 去組快取鍵、
  //         靜默地什麼都不做
  //       · **不放「文字回覆」的提示**：記憶決策只能按按鈕（理由見
  //         core/memory.js 開頭）。留著那句提示的話，人照著打 `@Alice answer`
  //         會走進 handleTextAnswer，然後被反查不到單號而擋下——他會以為壞了
  //
  //     block_id 沿用 `decision_actions_<qid>` / `decision_progress`：
  //     入向的 resolveDecision 就地更新靠這兩個名字，改名等於按鈕永遠不消失。
  postMemoryDecision: function (conv, ctx) {
    const channel = conv.channel;
    const threadTs = conv.thread || null;
    const questions = ctx.questions || [];

    // ⚠️ 這裡的文案**不可以描述任何特定 kind**。
    //    前言是所有題目共用的，而 kind 只有 augma 的 kg.py audit 知道。寫死成
    //    某一種 kind 的敘述，下一種進來就會被套上不屬於它的說明——實戰踩過：
    //    `eval-margin`（🟡 檢索門檻餘裕見底）被冠上「兩顆記憶原子互相矛盾」的
    //    前言，看卡片的人會以為系統壞了。kind-specific 的說明（含「不處理會
    //    怎樣」）由 augma 放進每題的 `context`，這裡只做排版與分級圖示。
    //
    //    分級靠 `severity`（blocker／warning）——payload 一直都有這個欄位，
    //    只是先前沒用。缺值時不給圖示，不要猜。
    const ICON = { blocker: '\u{1F534}', warning: '\u{1F7E1}' };
    const nBlocker = questions.filter(function (q) {
      return q.severity === 'blocker';
    }).length;
    const nWarning = questions.length - nBlocker;
    const tally = [
      nBlocker ? ICON.blocker + ' ' + nBlocker : '',
      nWarning ? ICON.warning + ' ' + nWarning : ''
    ].filter(Boolean).join('　');

    const blocks = [
      {
        type: 'header',
        // 有 🔴 才叫「待裁決」。全是 🟡 時那個詞太重——每日 job 天天跑，
        // 一直喊「待裁決」的下場跟假警報一樣：第三天起就沒人看卡片了。
        text: {
          type: 'plain_text',
          text: nBlocker ? '\u{1F9E0} 記憶圖譜待裁決' : '\u{1F9E0} 記憶圖譜體檢',
          emoji: true
        }
      },
      {
        type: 'section',
        block_id: 'decision_progress',
        text: {
          type: 'mrkdwn',
          text: '共 *' + questions.length + '* 題需要你決定（' + tally + '）。' +
                '每題的說明在題目下方，按下按鈕即生效。'
        }
      },
      { type: 'divider' }
    ];

    questions.forEach(function (q, qi) {
      const qid = q.id || ('M-' + (qi + 1));
      const options = (q.options && q.options.length) ? q.options : ['A: 同意', 'B: 不同意'];

      // 分級標在**每一題前面**，不是分成兩張卡片。同一批問題拆卡的話，
      // 「今天總共有幾題」就要人自己把兩張加起來——而漏看一張的成本很高。
      const icon = ICON[q.severity] || '';
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: (icon ? icon + ' ' : '') + '*' + qid + '*　' +
                (q.question || '（缺少問題描述）')
        }
      });
      if (q.context) {
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: '\u2139\ufe0f ' + q.context }]
        });
      }
      // 涉及哪幾顆原子。**一定要給可點的連結**——只印 id 等於要人自己去 grep
      // 檔名，而檔名是中文帶括號的，grep 起來很痛苦。實戰第一張卡片就踩到了。
      //
      // refs 由 augma 的 kg.py audit 帶過來（{id, title, path}）。舊 payload 只有
      // atoms（純 id 陣列），所以保留退路：有 refs 就給連結，沒有就印 id。
      const refs = q.refs || [];
      if (refs.length && ctx.repo) {
        blocks.push({
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: '\uD83D\uDD17 ' + refs.map(function (r) {
              // 路徑含中文與空白，一定要 encodeURI——不編碼的話 Slack 會把連結
              // 截在第一個空白處，點過去是 404。
              const url = 'https://github.com/' + ctx.repo + '/blob/main/' +
                          encodeURI(r.path || '');
              return '<' + url + '|' + (r.title || r.id) + '>';
            }).join('\u3000·\u3000')
          }]
        });
      } else if (q.atoms && q.atoms.length) {
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: '\uD83D\uDD17 `' + q.atoms.join('`　`') + '`' }]
        });
      }

      blocks.push({
        type: 'actions',
        block_id: 'decision_actions_' + qid,
        elements: options.map(function (opt, oi) {
          return {
            type: 'button',
            text: {
              type: 'plain_text',
              text: opt.length > 70 ? (opt.substring(0, 67) + '...') : opt,
              emoji: true
            },
            action_id: 'memory_' + qid + '_' + oi,
            value: JSON.stringify({
              kind: 'memory',
              memory_id: ctx.memoryId,
              question_id: qid,
              // ⚠️ 送**字母**，不送選項全文。字母由索引推出，與 augma 的
              //    `ord(letter) - ord('A')` 對稱。送全文在今天剛好也能work
              //    （選項字面以 "A: " 開頭），而那正是危險的地方：哪天選項文字
              //    改成不以字母開頭，那條路會靜默地開始對到錯的選項。
              //    augma 的 memory-answer.yml 用 `^[A-Za-z]$` 擋掉全文。
              choice: String.fromCharCode(65 + oi),
              // 卡片上「已定案」那行要顯示人看得懂的東西，不是一個字母。
              label: opt.length > 80 ? (opt.substring(0, 77) + '...') : opt
            })
          };
        })
      });

      if (qi < questions.length - 1) blocks.push({ type: 'divider' });
    });

    const foot = ['\u{1F4CC} 這張卡片**只能按按鈕**（選項是列舉的，所以不開文字通道）。'];
    if (ctx.runUrl) foot.push('<' + ctx.runUrl + '|每日沉澱的執行紀錄>');
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: foot.join('　·　') }] });

    // 通知列（卡片沒展開時看到的那一行）也要跟著分級——很多人只看這一眼。
    const summary = '\u{1F9E0} 記憶圖譜有 ' + questions.length +
                    (nBlocker ? ' 題待裁決' : ' 題待處理');
    const res = this.postMessage(channel, summary, threadTs, blocks);
    return res ? res.ts : null;
  },

  // user id → 這個平台的 mention 語法
  //
  // core 不可以自己組這個字串：Slack 是 `<@U123>`、Google Chat 是 `<users/123>`，
  // 寫死的那一種在另一個平台上會渲染成一段沒人看得懂的純文字——那個症狀看起來
  // 像 bug，不像「provider 還沒實作完」。
  //
  // ⚠️ 空值回**空字串**而不是 `<@>`：requester 留空代表「手動觸發，本來就沒有
  //    觸發者」，那時該完全不提人。實作與 slackBotProxy 那份刻意一致。
  mention: function (userId) {
    return userId ? '<@' + userId + '>' : '';
  },

  // 附件上傳：Slack 的 files.upload 已退役，須走 external upload 三步
  // 需要 Bot Token Scope: files:write
  //
  // attachments 元素：{ name, content, encoding?, mimetype? }
  //
  //   encoding === 'base64'  ← augma 一律送這種（lib/attachments.sh）
  //     content 是 base64 字串。**二進位安全**：PNG、PDF、zip 都走這條。
  //
  //   沒有 encoding          ← 舊版 payload，向下相容
  //     content 是檔案原文（只有 UTF-8 純文字送得出去）。這條保留是為了部署順序：
  //     這支先上線、augma 後推的那段時間裡，舊 payload 仍然要能正常上傳。
  //
  // ⚠️ 這裡刻意不 throw。附件是**補充**，訊息本文已經貼出去了——為了一個附件
  //    讓整個 handler 失敗，代價是 augma 那側看到 error 然後重試整則通知（洗頻）。
  //    改為回傳統計，讓呼叫端決定要不要在 thread 裡說一句「有幾個檔沒上傳成功」。
  //
  // 回傳 { ok: <成功數>, failed: <失敗數>, failedNames: [...] }
  uploadFiles: function (conv, attachments) {
    const list = attachments || [];
    const result = { ok: 0, failed: 0, failedNames: [] };
    if (!list.length) return result;

    const token = PropertiesService.getScriptProperties().getProperty('SLACK_TOKEN');
    if (!token) {
      console.warn('未設定 SLACK_TOKEN，略過 ' + list.length + ' 個附件');
      result.failed = list.length;
      result.failedNames = list.map(function (a) { return a.name; });
      return result;
    }
    const auth = { Authorization: 'Bearer ' + token };

    list.forEach(function (a) {
      const name = a.name || 'attachment';
      try {
        let blob;
        if (String(a.encoding || '').toLowerCase() === 'base64') {
          blob = Utilities.newBlob(
            Utilities.base64Decode(a.content),
            a.mimetype || 'application/octet-stream',
            name);
        } else {
          blob = Utilities.newBlob(a.content, a.mimetype || 'text/plain', name);
        }
        // length 必須是**解碼後**的位元組數。拿 base64 字串的長度去填會多 33%，
        // Slack 會在第三步以 file 尚未上傳完整為由拒收。
        const bytes = blob.getBytes().length;
        if (!bytes) {
          console.error('附件是空的，略過:', name);
          result.failed++; result.failedNames.push(name);
          return;
        }

        // ① 取得一次性上傳網址
        const r1 = UrlFetchApp.fetch(
          'https://slack.com/api/files.getUploadURLExternal?filename=' +
          encodeURIComponent(name) + '&length=' + bytes,
          { headers: auth, muteHttpExceptions: true });
        const j1 = JSON.parse(r1.getContentText());
        if (!j1.ok) {
          // 最常見：missing_scope（沒有 files:write）。名字印出來才知道是哪一個檔。
          console.error('getUploadURLExternal 失敗:', j1.error, name);
          result.failed++; result.failedNames.push(name);
          return;
        }

        // ② 上傳內容。送 Blob 而不是字串：字串會被以 UTF-8 重新編碼，
        //    二進位檔在這一步就壞掉（而且壞得沒有錯誤訊息，只有打不開的檔案）。
        const r2 = UrlFetchApp.fetch(j1.upload_url, {
          method: 'post',
          payload: blob,
          muteHttpExceptions: true
        });
        if (r2.getResponseCode() >= 300) {
          console.error('上傳內容失敗:', r2.getResponseCode(), name);
          result.failed++; result.failedNames.push(name);
          return;
        }

        // ③ 完成並貼到對話（thread 內）
        const r3 = UrlFetchApp.fetch('https://slack.com/api/files.completeUploadExternal', {
          method: 'post',
          contentType: 'application/json',
          headers: auth,
          payload: JSON.stringify({
            files: [{ id: j1.file_id, title: name }],
            channel_id: conv.channel,
            thread_ts: conv.thread || undefined
          }),
          muteHttpExceptions: true
        });
        const j3 = JSON.parse(r3.getContentText());
        if (!j3.ok) {
          console.error('completeUploadExternal 失敗:', j3.error, name);
          result.failed++; result.failedNames.push(name);
          return;
        }
        result.ok++;
      } catch (err) {
        console.error('附件上傳異常:', name, err);
        result.failed++; result.failedNames.push(name);
      }
    });

    return result;
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
