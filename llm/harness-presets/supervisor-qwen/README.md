# Supervisor -> Qwen Builder

A DeepSeek Harness custom agent preset where the session's selected parent model acts as the **architect / reviewer / verifier** and delegates implementation to a child pinned to **Qwen 3.8 27B**.

## Architecture

```text
User
  ↓
Supervisor model selected in Harness
  ↓ inspect / decide next step
qwen_builder
  ↓ continuable background worker
  ├─ milestone reports while working
  └─ edit repository / test / final report
Supervisor
  ↓ after child settlement: independently inspect files/diff/tests
accept OR delegate correction
  ↓
repeat until verified complete
```

The supervisor can be any model configured in Harness. To approximate the intended "OpenAI guides Qwen" setup, select an OpenAI/Codex model as the session model. The worker remains fixed to:

```text
provider: qwen
model: qwen3.8-27b
maxTokens: 32768
```

The ChatGPT web conversation itself is not directly embedded into Harness; the automatic supervisor must be a model endpoint configured inside Harness.

## Why this instead of Ralph

Harness's Ralph workflow repeatedly launches fresh workers, but completion is still a worker self-declaration and the built-in Ralph flow has no independent evaluator deciding whether the objective is actually complete.

This preset makes the parent model the evaluator. It delegates one bounded coding task, receives selected progress reports and the eventual child settlement, then independently inspects the actual workspace and verification evidence before deciding whether to continue.

## Level 2 progress reporting

`qwen_builder` runs as a **continuable background subagent** and receives Harness's native child-scoped `report` tool. Reports use `reportDelivery: next-step`, so meaningful milestones are delivered to the supervisor while Qwen continues working.

The worker is instructed to report only useful transitions, for example:

```text
Inspection complete — relevant playback code identified.
Root cause found — pause state still advances the wall-clock-derived time.
Implementation started — rewriting the playback clock state.
Verification started — running targeted playback tests.
Verification passed — targeted tests are green.
```

It should **not** report every file read, grep, shell command, or trivial edit, and it should never expose private chain-of-thought. The goal is visible activity without turning the supervisor transcript into a tool log.

The runtime also sends the supervisor a settlement/completion notice when the child finishes. The supervisor is explicitly instructed **not to inspect or verify a workspace that the child may still be modifying** merely because a progress report arrived; verification begins after settlement.

## Worker lifecycle

`qwen_builder` uses the in-process `spawn` subagent provider with:

```text
enableRunInBackground: true
backgroundMode: continuable
```

A `qwen_builder` call therefore returns a durable child id immediately and runs Qwen independently. Each new `qwen_builder` invocation creates a separate child conversation, so the next bounded correction or implementation step starts with focused conversational context while sharing the same repository workspace.

This keeps the useful properties of fresh implementation rounds:

- no single Qwen conversation accumulating across the entire project;
- each implementation step gets a focused context;
- corrections start from the real modified workspace rather than stale conversational assumptions;
- the expensive strategic context stays with the supervisor;
- the supervisor can shrink a task after a token-limit failure;
- meaningful worker progress remains visible while the child is active.

## Install

From the `All-testing` repository on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\llm\harness-presets\supervisor-qwen\Install-SupervisorQwenMode.ps1
```

This copies the preset to:

```text
%USERPROFILE%\.dsh\.agent-presets\supervisor-qwen\agent.cordis.yml
```

If `DSH_HOME` is set, the installer uses that Harness home instead.

Restart the Harness host after installation and select `supervisor-qwen` as the session mode.

If `supervisor-qwen` was already installed before Level 2 reporting was added, rerun the installer and restart Harness so the local preset is replaced with the latest version.

## Model requirements

The Qwen provider must already be configured in Harness under exactly:

```text
provider: qwen
model: qwen3.8-27b
```

The preset itself does not depend on whether Qwen is reached through a local or remote OpenAI-compatible endpoint.

## Recommended use

Give the supervisor the complete product objective. The supervisor should inspect the project, create a plan, and then iterate through small verifiable worker tasks.

Example flow:

```text
Supervisor: inspect current auth implementation
Supervisor → qwen_builder: implement refresh-token storage + tests
Qwen report: inspection complete; implementation starting
Qwen report: implementation complete; running tests
Qwen report: tests passed; final result follows
Runtime: child settled
Supervisor: inspect diff and test output
Supervisor → qwen_builder: fix missing invalidation path
...
Supervisor: final verification
Supervisor: report completion to user
```

## Safety / correctness policy

The supervisor is explicitly instructed not to trust worker reports or completion claims by themselves. It should inspect repository state and verification evidence after the child settles before ending the loop.

The Qwen child is capped at delegation depth 1 so it cannot recursively fan out additional subagents. This keeps responsibility clear: supervisor decides, Qwen builds.
