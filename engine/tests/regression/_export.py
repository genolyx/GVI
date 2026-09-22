"""One-shot export: dump fixtures + baseline snapshots from the workbench DB.

Reads the workbench SQLite database (whichever location ``workbench.config``
resolves to -- by default the SD-card mount), and writes:

  tests/regression/fixtures/<NAME>.fixture.json
  tests/regression/baseline/<NAME>.baseline.json

Each fixture file contains the inputs the regression test will send to
``analyze_variant``; each baseline contains the full ``/api/analyze`` JSON
response we want future runs to match.

USE
---
The list of fixtures lives in ``FIXTURE_SPECS`` below. Each spec is a tuple
``(name, entry_id)``. ``entry_id`` is the workbench ``entries.id``; the
script picks the most recent successful ``runs`` row for that entry.

Run from the repo root::

    python -m tests.regression._export

To export only specific fixtures::

    python -m tests.regression._export DDX39B AMT

To force overwriting existing files::

    python -m tests.regression._export --force

The script is intentionally self-contained -- it does NOT call the engine.
It only mirrors what the workbench already saved. Use this to capture the
*current* observed behavior as the gold baseline; later, when the engine is
refactored, the regression test re-runs ``analyze_variant`` and diffs.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Optional

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WORKBENCH_DIR = os.path.join(REPO_ROOT, "workbench")
FIXTURES_DIR = os.path.join(REPO_ROOT, "tests", "regression", "fixtures")
BASELINE_DIR = os.path.join(REPO_ROOT, "tests", "regression", "baseline")


# Fixture roster. Names are filename-safe (no spaces/slashes). Entry IDs are
# the workbench ``entries.id`` rows on the user's SD-card DB at the time of
# Gate 1 setup. If you re-seed the DB or move to a different machine, run
# this script with the new entry IDs (or use the lookup helper below).
FIXTURE_SPECS: list[tuple[str, int]] = [
    # (name,                            entry_id)
    ("DDX39B_c.212-8A_G",                81),  # junction-proximal cryptic acceptor (user-confirmed gold)
    ("NLRP3_c.2798G_T",                  16),  # exon-internal cryptic donor, minus strand
    ("AMT_c.878-1G_A",                   19),  # canonical acceptor, in-frame skip
    ("NEB_c.21522+3A_T",                 67),  # donor region, in-frame skip with P/LP in deleted exon
]


def _resolve_db_path() -> str:
    """Use workbench.config to find the live DB (respects env vars / SD card)."""
    if WORKBENCH_DIR not in sys.path:
        sys.path.insert(0, WORKBENCH_DIR)
    import config  # type: ignore  (workbench/config.py)
    return config.DB_PATH


def _lookup_entry(conn, entry_id: int) -> Optional[dict]:
    cur = conn.execute(
        """
        SELECT id, batch_id, gene, c_dot, transcript, case_id, lab_id, emg_raw, emg_parsed_json
        FROM entries WHERE id = ?
        """,
        (entry_id,),
    )
    row = cur.fetchone()
    if not row:
        return None
    cols = [d[0] for d in cur.description]
    return dict(zip(cols, row))


def _latest_done_run(conn, entry_id: int) -> Optional[dict]:
    cur = conn.execute(
        """
        SELECT id, engine_version, status, result_json, started_at, finished_at
        FROM runs
        WHERE entry_id = ? AND status = 'done'
        ORDER BY id DESC
        LIMIT 1
        """,
        (entry_id,),
    )
    row = cur.fetchone()
    if not row:
        return None
    cols = [d[0] for d in cur.description]
    return dict(zip(cols, row))


def export_one(conn, name: str, entry_id: int, *, force: bool) -> tuple[bool, str]:
    """Export a single fixture+baseline pair. Returns (wrote_anything, message)."""
    fixture_path = os.path.join(FIXTURES_DIR, f"{name}.fixture.json")
    baseline_path = os.path.join(BASELINE_DIR, f"{name}.baseline.json")

    if not force and os.path.exists(fixture_path) and os.path.exists(baseline_path):
        return False, f"[skip] {name} already exported (use --force to overwrite)"

    entry = _lookup_entry(conn, entry_id)
    if not entry:
        return False, f"[fail] {name}: entries.id={entry_id} not found in DB"
    run = _latest_done_run(conn, entry_id)
    if not run:
        return False, f"[fail] {name}: no successful run for entries.id={entry_id}"

    fixture = {
        "name": name,
        "source": {
            "entry_id": entry_id,
            "batch_id": entry["batch_id"],
            "engine_version": run["engine_version"],
            "captured_run_id": run["id"],
            "captured_at": run["finished_at"],
        },
        "inputs": {
            "gene": entry["gene"],
            "c_dot": entry["c_dot"],
            "transcript": entry["transcript"] or "",
            "case_id": entry["case_id"] or "",
            "lab_id": entry["lab_id"] or "",
            "emg_raw": entry["emg_raw"] or "",
            "emg_parsed_json": (
                json.loads(entry["emg_parsed_json"]) if entry["emg_parsed_json"] else None
            ),
        },
    }

    try:
        baseline = json.loads(run["result_json"])
    except json.JSONDecodeError as exc:
        return False, f"[fail] {name}: result_json malformed ({exc})"

    os.makedirs(FIXTURES_DIR, exist_ok=True)
    os.makedirs(BASELINE_DIR, exist_ok=True)
    with open(fixture_path, "w", encoding="utf-8") as f:
        json.dump(fixture, f, indent=2, ensure_ascii=False, sort_keys=True)
    with open(baseline_path, "w", encoding="utf-8") as f:
        json.dump(baseline, f, indent=2, ensure_ascii=False, sort_keys=True)

    return True, (
        f"[ok]   {name}: entry={entry_id} run={run['id']} engine={run['engine_version']} "
        f"({len(run['result_json']) // 1024} KB)"
    )


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("names", nargs="*", help="optional subset of fixture names to export")
    parser.add_argument("--force", action="store_true", help="overwrite existing files")
    parser.add_argument("--list", action="store_true", help="list known fixtures and exit")
    args = parser.parse_args(argv)

    if args.list:
        for name, entry_id in FIXTURE_SPECS:
            print(f"  {name}  (entry_id={entry_id})")
        return 0

    selected = (
        FIXTURE_SPECS
        if not args.names
        else [(n, eid) for (n, eid) in FIXTURE_SPECS if n in set(args.names)]
    )
    if args.names and not selected:
        print(f"no fixture names matched. known: {[n for n, _ in FIXTURE_SPECS]}", file=sys.stderr)
        return 2

    db_path = _resolve_db_path()
    if not os.path.isfile(db_path):
        print(f"workbench DB not found at {db_path}", file=sys.stderr)
        print("If you use an SD card, plug it in or set WORKBENCH_DATA_DIR.", file=sys.stderr)
        return 2
    print(f"using workbench DB at {db_path}")

    import sqlite3
    conn = sqlite3.connect(db_path)
    try:
        ok = 0
        fail = 0
        for name, entry_id in selected:
            wrote, msg = export_one(conn, name, entry_id, force=args.force)
            print(msg)
            if wrote:
                ok += 1
            elif "[fail]" in msg:
                fail += 1
        print(f"\nexport complete: {ok} written, {fail} failed, "
              f"{len(selected) - ok - fail} skipped")
        return 0 if fail == 0 else 1
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
