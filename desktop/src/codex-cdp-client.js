const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { CODEX_DESKTOP_PROFILE, selectPrimaryCodexTarget } = require('./codex-desktop-compatibility');

function cdpError(message, code) {
  return Object.assign(new Error(message), { code });
}

/**
 * AI:维护 Codex Desktop 页面的单一持久 CDP 连接。
 */
class CodexCdpClient extends EventEmitter {
  /**
   * @param {{debugPort?: number, fetchImpl?: Function, webSocketFactory?: Function, requestTimeoutMs?: number}} options CDP 依赖。
   */
  constructor(options = {}) {
    super();
    this.debugPort = Number(options.debugPort) || 9229;
    this.fetchImpl = options.fetchImpl || fetch;
    this.webSocketFactory = options.webSocketFactory || (url => new WebSocket(url));
    this.requestTimeoutMs = Math.max(10, Number(options.requestTimeoutMs) || 10000);
    this.profile = options.profile || CODEX_DESKTOP_PROFILE;
    this.targetSelector = options.targetSelector || selectPrimaryCodexTarget;
    this.socket = null;
    this.connecting = null;
    this.nextRequestId = 0;
    this.pending = new Map();
  }

  isConnected() {
    return Boolean(this.socket && this.socket.readyState === 1);
  }

  async connect() {
    if (this.isConnected()) return this;
    if (this.connecting) return this.connecting;
    this.connecting = this.openConnection().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async openConnection() {
    let response;
    try {
      response = await this.fetchImpl(`http://127.0.0.1:${this.debugPort}/json/list`, {
        signal: AbortSignal.timeout(3000),
      });
    } catch (error) {
      throw cdpError(`Codex Desktop CDP 未连接：${error.message}`, 'CDP_UNAVAILABLE');
    }
    if (!response || response.ok === false) {
      throw cdpError('Codex Desktop CDP 目标列表不可用。', 'CDP_UNAVAILABLE');
    }
    const targets = await response.json();
    const target = this.targetSelector(targets, this.debugPort, this.profile);
    if (!target) throw cdpError('未找到 Codex Desktop 页面调试目标。', 'CDP_TARGET_NOT_FOUND');

    const socket = this.webSocketFactory(target.webSocketDebuggerUrl);
    this.socket = socket;
    socket.on('message', data => this.handleMessage(data));
    socket.on('close', (code, reason) => {
      this.handleDisconnect(`CDP 连接已关闭：${code} ${String(reason || '')}`.trim(), socket);
    });
    socket.on('error', error => {
      if (this.listenerCount('error') > 0) this.emit('error', error);
    });
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = error => {
        cleanup();
        reject(cdpError(`Codex Desktop CDP 连接失败：${error.message}`, 'CDP_UNAVAILABLE'));
      };
      const cleanup = () => {
        socket.off('open', onOpen);
        socket.off('error', onError);
      };
      socket.once('open', onOpen);
      socket.once('error', onError);
    });
    this.emit('connected', { debugPort: this.debugPort, targetUrl: target.url });
    return this;
  }

  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      this.emit('protocol-error', cdpError('CDP 返回了无法解析的消息。', 'CDP_PROTOCOL_ERROR'));
      return;
    }
    if (!Object.hasOwn(message, 'id')) {
      if (message.method) this.emit('event', message);
      return;
    }
    const pending = this.pending.get(Number(message.id));
    if (!pending) return;
    this.pending.delete(Number(message.id));
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(cdpError(`CDP ${pending.method} 失败：${message.error.message || '未知错误'}`, 'CDP_PROTOCOL_ERROR'));
      return;
    }
    pending.resolve(message.result || {});
  }

  handleDisconnect(message, socket = this.socket) {
    if (socket && socket !== this.socket) return;
    const failure = cdpError(message || 'Codex Desktop CDP 已断开。', 'CDP_DISCONNECTED');
    this.invalidateConnection(failure);
  }

  /**
   * AI:使当前半开连接立即失效，并以同一原因结束全部等待请求。
   *
   * @param {Error} failure 连接失效原因。
   * @returns {void}
   */
  invalidateConnection(failure) {
    const socket = this.socket;
    this.socket = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.pending.clear();
    this.emit('disconnected', failure);
    if (socket && socket.readyState < 2) {
      if (typeof socket.terminate === 'function') socket.terminate();
      else socket.close();
    }
  }

  async request(method, params = {}) {
    await this.connect();
    if (!this.isConnected()) throw cdpError('Codex Desktop CDP 未连接。', 'CDP_DISCONNECTED');
    const id = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.invalidateConnection(cdpError(`CDP ${method} 请求超时。`, 'CDP_TIMEOUT'));
      }, this.requestTimeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(cdpError(`CDP ${method} 写入失败：${error.message}`, 'CDP_WRITE_FAILED'));
      }
    });
  }

  async evaluate(expression) {
    const result = await this.request('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw cdpError(`Codex Desktop 页面执行失败：${result.exceptionDetails.text || '未知异常'}`, 'CDP_EVALUATION_FAILED');
    }
    return result.result && result.result.value;
  }

  close() {
    if (!this.socket && this.pending.size === 0) return;
    this.invalidateConnection(cdpError('Codex Desktop CDP 已断开。', 'CDP_DISCONNECTED'));
  }
}

module.exports = {
  CodexCdpClient,
  cdpError,
};
