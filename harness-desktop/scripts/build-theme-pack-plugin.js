const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');

const ROOT = path.resolve(__dirname, '..');
const NAME = 'dsh-harness-theme-pack';
const VERSION = '0.1.0';
const SOURCE = path.join(ROOT, 'plugins', NAME);
const OUTPUT_DIR = path.join(ROOT, 'dist', 'plugins');
const OUTPUT = path.join(OUTPUT_DIR, `${NAME}-${VERSION}.zip`);

function collect(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full, base));
    else if (entry.isFile()) out.push({ full, relative: path.relative(base, full) });
  }
  return out;
}

if (!fs.existsSync(path.join(SOURCE, 'package.json'))) {
  throw new Error(`Theme plugin source is missing: ${SOURCE}`);
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const zip = new AdmZip();
for (const file of collect(SOURCE)) {
  zip.addFile(`${NAME}/${file.relative.replaceAll('\\', '/')}`, fs.readFileSync(file.full));
}
zip.writeZip(OUTPUT);
console.log(OUTPUT);
