"""Unit tests for extracted pure helper modules (hgvs / myvariant / uniprot / hgmd).

Fast and dependency-free (no engine load, no network). Locks in the behavior of
the Phase 3 extractions so future refactors stay behavior-preserving.
"""
from vc_engine.hgvs import (
    _c_dot_change_class,
    _c_dot_requires_exact_allele_match,
    _hgvs_c_dot_alleles_equal,
    _is_same_cdna_allele,
    _protein_position_from_hgvs_label,
    _refseq_base_match,
)
from vc_engine.regions import _hydrate_skipped_exon_aa_bounds, _hydrate_splice_excised_region, _skipped_exon_aa_range_label, _cds_interval_to_genomic
from vc_engine.analyze import _clinvar_variation_name_score
from vc_engine.myvariant import _pick_best_myvariant_hit, myvariant_hit_matches_refseq
from vc_engine.uniprot import (
    _uniprot_domain_lookup_mode,
    _uniprot_truncation_positions,
    _uniprot_truncation_feature_relation,
    _format_uniprot_feature_label,
    _pick_dbnsfp_uniprot_accession,
    _rank_uniprot_search_entry,
    _is_swiss_prot_accession,
)
from vc_engine.hgmd import (
    _hgmd_cell_pubmed_ids,
    _hgmd_column_carries_pubmed_ids,
    _hgmd_lookup_keys,
    _hgmd_ordered_candidate_keys,
    _hgmd_gene_mutation_url,
)


# --- hgvs ---

def test_downstream_plp_anchor_aa_uses_novel_ptc_not_fs_onset():
    from vc_engine.regions import _downstream_plp_anchor_aa

    pd = {"protein_start": 1185, "downstream_aas": 212}
    assert _downstream_plp_anchor_aa(pd) == 1397
    assert _downstream_plp_anchor_aa({"novel_stop_aa": 1400, "protein_start": 1185}) == 1400
    assert _downstream_plp_anchor_aa({"protein_start": 500}) == 500


def test_finalize_downstream_plp_scan_metadata_sets_nmd_math_and_flag():
    from vc_engine.regions import _finalize_downstream_plp_scan_metadata

    pd = {
        "consequence": "frameshift",
        "nmd_escape": True,
        "nmd_escape_truncation_fraction": 0.0088,
        "novel_stop_aa": 676,
        "protein_start": 532,
        "protein_length": 682,
    }
    _finalize_downstream_plp_scan_metadata(pd, "TBR1")
    assert pd.get("downstream_plp_scan_performed") is True
    assert "676" in (pd.get("nmd_math") or "")
    assert "No matched ClinVar P/LP" in (pd.get("nmd_math") or "")
    assert pd.get("downstream_pathogenic_clinvar_search_link", "").startswith("https://www.ncbi.nlm.nih.gov/clinvar/")


def test_c_search_term_uses_full_dup_notation():
    import re

    c_dot = "c.1588_1594dup"
    gene = "TBR1"
    _c_dot_core = c_dot.strip()
    if re.search(r"c\.\d+(?:_\d+)?(?:dup|del|ins|delins)\b", _c_dot_core, re.I):
        term = f"{gene}[gene] AND {_c_dot_core}"
    else:
        term = ""
    assert "1588_1594dup" in term
    assert "c.1588 " not in term


def test_needs_downstream_clinvar_plp_structural_nmd_escape():
    from vc_engine.regions import _needs_downstream_clinvar_plp

    # MC4R c.771C>A: last-exon nonsense, ~23% C-terminal loss, escapes NMD structurally.
    mc4r = {
        "consequence": "nonsense",
        "nmd_escape": True,
        "nmd_escape_truncation_fraction": 1.0 - (257 / 332.0),
        "protein_start": 257,
    }
    assert _needs_downstream_clinvar_plp(mc4r) is True
    assert _needs_downstream_clinvar_plp({"consequence": "nonsense", "nmd_escape": False}) is False
    assert _needs_downstream_clinvar_plp(
        {"consequence": "frameshift", "nmd_escape_truncation_fraction": -0.05}
    ) is True


def test_finalize_downstream_plp_scan_metadata_ge10_pct_label():
    from vc_engine.regions import _finalize_downstream_plp_scan_metadata

    pd = {
        "consequence": "nonsense",
        "nmd_escape": True,
        "nmd_escape_truncation_fraction": 0.135,
        "protein_start": 1050,
        "protein_length": 1214,
    }
    _finalize_downstream_plp_scan_metadata(pd, "ZEB2")
    nmd_math = pd.get("nmd_math") or ""
    assert "1050" in nmd_math
    assert "≥10%" in nmd_math
    assert "13.5" in nmd_math


def test_append_truncation_nmd_sections_nmd_escape_ge10():
    from vc_engine.splice import _append_truncation_nmd_sections

    sections = []
    pd = {
        "protein_length": 1214,
        "protein_start": 1050,
        "novel_stop_aa": 1050,
    }
    _append_truncation_nmd_sections(
        sections, pd, "ZEB2", "nonsense", True, False, True, 0.135,
    )
    assert sections[0][0] == "Truncation & NMD"
    body = sections[0][1]
    assert "≥10%" in body
    assert "PVS1" in body
    assert "13.5" in body
    assert "Stop: 1050/1214 aa" in body


def test_append_truncation_nmd_sections_nmd_predicted_includes_trunc_math():
    from vc_engine.splice import _append_truncation_nmd_sections

    sections = []
    pd = {
        "protein_length": 1020,
        "protein_start": 714,
        "novel_stop_aa": 719,
        "downstream_aas": 5,
        "consequence": "frameshift",
        "hgvs_p": "p.Ala714Glufs*6",
        "nmd_decision_basis": (
            "PTC in coding exon 16 of 23, upstream of the penultimate exon-exon "
            "junction — predicted to trigger NMD."
        ),
    }
    _append_truncation_nmd_sections(
        sections, pd, "ATP1A2", "frameshift", True, False, False, 0.30,
    )
    body = sections[0][1]
    assert "penultimate exon-exon junction" in body
    assert "Stop removes" not in body
    assert "Stop: 714 [WT] + 5 [shift] = 719/1020 aa" in body
    assert "29.5% C-terminal lost" in body
    assert "30.0%" not in body


def test_c_dot_change_class():
    assert _c_dot_change_class("c.382del") == "del"
    assert _c_dot_change_class("c.1614dup") == "dup"
    assert _c_dot_change_class("c.100_101insAT") == "ins"
    assert _c_dot_change_class("c.100delinsAT") == "indel"
    assert _c_dot_change_class("c.4755+1G>A") == "sub"


def test_c_dot_requires_exact_allele_match_for_snv():
    assert _c_dot_requires_exact_allele_match("c.4755+1G>A")
    assert _c_dot_requires_exact_allele_match("c.382del")
    assert not _c_dot_requires_exact_allele_match("c.100")


def test_clinvar_variation_name_score_rejects_different_snv():
    score = _clinvar_variation_name_score(
        "NM_001127222.2(CACNA1A):c.4755+1G>T",
        "CACNA1A",
        "NM_001127222.2",
        "c.4755+1G>A",
    )
    assert score == 0
    exact = _clinvar_variation_name_score(
        "NM_001127222.2(CACNA1A):c.4755+1G>A",
        "CACNA1A",
        "NM_001127222.2",
        "c.4755+1G>A",
    )
    assert exact == 100


def test_clinvar_variation_name_score_ddx3x_repeat_notation_via_protein():
    """ClinVar c.119CTC[1] vs lab c.122_124del — same p.Pro41del on NM_001356.5."""
    score = _clinvar_variation_name_score(
        "NM_001356.5(DDX3X):c.119CTC[1] (p.Pro41del)",
        "DDX3X",
        "NM_001356.5",
        "c.122_124del",
        hgvs_p="p.Pro41del",
    )
    assert score == 85


def test_pick_clinvar_from_esearch_ddx3x_inframe_del(monkeypatch, tmp_path):
    from vc_engine.analyze import _pick_clinvar_from_esearch
    import requests

    monkeypatch.setenv("VC_DATA_ROOT", str(tmp_path))
    (tmp_path / "clinvar-source").write_text("ncbi\n")
    uid, sig, sc = _pick_clinvar_from_esearch(
        requests.Session(),
        "DDX3X",
        "c.122_124del",
        "NM_001356.5",
        hgvs_p="p.Pro41del",
    )
    assert uid == "1215809"
    assert sc >= 70
    assert sig


def test_protein_position_from_hgvs_label():
    assert _protein_position_from_hgvs_label("c.4599C>A (p.Cys1533Ter)") == 1533
    assert _protein_position_from_hgvs_label("NM_1:c.100A>G (p.Arg34Gly)") == 34


def test_skipped_exon_aa_bounds_from_cds():
    pd = {"splice_target_start_cds": 4600, "splice_target_end_cds": 4845}
    lo, hi = _hydrate_skipped_exon_aa_bounds(pd)
    assert lo == 1534
    assert hi == 1615
    assert _skipped_exon_aa_range_label(pd) == "aa 1534–1615"


def test_hydrate_splice_excised_region_from_cryptic_gain():
    pd = {
        "transcript_strand": -1,
        "cds_genomic_start": 100,
        "cds_genomic_end": 200,
        "coding_exons": [{
            "start_cds": 4490,
            "end_cds": 4510,
            "start": 150,
            "end": 170,
            "chr": "3",
            "anatomical_rank": 25,
        }],
        "cryptic_gain_outcome": {
            "deleted_nt": 12,
            "excised_cdna_lo": 4499,
            "excised_cdna_hi": 4510,
            "use_donor_cryptic": True,
            "new_site_cdna": 4498,
            "exon_cds_start": 4490,
            "exon_cds_end": 4510,
        },
    }
    assert _hydrate_splice_excised_region(pd)
    assert pd["splice_excised_partial"] is True
    assert pd["splice_deleted_coords"]["start"] == 150
    assert pd["splice_deleted_coords"]["end"] == 161
    assert pd["skipped_exon_aa_range"] == [1500, 1504]


def test_hydrate_whole_exon_skip_deleted_coords_from_variant_exon():
    from vc_engine.regions import _hydrate_whole_exon_skip_deleted_coords

    pd = {
        "c_dot": "c.249+4A>T",
        "consequence": "intron_variant",
        "variant_exon": 2,
        "spliceai_exon_skip_spliceai_primary": True,
        "coding_exons": [
            {
                "anatomical_rank": 2,
                "start_cds": 184,
                "end_cds": 249,
                "length_bp": 66,
                "chr": "2",
                "start": 100,
                "end": 165,
            },
        ],
    }
    assert _hydrate_whole_exon_skip_deleted_coords(pd)
    assert pd["splice_deleted_coords"]["start"] == 100
    assert pd["splice_deleted_coords"]["end"] == 165
    assert pd["splice_is_in_frame"] is True


def test_hydrate_replaces_incomplete_splice_deleted_coords():
    from vc_engine.regions import _hydrate_whole_exon_skip_deleted_coords

    pd = {
        "c_dot": "c.2069+1G>A",
        "variant_exon": 17,
        "spliceai_exon_skip_spliceai_primary": True,
        "splice_deleted_coords": {"chr": None, "start": None, "end": None},
        "coding_exons": [
            {
                "anatomical_rank": 17,
                "start_cds": 1943,
                "end_cds": 2069,
                "length_bp": 127,
                "chr": "22",
                "start": 20995746,
                "end": 20995872,
            },
        ],
    }
    assert _hydrate_whole_exon_skip_deleted_coords(pd)
    assert pd["splice_deleted_coords"] == {
        "chr": "22",
        "start": 20995746,
        "end": 20995872,
    }


def test_skipped_exon_plp_scan_banner_checked():
    from vc_engine.regions import _skipped_exon_plp_scan_banner_html

    pd = {
        "skipped_exon_plp_checked": True,
        "skipped_exon_aa_range": [62, 83],
    }
    html_out = _skipped_exon_plp_scan_banner_html(pd)
    assert "Skipped exon ClinVar P/LP scan" in html_out
    assert "No P/LP" in html_out
    assert "aa 62–83" in html_out


def test_skipped_exon_plp_scan_banner_unmapped_empty_exons():
    from vc_engine.regions import _skipped_exon_plp_scan_banner_html

    pd = {
        "spliceai_exon_skip_spliceai_primary": True,
        "coding_exons": [],
    }
    html_out = _skipped_exon_plp_scan_banner_html(pd)
    assert "Ensembl lookup" in html_out


def test_gene_symbol_from_myvariant_hit_keeps_user_gene():
    from vc_engine.myvariant import _gene_symbol_from_myvariant_hit, _resolve_effective_gene_from_vep_symbols

    hit = {
        "clinvar": {"gene": {"symbol": "ASTN2"}},
        "snpeff": {"ann": [
            {"feature_id": "NM_001099679.1", "hgvs_c": "c.467T>C"},
            {"feature_id": "NM_012210.3", "hgvs_c": "c.467T>C"},
        ]},
    }
    assert _gene_symbol_from_myvariant_hit("TRIM32", hit, "NM_000335") == "TRIM32"
    assert _resolve_effective_gene_from_vep_symbols("TRIM32", ["ASTN2", "TRIM32"]) == "TRIM32"
    assert _resolve_effective_gene_from_vep_symbols("TRIM32", ["ASTN2"]) == "TRIM32"


def test_skipped_exon_uniprot_report_line_has_link():
    from vc_engine.uniprot import _skipped_exon_uniprot_report_line
    pd = {
        "uniprot_skipped_exon_checked": True,
        "skipped_exon_aa_range": [163, 214],
        "skipped_exon_has_critical_domain": True,
        "skipped_exon_critical_domains": ["C2H2-type 1 (aa 163–186)", "C2H2-type 2 (aa 192–214)"],
        "uniprot_primary_accession": "Q15915",
        "skipped_exon_critical_domain_link": "https://www.uniprot.org/uniprotkb/Q15915/entry#family_and_domains",
    }
    line = _skipped_exon_uniprot_report_line(pd)
    assert "<a href='https://www.uniprot.org/uniprotkb/Q15915" in line
    assert "UniProt</a>:" in line
    assert "C2H2-type 1" in line
    assert "skipped exon aa 163–214" in line


def test_hgvs_alleles_equal_rejects_substring_traps():
    assert _hgvs_c_dot_alleles_equal("c.382del", "c.382del")
    assert not _hgvs_c_dot_alleles_equal("c.382del", "c.-382del")
    assert not _hgvs_c_dot_alleles_equal("c.382del", "c.38del")


def test_is_same_cdna_allele_dup_requires_exact():
    assert _is_same_cdna_allele("c.100A>G", "c.100A>G")
    assert not _is_same_cdna_allele("c.1614-16_1622dup", "c.1614-6_1628dup")


def test_is_colocalized_cdna_alternate_snv_at_same_codon():
    from vc_engine.hgvs import _is_colocalized_cdna_alternate

    assert _is_colocalized_cdna_alternate("c.904G>T", "c.904G>A")
    assert not _is_colocalized_cdna_alternate("c.904G>T", "c.904G>T")
    assert not _is_colocalized_cdna_alternate("c.904G>T", "c.905G>A")


def test_classify_fgfr3_g904t_colocalized_vus_as_true_vus():
    from vc_engine.analyze import _classify_local_allele_hit

    hit = {
        "_id": "clinvar.variant_id:3713629",
        "clinvar": {
            "hgvs": {
                "coding": ["NM_000142.5(FGFR3):c.904G>A (p.Gly302Ser)"],
                "protein": ["NP_000133.1:p.Gly302Ser"],
            },
            "variant_id": "3713629",
            "rcv": [{"clinical_significance": "Uncertain significance"}],
        },
        "snpeff": {
            "ann": [{
                "feature_id": "NM_000142.5",
                "hgvs_c": "c.904G>A",
                "hgvs_p": "p.Gly302Ser",
                "protein": {"position": "302"},
            }]
        },
    }
    parsed = {
        "hgvs_p": "p.G302C",
        "c_dot": "c.904G>T",
        "transcript": "NM_000142.5",
        "clinvar_rcv": "4802675",
    }
    bucket, entry = _classify_local_allele_hit(
        hit, parsed, "NM_000142", 302, "904", None, "4"
    )
    assert bucket == "true_vus"
    assert entry["hgvs_c"] == "c.904G>A"


def test_finalize_exon_display_fields_from_cds_map_when_rank_missing():
    from vc_engine.analyze import _finalize_exon_display_fields

    parsed = {
        "c_dot": "c.700C>G",
        "consequence": "missense",
        "coding_exons": [
            {"anatomical_rank": 4, "start_cds": 511, "end_cds": 701, "length_bp": 191},
        ],
        "mrna_exon_total": 9,
    }
    _finalize_exon_display_fields(parsed, "c.700C>G")
    assert parsed["variant_exon"] == 4
    assert parsed["nmd_exon_total"] == 9


def test_refseq_base_match():
    assert _refseq_base_match("NM_017799.4:c.382del", "NM_017799")
    assert not _refseq_base_match("NM_000000.1:c.1A>G", "NM_017799")


# --- myvariant ---

def test_pick_best_myvariant_hit_prefers_refseq():
    hits = [
        {"clinvar": {"hgvs": {"coding": ["NM_999999.1:c.382del"]}}},
        {"clinvar": {"hgvs": {"coding": ["NM_017799.4:c.382del"]}}},
    ]
    best, score = _pick_best_myvariant_hit(hits, "c.382del", "NM_017799")
    assert score == 3
    assert best is hits[1]
    assert myvariant_hit_matches_refseq(hits[1], "NM_017799", "c.382del")


# --- uniprot ---

def test_uniprot_domain_lookup_mode():
    assert _uniprot_domain_lookup_mode("missense_variant") == "point"
    assert _uniprot_domain_lookup_mode("stop_gained") == "truncation"


def test_resolve_protein_aa_for_uniprot_from_hgvs_when_protein_start_missing():
    from vc_engine.uniprot import _resolve_protein_aa_for_uniprot

    assert _resolve_protein_aa_for_uniprot({"protein_start": 0, "hgvs_p": "p.Y182C"}) == 182
    assert _resolve_protein_aa_for_uniprot({"protein_start": 0, "hgvs_p": "p.Tyr182Cys"}) == 182
    assert _resolve_protein_aa_for_uniprot({"protein_start": 0, "hgvs_p": "p.K320*"}) == 320
    assert _resolve_protein_aa_for_uniprot({"protein_start": 0, "hgvs_p": "p.K552_R558del"}) == 552
    assert _resolve_protein_aa_for_uniprot({"protein_start": 53, "hgvs_p": "p.Y182C"}) == 53
    assert _resolve_protein_aa_for_uniprot({"protein_start": 0, "hgvs_p": ""}) == 0


def test_uniprot_truncation_positions_uses_downstream():
    assert _uniprot_truncation_positions({"protein_start": 100, "downstream_aas": 5}) == (100, 105)


def test_uniprot_truncation_feature_relation():
    assert _uniprot_truncation_feature_relation(90, 110, 100, 105) == "at_ptc"
    assert _uniprot_truncation_feature_relation(200, 220, 100, 105) == "lost_downstream"


def test_format_uniprot_feature_label():
    assert _format_uniprot_feature_label("Kinase", 10, 50) == "Kinase (aa 10–50)"
    assert _format_uniprot_feature_label("Kinase", 0, 0) == "Kinase"


def test_pick_dbnsfp_uniprot_prefers_swiss_prot_over_trembl():
    """GATA4 dbNSFP lists B3KUF4 (TrEMBL fragment) before P43694 (Swiss-Prot)."""
    uniprot_data = [
        {'acc': 'B3KUF4', 'gene': 'GATA4'},
        {'acc': 'P43694', 'gene': 'GATA4'},
    ]
    assert _pick_dbnsfp_uniprot_accession(uniprot_data, 'GATA4') == 'P43694'


def test_pick_dbnsfp_uniprot_prefers_gene_match():
    uniprot_data = [
        {'acc': 'P12345', 'gene': 'OTHER'},
        {'acc': 'P43694', 'gene': 'GATA4'},
    ]
    assert _pick_dbnsfp_uniprot_accession(uniprot_data, 'GATA4') == 'P43694'


def test_is_swiss_prot_accession():
    assert _is_swiss_prot_accession('P43694') is True
    assert _is_swiss_prot_accession('B3KUF4') is False
    assert _is_swiss_prot_accession('Q96P20-5') is True


def test_rank_uniprot_search_entry_prefers_canonical_human():
    results = [
        {
            'primaryAccession': 'B3KUF4',
            'uniProtkbId': 'B3KUF4_HUMAN',
            'genes': [],
            'sequence': {'length': 236},
        },
        {
            'primaryAccession': 'P43694',
            'uniProtkbId': 'GATA4_HUMAN',
            'genes': [{'geneName': {'value': 'GATA4'}}],
            'sequence': {'length': 442},
        },
    ]
    entry = _rank_uniprot_search_entry(results, 'GATA4')
    assert entry['primaryAccession'] == 'P43694'


def test_clinvar_hit_protein_on_user_transcript_when_snpeff_missing():
    from vc_engine.analyze import _clinvar_hit_protein_on_user_transcript

    hit = {
        "clinvar": {
            "hgvs": {
                "coding": ["NM_001365902.3(NFIX):c.355T>C (p.Cys119Arg)"],
                "protein": ["NP_001128668.1:p.Cys119Arg"],
            },
            "variant_id": "2501836",
            "rcv": [{"clinical_significance": "Pathogenic"}],
        },
        "snpeff": {"ann": [{"feature_id": "NM_002501.3", "protein": {"position": "119"}}]},
    }
    pos, hgvs_p, hgvs_c = _clinvar_hit_protein_on_user_transcript(hit, "NM_001365902")
    assert pos == 119
    assert hgvs_p == "p.Cys119Arg"
    assert hgvs_c == "c.355T>C"


def test_classify_same_protein_via_clinvar_when_snpeff_wrong_transcript():
    from vc_engine.analyze import _classify_local_allele_hit, _populate_local_allele_lists_from_hits

    hit_fs = {
        "_id": "clinvar.variant_id:540464",
        "clinvar": {
            "hgvs": {
                "coding": ["NM_001365902.3(NFIX):c.358del (p.Leu120fs)"],
                "protein": ["NP_001128668.1:p.Leu120fs"],
            },
            "variant_id": "540464",
            "rcv": [{"clinical_significance": "Pathogenic"}],
        },
        "snpeff": {"ann": [{"feature_id": "NM_002501.3", "protein": {"position": "120"}}]},
    }
    parsed = {
        "hgvs_p": "p.L120P",
        "c_dot": "c.359T>C",
        "consequence": "missense",
        "transcript": "NM_001365902.3",
    }
    bucket, entry = _classify_local_allele_hit(
        hit_fs, parsed, "NM_001365902", 120, "359", None, ""
    )
    assert bucket == "same_protein"
    assert entry["vid"] == "540464"

    regional = []
    pm5 = []
    same_pos = []
    _populate_local_allele_lists_from_hits(
        [hit_fs], parsed, "NM_001365902", 120, "359", None, "",
        [], [], same_pos, pm5, regional,
    )
    assert len(same_pos) == 1
    assert len(pm5) == 1

    hit_near = {
        "_id": "clinvar.variant_id:208724",
        "clinvar": {
            "hgvs": {
                "coding": ["NM_001365902.3(NFIX):c.361C>T (p.Arg121Cys)"],
                "protein": ["NP_001128668.1:p.Arg121Cys"],
            },
            "variant_id": "208724",
            "rcv": [{"clinical_significance": "Pathogenic"}],
        },
        "snpeff": {"ann": []},
    }
    bucket2, _ = _classify_local_allele_hit(
        hit_near, parsed, "NM_001365902", 120, "359", None, ""
    )
    assert bucket2 == "regional"


def test_finalize_local_allele_scan_metadata_hgvs_fallback_note():
    from vc_engine.analyze import (
        _append_allelic_context_logic_sections,
        _finalize_local_allele_scan_metadata,
    )

    hit = {
        "_id": "clinvar.variant_id:2501836",
        "clinvar": {
            "hgvs": {
                "coding": ["NM_001365902.3(NFIX):c.355T>C (p.Cys119Arg)"],
                "protein": ["NP_001128668.1:p.Cys119Arg"],
            },
            "variant_id": "2501836",
            "rcv": [{"clinical_significance": "Pathogenic"}],
        },
        "snpeff": {"ann": [{"feature_id": "NM_002501.3", "protein": {"position": "119"}}]},
    }
    parsed = {
        "transcript": "NM_001365902.3",
        "regional_hotspot": [{"vid": "2501836", "hgvs_p": "p.Cys119Arg"}],
        "c_allele_search_link": "https://example.com/c",
    }
    _finalize_local_allele_scan_metadata(
        parsed, "NFIX", "NM_001365902", [hit], 120
    )
    assert parsed["local_clinvar_scan_performed"] is True
    assert parsed["local_clinvar_used_hgvs_fallback"] is True
    assert "MyVariant snpeff had 0 on NM_001365902" in parsed["local_clinvar_scan_note"]
    assert "1 regional ±5 aa" in parsed["local_clinvar_scan_note"]

    sections = []
    _append_allelic_context_logic_sections(sections, parsed)
    assert sections
    assert sections[0][0] == 'Allelic context'
    body = sections[0][1]
    assert 'Same nucleotide change:' in body
    assert 'Same amino acid change: none' in body
    assert 'Nearby residue (±5 aa):' in body
    assert 'p.Cys119Arg' in body
    assert 'Regional hotspot' not in body
    assert 'Local ClinVar allelic scan' in body


def test_append_clingen_and_allelic_logic_sections():
    from vc_engine.analyze import (
        _append_allelic_context_logic_sections,
        _append_clingen_logic_section,
        _finalize_logic_explanation,
    )

    pd = {
        'has_clingen': True,
        'clingen_haplo_score': '3',
        'gene_symbol': 'ZEB2',
        'alternate_alleles': [],
        'vus_alternate_alleles': [],
        'same_protein_position_alleles': [],
        'pm5_local_alleles': [],
        'regional_hotspot': [],
    }
    sections = []
    _append_clingen_logic_section(sections, pd, 'ZEB2')
    _append_allelic_context_logic_sections(sections, pd)
    _finalize_logic_explanation(pd, sections)
    plain = pd.get('logic_explanation_plaintext') or ''
    assert plain.startswith('ClinGen:')
    assert 'Same nucleotide change: none' in plain
    assert 'Same amino acid change: none' in plain
    assert 'Nearby residue (±5 aa): none' in plain


def test_same_aa_line_excludes_regional_hotspot_neighbors():
    """EMC1-style: Gly868 (±4 aa) must not appear under Same amino acid change."""
    from vc_engine.analyze import _append_allelic_context_logic_sections

    pd = {
        'same_protein_position_alleles': [
            {
                'hgvs_c': 'c.2591G>T',
                'hgvs_p': 'p.Gly864Val',
                'significance': 'Uncertain significance',
                'vid': '1031861',
            }
        ],
        'pm5_local_alleles': [],
        'regional_hotspot': [
            {
                'hgvs_c': 'c.2602G>A',
                'hgvs_p': 'p.Gly868Arg',
                'significance': 'Pathogenic',
                'vid': '219101',
            }
        ],
        'alternate_alleles': [],
        'vus_alternate_alleles': [],
    }
    sections = []
    _append_allelic_context_logic_sections(sections, pd)
    body = sections[0][1]
    assert 'Same amino acid change: c.2591G>T / p.Gly864Val' in body
    assert 'p.Gly868Arg' not in body.split('Same amino acid change:')[1].split('Nearby residue')[0]
    assert 'Nearby residue (±5 aa): c.2602G>A / p.Gly868Arg' in body


def test_opa1_penultimate_ptc_triggers_nmd_not_downstream_scan():
    """OPA1 c.2873_2876del: ~5% C-term lost but PTC >50 nt from last junction → NMD, no <10% scan."""
    from vc_engine.regions import _needs_downstream_clinvar_plp

    pd = {
        "consequence": "frameshift",
        "nmd_escape": False,
        "nmd_escape_truncation_fraction": 0.056,
        "nmd_decision_basis": (
            "PTC in the penultimate coding exon (29 of 30), 110 nt upstream of the "
            "final exon-exon junction (more than 50-55 nt) — predicted to trigger NMD."
        ),
    }
    assert _needs_downstream_clinvar_plp(pd) is False


def test_promote_exonic_coding_indel_frameshift_primary():
    from vc_engine.analyze import _promote_exonic_coding_indel_frameshift_primary

    pd = {
        "c_dot": "c.2873_2876del",
        "hgvs_p": "p.Val958Glyfs*3",
        "consequence": "splice_acceptor_variant",
    }
    _promote_exonic_coding_indel_frameshift_primary(pd)
    assert pd["consequence"] == "frameshift"
    assert pd["exonic_indel_frameshift_primary"] is True
    assert pd["splice_site_overlap_secondary"] is True

    pd2 = {
        "c_dot": "c.2873-2A>G",
        "hgvs_p": "",
        "consequence": "splice_acceptor_variant",
    }
    _promote_exonic_coding_indel_frameshift_primary(pd2)
    assert pd2["consequence"] == "splice_acceptor_variant"


# --- hgmd ---

def test_hgmd_cell_pubmed_ids():
    assert _hgmd_cell_pubmed_ids("12345678; 23456789") == ["12345678", "23456789"]
    assert _hgmd_cell_pubmed_ids("nan") == []
    assert _hgmd_cell_pubmed_ids(None) == []


def test_hgmd_column_carries_pubmed_ids():
    assert _hgmd_column_carries_pubmed_ids("PMID")
    assert _hgmd_column_carries_pubmed_ids("allPMID")
    assert not _hgmd_column_carries_pubmed_ids("gene")


def test_hgmd_lookup_keys_both_notations():
    assert _hgmd_lookup_keys("TMEM260", "c.941del") == [
        "TMEM260_c.941del",
        "TMEM260_941del",
    ]


def test_hgmd_lookup_keys_strips_length_suffix():
    """HGMD gross dels use delN (e.g. 1570_1590del21); ClinVar uses short del."""
    from vc_engine.hgmd import _hgmd_strip_redundant_del_dup_bases

    assert _hgmd_strip_redundant_del_dup_bases("1570_1590del21") == "1570_1590del"
    assert _hgmd_strip_redundant_del_dup_bases("c.1570_1590del21") == "c.1570_1590del"
    # delins must keep inserted sequence identity
    assert _hgmd_strip_redundant_del_dup_bases("100_102delinsATG") == "100_102delinsATG"
    keys_hgmd = set(_hgmd_lookup_keys("DTNA", "1570_1590del21"))
    keys_short = set(_hgmd_lookup_keys("DTNA", "c.1570_1590del"))
    assert keys_hgmd & keys_short
    assert "DTNA_c.1570_1590del" in keys_hgmd
    assert "DTNA_1570_1590del" in keys_hgmd


def test_hgmd_ordered_candidate_keys_isoform_synonym_hits_del21():
    """DTNA-like: user c. on one NM; HGMD indexed under another NM + del21."""
    synonyms = [
        {
            "refseq": "NM_001386795.1",
            "hgvs_c": "c.1651_1671del",
            "user_input": True,
            "from_clinvar": True,
        },
        {
            "refseq": "NM_001390.5",
            "hgvs_c": "c.1570_1590del",
            "user_input": False,
            "from_clinvar": True,
        },
        {
            "refseq": "NM_001390.5",
            "hgvs_c": "c.1567_1587del",
            "user_input": False,
            "from_clinvar": True,
        },
    ]
    keys = _hgmd_ordered_candidate_keys(
        "DTNA", "c.1651_1671del", {"refseq_nm_synonyms": synonyms}
    )
    # Simulate GLOBAL_HGMD keys produced when indexing HGMD row 1570_1590del21
    indexed = set(_hgmd_lookup_keys("DTNA", "1570_1590del21"))
    assert any(k in indexed for k in keys), (keys[:12], indexed)


def test_hgmd_ordered_candidate_keys_falls_back_to_user_cdot():
    keys = _hgmd_ordered_candidate_keys("AMT", "c.878-1G>A", {"refseq_nm_synonyms": []})
    assert "AMT_c.878-1G>A" in keys


def test_exonic_inframe_del_consequence_heuristic_and_clinvar_p():
    from vc_engine.analyze import (
        _apply_exonic_coding_indel_consequence_heuristic,
        _hgvs_p_from_clinvar_variation_name,
        _hgvs_p_is_placeholder,
        _upgrade_hgvs_p_from_named_sources,
    )

    pd = {"c_dot": "c.1651_1671del", "consequence": "unknown", "hgvs_p": ""}
    _apply_exonic_coding_indel_consequence_heuristic(pd)
    assert pd["consequence"] == "inframe_deletion"

    title = "NM_001386795.1(DTNA):c.1651_1671del (p.Lys552_Arg558del)"
    assert _hgvs_p_from_clinvar_variation_name(title) == "p.Lys552_Arg558del"
    assert _hgvs_p_is_placeholder("p.Xaa551_Xaa557del")
    assert not _hgvs_p_is_placeholder("p.Lys552_Arg558del")

    pd2 = {
        "hgvs_p": "p.Xaa551_Xaa557del",
        "clinvar_variation_name": title,
    }
    _upgrade_hgvs_p_from_named_sources(pd2, None)
    assert pd2["hgvs_p"] == "p.Lys552_Arg558del"


def test_refseq_gff_coding_exons_fallback_dtna(monkeypatch):
    import vc_engine.splice as sp
    from vc_engine.analyze import _finalize_exon_display_fields

    gff = """\
##gff-version 3
NM_001386795.1\tRefSeq\tCDS\t150\t2462\t.\t+\t0\tID=cds
NM_001386795.1\tRefSeq\texon\t1\t148\t.\t+\t.\tID=e1
NM_001386795.1\tRefSeq\texon\t149\t216\t.\t+\t.\tID=e2
NM_001386795.1\tRefSeq\texon\t217\t297\t.\t+\t.\tID=e3
NM_001386795.1\tRefSeq\texon\t298\t511\t.\t+\t.\tID=e4
NM_001386795.1\tRefSeq\texon\t512\t597\t.\t+\t.\tID=e5
NM_001386795.1\tRefSeq\texon\t598\t752\t.\t+\t.\tID=e6
NM_001386795.1\tRefSeq\texon\t753\t858\t.\t+\t.\tID=e7
NM_001386795.1\tRefSeq\texon\t859\t1025\t.\t+\t.\tID=e8
NM_001386795.1\tRefSeq\texon\t1026\t1150\t.\t+\t.\tID=e9
NM_001386795.1\tRefSeq\texon\t1151\t1234\t.\t+\t.\tID=e10
NM_001386795.1\tRefSeq\texon\t1235\t1324\t.\t+\t.\tID=e11
NM_001386795.1\tRefSeq\texon\t1325\t1402\t.\t+\t.\tID=e12
NM_001386795.1\tRefSeq\texon\t1403\t1495\t.\t+\t.\tID=e13
NM_001386795.1\tRefSeq\texon\t1496\t1583\t.\t+\t.\tID=e14
NM_001386795.1\tRefSeq\texon\t1584\t1681\t.\t+\t.\tID=e15
NM_001386795.1\tRefSeq\texon\t1682\t1795\t.\t+\t.\tID=e16
NM_001386795.1\tRefSeq\texon\t1796\t1892\t.\t+\t.\tID=e17
NM_001386795.1\tRefSeq\texon\t1893\t2052\t.\t+\t.\tID=e18
"""

    class _Resp:
        status_code = 200
        text = gff

    class _Sess:
        def get(self, *a, **k):
            return _Resp()

    pd = {
        "transcript": "NM_001386795.1",
        "c_dot": "c.1651_1671del",
        "ensembl_transcript_id": "NM_001386795",
    }
    assert sp._ensure_coding_exons_from_refseq_nm(pd, _Sess())
    assert pd.get("coding_exons_source") == "refseq_gff"
    _finalize_exon_display_fields(pd, "c.1651_1671del")
    assert pd.get("variant_exon") == 17
    assert pd.get("nmd_exon_total") == 18


def test_hgmd_gene_mutation_url():
    url = _hgmd_gene_mutation_url("AMT", "c.878-1G>A")
    assert url.startswith("https://www.hgmd.cf.ac.uk/ac/gene.php?gene=AMT")
    assert _hgmd_gene_mutation_url("", "c.1A>G") == ""


# --- util ---

def test_safe_int_or_none():
    from vc_engine.util import _safe_int_or_none

    assert _safe_int_or_none("5") == 5
    assert _safe_int_or_none("5.9") == 5
    assert _safe_int_or_none(None) is None
    assert _safe_int_or_none("nope") is None


# --- clinvar (pure classifiers / parsers / accessors / link builders) ---

def test_clinvar_sig_is_pathogenic_or_likely_pathogenic():
    from vc_engine.clinvar import _clinvar_sig_is_pathogenic_or_likely_pathogenic as p

    assert p("Pathogenic")
    assert p("Likely pathogenic")
    assert not p("Benign")
    assert not p("Conflicting interpretations of pathogenicity")
    assert not p("")


def test_clingen_gene_lookup_presence_without_haplo_score():
    from vc_engine.state import clingen_db, clingen_gene_lookup

    clingen_db.clear()
    clingen_db['MAOA'] = ''
    key, raw = clingen_gene_lookup('MAOA')
    assert key == 'MAOA'
    assert raw == ''
    clingen_db['BRCA1'] = '3'
    key2, raw2 = clingen_gene_lookup('brca1')
    assert key2 == 'BRCA1'
    assert raw2 == '3'
    assert clingen_gene_lookup('NOTINDB') == (None, None)
    clingen_db.clear()


def test_clinvar_multi_vid_search_url():
    from vc_engine.clinvar import _clinvar_multi_vid_search_url

    # multiple VIDs -> VariationID-qualified OR query (not bare numbers)
    url = _clinvar_multi_vid_search_url(["12345", "67890"])
    assert "12345%5BVariationID%5D" in url or "12345[VariationID]" in url
    assert "67890%5BVariationID%5D" in url or "67890[VariationID]" in url
    # single VID -> direct variation page
    assert _clinvar_multi_vid_search_url(["12345"]).endswith("/variation/12345/")
    assert _clinvar_multi_vid_search_url([]) == ""


def test_clinvar_gene_plp_search_url():
    from vc_engine.clinvar import _clinvar_gene_plp_search_url

    assert _clinvar_gene_plp_search_url("AMT").startswith(
        "https://www.ncbi.nlm.nih.gov/clinvar/?term=AMT"
    )
    assert _clinvar_gene_plp_search_url("") == ""


def test_clinvar_hit_accessors():
    from vc_engine.clinvar import (
        _clinvar_variant_id_from_hit,
        _clinvar_coding_hgvs_from_hit,
    )

    hit = {
        "clinvar": {"variant_id": 12345, "hgvs": {"coding": "NM_0:c.1A>G"}},
    }
    assert _clinvar_variant_id_from_hit(hit) == "12345"
    coding = _clinvar_coding_hgvs_from_hit(hit)
    assert "c.1A>G" in (coding[0] if isinstance(coding, list) else coding)


def test_plp_region_clinvar_list_url_skips_hgmd():
    from vc_engine.clinvar import _plp_region_clinvar_list_url

    hits = [
        {"clinvar_vid": "111", "source": "clinvar"},
        {"clinvar_vid": "", "source": "hgmd"},
    ]
    url = _plp_region_clinvar_list_url(hits)
    assert url.endswith("/variation/111/")


def test_plp_region_matched_clinvar_link_html_counts_clinvar_only():
    from vc_engine.clinvar import _plp_region_matched_clinvar_link_html

    hits = [
        {"source": "clinvar"},
        {"source": "clinvar"},
        {"source": "hgmd"},
    ]
    html_frag = _plp_region_matched_clinvar_link_html(hits, "http://x/")
    assert "Matched variants (2)" in html_frag
    assert _plp_region_matched_clinvar_link_html(hits, "") == ""


# --- hgmd merge helpers (shared-state catalogue) ---

def test_merge_hgmd_downstream_and_skipped_exon():
    import vc_engine.hgmd as h

    saved = list(h.GLOBAL_HGMD_POSITIONAL_ENTRIES)
    try:
        h.GLOBAL_HGMD_POSITIONAL_ENTRIES.clear()
        h.GLOBAL_HGMD_POSITIONAL_ENTRIES.append(
            {
                "gene": "AMT",
                "c_dot_norm": "878-1g>a",
                "hgvs_c": "c.878-1G>A",
                "tag": "DM",
                "positions": [293],
            }
        )
        downstream = []
        h._merge_hgmd_downstream_hits(downstream, "AMT", 100)
        assert len(downstream) == 1
        assert downstream[0]["source"] == "hgmd"
        assert downstream[0]["position"] == 293

        # outside the residue range -> no hit
        none_hits = []
        h._merge_hgmd_downstream_hits(none_hits, "AMT", 500)
        assert none_hits == []

        skipped = []
        h._merge_hgmd_skipped_exon_hits(skipped, "AMT", 290, 300)
        assert len(skipped) == 1
        assert skipped[0]["c_dot_norm"] == "878-1g>a"
    finally:
        h.GLOBAL_HGMD_POSITIONAL_ENTRIES.clear()
        h.GLOBAL_HGMD_POSITIONAL_ENTRIES.extend(saved)


def test_canonical_splice_junction_pre_atg_acceptor():
    from vc_engine.splice import _canonical_splice_junction_from_hgvs

    cj = _canonical_splice_junction_from_hgvs("c.-37-1G>T")
    assert cj is not None
    assert cj["site"] == "acceptor"
    assert cj["offset"] == 1
    assert cj["anchor"] == -37

    assert _canonical_splice_junction_from_hgvs("c.1387-1G>A")["site"] == "acceptor"
    assert _canonical_splice_junction_from_hgvs("c.4206+1G>A")["site"] == "donor"
    assert _canonical_splice_junction_from_hgvs("c.-37G>A") is None


def test_collagen_junction_map_all_col_missense():
    from vc_engine.analyze import _collagen_gly_junction_align_eligible

    gly = {
        'gene': 'COL4A1',
        'consequence': 'missense',
        'hgvs_p': 'p.Gly1234Ser',
        'cds_seq': 'ATG' + ('GGT' * 500),
    }
    non_gly = {
        'gene': 'COL4A3',
        'consequence': 'missense',
        'hgvs_p': 'p.Leu1550Pro',
        'cds_seq': 'ATG' + ('GGT' * 500),
    }
    inframe_y = {
        'gene': 'COL4A1',
        'consequence': 'inframe_deletion',
        'hgvs_p': 'p.Glu651del',
        'c_dot': 'c.1952_1954del',
        'cds_seq': 'ATG' + ('GAA' * 700),
    }
    assert _collagen_gly_junction_align_eligible(gly)
    assert _collagen_gly_junction_align_eligible(non_gly)
    assert _collagen_gly_junction_align_eligible(inframe_y)
    assert not _collagen_gly_junction_align_eligible({**non_gly, 'gene': 'BRCA1'})
    assert not _collagen_gly_junction_align_eligible({**non_gly, 'consequence': 'synonymous_variant'})


def test_collagen_gly_disruption_requires_gly_anchor():
    """3 collagen matrix points apply only when a glycine anchor is removed/substituted."""
    from vc_engine.analyze import (
        _apply_collagen_motif_analysis,
        _collagen_evaluate_motif,
        _collagen_inframe_del_bounds,
        _collagen_motif_message,
        _collagen_residue_triplet_label,
    )
    from unittest.mock import patch

    prot = 'M' + ('GAE' * 15)
    y_idx = 3  # aa4 = E (Y slot in GAE starting at aa2)
    g_idx = 1  # aa2 = G
    y_stats = _collagen_evaluate_motif(prot, [y_idx])
    g_stats = _collagen_evaluate_motif(prot, [g_idx])
    assert y_stats['motif_disrupted']
    assert not y_stats['gly_disrupted']
    assert g_stats['gly_disrupted']

    pd_y = {
        'gene': 'COL4A1',
        'consequence': 'inframe_deletion',
        'hgvs_p': 'p.Glu4del',
        'c_dot': 'c.10_12del',
    }
    msg = _collagen_motif_message(
        pd_y, y_stats, scan_indices=[y_idx], prot_seq=prot,
    )
    assert 'does not remove a glycine anchor' in msg
    assert 'Y' in _collagen_residue_triplet_label(prot, y_idx + 1)

    bounds = _collagen_inframe_del_bounds({
        'hgvs_p': 'p.Glu651del',
        'c_dot': 'c.1952_1954del',
    })
    assert bounds['aa_start'] == 651
    assert bounds['cds_lo'] == 1952
    assert bounds['cds_hi'] == 1954

    long_prot = 'M' + ('GAE' * 220)
    pd_col4 = {
        'gene': 'COL4A1',
        'consequence': 'inframe_deletion',
        'hgvs_p': 'p.Glu651del',
        'c_dot': 'c.1952_1954del',
        'cds_seq': 'ATG' + ('GAA' * 700),
        'ensembl_transcript_id': 'ENST00000375820',
    }
    with patch('vc_engine.analyze._collagen_fetch_protein_sequence', return_value=long_prot):
        _apply_collagen_motif_analysis(pd_col4)
    assert pd_col4.get('collagen_math')
    assert not pd_col4.get('collagen_disrupted')

    pd_gly_del = {
        'gene': 'COL4A1',
        'consequence': 'inframe_deletion',
        'hgvs_p': 'p.Gly2del',
        'c_dot': 'c.4_6del',
        'cds_seq': 'ATG' + ('GAA' * 20),
        'ensembl_transcript_id': 'ENST00000375820',
    }
    with patch('vc_engine.analyze._collagen_fetch_protein_sequence', return_value=prot):
        _apply_collagen_motif_analysis(pd_gly_del)
    assert not pd_col4.get('collagen_disrupted')
    assert pd_gly_del.get('collagen_disrupted')


def test_collagen_inframe_del_gly_xy_map():
    from unittest.mock import patch

    from vc_engine.analyze import _build_collagen_gly_junction_align_viz

    long_prot = 'M' + ('GAE' * 220)
    pd = {
        'gene': 'COL4A1',
        'consequence': 'inframe_deletion',
        'hgvs_p': 'p.Glu651del',
        'c_dot': 'c.1952_1954del',
        'cds_seq': 'ATG' + ('GAA' * 700),
        'collagen_math': (
            'Collagen Motif Analysis -> Meets ≥9 consecutive Gly-X-Y repeats natively '
            '(maximum block at variant site: 220 repeats). In-frame change in native '
            'Gly-X-Y register (G649–A650–E651 (Y)) does not remove a glycine anchor '
            '— no collagen motif score.'
        ),
        'collagen_native_block_repeats': 220,
        'collagen_block_aa_lo': 2,
        'collagen_block_aa_hi': 661,
    }
    with patch('vc_engine.analyze._collagen_fetch_protein_sequence', return_value=long_prot):
        viz = _build_collagen_gly_junction_align_viz(pd)
    assert viz['eligible']
    assert viz['map_type'] == 'collagen_gly'
    assert viz['collagen_gly_xy']['inframe_deletion']
    assert viz['collagen_gly_xy']['variant_at_gly'] is False
    assert len(viz['tracks']) == 4


def test_non_col_inframe_del_skips_gly_xy_map():
    """NIPBL-style in-frame del must not open the collagen Gly-X-Y launcher."""
    from vc_engine.analyze import _build_collagen_gly_junction_align_viz

    viz = _build_collagen_gly_junction_align_viz(
        {
            'gene': 'NIPBL',
            'consequence': 'inframe_deletion',
            'hgvs_p': 'p.E2244del',
            'c_dot': 'c.6732_6734del',
            'cds_seq': 'N' * 7000,
            'protein_start': 2244,
        }
    )
    assert viz.get('eligible') is False
    assert 'COL' in (viz.get('reason') or '')


def test_nipbl_clinvar_microsatellite_name_score():
    """ClinVar c.6726AGA[2] is the same allele as lab c.6732_6734del."""
    from vc_engine.analyze import (
        _clinvar_variation_name_score,
        _genomic_intervals_near_or_overlap,
    )

    name = 'NM_133433.4(NIPBL):c.6726AGA[2] (p.Glu2244del)'
    score = _clinvar_variation_name_score(
        name, 'NIPBL', 'NM_133433.4', 'c.6732_6734del', hgvs_p='p.E2244del'
    )
    assert score >= 70
    # VEP right-shifted vs ClinVar left-shifted indel coords
    assert _genomic_intervals_near_or_overlap(37048643, 37048646, 37048637, 37048639, 30)


def test_deep_intronic_pre_atg_utr_pseudoexon_outcome():
    """5′ UTR pseudo-exon before AUG must not be labeled out-of-frame / PTC."""
    import vc_engine.splice as sp

    pd = {'first_mrna_exon_is_non_coding': True, 'c_dot': 'c.29-890C>T'}
    coding_exons = [{'anatomical_rank': 2, 'start_cds': 1, 'end_cds': 100}]
    details = {'intron_index_1based': 1}
    cx = {'anatomical_rank': 1, 'start_cds': 0, 'end_cds': 0, 'non_coding_upstream': True}
    assert sp._deep_intronic_insert_is_pre_atg(pd, coding_exons, details, cx)
    co = sp._pre_atg_utr_pseudoexon_outcome(
        'ATCCCCTCTCTGTGGCA',
        coding_exons,
        pd,
        anchor_exon_rank=1,
        downstream_exon_rank=2,
        model_label='nearest_intronic_ag',
    )
    assert co['pre_atg_utr_pseudoexon']
    assert not co.get('fs_ter_str')
    html = sp._format_splice_product_outcome_html(co, pd, product_role='Product 1 (primary)')
    low = html.lower()
    assert 'out-of-frame' not in low
    assert '5' in html and 'utr' in low
    assert 'unchanged' in low or 'not applicable' in low


def test_deep_intronic_c932_minus_not_pre_atg():
    """Deep ORF c.N− (CSMD1 c.932-2692) must not be labeled 5′ UTR / pre-AUG."""
    import vc_engine.splice as sp

    pd = {'c_dot': 'c.932-2692T>A', 'gene_symbol': 'CSMD1'}
    coding_exons = [
        {'anatomical_rank': i, 'start_cds': (i - 1) * 200 + 1, 'end_cds': i * 200}
        for i in range(1, 8)
    ]
    details = {'intron_index_1based': 6}
    assert not sp._deep_intronic_cdot_in_pre_first_coding_intron('c.932-2692T>A', coding_exons, details)
    cx = sp._deep_intronic_donor_gain_anchor_exon(pd, coding_exons, details)
    assert cx and cx.get('anatomical_rank') == 6
    assert not sp._deep_intronic_insert_is_pre_atg(pd, coding_exons, details, cx)


def test_deep_intronic_pre_atg_without_first_mrna_flag():
    """INTS11-like geometry must be pre-AUG even when Ensembl UTR flag is missing."""
    import vc_engine.splice as sp

    pd = {'c_dot': 'c.29-890C>T'}  # no first_mrna_exon_is_non_coding
    coding_exons = [{'anatomical_rank': 2, 'start_cds': 1, 'end_cds': 100}]
    details = {'intron_index_1based': 1}
    cx = sp._deep_intronic_donor_gain_anchor_exon(pd, coding_exons, details)
    assert cx and cx.get('non_coding_upstream') and cx.get('anatomical_rank') == 1
    assert sp._deep_intronic_insert_is_pre_atg(pd, coding_exons, details, cx)
    assert sp._deep_intronic_cdot_in_pre_first_coding_intron('c.29-890C>T', coding_exons, details)
    co = sp._pre_atg_utr_pseudoexon_outcome(
        'ATCCCCTCTCTGTGGCA',
        coding_exons,
        pd,
        anchor_exon_rank=1,
        downstream_exon_rank=2,
        model_label='nearest_intronic_ag',
    )
    co['pseudoexon_geometry'] = {
        'model': 'nearest_intronic_ag',
        'mechanism': 'donor_gain',
        'body_nt': 17,
        'span_nt': 21,
        'body_start_0based': 2577,
        'body_end_0based': 2594,
        'pre_atg_utr': True,
        'downstream_exon_rank': 2,
        'anchor_exon_rank': 1,
    }
    html = sp._format_splice_product_outcome_html(co, pd, product_role='Product 1 (primary)')
    low = html.lower()
    assert 'out-of-frame' not in low
    assert 'p.gly10' not in low
    assert '5' in html and 'utr' in low
    assert 'spliced into orf' not in low.replace('not translated as part of the annotated orf', '')


def test_reconcile_deep_intronic_pre_atg_from_wrong_coding_outcome():
    """Repair stored coding PTC outcome when HGVS shows pre-AUG intron 1 (INTS11)."""
    import vc_engine.splice as sp

    pd = {
        'c_dot': 'c.29-890C>T',
        'deep_intronic_splice_products_active': True,
        'deep_intronic_splice': {'details': {'intron_index_1based': 1}},
        'coding_exons': [{'anatomical_rank': 2, 'start_cds': 1, 'end_cds': 100}],
        'deep_intronic_spliceai_signal_plan': {'primary': {'kind': 'donor_gain', 'ds': 0.46, 'dp': 2}},
        'deep_intronic_primary_outcome': {
            'shift_nt': 17,
            'inserted_cdna': 'ATCCCCTCTCTGTGGCA',
            'cryptic_type': 'Donor gain',
            'fs_ter_str': 'p.Gly10Aspfs*53',
            'in_frame_shift': False,
            'pseudoexon_geometry': {'model': 'nearest_intronic_ag', 'pre_atg_utr': False},
        },
        'cryptic_inserted_cdna': 'ATCCCCTCTCTGTGGCA',
    }
    assert sp._reconcile_deep_intronic_pre_atg_outcome(pd)
    co = pd['deep_intronic_primary_outcome']
    assert co.get('pre_atg_utr_pseudoexon')
    assert not co.get('fs_ter_str')
    assert 'p.Gly10' not in (pd.get('deep_intronic_primary_splice_math') or '')


def test_junction_align_pre_atg_utr_no_ptc_track():
    import vc_engine.splice as sp

    co = sp._pre_atg_utr_pseudoexon_outcome('ATCCCCTCTCTGTGGCA', [], {}, anchor_exon_rank=1, downstream_exon_rank=2)
    bases = [{'nt': 'A', 'kind': 'utr_extension', 'hgvs': 'c.28+1'}]
    prod = sp._junction_align_product_from_co(
        co,
        title='Product — donor gain',
        bases=bases,
        span_label='+17 nt 5\u2032 UTR',
    )
    assert prod['summary'] == '5\u2032 UTR insert — ORF unchanged'
    assert not any(s.get('kind') == 'ptc' for s in prod.get('spans') or [])
    assert sp._junction_align_ptc_marker(bases, co) is None


def test_junction_align_acceptor_gain_ptc_in_pseudoexon():
    import vc_engine.splice as sp

    ins = 'TTTCCAT'
    cds = 'A' * 2249 + 'GATGAATCTTCAAG' + 'N' * 40
    co = {
        'shift_nt': 7,
        'ptc_aa_position': 753,
        'first_changed_aa_pos': 751,
        'fs_ter_str': 'p.Asp751Phefs*2',
        'ptc_within_insert': True,
        'ptc_in_pseudoexon_nt': True,
        'ptc_fraction_in_insert': 0.86,
        'ptc_location_kind': 'pseudo_exon',
    }
    bases, spans, _markers = sp._junction_align_mature_acceptor_gain_bases(
        ins, cds, 2250, exon_rank=17,
        upstream_end_cds=2249, upstream_exon_rank=16,
    )
    assert len(bases) == 12 + 7 + 14
    assert spans[0]['kind'] == 'exon'
    assert 'exon 16' in spans[0]['label']
    assert spans[1]['end'] - spans[1]['start'] == 7
    ptc = sp._junction_align_ptc_marker_product(
        bases, co, insert_len=7, track_origin_cds_0based=2249,
        display_prefix_len=12,
    )
    assert ptc and not ptc.get('off_window')
    assert ptc['start'] >= 12
    assert ptc['end'] <= 19, ptc


def test_acceptor_gain_retained_body_strips_duplicate_exon_g():
    import vc_engine.splice as sp

    cds = 'A' * 2249 + 'GATGAATCTTCAAG'
    assert sp._acceptor_gain_mature_retained_body(
        'TTTCCATG', cds_seq=cds, downstream_start_0=2249, target_body_nt=7,
    ) == 'TTTCCAT'
    assert sp._acceptor_gain_mature_retained_body(
        'TTTTCCAT', cds_seq=cds, downstream_start_0=2249, target_body_nt=7,
    ) == 'TTTCCAT'
    assert sp._acceptor_gain_mature_retained_body(
        'GTTTTCCAT', cds_seq=cds, downstream_start_0=2249, target_body_nt=7,
    ) == 'TTTCCAT'
    assert sp._acceptor_gain_mature_retained_body(
        'GTTTCCAT', cds_seq=cds, downstream_start_0=2249, target_body_nt=7,
    ) == 'TTTCCAT'
    assert sp._acceptor_gain_mature_retained_body(
        'GTTTCCAT', cds_seq=cds, downstream_start_0=2249, target_body_nt=8,
    ) == 'TTTCCAT'


def test_junction_align_acceptor_gain_no_leading_g_when_shift_nt_wrong():
    import vc_engine.splice as sp

    cds = 'A' * 2249 + 'GATGAATCTTCAAG' + 'N' * 40
    co = {
        'shift_nt': 8,
        'inserted_cdna': 'GTTTCCAT',
        'pseudoexon_geometry': {'body_nt': 8},
    }
    bases, spans, _markers = sp._junction_align_mature_acceptor_gain_bases(
        'GTTTCCAT', cds, 2250, exon_rank=17,
        upstream_end_cds=2249, upstream_exon_rank=16, co=co,
    )
    pseudo = [b for b in bases if b.get('kind') == 'exon_extension_intronic']
    assert ''.join(b['nt'] for b in pseudo) == 'TTTCCAT'
    assert bases[12]['nt'] == 'T'
    assert bases[12 + 6]['nt'] == 'T'
    assert bases[12 + 7]['nt'] == 'G'
    assert bases[12 + 7]['kind'] == 'exon'


def test_junction_align_acceptor_gain_geom_body_slice():
    import vc_engine.splice as sp

    mut = 'N' * 6190 + 'TTTCCAT' + 'AG' + 'N' * 20
    cds = 'A' * 2249 + 'GATGAATCTTCAAG' + 'N' * 40
    geom = {
        'body_nt': 7,
        'body_start_0based': 6190,
        'body_end_0based': 6197,
        'junction_proximal_acceptor': True,
    }
    co = {'shift_nt': 7, 'pseudoexon_geometry': geom}
    bases, spans, _ = sp._junction_align_mature_acceptor_gain_bases(
        'GTTTCCAT', cds, 2250, exon_rank=17,
        upstream_end_cds=2249, upstream_exon_rank=16, co=co, mut_seq=mut,
    )
    pseudo = [b for b in bases if b.get('kind') == 'exon_extension_intronic']
    assert len(pseudo) == 7
    assert ''.join(b['nt'] for b in pseudo) == 'TTTCCAT'
    assert spans[1]['end'] - spans[1]['start'] == 7
    assert bases[12 + 7]['nt'] == 'G'
    assert ''.join(b['nt'] for b in bases[12 + 7:12 + 10]) == 'GAT'


def test_junction_align_acceptor_gain_product_no_extra_exon_g():
    import vc_engine.splice as sp

    ins = 'TTTCCATG'
    cds = 'A' * 2249 + 'GATGAATCTTCAAG' + 'N' * 40
    co = {
        'shift_nt': 7,
        'ptc_aa_position': 753,
        'first_changed_aa_pos': 751,
        'fs_ter_str': 'p.Asp751Phefs*2',
        'ptc_within_insert': True,
        'ptc_in_pseudoexon_nt': True,
        'ptc_fraction_in_insert': 0.86,
        'ptc_location_kind': 'pseudo_exon',
        'pseudoexon_geometry': {'body_nt': 7},
    }
    bases, spans, _markers = sp._junction_align_mature_acceptor_gain_bases(
        ins, cds, 2250, exon_rank=17,
        upstream_end_cds=2249, upstream_exon_rank=16, co=co,
    )
    pseudo = [b for b in bases if b.get('kind') == 'exon_extension_intronic']
    assert len(pseudo) == 7
    assert ''.join(b['nt'] for b in pseudo) == 'TTTCCAT'
    assert bases[12 + 7]['nt'] == 'G'
    assert bases[12 + 7]['kind'] == 'exon'
    assert ''.join(b['nt'] for b in bases[12 + 7:12 + 10]) == 'GAT'
    ptc = sp._junction_align_ptc_marker_product(
        bases, co, insert_len=7, track_origin_cds_0based=2249, display_prefix_len=12,
    )
    assert ptc and ptc['end'] <= 19


def test_junction_align_acceptor_gain_no_dup_g_tile_in_pseudo():
    """Trailing/leading exon G must not render as a separate exon tile inside pseudo-exon."""
    import vc_engine.splice as sp

    cds = 'A' * 2249 + 'GATGAATCTTCAAG' + 'N' * 40
    co = {'shift_nt': 8, 'inserted_cdna': 'GTTTCCAT', 'pseudoexon_geometry': {'body_nt': 7}}
    bases, spans, _ = sp._junction_align_mature_acceptor_gain_bases(
        'GTTTCCAT', cds, 2250, exon_rank=17,
        upstream_end_cds=2249, upstream_exon_rank=16, co=co,
    )
    pseudo = [b for b in bases if b.get('kind') == 'exon_extension_intronic']
    assert ''.join(b['nt'] for b in pseudo) == 'TTTCCAT'
    exon_in_pseudo_span = [
        b for i, b in enumerate(bases)
        if 12 <= i < 12 + 7 and b.get('kind') == 'exon'
    ]
    assert not exon_in_pseudo_span
    assert bases[12 + 7]['nt'] == 'G'
    assert bases[12 + 7]['kind'] == 'exon'
    assert len(spans) == 2
    assert spans[1]['kind'] == 'exon_extension'


def test_junction_align_acceptor_gain_no_duplicate_junction_g():
    """When prefix includes c.2250 G, downstream head must not repeat it (TGG bug)."""
    import vc_engine.splice as sp

    cds = 'A' * 2249 + 'GGATGAATCTTCAAG' + 'N' * 40
    bases, spans, _ = sp._junction_align_mature_acceptor_gain_bases(
        'TTTCCAT', cds, 2250, exon_rank=17,
        upstream_end_cds=2250, upstream_exon_rank=16,
        downstream_start_cds=2250,
    )
    pseudo = [b for b in bases if b.get('kind') == 'exon_extension_intronic']
    assert len(pseudo) == 7
    assert ''.join(b['nt'] for b in pseudo) == 'TTTCCAT'
    junction = ''.join(b['nt'] for b in bases[10:22])
    assert 'TGG' not in junction
    assert 'TTTCCATGAT' in junction


def test_build_junction_prefers_deep_intronic_over_stale_ctx():
    import vc_engine.splice as sp

    cds = 'A' * 2249 + 'GATGAATCTTCAAG' + 'N' * 40
    wt = 'GT' + ('N' * 100) + 'TTTCCATAG' + ('N' * 20)
    pd = {
        'gene_symbol': 'MED12L',
        'c_dot': 'c.2250+6051A>T',
        'cds_seq': cds,
        'coding_exons': [
            {'anatomical_rank': 16, 'start_cds': 2200, 'end_cds': 2249},
            {'anatomical_rank': 17, 'start_cds': 2250, 'end_cds': 2300},
        ],
        'variant_exon': 17,
        'deep_intronic_splice_products_active': True,
        'deep_intronic_splice': {
            'eligible': True,
            'details': {'wt_intron_tx_seq': wt, 'mut_intron_tx_seq': wt},
        },
        'deep_intronic_primary_outcome': {
            'cryptic_type': 'Acceptor gain',
            'inserted_cdna': 'GTTTCCAT',
            'shift_nt': 8,
            'fs_ter_str': 'p.Asp751Phefs*2',
            'pseudoexon_geometry': {'body_nt': 7, 'body_start_0based': 102, 'body_end_0based': 109},
        },
        'cryptic_splice_outcome': {
            'cryptic_type': 'Acceptor gain',
            'inserted_cdna': 'GTTTCCAT',
            'junction_align_ctx': {
                'layout': 'acceptor_junction',
                'anchor_c': 2250,
                'exon_rank': 17,
                'ref_bases': [],
                'mut_bases': [],
                'product_bases': [
                    {'nt': 'G', 'kind': 'exon_extension'},
                    {'nt': 'T', 'kind': 'exon_extension'},
                ],
            },
        },
        'junction_align_viz_ctx': {'layout': 'acceptor_junction', 'anchor_c': 2250},
    }
    payload = sp._build_junction_align_payload(pd)
    assert payload.get('eligible')
    ag = next(t for t in payload['tracks'] if t.get('id') == 'acceptor_gain')
    pseudo = [b for b in ag['bases'] if b.get('kind') == 'exon_extension_intronic']
    assert ''.join(b['nt'] for b in pseudo) == 'TTTCCAT'


    import vc_engine.splice as sp

    intron = 'GT' + ('N' * 100) + 'GT' + 'TTTCCAT' + 'AG' + ('N' * 10)
    ag_i = intron.index('TTTCCAT') + 7
    pairs = sp._acceptor_gain_gt_ag_pairs(intron, ag_i)
    assert len(pairs) >= 2
    assert len(pairs[0]['retained']) == 7
    assert len(pairs[0]['retained']) < len(pairs[1]['retained'])
    nxt = sp._acceptor_gain_next_gt_ag_pair(intron, ag_i, pairs[0])
    assert nxt is not None
    assert len(nxt['retained']) > len(pairs[0]['retained'])


def test_format_splice_product_plain_summary_pseudoexon():
    import vc_engine.splice as sp

    co = {
        'shift_nt': 7,
        'cryptic_type': 'Acceptor gain',
        'anchor_exon_rank': 16,
        'downstream_exon_rank': 17,
        'fs_ter_str': 'p.Asp751Phefs*2',
        'nmd_escape': False,
        'truncation_pct': 48.2,
        'retained_pct': 51.8,
        'pseudoexon_geometry': {'body_nt': 7, 'mechanism': 'acceptor_gain'},
    }
    s = sp._format_splice_product_plain_summary(co)
    assert '7 nt pseudo-exon between exons 16 and 17' in s
    assert '+9 nt total junction extension (incl. canonical AG)' in s
    assert 'new PTC (p.Asp751Phefs*2)' in s
    assert 'NMD predicted' in s
    assert '48.2% of protein truncated' in s


def test_junction_extension_dual_label_donor_gain():
    import vc_engine.splice as sp

    co = {
        'shift_nt': 2,
        'inserted_cdna': 'AG',
        'cryptic_type': 'Donor gain',
    }
    sp._annotate_junction_extension_fields(co)
    assert co['orf_body_nt'] == 2
    assert co['total_junction_extension_nt'] == 4
    label = sp._format_junction_length_dual_label(co)
    assert '+2 nt' in label and '+4 nt' in label and 'GT' in label
    html = sp._build_splice_gain_summary_html(co)
    assert 'total junction extension (incl. canonical GT)' in html


def test_exonic_dup_not_deep_intronic_or_pre_atg():
    import vc_engine.splice as sp

    assert sp._hgvs_is_coding_exon_body('c.477dup')
    assert not sp._deep_intronic_should_run('intron_variant', 'c.477dup')
    assert not sp._deep_intronic_should_run('duplication', 'c.477dup')
    coding_exons = [
        {'anatomical_rank': 2, 'start_cds': 1, 'end_cds': 200},
        {'anatomical_rank': 3, 'start_cds': 201, 'end_cds': 800},
    ]
    assert sp._first_coding_mrna_exon_rank(coding_exons) == 2
    pd = {
        'c_dot': 'c.477dup',
        'variant_exon': 3,
        'coding_exons': coding_exons,
        'first_mrna_exon_is_non_coding': True,
    }
    assert not sp._met_reinitiation_applies(
        pd, current_cons='frameshift', current_rank=3, is_first_exon=False,
    )
    assert not sp._deep_intronic_insert_is_pre_atg(pd, coding_exons, {}, None)
    assert not sp._splice_viz_pre_atg_context(pd, coding_exons)
    pd_first = dict(pd, variant_exon=2)
    assert not sp._met_reinitiation_applies(
        pd_first, current_cons='frameshift', current_rank=2, is_first_exon=False,
    )
    assert sp._met_reinitiation_applies(
        pd_first, current_cons='start_lost', current_rank=2, is_first_exon=False,
    )


def test_slc16a2_clinvar_and_hgvs_derive(monkeypatch, tmp_path):
    import requests
    monkeypatch.setenv("VC_DATA_ROOT", str(tmp_path))
    (tmp_path / "clinvar-source").write_text("ncbi\n")
    from vc_engine.analyze import (
        _clinvar_variation_name_score,
        _ensure_derived_hgvs_p_for_inframe,
        _pick_clinvar_from_esearch,
    )
    from vc_engine.hgvs import _hgvs_c_dot_clinvar_equivalent
    from vc_engine.literature import _literature_protein_search_terms

    assert _hgvs_c_dot_clinvar_equivalent('c.467_469del', 'c.461TCT[2]')
    name = 'NM_006517.5(SLC16A2):c.461TCT[2] (p.Phe156del)'
    assert _clinvar_variation_name_score(
        name, 'SLC16A2', 'NM_006517.5', 'c.467_469del', hgvs_p='p.Phe156del',
    ) >= 85
    pd = {'consequence': 'inframe_deletion', 'hgvs_p': ''}
    _ensure_derived_hgvs_p_for_inframe(pd, None, 'c.467_469del')
    assert pd.get('hgvs_p') == 'p.Xaa156del'
    terms = _literature_protein_search_terms('p.Phe156del')
    assert any('Phe156del' in t for t in terms)
    s = requests.Session()
    uid, sig, sc = _pick_clinvar_from_esearch(
        s, 'SLC16A2', 'c.467_469del', 'NM_006517.5', hgvs_p='p.Phe156del',
    )
    if uid is None:
        import pytest
        pytest.skip(f'ClinVar ESearch unavailable or empty (score={sc})')
    assert uid == '11641', (uid, sig, sc)


def test_exon_boundary_donor_loss_whole_exon_skip_cdk13():
    """CDK13 c.2543G>A: donor loss at last exon base must not bail with 0 nt deleted."""
    import vc_engine.splice as sp

    cds_len = 3000
    cds = ['C'] * cds_len
    cds[2542] = 'G'  # c.2543 ref
    # Premature stop shortly after exon-7 junction in skip product (OOF from 190 nt exon)
    for i in range(2353, min(cds_len - 2, 2400), 3):
        cds[i:i + 3] = list('AAA')
    cds[2388:2391] = list('TAA')
    cds_seq = ''.join(cds)
    coding_exons = [
        {'start_cds': 2354, 'end_cds': 2543, 'anatomical_rank': 6, 'length_bp': 190,
         'chr': '7', 'start': 40045836, 'end': 40046025},
        {'start_cds': 2544, 'end_cds': 2600, 'anatomical_rank': 7, 'length_bp': 57,
         'chr': '7', 'start': 40047821, 'end': 40047877},
    ]
    pd = {
        'consequence': 'missense',
        'c_dot': 'c.2543G>A',
        'snpeff_cds_pos': 2543,
        'ref': 'G',
        'alt': 'A',
        'protein_length': 1512,
        'transcript_strand': 1,
        'spliceai_ds_ag': 0.0,
        'spliceai_ds_al': 0.10,
        'spliceai_ds_dg': 0.37,
        'spliceai_ds_dl': 0.67,
        'spliceai_dp_ag': 338,
        'spliceai_dp_al': -189,
        'spliceai_dp_dg': 6,
        'spliceai_dp_dl': 0,
        'coding_exons': coding_exons,
        'cds_seq': cds_seq,
    }
    sp._resolve_exon_internal_cryptic_outcome(None, pd)
    cg = pd.get('cryptic_gain_outcome') or {}
    assert cg.get('whole_exon_skip') is True
    assert cg.get('deleted_nt') == 190
    assert cg.get('in_frame') is False
    assert (pd.get('splice_frame_math') or '').strip()
    assert 'whole-exon skip' in (cg.get('narrative') or '').lower()


    import vc_engine.splice as sp

    ins = 'ATCCCCTCTCTGTGGCA'
    cds = 'X' * 28 + 'ATGGGGCCGGCCAGGAC' + 'N' * 40
    bases, markers, spans = sp._junction_align_pre_atg_product_bases(
        ins, cds, 29, 28, upstream_end_cds=28, upstream_exon_rank=1, downstream_exon_rank=2,
    )
    assert len(bases) == 12 + len(ins) + 18
    assert bases[12]['kind'] == 'utr_extension'
    assert bases[12 + len(ins)]['kind'] == 'exon'
    assert bases[12 + len(ins)]['hgvs'] == 'c.29'
    assert any(m.get('kind') == 'start_codon' for m in markers)
    met_idx = next(m['index'] for m in markers if m.get('kind') == 'start_codon')
    assert ''.join(b['nt'] for b in bases[met_idx:met_idx + 3]) == 'ATG'


def test_literature_filter_drops_hallucinated_c_dot():
    import vc_engine.literature as lit

    summary = (
        'FOUND: PMID: 37980560: Mutation: INTS11 c.29-890C>T; '
        'Patients: 2 siblings (homozygous); Disorder: Severe NDD.'
    )
    paper_text = 'Homozygous INTS11 missense variant impairs catalytic activity in two siblings.'
    out = lit._literature_filter_unsupported_allele_blocks(
        summary, paper_text, 'c.29-890C>T',
        empty_sentinel=lit._FUNCTIONAL_NO_STUDIES_SENTINEL,
    )
    assert '37980560' not in out
    assert out == lit._FUNCTIONAL_NO_STUDIES_SENTINEL


def test_refresh_pre_atg_deep_intronic_readouts():
    import vc_engine.splice as sp

    pd = {
        'c_dot': 'c.29-890C>T',
        'deep_intronic_splice_products_active': True,
        'deep_intronic_splice': {'details': {'intron_index_1based': 1}},
        'coding_exons': [{'anatomical_rank': 2, 'start_cds': 1, 'end_cds': 100}],
        'deep_intronic_spliceai_signal_plan': {'primary': {'kind': 'donor_gain', 'ds': 0.46, 'dp': 2}},
        'deep_intronic_primary_outcome': {
            'shift_nt': 17,
            'inserted_cdna': 'ATCCCCTCTCTGTGGCA',
            'fs_ter_str': 'p.Gly10Aspfs*53',
            'pseudoexon_geometry': {'model': 'nearest_intronic_ag'},
        },
        'deep_intronic_viz_primary': {
            'model': 'nearest_intronic_ag',
            'anchor_exon_rank': 1,
            'downstream_exon_rank': 2,
            'pseudoexon_retained_nt': 17,
        },
        'cryptic_inserted_cdna': 'ATCCCCTCTCTGTGGCA',
    }
    assert sp.refresh_pre_atg_deep_intronic_readouts(pd)
    assert pd['deep_intronic_primary_outcome'].get('pre_atg_utr_pseudoexon')
    assert pd['splice_viz']['pre_atg_utr_pseudoexon'] is True
    assert 'Gly10' not in (pd.get('deep_intronic_primary_splice_math') or '')


def test_pre_atg_utr_note_mrna_exon_numbering_vep_ranks():
    """VEP coding-only exon 1 must display as mRNA coding exon 2 when exon 1 is UTR."""
    import vc_engine.splice as sp

    pd = {'c_dot': 'c.29-890C>T', 'first_mrna_exon_is_non_coding': True}
    coding_exons = [{'anatomical_rank': 1, 'start_cds': 1, 'end_cds': 100}]
    co = sp._pre_atg_utr_pseudoexon_outcome(
        'ATCCCCTCTCTGTGGCA', coding_exons, pd, anchor_exon_rank=1,
    )
    note = co['pre_atg_utr_note'].lower()
    assert 'coding exon 2' in note
    assert co['downstream_exon_rank'] == 2


def test_deep_intronic_rna_evidence_table_init():
    """vc_engine/splice must define RNA evidence cache (workbench uses vc_engine without app_v11 globals)."""
    import vc_engine.splice as sp

    assert hasattr(sp, '_DEEP_INTRONIC_RNA_SPLICE_EVIDENCE_CACHE')
    sp._DEEP_INTRONIC_RNA_SPLICE_EVIDENCE_CACHE = None
    table = sp._deep_intronic_rna_evidence_table()
    assert isinstance(table, dict)


def test_deep_intronic_dual_gain_highest_ds_is_primary():
    import vc_engine.splice as sp

    gains = [
        {'kind': 'donor_gain', 'ds': 0.91, 'dp': 0},
        {'kind': 'acceptor_gain', 'ds': 0.89, 'dp': -61},
    ]
    thr = sp.DEEP_INTRONIC_MIN_SPLICE_PREDICTOR
    assert sp._deep_intronic_prefer_acceptor_gain_primary(gains, thr)

    pd = {
        'spliceai_ds_ag': 0.89,
        'spliceai_ds_dg': 0.91,
        'spliceai_dp_ag': -61,
        'spliceai_dp_dg': 0,
        'c_dot': 'c.5+11934A>G',
    }
    plan = sp._deep_intronic_spliceai_signal_plan(pd, thr, c_dot='c.5+11934A>G')
    assert plan['primary']['kind'] == 'donor_gain'
    assert plan['alternate']['kind'] == 'acceptor_gain'


def test_deep_intronic_small_acceptor_delta_keeps_donor_on_c_plus():
    import vc_engine.splice as sp

    pd = {
        'spliceai_ds_ag': 0.89,
        'spliceai_ds_dg': 0.91,
        'spliceai_dp_ag': -8,
        'spliceai_dp_dg': 0,
        'c_dot': 'c.5+11934A>G',
    }
    thr = sp.DEEP_INTRONIC_MIN_SPLICE_PREDICTOR
    plan = sp._deep_intronic_spliceai_signal_plan(pd, thr, c_dot='c.5+11934A>G')
    assert plan['primary']['kind'] == 'donor_gain'
    assert not plan.get('acceptor_delta_sized_primary')


def test_deep_intronic_donor_only_keeps_donor_primary():
    import vc_engine.splice as sp

    pd = {
        'spliceai_ds_dg': 0.85,
        'spliceai_dp_dg': 2,
        'c_dot': 'c.5+500A>G',
    }
    thr = sp.DEEP_INTRONIC_MIN_SPLICE_PREDICTOR
    plan = sp._deep_intronic_spliceai_signal_plan(pd, thr, c_dot='c.5+500A>G')
    assert plan['primary']['kind'] == 'donor_gain'


def test_collagen_gxg_linker_no_motif_score():
    from vc_engine.analyze import (
        _apply_collagen_motif_analysis,
        _collagen_evaluate_motif,
        _collagen_gxg_linker_at_aa,
        _collagen_is_gxg_triplet,
        _collagen_motif_message,
        _collagen_residue_triplet_label,
    )

    # G-X-G linker between two GPR helical runs
    prot = 'M' + ('GPR' * 12) + 'GAG' + ('GPR' * 12)
    assert _collagen_is_gxg_triplet(prot, 37)  # 0-based start of GAG (M + 36 aa)
    linker_aa = 38  # middle residue of GAG (1-based)
    assert _collagen_gxg_linker_at_aa(prot, linker_aa)[0]
    label = _collagen_residue_triplet_label(prot, linker_aa)
    assert 'Gly-X-Gly flexible linker' in label

    stats = _collagen_evaluate_motif(prot, [linker_aa - 1])
    assert stats['in_gxg_linker']
    assert stats['motif_disrupted'] is False

    pd = {'gene': 'COL1A1', 'consequence': 'missense_variant', 'hgvs_p': f'p.Ala{linker_aa}Thr'}
    msg = _collagen_motif_message(pd, stats, scan_indices=[linker_aa - 1])
    assert 'Gly-X-Gly' in msg
    assert '16919298' in msg
    assert 'No theoretical score' in msg

    pd2 = {
        'gene': 'COL1A1',
        'consequence': 'missense_variant',
        'hgvs_p': f'p.Ala{linker_aa}Thr',
        'ensembl_transcript_id': None,
    }
    # Without network fetch, _apply may not run full path — verify evaluate + message only above.


def test_collagen_triplet_role_non_native_not_gly_slot():
    from vc_engine.analyze import (
        _collagen_in_native_block,
        _collagen_residue_triplet_label,
        _collagen_triplet_role_at_aa,
    )

    # Non-collagen-like stretch: no G every third residue
    prot = 'M' + ('ACDEFGHIKLMNPQRSTVWY' * 80)
    aa_pos = 1550
    assert _collagen_triplet_role_at_aa(prot, aa_pos) is None
    assert not _collagen_in_native_block(prot, aa_pos)
    label = _collagen_residue_triplet_label(prot, aa_pos)
    assert 'not a native Gly-X-Y repeat' in label
    assert 'Gly1550' not in label

    # Native-like G-X-Y run (G-P-R repeats)
    col = 'M' + 'GPR' * 20
    assert _collagen_triplet_role_at_aa(col, 2) == 'Gly'
    assert _collagen_triplet_role_at_aa(col, 3) == 'X'
    assert _collagen_in_native_block(col, 3)


def test_junction_align_donor_secondary_exon_skip_track():
    from vc_engine.splice import (
        _junction_align_secondary_products,
        _junction_align_secondary_products_for_donor,
    )

    pd = {
        'gene': 'PPP2R1A',
        'c_dot': 'c.1661+1G>A',
        'consequence': 'splice_donor_variant',
        'spliceai_ds_dl': 0.85,
        'spliceai_ds_dg': 0.72,
        'splice_frame_math': 'Whole-exon skip baseline',
        'exon_skip_oof_fs_ter': 'p.Glu554fs',
        'variant_exon': 12,
        'cds_seq': 'ATG' + 'A' * 6000,
        'coding_exons': [{
            'anatomical_rank': 12,
            'start_cds': 1651,
            'end_cds': 1800,
            'chr': '11',
            'start': 1,
            'end': 100,
        }],
    }
    ctx = {'anchor_c': 1800, 'exon_rank': 13, 'upstream_exon': 12}
    extras = _junction_align_secondary_products_for_donor(pd, ctx)
    assert len(extras) == 1
    assert extras[0]['id'] == 'exon_skip_secondary'
    assert 'donor loss' in extras[0]['title'].lower()
    assert extras[0]['bases']

    routed = _junction_align_secondary_products(pd, ctx)
    assert len(routed) == 1


def test_junction_align_secondary_cryptic_gain_on_exon_skip_primary():
    from vc_engine.splice import (
        _build_junction_align_payload,
        _junction_align_secondary_cryptic_gain_products,
        _stash_secondary_cryptic_gain_before_strip,
    )

    ctx = {
        'layout': 'donor_junction',
        'anchor_c': 87,
        'mut_bases': [{'nt': 'G', 'kind': 'exon', 'hgvs': 'c.87'}],
        'mut_spans': [],
        'mut_markers': [],
        'product_bases': [{'nt': 'A', 'kind': 'exon_extension', 'hgvs': 'c.87+1'}],
    }
    co = {
        'shift_nt': 14,
        'inserted_cdna': 'A' * 14,
        'cryptic_type': 'Donor Gain',
        'junction_align_ctx': ctx,
        'fs_ter_str': 'p.Arg29fs',
    }
    pd = {
        'gene': 'ATP5MK',
        'c_dot': 'c.87+2dup',
        'consequence': 'splice_donor_variant',
        'spliceai_ds_dg': 0.47,
        'spliceai_ds_dl': 0.96,
        'spliceai_exon_skip_spliceai_primary': True,
        'splice_frame_math': 'Whole-exon skip — in-frame',
        'variant_exon': 3,
        'cds_seq': 'ATG' + 'N' * 200,
        'coding_exons': [{
            'anatomical_rank': 3,
            'start_cds': 74,
            'end_cds': 87,
            'chr': '1',
            'start': 1,
            'end': 100,
        }, {
            'anatomical_rank': 4,
            'start_cds': 88,
            'end_cds': 120,
            'chr': '1',
            'start': 101,
            'end': 200,
        }],
    }
    _stash_secondary_cryptic_gain_before_strip(pd, co, True, False, 0.0, 0.96, 0.47, 0.96)
    assert pd.get('spliceai_secondary_gain_product')
    extras = _junction_align_secondary_cryptic_gain_products(pd)
    assert len(extras) >= 1
    assert any(e.get('id') == 'cryptic_gain_secondary' for e in extras)

    pd.update({
        'spliceai_secondary_cryptic_outcome': co,
        'spliceai_secondary_gain_product': True,
    })
    payload = _build_junction_align_payload(pd)
    assert payload.get('eligible')
    track_ids = [t.get('id') for t in payload.get('tracks') or []]
    assert 'cryptic_gain_secondary' in track_ids


def test_splice_viz_secondary_gain_row_when_exon_skip_primary():
    from vc_engine.splice import _build_splice_viz_payload

    pd = {
        'gene_symbol': 'ATP5MK',
        'c_dot': 'c.87+2dup',
        'consequence': 'splice_donor_variant',
        'spliceai_fetched': True,
        'spliceai_exon_skip_spliceai_primary': True,
        'spliceai_secondary_gain_product': True,
        'spliceai_secondary_cryptic_outcome': {
            'shift_nt': 14,
            'inserted_cdna': 'A' * 14,
        },
        'splice_frame_math': 'skip math',
        'splice_is_in_frame': True,
        'variant_exon': 3,
        'coding_exons': [{
            'anatomical_rank': 1,
            'start_cds': 1,
            'end_cds': 30,
            'chr': '1',
            'start': 1,
            'end': 50,
        }, {
            'anatomical_rank': 2,
            'start_cds': 31,
            'end_cds': 73,
            'chr': '1',
            'start': 51,
            'end': 100,
        }, {
            'anatomical_rank': 3,
            'start_cds': 74,
            'end_cds': 87,
            'chr': '1',
            'start': 101,
            'end': 150,
        }, {
            'anatomical_rank': 4,
            'start_cds': 88,
            'end_cds': 120,
            'chr': '1',
            'start': 151,
            'end': 200,
        }],
        'cds_seq': 'ATG' + 'A' * 200,
    }
    viz = _build_splice_viz_payload(pd)
    assert viz.get('eligible')
    assert viz.get('junction_row') is True
    assert viz.get('spliceai_secondary_gain_product') is True
    assert viz.get('row_order') == 'ref_skip_junction'


def test_splice_viz_secondary_gain_row_schematic_when_no_cryptic_outcome():
    """Exon-skip primary + DS_DG secondary without resolved co_sec still shows junction row."""
    from vc_engine.splice import (
        _build_splice_viz_payload,
        _spliceai_exon_skip_takes_precedence_over_weak_cryptic,
    )

    pd = {
        'gene_symbol': 'KDM6A',
        'c_dot': 'c.1683+2T>G',
        'consequence': 'splice_donor_variant',
        'spliceai_fetched': True,
        'spliceai_ds_dl': 0.99,
        'spliceai_ds_dg': 0.39,
        'spliceai_ds_ag': 0.0,
        'spliceai_ds_al': 0.0,
        'spliceai_dp_dg': 0,
        'spliceai_dp_dl': 0,
        'splice_is_in_frame': True,
        'splice_frame_math': 'in-frame skip',
        'variant_exon': 16,
        'ref': 'T',
        'alt': 'G',
        'cds_seq': 'ATG' + 'N' * 5000,
        'transcript_chrom': 'X',
        'transcript_strand': 1,
    }
    exons = []
    for i in range(1, 31):
        exons.append({
            'anatomical_rank': i,
            'start_cds': (i - 1) * 100 + 1,
            'end_cds': i * 100,
            'chr': 'X',
            'start': 1000000 + i * 1000,
            'end': 1000000 + i * 1000 + 500,
        })
    pd['coding_exons'] = exons
    _spliceai_exon_skip_takes_precedence_over_weak_cryptic(pd)
    assert pd.get('spliceai_secondary_gain_product') is True
    assert not pd.get('spliceai_secondary_cryptic_outcome')

    viz = _build_splice_viz_payload(pd)
    assert viz.get('eligible')
    assert viz.get('junction_row') is True
    assert viz.get('spliceai_secondary_gain_product') is True
    assert viz.get('row_order') == 'ref_skip_junction'
    assert (viz.get('pseudoexon_retained_nt') or viz.get('shift_nt')) is not None
    assert viz.get('pseudo_after_rank') == 16
    assert viz.get('anchor_exon_rank') == 16

    from vc_engine.splice import _format_secondary_cryptic_gain_logic_html
    sec_html = _format_secondary_cryptic_gain_logic_html(pd)
    assert 'Secondary product' in sec_html
    assert 'DS_DG' in sec_html
    assert 'pseudo-exon' in sec_html.lower()


def test_maoa_donor_loss_primary_pangolin_gain_secondary():
    """SpliceAI junction donor loss primary; Pangolin deep-intron gain secondary (c.955+5G>A pattern)."""
    from vc_engine.splice import (
        _build_junction_align_payload,
        _format_secondary_cryptic_gain_logic_html,
        _spliceai_exon_skip_takes_precedence_over_weak_cryptic,
    )

    ctx = {
        'exon_rank': 8,
        'anchor_c': 955,
        'upstream_exon': 8,
        'layout': 'donor_junction',
        'mut_bases': [{'nt': 'G', 'kind': 'exon', 'hgvs': 'c.955'}],
        'mut_spans': [],
        'mut_markers': [
            {'index': 15, 'kind': 'splice_loss', 'label': 'canonical GT lost'},
            {'index': 24, 'kind': 'splice_gain', 'label': 'cryptic GT gained'},
        ],
        'product_bases': [{'nt': 'A', 'kind': 'exon_extension', 'hgvs': 'c.955+1'}],
    }
    co = {
        'cryptic_type': 'Donor Gain',
        'shift_nt': 17,
        'inserted_cdna': 'AGACTGCTATTATTCAT',
        'gain_signal': 0.27,
        'loss_signal': 0.4,
        'fs_ter_str': 'p.Glu319fsTer12',
        'junction_align_ctx': ctx,
    }
    pd = {
        'gene_symbol': 'MAOA',
        'c_dot': 'c.955+5G>A',
        'consequence': 'splice_donor_5th_base_variant',
        'spliceai_fetched': True,
        'spliceai_ds_dl': 0.27,
        'spliceai_ds_dg': 0.09,
        'spliceai_dp_dl': -5,
        'spliceai_dp_dg': 69,
        'spliceai_ds_al': 0.38,
        'spliceai_dp_al': -119,
        'pangolin_ds_sl': 0.4,
        'pangolin_ds_sg': 0.27,
        'pangolin_dp_sl': -5,
        'pangolin_dp_sg': 69,
        'cryptic_splice_outcome': co,
        'splice_frame_math': 'Exon 8 OOF skip — p.Cys266fsTer6.',
        'splice_is_in_frame': False,
        'variant_exon': 8,
        'ref': 'G',
        'alt': 'A',
        'cds_seq': 'ATG' + 'N' * 3000,
        'coding_exons': [{
            'anatomical_rank': 8,
            'start_cds': 796,
            'end_cds': 955,
            'chr': 'X',
            'start': 43731800,
            'end': 43731900,
        }, {
            'anatomical_rank': 9,
            'start_cds': 956,
            'end_cds': 1100,
            'chr': 'X',
            'start': 43731901,
            'end': 43732050,
        }],
    }
    _spliceai_exon_skip_takes_precedence_over_weak_cryptic(pd)
    assert pd.get('spliceai_exon_skip_spliceai_primary') is True
    assert not pd.get('cryptic_splice_outcome')
    assert pd.get('spliceai_secondary_gain_product') is True
    assert pd.get('spliceai_secondary_cryptic_outcome', {}).get('shift_nt') == 17
    assert 'Primary (SpliceAI' in (pd.get('splice_frame_math') or '')
    assert 'DS_DL=0.27' in (pd.get('splice_frame_math') or '')

    sec_html = _format_secondary_cryptic_gain_logic_html(pd)
    assert 'Pangolin DS_SG' in sec_html
    assert 'Secondary product' in sec_html

    payload = _build_junction_align_payload(pd)
    assert payload.get('eligible')
    tracks = payload.get('tracks') or []
    track_ids = [t.get('id') for t in tracks]
    assert track_ids.index('reference') < track_ids.index('mutant')
    assert 'cryptic_gain_secondary' in track_ids
    primary_product = next((t for t in tracks if t.get('id') == 'cryptic_product'), None)
    assert primary_product is not None
    assert 'Whole-exon skip' in (primary_product.get('title') or '')
    assert any(t.get('id') == 'cryptic_gain_secondary' for t in tracks)


def test_splice_viz_gain_primary_sets_pseudo_anchor():
    """Gain-primary / competing junction rows anchor pseudo-exon at variant exon."""
    from vc_engine.splice import _build_splice_viz_payload

    pd = {
        'gene_symbol': 'DDX39B',
        'c_dot': 'c.212-8A>G',
        'consequence': 'splice_acceptor_variant',
        'spliceai_fetched': True,
        'spliceai_competing_splice_isoforms': True,
        'spliceai_ds_ag': 0.72,
        'spliceai_ds_al': 0.55,
        'cryptic_splice_outcome': {'shift_nt': 7, 'minimal_signal': False},
        'splice_frame_math': 'competing math',
        'variant_exon': 3,
        'splice_is_in_frame': False,
        'coding_exons': [{
            'anatomical_rank': i,
            'start_cds': (i - 1) * 100 + 1,
            'end_cds': i * 100,
            'chr': '6',
            'start': 1000 + i * 500,
            'end': 1500 + i * 500,
        } for i in range(1, 12)],
    }
    viz = _build_splice_viz_payload(pd)
    assert viz.get('eligible')
    assert viz.get('junction_row') is True
    assert viz.get('pseudoexon_retained_nt') == 7
    assert viz.get('pseudo_after_rank') == 3
    assert viz.get('row_order') == 'ref_junction_skip'


def test_same_canonical_splice_junction_locus():
    from vc_engine.splice import _same_canonical_splice_junction_locus

    assert _same_canonical_splice_junction_locus('c.87+2dup', 'c.87+1G>C')
    assert _same_canonical_splice_junction_locus('c.87+2dup', 'NM_001206427.2:c.87+1G>C')
    assert not _same_canonical_splice_junction_locus('c.87+2dup', 'c.87+2dup')
    assert not _same_canonical_splice_junction_locus('c.87+2dup', 'c.88+1G>C')


def test_near_junction_intron_promotes_to_splice_region():
    """BICRA-style c.151-9 intron_variant should use dual-product splice path."""
    from vc_engine.splice import (
        _apply_near_splice_region_context,
        _canonical_splice_junction_from_hgvs,
        _consequence_is_acceptor_splice,
        _consequence_is_donor_splice,
        _near_junction_intronic_locus,
    )

    assert _canonical_splice_junction_from_hgvs('c.151-9G>A') is None
    loc = _near_junction_intronic_locus('c.151-9G>A')
    assert loc and loc['site'] == 'acceptor' and loc['offset'] == 9
    assert _consequence_is_acceptor_splice('intron_variant', 'c.151-9G>A')
    assert _consequence_is_donor_splice('intron_variant', 'c.100+9G>T')
    assert not _consequence_is_acceptor_splice('intron_variant', 'c.151+40A>G')

    pd = {'consequence': 'intron_variant', 'c_dot': 'c.151-9G>A'}
    _apply_near_splice_region_context(pd)
    assert pd['consequence'] == 'splice_region_variant'
    assert pd.get('near_canonical_splice_junction') is True
    assert pd.get('original_consequence') == 'intron_variant'
    assert _consequence_is_acceptor_splice(pd['consequence'], pd['c_dot'])

    deep = {'consequence': 'intron_variant', 'c_dot': 'c.151+40A>G'}
    _apply_near_splice_region_context(deep)
    assert deep['consequence'] == 'intron_variant'


def test_htra1_donor_plus1_cryptic_gt_at_plus23():
    """HTRA1 c.972+1: SpliceAI Δ≈+21 snaps to cryptic GT at +23 → ~20 nt intron retention."""
    from vc_engine.splice import _junction_spliceai_cryptic_site

    # Local intron oligo around c.972 donor (junction = last exonic C).
    seq = 'TCAACGTGAGCCTCTGTCCCTCTGCGGGTGGGGATTGGGGCAGAGTTTTGC'
    junction = 4  # C
    var_idx = 5   # +1 G
    transcript = seq
    mut = seq[:5] + 'A' + seq[6:]  # +1G>A destroys canonical GT

    pd = {
        'c_dot': 'c.972+1G>A',
        'spliceai_ds_dg': 0.85,
        'spliceai_dp_dg': 21,
        'spliceai_ds_dl': 0.99,
    }
    site, used = _junction_spliceai_cryptic_site(
        pd, mut, transcript, var_idx, False, 1, 'c.972+1G>A', junction,
    )
    assert site is not None
    assert used is True
    assert site - junction == 23
    assert mut[site:site + 2] == 'GT'
    # ORF body excludes canonical GT (+1,+2) and cryptic GT
    retained = mut[junction + 3:site]
    assert len(retained) == 20
    assert retained == 'GAGCCTCTGTCCCTCTGCGG'


def test_junction_secondary_merge():
    from vc_engine.splice import _junction_align_merge_secondary_tracks

    pd = {
        'spliceai_fetched': True,
        'spliceai_ds_ag': 0.45,
        'spliceai_ds_al': 0.55,
        'spliceai_ds_dg': 0.0,
        'spliceai_ds_dl': 0.03,
        'spliceai_secondary_exon_rank': 17,
        'spliceai_secondary_mechanism': '5prime_donor_loss',
        'spliceai_secondary_splice_frame_math': 'Exon 17 skip secondary.',
        'coding_exons': [
            {'anatomical_rank': 17, 'start_cds': 1846, 'end_cds': 2001, 'length_bp': 156},
            {'anatomical_rank': 18, 'start_cds': 2002, 'end_cds': 2251, 'length_bp': 250},
        ],
        'cds_seq': 'A' * 3000,
    }

    payload = {
        'eligible': True,
        'tracks': [{'id': 'reference'}, {'id': 'mutant'}],
    }
    merged = _junction_align_merge_secondary_tracks(pd, payload, primary_kind='exon_skip')
    track_ids = [t.get('id') for t in merged.get('tracks', [])]
    assert 'exon_skip_parallel_secondary' in track_ids


def test_proximal_acceptor_resolves_canonical_junction_alleles():
    from vc_engine.splice import (
        _hit_at_user_splice_junction_locus,
        _primary_splice_affects_canonical_junction,
        _resolve_splice_junction_locus,
        _splice_intronic_locus_from_hgvs,
    )

    pd = {
        'c_dot': 'c.2002-3C>G',
        'consequence': 'splice_region_variant',
        'splice_deleted_coords': {'chr': '17', 'start': 1, 'end': 2},
        'spliceai_ds_al': 0.55,
        'spliceai_ds_ag': 0.45,
    }
    locus = _splice_intronic_locus_from_hgvs('c.2002-3C>G')
    assert locus == {'site': 'acceptor', 'offset': 3, 'kind': 'sub', 'anchor': 2002}
    assert _primary_splice_affects_canonical_junction(pd, locus) is True
    resolved = _resolve_splice_junction_locus('c.2002-3C>G', pd)
    assert resolved and resolved['anchor'] == 2002 and resolved['site'] == 'acceptor'
    assert _hit_at_user_splice_junction_locus('c.2002-3C>G', 'c.2002-1G>A', pd)
    assert _hit_at_user_splice_junction_locus('c.2002-3C>G', 'c.2002-2A>G', pd)
    assert not _hit_at_user_splice_junction_locus('c.2002-3C>G', 'c.2002-14C>G', pd)
    assert _resolve_splice_junction_locus('c.2002-3C>G', None) is None


def test_suppress_start_loss_nmd_for_in_frame_exon_skip():
    from vc_engine.splice import _suppress_start_loss_nmd_for_exon_skip_primary

    pd = {
        'consequence': 'start_lost',
        'original_consequence': 'splice_donor_variant',
        'spliceai_exon_skip_spliceai_primary': True,
        'splice_deleted_coords': {'chr': '10', 'start': 1, 'end': 100},
        'splice_frame_math': 'Exon 3 skip — in-frame',
        'splice_is_in_frame': True,
        'splice_fraction_lost': 0.5,
        'nmd_math': 'Because the premature stop occurs early... Methionine (located at Amino Acid 28)...',
        'next_methionine_position': 28,
    }
    _suppress_start_loss_nmd_for_exon_skip_primary(pd)
    assert pd['consequence'] == 'splice_donor_variant'
    assert pd.get('nmd_math') is None
    assert pd.get('next_methionine_position') is None
    assert pd.get('nmd_escape') is True
    assert 'In-frame whole-exon skip' in (pd.get('nmd_decision_basis') or '')


def test_secondary_cryptic_gain_logic_block_not_parallel_skip():
    from vc_engine.splice import (
        _format_secondary_cryptic_gain_logic_html,
        _spliceai_secondary_acceptor_parallel_exon_skip_math,
    )

    pd = {
        'c_dot': 'c.87+2dup',
        'original_consequence': 'splice_donor_variant',
        'consequence': 'start_lost',
        'spliceai_exon_skip_spliceai_primary': True,
        'spliceai_secondary_gain_product': True,
        'spliceai_ds_dg': 0.47,
        'spliceai_dp_dg': 13,
        'spliceai_secondary_cryptic_outcome': {
            'cryptic_type': 'Donor Gain',
            'shift_nt': 14,
            'inserted_cdna': 'A' * 14,
            'fs_ter_str': 'p.Arg30fs',
            'narrative': 'Donor Gain at +13 bp: +14 nt retained, p.Arg30fs.',
        },
        'coding_exons': [{'anatomical_rank': 3, 'start_cds': 74, 'end_cds': 87}],
        'ensembl_transcript_id': 'ENST00000361866',
        'variant_exon': 3,
        'protein_length': 58,
    }
    html = _format_secondary_cryptic_gain_logic_html(pd)
    assert 'Secondary product' in html
    assert 'Donor Gain' in html or 'donor gain' in html.lower()
    assert 'parallel whole-exon skip' not in html.lower()
    # Parallel acceptor-skip math must not run when cryptic gain secondary is active.
    _spliceai_secondary_acceptor_parallel_exon_skip_math(None, pd, pd['coding_exons'], 'ENST1', False, True)
    assert not pd.get('spliceai_secondary_splice_frame_math')


def test_nr0b1_acceptor_exon_skip_maps():
    """Canonical acceptor c.N-1G>A — whole-exon skip maps (2-exon transcript)."""
    from vc_engine.splice import (
        _build_junction_align_payload,
        _build_splice_viz_payload,
        _junction_align_payload_exon_skip_loss,
    )

    pd = {
        'gene_symbol': 'NR0B1',
        'c_dot': 'c.1169-1G>A',
        'consequence': 'splice_acceptor_variant',
        'ref': 'G',
        'alt': 'A',
        'spliceai_fetched': True,
        'spliceai_exon_skip_spliceai_primary': True,
        'spliceai_ds_al': 0.97,
        'spliceai_ds_ag': 0.09,
        'splice_frame_math': 'Exon 2 length 245 bp: out-of-frame skip.',
        'splice_is_in_frame': False,
        'variant_exon': 2,
        'cds_seq': 'ATG' + 'N' * 1410,
        'transcript_chrom': 'X',
        'transcript_strand': 1,
        'coding_exons': [{
            'anatomical_rank': 1,
            'start_cds': 1,
            'end_cds': 1168,
            'chr': 'X',
            'start': 30304000,
            'end': 30304823,
        }, {
            'anatomical_rank': 2,
            'start_cds': 1169,
            'end_cds': 1413,
            'chr': 'X',
            'start': 30304824,
            'end': 30305068,
        }],
    }
    sv = _build_splice_viz_payload(pd)
    assert sv.get('eligible'), sv.get('reason')
    assert sv.get('target_rank') == 2
    assert sv.get('reference_only') is not True

    ja = _junction_align_payload_exon_skip_loss(pd)
    assert ja.get('eligible'), ja.get('reason')
    track_ids = [t.get('id') for t in ja.get('tracks') or []]
    assert 'reference' in track_ids and 'mutant' in track_ids

    full = _build_junction_align_payload(pd)
    assert full.get('eligible'), full.get('reason')


def test_junction_align_exon_skip_donor_dup():
    from vc_engine.splice import (
        _junction_align_apply_dup,
        _junction_align_bases_hgvs_index,
        _junction_align_flat_bases_donor,
        _junction_align_payload_exon_skip_loss,
    )

    exon_tail = 'TGTG'  # c.84–87
    gt = 'GT'
    intron = 'ACGT' + 'N' * 24
    anchor = 87
    ref_bases = _junction_align_flat_bases_donor(exon_tail, gt, intron, anchor)
    mut_bases = [dict(b) for b in ref_bases]
    mut_spans = []
    ref_spans = []
    pd = {'ref': 'T', 'alt': 'TT', 'c_dot': 'c.87+2dup'}
    assert _junction_align_apply_dup(
        mut_bases, mut_spans, 'c.87+2dup', pd, is_donor=True, ref_spans=ref_spans,
    )
    assert len(mut_bases) == len(ref_bases) + 1
    assert mut_spans[0]['kind'] == 'dup'
    assert ref_spans[0]['kind'] == 'dup'
    # Inserted T sits immediately 3′ of c.87+2 (second base of GT).
    gt_t_idx = _junction_align_bases_hgvs_index(ref_bases, 'c.87+2')
    assert mut_bases[gt_t_idx + 1]['nt'] == 'T'

    skip_pd = {
        'gene': 'ATP5MK',
        'c_dot': 'c.87+2dup',
        'consequence': 'splice_donor_variant',
        'ref': 'T',
        'alt': 'TT',
        'splice_frame_math': 'Whole-exon skip — in-frame',
        'variant_exon': 3,
        'cds_seq': 'ATG' + 'N' * 200,
        'coding_exons': [{
            'anatomical_rank': 3,
            'start_cds': 74,
            'end_cds': 87,
            'chr': '1',
            'start': 1,
            'end': 100,
        }, {
            'anatomical_rank': 4,
            'start_cds': 88,
            'end_cds': 120,
            'chr': '1',
            'start': 101,
            'end': 200,
        }],
    }
    payload = _junction_align_payload_exon_skip_loss(skip_pd)
    assert payload.get('eligible'), payload.get('reason')
    mut_track = next(t for t in payload['tracks'] if t['id'] == 'mutant')
    ref_track = next(t for t in payload['tracks'] if t['id'] == 'reference')
    assert len(mut_track['bases']) > len(ref_track['bases'])
    assert any(s.get('kind') == 'dup' for s in mut_track['spans'])
    assert any(s.get('kind') == 'dup' for s in ref_track['spans'])


def test_junction_align_exon_skip_donor_exon_intron_del():
    """c.N_N+Mdel at donor — deletion must appear on the primary mutant track."""
    from vc_engine.splice import _junction_align_payload_exon_skip_loss

    exon_tail = 'AAAGCAT'  # c.81–87
    cds = 'ATG' + ('N' * 73) + exon_tail + ('G' * 113)
    skip_pd = {
        'gene': 'DICER1',
        'c_dot': 'c.87_87+4del',
        'consequence': 'splice_donor_variant',
        'splice_frame_math': 'Exon 14 length 140 bp: out-of-frame skip.',
        'spliceai_exon_skip_spliceai_primary': True,
        'variant_exon': 14,
        'cds_seq': cds,
        'coding_exons': [{
            'anatomical_rank': 14,
            'start_cds': 1,
            'end_cds': 87,
            'chr': '14',
            'start': 1,
            'end': 100,
        }, {
            'anatomical_rank': 15,
            'start_cds': 88,
            'end_cds': 200,
            'chr': '14',
            'start': 101,
            'end': 200,
        }],
    }
    payload = _junction_align_payload_exon_skip_loss(skip_pd)
    assert payload.get('eligible'), payload.get('reason')
    mut_track = next(t for t in payload['tracks'] if t['id'] == 'mutant')
    ref_track = next(t for t in payload['tracks'] if t['id'] == 'reference')
    assert len(mut_track['bases']) == len(ref_track['bases']) - 5
    assert any(s.get('kind') == 'variant' for s in mut_track.get('spans') or [])
    assert any(s.get('kind') == 'variant' for s in ref_track.get('spans') or [])


def test_junction_snap_cryptic_gain_finds_gt_not_ac():
    """Predicted +bp on AC must snap to nearest GT, not highlight AC."""
    from vc_engine.splice import _junction_align_snap_cryptic_gain_index

    seq = 'GCGTATTGGTTAGAACAGAGT'
    bases = [{'nt': nt, 'kind': 'intron' if i >= 2 else 'exon'} for i, nt in enumerate(seq)]
    idx = _junction_align_snap_cryptic_gain_index(
        bases, 14, is_donor=True, min_idx=3, inserted_cdna='TATTGGTTAGAACAGA',
    )
    assert idx != 14  # must not stay on AC dinucleotide
    assert seq[idx:idx + 2] == 'GT'


def test_junction_mark_all_intronic_gt_except_primary_gain():
    """Other intronic GT dinucleotides get yellow splice_gt; only primary stays splice_gain."""
    from vc_engine.splice import (
        _junction_align_cryptic_gain_on_exon_skip_mutant,
        _junction_align_mark_intronic_splice_dinucs,
    )

    seq = 'GCGTATTGGTTAGAACAGAGT'
    bases = [{'nt': nt, 'kind': 'intron' if i >= 2 else 'exon'} for i, nt in enumerate(seq)]
    marked = _junction_align_mark_intronic_splice_dinucs(
        bases, is_donor=True, primary_gain_idx=19, intron_start=2, intron_end=20,
    )
    gt_sites = [
        i for i in range(len(marked) - 1)
        if marked[i].get('kind') == 'splice_gt' and marked[i + 1].get('kind') == 'splice_gt'
    ]
    assert 2 in gt_sites
    assert 8 in gt_sites
    assert 19 not in gt_sites

    skip_mut = {'bases': bases, 'spans': []}
    mut_bases, markers = _junction_align_cryptic_gain_on_exon_skip_mutant(
        skip_mut,
        {'anchor_c': 2256, 'mut_bases': [], 'mut_markers': []},
        {'transcript_strand': 1, 'spliceai_dp_dg': -16},
        {'inserted_cdna': 'TATTGGTTAGAACAGA'},
        is_don=True,
    )
    gain = [m for m in markers if m.get('kind') == 'splice_gain']
    assert len(gain) == 1
    assert 2 in gt_sites or any(
        mut_bases[i].get('kind') == 'splice_gt' for i in range(2, 18)
    )


def test_junction_cryptic_gain_reuses_exon_skip_mutant_window():
    """Cryptic pre-mRNA must share the primary skip track window; donor gain marks GT."""
    from vc_engine.splice import (
        _junction_align_cryptic_gain_on_exon_skip_mutant,
        _junction_align_secondary_cryptic_product_bases,
    )

    skip_mut = {
        'bases': [
            {'nt': 'G', 'kind': 'exon', 'hgvs': 'c.2243'},
            {'nt': 'C', 'kind': 'exon', 'hgvs': 'c.2255'},
            {'nt': 'G', 'kind': 'intron', 'hgvs': 'c.2256+5'},
            {'nt': 'T', 'kind': 'intron', 'hgvs': 'c.2256+6'},
            {'nt': 'A', 'kind': 'intron', 'hgvs': 'c.2256+7'},
            {'nt': 'T', 'kind': 'intron', 'hgvs': 'c.2256+8'},
            {'nt': 'T', 'kind': 'intron', 'hgvs': 'c.2256+9'},
            {'nt': 'G', 'kind': 'intron', 'hgvs': 'c.2256+10'},
            {'nt': 'G', 'kind': 'intron', 'hgvs': 'c.2256+11'},
            {'nt': 'T', 'kind': 'intron', 'hgvs': 'c.2256+12'},
            {'nt': 'T', 'kind': 'intron', 'hgvs': 'c.2256+13'},
            {'nt': 'A', 'kind': 'intron', 'hgvs': 'c.2256+14'},
            {'nt': 'G', 'kind': 'intron', 'hgvs': 'c.2256+15'},
            {'nt': 'A', 'kind': 'intron', 'hgvs': 'c.2256+16'},
            {'nt': 'A', 'kind': 'intron', 'hgvs': 'c.2256+17'},
            {'nt': 'C', 'kind': 'intron', 'hgvs': 'c.2256+18'},
            {'nt': 'A', 'kind': 'intron', 'hgvs': 'c.2256+19'},
            {'nt': 'G', 'kind': 'intron', 'hgvs': 'c.2256+20'},
            {'nt': 'A', 'kind': 'intron', 'hgvs': 'c.2256+21'},
            {'nt': 'G', 'kind': 'intron', 'hgvs': 'c.2256+22'},
            {'nt': 'T', 'kind': 'intron', 'hgvs': 'c.2256+23'},
        ],
        'spans': [{'start': 1, 'end': 3, 'kind': 'variant', 'label': '5 nt deleted'}],
    }
    cryptic_ctx = {'anchor_c': 2256, 'mut_bases': [], 'mut_markers': []}
    pd = {'transcript_strand': 1, 'spliceai_dp_dg': -16, 'spliceai_ds_dg': 0.26}
    co_sec = {'inserted_cdna': 'TATTGGTTAGAACAGA'}
    mut_bases, markers = _junction_align_cryptic_gain_on_exon_skip_mutant(
        skip_mut, cryptic_ctx, pd, co_sec, is_don=True,
    )
    seq = ''.join(b['nt'] for b in mut_bases)
    gain_idx = next(m['index'] for m in markers if m.get('kind') == 'splice_gain')
    assert seq[gain_idx:gain_idx + 2] == 'GT'
    prod = _junction_align_secondary_cryptic_product_bases(skip_mut, co_sec, cryptic_ctx)
    assert prod[0]['hgvs'] == 'c.2243'
    assert len(prod) == 2 + 16

def test_junction_donor_cds_prefix_end_when_last_exon_base_deleted():
    from vc_engine.splice import _junction_donor_cds_prefix_end

    ref = 'N' * 50 + 'AGTTA' + 'N' * 40  # last exon base at idx 50, then GT+intron
    mut = ref[:50] + ref[55:]  # c.N_N+4del removes 5 nt from exon end
    assert _junction_donor_cds_prefix_end(2256, 50, 50, ref, mut) == 2255
    assert _junction_donor_cds_prefix_end(2256, 50, 51, ref, mut) == 2256


def test_oof_exon_skip_truncation_applies_over_stale_snpeff():
    """OOF whole-exon skip PTC must replace early SnpEff protein_start placeholders."""
    from vc_engine.splice import (
        _apply_exon_skip_truncation_as_primary,
        _hydrate_exon_skip_truncation_metrics,
    )

    pd = {
        'protein_start': 418,
        'downstream_aas': 28,
        'protein_length': 470,
        'nmd_escape_truncation_fraction': 0.1128,
        'splice_is_in_frame': False,
        'spliceai_exon_skip_spliceai_primary': True,
        'splice_deleted_coords': {'chr': 'X', 'start': 1, 'end': 2},
        'exon_skip_oof_ptc_aa': 451,
        'exon_skip_oof_fs_ter': 'fsTer62',
        'exon_skip_predicted_hgvs_p': 'p.Gln390fsTer62',
        'splice_frame_math': 'Exon 2 OOF skip.',
    }
    _hydrate_exon_skip_truncation_metrics(pd)
    _apply_exon_skip_truncation_as_primary(pd)
    assert pd['protein_start'] == 389
    assert pd['downstream_aas'] == 62
    assert abs(pd['nmd_escape_truncation_fraction'] - (20 / 470.0)) < 0.001
    assert pd['exon_skip_model_truncated_protein_length'] == 450


def test_oof_last_exon_skip_skips_utr_readthrough():
    from vc_engine.splice import (
        _apply_exon_skip_truncation_as_primary,
        _coding_exon_skip_is_last,
        _hydrate_exon_skip_truncation_metrics,
        _oof_last_exon_skip_no_inframe_stop_result,
    )

    coding_exons = [
        {'anatomical_rank': 1, 'start_cds': 1, 'end_cds': 1168},
        {'anatomical_rank': 2, 'start_cds': 1169, 'end_cds': 1413},
    ]
    assert _coding_exon_skip_is_last(coding_exons, 1169, 1413)
    assert not _coding_exon_skip_is_last(coding_exons, 1, 1168)

    mut = 'N' * 1168
    _ptc, out = _oof_last_exon_skip_no_inframe_stop_result(mut, mut, 1169, 1413, 470)
    assert out.get('exon_skip_oof_no_inframe_stop')
    assert 'fsTer' not in (out.get('exon_skip_predicted_hgvs_p') or '')
    assert out.get('exon_skip_model_downstream_aas') == 0
    assert abs(out.get('exon_skip_model_truncation_fraction') - (81 / 470.0)) < 0.001

    pd = {
        'protein_start': 418,
        'downstream_aas': 28,
        'protein_length': 470,
        'nmd_escape_truncation_fraction': 0.1128,
        'splice_is_in_frame': False,
        'spliceai_exon_skip_spliceai_primary': True,
        'splice_deleted_coords': {'chr': 'X', 'start': 1, 'end': 2},
        'splice_frame_math': 'Exon 2 OOF skip.',
        **out,
    }
    _hydrate_exon_skip_truncation_metrics(pd)
    _apply_exon_skip_truncation_as_primary(pd)
    assert pd['protein_start'] == 389
    assert pd['downstream_aas'] == 0
    assert abs(pd['nmd_escape_truncation_fraction'] - (81 / 470.0)) < 0.001
    assert pd.get('exon_skip_oof_ptc_aa') is None


def test_junction_align_exon_skip_ptc_in_window():
    """OOF whole-exon skip — PTC in retained upstream exon should highlight on product track."""
    from vc_engine.splice import _junction_align_payload_exon_skip_loss

    # E3 ends c.243; E4 c.244–402 skipped; E5 from c.403. Junction aa ≈ 82, fsTer1.
    cds = 'ATG' + ('A' * 240) + 'TAG' + ('G' * 159) + ('C' * 200)
    pd = {
        'gene': 'NAA15',
        'c_dot': 'c.402+1G>A',
        'consequence': 'splice_donor_variant',
        'ref': 'G',
        'alt': 'A',
        'splice_frame_math': 'Exon 4 length not multiple of 3 — out-of-frame skip.',
        'splice_is_in_frame': False,
        'variant_exon': 4,
        'exon_skip_oof_fs_ter': 'fsTer1',
        'exon_skip_oof_ptc_aa': 82,
        'exon_skip_oof_ptc_exon_rank': 3,
        'exon_skip_model_protein_start': 82,
        'cds_seq': cds,
        'transcript_chrom': '16',
        'transcript_strand': 1,
        'coding_exons': [
            {'anatomical_rank': 3, 'start_cds': 1, 'end_cds': 243, 'chr': '16', 'start': 1, 'end': 100},
            {'anatomical_rank': 4, 'start_cds': 244, 'end_cds': 402, 'chr': '16', 'start': 101, 'end': 200},
            {'anatomical_rank': 5, 'start_cds': 403, 'end_cds': 562, 'chr': '16', 'start': 201, 'end': 300},
        ],
    }
    ja = _junction_align_payload_exon_skip_loss(pd)
    assert ja.get('eligible'), ja.get('reason')
    prod = next(t for t in ja['tracks'] if t.get('id') == 'cryptic_product')
    ptc_spans = [s for s in prod.get('spans') or [] if s.get('kind') == 'ptc']
    assert ptc_spans, f'expected in-window PTC span, note={prod.get("note")}'
    assert 'fsTer1' in (ptc_spans[0].get('label') or '')
    assert ja.get('upstream_exon') == 3
    assert 'beyond junction window' not in (prod.get('note') or '').lower()


def test_junction_align_secondary_skip_ptc_in_window():
    """Secondary whole-exon skip row uses same PTC placement as primary."""
    from vc_engine.splice import _junction_align_secondary_products_for_donor

    cds = 'ATG' + ('A' * 240) + 'TAG' + ('G' * 159) + ('C' * 200)
    pd = {
        'gene': 'NAA15',
        'c_dot': 'c.402+1G>A',
        'consequence': 'splice_donor_variant',
        'spliceai_ds_dl': 0.95,
        'spliceai_ds_dg': 0.88,
        'splice_frame_math': 'Out-of-frame whole-exon skip.',
        'exon_skip_oof_fs_ter': 'fsTer1',
        'exon_skip_oof_ptc_aa': 82,
        'exon_skip_oof_ptc_exon_rank': 3,
        'exon_skip_model_protein_start': 82,
        'cds_seq': cds,
        'coding_exons': [
            {'anatomical_rank': 3, 'start_cds': 1, 'end_cds': 243, 'chr': '16', 'start': 1, 'end': 100},
            {'anatomical_rank': 4, 'start_cds': 244, 'end_cds': 402, 'chr': '16', 'start': 101, 'end': 200},
            {'anatomical_rank': 5, 'start_cds': 403, 'end_cds': 562, 'chr': '16', 'start': 201, 'end': 300},
        ],
    }
    ctx = {'anchor_c': 402, 'exon_rank': 5, 'upstream_exon': 3}
    extras = _junction_align_secondary_products_for_donor(pd, ctx)
    assert len(extras) == 1
    prod = extras[0]
    assert prod.get('id') == 'exon_skip_secondary'
    ptc_spans = [s for s in prod.get('spans') or [] if s.get('kind') == 'ptc']
    assert ptc_spans, prod.get('note')
    assert 'fsTer1' in (ptc_spans[0].get('label') or '')


def test_junction_cryptic_acceptor_site_maps_dp_plus_into_exon():
    """c.N-1 acceptor gain: SpliceAI Δ+10 from variant → exonic AG, −9 nt 5′ exon trim."""
    import vc_engine.splice as sp

    junction_t_idx = 60
    exon_head = 'ACAAACAACAACAA'  # no decoy AG near Δ+10 landing zone
    intron = list('T' * junction_t_idx)
    intron[58:60] = list('AA')  # canonical AG lost (G>A at c.937-1)
    mut_seq = ''.join(intron) + exon_head
    # AG at variant+9 → new exon start at junction+9 → shift −9
    mut_list = list(mut_seq)
    mut_list[junction_t_idx + 7] = 'A'
    mut_list[junction_t_idx + 8] = 'G'
    mut_seq = ''.join(mut_list)
    ref_intron = list('T' * junction_t_idx)
    ref_intron[58:60] = list('AG')
    ref_seq = ''.join(ref_intron) + exon_head

    parsed = {
        'c_dot': 'c.937-1G>A',
        'spliceai_ds_ag': 0.96,
        'spliceai_dp_ag': 10,
    }
    site, _used = sp._junction_spliceai_cryptic_site(
        parsed,
        mut_seq,
        ref_seq,
        var_idx_t=59,
        is_acceptor=True,
        strand=1,
        c_dot='c.937-1G>A',
        junction_t_idx=junction_t_idx,
    )
    assert site is not None
    assert site + 2 > junction_t_idx, 'Δ+10 at c.937−1 should land in exon body'
    assert junction_t_idx - (site + 2) == -9


def test_spliceai_site_locus_unified_acceptor_minus_deep_and_junction():
    """Deep and junction paths share variant_index + oriented Δ."""
    import vc_engine.splice as sp

    L = 3000
    k = 2692
    d = 10
    j_var = L - k
    intron = list('N' * L)
    intron[j_var + d - 1] = 'A'
    intron[j_var + d] = 'G'
    seq = ''.join(intron)

    ag_deep, j_deep = sp._spliceai_site_locus(
        seq, j_var, d, 'acceptor_gain', 'c.932-2692T>A', 1, hgvs_intron=True,
    )
    assert ag_deep == j_var + d - 1
    assert ag_deep > j_var, 'Δ+10 should land downstream toward acceptor/exon'

    junction_t_idx = 60
    exon_head = 'ACAAACAACAACAA'
    intron2 = list('T' * junction_t_idx)
    intron2[58:60] = list('AA')
    mut_seq = ''.join(intron2) + exon_head
    mut_list = list(mut_seq)
    mut_list[junction_t_idx + 7] = 'A'
    mut_list[junction_t_idx + 8] = 'G'
    mut_seq = ''.join(mut_list)

    ag_junc, _ = sp._spliceai_site_locus(
        mut_seq, 59, d, 'acceptor_gain', 'c.937-1G>A', 1, hgvs_intron=False,
    )
    assert ag_junc == junction_t_idx + 7
    assert ag_junc + 2 > junction_t_idx


def test_acceptor_gain_target_body_uses_oriented_delta_not_hgvs_offset():
    import vc_engine.splice as sp

    assert sp._acceptor_gain_target_body_nt(10, 1) == 10
    assert sp._acceptor_gain_target_body_nt(-1, 1) is None
    assert sp._acceptor_gain_target_body_nt(3, 1) == 3


def test_deep_intronic_highest_ds_primary_col6a1_pattern():
    """COL6A1 c.930+189C>T: donor DS 0.96 primary, acceptor DS 0.5 secondary."""
    import vc_engine.splice as sp

    gains = [
        {'kind': 'donor_gain', 'ds': 0.96, 'dp': -2},
        {'kind': 'acceptor_gain', 'ds': 0.5, 'dp': -73},
    ]
    assert sp._deep_intronic_prefer_acceptor_gain_primary(gains, 0.2) is True
    plan = sp._deep_intronic_spliceai_signal_plan(
        {
            'spliceai_ds_ag': 0.5,
            'spliceai_ds_dg': 0.96,
            'spliceai_ds_al': 0.02,
            'spliceai_ds_dl': 0.12,
            'spliceai_dp_ag': -73,
            'spliceai_dp_dg': -2,
            'spliceai_dp_al': -354,
            'spliceai_dp_dl': -189,
        },
        0.2,
        c_dot='c.930+189C>T',
    )
    assert plan['primary']['kind'] == 'donor_gain'
    assert plan['alternate']['kind'] == 'acceptor_gain'


def test_deep_intronic_intro_lists_primary_and_inframe_alternate():
    import vc_engine.splice as sp

    pd = {
        'deep_intronic_splice_products_active': True,
        'deep_intronic_alternate_splice_math': '<b>Product 2</b>',
        'deep_intronic_spliceai_signal_plan': {
            'primary': {'kind': 'donor_gain', 'ds': 0.96, 'dp': -2},
            'alternate': {'kind': 'acceptor_gain', 'ds': 0.5, 'dp': -73},
        },
        'deep_intronic_alternate_outcome': {
            'in_frame_shift': True,
            'ptc_aa_position': None,
        },
        'variant_exon': 11,
        'consequence': 'intron_variant',
        'cryptic_splice_outcome': {'shift_nt': 185, 'cryptic_type': 'Donor gain'},
        'spliceai_junction_model_preferred': True,
    }
    assert sp._splice_variant_intro_is_complete(pd) is False
    intro = sp._build_splice_variant_intro_short(pd, 'COL6A1', 'c.930+189C>T')
    assert 'in-frame' in intro
    assert 'acceptor gain' in intro
    assert 'donor gain' in intro


def test_deep_intronic_dual_gain_companion_flags_missing_products():
    import vc_engine.splice as sp

    plan = {
        'gains': [
            {'kind': 'donor_gain', 'ds': 0.96, 'dp': -2},
            {'kind': 'acceptor_gain', 'ds': 0.5, 'dp': -73},
        ],
    }
    assert sp._deep_intronic_dual_gain_both_qualify(plan, 0.2) is True
    pd = {
        'deep_intronic_primary_outcome': {
            'cryptic_type': 'Acceptor gain',
            'inserted_cdna': 'AAA',
        },
    }
    assert sp._deep_intronic_has_gain_outcome(pd, 'acceptor') is True
    assert sp._deep_intronic_has_gain_outcome(pd, 'donor') is False


def test_acceptor_gain_gt_for_target_body_prefers_inframe_near_target():
    import vc_engine.splice as sp

    # AG at 80; target 73 → GT at 5 gives 73 nt (OOF), GT at 12 gives 66 nt (in-frame, within 8 nt).
    seq = ['N'] * 90
    seq[5:7] = list('GT')
    seq[12:14] = list('GT')
    seq[80:82] = list('AG')
    seq = ''.join(seq)
    pick = sp._acceptor_gain_gt_for_target_body(seq, 80, 73)
    assert pick is not None
    assert len(pick['retained']) == 66
    assert len(pick['retained']) % 3 == 0


def test_defer_whole_exon_skip_to_deep_intronic_col6a1():
    import vc_engine.splice as sp

    assert sp._defer_whole_exon_skip_to_deep_intronic('intron_variant', 'c.930+189C>T') is True
    assert sp._defer_whole_exon_skip_to_deep_intronic('intron_variant', 'c.930+1G>A') is False
    assert sp._defer_whole_exon_skip_to_deep_intronic('missense_variant', 'c.930G>A') is False


def test_pseudoexon_length_math_includes_body_and_span_compare():
    import vc_engine.splice as sp

    geom = {
        'model': 'acceptor_gain',
        'mechanism': 'acceptor_gain',
        'body_nt': 67,
        'span_nt': 71,
        'target_body_nt': 73,
        'body_start_0based': 46,
        'body_end_0based': 113,
        'gt_hgvs_offset': 45,
        'ag_hgvs_offset': 114,
        'spliceai_delta': -73,
        'intron_length_nt': 479,
        'anchor_exon_rank': 11,
        'downstream_exon_rank': 12,
    }
    html = sp._format_pseudoexon_length_math_html(geom, 'c.930+189C>T')
    assert '67 nt' in html
    assert '71 nt' in html
    assert 'Length comparison' in html
    assert 'SpliceAI |Δ| sizing target = <b>73 nt</b>' in html
    assert 'External splice predictors' in html


def test_cryptic_resolver_applies_intronic_deletion_not_snv_only():
    from unittest.mock import MagicMock

    import vc_engine.splice as sp

    cx_g_start = 1_000_000
    fetch_start = cx_g_start - 60
    fetch_end = cx_g_start + 45
    var_g_pos = cx_g_start - 9
    del_end_g = cx_g_start - 6

    plus = list('N' * (fetch_end - fetch_start + 1))
    junction_t_idx = cx_g_start - fetch_start
    plus[junction_t_idx - 2] = 'A'
    plus[junction_t_idx - 1] = 'G'
    for i, b in zip(range(var_g_pos - fetch_start, del_end_g - fetch_start + 1), 'TAAT'):
        plus[i] = b

    mock_resp = MagicMock(status_code=200, text=''.join(plus))
    mock_sess = MagicMock()
    mock_sess.get.return_value = mock_resp

    cds = 'ATG' + 'GCC' * 400
    cx = {
        'start': cx_g_start,
        'end': cx_g_start + 100,
        'anatomical_rank': 9,
        'start_cds': 910,
        'end_cds': 1000,
    }
    parsed = {
        'ref': 'TAAT',
        'alt': '-',
        'grch38_chrom': 'chr3',
        'grch38_start': var_g_pos,
        'grch38_end': del_end_g,
        'c_dot': 'c.910-9_910-6del',
        'consequence': 'splice_acceptor_variant',
        'spliceai_ds_ag': 0.45,
        'spliceai_ds_al': 0.14,
        'spliceai_dp_ag': -6,
        'variant_exon': 9,
    }

    out = sp._resolve_cryptic_splice_outcome(
        mock_sess,
        parsed,
        cx,
        [cx],
        cds,
        'c.910-9_910-6del',
        'splice_acceptor_variant',
        1,
        '3',
    )
    assert out is not None
    assert not out.get('minimal_signal')
    assert out.get('cryptic_type') == 'Acceptor Gain'
    assert out.get('shift_nt') not in (None, 0)
    assert out.get('junction_align_ctx')


def test_cryptic_resolver_keeps_vep_deletion_not_vcf_overwrite():
    """VEP AATT/- must not be replaced by naive VCF split (TAATT/T)."""
    from unittest.mock import MagicMock

    import vc_engine.splice as sp

    cx_g_start = 1_000_000
    fetch_start = cx_g_start - 60
    fetch_end = cx_g_start + 45
    var_g_pos = cx_g_start - 9
    del_end_g = cx_g_start - 6

    plus = list('N' * (fetch_end - fetch_start + 1))
    junction_t_idx = cx_g_start - fetch_start
    plus[junction_t_idx - 2] = 'A'
    plus[junction_t_idx - 1] = 'G'
    for i, b in zip(range(var_g_pos - fetch_start, del_end_g - fetch_start + 1), 'TAAT'):
        plus[i] = b

    mock_resp = MagicMock(status_code=200, text=''.join(plus))
    mock_sess = MagicMock()
    mock_sess.get.return_value = mock_resp

    cds = 'ATG' + 'GCC' * 400
    cx = {
        'start': cx_g_start,
        'end': cx_g_start + 100,
        'anatomical_rank': 9,
        'start_cds': 910,
        'end_cds': 1000,
    }
    parsed = {
        'ref': 'AATT',
        'alt': '-',
        'vep_vcf_string': 'chr3-186787485-TAATT-T',
        'grch38_chrom': 'chr3',
        'grch38_start': var_g_pos,
        'grch38_end': del_end_g,
        'c_dot': 'c.910-9_910-6del',
        'consequence': 'splice_acceptor_variant',
        'spliceai_ds_ag': 0.45,
        'spliceai_ds_al': 0.14,
        'spliceai_dp_ag': -6,
        'variant_exon': 9,
    }

    out = sp._resolve_cryptic_splice_outcome(
        mock_sess,
        parsed,
        cx,
        [cx],
        cds,
        'c.910-9_910-6del',
        'splice_acceptor_variant',
        1,
        '3',
    )
    assert out is not None
    assert not out.get('minimal_signal')


def test_parse_vcf_locus_string_handles_chr_prefix():
    import vc_engine.splice as sp

    parsed = sp._parse_vcf_locus_string('chr3-186787485-TAATT-T')
    assert parsed == ('chr3', 186787485, 'TAATT', 'T')


def test_cryptic_resolver_deletion_bounds_prefers_ref_allele_over_grch38_end():
    import vc_engine.splice as sp

    parsed = {'grch38_end': 186787489}
    start, end = sp._cryptic_resolver_deletion_bounds(parsed, 186787485, 'AATT', '-')
    assert start == 186787485
    assert end == 186787488
    assert end - start + 1 == 4


def test_cryptic_resolver_deletion_eif4a2_spliceai_shift_twelve_after_del():
    """After 4 bp intronic del, 12 bp are spliced in at cryptic AG (not 16 incl. exon CATG)."""
    from unittest.mock import MagicMock

    import vc_engine.splice as sp

    cx_g_start = 1_000_000
    fetch_start = cx_g_start - 60
    fetch_end = cx_g_start + 45
    var_g_pos = cx_g_start - 9

    plus = list('N' * (fetch_end - fetch_start + 1))
    junction_t_idx = cx_g_start - fetch_start
    # EIF4A2-like intron 3′ and exon 9 start (Ensembl ENST00000323963)
    intron_tail = 'CTGGTGATTCTTGAATTAAGGTTTATTAATTTGCAG'
    exon_head = 'CATGGTGACATGGA'
    win_start = junction_t_idx - len(intron_tail)
    for i, b in enumerate(intron_tail):
        plus[win_start + i] = b
    for i, b in enumerate(exon_head):
        plus[junction_t_idx + i] = b
    plus[junction_t_idx - 2] = 'A'
    plus[junction_t_idx - 1] = 'G'
    for i, b in zip(range(var_g_pos - fetch_start, var_g_pos - fetch_start + 4), 'AATT'):
        plus[i] = b
    # SpliceAI Δ−6 from variant → cryptic AG ~18 nt upstream of canonical acceptor
    plus[junction_t_idx - 18] = 'A'
    plus[junction_t_idx - 17] = 'G'

    mock_resp = MagicMock(status_code=200, text=''.join(plus))
    mock_sess = MagicMock()
    mock_sess.get.return_value = mock_resp

    cds = 'A' * 909 + 'CATGGTGAAC' + 'G' * 400
    cx = {
        'start': cx_g_start,
        'end': cx_g_start + 100,
        'anatomical_rank': 9,
        'start_cds': 910,
        'end_cds': 1000,
    }
    parsed = {
        'ref': 'AATT',
        'alt': '-',
        'grch38_chrom': 'chr3',
        'grch38_start': var_g_pos,
        'grch38_end': var_g_pos + 4,
        'c_dot': 'c.910-9_910-6del',
        'consequence': 'splice_acceptor_variant',
        'spliceai_ds_ag': 0.45,
        'spliceai_ds_al': 0.14,
        'spliceai_dp_ag': -6,
        'variant_exon': 9,
    }

    out = sp._resolve_cryptic_splice_outcome(
        mock_sess,
        parsed,
        cx,
        [cx],
        cds,
        'c.910-9_910-6del',
        'splice_acceptor_variant',
        1,
        '3',
    )
    assert out is not None
    assert out.get('shift_nt') == 12
    assert out.get('inserted_cdna') == 'GTTTATTTGCAG'


def test_junction_cryptic_acceptor_product_shows_full_retained_nt():
    """Retained intronic body renders as pseudo-exon; exon 5′ (CATG) follows separately."""
    import vc_engine.splice as sp

    ins = 'GTTTATTTGCAG'
    cds = 'A' * 909 + 'CATGGTGAAC' + 'G' * 40
    bases, spans = sp._junction_align_cryptic_acceptor_product_bases(ins, cds, 910)
    pseudo = [b for b in bases if b.get('kind') == 'exon_extension_intronic']
    exon = [b for b in bases if b.get('kind') == 'exon']
    assert len(pseudo) == 12
    assert ''.join(b['nt'] for b in pseudo) == ins
    assert spans[0]['end'] - spans[0]['start'] == 12
    assert exon and exon[0]['nt'] == 'C'
    assert ''.join(b['nt'] for b in exon[:4]) == 'CATG'


def test_junction_ref_idx_to_mut_idx_deletion_and_duplication():
    import vc_engine.splice as sp

    ref = 'ABCDEFGHIJKLMNOP'
    var_i = 5
    mut = ref[:5] + ref[9:]  # delete FGHI (4 bp at index 5–8)
    assert sp._junction_ref_idx_to_mut_idx(ref, mut, 3, var_i) == 3
    assert sp._junction_ref_idx_to_mut_idx(ref, mut, 13, var_i) == 9
    dup = ref[:5] + 'WWWW' + ref[5:]
    assert sp._junction_ref_idx_to_mut_idx(ref, dup, 3, var_i) == 3
    assert sp._junction_ref_idx_to_mut_idx(ref, dup, 13, var_i) == 17


def test_cryptic_resolver_donor_gain_deletion_shortens_retained_body():
    """Intronic del upstream of cryptic GT: retained body length uses mut_seq slice."""
    from unittest.mock import MagicMock

    import vc_engine.splice as sp

    cx_g_end = 1_000_000
    fetch_start = cx_g_end - 45
    fetch_end = cx_g_end + 60
    junction_t_idx = cx_g_end - fetch_start  # 45

    plus = list('N' * (fetch_end - fetch_start + 1))
    plus[junction_t_idx] = 'A'
    plus[junction_t_idx + 1:junction_t_idx + 3] = 'GT'
    intron = 'CCCC' * 10  # no spurious GT dinucleotides
    for i, b in enumerate(intron):
        plus[junction_t_idx + 3 + i] = b
    cryptic_gt = junction_t_idx + 20
    plus[cryptic_gt:cryptic_gt + 2] = 'GT'
    del_start = junction_t_idx + 10
    for i in range(4):
        plus[del_start + i] = 'A'

    mock_resp = MagicMock(status_code=200, text=''.join(plus))
    mock_sess = MagicMock()
    mock_sess.get.return_value = mock_resp

    ref = ''.join(plus)
    mut = ref[:del_start] + ref[del_start + 4:]
    body_start_mut = sp._junction_ref_idx_to_mut_idx(ref, mut, junction_t_idx + 3, del_start)
    cryptic_gt_mut = cryptic_gt - 4
    mut_body = mut[body_start_mut:cryptic_gt_mut]
    ref_body = ref[junction_t_idx + 3:cryptic_gt]
    assert len(ref_body) == len(mut_body) + 4

    cds = 'A' * 500 + 'T' * 100
    cx = {
        'start': cx_g_end - 80,
        'end': cx_g_end,
        'anatomical_rank': 5,
        'start_cds': 401,
        'end_cds': 500,
    }
    parsed = {
        'ref': 'AAAA',
        'alt': '-',
        'grch38_chrom': 'chr1',
        'grch38_start': fetch_start + del_start,
        'grch38_end': fetch_start + del_start + 3,
        'c_dot': 'c.500+10_500+13del',
        'consequence': 'splice_donor_variant',
        'spliceai_ds_dg': 0.55,
        'spliceai_ds_dl': 0.05,
        'spliceai_dp_dg': 6,
        'variant_exon': 5,
    }

    out = sp._resolve_cryptic_splice_outcome(
        mock_sess,
        parsed,
        cx,
        [cx],
        cds,
        'c.500+10_500+13del',
        'splice_donor_variant',
        1,
        '1',
    )
    assert out is not None
    assert not out.get('minimal_signal')
    assert out.get('shift_nt') == len(mut_body)
    assert out.get('inserted_cdna') == mut_body.upper()
    assert out.get('shift_nt') == len(out.get('inserted_cdna') or '')


def test_splice_variant_intro_short_uses_resolved_product_not_snpeff():
    import vc_engine.splice as sp

    parsed = {
        'variant_exon': 9,
        'consequence': 'splice_acceptor_variant',
        'c_dot': 'c.910-9_910-6del',
        'spliceai_junction_model_preferred': True,
        'snpeff_exon_rank': 8,
        'cryptic_splice_outcome': {
            'minimal_signal': False,
            'shift_nt': 16,
            'cryptic_type': 'Acceptor Gain',
            'in_frame_shift': False,
            'fs_ter_str': 'p.Ala304fsTer12',
            'ptc_aa_position': 316,
        },
    }
    intro = sp._build_splice_variant_intro_short(parsed, 'EIF4A2', 'c.910-9_910-6del')
    assert 'acceptor-side splice variant at exon 9' in intro
    assert 'out-of-frame' in intro
    assert 'cryptic acceptor gain' in intro
    assert 'new PTC' in intro
    assert 'p.Ala304fsTer12' in intro
    assert 'exon 8' not in intro
    assert 'structural splice LOF' not in intro
