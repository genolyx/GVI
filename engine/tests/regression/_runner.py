"""Run a fixture through the live engine, return the JSON response.

Drives ``engine.service.engine_bridge.analyze`` (which loads ``app_v11``
in-process) and replays a fixture. Used by the regression test to produce
the "current" side of the diff.

This module is import-safe: it does not touch the engine until you call
:func:`run_fixture`.
"""
from __future__ import annotations

import json
import os
from typing import Any

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def load_fixture(path: str) -> dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def run_fixture(
    fixture: dict[str, Any],
    *,
    run_literature: bool = True,
) -> dict[str, Any]:
    """Re-run a fixture through ``analyze_variant`` and return the response.

    Parameters
    ----------
    fixture : dict
        Loaded fixture JSON (see ``_export.py``).
    run_literature : bool
        Whether to invoke the Gemini literature pipeline. Per Gate 1
        decision the regression diff *includes* literature, so the default
        is True. Set False for fast iteration during refactor work; the
        test will diff the deterministic fields anyway.
    """
    # The bridge loads app_v11.py and mounts ClinVar + HGMD on first call.
    from engine.service.engine_bridge import analyze

    inputs = fixture["inputs"]
    response, _duration_ms = analyze(
        gene=inputs["gene"],
        hgvs_c=inputs["c_dot"],
        transcript=inputs.get("transcript", "") or "",
        clinical_notes="",
        run_literature=run_literature,
    )
    return response


def load_baseline(name: str) -> dict[str, Any]:
    baseline_path = os.path.join(
        REPO_ROOT, "tests", "regression", "baseline", f"{name}.baseline.json"
    )
    with open(baseline_path, encoding="utf-8") as f:
        return json.load(f)
