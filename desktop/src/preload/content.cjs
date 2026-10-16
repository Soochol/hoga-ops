const { contextBridge } = require('electron');
const argument = process.argv.find(value => value.startsWith('--hoga-api-origin='));
contextBridge.exposeInMainWorld('hogaDesktop', Object.freeze({
  strictConfig: true,
  apiOrigin: argument ? argument.slice('--hoga-api-origin='.length) : '',
}));
