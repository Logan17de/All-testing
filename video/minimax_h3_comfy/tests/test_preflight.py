"""Offline regression checks: no servers, model weights, credentials or GPU required."""
import importlib.util
import json
from pathlib import Path
import sys
import types
from unittest.mock import Mock

import pytest

DIRECTORY = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("preflight", DIRECTORY / "comfy_preflight.py")
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)
NOTEBOOK = json.loads((DIRECTORY.parent / "MiniMax_H3_ComfyUI_Colab.ipynb").read_text(encoding="utf-8"))


def cell(section):
    for index, item in enumerate(NOTEBOOK["cells"]):
        if item["cell_type"] == "markdown" and item["source"].startswith(section):
            return NOTEBOOK["cells"][index + 1]["source"]
    raise AssertionError(section)


@pytest.fixture
def runtime(monkeypatch, tmp_path):
    monkeypatch.setattr(preflight, "LOG", tmp_path)
    monkeypatch.setattr(preflight.time, "sleep", lambda _: None)
    return tmp_path


@pytest.mark.parametrize("approval", [None, False, 1, "True"])
def test_direct_download_cannot_bypass_gate(approval):
    namespace = {"PROCEED_WITH_H3_MODEL_DOWNLOADS": approval, "H3_PREFLIGHT_COMPLETE": True}
    with pytest.raises(SystemExit, match="Verify"):
        exec(cell("## 7."), namespace)
    assert "hf_hub_download" not in namespace


def test_approval_requires_successful_preflight():
    with pytest.raises(SystemExit):
        exec(cell("## 7."), {"PROCEED_WITH_H3_MODEL_DOWNLOADS": True})


def test_run_all_defaults_pause(capsys):
    namespace = {"H3_PREFLIGHT_COMPLETE": True, "PROCEED_WITH_H3_MODEL_DOWNLOADS": True}
    with pytest.raises(SystemExit, match="remain running"):
        exec(cell("## 6."), namespace)
    assert namespace["PROCEED_WITH_H3_MODEL_DOWNLOADS"] is False
    assert "Verify https://comfy.zetbros.com first." in capsys.readouterr().out


@pytest.mark.parametrize("failure", [False, True])
def test_download_completion_controls_restart(monkeypatch, tmp_path, failure):
    events = []
    def download(**kwargs):
        events.append("download")
        if failure:
            raise OSError("interrupted")
        target = Path(kwargs["local_dir"]) / kwargs["filename"]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("offline test fixture, not a model")
    monkeypatch.setitem(sys.modules, "huggingface_hub", types.SimpleNamespace(hf_hub_download=download))
    monkeypatch.setattr(preflight.subprocess, "run", lambda args, **kwargs: events.append(args[-1]))
    namespace = {"PROCEED_WITH_H3_MODEL_DOWNLOADS": True, "H3_PREFLIGHT_COMPLETE": True,
                 "H3_MODELS_DOWNLOADED": True,
                 "comfy_preflight": types.SimpleNamespace(run_launcher=lambda action: events.append(action))}
    source = cell("## 7.").replace("/content/ComfyUI/models", tmp_path.as_posix())
    if failure:
        with pytest.raises(OSError, match="interrupted"):
            exec(source, namespace)
        assert namespace["H3_MODELS_DOWNLOADED"] is False
        with pytest.raises(SystemExit):
            exec(cell("## 8."), namespace)
        assert "restart" not in events
    else:
        exec(source, namespace)
        assert namespace["H3_MODELS_DOWNLOADED"] is True
        assert events == ["check"] + ["download"] * 8
        exec(cell("## 8."), namespace)
        assert events[-1] == "restart"


@pytest.mark.parametrize("raw", ["eyJtest-token==", "sudo cloudflared service install 'eyJtest-token=='"])
def test_extract_token_without_executing_command(raw):
    assert preflight.extract_token(raw) == "eyJtest-token=="


@pytest.mark.parametrize("raw", ["", "sudo echo bad", "eyJone eyJtwo"])
def test_reject_missing_or_ambiguous_token(raw):
    with pytest.raises(RuntimeError):
        preflight.extract_token(raw)


def test_redact_logs_and_legacy_process_arguments(runtime, capsys):
    secret_log = ('Settings: map[token:eyJtest-token==]\n'
                  'cloudflared --token=secret-without-prefix\n'
                  'CF_ACCESS_CLIENT_SECRET: access-secret\n'
                  '\"CF-Access-Client-Secret\": \"header-secret\"\n'
                  'Authorization: Bearer auth-secret\n')
    (runtime / "cloudflared.log").write_text(secret_log)
    preflight.tail_log("cloudflared.log")
    output = capsys.readouterr().out
    for secret in ("eyJtest-token==", "secret-without-prefix", "access-secret", "auth-secret", "header-secret"):
        assert secret not in output
    assert "[REDACTED]" in output


def comfy_info(listen="127.0.0.1"):
    return {"pid": 100, "start": "50", "cwd": preflight.ROOT,
            "args": ["python3", "main.py", "--port", "8188", "--listen", listen]}


def test_process_scope_excludes_unrelated_commands():
    assert preflight.matches(comfy_info(), "comfyui")
    assert not preflight.matches({**comfy_info(), "cwd": Path("/other")}, "comfyui")
    assert not preflight.matches({**comfy_info(), "args": ["python3", "other.py"]}, "comfyui")
    assert not preflight.matches({**comfy_info(), "args": ["bash", "-c", "cloudflared tunnel run"]}, "cloudflared")
    assert not preflight.matches({**comfy_info(), "args": ["cloudflared", "access", "tcp"]}, "cloudflared")


def test_pid_reuse_is_not_signalled(monkeypatch):
    monkeypatch.setattr(preflight, "process_info", lambda pid: {"start": "different"})
    assert not preflight.same_process(comfy_info())


def test_process_lookup_rejects_other_runtime(monkeypatch):
    monkeypatch.setattr(preflight.os, "getuid", lambda: 1000, raising=False)
    monkeypatch.setattr(preflight.Path, "stat", lambda _: types.SimpleNamespace(st_uid=1000))
    monkeypatch.setattr(preflight.os, "readlink", lambda path: "ours" if "/self/" in str(path) else "other")
    assert preflight.process_info(100) is None


def test_healthy_comfy_is_reused(runtime, monkeypatch):
    monkeypatch.setattr(preflight, "processes", lambda kind: [comfy_info()])
    monkeypatch.setattr(preflight, "healthy", lambda: True)
    start, stop = Mock(), Mock()
    monkeypatch.setattr(preflight, "start_process", start)
    monkeypatch.setattr(preflight, "stop_processes", stop)
    preflight.start_comfy()
    start.assert_not_called()
    stop.assert_not_called()


def test_unrecognized_healthy_origin_is_untouched(runtime, monkeypatch):
    monkeypatch.setattr(preflight, "processes", lambda kind: [])
    monkeypatch.setattr(preflight, "healthy", lambda: True)
    stop = Mock()
    monkeypatch.setattr(preflight, "stop_processes", stop)
    with pytest.raises(RuntimeError, match="unrecognized"):
        preflight.start_comfy()
    stop.assert_not_called()


@pytest.mark.parametrize("restart,listen", [(True, "127.0.0.1"), (False, "0.0.0.0")])
def test_restart_or_wrong_binding_stops_only_comfy(runtime, monkeypatch, restart, listen):
    kinds = []
    info = comfy_info(listen)
    monkeypatch.setattr(preflight, "processes", lambda kind: kinds.append(kind) or [info])
    monkeypatch.setattr(preflight, "healthy", lambda: True)
    monkeypatch.setattr(preflight.subprocess, "run", lambda *a, **k: types.SimpleNamespace(returncode=0))
    stop = Mock()
    start = Mock(return_value=Mock(poll=lambda: None))
    monkeypatch.setattr(preflight, "stop_processes", stop)
    monkeypatch.setattr(preflight, "start_process", start)
    preflight.start_comfy(restart=restart)
    assert kinds == ["comfyui"]
    stop.assert_called_once_with([info])
    assert start.call_args.args[1] == "comfyui"
    assert preflight.option(start.call_args.args[0], "--listen") == "127.0.0.1"


def test_tunnel_uses_private_environment_and_one_connector(runtime, monkeypatch):
    monkeypatch.setattr(preflight, "read_token", lambda: "eyJtest-token==")
    monkeypatch.setattr(preflight.shutil, "which", lambda _: "/usr/local/bin/cloudflared")
    stale = [{"pid": 1}, {"pid": 2}]
    monkeypatch.setattr(preflight, "processes", lambda kind: stale if kind == "cloudflared" else [])
    monkeypatch.setattr(preflight, "registered", lambda: True)
    events = []
    monkeypatch.setattr(preflight, "stop_processes", lambda items: events.append(("stop", items)))
    def launch(args, name, **kwargs):
        events.append(("start", name))
        assert "eyJtest-token==" not in " ".join(args)
        assert kwargs["env"]["TUNNEL_TOKEN"] == "eyJtest-token=="
        return Mock(poll=lambda: None)
    monkeypatch.setattr(preflight, "start_process", launch)
    preflight.start_tunnel()
    assert events == [("stop", stale), ("start", "cloudflared")]


def test_failed_connector_never_reports_ready(runtime, monkeypatch):
    monkeypatch.setattr(preflight, "read_token", lambda: "eyJtest-token==")
    monkeypatch.setattr(preflight.shutil, "which", lambda _: "cloudflared")
    monkeypatch.setattr(preflight, "processes", lambda kind: [])
    monkeypatch.setattr(preflight, "stop_processes", lambda _: None)
    monkeypatch.setattr(preflight, "start_process", lambda *a, **k: Mock(poll=lambda: 1))
    with pytest.raises(RuntimeError, match="exited before registering"):
        preflight.start_tunnel()


def test_local_probe_rejects_non_200_and_non_comfy_json(monkeypatch):
    for status, data, expected in [(200, b'{"system": {}}', True),
                                    (201, b'{"system": {}}', False), (200, b'{}', False)]:
        response = Mock(status=status, read=lambda: data)
        context = Mock(__enter__=lambda _: response, __exit__=lambda *a: None)
        monkeypatch.setattr(preflight.urllib.request, "build_opener", lambda *a: Mock(open=lambda *a, **k: context))
        assert preflight.healthy() is expected


def test_setup_streams_stdout_stderr_and_preserves_previous_log(runtime, capsys):
    path = runtime / "setup.log"
    path.write_text("previous setup attempt\n", encoding="utf-8")
    preflight.run_setup_command(
        [sys.executable, "-u", "-c", "import sys; print('visible stdout'); print('visible stderr', file=sys.stderr)"],
        label="offline output check",
    )
    output = capsys.readouterr().out
    saved = path.read_text(encoding="utf-8")
    assert saved.startswith("previous setup attempt\n")
    for line in ("visible stdout", "visible stderr"):
        assert line in output and line in saved


def test_setup_failure_reports_cause_redacts_token_and_stops(runtime, capsys):
    with pytest.raises(SystemExit, match="Setup stopped"):
        preflight.run_setup_command(
            [sys.executable, "-u", "-c",
             "import sys; print('dependency failure eyJtest-secret==', file=sys.stderr); sys.exit(7)"],
            label="offline failure check",
        )
    output = capsys.readouterr().out
    saved = (runtime / "setup.log").read_text(encoding="utf-8")
    for text in (output, saved):
        assert "dependency failure" in text
        assert "exit 7" in text
        assert "eyJtest-secret==" not in text


@pytest.mark.parametrize("render_body", [
    "    cards.replaceChildren();\n",
    "    // Preserve prompt position before rebuilding cards.\n    capturePromptUiState(runtime);\n    cards.replaceChildren();\n",
])
def test_width_patch_preserves_upstream_render_body(tmp_path, render_body):
    source = "function render(node, runtime) {\n    const { state, cards, counter, status } = runtime;\n" + render_body + "}\n"
    target = tmp_path / "extender.js"
    target.write_text(source, encoding="utf-8")
    command = [sys.executable, str(DIRECTORY / "patch_extender_ui.py"), str(target)]
    preflight.subprocess.run(command, check=True, capture_output=True)
    patched = target.read_text(encoding="utf-8")
    assert render_body + "}\n" in patched
    assert patched.count("cards.replaceChildren();") == 1
    assert "H3_COLAB_FULL_WIDTH_PATCH_V1" in patched
    assert target.with_suffix(".js.pre-colab-width-patch").read_text(encoding="utf-8") == source
    preflight.subprocess.run(command, check=True, capture_output=True)
    assert target.read_text(encoding="utf-8") == patched


@pytest.mark.parametrize("source", ["function unrelated() {}\n", (
    "function render(node, runtime) {\n    const { state, cards, counter, status } = runtime;\n}\n"
) * 2])
def test_width_patch_refuses_unknown_or_ambiguous_source(tmp_path, source):
    target = tmp_path / "extender.js"
    target.write_text(source, encoding="utf-8")
    result = preflight.subprocess.run(
        [sys.executable, str(DIRECTORY / "patch_extender_ui.py"), str(target)], capture_output=True,
    )
    assert result.returncode == 1
    assert target.read_text(encoding="utf-8") == source


def test_invalid_tunnel_secret_fails_fast_and_stops_only_rejected_connector(runtime, monkeypatch):
    monkeypatch.setattr(preflight, "read_token", lambda: "eyJtest-token==")
    monkeypatch.setattr(preflight.shutil, "which", lambda _: "cloudflared")
    monkeypatch.setattr(preflight, "processes", lambda kind: [])
    info = {"pid": 2560, "start": "50", "args": ["cloudflared", "tunnel", "run"]}
    monkeypatch.setattr(preflight, "process_info", lambda pid: info if pid == 2560 else None)
    stop = Mock()
    monkeypatch.setattr(preflight, "stop_processes", stop)
    monkeypatch.setattr(preflight, "start_process", lambda *a, **k: Mock(pid=2560, poll=lambda: None))
    (runtime / "cloudflared.log").write_text('ERR Unauthorized: Invalid tunnel secret\n')
    sleep = Mock()
    monkeypatch.setattr(preflight.time, "sleep", sleep)
    with pytest.raises(RuntimeError, match="Section 4.*Section 5"):
        preflight.start_tunnel()
    assert stop.call_args_list[-1].args == ([info],)
    sleep.assert_not_called()


@pytest.mark.parametrize("action", ["preflight", "check", "restart", "local-storage"])
def test_notebook_launcher_streams_with_private_environment(runtime, monkeypatch, action):
    calls = []
    def logged(args, **kwargs):
        calls.append(args[-1])
        assert kwargs["env"]["PYTHONUNBUFFERED"] == "1"
        assert kwargs["log_name"] == "launcher.log"
        assert "eyJtest-token==" not in str(args)
        if action == "preflight":
            assert kwargs["env"]["CF_TUNNEL_TOKEN"] == "eyJtest-token=="
        else:
            assert "CF_TUNNEL_TOKEN" not in kwargs["env"]
    monkeypatch.setattr(preflight, "run_logged_command", logged)
    preflight.run_launcher(action, token="eyJtest-token==" if action == "preflight" else None)
    assert calls == [action]


def test_launcher_failure_shows_existing_diagnostics_without_retry(runtime, monkeypatch):
    run = Mock(side_effect=SystemExit("Launcher stopped"))
    diagnostics = Mock()
    monkeypatch.setattr(preflight, "run_logged_command", run)
    monkeypatch.setattr(preflight, "diagnostics", diagnostics)
    with pytest.raises(SystemExit, match="Launcher stopped"):
        preflight.run_launcher("preflight", token="eyJtest-token==")
    run.assert_called_once()
    diagnostics.assert_called_once()


def test_notebook_secret_reload_ignores_stale_environment(monkeypatch):
    monkeypatch.setenv("CF_TUNNEL_TOKEN", "eyJstale==")
    monkeypatch.setitem(sys.modules, "google.colab", types.SimpleNamespace(
        userdata=types.SimpleNamespace(get=lambda name: "eyJcurrent==")))
    assert preflight.read_token(use_environment=False) == "eyJcurrent=="


def test_local_storage_keeps_existing_local_files(runtime, monkeypatch):
    root = runtime / "ComfyUI"
    monkeypatch.setattr(preflight, "ROOT", root)
    output = root / "output"
    output.mkdir(parents=True)
    saved = output / "existing.mp4"
    saved.write_bytes(b"existing output fixture")
    stop = Mock()
    monkeypatch.setattr(preflight, "stop_processes", stop)
    preflight.prepare_local_storage()
    assert saved.read_bytes() == b"existing output fixture"
    assert (root / "user/default/workflows").is_dir()
    assert (root / "models/text_encoders").is_dir()
    stop.assert_not_called()


def legacy_storage(runtime, monkeypatch, simulate):
    root = runtime / "ComfyUI"
    target = runtime / "previous-storage"
    root.mkdir()
    target.mkdir()
    (target / "keep.txt").write_text("preserve old storage")
    link = root / "output"
    if simulate:
        # Exercise queue/stop/unlink ordering on hosts without symlink privileges.
        links = {link}
        original_is_symlink = Path.is_symlink
        original_unlink = Path.unlink
        monkeypatch.setattr(Path, "is_symlink", lambda path: path in links or original_is_symlink(path))
        def unlink(path, *args, **kwargs):
            if path in links:
                links.remove(path)
            else:
                original_unlink(path, *args, **kwargs)
        monkeypatch.setattr(Path, "unlink", unlink)
    else:
        try:
            link.symlink_to(target, target_is_directory=True)
        except OSError:
            pytest.skip("This host does not permit directory symlinks.")
    monkeypatch.setattr(preflight, "ROOT", root)
    return root, target, link


@pytest.mark.parametrize("simulate", [False, True])
def test_local_storage_detaches_only_link_and_preserves_target(runtime, monkeypatch, simulate):
    root, target, link = legacy_storage(runtime, monkeypatch, simulate)
    monkeypatch.setattr(preflight, "processes", lambda kind: [])
    preflight.prepare_local_storage()
    assert link.is_dir() and not link.is_symlink()
    assert (target / "keep.txt").read_text() == "preserve old storage"
    assert not (link / "keep.txt").exists()


@pytest.mark.parametrize("queue", [
    {"queue_running": [[1]], "queue_pending": []},
    {"queue_running": [], "queue_pending": [[1]]},
    {"unexpected": "response"},
])
@pytest.mark.parametrize("simulate", [False, True])
def test_local_storage_does_not_interrupt_generation_or_unverified_queue(runtime, monkeypatch, queue, simulate):
    root, target, link = legacy_storage(runtime, monkeypatch, simulate)
    monkeypatch.setattr(preflight, "processes", lambda kind: [comfy_info()])
    response = Mock(status=200, read=lambda: json.dumps(queue).encode())
    context = Mock(__enter__=lambda _: response, __exit__=lambda *a: None)
    monkeypatch.setattr(preflight.urllib.request, "build_opener", lambda *a: Mock(open=lambda *a, **k: context))
    stop = Mock()
    monkeypatch.setattr(preflight, "stop_processes", stop)
    with pytest.raises(RuntimeError):
        preflight.prepare_local_storage()
    assert link.is_symlink()
    assert (target / "keep.txt").read_text() == "preserve old storage"
    stop.assert_not_called()


@pytest.mark.parametrize("simulate", [False, True])
def test_local_storage_stops_only_idle_comfy_before_detaching(runtime, monkeypatch, simulate):
    root, target, link = legacy_storage(runtime, monkeypatch, simulate)
    info = comfy_info()
    kinds = []
    monkeypatch.setattr(preflight, "processes", lambda kind: kinds.append(kind) or [info])
    response = Mock(status=200, read=lambda: b'{"queue_running": [], "queue_pending": []}')
    context = Mock(__enter__=lambda _: response, __exit__=lambda *a: None)
    monkeypatch.setattr(preflight.urllib.request, "build_opener", lambda *a: Mock(open=lambda *a, **k: context))
    stopped = []
    def stop(items):
        assert link.is_symlink()
        stopped.extend(items)
    monkeypatch.setattr(preflight, "stop_processes", stop)
    preflight.prepare_local_storage()
    assert stopped == [info] and kinds == ["comfyui"]
    assert not link.is_symlink()
    assert (target / "keep.txt").exists()
