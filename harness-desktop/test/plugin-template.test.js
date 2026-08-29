const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');

const { guideText, starterFiles } = require('../lib/plugin-template');
const { validatePluginDirectory, SAFE_PERMISSION_NAMES } = require('../lib/plugin-validator');
const { findPluginRoot } = require('../lib/plugin-manager');

// The guide is only worth shipping if the plugin it describes is one the
// receiver actually accepts, so validate the starter through the real checks.
test('the starter plugin passes the real validator', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-starter-'));
  for (const file of starterFiles()) {
    const full = path.join(root, file.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, file.content);
  }
  const pluginRoot = findPluginRoot(root);
  const result = validatePluginDirectory(pluginRoot);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, [], 'the starter should not declare unknown permissions');
  assert.equal(result.manifest.name, 'dsh-starter-plugin');
});

test('the starter archive has exactly one plugin root and no unsafe paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-starter-zip-'));
  const zip = new AdmZip();
  for (const file of starterFiles()) zip.addFile(file.path, Buffer.from(file.content, 'utf8'));
  const archive = path.join(root, 'starter.zip');
  zip.writeZip(archive);

  const entries = new AdmZip(archive).getEntries().map((e) => e.entryName.replace(/\\/g, '/'));
  assert.ok(entries.length >= 4);
  for (const name of entries) {
    assert.ok(!path.win32.isAbsolute(name), `absolute entry: ${name}`);
    assert.ok(!name.split('/').includes('..'), `traversal entry: ${name}`);
  }
  const roots = new Set(entries.map((e) => e.split('/')[0]));
  assert.equal(roots.size, 1, 'more than one top-level directory would be ambiguous');
});

test('the starter can be renamed and still validates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-starter-named-'));
  for (const file of starterFiles('@acme/dsh-thing')) {
    const full = path.join(root, file.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, file.content);
  }
  // Scoped names nest a directory, so hand the validator the manifest's folder.
  const pluginRoot = path.join(root, '@acme', 'dsh-thing');
  const result = validatePluginDirectory(pluginRoot);
  assert.deepEqual(result.errors, []);
  assert.equal(result.manifest.name, '@acme/dsh-thing');
});

test('the guide documents the limits the receiver enforces', () => {
  const text = guideText();
  for (const needle of [
    '5000',                    // MAX_ARCHIVE_ENTRIES
    '512 MiB',                 // MAX_UNCOMPRESSED_BYTES
    'dsh.bundle.patch',
    'scripts.build',
    'harnessDesktop.permissions',
    'without inject',
  ]) {
    assert.ok(text.includes(needle), `guide is missing "${needle}"`);
  }
  for (const permission of SAFE_PERMISSION_NAMES) {
    assert.ok(text.includes(permission), `guide omits the "${permission}" permission`);
  }
});

test('the guide shows a manifest that validates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-guide-'));
  const { EXAMPLE_MANIFEST } = require('../lib/plugin-template');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(EXAMPLE_MANIFEST));
  fs.writeFileSync(path.join(root, 'cordis.patch.yml'), '- id: x\n');
  const result = validatePluginDirectory(root);
  assert.deepEqual(result.errors, [], 'the documented example must itself be valid');
});
