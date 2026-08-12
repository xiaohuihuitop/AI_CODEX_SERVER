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
   * @param {{debugPort?: number, processManager?: object, reader: object, cdp?: object}} options 运行时依赖。
   */
  constructor(options = {}) {
    super();
    if (!options.reader) throw new Error('ControlledCodexRuntime 缺少会话读取器。');
    this.debugPort = Number(options.debugPort) || 9230;
    this.processManager = options.processManager || new ControlledCodexProcess();
    this.portOwnerResolver = options.portOwnerResolver || resolvePortOwner;
    this.cdpProbe = options.cdpProbe || probeCdp;
    this.reader = options.reader;
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
  }

  async start() {
    const inspected = await this.processManager.inspect();
    this.version = inspected.app.version;
    const owner = await this.portOwnerResolver(this.debugPort);
    const current = inspected.mainProcess;
    const hasArgument = current && new RegExp(`--remote-debugging-port(?:=|\\s+)${this.debugPort}(?:\\s|$)`).test(current.commandLine);
    const currentOwnsPort = owner && current && Number(owner.pid) === Number(current.pid);
    const probe = hasArgument && currentOwnsPort ? await this.cdpProbe(this.debugPort) : { ok: false };

    let restarted = false;
    let processState = inspected;
    if (!probe.ok) {
      const result = await this.processManager.restart({ debugPort: this.debugPort });
      restarted = true;
      processState = { app: result.app, mainProcess: result.mainProcess };
    }
    await this.cdp.connect();
    this.state = 'ready';
    this.message = `受控 Codex Desktop 已连接：CDP ${this.debugPort}`;
    const details = {
      restarted,
      debugPort: this.debugPort,
      pid: processState.mainProcess && processState.mainProcess.pid || null,
      version: this.version,
    };
    this.emit('ready', details);
    this.cdp.on('disconnected', error => {
      this.state = 'unavailable';
      this.message = error.message;
      this.emit('unavailable', error);
    });
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
    this.cdp.close();
  }
}

module.exports = {
  ControlledCodexRuntime,
};
