const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { listArtifacts, listSkills, readTextFile, isInside, parseFrontmatter } = require('../lib/workspace-files');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('artifact listing reports the storage Harness Desktop actually manages', () => {
  const userData = tmp('hd-art-');
  fs.mkdirSync(path.join(userData, 'plugin-versions', 'dsh-demo', '1.0.0-abc'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'plugin-versions', 'dsh-demo', '1.0.0-abc', 'index.js'), 'x'.repeat(120));
  // node_modules must not be measured, or a real plugin stalls the listing.
  fs.mkdirSync(path.join(userData, 'plugin-versions', 'dsh-demo', '1.0.0-abc', 'node_modules', 'big'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'plugin-versions', 'dsh-demo', '1.0.0-abc', 'node_modules', 'big', 'blob'), 'y'.repeat(50000));

  const snapshot = path.join(userData, 'profile-snapshots', 'snap-1');
  fs.mkdirSync(snapshot, { recursive: true });
  fs.writeFileSync(path.join(snapshot, 'metadata.json'), JSON.stringify({
    id: 'snap-1', reason: 'Before installing dsh-demo@1.0.0', createdAt: '2026-01-01T00:00:00.000Z',
  }));

  fs.writeFileSync(path.join(userData, 'harness-desktop.log'), '{"at":"2026-01-01T00:00:00.000Z"}\n');

  const zip = path.join(userData, 'incoming.zip');
  fs.writeFileSync(zip, 'PK');
  fs.writeFileSync(path.join(userData, 'plugin-state.json'), JSON.stringify({
    candidates: { c1: { id: 'c1', source: zip, status: 'ready' } },
  }));

  const { items } = listArtifacts({ userData });
  const byGroup = (g) => items.filter((i) => i.group === g);

  assert.equal(byGroup('Plugin versions').length, 1);
  assert.equal(byGroup('Restore points')[0].name, 'Before installing dsh-demo@1.0.0');
  assert.equal(byGroup('Received archives')[0].name, 'incoming.zip');
  assert.equal(byGroup('Logs')[0].readable, true);

  const version = byGroup('Plugin versions')[0];
  assert.equal(version.files, 1, 'node_modules was walked');
  assert.ok(version.bytes < 1000, 'node_modules bytes were counted');
});

test('a received archive that has been deleted is reported as missing, not hidden', () => {
  const userData = tmp('hd-art2-');
  fs.writeFileSync(path.join(userData, 'plugin-state.json'), JSON.stringify({
    candidates: { c1: { id: 'c1', source: path.join(userData, 'gone.zip'), status: 'ready' } },
  }));
  const { items } = listArtifacts({ userData });
  assert.equal(items.length, 1);
  assert.equal(items[0].missing, true);
});

test('skills are read from the directories DSH itself loads', () => {
  const workspace = tmp('hd-ws-');
  const home = tmp('hd-home-');

  const a = path.join(workspace, '.dsh', 'skills', 'code-review');
  fs.mkdirSync(a, { recursive: true });
  fs.writeFileSync(path.join(a, 'SKILL.md'),
    '---\nname: code-review\ndescription: Review a diff for correctness bugs.\n---\n\nBody.\n');

  const b = path.join(workspace, '.agents', 'skills', 'release-notes');
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(b, 'SKILL.md'), '---\nname: release-notes\n---\n');

  const c = path.join(home, 'skills', 'from-home');
  fs.mkdirSync(c, { recursive: true });
  fs.writeFileSync(path.join(c, 'SKILL.md'), 'no frontmatter here\n');

  // A directory without SKILL.md is not a skill.
  fs.mkdirSync(path.join(workspace, '.dsh', 'skills', 'not-a-skill'), { recursive: true });

  const { items, roots } = listSkills({ workspace, dshHome: home });
  const names = items.map((i) => i.name).sort();
  assert.deepEqual(names, ['code-review', 'from-home', 'release-notes']);
  assert.equal(items.find((i) => i.name === 'code-review').description, 'Review a diff for correctness bugs.');
  assert.equal(items.find((i) => i.name === 'from-home').source, 'Harness home');
  assert.equal(roots.length, 3);
});

test('frontmatter parsing tolerates quotes and missing blocks', () => {
  assert.deepEqual(parseFrontmatter('---\nname: "x"\ndescription: \'y\'\n---\n'), { name: 'x', description: 'y' });
  assert.deepEqual(parseFrontmatter('no frontmatter'), {});
});

test('reading a file outside managed storage is refused', () => {
  const root = tmp('hd-read-');
  const outside = tmp('hd-out-');
  const inside = path.join(root, 'ok.txt');
  fs.writeFileSync(inside, 'hello');
  const escaped = path.join(outside, 'secret.txt');
  fs.writeFileSync(escaped, 'nope');

  assert.equal(readTextFile({ roots: [root], target: inside }).text, 'hello');
  assert.throws(() => readTextFile({ roots: [root], target: escaped }), /outside Harness Desktop managed storage/);
  assert.throws(
    () => readTextFile({ roots: [root], target: path.join(root, '..', path.basename(outside), 'secret.txt') }),
    /outside Harness Desktop managed storage/,
  );
});

test('isInside does not treat a sibling with a shared prefix as contained', () => {
  assert.equal(isInside('/a/data', '/a/data/child'), true);
  assert.equal(isInside('/a/data', '/a/data'), true);
  assert.equal(isInside('/a/data', '/a/data-other/child'), false);
});

test('a large text file is tail-read rather than loaded whole', () => {
  const root = tmp('hd-big-');
  const file = path.join(root, 'big.log');
  fs.writeFileSync(file, 'A'.repeat(700 * 1024) + 'TAIL');
  const result = readTextFile({ roots: [root], target: file });
  assert.equal(result.truncated, true);
  assert.ok(result.text.endsWith('TAIL'), 'the newest part of the log should survive');
  assert.ok(result.text.length <= 512 * 1024);
});
