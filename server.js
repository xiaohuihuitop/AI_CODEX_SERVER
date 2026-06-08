const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createToken, isAuthorized } = require('./src/auth');
const { CodexSessionReader } = require('./src/codex-session-reader');
const { readBody, sendJson, sendOptions, serveStatic } = require('./src/http-utils');
const { WindowsCodexController } = require('./src/windows-codex-controller');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 1024 * 1024;
const reader = new CodexSessionReader();
const controller = new WindowsCodexController();

/**
 * 获取本机可访问的手机入口地址。
 *
 * @param {string} token 访问令牌。
 * @returns {string[]} URL 列表。
 */
function getLanUrls(token) {
  const urls = new Set([`http://localhost:${PORT}/?token=${encodeURIComponent(token)}`]);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const net of entries || []) {
      if (net.family === 'IPv4' && !net.internal) {
        urls.add(`http://${net.address}:${PORT}/?token=${encodeURIComponent(token)}`);
      }
    }
  }
  return [...urls];
}

const token = createToken();

/**
 * 校验 HTTP 请求访问令牌。
 *
 * @param {import('node:http').IncomingMessage} req HTTP 请求对象。
 * @param {import('node:http').ServerResponse} res HTTP 响应对象。
 * @returns {boolean} 是否已授权。
 */
function requireAuth(req, res) {
  if (isAuthorized(req, token)) return true;
  sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  return false;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return sendOptions(res);
  if (req.method === 'GET' && req.url.startsWith('/codex/health')) {
    if (!requireAuth(req, res)) return undefined;
    return sendJson(res, 200, {
      ok: true,
      service: 'codex-windows-bridge',
      host: os.hostname(),
      now: new Date().toISOString(),
    });
  }
  if (req.method === 'GET' && req.url.startsWith('/codex/config')) {
    if (!requireAuth(req, res)) return undefined;
    return sendJson(res, 200, { ok: true, service: 'codex-windows-bridge', localOnly: true });
  }
  if (req.method === 'GET' && req.url.startsWith('/codex/threads')) {
    if (!requireAuth(req, res)) return undefined;
    try {
      const openThreads = await controller.listOpenThreads();
      return sendJson(res, 200, { ok: true, threads: reader.listOpenThreads(openThreads) });
    } catch (error) {
      return sendJson(res, 500, {
        ok: false,
        code: error.code || 'CODEX_THREADS_FAILED',
        message: error.message || '读取 Codex Desktop 当前打开线程失败。',
      });
    }
  }
  if (req.method === 'GET' && req.url.startsWith('/codex/history')) {
    if (!requireAuth(req, res)) return undefined;
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      return sendJson(res, 200, reader.parseHistory(url.searchParams.get('thread') || '', url.searchParams.get('limit') || 120));
    } catch (error) {
      return sendJson(res, 500, {
        ok: false,
        code: error.code || 'CODEX_HISTORY_FAILED',
        message: error.message || '读取 Codex 历史失败。',
      });
    }
  }
  if (req.method === 'GET' && req.url.startsWith('/codex/status')) {
    if (!requireAuth(req, res)) return undefined;
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      return sendJson(res, 200, reader.parseStatus({
        threadId: url.searchParams.get('thread') || '',
        since: url.searchParams.get('since') || '',
      }));
    } catch (error) {
      return sendJson(res, 500, {
        ok: false,
        code: error.code || 'CODEX_STATUS_FAILED',
        message: error.message || '读取 Codex 状态失败。',
      });
    }
  }
  if (req.method === 'POST' && req.url.startsWith('/send')) {
    if (!requireAuth(req, res)) return undefined;
    try {
      const payload = JSON.parse(await readBody(req, MAX_BODY_BYTES) || '{}');
      const text = typeof payload.text === 'string' ? payload.text : '';
      const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';
      if (!text.trim()) {
        return sendJson(res, 400, { ok: false, code: 'EMPTY_TEXT', message: '请输入文字。' });
      }
      if (!threadId) {
        return sendJson(res, 400, { ok: false, code: 'THREAD_ID_REQUIRED', message: '请选择 Codex 线程。' });
      }
      const target = reader.getThreadTarget(threadId);
      if (!target.available || !target.projectName || !target.threadName) {
        return sendJson(res, 404, { ok: false, code: 'THREAD_TARGET_NOT_FOUND', message: '未找到 Codex Desktop 线程控制目标。' });
      }
      const since = new Date(Date.now() - 750).toISOString();
      await controller.sendToThread(target, text);
      return sendJson(res, 200, {
        ok: true,
        sentAt: new Date().toISOString(),
        watch: { since, threadId },
      });
    } catch (error) {
      return sendJson(res, error.status || 500, {
        ok: false,
        code: error.code || 'CODEX_SEND_FAILED',
        message: error.message || '发送到 Codex Desktop 失败。',
      });
    }
  }
  if (req.method === 'POST' && req.url.startsWith('/codex/stop')) {
    if (!requireAuth(req, res)) return undefined;
    try {
      await controller.stopResponse();
      return sendJson(res, 200, { ok: true, message: '已向 Codex Desktop 发送停止指令。' });
    } catch (error) {
      return sendJson(res, 500, {
        ok: false,
        code: error.code || 'CODEX_STOP_FAILED',
        message: error.message || '停止 Codex 回复失败。',
      });
    }
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, PUBLIC_DIR);
  return sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '不支持的请求方法。' });
});

server.listen(PORT, HOST, () => {
  console.log('Codex Windows Bridge is running.');
  for (const url of getLanUrls(token)) console.log(`  ${url}`);
});
