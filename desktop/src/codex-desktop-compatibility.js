const { URL } = require('node:url');

const CODEX_DESKTOP_SELECTORS = Object.freeze({
  threadRow: '[data-app-action-sidebar-thread-id]',
  selectedThreadRow: '[data-app-action-sidebar-thread-id][aria-current="page"]',
  composer: '[contenteditable="true"]',
  stopLabel: '停止',
  sendLabels: Object.freeze(['发送', '发送消息']),
  sendButtonClass: 'size-token-button-composer',
});

const CODEX_DESKTOP_PROFILE = Object.freeze({
  id: 'codex-desktop-structural-v1',
  targetUrl: 'app://-/index.html',
  selectors: CODEX_DESKTOP_SELECTORS,
});

function isExpectedDebuggerUrl(value, debugPort) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'ws:'
      && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
      && Number(url.port) === Number(debugPort);
  } catch {
    return false;
  }
}

/**
 * AI:只选择对应本机调试端口的 Codex 主页面，排除快捷窗口和未知目标。
 *
 * @param {Array<object>} targets CDP 目标列表。
 * @param {number} debugPort 配置的本机调试端口。
 * @param {object} profile 兼容配置。
 * @returns {object|null} 唯一主页面目标。
 */
function selectPrimaryCodexTarget(targets, debugPort, profile = CODEX_DESKTOP_PROFILE) {
  if (!Array.isArray(targets)) return null;
  const matches = targets.filter(target => {
    if (!target || !target.webSocketDebuggerUrl) return false;
    const targetUrl = String(target.url || '');
    if (targetUrl !== profile.targetUrl) return false;
    return isExpectedDebuggerUrl(target.webSocketDebuggerUrl, debugPort);
  });
  return matches.length === 1 ? matches[0] : null;
}

module.exports = {
  CODEX_DESKTOP_PROFILE,
  selectPrimaryCodexTarget,
};
