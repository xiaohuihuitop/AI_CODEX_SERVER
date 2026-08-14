const path = require('node:path');
const { Worker } = require('node:worker_threads');

/**
 * AI:代理独立线程中的 Codex 会话读取器，使文件解析不阻塞控制线程。
 */
class CodexSessionReaderWorkerClient {
  /**
   * @param {{readerOptions?: object, WorkerClass?: typeof Worker, workerFile?: string}} options Worker 与读取器配置。
   */
  constructor(options = {}) {
    const WorkerClass = options.WorkerClass || Worker;
    const workerFile = options.workerFile || path.join(__dirname, 'codex-session-reader-worker.js');
    this.worker = new WorkerClass(workerFile, { workerData: { readerOptions: options.readerOptions || {} } });
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.worker.on('message', message => this.handleMessage(message));
    this.worker.on('error', error => this.failPending(error));
    this.worker.on('exit', code => {
      if (!this.closed && code !== 0) this.failPending(new Error(`会话读取 Worker 异常退出：${code}`));
    });
  }

  /**
   * AI:发送一个会话读取任务并关联响应。
   *
   * @param {string} action 任务名称。
   * @param {object} payload 任务参数。
   * @returns {Promise<object>} Worker 返回结果。
   */
  request(action, payload) {
    if (this.closed) return Promise.reject(new Error('会话读取 Worker 已关闭。'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, action, payload });
    });
  }

  /**
   * AI:处理 Worker 响应并恢复原始错误码。
   *
   * @param {{id?: number, ok?: boolean, value?: object, error?: object}} message Worker 响应。
   * @returns {void}
   */
  handleMessage(message) {
    const pending = this.pending.get(Number(message && message.id));
    if (!pending) return;
    this.pending.delete(Number(message.id));
    if (message.ok) {
      pending.resolve(message.value);
      return;
    }
    const error = Object.assign(new Error(message.error && message.error.message || '会话读取失败。'), {
      code: message.error && message.error.code || 'SESSION_READER_FAILED',
    });
    pending.reject(error);
  }

  /**
   * AI:Worker 失效时拒绝全部待处理任务。
   *
   * @param {Error} error 失效原因。
   * @returns {void}
   */
  failPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  /**
   * AI:在 Worker 中读取同步批次，并把偏移游标原子写回调用方。
   *
   * @param {Array<object>} targets 会话目标。
   * @param {Map<string, object>} offsets 当前同步游标。
   * @param {object} options 同步选项。
   * @returns {Promise<{sessions: Array<object>, openThreadIds: string[]}>} 同步批次。
   */
  async readKnownThreadSync(targets, offsets, options) {
    const response = await this.request('readKnownThreadSync', {
      targets,
      offsets: Array.from(offsets.entries()),
      options,
    });
    offsets.clear();
    for (const [threadId, offset] of response.offsets || []) offsets.set(threadId, offset);
    return response.result;
  }

  /**
   * @param {string} threadId 线程标识。
   * @param {number|string} limit 最大回合数量。
   * @param {string} before 历史游标。
   * @returns {Promise<object>} 历史分页。
   */
  parseHistory(threadId, limit, before) {
    return this.request('parseHistory', { threadId, limit, before });
  }

  /**
   * @param {{threadId?: string, since?: string}} options 状态查询参数。
   * @returns {Promise<object>} 线程状态。
   */
  parseStatus(options) {
    return this.request('parseStatus', { options });
  }

  /**
   * @returns {Promise<number>} Worker 退出码。
   */
  close() {
    this.closed = true;
    this.failPending(new Error('会话读取 Worker 已关闭。'));
    return this.worker.terminate();
  }
}

module.exports = {
  CodexSessionReaderWorkerClient,
};
