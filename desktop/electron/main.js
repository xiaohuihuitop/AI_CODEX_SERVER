const path = require('node:path');

if (process.argv.includes('--codex-manager-agent-child') || process.env.CODEX_MANAGER_AGENT_CHILD === '1') {
  require('../desktop-agent');
  return;
}

const { app, BrowserWindow, ipcMain, shell, Menu, Tray, nativeImage } = require('electron');
const {
  buildAgentEnv,
  buildMobileUrl,
  normalizeManagerConfig,
} = require('../src/desktop-manager');
const {
  getDefaultConfigPath,
  loadConfig,
  probeCloud,
  probeCodexDebug,
  saveConfig,
} = require('../src/desktop-manager-server');
const { createDesktopAgentProcess } = require('../src/desktop-agent-process');
const { restartCodexDesktopWithDebug } = require('../src/codex-desktop-process');

const PROJECT_ROOT = path.join(__dirname, '..');
const CONFIG_PATH = getDefaultConfigPath();
const CODEX_DEBUG_PORT = Number(process.env.CODEX_DEBUG_PORT || 9229);
const TRAY_ICON_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAUUlEQVR4nGMQlFD/P5CYYdQBow4YdQA+SYu9P6iCh74D+Ja+JAsPTwcQA0YdQDcHDHgaGHXAqANGHTDg5QDdHICMiQHDpz1ADzzqgFEHjDoAAFZ6baw6ZLM1AAAAAElFTkSuQmCC';

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createAgentController() {
  if (!app.isPackaged) return createDesktopAgentProcess({ cwd: PROJECT_ROOT });
  const exeName = path.basename(process.execPath);
  return createDesktopAgentProcess({
    cwd: path.dirname(process.execPath),
    nodePath: process.execPath,
    childArgs: ['--codex-manager-agent-child'],
    childEnv: { CODEX_MANAGER_AGENT_CHILD: '1' },
    processMatchText: '--codex-manager-agent-child',
    processNamePattern: `^${escapeRegExp(exeName)}$`,
  });
}

const agentController = createAgentController();

let config = loadConfig(CONFIG_PATH);
let mainWindow = null;
let tray = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on('second-instance', () => {
  if (!mainWindow) {
    createWindow();
    return;
  }
  showMainWindow();
});

/**
 * AI:创建系统托盘图标，避免隐藏窗口后无法从桌面恢复。
 *
 * @returns {Electron.NativeImage} 托盘图标。
 */
function createTrayIcon() {
  const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG_BASE64, 'base64'));
  return icon.resize({ width: 16, height: 16 });
}

/**
 * AI:恢复并聚焦主窗口，供托盘和二次启动复用。
 *
 * @returns {void}
 */
function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * AI:初始化 Windows 系统托盘入口。
 *
 * @returns {Tray} 系统托盘实例。
 */
function createTray() {
  if (tray) return tray;
  tray = new Tray(createTrayIcon());
  tray.setToolTip('Codex Desktop 管理器');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示管理器', click: showMainWindow },
    { type: 'separator' },
    {
      label: '退出管理器',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]));
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
  return tray;
}

function serverPortFromUrl(serverUrl) {
  try {
    const url = new URL(serverUrl);
    if (url.port) return Number(url.port);
    if (url.protocol === 'https:') return 443;
    if (url.protocol === 'http:') return 80;
  } catch {
    return null;
  }
  return null;
}

/**
 * AI:按配置启动 Agent，避免打开管理器后仍需要手动上线。
 *
 * @returns {Promise<void>} 启动检查完成。
 */
async function startAgentIfEnabled() {
  const normalized = normalizeManagerConfig(config);
  if (!normalized.autoStart || !normalized.serverUrl || !normalized.token) return;
  if (agentController.status().running) return;
  await agentController.restart(normalized);
}

/**
 * 构建渲染层需要的状态快照。
 *
 * @returns {Promise<object>} 当前管理器状态。
 */
async function getState() {
  const normalized = normalizeManagerConfig(config);
  const [cloud, codex] = await Promise.all([probeCloud(normalized), probeCodexDebug()]);
  return {
    ok: true,
    config: normalized,
    mobileUrl: normalized.serverUrl && normalized.token ? buildMobileUrl(normalized) : '',
    agentEnv: buildAgentEnv(normalized),
    agent: agentController.status(),
    cloud,
    codex,
    ports: {
      cloud: serverPortFromUrl(normalized.serverUrl),
      codexDebug: codex.port || CODEX_DEBUG_PORT,
    },
  };
}

/**
 * 创建 Electron 主窗口。
 *
 * @returns {BrowserWindow} 主窗口。
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 720,
    minWidth: 760,
    minHeight: 620,
    title: 'Codex Desktop 管理器',
    backgroundColor: '#f4f6f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer.html'));
  mainWindow.on('minimize', event => {
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on('close', event => {
    if (app.isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  return mainWindow;
}

ipcMain.handle('manager:get-state', () => getState());

ipcMain.handle('manager:save-config', async (_event, input) => {
  config = normalizeManagerConfig(input);
  saveConfig(CONFIG_PATH, config);
  return getState();
});

ipcMain.handle('manager:stop-agent', async () => {
  agentController.stop();
  return getState();
});

ipcMain.handle('manager:pause-feature', async () => {
  config = normalizeManagerConfig(Object.assign({}, config, { autoStart: false }));
  saveConfig(CONFIG_PATH, config);
  agentController.stop();
  return getState();
});

ipcMain.handle('manager:restart-agent', async () => {
  config = normalizeManagerConfig(Object.assign({}, config, { autoStart: true }));
  saveConfig(CONFIG_PATH, config);
  await agentController.restart(config);
  return getState();
});

ipcMain.handle('manager:open-mobile', async () => {
  const normalized = normalizeManagerConfig(config);
  if (!normalized.serverUrl || !normalized.token) {
    throw new Error('请先填写云端服务器地址和固定 Token。');
  }
  await shell.openExternal(buildMobileUrl(normalized));
  return getState();
});

ipcMain.handle('manager:restart-codex', async () => {
  await restartCodexDesktopWithDebug();
  return getState();
});

app.whenReady().then(() => {
  startAgentIfEnabled().catch(error => {
    console.error(`Codex manager auto start agent failed: ${error.message}`);
  });
  createTray();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
