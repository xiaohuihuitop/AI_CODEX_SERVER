const { CodexCdpClient } = require('./codex-cdp-client');
const {
  CODEX_DESKTOP_PROFILES,
  resolveCodexDesktopProfile,
} = require('./codex-desktop-compatibility');
const { CodexDesktopUiController } = require('./codex-desktop-ui-controller');
const { ControlledCodexProcess } = require('./controlled-codex-process');

function failureReport(base, stage, error) {
  return {
    checkedAt: '',
    debugPort: null,
    version: '',
    pid: null,
    profileId: '',
    versionSupported: false,
    cdpConnected: false,
    threadRows: 0,
    editor: false,
    action: false,
    ...base,
    compatible: false,
    pageCompatible: false,
    status: 'failed',
    stage,
    errorCode: String(error && error.code || 'COMPATIBILITY_INSPECTION_FAILED'),
    message: String(error && error.message || error || '兼容性检测失败。'),
  };
}

/**
 * AI:对当前官方 Codex Desktop 执行无副作用兼容性检测，未知版本只生成报告而不放行控制。
 *
 * @param {object} options 检测端口、系统依赖和时钟。
 * @returns {Promise<object>} 可供管理器展示和复制的兼容性报告。
 */
async function inspectCodexDesktopCompatibility(options = {}) {
  const debugPort = Number(options.debugPort) || 9230;
  const processManager = options.processManager || new ControlledCodexProcess();
  const now = options.now || (() => new Date());
  const checkedAt = now().toISOString();
  let inspected;
  try {
    inspected = await processManager.inspect();
  } catch (error) {
    return failureReport({ checkedAt, debugPort, version: '', pid: null }, 'package', error);
  }

  const version = String(inspected && inspected.app && inspected.app.version || '');
  let profile = CODEX_DESKTOP_PROFILES[CODEX_DESKTOP_PROFILES.length - 1];
  let versionSupported = false;
  try {
    profile = resolveCodexDesktopProfile(version);
    versionSupported = true;
  } catch (error) {
    if (!error || error.code !== 'CODEX_DESKTOP_VERSION_UNSUPPORTED') throw error;
  }
  const base = {
    checkedAt,
    debugPort,
    version,
    pid: Number(inspected && inspected.mainProcess && inspected.mainProcess.pid || 0) || null,
    profileId: profile.id,
    versionSupported,
  };
  const cdpFactory = options.cdpFactory || (clientOptions => new CodexCdpClient(clientOptions));
  const cdp = cdpFactory({ debugPort, profile });
  try {
    await cdp.connect();
    const controller = new CodexDesktopUiController({ cdp, profile });
    const page = await controller.inspectCompatibility();
    const pageCompatible = Boolean(page.compatible);
    return {
      ...base,
      cdpConnected: true,
      pageCompatible,
      compatible: versionSupported && pageCompatible,
      status: versionSupported && pageCompatible
        ? 'compatible'
        : pageCompatible ? 'needs-review' : 'incompatible',
      stage: 'complete',
      threadRows: page.threadRows,
      editor: page.editor,
      action: page.action,
      errorCode: '',
      message: '',
    };
  } catch (error) {
    return failureReport(base, 'cdp', error);
  } finally {
    cdp.close();
  }
}

module.exports = {
  inspectCodexDesktopCompatibility,
};
