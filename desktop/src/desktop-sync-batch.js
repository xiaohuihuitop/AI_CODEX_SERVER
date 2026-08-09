/**
 * AI:选择下一次会话同步批次，手机控制后的目标线程优先同步。
 *
 * @param {Array<object>} targets 可同步的线程目标。
 * @param {number} cursor 常规轮转游标。
 * @param {number} batchSize 常规批次大小。
 * @param {string} priorityThreadId 需要优先同步的线程标识。
 * @returns {{targets: Array<object>, nextCursor: number, prioritized: boolean}} 选中的线程和下一个常规游标。
 */
function selectSyncBatch(targets, cursor, batchSize, priorityThreadId = '') {
  const rows = Array.isArray(targets) ? targets : [];
  if (!rows.length) return { targets: [], nextCursor: 0, prioritized: false };
  const length = rows.length;
  const rawCursor = Number(cursor) || 0;
  const start = ((rawCursor % length) + length) % length;
  const priorityId = String(priorityThreadId || '').trim();
  const priority = priorityId ? rows.find(target => target.threadId === priorityId) : null;
  if (priority) return { targets: [priority], nextCursor: start, prioritized: true };

  const count = Math.max(1, Math.min(Number(batchSize) || 1, length));
  const batch = [];
  for (let index = 0; index < count; index += 1) {
    batch.push(rows[(start + index) % length]);
  }
  return { targets: batch, nextCursor: (start + batch.length) % length, prioritized: false };
}

/**
 * AI:判断手机控制目标是否已经同步到新的 JSONL 行或完整快照。
 *
 * @param {Array<object>} sessions 本轮待上传会话。
 * @param {string} threadId 需要确认的目标线程。
 * @returns {boolean} 已取得同步证据时返回 true。
 */
function hasControlSyncEvidence(sessions, threadId) {
  const id = String(threadId || '').trim();
  return Boolean(id && (sessions || []).some(session => session && session.threadId === id && (
    Boolean(session.snapshot)
    || (Array.isArray(session.lines) && session.lines.length > 0)
  )));
}

module.exports = {
  hasControlSyncEvidence,
  selectSyncBatch,
};
