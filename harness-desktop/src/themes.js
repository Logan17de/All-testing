(() => {
  'use strict';

  if (window.__HARNESS_DESKTOP_THEMES__) return;
  window.__HARNESS_DESKTOP_THEMES__ = true;

  const desktop = window.desktop;
  if (!desktop) return;

  const STORAGE_KEY = 'harness-desktop.theme.v1';
  const THEME_FILE = 'themes.json';
  const ROOT = document.documentElement;

  const SAFE_VARIABLES = new Set([
    '--bg', '--bg-rail', '--panel', '--panel-2', '--panel-3', '--line', '--line-2',
    '--text', '--text-2', '--dim', '--dimmer', '--blue', '--blue-hi', '--blue-soft',
    '--green', '--green-soft', '--amber', '--red', '--red-soft',
    '--rail-text', '--rail-text-2', '--rail-dim', '--rail-dimmer', '--rail-hover',
    '--rail-active', '--rail-line', '--rail-line-2', '--accent-deep', '--accent-hi',
    '--theme-hover', '--scroll-thumb', '--scroll-thumb-hover', '--theme-shadow',
  ]);

  const BUILTIN = {
    id: 'harness-control-room',
    name: 'Control Room',
    mode: 'dark',
    description: 'The built-in Harness Desktop dark theme.',
    source: 'Harness Desktop',
    variables: {
      '--bg': '#0b0e14',
      '--bg-rail': '#080b10',
      '--panel': '#10151d',
      '--panel-2': '#141a23',
      '--panel-3': '#182029',
      '--line': '#1c242f',
      '--line-2': '#26303d',
      '--text': '#e5e9f0',
      '--text-2': '#c3cbd7',
      '--dim': '#8b95a5',
      '--dimmer': '#5f6875',
      '--blue': '#2f6ef0',
      '--blue-hi': '#4b83f5',
      '--blue-soft': 'rgba(47, 110, 240, 0.16)',
      '--green': '#3fb950',
      '--green-soft': 'rgba(63, 185, 80, 0.14)',
      '--amber': '#d29922',
      '--red': '#f0656f',
      '--red-soft': 'rgba(240, 101, 111, 0.12)',
      '--rail-text': '#e5e9f0',
      '--rail-text-2': '#c3cbd7',
      '--rail-dim': '#8b95a5',
      '--rail-dimmer': '#5f6875',
      '--rail-hover': '#0e131a',
      '--rail-active': '#141a23',
      '--rail-line': '#1c242f',
      '--rail-line-2': '#26303d',
      '--accent-deep': '#1b3a86',
      '--accent-hi': '#4b83f5',
      '--theme-hover': 'rgba(47, 110, 240, 0.08)',
      '--scroll-thumb': '#202834',
      '--scroll-thumb-hover': '#2c3746',
      '--theme-shadow': 'rgba(0, 0, 0, 0.45)',
    },
  };

  const chromeStyle = document.createElement('style');
  chromeStyle.id = 'harness-theme-runtime-style';
  chromeStyle.textContent = `
    html[data-harness-theme] { color-scheme: dark; }
    html[data-harness-theme][data-theme-mode="light"] { color-scheme: light; }

    html[data-harness-theme] body { background:var(--bg); color:var(--text); }
    html[data-harness-theme] ::-webkit-scrollbar-thumb { background:var(--scroll-thumb); border:2px solid transparent; background-clip:padding-box; }
    html[data-harness-theme] ::-webkit-scrollbar-thumb:hover { background:var(--scroll-thumb-hover); background-clip:padding-box; }
    html[data-harness-theme] .rail { background:var(--bg-rail); border-right-color:var(--rail-line); }
    html[data-harness-theme] .rail-brand strong,
    html[data-harness-theme] .rail .settings-item { color:var(--rail-text); }
    html[data-harness-theme] .rail-item,
    html[data-harness-theme] .project { color:var(--rail-dim); }
    html[data-harness-theme] .rail-item svg,
    html[data-harness-theme] .project svg,
    html[data-harness-theme] .rail-item em,
    html[data-harness-theme] .rail-label { color:var(--rail-dimmer); }
    html[data-harness-theme] .rail-item:hover,
    html[data-harness-theme] .project:hover { background:var(--rail-hover); color:var(--rail-text-2); }
    html[data-harness-theme] .rail-item.active,
    html[data-harness-theme] .project.active { background:var(--rail-active); color:var(--rail-text); border-color:var(--rail-line-2); }
    html[data-harness-theme] .rail-item.active svg { color:var(--accent-hi); }
    html[data-harness-theme] .rail-item.active em { color:var(--rail-text-2); }
    html[data-harness-theme] .brand-mark { background:linear-gradient(160deg,var(--accent-hi),var(--accent-deep)); }
    html[data-harness-theme] .show-rail,
    html[data-harness-theme] .btn,
    html[data-harness-theme] .ghost-icon.on,
    html[data-harness-theme] .chat-artifact-chip { box-shadow:none; }
    html[data-harness-theme] .btn:hover:not(:disabled) { border-color:var(--line-2); }
    html[data-harness-theme] .rail-splitter i,
    html[data-harness-theme] .splitter i { background:var(--line-2); }
    html[data-harness-theme] .splitter:hover i,
    html[data-harness-theme] .splitter:focus-visible i,
    html[data-harness-theme] .splitter.dragging i { background:var(--blue); }
    html[data-harness-theme] .modal,
    html[data-harness-theme] .sheet,
    html[data-harness-theme] .enhanced-skill-dialog,
    html[data-harness-theme] .enhanced-artifact-popup { box-shadow:0 24px 70px var(--theme-shadow); }

    html[data-harness-theme][data-theme-mode="light"] .overlay,
    html[data-harness-theme][data-theme-mode="light"] .enhanced-skill-overlay { background:rgba(28,38,48,.28); }
    html[data-harness-theme][data-theme-mode="light"] .wc.close:hover { background:#b9484f; color:#fff; }
    html[data-harness-theme][data-theme-mode="light"] .enhanced-artifact-head { background:rgba(0,0,0,.018); }
    html[data-harness-theme][data-theme-mode="light"] .ext { color:rgba(20,34,48,.68); }

    .theme-pack-card { display:grid; gap:15px; }
    .theme-pack-head { display:flex; align-items:flex-start; gap:16px; }
    .theme-pack-head > div { flex:1; }
    .theme-pack-head strong { display:block; font:600 15px var(--disp); }
    .theme-pack-head small { display:block; margin-top:3px; color:var(--dim); }
    .theme-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(172px,1fr)); gap:11px; }
    .theme-choice { display:grid; gap:9px; min-width:0; padding:10px; border:1px solid var(--line); border-radius:10px; background:var(--panel); color:var(--text); text-align:left; cursor:pointer; }
    .theme-choice:hover { border-color:var(--line-2); background:var(--panel-2); }
    .theme-choice.active { border-color:var(--blue); box-shadow:0 0 0 2px var(--blue-soft); }
    .theme-preview { height:76px; display:grid; grid-template-columns:34% 1fr; overflow:hidden; border:1px solid rgba(127,127,127,.2); border-radius:8px; background:var(--preview-bg); }
    .theme-preview-rail { background:var(--preview-rail); border-right:1px solid var(--preview-line); position:relative; }
    .theme-preview-rail::before,
    .theme-preview-rail::after { content:""; position:absolute; left:8px; right:8px; height:5px; border-radius:5px; background:var(--preview-muted); opacity:.62; }
    .theme-preview-rail::before { top:16px; }
    .theme-preview-rail::after { top:29px; width:55%; }
    .theme-preview-main { background:var(--preview-panel); padding:10px 9px; position:relative; }
    .theme-preview-main::before { content:""; display:block; height:34px; border:1px solid var(--preview-line); border-radius:5px; background:var(--preview-bg); }
    .theme-preview-main::after { content:""; position:absolute; left:11px; right:20px; bottom:8px; height:7px; border-radius:6px; background:var(--preview-accent); }
    .theme-choice-meta { min-width:0; }
    .theme-choice-meta strong { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12.5px; }
    .theme-choice-meta span { display:block; margin-top:2px; color:var(--dimmer); font-size:10.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .theme-empty { padding:12px 0 2px; color:var(--dim); font-size:12px; }
  `;
  document.head.appendChild(chromeStyle);

  let catalog = [BUILTIN];
  let loadPromise = null;

  function esc(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    }[char]));
  }

  function joinPath(base, name) {
    return `${String(base || '').replace(/[\\/]+$/, '')}/${name}`;
  }

  function validColor(value) {
    if (typeof value !== 'string' || !value.trim() || /[;{}]/.test(value)) return false;
    return typeof CSS?.supports === 'function' ? CSS.supports('color', value.trim()) : /^#|^rgb|^hsl|^transparent$/i.test(value.trim());
  }

  function normalizeTheme(raw, source) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 72);
    const name = String(raw.name || '').trim().slice(0, 80);
    const mode = raw.mode === 'light' ? 'light' : 'dark';
    if (!id || !name || !raw.variables || typeof raw.variables !== 'object') return null;

    const variables = {};
    for (const [key, value] of Object.entries(raw.variables)) {
      if (!SAFE_VARIABLES.has(key) || !validColor(value)) continue;
      variables[key] = value.trim();
    }
    if (!variables['--bg'] || !variables['--panel'] || !variables['--text'] || !variables['--blue']) return null;
    return {
      id,
      name,
      mode,
      description: String(raw.description || '').trim().slice(0, 240),
      source,
      variables,
    };
  }

  async function discoverThemes() {
    const next = [BUILTIN];
    let plugins = [];
    try {
      const listed = await desktop.listPlugins();
      plugins = Array.isArray(listed?.installed) ? listed.installed : [];
    } catch {}

    for (const plugin of plugins) {
      if (!plugin?.path || !Array.isArray(plugin.permissions) || !plugin.permissions.includes('ui')) continue;
      try {
        const file = await desktop.readFile(joinPath(plugin.path, THEME_FILE));
        if (!file?.text || file.truncated) continue;
        const parsed = JSON.parse(file.text);
        const themes = Array.isArray(parsed?.themes) ? parsed.themes : [];
        for (const raw of themes.slice(0, 32)) {
          const normalized = normalizeTheme(raw, parsed.name || plugin.name || 'Theme plugin');
          if (!normalized) continue;
          if (!next.some(item => item.id === normalized.id)) next.push(normalized);
        }
      } catch {}
    }
    catalog = next;
    return catalog;
  }

  function selectedId() {
    try { return localStorage.getItem(STORAGE_KEY) || BUILTIN.id; }
    catch { return BUILTIN.id; }
  }

  function applyTheme(theme, persist = true) {
    const chosen = theme || BUILTIN;
    const values = { ...BUILTIN.variables, ...chosen.variables };
    for (const key of SAFE_VARIABLES) {
      if (values[key]) ROOT.style.setProperty(key, values[key]);
    }
    ROOT.dataset.harnessTheme = chosen.id;
    ROOT.dataset.themeMode = chosen.mode;
    ROOT.dataset.themeSource = chosen.source || '';
    if (persist) {
      try { localStorage.setItem(STORAGE_KEY, chosen.id); } catch {}
    }
    renderAppearance();
    return chosen;
  }

  function restoreSelection() {
    const stored = selectedId();
    const theme = catalog.find(item => item.id === stored) || BUILTIN;
    if (theme.id !== stored) {
      try { localStorage.setItem(STORAGE_KEY, BUILTIN.id); } catch {}
    }
    applyTheme(theme, false);
  }

  function previewStyle(theme) {
    const vars = { ...BUILTIN.variables, ...theme.variables };
    const railText = vars['--rail-dim'] || vars['--dim'];
    return [
      `--preview-bg:${vars['--bg']}`,
      `--preview-rail:${vars['--bg-rail']}`,
      `--preview-panel:${vars['--panel']}`,
      `--preview-line:${vars['--line-2']}`,
      `--preview-accent:${vars['--blue']}`,
      `--preview-muted:${railText}`,
    ].join(';');
  }

  function renderAppearance() {
    const pane = document.querySelector('.pane[data-pane="appearance"]');
    const card = pane?.querySelector('.sub-card');
    if (!card) return;
    const activeId = ROOT.dataset.harnessTheme || BUILTIN.id;
    card.classList.add('theme-pack-card');
    card.innerHTML = `
      <div class="theme-pack-head">
        <div><strong>Theme</strong><small>${catalog.length > 1 ? `${catalog.length - 1} plugin themes available plus the Harness default.` : 'Harness Desktop default theme. Install a UI theme plugin to add more.'}</small></div>
        <span class="pill">${esc(catalog.find(item => item.id === activeId)?.name || BUILTIN.name)}</span>
      </div>
      <div class="theme-grid">
        ${catalog.map(theme => `
          <button type="button" class="theme-choice ${theme.id === activeId ? 'active' : ''}" data-theme-id="${esc(theme.id)}" title="${esc(theme.description || theme.name)}">
            <span class="theme-preview" style="${esc(previewStyle(theme))}">
              <span class="theme-preview-rail"></span><span class="theme-preview-main"></span>
            </span>
            <span class="theme-choice-meta"><strong>${esc(theme.name)}</strong><span>${esc(theme.source)} · ${theme.mode}</span></span>
          </button>`).join('')}
      </div>
      ${catalog.length === 1 ? '<div class="theme-empty">Theme plugins contribute bounded color variables only; arbitrary CSS is not loaded into the renderer.</div>' : ''}`;

    card.querySelectorAll('[data-theme-id]').forEach(button => {
      button.addEventListener('click', () => {
        const theme = catalog.find(item => item.id === button.dataset.themeId);
        if (theme) applyTheme(theme, true);
      });
    });
  }

  async function refreshThemes() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      await discoverThemes();
      restoreSelection();
      renderAppearance();
      return catalog;
    })();
    try { return await loadPromise; }
    finally { loadPromise = null; }
  }

  document.addEventListener('click', event => {
    const nav = event.target.closest?.('.mnav[data-pane="appearance"]');
    if (nav) void refreshThemes();
  });

  void refreshThemes();
})();
