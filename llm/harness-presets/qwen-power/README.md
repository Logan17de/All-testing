# Qwen Power Code Mode

A DeepSeek Harness custom agent preset tuned for the self-hosted `Qwen/Qwen3.8-27B` relay in this repository.

## Why

The shipped Code/PTC mode is already strong, but Qwen3.8 can spend a large fraction of a turn reasoning before it reaches the final answer. For coding tasks this can be wasteful when the model drafts implementation code in reasoning and then writes essentially the same implementation through tools.

This preset keeps the full Code/PTC tool stack while explicitly steering the model to:

- inspect the repository first;
- reason about decisions rather than reproduce large code blocks in reasoning;
- write implementation directly through tools/files once the action is clear;
- use programmatic tool calling to batch related operations;
- preserve progress with todos/workflows on long tasks;
- test before finishing;
- keep final replies concise unless full code is explicitly requested.

## Install

Copy `agent.cordis.yml` into the Harness user preset directory:

```text
%USERPROFILE%\.dsh\.agent-presets\qwen-power\agent.cordis.yml
```

If `DSH_HOME` is customized, use:

```text
%DSH_HOME%\.agent-presets\qwen-power\agent.cordis.yml
```

Restart the Harness host after adding a new preset, then select `qwen-power` as the session mode/preset.

## Qwen model settings

Merge `settings-snippet.yml` into Harness settings. The important values are:

```yaml
contextWindow: 262144
maxTokens: 32768
reasoningEfforts:
  low: low
  medium: medium
  xhigh: xhigh
```

Use `medium` for normal agentic coding. Switch to `xhigh` for architecture, difficult debugging, or tasks where extra analysis is worth the additional tokens. `low` is useful for straightforward edits.

Qwen3.8-27B officially exposes `low`, `medium`, and `xhigh`; `xhigh` is the model default.

## Output-token cutoff

The previous Harness model declaration used `maxTokens: 8192`. Thinking/reasoning and the final answer share the normal generation budget unless the serving stack applies a separate reasoning budget. This can make a turn terminate before the final answer is complete.

`32768` is a practical default for the current 262,144-token vLLM context. Remember that input + generated reasoning + final output must still fit the server context window.

## Host plugin recommendations

These are host/deployment settings, not part of the agent preset:

- **Shell command timeout:** increase from `120000` to `300000` ms for builds/tests that legitimately take more than two minutes.
- **Shell output cap per stream:** keep `64000` bytes. Harness already spills excess output to a temporary file; raising this aggressively only pushes more tool text into model context.
- **Web max searches per request:** keep `5` for normal coding. Increase to `8` only if this preset is also used for research-heavy work.

## Thinking-history note

Qwen3.8 enables preserved thinking by default. This keeps prior thinking blocks in conversation history and can improve continuity and prefix/KV-cache reuse in agent workloads. Do not disable it merely because one turn is verbose. Prefer reducing reasoning effort or applying a per-turn thinking-token budget first.
