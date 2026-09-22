"""Unit tests for vc_engine.truncation — 10% rule and PTC formalization."""
import pytest

from vc_engine.truncation import (
    TRUNC_SEVERE_THRESHOLD,
    c_terminal_loss_fraction,
    ensure_truncation_fraction_from_stop,
    formalize_frameshift_ptc,
    formalize_nonsense_ptc,
    is_long_3prime_extension,
    is_marginal_loss,
    is_severe_loss,
    is_short_3prime_extension,
    n_terminal_loss_fraction,
    parse_nonsense_stop_aa_from_hgvs,
    truncation_rule_label,
)


class TestCTerminalLoss:
    def test_zeb2_style_last_exon_nonsense(self):
        # ZEB2 c.3149C>A p.S1050* on 1214-aa protein
        frac = c_terminal_loss_fraction(1050, 1214)
        assert abs(frac - (164 / 1214.0)) < 1e-6
        assert is_severe_loss(frac)
        assert not is_marginal_loss(frac)
        assert truncation_rule_label(frac) == "≥10% rule"

    def test_exactly_ten_percent_is_marginal(self):
        frac = c_terminal_loss_fraction(900, 1000)
        assert abs(frac - 0.10) < 1e-9
        assert is_marginal_loss(frac)
        assert not is_severe_loss(frac)
        assert truncation_rule_label(frac) == "<10% rule"

    def test_just_above_ten_percent_is_severe(self):
        frac = c_terminal_loss_fraction(899, 1000)
        assert is_severe_loss(frac)

    def test_invalid_inputs(self):
        assert c_terminal_loss_fraction(0, 100) == 0.0
        assert c_terminal_loss_fraction(50, 0) == 0.0

    def test_stop_past_native_terminus_is_negative_extension(self):
        # DOCK4-style: p.Q1974Vfs*19 on 1975-aa protein → stop at 1993
        frac = c_terminal_loss_fraction(1993, 1975)
        assert frac < 0
        assert abs(frac - (1.0 - 1993 / 1975.0)) < 1e-9
        assert is_short_3prime_extension(frac)

    def test_missing_length_coerced_to_one_does_not_invent_extension(self):
        # NOTCH1 c.1651_1654dup regression: stop~571 with plen=1 must not yield −570
        assert c_terminal_loss_fraction(571, 1) == 0.0
        pd = {}
        formalize_frameshift_ptc(pd, 552, 571, 1)
        assert pd.get("novel_stop_aa") == 571
        assert float(pd.get("nmd_escape_truncation_fraction") or 0) == 0.0
        # Real NOTCH1 length → severe truncation, not extension
        formalize_frameshift_ptc(pd, 552, 571, 2555)
        frac = pd["nmd_escape_truncation_fraction"]
        assert frac > 0.7
        assert not is_long_3prime_extension(frac)


class TestNTerminalLoss:
    def test_start_loss_next_met(self):
        frac = n_terminal_loss_fraction(50, 500)
        assert abs(frac - 49 / 500.0) < 1e-6

    def test_start_loss_escape_boundary(self):
        # 9.8% N-terminal loss — re-init viable (<10% strict escape in analyze)
        frac = n_terminal_loss_fraction(50, 500)  # 49/500 = 9.8%
        assert frac < TRUNC_SEVERE_THRESHOLD


class TestExtensionFractions:
    def test_short_3prime_extension(self):
        assert is_short_3prime_extension(-0.05)
        assert not is_short_3prime_extension(-0.15)

    def test_long_3prime_extension(self):
        assert is_long_3prime_extension(-0.10)
        assert is_long_3prime_extension(-0.15)


class TestFormalizePtc:
    def test_nonsense_sets_stop_fields(self):
        pd = {}
        formalize_nonsense_ptc(pd, 1050, 1214)
        assert pd["protein_start"] == 1050
        assert pd["novel_stop_aa"] == 1050
        assert abs(pd["nmd_escape_truncation_fraction"] - (1 - 1050 / 1214.0)) < 1e-6

    def test_frameshift_onset_and_stop(self):
        pd = {}
        formalize_frameshift_ptc(pd, 1756, 1830, 1863)
        assert pd["protein_start"] == 1756
        assert pd["novel_stop_aa"] == 1830
        assert pd["downstream_aas"] == 74
        assert abs(pd["nmd_escape_truncation_fraction"] - (1 - 1830 / 1863.0)) < 1e-4

    def test_frameshift_3prime_extension_not_clamped(self):
        pd = {}
        formalize_frameshift_ptc(pd, 1974, 1993, 1975)
        assert pd["protein_start"] == 1974
        assert pd["novel_stop_aa"] == 1993
        assert pd["downstream_aas"] == 19
        assert pd["nmd_escape_truncation_fraction"] < 0
        assert is_short_3prime_extension(pd["nmd_escape_truncation_fraction"])

    def test_parse_hgvs_nonsense(self):
        assert parse_nonsense_stop_aa_from_hgvs("p.S1050*") == 1050
        assert parse_nonsense_stop_aa_from_hgvs("p.Ser1050Ter") == 1050

    def test_ensure_backfill_from_hgvs_only(self):
        pd = {
            "consequence": "nonsense",
            "hgvs_p": "p.S1050*",
            "protein_length": 1214,
            "nmd_escape_truncation_fraction": 0.0,
        }
        ensure_truncation_fraction_from_stop(pd)
        assert pd["novel_stop_aa"] == 1050
        assert pd["nmd_escape_truncation_fraction"] > 0

    def test_tubb1_last_exon_nonsense_escapes_nmd(self):
        """TUBB1 c.958A>T p.K320*: PTC in last coding exon → escape + ~29% loss."""
        from vc_engine.truncation import apply_nmd_escape_from_coding_exons

        # ENST00000217133 coding map (CDS indices)
        coding = [
            {"start_cds": 1, "end_cds": 57, "anatomical_rank": 1},
            {"start_cds": 58, "end_cds": 166, "anatomical_rank": 2},
            {"start_cds": 167, "end_cds": 277, "anatomical_rank": 3},
            {"start_cds": 278, "end_cds": 1356, "anatomical_rank": 4},
        ]
        pd = {
            "consequence": "nonsense",
            "hgvs_p": "p.K320*",
            "protein_length": 451,
            "coding_exons": coding,
            "nmd_escape_truncation_fraction": 0.0,
        }
        assert apply_nmd_escape_from_coding_exons(pd, 958) is True
        assert pd["nmd_escape"] is True
        assert "last coding exon" in (pd.get("nmd_decision_basis") or "")
        ensure_truncation_fraction_from_stop(pd)
        assert pd["novel_stop_aa"] == 320
        assert abs(pd["nmd_escape_truncation_fraction"] - (1 - 320 / 451.0)) < 1e-4
        assert is_severe_loss(pd["nmd_escape_truncation_fraction"])

    def test_internal_exon_ptc_triggers_nmd(self):
        from vc_engine.truncation import apply_nmd_escape_from_coding_exons

        coding = [
            {"start_cds": 1, "end_cds": 300, "anatomical_rank": 1},
            {"start_cds": 301, "end_cds": 600, "anatomical_rank": 2},
            {"start_cds": 601, "end_cds": 900, "anatomical_rank": 3},
        ]
        pd = {"coding_exons": coding}
        assert apply_nmd_escape_from_coding_exons(pd, 150) is True
        assert pd["nmd_escape"] is False
        assert "upstream of the penultimate" in (pd.get("nmd_decision_basis") or "")

    def test_sync_fraction_uses_onset_plus_shift(self):
        from vc_engine.truncation import sync_truncation_fraction_from_ptc

        pd = {
            "consequence": "frameshift",
            "protein_length": 1020,
            "protein_start": 714,
            "novel_stop_aa": 719,
            "downstream_aas": 5,
            "nmd_escape_truncation_fraction": 0.30,
        }
        frac = sync_truncation_fraction_from_ptc(pd)
        assert abs(frac - (1 - 719 / 1020.0)) < 1e-4
        assert abs(pd["nmd_escape_truncation_fraction"] - frac) < 1e-4

    def test_sync_splice_oof_ptc_from_sidecar_fields(self):
        from vc_engine.truncation import sync_truncation_fraction_from_ptc

        pd = {
            "consequence": "splice_acceptor_variant",
            "protein_length": 428,
            "protein_start": 71,
            "downstream_aas": 5,
            "exon_skip_oof_ptc_aa": 76,
            "is_splice_frameshift": True,
            "splice_is_in_frame": False,
            "nmd_escape_truncation_fraction": 0.79,
        }
        frac = sync_truncation_fraction_from_ptc(pd)
        assert abs(frac - (1 - 76 / 428.0)) < 1e-4

    def test_sync_clears_stale_missense_truncation(self):
        from vc_engine.truncation import sync_truncation_fraction_from_ptc

        pd = {
            "consequence": "missense",
            "protein_start": 116,
            "protein_length": 1464,
            "nmd_escape_truncation_fraction": 0.921,
        }
        assert sync_truncation_fraction_from_ptc(pd) == 0.0
        assert pd["nmd_escape_truncation_fraction"] == 0.0

    def test_sync_start_loss_uses_n_terminal_not_c_terminal(self):
        """GNAS-style: next Met at 60/394 → ~15%, not protein_start=1 → ~99% C-term."""
        from vc_engine.truncation import (
            resolved_ptc_stop_aa,
            start_loss_fraction_from_next_met,
            sync_truncation_fraction_from_ptc,
        )

        pd = {
            "consequence": "start_lost",
            "protein_start": 1,
            "protein_length": 394,
            "next_methionine_position": 60,
            # Stale wrong value from an earlier C-term sync
            "nmd_escape_truncation_fraction": 0.997,
        }
        assert resolved_ptc_stop_aa(pd) == 0
        frac = sync_truncation_fraction_from_ptc(pd)
        expect = start_loss_fraction_from_next_met(60, 394)
        assert abs(frac - expect) < 1e-9
        assert abs(pd["nmd_escape_truncation_fraction"] - expect) < 1e-9
        assert frac < 0.2  # not the bogus ~99% C-terminal figure

    def test_resolved_ptc_prefers_onset_plus_shift(self):
        from vc_engine.truncation import resolved_ptc_stop_aa

        pd = {
            "protein_start": 714,
            "downstream_aas": 5,
            "novel_stop_aa": 714,
        }
        assert resolved_ptc_stop_aa(pd) == 719

    def test_resolved_ptc_ignores_missense_protein_start(self):
        from vc_engine.truncation import resolved_ptc_stop_aa

        pd = {
            "consequence": "missense",
            "protein_start": 116,
            "protein_length": 1464,
        }
        assert resolved_ptc_stop_aa(pd) == 0


@pytest.mark.parametrize(
    "fraction, marginal, severe, label",
    [
        (0.0, False, False, None),
        (0.05, True, False, "<10% rule"),
        (0.10, True, False, "<10% rule"),
        (0.1000001, False, True, "≥10% rule"),
        (0.135, False, True, "≥10% rule"),
    ],
)
def test_ten_percent_boundary_matrix(fraction, marginal, severe, label):
    assert is_marginal_loss(fraction) is marginal
    assert is_severe_loss(fraction) is severe
    assert truncation_rule_label(fraction) == label
