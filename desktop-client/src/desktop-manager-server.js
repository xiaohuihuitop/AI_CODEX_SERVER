const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { buildAgentEnv, buildMobileUrl, createDefaultManagerConfig, normalizeManagerConfig } = require('./desktop-manager');
const { createDesktopAgentProcess } = require('./desktop-agent-process');
const { readBody, sendJson, sendOptions } = require('./http-utils');

const MAX_BODY_BYTES = 1024 * 1024;
const STATUS_TIMEOUT_MS = 3500;

/**
 * 转义 HTML 文本。
 *
 * @param {string} value 原始文本。
 * @returns {string} HTML 安全文本。
 */
function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * 获取默认管理器配置路径。
 *
 * @returns {string} 配置文件路径。
 */
function getDefaultConfigPath() {
  return path.join(os.homedir(), '.codex-windows-bridge', 'manager-config.json');
}

/**
 * 读取管理器配置文件。
 *
 * @param {string} configPath 配置文件路径。
 * @returns {{serverUrl: string, token: string, deviceName: string, autoStart: boolean}} 管理器配置。
 */
function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) return createDefaultManagerConfig();
  return normalizeManagerConfig(JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')));
}

/**
 * 写入管理器配置文件。
 *
 * @param {string} configPath 配置文件路径。
 * @param {{serverUrl: string, token: string, deviceName: string, autoStart: boolean}} config 管理器配置。
 * @returns {void}
 */
function saveConfig(configPath, config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(normalizeManagerConfig(config), null, 2)}\n`, 'utf8');
}

/**
 * 带超时执行 fetch。
 *
 * @param {string} url 请求地址。
 * @param {number} timeoutMs 超时时间。
 * @returns {Promise<Response>} HTTP 响应。
 */
async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 探测云端 relay 状态。
 *
 * @param {{serverUrl: string, token: string}} config 管理器配置。
 * @returns {Promise<{configured: boolean, ok: boolean, online: boolean, status?: number, message?: string}>} 云端状态。
 */
async function probeCloud(config) {
  const normalized = normalizeManagerConfig(config);
  if (!normalized.serverUrl || !normalized.token) return { configured: false, ok: false, online: false, message: '未配置云端地址或 Token。' };
  try {
    const url = new URL('/codex/health', normalized.serverUrl);
    url.searchParams.set('token', normalized.token);
    const res = await fetchWithTimeout(url.toString(), STATUS_TIMEOUT_MS);
    const body = await res.json().catch(() => ({}));
    return {
      configured: true,
      ok: Boolean(res.ok && body.ok),
      online: Boolean(body.online),
      status: res.status,
      message: body.message || '',
    };
  } catch (error) {
    return { configured: true, ok: false, online: false, message: error.message };
  }
}

/**
 * 探测 Codex Desktop CDP 端口状态。
 *
 * @returns {Promise<{ok: boolean, targetCount: number, message?: string}>} CDP 状态。
 */
async function probeCodexDebug() {
  try {
    const res = await fetchWithTimeout('http://127.0.0.1:9229/json/list', STATUS_TIMEOUT_MS);
    const targets = await res.json();
    return {
      ok: Array.isArray(targets) && targets.some(target => target.url === 'app://-/index.html'),
      targetCount: Array.isArray(targets) ? targets.length : 0,
      message: '',
    };
  } catch (error) {
    return { ok: false, targetCount: 0, message: error.message };
  }
}

/**
 * 解析表单配置。
 *
 * @param {string} body 表单请求体。
 * @returns {{serverUrl: string, token: string, deviceName: string, autoStart: boolean}} 管理器配置。
 */
function parseForm(body) {
  const params = new URLSearchParams(body);
  return normalizeManagerConfig({
    serverUrl: params.get('serverUrl') || '',
    token: params.get('token') || '',
    deviceName: params.get('deviceName') || '',
    autoStart: params.has('autoStart'),
  });
}

/**
 * 渲染管理器页面。
 *
 * @param {{serverUrl: string, token: string, deviceName: string, autoStart: boolean}} config 管理器配置。
 * @param {{running: boolean, pid: number|null, lastOutput: string[], lastError: string[]}} agentStatus Agent 状态。
 * @returns {string} HTML 页面。
 */
function renderHtml(config, agentStatus) {
  const mobileUrl = config.serverUrl && config.token ? buildMobileUrl(config) : '';
  const agentEnv = JSON.stringify(buildAgentEnv(config), null, 2);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Desktop Manager</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f5f6f7; color: #111827; }
    main { max-width: 860px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 22px; margin: 0 0 18px; }
    h2 { font-size: 15px; margin: 22px 0 10px; }
    label { display: block; margin: 14px 0 6px; font-size: 13px; color: #4b5563; }
    input { box-sizing: border-box; width: 100%; height: 38px; border: 1px solid #c7ccd3; border-radius: 6px; padding: 0 10px; font: inherit; background: white; }
    button { height: 38px; border: 0; border-radius: 6px; padding: 0 14px; background: #111827; color: white; font: inherit; cursor: pointer; }
    button.secondary { background: #e5e7eb; color: #111827; }
    button.danger { background: #b42318; }
    button:disabled { opacity: .48; cursor: not-allowed; }
    pre { padding: 12px; border: 1px solid #d9dde3; border-radius: 6px; background: white; overflow-x: auto; white-space: pre-wrap; }
    section { border-top: 1px solid #d9dde3; padding-top: 16px; margin-top: 18px; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
    .status-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .status { border: 1px solid #d9dde3; border-radius: 6px; padding: 10px; background: white; min-height: 62px; }
    .status strong { display: block; font-size: 13px; margin-bottom: 6px; }
    .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; background: #9ca3af; }
    .dot.ok { background: #12805c; }
    .dot.bad { background: #b42318; }
    .muted { color: #6b7280; font-size: 12px; }
    @media (max-width: 720px) { main { padding: 16px; } .row, .status-grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <h1>Codex Desktop Manager</h1>
    <section>
      <div class="status-grid">
        <div class="status"><strong>云端</strong><span id="cloud"><span class="dot"></span>检测中</span><div class="muted" id="cloudDetail"></div></div>
        <div class="status"><strong>Agent</strong><span id="agent"><span class="dot ${agentStatus.running ? 'ok' : ''}"></span>${agentStatus.running ? '运行中' : '未运行'}</span><div class="muted" id="agentDetail">${agentStatus.pid ? `PID ${agentStatus.pid}` : ''}</div></div>
        <div class="status"><strong>Codex Desktop</strong><span id="codex"><span class="dot"></span>检测中</span><div class="muted" id="codexDetail"></div></div>
      </div>
    </section>
    <section>
      <form method="post" action="/config" id="configForm">
        <label>云端服务器地址</label>
        <input name="serverUrl" value="${escapeHtml(config.serverUrl)}" placeholder="http://群晖IP:8008">
        <div class="row">
          <div>
            <label>固定 Token</label>
            <input name="token" value="${escapeHtml(config.token)}">
          </div>
          <div>
            <label>设备名称</label>
            <input name="deviceName" value="${escapeHtml(config.deviceName)}">
          </div>
        </div>
        <label><input type="checkbox" name="autoStart" ${config.autoStart ? 'checked' : ''}> 开机自启</label>
        <div class="actions">
          <button type="submit">保存配置</button>
          <button type="button" id="restartAgent">Agent 上线/重连</button>
          <button type="button" id="stopAgent" class="danger">停止 Agent</button>
          <button type="button" id="refreshStatus" class="secondary">刷新状态</button>
        </div>
      </form>
    </section>
    <section>
      <h2>手机访问地址</h2>
      <pre id="mobileUrl">${escapeHtml(mobileUrl)}</pre>
      <h2>Agent 环境变量</h2>
      <pre>${escapeHtml(agentEnv)}</pre>
      <h2>Agent 日志</h2>
      <pre id="agentLog">${escapeHtml([...agentStatus.lastOutput, ...agentStatus.lastError].slice(-10).join('\n'))}</pre>
    </section>
  </main>
  <script>
    const setStatus = (id, ok, text, detail = '') => {
      document.getElementById(id).innerHTML = '<span class="dot ' + (ok ? 'ok' : 'bad') + '"></span>' + text;
      const detailEl = document.getElementById(id + 'Detail');
      if (detailEl) detailEl.textContent = detail;
    };
    async function refreshStatus() {
      const res = await fetch('/status', { cache: 'no-store' });
      const data = await res.json();
      setStatus('cloud', data.cloud.ok, data.cloud.ok ? '可访问' : '不可访问', data.cloud.online ? 'Agent 已在线' : (data.cloud.message || 'Agent 未在线'));
      setStatus('agent', data.agent.running, data.agent.running ? '运行中' : '未运行', data.agent.pid ? 'PID ' + data.agent.pid : '');
      setStatus('codex', data.codex.ok, data.codex.ok ? 'CDP 已开放' : 'CDP 不可用', data.codex.message || '');
      document.getElementById('agentLog').textContent = [...(data.agent.lastOutput || []), ...(data.agent.lastError || [])].slice(-10).join('\\n');
    }
    async function postAction(url) {
      const res = await fetch(url, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: '操作失败' }));
        alert(body.message || '操作失败');
      }
      await refreshStatus();
    }
    document.getElementById('restartAgent').addEventListener('click', () => postAction('/agent/restart'));
    document.getElementById('stopAgent').addEventListener('click', () => postAction('/agent/stop'));
    document.getElementById('refreshStatus').addEventListener('click', refreshStatus);
    refreshStatus();
    setInterval(refreshStatus, 5000);
  </script>
</body>
</html>`;
}

/**
 * 创建桌面管理器 HTTP 服务。
 *
 * @param {{config?: object, configPath?: string, agentController?: object, probes?: object, cwd?: string}} options 服务配置。
 * @returns {import('node:http').Server} HTTP 服务。
 */
function createDesktopManagerServer(options = {}) {
  const configPath = options.configPath || getDefaultConfigPath();
  let config = normalizeManagerConfig(options.config || loadConfig(configPath));
  const agentController = options.agentController || createDesktopAgentProcess({ cwd: options.cwd || path.join(__dirname, '..') });
  const probes = {
    cloud: options.probes?.cloud || probeCloud,
    codex: options.probes?.codex || probeCodexDebug,
  };

  async function getStatus() {
    const [cloud, codex] = await Promise.all([probes.cloud(config), probes.codex()]);
    return {
      ok: true,
      config,
      mobileUrl: config.serverUrl && config.token ? buildMobileUrl(config) : '',
      agent: agentController.status(),
      cloud,
      codex,
    };
  }

  return http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return sendOptions(res);
    try {
      if (req.method === 'GET' && req.url.startsWith('/config')) return sendJson(res, 200, { ok: true, config });
      if (req.method === 'GET' && req.url.startsWith('/status')) return sendJson(res, 200, await getStatus());
      if (req.method === 'POST' && req.url.startsWith('/config')) {
        config = parseForm(await readBody(req, MAX_BODY_BYTES));
        saveConfig(configPath, config);
        res.writeHead(303, { location: '/' });
        res.end();
        return undefined;
      }
      if (req.method === 'POST' && req.url.startsWith('/agent/restart')) {
        return sendJson(res, 200, { ok: true, agent: await agentController.restart(config) });
      }
      if (req.method === 'POST' && req.url.startsWith('/agent/stop')) {
        return sendJson(res, 200, { ok: true, agent: agentController.stop() });
      }
      if (req.method === 'GET' && req.url === '/') {
        const body = renderHtml(config, agentController.status());
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(body),
        });
        res.end(body);
        return undefined;
      }
      return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: '未找到管理页面。' });
    } catch (error) {
      return sendJson(res, error.status || 500, {
        ok: false,
        code: error.code || 'MANAGER_FAILED',
        message: error.message || '桌面管理器操作失败。',
      });
    }
  });
}

module.exports = {
  createDesktopManagerServer,
  getDefaultConfigPath,
  loadConfig,
  probeCloud,
  probeCodexDebug,
  renderHtml,
  saveConfig,
};
