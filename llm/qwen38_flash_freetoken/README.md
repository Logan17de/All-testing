# Qwen3.8-Flash-Next × FreeToken-style Colab runtime

Research implementation for running **`Qwen/Qwen3.8-Flash-Next-FP8`** on a single **A100 80 GB + ~250 GB host-RAM Colab runtime** by treating CPU RAM, PCIe and A100 VRAM as one heterogeneous MoE memory system.

This is deliberately **text-only** for the first milestone. It reuses the existing `All-testing/llm` outbound Supabase → Harness bridge after the local model is ready.

## Why this implementation is different on A100

Qwen3.8 Flash-Next is an FP8 checkpoint, but A100 (SM80) has no native FP8 Tensor-Core path. Current Transformers normally dequantizes an FP8 checkpoint globally on SM80, which defeats the host-memory capacity advantage for this model.

This runtime instead uses:

- **FP8 checkpoint storage in host RAM** for routed experts.
- **BF16 compute for ordinary GPU-resident linears**: CUDA-resident `FP8Linear` modules are dequantized once after load.
- **FP8 over PCIe for expert misses**, then either:
  - dequantize once into a **BF16 global LRU expert slot** (default A100 mode), or
  - keep an FP8 slot and dequantize on each hit (`cache_format=fp8`, capacity experiment).
- The huge Qwen PLE n-gram embedding remains host-resident. The upstream Qwen4Exp implementation already explicitly handles its CPU lookup and returns only selected vectors to the active device; this runtime also maps the configured PLE layer explicitly to CPU because it uses an explicit device map.

The goal is therefore **FP8 storage/bandwidth efficiency + native BF16 A100 compute**, not fake “native FP8 A100” claims.

## Architecture

```text
                         ~250 GB HOST RAM
┌──────────────────────────────────────────────────────────────────────┐
│ Qwen FP8 routed expert banks (authoritative)                         │
│ 48 layers × 512 experts                                              │
│                                                                      │
│ Giant PLE n-gram embedding (upstream Qwen host-resident path)        │
│                                                                      │
│ Optional CPU reference executor for q* correctness experiments       │
└───────────────┬───────────────────────────────┬──────────────────────┘
                │                               │
      background full-layer             decode cache misses
       FP8 staging/copy                    FP8 + scales
                │                               │
                ▼                               ▼
                         A100 80 GB
┌──────────────────────────────────────────────────────────────────────┐
│ GPU-resident exact Qwen path                                         │
│ GDN/QSA, routers, shared experts, norms, residual/PLE logic, head    │
│ (CUDA FP8 linears converted once to BF16 on SM80)                    │
│                                                                      │
│ Two full FP8 MoE layer buffers  <── prefill l / prefetch l+1         │
│                                                                      │
│ Global complete-expert LRU slots                                     │
│ default: BF16 slots, filled from FP8 miss bytes                       │
│ optional: FP8 slots                                                  │
│                                                                      │
│ KV/recurrent state + CUDA workspace                                  │
└──────────────────────────────────────────────────────────────────────┘
```

### Prefill

Long prompts activate a large union of experts. The runtime therefore uses two full-layer FP8 GPU buffers. A background worker stages and transfers layer `l+1` while layer `l` computes. At the end of each prompt layer, experts selected by the **last prompt token** are copied/dequantized directly from the already-resident full-layer buffer into the global decode LRU, so the first decode token does not start with a totally cold cache.

### Decode

For each layer:

1. Run the checkpoint's original router.
2. Deduplicate routed experts.
3. Check global `(layer, expert)` LRU slots.
4. Cache hits run locally on A100.
5. Misses are transferred as FP8 + block scales.
6. Default `gpu_fill` mode dequantizes a miss once into a BF16 slot and computes it on A100.
7. `hybrid_reference` can split misses with `q* ≈ m × B_pcie / B_host`, running residual misses on a slow exact-structure CPU reference path and merging all gate-weighted contributions.

No routed expert is skipped or substituted.

## What is implemented now

| Component | Status |
|---|---|
| Qwen architecture/config drift check | ✅ |
| A100 hardware/RAM preflight | ✅ |
| Keep prequantized routed FP8 storage on SM80 | ✅ |
| CUDA non-expert FP8 → BF16 conversion | ✅ |
| Transformers custom `Experts` backend registration | ✅ |
| Host-authoritative routed experts | ✅ |
| Fixed-shape global GPU expert slots | ✅ |
| Global LRU semantics | ✅ reference metadata path |
| FP8-over-PCIe → BF16 cache admission | ✅ |
| FP8 cache alternative | ✅ |
| Full-layer two-buffer prefill | ✅ prototype |
| Background host staging / H2D overlap | ✅ prototype |
| Last-prompt-token decode cache warming | ✅ |
| q* scheduler | ✅ |
| CPU/GPU exact merge | ✅ **reference/slow** |
| Local OpenAI-compatible API | ✅ |
| Existing Supabase → Harness relay reuse | ✅ |
| CUDA-device route/LRU planner | ⏳ next optimization |
| CUDA Graph hot path | ⏳ |
| High-performance CPU FP8/BF16 expert kernel | ⏳ |
| True token-by-token SSE | ⏳ compatibility stream currently flushes after generation |
| MTP/speculative decoding | ⏳ after exact baseline |
| Image input | intentionally disabled |

**Important:** CPU CI tests validate the scheduling/cache invariants, but this branch cannot be declared A100-performance-validated until the Colab notebook completes an end-to-end model load and generation on the target runtime.

## Colab quick start

Open `notebooks/Qwen3_8_Flash_FreeToken_A100.ipynb` and run cells in order. The notebook starts with cheap preflight/metadata tests before downloading/loading the checkpoint.

Command-line equivalents:

```bash
qwen38-flash-ft doctor
qwen38-flash-ft manifest
qwen38-flash-ft plan --cache-gib 42 --cache-format bf16
qwen38-flash-ft bandwidth
```

Then, on the A100 high-RAM runtime:

```bash
qwen38-flash-ft run-local --cache-gib 42 --cache-format bf16 --context 32768
```

Or use the existing private Harness relay:

```bash
qwen38-flash-ft run-relay --cache-gib 42 --cache-format bf16 --context 32768
```

`QWEN_RELAY_SECRET` must be present in Colab Secrets for relay mode. `ORACLE_WAKE_GITHUB_TOKEN` remains optional, matching the existing `All-testing` worker flow.

## Validation order

Do not jump directly to a long Harness session. The intended gates are:

1. `doctor` — A100/RAM **and enough local disk** detected (the official FP8 repo is ~185.5 GB / ~173 GiB of files, so the notebook requires ~190 GiB free before download).
2. `manifest` — current checkpoint still matches the architecture we coded for.
3. `plan` — expected host/GPU memory is feasible.
4. CPU unit tests.
5. A100 bandwidth profile.
6. Model load with exactly **48** expert banks bound to the backend.
7. 1-token/16-token deterministic smoke generation.
8. Compare deterministic logits/output against a reference implementation on a smaller compatible Qwen4Exp checkpoint if/when one is available.
9. Measure cache hit/miss and PCIe bytes/token.
10. Only then enable Harness agent workloads.

## Notes on exactness

The engine's baseline policy changes **placement and scheduling only**. The checkpoint tokenizer, router, top-k routing, gate weights, attention/recurrent path and all expert contributions remain intact. The optional CPU branch is slow because it dequantizes and executes with ordinary PyTorch BF16 operations; it exists first as an exactness oracle for heterogeneous merge behavior, not as the final performance kernel.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the implementation mapping and next optimization milestones.
