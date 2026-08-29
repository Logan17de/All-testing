const { contextBridge, ipcRenderer } = require('electron');

function numberOrNull(value) {
  const parsed = Number(value);
  return value === null || value === undefined || value === '' || !Number.isFinite(parsed) ? null : parsed;
}

function normalizeUsage(source, fallback = {}) {
  const usage = source && typeof source.usage === 'object' && source.usage ? source.usage : null;
  const used = numberOrNull(usage?.used);
  const remaining = numberOrNull(usage?.remaining);
  const refreshIn = typeof usage?.refreshIn === 'string' && usage.refreshIn.trim() ? usage.refreshIn.trim() : null;
  const resetAt = typeof usage?.resetAt === 'string' && usage.resetAt.trim() ? usage.resetAt.trim() : null;
  return {
    ...fallback,
    used,
    remaining,
    refreshIn,
    resetAt,
    available: used !== null || remaining !== null || refreshIn !== null || resetAt !== null,
  };
}

async function getUsage() {
  let providers = [];
  let authorizations = [];
  try {
    const routes = await ipcRenderer.invoke('llm:providers');
    providers = routes?.providers || [];
  } catch {}
  try {
    const auth = await ipcRenderer.invoke('authorization:list');
    authorizations = auth?.items || [];
  } catch {}

  const items = providers.map((provider) => normalizeUsage(provider, {
    id: provider.provider,
    label: provider.displayName || provider.provider,
    kind: 'Provider',
  }));
  for (const account of authorizations) {
    items.push(normalizeUsage(account, {
      id: account.key,
      label: account.label || account.key,
      kind: 'Account',
    }));
  }
  return { available: items.some((item) => item.available), items };
}

function skillSlug(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

async function createSkill(input = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Enter a skill name.');
  const slug = skillSlug(name);
  if (!slug) throw new Error('The skill name needs at least one letter or number.');
  const workspace = await ipcRenderer.invoke('workspace:get');
  if (!workspace?.path) throw new Error('Open a workspace before creating a skill.');
  const cleanDescription = String(input.description || '').replace(/[\r\n]+/g, ' ').trim();
  const target = `${String(workspace.path).replace(/[\\/]+$/, '')}/.dsh/skills/${slug}/SKILL.md`;
  const safeName = name.replace(/"/g, '\\"');
  const safeDescription = cleanDescription.replace(/"/g, '\\"');
  const text = `---\nname: "${safeName}"\ndescription: "${safeDescription}"\n---\n\n# ${name}\n\n${cleanDescription || 'Describe the reusable workflow and instructions for this skill here.'}\n`;
  await ipcRenderer.invoke('workspace:saveFile', { path: target, text });
  return { ok: true, path: target, name, slug };
}

const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.log', '.json', '.yml', '.yaml', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.toml', '.env', '.diff', '.patch', '.csv',
]);

function extension(target) {
  const name = String(target || '').split(/[\\/]/).pop() || '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

async function previewFile(target) {
  if (!TEXT_EXTENSIONS.has(extension(target))) {
    return { type: 'external', name: String(target || '').split(/[\\/]/).pop() || 'Artifact' };
  }
  try {
    const result = await ipcRenderer.invoke('workspace:readFile', target);
    return { type: 'text', ...result };
  } catch {}
  try {
    const result = await ipcRenderer.invoke('files:read', target);
    return { type: 'text', ...result };
  } catch (error) {
    return { type: 'error', error: error.message };
  }
}

contextBridge.exposeInMainWorld('desktop', {
  getStatus: () => ipcRenderer.invoke('app:status'),
  connect: () => ipcRenderer.invoke('app:connect'),
  reconnect: () => ipcRenderer.invoke('app:reconnect'),
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  getWorkspace: () => ipcRenderer.invoke('workspace:get'),
  listWorkspaces: () => ipcRenderer.invoke('workspace:list'),
  listSessions: () => ipcRenderer.invoke('session:list'),
  createSession: () => ipcRenderer.invoke('session:create'),
  getSessionHistory: (sessionId) => ipcRenderer.invoke('session:history', sessionId),
  getSessionModels: (sessionId) => ipcRenderer.invoke('session:models', sessionId),
  selectSessionModel: (selection) => ipcRenderer.invoke('session:select-model', selection),
  promptSession: (sessionId, text) => ipcRenderer.invoke('session:prompt', { sessionId, text }),
  cancelSession: (sessionId) => ipcRenderer.invoke('session:cancel', sessionId),
  getProvider: () => ipcRenderer.invoke('provider:get'),
  getUsage,
  discoverProviderModels: (config) => ipcRenderer.invoke('provider:discover-models', config),
  saveProvider: (config) => ipcRenderer.invoke('provider:save', config),
  removeProvider: (provider) => ipcRenderer.invoke('provider:remove', provider),
  listCredentials: () => ipcRenderer.invoke('credentials:list'),
  openSignIn: (url) => ipcRenderer.invoke('auth:open', url),
  listAuthorizations: () => ipcRenderer.invoke('authorization:list'),
  beginAuthorization: (request) => ipcRenderer.invoke('authorization:begin', request),
  answerAuthorization: (request) => ipcRenderer.invoke('authorization:answer', request),
  cancelAuthorization: (request) => ipcRenderer.invoke('authorization:cancel', request),
  clearCredential: (ref) => ipcRenderer.invoke('credentials:clear', ref),
  receivePlugin: () => ipcRenderer.invoke('plugin:receive'),
  activatePlugin: (id) => ipcRenderer.invoke('plugin:activate', id),
  disablePlugin: (name) => ipcRenderer.invoke('plugin:disable', name),
  rollbackPlugin: () => ipcRenderer.invoke('plugin:rollback'),
  listProviders: () => ipcRenderer.invoke('llm:providers'),
  listPlugins: () => ipcRenderer.invoke('plugin:list'),
  restoreHarnessCore: () => ipcRenderer.invoke('harness:restore-core'),
  testApi: (config) => ipcRenderer.invoke('api:test', config),
  savePluginGuide: () => ipcRenderer.invoke('plugin:guide'),
  saveStarterPlugin: () => ipcRenderer.invoke('plugin:starter'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  setWorkspace: (target) => ipcRenderer.invoke('workspace:set', target),
  listWorkspaceFiles: () => ipcRenderer.invoke('workspace:files'),
  readWorkspaceFile: (target) => ipcRenderer.invoke('workspace:readFile', target),
  saveWorkspaceFile: (target, text) => ipcRenderer.invoke('workspace:saveFile', { path: target, text }),
  listArtifacts: () => ipcRenderer.invoke('artifacts:list'),
  listSkills: () => ipcRenderer.invoke('skills:list'),
  createSkill,
  readFile: (target) => ipcRenderer.invoke('files:read', target),
  previewFile,
  revealFile: (target) => ipcRenderer.invoke('files:reveal', target),
  getLogs: () => ipcRenderer.invoke('logs:get'),
  reportLog: (source, message) => ipcRenderer.send('log:renderer', source, message),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  onLog: (callback) => ipcRenderer.on('log:line', (_event, line) => callback(line)),
  onHarnessStatus: (callback) => ipcRenderer.on('harness:status', (_event, status) => callback(status)),
  onEngineEvent: (callback) => ipcRenderer.on('engine:event', (_event, message) => callback(message)),
});

window.addEventListener('DOMContentLoaded', () => {
  for (const src of ['enhancements.js', 'detached-previews.js']) {
    const script = document.createElement('script');
    script.src = src;
    script.defer = true;
    document.head.appendChild(script);
  }
});
