const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

function createAppServerError(message, code = 'APP_SERVER_FAILED') {
  return Object.assign(new Error(message), { code });
}

function statusFromProtocol(status) {
  const type = typeof status === 'string' ? status : String(status && status.type || '');
  return type === 'active' ? 'running' : 'idle';
}

/**
 * AI:定位 Codex Desktop 当前安装版本附带的 app-server 可执行文件。
 *
 * @param {{localAppData?: string, filesystem?: typeof fs}} options 环境与文件系统依赖。
 * @returns {string} 最新内置 codex.exe 的绝对路径，未找到时返回空字符串。
 */
function findDesktopCodexExecutable(options = {}) {
  const filesystem = options.filesystem || fs;
  const localAppData = String(options.localAppData || process.env.LOCALAPPDATA || '').trim();
  if (!localAppData) return '';

  const binDirectory = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  let entries;
  try {
    entries = filesystem.readdirSync(binDirectory, { withFileTypes: true });
  } catch {
    return '';
  }

  const candidates = entries.map(entry => {
    if (!entry || typeof entry.isDirectory !== 'function' || !entry.isDirectory()) return null;
    const executable = path.join(binDirectory, entry.name, 'codex.exe');
    try {
      const stat = filesystem.statSync(executable);
      if (!stat.isFile()) return null;
      return { executable, mtimeMs: Number(stat.mtimeMs) || 0 };
    } catch {
      return null;
    }
  }).filter(Boolean);

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0] ? candidates[0].executable : '';
}

/**
 * AI:生成与 Codex Desktop 会话格式匹配的 app-server 启动命令。
 *
 * @param {{platform?: string, localAppData?: string, filesystem?: typeof fs}} options 平台与文件系统依赖。
 * @returns {{command: string, args: string[], source: string}} 子进程命令。
 * @throws {Error} Windows 未安装可用 Codex Desktop 时抛出明确错误。
 */
function resolveAppServerLaunch(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') {
    return { command: 'codex', args: ['app-server'], source: 'path' };
  }

  const executable = findDesktopCodexExecutable(options);
  if (!executable) {
    throw createAppServerError(
      '未找到 Codex Desktop 内置的 codex.exe，无法启动与桌面会话格式匹配的 App Server。',
      'APP_SERVER_EXECUTABLE_NOT_FOUND',
    );
  }
  return { command: executable, args: ['app-server'], source: 'desktop' };
}

/**
 * AI:管理本机 codex app-server 的 JSON-RPC stdio 连接。
 */
class CodexAppServerClient extends EventEmitter {
  /**
   * @param {{spawnProcess?: Function, requestTimeoutMs?: number, logger?: object, launchResolver?: Function}} options 子进程与协议配置。
   */
  constructor(options = {}) {
    super();
    this.spawnProcess = options.spawnProcess || spawn;
    this.requestTimeoutMs = Math.max(1000, Number(options.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS);
    this.logger = options.logger || console;
    this.launchResolver = options.launchResolver || resolveAppServerLaunch;
    this.child = null;
    this.starting = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.stdoutBuffer = '';
    this.runtimes = new Map();
  }

  /**
   * 启动并初始化 app-server。
   *
   * @returns {Promise<object>} initialize 响应。
   */
  async start() {
    if (this.isRunning()) return { alreadyRunning: true };
    if (this.starting) return this.starting;
    this.starting = this.startInternal().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /**
   * @returns {boolean} 子进程是否仍在运行。
   */
  isRunning() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  async startInternal() {
    let launch;
    try {
      launch = this.launchResolver();
    } catch (error) {
      throw error && error.code
        ? error
        : createAppServerError(`无法定位 codex app-server：${error.message}`, 'APP_SERVER_START_FAILED');
    }
    let child;
    try {
      child = this.spawnProcess(launch.command, launch.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      throw createAppServerError(`无法启动 codex app-server：${error.message}`, 'APP_SERVER_START_FAILED');
    }
    if (!child || !child.stdin || !child.stdout || !child.stderr) {
      throw createAppServerError('codex app-server 未提供可用的 stdio 通道。', 'APP_SERVER_START_FAILED');
    }
    this.child = child;
    this.emit('launch', launch);
    this.attachChild(child);
    try {
      const initialized = await this.request('initialize', {
        clientInfo: { name: 'codex-windows-agent', version: '0.2.0' },
        capabilities: { experimentalApi: true },
      });
      this.emit('ready', initialized);
      return initialized;
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  attachChild(child) {
    child.stdout.on('data', data => this.handleStdout(data));
    child.stderr.on('data', data => {
      const message = String(data || '').trim();
      if (message) this.emit('stderr', message);
    });
    child.on('error', error => this.handleExit(error, null, null));
    child.on('close', (code, signal) => this.handleExit(null, code, signal));
  }

  handleStdout(data) {
    this.stdoutBuffer += String(data || '');
    let lineEnd = this.stdoutBuffer.indexOf('\n');
    while (lineEnd >= 0) {
      const line = this.stdoutBuffer.slice(0, lineEnd).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(lineEnd + 1);
      if (line) this.handleMessage(line);
      lineEnd = this.stdoutBuffer.indexOf('\n');
    }
  }

  handleMessage(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit('protocol-error', createAppServerError('app-server 返回了无法解析的协议行。', 'APP_SERVER_PROTOCOL_ERROR'));
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, 'id')) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(createAppServerError(
          `app-server 请求 ${pending.method} 失败：${message.error.message || '未知错误'}`,
          'APP_SERVER_RPC_ERROR',
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === 'string') {
      this.applyNotification(message.method, message.params || {});
      this.emit('notification', { method: message.method, params: message.params || {} });
    }
  }

  applyNotification(method, params) {
    const threadId = String(params.threadId || '').trim();
    if (!threadId) return;
    if (method === 'turn/started') {
      const turnId = String(params.turn && params.turn.id || '').trim();
      this.setRuntime(threadId, { state: 'running', turnId });
      return;
    }
    if (method === 'turn/completed') {
      this.setRuntime(threadId, { state: 'idle', turnId: String(params.turn && params.turn.id || '').trim() });
      return;
    }
    if (method === 'thread/status/changed') {
      this.setRuntime(threadId, { state: statusFromProtocol(params.status) });
    }
  }

  setRuntime(threadId, next) {
    const previous = this.runtimes.get(threadId) || {};
    const runtime = {
      state: next.state || previous.state || 'idle',
      turnId: next.turnId || previous.turnId || '',
      observedAt: new Date().toISOString(),
    };
    this.runtimes.set(threadId, runtime);
    this.emit('runtime', { threadId, runtime });
  }

  handleExit(error, code, signal) {
    if (!this.child) return;
    this.child = null;
    const message = error
      ? `app-server 子进程异常：${error.message}`
      : `app-server 子进程已退出：code=${code === null ? 'null' : code} signal=${signal || ''}`;
    const failure = createAppServerError(message, 'APP_SERVER_EXITED');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.pending.clear();
    this.emit('exit', { error, code, signal, message });
  }

  /**
   * 请求 app-server JSON-RPC 方法。
   *
   * @param {string} method 协议方法。
   * @param {object} params 协议参数。
   * @returns {Promise<object>} 协议响应。
   */
  request(method, params = {}) {
    if (!this.isRunning()) return Promise.reject(createAppServerError('app-server 未运行。', 'APP_SERVER_NOT_RUNNING'));
    const id = String(this.nextRequestId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(createAppServerError(`app-server 请求 ${method} 超时。`, 'APP_SERVER_TIMEOUT'));
      }, this.requestTimeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(createAppServerError(`app-server 请求 ${method} 写入失败：${error.message}`, 'APP_SERVER_WRITE_FAILED'));
      }
    });
  }

  async listThreads(options = {}) {
    await this.start();
    const result = await this.request('thread/list', {
      archived: false,
      limit: Math.max(1, Math.min(Number(options.limit) || 100, 200)),
      sortKey: 'updated_at',
      sortDirection: 'desc',
      cursor: options.cursor || null,
    });
    const threads = Array.isArray(result && result.data) ? result.data : [];
    for (const thread of threads) {
      const threadId = String(thread && thread.id || '').trim();
      if (threadId) this.setRuntime(threadId, { state: statusFromProtocol(thread.status) });
    }
    return {
      threads,
      nextCursor: result && result.nextCursor || null,
    };
  }

  async resumeThread(threadId) {
    await this.start();
    return this.request('thread/resume', { threadId, excludeTurns: true });
  }

  async startTurn(threadId, text) {
    await this.start();
    const result = await this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text }],
    });
    const turnId = String(result && result.turn && result.turn.id || '').trim();
    this.setRuntime(threadId, { state: 'running', turnId });
    return result;
  }

  async interruptTurn(threadId) {
    await this.start();
    const runtime = this.runtimes.get(threadId);
    const turnId = String(runtime && runtime.turnId || '').trim();
    if (!turnId || runtime.state !== 'running') {
      throw Object.assign(new Error('该对话没有可停止的活动回复。'), { code: 'THREAD_NOT_RUNNING', status: 409 });
    }
    const result = await this.request('turn/interrupt', { threadId, turnId });
    this.setRuntime(threadId, { state: 'idle', turnId });
    return result;
  }

  getThreadRuntime(threadId) {
    return this.runtimes.get(threadId) || { state: 'unknown', turnId: '', observedAt: '' };
  }

  stop() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    child.kill();
  }
}

function createCodexAppServerClient(options = {}) {
  return new CodexAppServerClient(options);
}

module.exports = {
  CodexAppServerClient,
  createCodexAppServerClient,
  createAppServerError,
  findDesktopCodexExecutable,
  resolveAppServerLaunch,
  statusFromProtocol,
};
