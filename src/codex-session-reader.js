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
 * 过滤 Codex Desktop 只用于客户端 UI 的指令行。
 *
 * @param {string} text 原始回复文本。
 * @returns {string} 手机端可显示文本。
 */
function stripCodexUiDirectives(text) {
  return String(text || '')
    .split(/\r?\n/)
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
        name: indexed.name || '未命名线程',
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
      const threadName = indexed.name || '未命名线程';
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
   * 解析线程历史消息。
   *
   * @param {string} threadId Codex 线程 ID。
   * @param {number|string} limit 最大消息数量。
   * @returns {{ok: boolean, available: boolean, threadId: string, sessionFile: string, messages: Array<object>}} 历史结果。
   */
  parseHistory(threadId, limit = 120) {
    const file = this.findFileByThreadId(threadId);
    if (!file) {
      return { ok: true, available: false, threadId, sessionFile: '', messages: [] };
    }
    const messages = [];
    for (const item of readJsonl(file)) {
      const payload = item.payload || {};
      if (item.type === 'event_msg' && payload.type === 'user_message') {
        const text = String(payload.message || '').trim();
        if (text) messages.push({ role: 'user', label: '你', text, timestamp: item.timestamp || '' });
      }
      if (item.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant' && payload.phase === 'final_answer') {
        const text = messageText(payload.content);
        if (text) messages.push({ role: 'assistant', label: 'Codex', text, timestamp: item.timestamp || '' });
      }
    }
    return {
      ok: true,
      available: true,
      threadId,
      sessionFile: path.basename(file),
      messages: messages.slice(-Math.max(1, Math.min(Number(limit) || 120, 200))),
    };
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
      threadName: indexed.name || '未命名线程',
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
    const threadId = options.threadId || '';
    const sinceMs = Date.parse(options.since || '');
    const file = options.file || (threadId
      ? this.findFileByThreadId(threadId)
      : this.sessionFiles().sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]);
    if (!file) {
      return { ok: true, available: false, active: false, status: 'missing', threadId, sessionFile: '', preview: '', final: '', steps: [] };
    }

    let active = false;
    let completed = false;
    let startedAt = '';
    let completedAt = '';
    let final = '';
    const steps = [];
    for (const item of readJsonl(file)) {
      if (!Number.isNaN(sinceMs) && Date.parse(item.timestamp || '') < sinceMs) continue;
      const payload = item.payload || {};
      if (item.type === 'event_msg' && payload.type === 'task_started') {
        active = true;
        completed = false;
        startedAt = item.timestamp || startedAt;
        steps.push({ kind: 'start', label: '开始', text: '开始处理这条消息', time: item.timestamp || '' });
      }
      if (item.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
        const text = messageText(payload.content);
        if (text) {
          if (payload.phase === 'final_answer') {
            final = text;
            active = false;
            completed = true;
            completedAt = item.timestamp || completedAt;
          }
          steps.push({ kind: payload.phase === 'final_answer' ? 'final' : 'assistant', label: '回复', text, time: item.timestamp || '' });
        }
      }
      if (item.type === 'event_msg' && payload.type === 'task_complete') {
        active = false;
        completed = true;
        completedAt = item.timestamp || completedAt;
        final = stripCodexUiDirectives(payload.last_agent_message) || final;
        steps.push({ kind: 'complete', label: '完成', text: '回复完成', time: item.timestamp || '' });
      }
    }
    const parsedThreadId = threadIdFromSessionFile(file);
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
    };
  }
}

module.exports = {
  CodexSessionReader,
  isThreadId,
  stripCodexUiDirectives,
  projectNameFromCwd,
  threadIdFromSessionFile,
};
