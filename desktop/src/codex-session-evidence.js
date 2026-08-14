function evidenceError(message, code) {
  return Object.assign(new Error(message), { code });
}

/**
 * AI:用目标 JSONL 的真实记录确认 UI 控制动作已经生效。
 */
class CodexSessionEvidence {
  /**
   * @param {{reader: object, timeoutMs?: number, pollIntervalMs?: number, sleep?: Function}} options 会话读取依赖。
   */
  constructor(options = {}) {
    if (!options.reader) throw new Error('CodexSessionEvidence 缺少会话读取器。');
    this.reader = options.reader;
    this.timeoutMs = Math.max(1, Number(options.timeoutMs) || 12000);
    this.pollIntervalMs = Math.max(1, Number(options.pollIntervalMs) || 100);
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  async waitForTurnStarted(threadId, since = '') {
    if (typeof this.reader.findTurnStartedSince !== 'function') {
      throw evidenceError('会话读取器缺少新回合证据接口。', 'TURN_EVIDENCE_READER_UNAVAILABLE');
    }
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() <= deadline) {
      const matched = this.reader.findTurnStartedSince(threadId, since);
      if (matched) return matched;
      await this.sleep(this.pollIntervalMs);
    }
    throw evidenceError(`等待目标线程开始新回合超时：${threadId}`, 'TURN_START_CONFIRM_TIMEOUT');
  }

  async waitForStopped(threadId, since = '') {
    if (typeof this.reader.findTurnAbortedSince !== 'function') {
      throw evidenceError('会话读取器缺少停止证据接口。', 'STOP_EVIDENCE_READER_UNAVAILABLE');
    }
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() <= deadline) {
      const matched = this.reader.findTurnAbortedSince(threadId, since);
      if (matched) return matched;
      await this.sleep(this.pollIntervalMs);
    }
    throw evidenceError(`等待目标线程停止记录超时：${threadId}`, 'STOP_CONFIRM_TIMEOUT');
  }
}

module.exports = {
  CodexSessionEvidence,
  evidenceError,
};
