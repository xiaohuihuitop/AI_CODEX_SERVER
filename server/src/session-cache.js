function safeJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function stripCodexUiDirectives(text) {
  const lines = [];
  let inBrowserContext = false;

  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    const isBrowserHeader = /^(?:#+\s*)?In app browser:\s*$/i.test(trimmed);
    const isRequestHeader = /^(?:#+\s*)?My request for Codex:\s*$/i.test(trimmed);
    const isBrowserMeta = /^[-*]\s*(?:The user has the in-app browser open\.?|Current URL:.*)$/i.test(trimmed);

    if (isBrowserHeader) {
      inBrowserContext = true;
      continue;
    }
    if (isRequestHeader) {
      inBrowserContext = false;
      continue;
    }
    if (inBrowserContext) {
      if (!trimmed || isBrowserMeta) continue;
      inBrowserContext = false;
    }
    if (isBrowserMeta) continue;
    lines.push(line);
  }

  return lines
    .filter(line => !/^::[a-z][a-z-]*\{.*\}\s*$/i.test(line.trim()))
    .join('\n')
    .trim();
}

function messageText(content) {
  if (typeof content === 'string') return stripCodexUiDirectives(content);
  if (!Array.isArray(content)) return '';
  return stripCodexUiDirectives(content
    .map(item => item && (item.text || item.message || ''))
    .filter(Boolean)
    .join('\n')
    .trim());
}

function reasoningText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.text === 'string') return stripCodexUiDirectives(payload.text);
  if (!Array.isArray(payload.summary)) return '';
  return stripCodexUiDirectives(payload.summary
    .map(item => item && (item.text || item.summary || ''))
    .filter(Boolean)
    .join('\n')
    .trim());
}

function commentaryText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.message === 'string') return stripCodexUiDirectives(payload.message);
  return messageText(payload.content);
}

function commandCountText(count) {
  return `已运行 ${count} 条命令`;
}

function normalizeLineList(lines) {
  return Array.isArray(lines)
    ? lines.map(line => String(line || '')).filter(line => line.trim())
    : [];
}

/**
 * AI:按完整回合分页缓存消息，保持与 Desktop Agent 的 turnId 游标契约一致。
 *
 * @param {Array<object>} messages 时间正序消息。
 * @param {number|string} limit 最大回合数量。
 * @param {string} before 当前页首个回合游标。
 * @returns {{messages: Array<object>, hasMore: boolean, nextBefore: string, invalidCursor?: boolean}} 分页结果。
 */
function paginateCachedMessagesByTurn(messages, limit = 60, before = '') {
  const turns = [];
  for (const [index, message] of (messages || []).entries()) {
    const turnId = String(message && message.turnId || '').trim();
    const groupKey = turnId || `unidentified:${index}`;
    const previous = turns[turns.length - 1];
    if (!previous || previous.groupKey !== groupKey) turns.push({ groupKey, turnId, messages: [] });
    turns[turns.length - 1].messages.push(message);
  }
  const beforeText = String(before || '').trim();
  let end = turns.length;
  if (beforeText) {
    if (!beforeText.startsWith('turn:')) return { messages: [], hasMore: false, nextBefore: '', invalidCursor: true };
    end = turns.findIndex(turn => turn.turnId === beforeText.slice(5));
    if (end < 0) return { messages: [], hasMore: false, nextBefore: '', invalidCursor: true };
  }
  const max = Math.max(1, Math.min(Number(limit) || 60, 100));
  const start = Math.max(0, end - max);
  const selected = turns.slice(start, end);
  const firstTurnId = selected[0] && selected[0].turnId;
  const hasMore = start > 0 && Boolean(firstTurnId);
  return {
    messages: selected.flatMap(turn => turn.messages),
    hasMore,
    nextBefore: hasMore ? `turn:${firstTurnId}` : '',
  };
}

function normalizeSnapshot(snapshot) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const messages = Array.isArray(source.messages)
    ? source.messages.map(message => ({
      role: message && message.role === 'assistant' ? 'assistant' : 'user',
      label: String(message && message.label || ''),
      text: String(message && message.text || ''),
      timestamp: String(message && message.timestamp || ''),
      turnId: String(message && message.turnId || ''),
    })).filter(message => message.text)
    : [];
  const status = source.status && typeof source.status === 'object'
    ? source.status
    : { active: false, status: 'idle', preview: '', final: '', steps: [], turns: [] };
  return { messages, status };
}

/**
 * AI:生成快照消息的稳定身份，优先使用 JSONL 固有的时间、回合和正文。
 *
 * @param {object} message 消息对象。
 * @returns {string} 稳定身份。
 */
function snapshotMessageKey(message) {
  return [
    message && message.role || '',
    message && message.turnId || '',
    message && message.timestamp || '',
    message && message.text || '',
  ].join('\u0000');
}

/**
 * AI:查找完整序列在另一序列中的起点，处理后续较长快照覆盖先前短快照的情况。
 *
 * @param {string[]} source 被查询序列。
 * @param {string[]} target 待查找序列。
 * @returns {number} 起点，未找到返回 -1。
 */
function findSnapshotSequence(source, target) {
  if (!target.length) return 0;
  if (target.length > source.length) return -1;
  for (let start = 0; start <= source.length - target.length; start += 1) {
    let matched = true;
    for (let index = 0; index < target.length; index += 1) {
      if (source[start + index] !== target[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return start;
  }
  return -1;
}

/**
 * AI:合并 JSONL 的尾部快照，绝不因较短快照删除已缓存的更早消息。
 *
 * @param {Array<object>} existing 已缓存消息。
 * @param {Array<object>} incoming 本次快照消息。
 * @returns {Array<object>} 时间顺序稳定的完整消息序列。
 */
function mergeSnapshotMessages(existing, incoming) {
  const previous = Array.isArray(existing) ? existing : [];
  const next = Array.isArray(incoming) ? incoming : [];
  if (!previous.length) return next;
  if (!next.length) return previous;

  const previousKeys = previous.map(snapshotMessageKey);
  const nextKeys = next.map(snapshotMessageKey);
  if (findSnapshotSequence(nextKeys, previousKeys) !== -1) return next;
  if (findSnapshotSequence(previousKeys, nextKeys) !== -1) return previous;

  let overlap = 0;
  const maxOverlap = Math.min(previousKeys.length, nextKeys.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    const previousTail = previousKeys.slice(previousKeys.length - size);
    const nextHead = nextKeys.slice(0, size);
    if (previousTail.every((key, index) => key === nextHead[index])) {
      overlap = size;
      break;
    }
  }
  if (overlap) return previous.concat(next.slice(overlap));

  const seen = new Set(previousKeys);
  const additions = next.filter(message => {
    const key = snapshotMessageKey(message);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return previous.concat(additions);
}

class CloudSessionCache {
  /**
   * AI:创建云端会话缓存。
   *
   * @param {{maxLinesPerSession?: number}} options 缓存选项。
   */
  constructor(options = {}) {
    this.tokens = new Map();
    this.maxLinesPerSession = Math.max(100, Number(options.maxLinesPerSession) || 20000);
    this.parseSession = options.parseSession || parseSession;
  }

  /**
   * AI:读取 token 对应缓存桶。
   *
   * @param {string} token 设备 token。
   * @returns {{sessions: Map<string, object>, openThreadIds: string[], updatedAt: string}} 缓存桶。
   */
  bucket(token) {
    const key = String(token || '');
    if (!this.tokens.has(key)) {
      this.tokens.set(key, {
        sessions: new Map(),
        openThreadIds: [],
        updatedAt: '',
      });
    }
    return this.tokens.get(key);
  }

  /**
   * AI:应用 Agent 上传的 JSONL 增量。
   *
   * @param {string} token 设备 token。
   * @param {object} payload 同步负载。
   * @returns {{ok: boolean, updatedAt: string, sessionCount: number}} 应用结果。
   */
  applySync(token, payload = {}) {
    const bucket = this.bucket(token);
    const updatedAt = new Date().toISOString();
    bucket.updatedAt = updatedAt;
    const hasAuthoritativeList = Array.isArray(payload.openThreadIds);
    const openThreadIds = hasAuthoritativeList
      ? Array.from(new Set(payload.openThreadIds.map(item => String(item || '').trim()).filter(Boolean)))
      : bucket.openThreadIds;
    const openThreadSet = new Set(openThreadIds);
    let appliedSessionCount = 0;
    let removedSessionCount = 0;

    for (const row of payload.sessions || []) {
      const threadId = String(row.threadId || '').trim();
      // AI:增量内容只能更新当前权威打开线程，避免迟到消息让已归档缓存复活。
      if (!threadId || !openThreadSet.has(threadId)) continue;
      appliedSessionCount += 1;
      const existing = bucket.sessions.get(threadId) || { lines: [] };
      if (row.metadataOnly) {
        if (bucket.sessions.has(threadId)) {
          bucket.sessions.set(threadId, Object.assign({}, existing, {
            name: row.threadName || row.name || existing.name || threadId,
            projectName: row.projectName || existing.projectName || '',
            cwd: row.cwd || existing.cwd || '',
            updatedAt: row.updatedAt || existing.updatedAt || updatedAt,
            sessionFile: row.sessionFile || existing.sessionFile || '',
            mtimeMs: Number(row.mtimeMs || existing.mtimeMs || 0),
          }));
        } else {
          bucket.sessions.set(threadId, {
            threadId,
            name: row.threadName || row.name || threadId,
            projectName: row.projectName || '',
            cwd: row.cwd || '',
            updatedAt: row.updatedAt || updatedAt,
            sessionFile: row.sessionFile || '',
            mtimeMs: Number(row.mtimeMs || 0),
            lines: [],
            parsed: this.parseSession([], threadId),
            statusSinceCache: new Map(),
          });
        }
        continue;
      }
      if (row.snapshot) {
        const snapshot = normalizeSnapshot(row.snapshot);
        const parsed = Object.assign({}, snapshot, {
          messages: mergeSnapshotMessages(existing.parsed && existing.parsed.messages, snapshot.messages),
        });
        bucket.sessions.set(threadId, {
          threadId,
          name: row.threadName || row.name || existing.name || threadId,
          projectName: row.projectName || existing.projectName || '',
          cwd: row.cwd || existing.cwd || '',
          updatedAt: row.updatedAt || updatedAt,
          sessionFile: row.sessionFile || existing.sessionFile || '',
          mtimeMs: Number(row.mtimeMs || existing.mtimeMs || 0),
          lines: existing.lines || [],
          parsed,
          statusSinceCache: new Map(),
        });
        continue;
      }
      const incoming = normalizeLineList(row.lines);
      const lines = row.reset ? incoming : existing.lines.concat(incoming);
      const trimmed = lines.length > this.maxLinesPerSession
        ? lines.slice(lines.length - this.maxLinesPerSession)
        : lines;
      const parsed = this.parseSession(trimmed, threadId);
      const statusSinceCache = new Map();
      for (const since of existing.statusSinceCache instanceof Map ? existing.statusSinceCache.keys() : []) {
        statusSinceCache.set(since, this.parseSession(trimmed, threadId, since).status);
      }
      bucket.sessions.set(threadId, {
        threadId,
        name: row.threadName || row.name || existing.name || threadId,
        projectName: row.projectName || existing.projectName || '',
        cwd: row.cwd || existing.cwd || '',
        updatedAt: row.updatedAt || updatedAt,
        sessionFile: row.sessionFile || existing.sessionFile || '',
        mtimeMs: Number(row.mtimeMs || existing.mtimeMs || 0),
        lines: trimmed,
        parsed,
        statusSinceCache,
      });
    }

    if (hasAuthoritativeList) {
      // AI:权威目录在本次同步内同时驱动展示与物理清理，局部 sessions 增量无权保留已归档内容。
      for (const threadId of bucket.sessions.keys()) {
        if (!openThreadSet.has(threadId)) {
          bucket.sessions.delete(threadId);
          removedSessionCount += 1;
        }
      }
      bucket.openThreadIds = openThreadIds;
    }

    return {
      ok: true,
      updatedAt,
      sessionCount: bucket.sessions.size,
      appliedSessionCount,
      removedSessionCount,
    };
  }

  /**
   * AI:判断线程是否仍属于电脑当前权威打开列表。
   *
   * @param {string} token 设备 token。
   * @param {string} threadId 线程 ID。
   * @returns {boolean} 线程当前是否打开。
   */
  hasOpenThread(token, threadId) {
    const id = String(threadId || '').trim();
    return Boolean(id && this.bucket(token).openThreadIds.includes(id));
  }

  /**
   * AI:列出当前打开线程的缓存快照。
   *
   * @param {string} token 设备 token。
   * @returns {{ok: boolean, threads: Array<object>, cached: boolean}} 线程列表。
   */
  threads(token) {
    const bucket = this.bucket(token);
    const threads = [];
    for (const threadId of bucket.openThreadIds) {
      const session = bucket.sessions.get(threadId);
      if (!session) continue;
      const status = session.parsed.status;
      threads.push({
        id: threadId,
        name: session.name || threadId,
        projectName: session.projectName || '',
        updatedAt: session.updatedAt || bucket.updatedAt || '',
        sessionFile: session.sessionFile || '',
        mtimeMs: session.mtimeMs || 0,
        active: status.active,
        status: status.status,
      });
    }
    return { ok: true, threads, cached: true, updatedAt: bucket.updatedAt || '' };
  }

  /**
   * AI:解析指定线程历史消息。
   *
   * @param {string} token 设备 token。
   * @param {string} threadId 线程 ID。
   * @param {number|string} limit 最大回合数量。
   * @returns {{ok: boolean, available: boolean, threadId: string, sessionFile: string, messages: Array<object>, cached: boolean}} 历史结果。
   */
  history(token, threadId, limit = 120, before = '') {
    const session = this.hasOpenThread(token, threadId)
      ? this.bucket(token).sessions.get(String(threadId || ''))
      : null;
    if (!session) return { ok: true, available: false, threadId, sessionFile: '', messages: [], cached: true };
    const messages = session.parsed.messages || [];
    const page = paginateCachedMessagesByTurn(messages, limit, before);
    return {
      ok: true,
      available: true,
      threadId,
      sessionFile: session.sessionFile || '',
      messages: page.messages,
      hasMore: page.hasMore,
      nextBefore: page.nextBefore,
      invalidCursor: Boolean(page.invalidCursor),
      cached: true,
    };
  }

  /**
   * AI:解析指定线程运行状态。
   *
   * @param {string} token 设备 token。
   * @param {string} threadId 线程 ID。
   * @param {string} since 只用于判断当前轮询窗口状态的起点。
   * @returns {object} 状态结果。
   */
  status(token, threadId, since = '') {
    const session = this.hasOpenThread(token, threadId)
      ? this.bucket(token).sessions.get(String(threadId || ''))
      : null;
    if (!session) {
      return { ok: true, available: false, active: false, status: 'missing', threadId, sessionFile: '', preview: '', final: '', steps: [], turns: [], cached: true };
    }
    const sinceKey = String(since || '');
    let status = session.parsed.status;
    if (sinceKey && session.lines.length) {
      if (!session.statusSinceCache.has(sinceKey)) {
        session.statusSinceCache.set(sinceKey, this.parseSession(session.lines, threadId, sinceKey).status);
        if (session.statusSinceCache.size > 12) {
          const oldest = session.statusSinceCache.keys().next().value;
          session.statusSinceCache.delete(oldest);
        }
      }
      status = session.statusSinceCache.get(sinceKey);
    }
    return Object.assign({}, status, {
      ok: true,
      available: true,
      threadId,
      sessionFile: session.sessionFile || '',
      cached: true,
    });
  }
}

/**
 * AI:解析缓存中的 JSONL 行。
 *
 * @param {string[]} lines JSONL 行。
 * @param {string} threadId 线程 ID。
 * @param {string} since 轮询窗口起点。
 * @returns {{messages: Array<object>, status: object}} 解析结果。
 */
function parseSession(lines, threadId, since = '') {
  const sinceMs = Date.parse(since || '');
  const included = item => Number.isNaN(sinceMs) || Date.parse(item.timestamp || '') >= sinceMs;
  const messages = [];
  const steps = [];
  const turnsById = new Map();
  const seenProcessSteps = new Set();
  const recentCommentarySteps = new Map();
  const commandCountsByTurn = {};
  let currentTurnId = '';
  let latestTurnId = '';
  let active = false;
  let completed = false;
  let startedAt = '';
  let completedAt = '';
  let final = '';

  const ensureTurn = turnId => {
    if (!turnId) return null;
    if (!turnsById.has(turnId)) {
      turnsById.set(turnId, {
        turnId,
        status: 'running',
        steps: [],
        final: '',
        startedAt: '',
        completedAt: '',
      });
    }
    latestTurnId = turnId || latestTurnId;
    return turnsById.get(turnId);
  };
  const pushOrReplace = (rows, enriched, replace) => {
    if (!replace) {
      rows.push(enriched);
      return;
    }
    const index = rows.findIndex(row => row.turnId === enriched.turnId && row.kind === enriched.kind);
    if (index === -1) rows.push(enriched);
    else rows[index] = enriched;
  };
  const addStep = (step, options = {}) => {
    const enriched = Object.assign({ turnId: currentTurnId }, step);
    const replace = options.replace || enriched.kind === 'final';
    const dedupeKey = enriched.kind === 'commentary'
      ? `${enriched.turnId}\u0000${enriched.kind}\u0000${enriched.time}\u0000${enriched.text}`
      : '';
    if (dedupeKey && seenProcessSteps.has(dedupeKey)) return;
    if (dedupeKey) seenProcessSteps.add(dedupeKey);
    if (enriched.kind === 'commentary') {
      const recentKey = `${enriched.turnId}\u0000${enriched.kind}\u0000${enriched.text}`;
      const currentMs = Date.parse(enriched.time || '');
      const previousMs = recentCommentarySteps.get(recentKey);
      if (!Number.isNaN(currentMs) && previousMs !== undefined && Math.abs(currentMs - previousMs) <= 1500) return;
      if (!Number.isNaN(currentMs)) recentCommentarySteps.set(recentKey, currentMs);
    }
    if (options.visible !== false) pushOrReplace(steps, enriched, replace);
    if (!enriched.turnId) return;
    const turn = ensureTurn(enriched.turnId);
    pushOrReplace(turn.steps, enriched, replace);
    if (enriched.kind === 'start') turn.startedAt = enriched.time || turn.startedAt;
    if (enriched.kind === 'final') turn.final = enriched.text || turn.final;
    if (enriched.kind === 'complete') {
      turn.status = 'complete';
      turn.completedAt = enriched.time || turn.completedAt;
    }
    if (enriched.kind === 'interrupted') {
      turn.status = 'interrupted';
      turn.completedAt = enriched.time || turn.completedAt;
      turn.interruptionReason = enriched.reason || '用户停止';
    }
  };

  for (const line of lines || []) {
    const item = safeJson(line);
    if (!item) continue;
    const payload = item.payload || {};
    const visible = included(item);
    if (item.type === 'turn_context') {
      currentTurnId = String(payload.turn_id || payload.turnId || currentTurnId || '').trim();
      ensureTurn(currentTurnId);
    }
    if (item.type === 'event_msg' && payload.type === 'user_message') {
      const text = stripCodexUiDirectives(payload.message);
      if (text) messages.push({ role: 'user', label: '你', text, timestamp: item.timestamp || '', turnId: currentTurnId });
    }
    if (item.type === 'event_msg' && payload.type === 'task_started') {
      currentTurnId = String(payload.turn_id || payload.turnId || currentTurnId || '').trim();
      const previousMessage = messages[messages.length - 1];
      if (previousMessage && previousMessage.role === 'user' && !previousMessage.turnId) previousMessage.turnId = currentTurnId;
      if (visible) {
        active = true;
        completed = false;
        startedAt = item.timestamp || startedAt;
      }
      const turn = ensureTurn(currentTurnId);
      if (turn && item.timestamp) turn.startedAt = item.timestamp;
    }
    if ((item.type === 'event_msg' && payload.type === 'agent_reasoning') || (item.type === 'response_item' && payload.type === 'reasoning')) {
      const text = reasoningText(payload);
      if (text) {
        if (visible) {
          active = true;
          completed = false;
          startedAt = startedAt || item.timestamp || '';
        }
        addStep({ kind: 'reasoning', label: '思考', text, time: item.timestamp || '' }, { visible });
      }
    }
    if (item.type === 'event_msg' && payload.type === 'agent_message') {
      const text = commentaryText(payload);
      if (text) {
        if (visible) {
          if (payload.phase === 'final_answer') {
            final = text;
            active = false;
            completed = true;
            completedAt = item.timestamp || completedAt;
          } else {
            active = true;
            completed = false;
            startedAt = startedAt || item.timestamp || '';
          }
        }
        addStep({
          kind: payload.phase === 'final_answer' ? 'final' : 'commentary',
          label: payload.phase === 'final_answer' ? '回复' : '过程',
          text,
          time: item.timestamp || '',
        }, { visible });
      }
    }
    if (item.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
      const text = messageText(payload.content);
      if (text) {
        if (visible) {
          if (payload.phase === 'final_answer') {
            final = text;
            active = false;
            completed = true;
            completedAt = item.timestamp || completedAt;
          } else {
            active = true;
            completed = false;
          }
        }
        addStep({
          kind: payload.phase === 'final_answer' ? 'final' : payload.phase === 'commentary' ? 'commentary' : 'assistant',
          label: payload.phase === 'commentary' ? '过程' : '回复',
          text,
          time: item.timestamp || '',
        }, { visible });
        if (payload.phase === 'final_answer') messages.push({ role: 'assistant', label: 'Codex', text, timestamp: item.timestamp || '', turnId: currentTurnId });
      }
    }
    if (item.type === 'response_item' && payload.type === 'function_call' && currentTurnId) {
      commandCountsByTurn[currentTurnId] = (commandCountsByTurn[currentTurnId] || 0) + 1;
      if (visible) {
        active = true;
        completed = false;
        startedAt = startedAt || item.timestamp || '';
      }
      addStep({
        kind: 'tools',
        label: '命令',
        text: commandCountText(commandCountsByTurn[currentTurnId]),
        time: item.timestamp || '',
      }, { visible, replace: true });
    }
    if (item.type === 'event_msg' && payload.type === 'task_complete') {
      currentTurnId = String(payload.turn_id || payload.turnId || currentTurnId || '').trim();
      if (visible) {
        active = false;
        completed = true;
        completedAt = item.timestamp || completedAt;
        final = stripCodexUiDirectives(payload.last_agent_message) || final;
      }
      const text = stripCodexUiDirectives(payload.last_agent_message);
      const last = messages[messages.length - 1];
      if (text && !(last && last.role === 'assistant' && last.text === text)) {
        messages.push({ role: 'assistant', label: 'Codex', text, timestamp: item.timestamp || '', turnId: currentTurnId });
      }
      addStep({ kind: 'complete', label: '完成', text: '回复完成', time: item.timestamp || '' }, { visible });
    }
    if (item.type === 'event_msg' && payload.type === 'turn_aborted') {
      currentTurnId = String(payload.turn_id || payload.turnId || currentTurnId || '').trim();
      const reason = String(payload.reason || '').trim();
      if (visible) {
        active = false;
        completed = true;
        completedAt = item.timestamp || completedAt;
      }
      addStep({
        kind: 'interrupted',
        label: '已停止',
        text: '本轮回复已停止',
        reason: !reason || reason === 'interrupted' ? '用户停止' : reason,
        time: item.timestamp || '',
      }, { visible });
    }
  }

  const turns = Array.from(turnsById.values()).map(turn => {
    const hasComplete = turn.steps.some(step => step.kind === 'complete' || step.kind === 'final');
    return Object.assign({}, turn, {
      status: turn.status === 'interrupted' ? 'interrupted' : hasComplete ? 'complete' : active && turn.turnId === latestTurnId ? 'running' : 'idle',
      steps: turn.steps.slice(-30),
    });
  });

  return {
    messages,
    status: {
      active,
      status: completed ? 'complete' : active ? 'running' : 'idle',
      startedAt,
      completedAt,
      preview: final || (active ? 'Codex 正在回复...' : '暂无可显示回复。'),
      final: completed ? final : '',
      steps: steps.slice(-30),
      turns: turns.slice(-10),
    },
  };
}

function createCloudSessionCache(options) {
  return new CloudSessionCache(options);
}

module.exports = {
  CloudSessionCache,
  createCloudSessionCache,
  parseSession,
};
