const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const appManifest = require('../package.json');

function resolveFromDsh(request) {
  const dshRoot = path.dirname(require.resolve('@deepseek-ai/dsh/package.json'));
  return require.resolve(request, { paths: [dshRoot] });
}

// electron-builder walks `dependencies` only. Anything the engine reaches through
// peerDependencies is present in development (pnpm autoInstallPeers) but is left
// out of the packaged app, which then cannot boot the engine at all. The desktop
// app therefore has to pin that part of the runtime closure itself.
test('the app declares the DSH engine peer dependencies that the packaged build must ship', () => {
  let bootManifestPath;
  try {
    bootManifestPath = resolveFromDsh('@deepseek-ai/dsh-app-boot/package.json');
  } catch {
    assert.fail('@deepseek-ai/dsh-app-boot could not be resolved from the bundled DSH package.');
  }

  const bootManifest = JSON.parse(fs.readFileSync(bootManifestPath, 'utf8'));
  const enginePeers = Object.keys(bootManifest.peerDependencies || {})
    .filter((name) => name.startsWith('@deepseek-ai/'));

  assert.ok(enginePeers.length > 0, 'expected dsh-app-boot to declare @deepseek-ai peer dependencies');

  const declared = new Set(Object.keys(appManifest.dependencies || {}));
  const missing = enginePeers.filter((name) => !declared.has(name));
  assert.deepEqual(missing, [], `these engine peer dependencies would not ship: ${missing.join(', ')}`);
});

// sharp and koffi ship as platform-neutral packages whose native binary lives in a
// platform-specific optionalDependency. electron-builder does not collect those
// either, so the Windows x64 binaries are pinned explicitly.
test('the app pins the win32-x64 native binaries its dependencies need', () => {
  const declared = appManifest.dependencies || {};
  for (const name of ['@img/sharp-win32-x64', '@koromix/koffi-win32-x64']) {
    assert.ok(declared[name], `${name} is not declared, so the packaged build would lack its native binary`);
  }
});

test('the packaging file list still includes everything the app loads at runtime', () => {
  const files = appManifest.build.files;
  for (const entry of ['main.js', 'preload.js', 'lib/**/*', 'src/**/*', 'package.json']) {
    assert.ok(files.includes(entry), `build.files is missing ${entry}`);
  }
});

test('the desktop build ships no browser surface', () => {
  // The native client talks to DSH over process IPC; a webview or bundled web UI
  // would reintroduce exactly the wrapper this build replaced.
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /webviewTag:\s*false/, 'webviewTag must stay disabled');
  assert.doesNotMatch(main, /loadURL\s*\(/, 'the main window must not load a URL');
  assert.match(main, /loadFile\s*\(/, 'the main window must load a local file');

  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.doesNotMatch(preload, /nodeIntegration|require\(['"]node:/, 'preload must not expose Node to the renderer');
});
