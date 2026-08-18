// ═══════════════════════════════════════════════════════════════════
//  GitHub 整合模組
//  負責呼叫 GitHub Actions repository_dispatch API
// ═══════════════════════════════════════════════════════════════════

const AUGMA_GITHUB_REPO = '104corp/104.vip.f2e.augma';

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
