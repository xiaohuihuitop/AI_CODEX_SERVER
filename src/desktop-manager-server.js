const http = require('node:http');
const { buildAgentEnv, buildMobileUrl, createDefaultManagerConfig, normalizeManagerConfig } = require('./desktop-manager');
const { readBody, sendJson, sendOptions } = require('./http-utils');

const MAX_BODY_BYTES = 1024 * 1024;

function renderHtml(config) {
  const mobileUrl = config.serverUrl && config.token ? buildMobileUrl(config) : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Desktop Manager</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f6f7f8; color: #111827; }
    main { max-width: 760px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 22px; margin: 0 0 18px; }
    label { display: block; margin: 14px 0 6px; font-size: 13px; color: #4b5563; }
    input { width: 100%; height: 38px; border: 1px solid #c7ccd3; border-radius: 6px; padding: 0 10px; font: inherit; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    button { height: 38px; border: 0; border-radius: 6px; padding: 0 14px; background: #111827; color: white; font: inherit; cursor: pointer; }
    pre { padding: 12px; border: 1px solid #d9dde3; border-radius: 6px; background: white; overflow-x: auto; }
  </style>
</head>
<body>
  <main>
    <h1>Codex Desktop Manager</h1>
    <form method="post" action="/config">
      <label>云端服务器地址</label>
      <input name="serverUrl" value="${config.serverUrl}" placeholder="http://群晖IP:8008">
      <div class="row">
        <div>
          <label>固定 Token</label>
          <input name="token" value="${config.token}">
        </div>
        <div>
          <label>设备名称</label>
          <input name="deviceName" value="${config.deviceName}">
        </div>
      </div>
      <label><input type="checkbox" name="autoStart" ${config.autoStart ? 'checked' : ''}> 开机自启</label>
      <button type="submit">保存配置</button>
    </form>
    <h2>手机访问地址</h2>
    <pre>${mobileUrl}</pre>
    <h2>Agent 环境变量</h2>
    <pre>${JSON.stringify(buildAgentEnv(config), null, 2)}</pre>
  </main>
</body>
</html>`;
}

function parseForm(body) {
  const params = new URLSearchParams(body);
  return normalizeManagerConfig({
    serverUrl: params.get('serverUrl') || '',
    token: params.get('token') || '',
    deviceName: params.get('deviceName') || '',
    autoStart: params.has('autoStart'),
  });
}

function createDesktopManagerServer(options = {}) {
  let config = normalizeManagerConfig(options.config || createDefaultManagerConfig());
  return http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return sendOptions(res);
    if (req.method === 'GET' && req.url.startsWith('/config')) return sendJson(res, 200, { ok: true, config });
    if (req.method === 'POST' && req.url.startsWith('/config')) {
      config = parseForm(await readBody(req, MAX_BODY_BYTES));
      res.writeHead(303, { location: '/' });
      res.end();
      return undefined;
    }
    if (req.method === 'GET' && req.url === '/') {
      const body = renderHtml(config);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
      return undefined;
    }
    return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: '未找到管理页面。' });
  });
}

module.exports = {
  createDesktopManagerServer,
};
