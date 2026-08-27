/**
 * Extract every quoted string literal containing Chinese from the Agent Team
 * bundles, so the zh->en map can be built and audited against a known list.
 *
 * A hand-rolled scanner rather than a regex: the bundles are large and a
 * quote-matching regex backtracks catastrophically on them.
 *
 * Usage: node extract.mjs <path-to-agent-team/lib> [out.json]
 */
import fs from 'node:fs';

const BACKSLASH = String.fromCharCode(92);
const isCJK = (c) => c >= '一' && c <= '鿿';

export function scanLiterals(source) {
  const found = new Map();
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      let hasCJK = false;
      let closed = false;
      while (j < source.length) {
        const c = source[j];
        if (c === BACKSLASH) { j += 2; continue; }
        if (c === ch) { closed = true; break; }
        if (c === '\n' && ch !== '`') break;
        if (isCJK(c)) hasCJK = true;
        j++;
      }
      if (closed && hasCJK) {
        const text = source.slice(i + 1, j);
        found.set(text, (found.get(text) ?? 0) + 1);
      }
      i = closed ? j + 1 : i + 1;
      continue;
    }
    i++;
  }
  return found;
}

if (process.argv[2]) {
  const dir = process.argv[2];
  const out = process.argv[3];
  const all = new Map();
  for (const file of ['client.js', 'index.js']) {
    const source = fs.readFileSync(`${dir}/${file}`, 'utf8');
    for (const [text, count] of scanLiterals(source)) {
      const entry = all.get(text) ?? { text, chars: [...text].length, files: [], count: 0 };
      if (!entry.files.includes(file)) entry.files.push(file);
      entry.count += count;
      all.set(text, entry);
    }
  }
  const list = [...all.values()].sort((a, b) => a.chars - b.chars || a.text.localeCompare(b.text));
  const buckets = { '1-8': 0, '9-20': 0, '21-60': 0, '61+': 0 };
  for (const e of list) {
    if (e.chars <= 8) buckets['1-8']++;
    else if (e.chars <= 20) buckets['9-20']++;
    else if (e.chars <= 60) buckets['21-60']++;
    else buckets['61+']++;
  }
  console.log(`${list.length} unique literals containing Chinese`);
  console.log('by length:', JSON.stringify(buckets));
  console.log('client.js only:', list.filter((e) => e.files.length === 1 && e.files[0] === 'client.js').length);
  console.log('index.js only :', list.filter((e) => e.files.length === 1 && e.files[0] === 'index.js').length);
  console.log('both          :', list.filter((e) => e.files.length === 2).length);
  if (out) {
    fs.writeFileSync(out, JSON.stringify(list, null, 2));
    console.log(`wrote ${out}`);
  }
}
