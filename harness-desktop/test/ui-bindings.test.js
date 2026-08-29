const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SRC = path.join(__dirname, '..', 'src');
const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(SRC, 'renderer.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

const ids = new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));

// A handler bound to a removed element used to throw at load and leave every
// later control unbound, so this is checked statically as well as at runtime.
test('every bound selector matches an element in the markup', () => {
  const bound = [...renderer.matchAll(/\bon\('#([A-Za-z0-9_-]+)',/g)].map((m) => m[1]);
  assert.ok(bound.length > 30, `expected many bindings, found ${bound.length}`);
  const missing = [...new Set(bound)].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `these handlers target elements that no longer exist: ${missing.join(', ')}`);
});

test('no binding uses the unguarded form that can abort the script', () => {
  const raw = [...renderer.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)\.addEventListener\(/g)].map((m) => m[1]);
  assert.deepEqual(raw, [], `use on('#id', …) instead of $('#id').addEventListener for: ${raw.join(', ')}`);
});

test('every element the renderer reads by id exists in the markup', () => {
  const read = [...new Set([...renderer.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]))];
  const missing = read.filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `renderer reads missing elements: ${missing.join(', ')}`);
});

test('the settings modal only ships panes that have a nav entry', () => {
  const navs = new Set([...html.matchAll(/class="mnav[^"]*" data-pane="([a-z]+)"/g)].map((m) => m[1]));
  const panes = new Set([...html.matchAll(/class="pane[^"]*" data-pane="([a-z]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...panes].filter((p) => !navs.has(p)), [], 'orphan pane with no tab');
  assert.deepEqual([...navs].filter((n) => !panes.has(n)), [], 'tab with no pane');
});

// The renderer must never ship sample content. Everything on screen has to come
// from the engine or the filesystem, so a disconnected app shows empty states
// rather than a convincing-looking demo.
test('the renderer ships no fabricated data', () => {
  const banned = [
    'makePreviewBridge', 'PREVIEW',
    'All-testing', 'Rive_Rider', 'Language-Learning-App',
    'code-inspector', 'snapshot-manager', 'auth-bridge',
    'stability test plan', 'harness-desktop-v1',
    'plugin-review', 'triage-failure',
    'Preview content', 'Demo plugin', 'dsh-demo',
  ];
  const found = banned.filter((needle) => renderer.includes(needle));
  assert.deepEqual(found, [], `sample content found in renderer.js: ${found.join(', ')}`);
});

test('a disconnected renderer fails calls instead of inventing data', () => {
  assert.match(renderer, /const CONNECTED = typeof window\.desktop !== 'undefined'/);
  assert.match(renderer, /is not connected to its engine/);
  // No object literal standing in for engine responses.
  assert.doesNotMatch(renderer, /listPlugins:\s*async\s*\(\)\s*=>/, 'a stub bridge is still present');
  assert.doesNotMatch(renderer, /getSessionHistory:\s*async\s*\(\)\s*=>/, 'a stub bridge is still present');
});

test('provider presets use protocols the engine accepts', () => {
  const protocols = [...html.matchAll(/<option value="([a-z-]+)">/g)].map((m) => m[1]);
  for (const preset of ['anthropic-messages', 'openai-responses']) {
    assert.ok(protocols.includes(preset), `${preset} is not offered in the protocol list`);
    assert.ok(renderer.includes(preset), `${preset} is not used by any preset`);
  }
});

test('chat owns connection startup and exposes model plus reasoning effort controls', () => {
  assert.equal(ids.has('startEngine'), false);
  assert.equal(ids.has('effortSelect'), true);
  assert.match(renderer, /if \(e\.target\.value\.trim\(\)\) void ensureConnected\(\)/);
  assert.match(renderer, /if \(!await ensureConnected\(\)\) return/);
  assert.match(renderer, /reasoningEffort: event\.target\.value/);
});

test('provider setup discovers models and starts real authorization flows', () => {
  assert.match(renderer, /desktop\.discoverProviderModels\(providerConfig\(\)\)/);
  assert.match(renderer, /desktop\.beginAuthorization/);
  assert.match(renderer, /event\?\.stream === 'authorization'/);
});

test('main-process renderer sends are guarded against a closed Electron window', () => {
  assert.match(main, /function canSendToRenderer\(\)/);
  assert.match(main, /!mainWindow\.isDestroyed\(\)/);
  assert.match(main, /!mainWindow\.webContents\.isDestroyed\(\)/);
  assert.doesNotMatch(main, /mainWindow\?\.webContents\.send\(/,
    'direct optional-chained sends can still throw after BrowserWindow destruction');
});
