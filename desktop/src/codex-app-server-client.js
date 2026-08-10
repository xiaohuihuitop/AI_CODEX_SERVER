const { execFile, spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const VERSION_REQUEST_TIMEOUT_MS = 5000;

function createAppServerError(message, code = 'APP_SERVER_FAILED') {
  return Object.assign(new Error(message), { code });
}

function statusFromProtocol(status) {
  const type = typeof status === 'string' ? status : String(status && status.type || '');
  if (type === 'active') return 'running';
  if (type === 'idle') return 'idle';
  if (type === 'systemError') return 'error';
  if (type === 'notLoaded') return 'notLoaded';
  return 'unknown';
}

/**
 * AI:从 thread/read 响应恢复同一线程的权威运行态。
 *
 * @param {object} thread App Server 返回的线程。
 * @returns {{state: string, turnId: string, turnStatus: string, completedAt: string}} 线程运行态。
 */
function runtimeFromThread(thread) {
  const turns = Array.isArray(thread && thread.turns) ? thread.turns : [];
  const latestTurn = turns[turns.length - 1] || null;
  const activeTurn = [...turns].reverse().find(turn => turn && turn.status === 'inProgress') || null;
  const protocolState = statusFromProtocol(thread && thread.status);
  const selectedTurn = protocolState === 'running' ? activeTurn || latestTurn : latestTurn;
  const turnStatus = String(selectedTurn && selectedTurn.status || '').trim();
  let state = protocolState;
  if (protocolState === 'error' || turnStatus === 'failed') state = 'error';
  else if (turnStatus === 'completed' || turnStatus === 'interrupted') state = 'complete';
  else if (protocolState === 'running') state = 'running';
  const completedAtSeconds = Number(selectedTurn && selectedTurn.completedAt);
  return {
    state,
    turnId: String(selectedTurn && selectedTurn.id || '').trim(),
    turnStatus,
    completedAt: Number.isFinite(completedAtSeconds) && completedAtSeconds > 0
      ? new Date(completedAtSeconds * 1000).toISOString()
      : '',
  };
}

/**
 * AI:从 Codex 可执行文件的版本输出中提取语义版本号。
 *
 * @param {string|Buffer} output `codex --version` 的标准输出。
 * @returns {string} 版本号；输出不符合 Codex 格式时返回空字符串。
 */
function parseCodexVersion(output) {
  const matched = String(output || '').match(/\b(?:codex-cli|codex)\s+([0-9][^\s]*)/i);
  return matched ? matched[1] : '';
}

/**
 * AI:读取即将启动 app-server 的同一 Codex 可执行文件版本，避免管理器误显示 PATH 中的其他 CLI。
 *
 * @param {{command?: string}} launch app-server 启动命令。
 * @param {{execFile?: Function}} options 可注入的进程执行函数。
 * @returns {Promise<string>} 已解析的 Codex 版本号。
 */
function readCodexVersion(launch = {}, options = {}) {
  const command = String(launch.command || '').trim();
  if (!command) {
    return Promise.reject(createAppServerError('无法读取 Codex 版本：缺少 app-server 可执行文件。', 'APP_SERVER_VERSION_FAILED'));
  }
  const executeFile = options.execFile || execFile;
  return new Promise((resolve, reject) => {
    try {
      executeFile(command, ['--version'], {
        windowsHide: true,
        timeout: VERSION_REQUEST_TIMEOUT_MS,
        maxBuffer: 1024,
      }, (error, stdout) => {
        if (error) {
          reject(createAppServerError(`无法读取 Codex 版本：${error.message}`, 'APP_SERVER_VERSION_FAILED'));
          return;
        }
        const version = parseCodexVersion(stdout);
        if (!version) {
          reject(createAppServerError('无法读取 Codex 版本：可执行文件未返回可识别的版本号。', 'APP_SERVER_VERSION_FAILED'));
          return;
        }
        resolve(version);
      });
    } catch (error) {
      reject(createAppServerError(`无法读取 Codex 版本：${error.message}`, 'APP_SERVER_VERSION_FAILED'));
    }
  });
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

  // AI:该函数专门定位 Windows 安装目录，不能使用宿主系统的路径规则。
  const binDirectory = path.win32.join(localAppData, 'OpenAI', 'Codex', 'bin');
  let entries;
  try {
    entries = filesystem.readdirSync(binDirectory, { withFileTypes: true });
  } catch {
    return '';
  }

  const candidates = entries.map(entry => {
    if (!entry || typeof entry.isDirectory !== 'function' || !entry.isDirectory()) return null;
    const executable = path.win32.join(binDirectory, entry.name, 'codex.exe');
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
   * @param {{spawnProcess?: Function, requestTimeoutMs?: number, logger?: object, launchResolver?: Function, versionResolver?: Function, serverRequestHandler?: Function}} options 子进程与协议配置。
   */
  constructor(options = {}) {
    super();
    this.spawnProcess = options.spawnProcess || spawn;
    this.requestTimeoutMs = Math.max(1000, Number(options.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS);
    this.logger = options.logger || console;
    this.launchResolver = options.launchResolver || resolveAppServerLaunch;
    this.versionResolver = options.versionResolver || readCodexVersion;
    this.serverRequestHandler = typeof options.serverRequestHandler === 'function'
      ? options.serverRequestHandler
      : null;
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
    this.resolveRuntimeVersion(launch);
    this.attachChild(child);
    try {
      const initialized = await this.request('initialize', {
        clientInfo: { name: 'codex-windows-agent', version: '0.2.0' },
        capabilities: { experimentalApi: true },
      });
      this.notify('initialized', {});
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

  /**
   * AI:异步上报当前 app-server 对应的运行时版本，不阻塞会话服务初始化。
   *
   * @param {{command: string, args: string[], source: string}} launch 当前 app-server 启动命令。
   * @returns {void}
   */
  resolveRuntimeVersion(launch) {
    Promise.resolve()
      .then(() => this.versionResolver(launch))
      .then(version => {
        const normalized = String(version || '').trim();
        if (!normalized) {
          throw createAppServerError('无法读取 Codex 版本：版本号为空。', 'APP_SERVER_VERSION_FAILED');
        }
        this.emit('version', { launch, version: normalized });
      })
      .catch(error => {
        this.emit('version-error', { launch, error });
      });
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
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    const hasMethod = typeof message.method === 'string';
    const isResponse = hasId && (
      Object.prototype.hasOwnProperty.call(message, 'result')
      || Object.prototype.hasOwnProperty.call(message, 'error')
    );
    if (isResponse) {
      const pending = this.pending.get(String(message.id));
      if (!pending) {
        this.emit('protocol-error', createAppServerError(
          `app-server 返回了未知请求 ID：${String(message.id)}`,
          'APP_SERVER_UNKNOWN_RESPONSE',
        ));
        return;
      }
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
    if (hasId && hasMethod) {
      void this.handleServerRequest(message);
      return;
    }
    if (hasMethod) {
      this.applyNotification(message.method, message.params || {});
      this.emit('notification', { method: message.method, params: message.params || {} });
      return;
    }
    this.emit('protocol-error', createAppServerError('app-server 返回了无法识别的协议消息。', 'APP_SERVER_PROTOCOL_ERROR'));
  }

  /**
   * AI:处理 App Server 主动发起的 JSON-RPC 请求，禁止因误判响应而静默挂起。
   *
   * @param {{id: string|number, method: string, params?: object}} message 主动请求。
   * @returns {Promise<void>} 响应写入完成。
   */
  async handleServerRequest(message) {
    const request = {
      id: String(message.id),
      method: message.method,
      params: message.params || {},
    };
    this.emit('server-request', request);
    if (!this.serverRequestHandler) {
      this.replyError(request.id, -32601, 'App Server 主动请求暂不支持远程处理。');
      return;
    }
    try {
      const result = await this.serverRequestHandler(request);
      this.replyResult(request.id, result === undefined ? null : result);
    } catch (error) {
      this.replyError(request.id, -32000, error.message || 'App Server 主动请求处理失败。');
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
      const turnStatus = String(params.turn && params.turn.status || '').trim();
      this.setRuntime(threadId, {
        state: turnStatus.toLowerCase() === 'failed' ? 'error' : 'complete',
        turnId: String(params.turn && params.turn.id || '').trim(),
        turnStatus,
        completedAt: new Date().toISOString(),
      });
      return;
    }
    if (method === 'thread/status/changed') {
      const nextState = statusFromProtocol(params.status);
      const previous = this.runtimes.get(threadId);
      const state = nextState === 'idle' && (previous && (previous.state === 'complete' || previous.state === 'error'))
        ? previous.state
        : nextState;
      this.setRuntime(threadId, { state });
    }
  }

  setRuntime(threadId, next) {
    const previous = this.runtimes.get(threadId) || {};
    const runtime = {
      state: next.state || previous.state || 'idle',
      turnId: next.turnId || previous.turnId || '',
      turnStatus: Object.prototype.hasOwnProperty.call(next, 'turnStatus') ? next.turnStatus : previous.turnStatus || '',
      completedAt: Object.prototype.hasOwnProperty.call(next, 'completedAt') ? next.completedAt : previous.completedAt || '',
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
        this.writeProtocolMessage({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(createAppServerError(`app-server 请求 ${method} 写入失败：${error.message}`, 'APP_SERVER_WRITE_FAILED'));
      }
    });
  }

  /**
   * AI:发送不需要响应的 JSON-RPC 通知。
   *
   * @param {string} method 协议方法。
   * @param {object} params 协议参数。
   * @returns {void}
   */
  notify(method, params = {}) {
    this.writeProtocolMessage({ method, params });
  }

  /**
   * AI:向 App Server 返回主动请求的成功结果。
   *
   * @param {string|number} id 主动请求 ID。
   * @param {*} result 请求结果。
   * @returns {void}
   */
  replyResult(id, result) {
    this.writeProtocolMessage({ id: String(id), result });
  }

  /**
   * AI:向 App Server 返回主动请求的明确错误。
   *
   * @param {string|number} id 主动请求 ID。
   * @param {number} code JSON-RPC 错误码。
   * @param {string} message 错误文本。
   * @returns {void}
   */
  replyError(id, code, message) {
    this.writeProtocolMessage({ id: String(id), error: { code, message } });
  }

  /**
   * AI:在已建立的 stdio 通道上写入单条协议消息。
   *
   * @param {object} message JSON-RPC 消息。
   * @returns {void}
   */
  writeProtocolMessage(message) {
    if (!this.isRunning()) {
      throw createAppServerError('app-server 未运行。', 'APP_SERVER_NOT_RUNNING');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
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

  /**
   * AI:读取线程及完整回合状态，用于 Agent 重连或事件缺失后的权威校验。
   *
   * @param {string} threadId 线程标识。
   * @returns {Promise<object>} 已写入本地缓存的运行态。
   */
  async refreshThreadRuntime(threadId) {
    await this.start();
    const result = await this.request('thread/read', { threadId, includeTurns: true });
    const thread = result && result.thread;
    if (!thread || String(thread.id || '').trim() !== String(threadId || '').trim()) {
      throw createAppServerError('thread/read 未返回目标线程。', 'APP_SERVER_PROTOCOL_ERROR');
    }
    const runtime = runtimeFromThread(thread);
    this.setRuntime(threadId, runtime);
    return this.getThreadRuntime(threadId);
  }

  async resumeThread(threadId) {
    await this.start();
    return this.request('thread/resume', { threadId, excludeTurns: true });
  }

  async startTurn(threadId, text, clientUserMessageId) {
    await this.start();
    const messageId = String(clientUserMessageId || '').trim();
    if (!messageId) {
      throw createAppServerError('缺少客户端用户消息标识。', 'CLIENT_USER_MESSAGE_ID_REQUIRED');
    }
    const result = await this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text }],
      clientUserMessageId: messageId,
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
    const failure = createAppServerError('app-server 客户端已停止。', 'APP_SERVER_STOPPED');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.pending.clear();
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
  parseCodexVersion,
  readCodexVersion,
  resolveAppServerLaunch,
  runtimeFromThread,
  statusFromProtocol,
};
