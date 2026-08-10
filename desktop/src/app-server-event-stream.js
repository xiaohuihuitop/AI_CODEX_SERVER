const crypto = require('node:crypto');

/**
 * AI:将 App Server 方法名转换为跨端事件类型。
 *
 * @param {string} method App Server 通知方法。
 * @returns {string} 点分隔事件类型。
 */
function eventTypeFromMethod(method) {
  return String(method || '').trim().replace(/\//g, '.');
}

/**
 * AI:创建单个 Agent 生命周期内的 App Server 有序事件流。
 *
 * @param {{deviceId?: string, streamId?: string, now?: Function}} options 设备、流和时间依赖。
 * @returns {{fromNotification: Function, state: Function}} 事件流接口。
 */
function createAppServerEventStream(options = {}) {
  const deviceId = String(options.deviceId || '').trim();
  const streamId = String(options.streamId || crypto.randomUUID()).trim();
  const now = options.now || (() => new Date().toISOString());
  let lastSeq = 0;

  return {
    fromNotification(method, params = {}) {
      const threadId = String(params.threadId || '').trim();
      if (!threadId) return null;
      const turnId = String(params.turnId || params.turn?.id || '').trim();
      lastSeq += 1;
      return {
        streamId,
        seq: lastSeq,
        eventId: `${streamId}:${lastSeq}`,
        threadId,
        turnId,
        source: 'agent-app-server',
        observedAt: now(),
        type: eventTypeFromMethod(method),
        payload: params,
      };
    },
    state() {
      return { streamId, lastSeq, deviceId };
    },
  };
}

module.exports = {
  createAppServerEventStream,
  eventTypeFromMethod,
};
