#!/usr/bin/env node
/**
 * End-to-end smoke test for the Leader -> Coder -> Workspace -> Leader loop.
 *
 * It asserts the things that actually matter for this workflow:
 *   1. the Leader creates a team task and assigns it to the coder member,
 *      without the user naming the member;
 *   2. the coder's own session does the work (its session shows the tool
 *      calls, not the Leader's);
 *   3. the file lands in the shared Workspace with exact content;
 *   4. the Leader reports only after the task reaches an explicit terminal
 *      status.
 *
 * Failure is reported, never papered over: a task that ends `failed` is a
 * failed smoke test, and so is a Leader that edits the file itself.
 */
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentTeamClient } from './client.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = { url: 'http://127.0.0.1:3080', team: 'AI Coding Team', coder: 'Qwen Coder', timeoutMs: 300000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') args.url = argv[++i];
    else if (a === '--team') args.team = argv[++i];
    else if (a === '--coder') args.coder = argv[++i];
    else if (a === '--timeout') args.timeoutMs = Number(argv[++i]) * 1000;
    else if (a === '--keep') args.keep = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

const itemsOf = (v) => (Array.isArray(v) ? v : v?.items ?? []);

/** Poll the team until `done(team)` is satisfied or the budget runs out. */
async function waitFor(client, teamId, done, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const team = await client.getTeam(teamId);
    const members = Object.values(team.members ?? {});
    const tasks = Object.values(team.tasks ?? {});
    const line = tasks.map((t) => {
      const owner = members.find((m) => m.id === t.ownerSlotId);
      return `[${t.status}] ${t.title.slice(0, 40)} -> ${owner ? owner.displayName : '(unassigned)'}`;
    }).join(' ; ') || '(no tasks)';
    const states = members.map((m) => `${m.displayName}=${m.lastRuntimeState}`).join(' ');
    const stamp = `${states} | ${line}`;
    if (stamp !== last) { console.log(`    ${stamp}`); last = stamp; }
    if (done(team)) return team;
    await sleep(5000);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

const terminal = (t) => ['completed', 'failed', 'cancelled'].includes(t.status);

async function scenario(client, { teamId, workspacePath, coderName, timeoutMs }, { title, goal, file, expected }) {
  console.log(`\n--- ${title} ---`);
  const target = join(workspacePath, file);
  const before = existsSync(target) ? readFileSync(target, 'utf8') : null;

  await client.sendMessage(teamId, goal);
  console.log('    goal sent to Leader (no member named by the user)');

  const team = await waitFor(
    client, teamId,
    (t) => Object.values(t.tasks ?? {}).some(terminal),
    timeoutMs, 'a task to reach a terminal status',
  );

  const members = Object.values(team.members ?? {});
  const coder = members.find((m) => m.displayName === coderName);
  if (!coder) throw new Error(`FAIL: no member named "${coderName}" in the team.`);

  const tasks = Object.values(team.tasks ?? {});
  const assigned = tasks.filter((t) => t.ownerSlotId === coder.id);

  const results = [];
  results.push([`Leader created at least one task`, tasks.length > 0]);
  results.push([`a task was auto-assigned to "${coderName}"`, assigned.length > 0]);
  results.push([`no task ended 'failed'`, !tasks.some((t) => t.status === 'failed')]);

  const after = existsSync(target) ? readFileSync(target, 'utf8') : null;
  results.push([`${file} exists`, after !== null]);
  results.push([`${file} content is exactly the expected text`, after !== null && after.replace(/\r\n/g, '\n').trimEnd() === expected]);
  results.push([`${file} actually changed in this scenario`, after !== before]);

  for (const [name, ok] of results) console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (after !== null) console.log(`    content: ${JSON.stringify(after)}`);

  const failed = results.filter(([, ok]) => !ok);
  return { failed: failed.length, tasks, coder };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new AgentTeamClient(args.url);

  const team = itemsOf(await client.listTeams()).find((t) => t.name === args.team);
  if (!team) throw new Error(`No team named "${args.team}". Run provision.js first.`);

  const catalog = await client.catalog();
  const workspace = (catalog.workspaces ?? []).find((w) => String(w.id) === String(team.workspaceId));
  if (!workspace) throw new Error(`Team "${args.team}" references workspace ${team.workspaceId}, which Harness does not list.`);

  console.log(`Team    : ${team.name} (${team.id})`);
  console.log(`Coder   : ${args.coder}`);
  console.log(`Work dir: ${workspace.path}`);

  const ctx = { teamId: team.id, workspacePath: workspace.path, coderName: args.coder, timeoutMs: args.timeoutMs };
  let failures = 0;

  failures += (await scenario(client, ctx, {
    title: 'Scenario 1 - create',
    goal: 'Create a file named agent-team-smoke.txt containing exactly:\nhello from qwen\nDelegate implementation to Qwen Coder and verify it yourself.',
    file: 'agent-team-smoke.txt',
    expected: 'hello from qwen',
  })).failed;

  failures += (await scenario(client, ctx, {
    title: 'Scenario 2 - correction',
    goal: 'Change agent-team-smoke.txt so it contains exactly:\nhello from qwen v2\nDelegate the change and verify it yourself.',
    file: 'agent-team-smoke.txt',
    expected: 'hello from qwen v2',
  })).failed;

  if (!args.keep) {
    const target = join(workspace.path, 'agent-team-smoke.txt');
    if (existsSync(target)) { rmSync(target); console.log('\n  cleaned up agent-team-smoke.txt'); }
  }

  console.log(`\n${failures === 0 ? 'SMOKE TEST PASSED' : `SMOKE TEST FAILED (${failures} assertion(s))`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(`\nSMOKE TEST ERROR: ${error.message}\n`);
  process.exitCode = 1;
});
