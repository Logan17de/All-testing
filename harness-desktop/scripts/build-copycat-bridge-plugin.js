const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { validatePluginDirectory } = require('../lib/plugin-validator');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN_NAME = 'dsh-copycat-chatgpt-bridge';
const PLUGIN_DIR = path.join(ROOT, 'plugins', PLUGIN_NAME);
const DIST_DIR = path.join(ROOT, 'dist', 'plugins');

function filesUnder(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.DS_Store')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full, base));
    else if (entry.isFile()) out.push({ full, relative: path.relative(base, full) });
  }
  return out;
}

const validation = validatePluginDirectory(PLUGIN_DIR);
if (!validation.ok) {
  console.error(validation.errors.join('\n'));
  process.exit(1);
}

const manifest = validation.manifest;
const zip = new AdmZip();
for (const file of filesUnder(PLUGIN_DIR)) {
  const zipPath = `${PLUGIN_NAME}/${file.relative.replaceAll('\\', '/')}`;
  zip.addFile(zipPath, fs.readFileSync(file.full));
}

fs.mkdirSync(DIST_DIR, { recursive: true });
const output = path.join(DIST_DIR, `${PLUGIN_NAME}-${manifest.version}.zip`);
zip.writeZip(output);
console.log(output);
