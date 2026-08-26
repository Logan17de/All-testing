#!/usr/bin/env python3
"""Shared outbound-only Supabase relay primitives for Colab and Harness.

Security model:
- Uses Growing-Trader's public Supabase URL + publishable key.
- All relay tables remain protected by RLS with no direct anon policies.
- Every operation goes through SECURITY DEFINER RPCs gated by QWEN_RELAY_SECRET.
- No service-role key is stored on Colab or Windows.
- No Supabase Storage is required; large Harness requests are gzip+base64 encoded
  into the isolated qwen_relay_jobs table and removed after completion.
"""

from __future__ import annotations

import base64
import gzip
import json
import os
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any

DEFAULT_SUPABASE_URL = "https://imirspxhbnerxknyynqx.supabase.co"
DEFAULT_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_dBUDUTTSQvFMhqgP7FQBOQ_5ZMjLhxN"
DEFAULT_RELAY_ID = "qwen3-8-27b"
MODEL_ID = "qwen3.8-27b"
CONTEXT_WINDOW = 262_144

DEFAULT_ORACLE_GATEWAY_HEALTH_URL = "https://api.zetbros.com/health"
DEFAULT_ORACLE_WAKE_REPO = "Logan17de/Growing-Trader"
DEFAULT_ORACLE_WAKE_WORKFLOW = "oracle-wake.yml"
DEFAULT_ORACLE_WAKE_REF = "main"


class RelayError(RuntimeError):
    pass


def _result_data(result: Any) -> Any:
    return getattr(result, "data", None)


def _encode_payload(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    compressed = gzip.compress(raw, compresslevel=6)
    return base64.b64encode(compressed).decode("ascii")


def _decode_payload(encoded: str) -> dict[str, Any]:
    try:
        compressed = base64.b64decode(encoded.encode("ascii"), validate=True)
        raw = gzip.decompress(compressed)
        value = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise RelayError(f"Could not decode relay request payload: {exc}") from exc
    if not isinstance(value, dict):
        raise RelayError("Decoded relay request payload is not a JSON object")
    return value


def oracle_gateway_online(timeout_seconds: float = 4.0) -> bool:
    """Return True when the public Oracle gateway is reachable.

    /health intentionally does not require the public model API key. A 200 here
    proves that the VM, Nginx/TLS, and gateway service are up; the Colab worker
    may still be loading and can report worker_online=false.
    """
    health_url = (
        os.environ.get("ORACLE_GATEWAY_HEALTH_URL")
        or DEFAULT_ORACLE_GATEWAY_HEALTH_URL
    ).strip()
    if not health_url:
        return False
    request = urllib.request.Request(
        health_url,
        headers={"User-Agent": "zetbros-colab-qwen/1.0"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            return 200 <= int(response.status) < 300
    except Exception:
        return False


def request_oracle_wake_if_needed(*, wait_seconds: int = 0) -> bool:
    """Wake the shared Oracle VM through a narrowly-scoped GitHub workflow.

    Colab cannot contact a powered-off VM, so wake-up is dispatched through the
    Growing-Trader GitHub Actions workflow that already owns the OCI credentials.
    Colab only needs ORACLE_WAKE_GITHUB_TOKEN, ideally a fine-grained token with
    Actions read/write access to Logan17de/Growing-Trader and nothing else.

    Returns True when the gateway was already online or becomes reachable within
    wait_seconds. A successful dispatch with wait_seconds=0 also returns True.
    Missing wake credentials are non-fatal so model startup can still proceed.
    """
    if oracle_gateway_online():
        print("      Oracle gateway: already online ✅", flush=True)
        return True

    token = (os.environ.get("ORACLE_WAKE_GITHUB_TOKEN") or "").strip()
    if not token:
        print(
            "      Oracle gateway is offline and ORACLE_WAKE_GITHUB_TOKEN is not configured; "
            "automatic VM wake skipped.",
            flush=True,
        )
        return False

    repo = (os.environ.get("ORACLE_WAKE_REPO") or DEFAULT_ORACLE_WAKE_REPO).strip()
    workflow = (
        os.environ.get("ORACLE_WAKE_WORKFLOW") or DEFAULT_ORACLE_WAKE_WORKFLOW
    ).strip()
    ref = (os.environ.get("ORACLE_WAKE_REF") or DEFAULT_ORACLE_WAKE_REF).strip()
    url = f"https://api.github.com/repos/{repo}/actions/workflows/{workflow}/dispatches"
    body = json.dumps({"ref": ref}).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "zetbros-colab-qwen/1.0",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            status = int(response.status)
        if status != 204:
            print(f"      Oracle wake dispatch returned HTTP {status}; continuing Colab startup.", flush=True)
            return False
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")[:500]
        print(
            f"      Oracle wake dispatch failed: GitHub HTTP {exc.code} {detail}; "
            "continuing Colab startup.",
            flush=True,
        )
        return False
    except Exception as exc:
        print(f"      Oracle wake dispatch failed: {exc}; continuing Colab startup.", flush=True)
        return False

    print("      Oracle VM wake requested through GitHub Actions ✅", flush=True)
    if wait_seconds <= 0:
        return True

    deadline = time.time() + wait_seconds
    while time.time() < deadline:
        if oracle_gateway_online(timeout_seconds=5.0):
            print("      Oracle gateway: online ✅", flush=True)
            return True
        remaining = max(0, int(deadline - time.time()))
        print(f"\r      Waiting for Oracle gateway... {remaining:3d}s remaining", end="", flush=True)
        time.sleep(10)
    print("\n      Oracle wake was dispatched, but the gateway is not reachable yet.", flush=True)
    return False


@dataclass
class RelayConfig:
    url: str
    publishable_key: str
    relay_secret: str
    relay_id: str = DEFAULT_RELAY_ID

    @classmethod
    def from_env(cls) -> "RelayConfig":
        url = (os.environ.get("SUPABASE_URL") or DEFAULT_SUPABASE_URL).strip().rstrip("/")
        publishable_key = (
            os.environ.get("SUPABASE_PUBLISHABLE_KEY")
            or os.environ.get("SUPABASE_ANON_KEY")
            or DEFAULT_SUPABASE_PUBLISHABLE_KEY
        ).strip()
        relay_secret = (os.environ.get("QWEN_RELAY_SECRET") or "").strip()
        relay_id = (os.environ.get("QWEN_RELAY_ID") or DEFAULT_RELAY_ID).strip()
        if not relay_secret:
            raise RelayError("QWEN_RELAY_SECRET is missing")
        if not relay_id:
            raise RelayError("QWEN_RELAY_ID cannot be empty")
        return cls(
            url=url,
            publishable_key=publishable_key,
            relay_secret=relay_secret,
            relay_id=relay_id,
        )


class RelayStore:
    """RPC-only wrapper around the isolated Qwen relay schema."""

    def __init__(self, config: RelayConfig):
        from supabase import create_client

        self.config = config
        self.sb = create_client(config.url, config.publishable_key)

    @classmethod
    def from_env(cls) -> "RelayStore":
        return cls(RelayConfig.from_env())

    def _auth(self) -> dict[str, str]:
        return {
            "p_relay_id": self.config.relay_id,
            "p_secret": self.config.relay_secret,
        }

    def preflight(self) -> None:
        try:
            result = self.sb.rpc("qwen_relay_preflight", self._auth()).execute()
            if _result_data(result) is not True:
                raise RelayError(f"Unexpected relay preflight response: {_result_data(result)!r}")
        except Exception as exc:
            raise RelayError(
                "Growing-Trader Qwen relay preflight failed. Check QWEN_RELAY_SECRET. "
                f"Original error: {exc}"
            ) from exc

    def create_job(self, payload: dict[str, Any]) -> dict[str, Any]:
        job_id = str(uuid.uuid4())
        params: dict[str, Any] = {
            **self._auth(),
            "p_job_id": job_id,
            "p_request_payload": _encode_payload(payload),
        }
        try:
            result = self.sb.rpc("qwen_relay_create_job", params).execute()
            rows = _result_data(result) or []
            if not rows:
                raise RelayError("qwen_relay_create_job returned no row")
            return rows[0]
        except Exception as exc:
            raise RelayError(f"Failed to enqueue Qwen job: {exc}") from exc

    def claim_job(self, worker_id: str) -> dict[str, Any] | None:
        try:
            result = self.sb.rpc(
                "qwen_relay_claim_job",
                {**self._auth(), "p_worker_id": worker_id},
            ).execute()
            rows = _result_data(result) or []
            return rows[0] if rows else None
        except Exception as exc:
            raise RelayError(f"Failed to claim Qwen relay job: {exc}") from exc

    def decode_job_payload(self, job: dict[str, Any]) -> dict[str, Any]:
        encoded = job.get("request_payload")
        if not isinstance(encoded, str) or not encoded:
            raise RelayError(f"Relay job {job.get('id')} has no request_payload")
        return _decode_payload(encoded)

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        result = self.sb.rpc(
            "qwen_relay_get_job",
            {**self._auth(), "p_job_id": job_id},
        ).execute()
        rows = _result_data(result) or []
        return rows[0] if rows else None

    def set_job_status(self, job_id: str, status: str, error: str | None = None) -> None:
        self.sb.rpc(
            "qwen_relay_set_job_status",
            {
                **self._auth(),
                "p_job_id": job_id,
                "p_status": status,
                "p_error": error[:8000] if error else None,
            },
        ).execute()

    def cancel_job(self, job_id: str) -> None:
        try:
            self.sb.rpc(
                "qwen_relay_cancel_job",
                {**self._auth(), "p_job_id": job_id},
            ).execute()
        except Exception:
            pass

    def job_cancelled(self, job_id: str) -> bool:
        job = self.get_job(job_id)
        return bool(job and job.get("status") == "cancelled")

    def append_chunk(self, job_id: str, seq: int, payload: dict[str, Any]) -> None:
        self.sb.rpc(
            "qwen_relay_append_chunk",
            {
                **self._auth(),
                "p_job_id": job_id,
                "p_seq": seq,
                "p_payload": payload,
            },
        ).execute()

    def fetch_chunks(self, job_id: str, after_seq: int, limit: int = 100) -> list[dict[str, Any]]:
        result = self.sb.rpc(
            "qwen_relay_fetch_chunks",
            {
                **self._auth(),
                "p_job_id": job_id,
                "p_after_seq": after_seq,
                "p_limit": limit,
            },
        ).execute()
        return list(_result_data(result) or [])

    def upsert_worker(
        self,
        worker_id: str,
        status: str,
        *,
        model: str = MODEL_ID,
        context_window: int = CONTEXT_WINDOW,
        detail: str | None = None,
    ) -> None:
        self.sb.rpc(
            "qwen_relay_upsert_worker",
            {
                **self._auth(),
                "p_worker_id": worker_id,
                "p_status": status,
                "p_model": model,
                "p_context_window": context_window,
                "p_detail": detail,
            },
        ).execute()

    def get_live_worker(self, max_age_seconds: int = 30) -> dict[str, Any] | None:
        result = self.sb.rpc(
            "qwen_relay_get_live_worker",
            {
                **self._auth(),
                "p_max_age_seconds": max_age_seconds,
            },
        ).execute()
        rows = _result_data(result) or []
        return rows[0] if rows else None

    def cleanup_job(self, job_id: str, request_path: str | None = None) -> None:
        del request_path  # Backward-compatible argument; Storage is no longer used.
        try:
            self.sb.rpc(
                "qwen_relay_cleanup_job",
                {**self._auth(), "p_job_id": job_id},
            ).execute()
        except Exception:
            pass


def sleep_with_jitter(seconds: float) -> None:
    time.sleep(seconds)
