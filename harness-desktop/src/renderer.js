const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const esc = (v) => String(v ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

const state = {
  view: 'work',
  status: null,
  workspace: null,
  projects: [],
  sessions: [],
  sessionId: null,
  history: [],
  running: false,
  plugins: { installed: [], history: [], candidates: [] },
  selectedPlugin: null,
  candidate: null,
  tabs: [],
  activeTab: null,
  viewers: [],
  viewerExplicit: false,
  logs: [],
  artifacts: [],
  pluginFilterActive: false,
  showAllPlugins: false,
  pluginRows: [],
  sheetPlugin: null,
  editingProvider: null,
  expandedProvider: null,
  routes: { providers: [], groups: [] },
  sessionModels: null,
  authorizations: [],
  authPrompt: null,
  authorizedKeys: new Set(),
  discoveredModels: [],
  connection: 'idle',
  signInUrl: null,
  files: [],
  skills: [],
  skillRoots: [],
};

const missingTargets = [];

/**
 * Bind an event without letting a renamed or removed element abort the whole
 * script — one throw here used to leave every later control unbound.
 */
function on(selector, event, handler, options) {
  const element = $(selector);
  if (!element) { missingTargets.push(selector); return false; }
  element.addEventListener(event, handler, options);
  return true;
}

let toastTimer;
let historyTimer;
let connectPromise;

/* ── engine bridge ──────────────────────────────────────────────────────────
   Outside the desktop shell there is no preload bridge. Rather than invent
   data, every call fails cleanly so each surface renders its real
   disconnected state. Nothing in this file fabricates content. */
const CONNECTED = typeof window.desktop !== 'undefined';
if (!CONNECTED) {
  window.desktop = new Proxy({}, {
    get: (_target, name) => (typeof name === 'string' && (name.startsWith('on') || name === 'reportLog')
      ? () => {}
      : async () => { throw new Error('Harness Desktop is not connected to its engine.'); }),
  });
}

// Renderer faults used to vanish silently. Send them to the app log so a broken
// screen shows up in Diagnostics instead of just failing to paint.
if (CONNECTED && window.desktop.reportLog) {
  window.addEventListener('error', (e) => {
    window.desktop.reportLog('renderer', `${e.message} (${e.filename}:${e.lineno}:${e.colno})`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    window.desktop.reportLog('renderer', `Unhandled rejection: ${e.reason?.message || e.reason}`);
  });
}

function toast(message) {
  const box = $('#toast');
  box.textContent = message;
  box.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.add('hidden'), 4600);
}

function fmtTokens(n) {
  if (n === null || n === undefined) return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)} M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)} K`;
  return String(v);
}
function timeAgo(t) {
  const s = Math.max(0, Math.floor((Date.now() - Number(t || 0)) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
function clockTime(iso) {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}
function baseName(p) {
  return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'Workspace';
}

/* ── view switching ─────────────────────────────────────────────────────── */
function showView(id) {
  state.view = id;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${id}`));
  $$('.rail-item[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === id));
  if (id === 'plugins') void refreshPlugins();
  if (id === 'artifacts') void renderArtifactsView();
  if (id === 'skills') void renderSkillsView();
}

/* ── engine status ──────────────────────────────────────────────────────── */
async function refreshStatus() {
  try {
    state.status = await window.desktop.getStatus();
  } catch (error) {
    $('#statusRing').className = 'status-ring bad';
    toast(error.message);
    return false;
  }
  const s = state.status;
  const ready = Boolean(s.healthy && s.ready);
  $('#safeModeBanner').classList.toggle('hidden', !s.safeMode);
  const ring = $('#statusRing');
  ring.className = 'status-ring ' + (ready ? 'ready' : (s.connecting || s.running) ? 'busy' : 'off');
  ring.title = ready ? 'Connected' : s.safeMode ? 'Recovery mode' : (s.connecting || s.running) ? 'Connecting' : 'Connects when you type';
  $('#promptInput').disabled = false;
  $('#sendPrompt').disabled = false;
  if (ready) state.connection = 'ready';
  return ready;
}

function showConnection(message = '', kind = '') {
  const notice = $('#connectionNotice');
  notice.textContent = message;
  notice.className = `connection-notice${kind ? ` ${kind}` : ''}${message ? '' : ' hidden'}`;
}

async function ensureConnected() {
  if (state.status?.healthy && state.status?.ready) return true;
  if (connectPromise) return connectPromise;
  state.connection = 'connecting';
  showConnection('Connecting to Harness… Your message is preserved while the connection is prepared.');
  $('#statusRing').className = 'status-ring busy';
  connectPromise = (async () => {
    try {
      const result = await window.desktop.connect();
      if (!result?.ok) throw new Error(result?.reason || 'Harness could not establish a local connection.');
      state.status = { ...(result.status || {}), healthy: true, ready: true };
      state.connection = 'ready';
      showConnection('');
      await refreshWork();
      return true;
    } catch (error) {
      state.connection = 'error';
      showConnection(`Could not connect: ${error.message}`, 'error');
      $('#statusRing').className = 'status-ring bad';
      return false;
    } finally {
      connectPromise = null;
      $('#sendPrompt').disabled = false;
    }
  })();
  return connectPromise;
}

/* ── projects (real DSH workspaces) ─────────────────────────────────────── */
async function refreshProjects() {
  const list = $('#projectList');
  try {
    const result = await window.desktop.listWorkspaces();
    state.projects = result.items || [];
  } catch {
    state.projects = [];
  }
  const current = state.workspace?.path || state.status?.workspace;
  if (!state.projects.length && current) {
    state.projects = [{ workspaceId: state.workspace?.workspaceId || null, path: current, title: baseName(current) }];
  }
  if (!state.projects.length) {
    list.innerHTML = '<div class="rail-empty">No projects yet.</div>';
    return;
  }
  list.innerHTML = state.projects.map((p) => `
    <button class="project ${p.path === current ? 'active' : ''}" data-path="${esc(p.path)}" title="${esc(p.path)}">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3l1.5 2H13a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5z"/></svg>
      <span>${esc(p.title || baseName(p.path))}</span>
    </button>`).join('');
}

/* ── work: sessions & chat ──────────────────────────────────────────────── */
async function refreshWork({ selectFirst = true } = {}) {
  const ready = await refreshStatus();
  await refreshProjects();
  if (!ready) {
    state.sessions = [];
    state.sessionId = null;
    state.history = [];
    renderTasks();
    renderChat();
    return;
  }
  try {
    const [workspace, sessions] = await Promise.all([window.desktop.getWorkspace(), window.desktop.listSessions()]);
    state.workspace = workspace;
    $('#projectName').textContent = workspace.title || baseName(workspace.path);
    await refreshProjects();
    const allowed = new Set(workspace.sessionIds || []);
    state.sessions = (sessions.items || []).filter((x) => (allowed.size ? allowed.has(x.sessionId) : x.cwd === workspace.path));
    if (!state.sessions.some((x) => x.sessionId === state.sessionId)) {
      state.sessionId = selectFirst ? state.sessions[0]?.sessionId || null : null;
    }
    renderTasks();
    if (state.sessionId) await selectSession(state.sessionId);
    else renderChat();
  } catch (error) {
    $('#chatStream').innerHTML = `<div class="inline-state error-text">${esc(error.message)}</div>`;
  }
}

function taskTitle(session) {
  const projected = session?.projections?.values?.title;
  if (typeof projected === 'string' && projected.trim()) return projected.trim();
  if (projected?.title) return String(projected.title).trim();
  return session?.blank ? 'New task' : `Task ${String(session?.sessionId || '').slice(-6)}`;
}

function renderTasks() {
  const select = $('#taskSelect');
  if (!state.sessions.length) {
    select.innerHTML = '<option value="">No tasks yet</option>';
    return;
  }
  select.innerHTML = state.sessions.map((session) => `
    <option value="${esc(session.sessionId)}" ${session.sessionId === state.sessionId ? 'selected' : ''}>
      ${esc(taskTitle(session))}${session.running ? ' · running' : ''} · ${esc(timeAgo(session.updatedAt))}
    </option>`).join('');
}

function setRunning(running) {
  state.running = Boolean(running);
  $('#stopRun').classList.toggle('hidden', !state.running);
}

async function selectSession(sessionId) {
  state.sessionId = sessionId;
  try {
    const [history, models] = await Promise.all([
      window.desktop.getSessionHistory(sessionId),
      window.desktop.getSessionModels(sessionId),
    ]);
    if (state.sessionId !== sessionId) return;
    state.history = history.events || [];
    setRunning(state.sessions.find((x) => x.sessionId === sessionId)?.running);
    renderChat();
    renderTasks();
    renderModels(models);
  } catch (error) {
    $('#chatStream').innerHTML = `<div class="inline-state error-text">Conversation failed to load: ${esc(error.message)}</div>`;
  }
}

function contentText(content) {
  if (!Array.isArray(content)) return '';
  return content.map((b) => {
    if (b?.type === 'text' || b?.type === 'reasoning') return b.text || '';
    if (b?.type === 'tool-call') return `${b.name || 'tool'}(${b.arguments || ''})`;
    if (typeof b === 'string') return b;
    return '';
  }).filter(Boolean).join('\n');
}

function transcriptRows(entries) {
  const events = entries.map((e) => e.event || e);
  const completed = new Set(events.filter((e) => e.type === 'assistant/message').map((e) => `${e.data.turn}:${e.data.step}`));
  const streaming = new Map();
  const rows = [];
  for (const ev of events) {
    if (ev.type === 'user/message' && (ev.data?.source?.kind === 'user' || !ev.data?.source)) {
      rows.push({ seq: ev.seq, role: 'you', label: 'You', text: contentText(ev.data.content), at: ev.time });
    } else if (ev.type === 'assistant/message') {
      rows.push({ seq: ev.seq, role: 'ai', label: 'Harness AI', text: contentText(ev.data.message?.content), at: ev.time });
    } else if (ev.type === 'assistant/chunk') {
      const key = `${ev.data?.turn}:${ev.data?.step}`;
      const chunk = ev.data?.chunk;
      if (!completed.has(key) && (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta')) {
        const item = streaming.get(key) || { seq: ev.seq, role: 'ai', label: 'Harness AI', text: '', at: ev.time };
        item.text += chunk.text || '';
        streaming.set(key, item);
      }
    } else if (ev.type === 'tool/call') {
      rows.push({ seq: ev.seq, role: 'tool', label: 'Tool', text: `${ev.data.name}\n${ev.data.arguments || ''}`, at: ev.time });
    } else if (ev.type === 'tool/result') {
      rows.push({ seq: ev.seq, role: 'tool', label: 'Result', text: contentText(ev.data.message?.content), at: ev.time });
    }
  }
  rows.push(...streaming.values());
  return rows.filter((r) => r.text).sort((a, b) => a.seq - b.seq);
}

function titleCasePreset(v) {
  return String(v || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// The composer row shows the session's real permission preset and agent preset
// rather than invented labels.
function renderComposerMeta() {
  const events = state.history.map((e) => e.event || e);
  const preset = events.find((e) => e.type === 'permission/preset')?.data?.preset;
  $('#permMode').textContent = preset ? titleCasePreset(preset) : 'Standard';
  const session = state.sessions.find((x) => x.sessionId === state.sessionId);
  $('#presetLabel').textContent = titleCasePreset(session?.agentPreset || 'standard');
}

function renderChat() {
  renderComposerMeta();
  const stream = $('#chatStream');
  const rows = transcriptRows(state.history);
  if (!rows.length) {
    stream.innerHTML = `
      <div class="chat-empty">
        <span class="eyebrow">Local agent workspace</span>
        <h2>What should Harness work on?</h2>
        <p>Messages, tool activity, and run state stay in this window.</p>
      </div>`;
    return;
  }
  stream.innerHTML = rows.map((r) => `
    <article class="msg ${esc(r.role)}">
      <div class="msg-avatar ${r.role === 'you' ? 'you' : 'ai'}">${r.role === 'you' ? 'U' : 'H'}</div>
      <div>
        <div class="msg-head"><strong>${esc(r.label)}</strong><time>${esc(clockTime(r.at))}</time></div>
        <div class="msg-body">${esc(r.text)}</div>
      </div>
    </article>`).join('');
  stream.scrollTop = stream.scrollHeight;
}

function renderModels(models) {
  state.sessionModels = models;
  const sel = $('#modelSelect');
  const options = (models.groups || []).flatMap((g) => (g.models || []).map((m) => ({ provider: g.id, providerLabel: g.name || g.displayName || g.id, ...m })));
  if (!options.length) { sel.innerHTML = '<option>Auto</option>'; sel.disabled = true; return; }
  sel.innerHTML = options.map((m) => {
    const on = m.provider === models.current?.provider && m.id === models.current?.model;
    return `<option value="${esc(`${m.provider}\u0000${m.id}`)}" ${on ? 'selected' : ''}>${esc(`${m.providerLabel} · ${m.name || m.id}`)}</option>`;
  }).join('');
  sel.disabled = !models.routable;
  renderEfforts();
}

function renderEfforts() {
  const effort = $('#effortSelect');
  const [provider, model] = $('#modelSelect').value.split('\u0000');
  const selected = (state.sessionModels?.groups || [])
    .find((group) => group.id === provider)?.models?.find((item) => item.id === model);
  const efforts = selected?.reasoning?.efforts || [];
  effort.classList.toggle('hidden', !efforts.length);
  effort.disabled = !efforts.length || !state.sessionModels?.routable;
  if (!efforts.length) { effort.innerHTML = ''; return; }
  effort.innerHTML = efforts.map((item) => {
    const on = item.id === state.sessionModels?.current?.reasoningEffort;
    return `<option value="${esc(item.id)}" ${on ? 'selected' : ''}>${esc(item.name || item.id)}</option>`;
  }).join('');
  if (!state.sessionModels?.current?.reasoningEffort && selected?.reasoning?.defaultEffort) {
    effort.value = selected.reasoning.defaultEffort;
  }
}

async function sendPrompt() {
  const input = $('#promptInput');
  const text = input.value.trim();
  if (!text) return;
  const original = input.value;
  $('#sendPrompt').disabled = true;
  try {
    if (!await ensureConnected()) return;
    let sessionId = state.sessionId;
    if (!sessionId) {
      const created = await window.desktop.createSession();
      sessionId = created.sessionId;
      await refreshWork({ selectFirst: false });
    }
    await window.desktop.promptSession(sessionId, text);
    if (input.value === original) { input.value = ''; autoGrow(input); }
    state.running = true;
    clearTimeout(historyTimer);
    historyTimer = setTimeout(() => void selectSession(sessionId), 400);
  } catch (error) {
    showConnection(`Message was not sent: ${error.message}`, 'error');
  } finally {
    $('#sendPrompt').disabled = false;
  }
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
}

/* ── editor ─────────────────────────────────────────────────────────────── */
function openTab(name, body, lang = 'Markdown') {
  let tab = state.tabs.find((t) => t.name === name);
  if (!tab) { tab = { name, body, lang }; state.tabs.push(tab); }
  state.activeTab = tab;
  renderTabs();
}
function renderTabs() {
  $('#editorTabs').innerHTML = state.tabs.map((t) => `
    <button class="tab ${t === state.activeTab ? 'active' : ''}" data-tab="${esc(t.name)}">
      <span class="badge-type">${esc((t.lang || 'TXT').slice(0, 4).toUpperCase())}</span>
      <span>${esc(t.name)}</span>
      <span class="x" data-close="${esc(t.name)}">✕</span>
    </button>`).join('');
  const area = $('#editorArea');
  area.value = state.activeTab?.body || '';
  area.placeholder = state.activeTab
    ? ''
    : 'Open a workspace file above, or press + for a new buffer.';
  $('#editorLang').textContent = state.activeTab?.lang || 'Plain text';
  updateEditorStatus();
}
function updateEditorStatus() {
  const area = $('#editorArea');
  const words = area.value.trim() ? area.value.trim().split(/\s+/).length : 0;
  $('#editorWords').textContent = `${words} word${words === 1 ? '' : 's'}`;
  const upto = area.value.slice(0, area.selectionStart || 0).split('\n');
  $('#editorCaret').textContent = `Ln ${upto.length}, Col ${(upto[upto.length - 1] || '').length + 1}`;
  if (state.activeTab) state.activeTab.body = area.value;
}

/* ── editor commands ────────────────────────────────────────────────────── */
const WRAPPERS = { bold: '**', italic: '*', code: '`' };
const PREFIXES = { h1: '# ', h2: '## ', h3: '### ', ul: '- ', ol: '1. ' };

/** Apply a formatting command to the selection, keeping it selected afterwards. */
function applyEditorCommand(cmd) {
  const area = $('#editorArea');
  const start = area.selectionStart;
  const end = area.selectionEnd;
  const value = area.value;
  const selected = value.slice(start, end);

  if (cmd === 'undo') { document.execCommand('undo'); return; }
  if (cmd === 'redo') { document.execCommand('redo'); return; }
  if (cmd === 'expand') { applyPaneState({ viewer: false }, true); return; }
  if (cmd === 'more') { toast('Markdown is written directly — the toolbar covers the common marks.'); return; }

  if (WRAPPERS[cmd]) {
    const mark = WRAPPERS[cmd];
    // Toggle the mark off when it already wraps the selection.
    const before = value.slice(Math.max(0, start - mark.length), start);
    const after = value.slice(end, end + mark.length);
    if (before === mark && after === mark) {
      area.value = value.slice(0, start - mark.length) + selected + value.slice(end + mark.length);
      area.setSelectionRange(start - mark.length, end - mark.length);
    } else {
      const body = selected || 'text';
      area.value = value.slice(0, start) + mark + body + mark + value.slice(end);
      area.setSelectionRange(start + mark.length, start + mark.length + body.length);
    }
  } else if (PREFIXES[cmd]) {
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const nextBreak = value.indexOf('\n', end);
    const lineEnd = nextBreak === -1 ? value.length : nextBreak;
    const lines = value.slice(lineStart, lineEnd).split('\n');
    const prefix = PREFIXES[cmd];
    const allPrefixed = lines.every((line) => line.startsWith(prefix));
    const next = lines.map((line, index) => {
      const stripped = line.replace(/^(#{1,6} |- |\d+\. )/, '');
      if (allPrefixed) return stripped;
      return (cmd === 'ol' ? (index + 1) + '. ' : prefix) + stripped;
    }).join('\n');
    area.value = value.slice(0, lineStart) + next + value.slice(lineEnd);
    area.setSelectionRange(lineStart, lineStart + next.length);
  } else if (cmd === 'link') {
    const label = selected || 'text';
    const inserted = '[' + label + '](url)';
    area.value = value.slice(0, start) + inserted + value.slice(end);
    area.setSelectionRange(start + label.length + 3, start + label.length + 6);
  } else if (cmd === 'table') {
    const table = '\n| Column | Column |\n| --- | --- |\n|  |  |\n';
    area.value = value.slice(0, start) + table + value.slice(end);
    area.setSelectionRange(start + table.length, start + table.length);
  } else {
    return;
  }

  area.focus();
  updateEditorStatus();
  markDirty();
}

function markDirty() {
  if (state.activeTab) state.activeTab.dirty = true;
  const dot = $('#editorSaved');
  dot.textContent = '●';
  dot.title = 'Unsaved changes';
  dot.style.color = 'var(--amber)';
}
function markSaved() {
  if (state.activeTab) state.activeTab.dirty = false;
  const dot = $('#editorSaved');
  dot.textContent = '✓';
  dot.title = 'Saved';
  dot.style.color = 'var(--green)';
}

async function refreshWorkspaceFiles() {
  try {
    const result = await window.desktop.listWorkspaceFiles();
    state.files = result.items || [];
  } catch { state.files = []; }
  const select = $('#openFile');
  select.innerHTML = '<option value="">Open file…</option>' + state.files
    .map((f) => '<option value="' + esc(f.path) + '">' + esc(f.relative) + '</option>').join('');
}

async function openWorkspaceFile(target) {
  const file = state.files.find((f) => f.path === target);
  if (!file) return;
  try {
    const read = await window.desktop.readWorkspaceFile(target);
    const lang = file.name.endsWith('.md') ? 'Markdown' : file.name.split('.').pop().toUpperCase();
    let tab = state.tabs.find((t) => t.path === target);
    if (!tab) { tab = { name: file.relative, path: target, body: read.text, lang }; state.tabs.push(tab); }
    else tab.body = read.text;
    state.activeTab = tab;
    renderTabs();
    markSaved();
  } catch (error) { toast(error.message); }
}

async function saveActiveTab() {
  const tab = state.activeTab;
  if (!tab) return;
  if (!tab.path) { toast('This buffer has no file yet — open a workspace file to save into it.'); return; }
  try {
    await window.desktop.saveWorkspaceFile(tab.path, $('#editorArea').value);
    markSaved();
    toast('Saved ' + tab.name);
  } catch (error) { toast(error.message); }
}

/* ── artifact viewers ───────────────────────────────────────────────────── */
function renderViewers() {
  const col = $('#viewerCol');
  const work = document.querySelector('.work-body');
  // An empty artifact column should not park 440px of nothing next to the main
  // surface. Give the space back unless the user opened the panels on purpose.
  if (work && !state.viewers.length && !state.viewerExplicit) {
    work.classList.add('hide-viewer');
    $('#togglePanels').classList.remove('on');
    $('#togglePanels').setAttribute('aria-pressed', 'false');
  }
  if (!state.viewers.length) {
    col.innerHTML = '<div class="inline-state">No artifact open.<br>Open one from a run to preview it here.</div>';
    return;
  }
  col.innerHTML = state.viewers.map((v, i) => {
    const head = `
      <div class="viewer-head">
        <strong>${esc(v.title)}</strong>
        <span class="badge-type">${esc(v.kind)}</span>
        ${v.path ? `<button class="ghost-icon" data-viewer-reveal="${i}" title="Show in folder" aria-label="Show in folder">↗</button>` : ''}
        <button class="ghost-icon" data-viewer-expand="${i}" title="${v.expanded ? 'Collapse' : 'Expand'}" aria-label="Expand">⤢</button>
        <button class="ghost-icon" data-close-viewer="${i}" title="Close" aria-label="Close">✕</button>
      </div>`;
    return `<section class="viewer${v.expanded ? ' expanded' : ''}">${head}<div class="viewer-body md">${v.html || esc(v.body || '')}</div></section>`;
  }).join('');
}

/** Open a text artifact in the right-hand panel and make sure it is visible. */
function openViewer({ title, kind, body, truncated, path }) {
  state.viewers = state.viewers.filter((v) => v.title !== title);
  state.viewers.unshift({
    title,
    kind: kind === 'MD' ? 'MD' : 'TXT',
    body: truncated ? `… showing the last part of this file …\n\n${body}` : body,
    path,
  });
  state.viewers = state.viewers.slice(0, 4);
  state.viewerExplicit = true;
  applyPaneState({ viewer: true }, true);
  renderViewers();
  showView('work');
}

/* ── plugins ────────────────────────────────────────────────────────────── */
function setPipeline(stage, failed = false) {
  const order = ['receive', 'validate', 'compat', 'stage', 'build', 'activate'];
  const at = order.indexOf(stage);
  $$('#pipeline li').forEach((li, i) => {
    li.classList.remove('done', 'active', 'failed');
    if (at === -1) return;
    if (i < at) li.classList.add('done');
    else if (i === at) li.classList.add(failed ? 'failed' : 'active');
  });
}

async function refreshPlugins() {
  let data;
  try {
    data = await window.desktop.listPlugins();
  } catch (error) {
    $('#pluginList').innerHTML = '<div class="inline-state error-text">Could not read plugin state: ' + esc(error.message) + '</div>';
    return;
  }
  state.plugins = data;

  const installed = data.installed || [];
  $('#countPlugins').textContent = String(installed.length);

  // "All" adds plugins that were staged but are not currently mounted, so a
  // disabled one can be switched back on without re-adding the archive.
  const rows = installed.map((p) => ({ ...p, active: true }));
  if (state.showAllPlugins) {
    for (const candidate of data.candidates || []) {
      if (!candidate.name || rows.some((r) => r.name === candidate.name)) continue;
      rows.push({
        name: candidate.name,
        version: candidate.version,
        path: candidate.path,
        active: false,
        candidateId: candidate.id,
        description: candidate.description,
        permissions: candidate.permissions,
      });
    }
  }
  state.pluginRows = rows;

  const term = ($('#pluginSearch').value || '').toLowerCase();
  const withHistory = new Set((data.history || []).map((h) => h.plugin));
  const shown = rows
    .filter((p) => !term || p.name.toLowerCase().includes(term))
    .filter((p) => !state.pluginFilterActive || withHistory.has(p.name));

  $('#pluginListTitle').innerHTML = (state.showAllPlugins ? 'All plugins ' : 'Active plugins ')
    + '<span id="installedCount" class="count">(' + rows.length + ')</span>';
  $('#seeAllPlugins').textContent = state.showAllPlugins ? 'Show active' : 'See all';
  $('#pluginFootCount').textContent = shown.length === rows.length
    ? rows.length + ' plugin' + (rows.length === 1 ? '' : 's')
    : shown.length + ' of ' + rows.length + ' plugins';

  if (!shown.length) {
    $('#pluginList').innerHTML = rows.length
      ? '<div class="inline-state">No plugins match that search.</div>'
      : '<div class="inline-state">No plugins installed yet.<br>Drop a ZIP on the left to add one.</div>';
    return;
  }

  $('#pluginList').innerHTML = shown.map((p) => 
    '<div class="plugin-row ' + (p.active ? '' : 'inactive') + '">'
    + '<button class="plugin-open" data-plugin="' + esc(p.name) + '" title="Open plugin details">'
    + '<span class="plugin-icon"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2v3H3v6h3v3h4v-3h3V5h-3V2z"/></svg></span>'
    + '<span><strong>' + esc(p.name) + '</strong><small>v' + esc(p.version || '—') + '</small></span>'
    + '<span class="pill ' + (p.active ? 'on' : 'off') + '">' + (p.active ? 'Active' : 'Inactive') + '</span>'
    + '</button>'
    + '<button class="toggle ' + (p.active ? 'on' : '') + '" data-toggle-plugin="' + esc(p.name) + '"'
    + ' role="switch" aria-checked="' + (p.active ? 'true' : 'false') + '"'
    + ' aria-label="' + (p.active ? 'Deactivate ' : 'Activate ') + esc(p.name) + '"></button>'
    + '</div>').join('');
}

/** Plugin details live in a sheet so the page keeps to two panels. */
function openPluginSheet(name) {
  const plugin = (state.pluginRows || []).find((p) => p.name === name);
  if (!plugin) return;
  const history = (state.plugins.history || []).filter((h) => h.plugin === name);
  const permissions = plugin.permissions && plugin.permissions.length ? plugin.permissions : [];

  $('#pluginSheetBody').innerHTML = 
    '<div class="sheet-head">'
    + '<span class="plugin-icon"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2v3H3v6h3v3h4v-3h3V5h-3V2z"/></svg></span>'
    + '<div style="flex:1;min-width:0"><h2>' + esc(plugin.name) + '</h2>'
    + '<small>v' + esc(plugin.version || '—') + (plugin.activatedAt ? ' · installed ' + esc(new Date(plugin.activatedAt).toLocaleString()) : '') + '</small></div>'
    + '<span class="pill ' + (plugin.active ? 'on' : 'off') + '">' + (plugin.active ? 'Active' : 'Inactive') + '</span>'
    + '</div>'
    + '<p class="desc">' + esc(plugin.description
        || (plugin.manifestMissing ? 'This plugin\u2019s package.json could not be read.' : 'No description in package.json.')) + '</p>'
    + '<dl>'
    + '<div class="meta-row"><dt>Plugin ID</dt><dd class="mono">' + esc(plugin.name) + '</dd></div>'
    + '<div class="meta-row"><dt>Version</dt><dd class="mono">' + esc(plugin.version || '—') + '</dd></div>'
    + '<div class="meta-row"><dt>Engine</dt><dd>DSH ' + esc(state.status?.dshVersion || '—') + '</dd></div>'
    + (plugin.author ? '<div class="meta-row"><dt>Author</dt><dd>' + esc(plugin.author) + '</dd></div>' : '')
    + (plugin.license ? '<div class="meta-row"><dt>License</dt><dd>' + esc(plugin.license) + '</dd></div>' : '')
    + (plugin.patch ? '<div class="meta-row"><dt>Bundle patch</dt><dd class="mono">' + esc(plugin.patch) + '</dd></div>' : '')
    + '<div class="meta-row"><dt>Build target</dt><dd class="mono">' + esc(state.status?.platform || '—') + '</dd></div>'
    + (plugin.path ? '<div class="meta-row"><dt>Managed path</dt><dd class="mono" title="' + esc(plugin.path) + '">' + esc(baseName(plugin.path)) + '</dd></div>' : '')
    + '</dl>'
    + '<div class="sheet-section"><h3>Permissions</h3>'
    + (permissions.length
        ? permissions.map((p) => '<div class="perm-row"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14"/><path d="m5 8 2 2 4-4"/></svg>' + esc(p) + '</div>').join('')
        : '<div class="inline-state" style="padding:4px 0;text-align:left">No extra permissions declared.</div>')
    + '</div>'
    + '<div class="sheet-section"><h3>Restore points</h3>'
    + (history.length
        ? history.map((h) => '<div class="activity-row"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2h7l3 3v9H3z"/></svg><span>' + esc(h.type === 'install' ? 'Activated v' + esc(h.version || '?') : h.type === 'restore-core' ? 'Restored core state' : 'Disabled') + '</span><time>' + esc(new Date(h.createdAt).toLocaleString()) + '</time></div>').join('')
        : '<div class="inline-state" style="padding:4px 0;text-align:left">No restore points yet.</div>')
    + '</div>'
    + '<div class="sheet-foot">'
    + (history.length ? '<button class="btn ghost" data-sheet="rollback">Roll back</button>' : '')
    + '<button class="btn danger" data-sheet="uninstall">Uninstall plugin</button>'
    + '</div>';

  state.sheetPlugin = name;
  $('#pluginOverlay').classList.remove('hidden');
}
async function receivePluginZip() {
  setPipeline('receive');
  try {
    const candidate = await window.desktop.receivePlugin();
    if (!candidate) { setPipeline(null); return; }
    state.candidate = candidate;
    if (candidate.status === 'invalid') {
      setPipeline('validate', true);
      renderCandidate();
      toast(`Rejected: ${(candidate.validation?.errors || ['invalid plugin']).join('; ')}`);
      return;
    }
    setPipeline('build');
    renderCandidate();
    toast(`${candidate.name} v${candidate.version} staged and checked. Activate to apply.`);
    await refreshPlugins();
  } catch (error) {
    setPipeline('build', true);
    toast(`Plugin check failed: ${error.message}`);
  }
}

/* ── artifacts / skills views ───────────────────────────────────────────── */
function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return `${(v / 1048576).toFixed(1)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} B`;
}

const ARTIFACT_ICON = {
  BUILD: 'M6 2v3H3v6h3v3h4v-3h3V5h-3V2z',
  SNAP: 'M3 2h7l3 3v9H3z',
  ZIP: 'M3 2h10v12H3zM8 2v3M8 7v2',
  LOG: 'M3 2h10v12H3zM5.5 5.5h5M5.5 8h5M5.5 10.5h3',
};

async function renderArtifactsView() {
  const list = $('#artifactList');
  let data;
  try {
    data = await window.desktop.listArtifacts();
  } catch (error) {
    list.innerHTML = `<div class="empty-block error-text">Could not read managed storage: ${esc(error.message)}</div>`;
    return;
  }
  state.artifacts = data.items || [];
  $('#countArtifacts').textContent = String(state.artifacts.length);

  const term = ($('#artifactSearch')?.value || '').toLowerCase();
  const shown = state.artifacts.filter((a) => !term || a.name.toLowerCase().includes(term));
  $('#artifactCount').textContent = term
    ? `${shown.length} of ${state.artifacts.length}`
    : `${state.artifacts.length} item${state.artifacts.length === 1 ? '' : 's'}`;

  if (!shown.length) {
    list.innerHTML = state.artifacts.length
      ? '<div class="empty-block"><strong>Nothing matches that search</strong></div>'
      : `<div class="empty-block"><strong>No artifacts yet</strong>
           <p>Harness Desktop records what it manages here: staged plugin builds, profile restore points,
           the archives you hand it, and the app log. Install a plugin and they will appear.</p></div>`;
    return;
  }

  const groups = [...new Set(shown.map((a) => a.group))];
  list.innerHTML = groups.map((group) => `
    <section class="file-group">
      <h2>${esc(group)}</h2>
      <div class="file-rows">
        ${shown.filter((a) => a.group === group).map((a) => `
          <button class="file-row" data-artifact="${esc(a.id)}">
            <span class="plugin-icon"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="${ARTIFACT_ICON[a.kind] || ARTIFACT_ICON.LOG}"/></svg></span>
            <span>
              <strong>${esc(a.name)}</strong>
              <small class="${a.missing ? 'missing' : ''}">${a.missing ? 'File no longer on disk · ' : ''}${esc(fmtBytes(a.bytes))}${a.files ? ` · ${a.files} files` : ''}${a.modifiedAt ? ` · ${new Date(a.modifiedAt).toLocaleString()}` : ''}</small>
            </span>
            <span class="badge-type">${esc(a.kind)}</span>
            ${a.readable ? '<span class="row-btn" data-open="' + esc(a.id) + '">Open</span>' : ''}
            <span class="row-btn" data-reveal="${esc(a.id)}">Reveal</span>
          </button>`).join('')}
      </div>
    </section>`).join('');
}
async function renderSkillsView() {
  const list = $('#skillList');
  let data;
  try {
    data = await window.desktop.listSkills();
  } catch (error) {
    list.innerHTML = `<div class="empty-block error-text">Could not read skill folders: ${esc(error.message)}</div>`;
    return;
  }
  state.skills = data.items || [];
  state.skillRoots = data.roots || [];
  $('#countSkills').textContent = String(state.skills.length);

  const term = ($('#skillSearch')?.value || '').toLowerCase();
  const shown = state.skills.filter((k) => !term
    || k.name.toLowerCase().includes(term) || k.description.toLowerCase().includes(term));
  $('#skillCount').textContent = term
    ? `${shown.length} of ${state.skills.length}`
    : `${state.skills.length} skill${state.skills.length === 1 ? '' : 's'}`;

  $('#skillRoots').innerHTML = state.skillRoots.length
    ? `Scanned: ${state.skillRoots.map((r) => `<b>${esc(r)}</b>`).join('<br>')}`
    : '';

  if (!shown.length) {
    list.innerHTML = state.skills.length
      ? '<div class="empty-block"><strong>Nothing matches that search</strong></div>'
      : `<div class="empty-block"><strong>No skills installed</strong>
           <p>The engine loads a skill from any folder containing a <code>SKILL.md</code> inside
           <code>.dsh/skills</code> or <code>.agents/skills</code> in your workspace, or <code>skills</code>
           in your Harness home. Add one and it appears here.</p></div>`;
    return;
  }

  list.innerHTML = shown.map((k) => `
    <article class="skill-card">
      <div class="skill-top">
        <span class="plugin-icon"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 9.7 6h4.6l-3.7 2.7 1.4 4.5L8 10.4l-4 2.8 1.4-4.5L1.7 6h4.6z"/></svg></span>
        <strong title="${esc(k.name)}">${esc(k.name)}</strong>
        <span class="pill">${esc(k.source)}</span>
      </div>
      <p>${esc(k.description || 'No description in the SKILL.md frontmatter.')}</p>
      <span class="path" title="${esc(k.dir)}">${esc(k.dir)}</span>
      <div class="skill-actions">
        <span class="row-btn" data-skill-open="${esc(k.id)}">Open SKILL.md</span>
        <span class="row-btn" data-skill-reveal="${esc(k.id)}">Reveal</span>
      </div>
    </article>`).join('');
}

/* ── settings ───────────────────────────────────────────────────────────── */
/** Stable colour per provider id, so the same route always looks the same. */
function providerTint(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${hash} 45% 42%)`;
}

async function refreshSettings() {
  let provider = { available: false };
  try { provider = await window.desktop.getProvider(); } catch {}
  state.provider = provider;

  // Every row below is keyed off routes the engine reports; the catalogues only
  // decide grouping and prefill.
  let routes = { providers: [], groups: [] };
  try { routes = await window.desktop.listProviders(); } catch {}
  state.routes = routes;
  try {
    const authorization = await window.desktop.listAuthorizations();
    state.authorizations = (authorization.items || []).filter((item) =>
      (item.methods || []).some((method) => method.id === 'oauth'));
  } catch { state.authorizations = []; }

  const byId = new Map((routes.providers || []).map((p) => [p.provider, p]));
  const modelsFor = new Map((routes.groups || []).map((g) => [g.id, g.models || []]));
  const offline = !state.status?.healthy;

  let credentials = { items: [] };
  try { credentials = await window.desktop.listCredentials(); } catch {}
  const credByRef = new Map((credentials.items || []).map((c) => [c.ref, c]));

  const statusOf = (entry) => {
    const route = byId.get(entry.id);
    if (!route) return { text: offline ? 'Not connected' : 'Not available', dot: '' };
    if (route.active) return { text: 'Connected', dot: 'ok' };
    return { text: 'Not configured', dot: 'warn' };
  };

  // ── default providers ──
  $('#providerRows').innerHTML = DEFAULT_PROVIDERS.map((entry) => {
    const status = statusOf(entry);
    const models = modelsFor.get(entry.id) || [];
    return `<tr>
      <td class="w-chev"><button class="chev" data-expand="${esc(entry.id)}" aria-label="Show models">${state.expandedProvider === entry.id ? '⌄' : '›'}</button></td>
      <td><div class="prov-cell"><span class="prov-logo" style="background:${providerTint(entry.id)}">${esc(entry.letter)}</span>${esc(entry.label)}</div></td>
      <td><div class="status-cell"><span class="sdot ${status.dot}"></span>${esc(status.text)}</div></td>
      <td>API key</td>
      <td>${models.length ? models.length : '—'}</td>
      <td class="w-act"><div class="row-actions">
        <button class="btn sm" data-provider="${esc(entry.id)}">Manage</button>
        <button class="toggle ${byId.get(entry.id)?.active ? 'on' : ''}" data-toggle="${esc(entry.id)}" role="switch" aria-checked="${Boolean(byId.get(entry.id)?.active)}" aria-label="Toggle ${esc(entry.label)}"></button>
      </div></td>
    </tr>`;
  }).join('');

  if (state.expandedProvider) {
    const row = $('#providerRows').querySelector(`[data-expand="${state.expandedProvider}"]`)?.closest('tr');
    if (row) {
      const models = modelsFor.get(state.expandedProvider) || [];
      const detail = document.createElement('tr');
      detail.className = 'expanded-row';
      detail.innerHTML = `<td></td><td colspan="5">${models.length
        ? `<div class="model-chips">${models.map((m) => `<span class="pill">${esc(m.name || m.id)}</span>`).join('')}</div>`
        : '<span class="muted-note">Connect this provider to list its models.</span>'}</td>`;
      row.after(detail);
    }
  }

  // ── OAuth accounts ──
  $('#oauthCards').innerHTML = state.authorizations.length ? state.authorizations.map((authorization) => {
    const id = String(authorization.key).split('/').pop();
    const entry = { id, label: authorization.label, letter: authorization.label.slice(0, 1).toUpperCase() };
    const connected = state.authorizedKeys.has(authorization.key);
    return `<div class="oauth-card">
      <div class="oauth-top">
        <span class="prov-logo" style="background:${providerTint(entry.id)}">${esc(entry.letter)}</span>
        <div style="flex:1;min-width:0">
          <strong>${esc(entry.label)}</strong>
          <small>${connected ? 'Account route is available' : 'No account connected'}</small>
        </div>
        <span class="pill ${connected ? 'on' : 'off'}">${connected ? 'Connected' : 'Available'}</span>
      </div>
      <div class="oauth-foot">
        <span class="muted-note">${esc((authorization.methods || []).map((method) => method.label).join(' · '))}</span>
        <button class="btn ghost sm" data-auth-key="${esc(authorization.key)}" data-auth-method="${esc(authorization.methods?.find((method) => method.id === 'oauth')?.id || authorization.methods?.[0]?.id || '')}" ${authorization.inFlight ? 'disabled' : ''}>${authorization.inFlight ? 'Connecting…' : connected ? 'Reconnect' : 'Connect'}</button>
      </div>
    </div>`;
  }).join('') : '<div class="inline-state">No OAuth-capable providers are available in this runtime.</div>';

  // ── custom / private providers ──
  const oauthIds = new Set(state.authorizations.map((item) => String(item.key).split('/').pop()));
  const custom = (routes.providers || []).filter((p) => !CURATED.has(p.provider) && !oauthIds.has(p.provider) && p.active);
  $('#customRows').innerHTML = custom.length
    ? custom.map((p) => `<tr>
        <td><div class="prov-cell"><span class="prov-logo" style="background:${providerTint(p.provider)}">${esc(p.provider.slice(0, 1).toUpperCase())}</span>${esc(p.displayName || p.provider)}</div></td>
        <td class="refresh-cell">${esc(p.baseURL || p.settingsNs || '—')}</td>
        <td>API key</td>
        <td>${esc((modelsFor.get(p.provider) || [])[0]?.id || '—')}</td>
        <td><div class="status-cell"><span class="sdot ok"></span>Active</div></td>
        <td class="w-act"><div class="row-actions">
          <button class="btn sm" data-provider="${esc(p.provider)}">Manage</button>
          <button class="btn ghost sm" data-remove-provider="${esc(p.provider)}">Remove</button>
        </div></td>
      </tr>`).join('')
    : `<tr><td colspan="6"><div class="inline-state">${offline ? 'Connect from chat or retry the connection to list providers.' : 'No custom providers yet. Use Add provider for a self-hosted or private endpoint.'}</div></td></tr>`;

  // Accounts: real credential refs discovered from the provider settings.
  try {
    const credentials = await window.desktop.listCredentials();
    $('#accountsPane').innerHTML = (credentials.items || []).length
      ? credentials.items.map((c) => `<div class="field-row">
          <div><strong>${esc(c.ref)}</strong><small>Used by ${esc(c.owner)}${c.source ? ' · stored in ' + esc(c.source) : ''}</small></div>
          <span class="pill ${c.configured ? 'on' : 'off'}">${c.configured ? 'Configured' : 'Not set'}</span>
          ${c.configured && c.writable ? `<button class="btn ghost sm" data-clear-credential="${esc(c.ref)}">Clear</button>` : ''}
        </div>`).join('')
      : '<div class="inline-state">No provider credentials are configured yet. Add one from Models &amp; Providers.</div>';
  } catch { $('#accountsPane').innerHTML = '<div class="inline-state">Connect from chat to read stored credentials.</div>'; }

  // diagnostics
  const ready = Boolean(state.status?.healthy && state.status?.ready);
  $('#diagHealth').textContent = ready ? 'Connected' : state.status?.safeMode ? 'Recovery mode' : 'Not connected';
  $('#diagHealth').className = ready ? 'good-text' : 'error-text';
  $('#diagChecked').textContent = `Last checked: ${new Date().toLocaleTimeString()}`;

  $('#genDshHome').textContent = state.status?.dshHome || '—';

  await refreshLogs();
}

// "Log level" filters by source severity words present in the message, which is
// the only signal the engine gives us without a structured level field.
const LOG_LEVELS = {
  Info: () => true,
  Debug: () => true,
  Warn: (line) => /warn|deprecat|pending|safe mode/i.test(line.message),
  Error: (line) => /error|fail|cannot|refused|stopped \(code [1-9]/i.test(line.message),
};

function renderLogView() {
  const level = $('#logLevel')?.value || 'Info';
  const keep = LOG_LEVELS[level] || LOG_LEVELS.Info;
  const shown = state.logs.filter(keep);
  $('#logCount').textContent = shown.length === state.logs.length
    ? `${shown.length} entries`
    : `${shown.length} of ${state.logs.length} entries`;
  $('#logOutput').textContent = shown.map((i) => `${i.at.slice(11, 19)}  [${i.source}]  ${i.message}`).join('\n');
  $('#logOutput').scrollTop = $('#logOutput').scrollHeight;
}

async function refreshLogs() {
  let items;
  try { items = await window.desktop.getLogs(); }
  catch (error) {
    $('#logCount').textContent = 'unavailable';
    $('#logOutput').textContent = `Could not read the log: ${error.message}`;
    return;
  }
  state.logs = items;
  renderLogView();
  $('#diagRecent').innerHTML = items.slice(-4).reverse().map((i) => `
    <div class="diag-line"><time>${esc(i.at.slice(11, 19))}</time><span>${esc(i.message)}</span></div>`).join('')
    || '<div class="diag-line"><span>No entries yet.</span></div>';
}

function openSettings(pane = 'models') {
  $('#settingsOverlay').classList.remove('hidden');
  selectPane(pane);
  if (pane === 'models') void ensureConnected().then(() => refreshSettings());
  else void refreshSettings();
}
function selectPane(pane) {
  $$('.mnav').forEach((b) => b.classList.toggle('active', b.dataset.pane === pane));
  $$('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === pane));
}

/* ── events ─────────────────────────────────────────────────────────────── */
$$('.rail-item[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
on('#openSettings', 'click', () => openSettings());
on('#closeSettings', 'click', () => $('#settingsOverlay').classList.add('hidden'));
on('#settingsDone', 'click', () => $('#settingsOverlay').classList.add('hidden'));
on('#settingsOverlay', 'click', (e) => { if (e.target.id === 'settingsOverlay') $('#settingsOverlay').classList.add('hidden'); });
$$('.mnav').forEach((b) => b.addEventListener('click', () => selectPane(b.dataset.pane)));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#settingsOverlay').classList.add('hidden'); });

on('#projectList', 'click', async (e) => {
  const btn = e.target.closest('.project');
  if (!btn) return;
  toast(`Use Settings → Workspace to switch folders.`);
});
on('#addProject', 'click', () => void chooseWorkspace());
on('#projectSwitch', 'click', () => void chooseWorkspace());


async function chooseWorkspace() {
  const ws = await window.desktop.chooseWorkspace();
  if (!ws) return;
  state.workspace = ws;
  state.sessionId = null;
  toast(`Using workspace ${baseName(ws.path)}.`);
  await refreshWork();
}

on('#genRelaunch', 'click', () => window.desktop.relaunch());

on('#promptInput', 'input', (e) => {
  autoGrow(e.target);
  if (e.target.value.trim()) void ensureConnected();
});
on('#promptInput', 'keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendPrompt(); }
});
on('#sendPrompt', 'click', () => void sendPrompt());
on('#composerAdd', 'click', () => {
  const tab = state.activeTab;
  if (!tab || !tab.path) {
    toast('Open a workspace file in the editor first — its path is then added as context.');
    return;
  }
  const input = $('#promptInput');
  const at = input.selectionStart ?? input.value.length;
  const reference = (at > 0 && input.value[at - 1] !== ' ' ? ' ' : '') + tab.name + ' ';
  input.value = input.value.slice(0, at) + reference + input.value.slice(at);
  input.setSelectionRange(at + reference.length, at + reference.length);
  input.focus();
  autoGrow(input);
  toast('Added ' + tab.name + ' to the message.');
});
on('#composerTune', 'click', () => $('#modelSelect').focus());
on('#composerTuneMenu', 'click', () => $('#modelSelect').focus());
on('#permMode', 'click', () => toast('Permission preset comes from the session and is set by the engine.'));
on('#modelSelect', 'change', async (e) => {
  const [provider, model] = e.target.value.split('\u0000');
  if (!provider || !state.sessionId) return;
  const groupModel = (state.sessionModels?.groups || []).find((g) => g.id === provider)?.models?.find((m) => m.id === model);
  const reasoningEffort = groupModel?.reasoning?.defaultEffort;
  try {
    await window.desktop.selectSessionModel({ sessionId: state.sessionId, provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) });
    const models = await window.desktop.getSessionModels(state.sessionId);
    renderModels(models);
    toast('Model updated.');
  }
  catch (error) { toast(error.message); }
});
on('#effortSelect', 'change', async (event) => {
  const [provider, model] = $('#modelSelect').value.split('\u0000');
  if (!provider || !model || !state.sessionId) return;
  try {
    await window.desktop.selectSessionModel({ sessionId: state.sessionId, provider, model, reasoningEffort: event.target.value });
    state.sessionModels.current = { provider, model, reasoningEffort: event.target.value };
    toast('Reasoning effort updated.');
  } catch (error) { toast(error.message); }
});

$$('.fb[data-cmd]').forEach((button) =>
  button.addEventListener('click', () => applyEditorCommand(button.dataset.cmd)));
on('#openFile', 'change', (event) => {
  if (event.target.value) void openWorkspaceFile(event.target.value);
});
on('#saveFile', 'click', () => void saveActiveTab());
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    void saveActiveTab();
  }
});
on('#editorArea', 'input', markDirty);
on('#editorArea', 'input', updateEditorStatus);
on('#editorArea', 'keyup', updateEditorStatus);
on('#editorArea', 'click', updateEditorStatus);
on('#editorTabs', 'click', (e) => {
  const close = e.target.dataset.close;
  if (close) {
    state.tabs = state.tabs.filter((t) => t.name !== close);
    if (state.activeTab?.name === close) state.activeTab = state.tabs[0] || null;
    renderTabs();
    return;
  }
  const tab = e.target.closest('.tab');
  if (tab) { state.activeTab = state.tabs.find((t) => t.name === tab.dataset.tab) || null; renderTabs(); }
});
on('#newTab', 'click', () => openTab(`untitled-${state.tabs.length + 1}.md`, '', 'Markdown'));

on('#viewerCol', 'click', (e) => {
  const revealIndex = e.target.dataset.viewerReveal;
  if (revealIndex !== undefined) {
    const viewer = state.viewers[Number(revealIndex)];
    if (viewer?.path) window.desktop.revealFile(viewer.path).catch((error) => toast(error.message));
    return;
  }
  const expandIndex = e.target.dataset.viewerExpand;
  if (expandIndex !== undefined) {
    const viewer = state.viewers[Number(expandIndex)];
    if (viewer) { viewer.expanded = !viewer.expanded; renderViewers(); }
    return;
  }
  const close = e.target.dataset.closeViewer;
  if (close !== undefined) { state.viewers.splice(Number(close), 1); renderViewers(); return; }
  const zoom = e.target.dataset.zoom;
  if (zoom) {
    const v = state.viewers[Number(e.target.dataset.viewer)];
    if (!v) return;
    if (zoom === '+') v.zoom = Math.min(400, (v.zoom || 42) + 10);
    if (zoom === '-') v.zoom = Math.max(10, (v.zoom || 42) - 10);
    if (zoom === 'fit') v.zoom = 42;
    if (zoom === '100') v.zoom = 100;
    renderViewers();
  }
});

on('#dropzone', 'click', () => void receivePluginZip());
['dragenter', 'dragover'].forEach((ev) => on('#dropzone', ev, (e) => { e.preventDefault(); $('#dropzone').classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => on('#dropzone', ev, (e) => { e.preventDefault(); $('#dropzone').classList.remove('drag'); }));
on('#dropzone', 'drop', () => toast('Use the picker to choose a plugin ZIP — dropped paths are not exposed to this window.'));
on('#refreshPlugins', 'click', () => void refreshPlugins());
on('#pluginSearch', 'input', () => void refreshPlugins());
on('#pluginList', 'click', async (event) => {
  const toggle = event.target.closest('[data-toggle-plugin]');
  if (toggle) {
    const name = toggle.dataset.togglePlugin;
    const plugin = (state.pluginRows || []).find((p) => p.name === name);
    if (!plugin) return;
    toggle.disabled = true;
    try {
      if (plugin.active) {
        await window.desktop.disablePlugin(name);
        toast(name + ' deactivated. Restarting…');
      } else if (plugin.candidateId) {
        await window.desktop.activatePlugin(plugin.candidateId);
        toast(name + ' activated. Restarting…');
      } else {
        toast('That version is no longer staged — add the plugin ZIP again to reactivate it.');
        toggle.disabled = false;
        return;
      }
      setTimeout(() => window.desktop.relaunch(), 700);
    } catch (error) {
      toast(error.message);
      toggle.disabled = false;
      await refreshPlugins();
    }
    return;
  }
  const open = event.target.closest('[data-plugin]');
  if (open) openPluginSheet(open.dataset.plugin);
});

on('#seeAllPlugins', 'click', () => {
  state.showAllPlugins = !state.showAllPlugins;
  void refreshPlugins();
});

on('#closePluginSheet', 'click', () => $('#pluginOverlay').classList.add('hidden'));
on('#pluginOverlay', 'click', (event) => {
  if (event.target.id === 'pluginOverlay') $('#pluginOverlay').classList.add('hidden');
});
on('#pluginSheetBody', 'click', async (event) => {
  const action = event.target.closest('[data-sheet]')?.dataset.sheet;
  if (!action) return;
  const name = state.sheetPlugin;
  try {
    if (action === 'uninstall') {
      await window.desktop.disablePlugin(name);
      toast(name + ' uninstalled. Restarting…');
    } else {
      await window.desktop.rollbackPlugin();
      toast('Previous profile restored. Restarting…');
    }
    setTimeout(() => window.desktop.relaunch(), 700);
  } catch (error) { toast(error.message); }
});

/* Install actions live in one menu instead of three scattered buttons. */
function togglePluginMenu(open) {
  const menu = $('#pluginMenu');
  const next = open === undefined ? menu.classList.contains('hidden') : open;
  menu.classList.toggle('hidden', !next);
  $('#addPluginMenu').setAttribute('aria-expanded', String(next));
}
on('#addPluginMenu', 'click', (event) => { event.stopPropagation(); togglePluginMenu(); });
on('#pluginMenu', 'click', (event) => {
  const action = event.target.closest('[data-menu]')?.dataset.menu;
  if (!action) return;
  togglePluginMenu(false);
  if (action === 'zip') void receivePluginZip();
  else if (action === 'guide') void savePluginGuide();
  else void saveStarterPlugin();
});
document.addEventListener('click', () => togglePluginMenu(false));

/* install helpers used by the header menu */
async function savePluginGuide() {
  try {
    const saved = await window.desktop.savePluginGuide();
    if (saved) toast('Plugin format guide saved to ' + saved.path);
  } catch (error) { toast(error.message); }
}
async function saveStarterPlugin() {
  try {
    const saved = await window.desktop.saveStarterPlugin();
    if (saved) toast('Starter plugin saved to ' + saved.path + ' — add it back to test the pipeline.');
  } catch (error) { toast(error.message); }
}

/* window controls */
$$('.wc[data-win]').forEach((button) => button.addEventListener('click', async () => {
  const action = button.dataset.win;
  if (action === 'minimize') await window.desktop.minimizeWindow();
  else if (action === 'maximize') await window.desktop.maximizeWindow();
  else await window.desktop.closeWindow();
}));

/* project switching */
on('#projectList', 'click', async (event) => {
  const button = event.target.closest('.project');
  if (!button) return;
  try {
    await window.desktop.setWorkspace(button.dataset.path);
    state.sessionId = null;
    state.viewers = [];
    toast('Switched to ' + baseName(button.dataset.path) + '.');
    await refreshWork();
    await refreshWorkspaceFiles();
    renderViewers();
  } catch (error) { toast(error.message); }
});

/* tasks */
on('#taskSelect', 'change', (event) => {
  if (event.target.value) void selectSession(event.target.value);
});
on('#newTask', 'click', async () => {
  try {
    if (!await ensureConnected()) return;
    const created = await window.desktop.createSession();
    await refreshWork({ selectFirst: false });
    await selectSession(created.sessionId);
    $('#promptInput').focus();
  } catch (error) { toast(error.message); }
});
on('#stopRun', 'click', async () => {
  if (!state.sessionId) return;
  try { await window.desktop.cancelSession(state.sessionId); setRunning(false); toast('Run cancelled.'); }
  catch (error) { toast(error.message); }
});
on('#workMore', 'click', () => void chooseWorkspace());

/* staged candidate */
on('#candidatePanel', 'click', async (event) => {
  const action = event.target.closest('[data-candidate]')?.dataset.candidate;
  if (!action) return;
  if (action === 'dismiss') { state.candidate = null; renderCandidate(); setPipeline(null); return; }
  if (action === 'guide') { void savePluginGuide(); return; }
  const button = event.target;
  button.disabled = true;
  button.textContent = 'Activating safely…';
  try {
    await window.desktop.activatePlugin(state.candidate.id);
    toast('Plugin verified. Restarting the app…');
    setTimeout(() => window.desktop.relaunch(), 700);
  } catch (error) {
    setPipeline('activate', true);
    toast(error.message);
    button.disabled = false;
    button.textContent = 'Activate & restart';
    await refreshPlugins();
  }
});

/* provider configuration */
// Curated shortcuts over routes the engine really declares (llm.providers).
// Every id below appears in that list; the engine validates the rest on save.
const DEFAULT_PROVIDERS = [
  { id: 'openai', label: 'OpenAI', letter: 'O', api: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1', apiKeyRef: 'OPENAI_API_KEY', model: 'gpt-5.1' },
  { id: 'anthropic', label: 'Anthropic', letter: 'A', api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com/v1', apiKeyRef: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-4-5' },
  { id: 'deepseek-official', label: 'DeepSeek', letter: 'D', builtIn: true,
    baseUrl: 'https://api.deepseek.com', apiKeyRef: 'DEEPSEEK_API_KEY' },
  { id: 'google', label: 'Google Gemini', letter: 'G', api: 'openai-completions',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyRef: 'GEMINI_API_KEY', model: 'gemini-2.5-pro' },
  { id: 'openrouter', label: 'OpenRouter', letter: 'R', api: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api/v1', apiKeyRef: 'OPENROUTER_API_KEY', model: 'openai/gpt-5.1' },
];

// Known route ids are kept out of the custom-provider table; the actual OAuth
// catalogue and methods are always read from the running authorization service.
const OAUTH_PROVIDERS = [
  { id: 'openai-codex', label: 'Codex (OpenAI)', letter: 'C', api: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex', apiKeyRef: 'OPENAI_CODEX_AUTH', model: 'gpt-5.1-codex' },
  { id: 'github-copilot', label: 'GitHub Copilot', letter: 'G', api: 'openai-responses',
    baseUrl: 'https://api.githubcopilot.com', apiKeyRef: 'GITHUB_COPILOT_AUTH', model: 'gpt-4.1' },
];

const CURATED = new Set([...DEFAULT_PROVIDERS, ...OAUTH_PROVIDERS].map((p) => p.id));

function openProviderForm(id, preset) {
  const provider = state.provider || {};
  const route = (state.routes?.providers || []).find((p) => p.provider === id);
  const builtIn = id === 'deepseek-official';
  const seed = preset || [...DEFAULT_PROVIDERS, ...OAUTH_PROVIDERS].find((p) => p.id === id) || null;
  const existingModels = (state.routes?.groups || []).find((group) => group.id === id)?.models || [];
  state.editingProvider = id;
  state.discoveredModels = existingModels;
  $('#providerFormTitle').textContent = 'Configure ' + (seed?.label || route?.displayName || id);
  $('#apiBaseUrl').value = builtIn ? (provider.baseUrl || '') : (route?.baseURL || seed?.baseUrl || '');
  const selectedModel = builtIn ? (provider.model || '') : (seed?.model || existingModels[0]?.id || '');
  $('#apiModel').innerHTML = existingModels.length
    ? existingModels.map((model) => `<option value="${esc(model.id)}">${esc(model.name || model.id)}</option>`).join('')
    : '<option value="">Connect to load models</option>';
  if (selectedModel && existingModels.some((model) => model.id === selectedModel)) $('#apiModel').value = selectedModel;
  $('#apiKeyRefRow').classList.toggle('hidden', builtIn);
  $('#apiProtocolRow').classList.toggle('hidden', builtIn);
  $('#apiKeyRow').classList.remove('hidden');
  $('#apiKeyRef').value = builtIn ? '' : (seed?.apiKeyRef || id.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY');
  if (seed?.api) $('#apiProtocol').value = seed.api;
  $('#apiKey').value = '';
  $('#apiResult').textContent = existingModels.length
    ? `${existingModels.length} model${existingModels.length === 1 ? '' : 's'} available.`
    : provider.configured ? 'A key is stored. Refresh models to verify it.' : 'Enter credentials to fetch available models.';
  $('#apiResult').className = 'form-result';
  $('#providerForm').classList.remove('hidden');
  $('#apiBaseUrl').focus();
  if (existingModels.length || (route && !$('#apiKey').value)) void discoverModels();
}
function providerConfig() {
  return {
    provider: state.editingProvider,
    baseUrl: $('#apiBaseUrl').value.trim(),
    apiKey: $('#apiKey').value,
    model: $('#apiModel').value.trim(),
    apiKeyRef: $('#apiKeyRef').value.trim(),
    api: $('#apiProtocol').value,
  };
}
function setDiscoveredModels(models, preferred) {
  state.discoveredModels = models;
  const select = $('#apiModel');
  select.innerHTML = models.map((model) => `<option value="${esc(model.id)}">${esc(model.name || model.id)}</option>`).join('');
  if (preferred && models.some((model) => model.id === preferred)) select.value = preferred;
}
async function discoverModels() {
  const result = $('#apiResult');
  const preferred = $('#apiModel').value;
  result.textContent = 'Connecting and fetching models…';
  result.className = 'form-result';
  try {
    const discovered = await window.desktop.discoverProviderModels(providerConfig());
    setDiscoveredModels(discovered.models || [], preferred);
    result.textContent = `${discovered.models.length} model${discovered.models.length === 1 ? '' : 's'} available.`;
    result.className = 'form-result ok';
    return discovered;
  } catch (error) {
    state.discoveredModels = [];
    result.textContent = error.message;
    result.className = 'form-result bad';
    return null;
  }
}
on('#customRows', 'click', async (event) => {
  const remove = event.target.closest('[data-remove-provider]')?.dataset.removeProvider;
  if (remove) {
    try { await window.desktop.removeProvider(remove); toast(remove + ' removed.'); await refreshSettings(); }
    catch (error) { toast(error.message); }
    return;
  }
  const manage = event.target.closest('[data-provider]');
  if (manage) openProviderForm(manage.dataset.provider);
});

on('#oauthCards', 'click', async (event) => {
  const clear = event.target.closest('[data-clear-credential]')?.dataset.clearCredential;
  if (clear) {
    try { await window.desktop.clearCredential(clear); toast('Signed out of ' + clear + '.'); await refreshSettings(); }
    catch (error) { toast(error.message); }
    return;
  }
  const connect = event.target.closest('[data-auth-key]');
  if (connect) {
    connect.disabled = true;
    connect.textContent = 'Connecting…';
    try {
      const outcome = await window.desktop.beginAuthorization({ key: connect.dataset.authKey, method: connect.dataset.authMethod || undefined });
      if (outcome.status === 'authorized') {
        state.authorizedKeys.add(connect.dataset.authKey);
        toast('Account connected. Models are being refreshed.');
        await refreshSettings();
        if (state.sessionId) renderModels(await window.desktop.getSessionModels(state.sessionId));
      } else toast('Sign-in was cancelled.');
    } catch (error) { toast(`Sign-in failed: ${error.message}`); }
    finally { connect.disabled = false; connect.textContent = 'Connect'; }
  }
});

on('#providerRows', 'click', (event) => {
  const chev = event.target.closest('[data-expand]');
  if (chev) {
    state.expandedProvider = state.expandedProvider === chev.dataset.expand ? null : chev.dataset.expand;
    void refreshSettings();
    return;
  }
  const manage = event.target.closest('[data-provider]');
  if (manage && !manage.disabled) { openProviderForm(manage.dataset.provider); return; }
  const toggle = event.target.closest('[data-toggle]');
  if (!toggle) return;
  const route = (state.routes?.providers || []).find((p) => p.provider === toggle.dataset.toggle);
  if (!route?.settingsNs) { toast('That route has no writable settings namespace.'); return; }
  openProviderForm(toggle.dataset.toggle);
});
on('#cancelProvider', 'click', () => $('#providerForm').classList.add('hidden'));
on('#testApi', 'click', async () => {
  await discoverModels();
});
on('#apiKey', 'change', () => { if ($('#apiBaseUrl').value.trim()) void discoverModels(); });
on('#apiBaseUrl', 'change', () => { if ($('#apiBaseUrl').value.trim()) void discoverModels(); });
on('#apiProtocol', 'change', () => { if ($('#apiBaseUrl').value.trim()) void discoverModels(); });
on('#saveProvider', 'click', async () => {
  const result = $('#apiResult');
  result.textContent = 'Verifying models and saving…';
  result.className = 'form-result';
  try {
    const saved = await window.desktop.saveProvider(providerConfig());
    setDiscoveredModels(saved.models || [], saved.selectedModel);
    result.textContent = `Saved with ${saved.models?.length || 0} available model(s).`;
    result.className = 'form-result ok';
    $('#apiKey').value = '';
    await refreshSettings();
    if (state.sessionId) renderModels(await window.desktop.getSessionModels(state.sessionId));
  } catch (error) { result.textContent = error.message; result.className = 'form-result bad'; }
});

/* diagnostics */
on('#addOauth', 'click', () => {
  const first = state.authorizations.find((item) => !item.inFlight) || state.authorizations[0];
  if (!first) { toast('No OAuth sign-in flows are available.'); return; }
  const button = $(`[data-auth-key="${CSS.escape(first.key)}"]`);
  button?.click();
});

on('#addProviderCustom', 'click', () => {
  const name = prompt('Provider id (lowercase, no spaces):', 'my-provider');
  if (!name) return;
  openProviderForm(name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-'), {
    label: name, baseUrl: '', api: 'openai-completions', model: '',
    apiKeyRef: name.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY',
  });
});

on('#signInOpen', 'click', async () => {
  if (!state.signInUrl) return;
  try { await window.desktop.openSignIn(state.signInUrl); }
  catch (error) { toast(error.message); }
});
on('#authPromptSubmit', 'click', async () => {
  const active = state.authPrompt;
  if (!active) return;
  const answer = active.prompt.kind === 'select' ? $('#authPromptSelect').value : $('#authPromptInput').value;
  try {
    await window.desktop.answerAuthorization({ promptId: active.promptId, answer });
    state.authPrompt = null;
    $('#authPrompt').classList.add('hidden');
  } catch (error) { toast(error.message); }
});
on('#authPromptCancel', 'click', async () => {
  const active = state.authPrompt;
  if (!active) return;
  try { await window.desktop.cancelAuthorization({ key: active.key }); }
  catch (error) { toast(error.message); }
  state.authPrompt = null;
  $('#authPrompt').classList.add('hidden');
});

on('#accountsPane', 'click', async (event) => {
  const ref = event.target.closest('[data-clear-credential]')?.dataset.clearCredential;
  if (!ref) return;
  try {
    await window.desktop.clearCredential(ref);
    toast('Cleared ' + ref + '.');
    await refreshSettings();
  } catch (error) { toast(error.message); }
});

on('#logLevel', 'change', () => renderLogView());
on('#diagRestart', 'click', async () => {
  const button = $('#diagRestart');
  button.disabled = true;
  button.textContent = 'Connecting…';
  try {
    const result = await window.desktop.reconnect();
    toast(result.ok ? 'Connected.' : (result.reason || 'Connection failed. Check the log below.'));
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = 'Retry connection'; await refreshStatus(); await refreshLogs(); }
});
on('#restoreHarness', 'click', async () => {
  const button = $('#restoreHarness');
  button.disabled = true;
  try {
    const result = await window.desktop.restoreHarnessCore();
    if (!result) return;
    toast('Harness restored to its core state. Restarting…');
    setTimeout(() => window.desktop.relaunch(), 900);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});

on('#genSafeInfo', 'click', () => {
  const command = 'Harness Desktop.exe --safe-mode';
  navigator.clipboard?.writeText(command).then(
    () => toast('Copied: ' + command),
    () => toast('Run: ' + command));
});

/* artifacts & skills */
on('#refreshArtifacts', 'click', () => void renderArtifactsView());
on('#artifactSearch', 'input', () => void renderArtifactsView());
on('#refreshSkills', 'click', () => void renderSkillsView());
on('#skillSearch', 'input', () => void renderSkillsView());

on('#artifactList', 'click', async (event) => {
  const revealId = event.target.dataset.reveal;
  const openId = event.target.dataset.open;
  const rowId = event.target.closest('.file-row')?.dataset.artifact;
  const item = state.artifacts.find((a) => a.id === (revealId || openId || rowId));
  if (!item) return;
  try {
    if (revealId) { await window.desktop.revealFile(item.path); return; }
    if (item.readable || openId) {
      const file = await window.desktop.readFile(item.path);
      openViewer({ title: item.name, kind: item.kind, body: file.text, truncated: file.truncated, path: item.path });
      return;
    }
    await window.desktop.revealFile(item.path);
  } catch (error) { toast(error.message); }
});

on('#skillList', 'click', async (event) => {
  const openId = event.target.dataset.skillOpen;
  const revealId = event.target.dataset.skillReveal;
  const skill = state.skills.find((k) => k.id === (openId || revealId));
  if (!skill) return;
  try {
    if (revealId) { await window.desktop.revealFile(skill.manifest); return; }
    const file = await window.desktop.readFile(skill.manifest);
    openViewer({ title: skill.name + ' · SKILL.md', kind: 'MD', body: file.text, truncated: file.truncated, path: skill.manifest });
  } catch (error) { toast(error.message); }
});

on('#clearLogView', 'click', () => { $('#logOutput').textContent = ''; $('#logCount').textContent = '0 entries in view'; });
on('#openDiagnostics', 'click', () => selectPane('diagnostics'));

if (window.desktop.onLog) {
  window.desktop.onLog((item) => {
    state.logs.push(item);
    if ($('#logOutput')) renderLogView();
  });
}
if (window.desktop.onHarnessStatus) window.desktop.onHarnessStatus(() => void refreshStatus());
if (window.desktop.onEngineEvent) {
  window.desktop.onEngineEvent((event) => {
    const p = event?.payload;
    if (event?.stream === 'authorization' && p?.type === 'notice') {
      const notice = p.notice || {};
      state.signInUrl = typeof notice.url === 'string' && /^https:\/\//i.test(notice.url) ? notice.url : null;
      $('#signInMessage').textContent = [notice.message, notice.code ? `Code: ${notice.code}` : ''].filter(Boolean).join(' — ');
      $('#signInOpen').classList.toggle('hidden', !state.signInUrl);
      $('#signInBanner').classList.remove('hidden');
      toast(notice.message || 'Continue the provider sign-in from Settings.');
      return;
    }
    if (event?.stream === 'authorization' && p?.type === 'prompt') {
      state.authPrompt = p;
      const prompt = p.prompt || {};
      $('#authPromptLabel').firstChild.textContent = prompt.message || 'Authorization response';
      const select = $('#authPromptSelect');
      const input = $('#authPromptInput');
      const isSelect = prompt.kind === 'select';
      select.classList.toggle('hidden', !isSelect);
      input.classList.toggle('hidden', isSelect);
      if (isSelect) {
        select.innerHTML = (prompt.options || []).map((option) => `<option value="${esc(option.id)}">${esc(option.label)}</option>`).join('');
      } else {
        input.type = prompt.kind === 'secret' ? 'password' : 'text';
        input.placeholder = prompt.placeholder || '';
        input.value = '';
      }
      $('#authPrompt').classList.remove('hidden');
      openSettings('models');
      return;
    }
    if (p?.type === 'host/session-status' && !p.running) {
      clearTimeout(historyTimer);
      historyTimer = setTimeout(() => { if (state.sessionId) void selectSession(state.sessionId); }, 300);
    }
    const url = p?.url || p?.data?.url;
    if (typeof url === 'string' && /^https:\/\//i.test(url)) {
      state.signInUrl = url;
      $('#signInMessage').textContent = p.message || p.data?.message || 'Open the provider page to finish signing in.';
      $('#signInBanner').classList.remove('hidden');
      toast('A provider needs you to sign in — see Settings → Models & Providers.');
    }
    if (p?.type === 'mux/event' && state.sessionId) {
      clearTimeout(historyTimer);
      historyTimer = setTimeout(() => void selectSession(state.sessionId), 260);
    }
  });
}

/* ── resizable / collapsible panes ──────────────────────────────────────── */
const PANES = {
  rail:   { varName: '--w-rail',   sel: '.rail',       edge: 'left',  min: 200, max: 420, def: 258 },
  chat:   { varName: '--w-chat',   sel: '.chat-col',   edge: 'left',  min: 240, max: 620, def: 320 },
  viewer: { varName: '--w-viewer', sel: '.viewer-col', edge: 'right', min: 300, max: 780, def: 440 },
  cola:   { varName: '--w-cola',   sel: '.col-a',      edge: 'left',  min: 320, max: 640, def: 420 },
  colc:   { varName: '--w-colc',   sel: '.col-c',      edge: 'right', min: 280, max: 620, def: 396 },
};
const LAYOUT_KEY = 'harness.layout.v1';

function readLayout() {
  try { return JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {}; } catch { return {}; }
}
function writeLayout(patch) {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...readLayout(), ...patch })); } catch {}
}
function setPaneWidth(key, px) {
  const cfg = PANES[key];
  const width = Math.round(Math.max(cfg.min, Math.min(cfg.max, px)));
  document.documentElement.style.setProperty(cfg.varName, `${width}px`);
  writeLayout({ [cfg.varName]: width });
  return width;
}

function initSplitters() {
  $$('.splitter').forEach((splitter) => {
    const key = splitter.dataset.split;
    const cfg = PANES[key];
    if (!cfg) return;

    splitter.addEventListener('pointerdown', (event) => {
      const pane = document.querySelector(cfg.sel);
      if (!pane) return;
      event.preventDefault();
      splitter.setPointerCapture(event.pointerId);
      splitter.classList.add('dragging');
      document.body.classList.add('resizing');

      const move = (e) => {
        const rect = pane.getBoundingClientRect();
        const next = cfg.edge === 'left' ? e.clientX - rect.left : rect.right - e.clientX;
        setPaneWidth(key, next);
      };
      const up = () => {
        splitter.classList.remove('dragging');
        document.body.classList.remove('resizing');
        splitter.removeEventListener('pointermove', move);
        splitter.removeEventListener('pointerup', up);
        splitter.removeEventListener('pointercancel', up);
      };
      splitter.addEventListener('pointermove', move);
      splitter.addEventListener('pointerup', up);
      splitter.addEventListener('pointercancel', up);
    });

    // Keyboard resizing keeps the layout reachable without a pointer.
    splitter.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const pane = document.querySelector(cfg.sel);
      if (!pane) return;
      const delta = (event.key === 'ArrowRight' ? 16 : -16) * (cfg.edge === 'left' ? 1 : -1);
      setPaneWidth(key, pane.getBoundingClientRect().width + delta);
    });

    splitter.addEventListener('dblclick', () => setPaneWidth(key, cfg.def));
  });
}

function applyPaneState({ editor, viewer, colc, rail } = {}, explicit = false) {
  if (explicit && viewer !== undefined) state.viewerExplicit = viewer;
  const work = document.querySelector('.work-body');
  const plugins = document.querySelector('.plugins-body');
  if (editor !== undefined) {
    work.classList.toggle('hide-editor', !editor);
    $('#toggleEditor').classList.toggle('on', editor);
    $('#toggleEditor').setAttribute('aria-pressed', String(editor));
    writeLayout({ editor });
  }
  if (viewer !== undefined) {
    work.classList.toggle('hide-viewer', !viewer);
    $('#togglePanels').classList.toggle('on', viewer);
    $('#togglePanels').setAttribute('aria-pressed', String(viewer));
    writeLayout({ viewer });
  }
  if (rail !== undefined) {
    document.querySelector('.shell').classList.toggle('hide-rail', !rail);
    $('#toggleRail').setAttribute('aria-expanded', String(rail));
    writeLayout({ rail });
  }
  if (colc !== undefined && plugins) {
    plugins.classList.toggle('hide-colc', !colc);
    writeLayout({ colc });
  }
}

function restoreLayout() {
  const saved = readLayout();
  for (const cfg of Object.values(PANES)) {
    const width = saved[cfg.varName];
    if (width) document.documentElement.style.setProperty(cfg.varName, `${width}px`);
  }
  applyPaneState({
    editor: saved.editor !== false,
    viewer: saved.viewer !== false,
    colc: saved.colc !== false,
    rail: saved.rail !== false,
  });
}

on('#toggleRail', 'click', () => applyPaneState({ rail: false }));
on('#showRail', 'click', () => applyPaneState({ rail: true }));
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    applyPaneState({ rail: document.querySelector('.shell').classList.contains('hide-rail') });
  }
});

on('#toggleEditor', 'click', () =>
  applyPaneState({ editor: document.querySelector('.work-body').classList.contains('hide-editor') }));
on('#togglePanels', 'click', () =>
  applyPaneState({ viewer: document.querySelector('.work-body').classList.contains('hide-viewer') }, true));
on('#closeEditor', 'click', () => applyPaneState({ editor: false }));
on('#closePanels', 'click', () => applyPaneState({ viewer: false }, true));
on('#focusMode', 'click', () => {
  const work = document.querySelector('.work-body');
  const focused = work.classList.contains('hide-editor') && work.classList.contains('hide-viewer');
  applyPaneState({ editor: focused, viewer: focused }, true);
  $('#focusMode').classList.toggle('on', !focused);
});

/* ── boot ───────────────────────────────────────────────────────────────── */
initSplitters();
restoreLayout();
showView('work');
renderViewers();
void refreshWork();
void refreshPlugins();
void refreshWorkspaceFiles();

// Surface any control this build failed to bind, instead of failing silently.
if (missingTargets.length) {
  const message = 'Unbound UI targets: ' + missingTargets.join(', ');
  if (CONNECTED) window.desktop.reportLog('renderer', message);
  console.warn(message);
}
