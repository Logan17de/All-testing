# Architecture and implementation map

## 1. Design invariant

The baseline engine must produce the same routed MoE computation as the original checkpoint. We are allowed to change **where** expert weights live, **when** they move, and **which processor** evaluates a cache miss. We do not change the router, skip experts, prune tokens, substitute experts, or retrain anything.

That gives the core abstraction:

```python
router -> route plan -> GPU cached/fetched experts + optional CPU misses -> exact weighted merge
```

## 2. Why Qwen3.8 Flash-Next is a good target

The current Qwen4Exp text implementation exposes routed experts as packed 3-D tensors:

- `gate_up_proj`: `[num_experts, 2 * intermediate, hidden]`
- `down_proj`: `[num_experts, hidden, intermediate]`

For the published 48-layer / 512-expert / H=2560 / I=640 configuration, one routed expert has:

- raw FP8 weights: `3 * H * I = 4,915,200 bytes`
- FP8 block-scale metadata: ~1.2 KB with 128×128 blocks

So the entire routed pool is roughly 112.5 GiB plus scale metadata, while only 10 routed experts are selected per layer/token.

The upstream model also marks `ple.ple_embedding.ngram_embedding.weight` as a special no-placement parameter and performs the lookup on the embedding device before returning only selected vectors to the active device. Because this runtime supplies an explicit device map, `loader.py` additionally maps the checkpoint's configured PLE layer(s) to CPU explicitly.

## 3. A100-specific execution contract

Transformers' normal fine-grained FP8 quantizer treats SM89+ as the supported FP8 execution target and otherwise globally dequantizes a prequantized checkpoint. Globally dequantizing Qwen Flash would destroy our host-memory budget.

`a100_storage.py` therefore:

1. temporarily suppresses only the SM80 global-dequantize decision while loading the **already prequantized** checkpoint;
2. keeps CPU routed `FP8Experts` compressed;
3. dequantizes every CUDA-resident ordinary `FP8Linear` once to a standard BF16 `nn.Linear` before forward;
4. removes Accelerate's CPU execution hook from expert modules so their **weights remain CPU** but hidden states stay on the A100 when the custom expert backend is called.

The custom backend never asks A100 to execute native FP8 GEMM. Expert misses travel as FP8 bytes, then compute is BF16.

## 4. Decode cache

`GPUExpertSlotCache` preallocates fixed-shape complete-expert slots.

### BF16 cache mode (default A100)

```text
host expert FP8 + scales
        │ PCIe (~4.92 MB/expert)
        ▼
GPU temporary FP8
        │ dequant once
        ▼
BF16 LRU slot (~9.83 MB/expert)
        │
        └── repeated native BF16 A100 GEMMs
```

This trades cache capacity for faster hits.

### FP8 cache mode

```text
host FP8 ─PCIe→ FP8 LRU slot ─dequant on each use→ BF16 GEMM
```

This roughly doubles slot count and is included as an ablation.

## 5. Prefill

Per-expert on-demand fetch is a poor long-prompt strategy because the union of routes tends toward most experts in a layer.

The prototype allocates two full FP8 layer buffers on GPU and one host staging bank. While current layer `l` computes, a background worker stages and transfers `l+1` into the alternate GPU buffer. If pinned host allocation succeeds, H2D is issued non-blocking; if not, the system degrades to pageable staging without changing output.

Because A100 lacks native FP8 compute, the current prefill kernel dequantizes each actually-used expert from the resident FP8 layer buffer and executes BF16 GEMMs. A future Triton kernel should fuse block dequant + grouped expert GEMM and remove Python route loops.

At each layer, the final prompt token's selected experts are promoted from the full layer buffer straight into the decode LRU. That costs **zero additional PCIe bytes** and makes the decode working set warm immediately.

## 6. q* CPU/GPU miss split

For `m` misses, measured host bandwidth `B_H` and H2D expert bandwidth `B_P`, the reference policy uses:

```text
q* = clamp(round(m * B_P / B_H), 1, m)
```

when `B_H > B_P`, otherwise all misses are fetched. `q*` misses fill GPU slots and the remainder run on CPU concurrently.

The current CPU branch is intentionally a correctness implementation: FP8 blocks are dequantized to BF16 and evaluated with ordinary PyTorch operations. It is too slow to be called a performance backend. Before enabling hybrid mode for speed, replace it with compiled SIMD/AMX-style expert GEMV/GEMM and profile the *actual expert shape* under simultaneous PCIe traffic.

## 7. Transformers integration

Current Transformers has a public `ExpertsInterface`. Qwen4Exp's routed expert class is decorated with it, and the fine-grained FP8 conversion has its own compatible expert interface. `backend.register_backend()` registers `freetoken` with both.

This is valuable because the rest of Qwen remains upstream code:

- Gated DeltaNet
- Qwen Sparse Attention
- router and gate normalization
- shared expert
- PLE / n-gram logic
- recurrent/KV state
- generation loop

Our code only owns heterogeneous routed-expert execution.

## 8. Serving / Harness

`serve.py` exposes a private OpenAI-compatible endpoint on `127.0.0.1:8000` and retains the served model name expected by the existing relay. `relay.py` reuses `qwen_supabase_relay.RelayStore` and the existing `QwenRelayWorker`, so no public Colab tunnel is introduced.

Tool calls use a compatibility parser for Qwen `<tool_call>{...}</tool_call>` blocks. Streaming currently preserves SSE protocol but emits after complete generation so tool parsing is stable. True incremental parser/streaming is a serving optimization after inference correctness.

## 9. Next optimization milestones

### Milestone A — target-hardware proof

- A100 high-RAM load succeeds without global BF16 model expansion.
- 48 FP8 expert banks stay in host RAM.
- non-expert CUDA linears are BF16.
- deterministic short generation succeeds.
- record peak host RAM / VRAM.

### Milestone B — route/cache kernel

Move these Python operations to fixed CUDA workspaces:

- route dedup
- `(layer, expert)` residency lookup
- hit/miss compaction
- LRU victim selection
- q* fill count
- logical expert → physical slot rewrite

No `.cpu().tolist()` in the decode hot path.

### Milestone C — A100 fused expert kernel

Build Triton/CUDA kernels that consume checkpoint FP8 blocks but execute using A100-supported BF16/FP16 tensor-core math without materializing a complete BF16 expert on each operation. Benchmark against BF16-cache mode.

### Milestone D — high-performance CPU branch

- fixed physical-core pool
- NUMA affinity
- blockwise FP8 dequant integrated into GEMV/GEMM
- simultaneous CPU + H2D bandwidth calibration
- exact CPU/GPU partial-sum equivalence tests

### Milestone E — CUDA Graph serving

- fixed route descriptors and counts
- fixed cache workspaces
- persistent CPU workers / host callback nodes
- batch sizes 1/2/4
- elastic KV/expert partition only at scheduler-safe points

### Milestone F — agent-serving features

- radix prefix reuse
- recurrent-state anchors at tool-call/tool-output/turn boundaries
- MTP/speculative decoding as a separate ablation
- true streaming tool parser

Approximate mechanisms such as token pruning or early exit stay out of the exact baseline.
