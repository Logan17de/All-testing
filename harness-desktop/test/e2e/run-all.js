// Runs every real-engine suite against an isolated DSH home.
//   node test/e2e/run-all.js
// These talk to a real DSH engine and mutate a profile, so they must never point
// at a DSH_HOME you care about. Each suite snapshots and restores what it touches.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const HOME = process.env.DSH_HOME || path.join(ROOT, '.e2e', 'source-dsh-home');

const profile = path.join(HOME, 'profiles', 'web');
if (!fs.existsSync(profile)) {
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-e2e',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(profile, 'cordis.yml'), '[]\n');
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n');
  fs.writeFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'packages: []\n');
}

const suites = ['e2e-real', 'e2e-recovery', 'e2e-starter', 'e2e-restore-core', 'e2e-providers', 'real-verify', 'ui-smoke'];
let failed = 0;
for (const suite of suites) {
  const result = spawnSync(process.execPath, [path.join(__dirname, `${suite}.js`)], {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: HOME },
    encoding: 'utf8',
  });
  const summary = (result.stdout || '').match(/^\d+\/\d+ passed$/m)?.[0]
    || (result.stdout || '').match(/^PASS .*$/m)?.[0]
    || 'no summary';
  const ok = result.status === 0;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${suite.padEnd(18)} ${summary}`);
  if (!ok) console.log((result.stdout || result.stderr || '').split('\n').slice(-12).join('\n'));
}
console.log(`\n${suites.length - failed}/${suites.length} suites passed`);
process.exit(failed ? 1 : 0);
