const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HarnessRuntime } = require('./lib/runtime');
const { PluginManager } = require('./lib/plugin-manager');

let mainWindow;
let runtime;
let pluginManager;
let quitting = false;
let safeMode = process.argv.includes('--safe-mode');
let settings;
const logs = [];

function log(source, message) {
  if (!message) return;
  for (const line of String(message).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const item = { at: new Date().toISOString(), source, message: line };
    logs.push(item);
    if (logs.length > 1500) logs.shift();
    mainWindow?.webContents.send('log:line', item);
  }
}

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function bootStateFile() {
  return path.join(app.getPath('userData'), 'boot-state.json');
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return { workspace: os.homedir() };
  }
}

function saveSettings() {
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

function writeBootState(state) {
  fs.writeFileSync(bootStateFile(), JSON.stringify({ state, at: new Date().toISOString() }, null, 2));
}

function previousBootWasInterrupted() {
  try {
    const state = JSON.parse(fs.readFileSync(bootStateFile(), 'utf8'));
    return state.state === 'booting';
  } catch {
    return false;
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1050,
    minHeight: 680,
    backgroundColor: '#0b0d12',
    title: 'Harness Desktop',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  await mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

async function bootHarness() {
  if (safeMode) {
    log('app', 'Safe Mode is active. Harness auto-start is disabled so rollback remains available.');
    return;
  }
  writeBootState('booting');
  const result = await runtime.start(settings.workspace);
  if (result.ok) {
    writeBootState('healthy');
    mainWindow?.webContents.send('harness:status', runtime.status());
  } else {
    safeMode = true;
    log('app', 'Harness failed its startup health check. Entering Safe Mode.');
    mainWindow?.webContents.send('harness:status', runtime.status());
  }
}

function registerIpc() {
  ipcMain.handle('app:status', async () => ({
    ...runtime.status(),
    healthy: await runtime.isHealthy(),
    safeMode,
    workspace: settings.workspace,
  }));

  ipcMain.handle('harness:start', async () => {
    safeMode = false;
    const result = await runtime.start(settings.workspace);
    if (result.ok) writeBootState('healthy');
    return { ...result, status: runtime.status() };
  });

  ipcMain.handle('harness:restart', async () => {
    safeMode = false;
    const result = await runtime.restart(settings.workspace);
    if (result.ok) writeBootState('healthy');
    return { ...result, status: runtime.status() };
  });

  ipcMain.handle('workspace:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    settings.workspace = result.filePaths[0];
    saveSettings();
    return settings.workspace;
  });

  ipcMain.handle('plugin:receive', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Harness plugin archive',
      filters: [{ name: 'Plugin archive', extensions: ['zip'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return pluginManager.receiveZip(result.filePaths[0]);
  });

  ipcMain.handle('plugin:activate', async (_event, id) => pluginManager.activate(id));
  ipcMain.handle('plugin:disable', async (_event, name) => pluginManager.disable(name));
  ipcMain.handle('plugin:rollback', async () => pluginManager.rollbackPrevious());
  ipcMain.handle('plugin:list', async () => pluginManager.list());

  ipcMain.handle('api:test', async (_event, config) => {
    const baseUrl = String(config?.baseUrl || '').trim().replace(/\/$/, '');
    const apiKey = String(config?.apiKey || '').trim();
    if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, error: 'Enter a valid http(s) API base URL.' };

    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        preview: text.slice(0, 500),
        error: response.ok ? null : `API returned HTTP ${response.status}`,
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('logs:get', async () => logs);
  ipcMain.handle('app:relaunch', async () => {
    app.relaunch({ args: process.argv.slice(1).filter((arg) => arg !== '--safe-mode') });
    app.exit(0);
  });
}

app.whenReady().then(async () => {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  if (previousBootWasInterrupted()) safeMode = true;
  settings = loadSettings();

  runtime = new HarnessRuntime({ appRoot: app.getAppPath(), logger: log });
  pluginManager = new PluginManager({
    userData: app.getPath('userData'),
    runtime,
    logger: log,
    getWorkspace: () => settings.workspace,
  });

  registerIpc();
  await createWindow();
  await bootHarness();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  writeBootState('clean');
  Promise.resolve(runtime?.stop()).finally(() => app.exit(0));
});
