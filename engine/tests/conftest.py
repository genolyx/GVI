"""Shared pytest configuration for the vendored engine test suite.

SAM-VC's original conftest wired up the Flask workbench's SQLite layer. That
workbench is not part of GVI — the control plane owns persistence — so the fixture
and its tests were dropped during the port.
"""
from __future__ import annotations

from engine.service.config import ensure_engine_importable

# `app_v11.py` does `from vc_engine.… import …`, so `engine/` must be on sys.path
# for any test that touches engine internals.
ensure_engine_importable()
