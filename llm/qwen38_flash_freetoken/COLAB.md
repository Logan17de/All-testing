# Colab operating notes

Target runtime: **A100 80 GB + high-memory (~250 GB host RAM)**.

Before model load, confirm all three resources:

```bash
nvidia-smi
free -h
df -h /content
```

The host-RAM budget is tight because the routed experts remain compressed FP8 but Qwen's giant n-gram embedding is host-resident and roughly 95 GiB in the current upstream implementation. Avoid making full checkpoint copies in RAM and avoid pinning the entire routed expert pool.

If local Colab disk is smaller than the repository footprint shown by `qwen38-flash-ft manifest`, use a sufficiently large persistent disk (or Drive only if you have enough quota and accept much slower FUSE I/O) and set `RuntimeConfig.cache_dir` there **before** the strict doctor/load step.

Start with `cache_format="bf16"`. The runtime dynamically clamps the requested expert cache to free VRAM after ordinary CUDA FP8 linears are converted to BF16 and after the prefill reserve is considered.

If full-layer pinned staging allocation fails, the code falls back to pageable staging. That should be reported in benchmarks because H2D overlap can change materially.


## Disk requirement

The official FP8 checkpoint is roughly **185.5 GB (~173 GiB)** across 131 safetensors shards. The notebook preflight requires about **190 GiB free** on the filesystem backing `cache_dir` before model load. This is separate from the ~250 GB system-RAM requirement.
