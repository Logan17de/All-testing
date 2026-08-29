(() => {
  'use strict';
  if (window.__HARNESS_DETACHED_PREVIEWS__) return;
  window.__HARNESS_DETACHED_PREVIEWS__ = true;

  const style = document.createElement('style');
  style.textContent = `
    .enhanced-artifact-popup.detached {
      position: fixed !important;
      z-index: 130;
      top: 84px;
      right: 34px;
      width: min(560px, calc(100vw - 70px));
      height: min(520px, calc(100vh - 130px)) !important;
      min-width: 320px;
      min-height: 190px;
      max-width: calc(100vw - 24px);
      max-height: calc(100vh - 24px);
      resize: both;
      overflow: hidden;
      box-shadow: 0 28px 90px rgba(0,0,0,.62);
    }
    .enhanced-artifact-popup.detached .enhanced-artifact-head { cursor: move; user-select: none; }
    .enhanced-artifact-popup.detached .artifact-resize-grip { display: none; }
  `;
  document.head.appendChild(style);

  const detached = new Set();
  const stack = document.querySelector('#viewerCol');
  if (!stack) return;

  const keyFor = (panel) => panel?.querySelector('.enhanced-artifact-head strong')?.getAttribute('title')
    || panel?.querySelector('.enhanced-artifact-head strong')?.textContent
    || '';

  function applyDetachedState() {
    stack.querySelectorAll('.enhanced-artifact-popup').forEach((panel) => {
      const key = keyFor(panel);
      const isDetached = detached.has(key);
      panel.classList.toggle('detached', isDetached);
      const button = panel.querySelector('[data-enhanced-popout]');
      if (button) {
        button.title = isDetached ? 'Dock preview' : 'Pop out preview';
        button.setAttribute('aria-label', isDetached ? 'Dock preview' : 'Pop out preview');
        button.textContent = isDetached ? '↙' : '↗';
      }
    });
  }

  stack.addEventListener('click', (event) => {
    const popout = event.target.closest('[data-enhanced-popout]');
    if (popout) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const panel = popout.closest('.enhanced-artifact-popup');
      const key = keyFor(panel);
      if (!key) return;
      if (detached.has(key)) {
        detached.delete(key);
        panel.style.left = '';
        panel.style.top = '';
        panel.style.right = '';
      } else {
        detached.add(key);
      }
      applyDetachedState();
      return;
    }

    const close = event.target.closest('[data-enhanced-close]');
    if (close) {
      const key = keyFor(close.closest('.enhanced-artifact-popup'));
      if (key) detached.delete(key);
      return;
    }

    const maximize = event.target.closest('[data-enhanced-maximize]');
    if (maximize) {
      const panel = maximize.closest('.enhanced-artifact-popup');
      const key = keyFor(panel);
      if (key && detached.has(key)) {
        detached.delete(key);
        panel.classList.remove('detached');
      }
    }
  }, true);

  stack.addEventListener('pointerdown', (event) => {
    const head = event.target.closest('.enhanced-artifact-head');
    if (!head || event.target.closest('button')) return;
    const panel = head.closest('.enhanced-artifact-popup.detached');
    if (!panel) return;

    const rect = panel.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = rect.left;
    const startTop = rect.top;
    head.setPointerCapture(event.pointerId);

    const move = (moveEvent) => {
      const maxLeft = Math.max(8, window.innerWidth - panel.offsetWidth - 8);
      const maxTop = Math.max(8, window.innerHeight - panel.offsetHeight - 8);
      const left = Math.max(8, Math.min(maxLeft, startLeft + moveEvent.clientX - startX));
      const top = Math.max(8, Math.min(maxTop, startTop + moveEvent.clientY - startY));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = 'auto';
    };
    const done = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', done);
      head.removeEventListener('pointercancel', done);
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', done);
    head.addEventListener('pointercancel', done);
  });

  new MutationObserver(applyDetachedState).observe(stack, { childList: true, subtree: true });
  applyDetachedState();
})();
