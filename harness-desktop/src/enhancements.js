(() => {
  'use strict';

  if (window.__HARNESS_DESKTOP_ENHANCEMENTS__) return;
  window.__HARNESS_DESKTOP_ENHANCEMENTS__ = true;

  const desktop = window.desktop;
  if (!desktop) return;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[char]));

  const style = document.createElement('style');
  style.textContent = `
    .engine-card.enhanced-engine-card { margin: 0 0 6px; }
    .usage-summary { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; margin:0 0 14px; }
    .usage-stat { border:1px solid var(--line); border-radius:var(--radius); background:var(--panel); padding:13px 14px; }
    .usage-stat span { display:block; color:var(--dimmer); font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
    .usage-stat strong { display:block; margin-top:4px; font:600 17px var(--disp); }
    .usage-table td, .usage-table th { white-space:nowrap; }
    .usage-unknown { color:var(--dimmer); }
    .usage-source { color:var(--dimmer); font-size:11px; }
    .usage-actions { display:flex; justify-content:flex-end; margin-bottom:10px; }

    .enhanced-artifact-popup { position:relative; flex:0 0 auto; min-height:180px; border:1px solid var(--line-2); border-radius:var(--radius); background:var(--panel); overflow:hidden; box-shadow:0 10px 32px rgba(0,0,0,.22); }
    .enhanced-artifact-popup + .enhanced-artifact-popup { margin-top:12px; }
    .enhanced-artifact-head { display:flex; align-items:center; gap:7px; padding:8px 9px 8px 12px; border-bottom:1px solid var(--line); background:rgba(255,255,255,.012); }
    .enhanced-artifact-head strong { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12.5px; }
    .enhanced-artifact-head .ghost-icon { min-width:27px; width:27px; height:27px; padding:0; }
    .enhanced-artifact-body { overflow:auto; padding:14px 16px; height:calc(100% - 45px); color:var(--text-2); }
    .enhanced-artifact-body pre { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; font:12px/1.65 var(--mono); color:var(--text-2); }
    .enhanced-artifact-body img { display:block; max-width:100%; max-height:100%; margin:auto; object-fit:contain; border-radius:6px; }
    .enhanced-artifact-body .preview-empty { display:grid; place-items:center; min-height:120px; text-align:center; color:var(--dim); }
    .artifact-resize-grip { height:9px; cursor:ns-resize; display:grid; place-items:center; position:absolute; left:0; right:0; bottom:0; }
    .artifact-resize-grip::before { content:""; width:42px; height:2px; border-radius:2px; background:var(--line-2); }
    .artifact-resize-grip:hover::before { background:var(--blue); }
    .enhanced-artifact-popup.maximized { position:fixed; z-index:120; top:48px; right:16px; bottom:16px; left:max(300px,24vw); height:auto !important; box-shadow:0 24px 70px rgba(0,0,0,.55); }
    .enhanced-artifact-popup.maximized .artifact-resize-grip { display:none; }

    .chat-artifact-chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
    .chat-artifact-chip { display:inline-flex; align-items:center; gap:7px; max-width:100%; padding:6px 9px; border:1px solid var(--line-2); border-radius:7px; background:var(--panel-2); color:var(--text-2); cursor:pointer; font-size:12px; }
    .chat-artifact-chip:hover { border-color:var(--blue); background:var(--blue-soft); color:var(--text); }
    .chat-artifact-chip b { font-size:9px; color:var(--dimmer); font-family:var(--mono); }

    .enhanced-skill-overlay { position:fixed; inset:0; z-index:140; background:rgba(4,7,11,.72); display:grid; place-items:center; padding:24px; }
    .enhanced-skill-dialog { width:min(520px,calc(100vw - 48px)); border:1px solid var(--line-2); border-radius:12px; background:var(--panel); box-shadow:0 24px 80px rgba(0,0,0,.5); padding:18px; }
    .enhanced-skill-dialog h2 { margin:0 0 4px; font:600 18px var(--disp); }
    .enhanced-skill-dialog p { margin:0 0 15px; color:var(--dim); font-size:13px; }
    .enhanced-skill-dialog label { display:grid; gap:6px; margin:11px 0; color:var(--text-2); font-size:12px; }
    .enhanced-skill-dialog input, .enhanced-skill-dialog textarea { width:100%; border:1px solid var(--line-2); border-radius:7px; background:var(--panel-2); padding:9px 10px; outline:none; }
    .enhanced-skill-dialog textarea { min-height:90px; resize:vertical; }
    .enhanced-skill-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:15px; }
  `;
  document.head.appendChild(style);

  function human(value) {
    if (value === null || value === undefined || value === '') return 'Unknown';
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return 'Unknown';
      if (Math.abs(value) >= 1e9) return `${(value / 1e9).toFixed(2)} B`;
      if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)} M`;
      if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)} K`;
    }
    return String(value);
  }

  function updateEngineCard(status = {}) {
    const card = $('#enhancedEngineCard');
    if (!card) return;
    const ready = Boolean(status.healthy && status.ready);
    const running = Boolean(status.connecting || status.running);
    const dot = $('.engine-dot', card);
    dot.className = `engine-dot ${ready ? 'good' : running ? 'busy' : status.safeMode ? 'bad' : ''}`;
    $('#enhancedEngineTitle').textContent = ready ? 'Engine online' : running ? 'Engine connecting' : status.safeMode ? 'Recovery mode' : 'Engine offline';
    $('#enhancedEngineVersion').textContent = status.dshVersion ? `DSH ${status.dshVersion}` : 'DSH —';
    $('#enhancedEnginePlatform').textContent = status.platform || (navigator.userAgent.includes('Windows') ? 'Windows x64' : 'Platform —');
  }

  async function ensureEngineCard() {
    const foot = $('.rail-foot');
    if (!foot || $('#enhancedEngineCard')) return;
    const card = document.createElement('div');
    card.id = 'enhancedEngineCard';
    card.className = 'engine-card enhanced-engine-card';
    card.innerHTML = `
      <span class="engine-dot"></span>
      <div><strong id="enhancedEngineTitle">Engine status</strong><small id="enhancedEngineVersion">DSH —</small><small id="enhancedEnginePlatform">Platform —</small></div>`;
    foot.prepend(card);
    try { updateEngineCard(await desktop.getStatus()); } catch {}
    if (desktop.onHarnessStatus) desktop.onHarnessStatus((status) => updateEngineCard(status || {}));
  }

  function selectSettingsPane(name) {
    $$('.mnav').forEach((node) => node.classList.toggle('active', node.dataset.pane === name));
    $$('.pane').forEach((node) => node.classList.toggle('active', node.dataset.pane === name));
  }

  async function refreshUsage() {
    const body = $('#usageRows');
    if (!body) return;
    body.innerHTML = '<tr><td colspan="6"><div class="inline-state">Refreshing usage…</div></td></tr>';
    let result;
    try { result = await desktop.getUsage(); }
    catch (error) { result = { items: [], error: error.message }; }
    const items = result?.items || [];

    $('#usageAvailable').textContent = result?.available ? 'Provider-reported data' : 'Usage data unavailable';
    $('#usageUpdated').textContent = `Checked ${new Date().toLocaleTimeString()}`;

    const knownUsed = items.filter((item) => typeof item.used === 'number').reduce((sum, item) => sum + item.used, 0);
    const knownRemaining = items.filter((item) => typeof item.remaining === 'number').reduce((sum, item) => sum + item.remaining, 0);
    const usedKnown = items.some((item) => typeof item.used === 'number');
    const remainingKnown = items.some((item) => typeof item.remaining === 'number');
    $('#usageSummaryUsed').textContent = usedKnown ? human(knownUsed) : 'Unknown';
    $('#usageSummaryRemaining').textContent = remainingKnown ? human(knownRemaining) : 'Unknown';
    const refresh = items.map((item) => item.refreshIn || item.resetAt).find(Boolean);
    $('#usageSummaryRefresh').textContent = refresh ? human(refresh) : 'Unknown';

    if (!items.length) {
      body.innerHTML = `<tr><td colspan="6"><div class="inline-state">No providers are currently reported by the engine. Used, remaining, and refresh time are Unknown.</div></td></tr>`;
      return;
    }

    body.innerHTML = items.map((item) => `
      <tr>
        <td><strong>${esc(item.label || item.id || 'Provider')}</strong><div class="usage-source">${esc(item.kind || 'provider')}</div></td>
        <td class="${item.used == null ? 'usage-unknown' : ''}">${esc(human(item.used))}</td>
        <td class="${item.remaining == null ? 'usage-unknown' : ''}">${esc(human(item.remaining))}</td>
        <td class="${!item.refreshIn ? 'usage-unknown' : ''}">${esc(human(item.refreshIn))}</td>
        <td class="${!item.resetAt ? 'usage-unknown' : ''}">${esc(human(item.resetAt))}</td>
        <td>${item.available ? '<span class="pill on">Available</span>' : '<span class="pill off">Unknown</span>'}</td>
      </tr>`).join('');
  }

  function ensureUsagePane() {
    const nav = $('.modal-nav');
    const main = $('.modal-main');
    if (!nav || !main || $('[data-pane="usage"]')) return;

    const navButton = document.createElement('button');
    navButton.className = 'mnav';
    navButton.dataset.pane = 'usage';
    navButton.innerHTML = '<span class="mi">◴</span>Usage';
    navButton.addEventListener('click', () => { selectSettingsPane('usage'); void refreshUsage(); });
    nav.appendChild(navButton);

    const pane = document.createElement('section');
    pane.className = 'pane';
    pane.dataset.pane = 'usage';
    pane.innerHTML = `
      <div class="pane-head"><div><h2>Usage &amp; Limits</h2><p>Provider-reported usage only. Harness never guesses a quota.</p></div></div>
      <div class="usage-actions"><div style="margin-right:auto"><strong id="usageAvailable">Checking…</strong><div id="usageUpdated" class="usage-source">—</div></div><button id="refreshUsageNow" class="btn ghost sm">↻ Refresh</button></div>
      <div class="usage-summary">
        <div class="usage-stat"><span>Used</span><strong id="usageSummaryUsed">Unknown</strong></div>
        <div class="usage-stat"><span>Remaining</span><strong id="usageSummaryRemaining">Unknown</strong></div>
        <div class="usage-stat"><span>Refresh in / reset</span><strong id="usageSummaryRefresh">Unknown</strong></div>
      </div>
      <div class="table-wrap"><table class="grid usage-table"><thead><tr><th>Provider / Account</th><th>Used</th><th>Remaining</th><th>Refresh in</th><th>Reset at</th><th>Status</th></tr></thead><tbody id="usageRows"></tbody></table></div>
      <p class="sec-sub">If a provider or account does not expose usage through the Harness runtime, its values stay <strong>Unknown</strong>.</p>`;
    const footer = $('.modal-foot', main);
    main.insertBefore(pane, footer || null);
    $('#refreshUsageNow').addEventListener('click', () => void refreshUsage());
  }

  function repairProjectClicks() {
    const original = $('#projectList');
    if (!original || original.dataset.enhancedProjectHandler === '1') return;
    const clean = original.cloneNode(true);
    clean.dataset.enhancedProjectHandler = '1';
    original.replaceWith(clean);
    clean.addEventListener('click', async (event) => {
      const button = event.target.closest('.project');
      if (!button?.dataset.path) return;
      button.disabled = true;
      try {
        await desktop.setWorkspace(button.dataset.path);
        location.reload();
      } catch (error) {
        button.disabled = false;
        console.error('Workspace switch failed', error);
      }
    });
  }

  function ensureSkillCreateButton() {
    const head = $('#view-skills .page-head');
    if (!head || $('#addSkillEnhanced')) return;
    const controls = document.createElement('div');
    controls.className = 'head-actions';
    controls.innerHTML = '<button id="addSkillEnhanced" class="btn primary">+ Add skill</button>';
    const windows = $('.win-controls', head);
    head.insertBefore(controls, windows || null);
    $('#addSkillEnhanced').addEventListener('click', openSkillDialog);
  }

  function openSkillDialog() {
    if ($('#enhancedSkillOverlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'enhancedSkillOverlay';
    overlay.className = 'enhanced-skill-overlay';
    overlay.innerHTML = `
      <form class="enhanced-skill-dialog">
        <h2>Add skill</h2><p>Create a real SKILL.md in this workspace. Harness will discover it from the normal skill folders.</p>
        <label>Name<input id="enhancedSkillName" required maxlength="80" placeholder="Review pull request" /></label>
        <label>Description<textarea id="enhancedSkillDescription" maxlength="500" placeholder="What should this skill help the models do?"></textarea></label>
        <div id="enhancedSkillError" class="error-text"></div>
        <div class="enhanced-skill-actions"><button type="button" class="btn ghost" data-skill-cancel>Cancel</button><button class="btn primary" type="submit">Create skill</button></div>
      </form>`;
    document.body.appendChild(overlay);
    $('#enhancedSkillName').focus();
    $('[data-skill-cancel]', overlay).addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (event) => { if (event.target === overlay) overlay.remove(); });
    $('form', overlay).addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = $('button[type="submit"]', overlay);
      submit.disabled = true;
      try {
        await desktop.createSkill({
          name: $('#enhancedSkillName').value.trim(),
          description: $('#enhancedSkillDescription').value.trim(),
        });
        overlay.remove();
        $('#refreshSkills')?.click();
      } catch (error) {
        $('#enhancedSkillError').textContent = error.message;
        submit.disabled = false;
      }
    });
  }

  const enhancedViewers = [];
  let renderingDock = false;

  function ensureViewerVisible() {
    const work = $('.work-body');
    if (work?.classList.contains('hide-viewer')) $('#togglePanels')?.click();
  }

  async function openArtifactPopup({ id, title, path, kind }) {
    if (!path) return;
    let preview;
    try { preview = await desktop.previewFile(path); }
    catch (error) { preview = { type: 'error', error: error.message }; }
    const key = path || id || title;
    const existing = enhancedViewers.find((item) => item.key === key);
    const value = { key, id, title: title || preview?.name || 'Artifact', path, kind: kind || preview?.kind || 'FILE', preview, expanded: existing?.expanded || false, height: existing?.height || 300 };
    if (existing) Object.assign(existing, value);
    else enhancedViewers.unshift(value);
    enhancedViewers.splice(4);
    ensureViewerVisible();
    renderEnhancedDock();
  }

  function renderEnhancedDock() {
    const stack = $('#viewerCol');
    if (!stack || renderingDock) return;
    renderingDock = true;
    try {
      $$('[data-enhanced-artifact]', stack).forEach((node) => node.remove());
      if (enhancedViewers.length) {
        const empty = $('.inline-state', stack);
        if (empty && !$('.viewer', stack)) empty.remove();
      }
      enhancedViewers.forEach((item, index) => {
        const panel = document.createElement('section');
        panel.className = `enhanced-artifact-popup${item.expanded ? ' maximized' : ''}`;
        panel.dataset.enhancedArtifact = String(index);
        if (!item.expanded) panel.style.height = `${Math.max(180, item.height || 300)}px`;
        const type = item.preview?.type;
        let body;
        if (type === 'image') body = `<img src="${esc(item.preview.dataUrl)}" alt="${esc(item.title)}" />`;
        else if (type === 'text') body = `<pre>${esc(item.preview.text || '')}${item.preview.truncated ? '\n\n… preview truncated …' : ''}</pre>`;
        else body = `<div class="preview-empty"><div><strong>${esc(type === 'error' ? 'Preview failed' : 'Preview unavailable')}</strong><p>${esc(item.preview?.error || 'Open this artifact in its default application.')}</p></div></div>`;
        panel.innerHTML = `
          <div class="enhanced-artifact-head">
            <strong title="${esc(item.path)}">${esc(item.title)}</strong><span class="badge-type">${esc(item.kind || 'FILE')}</span>
            <button class="ghost-icon" data-enhanced-popout="${index}" title="Pop out / open in default app" aria-label="Pop out">↗</button>
            <button class="ghost-icon" data-enhanced-maximize="${index}" title="${item.expanded ? 'Restore' : 'Maximize'}" aria-label="Maximize">⤢</button>
            <button class="ghost-icon" data-enhanced-close="${index}" title="Close preview" aria-label="Close preview">✕</button>
          </div><div class="enhanced-artifact-body">${body}</div><div class="artifact-resize-grip" data-enhanced-resize="${index}" title="Drag to resize"></div>`;
        stack.appendChild(panel);
      });
    } finally { renderingDock = false; }
  }

  function bindViewerDock() {
    const stack = $('#viewerCol');
    if (!stack || stack.dataset.enhancedDock === '1') return;
    stack.dataset.enhancedDock = '1';

    stack.addEventListener('click', async (event) => {
      const close = event.target.closest('[data-enhanced-close]');
      if (close) { enhancedViewers.splice(Number(close.dataset.enhancedClose), 1); renderEnhancedDock(); return; }
      const max = event.target.closest('[data-enhanced-maximize]');
      if (max) { const item = enhancedViewers[Number(max.dataset.enhancedMaximize)]; if (item) item.expanded = !item.expanded; renderEnhancedDock(); return; }
      const popout = event.target.closest('[data-enhanced-popout]');
      if (popout) {
        const item = enhancedViewers[Number(popout.dataset.enhancedPopout)];
        if (item?.path) { try { await desktop.openFile(item.path); } catch (error) { console.error(error); } }
      }
    });

    stack.addEventListener('pointerdown', (event) => {
      const grip = event.target.closest('[data-enhanced-resize]');
      if (!grip) return;
      const index = Number(grip.dataset.enhancedResize);
      const item = enhancedViewers[index];
      const panel = grip.closest('.enhanced-artifact-popup');
      if (!item || !panel || item.expanded) return;
      const startY = event.clientY;
      const startHeight = panel.getBoundingClientRect().height;
      grip.setPointerCapture(event.pointerId);
      const move = (moveEvent) => {
        item.height = Math.max(180, Math.min(window.innerHeight - 120, startHeight + moveEvent.clientY - startY));
        panel.style.height = `${item.height}px`;
      };
      const done = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', done);
        grip.removeEventListener('pointercancel', done);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', done);
      grip.addEventListener('pointercancel', done);
    });

    const observer = new MutationObserver(() => {
      if (!renderingDock && enhancedViewers.length && !stack.querySelector('[data-enhanced-artifact]')) renderEnhancedDock();
    });
    observer.observe(stack, { childList: true });
  }

  function bindArtifactAndSkillOpeners() {
    const artifacts = $('#artifactList');
    if (artifacts && artifacts.dataset.enhancedOpen !== '1') {
      artifacts.dataset.enhancedOpen = '1';
      artifacts.addEventListener('click', async (event) => {
        if (event.target.closest('[data-reveal]')) return;
        const row = event.target.closest('.file-row');
        if (!row?.dataset.artifact) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        try {
          const result = await desktop.listArtifacts();
          const item = (result.items || []).find((entry) => entry.id === row.dataset.artifact);
          if (!item) return;
          await openArtifactPopup({ id: item.id, title: item.name, path: item.path, kind: item.kind });
        } catch (error) { console.error(error); }
      }, true);
    }

    const skills = $('#skillList');
    if (skills && skills.dataset.enhancedOpen !== '1') {
      skills.dataset.enhancedOpen = '1';
      skills.addEventListener('click', async (event) => {
        if (event.target.closest('[data-skill-reveal]')) return;
        const button = event.target.closest('[data-skill-open]');
        if (!button) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        try {
          const result = await desktop.listSkills();
          const item = (result.items || []).find((entry) => entry.id === button.dataset.skillOpen);
          if (!item?.manifest) return;
          await openArtifactPopup({ id: item.id, title: `${item.name} · SKILL.md`, path: item.manifest, kind: 'MD' });
        } catch (error) { console.error(error); }
      }, true);
    }
  }

  function artifactBlocks(content) {
    if (!Array.isArray(content)) return [];
    const found = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const type = String(block.type || '').toLowerCase();
      const path = block.path || block.filePath || block.localPath || block.file?.path || block.attachment?.path;
      const name = block.name || block.filename || block.fileName || block.file?.name || block.attachment?.name || (path ? String(path).split(/[\\/]/).pop() : 'Artifact');
      if (path && (['file', 'attachment', 'image', 'document', 'artifact'].includes(type) || block.mimeType || block.mediaType || block.filename || block.fileName)) {
        found.push({ path: String(path), title: String(name || 'Artifact'), kind: type ? type.toUpperCase().slice(0, 8) : 'FILE' });
      }
    }
    return found;
  }

  let chatArtifactTimer;
  async function refreshChatArtifacts() {
    const sessionId = $('#taskSelect')?.value;
    const stream = $('#chatStream');
    if (!sessionId || !stream) return;
    let history;
    try { history = await desktop.getSessionHistory(sessionId); } catch { return; }
    const events = (history.events || []).map((entry) => entry.event || entry)
      .filter((event) => event?.type === 'user/message' || event?.type === 'assistant/message');
    const messageNodes = $$('.msg.you, .msg.ai', stream);
    messageNodes.forEach((node) => $('.chat-artifact-chips', node)?.remove());
    let nodeIndex = 0;
    for (const event of events) {
      const node = messageNodes[nodeIndex++];
      if (!node) break;
      const content = event.type === 'user/message' ? event.data?.content : event.data?.message?.content;
      const artifacts = artifactBlocks(content);
      if (!artifacts.length) continue;
      const body = $('.msg-body', node)?.parentElement || node.lastElementChild;
      if (!body) continue;
      const chips = document.createElement('div');
      chips.className = 'chat-artifact-chips';
      artifacts.forEach((artifact) => {
        const chip = document.createElement('button');
        chip.className = 'chat-artifact-chip';
        chip.type = 'button';
        chip.innerHTML = `<b>${esc(artifact.kind)}</b><span>${esc(artifact.title)}</span>`;
        chip.addEventListener('click', () => void openArtifactPopup(artifact));
        chips.appendChild(chip);
      });
      body.appendChild(chips);
    }
  }

  function bindChatArtifactObserver() {
    const stream = $('#chatStream');
    if (!stream || stream.dataset.enhancedArtifacts === '1') return;
    stream.dataset.enhancedArtifacts = '1';
    const queue = () => {
      clearTimeout(chatArtifactTimer);
      chatArtifactTimer = setTimeout(() => void refreshChatArtifacts(), 120);
    };
    new MutationObserver(queue).observe(stream, { childList: true, subtree: true });
    $('#taskSelect')?.addEventListener('change', queue);
    queue();
  }

  async function start() {
    await ensureEngineCard();
    ensureUsagePane();
    repairProjectClicks();
    ensureSkillCreateButton();
    bindViewerDock();
    bindArtifactAndSkillOpeners();
    bindChatArtifactObserver();
  }

  void start();
})();
