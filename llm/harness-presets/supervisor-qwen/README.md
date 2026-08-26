# Supervisor -> Qwen Builder

A DeepSeek Harness custom agent preset where the session's selected parent model acts as the **architect / reviewer / verifier** and delegates implementation to a child pinned to **Qwen 3.8 27B**.

## Architecture

```text
User
  ↓
Supervisor model selected in Harness
  ↓ inspect / decide next step
qwen_builder
  ↓ edit repository / test / report
Supervisor
  ↓ independently inspect files/diff/tests
accept OR delegate correction
  ↓
repeat until verified complete
```

The supervisor can be any model configured in Harness. To approximate the intended "OpenAI guides Qwen" setup, select an OpenAI API model as the session model. The worker remains fixed to:

```text
provider: qwen
model: qwen3.8-27b
maxTokens: 32768
```

The ChatGPT web conversation itself is not directly embedded into Harness; the automatic supervisor must be a model endpoint configured inside Harness.

## Why this instead of Ralph

Harness's Ralph workflow repeatedly launches fresh workers, but completion is still a worker self-declaration and the built-in Ralph flow has no independent evaluator deciding whether the objective is actually complete.

This preset makes the parent model the evaluator. It delegates one bounded coding task, receives the worker result, then independently inspects the actual workspace and verification evidence before deciding whether to continue.

## Worker lifecycle

`qwen_builder` uses the in-process `spawn` subagent provider with `enableRunInBackground: false`.

Each invocation is a fresh Qwen child. It does not inherit the supervisor conversation, so the supervisor must send a standalone prompt. The child is created from the same parent workspace/cwd, so repository files carry durable state between rounds.

Fresh workers are intentional:

- no long Qwen conversation accumulating across the whole project;
- each implementation step gets a focused context;
- corrections start from the real modified workspace rather than old conversational assumptions;
- the expensive strategic context stays with the supervisor;
- the supervisor can shrink a task after a token-limit failure.

## Install

From the `All-testing` repository on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\llm\harness-presets\supervisor-qwen\Install-SupervisorQwenMode.ps1
```

This copies the preset to:

```text
%USERPROFILE%\.dsh\.agent-presets\supervisor-qwen\agent.cordis.yml
```

If `DSH_HOME` is set, the installer uses:

```text
%DSH_HOME%\.agent-presets\supervisor-qwen\agent.cordis.yml
```

Restart the Harness host after installation and select `supervisor-qwen` as the session mode.

## Model requirements

The Qwen provider must already be configured in Harness under exactly:

```text
provider: qwen
model: qwen3.8-27b
```

The preset assumes the Qwen API endpoint is available whenever implementation is delegated. With the planned public API gateway this can eventually be `https://api.zetbros.com/v1`; the preset itself does not care whether Qwen is reached through localhost or a remote OpenAI-compatible URL.

## Recommended use

Give the supervisor the complete product objective. The supervisor should inspect the project, create a plan, and then iterate through small verifiable worker tasks.

Example flow:

```text
Supervisor: inspect current auth implementation
Supervisor → qwen_builder: implement refresh-token storage + tests
Qwen: edits files, runs tests, reports
Supervisor: inspect diff and test output
Supervisor → qwen_builder: fix missing invalidation path
Qwen: edits, tests, reports
Supervisor: rerun targeted tests + inspect edge case
Supervisor → qwen_builder: add regression test
Qwen: edits, tests, reports
Supervisor: final verification
Supervisor: report completion to user
```

## Safety / correctness policy

The supervisor is explicitly instructed not to trust the worker's completion claim by itself. It should inspect repository state and verification evidence before ending the loop.

The Qwen child is capped at delegation depth 1 so it cannot recursively fan out additional subagents. This keeps responsibility clear: supervisor decides, Qwen builds.
