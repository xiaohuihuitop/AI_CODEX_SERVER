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
    this.onControlProgress = typeof options.onControlProgress === 'function' ? options.onControlProgress : null;
    this.busy = false;
  }

  /**
   * AI:向 Agent 入口报告不含会话正文的控制执行进度。
   *
   * @param {string} phase 执行阶段。
   * @param {object} details 线程和回合元数据。
   * @returns {void}
   */
  reportControlProgress(phase, details = {}) {
    if (this.onControlProgress) this.onControlProgress({ phase, ...details });
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

    this.reportControlProgress('send.received', { threadId, textLength: text.length });

    try {
      this.reportControlProgress('send.resume.started', { threadId });
      await this.appServer.resumeThread(threadId);
      this.reportControlProgress('send.resume.completed', { threadId });
    } catch (error) {
      this.reportControlProgress('send.resume.failed', { threadId, error: error.message || String(error) });
      throw requestError(`无法恢复目标对话：${error.message}`, 'THREAD_RESUME_FAILED', 409);
    }
    let started;
    try {
      started = await this.appServer.startTurn(threadId, text);
    } catch (error) {
      this.reportControlProgress('send.turn.failed', { threadId, error: error.message || String(error) });
      throw requestError(`无法启动目标对话的回复：${error.message}`, 'TURN_START_FAILED', 502);
    }
    const turnId = String(started && started.turn && started.turn.id || '').trim();
    if (!turnId) {
      this.reportControlProgress('send.turn.failed', { threadId, error: 'app-server 未返回回合标识。' });
      throw requestError('无法启动目标对话的回复：app-server 未返回回合标识。', 'TURN_START_INVALID', 502);
    }
    this.reportControlProgress('send.turn.started', { threadId, turnId });
    return {
      ok: true,
      watch: { threadId, turnId, since: new Date(this.now()).toISOString() },
    };
  }

  async stop(payload) {
    const threadId = String(payload.threadId || '').trim();
    if (!threadId) throw requestError('缺少对话标识。', 'THREAD_ID_REQUIRED', 400);
    this.reportControlProgress('stop.received', { threadId });
    try {
      await this.appServer.interruptTurn(threadId);
    } catch (error) {
      this.reportControlProgress('stop.failed', { threadId, error: error.message || String(error) });
      throw error;
    }
    this.reportControlProgress('stop.completed', { threadId });
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
