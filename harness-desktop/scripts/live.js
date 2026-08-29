// Launch Harness Desktop against the live-test engine home and workspace.
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const electron = require(path.join(ROOT, 'node_modules', 'electron'));

const child = spawn(electron, ['.', ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    DSH_HOME: path.join(ROOT, '.e2e', 'source-dsh-home'),
    HARNESS_DESKTOP_USER_DATA: path.join(ROOT, '.e2e', 'live-user-data'),
  },
});
child.on('exit', (code) => process.exit(code ?? 0));
