const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { validatePluginDirectory } = require('../lib/plugin-validator');

function tempPlugin(manifest, patch = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-plugin-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
  if (patch) fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- id: example\n');
  return dir;
}

test('accepts a standard DSH bundle plugin', () => {
  const dir = tempPlugin({
    name: 'dsh-example',
    version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  });
  const result = validatePluginDirectory(dir);
  assert.equal(result.ok, true);
});

test('rejects a missing DSH bundle declaration', () => {
  const dir = tempPlugin({ name: 'bad-plugin', version: '1.0.0' });
  const result = validatePluginDirectory(dir);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /dsh\.bundle\.patch/);
});

test('rejects a bundle patch escaping the plugin root', () => {
  const dir = tempPlugin({
    name: 'bad-plugin',
    version: '1.0.0',
    dsh: { bundle: { patch: '../outside.yml' } },
  });
  const result = validatePluginDirectory(dir);
  assert.equal(result.ok, false);
});
