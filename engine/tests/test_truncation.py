"""Unit tests for vc_engine.truncation — 10% rule and PTC formalization."""
import pytest

from vc_engine.truncation import (
    TRUNC_SEVERE_THRESHOLD,
    c_terminal_loss_fraction,
    ensure_truncation_fraction_from_stop,
    formalize_frameshift_ptc,
    formalize_nonsense_ptc,
    frameshift_product_length,
    frameshift_ter_index,
    is_long_3prime_extension,
    is_marginal_loss,
    is_severe_loss,
    is_short_3prime_extension,
    n_terminal_loss_fraction,
    parse_nonsense_stop_aa_from_hgvs,
    sync_truncation_fraction_from_ptc,
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
        # DOCK4 p.Q1974Vfs*19: Ter = 1974+19-1 = 1992, product = 1991, WT = 1975.
        # (1991-1975)/1975, not 1993/1975 (that counted the stop codon).
        ter = frameshift_ter_index(1974, 19)
        assert ter == 1992
        assert frameshift_product_length(ter) == 1991
        frac = c_terminal_loss_fraction(ter, 1975)
        expect = -((1991 - 1975) / 1975.0)
        assert frac < 0
        assert abs(frac - expect) < 1e-9
        assert abs(frac - (1.0 - 1993 / 1975.0)) > 1e-4

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
        formalize_frameshift_ptc(pd, 1974, frameshift_ter_index(1974, 19), 1975)
        assert pd["protein_start"] == 1974
        assert pd["novel_stop_aa"] == 1992
        assert pd["protein_product_length"] == 1991
        assert pd["downstream_aas"] == 18
        assert pd["protein_extension"] is True
        assert pd["nmd_escape_truncation_fraction"] < 0
        expl = pd["protein_extension_explanation"]
        assert "extends the protein" in expl
        assert "elongated ORF with a novel C-terminus" in expl
        assert "not a shorter truncation" in expl
        assert "<10%" not in expl and "≥10%" not in expl

    def test_twist1_extension_excludes_stop_codon(self):
        """TWIST1 p.His180MetfsTer54, WT 202 → Ter 233, product 232, +14.9%."""
        assert frameshift_ter_index(180, 54) == 233
        assert frameshift_product_length(233) == 232
        frac = c_terminal_loss_fraction(233, 202)
        assert abs(frac - (-(30 / 202.0))) < 1e-12
        assert round(abs(frac) * 100, 1) == 14.9
        assert abs(abs(frac) - (233 / 202.0)) > 0.001
        pd = {
            "consequence": "frameshift",
            "hgvs_p": "p.His180MetfsTer54",
            "protein_length": 202,
            "nmd_decision_basis": (
                "PTC in the last coding exon (2 of 2); no downstream exon-exon "
                "junction remains — predicted to escape NMD."
            ),
        }
        formalize_frameshift_ptc(pd, 180, 233, 202)
        assert pd["novel_stop_aa"] == 233
        assert pd["protein_product_length"] == 232
        assert round(abs(pd["nmd_escape_truncation_fraction"]) * 100, 1) == 14.9
        expl = pd["nmd_math"]
        assert "extends the protein by 14.9%" in expl
        assert "232 vs 202" in expl
        assert "novel stop at aa 233 vs 202-aa reference" in expl
        assert "elongated ORF with a novel C-terminus (not a shorter truncation)" in expl
        assert "escape NMD" in expl
        assert "truncated protein" not in expl.lower()
        assert "<10%" not in expl and "≥10%" not in expl
        sync_truncation_fraction_from_ptc(pd)
        assert round(abs(pd["nmd_escape_truncation_fraction"]) * 100, 1) == 14.9
        assert "extends the protein by 14.9%" in pd["nmd_math"]


def test_cacna1a_extension_ter_is_in_3utr_not_on_coding_exon():
    """CACNA1A c.7317del p.V2440Yfs*168: Stop at the last CDS end, Ter in the 3′ UTR."""
    from vc_engine.splice import _build_splice_viz_payload, frameshift_utr_extension_geometry

    geo = frameshift_utr_extension_geometry(2607, 2506)
    assert geo["utr_nt"] == (2607 - 2506 - 1) * 3 == 300
    assert 0.08 < geo["ter_fraction_in_utr"] < 0.92
    pd = {
        "consequence": "frameshift",
        "gene_symbol": "CACNA1A",
        "hgvs_p": "p.V2440Yfs*168",
        "c_dot": "c.7317del",
        "variant_exon": 40,
        "protein_length": 2506,
        "novel_stop_aa": 2607,
        "coding_exons_source": "refseq_gff",
        "coding_exons": [
            {"anatomical_rank": 40, "start_cds": 6901, "end_cds": 7100, "length_bp": 200},
            {"anatomical_rank": 47, "start_cds": 7300, "end_cds": 7518, "length_bp": 219},
        ],
    }
    viz = _build_splice_viz_payload(pd)
    layer = viz["ptc_markers"]["reference"]
    assert layer["utr_extension"] is True
    assert layer["native_stop_at_cds_end"] is True
    assert layer["exon_rank"] == 47
    assert "fraction_in_exon" not in layer
    assert layer["wt_protein_length"] == 2506
    assert layer["ptc_aa_position"] == 2607
    assert layer["utr_nt"] == 300
    assert viz["reference_ptc_location_kind"] == "utr_extension"
    cap = viz["reference_ptc_location_label"]
    assert "3′ UTR (past native stop on exon 47)" in cap
    assert "native stop after aa 2506" in cap
    assert "novel Ter at aa 2607" in cap
    assert "~300 nt into 3′ UTR" in cap
    legend = viz["reference_ptc_location_detail"]
    assert "Stop = WT terminus" in legend
    assert "dashed 3′ UTR = read-through" in legend
    assert "Ter = novel stop (protein extension)" in legend
    ranks = [e["rank"] for e in viz["focus_primary"]["exons"]]
    assert 47 in ranks
    # A stop inside the protein stays on the coding exon.
    inside = dict(pd)
    inside["novel_stop_aa"] = 100
    inside["variant_exon"] = 40
    inside["coding_exons"] = [
        {"anatomical_rank": 2, "start_cds": 1, "end_cds": 900, "length_bp": 900},
    ]
    inside["variant_exon"] = 2
    viz_in = _build_splice_viz_payload(inside)
    layer_in = viz_in["ptc_markers"]["reference"]
    assert not layer_in.get("utr_extension")
    assert layer_in.get("fraction_in_exon") is not None
    assert layer_in["fraction_in_exon"] < 0.97

def test_parse_hgvs_nonsense():
    assert parse_nonsense_stop_aa_from_hgvs("p.S1050*") == 1050
    assert parse_nonsense_stop_aa_from_hgvs("p.Ser1050Ter") == 1050

def test_ensure_backfill_from_hgvs_only():
    pd = {
        "consequence": "nonsense",
        "hgvs_p": "p.S1050*",
        "protein_length": 1214,
        "nmd_escape_truncation_fraction": 0.0,
    }
    ensure_truncation_fraction_from_stop(pd)
    assert pd["novel_stop_aa"] == 1050
    assert pd["nmd_escape_truncation_fraction"] > 0

def test_tubb1_last_exon_nonsense_escapes_nmd():
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

def test_internal_exon_ptc_triggers_nmd():
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

def test_sync_fraction_uses_onset_plus_shift():
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

def test_sync_splice_oof_ptc_from_sidecar_fields():
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

def test_sync_clears_stale_missense_truncation():
    from vc_engine.truncation import sync_truncation_fraction_from_ptc

    pd = {
        "consequence": "missense",
        "protein_start": 116,
        "protein_length": 1464,
        "nmd_escape_truncation_fraction": 0.921,
    }
    assert sync_truncation_fraction_from_ptc(pd) == 0.0
    assert pd["nmd_escape_truncation_fraction"] == 0.0

def test_sync_start_loss_uses_n_terminal_not_c_terminal():
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

def test_resolved_ptc_prefers_onset_plus_shift():
    from vc_engine.truncation import resolved_ptc_stop_aa

    pd = {
        "protein_start": 714,
        "downstream_aas": 5,
        "novel_stop_aa": 714,
    }
    assert resolved_ptc_stop_aa(pd) == 719

def test_resolved_ptc_ignores_missense_protein_start():
    from vc_engine.truncation import resolved_ptc_stop_aa

    pd = {
        "consequence": "missense",
        "protein_start": 116,
        "protein_length": 1464,
    }
    assert resolved_ptc_stop_aa(pd) == 0


def test_stop_lost_ext_n_uses_onset_plus_n():
    """p.*278Cext*5 on a 277-aa protein: Ter = 278+5, product = Ter-1."""
    from vc_engine.truncation import (
        apply_stop_lost_extension,
        frameshift_product_length,
        protein_extension_fraction,
        stop_lost_ter_index,
    )

    assert stop_lost_ter_index(278, 5) == 283
    ter = 283
    plen = 277
    product = frameshift_product_length(ter)
    assert product == 282
    frac = protein_extension_fraction(ter, plen)
    assert abs(frac - (-(282 - 277) / 277.0)) < 1e-12
    pd = {
        "consequence": "stop_lost",
        "hgvs_p": "p.*278Cext*5",
        "c_dot": "c.834A>T",
        "protein_length": plen,
    }
    apply_stop_lost_extension(pd)
    assert pd["novel_stop_aa"] == 283
    assert pd["protein_product_length"] == 282
    assert abs(pd["nmd_escape_truncation_fraction"] - frac) < 1e-12
    expl = pd["protein_extension_explanation"]
    assert expl.startswith("Stop-lost read-through past the native terminus — extends the protein")
    assert "extends the protein by" in expl
    assert "282 vs 277" in expl
    assert "novel stop at aa 283 vs 277-aa reference" in expl
    assert "truncated" not in expl.lower()
    assert "<10%" not in expl and "≥10%" not in expl
    assert "Frameshift stop" not in expl
    sync_truncation_fraction_from_ptc(pd)
    assert abs(pd["nmd_escape_truncation_fraction"] - frac) < 1e-12
    assert "Stop-lost read-through" in pd["nmd_math"]


def test_stop_lost_readthrough_scan_sets_novel_stop():
    """Mutate the native TGA and scan the appended 3′ UTR for the next stop."""
    from vc_engine.truncation import apply_stop_lost_extension, stop_lost_ter_from_readthrough

    cds = "ATG" + ("GCT" * 276) + "TGA"
    assert len(cds) == 834
    assert cds[-3:] == "TGA"
    utr = "AAACCCTAA"
    assert stop_lost_ter_from_readthrough(cds, utr, 834, "T") == 281
    pd = {
        "consequence": "stop_lost",
        "hgvs_p": "p.*278Cext*?",
        "c_dot": "c.834A>T",
        "protein_length": 277,
    }
    apply_stop_lost_extension(pd, cds=cds, utr=utr)
    assert pd["novel_stop_aa"] == 281
    assert pd["protein_product_length"] == 280
    assert abs(pd["nmd_escape_truncation_fraction"] - (-(280 - 277) / 277.0)) < 1e-12
    expl = pd["nmd_math"]
    assert "Stop-lost read-through past the native terminus — extends the protein" in expl
    assert "truncated" not in expl.lower()
    assert "<10%" not in expl and "≥10%" not in expl


def test_plp1_stop_lost_map_shows_utr_when_ter_unknown():
    """PLP1 c.834A>T p.*278Cext*? still draws Stop + 3′ UTR + Ter? without a transcript id."""
    from vc_engine.splice import _build_splice_viz_payload
    from vc_engine.truncation import apply_stop_lost_extension

    pd = {
        "consequence": "stop_lost",
        "gene_symbol": "PLP1",
        "hgvs_p": "p.*278Cext*?",
        "c_dot": "c.834A>T",
        "protein_length": 277,
        "variant_exon": 7,
        "coding_exons_source": "refseq_gff",
        "coding_exons": [
            {"anatomical_rank": 6, "start_cds": 600, "end_cds": 750, "length_bp": 151},
            {"anatomical_rank": 7, "start_cds": 751, "end_cds": 834, "length_bp": 84},
        ],
    }
    apply_stop_lost_extension(pd)
    assert pd["stop_lost_ter_unknown"] is True
    assert pd["protein_extension"] is True
    assert "novel_stop_aa" not in pd
    assert "Stop-lost read-through past the native terminus — extends the protein" in pd["nmd_math"]
    assert "truncated" not in pd["nmd_math"].lower()
    viz = _build_splice_viz_payload(pd)
    layer = viz["ptc_markers"]["reference"]
    assert layer["utr_extension"] is True
    assert layer["ter_unknown"] is True
    assert layer["native_stop_at_cds_end"] is True
    assert layer["exon_rank"] == 7
    assert "fraction_in_exon" not in layer
    assert "ptc_aa_position" not in layer
    assert layer["wt_protein_length"] == 277
    cap = viz["reference_ptc_location_label"]
    assert "3′ UTR (past native stop on exon 7)" in cap
    assert "native stop after aa 277" in cap
    assert "novel Ter? (length not resolved)" in cap
    assert "Stop = WT terminus" in viz["reference_ptc_location_detail"]
    assert 7 in [e["rank"] for e in viz["focus_primary"]["exons"]]


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
