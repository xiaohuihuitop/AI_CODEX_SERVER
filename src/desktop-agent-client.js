const { WebSocket } = require('ws');

function agentUrlFromServerUrl(serverUrl, token) {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const basePath = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${basePath}/agent`;
  url.search = '';
  url.searchParams.set('token', token);
  return url.toString();
}

async function handleAgentRequest(api, message) {
  if (!message || typeof message.id !== 'string' || typeof message.action !== 'string') {
    return {
      id: typeof message?.id === 'string' ? message.id : '',
      ok: false,
      error: { code: 'INVALID_AGENT_REQUEST', message: 'Agent 请求格式不正确。', status: 400 },
    };
  }
  try {
    return {
      id: message.id,
      ok: true,
      result: await api.handle(message.action, message.payload || {}),
    };
  } catch (error) {
    return {
      id: message.id,
      ok: false,
      error: {
        code: error.code || 'AGENT_HANDLER_FAILED',
        message: error.message || 'Agent 执行失败。',
        status: error.status || 500,
      },
    };
  }
}

function createDesktopAgentClient(options) {
  const url = agentUrlFromServerUrl(options.serverUrl, options.token);
  const api = options.api;
  const ws = new WebSocket(url);
  ws.on('message', async data => {
    let message = null;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    ws.send(JSON.stringify(await handleAgentRequest(api, message)));
  });
  return ws;
}

module.exports = {
  agentUrlFromServerUrl,
  createDesktopAgentClient,
  handleAgentRequest,
};
