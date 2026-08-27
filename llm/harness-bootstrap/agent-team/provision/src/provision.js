#!/usr/bin/env node
/**
 * Provision Agent Team assistants and a team from a declarative spec.
 *
 * Idempotent: assistants are matched by name and updated in place, teams are
 * skipped when a team of the same name already exists. Safe to re-run.
 */
import { AgentTeamClient, AgentTeamRpcError } from './client.js';
import { loadSpec, parseOverrides } from './spec.js';

function parseArgs(argv) {
  const args = {
    url: 'http://127.0.0.1:3080',
    spec: 'spec/ai-coding-team.json',
    set: [],
    assistantsOnly: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url') args.url = argv[++i];
    else if (arg === '--spec') args.spec = argv[++i];
    else if (arg === '--workspace') args.workspace = argv[++i];
    else if (arg === '--set') args.set.push(argv[++i]);
    else if (arg === '--assistants-only') args.assistantsOnly = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

const HELP = [
  '',
  'dsh-team-provision - apply an Agent Team spec to a running Harness',
  '',
  '  --url <url>             Harness base URL (default http://127.0.0.1:3080)',
  '  --spec <path>           Spec file (default spec/ai-coding-team.json)',
  '  --workspace <idOrPath>  Workspace for the team. Required unless --assistants-only.',
  '  --set k.field=value     Override an assistant field (repeatable)',
  '  --assistants-only       Provision assistants, skip team creation',
  '  --dry-run               Validate everything, change nothing',
  '  -h, --help              Show this help',
  '',
  'Example:',
  '  node src/provision.js --set engineering-leader.provider=codex \\',
  '     --set engineering-leader.model=gpt-5.6-sol --workspace <PROJECT_PATH>',
  '',
].join('\n');

/** Fail early and legibly when a spec names something Harness does not expose. */
function validateAgainstCatalog(assistants, catalog) {
  const problems = [];
  const providerIds = new Set(catalog.providers.map((p) => p.id));
  const presetIds = new Set(catalog.agentPresets.map((p) => p.id));
  const permissionIds = new Set(catalog.permissionPresets.map((p) => p.value ?? p.id));

  for (const a of assistants) {
    if (!providerIds.has(a.provider)) {
      problems.push(
        `${a.name} requires Harness provider "${a.provider}", which is not configured. ` +
        `Configure it first in Settings -> Models. Available: ${[...providerIds].join(', ') || '(none)'}`,
      );
      continue;
    }
    const models = new Set((catalog.models[a.provider] ?? []).map((m) => m.id));
    if (!models.has(a.model)) {
      problems.push(
        `${a.name} requires Harness model ${a.provider}/${a.model}. ` +
        `Configure it first in Settings -> Models. ` +
        `Provider ${a.provider} currently offers: ${[...models].join(', ') || '(none)'}`,
      );
    }
    if (!presetIds.has(a.agentPresetId)) {
      problems.push(`${a.name} names agent preset "${a.agentPresetId}". Available: ${[...presetIds].join(', ')}`);
    }
    if (!permissionIds.has(a.permissionPresetId)) {
      problems.push(`${a.name} names permission preset "${a.permissionPresetId}". Available: ${[...permissionIds].join(', ')}`);
    }
  }
  return problems;
}

function resolveWorkspace(catalog, wanted) {
  const list = catalog.workspaces ?? [];
  const hit = list.find((w) => String(w.id) === String(wanted))
    ?? list.find((w) => w.path === wanted)
    ?? list.find((w) => String(w.path).toLowerCase() === String(wanted).toLowerCase());
  if (hit) return hit;
  const known = list.map((w) => `${w.id}  ${w.path}`).join('\n      ') || '(none registered)';
  throw new Error(`Workspace "${wanted}" is not registered in Harness.\n    Known workspaces:\n      ${known}`);
}

const ASSISTANT_PAYLOAD = [
  'name', 'description', 'icon', 'instructions', 'provider', 'model',
  'reasoningEffort', 'agentPresetId', 'permissionPresetId', 'skillAllowlist', 'mcpServers',
];

const payloadOf = (a) => Object.fromEntries(
  ASSISTANT_PAYLOAD.filter((f) => a[f] !== undefined).map((f) => [f, a[f]]),
);

const itemsOf = (value) => (Array.isArray(value) ? value : value?.items ?? []);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const spec = loadSpec(args.spec, parseOverrides(args.set));
  const client = new AgentTeamClient(args.url);

  console.log(`> Reading Harness catalog from ${args.url}`);
  const catalog = await client.catalog();

  const problems = validateAgainstCatalog(spec.assistants, catalog);
  if (problems.length > 0) {
    console.error('\nProvisioning refused - the spec names things Harness does not expose:\n');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\nNever put an API key in a repository file; configure providers in the Harness UI.\n');
    process.exitCode = 1;
    return;
  }

  // Second, stricter gate: ask the model registry to actually resolve each
  // model, so a route that lists a model but cannot serve it still fails here.
  for (const a of spec.assistants) {
    try {
      await client.modelCapabilities(a.provider, a.model);
    } catch (error) {
      console.error(`\n${a.name} requires Harness model ${a.provider}/${a.model}.`);
      console.error(`Configure it first in Settings -> Models.  (${error.code}: ${error.message})\n`);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`  catalog OK - ${spec.assistants.length} assistant(s) validated against configured providers`);

  let workspace;
  if (!args.assistantsOnly) {
    if (!args.workspace) throw new Error('--workspace <idOrPath> is required (or pass --assistants-only).');
    workspace = resolveWorkspace(catalog, args.workspace);
  }

  if (args.dryRun) {
    console.log('\n--dry-run: validation passed, nothing written.');
    return;
  }

  // --- assistants (idempotent upsert by name) ------------------------------
  const byName = new Map(itemsOf(await client.listAssistants()).map((a) => [a.name, a]));
  const ids = new Map();

  for (const a of spec.assistants) {
    const current = byName.get(a.name);
    if (current) {
      const updated = await client.updateAssistant(current.id, payloadOf(a), current.revision);
      ids.set(a.key, updated?.id ?? current.id);
      console.log(`  updated assistant "${a.name}" (${a.provider}/${a.model})`);
    } else {
      const created = await client.createAssistant(payloadOf(a));
      ids.set(a.key, created.id);
      console.log(`  created assistant "${a.name}" (${a.provider}/${a.model})`);
    }
  }

  if (args.assistantsOnly) {
    console.log('\nDone (assistants only).');
    return;
  }

  // --- team ----------------------------------------------------------------
  const teamsByName = new Map(itemsOf(await client.listTeams()).map((t) => [t.name, t]));

  for (const team of spec.teams) {
    if (teamsByName.has(team.name)) {
      console.log(`  team "${team.name}" already exists - left untouched`);
      continue;
    }
    const draft = await client.createTeamDraft({
      name: team.name,
      workspaceId: String(workspace.id),
      directMemberChat: team.directMemberChat ?? true,
      members: team.members.map((key) => ({
        assistantId: ids.get(key),
        role: key === team.leader ? 'leader' : 'member',
      })),
    });
    console.log(`  created team "${team.name}" in workspace ${workspace.path}`);
    await client.startTeam(draft.id);
    console.log(`  started team "${team.name}" (id ${draft.id})`);
  }

  console.log('\nDone. Open the Team workbench in Harness to see the members.');
}

main().catch((error) => {
  console.error(`\n${error instanceof AgentTeamRpcError ? error.message : error.message}\n`);
  process.exitCode = 1;
});
