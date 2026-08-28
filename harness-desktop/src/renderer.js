const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let latestStatus = null;
let currentCandidate = null;
let toastTimer;

function toast(message) {
  const box = $('#toast');
  box.textContent = message;
  box.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.add('hidden'), 4500);
}

function showPage(id) {
  $$('.page').forEach((page) => page.classList.toggle('active', page.id === id));
  $$('.nav').forEach((nav) => nav.classList.toggle('active', nav.dataset.page === id));
  if (id === 'plugins') refreshPlugins();
  if (id === 'logs') refreshLogs();
  if (id === 'harness') refreshHarnessView();
}

async function refreshStatus() {
  latestStatus = await window.desktop.getStatus();
  const healthy = latestStatus.healthy;
  $('#statusDot').className = `dot ${healthy ? 'good' : 'bad'}`;
  $('#statusText').textContent = latestStatus.safeMode ? 'Safe Mode' : healthy ? 'Harness online' : 'Harness offline';
  $('#healthCard').textContent = latestStatus.safeMode ? 'Safe Mode' : healthy ? 'Healthy' : 'Offline';
  $('#runtimeUrl').textContent = latestStatus.url;
  $('#dshVersion').textContent = latestStatus.dshVersion;
  $('#workspaceCard').textContent = latestStatus.workspace || 'Not selected';
  $('#workspaceInput').value = latestStatus.workspace || '';
  $('#dshHomeInput').value = latestStatus.dshHome || '';
  $('#safeModeBanner').classList.toggle('hidden', !latestStatus.safeMode);
  $('#webviewFallback').classList.toggle('hidden', healthy);
}

function refreshHarnessView() {
  const view = $('#harnessView');
  if (latestStatus?.healthy) {
    const url = `${latestStatus.url}?desktop=${Date.now()}`;
    if (!view.src.startsWith(latestStatus.url)) view.src = url;
  }
}

async function refreshPlugins() {
  const data = await window.desktop.listPlugins();
  const installed = $('#installedPlugins');
  if (!data.installed.length) {
    installed.className = 'list empty';
    installed.textContent = 'No tracked plugins yet.';
  } else {
    installed.className = 'list';
    installed.innerHTML = data.installed.map((plugin) => `
      <div class="list-item">
        <div><strong>${escapeHtml(plugin.name)}</strong><small>${escapeHtml(plugin.version)} · active</small></div>
        <button class="disable-plugin" data-name="${escapeAttr(plugin.name)}">Disable</button>
      </div>`).join('');
  }

  const history = $('#pluginHistory');
  if (!data.history.length) {
    history.className = 'list empty';
    history.textContent = 'No restore points yet.';
  } else {
    history.className = 'list';
    history.innerHTML = data.history.map((item) => `
      <div class="list-item"><div><strong>${escapeHtml(item.type)} · ${escapeHtml(item.plugin || 'profile')}</strong><small>${new Date(item.createdAt).toLocaleString()}</small></div></div>`).join('');
  }
}

function showCandidate(candidate) {
  currentCandidate = candidate;
  const box = $('#pluginCandidate');
  box.classList.remove('hidden');
  if (candidate.status === 'invalid') {
    box.innerHTML = `<h2>Plugin rejected</h2><p class="error-text">${candidate.validation.errors.map(escapeHtml).join('<br>')}</p>`;
    return;
  }

  const permissions = candidate.permissions?.length
    ? candidate.permissions.map((item) => `<span class="badge">${escapeHtml(item)}</span>`).join('')
    : '<span class="badge">No extra permissions declared</span>';
  const warnings = candidate.validation?.warnings?.length
    ? `<p class="muted">${candidate.validation.warnings.map(escapeHtml).join(' · ')}</p>`
    : '';
  box.innerHTML = `
    <div class="candidate-grid">
      <div><span class="eyebrow">Ready to activate</span><h2>${escapeHtml(candidate.name)} <span class="muted">${escapeHtml(candidate.version)}</span></h2><p>${escapeHtml(candidate.description || 'No description provided.')}</p><div>${permissions}</div>${warnings}</div>
      <button id="activateCandidate" class="primary">Activate & restart</button>
    </div>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}
function escapeAttr(value) { return escapeHtml(value); }

async function refreshLogs() {
  const items = await window.desktop.getLogs();
  $('#logOutput').textContent = items.map(formatLog).join('\n');
  $('#logOutput').scrollTop = $('#logOutput').scrollHeight;
}
function formatLog(item) { return `${item.at.slice(11, 19)}  [${item.source}]  ${item.message}`; }

$$('.nav').forEach((button) => button.addEventListener('click', () => showPage(button.dataset.page)));
$('[data-page-target="harness"]').addEventListener('click', () => showPage('harness'));

$('#startHarness').addEventListener('click', async () => {
  const result = await window.desktop.startHarness();
  toast(result.ok ? 'Harness started.' : 'Harness failed to start. Check Logs.');
  await refreshStatus();
});
$('#restartHarness').addEventListener('click', async () => {
  const result = await window.desktop.restartHarness();
  toast(result.ok ? 'Harness restarted.' : 'Restart failed. Check Logs.');
  await refreshStatus();
});
$('#refreshHarness').addEventListener('click', async () => {
  await refreshStatus();
  $('#harnessView').reloadIgnoringCache();
});
$('#chooseWorkspace').addEventListener('click', async () => {
  const workspace = await window.desktop.chooseWorkspace();
  if (workspace) {
    $('#workspaceInput').value = workspace;
    toast('Workspace updated. Restart Harness to apply it.');
    await refreshStatus();
  }
});
$('#receivePlugin').addEventListener('click', async () => {
  try {
    $('#receivePlugin').disabled = true;
    $('#receivePlugin').textContent = 'Checking plugin…';
    const candidate = await window.desktop.receivePlugin();
    if (candidate) showCandidate(candidate);
  } catch (error) {
    toast(`Plugin check failed: ${error.message}`);
  } finally {
    $('#receivePlugin').disabled = false;
    $('#receivePlugin').textContent = 'Receive plugin .zip';
  }
});
$('#pluginCandidate').addEventListener('click', async (event) => {
  if (event.target.id !== 'activateCandidate' || !currentCandidate) return;
  event.target.disabled = true;
  event.target.textContent = 'Activating…';
  try {
    await window.desktop.activatePlugin(currentCandidate.id);
    toast('Plugin verified. Restarting desktop app…');
    setTimeout(() => window.desktop.relaunch(), 900);
  } catch (error) {
    toast(error.message);
    event.target.disabled = false;
    event.target.textContent = 'Activate & restart';
    await refreshPlugins();
  }
});
$('#installedPlugins').addEventListener('click', async (event) => {
  const button = event.target.closest('.disable-plugin');
  if (!button) return;
  try {
    button.disabled = true;
    await window.desktop.disablePlugin(button.dataset.name);
    toast('Plugin disabled. Restarting desktop app…');
    setTimeout(() => window.desktop.relaunch(), 900);
  } catch (error) {
    toast(error.message);
    button.disabled = false;
  }
});
$('#rollbackPlugin').addEventListener('click', async () => {
  try {
    $('#rollbackPlugin').disabled = true;
    await window.desktop.rollbackPlugin();
    toast('Previous profile restored. Restarting desktop app…');
    setTimeout(() => window.desktop.relaunch(), 900);
  } catch (error) {
    toast(error.message);
    $('#rollbackPlugin').disabled = false;
  }
});
$('#refreshPlugins').addEventListener('click', refreshPlugins);
$('#testApi').addEventListener('click', async () => {
  const result = $('#apiResult');
  result.textContent = 'Testing…';
  const response = await window.desktop.testApi({ baseUrl: $('#apiBaseUrl').value, apiKey: $('#apiKey').value });
  result.className = response.ok ? 'success-text' : 'error-text';
  result.textContent = response.ok ? `Connected · HTTP ${response.status}` : response.error || 'Connection failed';
});
$('#clearLogView').addEventListener('click', () => { $('#logOutput').textContent = ''; });
window.desktop.onLog((item) => {
  const output = $('#logOutput');
  output.textContent += `${output.textContent ? '\n' : ''}${formatLog(item)}`;
  output.scrollTop = output.scrollHeight;
});
window.desktop.onHarnessStatus(refreshStatus);

refreshStatus().then(refreshHarnessView);
refreshPlugins();
