const { EventEmitter } = require('node:events');
const { CodexCdpClient } = require('./codex-cdp-client');
const { CodexDesktopUiController } = require('./codex-desktop-ui-controller');
const { CodexSessionEvidence } = require('./codex-session-evidence');
const { ControlledCodexProcess, probeCdp, resolvePortOwner } = require('./controlled-codex-process');

/**
 * AI:组合受控进程、持久 CDP、官方界面控制和 JSONL 证据链。
 */
class ControlledCodexRuntime extends EventEmitter {
  /**
   * @param {{debugPort?: number, processManager?: object, reader: object, cdp?: object, reconnectIntervalMs?: number, healthCheckIntervalMs?: number}} options 运行时依赖。
   */
  constructor(options = {}) {
    super();
    if (!options.reader) throw new Error('ControlledCodexRuntime 缺少会话读取器。');
    this.debugPort = Number(options.debugPort) || 9230;
    this.processManager = options.processManager || new ControlledCodexProcess();
    this.portOwnerResolver = options.portOwnerResolver || resolvePortOwner;
    this.cdpProbe = options.cdpProbe || probeCdp;
    this.reader = options.reader;
    this.reconnectIntervalMs = Math.max(100, Number(options.reconnectIntervalMs) || 2000);
    this.healthCheckIntervalMs = Math.max(10, Number(options.healthCheckIntervalMs) || 15000);
    this.reconnectTimer = null;
    this.reconnecting = false;
    this.heartbeatTimer = null;
    this.heartbeatRunning = false;
    this.cdp = options.cdp || new CodexCdpClient({ debugPort: this.debugPort });
    this.evidence = options.evidence || new CodexSessionEvidence({ reader: this.reader });
    this.controller = options.controller || new CodexDesktopUiController({
      cdp: this.cdp,
      sessionConfirmer: (threadId, since) => this.evidence.waitForTurnStarted(threadId, since),
      sessionStopConfirmer: threadId => this.evidence.waitForStopped(threadId),
    });
    this.state = 'starting';
    this.message = '正在连接受控 Codex Desktop';
    this.version = '';
    this.cdp.on('disconnected', error => this.handleDisconnected(error));
  }

  /**
   * AI:CDP 短暂断开时立即暴露不可控状态，并安排只重连现有调试目标。
   *
   * @param {Error} error CDP 断开原因。
   * @returns {void}
   */
  handleDisconnected(error) {
    if (this.state === 'stopped') return;
    this.clearHeartbeat();
    this.state = 'unavailable';
    this.message = error && error.message || 'Codex Desktop CDP 已断开。';
    this.emit('unavailable', error);
    this.scheduleReconnect();
  }

  /**
   * AI:避免多个定时器同时重连同一个 CDP 客户端。
   *
   * @returns {void}
   */
  scheduleReconnect() {
    if (this.state === 'stopped' || this.reconnectTimer || this.reconnecting) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, this.reconnectIntervalMs);
  }

  /**
   * AI:安排无副作用的页面探测，提前识别 readyState 仍为 OPEN 的半开连接。
   *
   * @returns {void}
   */
  scheduleHeartbeat() {
    if (this.state !== 'ready' || this.heartbeatTimer || this.heartbeatRunning) return;
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      void this.runHeartbeat();
    }, this.healthCheckIntervalMs);
  }

  /**
   * AI:执行轻量 Runtime.evaluate；失败只触发连接重建，不重放业务命令。
   *
   * @returns {Promise<void>} 本轮探测完成后结束。
   */
  async runHeartbeat() {
    if (this.state !== 'ready' || this.heartbeatRunning) return;
    this.heartbeatRunning = true;
    try {
      await this.cdp.evaluate('1 + 1');
    } catch (error) {
      if (this.state === 'ready') this.handleDisconnected(error);
    } finally {
      this.heartbeatRunning = false;
      this.scheduleHeartbeat();
    }
  }

  /**
   * AI:清理健康探测定时器，避免断线或停止后残留重复探测。
   *
   * @returns {void}
   */
  clearHeartbeat() {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /**
   * AI:恢复同一官方实例的 CDP 连接，不执行进程重启或控制面切换。
   *
   * @returns {Promise<void>} 重连完成或本轮失败后结束。
   */
  async reconnect() {
    if (this.state === 'stopped' || this.reconnecting) return;
    this.reconnecting = true;
    try {
      await this.cdp.connect();
      if (typeof this.cdp.isConnected === 'function' && !this.cdp.isConnected()) {
        throw Object.assign(new Error('Codex Desktop CDP 重连后仍未建立连接。'), { code: 'CDP_RECONNECT_FAILED' });
      }
      this.state = 'ready';
      this.message = `受控 Codex Desktop 已连接：CDP ${this.debugPort}`;
      this.scheduleHeartbeat();
      this.emit('reconnected', {
        reconnected: true,
        debugPort: this.debugPort,
        version: this.version,
      });
    } catch (error) {
      if (this.state !== 'stopped') {
        this.state = 'unavailable';
        this.message = `CDP 自动重连失败：${error.message || String(error)}`;
        this.scheduleReconnect();
      }
    } finally {
      this.reconnecting = false;
    }
  }

  async start() {
    const inspected = await this.processManager.inspect();
    this.version = inspected.app.version;
    const owner = await this.portOwnerResolver(this.debugPort);
    const current = inspected.mainProcess;
    const currentOwnsPort = owner && current && Number(owner.pid) === Number(current.pid);
    // AI:以真实 CDP 探测结果为准，Windows Appx 单实例可能不会把启动参数保留在主进程命令行中。
    const probe = currentOwnsPort ? await this.cdpProbe(this.debugPort) : { ok: false };
    if (!probe.ok) {
      if (owner && !currentOwnsPort) {
        throw Object.assign(new Error(`CDP 端口 ${this.debugPort} 已被其他进程占用：PID ${owner.pid}`), {
          code: 'CDP_PORT_OCCUPIED',
        });
      }
      throw Object.assign(new Error(`Codex Desktop CDP ${this.debugPort} 未就绪，请点击“重启 Codex 启用 CDP”。`), {
        code: 'CDP_NOT_READY',
      });
    }
    await this.cdp.connect();
    this.state = 'ready';
    this.message = `受控 Codex Desktop 已连接：CDP ${this.debugPort}`;
    this.scheduleHeartbeat();
    const details = {
      debugPort: this.debugPort,
      pid: current && current.pid || null,
      version: this.version,
    };
    this.emit('ready', details);
    return details;
  }

  async sendMessage(threadId, text) {
    this.assertReady();
    return this.controller.sendMessage(threadId, text);
  }

  async stop(threadId) {
    this.assertReady();
    return this.controller.stop(threadId);
  }

  async getThreadRuntime(threadId) {
    this.assertReady();
    return this.controller.getThreadRuntime(threadId);
  }

  assertReady() {
    if (this.state !== 'ready') {
      throw Object.assign(new Error(this.message || '受控 Codex Desktop 未就绪。'), { code: 'CONTROLLED_CODEX_NOT_READY' });
    }
  }

  stopRuntime() {
    this.state = 'stopped';
    this.message = 'Agent 已停止';
    this.clearHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.cdp.close();
  }
}

module.exports = {
  ControlledCodexRuntime,
};
