"""Smoke checks for the classification engine (app_v11.py).

Loading app_v11 imports heavy deps (pysam, google-genai) and may mount HGMD,
so the full module-load test is opt-in:

    WORKBENCH_RUN_ENGINE_TESTS=1 pytest tests/test_engine_smoke.py

The unguarded tests below only check that the engine file and its declared
dependencies exist, which is cheap and CI-safe.
"""
from __future__ import annotations

import os
import re

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE_FILE = os.path.join(REPO_ROOT, "app_v11.py")


def test_engine_file_present():
    assert os.path.isfile(ENGINE_FILE), "active engine app_v11.py missing from repo root"


def test_root_requirements_cover_engine_imports():
    """Every third-party top-level import in the engine should be pinned in requirements.txt."""
    req_path = os.path.join(REPO_ROOT, "requirements.txt")
    assert os.path.isfile(req_path), "root requirements.txt missing"
    reqs = open(req_path, encoding="utf-8").read().lower()

    # import name -> distribution name as it appears in requirements.txt
    expected = {
        "flask": "flask",
        "flask_cors": "flask-cors",
        "requests": "requests",
        "pandas": "pandas",
        "pysam": "pysam",
        "genai": "google-genai",
        "fitz": "pymupdf",
        "bs4": "beautifulsoup4",
        "dotenv": "python-dotenv",
    }
    src = open(ENGINE_FILE, encoding="utf-8").read()
    for import_name, dist in expected.items():
        if re.search(rf"(?m)^\s*(import {import_name}\b|from {import_name}\b)", src):
            assert dist in reqs, f"engine imports {import_name} but {dist} not in requirements.txt"


@pytest.mark.skipif(
    os.environ.get("WORKBENCH_RUN_ENGINE_TESTS") != "1",
    reason="set WORKBENCH_RUN_ENGINE_TESTS=1 to load the full engine (heavy deps / HGMD)",
)
def test_engine_module_loads_and_exposes_analyze_route():
    import importlib.util
    import sys

    if REPO_ROOT not in sys.path:
        sys.path.insert(0, REPO_ROOT)
    spec = importlib.util.spec_from_file_location("classifier_v11_test", ENGINE_FILE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert getattr(mod, "app", None) is not None, "engine has no Flask app"
    rules = {r.rule for r in mod.app.url_map.iter_rules()}
    assert "/api/analyze" in rules
