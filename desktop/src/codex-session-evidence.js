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
    const minimumTime = Date.parse(String(since || ''));
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() <= deadline) {
      const status = this.reader.parseStatus({ threadId });
      const matched = [...(status.turns || [])].reverse().find(turn => {
        if (!String(turn && turn.turnId || '').trim()) return false;
        const timestamp = Date.parse(String(turn.startedAt || ''));
        return !Number.isFinite(minimumTime) || (Number.isFinite(timestamp) && timestamp >= minimumTime);
      });
      if (matched) {
        return { turnId: String(matched.turnId || ''), observedAt: String(matched.startedAt || new Date().toISOString()) };
      }
      await this.sleep(this.pollIntervalMs);
    }
    throw evidenceError(`等待目标线程开始新回合超时：${threadId}`, 'TURN_START_CONFIRM_TIMEOUT');
  }

  async waitForStopped(threadId) {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() <= deadline) {
      const status = this.reader.parseStatus({ threadId });
      const latest = Array.isArray(status.turns) ? status.turns.at(-1) : null;
      if (status.status !== 'running' && latest && latest.status === 'interrupted') return { status: 'interrupted' };
      await this.sleep(this.pollIntervalMs);
    }
    throw evidenceError(`等待目标线程停止记录超时：${threadId}`, 'STOP_CONFIRM_TIMEOUT');
  }
}

module.exports = {
  CodexSessionEvidence,
  evidenceError,
};
