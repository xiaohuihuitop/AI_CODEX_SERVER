const { parentPort, workerData } = require('node:worker_threads');
const { CodexSessionReader } = require('./codex-session-reader');

const reader = new CodexSessionReader(workerData && workerData.readerOptions || {});

/**
 * AI:在独立线程执行会话文件解析，避免大型 JSONL 阻塞 CDP 控制事件循环。
 *
 * @param {{action?: string, payload?: object}} request Worker 请求。
 * @returns {object} 可序列化的解析结果。
 */
function handleRequest(request) {
  const action = String(request && request.action || '');
  const payload = request && request.payload || {};
  if (action === 'readKnownThreadSync') {
    const offsets = new Map(Array.isArray(payload.offsets) ? payload.offsets : []);
    const result = reader.readKnownThreadSync(payload.targets, offsets, payload.options);
    return { result, offsets: Array.from(offsets.entries()) };
  }
  if (action === 'parseHistory') {
    return reader.parseHistory(payload.threadId, payload.limit, payload.before);
  }
  if (action === 'parseStatus') {
    return reader.parseStatus(payload.options);
  }
  throw Object.assign(new Error(`不支持的会话读取任务：${action}`), { code: 'SESSION_READER_ACTION_NOT_ALLOWED' });
}

parentPort.on('message', request => {
  const id = Number(request && request.id);
  try {
    parentPort.postMessage({ id, ok: true, value: handleRequest(request) });
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: { code: error.code || 'SESSION_READER_FAILED', message: error.message || String(error) },
    });
  }
});
