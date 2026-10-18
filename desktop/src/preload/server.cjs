const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('serverManager', Object.freeze({
  read: () => ipcRenderer.invoke('server:read'),
  refresh: () => ipcRenderer.invoke('server:refresh'),
  start: () => ipcRenderer.invoke('server:start'),
  stop: () => ipcRenderer.invoke('server:stop'),
  openLogs: () => ipcRenderer.invoke('server:logs'),
  openClient: () => ipcRenderer.invoke('server:open-client'),
  close: () => ipcRenderer.invoke('server:close'),
  quit: () => ipcRenderer.invoke('server:quit'),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('server:state', listener);
    return () => ipcRenderer.removeListener('server:state', listener);
  },
}));
