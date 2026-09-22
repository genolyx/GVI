"""Small generic utilities shared across the engine package.

Extracted from ``app_v11.py`` (Phase 3 of ``docs/ENGINE_SPLIT_PLAN.md``).
"""
from __future__ import annotations


def _safe_int_or_none(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None
