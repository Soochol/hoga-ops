const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('serverManager', Object.freeze({
  read: () => ipcRenderer.invoke('server:read'),
  refresh: () => ipcRenderer.invoke('server:refresh'),
  start: () => ipcRenderer.invoke('server:start'),
  stop: () => ipcRenderer.invoke('server:stop'),
  openLogs: () => ipcRenderer.invoke('server:logs'),
  openClient: () => ipcRenderer.invoke('server:open-client'),
  windowState: () => ipcRenderer.invoke('server:window-state'),
  minimize: () => ipcRenderer.invoke('server:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('server:toggle-maximize'),
  close: () => ipcRenderer.invoke('server:close'),
  quit: () => ipcRenderer.invoke('server:quit'),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('server:state', listener);
    return () => ipcRenderer.removeListener('server:state', listener);
  },
  onWindowState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('server:window-state', listener);
    return () => ipcRenderer.removeListener('server:window-state', listener);
  },
}));
