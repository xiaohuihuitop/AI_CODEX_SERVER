const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_CODEX_DIR = path.join(os.homedir(), '.codex');

/**
 * 判断字符串是否符合 Codex threadId 格式。
 *
 * @param {unknown} value 待检查值。
 * @returns {boolean} 是否为 threadId。
 */
function isThreadId(value) {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(value);
}

/**
 * 从会话文件名提取 Codex threadId。
 *
 * @param {string} file 会话文件路径或文件名。
 * @returns {string} threadId，未匹配时返回空字符串。
 */
function threadIdFromSessionFile(file) {
  return (path.basename(file || '').match(/([a-f0-9]{8}-[a-f0-9-]{27,})\.jsonl$/i) || [])[1] || '';
}

/**
 * 安全解析 JSON 行。
 *
 * @param {string} line JSONL 单行文本。
 * @returns {object|null} 解析结果。
 */
function safeJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * AI:过滤 Codex Desktop 只用于客户端 UI 的指令行和浏览器上下文。
 *
 * @param {string} text 原始消息文本。
 * @returns {string} 手机端可显示文本。
 */
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

/**
 * 提取 Codex message content 中的文本。
 *
 * @param {unknown} content Codex 消息 content 字段。
 * @returns {string} 规范化文本。
 */
function messageText(content) {
  if (typeof content === 'string') return stripCodexUiDirectives(content);
  if (!Array.isArray(content)) return '';
  return stripCodexUiDirectives(content
    .map(item => item && (item.text || item.message || ''))
    .filter(Boolean)
    .join('\n')
    .trim());
}

/**
 * AI:生成与 Codex Desktop 侧栏一致的线程标题，侧栏以 60 个字符展示首条用户请求。
 *
 * @param {string} text 用户请求文本。
 * @returns {string} 可用于匹配侧栏的线程标题。
 */
function threadTitleFromUserMessage(text) {
  const normalized = stripCodexUiDirectives(text).replace(/\s+/g, ' ').trim();
  const characters = Array.from(normalized);
  return characters.length > 60 ? `${characters.slice(0, 59).join('')}…` : normalized;
}

/**
 * AI:读取会话的线程标题，索引缺失时从首条真实用户请求生成侧栏标题。
 *
 * @param {string} file 会话文件路径。
 * @param {string} indexedName Codex 会话索引标题。
 * @returns {string} 线程标题。
 */
function threadTitleFromSession(file, indexedName) {
  const name = String(indexedName || '').trim();
  if (name) return name;
  for (const item of readJsonl(file)) {
    const payload = item.payload || {};
    if (item.type !== 'event_msg' || payload.type !== 'user_message') continue;
    const title = threadTitleFromUserMessage(payload.message);
    if (title) return title;
  }
  return '';
}

/**
 * 提取 Codex 公开过程摘要文本。
 *
 * @param {object} payload Codex 响应 payload。
 * @returns {string} 过程摘要文本。
 */
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

/**
 * 提取 Codex commentary 阶段的公开过程文本。
 *
 * @param {object} payload Codex 响应 payload。
 * @returns {string} 过程文本。
 */
function commentaryText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.message === 'string') return stripCodexUiDirectives(payload.message);
  return messageText(payload.content);
}

/**
 * 生成工具调用数量文本。
 *
 * @param {number} count 已运行命令数量。
 * @returns {string} 手机端显示文本。
 */
function commandCountText(count) {
  return `已运行 ${count} 条命令`;
}

/**
 * 将 Codex Desktop 已知的可发送状态同步到缺少终止事件的会话。
 *
 * @param {object} status JSONL 解析结果。
 * @param {{state?: string, observedAt?: string}|undefined} desktopRuntime 当前桌面线程运行状态。
 * @returns {object} 统一后的会话状态。
 */
function applyDesktopRuntimeStatus(status, desktopRuntime) {
  if (!desktopRuntime || !status) return status;
  if (desktopRuntime.state === 'running' && status.status !== 'running') {
    return Object.assign({}, status, {
      active: true,
      status: 'running',
      completedAt: '',
      preview: 'Codex 正在回复...',
      final: '',
    });
  }
  const terminalState = desktopRuntime.state === 'error' ? 'error' : 'complete';
  const isTerminal = desktopRuntime.state === 'idle' || desktopRuntime.state === 'complete' || desktopRuntime.state === 'error';
  if (!isTerminal) return status;
  const runtimeTurnId = String(desktopRuntime.turnId || '').trim();
  const currentTurns = Array.isArray(status.turns) ? status.turns : [];
  const runtimeTurnKnown = !runtimeTurnId || currentTurns.some(turn => turn && turn.turnId === runtimeTurnId);
  if (status.status !== 'running' && runtimeTurnKnown && desktopRuntime.state !== 'error') return status;
  const completedAt = String(desktopRuntime.completedAt || desktopRuntime.observedAt || new Date().toISOString());
  const turns = Array.isArray(status.turns) ? status.turns.map(turn => (
    turn.status === 'running'
      ? Object.assign({}, turn, { status: terminalState, completedAt })
      : turn
  )) : [];
  return Object.assign({}, status, {
    active: false,
    status: terminalState,
    completedAt,
    preview: runtimeTurnKnown && status.final ? status.final : terminalState === 'error' ? 'Codex 本轮回复失败。' : 'Codex Desktop 已结束本轮回复。',
    final: runtimeTurnKnown ? status.final : '',
    turns,
  });
}

/**
 * AI:按完整回合分页消息，游标绑定首个回合 ID，不受尾部新增消息影响。
 *
 * @param {Array<object>} messages 时间正序消息。
 * @param {number|string} limit 最大回合数量。
 * @param {string} before 当前页首个回合游标。
 * @returns {{messages: Array<object>, hasMore: boolean, nextBefore: string, invalidCursor?: boolean}} 分页结果。
 */
function paginateMessagesByTurn(messages, limit = 60, before = '') {
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
    const turnId = beforeText.slice(5);
    end = turns.findIndex(turn => turn.turnId === turnId);
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

/**
 * 读取完整 JSONL 文件。
 *
 * @param {string} file JSONL 文件路径。
 * @returns {object[]} JSON 对象列表。
 */
function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(safeJson).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * AI:读取 JSONL 文本行，保留原始行用于云端增量解析。
 *
 * @param {string} file JSONL 文件路径。
 * @returns {string[]} JSONL 原始行。
 */
function readJsonlLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * AI:只读取文件头部查找 session_meta，避免为匹配项目名解析完整会话文件。
 *
 * @param {string} file JSONL 文件路径。
 * @returns {object} session_meta 记录。
 */
function readSessionMeta(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const lines = buffer.toString('utf8', 0, bytesRead).split('\n').filter(Boolean);
    for (const line of lines) {
      const item = safeJson(line);
      if (item && item.type === 'session_meta') return item;
    }
  } catch {
    return {};
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return {};
}

/**
 * AI:读取文件指定字节区间并返回完整 JSONL 行。
 *
 * @param {string} file JSONL 文件路径。
 * @param {number} start 起始字节。
 * @param {number} end 结束字节。
 * @returns {string[]} JSONL 原始行。
 */
function readJsonlRangeLines(file, start, end) {
  const from = Math.max(0, Number(start) || 0);
  const to = Math.max(from, Number(end) || 0);
  const length = to - from;
  if (length <= 0) return [];
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, from);
    return buffer.toString('utf8', 0, bytesRead).split('\n').filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * AI:读取文件尾部 JSONL 行，用于首次打开线程同步。
 *
 * @param {string} file JSONL 文件路径。
 * @param {number} size 文件大小。
 * @param {number} lineLimit 最大行数。
 * @returns {string[]} JSONL 尾部行。
 */
function readTailJsonlLines(file, size, lineLimit) {
  const maxBytes = 2 * 1024 * 1024;
  const start = Math.max(0, Number(size) - maxBytes);
  const lines = readJsonlRangeLines(file, start, size);
  const completeLines = start > 0 ? lines.slice(1) : lines;
  return completeLines.length > lineLimit
    ? completeLines.slice(completeLines.length - lineLimit)
    : completeLines;
}

/**
 * AI:从文件尾部反向读取完整回合，避免后台快照重复解析整份大型会话。
 *
 * @param {string} file JSONL 文件路径。
 * @param {number} turnLimit 需要覆盖的最近回合数量。
 * @returns {object[]} 按原始时间顺序排列的 JSONL 记录。
 */
function visitJsonlBackwards(file, visitor) {
  const chunkSize = 256 * 1024;
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    fd = fs.openSync(file, 'r');
    let position = size;
    let leadingFragment = Buffer.alloc(0);

    while (position > 0) {
      const start = Math.max(0, position - chunkSize);
      const buffer = Buffer.alloc(position - start);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, start);
      const combined = Buffer.concat([buffer.subarray(0, bytesRead), leadingFragment]);
      const parts = [];
      let lineStart = 0;
      for (let index = 0; index < combined.length; index += 1) {
        if (combined[index] !== 0x0A) continue;
        parts.push(combined.subarray(lineStart, index));
        lineStart = index + 1;
      }
      parts.push(combined.subarray(lineStart));
      leadingFragment = start > 0 ? Buffer.from(parts.shift() || Buffer.alloc(0)) : Buffer.alloc(0);
      const items = parts
        .filter(part => part.length)
        .map(part => safeJson(part.toString('utf8')))
        .filter(Boolean);
      if (visitor(items) === false) return;
      position = start;
    }
  } catch {
    return;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * AI:从文件尾部反向读取完整回合，避免后台快照重复解析整份大型会话。
 *
 * @param {string} file JSONL 文件路径。
 * @param {number} turnLimit 需要覆盖的最近回合数量。
 * @returns {object[]} 按原始时间顺序排列的 JSONL 记录。
 */
function readRecentTurnItems(file, turnLimit) {
  const requiredTurns = Math.max(1, Number(turnLimit) || 1) + 1;
  let turnCount = 0;
  let userMessageCount = 0;
  const chunks = [];
  visitJsonlBackwards(file, items => {
    chunks.unshift(items);
    for (const item of items) {
      const payload = item.payload || {};
      if (item.type === 'event_msg' && payload.type === 'task_started') turnCount += 1;
      if (item.type === 'event_msg' && payload.type === 'user_message') userMessageCount += 1;
    }
    return turnCount < requiredTurns || userMessageCount < requiredTurns;
  });
  return chunks.flat();
}

/**
 * AI:从会话尾部查找最近事件，到达调用方给出的时间边界后立即停止。
 *
 * @param {string} file JSONL 文件路径。
 * @param {(item: object) => boolean} matches 目标事件判断。
 * @param {number} minimumTime 最早允许的事件时间戳。
 * @returns {object|null} 最近匹配事件。
 */
function findRecentJsonlItem(file, matches, minimumTime = Number.NEGATIVE_INFINITY) {
  let found = null;
  visitJsonlBackwards(file, items => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      const timestamp = Date.parse(String(item.timestamp || ''));
      if (Number.isFinite(minimumTime) && Number.isFinite(timestamp) && timestamp < minimumTime) return false;
      if (matches(item)) {
        found = item;
        return false;
      }
    }
    return true;
  });
  return found;
}

/**
 * AI:从已解析记录投影用户消息和最终回复，供完整分页与紧凑快照复用。
 *
 * @param {object[]} items JSONL 记录。
 * @returns {Array<object>} 历史消息。
 */
function historyMessagesFromItems(items) {
  const messages = [];
  let currentTurnId = '';
  for (const item of items || []) {
    const payload = item.payload || {};
    if (item.type === 'event_msg' && payload.type === 'user_message') {
      const text = stripCodexUiDirectives(payload.message);
      if (text) messages.push({ role: 'user', label: '你', text, timestamp: item.timestamp || '', turnId: currentTurnId });
    }
    if (item.type === 'event_msg' && payload.type === 'task_started') {
      currentTurnId = String(payload.turn_id || payload.turnId || currentTurnId || '').trim();
      const previousMessage = messages[messages.length - 1];
      if (previousMessage && previousMessage.role === 'user' && !previousMessage.turnId) previousMessage.turnId = currentTurnId;
    }
    if (item.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant' && payload.phase === 'final_answer') {
      const text = messageText(payload.content);
      if (text) messages.push({ role: 'assistant', label: 'Codex', text, timestamp: item.timestamp || '', turnId: currentTurnId });
    }
    if (item.type === 'event_msg' && payload.type === 'task_complete') {
      currentTurnId = String(payload.turn_id || payload.turnId || currentTurnId || '').trim();
      const text = stripCodexUiDirectives(payload.last_agent_message);
      const last = messages[messages.length - 1];
      if (text && !(last && last.role === 'assistant' && last.text === text)) {
        messages.push({ role: 'assistant', label: 'Codex', text, timestamp: item.timestamp || '', turnId: currentTurnId });
      }
    }
  }
  return messages;
}

/**
 * 生成项目名和线程名的匹配键。
 *
 * @param {string} projectName Codex Desktop 项目名。
 * @param {string} threadName Codex Desktop 线程名。
 * @returns {string} 匹配键。
 */
function targetKey(projectName, threadName) {
  return `${String(projectName || '').trim()}\u0000${String(threadName || '').trim()}`;
}

/**
 * 从 Codex 会话 cwd 提取项目目录名。
 *
 * @param {string} cwd Codex 会话记录的工作目录。
 * @returns {string} 项目目录名。
 */
function projectNameFromCwd(cwd) {
  const value = String(cwd || '').trim();
  if (!value) return '';
  return value.includes('\\') ? path.win32.basename(value) : path.basename(value);
}

class CodexSessionReader {
  /**
   * 创建 Codex 会话读取器。
   *
   * @param {{sessionsDir?: string, sessionIndexFile?: string}} options 路径配置。
   */
  constructor(options = {}) {
    this.sessionsDir = options.sessionsDir || path.join(DEFAULT_CODEX_DIR, 'sessions');
    this.sessionIndexFile = options.sessionIndexFile || path.join(DEFAULT_CODEX_DIR, 'session_index.jsonl');
    this.sessionMetaCache = new Map();
  }

  /**
   * 校验 Codex 会话目录存在。
   *
   * @returns {void}
   */
  assertSessionsDir() {
    if (!fs.existsSync(this.sessionsDir)) {
      const error = new Error(`未找到 Codex 会话目录：${this.sessionsDir}`);
      error.code = 'CODEX_SESSIONS_DIR_MISSING';
      throw error;
    }
  }

  /**
   * 列出所有 Codex JSONL 会话文件。
   *
   * @returns {string[]} 会话文件绝对路径。
   */
  sessionFiles() {
    this.assertSessionsDir();
    return fs.readdirSync(this.sessionsDir, { recursive: true })
      .map(item => path.join(this.sessionsDir, item))
      .filter(file => file.endsWith('.jsonl') && fs.statSync(file).isFile());
  }

  /**
   * 读取 Codex 线程索引。
   *
   * @returns {Map<string, {id: string, name: string, updatedAt: string}>} 线程索引。
   */
  readIndex() {
    const byId = new Map();
    for (const item of readJsonl(this.sessionIndexFile)) {
      if (!item.id) continue;
      byId.set(item.id, {
        id: item.id,
        name: item.thread_name || '',
        updatedAt: item.updated_at || '',
      });
    }
    return byId;
  }

  /**
   * 根据 threadId 查找最新会话文件。
   *
   * @param {string} threadId Codex 线程 ID。
   * @returns {string|null} 会话文件路径。
   */
  findFileByThreadId(threadId) {
    if (!isThreadId(threadId)) return null;
    let best = null;
    for (const file of this.sessionFiles()) {
      if (!path.basename(file).includes(threadId)) continue;
      const stat = fs.statSync(file);
      if (!best || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs };
    }
    return best && best.file;
  }

  /**
   * 列出 Codex 线程。
   *
   * @param {number|string} limit 最大返回数量。
   * @returns {Array<object>} 线程列表。
   */
  listThreads(limit = 80) {
    const byId = this.readIndex();
    const rows = [];
    for (const file of this.sessionFiles()) {
      const id = threadIdFromSessionFile(file);
      if (!id) continue;
      const stat = fs.statSync(file);
      const indexed = byId.get(id) || { id, name: '', updatedAt: '' };
      rows.push({
        id,
        name: threadTitleFromSession(file, indexed.name) || '未命名线程',
        updatedAt: indexed.updatedAt || new Date(stat.mtimeMs).toISOString(),
        sessionFile: path.basename(file),
        mtimeMs: stat.mtimeMs,
      });
    }
    return rows
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, Math.max(1, Math.min(Number(limit) || 80, 160)));
  }

  /**
   * 只列出 Codex Desktop 当前打开的线程。
   *
   * @param {Array<{projectName: string, threadName: string}>} openTargets 当前打开线程目标。
   * @returns {Array<object>} 线程列表。
   */
  listOpenThreads(openTargets) {
    const wanted = new Map();
    for (const target of openTargets || []) {
      const key = targetKey(target.projectName, target.threadName);
      if (key !== '\u0000') wanted.set(key, target);
    }

    const byId = this.readIndex();
    const files = this.sessionFiles();
    const rows = [];
    for (const file of files) {
      const id = threadIdFromSessionFile(file);
      if (!id) continue;

      const indexed = byId.get(id) || { id, name: '', updatedAt: '' };
      const meta = readJsonl(file).find(item => item.type === 'session_meta') || {};
      const cwd = String((meta.payload && meta.payload.cwd) || '').trim();
      const projectName = projectNameFromCwd(cwd);
      const threadName = threadTitleFromSession(file, indexed.name) || '未命名线程';
      const opened = wanted.get(targetKey(projectName, threadName));
      if (!opened) continue;

      const stat = fs.statSync(file);
      const runtime = this.parseStatus({ threadId: id, file });
      rows.push({
        id,
        name: threadName,
        projectName,
        updatedAt: indexed.updatedAt || new Date(stat.mtimeMs).toISOString(),
        sessionFile: path.basename(file),
        mtimeMs: stat.mtimeMs,
        active: runtime.active,
        status: runtime.status,
      });
    }

    return rows.sort((a, b) => {
      const aIndex = openTargets.findIndex(item => targetKey(item.projectName, item.threadName) === targetKey(a.projectName, a.name));
      const bIndex = openTargets.findIndex(item => targetKey(item.projectName, item.threadName) === targetKey(b.projectName, b.name));
      return aIndex - bIndex;
    });
  }

  /**
   * AI:读取 Codex Desktop 当前打开线程的会话文件快照。
   *
   * @param {Array<{projectName: string, threadName: string}>} openTargets 当前打开线程目标。
   * @param {Map<string, {size: number}>|object} offsets 已同步偏移。
   * @param {{initialLineLimit?: number, snapshotMessageLimit?: number, syncByteLimit?: number}} options 同步选项。
   * @returns {{sessions: Array<object>, openThreadIds: string[]}} 会话同步快照。
   */
  readOpenThreadSync(openTargets, offsets = new Map(), options = {}) {
    const wanted = new Map();
    for (const target of openTargets || []) {
      const key = targetKey(target.projectName, target.threadName);
      if (key !== '\u0000') wanted.set(key, target);
    }
    const byId = this.readIndex();
    const files = this.sessionFiles();
    const sessions = [];
    const openThreadIds = [];
    const initialLineLimit = Math.max(1, Math.min(Number(options.initialLineLimit) || 800, 5000));

    for (const file of files) {
      const id = threadIdFromSessionFile(file);
      if (!id) continue;
      const indexed = byId.get(id) || { id, name: '', updatedAt: '' };
      const stat = fs.statSync(file);
      const cachedMeta = this.sessionMetaCache.get(file);
      const meta = cachedMeta && cachedMeta.size === stat.size && cachedMeta.mtimeMs === stat.mtimeMs
        ? cachedMeta.meta
        : readSessionMeta(file);
      this.sessionMetaCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, meta });
      const cwd = String((meta.payload && meta.payload.cwd) || '').trim();
      const projectName = projectNameFromCwd(cwd);
      const threadName = threadTitleFromSession(file, indexed.name) || '未命名线程';
      if (!wanted.has(targetKey(projectName, threadName))) continue;

      const previous = offsets instanceof Map ? offsets.get(id) : offsets[id];
      const previousSize = previous && Number(previous.size) > 0 ? Number(previous.size) : 0;
      const reset = previousSize <= 0 || previousSize > stat.size;
      const lines = reset
        ? readTailJsonlLines(file, stat.size, initialLineLimit)
        : readJsonlRangeLines(file, previousSize, stat.size);
      offsets instanceof Map ? offsets.set(id, { size: stat.size }) : offsets[id] = { size: stat.size };
      openThreadIds.push(id);
      if (!lines.length && !reset) continue;
      sessions.push({
        threadId: id,
        threadName,
        projectName,
        cwd,
        updatedAt: indexed.updatedAt || new Date(stat.mtimeMs).toISOString(),
        sessionFile: path.basename(file),
        mtimeMs: stat.mtimeMs,
        reset,
        lines,
      });
    }

    return { sessions, openThreadIds };
  }

  /**
   * AI:低频发现当前打开线程对应的会话文件，避免每次增量同步都扫描完整会话目录。
   *
   * @param {Array<{projectName: string, threadName: string}>} openTargets 当前打开线程目标。
   * @returns {Array<object>} 打开线程会话目标。
   */
  discoverOpenThreadSessions(openTargets) {
    const wanted = new Map();
    for (const target of openTargets || []) {
      const key = targetKey(target.projectName, target.threadName);
      if (key !== '\u0000') wanted.set(key, target);
    }
    const byId = this.readIndex();
    const rows = [];

    for (const file of this.sessionFiles()) {
      const id = threadIdFromSessionFile(file);
      if (!id) continue;
      const indexed = byId.get(id) || { id, name: '', updatedAt: '' };
      const stat = fs.statSync(file);
      const cachedMeta = this.sessionMetaCache.get(file);
      const meta = cachedMeta && cachedMeta.size === stat.size && cachedMeta.mtimeMs === stat.mtimeMs
        ? cachedMeta.meta
        : readSessionMeta(file);
      this.sessionMetaCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, meta });
      const cwd = String((meta.payload && meta.payload.cwd) || '').trim();
      const projectName = projectNameFromCwd(cwd);
      const threadName = threadTitleFromSession(file, indexed.name) || '未命名线程';
      const opened = wanted.get(targetKey(projectName, threadName));
      if (!opened) continue;
      rows.push({
        threadId: id,
        threadName: opened.threadName,
        projectName,
        cwd,
        file,
        updatedAt: indexed.updatedAt || new Date(stat.mtimeMs).toISOString(),
        sessionFile: path.basename(file),
        mtimeMs: stat.mtimeMs,
      });
    }

    return rows.sort((a, b) => {
      const aIndex = openTargets.findIndex(item => targetKey(item.projectName, item.threadName) === targetKey(a.projectName, a.threadName));
      const bIndex = openTargets.findIndex(item => targetKey(item.projectName, item.threadName) === targetKey(b.projectName, b.threadName));
      return aIndex - bIndex;
    });
  }

  /**
   * AI:发现本机全部可同步会话，不依赖 Codex Desktop 当前是否将其打开。
   *
   * @param {number|string} limit 最大会话数量。
   * @returns {Array<object>} 本机会话目标。
   */
  discoverThreadSessions(limit = 160) {
    const byId = this.readIndex();
    const rows = [];
    for (const file of this.sessionFiles()) {
      const threadId = threadIdFromSessionFile(file);
      if (!threadId) continue;
      const indexed = byId.get(threadId) || { id: threadId, name: '', updatedAt: '' };
      const stat = fs.statSync(file);
      const cachedMeta = this.sessionMetaCache.get(file);
      const meta = cachedMeta && cachedMeta.size === stat.size && cachedMeta.mtimeMs === stat.mtimeMs
        ? cachedMeta.meta
        : readSessionMeta(file);
      this.sessionMetaCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, meta });
      const cwd = String((meta.payload && meta.payload.cwd) || '').trim();
      rows.push({
        threadId,
        threadName: threadTitleFromSession(file, indexed.name) || '未命名线程',
        projectName: projectNameFromCwd(cwd),
        cwd,
        file,
        updatedAt: indexed.updatedAt || new Date(stat.mtimeMs).toISOString(),
        sessionFile: path.basename(file),
        mtimeMs: stat.mtimeMs,
      });
    }
    return rows
      .sort((left, right) => Number(right.mtimeMs || 0) - Number(left.mtimeMs || 0))
      .slice(0, Math.max(1, Math.min(Number(limit) || 160, 1000)));
  }

  /**
   * AI:将线程目录映射到本地 JSONL，同步时保留目录给出的 threadId 顺序。
   *
   * @param {Array<{id?: string, name?: string, title?: string, cwd?: string, updatedAt?: number|string}>} threads 线程目录。
   * @param {{preferLocalName?: boolean}} options 标题优先级选项。
   * @returns {Array<object>} 可读取 JSONL 的线程目标。
   */
  discoverCatalogThreadSessions(threads, options = {}) {
    const values = Array.isArray(threads) ? threads : [];
    const wantedIds = new Set(values.map(thread => String(thread && thread.id || '').trim()).filter(Boolean));
    const indexedById = this.readIndex();
    const localById = new Map();
    for (const file of this.sessionFiles()) {
      const threadId = threadIdFromSessionFile(file);
      if (!wantedIds.has(threadId)) continue;
      const stat = fs.statSync(file);
      const previous = localById.get(threadId);
      if (previous && previous.mtimeMs >= stat.mtimeMs) continue;
      const cachedMeta = this.sessionMetaCache.get(file);
      const meta = cachedMeta && cachedMeta.size === stat.size && cachedMeta.mtimeMs === stat.mtimeMs
        ? cachedMeta.meta
        : readSessionMeta(file);
      this.sessionMetaCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, meta });
      const indexed = indexedById.get(threadId) || { name: '', updatedAt: '' };
      const cwd = String((meta.payload && meta.payload.cwd) || '').trim();
      localById.set(threadId, {
        threadId,
        threadName: String(indexed.name || '').trim(),
        projectName: projectNameFromCwd(cwd),
        cwd,
        file,
        updatedAt: indexed.updatedAt || new Date(stat.mtimeMs).toISOString(),
        sessionFile: path.basename(file),
        mtimeMs: stat.mtimeMs,
      });
    }
    return values.map(thread => {
      const threadId = String(thread && thread.id || '').trim();
      const local = localById.get(threadId);
      if (!local) return null;
      const updatedAt = Number(thread.updatedAt);
      const catalogName = String(thread.name || thread.title || '').trim();
      const cwd = String(thread.cwd || '').trim() || local.cwd;
      return Object.assign({}, local, {
        threadName: (options.preferLocalName ? local.threadName || catalogName : catalogName || local.threadName) || '未命名线程',
        cwd,
        projectName: projectNameFromCwd(cwd),
        updatedAt: Number.isFinite(updatedAt) && updatedAt > 0
          ? new Date(updatedAt * 1000).toISOString()
          : local.updatedAt,
      });
    }).filter(Boolean);
  }

  /**
   * AI:将 Desktop 侧栏线程目录映射到本地 JSONL，优先保留侧栏已生成的线程标题。
   *
   * @param {Array<{id?: string, name?: string, cwd?: string, updatedAt?: number|string}>} threads Desktop 线程列表。
   * @returns {Array<object>} 可读取 JSONL 的线程目标。
   */
  discoverDesktopThreadSessions(threads) {
    return this.discoverCatalogThreadSessions(threads, { preferLocalName: true });
  }

  /**
   * AI:生成最近完整回合的紧凑快照，读取量不随会话总文件大小增长。
   *
   * @param {object} target 会话同步目标。
   * @param {number} messageLimit 最大消息回合数。
   * @returns {{messages: Array<object>, status: object}} 紧凑会话快照。
   */
  createRecentSnapshot(target, messageLimit) {
    const items = readRecentTurnItems(target.file, Math.max(messageLimit, 10));
    const page = paginateMessagesByTurn(historyMessagesFromItems(items), messageLimit);
    return {
      messages: page.messages,
      status: applyDesktopRuntimeStatus(
        this.parseStatusItems({ threadId: target.threadId, file: target.file, items }),
        target.desktopRuntime,
      ),
    };
  }

  /**
   * AI:读取已发现打开线程的新增 JSONL 行。
   *
   * @param {Array<object>} targets 打开线程会话目标。
   * @param {Map<string, {size: number}>|object} offsets 已同步偏移。
   * @param {{initialLineLimit?: number, maxTargets?: number}} options 同步选项。
   * @returns {{sessions: Array<object>, openThreadIds: string[]}} 会话同步快照。
   */
  readKnownThreadSync(targets, offsets = new Map(), options = {}) {
    const sessions = [];
    const openThreadIds = [];
    const initialLineLimit = Math.max(1, Math.min(Number(options.initialLineLimit) || 800, 5000));
    const snapshotMessageLimit = Math.max(0, Math.min(Number(options.snapshotMessageLimit) || 0, 100));
    const syncByteLimit = Math.max(1024, Number(options.syncByteLimit) || 512 * 1024);
    const maxTargets = Math.max(1, Number(options.maxTargets) || Number.MAX_SAFE_INTEGER);
    let syncedBytes = 0;

    for (const target of (targets || []).slice(0, maxTargets)) {
      if (!target || !target.threadId || !target.file) continue;
      let stat = null;
      try {
        stat = fs.statSync(target.file);
      } catch {
        continue;
      }
      openThreadIds.push(target.threadId);
      const previous = offsets instanceof Map ? offsets.get(target.threadId) : offsets[target.threadId];
      const previousSize = previous && Number(previous.size) > 0 ? Number(previous.size) : 0;
      const reset = previousSize <= 0 || previousSize > stat.size;
      const desktopState = String((target.desktopRuntime && target.desktopRuntime.state) || 'unknown');
      const stateChanged = String((previous && previous.desktopState) || 'unknown') !== desktopState;
      const changed = reset || previousSize < stat.size || stateChanged;
      if (snapshotMessageLimit && (reset || stateChanged)) {
        const remainingBytes = Math.max(0, syncByteLimit - syncedBytes);
        if (!remainingBytes) {
          if (reset) {
            sessions.push({
              threadId: target.threadId,
              threadName: target.threadName,
              projectName: target.projectName,
              cwd: target.cwd,
              updatedAt: target.updatedAt || new Date(stat.mtimeMs).toISOString(),
              sessionFile: target.sessionFile || path.basename(target.file),
              mtimeMs: stat.mtimeMs,
              metadataOnly: true,
            });
          }
          continue;
        }
        const snapshot = this.createRecentSnapshot(target, snapshotMessageLimit);
        const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
        if (snapshotBytes <= remainingBytes) {
          const nextOffset = { size: stat.size, desktopState };
          offsets instanceof Map ? offsets.set(target.threadId, nextOffset) : offsets[target.threadId] = nextOffset;
          syncedBytes += snapshotBytes;
          sessions.push({
            threadId: target.threadId,
            threadName: target.threadName,
            projectName: target.projectName,
            cwd: target.cwd,
            updatedAt: target.updatedAt || new Date(stat.mtimeMs).toISOString(),
            sessionFile: target.sessionFile || path.basename(target.file),
            mtimeMs: stat.mtimeMs,
            snapshot,
          });
          continue;
        }
        if (reset) {
          sessions.push({
            threadId: target.threadId,
            threadName: target.threadName,
            projectName: target.projectName,
            cwd: target.cwd,
            updatedAt: target.updatedAt || new Date(stat.mtimeMs).toISOString(),
            sessionFile: target.sessionFile || path.basename(target.file),
            mtimeMs: stat.mtimeMs,
            metadataOnly: true,
          });
        }
        continue;
      }
      let lines = reset
        ? readTailJsonlLines(target.file, stat.size, initialLineLimit)
        : readJsonlRangeLines(target.file, previousSize, stat.size);
      const remainingBytes = Math.max(0, syncByteLimit - syncedBytes);
      let lineBytes = lines.reduce((total, line) => total + Buffer.byteLength(line, 'utf8') + 1, 0);
      if (lineBytes && syncedBytes + lineBytes > syncByteLimit) {
        const tail = [];
        let tailBytes = 0;
        for (let index = lines.length - 1; index >= 0; index -= 1) {
          const bytes = Buffer.byteLength(lines[index], 'utf8') + 1;
          if (tail.length && tailBytes + bytes > remainingBytes) break;
          if (bytes > remainingBytes) continue;
          tail.unshift(lines[index]);
          tailBytes += bytes;
        }
        lines = tail;
        lineBytes = tailBytes;
      }
      if (!lines.length && (reset || previousSize < stat.size)) {
        // AI:首轮先同步线程元数据，后续同步周期再按预算补齐历史，避免大批 JSONL 阻塞 Relay。
        sessions.push({
          threadId: target.threadId,
          threadName: target.threadName,
          projectName: target.projectName,
          cwd: target.cwd,
          updatedAt: target.updatedAt || new Date(stat.mtimeMs).toISOString(),
          sessionFile: target.sessionFile || path.basename(target.file),
          mtimeMs: stat.mtimeMs,
          metadataOnly: true,
        });
        continue;
      }
      const nextOffset = { size: stat.size, desktopState };
      offsets instanceof Map ? offsets.set(target.threadId, nextOffset) : offsets[target.threadId] = nextOffset;
      if (!lines.length && !reset) continue;
      syncedBytes += lineBytes;
      sessions.push({
        threadId: target.threadId,
        threadName: target.threadName,
        projectName: target.projectName,
        cwd: target.cwd,
        updatedAt: target.updatedAt || new Date(stat.mtimeMs).toISOString(),
        sessionFile: target.sessionFile || path.basename(target.file),
        mtimeMs: stat.mtimeMs,
        reset,
        lines,
      });
    }

    return { sessions, openThreadIds };
  }

  /**
   * 解析线程历史消息。
   *
   * @param {string} threadId Codex 线程 ID。
   * @param {number|string} limit 最大回合数量。
   * @param {string} before 当前页首个回合的稳定游标。
   * @returns {{ok: boolean, available: boolean, threadId: string, sessionFile: string, messages: Array<object>, hasMore: boolean, nextBefore: string}} 历史结果。
   */
  parseHistory(threadId, limit = 120, before = '') {
    const file = this.findFileByThreadId(threadId);
    if (!file) {
      return {
        ok: true,
        available: false,
        threadId,
        sessionFile: '',
        messages: [],
        hasMore: false,
        nextBefore: '',
      };
    }
    const messages = historyMessagesFromItems(readJsonl(file));
    const page = paginateMessagesByTurn(messages, limit, before);
    return {
      ok: true,
      available: true,
      threadId,
      sessionFile: path.basename(file),
      messages: page.messages,
      hasMore: page.hasMore,
      nextBefore: page.nextBefore,
      invalidCursor: Boolean(page.invalidCursor),
    };
  }

  /**
   * AI:只从会话尾部确认指定时间后的新回合，供发送落盘证据轮询使用。
   *
   * @param {string} threadId 线程标识。
   * @param {string} since 最早接受时间。
   * @returns {{turnId: string, observedAt: string}|null} 新回合证据。
   */
  findTurnStartedSince(threadId, since = '') {
    const file = this.findFileByThreadId(threadId);
    if (!file) return null;
    const minimumTime = Date.parse(String(since || ''));
    const item = findRecentJsonlItem(file, candidate => {
      const payload = candidate.payload || {};
      return candidate.type === 'event_msg' && payload.type === 'task_started';
    }, minimumTime);
    if (!item) return null;
    const payload = item.payload || {};
    const turnId = String(payload.turn_id || payload.turnId || '').trim();
    return turnId ? { turnId, observedAt: String(item.timestamp || '') } : null;
  }

  /**
   * AI:只从会话尾部确认指定时间后的手动停止事件。
   *
   * @param {string} threadId 线程标识。
   * @param {string} since 最早接受时间。
   * @returns {{status: string, observedAt: string}|null} 停止证据。
   */
  findTurnAbortedSince(threadId, since = '') {
    const file = this.findFileByThreadId(threadId);
    if (!file) return null;
    const minimumTime = Date.parse(String(since || ''));
    const item = findRecentJsonlItem(file, candidate => {
      const payload = candidate.payload || {};
      return candidate.type === 'event_msg' && payload.type === 'turn_aborted';
    }, minimumTime);
    return item ? { status: 'interrupted', observedAt: String(item.timestamp || '') } : null;
  }

  /**
   * 解析线程在 Codex Desktop 侧的控制目标。
   *
   * @param {string} threadId Codex 线程 ID。
   * @returns {{available: boolean, threadId: string, threadName: string, projectName: string, cwd: string, sessionFile: string}} 控制目标。
   */
  getThreadTarget(threadId) {
    const file = this.findFileByThreadId(threadId);
    if (!file) {
      return { available: false, threadId, threadName: '', projectName: '', cwd: '', sessionFile: '' };
    }

    const indexed = this.readIndex().get(threadId) || { name: '' };
    const meta = readJsonl(file).find(item => item.type === 'session_meta') || {};
    const cwd = String((meta.payload && meta.payload.cwd) || '').trim();
    return {
      available: true,
      threadId,
      threadName: threadTitleFromSession(file, indexed.name) || '未命名线程',
      projectName: projectNameFromCwd(cwd),
      cwd,
      sessionFile: path.basename(file),
    };
  }

  /**
   * 解析线程当前回复状态。
   *
   * @param {{threadId?: string, since?: string}} options 状态查询参数。
   * @returns {object} 状态结果。
   */
  parseStatus(options = {}) {
    return this.parseStatusItems(options);
  }

  /**
   * AI:从指定 JSONL 记录投影线程状态，供完整查询与最近回合快照复用。
   *
   * @param {{threadId?: string, since?: string, file?: string, items?: object[]}} options 状态解析参数。
   * @returns {object} 状态结果。
   */
  parseStatusItems(options = {}) {
    const threadId = options.threadId || '';
    const sinceMs = Date.parse(options.since || '');
    const file = options.file || (threadId
      ? this.findFileByThreadId(threadId)
      : this.sessionFiles().sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]);
    if (!file) {
      return { ok: true, available: false, active: false, status: 'missing', threadId, sessionFile: '', preview: '', final: '', steps: [], turns: [] };
    }

    let active = false;
    let completed = false;
    let startedAt = '';
    let completedAt = '';
    let final = '';
    const steps = [];
    const turnsById = new Map();
    const seenProcessSteps = new Set();
    const recentCommentarySteps = new Map();
    const commandCountsByTurn = {};
    let currentTurnId = '';
    let latestTurnId = '';
    const included = item => Number.isNaN(sinceMs) || Date.parse(item.timestamp || '') >= sinceMs;
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
      if (index === -1) {
        rows.push(enriched);
      } else {
        rows[index] = enriched;
      }
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
    const items = Array.isArray(options.items) ? options.items : readJsonl(file);
    for (const item of items) {
      const payload = item.payload || {};
      const visible = included(item);
      if (item.type === 'turn_context') {
        currentTurnId = String(payload.turn_id || payload.turnId || currentTurnId || '').trim();
        ensureTurn(currentTurnId);
      }
      if (item.type === 'event_msg' && payload.type === 'task_started') {
        currentTurnId = String(payload.turn_id || payload.turnId || currentTurnId || '').trim();
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
        }
      }
      if (item.type === 'response_item' && payload.type === 'function_call') {
        if (currentTurnId) {
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
      }
      if (item.type === 'event_msg' && payload.type === 'task_complete') {
        currentTurnId = String(payload.turn_id || payload.turnId || currentTurnId || '').trim();
        if (visible) {
          active = false;
          completed = true;
          completedAt = item.timestamp || completedAt;
          final = stripCodexUiDirectives(payload.last_agent_message) || final;
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
    const parsedThreadId = threadIdFromSessionFile(file);
    const turns = Array.from(turnsById.values()).map(turn => {
      const hasComplete = turn.steps.some(step => step.kind === 'complete' || step.kind === 'final');
      return Object.assign({}, turn, {
        status: turn.status === 'interrupted' ? 'interrupted' : hasComplete ? 'complete' : active && turn.turnId === latestTurnId ? 'running' : 'idle',
        steps: turn.steps.slice(-30),
      });
    });
    return {
      ok: true,
      available: true,
      active,
      status: completed ? 'complete' : active ? 'running' : 'idle',
      threadId: parsedThreadId,
      sessionFile: path.basename(file),
      startedAt,
      completedAt,
      preview: final || (active ? 'Codex 正在回复...' : '暂无可显示回复。'),
      final: completed ? final : '',
      steps: steps.slice(-30),
      turns: turns.slice(-10),
    };
  }
}

module.exports = {
  CodexSessionReader,
  applyDesktopRuntimeStatus,
  paginateMessagesByTurn,
  isThreadId,
  reasoningText,
  stripCodexUiDirectives,
  projectNameFromCwd,
  threadIdFromSessionFile,
  readJsonlLines,
};
