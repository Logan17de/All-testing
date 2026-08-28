from __future__ import annotations

import argparse
import json
from dataclasses import asdict

from .config import RuntimeConfig


def _cfg(args) -> RuntimeConfig:
    cfg = RuntimeConfig()
    if getattr(args, "cache_gib", None) is not None:
        cfg.expert_cache_gib = args.cache_gib
    if getattr(args, "cache_format", None):
        cfg.cache_format = args.cache_format
    if getattr(args, "context", None):
        cfg.max_context_tokens = args.context
    return cfg


def main(argv=None):
    parser = argparse.ArgumentParser(prog="qwen38-flash-ft")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("doctor")
    sub.add_parser("manifest")
    p = sub.add_parser("plan")
    p.add_argument("--cache-gib", type=float, default=42.0)
    p.add_argument("--cache-format", choices=["bf16", "fp8"], default="bf16")
    sub.add_parser("bandwidth")
    p = sub.add_parser("simulate-cache")
    p.add_argument("--tokens", type=int, default=1000)
    p.add_argument("--fraction", type=float, default=0.20)
    p = sub.add_parser("run-local")
    p.add_argument("--cache-gib", type=float, default=42.0)
    p.add_argument("--cache-format", choices=["bf16", "fp8"], default="bf16")
    p.add_argument("--context", type=int, default=32768)
    p = sub.add_parser("run-relay")
    p.add_argument("--cache-gib", type=float, default=42.0)
    p.add_argument("--cache-format", choices=["bf16", "fp8"], default="bf16")
    p.add_argument("--context", type=int, default=32768)

    args = parser.parse_args(argv)
    cfg = _cfg(args)

    if args.cmd == "doctor":
        from .hardware import collect_hardware_report, validate_colab_target
        r = collect_hardware_report()
        print(json.dumps(r.as_dict(), indent=2))
        print("problems:", validate_colab_target(cfg, strict=False))
    elif args.cmd == "manifest":
        from .manifest import inspect_remote_model, validate_manifest
        m = inspect_remote_model(cfg)
        print(json.dumps(m.as_dict(), indent=2))
        print(validate_manifest(m, cfg))
    elif args.cmd == "plan":
        from .planner import build_memory_plan
        print(json.dumps(build_memory_plan(cfg).as_dict(), indent=2))
    elif args.cmd == "bandwidth":
        from .hardware import profile_bandwidth
        print(json.dumps(asdict(profile_bandwidth()), indent=2))
    elif args.cmd == "simulate-cache":
        from .bench import simulate_routes
        print(json.dumps(simulate_routes(cfg, tokens=args.tokens, cache_fraction=args.fraction), indent=2))
    elif args.cmd == "run-local":
        import secrets
        from .loader import load_qwen_runtime
        from .serve import run_server
        loaded = load_qwen_runtime(cfg)
        key = secrets.token_urlsafe(32)
        print(f"Local API key: {key}")
        run_server(loaded, key)
    elif args.cmd == "run-relay":
        from .relay import run_colab_harness_worker
        run_colab_harness_worker(cfg)


if __name__ == "__main__":
    main()
