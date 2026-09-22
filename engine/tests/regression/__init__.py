"""Engine regression harness.

Captures full classifier output (workbench engine.analyze_variant) for a
fixed set of variants, snapshots the JSON, and diffs future runs against
the snapshot. Used as a safety net so that
behavior-preserving changes can be proven equivalent and behavior-changing
changes get flagged for review before merge.

This package is intentionally self-contained:

  tests/regression/
    fixtures/    -- one JSON per fixture (gene, c_dot, transcript, emg_raw)
    baseline/    -- one JSON per fixture (full /api/analyze response snapshot)
    _diff.py     -- structured JSON diff with field-pattern ignore lists
    _export.py   -- one-shot script: dump fixtures + baselines from workbench DB
    _runner.py   -- runs analyze_variant for a fixture (in-process)
"""
