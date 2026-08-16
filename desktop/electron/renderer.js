const state = {
  current: null,
  busy: false,
};
const SILENT_REFRESH_MS = 15000;

const elements = {
  serverUrl: document.getElementById('serverUrl'),
  token: document.getElementById('token'),
  deviceName: document.getElementById('deviceName'),
  debugPort: document.getElementById('debugPort'),
  autoStart: document.getElementById('autoStart'),
  saveState: document.getElementById('saveState'),
  configForm: document.getElementById('configForm'),
  restartAgentButton: document.getElementById('restartAgentButton'),
  restartCodexButton: document.getElementById('restartCodexButton'),
  inspectCompatibilityButton: document.getElementById('inspectCompatibilityButton'),
  stopButton: document.getElementById('stopButton'),
  refreshButton: document.getElementById('refreshButton'),
  openMobileButton: document.getElementById('openMobileButton'),
  copyMobileButton: document.getElementById('copyMobileButton'),
  compatibilityPanel: document.getElementById('compatibilityPanel'),
  compatibilityResult: document.getElementById('compatibilityResult'),
  copyCompatibilityButton: document.getElementById('copyCompatibilityButton'),
  portStatus: document.getElementById('portStatus'),
  mobileUrl: document.getElementById('mobileUrl'),
  agentEnv: document.getElementById('agentEnv'),
  agentLog: document.getElementById('agentLog'),
  managerVersion: document.getElementById('managerVersion'),
  clearLogsButton: document.getElementById('clearLogsButton'),
  lastUpdated: document.getElementById('lastUpdated'),
  cloudCard: document.getElementById('cloudCard'),
  cloudStatus: document.getElementById('cloudStatus'),
  cloudDetail: document.getElementById('cloudDetail'),
  agentCard: document.getElementById('agentCard'),
  agentStatus: document.getElementById('agentStatus'),
  agentDetail: document.getElementById('agentDetail'),
  codexCard: document.getElementById('codexCard'),
  codexStatus: document.getElementById('codexStatus'),
  codexDetail: document.getElementById('codexDetail'),
  codexVersion: document.getElementById('codexVersion'),
};

function getFormConfig() {
  return {
    serverUrl: elements.serverUrl.value,
    token: elements.token.value,
    deviceName: elements.deviceName.value,
    autoStart: elements.autoStart.checked,
    debugPort: elements.debugPort.value,
  };
}

function setBusy(value) {
  state.busy = value;
  [
    elements.restartAgentButton,
    elements.restartCodexButton,
    elements.inspectCompatibilityButton,
    elements.stopButton,
    elements.refreshButton,
    elements.openMobileButton,
    elements.copyMobileButton,
    elements.copyCompatibilityButton,
    elements.clearLogsButton,
  ].forEach(button => {
    button.disabled = value;
  });
}

function formatCompatibilityReport(report) {
  const conclusions = {
    compatible: '兼容，可以控制',
    incompatible: '页面结构不兼容',
    failed: '检测失败',
  };
  const yesNo = value => value ? '通过' : '未通过';
  const lines = [
    `检测时间：${report.checkedAt || '未知'}`,
    `官方 Codex：v${report.version || '未知'}（PID ${report.pid || '未知'}）`,
    `CDP 端口：${report.debugPort || '未知'}`,
    `控制契约：${report.contractId || '未知'}`,
    `CDP 连接：${yesNo(report.cdpConnected)}`,
    `侧栏线程：${Number(report.threadRows || 0)} 条`,
    `消息编辑器：${yesNo(report.editor)}`,
    `发送/停止按钮：${yesNo(report.action)}`,
    `检测结论：${conclusions[report.status] || '未知'}`,
  ];
  if (report.errorCode) lines.push(`错误：${report.errorCode} / ${report.message || '未知错误'}`);
  return lines.join('\n');
}

function setCard(card, ok) {
  card.classList.toggle('ok', Boolean(ok));
  card.classList.toggle('bad', !ok);
}

function isConfigured(config) {
  return Boolean(config && config.serverUrl && config.token);
}

function renderConfig(config) {
  elements.serverUrl.value = config.serverUrl || '';
  elements.token.value = config.token || '';
  elements.deviceName.value = config.deviceName || '';
  elements.autoStart.checked = Boolean(config.autoStart);
  elements.debugPort.value = config.debugPort || 9230;
}

function renderState(nextState, options = {}) {
  state.current = nextState;
  const managerVersion = nextState.managerVersion || '未知版本';
  elements.managerVersion.textContent = `版本 v${managerVersion}`;
  if (options.renderConfig !== false) renderConfig(nextState.config);
  const configured = isConfigured(nextState.config);
  const featureStarted = Boolean(configured && nextState.agent.running);

  setCard(elements.cloudCard, nextState.cloud.ok && nextState.cloud.online);
  elements.cloudStatus.textContent = nextState.cloud.online ? '已连接' : '未连接';
  elements.cloudDetail.textContent = configured
    ? (nextState.cloud.message || (nextState.cloud.ok ? '服务器可访问' : '服务器不可访问'))
    : '请先填写云端地址和 Token';

  setCard(elements.agentCard, featureStarted);
  elements.agentStatus.textContent = !configured ? '配置不完整' : featureStarted ? '已启动' : '已停止';
  elements.agentDetail.textContent = nextState.agent.pid ? `同步服务 PID ${nextState.agent.pid}` : '手机端暂时不能控制这台电脑';

  setCard(elements.codexCard, nextState.controlledCodex.ok);
  const cloudPort = nextState.ports.cloud || '未配置';
  elements.codexStatus.textContent = nextState.controlledCodex.ok ? '已连接' : '未连接';
  elements.codexDetail.textContent = nextState.controlledCodex.message || '等待受控 Codex Desktop 初始化';
  const codexVersion = String(nextState.controlledCodex.codexVersion || '').trim();
  elements.codexVersion.textContent = codexVersion ? `当前 Codex：v${codexVersion}` : '';
  elements.portStatus.textContent = `云端 ${cloudPort} / CDP ${nextState.config.debugPort || 9230}`;

  elements.mobileUrl.textContent = nextState.mobileUrl || '请先填写云端服务器地址和固定 Token。';
  elements.agentEnv.textContent = [
    `CODEX_CLOUD_URL=${nextState.agentEnv.CODEX_CLOUD_URL || ''}`,
    `CODEX_DEVICE_TOKEN=${nextState.agentEnv.CODEX_DEVICE_TOKEN || ''}`,
    `CODEX_DEVICE_NAME=${nextState.agentEnv.CODEX_DEVICE_NAME || ''}`,
    `CODEX_DEBUG_PORT=${nextState.agentEnv.CODEX_DEBUG_PORT || ''}`,
  ].join('\n');

  const logs = [
    ...(nextState.managerLogs || []),
    ...(nextState.agent.lastOutput || []),
    ...(nextState.agent.lastError || []),
  ].slice(-500);
  elements.agentLog.textContent = [`管理器版本：v${managerVersion}`, ...logs].join('\n');
  elements.lastUpdated.textContent = `最后刷新 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
}

async function runAction(action, options = {}) {
  const interactive = options.interactive !== false;
  if (state.busy) return;
  if (interactive) setBusy(true);
  try {
    renderState(await action(), { renderConfig: options.renderConfig !== false });
    if (interactive) elements.saveState.textContent = '状态已更新';
  } catch (error) {
    if (interactive) elements.saveState.textContent = error.message || '操作失败';
  } finally {
    if (interactive) setBusy(false);
  }
}

async function refresh(options = {}) {
  await runAction(() => window.codexManager.getState(), {
    interactive: options.interactive !== false,
    renderConfig: options.renderConfig !== false,
  });
}

async function refreshSilently() {
  if (state.busy || document.visibilityState !== 'visible') return;
  await refresh({ interactive: false, renderConfig: false });
}

elements.configForm.addEventListener('submit', event => {
  event.preventDefault();
  runAction(() => window.codexManager.saveConfig(getFormConfig()));
});

elements.restartAgentButton.addEventListener('click', () => {
  runAction(() => window.codexManager.restartAgent());
});

elements.restartCodexButton.addEventListener('click', () => {
  runAction(() => window.codexManager.restartCodex());
});

elements.inspectCompatibilityButton.addEventListener('click', async () => {
  if (state.busy) return;
  setBusy(true);
  elements.compatibilityPanel.hidden = false;
  elements.compatibilityResult.textContent = '正在检测兼容性...';
  try {
    const report = await window.codexManager.inspectCodexCompatibility();
    elements.compatibilityResult.textContent = formatCompatibilityReport(report);
    elements.saveState.textContent = '兼容性检测完成';
  } catch (error) {
    elements.compatibilityResult.textContent = error.message || '兼容性检测失败';
    elements.saveState.textContent = '兼容性检测失败';
  } finally {
    setBusy(false);
  }
});

elements.stopButton.addEventListener('click', () => {
  runAction(() => window.codexManager.pauseFeature());
});

elements.refreshButton.addEventListener('click', refresh);

elements.openMobileButton.addEventListener('click', () => {
  runAction(() => window.codexManager.openMobile());
});

elements.copyMobileButton.addEventListener('click', async () => {
  if (!state.current?.mobileUrl) return;
  await navigator.clipboard.writeText(state.current.mobileUrl);
  elements.saveState.textContent = '手机访问地址已复制';
});

elements.copyCompatibilityButton.addEventListener('click', async () => {
  const report = elements.compatibilityResult.textContent.trim();
  if (!report) return;
  await navigator.clipboard.writeText(report);
  elements.saveState.textContent = '兼容性检测结果已复制';
});

elements.clearLogsButton.addEventListener('click', () => {
  runAction(() => window.codexManager.clearLogs());
});

[
  elements.serverUrl,
  elements.token,
  elements.deviceName,
  elements.autoStart,
  elements.debugPort,
].forEach(input => {
  input.addEventListener('input', () => {
    elements.saveState.textContent = '配置已修改，点击保存配置后生效';
  });
});

refresh();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshSilently();
});
setInterval(refreshSilently, SILENT_REFRESH_MS);
