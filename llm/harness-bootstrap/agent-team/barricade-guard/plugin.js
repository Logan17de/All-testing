/**
 * dsh-barricade-guard — DSH 0.1.1-rc.2 adapter for `dsh-barricade`.
 *
 * Upstream's own plugin entry cannot mount on this DSH build. Three independent
 * mismatches, each verified against the installed harness:
 *
 *   1. It reads `ctx.approval` while declaring only `inject = ['tools']`, so
 *      cordis throws `cannot get property "approval" without inject` at mount
 *      and takes the WHOLE plugin tree down with it.
 *   2. It reads the command from `args.command`, but DSH passes a
 *      `ToolExecution` whose parsed arguments live under `arguments`. With the
 *      stock path every command reads as undefined and the fail-closed branch
 *      denies every shell call.
 *   3. It registers with `ctx.on('tools/pre-execute')` and throws to block,
 *      while DSH runs that hook as a waterfall whose listeners RETURN a gate
 *      decision — and exposes `ctx.tools.guard()` as the purpose-built seam:
 *        `(execution) => string | undefined`  — a returned string denies.
 *
 * This adapter fixes all three by re-mounting upstream's analysis unchanged.
 * Only the integration is ours; every rule, the tokenizer and the severity
 * model come from the upstream package, so its updates flow through untouched.
 */
import os from 'node:os';
import path from 'node:path';
import { analyzeCommand } from 'dsh-barricade/src/analyzer.js';
import { Policy } from 'dsh-barricade/src/policy.js';
import { LEVELS } from 'dsh-barricade/src/rules.js';
import { DEFAULT_TOOLS } from 'dsh-barricade/plugin.js';

export const name = 'barricade-guard';

// Only `tools` is required, and it is the only service we touch. This is the
// difference between mounting and bringing the harness down.
export const inject = ['tools'];

/** Read a dotted path off the execution, with a bare `command` fallback. */
function getByPath(obj, dotPath) {
  let cur = obj;
  for (const part of String(dotPath).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Resolve the directory a command should be analysed against.
 *
 * The harness process runs in $DSH_HOME, not the session workspace, so
 * `process.cwd()` would make every workspace path look "outside the workspace"
 * and trip `fs/rm-outside` on ordinary work. DSH's shell tools carry the real
 * directory as `workdir`, so prefer that and fall back to the process cwd.
 *
 * Note this is a deliberate trade: a caller that lies about `workdir` widens
 * the workspace-relative rules. It cannot weaken the absolute-path rules
 * (`rm -rf /`, `rm -rf ~`, device writes, mkfs), which are the critical tier.
 */
function resolveCwd(execution) {
  const args = execution?.arguments;
  const claimed = typeof args?.workdir === 'string' ? args.workdir
    : typeof args?.cwd === 'string' ? args.cwd
      : null;
  if (claimed && path.isAbsolute(claimed)) return claimed;
  return process.cwd();
}

export function apply(ctx, config = {}) {
  const toolNames = new Set(
    Array.isArray(config.toolNames) && config.toolNames.length > 0
      ? config.toolNames
      : DEFAULT_TOOLS,
  );
  const commandPath = config.commandPath ?? 'arguments.command';

  let policy = config.policy ?? Policy.load({ env: process.env, cwd: process.cwd() }).policy;
  if (config.level && LEVELS.includes(config.level)) policy = policy.withLevel(config.level);

  ctx.tools.guard((execution) => {
    if (!execution || !toolNames.has(execution.name)) return undefined;

    const command = getByPath(execution, commandPath);
    if (typeof command !== 'string' || !command.trim()) {
      // Fail closed: a shell tool whose command we cannot read is not allowed
      // through unexamined. Say why, because the usual cause is configuration —
      // a tool listed in toolNames that carries no command at all (`run_code`
      // takes `code`, not `command`), which would otherwise refuse every call
      // of that tool with no hint as to the reason.
      return `Barricade: refused "${execution.name}" — no readable command at `
        + `"${commandPath}". If this tool carries no shell command (run_code and `
        + `friends take "code"), remove it from the guard's toolNames.`;
    }

    let verdict;
    try {
      verdict = analyzeCommand(command, {
        policy,
        cwd: resolveCwd(execution),
        home: os.homedir(),
        env: process.env,
      });
    } catch (error) {
      // An analyzer crash must not silently disarm the gate.
      return `Barricade: command analysis failed (${error?.message ?? 'unknown error'}); refused.`;
    }

    // `ask` has no home in a synchronous guard, and upstream's approval probing
    // does not match this build's approval service. Treat anything short of
    // `allow` as a denial, which is also upstream's default `mode: 'deny'`.
    if (verdict.action === 'allow') return undefined;
    return verdict.format();
  });
}
