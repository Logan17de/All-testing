/** Load a provisioning spec and resolve its instruction files + CLI overrides. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ASSISTANT_FIELDS = new Set([
  'name', 'description', 'icon', 'instructions', 'provider', 'model',
  'reasoningEffort', 'agentPresetId', 'permissionPresetId',
  'skillAllowlist', 'mcpServers',
]);

export function loadSpec(specPath, overrides = {}) {
  const abs = resolve(specPath);
  const base = dirname(abs);
  const raw = JSON.parse(readFileSync(abs, 'utf8'));

  const assistants = (raw.assistants ?? []).map((entry) => {
    const { key, instructionsFile, comment, ...rest } = entry;
    if (!key) throw new Error(`Every assistant needs a stable "key". Offending entry: ${JSON.stringify(entry).slice(0, 120)}`);
    const resolved = { ...rest };
    if (instructionsFile) {
      resolved.instructions = readFileSync(resolve(base, instructionsFile), 'utf8').trimEnd();
    }
    for (const [field, value] of Object.entries(overrides[key] ?? {})) {
      if (!ASSISTANT_FIELDS.has(field)) {
        throw new Error(`--set ${key}.${field}: not a settable assistant field. Settable: ${[...ASSISTANT_FIELDS].join(', ')}`);
      }
      resolved[field] = value;
    }
    return { key, ...resolved };
  });

  for (const a of assistants) {
    for (const required of ['name', 'instructions', 'agentPresetId', 'permissionPresetId']) {
      if (!a[required]) throw new Error(`Assistant "${a.key}" is missing required field "${required}".`);
    }
    if (!a.provider || !a.model) {
      throw new Error(
        `Assistant "${a.key}" has no provider/model. This is deliberate for vendor-neutral roles.\n` +
        `Supply one at provision time, e.g.:\n` +
        `  --set ${a.key}.provider=<provider> --set ${a.key}.model=<model>`,
      );
    }
    a.skillAllowlist ??= [];
    a.mcpServers ??= [];
  }

  const byKey = new Map(assistants.map((a) => [a.key, a]));
  const teams = (raw.teams ?? []).map((team) => {
    for (const memberKey of team.members ?? []) {
      if (!byKey.has(memberKey)) throw new Error(`Team "${team.key}" references unknown assistant key "${memberKey}".`);
    }
    if (!byKey.has(team.leader)) throw new Error(`Team "${team.key}" names unknown leader key "${team.leader}".`);
    if (!(team.members ?? []).includes(team.leader)) throw new Error(`Team "${team.key}" leader "${team.leader}" must also be listed in members.`);
    return team;
  });

  return { assistants, teams };
}

/** Parse repeated `--set key.field=value` flags into `{ key: { field: value } }`. */
export function parseOverrides(pairs) {
  const out = {};
  for (const pair of pairs) {
    const match = /^([^.=]+)\.([^=]+)=(.*)$/.exec(pair);
    if (!match) throw new Error(`--set expects <assistantKey>.<field>=<value>, got: ${pair}`);
    const [, key, field, value] = match;
    (out[key] ??= {})[field] = value;
  }
  return out;
}
