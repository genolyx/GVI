# Engine regression harness

Safety net for engine changes.
Captures the live `analyze_variant` JSON for a fixed roster of variants the
user has reviewed and approved, then diffs future runs against the snapshot
so behavior-preserving refactors can be proven equivalent.

## Layout

```
tests/regression/
├── _diff.py        ← structured JSON diff (path/kind/baseline/current)
├── _export.py      ← CLI: read workbench DB, write fixtures + baselines
├── _runner.py      ← in-process driver: runs analyze_variant for a fixture
├── fixtures/       ← inputs (gene, c_dot, transcript, EMG paste)
└── baseline/       ← gold-standard /api/analyze JSON snapshots
tests/
└── test_classifier_regression.py  ← pytest entry point
```

## Capturing a baseline

Pulls the most recent `runs.status='done'` row for each entry listed in
`_export.py:FIXTURE_SPECS` from the workbench SQLite database. Respects
`WORKBENCH_DATA_DIR` / SD-card mount via `workbench/config.py`.

```bash
python -m tests.regression._export             # all fixtures
python -m tests.regression._export DDX39B AMT  # subset
python -m tests.regression._export --force     # overwrite
python -m tests.regression._export --list      # show roster
```

The script never calls the engine — it only mirrors what the workbench
already saved. Use it once at the start of each refactor gate to lock in
"current correct behavior."

## Running the regression test

```bash
WORKBENCH_RUN_ENGINE_TESTS=1 pytest tests/test_classifier_regression.py -v
```

The test is opt-in because loading `app_v11.py` mounts HGMD (slow) and may
make external API calls (Broad SpliceAI, ClinVar, MyVariant, Gemini).

### Flags

| Env var | Effect |
|---------|--------|
| `WORKBENCH_RUN_ENGINE_TESTS=1` | required; enables the regression suite |
| `WORKBENCH_REGRESSION_NO_LITERATURE=1` | skip Gemini calls; faster iteration |
| `WORKBENCH_REGRESSION_REBASELINE=1` | overwrite baseline with the current run output (use only after reviewing every diff) |

### Diff scope

By Gate 1 chat decision the harness diffs **everything**, including
literature/Gemini summaries. Because Gemini is non-deterministic, the
test partitions diffs into two buckets:

- **Code-field diffs** (`parsed_data.*`, `results_acmg.*`, `results_custom.*`,
  `effective_gene`, `gene_summary`) → **fail the test**.
- **Literature diffs** (`literature.clinical_summary`,
  `literature.functional_summary`, `parsed_data.clinical_publication_summary_plaintext`)
  → **reported on stdout, do not fail the test**.

If literature noise becomes annoying, move the `LITERATURE_PATHS` patterns
in `_diff.py` into `DEFAULT_IGNORE_PATHS` and re-baseline.

## Adding a new fixture

1. Run the variant in the workbench, review the output, confirm it's correct.
2. Find the `entries.id` (workbench → batch → entry detail page).
3. Add a row to `FIXTURE_SPECS` in `_export.py`:

   ```python
   ("MYGENE_c.123A_T", 142),
   ```

4. `python -m tests.regression._export MYGENE_c.123A_T`
5. Commit the fixture+baseline JSONs.
6. Re-run the regression suite to confirm the new fixture passes.

## When the regression test fails

1. Read the captured stdout for the list of changed paths.
2. For each `[value_changed]` row, decide: is this an intended behavior
   change for the current refactor, or a regression?
3. If it's a regression: revert the offending change.
4. If it's intended (and reviewed by the curator): re-baseline that
   fixture only, with a commit message explaining what changed and why.

   ```bash
   WORKBENCH_RUN_ENGINE_TESTS=1 WORKBENCH_REGRESSION_REBASELINE=1 \
       pytest tests/test_classifier_regression.py::test_engine_output_matches_baseline -k DDX39B -v
   ```

## Current roster

| Name                  | Why it's a fixture                                          |
|-----------------------|-------------------------------------------------------------|
| `DDX39B_c.212-8A_G`   | Junction-proximal cryptic acceptor — user-confirmed gold    |
| `NLRP3_c.2798G_T`     | Exon-internal cryptic donor on the minus strand             |
| `AMT_c.878-1G_A`      | Canonical acceptor, in-frame whole-exon skip                |
| `NEB_c.21522+3A_T`    | Donor region, in-frame skip with P/LP variants in the deleted exon |

Each one exercises a different splice mechanism that the Gate 2
consolidation needs to preserve.
