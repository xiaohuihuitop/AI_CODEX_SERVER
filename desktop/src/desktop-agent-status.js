const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AGENT_STATUS_VERSION = 1;
const AGENT_STATUS_DIRNAME = '.codex-windows-bridge';
const AGENT_STATUS_HEARTBEAT_MS = 10000;
const AGENT_STATUS_MAX_AGE_MS = AGENT_STATUS_HEARTBEAT_MS * 3;
const AGENT_STATES = new Set(['starting', 'ready', 'unavailable', 'stopped']);

/**
 * AI:根据设备 Key 生成不包含明文 Key 的本机状态文件路径。
 *
 * @param {string} token 设备 Key。
 * @param {{homeDir?: string}} options 可注入的用户目录。
 * @returns {string} Agent 状态文件绝对路径。
 */
function getAgentStatusPath(token, options = {}) {
  const fingerprint = crypto.createHash('sha256').update(String(token || '').trim()).digest('hex').slice(0, 16);
  const homeDir = options.homeDir || os.homedir();
  return path.join(homeDir, AGENT_STATUS_DIRNAME, `agent-status-${fingerprint}.json`);
}

/**
 * AI:校验并规范化 Agent 写入和管理器读取的状态载荷。
 *
 * @param {object} input 原始状态载荷。
 * @returns {{version: number, pid: number, state: string, message: string, codexVersion: string, updatedAt: string}} 规范化状态。
 */
function normalizeAgentStatus(input = {}) {
  const pid = Number(input.pid);
  const state = String(input.state || '').trim();
  const message = String(input.message || '').trim();
  const codexVersion = String(input.codexVersion || '').trim();
  const updatedAt = String(input.updatedAt || '').trim();
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Agent 状态缺少有效 PID。');
  if (!AGENT_STATES.has(state)) throw new Error('Agent 状态包含未知服务状态。');
  if (codexVersion.length > 128) throw new Error('Agent 状态中的 Codex 版本过长。');
  if (!Number.isFinite(Date.parse(updatedAt))) throw new Error('Agent 状态缺少有效更新时间。');
  return {
    version: AGENT_STATUS_VERSION,
    pid,
    state,
    message,
    codexVersion,
    updatedAt,
  };
}

/**
 * AI:原子写入当前 Agent 的受控官方客户端状态，避免管理器读取到半截 JSON。
 *
 * @param {string} statusPath 状态文件路径。
 * @param {object} status 原始状态载荷。
 * @returns {{version: number, pid: number, state: string, message: string, codexVersion: string, updatedAt: string}} 已写入状态。
 */
function writeAgentStatus(statusPath, status) {
  const normalized = normalizeAgentStatus(status);
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  const temporaryPath = `${statusPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(normalized)}\n`, 'utf8');
  fs.renameSync(temporaryPath, statusPath);
  return normalized;
}

/**
 * AI:读取并校验 Agent 状态文件，损坏或不存在时返回空状态供管理器明确提示。
 *
 * @param {string} statusPath 状态文件路径。
 * @returns {{version: number, pid: number, state: string, message: string, codexVersion: string, updatedAt: string}|null} 有效状态或空。
 */
function readAgentStatus(statusPath) {
  try {
    if (!statusPath || !fs.existsSync(statusPath)) return null;
    return normalizeAgentStatus(JSON.parse(fs.readFileSync(statusPath, 'utf8').replace(/^\uFEFF/, '')));
  } catch {
    return null;
  }
}

/**
 * AI:判断状态心跳是否仍在有效窗口内，过期状态不能表示当前服务可用。
 *
 * @param {{updatedAt?: string}|null} status Agent 状态。
 * @param {number} now 当前时间戳。
 * @returns {boolean} 心跳有效时返回 true。
 */
function isAgentStatusFresh(status, now = Date.now()) {
  const updatedAt = Date.parse(String(status?.updatedAt || ''));
  const age = Number(now) - updatedAt;
  return Number.isFinite(updatedAt) && Number.isFinite(age) && age >= 0 && age <= AGENT_STATUS_MAX_AGE_MS;
}

module.exports = {
  AGENT_STATUS_HEARTBEAT_MS,
  AGENT_STATUS_MAX_AGE_MS,
  AGENT_STATUS_VERSION,
  getAgentStatusPath,
  isAgentStatusFresh,
  readAgentStatus,
  writeAgentStatus,
};
