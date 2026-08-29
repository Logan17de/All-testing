// Provider configuration and credentials against the real engine.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP = require('node:path').resolve(__dirname, '..', '..');
const { HarnessRuntime } = require(path.join(APP, 'lib', 'runtime'));

const DSH_HOME = process.env.DSH_HOME;
const BACKUP = path.join(os.tmpdir(), 'prov-backup-' + Date.now());

const steps = [];
const step = (n, ok, d) => { steps.push({ n, ok }); console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '\n        ' + d : '')); };

async function main() {
  // Back up only the mutable config files: copying the whole home dereferences
  // pnpm's symlinks and breaks the profile.
  const CONFIG = ['settings.yaml', '.credentials.yaml'];
  fs.mkdirSync(BACKUP, { recursive: true });
  for (const name of CONFIG) {
    const src = path.join(DSH_HOME, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(BACKUP, name));
  }
  const runtime = new HarnessRuntime({ appRoot: APP, logger: () => {} });

  try {
    await runtime.start(APP);

    const before = await runtime.request('settings.describe', {});
    const custom = before.namespaces.find((n) => n.ns === 'llm-pi-ai');
    step('1. the configurable provider namespace exists and is writable',
      Boolean(custom), `llm-pi-ai revision=${custom?.revision}`);
    step('2. it starts with no custom providers',
      Object.keys(custom?.value?.providers || {}).length === 0,
      JSON.stringify(custom?.value?.providers || {}));

    // Write a custom provider exactly as provider:save does.
    const ref = 'E2E_TEST_API_KEY';
    await runtime.request('credentials.set', { ref, value: 'sk-e2e-not-a-real-key' });
    await runtime.request('settings.mutate', {
      ns: 'llm-pi-ai',
      expectedRevision: custom.revision,
      ops: [{
        op: 'set',
        path: ['providers', 'e2e-test-route'],
        value: { api: 'openai-completions', baseURL: 'https://example.invalid/v1', apiKeyEnv: ref, models: [{ id: 'e2e-model', name: 'e2e-model' }] },
      }],
    });

    const after = await runtime.request('settings.describe', {});
    const written = after.namespaces.find((n) => n.ns === 'llm-pi-ai');
    step('3. a custom provider persists into llm-pi-ai',
      Boolean(written?.value?.providers?.['e2e-test-route']),
      JSON.stringify(written?.value?.providers?.['e2e-test-route'] || null));

    const creds = await runtime.request('credentials.describe', { refs: [ref] });
    step('4. its credential is stored and reported as configured',
      creds.credentials?.[ref]?.configured === true, JSON.stringify(creds.credentials?.[ref]));

    // The route should now show up as a real provider.
    const routes = (await runtime.request('llm.providers', {})).providers || [];
    const route = routes.find((p) => p.provider === 'e2e-test-route');
    step('5. the engine now lists it as a route', Boolean(route), JSON.stringify(route || null));

    // The two presets the UI offers must be accepted by the engine.
    const presets = [
      { id: 'anthropic', api: 'anthropic-messages', baseURL: 'https://api.anthropic.com/v1', ref: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-4-5' },
      { id: 'openai-responses', api: 'openai-responses', baseURL: 'https://api.openai.com/v1', ref: 'OPENAI_API_KEY', model: 'gpt-5.1' },
    ];
    for (const preset of presets) {
      const ns = (await runtime.request('settings.describe', {})).namespaces.find((n) => n.ns === 'llm-pi-ai');
      await runtime.request('credentials.set', { ref: preset.ref, value: 'sk-e2e-placeholder' });
      await runtime.request('settings.mutate', {
        ns: 'llm-pi-ai', expectedRevision: ns.revision,
        ops: [{ op: 'set', path: ['providers', preset.id], value: { api: preset.api, baseURL: preset.baseURL, apiKeyEnv: preset.ref, models: [{ id: preset.model, name: preset.model }] } }],
      });
    }
    const withPresets = (await runtime.request('llm.providers', {})).providers || [];
    const active = withPresets.filter((p) => p.active).map((p) => p.provider);
    step('7. the Claude and OpenAI presets are accepted by the engine',
      active.includes('anthropic') && active.includes('openai-responses'),
      'active routes: ' + active.join(', '));
    for (const preset of presets) {
      const ns = (await runtime.request('settings.describe', {})).namespaces.find((n) => n.ns === 'llm-pi-ai');
      await runtime.request('settings.mutate', { ns: 'llm-pi-ai', expectedRevision: ns.revision, ops: [{ op: 'unset', path: ['providers', preset.id] }] });
      await runtime.request('credentials.unset', { ref: preset.ref });
    }

    // And it can be removed again.
    const latest = (await runtime.request('settings.describe', {})).namespaces.find((n) => n.ns === 'llm-pi-ai');
    await runtime.request('settings.mutate', {
      ns: 'llm-pi-ai',
      expectedRevision: latest.revision,
      ops: [{ op: 'unset', path: ['providers', 'e2e-test-route'] }],
    });
    await runtime.request('credentials.unset', { ref });
    const cleaned = (await runtime.request('settings.describe', {})).namespaces.find((n) => n.ns === 'llm-pi-ai');
    const clearedCreds = await runtime.request('credentials.describe', { refs: [ref] });
    step('6. removing the provider and clearing its credential works',
      !cleaned?.value?.providers?.['e2e-test-route'] && clearedCreds.credentials?.[ref]?.configured !== true,
      `providers=${JSON.stringify(cleaned?.value?.providers || {})}`);
  } catch (error) {
    console.log('\nABORTED: ' + error.message);
    steps.push({ n: 'aborted', ok: false });
  } finally {
    await runtime.stop();
    // Restore ONLY the files that were backed up. Wiping DSH_HOME here deleted
    // the whole profile tree, because BACKUP holds just the two config files.
    for (const name of CONFIG) {
      const saved = path.join(BACKUP, name);
      const live = path.join(DSH_HOME, name);
      if (fs.existsSync(saved)) fs.copyFileSync(saved, live);
      else if (fs.existsSync(live)) fs.rmSync(live);
    }
    fs.rmSync(BACKUP, { recursive: true, force: true });
    console.log('\nconfig restored.');
    const failed = steps.filter((s) => !s.ok);
    console.log(`\n===== PROVIDERS SUMMARY =====\n${steps.length - failed.length}/${steps.length} passed`);
    process.exit(failed.length ? 1 : 0);
  }
}

main();
