"""OOF whole-exon skip must surface NMD + % even when CDS PTC lookup fails."""
from __future__ import annotations

from vc_engine.splice import (
    _ensure_protein_length_from_coding_exons,
    _mark_oof_exon_skip_nmd_provisional,
)


def test_protein_length_backfill_ignores_explicit_zero():
    pd = {
        "protein_length": 0,
        "coding_exons": [
            {"end_cds": 385},
            {"end_cds": 2253},  # MMUT-like CDS incl. stop
        ],
    }
    assert _ensure_protein_length_from_coding_exons(pd) == 750
    assert pd["protein_length"] == 750


def test_oof_provisional_sets_nmd_and_exon_percent():
    pd = {"protein_length": 750}
    _mark_oof_exon_skip_nmd_provisional(pd, aa_lost=38, ptc_unresolved=True)
    assert pd["is_splice_frameshift"] is True
    assert pd["splice_is_in_frame"] is False
    assert pd["nmd_escape"] is False
    assert "NMD" in (pd.get("nmd_decision_basis") or "")
    assert abs(pd["nmd_escape_truncation_fraction"] - (38 / 750)) < 1e-9
    assert abs(pd["splice_fraction_lost"] - (38 / 750)) < 1e-9


def test_oof_provisional_does_not_clobber_resolved_ptc_fraction():
    pd = {
        "protein_length": 750,
        "exon_skip_oof_ptc_aa": 530,
        "nmd_escape_truncation_fraction": 0.29,
    }
    _mark_oof_exon_skip_nmd_provisional(pd, aa_lost=38, ptc_unresolved=False)
    assert abs(pd["nmd_escape_truncation_fraction"] - 0.29) < 1e-9
