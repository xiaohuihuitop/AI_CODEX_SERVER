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
 * AI:检查手机控制目标的落盘与完成证据，发送命令只接受同一回合的数据。
 *
 * @param {Array<object>} sessions 本轮待上传会话。
 * @param {string} threadId 需要确认的目标线程。
 * @param {string} turnId 发送命令对应的回合 ID；停止命令不提供该值。
 * @returns {{accepted: boolean, completed: boolean}} 控制命令的同步阶段。
 */
function inspectControlSyncEvidence(sessions, threadId, turnId = '') {
  const id = String(threadId || '').trim();
  const expectedTurnId = String(turnId || '').trim();
  const matchingSessions = (sessions || []).filter(session => session && session.threadId === id);
  if (!id || !matchingSessions.length) return { accepted: false, completed: false };

  if (!expectedTurnId) {
    const changed = matchingSessions.some(session => Boolean(session.snapshot)
      || (Array.isArray(session.lines) && session.lines.length > 0));
    return { accepted: changed, completed: changed };
  }

  let accepted = false;
  let completed = false;
  for (const session of matchingSessions) {
    const snapshot = session.snapshot || {};
    const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    if (messages.some(message => String(message && message.turnId || '').trim() === expectedTurnId)) accepted = true;
    const turns = Array.isArray(snapshot.status && snapshot.status.turns) ? snapshot.status.turns : [];
    const turn = turns.find(item => String(item && item.turnId || '').trim() === expectedTurnId);
    if (turn) {
      accepted = true;
      if (turn.status === 'complete') completed = true;
    }

    for (const line of Array.isArray(session.lines) ? session.lines : []) {
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = item && item.payload || {};
      const metadata = payload.internal_chat_message_metadata_passthrough || {};
      const lineTurnId = String(payload.turn_id || payload.turnId || metadata.turn_id || metadata.turnId || '').trim();
      if (lineTurnId !== expectedTurnId) continue;
      if (item.type === 'response_item' && payload.type === 'message') accepted = true;
      if (item.type === 'event_msg' && payload.type === 'task_started') accepted = true;
      if (item.type === 'event_msg' && payload.type === 'task_complete') {
        accepted = true;
        completed = true;
      }
    }
  }
  return { accepted, completed };
}

/**
 * AI:推进手机控制同步状态；发送确认后继续保留优先目标，直到同一回合完成。
 *
 * @param {{threadId: string, turnId: string, accepted: boolean, deadline: number}|null} state 当前控制同步状态。
 * @param {{accepted: boolean, completed: boolean}} evidence 本轮读取到的同步证据。
 * @param {number} now 当前时间戳。
 * @returns {{state: object|null, confirmedTurnIds: string[], acceptedNow: boolean, completedNow: boolean, timedOut: boolean}} 状态推进结果。
 */
function advanceControlSyncState(state, evidence, now = Date.now()) {
  if (!state || !state.threadId) {
    return { state: null, confirmedTurnIds: [], acceptedNow: false, completedNow: false, timedOut: false };
  }
  const acceptedNow = !state.accepted && Boolean(evidence && evidence.accepted);
  const completedNow = Boolean(evidence && evidence.completed);
  const confirmedTurnIds = acceptedNow && state.turnId ? [state.turnId] : [];
  if (completedNow) {
    return { state: null, confirmedTurnIds, acceptedNow, completedNow: true, timedOut: false };
  }
  const accepted = state.accepted || acceptedNow;
  if (!accepted && Number(now) >= Number(state.deadline || 0)) {
    return { state: null, confirmedTurnIds: [], acceptedNow: false, completedNow: false, timedOut: true };
  }
  return {
    state: Object.assign({}, state, { accepted }),
    confirmedTurnIds,
    acceptedNow,
    completedNow: false,
    timedOut: false,
  };
}

module.exports = {
  advanceControlSyncState,
  inspectControlSyncEvidence,
  selectSyncBatch,
};
