#!/usr/bin/env python3
"""Local Colab process control only; never downloads models or queues a workflow."""

import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import time
import urllib.request

PUBLIC_URL = "https://comfy.zetbros.com"
ORIGIN = "http://127.0.0.1:8188"
ROOT = Path(os.environ.get("COMFY_ROOT", "/content/ComfyUI")).resolve()
LOG = Path(os.environ.get("H3_LOG_DIR", "/content/h3_comfy_logs"))
TOKEN_PATTERN = r"eyJ[A-Za-z0-9._=+/-]+"
TS_ROOT = Path('/content/h3_tailscale')
TS_SOCKET = str(TS_ROOT / 'tailscaled.sock')
TS_VERSION = '1.102.4'
TS_HASHES = {
    'amd64': '50748df1045e60b5b695f19f4c56b0da36c019948b440fb456b6584a50f0d8b9',
    'arm64': '9dd1e6a592a014bbaea0103167ffe299adeda4ba14e078ce9c2895364f6c4c3f',
}


def access_method():
    method = os.environ.get('H3_ACCESS_METHOD', 'cloudflare')
    if method not in ('tailscale', 'cloudflare'):
        raise RuntimeError('H3_ACCESS_METHOD must be tailscale or cloudflare.')
    return method


def ts_command(*args, timeout=15):
    return subprocess.run([str(TS_ROOT / 'tailscale'), '--socket=' + TS_SOCKET, *args],
                          capture_output=True, text=True, timeout=timeout)


def tailscale_status():
    result = ts_command('status', '--json')
    # Logged-out status can return nonzero but still contain usable JSON.
    try:
        status = json.loads(result.stdout)
        if not isinstance(status, dict) or not status.get('BackendState'):
            raise ValueError()
        return status
    except ValueError:
        raise RuntimeError('Tailscale is unavailable. Run Section 4; see tailscaled.log.') from None


def tailscale_url(status=None):
    status = tailscale_status() if status is None else status
    if status.get('BackendState') != 'Running':
        raise RuntimeError('Finish the Tailscale sign-in from Section 4 before preflight.')
    for value in status.get('TailscaleIPs') or []:
        address = ipaddress.ip_address(value)
        if address.version == 4 and address in ipaddress.ip_network('100.64.0.0/10'):
            return f'http://{address}:8188/'
    raise RuntimeError('Tailscale has no private IPv4 address yet. Rerun Section 4.')


def access_url():
    return tailscale_url() if access_method() == 'tailscale' else PUBLIC_URL


def install_tailscale():
    if all((TS_ROOT / name).is_file() for name in ('tailscale', 'tailscaled')):
        return
    arch = {'x86_64': 'amd64', 'amd64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine().lower())
    if arch not in TS_HASHES:
        raise RuntimeError('Unsupported Tailscale architecture.')
    TS_ROOT.mkdir(parents=True, exist_ok=True)
    archive = TS_ROOT / 'download.tgz'
    url = f'https://pkgs.tailscale.com/stable/tailscale_{TS_VERSION}_{arch}.tgz'
    print(f'Downloading Tailscale {TS_VERSION} ({arch}); no model downloads.', flush=True)
    with urllib.request.urlopen(url, timeout=60) as source, archive.open('wb') as dest:
        shutil.copyfileobj(source, dest)
    with archive.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    if digest != TS_HASHES[arch]:
        raise RuntimeError('Tailscale archive checksum mismatch; nothing was installed.')
    # Read only the two expected regular files; never extract arbitrary archive paths.
    with tarfile.open(archive) as package:
        for name in ('tailscale', 'tailscaled'):
            member = package.getmember(f'tailscale_{TS_VERSION}_{arch}/{name}')
            if not member.isfile():
                raise RuntimeError('Invalid Tailscale archive member.')
            staging = TS_ROOT / (name + '.new')
            with package.extractfile(member) as source, staging.open('wb') as dest:
                shutil.copyfileobj(source, dest)
            staging.chmod(0o755)
            staging.replace(TS_ROOT / name)


def prepare_tailscale_login():
    install_tailscale()
    existing = processes('tailscaled')
    if len(existing) > 1:
        raise RuntimeError('Multiple managed Tailscale daemons found; refusing to add another.')
    child = None
    if not existing:
        child = start_process([str(TS_ROOT / 'tailscaled'), '--tun=userspace-networking',
                               '--state=mem:', '--socket=' + TS_SOCKET], 'tailscaled')
    deadline = time.monotonic() + 15
    while True:
        try:
            status = tailscale_status()
            break
        except (RuntimeError, OSError, subprocess.TimeoutExpired):
            if time.monotonic() >= deadline or (child and child.poll() is not None):
                raise RuntimeError('Tailscale daemon did not start. See tailscaled.log.') from None
            time.sleep(0.5)
    if status['BackendState'] != 'Running':
        # Capture the authorization URL privately: notebook displays it, logs never do.
        result = ts_command('up', '--hostname=colab-comfy', '--accept-dns=false',
                            '--accept-routes=false', '--timeout=8s', timeout=15)
        status = tailscale_status()
        if status['BackendState'] not in ('Running', 'NeedsLogin', 'NeedsMachineAuth'):
            raise RuntimeError('Tailscale sign-in could not start: ' + redact(result.stderr))
        if status['BackendState'] == 'NeedsLogin' and not status.get('AuthURL'):
            raise RuntimeError('No Tailscale sign-in URL was returned; rerun Section 4.')
    print('Tailscale state: ' + status['BackendState'])
    print('Complete the notebook sign-in link, then run Section 5. No models downloaded.')


def check_tailscale():
    if len(processes('tailscaled')) != 1:
        raise RuntimeError('Managed Tailscale daemon is missing or duplicated. Rerun Section 4.')
    status = tailscale_status()
    url = tailscale_url(status)
    result = ts_command('serve', 'status', '--json')
    try:
        config = json.loads(result.stdout)
        handler = config['TCP']['8188']
        if (result.returncode or handler.get('TCPForward') != '127.0.0.1:8188'
                or handler.get('HTTP') or handler.get('HTTPS') or handler.get('TerminateTLS')
                or any(config.get('AllowFunnel', {}).values())):
            raise ValueError()
    except (ValueError, KeyError, TypeError, AttributeError):
        raise RuntimeError('Private Tailscale Serve route is not ready. Rerun Section 5.') from None
    return url


def start_tailscale_serve():
    tailscale_url()  # Fail before mutating Serve if login is incomplete.
    result = ts_command('serve', '--bg', '--tcp=8188', 'tcp://127.0.0.1:8188', timeout=30)
    if result.returncode:
        raise RuntimeError('Tailscale Serve failed: ' + redact(result.stderr))
    print('Private Tailscale route configured: ' + check_tailscale())


def redact(text):
    text = re.sub(r'https://login\.tailscale\.com/\S+|tskey-[A-Za-z0-9_-]+', '[REDACTED]', text)
    text = re.sub(TOKEN_PATTERN, "[REDACTED]", text)
    return re.sub(
        r"(?i)((?:--token|(?:CF_)?TUNNEL_TOKEN|CF[-_]ACCESS[-_]CLIENT[-_](?:SECRET|ID)|"
        r"Authorization|Cookie|Set-Cookie)[\"']?\s*[:= ]\s*)([^\r\n]+)",
        r"\1[REDACTED]", text,
    )


def run_logged_command(args, *, label, cwd=None, env=None, log_name="setup.log"):
    """Relay child output through notebook stdout and preserve a redacted log."""
    LOG.mkdir(parents=True, exist_ok=True)
    path = LOG / log_name
    phase = "Setup" if log_name == "setup.log" else "Launcher"
    with path.open("a", encoding="utf-8") as log:
        def emit(text):
            safe = redact(text)
            print(safe, end="", flush=True)
            log.write(safe)
            log.flush()

        emit(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')} | {label} ===\n")
        try:
            with subprocess.Popen(args, cwd=cwd, env=env, stdout=subprocess.PIPE,
                                  stderr=subprocess.STDOUT, text=True,
                                  encoding="utf-8", errors="replace", bufsize=1) as child:
                for line in child.stdout:
                    emit(line)
                status = child.wait()
        except OSError as error:
            emit(f"Could not start command: {error}\n")
            raise SystemExit(f"{phase} stopped: {label}. See {path}.") from None
        if status:
            emit(f"{phase.upper()} FAILED: {label} (exit {status}). Log: {path}\n")
            raise SystemExit(f"{phase} stopped. See the error lines above; model downloads remain gated.")


def run_setup_command(args, *, label, cwd=None):
    run_logged_command(args, label=label, cwd=cwd)


def run_launcher(action, *, token=None):
    """Notebook entry point: stream launcher errors, retaining the secret in env only."""
    if action not in ("preflight", "check", "restart", "local-storage", "tailscale-login"):
        raise ValueError("Unsupported launcher action.")
    env = os.environ.copy()
    env.pop("CF_TUNNEL_TOKEN", None)
    env.pop("TUNNEL_TOKEN", None)
    env["PYTHONUNBUFFERED"] = "1"
    if token is not None:
        env["CF_TUNNEL_TOKEN"] = extract_token(token)
    try:
        run_logged_command(["bash", str(Path(__file__).with_name("launch_comfy.sh")), action],
                           label=action, env=env, log_name="launcher.log")
    except SystemExit:
        # Read existing evidence only; never start a second process after failure.
        diagnostics()
        raise
    finally:
        env.pop("CF_TUNNEL_TOKEN", None)


def extract_token(raw):
    tokens = re.findall(TOKEN_PATTERN, raw or "")
    if len(tokens) != 1:
        raise RuntimeError("CF_TUNNEL_TOKEN must contain exactly one eyJ... tunnel token.")
    return tokens[0]


def read_token(*, use_environment=True):
    try:
        if use_environment and os.environ.get("CF_TUNNEL_TOKEN"):
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
    if kind == 'tailscaled':
        return (args[0] == str(TS_ROOT / 'tailscaled')
                and option(args, '--socket') == TS_SOCKET)
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


def prepare_local_storage():
    """Replace legacy storage links with local directories; never alter their targets."""
    drive = Path("/content/drive")
    if ROOT == drive or drive in ROOT.parents:
        raise RuntimeError("COMFY_ROOT must be on local runtime disk, outside /content/drive.")
    paths = [ROOT / name for name in ("models", "input", "output", "user", "temp")]
    paths += [ROOT / "models" / name for name in (
        "diffusion_models", "text_encoders", "vae", "loras", "checkpoints",
        "latent_upscale_models", "model_patches",
    )]
    links = []
    for path in paths:
        # Never walk a linked parent into external storage.
        if not any(parent in path.parents for parent in links) and path.is_symlink():
            links.append(path)
    if links:
        existing = processes("comfyui")
        if existing:
            try:
                with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
                    ORIGIN + "/queue", timeout=5
                ) as response:
                    queue = json.load(response)
                    if response.status != 200 or not all(
                        isinstance(queue.get(key), list) for key in ("queue_running", "queue_pending")
                    ):
                        raise ValueError("Invalid queue response")
            except (OSError, ValueError, AttributeError):
                raise RuntimeError("Cannot verify an idle ComfyUI queue; storage links were left unchanged.") from None
            if queue["queue_running"] or queue["queue_pending"]:
                raise RuntimeError("Finish queued generation before changing storage. Nothing was changed.")
            stop_processes(existing)
            print("Stopped only idle ComfyUI before detaching storage links; cloudflared is unchanged.")
        for path in links:
            path.unlink()  # Remove the link itself, never the directory it points to.
            print(f"Detached legacy storage link: {path}. Its target was left untouched.")
    for path in paths:
        path.mkdir(parents=True, exist_ok=True)
    (ROOT / "user/default/workflows").mkdir(parents=True, exist_ok=True)
    print("ComfyUI storage is local to the Colab runtime. Download results from the workflow before ending the session.")
    if links:
        print("Previous linked files were not copied. Start preflight again to open ComfyUI with local storage.")


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
    if access_method() == 'tailscale':
        if (len(comfy) != 1 or option(comfy[0]['args'], '--listen') != '127.0.0.1'
                or not healthy()):
            raise RuntimeError('ComfyUI preflight is no longer healthy. Rerun Section 5.')
        check_tailscale()
        return
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
    print("Starting one Cloudflare connector; waiting for tunnel registration.", flush=True)
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
        log_path = LOG / "cloudflared.log"
        log_text = log_path.read_text(errors="replace") if log_path.exists() else ""
        if "unauthorized: invalid tunnel secret" in log_text.lower():
            # A rejected secret cannot succeed through retries. Stop only the
            # connector just launched, retaining the healthy ComfyUI process.
            info = process_info(child.pid)
            if info and matches(info, "cloudflared"):
                stop_processes([info])
            raise RuntimeError(
                "Cloudflare rejected CF_TUNNEL_TOKEN: Unauthorized: Invalid tunnel secret. "
                "Copy the current connector token for the existing tunnel into Colab Secrets, "
                "then rerun Section 4 (read secret) and Section 5 (preflight). "
                "ComfyUI remains running; do not reinstall or download models."
            )
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
    print('managed tailscaled PIDs:', [p['pid'] for p in processes('tailscaled')])
    if access_method() == 'tailscale':
        try:
            state = tailscale_status()
            print('Tailscale:', state['BackendState'], state.get('TailscaleIPs'))
        except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
            print(redact(str(error)))
    for name in ("setup.log", "launcher.log", "cli-check.log", "cloudflared.log", "tailscaled.log", "comfyui.log"):
        print(f"\n=== {name}: last 50 lines ===")
        tail_log(name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("preflight", "restart", "check", "diagnostics", "local-storage", "tailscale-login"))
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
        if action == 'tailscale-login':
            prepare_tailscale_login()
        elif action == "local-storage":
            prepare_local_storage()
        elif action == "check":
            check_preflight()
        elif action == "restart":
            check_preflight()
            start_comfy(restart=True)
            check_preflight()
            print("FINAL READY\n" + access_url())
            print("Refresh the browser once so the model dropdowns reload.")
        else:
            if access_method() == 'tailscale':
                tailscale_url()  # Sign-in must finish before starting ComfyUI.
            prepare_local_storage()
            start_comfy()
            if not healthy():
                raise RuntimeError("Local /system_stats must return HTTP 200 before exposing ComfyUI.")
            if access_method() == 'tailscale':
                start_tailscale_serve()
            else:
                start_tunnel()
            check_preflight()
            print("OPEN COMFYUI:\n" + access_url())
            print("Verify the full UI, workflow canvas and connection in your browser before approving downloads.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("ERROR: " + redact(str(error)), file=sys.stderr)
        sys.exit(1)
