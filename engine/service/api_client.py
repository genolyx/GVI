"""Client for the GVI Engine API v1.

The worker holds no database credentials. Tenant isolation lives in the control
plane (``server/domain/tenant.ts``), so every read and write goes over HTTP with a
shared worker token. That keeps the isolation logic in exactly one place.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Optional

import requests


class EngineApiError(RuntimeError):
    def __init__(self, message: str, *, status_code: int = 0) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class PresignedUpload:
    url: str
    key: str
    headers: dict[str, str]


@dataclass(frozen=True)
class ClaimedRun:
    run_id: int
    organization_id: int
    contract_version: str
    lease_expires_at: str
    attempt: int
    gene: str
    hgvs_c: str
    transcript: str
    hgvs_p: str
    clinical_notes: str
    reference_build: str
    run_literature: bool
    #: Where to PUT the CurationDocument the client renders.
    document_upload: PresignedUpload
    #: Where to PUT the unmodified engine response, kept for reproducibility.
    raw_upload: PresignedUpload

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "ClaimedRun":
        variant = payload.get("input") or {}

        def upload(key: str) -> PresignedUpload:
            block = payload.get(key) or {}
            return PresignedUpload(
                url=block.get("url", ""),
                key=block.get("key", ""),
                headers=block.get("headers") or {},
            )

        return cls(
            run_id=int(payload["runId"]),
            organization_id=int(payload["organizationId"]),
            contract_version=str(payload.get("contractVersion", "1.0")),
            lease_expires_at=str(payload.get("leaseExpiresAt", "")),
            attempt=int(payload.get("attempt", 1)),
            gene=str(variant.get("gene", "")),
            hgvs_c=str(variant.get("hgvsC", "")),
            transcript=str(variant.get("transcript") or ""),
            hgvs_p=str(variant.get("hgvsP") or ""),
            clinical_notes=str(variant.get("clinicalNotes") or ""),
            reference_build=str(variant.get("referenceBuild") or "GRCh38"),
            run_literature=bool(variant.get("runLiterature", True)),
            document_upload=upload("documentUpload"),
            raw_upload=upload("rawUpload"),
        )


class EngineApiClient:
    def __init__(self, base_url: str, token: str, worker_id: str, *, timeout: float = 30.0) -> None:
        if not token:
            raise ValueError("ENGINE_WORKER_TOKEN is required")
        self._base = base_url.rstrip("/")
        self._worker_id = worker_id
        self._timeout = timeout
        self._session = requests.Session()
        self._session.headers.update(
            {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "X-Engine-Worker-Id": worker_id,
            }
        )

    def health(self) -> dict[str, Any]:
        try:
            response = self._session.get(f"{self._base}/api/engine/v1/health", timeout=self._timeout)
        except requests.RequestException as exc:
            raise EngineApiError(f"{type(exc).__name__}: {exc}") from exc
        try:
            payload = response.json()
        except ValueError:
            payload = {}
        if response.status_code >= 400:
            raise EngineApiError(
                str(payload.get("error") or f"HTTP {response.status_code}"),
                status_code=response.status_code,
            )
        return payload if isinstance(payload, dict) else {}

    def complete_llm(
        self,
        prompt: str,
        *,
        purpose: str = "gene_profile",
        run_id: Optional[int] = None,
    ) -> str:
        body: dict[str, Any] = {
            "workerId": self._worker_id,
            "purpose": purpose,
            "prompt": prompt,
        }
        if run_id:
            body["runId"] = run_id
        _, payload = self._post("/api/engine/v1/llm", body)
        return str(payload.get("text") or "")

    def _post(self, path: str, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        try:
            response = self._session.post(
                f"{self._base}{path}", data=json.dumps(body), timeout=self._timeout
            )
        except requests.RequestException as exc:
            # A restarted API must not kill the warm worker. Callers already retry.
            raise EngineApiError(f"{type(exc).__name__}: {exc}") from exc
        if response.status_code == 204:
            return 204, {}
        try:
            payload = response.json()
        except ValueError:
            payload = {}
        if response.status_code >= 400:
            raise EngineApiError(
                str(payload.get("error") or f"HTTP {response.status_code}"),
                status_code=response.status_code,
            )
        return response.status_code, payload

    def claim(self) -> Optional[ClaimedRun]:
        """Lease the next queued run, or None when the queue is empty."""
        status, payload = self._post("/api/engine/v1/claim", {"workerId": self._worker_id})
        if status == 204 or not payload:
            return None
        return ClaimedRun.from_payload(payload)

    def heartbeat(self, run_id: int) -> str:
        """Extend the lease. Returns the new expiry."""
        _, payload = self._post(
            f"/api/engine/v1/runs/{run_id}/heartbeat", {"workerId": self._worker_id}
        )
        return str(payload.get("leaseExpiresAt", ""))

    def report_event(self, run_id: int, *, status: str, message: str, progress: int) -> None:
        self._post(
            f"/api/engine/v1/runs/{run_id}/events",
            {
                "workerId": self._worker_id,
                "status": status,
                "message": message,
                "progressPercent": max(0, min(100, int(progress))),
            },
        )

    def complete(
        self,
        run_id: int,
        *,
        document: dict[str, Any],
        document_key: str,
        document_hash: str,
        raw_key: str,
        raw_hash: str,
        timings: dict[str, Any],
    ) -> None:
        """Hand the finished run back to the control plane.

        The full document travels in the body even though it is already in object
        storage: the server validates it against the Zod contract before trusting
        it, and derives the queryable `summary` projection from it. Keeping that
        projection in one place (``shared/curation/document.ts``) avoids a second
        Python implementation drifting out of step.
        """
        self._post(
            f"/api/engine/v1/runs/{run_id}/complete",
            {
                "workerId": self._worker_id,
                "document": document,
                "documentKey": document_key,
                "documentHash": document_hash,
                "rawKey": raw_key,
                "rawHash": raw_hash,
                "timings": timings,
            },
        )

    def fail(self, run_id: int, *, message: str, kind: str, retryable: bool) -> None:
        self._post(
            f"/api/engine/v1/runs/{run_id}/fail",
            {
                "workerId": self._worker_id,
                "error": {"message": message[:2000], "kind": kind},
                "retryable": retryable,
            },
        )

    def upload(self, target: PresignedUpload, payload: dict[str, Any]) -> str:
        """PUT JSON to object storage and return its SHA-256.

        The hash is computed over the exact bytes uploaded, so the control plane can
        verify integrity later without re-fetching and re-serialising.
        """
        body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        digest = hashlib.sha256(body).hexdigest()
        headers = {"Content-Type": "application/json", **target.headers}
        response = requests.put(target.url, data=body, headers=headers, timeout=120)
        if response.status_code >= 400:
            raise EngineApiError(
                f"Upload to {target.key} failed: HTTP {response.status_code}",
                status_code=response.status_code,
            )
        return digest
