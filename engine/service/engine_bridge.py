"""In-process bridge to the vendored SAM-VC engine.

The engine is a Flask app whose only useful surface is ``POST /api/analyze`` plus the
literature routes. Rather than run it as a second HTTP server, the worker loads it
once and drives it through Flask's test client. The SAM-VC Flask workbench is not
shipped; GVI owns the UI and persistence.

Loading is deliberately eager and one-shot: importing ``app_v11`` opens the ClinVar
tabix VCF and reads the HGMD spreadsheet into RAM, which takes minutes. A worker is
therefore a long-lived warm process that handles one analysis at a time. The engine
holds mutable module-level state (an open ``pysam.VariantFile``), so never call into
it from more than one thread. Outbound HTTP is cached in Redis when available.
"""
from __future__ import annotations

import importlib.util
import os
import threading
import time
from typing import Any, Optional

from .config import ENGINE_ROOT, ensure_engine_importable

_app: Any = None
_module: Any = None
_load_lock = threading.Lock()
_analyze_lock = threading.Lock()
_load_error: Optional[str] = None


def is_ready() -> bool:
    return _app is not None


def load_error() -> Optional[str]:
    return _load_error


def load_engine(engine_version: str = "v11") -> Any:
    """Import ``app_<version>.py`` and return its Flask app. Idempotent."""
    global _app, _module, _load_error
    if _app is not None:
        return _app

    with _load_lock:
        if _app is not None:
            return _app

        engine_file = ENGINE_ROOT / f"app_{engine_version}.py"
        if not engine_file.is_file():
            _load_error = f"Engine module not found: {engine_file}"
            raise FileNotFoundError(_load_error)

        ensure_engine_importable()
        # The engine resolves `deep_intronic_rna_evidence.json` and other assets
        # relative to its own directory, and some helpers assume it is the cwd.
        os.chdir(ENGINE_ROOT)

        spec = importlib.util.spec_from_file_location(f"gvi_engine_{engine_version}", engine_file)
        if spec is None or spec.loader is None:
            _load_error = f"Cannot load engine module: {engine_file}"
            raise ImportError(_load_error)

        started = time.monotonic()
        print(f"[engine] loading {engine_file.name} (ClinVar + HGMD mount starts now)…", flush=True)
        module = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(module)
        except Exception as exc:  # noqa: BLE001 - surfaced through readiness
            _load_error = f"{type(exc).__name__}: {exc}"
            raise

        app = getattr(module, "app", None)
        if app is None:
            _load_error = "Engine module exposes no Flask `app`"
            raise AttributeError(_load_error)

        print(f"[engine] ready in {time.monotonic() - started:.1f}s", flush=True)
        _app = app
        _module = module
        _load_error = None
        return _app


def install_llm_proxy(complete) -> None:
    """Point the loaded engine at the GVI LLM proxy instead of Gemini."""
    from .llm_proxy import GviLlmClient, set_shared_client

    client = GviLlmClient(complete)
    set_shared_client(client)
    if _module is not None:
        _module.client = client
        analyze = getattr(_module, "_vc_analyze", None)
        if analyze is not None:
            analyze.client = client
    try:
        import vc_engine.analyze as analyze_mod

        analyze_mod.client = client
    except ImportError:
        pass
    os.environ["GVI_LLM_PROXY"] = "1"


def analyze(
    *,
    gene: str,
    hgvs_c: str,
    transcript: str = "",
    hgvs_p: str = "",
    clinical_notes: str = "",
    engine_version: str = "v11",
    run_literature: bool = True,
) -> tuple[dict[str, Any], int]:
    """Run one curation analysis.

    Returns the raw engine response and the elapsed wall time in milliseconds.
    Raises ``EngineAnalysisError`` when the engine reports a failure.
    """
    app = load_engine(engine_version)
    payload = {
        "gene": gene.strip(),
        "c_dot": hgvs_c.strip(),
        "transcript": (transcript or "").strip(),
        "hgvs_p": (hgvs_p or "").strip(),
        "clinical_notes": (clinical_notes or "").strip(),
    }

    started = time.monotonic()
    # Serialised because the engine's module-level state is not thread-safe.
    with _analyze_lock:
        with app.test_client() as client:
            response = client.post("/api/analyze", json=payload, content_type="application/json")
            body = response.get_json(silent=True) or {}
            status = response.status_code

        if status != 200 or not body.get("success"):
            raise EngineAnalysisError(
                body.get("error") or f"Engine returned HTTP {status}", status_code=status
            )

        if run_literature:
            body = enrich_with_literature(app, body, gene=payload["gene"], hgvs_c=payload["c_dot"])

    return body, int((time.monotonic() - started) * 1000)


class EngineAnalysisError(RuntimeError):
    def __init__(self, message: str, *, status_code: int = 500) -> None:
        super().__init__(message)
        self.status_code = status_code


def enrich_with_literature(
    app: Any,
    analyze_result: dict[str, Any],
    *,
    gene: str,
    hgvs_c: str,
    force_pmids: str = "",
) -> dict[str, Any]:
    """Attach ``literature.*`` by calling the engine's download + summarize routes.

    Literature is best-effort: a
    failure here records an error on the document rather than failing the run,
    because the ACMG result is already complete without it.
    """
    parsed = analyze_result.get("parsed_data") or {}
    index = parsed.get("literature_index") or {}

    index_pmids = [str(p).strip() for p in (index.get("pmids") or []) if str(p).strip().isdigit()]
    forced = ",".join(filter(None, [force_pmids.strip(), ",".join(index_pmids)]))

    request_base = {
        "gene": gene,
        "c_dot": hgvs_c,
        "hgvs_p": (parsed.get("hgvs_p") or "").strip(),
        "vid": str(parsed.get("clinvar_rcv") or "").strip(),
        "force_pmids": forced,
        "hgmd_pmids": ",".join(
            str(p) for p in (parsed.get("hgmd_excel_pmids") or []) if str(p).strip()
        ),
        "alternate_transcript_literature": parsed.get("alternate_transcript_literature") or [],
    }

    literature: dict[str, Any] = {"status": "skipped"}
    if index.get("available") and (index.get("hit_count") or 0) > 0:
        literature["local_index"] = {
            "query": index.get("query"),
            "hit_count": index.get("hit_count"),
            "pmids": index.get("pmids") or [],
        }

    try:
        with app.test_client() as client:
            download = client.post("/api/download_literature", json=request_base)
            download_body = download.get_json(silent=True) or {}
            if download.status_code != 200:
                literature["status"] = "download_failed"
                literature["error"] = str(download_body.get("error") or download.status_code)
                analyze_result["literature"] = literature
                return analyze_result

            folder = (download_body.get("folder") or "").strip()
            if not folder or not os.path.isdir(folder):
                literature["status"] = "no_folder"
                analyze_result["literature"] = literature
                return analyze_result

            summarize_payload = {
                **request_base,
                "folder_path": folder,
                "queued_pmids": download_body.get("queued_pmids") or download_body.get("pmids") or [],
            }

            clinical = client.post("/api/summarize_literature", json=summarize_payload)
            clinical_body = clinical.get_json(silent=True) or {}
            if clinical.status_code == 200 and clinical_body.get("summary"):
                literature["clinical_summary"] = clinical_body["summary"]
                literature["status"] = "ok"
            else:
                literature["status"] = "summarize_failed"
                literature["error"] = str(
                    clinical_body.get("error") or f"HTTP {clinical.status_code}"
                )

            functional = client.post("/api/summarize_functional", json=summarize_payload)
            functional_body = functional.get_json(silent=True) or {}
            if functional.status_code == 200 and functional_body.get("summary"):
                literature["functional_summary"] = functional_body["summary"]
    except Exception as exc:  # noqa: BLE001 - literature never fails the run
        literature = {"status": "error", "error": str(exc)[:500]}

    analyze_result["literature"] = literature
    return analyze_result
