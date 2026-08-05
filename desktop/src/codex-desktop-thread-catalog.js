const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_CODEX_DIR = path.join(os.homedir(), '.codex');
const MAX_THREAD_LIMIT = 1000;

/**
 * AI:定位当前 Codex Desktop 使用的本地线程状态数据库。
 *
 * @param {string} codexDir Codex 用户数据目录。
 * @returns {string} 最新状态数据库绝对路径。
 */
function findDesktopStateFile(codexDir = DEFAULT_CODEX_DIR) {
  const files = fs.readdirSync(codexDir)
    .filter(name => /^state_\d+\.sqlite$/i.test(name))
    .map(name => {
      const file = path.join(codexDir, name);
      return { file, mtimeMs: fs.statSync(file).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (!files.length) {
    const error = new Error('未找到 Codex Desktop 线程状态数据库。');
    error.code = 'CODEX_STATE_DB_MISSING';
    throw error;
  }
  return files[0].file;
}

/**
 * AI:读取 Codex Desktop 侧栏的顶层未归档线程目录。
 */
class CodexDesktopThreadCatalog {
  /**
   * AI:创建只读线程目录读取器。
   *
   * @param {{stateFile?: string, databaseFactory?: Function}} options 状态数据库与测试依赖。
   */
  constructor(options = {}) {
    this.stateFile = options.stateFile || findDesktopStateFile(options.codexDir || DEFAULT_CODEX_DIR);
    this.databaseFactory = options.databaseFactory || ((file, openOptions) => new DatabaseSync(file, openOptions));
  }

  /**
   * AI:列出 Desktop 当前侧栏使用的未归档用户线程，不混入 CLI 或子代理线程。
   *
   * @param {number|string} limit 最大返回数量。
   * @returns {Array<{id: string, name: string, cwd: string, updatedAt: number, pinned: boolean}>} 线程目录。
   */
  listThreads(limit = MAX_THREAD_LIMIT) {
    const max = Math.max(1, Math.min(Number(limit) || MAX_THREAD_LIMIT, MAX_THREAD_LIMIT));
    const database = this.databaseFactory(this.stateFile, { readOnly: true });
    try {
      const rows = database.prepare(`
        SELECT id, title, name, cwd, updated_at, is_pinned
        FROM threads
WHERE archived = 0
  AND source = 'vscode'
  AND (thread_source IS NULL OR thread_source <> 'subagent')
  AND TRIM(COALESCE(title, name, '')) <> ''
ORDER BY is_pinned DESC, updated_at DESC
LIMIT ?
      `).all(max);
      return rows.map(row => ({
        id: String(row.id || '').trim(),
        name: String(row.title || row.name || '').trim(),
        cwd: String(row.cwd || '').trim(),
        updatedAt: Number(row.updated_at) || 0,
        pinned: Boolean(row.is_pinned),
      })).filter(row => row.id);
    } finally {
      database.close();
    }
  }
}

/**
 * AI:创建 Codex Desktop 本地线程目录读取器。
 *
 * @param {{stateFile?: string, databaseFactory?: Function}} options 状态数据库与测试依赖。
 * @returns {CodexDesktopThreadCatalog} 线程目录读取器。
 */
function createCodexDesktopThreadCatalog(options = {}) {
  return new CodexDesktopThreadCatalog(options);
}

module.exports = {
  CodexDesktopThreadCatalog,
  createCodexDesktopThreadCatalog,
  findDesktopStateFile,
};
