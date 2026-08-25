// ═══════════════════════════════════════════════════════════════════
//  GitHub 整合模組
//  負責呼叫 GitHub Actions repository_dispatch API，以及讀取 augma 的
//  progress.json —— 那是流程狀態的唯一真相來源，GAS 不留副本。
// ═══════════════════════════════════════════════════════════════════

const AUGMA_GITHUB_REPO = '104corp/104.vip.f2e.augma';
const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9]+-[0-9]+$/;
// 提問編號＝分支名 ask/<id> 的後半段，由 ask-workflow 的 Resolve ask id 產生：
// <sanitized-slack-uid>-YYYYMMDD-HHMMSS。這條樣式在 ask-workflow.yml 的
// Validate input 有一份**必須同步**的副本（那邊不能相信呼叫端送什麼）。
const ASK_ID_PATTERN = /^[A-Za-z0-9]+-[0-9]{8}-[0-9]{6}$/;
// 記憶決策的路由鍵。**用點分隔，刻意不與上面兩條 pattern 有交集**：
// `MEM-20260824` 會被 decision.js 的 JIRA_IN_TEXT_RE 認成單號，
// `mem-20260824-031500` 會被 ASK_ID_IN_TEXT_RE 認成 ask 提問編號。
// 兩種誤認都會讓 thread 歸屬被快取六小時然後整串壞掉，而症狀離事發點很遠。
// augma 側 memory-answer.yml 的 Validate input 有一份**必須同步**的副本。
const MEMORY_ID_PATTERN = /^mem\.[0-9]{8}\.[0-9]{6}$/;

function dispatchPipeline(pipelineType, jiraId, conversation, userId) {
  const cleanJiraId = jiraId.trim().toUpperCase();

  const clean = {
    jira_id: cleanJiraId,
    conversation: conversation
  };

  // 觸發者的 Slack UID。augma 那側寫進 progress.json 的 requester 欄位——
  // 那是唯一進版控的觸發紀錄（commit author 一律是 augma-bot、conversation
  // 只有 channel/thread，兩者都還不出「誰叫的」）。
  //
  // 送 raw id 而不是顯示名，理由與 dispatchAsk 相同：顯示名可能含點或中文，
  // 而 augma 那側以 ^[A-Za-z0-9][A-Za-z0-9-]*$ 白名單擋外部輸入。
  // 差別是這裡**沒有** 'unknown' fallback——progress.json 的 requester 留空
  // 代表「手動觸發，本來就沒有觸發者」，填 'unknown' 反而看起來像有值卻查不到人。
  const uid = String(userId || '').replace(/[^A-Za-z0-9]/g, '');
  if (uid) {
    clean.user_id = uid;
  }

  return dispatchWorkflow({ event_type: pipelineType, client_payload: clean });
}

function dispatchResume(jiraId, pipeline, questionId, choice, user) {
  const payload = {
    event_type: 'resume',
    client_payload: {
      jira_id: jiraId,
      pipeline: pipeline,
      question_id: questionId,
      answer: choice,
      user: user,
      resume: true
    }
  };

  return dispatchWorkflow(payload);
}

// 整份 checkList 貼上：整串原封不動送過去，由 augma 的 answer-batch 自行拆解。
//
// 為什麼不在這裡先拆好再送逐題答案：格式知識屬於 augma。
// `- **Q-001**: A. …` 這個形狀是 checklist.js 的 buildReply() 決定的，它跟
// update-progress.sh 在同一個 repo、同一次 review 裡。放在 GAS 的話，格式改一次
// 就要重新部署 Apps Script，而且沒有 CI 會告訴你兩邊不同步。
//
// ⚠️ answer 與 answer_batch **互斥**，一次只送其中一個。resume-workflow.yml
//    兩個都吃，但 apply-answer.sh 會在同時收到時明確失敗——靜默擇一才是真的難查。
//
// ⚠️ client_payload 上限 64 KB、top-level 屬性上限 10 個。這裡是 5 個
//    （單題那條是 6 個），還有空間，但別再無限加欄位。長度截斷由呼叫端負責
//    （_truncateUtf8_），因為只有它知道要怎麼跟使用者說「被截掉了」。
function dispatchResumeBatch(jiraId, pipeline, rawText, user) {
  const payload = {
    event_type: 'resume',
    client_payload: {
      jira_id: jiraId,
      pipeline: pipeline,
      answer_batch: rawText,
      user: user,
      resume: true
    }
  };

  return dispatchWorkflow(payload);
}

// 自由提問。與 pipeline 完全無關：ask-workflow.yml 沒有下游、不碰任何 JIRA 單的
// progress.json，它只是借用同一套 Phase 機制（那套的收工邏輯依賴 progress.json
// 的結算狀態，不借用就得自己重寫一份殺 agent 的邏輯）。
//
// conversation 必須在這裡就定案：答案是幾分鐘後由 augma 主動貼回來的，
// 那時已經沒有任何 Slack 事件可以推導出「要回到哪裡」。
//
// askId 是**續問**：同一個 Slack thread 的追問要回到同一支 ask/<id> 分支，
// 上一輪的問答才看得到（augma 的 ask-new-turn.sh 負責歸檔與重設）。
// 空字串／未傳＝開新的一輪，這個欄位就不放進 payload。
//
// ⚠️ 不放空字串是刻意的：ask-workflow 的 concurrency 分組鍵寫成
//    `client_payload.ask_id || client_payload.user_id`，而 GitHub 表達式的
//    `||` 對空字串會取右邊——放空字串其實也能運作，但 workflow 那邊的
//    `if [ -n "$ASK_CONTINUE_ID" ]` 與這裡「有沒有這個欄位」對不上，
//    日後改任一邊都要重新推一次那條真值表。乾脆讓「沒有」就是不存在。
function dispatchAsk(prompt, userId, conversation, askId) {
  const clean = {
    prompt: prompt,
    // 只用來組分支名（ask/<uid>-<timestamp>），所以送 id 而不是顯示名——
    // 顯示名可能含點或中文，那些在 git ref 裡是雷。
    user_id: String(userId || 'unknown').replace(/[^A-Za-z0-9]/g, ''),
    conversation: conversation
  };

  // 樣式在這裡先驗一次。workflow 那邊會再驗同一條（它不能相信呼叫端），
  // 但擋在這裡的好處是：對不上就當新的一輪，人拿得到答案；送過去才被打回來
  // 的話 Actions log 會多一則沒人會看到的 warning。
  const id = String(askId || '').trim();
  if (id && ASK_ID_PATTERN.test(id)) {
    clean.ask_id = id;
  } else if (id) {
    console.warn('dispatchAsk: ask_id 樣式不符，改為開新的一輪：' + id);
  }

  return dispatchWorkflow({ event_type: 'ask', client_payload: clean });
}

// 記憶圖譜的裁決回傳。與 dispatchResume 完全分開，因為那條鏈以 jira_id +
// pipeline + phase 為鍵，而記憶決策三個都沒有（詳見 core/memory.js 開頭）。
//
// conversation 必須在這裡就定案：結果是幾分鐘後由 augma 主動貼回來的，
// 而它沒有 progress.json 可以反查錨點（那一份以 jira_key 為鍵、住在 feature
// 分支上）。這一點與 dispatchAsk 完全同構。
//
// choice 是**選項字母**，不是選項全文。augma 的 memory-answer.yml 用
// `^[A-Za-z]$` 擋掉全文——送全文在今天剛好也能work（選項字面以 "A: " 開頭），
// 而那正是危險的地方：哪天選項文字改成不以字母開頭，那條路會靜默地對到錯的選項。
function dispatchMemoryAnswer(memoryId, questionId, choice, user, conversation) {
  const id = String(memoryId || '').trim();
  if (!MEMORY_ID_PATTERN.test(id)) {
    console.error('dispatchMemoryAnswer: memory_id 樣式不符：' + id);
    return false;
  }
  const letter = String(choice || '').trim().toUpperCase();
  if (!/^[A-Z]$/.test(letter)) {
    console.error('dispatchMemoryAnswer: choice 必須是單一選項字母，收到：' + choice);
    return false;
  }

  return dispatchWorkflow({
    event_type: 'memory-answer',
    client_payload: {
      memory_id: id,
      question_id: String(questionId || ''),
      choice: letter,
      user: String(user || 'unknown'),
      conversation: conversation || {}
    }
  });
}

function dispatchWorkflow(payload) {
  const githubToken = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!githubToken) {
    console.error('❌ 未在 Script Properties 設定 GITHUB_TOKEN');
    return false;
  }

  const url = `https://api.github.com/repos/${AUGMA_GITHUB_REPO}/dispatches`;
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': `token ${githubToken}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'GAS-Alice-Proxy'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const res = UrlFetchApp.fetch(url, options);
    const code = res.getResponseCode();
    return code === 204;
  } catch (err) {
    console.error('呼叫 GitHub API 發生異常:', err);
    return false;
  }
}


// ═══════════════════════════════════════════════════════════════════
//  讀取 progress.json
//
//  augma 把流程狀態全部寄放在 feature/<JIRA_KEY> 分支的 workspace/progress.json，
//  由 commit-phase.sh 持續 push。這裡直讀那一份，刻意**不快取**——
//  快取會製造「GAS 看到的狀態」與「真相」不一致，而那正是要避免的問題。
//
//  讀不到一律回 null（分支還沒建、產物還沒 push、token 權限不足），
//  由呼叫端降級運作：dispatch 是不可失敗的動作，不能被讀取失敗擋下。
// ═══════════════════════════════════════════════════════════════════

function fetchProgress(jiraId) {
  const githubToken = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!githubToken) {
    console.error('❌ 未在 Script Properties 設定 GITHUB_TOKEN');
    return null;
  }

  const key = String(jiraId || '').trim().toUpperCase();
  if (!JIRA_KEY_PATTERN.test(key)) {
    console.error('fetchProgress: 非法的 JIRA key:', jiraId);
    return null;
  }

  // Accept: raw 直接拿檔案內容，不必解 base64（contents API 預設回 JSON 包一層）
  const url = `https://api.github.com/repos/${AUGMA_GITHUB_REPO}/contents/workspace/progress.json` +
              `?ref=feature/${encodeURIComponent(key)}`;

  try {
    const res = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: {
        'Authorization': `token ${githubToken}`,
        'Accept': 'application/vnd.github.raw',
        'User-Agent': 'GAS-Alice-Proxy'
      },
      muteHttpExceptions: true
    });

    const code = res.getResponseCode();
    if (code === 404) {
      // 正常情況：卡片送出時 commit-phase.sh 還沒 push，或這張單尚未建分支
      console.log(`progress.json 尚不存在（${key}，HTTP 404）——降級運作`);
      return null;
    }
    if (code !== 200) {
      console.error(`讀取 progress.json 失敗（${key}，HTTP ${code}）：${res.getContentText().slice(0, 200)}`);
      return null;
    }
    return JSON.parse(res.getContentText());
  } catch (err) {
    console.error('讀取 progress.json 發生異常:', err);
    return null;
  }
}
