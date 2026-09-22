"""Noncoding (n. / NR_) analyze-track helpers — no network."""
from __future__ import annotations

from vc_engine.hgvs import (
    _hgvs_c_dot_alleles_equal,
    _hgvs_dna_kind,
    _is_noncoding_dna_hgvs,
    _myvariant_c_dot_tail_norm,
    _normalize_dna_hgvs_prefix,
    _vep_hgvs_query,
)
from vc_engine.hgmd import _hgmd_lookup_keys, _hgmd_ordered_candidate_keys
from vc_engine.lit_index import _normalize_c_dot
from vc_engine.literature import _literature_c_query_clause
from vc_engine.noncoding import (
    apply_noncoding_curation_pack,
    build_noncoding_clinvar_search_links,
    format_noncoding_curation_logic_html,
    noncoding_critical_region,
)
from vc_engine.scoring import apply_rubric


def test_normalize_preserves_n_and_r():
    assert _normalize_dna_hgvs_prefix("n.109G>T") == "n.109G>T"
    assert _normalize_dna_hgvs_prefix("r.109g>u") == "r.109g>u"
    assert _normalize_dna_hgvs_prefix("c.100A>G") == "c.100A>G"
    assert _normalize_dna_hgvs_prefix("109G>T") == "c.109G>T"
    assert _normalize_c_dot("n.109G>T") == "n.109G>T"


def test_noncoding_detection():
    assert _hgvs_dna_kind("n.109G>T") == "n"
    assert _is_noncoding_dna_hgvs("n.109G>T", "NR_003137")
    assert _is_noncoding_dna_hgvs("c.100A>G", "NR_003137")
    assert not _is_noncoding_dna_hgvs("c.100A>G", "NM_000827")


def test_tail_norm_strips_n_prefix():
    assert _myvariant_c_dot_tail_norm("n.109G>T") == "109g>t"
    assert _myvariant_c_dot_tail_norm("c.109G>T") == "109g>t"
    assert _hgvs_c_dot_alleles_equal("n.109G>T", "NR_003137.2:n.109G>T".split(":")[-1])


def test_vep_query_accepts_nr():
    assert _vep_hgvs_query("NR_003137.2", "n.109G>T", "RNU4-2") == "NR_003137:n.109G>T"
    assert _vep_hgvs_query("NM_000827.4", "c.100A>G", "GRIA1") == "NM_000827:c.100A>G"
    assert _vep_hgvs_query("", "n.109G>T", "RNU4-2") == "RNU4-2:n.109G>T"


def test_lit_and_hgmd_do_not_invent_c_n():
    assert "c.n." not in _literature_c_query_clause("n.109G>T")
    assert '"n.109G>T"' in _literature_c_query_clause("n.109G>T")
    keys = _hgmd_lookup_keys("RNU4-2", "n.109G>T")
    assert "RNU4-2_n.109G>T" in keys
    assert "RNU4-2_109G>T" in keys
    assert not any("c.n." in k for k in keys)
    ordered = _hgmd_ordered_candidate_keys(
        "RNU4-2", "n.109G>T", {"refseq_nm_synonyms": []}
    )
    assert any(k.endswith("n.109G>T") or k.endswith("_109G>T") for k in ordered)
    assert not any("c.n." in k for k in ordered)


def test_rubric_hook_accepts_noncoding_track():
    out = apply_rubric(
        {
            "consequence": "non_coding_transcript_exon_variant",
            "noncoding_track": True,
            "c_dot": "n.109G>T",
            "cadd_phred": 0,
            "revel_score": 0,
            "gnomad_af": 0,
            "spliceai_ds_ag": 0,
            "spliceai_ds_al": 0,
            "spliceai_ds_dg": 0,
            "spliceai_ds_dl": 0,
        }
    )
    assert out["enabled"] is False
    assert out["breakdown"] == []


def test_rnu4_2_critical_region_and_clinvar_links():
    import urllib.parse

    region = noncoding_critical_region("RNU4-2")
    assert region and region["start"] == 120291825
    links = build_noncoding_clinvar_search_links("RNU4-2", "n.109G>T", "NR_003137")
    allele_q = urllib.parse.unquote(links["allele"])
    assert "n.109G>T" in allele_q
    assert "critical_region" in links
    assert "pathogenic" in links["gene_plp"].lower()


def test_noncoding_curation_pack_checklist():
    pd = {
        "noncoding_track": True,
        "grch38_chrom": "chr12",
        "grch38_start": 120291830,
        "grch38_end": 120291830,
        "clinvar_sig": "",
        "clinvar_rcv": "",
        "gnomad_af": 0,
    }
    apply_noncoding_curation_pack(
        pd, gene="RNU4-2", c_dot="n.109G>T", transcript="NR_003137", global_vcf=None
    )
    assert pd["noncoding_in_critical_region"] is True
    assert pd["c_allele_search_link"]
    assert any(
        "noncoding track" in (i.get("text") or "").lower()
        for i in pd["noncoding_curation_checklist"]
    )
    html = format_noncoding_curation_logic_html(pd)
    assert "Noncoding RNA" in html
    assert "critical region" in html.lower()


def test_clinvar_nr_n_title_score_regex():
    """Mirror analyze NR_:n. title matching without loading the Flask app stack."""
    import re

    name = "NR_003137.3(RNU4-2):n.109G>T"
    m = re.search(
        r"((?:NM|NR)_\d+(?:\.\d+)?)(?:\([^)]*\))?:((?:c|n|r)\.[^ (]+)",
        name,
        re.I,
    )
    assert m
    assert _hgvs_c_dot_alleles_equal("n.109G>T", m.group(2))
    assert m.group(1).startswith("NR_")
