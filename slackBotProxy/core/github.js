// ═══════════════════════════════════════════════════════════════════
//  GitHub 整合模組
//  負責呼叫 GitHub Actions repository_dispatch API，以及讀取 augma 的
//  progress.json —— 那是流程狀態的唯一真相來源，GAS 不留副本。
// ═══════════════════════════════════════════════════════════════════

const AUGMA_GITHUB_REPO = '104corp/104.vip.f2e.augma';
const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9]+-[0-9]+$/;

function dispatchPipeline(pipelineType, jiraId, conversation) {
  const cleanJiraId = jiraId.trim().toUpperCase();

  const payload = {
    event_type: pipelineType,
    client_payload: {
      jira_id: cleanJiraId,
      conversation: conversation
    }
  };

  return dispatchWorkflow(payload);
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
