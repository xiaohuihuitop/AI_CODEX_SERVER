const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
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

const PROJECT_ROOT = path.join(__dirname, '..');
const CONFIG_PATH = getDefaultConfigPath();
const agentController = createDesktopAgentProcess({ cwd: PROJECT_ROOT });

let config = loadConfig(CONFIG_PATH);
let mainWindow = null;

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
  return mainWindow;
}

ipcMain.handle('manager:get-state', () => getState());

ipcMain.handle('manager:save-config', async (_event, input) => {
  config = normalizeManagerConfig(input);
  saveConfig(CONFIG_PATH, config);
  return getState();
});

ipcMain.handle('manager:start-agent', async () => {
  agentController.start(config);
  return getState();
});

ipcMain.handle('manager:stop-agent', async () => {
  agentController.stop();
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

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
