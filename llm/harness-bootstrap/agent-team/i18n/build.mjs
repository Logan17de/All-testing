/**
 * Build an English copy of @limuyang2/dsh-agent-team.
 *
 * The upstream package ships no i18n: its UI strings are hardcoded Chinese
 * literals in the published bundles. This script copies a pinned upstream
 * release and replaces whole string literals using i18n/zh-en.json, producing a
 * local package that is installed through the normal DSH plugin mechanism.
 *
 * Replacement operates on complete literal spans found by a scanner, never by
 * substring search, so a short label such as 团队 can never corrupt a longer
 * string such as 团队事件 that contains it.
 *
 * Usage:
 *   node build.mjs --source <upstream-package-dir> --out <target-dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKSLASH = String.fromCharCode(92);
const isCJK = (c) => c >= '一' && c <= '鿿';

/** Return [{start,end,text}] for every quoted literal, in source order. */
function literalSpans(source) {
  const spans = [];
  let i = 0;
  while (i < source.length) {
    const quote = source[i];
    if (quote === '"' || quote === "'" || quote === '`') {
      let j = i + 1;
      let closed = false;
      while (j < source.length) {
        const c = source[j];
        if (c === BACKSLASH) { j += 2; continue; }
        if (c === quote) { closed = true; break; }
        if (c === '\n' && quote !== '`') break;
        j++;
      }
      if (closed) {
        spans.push({ start: i + 1, end: j, text: source.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return spans;
}

function translate(source, strings, stats) {
  const spans = literalSpans(source);
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    const replacement = strings[span.text];
    if (replacement === undefined) continue;
    out += source.slice(cursor, span.start) + replacement;
    cursor = span.end;
    stats.replaced += 1;
    stats.used.add(span.text);
  }
  out += source.slice(cursor);
  return out;
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--source') args.source = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.source || !args.out) throw new Error('Usage: node build.mjs --source <upstream-dir> --out <target-dir>');
  return args;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const map = JSON.parse(fs.readFileSync(path.join(here, 'zh-en.json'), 'utf8'));
const strings = map.strings;

const upstream = JSON.parse(fs.readFileSync(path.join(args.source, 'package.json'), 'utf8'));
console.log(`source  : ${upstream.name}@${upstream.version}`);

fs.rmSync(args.out, { recursive: true, force: true });
copyTree(args.source, args.out);

const stats = { replaced: 0, used: new Set() };
for (const file of ['lib/client.js', 'lib/index.js']) {
  const target = path.join(args.out, file);
  const source = fs.readFileSync(target, 'utf8');
  fs.writeFileSync(target, translate(source, strings, stats), 'utf8');
}

// Mark the build so an installed copy is identifiable, while keeping the
// package NAME identical: the profile's bundle list resolves plugins by name.
const patched = JSON.parse(fs.readFileSync(path.join(args.out, 'package.json'), 'utf8'));
patched.version = `${upstream.version}`;
patched.description = `${upstream.description ?? ''} (English UI build)`.trim();
fs.writeFileSync(path.join(args.out, 'package.json'), `${JSON.stringify(patched, null, 2)}\n`, 'utf8');

// Coverage report: what the map did not cover, and what it no longer matches.
const remaining = new Set();
for (const file of ['lib/client.js', 'lib/index.js']) {
  for (const span of literalSpans(fs.readFileSync(path.join(args.out, file), 'utf8'))) {
    if ([...span.text].some(isCJK)) remaining.add(span.text);
  }
}
const unused = Object.keys(strings).filter((k) => !stats.used.has(k));

console.log(`out     : ${args.out}`);
console.log(`replaced: ${stats.replaced} literal occurrences from ${stats.used.size} map entries`);
console.log(`unused  : ${unused.length} map entries matched nothing${unused.length ? ` -> ${unused.slice(0, 5).map((s) => JSON.stringify(s)).join(', ')}` : ''}`);
console.log(`remaining Chinese literals: ${remaining.size}`);
if (remaining.size > 0) {
  const sorted = [...remaining].sort((a, b) => [...b].length - [...a].length);
  console.log('  longest still untranslated:');
  for (const s of sorted.slice(0, 6)) console.log(`    ${[...s].length} chars: ${JSON.stringify(s.slice(0, 80))}`);
}
