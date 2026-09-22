"""Curation worker run loop.

    python -m engine.service.worker

One process handles one run at a time. The engine holds mutable module-level state
(an open ClinVar tabix handle, an in-process HTTP cache) and is not thread-safe, so
concurrency comes from running more replicas — never more threads.

Liveness and readiness are served from a small stdlib HTTP server rather than a web
framework: the worker is a polling client, and two probe endpoints do not justify
pulling in an ASGI stack. Readiness stays false until the engine has finished
mounting its reference data, which takes minutes.
"""
from __future__ import annotations

import json
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional

from .adapter import to_curation_document
from .api_client import ClaimedRun, EngineApiClient, EngineApiError
from .config import WorkerSettings
from .engine_bridge import EngineAnalysisError, is_ready, load_engine, load_error

_shutdown = threading.Event()
_current_run_id: Optional[int] = None


class _ProbeHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path == "/healthz":
            self._respond(200, {"status": "alive"})
        elif self.path == "/readyz":
            if is_ready():
                self._respond(200, {"status": "ready"})
            else:
                self._respond(503, {"status": "loading", "error": load_error()})
        else:
            self._respond(404, {"error": "not_found"})

    def _respond(self, status: int, body: dict[str, Any]) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args: Any) -> None:
        # Probe traffic is every few seconds; logging it drowns out the run log.
        return


def _start_probe_server(port: int) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("0.0.0.0", port), _ProbeHandler)
    thread = threading.Thread(target=server.serve_forever, name="probes", daemon=True)
    thread.start()
    print(f"[worker] probes listening on :{port}", flush=True)
    return server


class _Heartbeat:
    """Keeps the lease alive for as long as a run is in flight."""

    def __init__(self, client: EngineApiClient, run_id: int, interval: float) -> None:
        self._client = client
        self._run_id = run_id
        self._interval = interval
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name=f"heartbeat-{run_id}", daemon=True)

    def __enter__(self) -> "_Heartbeat":
        self._thread.start()
        return self

    def __exit__(self, *_exc: Any) -> None:
        self._stop.set()
        self._thread.join(timeout=5)

    def _loop(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                self._client.heartbeat(self._run_id)
            except EngineApiError as exc:
                # A rejected heartbeat means the reaper already requeued this run.
                # Keep going; `complete` will be rejected too and the loop moves on.
                print(f"[worker] heartbeat rejected for run {self._run_id}: {exc}", flush=True)


def _process(client: EngineApiClient, settings: WorkerSettings, run: ClaimedRun) -> None:
    global _current_run_id
    _current_run_id = run.run_id
    print(
        f"[worker] run {run.run_id}: {run.gene} {run.hgvs_c} (attempt {run.attempt})",
        flush=True,
    )

    if run.reference_build not in ("GRCh38", "GRCh37"):
        client.fail(
            run.run_id,
            message=f"Curation supports GRCh38 and GRCh37 (lifted). This run is {run.reference_build}.",
            kind="unsupported_reference_build",
            retryable=False,
        )
        return

    with _Heartbeat(client, run.run_id, settings.heartbeat_interval_seconds):
        try:
            client.report_event(
                run.run_id, status="running", message="Engine analysis started.", progress=5
            )
            raw, duration_ms = analyze_run(run, settings)

            client.report_event(
                run.run_id, status="running", message="Mapping engine output.", progress=70
            )
            document = to_curation_document(
                raw,
                engine_version=settings.engine_version,
                duration_ms=duration_ms,
                hgmd_enabled=settings.hgmd_enabled,
                gemini_enabled=settings.gemini_enabled,
                requested_gene=run.gene,
                requested_hgvs_c=run.hgvs_c,
            )
            document_payload = json.loads(document.model_dump_json(by_alias=True))

            client.report_event(
                run.run_id, status="running", message="Archiving results.", progress=85
            )
            document_hash = client.upload(run.document_upload, document_payload)
            raw_hash = client.upload(run.raw_upload, raw)

            client.complete(
                run.run_id,
                document=document_payload,
                document_key=run.document_upload.key,
                document_hash=document_hash,
                raw_key=run.raw_upload.key,
                raw_hash=raw_hash,
                timings={"engineMs": duration_ms},
            )
            print(f"[worker] run {run.run_id} succeeded in {duration_ms}ms", flush=True)

        except EngineAnalysisError as exc:
            # The engine rejected the variant. Retrying the same input will not help.
            client.fail(run.run_id, message=str(exc), kind="engine_analysis", retryable=False)
            print(f"[worker] run {run.run_id} failed: {exc}", flush=True)
        except ValueError as exc:
            # Adapter or contract violation: a code bug, not a transient fault.
            client.fail(run.run_id, message=str(exc), kind="contract", retryable=False)
            print(f"[worker] run {run.run_id} contract error: {exc}", flush=True)
        except Exception as exc:  # noqa: BLE001 - network, storage, timeouts
            client.fail(
                run.run_id,
                message=f"{type(exc).__name__}: {exc}",
                kind="transient",
                retryable=True,
            )
            print(f"[worker] run {run.run_id} transient error: {exc}", flush=True)


def analyze_run(run: ClaimedRun, settings: WorkerSettings) -> tuple[dict[str, Any], int]:
    from .engine_bridge import analyze

    return analyze(
        gene=run.gene,
        hgvs_c=run.hgvs_c,
        transcript=run.transcript,
        hgvs_p=run.hgvs_p,
        clinical_notes=run.clinical_notes,
        engine_version=settings.engine_version,
        run_literature=settings.run_literature and run.run_literature,
    )


def _install_signal_handlers() -> None:
    def handle(signum: int, _frame: Any) -> None:
        print(f"[worker] signal {signum}; finishing current run then exiting", flush=True)
        _shutdown.set()

    signal.signal(signal.SIGTERM, handle)
    signal.signal(signal.SIGINT, handle)


def main(argv: Optional[list[str]] = None) -> int:
    del argv
    settings = WorkerSettings.from_env()
    settings.apply_engine_env()

    _install_signal_handlers()
    probe_server = _start_probe_server(settings.health_port)

    print(
        f"[worker] id={settings.worker_id} engine={settings.engine_version} "
        f"hgmd={'on' if settings.hgmd_enabled else 'off'} "
        f"gemini={'on' if settings.gemini_enabled else 'off'}",
        flush=True,
    )

    try:
        # Mount reference data before claiming anything, so a slow cold start never
        # burns a lease.
        load_engine(settings.engine_version)
    except Exception as exc:  # noqa: BLE001
        print(f"[worker] fatal: engine failed to load: {exc}", flush=True)
        probe_server.shutdown()
        return 1

    client = EngineApiClient(settings.api_url, settings.worker_token, settings.worker_id)

    llm_via_proxy = False
    if settings.gemini_enabled:
        try:
            llm_via_proxy = bool(client.health().get("llm"))
        except EngineApiError as exc:
            print(f"[worker] engine API health check failed: {exc}", flush=True)
        if llm_via_proxy:
            from .engine_bridge import install_llm_proxy

            os.environ["GVI_LLM_PROXY_URL"] = f"{settings.api_url}/api/engine/v1/llm"
            install_llm_proxy(
                lambda prompt, model=None: client.complete_llm(prompt, run_id=_current_run_id)
            )
            print("[worker] LLM via GVI proxy", flush=True)
        elif not os.environ.get("GEMINI_API_KEY", "").strip():
            os.environ["VC_DISABLE_GEMINI"] = "1"
            print("[worker] LLM disabled (proxy not configured, no Gemini key)", flush=True)

    idle_logged = False
    while not _shutdown.is_set():
        try:
            run = client.claim()
        except EngineApiError as exc:
            print(f"[worker] claim failed: {exc}", flush=True)
            _shutdown.wait(settings.poll_interval_seconds)
            continue

        if run is None:
            if not idle_logged:
                print("[worker] queue empty; polling", flush=True)
                idle_logged = True
            _shutdown.wait(settings.poll_interval_seconds)
            continue

        idle_logged = False
        _process(client, settings, run)

    probe_server.shutdown()
    print("[worker] stopped", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
