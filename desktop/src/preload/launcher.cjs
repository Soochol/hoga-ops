const { contextBridge, ipcRenderer } = require('electron');
// The main process also checks the exact sender frame and app URL.
contextBridge.exposeInMainWorld('launcher', Object.freeze({
  read: () => ipcRenderer.invoke('launcher:read'),
  connect: profile => ipcRenderer.invoke('launcher:connect', profile),
  cancel: () => ipcRenderer.invoke('launcher:cancel'),
  remove: id => ipcRenderer.invoke('launcher:remove', id),
}));
