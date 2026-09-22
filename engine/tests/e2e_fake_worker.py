"""Drain one curation run using the real worker client, without the real engine.

    engine/.venv/bin/python engine/tests/e2e_fake_worker.py [baseline-name]

Reads ENGINE_API_URL and ENGINE_WORKER_TOKEN from .env.

Everything here is production code except the analysis itself: the same
``EngineApiClient``, the same adapter, the same contract. The engine response is
replayed from a regression baseline so the check runs offline in under a second,
rather than needing a warm engine, a reference-data mount, and several minutes of
external API calls.

``baseline-name`` selects which baseline to replay, defaulting to AMT. The other
baselines cover splicing shapes AMT does not -- NLRP3 has an exon-internal cryptic
donor, NEB a secondary skip -- which the UI needs to be driven with.

Pair this with ``scripts/curation-e2e.ts``.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from dotenv import load_dotenv  # noqa: E402

from engine.service.adapter import to_curation_document  # noqa: E402
from engine.service.api_client import EngineApiClient, EngineApiError  # noqa: E402

BASELINE_DIR = Path(__file__).resolve().parent / "regression" / "baseline"
DEFAULT_BASELINE = "AMT_c.878-1G_A"


def resolve_baseline(name: str) -> Path:
    path = BASELINE_DIR / f"{name}.baseline.json"
    if not path.is_file():
        available = sorted(p.name.replace(".baseline.json", "") for p in BASELINE_DIR.glob("*.baseline.json"))
        raise SystemExit(f"no baseline {name!r}; available: {', '.join(available)}")
    return path


def main() -> int:
    # Read the worker token from .env in-process so it never has to appear on a
    # command line or in shell history.
    load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

    api_url = os.environ.get("ENGINE_API_URL", "http://localhost:3010")
    token = os.environ.get("ENGINE_WORKER_TOKEN", "")
    if not token:
        print("ENGINE_WORKER_TOKEN is required (set it in .env)", file=sys.stderr)
        return 2

    baseline = resolve_baseline(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_BASELINE)
    print(f"replaying {baseline.stem}")

    client = EngineApiClient(api_url, token, worker_id="e2e-fake-worker")

    run = client.claim()
    if run is None:
        print("No queued run to claim. Run `tsx scripts/curation-e2e.ts seed` first.")
        return 1

    print(f"claimed run {run.run_id}: {run.gene} {run.hgvs_c} (attempt {run.attempt})")
    print(f"  lease expires {run.lease_expires_at}")

    client.report_event(
        run.run_id, status="running", message="Replaying baseline response.", progress=30
    )
    lease = client.heartbeat(run.run_id)
    print(f"  heartbeat extended lease to {lease}")

    raw = json.loads(baseline.read_text())
    document = to_curation_document(
        raw,
        engine_version="v11-e2e",
        duration_ms=4242,
        hgmd_enabled=True,
        gemini_enabled=False,
        requested_gene=run.gene,
        requested_hgvs_c=run.hgvs_c,
    )
    payload = json.loads(document.model_dump_json(by_alias=True))

    document_hash = client.upload(run.document_upload, payload)
    raw_hash = client.upload(run.raw_upload, raw)
    print(f"  uploaded document ({document_hash[:12]}…) and raw response ({raw_hash[:12]}…)")

    client.complete(
        run.run_id,
        document=payload,
        document_key=run.document_upload.key,
        document_hash=document_hash,
        raw_key=run.raw_upload.key,
        raw_hash=raw_hash,
        timings={"engineMs": 4242},
    )
    print(f"completed run {run.run_id}")

    # The lease is gone now, so a second complete must be refused. This is the
    # guard that stops a reaped-then-resurrected worker from clobbering a rerun.
    try:
        client.complete(
            run.run_id,
            document=payload,
            document_key=run.document_upload.key,
            document_hash=document_hash,
            raw_key=run.raw_upload.key,
            raw_hash=raw_hash,
            timings={},
        )
    except EngineApiError as exc:
        print(f"  second complete correctly rejected: HTTP {exc.status_code} {exc}")
    else:
        print("  ERROR: a stale worker was allowed to complete the run twice", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
