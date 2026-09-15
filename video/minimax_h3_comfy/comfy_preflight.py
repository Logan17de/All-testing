#!/usr/bin/env python3
"""Local Colab process control only; never downloads models or queues a workflow."""

import argparse
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

PUBLIC_URL = "https://comfy.zetbros.com"
ORIGIN = "http://127.0.0.1:8188"
ROOT = Path(os.environ.get("COMFY_ROOT", "/content/ComfyUI")).resolve()
LOG = Path(os.environ.get("H3_LOG_DIR", "/content/h3_comfy_logs"))
TOKEN_PATTERN = r"eyJ[A-Za-z0-9._=+/-]+"


def redact(text):
    text = re.sub(TOKEN_PATTERN, "[REDACTED]", text)
    return re.sub(
        r"(?i)((?:--token|(?:CF_)?TUNNEL_TOKEN|CF[-_]ACCESS[-_]CLIENT[-_](?:SECRET|ID)|"
        r"Authorization|Cookie|Set-Cookie)[\"']?\s*[:= ]\s*)([^\r\n]+)",
        r"\1[REDACTED]", text,
    )


def run_setup_command(args, *, label, cwd=None):
    """Relay child output through notebook stdout and preserve a redacted setup log."""
    LOG.mkdir(parents=True, exist_ok=True)
    path = LOG / "setup.log"
    with path.open("a", encoding="utf-8") as log:
        def emit(text):
            safe = redact(text)
            print(safe, end="", flush=True)
            log.write(safe)
            log.flush()

        emit(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')} | {label} ===\n")
        try:
            with subprocess.Popen(args, cwd=cwd, stdout=subprocess.PIPE,
                                  stderr=subprocess.STDOUT, text=True,
                                  encoding="utf-8", errors="replace", bufsize=1) as child:
                for line in child.stdout:
                    emit(line)
                status = child.wait()
        except OSError as error:
            emit(f"Could not start setup command: {error}\n")
            raise SystemExit(f"Setup stopped: {label}. See {path}.") from None
        if status:
            emit(f"SETUP FAILED: {label} (exit {status}). Log: {path}\n")
            raise SystemExit("Setup stopped. Share the error lines above; model downloads remain gated.")


def extract_token(raw):
    tokens = re.findall(TOKEN_PATTERN, raw or "")
    if len(tokens) != 1:
        raise RuntimeError("CF_TUNNEL_TOKEN must contain exactly one eyJ... tunnel token.")
    return tokens[0]


def read_token():
    try:
        if os.environ.get("CF_TUNNEL_TOKEN"):
            return extract_token(os.environ["CF_TUNNEL_TOKEN"])
        from google.colab import userdata
        return extract_token(userdata.get("CF_TUNNEL_TOKEN"))
    except Exception:
        raise RuntimeError("Cannot read CF_TUNNEL_TOKEN. Check Colab Secrets and notebook access.") from None


def process_info(pid):
    """Identify processes by Linux PID/start time, UID and this runtime's namespaces."""
    try:
        proc = Path("/proc") / str(pid)
        if proc.stat().st_uid != os.getuid():
            return None
        for ns in ("pid", "net"):
            if os.readlink(proc / "ns" / ns) != os.readlink(f"/proc/self/ns/{ns}"):
                return None
        stat = (proc / "stat").read_text().rsplit(")", 1)[1].split()
        if stat[0] == "Z":
            return None
        args = (proc / "cmdline").read_bytes().decode(errors="replace").rstrip("\0").split("\0")
        return {"pid": int(pid), "start": stat[19], "args": args,
                "cwd": (proc / "cwd").resolve()}
    except (OSError, ValueError, IndexError):
        return None


def option(args, name, default=None):
    for i, arg in enumerate(args):
        if arg.startswith(name + "="):
            return arg.split("=", 1)[1]
        if arg == name and i + 1 < len(args):
            return args[i + 1]
    return default


def matches(info, kind):
    args = info["args"]
    if not args:
        return False
    if kind == "cloudflared":
        return Path(args[0]).name == "cloudflared" and "tunnel" in args and "run" in args
    return (Path(args[0]).name.startswith("python")
            and any(arg == "main.py" or arg == str(ROOT / "main.py") for arg in args[1:])
            and info["cwd"] == ROOT
            and option(args, "--port", "8188") == "8188")


def processes(kind):
    result = []
    for proc in Path("/proc").iterdir():
        if proc.name.isdigit():
            info = process_info(proc.name)
            if info and matches(info, kind):
                result.append(info)
    return result


def same_process(info):
    current = process_info(info["pid"])
    return current is not None and current["start"] == info["start"]


def stop_processes(items):
    for info in items:
        for sig, timeout in ((signal.SIGTERM, 15), (signal.SIGKILL, 5)):
            if not same_process(info):
                break
            try:
                os.kill(info["pid"], sig)
            except ProcessLookupError:
                break
            deadline = time.monotonic() + timeout
            while same_process(info) and time.monotonic() < deadline:
                time.sleep(0.2)
        if same_process(info):
            raise RuntimeError(f"Process {info['pid']} did not stop; refusing to start a duplicate.")


def healthy():
    try:
        # Bypass proxy environment variables for the exact local origin.
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
            ORIGIN + "/system_stats", timeout=3
        ) as response:
            stats = json.load(response)
            return response.status == 200 and isinstance(stats, dict) and "system" in stats
    except (OSError, ValueError):
        return False


def tail_log(name):
    path = LOG / name
    if path.exists():
        # Bound the read even when generation has produced a very large log.
        with path.open("rb") as stream:
            stream.seek(max(0, path.stat().st_size - 65536))
            print(redact("\n".join(stream.read().decode(errors="replace").splitlines()[-50:])))


def start_process(args, name, env=None, cwd=None):
    env = (os.environ if env is None else env).copy()
    env.pop("CF_TUNNEL_TOKEN", None)
    if name != "cloudflared":
        env.pop("TUNNEL_TOKEN", None)
    with (LOG / (name + ".log")).open("w") as log:
        child = subprocess.Popen(args, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    (LOG / (name + ".pid")).write_text(str(child.pid))
    return child


def start_comfy(restart=False):
    existing = processes("comfyui")
    if (not restart and len(existing) == 1 and healthy()
            and option(existing[0]["args"], "--listen") == "127.0.0.1"):
        print("Existing ComfyUI is healthy on 127.0.0.1:8188; reusing it.")
        return
    if healthy() and not existing:
        raise RuntimeError("Port 8188 is served by an unrecognized process; it was left untouched.")
    args = [sys.executable, "main.py", "--listen", "127.0.0.1", "--port", "8188",
            "--disable-auto-launch", *json.loads(os.environ.get("H3_COMFY_VRAM_ARGS", "[]"))]
    with (LOG / "cli-check.log").open("w") as log:
        result = subprocess.run([
            sys.executable, "-c",
            "import comfy.options; comfy.options.enable_args_parsing(); import comfy.cli_args",
            *args[2:],
        ], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
    if result.returncode:
        tail_log("cli-check.log")
        raise RuntimeError("ComfyUI CLI argument check failed. No server was started.")
    print("ComfyUI CLI argument check: PASSED")
    stop_processes(existing)
    child = start_process(args, "comfyui", cwd=ROOT)
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        if child.poll() is not None:
            tail_log("comfyui.log")
            raise RuntimeError("ComfyUI exited during startup.")
        if healthy():
            print("ComfyUI /system_stats: HTTP 200.")
            return
        time.sleep(1)
    raise RuntimeError("ComfyUI did not become healthy. Run diagnostics; no second process was started.")


def registered():
    path = LOG / "cloudflared.log"
    return path.exists() and "Registered tunnel connection" in path.read_text(errors="replace")


def check_preflight():
    comfy = processes("comfyui")
    tunnels = processes("cloudflared")
    if (len(comfy) != 1 or option(comfy[0]["args"], "--listen") != "127.0.0.1"
            or not healthy() or len(tunnels) != 1 or not registered()):
        raise RuntimeError("Preflight is no longer healthy. Rerun preflight before continuing.")
    pid_path = LOG / "cloudflared.pid"
    if not pid_path.exists() or pid_path.read_text().strip() != str(tunnels[0]["pid"]):
        raise RuntimeError("The running connector does not match this preflight. Rerun preflight.")


def start_tunnel():
    # Read/validate first: failure leaves an existing connector untouched.
    token = read_token()
    if not shutil.which("cloudflared"):
        arch = {"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine().lower())
        if not arch:
            raise RuntimeError("Unsupported cloudflared architecture.")
        subprocess.run(["curl", "-fL", "--retry", "3", "--retry-delay", "2",
                        f"https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-{arch}",
                        "-o", "/usr/local/bin/cloudflared"], check=True)
        Path("/usr/local/bin/cloudflared").chmod(0o755)
    stop_processes(processes("cloudflared"))
    env = os.environ.copy()
    # Official equivalent of --token, without a credential in process arguments.
    env["TUNNEL_TOKEN"] = token
    child = start_process(["cloudflared", "tunnel", "--no-autoupdate", "run"], "cloudflared", env=env)
    del token, env
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if child.poll() is not None:
            tail_log("cloudflared.log")
            raise RuntimeError("cloudflared exited before registering.")
        if registered():
            return
        time.sleep(1)
    raise RuntimeError("Cloudflare did not register within 60 seconds. Run diagnostics.")


def diagnostics():
    commands = [
        ["curl", "--noproxy", "*", "-sS", "--connect-timeout", "2", "--max-time", "5", "-o", "/dev/null", "-w", "HTTP %{http_code}\n", ORIGIN + "/system_stats"],
        ["ss", "-ltnp"],
    ]
    for cmd in commands:
        print("Local /system_stats:" if cmd[0] == "curl" else "Listener on 8188:")
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
            output = result.stdout + result.stderr
            if cmd[0] == "ss":
                output = "\n".join(line for line in output.splitlines() if ":8188" in line)
            print(redact(output))
        except (OSError, subprocess.TimeoutExpired):
            print("Diagnostic command unavailable or timed out.")
    print("cloudflared running PIDs (this runtime):", [p["pid"] for p in processes("cloudflared")])
    for name in ("setup.log", "cloudflared.log", "comfyui.log"):
        print(f"\n=== {name}: last 50 lines ===")
        tail_log(name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("preflight", "restart", "check", "diagnostics"))
    action = parser.parse_args().action
    if sys.platform != "linux":
        raise RuntimeError("Run this helper inside the Colab Linux runtime.")
    LOG.mkdir(parents=True, exist_ok=True)
    if action == "diagnostics":
        diagnostics()
        return
    # Serialize repeated launch cells without installing a service.
    import fcntl
    with (LOG / "launch.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Another launch/restart is in progress; wait for it to finish.") from None
        if action == "check":
            check_preflight()
        elif action == "restart":
            check_preflight()
            start_comfy(restart=True)
            check_preflight()
            print("FINAL READY\n" + PUBLIC_URL)
            print("Refresh the browser once so the model dropdowns reload.")
        else:
            start_comfy()
            if not healthy():
                raise RuntimeError("Local /system_stats must return HTTP 200 before starting Cloudflare.")
            start_tunnel()
            check_preflight()
            print("OPEN COMFYUI:\n" + PUBLIC_URL)
            print("Verify the full UI, workflow canvas and connection in your browser before approving downloads.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("ERROR: " + redact(str(error)), file=sys.stderr)
        sys.exit(1)
