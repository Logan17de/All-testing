(() => {
  'use strict';

  // renderer.js owns plugin state and the install pipeline, but the staged
  // candidate renderer was accidentally dropped during the desktop UI rewrite.
  // Keep this as a small compatibility surface so receiving any plugin ZIP does
  // not crash with `renderCandidate is not defined`.
  if (typeof window.renderCandidate === 'function') return;

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[char]));

  const style = document.createElement('style');
  style.textContent = `
    #candidatePanel.candidate { margin:12px 16px 0; padding:12px 13px; border:1px solid var(--line-2); border-radius:var(--radius); background:var(--panel-2); }
    .candidate-head { display:flex; align-items:flex-start; gap:10px; }
    .candidate-mark { width:30px; height:30px; flex:none; display:grid; place-items:center; border-radius:7px; border:1px solid var(--line-2); background:var(--panel-3); color:var(--blue-hi); font-weight:700; }
    .candidate-copy { min-width:0; flex:1; }
    .candidate-title { display:flex; align-items:center; gap:8px; min-width:0; }
    .candidate-title strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13.5px; }
    .candidate-title small { color:var(--dimmer); font:11px var(--mono); white-space:nowrap; }
    .candidate-copy > p { margin:4px 0 0; color:var(--dim); font-size:12px; line-height:1.5; }
    .candidate-meta { display:flex; flex-wrap:wrap; gap:5px; margin-top:10px; }
    .candidate-meta .pill { font-size:10.5px; padding:2px 7px; }
    .candidate-errors { margin:10px 0 0; padding:8px 10px; border:1px solid rgba(240,101,111,.28); border-radius:7px; background:var(--red-soft); color:var(--red); font-size:11.5px; }
    .candidate-errors div + div { margin-top:4px; }
    .candidate-actions { display:flex; flex-wrap:wrap; gap:7px; margin-top:11px; }
    .candidate-actions .btn { padding:6px 10px; font-size:12px; }
  `;
  document.head.appendChild(style);

  window.renderCandidate = function renderCandidate() {
    const panel = document.querySelector('#candidatePanel');
    if (!panel) return;

    // `state` is the renderer's global lexical state. Scripts loaded into the
    // same renderer realm can read it even though it is not a window property.
    const candidate = typeof state === 'object' && state ? state.candidate : null;
    if (!candidate) {
      panel.innerHTML = '';
      panel.classList.add('hidden');
      return;
    }

    const validation = candidate.validation && typeof candidate.validation === 'object'
      ? candidate.validation
      : {};
    const errors = Array.isArray(validation.errors) ? validation.errors.filter(Boolean) : [];
    const warnings = Array.isArray(validation.warnings) ? validation.warnings.filter(Boolean) : [];
    const permissions = Array.isArray(candidate.permissions)
      ? candidate.permissions
      : Array.isArray(validation.permissions) ? validation.permissions : [];
    const invalid = candidate.status === 'invalid' || errors.length > 0;
    const ready = candidate.status === 'ready' && !invalid;
    const statusLabel = invalid ? 'Rejected' : ready ? 'Ready' : String(candidate.status || 'Staged');
    const statusClass = invalid ? 'off' : ready ? 'on' : '';

    const permissionMarkup = permissions.length
      ? permissions.map((permission) => `<span class="pill">${escapeHtml(permission)}</span>`).join('')
      : '<span class="pill">No declared permissions</span>';
    const warningMarkup = warnings.length
      ? warnings.map((warning) => `<span class="pill">⚠ ${escapeHtml(warning)}</span>`).join('')
      : '';
    const errorMarkup = errors.length
      ? `<div class="candidate-errors">${errors.map((error) => `<div>${escapeHtml(error)}</div>`).join('')}</div>`
      : '';

    panel.innerHTML = `
      <div class="candidate-head">
        <div class="candidate-mark">P</div>
        <div class="candidate-copy">
          <div class="candidate-title">
            <strong>${escapeHtml(candidate.name || 'Plugin candidate')}</strong>
            <small>${escapeHtml(candidate.version ? `v${candidate.version}` : '')}</small>
            <span class="pill ${statusClass}">${escapeHtml(statusLabel)}</span>
          </div>
          <p>${escapeHtml(candidate.description || (invalid
            ? 'This archive did not pass Harness Desktop validation.'
            : 'Validated and staged. Review the declared permissions before activation.'))}</p>
        </div>
      </div>
      <div class="candidate-meta">${permissionMarkup}${warningMarkup}</div>
      ${errorMarkup}
      <div class="candidate-actions">
        ${ready ? '<button class="btn primary sm" data-candidate="activate">Activate plugin</button>' : ''}
        <button class="btn ghost sm" data-candidate="guide">Plugin format guide</button>
        <button class="btn ghost sm" data-candidate="dismiss">Dismiss</button>
      </div>`;
    panel.classList.remove('hidden');
  };
})();
