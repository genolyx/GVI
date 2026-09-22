"""Engine regression test (Gate 1 of the refactor plan).

Each parametrized variant is sent through ``workbench.engine.analyze_variant``
and the resulting JSON is diffed against a gold baseline captured before
any refactor commits. The harness exists so the engine refactor (Gates 2-5)
can be proven *behavior-preserving* on a known set of variants the user has
already reviewed.

Usage
-----

The test is opt-in (it loads the full engine and may make external API calls)::

    WORKBENCH_RUN_ENGINE_TESTS=1 pytest tests/test_classifier_regression.py -v

Skip the literature pipeline (faster, but still diffs everything else)::

    WORKBENCH_RUN_ENGINE_TESTS=1 WORKBENCH_REGRESSION_NO_LITERATURE=1 \
        pytest tests/test_classifier_regression.py -v

Re-baseline (after intentional behavior change you have reviewed)::

    WORKBENCH_RUN_ENGINE_TESTS=1 WORKBENCH_REGRESSION_REBASELINE=1 \
        pytest tests/test_classifier_regression.py -v

Diff scope
----------

Per Gate 1 chat decision (2026-06-06): the user opted to **include** the
literature/Gemini outputs in the diff even though they are non-deterministic.
The harness reports literature diffs but does NOT fail the test on them by
default -- they are emitted on stdout for review. Code-driven fields
(``parsed_data.*``, ``results_acmg.*``, ``results_custom.*``,
``effective_gene``, ``gene_summary``) cause the test to fail if they
diverge.
"""
from __future__ import annotations

import glob
import json
import os

import pytest

from tests.regression._diff import (
    DEFAULT_IGNORE_PATHS,
    LITERATURE_PATHS,
    diff_json,
    filter_paths,
    summarize,
)
from tests.regression._runner import load_baseline, load_fixture, run_fixture


REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES_DIR = os.path.join(REPO_ROOT, "tests", "regression", "fixtures")
BASELINE_DIR = os.path.join(REPO_ROOT, "tests", "regression", "baseline")


def _discover_fixtures() -> list[str]:
    """Return ``[name, ...]`` for every ``*.fixture.json`` on disk."""
    paths = sorted(glob.glob(os.path.join(FIXTURES_DIR, "*.fixture.json")))
    return [os.path.basename(p)[: -len(".fixture.json")] for p in paths]


pytestmark = pytest.mark.skipif(
    os.environ.get("WORKBENCH_RUN_ENGINE_TESTS") != "1",
    reason="set WORKBENCH_RUN_ENGINE_TESTS=1 to run the full engine regression suite",
)


@pytest.fixture(scope="session")
def run_literature_flag() -> bool:
    return os.environ.get("WORKBENCH_REGRESSION_NO_LITERATURE") != "1"


@pytest.fixture(scope="session")
def rebaseline_flag() -> bool:
    return os.environ.get("WORKBENCH_REGRESSION_REBASELINE") == "1"


@pytest.mark.parametrize("name", _discover_fixtures())
def test_engine_output_matches_baseline(
    name: str,
    run_literature_flag: bool,
    rebaseline_flag: bool,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Run one fixture, diff against baseline, fail on code-field changes."""

    fixture_path = os.path.join(FIXTURES_DIR, f"{name}.fixture.json")
    baseline_path = os.path.join(BASELINE_DIR, f"{name}.baseline.json")

    fixture = load_fixture(fixture_path)
    if not os.path.isfile(baseline_path):
        if not rebaseline_flag:
            pytest.fail(
                f"{name}: no baseline at {baseline_path}. "
                "Run with WORKBENCH_REGRESSION_REBASELINE=1 to capture one."
            )
        # Rebaselining a brand-new fixture: still need to run the engine to
        # produce the snapshot.
        baseline = None
    else:
        baseline = load_baseline(name)

    current = run_fixture(fixture, run_literature=run_literature_flag)

    if rebaseline_flag:
        with open(baseline_path, "w", encoding="utf-8") as f:
            json.dump(current, f, indent=2, ensure_ascii=False, sort_keys=True)
        with capsys.disabled():
            print(f"\n[rebaseline] {name}: wrote new baseline ({len(json.dumps(current))} bytes)")
        return

    assert baseline is not None
    changes = diff_json(baseline, current, ignore_paths=DEFAULT_IGNORE_PATHS)

    if not changes:
        return

    # Partition: literature changes are reported but do not fail the test;
    # everything else is a code-field change and must fail.
    literature_changes = list(filter_paths(changes, LITERATURE_PATHS))
    literature_change_set = {(c.path, c.kind) for c in literature_changes}
    code_changes = [
        c for c in changes if (c.path, c.kind) not in literature_change_set
    ]

    with capsys.disabled():
        print(f"\n=== regression diff: {name} ===")
        print(f"  total changes : {summarize(changes)}")
        print(f"  literature     : {len(literature_changes)} (informational, not failing)")
        print(f"  code fields    : {len(code_changes)}")

        if literature_changes:
            print(f"\n  -- literature diffs (review only) --")
            for ch in literature_changes[:10]:
                print(f"    [{ch.kind}] {ch.path}")
            if len(literature_changes) > 10:
                print(f"    ... and {len(literature_changes) - 10} more")

        if code_changes:
            print(f"\n  -- code-field diffs (FAILING) --")
            for ch in code_changes[:30]:
                b = _short(ch.baseline)
                c = _short(ch.current)
                print(f"    [{ch.kind}] {ch.path}")
                print(f"      baseline: {b}")
                print(f"      current : {c}")
            if len(code_changes) > 30:
                print(f"    ... and {len(code_changes) - 30} more (truncated)")

    assert not code_changes, (
        f"{name}: {len(code_changes)} code-field regressions vs baseline "
        f"(see captured stdout above; rebaseline with WORKBENCH_REGRESSION_REBASELINE=1 "
        f"only after manually reviewing every change)"
    )


def _short(v, limit: int = 200) -> str:
    """Compact one-line repr for diff output."""
    s = repr(v)
    if len(s) > limit:
        s = s[:limit] + "...<truncated>"
    return s
