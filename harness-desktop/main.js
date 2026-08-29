const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HarnessRuntime } = require('./lib/runtime');
const { PluginManager } = require('./lib/plugin-manager');
const { testApiConnection } = require('./lib/api-check');
const { listArtifacts, listSkills, listWorkspaceFiles, readTextFile, writeTextFile, isInside } = require('./lib/workspace-files');
const { guideText, starterFiles } = require('./lib/plugin-template');
const AdmZip = require('adm-zip');

let mainWindow;
let runtime;
let pluginManager;
let quitting = false;
let safeMode = process.argv.includes('--safe-mode');
const explicitSafeMode = safeMode;
let settings;
const logs = [];
let logFile;
let connectionAttempt = null;

const userDataOverride = process.env.HARNESS_DESKTOP_USER_DATA?.trim();
if (userDataOverride) app.setPath('userData', path.resolve(userDataOverride));

function canSendToRenderer() {
  return Boolean(
    mainWindow
    && !mainWindow.isDestroyed()
    && mainWindow.webContents
    && !mainWindow.webContents.isDestroyed()
  );
}

function sendToRenderer(channel, ...args) {
  if (!canSendToRenderer()) return false;
  try {
    mainWindow.webContents.send(channel, ...args);
    return true;
  } catch {
    return false;
  }
}

function log(source, message) {
  if (!message) return;
  for (const line of String(message).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const item = { at: new Date().toISOString(), source, message: line };
    logs.push(item);
    if (logs.length > 1500) logs.shift();
    if (logFile) {
      try { fs.appendFileSync(logFile, `${JSON.stringify(item)}\n`); } catch {}
    }
    sendToRenderer('log:line', item);
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
    return state.state === 'booting' || state.state === 'crashed';
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
      webviewTag: false,
      sandbox: true,
    },
  });
  mainWindow.once('closed', () => { mainWindow = null; });
  mainWindow.webContents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
    if (isMainFrame) log('app', `Window load failed (${code} ${description}) for ${validatedUrl}.`);
  });
  await mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
}

async function syncWorkspace() {
  if (!runtime?.ready || !settings.workspace) return null;
  const result = await runtime.request('workspace.create', { path: settings.workspace });
  settings.workspaceId = result.workspace.workspaceId;
  saveSettings();
  return result.workspace;
}

async function bootHarness(interruptedBoot = false) {
  const pending = pluginManager.getPendingChange();
  if (!explicitSafeMode && pending && (interruptedBoot || pending.phase === 'changing')) {
    try {
      log('app', 'An interrupted plugin change was detected. Restoring the previous working profile.');
      await pluginManager.recoverPendingChange();
      safeMode = false;
      writeBootState('healthy');
      sendToRenderer('harness:status', runtime.status());
      return;
    } catch (error) {
      safeMode = true;
      log('app', `Automatic recovery failed: ${error.message}`);
      return;
    }
  }
  if (safeMode) {
    log('app', 'Safe Mode is active. Harness auto-start is disabled so rollback remains available.');
    return;
  }
  writeBootState('booting');
  const result = await runtime.start(settings.workspace);
  if (result.ok) {
    try { await syncWorkspace(); }
    catch (error) { log('workspace', `Workspace registration failed: ${error.message}`); }
    if (pending) {
      const verification = await pluginManager.verifyPendingChange();
      if (!verification.ok) {
        try {
          log('plugin', `Post-restart plugin verification failed: ${verification.error} Restoring the previous profile.`);
          await pluginManager.recoverPendingChange();
          safeMode = false;
          writeBootState('healthy');
          sendToRenderer('harness:status', runtime.status());
          return;
        } catch (error) {
          log('plugin', `Automatic post-restart rollback failed: ${error.message}`);
          safeMode = true;
          return;
        }
      }
      pluginManager.confirmPendingRestart();
      log('plugin', 'Post-restart health and config checks passed. The plugin change is now committed.');
    }
    const ready = runtime.status();
    log('app', `Harness engine is ready (DSH ${ready.dshVersion}, pnpm ${ready.pnpmVersion}) over ${ready.transport}.`);
    log('workspace', `Using workspace ${settings.workspace}.`);
    writeBootState('healthy');
    sendToRenderer('harness:status', runtime.status());
  } else {
    if (pending) {
      try {
        log('plugin', 'Post-restart health check failed. Automatically restoring the previous profile.');
        await pluginManager.recoverPendingChange();
        safeMode = false;
        writeBootState('healthy');
        sendToRenderer('harness:status', runtime.status());
        return;
      } catch (error) {
        log('plugin', `Automatic post-restart rollback failed: ${error.message}`);
      }
    }
    safeMode = true;
    log('app', 'Harness failed its startup health check. Entering Safe Mode.');
    sendToRenderer('harness:status', runtime.status());
  }
}

async function connectHarness({ restart = false } = {}) {
  if (connectionAttempt) return connectionAttempt;
  connectionAttempt = (async () => {
    if (explicitSafeMode) {
      return { ok: false, reason: 'Harness Desktop was opened with --safe-mode. Relaunch normally to connect.' };
    }
    safeMode = false;
    writeBootState('booting');
    sendToRenderer('harness:status', { ...runtime.status(), connecting: true, safeMode: false });
    try {
      const result = restart
        ? await runtime.restart(settings.workspace)
        : await runtime.start(settings.workspace);
      if (!result.ok) {
        const reason = result.reason || 'The local Harness service did not become ready.';
        writeBootState('crashed');
        log('app', `Connection failed: ${reason}`);
        return { ok: false, reason, status: runtime.status() };
      }
      await syncWorkspace();
      writeBootState('healthy');
      const ready = runtime.status();
      log('app', `Connected to Harness (DSH ${ready.dshVersion}, pnpm ${ready.pnpmVersion}).`);
      return { ok: true, status: ready };
    } catch (error) {
      const reason = error?.message || String(error);
      writeBootState('crashed');
      log('app', `Connection failed: ${reason}`);
      return { ok: false, reason, status: runtime.status() };
    } finally {
      sendToRenderer('harness:status', { ...runtime.status(), connecting: false, safeMode });
    }
  })();
  try { return await connectionAttempt; }
  finally { connectionAttempt = null; }
}

function registerIpc() {
  const runProfileChange = async (action) => {
    writeBootState('booting');
    try {
      const result = await action();
      writeBootState('pending-restart');
      return result;
    } catch (error) {
      log('plugin', `Profile change failed: ${error.message}`);
      if (await runtime.isHealthy()) writeBootState('healthy');
      throw error;
    }
  };

  ipcMain.handle('app:status', async () => ({
    ...runtime.status(),
    healthy: await runtime.isHealthy(),
    safeMode,
    workspace: settings.workspace,
  }));

  ipcMain.handle('app:connect', async () => connectHarness());
  ipcMain.handle('app:reconnect', async () => connectHarness({ restart: true }));

  ipcMain.handle('workspace:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    settings.workspace = result.filePaths[0];
    settings.workspaceId = null;
    saveSettings();
    if (await runtime.isHealthy()) await syncWorkspace();
    log('app', `Workspace changed to ${settings.workspace}.`);
    return { path: settings.workspace, workspaceId: settings.workspaceId };
  });

  // The Projects rail lists real DSH workspaces. An offline engine returns an
  // empty list rather than failing the whole render.
  ipcMain.handle('workspace:list', async () => {
    if (!await runtime.isHealthy()) return { items: [] };
    try {
      const result = await runtime.request('workspace.list', {});
      const items = result.items || result.workspaces || [];
      return { items: Array.isArray(items) ? items : Object.values(items) };
    } catch (error) {
      log('workspace', `Workspace list failed: ${error.message}`);
      return { items: [] };
    }
  });

  ipcMain.handle('workspace:get', async () => {
    if (!await runtime.isHealthy()) return { path: settings.workspace, workspaceId: settings.workspaceId || null };
    const workspace = await syncWorkspace();
    return workspace || { path: settings.workspace, workspaceId: settings.workspaceId || null };
  });

  ipcMain.handle('session:list', async () => runtime.request('session.list', {}));
  ipcMain.handle('session:create', async () => {
    const workspace = await syncWorkspace();
    return runtime.request('session.create', workspace
      ? { workspaceId: workspace.workspaceId }
      : { cwd: settings.workspace });
  });
  ipcMain.handle('session:history', async (_event, sessionId) => runtime.request('session.history', { sessionId, maxMessages: 100 }));
  ipcMain.handle('session:models', async (_event, sessionId) => runtime.request('session.models', { sessionId }));
  ipcMain.handle('session:select-model', async (_event, selection) => runtime.request('session.selectModel', selection));
  ipcMain.handle('session:prompt', async (_event, { sessionId, text }) => runtime.request('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));
  ipcMain.handle('session:cancel', async (_event, sessionId) => runtime.request('session.cancel', { sessionId }));

  ipcMain.handle('provider:get', async () => {
    if (!await runtime.isHealthy()) return { available: false };
    const [settingsView, credentials, models] = await Promise.all([
      runtime.request('settings.describe', {}),
      runtime.request('credentials.describe', { refs: ['DEEPSEEK_API_KEY'] }),
      runtime.request('llm.models', {}),
    ]);
    const provider = settingsView.namespaces.find((item) => item.ns === 'llm-deepseek');
    const defaultModel = settingsView.namespaces.find((item) => item.ns === 'agent-default-model');
    return {
      available: true,
      writable: settingsView.writable,
      baseUrl: provider?.value?.baseURL || 'https://api.deepseek.com',
      configured: Boolean(credentials.credentials.DEEPSEEK_API_KEY?.configured),
      credentialSource: credentials.credentials.DEEPSEEK_API_KEY?.source || null,
      model: defaultModel?.value?.model || 'deepseek-v4-flash',
      models: models.groups.find((group) => group.id === 'deepseek-official')?.models || [],
    };
  });

  // Credential refs are discovered from the provider settings themselves, so the
  // Accounts view never guesses at names.
  const credentialRefs = async () => {
    const described = await runtime.request('settings.describe', {});
    const refs = new Map();
    const deepseek = described.namespaces.find((n) => n.ns === 'llm-deepseek');
    if (deepseek?.value?.apiKeyEnv) refs.set(deepseek.value.apiKeyEnv, 'DeepSeek');
    const custom = described.namespaces.find((n) => n.ns === 'llm-pi-ai');
    for (const [name, cfg] of Object.entries(custom?.value?.providers || {})) {
      if (cfg?.apiKeyEnv) refs.set(cfg.apiKeyEnv, name);
    }
    return { described, refs };
  };

  ipcMain.handle('credentials:list', async () => {
    if (!await runtime.isHealthy()) return { items: [] };
    try {
      const { refs } = await credentialRefs();
      if (!refs.size) return { items: [] };
      const described = await runtime.request('credentials.describe', { refs: [...refs.keys()] });
      return {
        items: [...refs.entries()].map(([ref, owner]) => ({
          ref,
          owner,
          configured: Boolean(described.credentials?.[ref]?.configured),
          source: described.credentials?.[ref]?.source || null,
          writable: described.credentials?.[ref]?.writable !== false,
        })),
      };
    } catch (error) { log('api', `Credential list failed: ${error.message}`); return { items: [] }; }
  });

  ipcMain.handle('credentials:clear', async (_event, ref) => {
    await runtime.request('credentials.unset', { ref });
    log('api', `Cleared credential ${ref}.`);
    return { ok: true };
  });

  const discoverProviderModels = async (config = {}) => {
    const connected = await connectHarness();
    if (!connected.ok) throw new Error(connected.reason || 'Could not connect to Harness.');
    const target = String(config.provider || 'deepseek-official');
    const catalog = await runtime.request('llm.models', {});
    const registered = (catalog.groups || []).find((group) => group.id === target)?.models || [];
    if (!config.apiKey?.trim() && registered.length) return { models: registered };

    const check = await testApiConnection(config);
    if (!check.ok) throw new Error(check.error || 'The provider model endpoint could not be reached.');
    if (check.models?.length) return { models: check.models };

    const result = await runtime.request('llm.discoverModels', {
      settingsNs: target === 'deepseek-official' ? 'llm-deepseek' : 'llm-pi-ai',
      provider: target,
      baseURL: config.baseUrl?.trim() || undefined,
      api: config.api || undefined,
      apiKey: config.apiKey?.trim() || undefined,
    }, 60_000);
    const models = Array.isArray(result?.models) ? result.models : [];
    if (!models.length) throw new Error('The provider connected, but its model endpoint did not report any available models.');
    return { models };
  };

  ipcMain.handle('provider:discover-models', async (_event, config) => discoverProviderModels(config));

  // Saves the bundled DeepSeek route, or any other route the engine declares,
  // which is written into the llm-pi-ai providers map.
  ipcMain.handle('provider:save', async (_event, config) => {
    const discovered = await discoverProviderModels(config);
    const described = await runtime.request('settings.describe', {});
    const target = config.provider || 'deepseek-official';
    const chosen = discovered.models.find((model) => model.id === config.model) || discovered.models[0];

    if (target === 'deepseek-official') {
      const provider = described.namespaces.find((item) => item.ns === 'llm-deepseek');
      const defaultModel = described.namespaces.find((item) => item.ns === 'agent-default-model');
      if (!provider || !defaultModel) throw new Error('The bundled DeepSeek provider is unavailable.');
      const ref = provider.value?.apiKeyEnv || 'DEEPSEEK_API_KEY';
      if (config.apiKey?.trim()) {
        await runtime.request('credentials.set', { ref, value: config.apiKey.trim() });
      }
      await runtime.request('settings.mutate', {
        ns: 'llm-deepseek',
        expectedRevision: provider.revision,
        ops: [{ op: 'set', path: ['baseURL'], value: config.baseUrl.trim() }],
      });
      await runtime.request('settings.mutate', {
        ns: 'agent-default-model',
        expectedRevision: defaultModel.revision,
        ops: [
          { op: 'set', path: ['provider'], value: 'deepseek-official' },
          { op: 'set', path: ['model'], value: chosen.id },
        ],
      });
      log('api', `DeepSeek provider saved with ${discovered.models.length} discovered model(s).`);
      return { ok: true, models: discovered.models, selectedModel: chosen.id };
    }

    const custom = described.namespaces.find((item) => item.ns === 'llm-pi-ai');
    if (!custom) throw new Error('This engine build exposes no configurable provider namespace.');
    const ref = config.apiKeyRef?.trim() || `${target.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
    if (config.apiKey?.trim()) {
      await runtime.request('credentials.set', { ref, value: config.apiKey.trim() });
    }
    await runtime.request('settings.mutate', {
      ns: 'llm-pi-ai',
      expectedRevision: custom.revision,
      ops: [{
        op: 'set',
        path: ['providers', target],
        value: {
          api: config.api || 'openai-completions',
          baseURL: config.baseUrl.trim(),
          apiKeyEnv: ref,
          models: discovered.models.map((model) => ({
            id: model.id,
            name: model.name || model.id,
            ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
            ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
          })),
        },
      }],
    });
    log('api', `Provider ${target} saved with ${discovered.models.length} discovered model(s).`);
    return { ok: true, models: discovered.models, selectedModel: chosen.id };
  });

  ipcMain.handle('provider:remove', async (_event, providerId) => {
    const target = String(providerId || '');
    if (!target || target === 'deepseek-official') throw new Error('That built-in provider cannot be removed.');
    const described = await runtime.request('settings.describe', {});
    const custom = described.namespaces.find((item) => item.ns === 'llm-pi-ai');
    if (!custom) throw new Error('Custom provider settings are unavailable.');
    if (!custom.value?.providers?.[target]) return { ok: true };
    await runtime.request('settings.mutate', {
      ns: 'llm-pi-ai',
      expectedRevision: custom.revision,
      ops: [{ op: 'unset', path: ['providers', target] }],
    });
    log('api', `Removed provider ${target}.`);
    return { ok: true };
  });

  ipcMain.handle('plugin:receive', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Harness plugin archive',
      filters: [{ name: 'Plugin archive', extensions: ['zip'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const trust = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Trust and inspect'],
      defaultId: 0,
      cancelId: 0,
      title: 'Trust this plugin archive?',
      message: 'Plugins can run code with your user permissions.',
      detail: 'Only continue if you trust the archive and its author. Harness will install dependencies and may run package build scripts while preparing it.',
    });
    if (trust.response !== 1) return null;
    return pluginManager.receiveZip(result.filePaths[0]);
  });

  ipcMain.handle('plugin:activate', async (_event, id) => {
    const trust = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Activate plugin'],
      defaultId: 0,
      cancelId: 0,
      title: 'Activate this plugin?',
      message: 'The plugin will become part of the local Harness runtime.',
      detail: 'Activation restarts the local connection. Continue only if you trust the plugin code and the permissions shown in its manifest.',
    });
    if (trust.response !== 1) return null;
    return runProfileChange(() => pluginManager.activate(id));
  });
  ipcMain.handle('plugin:disable', async (_event, name) => runProfileChange(() => pluginManager.disable(name)));
  ipcMain.handle('plugin:rollback', async () => runProfileChange(() => pluginManager.rollbackPrevious()));
  // The provider table is built from what the engine actually routes, not a
  // hardcoded vendor list.
  ipcMain.handle('llm:providers', async () => {
    if (!await runtime.isHealthy()) return { providers: [], groups: [] };
    try {
      const [list, models] = await Promise.all([
        runtime.request('llm.providers', {}),
        runtime.request('llm.models', {}),
      ]);
      return { providers: list.providers || [], groups: models.groups || [] };
    } catch (error) {
      log('api', `Provider list failed: ${error.message}`);
      return { providers: [], groups: [] };
    }
  });

  // Installed plugins carry their real manifest so the UI never invents a
  // description, permission set, or compatibility range.
  ipcMain.handle('plugin:list', async () => {
    const listed = pluginManager.list();
    listed.installed = listed.installed.map((plugin) => {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(plugin.path, 'package.json'), 'utf8'));
        return {
          ...plugin,
          description: typeof manifest.description === 'string' ? manifest.description : '',
          author: manifest.author?.name || manifest.author || null,
          homepage: manifest.homepage || null,
          license: manifest.license || null,
          permissions: manifest.harnessDesktop?.permissions || [],
          patch: manifest.dsh?.bundle?.patch || null,
          engines: manifest.engines || null,
        };
      } catch {
        return { ...plugin, manifestMissing: true };
      }
    });
    return listed;
  });

  // Destructive, so it confirms in the main process where the dialog is native.
  ipcMain.handle('harness:restore-core', async () => {
    const skillDirs = listSkills({ workspace: settings.workspace, dshHome: runtime.dshHome }).roots;
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Restore core state'],
      defaultId: 0,
      cancelId: 0,
      title: 'Restore Harness',
      message: 'Reset Harness to its core state?',
      detail: 'This unmounts every plugin you added, leaving only the plugins and skills that ship with Harness.'
        + '\n\nYour plugin archives are kept, and skill folders are moved aside rather than deleted, so nothing is lost.'
        + '\nA restore point is taken first — Roll back undoes this.',
    });
    if (choice.response !== 1) return null;
    return runProfileChange(() => pluginManager.restoreCore({ skillDirs }));
  });

  ipcMain.handle('api:test', async (_event, config) => {
    const result = await testApiConnection(config);
    log('api', result.ok
      ? `Provider connection succeeded with HTTP ${result.status}.`
      : `Provider connection failed: ${result.error}`);
    return result;
  });

  // Artifacts and Skills are read from real files: the app's own managed
  // storage, and the skill directories DSH itself loads from.
  const artifactRoots = () => [app.getPath('userData')];
  const skillRoots = () => listSkills({ workspace: settings.workspace, dshHome: runtime.dshHome }).roots;

  // Writes the plugin format guide the receiver actually enforces, so a plugin
  // author can check their archive against it before handing it over.
  ipcMain.handle('plugin:guide', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save plugin format guide',
      defaultPath: 'harness-plugin-format.txt',
      filters: [{ name: 'Text file', extensions: ['txt'] }],
    });
    if (result.canceled || !result.filePath) return null;
    fs.writeFileSync(result.filePath, guideText(), 'utf8');
    log('plugin', `Plugin format guide written to ${result.filePath}.`);
    return { path: result.filePath };
  });

  // A minimal plugin that passes every check, for exercising the install path.
  ipcMain.handle('plugin:starter', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save starter plugin archive',
      defaultPath: 'dsh-starter-plugin.zip',
      filters: [{ name: 'Plugin archive', extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePath) return null;
    const zip = new AdmZip();
    for (const file of starterFiles()) zip.addFile(file.path, Buffer.from(file.content, 'utf8'));
    zip.writeZip(result.filePath);
    log('plugin', `Starter plugin archive written to ${result.filePath}.`);
    return { path: result.filePath };
  });

  // Frameless-style window controls in the header need real window actions.
  ipcMain.handle('window:minimize', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
    mainWindow.minimize();
    return { ok: true };
  });
  ipcMain.handle('window:maximize', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
    if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
    return { ok: true, maximized: mainWindow.isMaximized() };
  });
  ipcMain.handle('window:close', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
    mainWindow.close();
    return { ok: true };
  });

  // Switch to a project already known to the engine, without a file dialog.
  ipcMain.handle('workspace:set', async (_event, target) => {
    if (typeof target !== 'string' || !target.trim()) throw new Error('No workspace path given.');
    if (!fs.existsSync(target)) throw new Error('That folder no longer exists.');
    settings.workspace = target;
    settings.workspaceId = null;
    saveSettings();
    if (await runtime.isHealthy()) await syncWorkspace();
    log('workspace', `Workspace changed to ${target}.`);
    return { path: settings.workspace, workspaceId: settings.workspaceId || null };
  });

  // Editor files are scoped to the open workspace.
  ipcMain.handle('workspace:files', async () => listWorkspaceFiles({ workspace: settings.workspace }));
  ipcMain.handle('workspace:readFile', async (_event, target) =>
    readTextFile({ roots: [settings.workspace], target }));
  ipcMain.handle('workspace:saveFile', async (_event, { path: target, text }) => {
    const result = writeTextFile({ roots: [settings.workspace], target, text });
    log('workspace', `Saved ${target} (${result.bytes} bytes).`);
    return result;
  });

  ipcMain.handle('artifacts:list', async () => listArtifacts({ userData: app.getPath('userData') }));
  // Prefer the engine's own skill registry; fall back to scanning the folders
  // it loads from when the engine is not up.
  ipcMain.handle('skills:list', async () => {
    const scanned = listSkills({ workspace: settings.workspace, dshHome: runtime.dshHome });
    if (!await runtime.isHealthy()) return { ...scanned, source: 'disk' };
    try {
      const engine = await runtime.request('skills.list', {});
      const items = engine.items || engine.skills || [];
      if (!Array.isArray(items) || !items.length) return { ...scanned, source: 'disk' };
      const byName = new Map(scanned.items.map((s) => [s.name, s]));
      return {
        items: items.map((skill) => {
          const onDisk = byName.get(skill.name) || {};
          return {
            id: `engine:${skill.name || skill.id}`,
            name: skill.name || skill.id,
            description: skill.description || onDisk.description || '',
            source: skill.source || onDisk.source || 'Engine',
            dir: onDisk.dir || null,
            manifest: onDisk.manifest || null,
            modifiedAt: onDisk.modifiedAt || null,
          };
        }),
        roots: scanned.roots,
        source: 'engine',
      };
    } catch { return { ...scanned, source: 'disk' }; }
  });

  ipcMain.handle('authorization:list', async () => {
    const connected = await connectHarness();
    if (!connected.ok) throw new Error(connected.reason || 'Could not connect to Harness.');
    return runtime.request('authorization.list', {});
  });
  ipcMain.handle('authorization:begin', async (_event, request) =>
    runtime.request('authorization.begin', request, 10 * 60_000));
  ipcMain.handle('authorization:answer', async (_event, request) =>
    runtime.request('authorization.answer', request));
  ipcMain.handle('authorization:cancel', async (_event, request) =>
    runtime.request('authorization.cancel', request));

  ipcMain.handle('auth:open', async (_event, url) => {
    if (!/^https:\/\//i.test(String(url || ''))) throw new Error('Only https sign-in links can be opened.');
    await shell.openExternal(url);
    log('api', `Opened provider sign-in page: ${url}`);
    return { ok: true };
  });

  ipcMain.handle('files:read', async (_event, target) =>
    readTextFile({ roots: [...artifactRoots(), ...skillRoots()], target }));

  ipcMain.handle('files:reveal', async (_event, target) => {
    const roots = [...artifactRoots(), ...skillRoots()];
    const { isInside } = require('./lib/workspace-files');
    if (!roots.some((root) => isInside(root, target))) {
      throw new Error('That path is outside Harness Desktop managed storage.');
    }
    shell.showItemInFolder(target);
    return { ok: true };
  });

  ipcMain.handle('logs:get', async () => logs);
  ipcMain.on('log:renderer', (_event, source, message) => log(source || 'renderer', message));
  ipcMain.handle('app:relaunch', async () => {
    await runtime.stop();
    writeBootState('clean');
    app.relaunch({ args: process.argv.slice(1).filter((arg) => arg !== '--safe-mode') });
    app.exit(0);
  });
}

app.whenReady().then(async () => {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  logFile = path.join(app.getPath('userData'), 'harness-desktop.log');
  try {
    const previousLines = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).slice(-1000);
    for (const line of previousLines) {
      try { logs.push(JSON.parse(line)); } catch {}
    }
    if (fs.statSync(logFile).size > 5 * 1024 * 1024) {
      fs.writeFileSync(logFile, `${logs.map((item) => JSON.stringify(item)).join('\n')}\n`);
    }
  } catch {}
  const interruptedBoot = previousBootWasInterrupted();
  if (interruptedBoot) safeMode = true;
  settings = loadSettings();

  runtime = new HarnessRuntime({
    appRoot: app.getAppPath(),
    logger: log,
    dshHome: path.join(app.getPath('userData'), 'dsh-home'),
    profileName: 'desktop',
  });
  runtime.on('event', (message) => sendToRenderer('engine:event', message));
  runtime.on('status', (status) => {
    sendToRenderer('harness:status', { ...runtime.status(), ...status });
    // An engine that dies on its own must not leave a 'healthy' boot state behind:
    // a profile can pass the ready handshake and only then fail its own activation.
    if (status.running === false && !status.expected && !quitting) {
      safeMode = true;
      log('app', status.reason
        || `Harness engine stopped unexpectedly (code ${status.code ?? 'unknown'}). Entering Safe Mode.`);
      try { writeBootState('crashed'); } catch {}
    }
  });
  pluginManager = new PluginManager({
    userData: app.getPath('userData'),
    runtime,
    logger: log,
    getWorkspace: () => settings.workspace,
  });

  registerIpc();
  await createWindow();
  log('app', `Harness Desktop started${safeMode ? ' in Safe Mode' : ''}.`);
  if (interruptedBoot || pluginManager.getPendingChange()) await bootHarness(interruptedBoot);
}).catch((error) => {
  log('app', `Fatal startup error: ${error.stack || error.message}`);
  dialog.showErrorBox('Harness Desktop could not start', error.message || String(error));
  app.exit(1);
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
