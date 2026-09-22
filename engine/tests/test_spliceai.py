"""Unit tests for vc_engine.spliceai (EMG SpliceAI ingest / snapshot / apply policy).

Fast and dependency-free (no engine load, no network). Locks in the Broad-vs-EMG
source-of-truth behavior extracted in Phase 3 step 4.
"""
from vc_engine.spliceai import (
    _parse_spliceai_dp,
    _pick_spliceai_score_row,
    _emg_spliceai_ds_snapshot,
    _emg_spliceai_dp_snapshot,
    _emg_spliceai_complete_snapshot,
    _apply_emg_spliceai_complete,
    _apply_emg_spliceai_ds_only,
    _apply_emg_spliceai_if_broad_unavailable,
    _ingest_spliceai_broad_json,
    _refresh_spliceai_in_silico_source,
)


def test_parse_spliceai_dp():
    assert _parse_spliceai_dp("12") == 12
    assert _parse_spliceai_dp("12.6") == 13
    assert _parse_spliceai_dp(-5) == -5
    assert _parse_spliceai_dp(None) is None
    assert _parse_spliceai_dp("") is None
    assert _parse_spliceai_dp("nope") is None


def test_pick_spliceai_score_row_prefers_nm_match():
    rows = [
        {"t_refseq_ids": ["NM_000999.3"], "g_name": "B"},
        {"t_refseq_ids": ["NM_017799.4"], "g_name": "A"},
    ]
    assert _pick_spliceai_score_row(rows, target_nm_base="NM_017799") is rows[1]
    # MANE select fallback when no NM match
    mane = [{"t_priority": "MS", "g_name": "X"}, {"g_name": "Y"}]
    assert _pick_spliceai_score_row(mane) is mane[0]
    assert _pick_spliceai_score_row([]) is None


def test_emg_ds_snapshot_requires_all_four():
    assert _emg_spliceai_ds_snapshot({"DS_AG": 0.9}) is None
    full = {"DS_AG": 0.9, "DS_AL": 0.1, "DS_DG": 0.0, "DS_DL": 0.2}
    assert _emg_spliceai_ds_snapshot(full) == {
        "ds_ag": 0.9,
        "ds_al": 0.1,
        "ds_dg": 0.0,
        "ds_dl": 0.2,
    }


def test_emg_dp_snapshot_thresholds():
    # >=2 needed for non-strict
    assert _emg_spliceai_dp_snapshot({"DP_AG": "10"}) is None
    snap = _emg_spliceai_dp_snapshot({"DP_AG": "10", "DP_AL": "-5"})
    assert snap == {"dp_ag": 10, "dp_al": -5}
    # require_all_four
    four = {"DP_AG": "1", "DP_AL": "2", "DP_DG": "3", "DP_DL": "4"}
    assert _emg_spliceai_dp_snapshot(four, require_all_four=True) == {
        "dp_ag": 1,
        "dp_al": 2,
        "dp_dg": 3,
        "dp_dl": 4,
    }
    assert _emg_spliceai_dp_snapshot({"DP_AG": "1"}, require_all_four=True) is None


def test_apply_emg_complete_skips_broad():
    pd = {}
    emg = {
        "DS_AG": 0.99, "DS_AL": 0.0, "DS_DG": 0.0, "DS_DL": 0.0,
        "DP_AG": "-2", "DP_AL": "5", "DP_DG": "10", "DP_DL": "-7",
    }
    assert _apply_emg_spliceai_complete(pd, emg) is True
    assert pd["spliceai_fetched"] is True
    assert pd["spliceai_from_emg"] is True
    assert pd["spliceai_emg_full_fallback"] is True
    assert pd["spliceai_ds_ag"] == 0.99
    assert pd["spliceai_dp_dl"] == -7
    assert pd["spliceai_in_silico_source"] == "emedgene"


def test_apply_emg_ds_only_leaves_broad_pending():
    pd = {}
    emg = {"DS_AG": 0.5, "DS_AL": 0.1, "DS_DG": 0.2, "DS_DL": 0.3}
    assert _apply_emg_spliceai_ds_only(pd, emg) is True
    # DS-only must NOT mark fetched (Broad still runs for Δbp)
    assert "spliceai_fetched" not in pd
    assert pd["spliceai_emg_ds_pending_broad_dp"] is True
    assert pd["spliceai_in_silico_source"] == "emedgene+broad"


def test_apply_emg_if_broad_unavailable_noop_when_fetched():
    pd = {"spliceai_fetched": True}
    emg = {"DS_AG": 0.5, "DS_AL": 0.1, "DS_DG": 0.2, "DS_DL": 0.3}
    assert _apply_emg_spliceai_if_broad_unavailable(pd, emg) is False


def test_ingest_broad_json_applies_scores():
    pd = {}
    sai = {
        "scores": [
            {
                "g_name": "AMT", "t_refseq_ids": ["NM_000481.4"],
                "DS_AG": 0.0, "DS_AL": 0.97, "DS_DG": 0.0, "DS_DL": 0.0,
                "DP_AG": "1", "DP_AL": "-2", "DP_DG": "3", "DP_DL": "4",
            }
        ]
    }
    assert _ingest_spliceai_broad_json(pd, sai, gene_symbol="AMT") is True
    assert pd["spliceai_ds_al"] == 0.97
    assert pd["spliceai_dp_al"] == "-2"
    assert pd["spliceai_fetched"] is True
    assert pd["spliceai_in_silico_source"] == "broad"


def test_ingest_broad_json_error_sets_message():
    pd = {}
    assert _ingest_spliceai_broad_json(pd, {"error": "oob"}) is False
    assert "splice_api_error" in pd


def test_refresh_source_clears_when_unknown():
    pd = {"spliceai_in_silico_source": "broad"}
    _refresh_spliceai_in_silico_source(pd)
    assert "spliceai_in_silico_source" not in pd
