"""Variant scoring / classification.

ACMG/AMP criteria live in ``apply_acmg``. Institutional numeric scoring is
optional and off by default — there is no built-in lab rubric.

To supply an institutional score, set ``VC_INSTITUTIONAL_SCORING`` to
``package.module:function``. The function should accept
``(variant_data, splice_points=None, nmd_points=None)`` and return a dict with
``total``, ``breakdown`` (list of ``{reason, points}``), and optional
``classification`` (``{label, class}``). ``classify_score`` is a helper if the
hook uses a numeric total.
"""
from __future__ import annotations

import importlib
import os

from vc_engine.truncation import is_severe_loss

# Empty placeholder so older imports keep working. Labs can replace this in a
# custom scoring module if they still use a pedigree/phenotype matrix.
clMatrixDef = {
    "rows": [],
    "cols": [],
    "matrix": [],
}


def classify_score(total):
    """Map a numeric institutional total to a classification label.

    Used only when an institution plugs in their own rubric. Default analysis
    does not apply these thresholds.
    """
    if total is None:
        return None
    if total >= 5.0:
        return {"label": "Pathogenic (P)", "class": "pathogenic"}
    if total >= 3.0 and total <= 4.5:
        return {"label": "Likely Pathogenic (LP)", "class": "pathogenic"}
    if total >= 0.5 and total <= 2.5:
        return {"label": "VUS Pathogenic (VUSP)", "class": "vus"}
    if total == 0.0:
        return {"label": "VUS", "class": "vus"}
    if total >= -2.5 and total <= -0.5:
        return {"label": "VUS Benign (VUSB)", "class": "vus"}
    if total >= -4.5 and total <= -3.0:
        return {"label": "Likely Benign (LB)", "class": "benign"}
    return {"label": "Benign (B)", "class": "benign"}


def empty_institutional_result():
    return {
        "enabled": False,
        "total": None,
        "breakdown": [],
        "classification": None,
    }


def apply_rubric(variant_data, splice_points=None, nmd_points=None):
    """Optional institutional scoring hook. Default: disabled, no values.

    Set ``VC_INSTITUTIONAL_SCORING=package.module:function`` to enable a lab's
    own rubric. Without that, analysis still runs ACMG and optional curator
    classification, but does not compute an institutional score.
    """
    spec = (os.environ.get("VC_INSTITUTIONAL_SCORING") or "").strip()
    if not spec:
        return empty_institutional_result()
    try:
        mod_name, _, func_name = spec.partition(":")
        func_name = func_name or "apply_rubric"
        fn = getattr(importlib.import_module(mod_name), func_name)
        out = fn(variant_data, splice_points=splice_points, nmd_points=nmd_points)
        if not isinstance(out, dict):
            return empty_institutional_result()
        result = dict(out)
        result.setdefault("enabled", True)
        result.setdefault("breakdown", [])
        if "classification" not in result and result.get("total") is not None:
            result["classification"] = classify_score(result["total"])
        return result
    except Exception as exc:
        print(f"Institutional scoring hook failed ({spec}): {exc}")
        return empty_institutional_result()


def _normalize_disease_mechanism(raw) -> str:
    text = str(raw or "Unknown").strip().lower()
    if text in ("lof", "loss of function", "loss-of-function", "haploinsufficiency"):
        return "LOF"
    if text in ("gof", "gain of function", "gain-of-function"):
        return "GOF"
    if text in ("both", "lof/gof", "gof/lof"):
        return "BOTH"
    return "UNKNOWN"


def _clingen_haplo_score_int(parsed_data) -> int | None:
    raw = str(parsed_data.get("clingen_haplo_score") or "").strip()
    if not raw or raw.upper() == "N/A":
        return None
    try:
        return int(float(raw.split()[0]))
    except (TypeError, ValueError):
        return None


def lof_is_known_mechanism(parsed_data) -> bool:
    """Richards PVS1: null variant in a gene where LOF is a known mechanism.

    ClinGen haploinsufficiency score 3 is sufficient evidence of loss of
    function and sets the mechanism, including when a prior call was GOF or
    Unknown. A gain-of-function call blocks PVS1 only when that score is absent.
    """
    if _clingen_haplo_score_int(parsed_data) == 3:
        return True
    mech = _normalize_disease_mechanism(parsed_data.get("disease_mechanism"))
    if mech == "GOF":
        return False
    return mech in ("LOF", "BOTH")


def apply_clingen_disease_mechanism(parsed_data) -> None:
    """Set disease mechanism from ClinGen haploinsufficiency score 3."""
    if _clingen_haplo_score_int(parsed_data) != 3:
        return
    parsed_data["disease_mechanism"] = "LOF"
    parsed_data["disease_mechanism_citation"] = "ClinGen haploinsufficiency score 3"


def _is_nullish_consequence(consequence: str) -> bool:
    return (
        "nonsense" in consequence
        or "frameshift" in consequence
        or consequence == "start_lost"
        or "splice_donor_variant" in consequence
        or "splice_acceptor_variant" in consequence
    )


def _is_canonical_splice(consequence: str) -> bool:
    return "splice_donor_variant" in consequence or "splice_acceptor_variant" in consequence


def _pm1_hotspot_desc(parsed_data) -> str | None:
    """PM1: missense/in-frame in a mutational hotspot or critical region.

    Uses ClinVar P/LP neighbors already gathered for the review panel
    (±5 aa) or the denser internal hotspot map (≥3 variants in that window).
    """
    regional = parsed_data.get("regional_hotspot") or []
    hotspot = parsed_data.get("internal_hotspot") or {}
    n_regional = len(regional) if isinstance(regional, list) else 0
    n_hot = len(hotspot) if isinstance(hotspot, dict) else 0
    if n_regional >= 2:
        return (
            f"Located in a mutational hotspot ({n_regional} ClinVar P/LP missense "
            "within ±5 amino acids)"
        )
    if n_hot >= 3:
        return (
            f"Located in a mutational hotspot ({n_hot} ClinVar variants within ±5 amino acids)"
        )
    return None


def _max_spliceai(parsed_data) -> float:
    return max(
        float(parsed_data.get("spliceai_ds_ag") or 0.0),
        float(parsed_data.get("spliceai_ds_al") or 0.0),
        float(parsed_data.get("spliceai_ds_dg") or 0.0),
        float(parsed_data.get("spliceai_ds_dl") or 0.0),
    )


def combine_acmg_criteria(criteria):
    """Richards et al. 2015 Table 5 combining rules (ACMG/AMP)."""
    path_counts = {"very_strong": 0, "strong": 0, "moderate": 0, "supporting": 0}
    benign_counts = {"stand_alone": 0, "strong": 0, "supporting": 0}

    for c in criteria:
        weight = c.get("weight")
        if c.get("type") == "pathogenic":
            if weight in path_counts:
                path_counts[weight] += 1
        elif weight in benign_counts:
            benign_counts[weight] += 1

    vs, s, m, p = (
        path_counts["very_strong"],
        path_counts["strong"],
        path_counts["moderate"],
        path_counts["supporting"],
    )

    is_pathogenic = False
    is_likely_pathogenic = False

    # Pathogenic
    if vs >= 1 and (s >= 1 or m >= 2 or (m == 1 and p >= 1) or p >= 2):
        is_pathogenic = True
    if s >= 2:
        is_pathogenic = True
    if s == 1 and (m >= 3 or (m == 2 and p >= 2) or (m == 1 and p >= 4)):
        is_pathogenic = True

    # Likely pathogenic (only if not already Pathogenic)
    if not is_pathogenic:
        if vs >= 1 and m == 1:
            is_likely_pathogenic = True
        elif s == 1 and m in (1, 2):
            is_likely_pathogenic = True
        elif s == 1 and p >= 2:
            is_likely_pathogenic = True
        elif m >= 3:
            is_likely_pathogenic = True
        elif m == 2 and p >= 2:
            is_likely_pathogenic = True
        elif m == 1 and p >= 4:
            is_likely_pathogenic = True

    is_benign = benign_counts["stand_alone"] >= 1 or benign_counts["strong"] >= 2
    is_likely_benign = False
    if not is_benign:
        if benign_counts["strong"] == 1 and benign_counts["supporting"] >= 1:
            is_likely_benign = True
        elif benign_counts["supporting"] >= 2:
            is_likely_benign = True

    if (is_pathogenic or is_likely_pathogenic) and (is_benign or is_likely_benign):
        return {"label": "VUS (Conflicting)", "class": "vus"}
    if is_pathogenic:
        return {"label": "Pathogenic", "class": "pathogenic"}
    if is_likely_pathogenic:
        return {"label": "Likely Pathogenic", "class": "pathogenic"}
    if is_benign:
        return {"label": "Benign", "class": "benign"}
    if is_likely_benign:
        return {"label": "Likely Benign", "class": "benign"}
    return {"label": "VUS", "class": "vus"}


def apply_acmg(parsed_data, splice_points=None, nmd_points=None):
    """Automatic ACMG/AMP criteria and Richards 2015 combining rules."""
    criteria = []
    parsed_data = parsed_data or {}
    consequence = str(parsed_data.get("consequence") or "").lower()
    nmd_escape = bool(parsed_data.get("nmd_escape", False))
    trunc_frac = parsed_data.get("nmd_escape_truncation_fraction") or 0.0
    has_downstream_pathogenic = bool(parsed_data.get("has_downstream_pathogenic", False))
    has_upstream_pathogenic = bool(parsed_data.get("has_upstream_pathogenic", False))
    start_lost_pathogenic = bool(parsed_data.get("start_lost_5_prime_pathogenic", False))
    nmd_pts = nmd_points if nmd_points is not None else parsed_data.get("nmd_points")

    # 1. PVS1 / PVS1_Strong / PM4 — null and canonical splice (ClinGen PVS1 SOP).
    # The variant rules apply even when the gene is not in ClinGen. That case
    # is still PVS1, labeled mechanism unknown. A gain-of-function call blocks it.
    gof_blocks = (
        _normalize_disease_mechanism(parsed_data.get("disease_mechanism")) == "GOF"
        and _clingen_haplo_score_int(parsed_data) != 3
    )
    if _is_nullish_consequence(consequence) and not gof_blocks:
        if consequence == "start_lost":
            if start_lost_pathogenic:
                criteria.append({
                    "code": "PVS1",
                    "desc": "Start-loss variant bypassing established 5' pathogenic sequence",
                    "type": "pathogenic",
                    "weight": "very_strong",
                })
            elif is_severe_loss(trunc_frac):
                criteria.append({
                    "code": "PVS1",
                    "desc": (
                        "Start codon bypassed with no viable compensating initiation codon "
                        f"(>= 10% protein length skipped: {trunc_frac:.1%})"
                    ),
                    "type": "pathogenic",
                    "weight": "very_strong",
                })
            elif has_upstream_pathogenic:
                criteria.append({
                    "code": "PVS1",
                    "desc": "Start-loss truncates <10%, but bypasses upstream P/LP evidence",
                    "type": "pathogenic",
                    "weight": "very_strong",
                })
        elif _is_canonical_splice(consequence) and "splice_is_in_frame" in parsed_data:
            is_in_frame = parsed_data["splice_is_in_frame"]
            s_frac = parsed_data.get("splice_fraction_lost") or 0.0
            if not is_in_frame and not nmd_escape:
                criteria.append({
                    "code": "PVS1",
                    "desc": "Canonical splice predicted out-of-frame (presumed NMD)",
                    "type": "pathogenic",
                    "weight": "very_strong",
                })
            elif is_in_frame:
                if is_severe_loss(s_frac):
                    criteria.append({
                        "code": "PVS1_Strong",
                        "desc": (
                            "In-frame splice skip removes >= 10% of the protein "
                            f"({s_frac:.1%})"
                        ),
                        "type": "pathogenic",
                        "weight": "strong",
                    })
                elif (
                    has_upstream_pathogenic
                    or has_downstream_pathogenic
                    or parsed_data.get("has_pathogenic_in_deleted_exon")
                ):
                    # ClinGen PVS1: in-frame deletion of a region with P/LP → Strong, not Very Strong
                    criteria.append({
                        "code": "PVS1_Strong",
                        "desc": "In-frame splice skip (<10%) deletes a region harboring P/LP variation",
                        "type": "pathogenic",
                        "weight": "strong",
                    })
                else:
                    criteria.append({
                        "code": "PM4",
                        "desc": (
                            "In-frame splice skip (<10%) without known P/LP in the deleted region "
                            f"({s_frac:.1%})"
                        ),
                        "type": "pathogenic",
                        "weight": "moderate",
                    })
        elif nmd_escape:
            if "nonsense" in consequence and is_severe_loss(trunc_frac):
                criteria.append({
                    "code": "PVS1",
                    "desc": f"Escapes NMD, but stop codon truncates >10% of protein ({trunc_frac:.1%})",
                    "type": "pathogenic",
                    "weight": "very_strong",
                })
            elif has_downstream_pathogenic:
                criteria.append({
                    "code": "PVS1",
                    "desc": "Escapes NMD, but has downstream P/LP evidence",
                    "type": "pathogenic",
                    "weight": "very_strong",
                })
        elif nmd_pts is not None and float(nmd_pts) == 4.0:
            criteria.append({
                "code": "PVS1",
                "desc": "Null variant predicted to undergo NMD",
                "type": "pathogenic",
                "weight": "very_strong",
            })
        else:
            null_desc = f"Null variant ({consequence.replace('_', ' ')})"
            if lof_is_known_mechanism(parsed_data):
                null_desc += " in a gene where LOF is a known mechanism of disease"
            criteria.append({
                "code": "PVS1",
                "desc": null_desc,
                "type": "pathogenic",
                "weight": "very_strong",
            })
        if not lof_is_known_mechanism(parsed_data):
            for criterion in criteria:
                if criterion["code"] in ("PVS1", "PVS1_Strong") and "Mechanism unknown" not in criterion["desc"]:
                    criterion["desc"] = criterion["desc"].rstrip(".") + ". Mechanism unknown."

    # 2. PS1 / PM5 — same residue, not merely a nearby/local ClinVar allele
    if "missense" in consequence or "inframe" in consequence:
        if parsed_data.get("identical_pathogenic"):
            criteria.append({
                "code": "PS1",
                "desc": "Same amino acid change as a previously established pathogenic variant",
                "type": "pathogenic",
                "weight": "strong",
            })
        elif parsed_data.get("different_pathogenic") or parsed_data.get("pm5_local_alleles"):
            criteria.append({
                "code": "PM5",
                "desc": (
                    "Novel missense change at an amino acid residue where a different "
                    "missense pathogenic change has been seen before"
                ),
                "type": "pathogenic",
                "weight": "moderate",
            })

        pm1_desc = _pm1_hotspot_desc(parsed_data)
        if pm1_desc:
            criteria.append({
                "code": "PM1",
                "desc": pm1_desc,
                "type": "pathogenic",
                "weight": "moderate",
            })

    # 3. Population data (BA1, BS1, PM2)
    af = parsed_data.get("gnomad_af")
    if af is not None:
        try:
            af = float(af)
        except (TypeError, ValueError):
            af = None
    # MyVariant was queried and gnomAD had no AF → treat as absent (PM2).
    if af is None and parsed_data.get("gnomad_checked"):
        af = 0.0
    if af is not None:
        if af >= 0.05:
            criteria.append({
                "code": "BA1",
                "desc": f"Allele frequency is ≥5% ({af:.4f}) in gnomAD",
                "type": "benign",
                "weight": "stand_alone",
            })
        elif af >= 0.01:
            criteria.append({
                "code": "BS1",
                "desc": f"Allele frequency is ≥1% ({af:.4f}) in gnomAD",
                "type": "benign",
                "weight": "strong",
            })
        elif af < 0.0001:
            criteria.append({
                "code": "PM2",
                "desc": f"Absent or extremely rare ({af:.4g}) in population databases",
                "type": "pathogenic",
                "weight": "moderate",
            })

    nhom = parsed_data.get("gnomad_nhomalt")
    try:
        nhom = int(nhom) if nhom is not None else None
    except (TypeError, ValueError):
        nhom = None
    if nhom is not None and nhom >= 1:
        criteria.append({
            "code": "BS2",
            "desc": (
                f"gnomAD reports {nhom} homozygous "
                f"{'genotype' if nhom == 1 else 'genotypes'}"
            ),
            "type": "benign",
            "weight": "strong",
        })

    # 4. PP3 / BP4 — do not stack with PVS1; do not treat "no splice effect" as
    # benign for missense or truncating variants.
    has_pvs1_family = any(
        c["code"] in ("PVS1", "PVS1_Strong", "PM4") for c in criteria
    )
    max_spliceai = _max_spliceai(parsed_data)
    has_spliceai_path = max_spliceai > 0.5
    has_spliceai_benign = 0 < max_spliceai < 0.2
    truncating = (
        "nonsense" in consequence
        or "frameshift" in consequence
        or consequence == "start_lost"
        or consequence == "stop_lost"
    )

    if not has_pvs1_family and not truncating:
        if "missense" in consequence:
            cadd = parsed_data.get("cadd_phred") or 0
            revel = parsed_data.get("revel_score") or 0
            try:
                cadd = float(cadd)
            except (TypeError, ValueError):
                cadd = 0.0
            try:
                revel = float(revel)
            except (TypeError, ValueError):
                revel = 0.0
            has_cadd = cadd > 0
            has_revel = revel > 0
            cadd_path = cadd >= 25
            cadd_benign = has_cadd and cadd < 10
            revel_path = has_revel and revel >= 0.644
            revel_benign = has_revel and revel < 0.5
            metadome_path = bool(parsed_data.get("metadome_intolerant"))
            # SpliceAI can support a cryptic-splice missense (PP3) but absence of
            # a splice signal is not evidence the missense is benign (not BP4).
            path_support_count = sum([cadd_path, revel_path, has_spliceai_path, metadome_path])
            benign_support_count = sum([cadd_benign, revel_benign])

            if path_support_count >= 2:
                criteria.append({
                    "code": "PP3",
                    "desc": "Multiple lines of computational evidence support a deleterious effect",
                    "type": "pathogenic",
                    "weight": "supporting",
                })
            elif benign_support_count >= 2:
                criteria.append({
                    "code": "BP4",
                    "desc": "Multiple lines of computational evidence suggest no impact on gene or gene product",
                    "type": "benign",
                    "weight": "supporting",
                })
            elif revel_path:
                criteria.append({
                    "code": "PP3",
                    "desc": "REVEL supports a deleterious effect",
                    "type": "pathogenic",
                    "weight": "supporting",
                })
            elif cadd_path:
                criteria.append({
                    "code": "PP3",
                    "desc": "CADD supports a deleterious effect",
                    "type": "pathogenic",
                    "weight": "supporting",
                })
            elif metadome_path:
                criteria.append({
                    "code": "PP3",
                    "desc": "MetaDome indicates an intolerant residue",
                    "type": "pathogenic",
                    "weight": "supporting",
                })
            elif has_spliceai_path:
                criteria.append({
                    "code": "PP3",
                    "desc": "SpliceAI supports a deleterious splice effect",
                    "type": "pathogenic",
                    "weight": "supporting",
                })
            elif revel_benign:
                criteria.append({
                    "code": "BP4",
                    "desc": "REVEL suggests no impact",
                    "type": "benign",
                    "weight": "supporting",
                })
            elif cadd_benign:
                criteria.append({
                    "code": "BP4",
                    "desc": "CADD suggests no impact",
                    "type": "benign",
                    "weight": "supporting",
                })
        else:
            # CADD/REVEL of 0 are missing scores, not benign calls. A low SpliceAI
            # delta is only "no splicing impact" when splicing is the question.
            # An in-frame protein change (MECP2 c.1366_1368del, SpliceAI 0.016)
            # does not become BP4 because that score is absent or negligible.
            splice_question = "splice" in consequence or "intron" in consequence
            inframe = "inframe" in consequence
            if has_spliceai_path:
                criteria.append({
                    "code": "PP3",
                    "desc": "SpliceAI computationally predicts aberrant splicing",
                    "type": "pathogenic",
                    "weight": "supporting",
                })
            elif has_spliceai_benign and splice_question and not inframe:
                criteria.append({
                    "code": "BP4",
                    "desc": "SpliceAI computationally predicts no splicing impact",
                    "type": "benign",
                    "weight": "supporting",
                })

    # 5. Clinical evidence (PP1, PP4)
    ai_logic = parsed_data.get("ai_logic") or {}
    if ai_logic:
        try:
            seg_num = int(ai_logic.get("total_segregations_across_all_families") or 0)
        except (TypeError, ValueError):
            seg_num = 0
        if seg_num >= 4:
            criteria.append({
                "code": "PP1_Strong",
                "desc": f"Co-segregation with disease in {seg_num} affected family members",
                "type": "pathogenic",
                "weight": "strong",
            })
        elif seg_num >= 2:
            criteria.append({
                "code": "PP1",
                "desc": f"Co-segregation with disease in {seg_num} affected family members",
                "type": "pathogenic",
                "weight": "supporting",
            })
        if ai_logic.get("is_specific_etiology"):
            criteria.append({
                "code": "PP4",
                "desc": (
                    "Patient's phenotype or family history is highly specific for a disease "
                    "with a single genetic etiology"
                ),
                "type": "pathogenic",
                "weight": "supporting",
            })

    return {
        "criteria": criteria,
        "classification": combine_acmg_criteria(criteria),
    }
