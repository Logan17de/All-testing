const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getStatus: () => ipcRenderer.invoke('app:status'),
  startHarness: () => ipcRenderer.invoke('harness:start'),
  restartHarness: () => ipcRenderer.invoke('harness:restart'),
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  receivePlugin: () => ipcRenderer.invoke('plugin:receive'),
  activatePlugin: (id) => ipcRenderer.invoke('plugin:activate', id),
  disablePlugin: (name) => ipcRenderer.invoke('plugin:disable', name),
  rollbackPlugin: () => ipcRenderer.invoke('plugin:rollback'),
  listPlugins: () => ipcRenderer.invoke('plugin:list'),
  testApi: (config) => ipcRenderer.invoke('api:test', config),
  getLogs: () => ipcRenderer.invoke('logs:get'),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  onLog: (callback) => ipcRenderer.on('log:line', (_event, line) => callback(line)),
  onHarnessStatus: (callback) => ipcRenderer.on('harness:status', (_event, status) => callback(status)),
});
