const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const { validatePluginDirectory } = require('../lib/plugin-validator');

const PLUGIN = path.join(__dirname, '..', 'plugins', 'dsh-copycat-chatgpt-bridge');

function ok(value) {
  return { result: { ok: true, value } };
}

test('Copycat bridge is a valid Harness Desktop plugin', () => {
  const result = validatePluginDirectory(PLUGIN);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.manifest.name, 'dsh-copycat-chatgpt-bridge');
  assert.equal(result.manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.deepEqual(result.permissions.sort(), ['filesystem', 'network', 'workspace']);
});

test('Copycat bridge exposes an authenticated loopback Session API', async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'copycat-bridge-test-'));
  const previous = {
    DSH_HOME: process.env.DSH_HOME,
    COPYCAT_BRIDGE_PORT: process.env.COPYCAT_BRIDGE_PORT,
    COPYCAT_BRIDGE_TOKEN: process.env.COPYCAT_BRIDGE_TOKEN,
    COPYCAT_BRIDGE_HOST: process.env.COPYCAT_BRIDGE_HOST,
  };
  process.env.DSH_HOME = scratch;
  process.env.COPYCAT_BRIDGE_PORT = '0';
  process.env.COPYCAT_BRIDGE_TOKEN = 'unit-test-copycat-token';
  process.env.COPYCAT_BRIDGE_HOST = '127.0.0.1';

  let dispose = null;
  const calls = [];
  const apiProxy = {
    sessions: {
      create: async request => {
        calls.push(['create', request]);
        return ok({ sessionId: 'session-copycat-1' });
      },
      list: async request => {
        calls.push(['list', request]);
        return ok({ items: [{ sessionId: 'session-copycat-1' }] });
      },
      history: async request => {
        calls.push(['history', request]);
        return ok({ events: [] });
      },
      prompt: async request => {
        calls.push(['prompt', request]);
        return ok({ queued: true });
      },
      cancel: async request => {
        calls.push(['cancel', request]);
        return ok({ cancelled: true });
      },
    },
    events: {
      mux: async function* () {
        yield { rpcId: 'test-mux', payload: { type: 'test-event', sessionId: 'session-copycat-1' } };
      },
      host: async function* () {
        yield { rpcId: 'test-host', payload: { type: 'ready' } };
      },
    },
  };
  const ctx = {
    apiProxy,
    logger: { info() {}, warn() {} },
    on(event, handler) {
      if (event === 'dispose') dispose = handler;
    },
  };

  t.after(async () => {
    try { dispose?.(); } catch {}
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise(resolve => setTimeout(resolve, 30));
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const moduleUrl = `${pathToFileURL(path.join(PLUGIN, 'index.js')).href}?test=${Date.now()}`;
  const plugin = await import(moduleUrl);
  await plugin.apply(ctx);

  const discovery = JSON.parse(fs.readFileSync(path.join(scratch, 'copycat-bridge', 'bridge.json'), 'utf8'));
  assert.match(discovery.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/api\/bridge$/);
  assert.equal(discovery.token, 'unit-test-copycat-token');

  const unauthorized = await fetch(`${discovery.baseUrl}/status`);
  assert.equal(unauthorized.status, 401);

  const headers = {
    Authorization: `Bearer ${discovery.token}`,
    'Content-Type': 'application/json',
  };
  const status = await fetch(`${discovery.baseUrl}/status`, { headers }).then(r => r.json());
  assert.equal(status.ok, true);
  assert.equal(status.harness.ready, true);

  const attachment = path.join(scratch, 'screen.png');
  fs.writeFileSync(attachment, 'not-really-an-image');
  const sent = await fetch(`${discovery.baseUrl}/message`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      text: 'Inspect the screenshot and fix the UI.',
      attachments: [attachment],
      cwd: scratch,
    }),
  });
  assert.equal(sent.status, 202);
  const result = await sent.json();
  assert.equal(result.ok, true);
  assert.equal(result.session_id, 'session-copycat-1');
  assert.equal(result.created_session, true);

  const createCall = calls.find(([kind]) => kind === 'create');
  assert.equal(createCall[1].payload.cwd, scratch);
  const promptCall = calls.find(([kind]) => kind === 'prompt');
  assert.equal(promptCall[1].payload.sessionId, 'session-copycat-1');
  assert.equal(promptCall[1].payload.mode, 'queue');
  assert.match(promptCall[1].payload.content[0].text, /Inspect the screenshot/);
  assert.match(promptCall[1].payload.content[0].text, /screen\.png/);
});
