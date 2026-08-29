const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const enhancements = fs.readFileSync(path.join(ROOT, 'src', 'enhancements.js'), 'utf8');
const detached = fs.readFileSync(path.join(ROOT, 'src', 'detached-previews.js'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

test('enhancement scripts parse as JavaScript', () => {
  assert.doesNotThrow(() => new Function(enhancements));
  assert.doesNotThrow(() => new Function(detached));
});

test('left rail keeps Plugins, Artifacts, and Skills together in that order', () => {
  const plugins = html.indexOf('data-view="plugins"');
  const artifacts = html.indexOf('data-view="artifacts"');
  const skills = html.indexOf('data-view="skills"');
  assert.ok(plugins >= 0 && artifacts > plugins && skills > artifacts);
});

test('settings usage never invents unavailable values', () => {
  assert.match(preload, /function normalizeUsage/);
  assert.match(preload, /available: used !== null \|\| remaining !== null/);
  assert.match(enhancements, /Used/);
  assert.match(enhancements, /Remaining/);
  assert.match(enhancements, /Refresh in/);
  assert.match(enhancements, /Unknown/);
  assert.match(enhancements, /Harness never guesses a quota/);
});

test('artifact previews expose close maximize detach and resize controls', () => {
  assert.match(enhancements, /data-enhanced-close/);
  assert.match(enhancements, /data-enhanced-maximize/);
  assert.match(enhancements, /data-enhanced-popout/);
  assert.match(enhancements, /data-enhanced-resize/);
  assert.match(detached, /\.enhanced-artifact-popup\.detached/);
  assert.match(detached, /resize: both/);
  assert.match(detached, /cursor: move/);
});

test('chat attachment blocks can open artifact previews', () => {
  assert.match(enhancements, /function artifactBlocks/);
  assert.match(enhancements, /chat-artifact-chips/);
  assert.match(enhancements, /getSessionHistory/);
  assert.match(enhancements, /openArtifactPopup/);
});

test('skills can be created only through the workspace-scoped save API', () => {
  assert.match(preload, /\.dsh\/skills\/\$\{slug\}\/SKILL\.md/);
  assert.match(preload, /workspace:saveFile/);
  assert.doesNotMatch(preload, /require\(['"]node:fs['"]\)/);
});

test('enhancement scripts are loaded by the preload and engine status is visible in the rail', () => {
  assert.match(preload, /enhancements\.js/);
  assert.match(preload, /detached-previews\.js/);
  assert.match(enhancements, /enhancedEngineCard/);
  assert.match(enhancements, /Engine online/);
});

test('main-process renderer sends stay guarded after the UX additions', () => {
  assert.match(main, /function canSendToRenderer\(\)/);
  assert.doesNotMatch(main, /mainWindow\?\.webContents\.send\(/);
});
