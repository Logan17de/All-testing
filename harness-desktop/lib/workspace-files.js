const fs = require('node:fs');
const path = require('node:path');

// Directory scans are bounded so a plugin that ships a huge tree cannot stall the
// UI thread that asked for a listing.
const MAX_ENTRIES = 4000;
const MAX_TEXT_BYTES = 512 * 1024;
const SKILL_DIRS = [
  ['workspace', path.join('.dsh', 'skills')],
  ['workspace', path.join('.agents', 'skills')],
  ['home', 'skills'],
];

function statOrNull(target) {
  try { return fs.statSync(target); } catch { return null; }
}

function canonicalPath(target) {
  const resolved = path.resolve(target);
  try { return fs.realpathSync.native(resolved); } catch {}
  let existing = resolved;
  const missing = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return resolved;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  try { return path.join(fs.realpathSync.native(existing), ...missing); }
  catch { return resolved; }
}

/** True when `target` resolves inside `root`, including across symlinks/junctions. */
function isInside(root, target) {
  if (!root || !target) return false;
  const base = canonicalPath(root);
  const resolved = canonicalPath(target);
  if (resolved === base) return true;
  return resolved.startsWith(base + path.sep);
}

/** Recursive size that skips node_modules and stops at MAX_ENTRIES. */
function measureTree(dir) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length && files < MAX_ENTRIES) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      const stat = statOrNull(full);
      if (!stat) continue;
      bytes += stat.size;
      files += 1;
      if (files >= MAX_ENTRIES) break;
    }
  }
  return { bytes, files, truncated: files >= MAX_ENTRIES };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/**
 * Everything Harness Desktop itself produced: staged plugin versions, profile
 * snapshots, the archives it was handed, and the app log. These are real files on
 * disk rather than a synthetic artifact store.
 */
function listArtifacts({ userData }) {
  const items = [];
  if (!userData) return { items };

  const versionsDir = path.join(userData, 'plugin-versions');
  for (const pkg of safeReaddir(versionsDir)) {
    if (!pkg.isDirectory()) continue;
    for (const version of safeReaddir(path.join(versionsDir, pkg.name))) {
      if (!version.isDirectory()) continue;
      const full = path.join(versionsDir, pkg.name, version.name);
      const stat = statOrNull(full);
      const size = measureTree(full);
      items.push({
        id: `version:${pkg.name}/${version.name}`,
        group: 'Plugin versions',
        name: `${pkg.name} ${version.name}`,
        kind: 'BUILD',
        path: full,
        directory: true,
        bytes: size.bytes,
        files: size.files,
        modifiedAt: stat ? stat.mtime.toISOString() : null,
      });
    }
  }

  const snapshotsDir = path.join(userData, 'profile-snapshots');
  for (const snap of safeReaddir(snapshotsDir)) {
    if (!snap.isDirectory()) continue;
    const full = path.join(snapshotsDir, snap.name);
    const meta = readJson(path.join(full, 'metadata.json'), null);
    const stat = statOrNull(full);
    const size = measureTree(full);
    items.push({
      id: `snapshot:${snap.name}`,
      group: 'Restore points',
      name: meta?.reason || snap.name,
      kind: 'SNAP',
      path: full,
      directory: true,
      bytes: size.bytes,
      files: size.files,
      modifiedAt: meta?.createdAt || (stat ? stat.mtime.toISOString() : null),
    });
  }

  const state = readJson(path.join(userData, 'plugin-state.json'), null);
  for (const candidate of Object.values(state?.candidates || {})) {
    if (!candidate?.source) continue;
    const stat = statOrNull(candidate.source);
    items.push({
      id: `archive:${candidate.id}`,
      group: 'Received archives',
      name: path.basename(candidate.source),
      kind: 'ZIP',
      path: candidate.source,
      directory: false,
      missing: !stat,
      status: candidate.status,
      bytes: stat ? stat.size : 0,
      modifiedAt: stat ? stat.mtime.toISOString() : null,
    });
  }

  const logFile = path.join(userData, 'harness-desktop.log');
  const logStat = statOrNull(logFile);
  if (logStat) {
    items.push({
      id: 'log:app',
      group: 'Logs',
      name: 'harness-desktop.log',
      kind: 'LOG',
      path: logFile,
      directory: false,
      bytes: logStat.size,
      modifiedAt: logStat.mtime.toISOString(),
      readable: true,
    });
  }

  items.sort((a, b) => String(b.modifiedAt || '').localeCompare(String(a.modifiedAt || '')));
  return { items };
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/** Minimal YAML frontmatter reader — enough for a skill's name and description. */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const meta = {};
  if (!match) return meta;
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!pair) continue;
    meta[pair[1]] = pair[2].replace(/^["']|["']$/g, '').trim();
  }
  return meta;
}

/**
 * DSH loads skills from `<workspace>/.dsh/skills`, `<workspace>/.agents/skills`
 * and `$DSH_HOME/skills`; each skill is a directory holding a SKILL.md.
 */
function listSkills({ workspace, dshHome }) {
  const roots = [];
  for (const [base, relative] of SKILL_DIRS) {
    const root = base === 'workspace' ? workspace : dshHome;
    if (!root) continue;
    roots.push({ label: base === 'workspace' ? 'Workspace' : 'Harness home', dir: path.join(root, relative) });
  }

  const items = [];
  for (const root of roots) {
    for (const entry of safeReaddir(root.dir)) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root.dir, entry.name);
      const manifest = path.join(dir, 'SKILL.md');
      const stat = statOrNull(manifest);
      if (!stat) continue;
      let meta = {};
      try { meta = parseFrontmatter(fs.readFileSync(manifest, 'utf8').slice(0, 8192)); } catch {}
      items.push({
        id: `${root.label}:${entry.name}`,
        name: meta.name || entry.name,
        description: meta.description || '',
        source: root.label,
        dir,
        manifest,
        modifiedAt: stat.mtime.toISOString(),
      });
    }
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { items, roots: roots.map((r) => r.dir) };
}

/** Bounded text read, refused for anything outside the allowed roots. */
function readTextFile({ roots, target }) {
  if (!roots.some((root) => isInside(root, target))) {
    throw new Error('That file is outside Harness Desktop managed storage.');
  }
  const stat = statOrNull(target);
  if (!stat || !stat.isFile()) throw new Error('File is no longer available.');
  const handle = fs.openSync(target, 'r');
  try {
    const length = Math.min(stat.size, MAX_TEXT_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, Math.max(0, stat.size - length));
    return {
      text: buffer.toString('utf8'),
      truncated: stat.size > MAX_TEXT_BYTES,
      bytes: stat.size,
    };
  } finally {
    fs.closeSync(handle);
  }
}

/** Bounded listing of editable text files in a workspace. */
function listWorkspaceFiles({ workspace, limit = 400 }) {
  const items = [];
  if (!workspace) return { items };
  const skip = new Set(['node_modules', '.git', 'dist', 'out', '.next', 'build', '.cache']);
  const exts = new Set(['.md', '.txt', '.json', '.yml', '.yaml', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.toml', '.env']);
  const stack = [{ dir: workspace, depth: 0 }];
  while (stack.length && items.length < limit) {
    const { dir, depth } = stack.pop();
    if (depth > 4) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (items.length >= limit) break;
      if (entry.name.startsWith('.') && entry.isDirectory() && entry.name !== '.dsh' && entry.name !== '.agents') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!exts.has(path.extname(entry.name).toLowerCase())) continue;
      const stat = statOrNull(full);
      if (!stat || stat.size > MAX_TEXT_BYTES) continue;
      items.push({ name: entry.name, path: full, relative: path.relative(workspace, full), bytes: stat.size });
    }
  }
  items.sort((a, b) => a.relative.localeCompare(b.relative));
  return { items, truncated: items.length >= limit };
}

/** Write a text file, refused for anything outside the allowed roots. */
function writeTextFile({ roots, target, text }) {
  if (!roots.some((root) => isInside(root, target))) {
    throw new Error('That file is outside the current workspace.');
  }
  if (typeof text !== 'string') throw new Error('Nothing to write.');
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new Error('File is too large to save from the editor.');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, 'utf8');
  return { ok: true, bytes: Buffer.byteLength(text, 'utf8') };
}

module.exports = { listArtifacts, listSkills, listWorkspaceFiles, readTextFile, writeTextFile, isInside, parseFrontmatter, MAX_TEXT_BYTES };
