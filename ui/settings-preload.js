'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('flacoCfg', {
  get: () => ipcRenderer.invoke('cfg:get'),
  set: (patch) => ipcRenderer.invoke('cfg:set', patch),
  dl: (act, arg) => ipcRenderer.invoke('dl:do', act, arg),
});
