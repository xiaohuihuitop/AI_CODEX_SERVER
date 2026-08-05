const { createCodexAppServerClient } = require('./codex-app-server-client');

function requestError(message, code, status) {
  return Object.assign(new Error(message), { code, status });
}

class DesktopAgentApi {
  /**
   * @param {{reader?: object, appServer?: object, listThreads?: Function, now?: Function}} options 本机会话与 app-server 依赖。
   */
  constructor(options = {}) {
    this.reader = options.reader || {};
    this.appServer = options.appServer || createCodexAppServerClient();
    this.listThreadsProvider = options.listThreads;
    this.now = options.now || (() => Date.now());
    this.busy = false;
  }

  isBusy() {
    return this.busy;
  }

  async handle(action, payload = {}) {
    if (this.busy) throw requestError('桌面 Agent 正在处理上一条控制命令。', 'AGENT_BUSY', 409);
    this.busy = true;
    try {
      if (action === 'threads') return await this.listThreads();
      if (action === 'send') return await this.send(payload);
      if (action === 'stop') return await this.stop(payload);
      throw requestError('不支持的 Agent 动作。', 'ACTION_NOT_ALLOWED', 400);
    } finally {
      this.busy = false;
    }
  }

  async listThreads() {
    if (typeof this.listThreadsProvider !== 'function') {
      throw requestError('桌面线程目录不可用。', 'THREAD_CATALOG_UNAVAILABLE', 503);
    }
    const result = await this.listThreadsProvider();
    return {
      ok: true,
      threads: Array.isArray(result && result.threads) ? result.threads : [],
      nextCursor: result && result.nextCursor || null,
    };
  }

  async send(payload) {
    const threadId = String(payload.threadId || '').trim();
    const text = String(payload.text || '').trim();
    if (!threadId) throw requestError('缺少对话标识。', 'THREAD_ID_REQUIRED', 400);
    if (!text) throw requestError('发送内容不能为空。', 'EMPTY_TEXT', 400);

    try {
      await this.appServer.resumeThread(threadId);
    } catch (error) {
      throw requestError(`无法恢复目标对话：${error.message}`, 'THREAD_RESUME_FAILED', 409);
    }
    const started = await this.appServer.startTurn(threadId, text);
    const turnId = String(started && started.turn && started.turn.id || '').trim();
    return {
      ok: true,
      watch: { threadId, turnId, since: new Date(this.now()).toISOString() },
    };
  }

  async stop(payload) {
    const threadId = String(payload.threadId || '').trim();
    if (!threadId) throw requestError('缺少对话标识。', 'THREAD_ID_REQUIRED', 400);
    await this.appServer.interruptTurn(threadId);
    return { ok: true, threadId };
  }
}

function createDesktopAgentApi(options = {}) {
  return new DesktopAgentApi(options);
}

module.exports = {
  DesktopAgentApi,
  createDesktopAgentApi,
  requestError,
};
