const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codexManager', {
  getState: () => ipcRenderer.invoke('manager:get-state'),
  saveConfig: config => ipcRenderer.invoke('manager:save-config', config),
  stopAgent: () => ipcRenderer.invoke('manager:stop-agent'),
  restartAgent: () => ipcRenderer.invoke('manager:restart-agent'),
  restartCodex: () => ipcRenderer.invoke('manager:restart-codex'),
  openMobile: () => ipcRenderer.invoke('manager:open-mobile'),
});
