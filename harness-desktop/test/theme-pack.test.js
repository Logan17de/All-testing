const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN = path.join(ROOT, 'plugins', 'dsh-harness-theme-pack');
const { validatePluginDirectory } = require(path.join(ROOT, 'lib', 'plugin-validator'));

const EXPECTED = [
  'deep-ocean',
  'midnight-purple',
  'carbon-green',
  'amber-night',
  'ocean-blue',
  'forest-green',
  'purple-twilight',
  'warm-sand',
];

test('theme pack is a valid Harness Desktop plugin', () => {
  const result = validatePluginDirectory(PLUGIN);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(result.permissions, ['ui']);
});

test('theme pack declares all eight requested themes with required color roles', () => {
  const pack = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'themes.json'), 'utf8'));
  assert.equal(pack.schema, 1);
  assert.deepEqual(pack.themes.map(theme => theme.id), EXPECTED);
  for (const theme of pack.themes) {
    assert.match(theme.name, /\S/);
    assert.ok(['dark', 'light'].includes(theme.mode));
    for (const key of ['--bg', '--bg-rail', '--panel', '--text', '--blue', '--rail-active']) {
      assert.equal(typeof theme.variables[key], 'string', `${theme.id} is missing ${key}`);
      assert.match(theme.variables[key], /\S/);
    }
  }
});

test('desktop preload loads the generic theme contribution runtime', () => {
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const runtime = fs.readFileSync(path.join(ROOT, 'src', 'themes.js'), 'utf8');
  assert.match(preload, /themes\.js/);
  assert.match(runtime, /themes\.json/);
  assert.match(runtime, /harness-desktop\.theme\.v1/);
  assert.match(runtime, /permissions\.includes\('ui'\)/);
});
