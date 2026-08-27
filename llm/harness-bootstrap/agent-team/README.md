# Agent Team workflow

Adds a supervisor/worker coding team to the Harness `web` profile: a
vendor-neutral **Engineering Leader** that plans, delegates and independently
verifies, and a **Qwen Coder** that implements in the shared Workspace.

```
User
  -> Engineering Leader        (any configured model; codex by default)
       -> team_create_task     (ownerSlotId = Qwen Coder's stable slot id)
            -> Qwen Coder      (qwen/qwen3.8-27b, own session, own context)
                 -> edits the shared Workspace, runs checks
                 -> team_update_task(status, result)
       -> Leader inspects the Workspace itself and verifies
       -> correction loop, or acceptance
```

Members are **independent root sessions**, not subagents: separate model,
context, permissions and tool activity. Only tasks and results cross between
them, which is what keeps the Leader's context free of implementation detail.

No credentials live here. Providers are connected in Harness under
**Settings -> Subscriptions** and **Settings -> Models**.

## Install

```powershell
.\Install-AgentTeam-Windows.ps1 -Workspace "<PROJECT_PATH>"
```

Run `Install-Harness-Windows.ps1` in the parent folder first. Register the
workspace in the Harness sidebar (**Add workspace**) before provisioning.

Useful switches: `-LeaderProvider` / `-LeaderModel` (default `codex` /
`gpt-5.6-sol`), `-SkipEnglishUi`, `-SkipBarricade`, `-SkipProvision`.

## What it installs

| Package | Why |
| --- | --- |
| `@limuyang2/dsh-agent-team@0.1.4` | The team runtime. Pinned — see version note below. |
| `dshmarket` | Plugin market inside Settings, for browsing the rest of the ecosystem. |
| `dsh-solution-explorer` | File explorer + source control in the web UI. |
| `dsh-session-manager` | Delete and restore sessions. DSH ships `archiveSession` but **no delete**. |
| `dsh-barricade` + local adapter | Deterministic destructive-command gate (optional). |

## Three traps this folder exists to handle

### 1. Plugin installs re-break every tool call

`@wnjxyk/dsh-codex-oauth` declares `@deepseek-ai/dsh-tools` as a **regular
dependency** instead of a peer, so pnpm materialises a second physical copy on
every install. `dsh-tools` keys its scheduler with `Symbol("…")` — not
`Symbol.for` — so two copies mint different symbols, the lookup returns
`undefined`, and every tool call dies with:

```text
Cannot read properties of undefined (reading 'prepare')
```

The installer runs `Repair-DshTools-Windows.ps1` **after** installing plugins
for this reason. Run it again after any future `dsh plugin add`.

A session that made a tool call while this was broken is **permanently
unusable**: it holds a `tool_use` with no `tool_result`, and both providers
reject the replay (`No tool output found for function call …`). That is not a
subscription failure — start a new session, or delete the old one with
`dsh-session-manager`.

### 2. `pnpm add` installs but does not activate

Only the `dsh plugin add` wrapper appends to `dsh.profile.bundles`. Anything
linked with plain `pnpm add` (the English build, `barricade-guard`) stays
installed-but-dormant until it is listed there. The installer does this
explicitly.

### 3. Version pinning is not optional

Agent Team `0.1.4` declares peers `^0.1.1-rc.2`; `0.1.3` declares
`^0.1.0-rc.7`, which `0.1.1-rc.2` does **not** satisfy under default semver
rules. Check before moving:

```powershell
npm view @limuyang2/dsh-agent-team version peerDependencies --json
```

## Contents

| Path | What it is |
| --- | --- |
| `provision/` | Declarative provisioner over Agent Team's public `/agent-team/api` |
| `provision/spec/ai-coding-team.json` | The team definition |
| `provision/spec/instructions/` | Role prompts for each assistant |
| `provision/src/smoke.js` | End-to-end Leader -> Coder -> Workspace test |
| `i18n/` | English UI build (upstream ships hardcoded Chinese) |
| `barricade-guard/` | Adapter mounting `dsh-barricade`'s rules on this DSH build |

### Provisioning is idempotent

Assistants are matched by name and updated in place; an existing team is left
alone. Safe to re-run.

```powershell
node provision\src\provision.js --set engineering-leader.provider=codex --set engineering-leader.model=gpt-5.6-sol --workspace "<PROJECT_PATH>"
```

It refuses to write anything if a provider, model or preset in the spec is not
exposed by Harness, and names what is missing.

> Assistant settings are **snapshotted when a member joins a team**. Editing a
> template later does not update existing members — dissolve and re-create the
> team, or remove and re-add the member.

### Verify

```powershell
node provision\src\smoke.js
```

Drives the loop twice (create, then correct) and asserts the coder — not the
Leader — did the work.

## Known limitation

Agent Team's own plugin entry for `dsh-barricade` cannot mount on DSH
`0.1.1-rc.2`; the adapter in `barricade-guard/` exists for that reason and its
README documents the three mismatches. The adapter's mount and rule logic are
both tested, but **that `ctx.tools.guard()` fires on a live call is worth
confirming yourself** — ask an agent to run `Get-Location` (must succeed) and,
in a throwaway repo, `git reset --hard` (must be refused). Do not canary with
`rm -rf`: the guard blocks statically, so if it is not firing the command runs.
