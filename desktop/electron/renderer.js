const state = {
  current: null,
  busy: false,
};
const SILENT_REFRESH_MS = 15000;

const elements = {
  serverUrl: document.getElementById('serverUrl'),
  token: document.getElementById('token'),
  deviceName: document.getElementById('deviceName'),
  autoStart: document.getElementById('autoStart'),
  saveState: document.getElementById('saveState'),
  configForm: document.getElementById('configForm'),
  restartAgentButton: document.getElementById('restartAgentButton'),
  stopButton: document.getElementById('stopButton'),
  restartCodexButton: document.getElementById('restartCodexButton'),
  refreshButton: document.getElementById('refreshButton'),
  openMobileButton: document.getElementById('openMobileButton'),
  copyMobileButton: document.getElementById('copyMobileButton'),
  portStatus: document.getElementById('portStatus'),
  mobileUrl: document.getElementById('mobileUrl'),
  agentEnv: document.getElementById('agentEnv'),
  agentLog: document.getElementById('agentLog'),
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
};

function getFormConfig() {
  return {
    serverUrl: elements.serverUrl.value,
    token: elements.token.value,
    deviceName: elements.deviceName.value,
    autoStart: elements.autoStart.checked,
  };
}

function setBusy(value) {
  state.busy = value;
  [
    elements.restartAgentButton,
    elements.stopButton,
    elements.restartCodexButton,
    elements.refreshButton,
    elements.openMobileButton,
    elements.copyMobileButton,
  ].forEach(button => {
    button.disabled = value;
  });
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
}

function renderState(nextState, options = {}) {
  state.current = nextState;
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

  setCard(elements.codexCard, nextState.codex.ok);
  const cloudPort = nextState.ports.cloud || '未配置';
  elements.codexStatus.textContent = nextState.codex.ok ? '可用' : '需重启 Codex 生效 CDP';
  elements.codexDetail.textContent = nextState.codex.ok
    ? `CDP 端口 ${nextState.ports.codexDebug}`
    : (nextState.codex.message || `点击“重启 Codex 生效 CDP”，端口 ${nextState.ports.codexDebug}`);
  elements.portStatus.textContent = `云端 ${cloudPort} / CDP ${nextState.ports.codexDebug}`;

  elements.mobileUrl.textContent = nextState.mobileUrl || '请先填写云端服务器地址和固定 Token。';
  elements.agentEnv.textContent = [
    `CODEX_CLOUD_URL=${nextState.agentEnv.CODEX_CLOUD_URL || ''}`,
    `CODEX_DEVICE_TOKEN=${nextState.agentEnv.CODEX_DEVICE_TOKEN || ''}`,
    `CODEX_DEVICE_NAME=${nextState.agentEnv.CODEX_DEVICE_NAME || ''}`,
  ].join('\n');

  const logs = [...(nextState.agent.lastOutput || []), ...(nextState.agent.lastError || [])].slice(-12);
  elements.agentLog.textContent = logs.length ? logs.join('\n') : '暂无日志。';
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

elements.stopButton.addEventListener('click', () => {
  runAction(() => window.codexManager.pauseFeature());
});

elements.restartCodexButton.addEventListener('click', () => {
  runAction(() => window.codexManager.restartCodex());
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

[
  elements.serverUrl,
  elements.token,
  elements.deviceName,
  elements.autoStart,
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
