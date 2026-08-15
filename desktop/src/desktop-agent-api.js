const { applyDesktopRuntimeStatus } = require('./codex-session-reader');

function requestError(message, code, status) {
  return Object.assign(new Error(message), { code, status });
}

class DesktopAgentApi {
  /**
   * AI:创建面向受控官方 Codex Desktop 的控制 API。
   *
   * @param {{reader?: object, queryReader?: object, desktopController?: object, listThreads?: Function, now?: Function}} options 本机线程、异步查询读取器、官方客户端控制器与目录依赖。
   */
  constructor(options = {}) {
    this.reader = options.reader || {};
    this.queryReader = options.queryReader || this.reader;
    this.desktopController = options.desktopController;
    this.listThreadsProvider = options.listThreads;
    this.now = options.now || (() => Date.now());
    this.onControlProgress = typeof options.onControlProgress === 'function' ? options.onControlProgress : null;
    this.maxSendRequestEntries = Math.max(10, Number(options.maxSendRequestEntries) || 500);
    this.sendRequests = new Map();
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
    // AI:本地读取不占用官方客户端控制锁，避免手机刷新被发送或停止操作阻塞。
    if (action === 'history') return this.history(payload);
    if (action === 'status') return this.status(payload);
    if (action === 'send') return this.send(payload);
    if (this.busy) throw requestError('桌面 Agent 正在处理上一条控制命令。', 'AGENT_BUSY', 409);
    this.busy = true;
    try {
      if (action === 'threads') return await this.listThreads();
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

  /**
   * AI:按游标读取本机 Codex JSONL 历史，供 Relay 在 Agent 在线时提供完整分页。
   *
   * @param {{threadId?: string, limit?: number|string, before?: number|string}} payload 历史分页参数。
   * @returns {object} 本机历史页。
   */
  async history(payload) {
    const threadId = String(payload.threadId || '').trim();
    if (!threadId) throw requestError('缺少对话标识。', 'THREAD_ID_REQUIRED', 400);
    if (typeof this.queryReader.parseHistory !== 'function') {
      throw requestError('本机历史读取器不可用。', 'HISTORY_READER_UNAVAILABLE', 503);
    }
    return await this.queryReader.parseHistory(threadId, payload.limit, payload.before);
  }

  /**
   * AI:直接解析本机 JSONL 的运行状态，避免快照缓存缺少 since 窗口事件时返回旧状态。
   *
   * @param {{threadId?: string, since?: string}} payload 状态查询参数。
   * @returns {object} 本机线程状态。
   */
  async status(payload) {
    const threadId = String(payload.threadId || '').trim();
    if (!threadId) throw requestError('缺少对话标识。', 'THREAD_ID_REQUIRED', 400);
    if (typeof this.queryReader.parseStatus !== 'function') {
      throw requestError('本机状态读取器不可用。', 'STATUS_READER_UNAVAILABLE', 503);
    }
    const status = await this.queryReader.parseStatus({ threadId, since: String(payload.since || '') });
    if (!this.desktopController || typeof this.desktopController.getThreadRuntime !== 'function') {
      throw requestError('官方 Codex Desktop 控制器不可用。', 'CODEX_DESKTOP_CONTROL_UNAVAILABLE', 503);
    }
    let runtime;
    this.reportControlProgress('status.reconcile.started', { threadId, localStatus: status.status });
    try {
      runtime = await this.desktopController.getThreadRuntime(threadId);
      this.reportControlProgress('status.reconcile.completed', { threadId, runtimeState: runtime.state });
    } catch (error) {
      this.reportControlProgress('status.reconcile.failed', { threadId, errorCode: error.code || '', error: error.message || String(error) });
      throw requestError(`无法校验官方客户端运行状态：${error.message || String(error)}`, 'CODEX_DESKTOP_STATUS_FAILED', 503);
    }
    return applyDesktopRuntimeStatus(status, runtime);
  }

  async send(payload) {
    const threadId = String(payload.threadId || '').trim();
    const text = String(payload.text || '').trim();
    const clientUserMessageId = String(payload.clientUserMessageId || '').trim();
    if (!threadId) throw requestError('缺少对话标识。', 'THREAD_ID_REQUIRED', 400);
    if (!text) throw requestError('发送内容不能为空。', 'EMPTY_TEXT', 400);
    if (!clientUserMessageId) {
      throw requestError('缺少客户端用户消息标识。', 'CLIENT_USER_MESSAGE_ID_REQUIRED', 400);
    }

    const existing = this.sendRequests.get(clientUserMessageId);
    if (existing) {
      if (existing.threadId !== threadId || existing.text !== text) {
        throw requestError('客户端用户消息标识已被其他内容使用。', 'CLIENT_USER_MESSAGE_ID_CONFLICT', 409);
      }
      this.reportControlProgress('send.deduplicated', { threadId, clientUserMessageId });
      return existing.promise;
    }
    if (this.busy) throw requestError('桌面 Agent 正在处理上一条控制命令。', 'AGENT_BUSY', 409);

    this.busy = true;
    const entry = { threadId, text, promise: null, settled: false };
    entry.promise = this.executeSend({ threadId, text, clientUserMessageId })
      .finally(() => {
        entry.settled = true;
        this.busy = false;
        this.trimSendRequests();
      });
    this.sendRequests.set(clientUserMessageId, entry);
    return entry.promise;
  }

  /**
   * AI:执行首次出现的发送请求，重复请求由 `send` 直接复用同一个结果。
   *
   * @param {{threadId: string, text: string, clientUserMessageId: string}} payload 已校验发送参数。
   * @returns {Promise<object>} 回合监听信息。
   */
  async executeSend(payload) {
    const { threadId, text, clientUserMessageId } = payload;

    this.reportControlProgress('send.received', { threadId, clientUserMessageId, textLength: text.length });
    if (!this.desktopController || typeof this.desktopController.sendMessage !== 'function') {
      throw requestError('官方 Codex Desktop 控制器不可用。', 'CODEX_DESKTOP_CONTROL_UNAVAILABLE', 503);
    }
    let started;
    try {
      this.reportControlProgress('send.desktop.started', { threadId, clientUserMessageId });
      started = await this.desktopController.sendMessage(threadId, text);
    } catch (error) {
      this.reportControlProgress('send.desktop.failed', { threadId, clientUserMessageId, errorCode: error.code || '', error: error.message || String(error) });
      throw requestError(`无法通过官方客户端发送消息：${error.message || String(error)}`, 'CODEX_DESKTOP_SEND_FAILED', 503);
    }
    const turnId = String(started && started.turnId || '').trim();
    if (!turnId) {
      this.reportControlProgress('send.desktop.failed', { threadId, clientUserMessageId, error: 'JSONL 未确认回合标识。' });
      throw requestError('无法通过官方客户端发送消息：JSONL 未确认回合标识。', 'CODEX_DESKTOP_SEND_FAILED', 503);
    }
    this.reportControlProgress('send.desktop.completed', { threadId, turnId, clientUserMessageId });
    return {
      ok: true,
      watch: { threadId, turnId, clientUserMessageId, since: new Date(this.now()).toISOString() },
    };
  }

  /**
   * AI:限制幂等请求记录数量，只淘汰已结束记录，避免进行中请求失去去重依据。
   *
   * @returns {void}
   */
  trimSendRequests() {
    if (this.sendRequests.size <= this.maxSendRequestEntries) return;
    for (const [key, entry] of this.sendRequests) {
      if (!entry.settled) continue;
      this.sendRequests.delete(key);
      if (this.sendRequests.size <= this.maxSendRequestEntries) break;
    }
  }

  async stop(payload) {
    const threadId = String(payload.threadId || '').trim();
    if (!threadId) throw requestError('缺少对话标识。', 'THREAD_ID_REQUIRED', 400);
    this.reportControlProgress('stop.received', { threadId });
    try {
      if (!this.desktopController || typeof this.desktopController.stop !== 'function') {
        throw new Error('官方 Codex Desktop 控制器不可用。');
      }
      await this.desktopController.stop(threadId);
    } catch (error) {
      this.reportControlProgress('stop.failed', { threadId, errorCode: error.code || '', error: error.message || String(error) });
      throw requestError(`无法停止 Codex Desktop 回复：${error.message || String(error)}`, 'CODEX_DESKTOP_CONTROL_FAILED', 503);
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
