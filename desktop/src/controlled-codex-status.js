const {
  getAgentStatusPath,
  isAgentStatusFresh,
  readAgentStatus,
} = require('./desktop-agent-status');

/**
 * AI:将 Agent 写入的受控官方 Codex 状态投影为管理器可显示状态。
 *
 * @param {{running?: boolean, pid?: number|null}} agent 管理器识别到的 Agent 进程。
 * @param {{token?: string}} config 当前管理器配置。
 * @param {{homeDir?: string, now?: Function}} options 测试用依赖。
 * @returns {{ok: boolean, message: string, codexVersion: string}} 官方客户端显示状态。
 */
function resolveControlledCodexStatus(agent = {}, config = {}, options = {}) {
  if (!agent.running) return { ok: false, message: 'Agent 未运行', codexVersion: '' };
  const status = readAgentStatus(getAgentStatusPath(config.token, { homeDir: options.homeDir }));
  if (!status) return { ok: false, message: '等待受控 Codex Desktop 状态上报', codexVersion: '' };
  if (Number(status.pid) !== Number(agent.pid)) {
    return { ok: false, message: `状态属于其他 Agent（PID ${status.pid}）`, codexVersion: '' };
  }
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  if (!isAgentStatusFresh(status, now)) return { ok: false, message: '受控 Codex Desktop 状态心跳已过期', codexVersion: '' };
  if (status.state === 'ready') {
    return {
      ok: true,
      message: status.message || '受控 Codex Desktop 已连接',
      codexVersion: status.codexVersion,
    };
  }
  return { ok: false, message: status.message || '等待受控 Codex Desktop 初始化', codexVersion: '' };
}

module.exports = {
  resolveControlledCodexStatus,
};
