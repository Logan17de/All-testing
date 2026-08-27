# Agent Team English UI build

`@limuyang2/dsh-agent-team` ships **no i18n**: its UI strings are hardcoded
Chinese literals in the published bundles, and no Harness locale setting affects
them. This directory turns a pinned upstream release into an English build and
installs it through the normal DSH plugin mechanism.

| File | Role |
| --- | --- |
| `zh-en.json` | The zh -> en map. The reviewable source of truth. |
| `build.mjs` | Copies a pinned upstream release and replaces whole string literals. |
| `extract.mjs` | Lists every Chinese literal in a release, to audit map coverage. |

Replacement works on **complete literal spans**, never substring search, so a
short label such as `团队` cannot corrupt a longer string such as `团队事件`
that contains it.

## Deliberately not translated

Two literals are left in Chinese because they are model-facing prompt text, and
rewriting a prompt can change model behaviour:

- the 1065-character Assistant Builder system prompt;
- the draft-validated instruction beginning `草稿`.

Both are only used by the "Team Agent Assistant" conversational builder. Every
string a person or a team member reads is translated.

## Rebuild after an upstream release

```bash
npm pack @limuyang2/dsh-agent-team@<version>
tar -xzf limuyang2-dsh-agent-team-<version>.tgz
```

```bash
node build.mjs --source ./package --out "<DSH_HOME>/profiles/web/agent-team-en"
```

The build must read a **pristine** upstream tree, not the already-patched copy in
`node_modules`. It prints a coverage report:

```
replaced: 438 literal occurrences from 332 map entries
unused  : 0 map entries matched nothing
remaining Chinese literals: 2
```

`unused > 0` means upstream changed a string the map still names. `remaining > 2`
means upstream added strings the map does not cover — run `extract.mjs` against
the new release and add them.

## Install

The build output lives **inside the profile directory**, not in this repository:
pnpm links external directories rather than installing them, which breaks both
the plugin's runtime dependencies and its `@deepseek-ai/*` peers. From
`<DSH_HOME>/profiles/web`:

```bash
pnpm add file:./agent-team-en
```

This keeps the package name `@limuyang2/dsh-agent-team`, which is what the
profile's `dsh.profile.bundles` list resolves. Restart Harness afterwards.

To go back to the upstream Chinese build:

```bash
pnpm add @limuyang2/dsh-agent-team@0.1.4
```
