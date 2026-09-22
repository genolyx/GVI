"""Unit tests for the extracted scoring module (vc_engine.scoring).

These are fast and dependency-free (no engine load, no network). They lock in
the optional institutional score-to-label helper and ACMG rules.
"""
import pytest

from vc_engine.scoring import classify_score, apply_rubric, apply_acmg, combine_acmg_criteria
from vc_engine.clinvar import clinvar_portal_url


@pytest.mark.parametrize(
    "total,label",
    [
        (6.0, "Pathogenic (P)"),
        (5.0, "Pathogenic (P)"),
        (4.5, "Likely Pathogenic (LP)"),
        (3.0, "Likely Pathogenic (LP)"),
        (2.5, "VUS Pathogenic (VUSP)"),
        (0.5, "VUS Pathogenic (VUSP)"),
        (0.0, "VUS"),
        (-0.5, "VUS Benign (VUSB)"),
        (-2.5, "VUS Benign (VUSB)"),
        (-3.0, "Likely Benign (LB)"),
        (-4.5, "Likely Benign (LB)"),
        (-5.0, "Benign (B)"),
    ],
)
def test_classify_score_boundaries(total, label):
    assert classify_score(total)["label"] == label


def test_classify_score_class_buckets():
    assert classify_score(5.0)["class"] == "pathogenic"
    assert classify_score(0.0)["class"] == "vus"
    assert classify_score(-5.0)["class"] == "benign"


def test_apply_rubric_disabled_by_default():
    out = apply_rubric({"consequence": "missense", "c_dot": "c.1A>G"})
    assert out["enabled"] is False
    assert out["total"] is None
    assert out["breakdown"] == []
    assert out["classification"] is None


def test_apply_rubric_custom_hook(monkeypatch):
    import sys
    import types

    mod = types.ModuleType("inst_score_test_mod")

    def score(_variant_data, splice_points=None, nmd_points=None):
        return {
            "total": 1.0,
            "breakdown": [{"reason": "lab rule", "points": 1.0}],
        }

    mod.score = score
    sys.modules["inst_score_test_mod"] = mod
    monkeypatch.setenv("VC_INSTITUTIONAL_SCORING", "inst_score_test_mod:score")
    out = apply_rubric({"consequence": "missense", "c_dot": "c.1A>G"})
    assert out["enabled"] is True
    assert out["total"] == 1.0
    assert out["classification"]["label"] == "VUS Pathogenic (VUSP)"


def test_apply_acmg_ba1_high_af():
    out = apply_acmg({"consequence": "missense", "gnomad_af": 0.06})
    codes = {c["code"] for c in out["criteria"]}
    assert "BA1" in codes
    assert out["classification"]["label"] == "Benign"


def test_apply_acmg_pm2_rare():
    out = apply_acmg({"consequence": "missense", "gnomad_af": 0.00005})
    codes = {c["code"] for c in out["criteria"]}
    assert "PM2" in codes


def test_apply_acmg_pvs1_null_lof_gene():
    out = apply_acmg({"consequence": "nonsense", "disease_mechanism": "LOF"})
    codes = {c["code"] for c in out["criteria"]}
    assert "PVS1" in codes


def test_apply_acmg_no_pvs1_for_gof():
    out = apply_acmg({"consequence": "nonsense", "disease_mechanism": "GOF"})
    codes = {c["code"] for c in out["criteria"]}
    assert "PVS1" not in codes


def test_apply_acmg_pvs1_alone_is_vus():
    out = apply_acmg({"consequence": "nonsense", "disease_mechanism": "LOF"})
    assert {c["code"] for c in out["criteria"]} == {"PVS1"}
    assert out["classification"]["label"] == "VUS"


def test_apply_acmg_pvs1_pm2_is_likely_pathogenic():
    out = apply_acmg({"consequence": "nonsense", "disease_mechanism": "LOF", "gnomad_af": 0})
    codes = {c["code"] for c in out["criteria"]}
    assert codes == {"PVS1", "PM2"}
    assert out["classification"]["label"] == "Likely Pathogenic"


def test_apply_acmg_no_pm2_when_af_missing():
    out = apply_acmg({"consequence": "missense"})
    assert "PM2" not in {c["code"] for c in out["criteria"]}


def test_apply_acmg_ba1_at_five_percent():
    out = apply_acmg({"consequence": "missense", "gnomad_af": 0.05})
    assert "BA1" in {c["code"] for c in out["criteria"]}
    assert out["classification"]["label"] == "Benign"


def test_apply_acmg_ps1_requires_identical_protein_change():
    out = apply_acmg({
        "consequence": "missense",
        "alternate_alleles": [{"vid": "1", "hgvs_c": "c.100A>C"}],
    })
    assert "PS1" not in {c["code"] for c in out["criteria"]}
    out = apply_acmg({"consequence": "missense", "identical_pathogenic": True})
    assert "PS1" in {c["code"] for c in out["criteria"]}


def test_apply_acmg_no_bp4_from_spliceai_on_nonsense():
    out = apply_acmg({
        "consequence": "nonsense",
        "disease_mechanism": "LOF",
        "spliceai_ds_ag": 0.05,
    })
    assert "BP4" not in {c["code"] for c in out["criteria"]}


def test_apply_acmg_no_pp3_stacked_with_pvs1():
    out = apply_acmg({
        "consequence": "splice_donor_variant",
        "disease_mechanism": "LOF",
        "splice_is_in_frame": False,
        "spliceai_ds_dl": 0.9,
    })
    codes = {c["code"] for c in out["criteria"]}
    assert "PVS1" in codes
    assert "PP3" not in codes


def test_apply_acmg_pvs1_from_clingen_hi_when_mechanism_unknown():
    out = apply_acmg({
        "consequence": "nonsense",
        "disease_mechanism": "Unknown",
        "clingen_haplo_score": "3",
    })
    assert "PVS1" in {c["code"] for c in out["criteria"]}


def test_apply_acmg_no_pvs1_clingen_hi_30():
    out = apply_acmg({
        "consequence": "nonsense",
        "disease_mechanism": "Unknown",
        "clingen_haplo_score": "30",
    })
    assert "PVS1" not in {c["code"] for c in out["criteria"]}


def test_apply_acmg_inframe_splice_with_plp_is_pvs1_strong():
    out = apply_acmg({
        "consequence": "splice_acceptor_variant",
        "disease_mechanism": "LOF",
        "splice_is_in_frame": True,
        "splice_fraction_lost": 0.04,
        "has_pathogenic_in_deleted_exon": True,
    })
    codes = {c["code"] for c in out["criteria"]}
    assert "PVS1_Strong" in codes
    assert "PVS1" not in codes


def test_combine_acmg_two_moderate_two_supporting_is_lp():
    criteria = [
        {"type": "pathogenic", "weight": "moderate"},
        {"type": "pathogenic", "weight": "moderate"},
        {"type": "pathogenic", "weight": "supporting"},
        {"type": "pathogenic", "weight": "supporting"},
    ]
    assert combine_acmg_criteria(criteria)["label"] == "Likely Pathogenic"


def test_combine_acmg_one_moderate_four_supporting_is_lp():
    criteria = [{"type": "pathogenic", "weight": "moderate"}] + [
        {"type": "pathogenic", "weight": "supporting"}
    ] * 4
    assert combine_acmg_criteria(criteria)["label"] == "Likely Pathogenic"


def test_combine_acmg_pvs1_two_supporting_is_pathogenic():
    criteria = [
        {"type": "pathogenic", "weight": "very_strong"},
        {"type": "pathogenic", "weight": "supporting"},
        {"type": "pathogenic", "weight": "supporting"},
    ]
    assert combine_acmg_criteria(criteria)["label"] == "Pathogenic"


def test_apply_acmg_tp53_hotspot_is_likely_pathogenic():
    """Classic TP53 p.Arg175His-like evidence the auto-scorer previously left as VUS/PM5."""
    out = apply_acmg({
        "consequence": "missense",
        "pm5_local_alleles": [{"hgvs_c": "c.523C>G", "hgvs_p": "p.Arg175Gly"}],
        "regional_hotspot": [
            {"hgvs_c": "c.535C>A", "significance": "Likely pathogenic"},
            {"hgvs_c": "c.536A>G", "significance": "Likely pathogenic"},
        ],
        "cadd_phred": 25.1,
        "metadome_intolerant": True,
        "gnomad_checked": True,
    })
    codes = {c["code"] for c in out["criteria"]}
    assert {"PM1", "PM5", "PM2", "PP3"} <= codes
    assert out["classification"]["label"] == "Likely Pathogenic"


def test_apply_acmg_no_pm1_without_hotspot():
    out = apply_acmg({"consequence": "missense", "cadd_phred": 28})
    assert "PM1" not in {c["code"] for c in out["criteria"]}


def test_clinvar_portal_url_numeric_vs_accession():
    assert clinvar_portal_url("12345").endswith("/variation/12345/")
    assert clinvar_portal_url("RCV000123").endswith("/clinvar/RCV000123/")
    assert clinvar_portal_url("") == ""
