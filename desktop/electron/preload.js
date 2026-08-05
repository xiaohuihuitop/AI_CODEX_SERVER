const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codexManager', {
  getState: () => ipcRenderer.invoke('manager:get-state'),
  saveConfig: config => ipcRenderer.invoke('manager:save-config', config),
  stopAgent: () => ipcRenderer.invoke('manager:stop-agent'),
  pauseFeature: () => ipcRenderer.invoke('manager:pause-feature'),
  restartAgent: () => ipcRenderer.invoke('manager:restart-agent'),
  clearLogs: () => ipcRenderer.invoke('manager:clear-logs'),
  openMobile: () => ipcRenderer.invoke('manager:open-mobile'),
});
