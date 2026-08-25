#!/usr/bin/env python3
"""Shared Supabase relay primitives for the Colab Qwen worker and Windows bridge.

This module deliberately uses Supabase's normal HTTPS client APIs only.  Colab
never opens an inbound port to the Internet; the only local network hop is from
its worker to vLLM on 127.0.0.1.
"""

from __future__ import annotations

import gzip
import json
import os
import time
import uuid
from dataclasses import dataclass
from typing import Any

BUCKET = "qwen-relay"
DEFAULT_RELAY_ID = "qwen3-8-27b"
MODEL_ID = "qwen3.8-27b"
CONTEXT_WINDOW = 262_144


class RelayError(RuntimeError):
    pass


def _result_data(result: Any) -> Any:
    return getattr(result, "data", None)


@dataclass
class RelayConfig:
    url: str
    key: str
    relay_id: str = DEFAULT_RELAY_ID

    @classmethod
    def from_env(cls) -> "RelayConfig":
        url = (os.environ.get("SUPABASE_URL") or "").strip().rstrip("/")
        key = (
            os.environ.get("SUPABASE_SECRET_KEY")
            or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
            or ""
        ).strip()
        relay_id = (os.environ.get("QWEN_RELAY_ID") or DEFAULT_RELAY_ID).strip()
        if not url:
            raise RelayError("SUPABASE_URL is missing")
        if not key:
            raise RelayError(
                "SUPABASE_SECRET_KEY is missing (legacy SUPABASE_SERVICE_ROLE_KEY also works)"
            )
        if not relay_id:
            raise RelayError("QWEN_RELAY_ID cannot be empty")
        return cls(url=url, key=key, relay_id=relay_id)


class RelayStore:
    """Small synchronous wrapper around Supabase Database + Storage APIs."""

    def __init__(self, config: RelayConfig):
        from supabase import create_client

        self.config = config
        self.sb = create_client(config.url, config.key)

    @classmethod
    def from_env(cls) -> "RelayStore":
        return cls(RelayConfig.from_env())

    def preflight(self) -> None:
        """Fail before GPU work if the relay migration/bucket is missing."""
        try:
            self.sb.table("qwen_relay_jobs").select("id").limit(1).execute()
            # Listing with a service/secret key proves that the private bucket exists.
            self.sb.storage.from_(BUCKET).list(path="requests", options={"limit": 1})
        except Exception as exc:
            raise RelayError(
                "Supabase relay is not initialized. Apply llm/supabase_qwen_relay.sql "
                "to the chosen project first. Original error: " + str(exc)
            ) from exc

    def upload_request(self, job_id: str, payload: dict[str, Any]) -> str:
        path = f"requests/{self.config.relay_id}/{job_id}.json.gz"
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        compressed = gzip.compress(raw, compresslevel=6)
        try:
            self.sb.storage.from_(BUCKET).upload(
                path=path,
                file=compressed,
                file_options={"content-type": "application/gzip", "upsert": "false"},
            )
        except Exception as exc:
            raise RelayError(f"Failed to upload request payload {path}: {exc}") from exc
        return path

    def download_request(self, path: str) -> dict[str, Any]:
        try:
            blob = self.sb.storage.from_(BUCKET).download(path)
            return json.loads(gzip.decompress(blob).decode("utf-8"))
        except Exception as exc:
            raise RelayError(f"Failed to download/decode request {path}: {exc}") from exc

    def remove_request(self, path: str) -> None:
        try:
            self.sb.storage.from_(BUCKET).remove([path])
        except Exception:
            # Cleanup is best effort; never turn a completed model request into a failure.
            pass

    def create_job(self, payload: dict[str, Any]) -> dict[str, Any]:
        job_id = str(uuid.uuid4())
        request_path = self.upload_request(job_id, payload)
        row = {
            "id": job_id,
            "relay_id": self.config.relay_id,
            "request_path": request_path,
            "status": "queued",
        }
        try:
            result = self.sb.table("qwen_relay_jobs").insert(row).execute()
            rows = _result_data(result) or []
            return rows[0] if rows else row
        except Exception as exc:
            self.remove_request(request_path)
            raise RelayError(f"Failed to enqueue Qwen job: {exc}") from exc

    def claim_job(self, worker_id: str) -> dict[str, Any] | None:
        try:
            result = self.sb.rpc(
                "qwen_relay_claim_job",
                {"p_relay_id": self.config.relay_id, "p_worker_id": worker_id},
            ).execute()
            rows = _result_data(result) or []
            return rows[0] if rows else None
        except Exception as exc:
            raise RelayError(f"Failed to claim Qwen relay job: {exc}") from exc

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        result = (
            self.sb.table("qwen_relay_jobs")
            .select("id,status,error,request_path,worker_id,created_at,claimed_at,completed_at")
            .eq("id", job_id)
            .limit(1)
            .execute()
        )
        rows = _result_data(result) or []
        return rows[0] if rows else None

    def set_job_status(self, job_id: str, status: str, error: str | None = None) -> None:
        update: dict[str, Any] = {"status": status}
        if error is not None:
            update["error"] = error[:8000]
        if status in {"done", "error", "cancelled"}:
            update["completed_at"] = "now()"
        # PostgREST does not evaluate the string now(); use the DB trigger for timestamps.
        update.pop("completed_at", None)
        self.sb.table("qwen_relay_jobs").update(update).eq("id", job_id).execute()

    def cancel_job(self, job_id: str) -> None:
        try:
            self.sb.table("qwen_relay_jobs").update({"status": "cancelled"}).eq("id", job_id).execute()
        except Exception:
            pass

    def job_cancelled(self, job_id: str) -> bool:
        job = self.get_job(job_id)
        return bool(job and job.get("status") == "cancelled")

    def append_chunk(self, job_id: str, seq: int, payload: dict[str, Any]) -> None:
        row = {"job_id": job_id, "seq": seq, "payload": payload}
        self.sb.table("qwen_relay_chunks").insert(row).execute()

    def fetch_chunks(self, job_id: str, after_seq: int, limit: int = 100) -> list[dict[str, Any]]:
        result = (
            self.sb.table("qwen_relay_chunks")
            .select("seq,payload")
            .eq("job_id", job_id)
            .gt("seq", after_seq)
            .order("seq")
            .limit(limit)
            .execute()
        )
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
        row = {
            "relay_id": self.config.relay_id,
            "worker_id": worker_id,
            "status": status,
            "model": model,
            "context_window": context_window,
            "detail": detail,
        }
        self.sb.table("qwen_relay_workers").upsert(
            row, on_conflict="relay_id,worker_id"
        ).execute()

    def get_live_worker(self, max_age_seconds: int = 30) -> dict[str, Any] | None:
        result = (
            self.sb.table("qwen_relay_workers")
            .select("relay_id,worker_id,status,model,context_window,detail,updated_at")
            .eq("relay_id", self.config.relay_id)
            .eq("status", "online")
            .order("updated_at", desc=True)
            .limit(1)
            .execute()
        )
        rows = _result_data(result) or []
        if not rows:
            return None
        row = rows[0]
        # Let SQL expose an age check through qwen_relay_worker_alive for reliable timezone handling.
        try:
            alive = self.sb.rpc(
                "qwen_relay_worker_alive",
                {"p_relay_id": self.config.relay_id, "p_max_age_seconds": max_age_seconds},
            ).execute()
            if not bool(_result_data(alive)):
                return None
        except Exception:
            # If the helper is unavailable, keep the row and let job timeout diagnostics explain it.
            pass
        return row

    def cleanup_job(self, job_id: str, request_path: str | None = None) -> None:
        """Remove finished relay artifacts after the caller has consumed them."""
        try:
            self.sb.table("qwen_relay_chunks").delete().eq("job_id", job_id).execute()
        except Exception:
            pass
        if request_path:
            self.remove_request(request_path)
        try:
            self.sb.table("qwen_relay_jobs").delete().eq("id", job_id).execute()
        except Exception:
            pass


def sleep_with_jitter(seconds: float) -> None:
    # Tiny deterministic helper kept here so both sides can later add backoff centrally.
    time.sleep(seconds)
