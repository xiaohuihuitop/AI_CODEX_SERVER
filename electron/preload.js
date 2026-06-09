const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codexManager', {
  getState: () => ipcRenderer.invoke('manager:get-state'),
  saveConfig: config => ipcRenderer.invoke('manager:save-config', config),
  startAgent: () => ipcRenderer.invoke('manager:start-agent'),
  stopAgent: () => ipcRenderer.invoke('manager:stop-agent'),
  openMobile: () => ipcRenderer.invoke('manager:open-mobile'),
});
