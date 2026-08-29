// Build a self-contained copy of the UI for design review.
//
// Two outputs from one source of truth, so they can never drift:
//   .e2e/ui-preview.html   a complete standalone page you can open in a browser
//   .e2e/ui-artifact.html  body-only, for hosts that supply their own <head>
//
// The renderer falls back to its preview bridge when window.desktop is absent,
// so this shows the real layout with placeholder data and never runs the engine.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, '.e2e');

const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(SRC, 'renderer.js'), 'utf8');

const body = html
  .split('<body>')[1]
  .split('</body>')[0]
  .replace('<script src="renderer.js"></script>', '');

const head = [
  '<title>Harness Desktop UI</title>',
  '<style>',
  css,
  'html, body { height: 100%; overflow: hidden; }',
  '</style>',
].join('\n');

const script = `<script>\n${js}\n</script>`;

const standalone = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8" />',
  '<meta name="viewport" content="width=device-width, initial-scale=1" />',
  head,
  '</head>',
  '<body>',
  body,
  script,
  '</body>',
  '</html>',
  '',
].join('\n');

const artifact = [head, body, script, ''].join('\n');

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'ui-preview.html'), standalone);
fs.writeFileSync(path.join(OUT, 'ui-artifact.html'), artifact);

// A dropped <style> renders the page as raw HTML, which is easy to miss — so fail loudly.
for (const [name, text] of [['ui-preview.html', standalone], ['ui-artifact.html', artifact]]) {
  const problems = [];
  if (!text.includes('<style>')) problems.push('missing <style>');
  if (!text.includes('--w-chat')) problems.push('stylesheet looks truncated');
  if (!text.includes('<script>')) problems.push('missing <script>');
  if (!text.includes('class="shell"')) problems.push('missing app markup');
  if (text.includes('styles.css') || text.includes('renderer.js"')) problems.push('still references external files');
  if (problems.length) {
    console.error(`${name}: ${problems.join(', ')}`);
    process.exit(1);
  }
  console.log(`${name.padEnd(20)} ${(text.length / 1024).toFixed(1)} KB  ok`);
}
