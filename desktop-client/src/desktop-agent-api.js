const { CodexSessionReader } = require('./codex-session-reader');
const { WindowsCodexController } = require('./windows-codex-controller');

function createHttpError(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}

class DesktopAgentApi {
  constructor(options = {}) {
    this.reader = options.reader || new CodexSessionReader();
    this.controller = options.controller || new WindowsCodexController();
    this.now = options.now || (() => Date.now());
    this.activeControlTasks = 0;
  }

  async handle(action, payload = {}) {
    if (action === 'threads') return this.threads();
    if (action === 'history') return this.history(payload);
    if (action === 'status') return this.status(payload);
    if (action === 'send') return this.send(payload);
    if (action === 'stop') return this.stop();
    throw createHttpError('ACTION_NOT_ALLOWED', '不支持的 Agent 动作。', 400);
  }

  async threads() {
    const openThreads = await this.controller.listOpenThreads();
    const rows = this.reader.listOpenThreads(openThreads);
    return Array.isArray(rows) ? { ok: true, threads: rows } : rows;
  }

  async history(payload) {
    return this.reader.parseHistory(payload.threadId || payload.thread || '', payload.limit || 120);
  }

  async status(payload) {
    return this.reader.parseStatus({
      threadId: payload.threadId || payload.thread || '',
      since: payload.since || '',
    });
  }

  async send(payload) {
    const text = typeof payload.text === 'string' ? payload.text : '';
    const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';
    if (!text.trim()) throw createHttpError('EMPTY_TEXT', '请输入文字。', 400);
    if (!threadId) throw createHttpError('THREAD_ID_REQUIRED', '请选择 Codex 线程。', 400);
    const target = this.reader.getThreadTarget(threadId);
    if (!target.available || !target.projectName || !target.threadName) {
      throw createHttpError('THREAD_TARGET_NOT_FOUND', '未找到 Codex Desktop 线程控制目标。', 404);
    }
    const since = new Date(this.now() - 750).toISOString();
    await this.runControlTask(() => this.controller.sendToThread(target, text));
    return {
      ok: true,
      sentAt: new Date(this.now()).toISOString(),
      watch: { since, threadId },
    };
  }

  async stop() {
    await this.runControlTask(() => this.controller.stopResponse());
    return { ok: true, message: '已向 Codex Desktop 发送停止指令。' };
  }

  /**
   * AI:判断 Agent 是否正在控制 Codex Desktop，避免同步任务抢占 UI 控制。
   *
   * @returns {boolean} 是否存在控制任务。
   */
  isBusy() {
    return this.activeControlTasks > 0;
  }

  /**
   * AI:执行会触碰 Codex Desktop UI 的控制任务。
   *
   * @param {Function} task 控制任务。
   * @returns {Promise<*>} 控制任务结果。
   */
  async runControlTask(task) {
    this.activeControlTasks += 1;
    try {
      return await task();
    } finally {
      this.activeControlTasks -= 1;
    }
  }
}

function createDesktopAgentApi(options) {
  return new DesktopAgentApi(options);
}

module.exports = {
  DesktopAgentApi,
  createDesktopAgentApi,
};
