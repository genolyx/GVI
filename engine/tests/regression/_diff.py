"""Structured JSON diff for classifier outputs.

Produces a list of `Change` records describing every leaf-level difference
between two JSON-shaped dicts. Each change has a dotted path
(``parsed_data.splice_frame_math``, ``results_acmg.PVS1.applied``, ...) so
downstream code can apply pattern-based ignore rules without reflattening.

Why a custom diff (vs ``deepdiff`` etc.):

- We want a *stable, classifier-aware* representation: one row per leaf
  difference, with kind in {added, removed, value_changed, type_changed}.
- We want to ignore non-deterministic fields (Gemini summaries, timestamps,
  HTTP session-id-style strings) by *path glob*, not by value heuristic.
- Zero third-party deps so the harness is installable on any machine that
  already runs the engine.
"""
from __future__ import annotations

import fnmatch
from dataclasses import dataclass, asdict
from typing import Any, Iterable, Iterator, Sequence


SENTINEL_MISSING = object()


@dataclass(frozen=True)
class Change:
    """A single leaf-level difference between baseline and current JSON."""

    path: str           # dotted path, list indices as ``[N]``
    kind: str           # added | removed | value_changed | type_changed
    baseline: Any       # value in baseline (or repr of "missing")
    current: Any        # value in current (or repr of "missing")

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        # asdict will leave SENTINEL_MISSING as-is; replace with a string so
        # the result round-trips through json.dumps.
        for k in ("baseline", "current"):
            if d[k] is SENTINEL_MISSING:
                d[k] = "<missing>"
        return d


def _join(prefix: str, key: str | int) -> str:
    if isinstance(key, int):
        return f"{prefix}[{key}]"
    if not prefix:
        return str(key)
    return f"{prefix}.{key}"


def _matches_any(path: str, patterns: Sequence[str]) -> bool:
    return any(fnmatch.fnmatchcase(path, pat) for pat in patterns)


def diff_json(
    baseline: Any,
    current: Any,
    *,
    ignore_paths: Sequence[str] = (),
    path: str = "",
) -> list[Change]:
    """Return every leaf-level difference between baseline and current.

    ``ignore_paths`` is a list of fnmatch-style globs against the dotted
    path. Matching paths (and any descendants) are skipped entirely.

    The walk visits dict keys in sorted order and lists by index, so the
    output is deterministic and stable for diffing.
    """
    if path and _matches_any(path, ignore_paths):
        return []

    if type(baseline) is not type(current):
        # Allow None vs absent etc. -- only treat as type_changed when both
        # are present and concrete types differ.
        if baseline is None or current is None:
            return [Change(path=path or "<root>", kind="value_changed",
                           baseline=baseline, current=current)]
        return [Change(path=path or "<root>", kind="type_changed",
                       baseline=type(baseline).__name__,
                       current=type(current).__name__)]

    if isinstance(baseline, dict):
        return _diff_dict(baseline, current, ignore_paths=ignore_paths, path=path)
    if isinstance(baseline, list):
        return _diff_list(baseline, current, ignore_paths=ignore_paths, path=path)

    # Scalar leaf.
    if baseline != current:
        return [Change(path=path or "<root>", kind="value_changed",
                       baseline=baseline, current=current)]
    return []


def _diff_dict(b: dict, c: dict, *, ignore_paths, path: str) -> list[Change]:
    out: list[Change] = []
    keys = sorted(set(b.keys()) | set(c.keys()))
    for k in keys:
        sub = _join(path, str(k))
        if _matches_any(sub, ignore_paths):
            continue
        if k not in b:
            out.append(Change(path=sub, kind="added",
                              baseline=SENTINEL_MISSING, current=c[k]))
        elif k not in c:
            out.append(Change(path=sub, kind="removed",
                              baseline=b[k], current=SENTINEL_MISSING))
        else:
            out.extend(diff_json(b[k], c[k], ignore_paths=ignore_paths, path=sub))
    return out


def _diff_list(b: list, c: list, *, ignore_paths, path: str) -> list[Change]:
    out: list[Change] = []
    if len(b) != len(c):
        # Length change is itself a diff. We still walk the overlap so the
        # report shows both the length change and any per-index diffs.
        out.append(Change(
            path=path or "<root>",
            kind="value_changed",
            baseline=f"<list len={len(b)}>",
            current=f"<list len={len(c)}>",
        ))
    for i in range(min(len(b), len(c))):
        sub = _join(path, i)
        if _matches_any(sub, ignore_paths):
            continue
        out.extend(diff_json(b[i], c[i], ignore_paths=ignore_paths, path=sub))
    # Surface added/removed tail items individually so reviewers see what
    # changed at the end of the list, not just "length changed".
    if len(c) > len(b):
        for i in range(len(b), len(c)):
            sub = _join(path, i)
            if _matches_any(sub, ignore_paths):
                continue
            out.append(Change(path=sub, kind="added",
                              baseline=SENTINEL_MISSING, current=c[i]))
    elif len(b) > len(c):
        for i in range(len(c), len(b)):
            sub = _join(path, i)
            if _matches_any(sub, ignore_paths):
                continue
            out.append(Change(path=sub, kind="removed",
                              baseline=b[i], current=SENTINEL_MISSING))
    return out


# Field-path globs we ignore by default. These are non-deterministic or
# session-bound and would create permanent noise in every diff.
#
# IMPORTANT: keep this list small and surgical. The whole point of the
# harness is to catch unintended changes; over-ignoring defeats the purpose.
DEFAULT_IGNORE_PATHS: tuple[str, ...] = (
    # Top-level metadata that changes per run.
    "engine_version",
    "*.timestamp",
    "*.session_id",
    "*.run_id",
    # Gemini-generated prose (clinical profile + disease mechanism). These are
    # produced on every analyze (independent of the literature pipeline) and are
    # non-deterministic, so they would otherwise fail every diff. The code paths
    # that build them are unchanged by the engine refactor; we gate on the
    # deterministic fields instead.
    "gene_summary",
    "parsed_data.disease_mechanism",
    "parsed_data.disease_mechanism_citation",
    "parsed_data.clinical_publication_summary_html",
    "parsed_data.clinical_publication_summary_plaintext",
)


# Field-path globs the user opted to *exclude* from non-determinism handling.
# Per chat decision (Gate 1, 2026-06-06), literature stays IN the diff. If
# Gemini noise becomes a problem you can move these patterns into
# DEFAULT_IGNORE_PATHS and re-baseline.
LITERATURE_PATHS: tuple[str, ...] = (
    "literature.clinical_summary",
    "literature.functional_summary",
    "literature.mechanism_summary",
    "parsed_data.clinical_publication_summary_plaintext",
)


def summarize(changes: Iterable[Change]) -> dict[str, int]:
    """Group changes by kind for a human-readable header."""
    counts: dict[str, int] = {}
    for ch in changes:
        counts[ch.kind] = counts.get(ch.kind, 0) + 1
    return counts


def filter_paths(changes: Iterable[Change], patterns: Sequence[str]) -> Iterator[Change]:
    """Yield changes whose path matches any of the patterns."""
    for ch in changes:
        if _matches_any(ch.path, patterns):
            yield ch
