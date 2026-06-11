const state = {
  current: null,
  busy: false,
};

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

function renderConfig(config) {
  elements.serverUrl.value = config.serverUrl || '';
  elements.token.value = config.token || '';
  elements.deviceName.value = config.deviceName || '';
  elements.autoStart.checked = Boolean(config.autoStart);
}

function renderState(nextState, options = {}) {
  state.current = nextState;
  if (options.renderConfig !== false) renderConfig(nextState.config);

  setCard(elements.cloudCard, nextState.cloud.ok);
  elements.cloudStatus.textContent = nextState.cloud.ok ? '可访问' : '不可访问';
  elements.cloudDetail.textContent = nextState.cloud.online ? 'Agent 已在线' : (nextState.cloud.message || 'Agent 未在线');

  setCard(elements.agentCard, nextState.agent.running);
  elements.agentStatus.textContent = nextState.agent.running ? '运行中' : '未运行';
  elements.agentDetail.textContent = nextState.agent.pid ? `PID ${nextState.agent.pid}` : '';

  setCard(elements.codexCard, nextState.codex.ok);
  elements.codexStatus.textContent = nextState.codex.ok ? 'CDP 已开放' : 'CDP 不可用';
  elements.codexDetail.textContent = nextState.codex.ok ? `目标数量 ${nextState.codex.targetCount}` : (nextState.codex.message || '');

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
  if (state.busy) return;
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
  runAction(() => window.codexManager.stopAgent());
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
setInterval(refreshSilently, 5000);
