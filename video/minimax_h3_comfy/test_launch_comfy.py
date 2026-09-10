"""CPU-only launcher regressions; fixture parser, no models, GPU, or tunnel.

Run: python -m unittest discover -s video/minimax_h3_comfy -p test_launch_comfy.py -v
The production launcher separately validates against the installed ComfyUI parser.
"""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

LAUNCHER = Path(__file__).with_name("launch_comfy.sh")
SOURCE = LAUNCHER.read_text(encoding="utf-8")
ARGS_PREFIX = SOURCE.split("# Launch or reuse ComfyUI.", 1)[0]
STARTUP = SOURCE.split("# Keep ComfyUI alive when refreshing the public tunnel.", 1)[0]

# Deliberately excludes the retired normalvram option. This is a narrow fixture,
# not a vendored ComfyUI installation or evidence of GPU compatibility.
PARSER_FIXTURE = '''import argparse
import comfy.options
parser = argparse.ArgumentParser()
parser.add_argument("--listen")
parser.add_argument("--port", type=int)
parser.add_argument("--disable-auto-launch", action="store_true")
parser.add_argument("--reserve-vram", type=float)
parser.add_argument("--preview-method", choices=["none", "auto", "latent2rgb", "taesd"])
group = parser.add_mutually_exclusive_group()
group.add_argument("--highvram", action="store_true")
group.add_argument("--lowvram", action="store_true")
args = parser.parse_args() if comfy.options.args_parsing else parser.parse_args([])
'''


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = os.environ.copy()
        self.env.pop("H3_VRAM_MODE", None)
        self.env.update(COMFY_ROOT=str(self.root), H3_LOG_DIR=str(self.root / "logs"),
                        H3_RESERVE_VRAM_GB="6", H3_PREVIEW_METHOD="none", COMFY_PORT="8188")

    def run_bash(self, source, **overrides):
        return subprocess.run(["bash", "-c", source], env={**self.env, **overrides},
                              capture_output=True, text=True, timeout=15)

    def collect_args(self, mode=None):
        overrides = {} if mode is None else {"H3_VRAM_MODE": mode}
        result = self.run_bash(ARGS_PREFIX + '\nprintf "%s\\0" "${COMFY_ARGS[@]}"\n', **overrides)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout.rstrip("\0").split("\0")

    def prepare_fixture(self, healthy=False):
        comfy = self.root / "comfy"
        comfy.mkdir()
        (comfy / "__init__.py").write_text("")
        (comfy / "options.py").write_text(
            "args_parsing = False\ndef enable_args_parsing():\n    global args_parsing\n    args_parsing = True\n")
        (comfy / "cli_args.py").write_text(PARSER_FIXTURE)
        (self.root / "main.py").write_text(
            "from pathlib import Path\nPath('started').touch()\nprint('fixture startup failure', flush=True)\nraise SystemExit(17)\n")
        bindir = self.root / "bin"
        bindir.mkdir()
        for name, status in (("curl", 0 if healthy else 1), ("pkill", 0)):
            p = bindir / name
            p.write_text(f"#!/usr/bin/env bash\nexit {status}\n")
            p.chmod(0o755)
        self.env["PATH"] = str(bindir) + os.pathsep + self.env["PATH"]

    def test_shell_syntax(self):
        result = subprocess.run(["bash", "-n", str(LAUNCHER)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_default_and_legacy_aliases_use_no_mode_flag(self):
        for mode in (None, "", "auto", "default", "normalvram"):
            with self.subTest(mode=mode):
                args = self.collect_args(mode)
                self.assertEqual(args, ["--listen", "0.0.0.0", "--port", "8188",
                                       "--disable-auto-launch", "--reserve-vram", "6",
                                       "--preview-method", "none"])

    def test_explicit_modes_preserved(self):
        for mode in ("highvram", "lowvram"):
            with self.subTest(mode=mode):
                args = self.collect_args(mode)
                self.assertIn("--" + mode, args)
                self.assertNotIn("--normalvram", args)

    def test_unknown_mode_rejected(self):
        result = self.run_bash(ARGS_PREFIX, H3_VRAM_MODE="typo")
        self.assertEqual(result.returncode, 2)
        self.assertIn("H3_VRAM_MODE must be", result.stdout)

    def test_preflight_rejects_bad_preview_before_server(self):
        self.prepare_fixture()
        result = self.run_bash(STARTUP, H3_PREVIEW_METHOD="not-a-preview")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("argument preflight failed", result.stdout)
        self.assertFalse((self.root / "started").exists())

    def test_startup_exit_is_reported_without_full_timeout(self):
        self.prepare_fixture()
        start = time.monotonic()
        result = self.run_bash(STARTUP, H3_VRAM_MODE="normalvram")
        self.assertLess(time.monotonic() - start, 10)
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        self.assertIn("ComfyUI CLI argument check: PASSED", result.stdout)
        self.assertIn("exit 17", result.stdout)
        self.assertIn("fixture startup failure", result.stdout)
        self.assertTrue((self.root / "started").exists())

    def test_healthy_process_reused(self):
        self.prepare_fixture(healthy=True)
        result = self.run_bash(STARTUP)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("reusing it", result.stdout)
        self.assertFalse((self.root / "started").exists())


if __name__ == "__main__":
    unittest.main()
