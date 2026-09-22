"""Variant classification engine: the /api/analyze route + its helper web.

Extracted from ``app_v11.py`` (final phase of ``docs/ENGINE_SPLIT_PLAN.md``).
Contains analyze_variant (the POST /api/analyze pipeline) and its ~55 local
helpers as a Flask Blueprint (analyze_bp). Engine runtime state (GLOBAL_VCF
pysam handle, HGMD dicts, EnsemblCurlSession, Gemini client) is injected as
module attributes by the app_v11 mount before the app serves requests.
"""

from __future__ import annotations

import concurrent.futures
import html
import json
import pandas as pd
import re
import urllib.parse

from flask import Blueprint, request, jsonify
from flask import jsonify, request
from google.genai import types
from vc_engine.clinvar import _clinvar_cdot_label_from_esummary, _clinvar_coding_hgvs_from_hit, _clinvar_display_sig_from_rcv, _clinvar_geneinfo_matches, _clinvar_genomic_hgvs_from_hit, _clinvar_name_change_class, _clinvar_plp_sig_for_deleted_exon, _clinvar_rcv_any_pathogenic_or_likely, _clinvar_rcv_list_from_hit, _clinvar_sig_from_esummary_obj, _clinvar_variant_id_from_hit, _clinvar_variation_uid_for_pubmed_elink, _fetch_clinvar_aliases, _fetch_clinvar_esummary_map, _fetch_myvariant_clinvar_variant_hit, clinvar_portal_url
from vc_engine.gnomad_local import apply_local_gnomad, local_gnomad_configured
from vc_engine.hgmd import _hgmd_ordered_candidate_keys, _merge_hgmd_downstream_hits, _merge_hgmd_skipped_exon_hits, _merge_hgmd_upstream_hits
from vc_engine.lit_index import search_lit_index
from vc_engine.noncoding import (
    append_noncoding_curation_logic_section,
    apply_noncoding_curation_pack,
)
from vc_engine.hgvs import (
    _AA_ONE_TO_THREE,
    _c_dot_change_class,
    _c_dot_requires_exact_allele_match,
    _clinvar_esearch_stem_terms,
    _derive_inframe_hgvs_p_from_c_dot,
    _hgvs_c_dot_alleles_equal,
    _hgvs_c_dot_clinvar_equivalent,
    _hgvs_dna_kind,
    _is_colocalized_cdna_alternate,
    _is_noncoding_dna_hgvs,
    _is_same_cdna_allele,
    _myvariant_c_dot_tail_norm,
    _normalize_dna_hgvs_prefix,
    _parse_missense_substitution_hgvs_p,
    _protein_position_from_hgvs_label,
    _vep_hgvs_query,
)
from vc_engine.myvariant import (
    _MYVARIANT_LOCAL_ALLELE_FIELDS,
    _gene_symbol_from_myvariant_hit,
    _pick_best_myvariant_hit,
    _resolve_effective_gene_from_vep_symbols,
)
from vc_engine.regions import _downstream_plp_anchor_aa, _downstream_plp_hits_markup, _finalize_downstream_plp_scan_metadata, _finalize_plp_region_links, _finalize_skipped_exon_plp_links, _hydrate_skipped_exon_aa_bounds, _hydrate_splice_excised_region, _hydrate_whole_exon_skip_deleted_coords, _needs_downstream_clinvar_plp, _skipped_exon_aa_range_label, _skipped_exon_region_context_html, _splice_deleted_coords_complete, _upstream_plp_hits_markup, _whole_exon_skip_modeled
from vc_engine.truncation import (
    TRUNC_SEVERE_THRESHOLD,
    apply_nmd_escape_from_coding_exons,
    c_terminal_loss_fraction,
    ensure_truncation_fraction_from_stop,
    sync_truncation_fraction_from_ptc,
    formalize_frameshift_ptc,
    formalize_nonsense_ptc,
    is_marginal_loss,
    is_severe_loss,
    is_short_3prime_extension,
    is_start_loss_reinit_viable,
    parse_nonsense_stop_aa_from_hgvs,
    start_loss_fraction_from_next_met,
)
from vc_engine.scoring import apply_acmg, apply_rubric
from vc_engine.splice import SPLICEAI_RECONCILE_MIN, _append_deep_intronic_splice_logic_sections, _append_nmd_escape_clinical_context, _append_splice_product_logic_sections, _append_splice_support_sections, _append_truncation_nmd_sections, _apply_canonical_splice_hgvs_override, _apply_near_splice_region_context, _apply_exon_skip_truncation_as_primary, _apply_pre_atg_splice_acceptor_context, _build_junction_align_payload, _build_splice_products_panel_html, _build_splice_variant_intro_short, _build_splice_viz_payload, _canonical_splice_junction_from_hgvs, _consequence_is_acceptor_splice, _consequence_is_donor_splice, _deep_intronic_signal_label, _defer_whole_exon_skip_to_deep_intronic, _ensure_cds_seq, _ensure_coding_exons_for_splice_viz, _ensure_protein_length_from_coding_exons, _ensure_splice_secondary_cryptic_gain, _finalize_splice_report_narratives, _format_whole_exon_skip_hgvs_p, _hit_at_user_splice_junction_locus, _hydrate_exon_skip_truncation_metrics, _junction_align_ruler_ticks, _logic_csq_is_splice_context, _logic_lines_block, _mark_oof_exon_skip_nmd_provisional, _logic_section_text_plain, _logic_should_show_deep_intronic_context, _lookup_clinvar_plp_downstream_of_ptc, _met_reinitiation_applies, _missense_same_codon_different_change, _normalize_to_forward_strand, _oofs_exon_skip_ptc_cds_and_cdna, _reconcile_splice_model_precedence, refresh_pre_atg_deep_intronic_readouts, _resolve_cryptic_splice_outcome, _resolve_exon_internal_cryptic_outcome, _resolve_splice_junction_locus, _same_canonical_splice_junction_locus, _select_splice_coding_exon, _set_spliceai_narrative_sentence, _should_show_spliceai_narrative_in_logic, _splice_cdna_anchor_from_hgvs, _splice_variant_intro_is_complete, _spliceai_exon_skip_takes_precedence_over_weak_cryptic, _refresh_secondary_gain_at_spliceai_dp, _spliceai_scores_4, _spliceai_secondary_acceptor_parallel_exon_skip_math, _spliceai_secondary_donor_parallel_exon_skip_math, _spliceai_variant_locus_string, _stash_transcript_mrna_exon_metadata, _suppress_start_loss_nmd_for_exon_skip_primary, _translate_cds_aas, _whole_exon_skip_primary_resolved, compute_deep_intronic_splice_math, compute_deep_intronic_spliceai_products
from vc_engine.spliceai import _apply_emg_spliceai_ds_only, _apply_emg_spliceai_if_broad_unavailable, _emg_spliceai_ds_snapshot, _ingest_spliceai_broad_json, _refresh_spliceai_in_silico_source
from vc_engine.state import clingen_db, clingen_gene_lookup
from vc_engine.uniprot import (
    _apply_uniprot_domain_lookup,
    _apply_uniprot_skipped_exon_domains,
    _pick_dbnsfp_uniprot_accession,
)
from vc_engine.metadome import (
    append_metadome_logic_section,
    apply_metadome_missense_lookup,
)
from vc_engine.util import _safe_int_or_none

analyze_bp = Blueprint("analyze", __name__)

# Injected by the app_v11 mount after the engine data is loaded.
GLOBAL_VCF = None


def _clinvar_vcf():
    """Local ClinVar handle when Settings selected the file. None in NCBI mode."""
    from vc_engine.source_mode import clinvar_file_active

    if not clinvar_file_active():
        return None
    return GLOBAL_VCF
GLOBAL_HGMD = None
GLOBAL_HGMD_PMIDS = None
http_session = None
client = None


def _sort_refseq_synonym_pairs(pairs):
    """MANE → ClinVar-listed → canonical → user transcript."""
    def keyfn(p):
        mane = 0 if (p.get("mane_select") or "").strip() else 1
        cv = 0 if p.get("from_clinvar") else 1
        can = 0 if p.get("canonical") else 1
        usr = 1 if p.get("user_input") else 0
        return (mane, cv, can, -usr, p.get("refseq", ""))

    return sorted(pairs, key=keyfn)


def _collect_refseq_nm_synonyms_from_vep_tc(transcript_consequences):
    """
    Pull NM_*:c. / NR_*:n. HGVS strings from Ensembl VEP transcript_consequences.
    HGMD / literature often use MANE Select numbering vs an alternate accession.
    """
    pairs = []
    tails = []
    seen_full = set()
    for t in transcript_consequences or []:
        hx = (t.get("hgvsc") or "").strip()
        if not hx or ":" not in hx:
            continue
        left, right = hx.split(":", 1)
        left = left.strip()
        right = right.strip()
        right_l = right.lower()
        left_u = left.upper()
        if right_l.startswith("c.") and left_u.startswith("NM_"):
            pass
        elif right_l.startswith(("n.", "r.")) and left_u.startswith("NR_"):
            pass
        else:
            continue
        full = f"{left}:{right}"
        if full in seen_full:
            continue
        seen_full.add(full)
        mane_sel = (t.get("mane_select") or "").strip()
        pairs.append(
            {
                "refseq": left,
                "hgvs_c": right,
                "full": full,
                "mane_select": mane_sel,
                "canonical": (t.get("canonical") == 1),
                "user_input": False,
            }
        )
        tails.append(right)
    seen_t = set()
    tails_u = []
    for x in tails:
        if x not in seen_t:
            seen_t.add(x)
            tails_u.append(x)
    return {"pairs": _sort_refseq_synonym_pairs(pairs), "tails": tails_u}


def _merge_into_parsed_refseq_synonyms(parsed_data, syn_pack):
    if not syn_pack:
        return
    pairs_add = syn_pack.get("pairs") or []
    tails_add = syn_pack.get("tails") or []
    if pairs_add:
        cur = list(parsed_data.get("refseq_nm_synonyms") or [])
        seen = {p.get("full") for p in cur}
        for p in pairs_add:
            f = p.get("full")
            if f and f not in seen:
                seen.add(f)
                cur.append(p)
        parsed_data["refseq_nm_synonyms"] = _sort_refseq_synonym_pairs(cur)
    if tails_add:
        tails = list(parsed_data.get("refseq_nm_synonym_c_tails") or [])
        ts = set(tails)
        for x in tails_add:
            if x not in ts:
                ts.add(x)
                tails.append(x)
        parsed_data["refseq_nm_synonym_c_tails"] = tails


def _nm_c_pairs_from_hgvs_string(s):
    """Split NM_…:c.… tokens from ClinVar / MyVariant HGVS strings (incl. NM_x(gene):c.)."""
    out = []
    s = str(s).strip()
    if not s or "NM_" not in s.upper() or "c." not in s.lower():
        return out
    for part in re.split(r"[,;]\s*", s):
        part = part.strip()
        if not part:
            continue
        m = re.search(
            r"(NM_\d+(?:\.\d+)?)\s*(?:\([^)]*\))?\s*:\s*(c\.[^\s,;]+)",
            part,
            re.I,
        )
        if m:
            refseq = m.group(1)
            cdot = m.group(2)
            full = f"{refseq}:{cdot}"
            out.append({"refseq": refseq, "hgvs_c": cdot, "full": full})
    return out


def _merge_refseq_synonyms_from_clinvar_myvariant_hit(hit, parsed_data):
    """
    Pull alternate RefSeq HGVS from the matched MyVariant ClinVar/SnpEff payload.
    Isoforms use different c. positions — do NOT filter by the user's typed c. tail.
    """
    if not hit or not isinstance(hit, dict):
        return
    pairs_add = []
    tails_add = []
    seen = set()

    coding = hit.get("clinvar", {}).get("hgvs", {}).get("coding", [])
    if isinstance(coding, str):
        coding = [coding]
    for cstr in coding or []:
        for p in _nm_c_pairs_from_hgvs_string(cstr):
            if p["full"] in seen:
                continue
            seen.add(p["full"])
            pairs_add.append(
                {
                    **p,
                    "mane_select": "",
                    "canonical": False,
                    "user_input": False,
                    "from_clinvar": True,
                }
            )
            tails_add.append(p["hgvs_c"])

    ann = hit.get("snpeff", {}).get("ann", [])
    if isinstance(ann, dict):
        ann = [ann]
    for a in ann or []:
        hg = (a.get("hgvs_c") or "").strip()
        if not hg:
            continue
        for p in _nm_c_pairs_from_hgvs_string(hg):
            if p["full"] in seen:
                continue
            seen.add(p["full"])
            pairs_add.append(
                {
                    **p,
                    "mane_select": "",
                    "canonical": False,
                    "user_input": False,
                    "from_clinvar": True,
                }
            )
            tails_add.append(p["hgvs_c"])

    if pairs_add:
        _merge_into_parsed_refseq_synonyms(
            parsed_data, {"pairs": pairs_add, "tails": tails_add}
        )


def _enrich_refseq_synonyms_clinvar_vid_lookup(http_session, variant_id, parsed_data):
    """Fetch full clinvar.hgvs.coding list by ClinVar variation ID when the query hit was sparse."""
    from vc_engine.source_mode import clinvar_remote_active

    if not clinvar_remote_active():
        return
    vid = str(variant_id or "").strip()
    if not vid.isdigit():
        return
    try:
        url = f"https://myvariant.info/v1/variant/clinvar.variant_id:{vid}?fields=clinvar.hgvs.coding"
        resp = http_session.get(url, timeout=12)
        if resp.status_code != 200:
            return
        doc = resp.json()
        if not isinstance(doc, dict):
            return
        cv = doc.get("clinvar") or {}
        hg = cv.get("hgvs") or {}
        coding = hg.get("coding", [])
        fake_hit = {"clinvar": {"hgvs": {"coding": coding}}}
        _merge_refseq_synonyms_from_clinvar_myvariant_hit(fake_hit, parsed_data)
    except Exception:
        pass


def _ensure_user_nm_on_refseq_synonyms(parsed_data, target_nm_base, c_dot):
    base = str(target_nm_base or "").strip()
    base_u = base.upper()
    if not base_u.startswith(("NM_", "NR_")):
        return
    cc = _normalize_dna_hgvs_prefix(c_dot)
    if not cc:
        return
    # NM_ pairs with c.; NR_ pairs with n./r. (default n. if bare).
    if base_u.startswith("NR_") and _hgvs_dna_kind(cc) == "c":
        return
    if base_u.startswith("NM_") and _hgvs_dna_kind(cc) in ("n", "r"):
        return
    full = f"{base}:{cc}"
    cur = list(parsed_data.get("refseq_nm_synonyms") or [])
    norm = full.replace(" ", "")
    if any((p.get("full") or "").replace(" ", "") == norm for p in cur):
        return
    cur.append(
        {
            "refseq": base,
            "hgvs_c": cc,
            "full": full,
            "mane_select": "",
            "canonical": False,
            "user_input": True,
        }
    )
    parsed_data["refseq_nm_synonyms"] = _sort_refseq_synonym_pairs(cur)


def _fetch_vep_refseq_synonyms_supplemental(http_session, nm_base, c_dot):
    """Lightweight VEP call when the main VEP block did not populate RefSeq synonyms."""
    if not nm_base or not str(nm_base).upper().startswith(("NM_", "NR_")):
        return {"pairs": [], "tails": []}
    try:
        hq = _vep_hgvs_query(nm_base, c_dot) or f"{nm_base}:{c_dot}"
        url = (
            "https://rest.ensembl.org/vep/human/hgvs/"
            f"{urllib.parse.quote(hq, safe='')}?hgvs=1&mane=1&canonical=1"
        )
        resp = http_session.get(url, timeout=45)
        if resp.status_code != 200:
            return {"pairs": [], "tails": []}
        vd = resp.json()
        if not vd or len(vd) < 1:
            return {"pairs": [], "tails": []}
        return _collect_refseq_nm_synonyms_from_vep_tc(vd[0].get("transcript_consequences", []))
    except Exception:
        return {"pairs": [], "tails": []}


def _norm_c_dot_for_upstream_dedupe(c_raw):
    """Normalize HGVS DNA strings for deduping ClinVar vs HGMD upstream lists."""
    if not c_raw:
        return ""
    s = str(c_raw).strip()
    if not s or s.lower() in ("nan", "unknown c.", "unknown", "."):
        return ""
    if ":" in s:
        s = s.split(":")[-1].strip()
    s = _normalize_dna_hgvs_prefix(s)
    return re.sub(r"\s+", "", s.lower())


def _protein_positions_from_text_blob(txt):
    """Extract residue numbers from protein HGVS-like text (same heuristics as ClinVar scan)."""
    if txt is None:
        return []
    try:
        if pd.isna(txt):
            return []
    except Exception:
        pass
    if isinstance(txt, bool):
        return []
    if isinstance(txt, (int, float)):
        return []
    hp = str(txt).strip()
    if not hp or hp.lower() in ("nan", ".", "-", "na"):
        return []
    pos_vals = []
    for m in re.findall(r"p\.(?:[A-Za-z]{3}|[A-Za-z*])(\d+)", hp):
        try:
            pos_vals.append(int(m))
        except ValueError:
            pass
    for mo in re.finditer(r"(\d+)(?:fs|\*|Ter\b)", hp, re.I):
        try:
            pos_vals.append(int(mo.group(1)))
        except ValueError:
            pass
    return pos_vals


def _ensembl_inclusive_to_pysam_fetch_interval(start_1b_incl, end_1b_incl):
    """
    Ensembl exon/REST features use 1-based inclusive coordinates on the contig.
    pysam.VariantFile.fetch contig, start, end uses 0-based, half-open [start, end).
    """
    try:
        s = int(start_1b_incl)
        e = int(end_1b_incl)
    except (TypeError, ValueError):
        return None, None
    if s < 1 or e < s:
        return None, None
    return s - 1, e


def _fetch_broad_spliceai_and_pangolin(http_session, locus_fmt, timeout=30):
    """GET SpliceAI + Pangolin Broad endpoints in parallel for the same chr-pos-ref-alt."""
    fmt = (locus_fmt or "").strip()
    if not fmt:
        return None, None
    sai_url = f"https://spliceai-38-xwkwwwxdwq-uc.a.run.app/spliceai/?hg=38&variant={fmt}"
    pan_url = f"https://pangolin-38-xwkwwwxdwq-uc.a.run.app/pangolin/?hg=38&variant={fmt}"
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
            f_sai = ex.submit(http_session.get, sai_url, timeout=timeout)
            f_pan = ex.submit(http_session.get, pan_url, timeout=timeout)
            return f_sai.result(), f_pan.result()
    except Exception as e:
        print(f"Broad SpliceAI/Pangolin parallel fetch error: {e}")
        try:
            return http_session.get(sai_url, timeout=timeout), None
        except Exception:
            return None, None


def _ingest_pangolin_broad_response(parsed_data, pan_resp):
    """Parse Broad Pangolin JSON into parsed_data scores (no-op if already fetched)."""
    if parsed_data.get("pangolin_fetched") or pan_resp is None:
        return
    try:
        if getattr(pan_resp, "status_code", 0) != 200:
            return
        parsed_data["pangolin_fetched"] = True
        pan_data = pan_resp.json()
        if not (pan_data and "scores" in pan_data):
            return
        scores_list = pan_data.get("scores", [])
        best_ds_sg = 0.0
        best_ds_sl = 0.0
        parsed_data["pangolin_dp_sg"] = ""
        parsed_data["pangolin_dp_sl"] = ""
        for s in scores_list:
            if isinstance(s, dict):
                ds_sg = abs(float(s.get("DS_SG", 0.0)))
                ds_sl = abs(float(s.get("DS_SL", 0.0)))
                dp_sg = s.get("DP_SG", "")
                dp_sl = s.get("DP_SL", "")
                if ds_sg > best_ds_sg:
                    best_ds_sg, parsed_data["pangolin_dp_sg"] = ds_sg, dp_sg
                if ds_sl > best_ds_sl:
                    best_ds_sl, parsed_data["pangolin_dp_sl"] = ds_sl, dp_sl
        parsed_data["pangolin_ds_sg"] = best_ds_sg
        parsed_data["pangolin_ds_sl"] = best_ds_sl
    except Exception as e:
        print(f"Pangolin Broad API Error: {e}")


def _run_skipped_exon_clinvar_plp_scan(parsed_data, effective_gene):
    """
    Scan local ClinVar VCF (+ HGMD aa span) for P/LP hits in splice_deleted_coords.
    Safe to call more than once after coords are hydrated late (e.g. after Ensembl
    coding_exons catch-up). No-ops when already checked or coords are incomplete.
    """
    if parsed_data.get("skipped_exon_plp_checked"):
        return bool(parsed_data.get("has_pathogenic_in_deleted_exon"))
    if not _splice_deleted_coords_complete(parsed_data):
        return False
    del_c = parsed_data["splice_deleted_coords"]
    try:
        _hydrate_skipped_exon_aa_bounds(parsed_data)
        vcf_chrom = str(del_c["chr"]).replace("chr", "")
        g0, g1 = _ensembl_inclusive_to_pysam_fetch_interval(del_c["start"], del_c["end"])
        parsed_data["skipped_exon_plp_checked"] = True
        if _clinvar_vcf() is not None and g0 is not None and g1 is not None:
            skipped_hits = []
            skipped_seen = set()
            for rec in _clinvar_vcf().fetch(vcf_chrom, g0, g1):
                if "CLNSIG" not in rec.info:
                    continue
                sig = rec.info.get("CLNSIG", [""])[0].lower()
                gene_info = rec.info.get("GENEINFO", "")
                if not _clinvar_geneinfo_matches(gene_info, effective_gene):
                    continue
                if not _clinvar_plp_sig_for_deleted_exon(sig):
                    continue
                vid = str(rec.id or "").strip()
                if not vid or vid in skipped_seen:
                    continue
                skipped_seen.add(vid)
                raw_sig = sig.replace("_", " ").title()
                hgvs_list = rec.info.get("CLNHGVS", [])
                g_hgvs = str(hgvs_list[0]).split(":")[-1] if hgvs_list else ""
                link_id = vid
                if "RCV" in rec.info:
                    rcvs = rec.info.get("RCV", [])
                    if rcvs:
                        link_id = str(rcvs[0]).split("|")[0]
                skipped_hits.append({
                    "label": f"{g_hgvs or 'Unknown c.'} ({raw_sig})",
                    "link": clinvar_portal_url(link_id),
                    "clinvar_vid": vid,
                    "source": "clinvar",
                    "c_dot_norm": "",
                    "_raw_sig": raw_sig,
                    "_g_hgvs": g_hgvs,
                })
            if skipped_hits:
                emap = _fetch_clinvar_esummary_map(
                    http_session, [h["clinvar_vid"] for h in skipped_hits]
                )
                for h in skipped_hits:
                    cdot = _clinvar_cdot_label_from_esummary(
                        emap.get(str(h["clinvar_vid"]))
                    )
                    if cdot:
                        h["label"] = f"{cdot} ({h['_raw_sig']})"
                        h["c_dot_norm"] = _norm_c_dot_for_upstream_dedupe(
                            cdot.split(" (p.")[0]
                        )
                        pos = _protein_position_from_hgvs_label(h["label"])
                        if pos is not None:
                            h["position"] = pos
                    h.pop("_raw_sig", None)
                    h.pop("_g_hgvs", None)
            _skip_bounds = _hydrate_skipped_exon_aa_bounds(parsed_data)
            if _skip_bounds:
                _merge_hgmd_skipped_exon_hits(
                    skipped_hits, effective_gene, _skip_bounds[0], _skip_bounds[1]
                )
            if skipped_hits:
                skipped_hits.sort(key=lambda x: (x.get("label") or ""))
                parsed_data["skipped_exon_pathogenic_hits"] = skipped_hits
                _finalize_skipped_exon_plp_links(parsed_data)
        else:
            parsed_data["skipped_exon_plp_vcf_unavailable"] = True
        return True
    except Exception as e:
        print(f"Skipped Exon ClinVar Lookup Error: {e}")
        parsed_data["skipped_exon_plp_checked"] = False
        return False


def _ensure_skipped_exon_interval_and_plp_scan(parsed_data, effective_gene, session=None):
    """Fetch coding_exons if needed, hydrate skipped-exon coords, then run P/LP scan."""
    needs_skip_interval = (
        _whole_exon_skip_modeled(parsed_data)
        or bool(parsed_data.get("spliceai_exon_skip_spliceai_primary"))
        or (
            bool(parsed_data.get("splice_deleted_coords"))
            and not _splice_deleted_coords_complete(parsed_data)
        )
    )
    if not parsed_data.get("skipped_exon_plp_checked") and needs_skip_interval:
        _ensure_coding_exons_for_splice_viz(parsed_data, session or http_session)
    _hydrate_splice_excised_region(parsed_data)
    _hydrate_whole_exon_skip_deleted_coords(parsed_data)
    return _run_skipped_exon_clinvar_plp_scan(parsed_data, effective_gene)


def _protein_frameshift_anchor(p_str):
    """First amino-acid index for frameshift / early-terminator protein HGVS (e.g. Met128, M128Wfs*35)."""
    if not p_str:
        return None
    s = str(p_str).split(":")[-1]
    low = s.lower()
    if "fs" not in low and "ter" not in low and "*" not in s:
        return None
    m = re.search(r"(?:Met|M)\s*(\d+)", s, re.I)
    if m:
        return int(m.group(1))
    m = re.search(r"(\d+)", s)
    return int(m.group(1)) if m else None


def _protein_frameshift_match(p1, p2):
    a = _protein_frameshift_anchor(p1)
    b = _protein_frameshift_anchor(p2)
    return a is not None and b is not None and a == b


def _normalize_protein_hgvs_tail(hgvs_p):
    s = _normalize_hgvs_p_to_3letter(hgvs_p or "")
    return re.sub(r"\s+", "", s).lower()


def _protein_hgvs_exact_match(p1, p2):
    a = _normalize_protein_hgvs_tail(p1)
    b = _normalize_protein_hgvs_tail(p2)
    return bool(a and b and a == b)


def _clinvar_variation_name_score(variation_name, effective_gene, target_transcript, c_dot, hgvs_p=None):
    """
    Score a ClinVar variation title against the user / VEP HGVS.
    100 = exact NM/NR + c./n. allele; 85 = same NM + exact p.; 70 = exact p. alone;
    60 = same frameshift protein anchor; 40 = same change class + gene.
    """
    name = str(variation_name or "")
    if not name:
        return 0
    if effective_gene and effective_gene.upper() not in name.upper():
        return 0
    score = 0
    want_c = _myvariant_c_dot_tail_norm(c_dot)
    want_nm = (target_transcript or "").split(".")[0].upper()
    # Coding: NM_*:c.… ; Noncoding: NR_*:n.|r.…
    m = re.search(
        r"((?:NM|NR)_\d+(?:\.\d+)?)(?:\([^)]*\))?:((?:c|n|r)\.[^ (]+)",
        name,
        re.I,
    )
    if m and want_c:
        nm = m.group(1).split(".")[0].upper()
        cand_c = _myvariant_c_dot_tail_norm(m.group(2))
        if _hgvs_c_dot_alleles_equal(want_c, cand_c):
            score = 100 if (not want_nm or nm == want_nm) else 70
        elif _hgvs_c_dot_clinvar_equivalent(want_c, cand_c):
            score = max(score, 88 if (not want_nm or nm == want_nm) else 75)
    if hgvs_p:
        pm = re.search(r"\(p\.([^)]+)\)", name)
        if pm:
            cand_p = pm.group(1)
            if _protein_hgvs_exact_match(hgvs_p, cand_p):
                nm_ok = not want_nm
                if want_nm and m:
                    nm_ok = m.group(1).split(".")[0].upper() == want_nm
                score = max(score, 85 if nm_ok else 70)
            elif _protein_frameshift_match(hgvs_p, cand_p):
                score = max(score, 60)
    q_class = _c_dot_change_class(want_c)
    n_class = _clinvar_name_change_class(name)
    if q_class and n_class and q_class == n_class and score < 60:
        # Same class alone is not enough for substitutions (G>A vs G>T at +1).
        if q_class != "sub":
            score = max(score, 40)
    return score


def _append_uniprot_domain_logic_section(sections, parsed_data):
    if not parsed_data.get('uniprot_domain_checked'):
        return
    link = (parsed_data.get('critical_domain_link') or '').strip()
    acc = (parsed_data.get('uniprot_primary_accession') or '').strip()
    if not link and acc:
        link = f"https://www.uniprot.org/uniprotkb/{acc}/entry#family_and_domains"
    if link:
        uniprot_head = (
            f"<a href='{link}' target='_blank' style='text-decoration: underline; "
            f"color: #4338ca;'>UniProt</a>:"
        )
    else:
        uniprot_head = "UniProt:"
    if parsed_data.get('has_critical_domain'):
        at_ptc = parsed_data.get('critical_domain_at_ptc') or []
        lost_ds = parsed_data.get('critical_domain_lost_downstream') or []
        ptc_aa = parsed_data.get('uniprot_ptc_aa')
        parts = []
        if at_ptc:
            parts.append(f"overlaps PTC region (Ter ~aa {ptc_aa}): {', '.join(at_ptc)}")
        if lost_ds:
            prefix = "truncation removes downstream"
            if not at_ptc and ptc_aa:
                prefix = (
                    f"no curated domain overlaps the PTC (Ter ~aa {ptc_aa}); "
                    f"truncation removes downstream"
                )
            parts.append(f"{prefix}: {', '.join(lost_ds)}")
        if not parts:
            parts.append(parsed_data.get('critical_domain_names', ''))
        body = f"{uniprot_head} {'; '.join(parts)}."
        sections.append(("", body))
    else:
        sections.append(("", f"{uniprot_head} No domain of interest."))


def _logic_indefinite_article(phrase):
    w = (phrase or '').strip().lower()
    if not w:
        return 'a'
    return 'an' if w[0] in 'aeiou' else 'a'


def _finalize_logic_explanation(parsed_data, sections):
    html_parts = []
    text_parts = []
    for _i, (cnt, desc) in enumerate(sections, 1):
        body = _logic_section_text_plain(desc) or ''
        cnt_s = (cnt or '').strip()
        if cnt_s:
            html_parts.append(f"<li style='margin-bottom: 6px;'><strong>{cnt_s}:</strong> {desc}</li>")
            if '\n' in body:
                text_parts.append(f"{cnt_s}:\n{body}")
            else:
                text_parts.append(f"{cnt_s}: {body}")
        else:
            html_parts.append(f"<li style='margin-bottom: 6px;'>{desc}</li>")
            text_parts.append(body)
    parsed_data['logic_explanation'] = (
        f"<ul style='margin-top: 5px; padding-left: 20px;'>{''.join(html_parts)}</ul>"
    )
    parsed_data['logic_explanation_plaintext'] = "\n\n".join(text_parts)


def _build_lof_variant_intro(parsed_data, effective_gene, c_dot, csq, is_start_loss, is_trunc):
    if _logic_csq_is_splice_context(csq, parsed_data) or parsed_data.get('is_splice_frameshift'):
        short = _build_splice_variant_intro_short(parsed_data, effective_gene, c_dot)
        if short:
            return short

    target_exon = parsed_data.get('variant_exon', '?')
    ptc_exon = parsed_data.get('snpeff_exon_rank', '?')
    hgvs_p = (parsed_data.get('hgvs_p') or '').strip()
    if is_start_loss:
        orig = parsed_data.get('original_consequence', 'start_lost')
        if orig != 'start_lost':
            if parsed_data.get('is_splice_frameshift'):
                v_type = 'structural splice LOF'
            elif 'frameshift' in (orig or ''):
                v_type = 'frameshift'
            else:
                v_type = 'nonsense'
            base = f"{effective_gene} {c_dot} → early {v_type} at exon {target_exon}"
            if ptc_exon != '?':
                base += f" (PTC in exon {ptc_exon})"
        else:
            base = f"{effective_gene} {c_dot} → primary start codon lost"
    else:
        if parsed_data.get('is_splice_frameshift'):
            v_type = 'structural splice LOF'
        elif 'frameshift' in csq:
            v_type = 'frameshift'
        else:
            v_type = 'nonsense'
        base = (
            f"{effective_gene} {c_dot} → {_logic_indefinite_article(v_type)} {v_type} "
            f"at exon {target_exon}"
        )
        if ptc_exon != '?':
            base += f" (PTC in exon {ptc_exon})"
    if hgvs_p and hgvs_p != '?':
        base += f"; {hgvs_p}"
    return base + "."


def _build_generic_variant_intro(effective_gene, c_dot, csq_display, target_exon, hgvs_p):
    art = _logic_indefinite_article(csq_display)
    if _is_noncoding_dna_hgvs(c_dot):
        body = (
            f"{effective_gene} {c_dot} → {art} noncoding-transcript ({csq_display}) allele"
        )
        if target_exon and str(target_exon) not in ("?", "0", ""):
            body += f" (transcript feature {target_exon})"
        body += ". Protein / NMD metrics do not apply; use RNA structure, ClinVar n., and clinical context."
        return body
    body = f"{effective_gene} {c_dot} → {art} {csq_display} at exon {target_exon}"
    hp = (hgvs_p or '').strip()
    if hp and hp not in ('?', ''):
        body += f" ({hp})"
    return body + "."


def _append_inframe_coding_logic_section(sections, parsed_data):
    out = parsed_data.get('inframe_coding_outcome')
    if not out:
        return
    lines = [out.get('op_phrase'), out.get('length_phrase')]
    note = (out.get('flagged_residue_note') or '').strip()
    aa3 = (out.get('flagged_residue_aa3') or '').strip()
    if note and aa3:
        lines.append(f"{aa3}: {note.rstrip('.')}")
    lines.append(out.get('verdict_short'))
    sections.append(("In-frame coding change", _logic_lines_block(*lines)))


def _collagen_gly_run_length(prot_seq, g_idx):
    """Consecutive Gly-X-Y repeats with a glycine anchor at ``g_idx`` (0-based)."""
    if g_idx < 0 or g_idx >= len(prot_seq) or prot_seq[g_idx] != 'G':
        return 0
    upstream = 0
    curr = g_idx - 3
    while curr >= 0 and prot_seq[curr] == 'G':
        upstream += 1
        curr -= 3
    downstream = 0
    curr = g_idx + 3
    while curr < len(prot_seq) and prot_seq[curr] == 'G':
        downstream += 1
        curr += 3
    return upstream + 1 + downstream


_COLLAGEN_GXG_LINKER_NOTE = (
    "Gly-X-Gly motifs are flexible regions between two triple-helical segments "
    "that facilitate the protein's overall conformation (PMID: 16919298). "
    "No theoretical score is applied for disruption in this region; "
    "however, investigation of functional impact may still be warranted."
)


def _collagen_is_gxg_triplet(prot_seq, g_idx):
    """True when triplet starting at 0-based ``g_idx`` is Gly-X-Gly (Y slot is Gly)."""
    if g_idx < 0 or g_idx + 2 >= len(prot_seq):
        return False
    return prot_seq[g_idx] == 'G' and prot_seq[g_idx + 2] == 'G'


def _collagen_gxg_linker_at_aa(prot_seq, aa_num):
    """
    True if 1-based ``aa_num`` lies in a native Gly-X-Gly linker triplet.
    Returns (in_linker, triplet_gly_idx_0based).
    """
    if not prot_seq or aa_num < 1:
        return False, -1
    idx = aa_num - 1
    if idx >= len(prot_seq):
        return False, -1
    for offset in (0, 1, 2):
        g_idx = idx - offset
        if _collagen_is_gxg_triplet(prot_seq, g_idx):
            return True, g_idx
    return False, -1


def _collagen_block_at_aa(prot_seq, aa_idx):
    """Return (block_repeat_count, gly_anchor_idx) for the Gly-X-Y block at ``aa_idx``."""
    if aa_idx < 0 or aa_idx >= len(prot_seq):
        return 0, -1
    best_run, best_g = 0, -1
    for offset in (0, 1, 2):
        g_idx = aa_idx - offset
        if g_idx < 0 or prot_seq[g_idx] != 'G':
            continue
        if aa_idx > g_idx + 2:
            continue
        run = _collagen_gly_run_length(prot_seq, g_idx)
        if run > best_run:
            best_run, best_g = run, g_idx
    return best_run, best_g


def _collagen_scan_indices(parsed_data, protein_anchor=None):
    """0-based protein indices to evaluate for Gly-X-Y motif disruption."""
    csq = (parsed_data.get('consequence') or '').lower()
    hgvs_p = (parsed_data.get('hgvs_p') or '').strip()
    indices = []

    start_cds = parsed_data.get('splice_target_start_cds')
    end_cds = parsed_data.get('splice_target_end_cds')
    if start_cds and end_cds:
        try:
            lo = (int(start_cds) - 1) // 3
            hi = (int(end_cds) - 1) // 3
            if hi >= lo:
                indices.extend(range(lo, hi + 1))
                return indices
        except (TypeError, ValueError):
            pass

    if 'inframe' in csq and hgvs_p:
        info = _parse_inframe_hgvs_p(hgvs_p)
        if info:
            lo = int(info['start_pos']) - 1
            hi = int(info['end_pos']) - 1
            if hi >= lo:
                indices.extend(range(lo, hi + 1))
                return indices

    if protein_anchor:
        indices.append(int(protein_anchor) - 1)
        return indices

    if hgvs_p:
        sub = _parse_missense_substitution_hgvs_p(hgvs_p)
        if sub:
            indices.append(int(sub['pos']) - 1)
            return indices
        fs_anchor = _protein_frameshift_anchor(hgvs_p)
        if fs_anchor:
            indices.append(int(fs_anchor) - 1)
            return indices
        pos = _protein_position_from_hgvs_p(hgvs_p)
        if pos:
            indices.append(int(pos) - 1)

    return indices


def _collagen_is_inframe_exon_skip(parsed_data):
    """The ≥9 Gly-X-Y repeat rule is for gly missense, not in-frame exon skip."""
    if parsed_data.get('splice_is_in_frame') is not True:
        return False
    return bool(
        parsed_data.get('splice_target_start_cds')
        and parsed_data.get('splice_target_end_cds')
    )


def _collagen_evaluate_skipped_exon_motif(prot_seq, scan_indices):
    """Gly-X-Y stats for in-frame exon skip: gly count in exon + native block span."""
    if not scan_indices:
        return None
    aa_lo = min(scan_indices)
    aa_hi = max(scan_indices)
    gly_count = 0
    max_native_block = 0
    seen_g = set()
    for idx in scan_indices:
        if idx < 0 or idx >= len(prot_seq):
            continue
        if prot_seq[idx] == 'G':
            gly_count += 1
        block_run, g_idx = _collagen_block_at_aa(prot_seq, idx)
        if g_idx >= 0 and g_idx not in seen_g:
            seen_g.add(g_idx)
        if block_run > max_native_block:
            max_native_block = block_run
    return {
        'aa_lo': aa_lo,
        'aa_hi': aa_hi,
        'gly_count': gly_count,
        'max_native_block': max_native_block,
        'exon_aa_len': aa_hi - aa_lo + 1,
    }


def _collagen_skipped_exon_motif_message(stats, parsed_data):
    exon = parsed_data.get('variant_exon') or '?'
    lo = stats['aa_lo'] + 1
    hi = stats['aa_hi'] + 1
    native = stats['max_native_block']
    native_txt = (
        f'{native} repeat(s) on the reference protein (includes flanking exons)'
        if native > 0
        else 'not in a native Gly-X-Y block on the reference protein'
    )
    return (
        'Collagen Motif Analysis -> '
        f'In-frame exon skip — skipped exon {exon} (aa {lo}–{hi}): '
        f'{stats["gly_count"]} glycine position(s) in the excised exon; '
        f'uninterrupted native Gly-X-Y block at this site: {native_txt}. '
        f'Note: for in-frame skipping, pathogenicity does not follow the '
        f'≥9 consecutive Gly-X-Y rule used for glycine missense variants — '
        f'use splice SOP (% protein lost, ClinVar in exon, domains) instead.'
    )


def _collagen_fetch_protein_sequence(parsed_data, transcript_input=''):
    """Return Ensembl reference protein sequence for collagen scans, or None."""
    enst = parsed_data.get('ensembl_transcript_id')
    tx = (transcript_input or '').strip()
    if not enst and tx and http_session is not None:
        try:
            xref_url = (
                f"https://rest.ensembl.org/xrefs/symbol/homo_sapiens/"
                f"{tx.split('.')[0]}"
            )
            xref_resp = http_session.get(xref_url, timeout=20)
            if xref_resp.status_code == 200:
                for obj in xref_resp.json():
                    if obj.get('id', '').startswith('ENST'):
                        enst = obj['id']
                        break
        except Exception:
            pass
    if not enst:
        parsed_data['collagen_math'] = (
            'Collagen Motif Analysis -> Transcript unavailable; motif scan skipped.'
        )
        return None
    try:
        clean_enst = enst.split('.')[0]
        seq_url = f"https://rest.ensembl.org/sequence/id/{clean_enst}?type=protein"
        seq_resp = http_session.get(seq_url, timeout=25)
        if seq_resp.status_code != 200:
            parsed_data['collagen_math'] = (
                'Collagen Motif Analysis -> Reference protein sequence unavailable.'
            )
            return None
        prot_seq = seq_resp.json().get('seq', '')
        if not prot_seq:
            parsed_data['collagen_math'] = (
                'Collagen Motif Analysis -> Reference protein sequence unavailable.'
            )
            return None
        return prot_seq
    except Exception as exc:
        print(f"Collagen protein fetch error: {exc}")
        parsed_data['collagen_math'] = (
            'Collagen Motif Analysis -> Reference protein sequence unavailable.'
        )
        return None


def _collagen_evaluate_motif(prot_seq, scan_indices):
    """Scan affected positions; return motif stats for collagen scoring."""
    max_total_g = -1
    motif_disrupted = False
    gly_positions_in_block = 0
    seen_g = set()
    in_gxg_linker = False

    for idx in scan_indices:
        if idx < 0 or idx >= len(prot_seq):
            continue
        if _collagen_gxg_linker_at_aa(prot_seq, idx + 1)[0]:
            in_gxg_linker = True
        block_run, g_idx = _collagen_block_at_aa(prot_seq, idx)
        if g_idx >= 0 and g_idx not in seen_g:
            seen_g.add(g_idx)
            if block_run > max_total_g:
                max_total_g = block_run
        if block_run >= 9 and not _collagen_is_gxg_triplet(prot_seq, g_idx):
            motif_disrupted = True
            if prot_seq[idx] == 'G':
                gly_positions_in_block += 1
        elif block_run >= 9 and _collagen_is_gxg_triplet(prot_seq, g_idx):
            # Long helix register passes through a Gly-X-Gly linker triplet — do not score.
            pass

    if in_gxg_linker:
        motif_disrupted = False

    gly_disrupted = gly_positions_in_block > 0

    return {
        'motif_disrupted': motif_disrupted,
        'gly_disrupted': gly_disrupted,
        'max_total_g': max_total_g,
        'gly_positions_in_block': gly_positions_in_block,
        'in_gxg_linker': in_gxg_linker,
    }


def _collagen_motif_message(parsed_data, stats, *, scan_indices, prot_seq=None):
    """Build collagen_math narrative from scan stats."""
    csq = (parsed_data.get('consequence') or '').lower()
    max_g = stats['max_total_g']
    gly_lost = stats['gly_positions_in_block']
    prefix = 'Collagen Motif Analysis -> '

    if stats.get('in_gxg_linker'):
        block_bit = ''
        if max_g != -1 and max_g > 0:
            block_bit = (
                f" Native Gly-X-Y register at this site spans {max_g} repeat(s); "
                f"the affected triplet is Gly-X-Gly (flexible linker), not triple-helical Gly-X-Y."
            )
        else:
            block_bit = " Variant maps to a Gly-X-Gly linker triplet on the reference protein."
        return prefix + block_bit + ' ' + _COLLAGEN_GXG_LINKER_NOTE

    if stats['motif_disrupted']:
        base = (
            f"Meets ≥9 consecutive Gly-X-Y repeats natively "
            f"(maximum block at variant site: {max_g} repeats)."
        )
        if 'splice' in csq or parsed_data.get('splice_target_start_cds'):
            return (
                prefix + base
                + f" Splice consequence disrupts triple-helix register, "
                f"excising {gly_lost} glycine position(s) from the block."
            )
        if 'inframe' in csq:
            if gly_lost > 0:
                return (
                    prefix + base
                    + f" In-frame change disrupts triple-helix register "
                    f"({gly_lost} glycine position(s) in the affected span)."
                )
            slot_txt = 'non-glycine slot in the affected triplet'
            if scan_indices and prot_seq:
                slot_txt = _collagen_residue_triplet_label(prot_seq, scan_indices[0] + 1)
            return (
                prefix + base
                + f" In-frame change in native Gly-X-Y register ({slot_txt}) "
                + "does not remove a glycine anchor — no collagen motif score."
            )
        if any(x in csq for x in ('frameshift', 'nonsense', 'stop_gained')):
            return prefix + base + " Truncation / frameshift disrupts triple-helix register."
        hgvs_p = (parsed_data.get('hgvs_p') or '').strip()
        sub = _parse_missense_substitution_hgvs_p(hgvs_p) if hgvs_p else None
        if sub and sub.get('ref_1') == 'G':
            return prefix + base + " Glycine substitution disrupts triple-helix."
        if sub and stats.get('motif_disrupted'):
            role = _collagen_triplet_role_at_aa(prot_seq, sub['pos']) if prot_seq else None
            slot = role or 'X/Y'
            return (
                prefix + base
                + f" {slot} substitution — does not replace a glycine anchor; no collagen motif score."
            )
        return prefix + base + " Variant falls within triple-helix Gly-X-Y motif."

    if max_g != -1:
        return (
            prefix
            + f"Does not meet ≥9 consecutive Gly-X-Y repeats natively (maximum block at variant site "
            + f"was only {max_g} repeats). Block is too structurally fragmented to "
            + "formally satisfy pathogenic motif criteria."
        )
    if scan_indices:
        return (
            prefix
            + "Variant mapped to protein coordinates but is not within a native "
            + "uninterrupted Gly-X-Y repeat block."
        )
    return prefix + "Could not map variant to protein coordinates for motif scan."


def _apply_collagen_motif_analysis(parsed_data, *, protein_anchor=None, transcript_input=''):
    """For COL genes, evaluate whether the variant disrupts Gly-X-Y triple-helix motifs."""
    parsed_data['collagen_disrupted'] = False
    parsed_data['collagen_math'] = ''

    gene = (parsed_data.get('gene_symbol') or parsed_data.get('gene') or '').strip()
    if not gene.upper().startswith('COL'):
        return

    if _collagen_is_inframe_exon_skip(parsed_data):
        scan_indices = _collagen_scan_indices(parsed_data, protein_anchor=protein_anchor)
        if not scan_indices:
            return
        prot_seq = _collagen_fetch_protein_sequence(parsed_data, transcript_input)
        if not prot_seq:
            return
        stats = _collagen_evaluate_skipped_exon_motif(prot_seq, scan_indices)
        if stats:
            parsed_data['collagen_skipped_exon_gly_count'] = stats['gly_count']
            parsed_data['collagen_skipped_exon_native_block'] = stats['max_native_block']
            parsed_data['collagen_math'] = _collagen_skipped_exon_motif_message(
                stats, parsed_data,
            )
        return

    scan_indices = _collagen_scan_indices(parsed_data, protein_anchor=protein_anchor)
    if not scan_indices:
        anchor = _protein_position_from_hgvs_p(parsed_data.get('hgvs_p') or '')
        if anchor:
            scan_indices = [anchor - 1]

    if not scan_indices:
        parsed_data['collagen_math'] = (
            'Collagen Motif Analysis -> Could not map variant to protein coordinates '
            'for motif scan.'
        )
        return

    prot_seq = _collagen_fetch_protein_sequence(parsed_data, transcript_input)
    if not prot_seq:
        return

    try:
        stats = _collagen_evaluate_motif(prot_seq, scan_indices)
        parsed_data['collagen_gxg_linker'] = bool(stats.get('in_gxg_linker'))
        parsed_data['collagen_disrupted'] = (
            bool(stats.get('gly_disrupted')) and not stats.get('in_gxg_linker')
        )
        parsed_data['collagen_math'] = _collagen_motif_message(
            parsed_data, stats, scan_indices=scan_indices, prot_seq=prot_seq,
        )
        max_g = stats.get('max_total_g', -1)
        if max_g >= 0:
            parsed_data['collagen_native_block_repeats'] = max_g
        if scan_indices:
            block_run, aa_lo, aa_hi = _collagen_gly_block_bounds(prot_seq, scan_indices[0])
            if block_run > 0:
                parsed_data['collagen_block_aa_lo'] = aa_lo
                parsed_data['collagen_block_aa_hi'] = aa_hi
    except Exception as exc:
        print(f"Collagen Gly-X-Y motif scan error: {exc}")
        parsed_data['collagen_math'] = (
            'Collagen Motif Analysis -> Motif scan failed (see server log).'
        )


def _collagen_motif_summary_plain(parsed_data):
    raw = (parsed_data.get('collagen_math') or '').strip()
    return raw.replace('Collagen Motif Analysis -> ', '').strip()


def _collagen_gly_block_bounds(prot_seq, aa_idx):
    """Return (repeat_count, aa_lo, aa_hi) 1-based for the native Gly-X-Y block at ``aa_idx``."""
    block_run, gly_anchor = _collagen_block_at_aa(prot_seq, aa_idx)
    if block_run <= 0 or gly_anchor < 0:
        return 0, None, None
    upstream = 0
    curr = gly_anchor - 3
    while curr >= 0 and prot_seq[curr] == 'G':
        upstream += 1
        curr -= 3
    start_g = gly_anchor - upstream * 3
    return block_run, start_g + 1, start_g + block_run * 3


def _collagen_in_native_block(prot_seq, aa_num):
    """True when aa_num lies in a reference Gly-X-Y run (G every third residue)."""
    if not prot_seq or aa_num < 1:
        return False
    block_run, g_idx = _collagen_block_at_aa(prot_seq, aa_num - 1)
    return block_run > 0 and g_idx >= 0


def _collagen_triplet_start_for_aa(prot_seq, aa_num):
    """0-based index of the Gly-X-Y triplet start containing aa_num (native block only)."""
    idx = aa_num - 1
    block_run, g_idx = _collagen_block_at_aa(prot_seq, idx)
    if block_run <= 0 or g_idx < 0:
        return None
    return g_idx + 3 * ((idx - g_idx) // 3)


def _collagen_triplet_role_at_aa(prot_seq, aa_num):
    """Gly / X / Y from native register, or None when not in a Gly-X-Y run."""
    if not prot_seq or aa_num < 1:
        return None
    idx = aa_num - 1
    if idx >= len(prot_seq):
        return None
    block_run, g_idx = _collagen_block_at_aa(prot_seq, idx)
    if block_run <= 0 or g_idx < 0:
        return None
    return ('Gly', 'X', 'Y')[(idx - g_idx) % 3]


def _collagen_triplet_kind_from_role(role):
    if not role:
        return 'protein_plain'
    return {
        'Gly': 'protein_gly',
        'X': 'protein_x',
        'Y': 'protein_y',
    }.get(role, 'protein_plain')


def _collagen_residue_triplet_label(prot_seq, aa_num, *, native_only=False):
    """Human label for the reference triplet containing aa_num (1-based)."""
    idx = aa_num - 1
    tri_start = _collagen_triplet_start_for_aa(prot_seq, aa_num)
    if tri_start is None:
        if native_only:
            return ''
        tri_start = (idx // 3) * 3
        parts = [
            f'{prot_seq[tri_start + i]}{tri_start + i + 1}'
            for i in range(3)
            if tri_start + i < len(prot_seq)
        ]
        return '–'.join(parts) + ' (not a native Gly-X-Y repeat)'
    parts = []
    for i in range(3):
        pos = tri_start + i + 1
        if pos - 1 >= len(prot_seq):
            break
        aa = prot_seq[pos - 1]
        role = ('Gly', 'X', 'Y')[i]
        parts.append(f'{aa}{pos} ({role})')
    label = '–'.join(parts)
    tri_g = tri_start
    if _collagen_is_gxg_triplet(prot_seq, tri_g):
        label += ' · Gly-X-Gly flexible linker'
    return label


def _collagen_native_repeats_in_aa_window(prot_seq, aa_lo, aa_hi):
    """Count native Gly-X-Y repeats with a G anchor in [aa_lo, aa_hi] (1-based, inclusive)."""
    if not prot_seq:
        return 0
    lo = max(1, int(aa_lo))
    hi = min(len(prot_seq), int(aa_hi))
    seen_g = set()
    total = 0
    for pos in range(lo, hi + 1):
        g_idx = pos - 1
        if g_idx in seen_g or prot_seq[g_idx] != 'G':
            continue
        run = _collagen_gly_run_length(prot_seq, g_idx)
        if run <= 0:
            continue
        seen_g.add(g_idx)
        total += run
    return total


def _collagen_inframe_del_bounds(parsed_data, info=None):
    """Return dict with aa_start, aa_end, cds_lo, cds_hi (1-based inclusive) for in-frame deletion."""
    c_dot = parsed_data.get('c_dot') or ''
    m = re.search(r'c\.(\d+)_(\d+)del', c_dot, re.I)
    if m:
        cds_lo, cds_hi = int(m.group(1)), int(m.group(2))
        if cds_lo <= cds_hi and (cds_hi - cds_lo + 1) % 3 == 0:
            aa_start = (cds_lo - 1) // 3 + 1
            aa_end = (cds_hi - 1) // 3 + 1
            return {
                'aa_start': aa_start,
                'aa_end': aa_end,
                'del_aa_count': aa_end - aa_start + 1,
                'cds_lo': cds_lo,
                'cds_hi': cds_hi,
            }
    m = re.search(r'c\.(\d+)del', c_dot, re.I)
    if m:
        cds_lo = int(m.group(1))
        if cds_lo >= 1:
            aa_start = (cds_lo - 1) // 3 + 1
            return {
                'aa_start': aa_start,
                'aa_end': aa_start,
                'del_aa_count': 1,
                'cds_lo': cds_lo,
                'cds_hi': cds_lo + 2,
            }

    if info is None:
        info = _parse_inframe_hgvs_p(parsed_data.get('hgvs_p') or '')
    if info and info.get('del_aa_count', 0) > 0:
        aa_start = int(info['start_pos'])
        aa_end = int(info['end_pos'])
        cds_lo = (aa_start - 1) * 3 + 1
        cds_hi = (aa_end - 1) * 3 + 3
        return {
            'aa_start': aa_start,
            'aa_end': aa_end,
            'del_aa_count': int(info['del_aa_count']),
            'cds_lo': cds_lo,
            'cds_hi': cds_hi,
        }
    return None


def _collagen_gly_junction_align_eligible(parsed_data):
    gene = (parsed_data.get('gene_symbol') or parsed_data.get('gene') or '').upper()
    if not gene.startswith('COL'):
        return False
    if not (parsed_data.get('cds_seq') or '').strip():
        return False
    csq = (parsed_data.get('consequence') or '').lower()
    if 'missense' in csq:
        sub = _parse_missense_substitution_hgvs_p(parsed_data.get('hgvs_p') or '')
        if sub and sub.get('pos'):
            return True
        if _protein_position_from_hgvs_p(parsed_data.get('hgvs_p') or ''):
            return True
        return False
    if 'inframe' in csq:
        info = _parse_inframe_hgvs_p(parsed_data.get('hgvs_p') or '')
        if info and info.get('del_aa_count', 0) > 0:
            return True
        return _collagen_inframe_del_bounds(parsed_data) is not None
    return False


def _collagen_gly_tx_alleles(cds, cds_pos, ref, alt):
    """Map forward-genomic ref/alt to transcript-oriented alleles for CDS substitution."""
    _comp = {'A': 'T', 'T': 'A', 'G': 'C', 'C': 'G', 'N': 'N'}
    ref = str(ref or '').upper()
    alt = str(alt or '').upper()
    tx_ref, tx_alt = ref, alt
    if len(ref) == 1 and len(alt) == 1 and 0 < cds_pos <= len(cds):
        txn_base = cds[cds_pos - 1]
        if ref and ref != txn_base and _comp.get(ref, '') == txn_base:
            tx_ref = _comp.get(ref, ref)
            tx_alt = _comp.get(alt, alt)
    return tx_ref, tx_alt


def _collagen_gly_junction_legend(native_register=True):
    items = [
        {'kind': 'exon', 'label': 'cDNA (reference / mutant)'},
    ]
    if native_register:
        items.extend([
            {'kind': 'protein_gly', 'label': 'Gly slot — reference has G at this anchor'},
            {'kind': 'protein_x', 'label': 'X slot (second position in native Gly-X-Y)'},
            {'kind': 'protein_y', 'label': 'Y slot (third position in native Gly-X-Y)'},
        ])
    else:
        items.append({
            'kind': 'protein_plain',
            'label': 'Protein — not in a native Gly-X-Y repeat (no slot coloring)',
        })
    items.append({'kind': 'variant', 'label': 'Red underline — variant site (compare reference vs mutant rows)'})
    return items


def _build_collagen_gly_inframe_del_viz(parsed_data, bounds):
    """Reference / mutant cDNA + protein tracks for COL in-frame deletions in Gly-X-Y register."""
    out = {'eligible': False, 'reason': ''}
    cds = (parsed_data.get('cds_seq') or '').upper()
    aa_start = int(bounds['aa_start'])
    aa_end = int(bounds['aa_end'])
    cds_lo = int(bounds['cds_lo'])
    cds_hi = int(bounds['cds_hi'])
    if cds_lo < 1 or cds_hi > len(cds) or cds_lo > cds_hi:
        out['reason'] = 'Could not resolve cDNA bounds for collagen in-frame deletion map.'
        return out

    prot_seq = _collagen_fetch_protein_sequence(parsed_data)
    if not prot_seq:
        out['reason'] = 'Reference protein sequence unavailable for collagen map.'
        return out

    mut_cds = cds[:cds_lo - 1] + cds[cds_hi:]
    window_codons = 5
    first_codon = max(0, aa_start - 1 - window_codons)
    last_codon = min(len(cds) // 3, aa_end + window_codons)
    lo = first_codon * 3 + 1
    hi = last_codon * 3
    ref_window = cds[lo - 1:hi]
    if len(ref_window) % 3:
        ref_window = ref_window[: len(ref_window) - (len(ref_window) % 3)]
        last_codon = first_codon + len(ref_window) // 3
    if not ref_window:
        out['reason'] = 'CDS window empty for collagen map.'
        return out

    mut_lo = lo
    mut_hi = hi - (cds_hi - cds_lo + 1)
    if mut_lo > len(mut_cds):
        out['reason'] = 'Mutant CDS window empty for collagen map.'
        return out
    mut_hi = min(mut_hi, len(mut_cds))
    mut_window = mut_cds[mut_lo - 1:mut_hi]
    if len(mut_window) % 3:
        mut_window = mut_window[: len(mut_window) - (len(mut_window) % 3)]
    if not mut_window:
        out['reason'] = 'Mutant CDS window empty for collagen map.'
        return out

    del_span_start = cds_lo - lo
    del_span_end = del_span_start + (cds_hi - cds_lo + 1)

    def _dna_bases(seq, *, offset_lo, del_start=None, del_end=None, variant_label='variant'):
        bases = []
        for i, nt in enumerate(seq):
            pos = offset_lo + i
            bases.append({'nt': nt, 'kind': 'exon', 'hgvs': f'c.{pos}'})
        spans = []
        if del_start is not None and del_end is not None:
            ds = max(0, del_start)
            de = min(len(bases), del_end)
            if de > ds:
                spans.append({
                    'start': ds,
                    'end': de,
                    'kind': 'variant',
                    'label': variant_label,
                })
        return bases, spans

    ref_bases, ref_spans = _dna_bases(
        ref_window,
        offset_lo=lo,
        del_start=del_span_start,
        del_end=del_span_end,
        variant_label=f'deleted c.{cds_lo}_{cds_hi}',
    )
    mut_bases, mut_spans = _dna_bases(mut_window, offset_lo=mut_lo)

    ref_window_aas = [
        prot_seq[ci] if ci < len(prot_seq) else 'X'
        for ci in range(first_codon, first_codon + len(ref_window) // 3)
    ]
    mut_aas = _translate_cds_aas(mut_window)

    anchor_aa = aa_start
    native_register = any(
        _collagen_in_native_block(prot_seq, pos)
        for pos in range(aa_start, aa_end + 1)
    )
    in_gxg_linker = any(
        _collagen_gxg_linker_at_aa(prot_seq, pos)[0]
        for pos in range(aa_start, aa_end + 1)
    )
    deleted_roles = []
    gly_removed = 0
    for pos in range(aa_start, aa_end + 1):
        role = _collagen_triplet_role_at_aa(prot_seq, pos)
        if role:
            deleted_roles.append(role)
        if pos - 1 < len(prot_seq) and prot_seq[pos - 1] == 'G':
            if _collagen_in_native_block(prot_seq, pos):
                gly_removed += 1
    primary_role = deleted_roles[0] if deleted_roles else None

    if in_gxg_linker:
        var_note = 'Gly-X-Gly flexible linker (no collagen motif score)'
    elif gly_removed > 0:
        var_note = f'removes {gly_removed} native glycine anchor(s)'
    elif native_register and primary_role:
        var_note = f'{primary_role} slot — does not remove a native Gly anchor'
    else:
        var_note = 'outside native Gly-X-Y block on reference protein'

    def _collagen_protein_bases(aas_window, *, allele='reference', codon_offset=first_codon):
        bases = []
        spans = []
        for local_ci, aa in enumerate(aas_window):
            ci = codon_offset + local_ci
            aa_num = ci + 1
            role = _collagen_triplet_role_at_aa(prot_seq, aa_num)
            is_deleted = allele == 'reference' and aa_start <= aa_num <= aa_end
            bases.append({
                'nt': aa if not is_deleted else f'{aa}',
                'kind': _collagen_triplet_kind_from_role(role),
                'hgvs': f'p.{aa}{aa_num}',
                'codon_span': 3,
                'triplet_role': role,
                'aa_num': aa_num,
            })
            if is_deleted:
                spans.append({
                    'start': local_ci,
                    'end': local_ci + 1,
                    'kind': 'variant',
                    'label': f'deleted p.{aa}{aa_num} ({var_note})',
                })
        return bases, spans

    ref_prot_bases, ref_prot_spans = _collagen_protein_bases(ref_window_aas, allele='reference')
    mut_prot_bases, mut_prot_spans = _collagen_protein_bases(
        mut_aas, allele='mutant', codon_offset=first_codon,
    )

    triplet_label = _collagen_residue_triplet_label(prot_seq, anchor_aa)
    motif_summary = _collagen_motif_summary_plain(parsed_data)
    block_run = parsed_data.get('collagen_native_block_repeats')
    try:
        block_run = int(block_run) if block_run is not None else 0
    except (TypeError, ValueError):
        block_run = 0
    block_aa_lo = parsed_data.get('collagen_block_aa_lo')
    block_aa_hi = parsed_data.get('collagen_block_aa_hi')

    window_aa_lo = first_codon + 1
    window_aa_hi = first_codon + len(ref_window_aas)
    window_gly_repeats = _collagen_native_repeats_in_aa_window(
        prot_seq, window_aa_lo, window_aa_hi,
    )

    if aa_start == aa_end:
        del_hgvs_p = f"p.{prot_seq[aa_start - 1] if aa_start - 1 < len(prot_seq) else 'Xaa'}{aa_start}del"
    else:
        ref_lo = prot_seq[aa_start - 1] if aa_start - 1 < len(prot_seq) else 'X'
        ref_hi = prot_seq[aa_end - 1] if aa_end - 1 < len(prot_seq) else 'X'
        del_hgvs_p = f'p.{ref_lo}{aa_start}_{ref_hi}{aa_end}del'

    if native_register:
        protein_summary = f'Native Gly-X-Y triplet at deletion: {triplet_label}'
    else:
        protein_summary = f'In-frame deletion {del_hgvs_p} · triplet {triplet_label}'
    if window_gly_repeats:
        protein_summary += f' · {window_gly_repeats} native repeat(s) in map window'

    gene = parsed_data.get('gene_symbol') or parsed_data.get('gene') or ''
    c_dot = parsed_data.get('c_dot') or ''
    hgvs_p = parsed_data.get('hgvs_p') or del_hgvs_p
    tracks = [
        {
            'id': 'reference',
            'title': 'Reference cDNA',
            'kind': 'reference',
            'bases': ref_bases,
            'spans': ref_spans,
            'markers': [],
        },
        {
            'id': 'mutant',
            'title': 'Mutant cDNA (in-frame deletion)',
            'kind': 'mutant',
            'bases': mut_bases,
            'spans': mut_spans,
            'markers': [],
        },
        {
            'id': 'protein_ref',
            'title': f'Protein (reference — {del_hgvs_p})',
            'kind': 'protein',
            'codon_aligned': True,
            'variant_style': 'underline',
            'bases': ref_prot_bases,
            'spans': ref_prot_spans,
            'markers': [],
        },
        {
            'id': 'protein_mut',
            'title': f'Protein (mutant — after deletion)',
            'kind': 'protein',
            'codon_aligned': True,
            'variant_style': 'underline',
            'bases': mut_prot_bases,
            'spans': mut_prot_spans,
            'markers': [],
            'summary': protein_summary,
        },
    ]

    collagen_gly_xy = {
        'motif_summary': motif_summary,
        'block_repeat_count': block_run,
        'block_aa_lo': block_aa_lo,
        'block_aa_hi': block_aa_hi,
        'window_repeat_count': window_gly_repeats,
        'meets_nine_rule': block_run >= 9 and not in_gxg_linker,
        'in_gxg_linker': in_gxg_linker,
        'gxg_linker_note': _COLLAGEN_GXG_LINKER_NOTE if in_gxg_linker else None,
        'variant_triplet': triplet_label,
        'variant_triplet_role': primary_role,
        'variant_at_gly': gly_removed > 0,
        'native_register': native_register,
        'reference_triplet': triplet_label,
        'reference_aa': del_hgvs_p,
        'mutant_aa': 'deleted',
        'inframe_deletion': True,
        'deleted_aa_count': bounds['del_aa_count'],
    }

    subtitle_extra = ''
    if block_run > 0:
        subtitle_extra = f' · maximum block at variant site: {block_run} repeat(s)'
        if window_gly_repeats:
            subtitle_extra += f' · {window_gly_repeats} in map window'

    return {
        'eligible': True,
        'map_type': 'collagen_gly',
        'title': f'{gene} collagen Gly-X-Y alignment',
        'subtitle': (
            f'{c_dot} ({hgvs_p}) · reference & mutant cDNA + reference & mutant protein '
            f'(red underline = deleted region) · mRNA/cDNA sense (A,C,G,T)'
            f'{subtitle_extra}'
        ),
        'anchor_hgvs': c_dot,
        'ruler': _junction_align_ruler_ticks(ref_bases, every=3),
        'tracks': tracks,
        'legend': _collagen_gly_junction_legend(native_register=native_register),
        'collagen_gly_xy': collagen_gly_xy,
        'launcher_label': 'Collagen Gly-X-Y sequence map',
        'launcher_hint': (
            'Reference and mutant cDNA with codon-aligned protein rows — '
            'shows which Gly-X-Y position is deleted and whether a glycine anchor is lost.'
        ),
    }


def _build_collagen_gly_junction_align_viz(parsed_data):
    """Reference / mutant cDNA + protein tracks for COL variants (Gly-X-Y register)."""
    out = {'eligible': False, 'reason': ''}
    gene = (parsed_data.get('gene_symbol') or parsed_data.get('gene') or '').upper()
    # Hard gate: Gly-X-Y maps are COL-only. Do not route non-COL in-frame dels here
    # (NIPBL c.6732_6734del regression: collagen launcher on a cohesin gene).
    if not gene.startswith('COL'):
        out['reason'] = 'Collagen Gly-X-Y map applies to COL gene variants.'
        return out

    csq = (parsed_data.get('consequence') or '').lower()
    if 'inframe' in csq:
        bounds = _collagen_inframe_del_bounds(parsed_data)
        if bounds:
            return _build_collagen_gly_inframe_del_viz(parsed_data, bounds)

    if not _collagen_gly_junction_align_eligible(parsed_data):
        if 'missense' not in csq and 'inframe' not in csq:
            out['reason'] = 'Collagen Gly-X-Y map applies to COL missense or in-frame deletion variants.'
        else:
            out['reason'] = 'CDS / protein coordinates unavailable for collagen alignment map.'
        return out

    cds = (parsed_data.get('cds_seq') or '').upper()
    ref = str(parsed_data.get('ref') or '').upper()
    alt = str(parsed_data.get('alt') or '').upper()
    sub = _parse_missense_substitution_hgvs_p(parsed_data.get('hgvs_p') or '')
    if not sub or not sub.get('pos'):
        pos = _protein_position_from_hgvs_p(parsed_data.get('hgvs_p') or '')
        if not pos:
            out['reason'] = 'Could not parse protein position for collagen map.'
            return out
        sub = {'pos': pos, 'ref_1': 'X', 'alt_1': 'X', 'ref_3': 'Xaa', 'alt_3': 'Xaa'}
    aa_pos = int(sub['pos'])
    aa_idx = aa_pos - 1

    prot_seq = _collagen_fetch_protein_sequence(parsed_data)
    if not prot_seq:
        out['reason'] = 'Reference protein sequence unavailable for collagen map.'
        return out

    cds_pos = parsed_data.get('snpeff_cds_pos')
    try:
        cds_pos = int(cds_pos or 0)
    except (TypeError, ValueError):
        cds_pos = 0
    if cds_pos <= 0:
        m = re.search(r'c\.(\d+)', parsed_data.get('c_dot') or '', re.I)
        if m:
            cds_pos = int(m.group(1))
    if cds_pos <= 0 or cds_pos > len(cds):
        out['reason'] = 'Could not resolve cDNA position for collagen map.'
        return out

    tx_ref, tx_alt = _collagen_gly_tx_alleles(cds, cds_pos, ref, alt)
    codon_idx = (cds_pos - 1) // 3
    window_codons = 5
    first_codon = max(0, codon_idx - window_codons)
    last_codon = min(len(cds) // 3, codon_idx + window_codons + 1)
    lo = first_codon * 3 + 1
    hi = last_codon * 3
    window = cds[lo - 1:hi]
    if len(window) % 3:
        window = window[: len(window) - (len(window) % 3)]
        last_codon = first_codon + len(window) // 3
    if not window:
        out['reason'] = 'CDS window empty for collagen map.'
        return out

    var_offset = cds_pos - lo

    def _dna_bases(seq, *, variant_offset=None, variant_label='variant'):
        bases = []
        for i, nt in enumerate(seq):
            pos = lo + i
            bases.append({'nt': nt, 'kind': 'exon', 'hgvs': f'c.{pos}'})
        spans = []
        if variant_offset is not None and 0 <= variant_offset < len(bases):
            spans.append({
                'start': variant_offset,
                'end': variant_offset + 1,
                'kind': 'variant',
                'label': variant_label,
            })
        return bases, spans

    ref_bases, ref_spans = _dna_bases(window, variant_offset=var_offset, variant_label=f'WT {tx_ref}')

    mut_seq = window
    if (len(tx_ref) == 1 and len(tx_alt) == 1
            and 0 <= var_offset < len(window) and window[var_offset] == tx_ref):
        mut_seq = window[:var_offset] + tx_alt + window[var_offset + 1:]
    mut_bases, mut_spans = _dna_bases(
        mut_seq, variant_offset=var_offset, variant_label=f'variant {tx_alt}',
    )

    mut_aas = _translate_cds_aas(mut_seq)
    ref_window_aas = [
        prot_seq[ci] if ci < len(prot_seq) else 'X'
        for ci in range(first_codon, first_codon + len(mut_aas))
    ]
    native_register = _collagen_in_native_block(prot_seq, aa_pos)
    in_gxg_linker = _collagen_gxg_linker_at_aa(prot_seq, aa_pos)[0]
    variant_role = _collagen_triplet_role_at_aa(prot_seq, aa_pos)
    ref_aa = sub.get('ref_1') or (prot_seq[aa_idx] if aa_idx < len(prot_seq) else 'X')
    var_local = codon_idx - first_codon
    alt_aa = sub.get('alt_1') or (mut_aas[var_local] if 0 <= var_local < len(mut_aas) else 'X')

    if in_gxg_linker:
        var_note = 'Gly-X-Gly flexible linker (no collagen motif score)'
    elif native_register and variant_role == 'Gly':
        var_note = 'disrupts native collagen Gly anchor'
    elif native_register:
        var_note = f'{variant_role} slot — does not replace native Gly anchor'
    else:
        var_note = 'outside native Gly-X-Y block on reference protein'

    def _collagen_protein_bases(aas_window, *, allele='reference'):
        bases = []
        spans = []
        for local_ci, ci in enumerate(range(first_codon, first_codon + len(aas_window))):
            if local_ci >= len(aas_window):
                break
            aa = aas_window[local_ci]
            aa_num = ci + 1
            is_var = ci == codon_idx
            role = _collagen_triplet_role_at_aa(prot_seq, aa_num)
            bases.append({
                'nt': aa,
                'kind': _collagen_triplet_kind_from_role(role),
                'hgvs': f'p.{aa}{aa_num}',
                'codon_span': 3,
                'triplet_role': role,
                'aa_num': aa_num,
            })
            if is_var:
                if allele == 'reference':
                    span_label = f'reference p.{aa}{aa_num} at variant site ({var_note})'
                else:
                    span_label = f'mutant p.{ref_aa}{aa_num}→{alt_aa}{aa_num} ({var_note})'
                spans.append({
                    'start': local_ci,
                    'end': local_ci + 1,
                    'kind': 'variant',
                    'label': span_label,
                })
        return bases, spans

    ref_prot_bases, ref_prot_spans = _collagen_protein_bases(ref_window_aas, allele='reference')
    mut_prot_bases, mut_prot_spans = _collagen_protein_bases(mut_aas, allele='mutant')

    triplet_label = _collagen_residue_triplet_label(prot_seq, aa_pos)

    motif_summary = _collagen_motif_summary_plain(parsed_data)
    block_run = parsed_data.get('collagen_native_block_repeats')
    try:
        block_run = int(block_run) if block_run is not None else 0
    except (TypeError, ValueError):
        block_run = 0
    block_aa_lo = parsed_data.get('collagen_block_aa_lo')
    block_aa_hi = parsed_data.get('collagen_block_aa_hi')

    window_aa_lo = first_codon + 1
    window_aa_hi = first_codon + len(mut_aas)
    window_gly_repeats = _collagen_native_repeats_in_aa_window(
        prot_seq, window_aa_lo, window_aa_hi,
    )

    if native_register:
        protein_summary = f'Native Gly-X-Y triplet: {triplet_label}'
    else:
        protein_summary = (
            f'Reference p.{ref_aa}{aa_pos} → mutant p.{alt_aa}{aa_pos} · '
            f'triplet {triplet_label}'
        )
    if window_gly_repeats:
        protein_summary += f' · {window_gly_repeats} native repeat(s) in map window'

    gene = parsed_data.get('gene_symbol') or parsed_data.get('gene') or ''
    c_dot = parsed_data.get('c_dot') or ''
    hgvs_p = parsed_data.get('hgvs_p') or ''
    tracks = [
        {
            'id': 'reference',
            'title': 'Reference cDNA',
            'kind': 'reference',
            'bases': ref_bases,
            'spans': ref_spans,
            'markers': [],
        },
        {
            'id': 'mutant',
            'title': 'Mutant cDNA',
            'kind': 'mutant',
            'bases': mut_bases,
            'spans': mut_spans,
            'markers': [],
        },
        {
            'id': 'protein_ref',
            'title': f'Protein (reference — p.{ref_aa}{aa_pos})',
            'kind': 'protein',
            'codon_aligned': True,
            'variant_style': 'underline',
            'bases': ref_prot_bases,
            'spans': ref_prot_spans,
            'markers': [],
        },
        {
            'id': 'protein_mut',
            'title': f'Protein (mutant — p.{alt_aa}{aa_pos})',
            'kind': 'protein',
            'codon_aligned': True,
            'variant_style': 'underline',
            'bases': mut_prot_bases,
            'spans': mut_prot_spans,
            'markers': [],
            'summary': protein_summary,
        },
    ]

    collagen_gly_xy = {
        'motif_summary': motif_summary,
        'block_repeat_count': block_run,
        'block_aa_lo': block_aa_lo,
        'block_aa_hi': block_aa_hi,
        'window_repeat_count': window_gly_repeats,
        'meets_nine_rule': block_run >= 9 and not in_gxg_linker,
        'in_gxg_linker': in_gxg_linker,
        'gxg_linker_note': _COLLAGEN_GXG_LINKER_NOTE if in_gxg_linker else None,
        'variant_triplet': triplet_label,
        'variant_triplet_role': variant_role,
        'variant_at_gly': bool(native_register and variant_role == 'Gly' and ref_aa == 'G'),
        'native_register': native_register,
        'reference_triplet': triplet_label,
        'reference_aa': f'{ref_aa}{aa_pos}',
        'mutant_aa': f'{alt_aa}{aa_pos}',
    }

    subtitle_extra = ''
    if block_run > 0:
        subtitle_extra = f' · maximum block at variant site: {block_run} repeat(s)'
        if window_gly_repeats:
            subtitle_extra += f' · {window_gly_repeats} in map window'

    return {
        'eligible': True,
        'map_type': 'collagen_gly',
        'title': f'{gene} collagen Gly-X-Y alignment',
        'subtitle': (
            f'{c_dot} ({hgvs_p}) · reference & mutant cDNA + reference & mutant protein '
            f'(red underline = variant site, not Gly-anchor coloring) · mRNA/cDNA sense (A,C,G,T)'
            f'{subtitle_extra}'
        ),
        'anchor_hgvs': c_dot,
        'ruler': _junction_align_ruler_ticks(ref_bases, every=3),
        'tracks': tracks,
        'legend': _collagen_gly_junction_legend(native_register=native_register),
        'collagen_gly_xy': collagen_gly_xy,
        'launcher_label': 'Collagen Gly-X-Y sequence map',
        'launcher_hint': (
            'Reference and mutant cDNA with codon-aligned protein row — '
            'shows which Gly-X-Y position is disrupted and how many repeats are in the block.'
        ),
    }


def _append_collagen_logic_section(sections, parsed_data):
    raw = (parsed_data.get('collagen_math') or '').strip()
    if not raw:
        return
    text = raw.replace('Collagen Motif Analysis -> ', '').strip()
    sections.append(("Collagen motif", _logic_lines_block(text)))


def _format_allele_entries_plain(alleles):
    """Plain-text ClinVar allele lines for logic / copy-paste."""
    out = []
    for a in alleles or []:
        if not isinstance(a, dict):
            continue
        hgvs_c = (a.get('hgvs_c') or '').strip()
        hgvs_p = (a.get('hgvs_p') or '').strip()
        if hgvs_c and hgvs_p and hgvs_c != hgvs_p:
            hgvs = f"{hgvs_c} / {hgvs_p}"
        elif hgvs_p:
            hgvs = hgvs_p
        else:
            hgvs = hgvs_c or '?'
        sig = (a.get('significance') or '?').strip()
        vid = (a.get('vid') or '?').strip()
        out.append(f"{hgvs} ({sig}) [VID: {vid}]")
    return out


def _allelic_nucleotide_change_lines(parsed_data):
    """P/LP or VUS at the same c. locus / splice junction."""
    lines = []
    alts = parsed_data.get('alternate_alleles') or []
    vus = parsed_data.get('vus_alternate_alleles') or []
    sj = parsed_data.get('splice_junction_alleles') or []
    sjv = parsed_data.get('splice_junction_vus_alleles') or []
    if alts:
        lines.extend(_format_allele_entries_plain(alts))
    elif vus:
        lines.extend(_format_allele_entries_plain(vus))
    if sj:
        lines.extend(_format_allele_entries_plain(sj))
    elif sjv:
        lines.extend(_format_allele_entries_plain(sjv))
    return lines


def _allelic_amino_acid_change_lines(parsed_data):
    """P/LP or VUS at the exact same protein residue (different nucleotide change).

    Regional ±5 aa neighbors belong in nearby-residue context, not here.
    """
    lines = []
    seen_vids = set()
    for a in (parsed_data.get('same_protein_position_alleles') or []) + (
        parsed_data.get('pm5_local_alleles') or []
    ):
        vid = str(a.get('vid') or '').strip()
        if vid and vid in seen_vids:
            continue
        if vid:
            seen_vids.add(vid)
        lines.extend(_format_allele_entries_plain([a]))
    det = parsed_data.get('different_pathogenic_details') or {}
    if parsed_data.get('different_pathogenic') and det:
        vid = str(det.get('vid') or '').strip()
        if vid and vid in seen_vids:
            return lines
        if vid:
            seen_vids.add(vid)
        p_str = (det.get('hgvs_p') or 'pathogenic colocalization').strip()
        c_str = (det.get('hgvs_c') or '').strip()
        vid_disp = vid or '?'
        if c_str and p_str:
            hgvs = f"{c_str} / {p_str}"
        else:
            hgvs = p_str or c_str or '?'
        lines.append(f"{hgvs} (Pathogenic) [VID: {vid_disp}]")
    return lines


def _allelic_nearby_residue_change_lines(parsed_data):
    """P/LP within ±5 aa of the curated residue (not the same codon)."""
    lines = []
    seen_vids = set()
    for a in (parsed_data.get('same_protein_position_alleles') or []) + (
        parsed_data.get('pm5_local_alleles') or []
    ):
        vid = str(a.get('vid') or '').strip()
        if vid:
            seen_vids.add(vid)
    det = parsed_data.get('different_pathogenic_details') or {}
    if parsed_data.get('different_pathogenic') and det.get('vid'):
        seen_vids.add(str(det.get('vid')).strip())
    for a in parsed_data.get('regional_hotspot') or []:
        vid = str(a.get('vid') or '').strip()
        if vid and vid in seen_vids:
            continue
        if vid:
            seen_vids.add(vid)
        lines.extend(_format_allele_entries_plain([a]))
    return lines


def _append_clingen_logic_section(sections, parsed_data, effective_gene=None):
    """ClinGen haploinsufficiency curation — always first in logic explanation."""
    gene = (
        (effective_gene or parsed_data.get('gene_symbol') or parsed_data.get('gene') or '')
        .strip()
    )
    if parsed_data.get('has_clingen'):
        score = str(parsed_data.get('clingen_haplo_score') or '').strip()
        if score and score.upper() != 'N/A':
            body = f"{gene}: haploinsufficiency score {score}."
        else:
            body = f"{gene}: curated in ClinGen (haplo score not reported)."
    else:
        label = gene or 'Gene'
        body = f"{label}: not in local ClinGen curation list."
    sections.append(("ClinGen", body))


def _append_allelic_context_logic_sections(sections, parsed_data):
    """
    Local ClinVar allele context — structured for report / Excel copy-paste.
    Noncoding track: genomic / n. neighbors instead of codon / ±5 aa.
    """
    if parsed_data.get("noncoding_track"):
        lines = []
        neighbors = parsed_data.get("noncoding_clinvar_neighbors") or []
        if neighbors:
            bits = []
            for h in neighbors[:6]:
                lab = (h.get("hgvs") or f"pos {h.get('pos')}").strip()
                bits.append(
                    f"{lab} ({h.get('significance') or 'P/LP'}; VID {h.get('vid') or '?'})"
                )
            lines.append("Nearby ClinVar P/LP (RNA locus): " + "; ".join(bits))
        else:
            lines.append("Nearby ClinVar P/LP (RNA locus): none in scanned window")
        links = parsed_data.get("noncoding_clinvar_search_links") or {}
        if links.get("allele"):
            lines.append(f"ClinVar n. allele search: {links['allele']}")
        if links.get("gene_plp"):
            lines.append(f"ClinVar gene P/LP search: {links['gene_plp']}")
        scan_note = (parsed_data.get("local_clinvar_scan_note") or "").strip()
        if scan_note:
            lines.append(scan_note)
        sections.append(("Allelic context (noncoding)", _logic_lines_block(*lines)))
        return

    lines = []
    nuc = _allelic_nucleotide_change_lines(parsed_data)
    aa = _allelic_amino_acid_change_lines(parsed_data)
    nearby = _allelic_nearby_residue_change_lines(parsed_data)

    if nuc:
        lines.append("Same nucleotide change: " + "; ".join(nuc))
    else:
        lines.append("Same nucleotide change: none")

    if aa:
        lines.append("Same amino acid change: " + "; ".join(aa))
    else:
        lines.append("Same amino acid change: none")

    if nearby:
        lines.append("Nearby residue (±5 aa): " + "; ".join(nearby))
    else:
        lines.append("Nearby residue (±5 aa): none")

    alt_tx = parsed_data.get("alternate_transcript_literature") or []
    if alt_tx:
        vid = str(parsed_data.get("clinvar_rcv") or "").strip() or "?"
        lines.append(
            f"Alternate isoform HGVS (ClinVar VID {vid}): "
            f"{len(alt_tx)} other transcript name(s) included in literature search."
        )

    scan_note = (parsed_data.get("local_clinvar_scan_note") or "").strip()
    if scan_note:
        lines.append(scan_note)

    sections.append(("Allelic context", _logic_lines_block(*lines)))


def _append_clinical_overlap_sections(sections, parsed_data):
    if parsed_data.get('identical_pathogenic'):
        acc = parsed_data.get('identical_pathogenic_rcv', '')
        sections.append((
            "Clinical context",
            f"Exact Pathogenic match in ClinVar ({acc}).",
        ))
    elif parsed_data.get('different_pathogenic'):
        # Allelic & locus context lists the specific P/LP allele + VID; skip duplicate generic line.
        if not (parsed_data.get('different_pathogenic_details') or {}):
            sections.append((
                "Clinical context",
                "Different amino acid change at the same codon is Pathogenic in ClinVar.",
            ))
    elif parsed_data.get('inframe_overlap_pathogenic'):
        sections.append((
            "Clinical context",
            "Established Pathogenic variant falls inside this in-frame indel interval.",
        ))
    elif parsed_data.get('internal_hotspot'):
        hs_vars = parsed_data.get('internal_hotspot')
        if isinstance(hs_vars, dict) and hs_vars:
            link_parts = []
            for vid, hgvs in list(hs_vars.items())[:6]:
                hgvs_disp = (hgvs or "").strip() or "—"
                label = (
                    f"{hgvs_disp} "
                    f"<span style='color:#374151;font-weight:600;'>[ClinVar Variation ID: {vid}]</span>"
                )
                link_parts.append(
                    f"<a href='https://www.ncbi.nlm.nih.gov/clinvar/variation/{vid}/' "
                    f"target='_blank' style='text-decoration: underline; color: #4338ca;'>{label}</a>"
                )
            v_str = ", ".join(link_parts)
            if len(hs_vars) > 6:
                v_str += f", and {len(hs_vars) - 6} others"
            sections.append((
                "Hotspot",
                f"≥3 ClinVar P/LP variants within ±5 aa ({len(hs_vars)} total).<br>"
                f"<span style='font-size: 0.95em; color: #4b5563;'>{v_str}</span>",
            ))
        else:
            sections.append((
                "Hotspot",
                "≥3 ClinVar P/LP variants within ±5 aa at this locus.",
            ))


def _vcf_record_genomic_end(rec):
    try:
        return int(rec.pos) + max(len(rec.ref or ""), 1) - 1
    except (TypeError, ValueError):
        return int(rec.pos)


def _genomic_intervals_overlap(a_start, a_end, b_start, b_end):
    try:
        a0, a1 = int(a_start), int(a_end or a_start)
        b0, b1 = int(b_start), int(b_end or b_start)
    except (TypeError, ValueError):
        return False
    if a0 > a1:
        a0, a1 = a1, a0
    if b0 > b1:
        b0, b1 = b1, b0
    return a0 <= b1 and b0 <= a1


def _genomic_intervals_near_or_overlap(a_start, a_end, b_start, b_end, max_gap=30):
    """Overlap, or within ``max_gap`` bp (microsatellite left/right-shift of same del)."""
    if _genomic_intervals_overlap(a_start, a_end, b_start, b_end):
        return True
    try:
        a0, a1 = int(a_start), int(a_end or a_start)
        b0, b1 = int(b_start), int(b_end or b_start)
    except (TypeError, ValueError):
        return False
    if a0 > a1:
        a0, a1 = a1, a0
    if b0 > b1:
        b0, b1 = b1, b0
    if a1 < b0:
        return (b0 - a1) <= max_gap
    if b1 < a0:
        return (a0 - b1) <= max_gap
    return False


def _resolve_clinvar_from_genomic_locus(
    parsed_data, http_session, effective_gene, target_transcript=None, c_dot=None, overwrite=False
):
    """
    Resolve ClinVar Variation ID from local GRCh38 VCF at the VEP genomic locus.
    HGVS c. strings alone are unreliable (ClinVar may use c.391del vs lab c.382del); anchor on
    coordinates + transcript/protein concordance instead of MyVariant text search.
    """
    vcf = _clinvar_vcf()
    if vcf is None:
        return False
    chrom = str(parsed_data.get("grch38_chrom") or "").replace("chr", "").strip()
    start = parsed_data.get("grch38_start")
    if not chrom or not start:
        return False
    try:
        g0 = int(start)
        g1 = int(parsed_data.get("grch38_end") or start)
    except (TypeError, ValueError):
        return False
    if g0 > g1:
        g0, g1 = g1, g0

    existing = str(parsed_data.get("clinvar_rcv") or "").strip()
    if existing and not overwrite:
        return False

    fetch_start = max(0, g0 - 25)
    fetch_end = g1 + 25
    candidate_ids = []
    id_to_rec = {}
    try:
        for rec in vcf.fetch(str(chrom), fetch_start, fetch_end):
            if not rec.id or str(rec.id) in ("None", "."):
                continue
            gene_info = rec.info.get("GENEINFO", "")
            if effective_gene and not _clinvar_geneinfo_matches(gene_info, effective_gene):
                continue
            # Exact overlap first; for indels also allow nearby (±30 bp) so
            # left- vs right-shifted microsatellite alleles still score
            # (NIPBL c.6732_6734del / ClinVar c.6726AGA[2]).
            rec_end = _vcf_record_genomic_end(rec)
            q_class = _c_dot_change_class(_myvariant_c_dot_tail_norm(c_dot))
            if q_class in ("del", "dup", "ins", "indel"):
                if not _genomic_intervals_near_or_overlap(g0, g1, rec.pos, rec_end, max_gap=30):
                    continue
            elif not _genomic_intervals_overlap(g0, g1, rec.pos, rec_end):
                continue
            vid = str(rec.id).strip()
            if vid not in id_to_rec:
                candidate_ids.append(vid)
                id_to_rec[vid] = rec
    except Exception as e:
        print(f"Local ClinVar genomic scan error: {e}")
        return False

    if not candidate_ids:
        return False

    from vc_engine.source_mode import clinvar_remote_active

    remote = clinvar_remote_active()
    summaries = _fetch_clinvar_esummary_map(http_session, candidate_ids[:25]) if remote else {}
    hgvs_p = parsed_data.get("hgvs_p") or ""
    best_uid = None
    best_score = 0
    best_sig = None
    best_rec = None

    for uid in candidate_ids:
        rec = id_to_rec.get(uid)
        result_obj = summaries.get(uid) or {}
        vs0 = (result_obj.get("variation_set") or [{}])[0]
        variation_name = vs0.get("variation_name") or result_obj.get("title") or ""
        score = _clinvar_variation_name_score(
            variation_name, effective_gene, target_transcript, c_dot, hgvs_p=hgvs_p
        )
        if not remote and rec is not None:
            # The indexed VCF record is the ClinVar answer; do not require an NCBI title.
            score = max(score, 100)
        elif score < 40:
            # Same locus + gene + overlapping indel when user asked for a deletion/frameshift
            q_class = _c_dot_change_class(_myvariant_c_dot_tail_norm(c_dot))
            if q_class in ("del", "dup", "ins", "indel") and rec is not None:
                score = 25
        if score > best_score:
            best_score = score
            best_uid = uid
            best_sig = _clinvar_sig_from_esummary_obj(result_obj)
            if rec is not None and "CLNSIG" in rec.info:
                raw = rec.info.get("CLNSIG", [""])[0]
                best_sig = str(raw).replace(",_", ", ").replace("_", " ")
            best_rec = rec

    if not best_uid:
        return False

    min_accept = 60 if hgvs_p else 40
    if c_dot and _c_dot_requires_exact_allele_match(c_dot):
        min_accept = 100
        if hgvs_p and best_score >= 70:
            min_accept = 70
    if best_score < min_accept:
        return False

    if existing and existing == best_uid:
        return False

    parsed_data["clinvar_rcv"] = best_uid
    if best_sig:
        parsed_data["clinvar_sig"] = best_sig
    print(
        f"ClinVar genomic resolve: {effective_gene} {c_dot} -> VID {best_uid} "
        f"(score={best_score}, replaced={existing or 'none'})"
    )
    return True


def _pick_clinvar_from_esearch(http_session, effective_gene, c_dot, target_transcript=None, hgvs_p=None):
    """ClinVar ESearch with esummary disambiguation — never trust idlist[0] alone."""
    from vc_engine.source_mode import clinvar_remote_active

    if not clinvar_remote_active():
        return None, None, 0
    try:
        search_terms = [f'{effective_gene}[gene] AND "{c_dot}"']
        nm_base = (target_transcript or "").split(".")[0].upper()
        if nm_base:
            search_terms.append(f'{effective_gene}[gene] AND {nm_base}:"{c_dot}"')
        nm_full = (target_transcript or "").strip()
        if nm_full.upper().startswith("NM_"):
            search_terms.append(f"{nm_full}:{c_dot}")
        search_terms.append(f"{effective_gene}[gene] AND {c_dot}")
        for stem in _clinvar_esearch_stem_terms(c_dot):
            search_terms.append(f"{effective_gene}[gene] AND {stem}")
            if nm_base:
                search_terms.append(f'{effective_gene}[gene] AND {nm_base}:"{stem}"')
        if hgvs_p:
            p_tail = str(hgvs_p).strip()
            if ":" in p_tail:
                p_tail = p_tail.split(":")[-1].strip()
            if p_tail.lower().startswith("p."):
                search_terms.append(f'{effective_gene}[gene] AND "{p_tail}"')
                # One-letter p.E2244del often misses ClinVar's p.Glu2244del indexing.
                try:
                    p3 = _normalize_hgvs_p_to_3letter(p_tail)
                except Exception:
                    p3 = ""
                if p3 and p3.lower() != p_tail.lower():
                    search_terms.append(f'{effective_gene}[gene] AND "{p3}"')
                    if p3.lower().startswith("p."):
                        search_terms.append(f'{effective_gene}[gene] AND "{p3[2:]}"')
        es_ids = []
        seen_ids = set()
        for term in search_terms:
            es_url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
            es_resp = http_session.get(
                es_url, params={"db": "clinvar", "term": term, "retmode": "json"}, timeout=10,
            )
            if es_resp.status_code != 200:
                continue
            for uid in es_resp.json().get("esearchresult", {}).get("idlist", []):
                if uid not in seen_ids:
                    seen_ids.add(uid)
                    es_ids.append(uid)
        if not es_ids:
            return None, None, 0
        summaries = _fetch_clinvar_esummary_map(http_session, es_ids[:20])
        best_uid = None
        best_sig = None
        best_score = 0
        for uid in es_ids:
            result_obj = summaries.get(str(uid)) or {}
            vs0 = (result_obj.get("variation_set") or [{}])[0]
            variation_name = vs0.get("variation_name") or result_obj.get("title") or ""
            score = _clinvar_variation_name_score(
                variation_name, effective_gene, target_transcript, c_dot, hgvs_p=hgvs_p
            )
            if score > best_score:
                best_score = score
                best_uid = str(uid)
                best_sig = _clinvar_sig_from_esummary_obj(result_obj)
        if best_score >= 70:
            return best_uid, best_sig, best_score
        return None, None, best_score
    except Exception as e:
        print(f"ClinVar esearch pick error: {e}")
        return None, None, 0


def _protein_position_from_hgvs_p(hgvs_p):
    sub = _parse_missense_substitution_hgvs_p(hgvs_p)
    if sub:
        return sub["pos"]
    pos_vals = _protein_positions_from_text_blob(hgvs_p)
    return pos_vals[0] if pos_vals else None


def _missense_same_aa_change(hgvs_p_a, hgvs_p_b):
    a = _parse_missense_substitution_hgvs_p(hgvs_p_a)
    b = _parse_missense_substitution_hgvs_p(hgvs_p_b)
    if not a or not b or a["pos"] != b["pos"]:
        return False
    return a["ref_1"] == b["ref_1"] and a["alt_1"] == b["alt_1"]


def _transcript_base_id(transcript):
    tx = (transcript or "").strip().replace(" ", "")
    if "." in tx:
        tx = tx.split(".")[0]
    return tx.upper()


def _snpeff_ann_on_transcript(ann, transcript_base):
    fid = (ann.get("feature_id") or "").strip()
    fid_base = fid.split(".")[0].upper() if "." in fid else fid.upper()
    if transcript_base:
        return fid_base == transcript_base
    return fid_base.startswith("NM_")


def _ann_protein_position(ann):
    if not ann or not isinstance(ann, dict):
        return None
    pos_str = (ann.get("protein") or {}).get("position", "")
    if not pos_str:
        return None
    try:
        return int(str(pos_str).split("/")[0])
    except (TypeError, ValueError):
        return None


def _pick_snpeff_ann_for_transcript(ann_list, transcript_base, target_pos=None):
    """
    Pick snpeff annotation on the user's transcript.
    When target_pos is set, prefer the row at that protein index (TUBB has multiple
    p. entries on NM_178014 — first match alone can be the wrong residue).
    """
    if isinstance(ann_list, dict):
        ann_list = [ann_list]
    if not ann_list:
        return None
    on_tx = []
    for a in ann_list:
        if transcript_base and not _snpeff_ann_on_transcript(a, transcript_base):
            continue
        on_tx.append(a)
    if transcript_base and not on_tx:
        return None
    if target_pos is not None:
        try:
            tp = int(target_pos)
        except (TypeError, ValueError):
            tp = None
        if tp is not None:
            for a in on_tx:
                if _ann_protein_position(a) == tp:
                    return a
    return on_tx[0] if on_tx else None


def _clinvar_hit_anns_on_transcript_at_pos(hit, transcript_base, protein_pos):
    """User-transcript annotation at a protein index (snpeff, else ClinVar HGVS)."""
    if protein_pos is None:
        return []
    try:
        tp = int(protein_pos)
    except (TypeError, ValueError):
        return []
    ann_list = hit.get("snpeff", {}).get("ann", [])
    if isinstance(ann_list, dict):
        ann_list = [ann_list]
    out = []
    for a in ann_list:
        if transcript_base and not _snpeff_ann_on_transcript(a, transcript_base):
            continue
        if _ann_protein_position(a) == tp:
            out.append(a)
    if out:
        return out
    cv_pos, cv_p, cv_c = _clinvar_hit_protein_on_user_transcript(hit, transcript_base)
    if cv_pos == tp and (cv_p or cv_c):
        return [{"hgvs_p": cv_p, "hgvs_c": cv_c, "protein": {"position": str(tp)}}]
    return []


def _normalize_clinvar_c_dot(hgvs_c):
    """Extract c.… from ClinVar coding strings (strip parenthetical p.)."""
    s = (hgvs_c or "").strip()
    if ":" in s:
        s = s.split(":")[-1]
    m = re.search(r"(c\.[^(\s]+)", s)
    return m.group(1) if m else s


def _same_protein_position_different_change(hgvs_p_a, hgvs_p_b):
    """Same aa index, different change (missense PM5, or missense vs fs at same codon)."""
    if not hgvs_p_a or not hgvs_p_b:
        return False
    if hgvs_p_a.strip() == hgvs_p_b.strip():
        return False
    if _missense_same_codon_different_change(hgvs_p_a, hgvs_p_b):
        return True
    pa = _protein_position_from_hgvs_p(hgvs_p_a)
    pb = _protein_position_from_hgvs_p(hgvs_p_b)
    return pa is not None and pa == pb


def _hgvs_kind_from_strings(hgvs_c, hgvs_p, effect=""):
    g = (hgvs_c or "").strip()
    p = (hgvs_p or "").strip()
    eff = (effect or "").lower().replace(" ", "_")
    if g.startswith("g.") or re.match(r"^(NC_|NG_)", g, re.I):
        return "genomic"
    if eff and "intron" in eff:
        return "intron_variant"
    if re.search(r"c\.[+-]", g):
        return "intron_variant"
    if p and p.lower().startswith("p."):
        return "missense"
    if ">" in g and "c." in g:
        return "coding"
    return "other"


def _transcript_label_from_hgvs_full(hgvs_full):
    """RefSeq / LRG / genomic accession prefix for ClinVar alternate-name rows."""
    s = (hgvs_full or "").strip().replace(" ", "")
    for pat in (
        r"^(NM_[0-9]+)",
        r"^(NC_[0-9]+(?:\.[0-9]+)?)",
        r"^(NG_[0-9]+(?:\.[0-9]+)?)",
        r"^(LRG_\d+)",
    ):
        m = re.match(pat, s, re.I)
        if m:
            return m.group(1).upper()
    return ""


def _snpeff_ann_for_transcript_prefix(ann_by_tx, tx_prefix):
    """snpeff feature_id base (NM_001142649) keyed in ann_by_tx."""
    if not tx_prefix:
        return None
    key = tx_prefix.split(".")[0].upper()
    return ann_by_tx.get(key)


def _hgvs_on_user_transcript(hgvs_full, strict_tx_base):
    if not strict_tx_base:
        return False
    return strict_tx_base.upper() in (hgvs_full or "").replace(" ", "").upper()


def _is_exonic_coding_indel_c_dot(c_dot):
    """True for c.N del/dup/ins in the CDS (not c.N±k intronic junction HGVS)."""
    s = re.sub(r"\s+", "", str(c_dot or "")).lower()
    if not re.search(r"c\.-?\d+.*(?:del|dup|ins|inv)", s):
        return False
    if re.search(r"c\.-?\d+[\+\-]\d", s):
        return False
    return True


def _hgvs_p_indicates_frameshift_ptc(hgvs_p):
    hp = (hgvs_p or "").lower()
    return bool(re.search(r"fs\*?\d+|frameshift|\*\d+|ter\d+", hp))


def _exonic_indel_deleted_bp_not_multiple_of_three(c_dot):
    m = re.search(
        r"c\.(-?\d+)_(-?\d+)del",
        re.sub(r"\s+", "", str(c_dot or "")),
        re.I,
    )
    if not m:
        return False
    try:
        a, b = int(m.group(1)), int(m.group(2))
        return (abs(b - a) + 1) % 3 != 0
    except (TypeError, ValueError):
        return False


def _promote_exonic_coding_indel_frameshift_primary(parsed_data):
    """
    Exonic del/dup/ins that creates a frameshift PTC (e.g. OPA1 c.2873_2876delTTAG)
    should use the direct coding LOF path as primary even when VEP also flags
    splice_region / splice_acceptor at the same locus.
    """
    if not parsed_data or not _is_exonic_coding_indel_c_dot(parsed_data.get("c_dot")):
        return
    csq = (parsed_data.get("consequence") or "").lower()
    if csq in ("frameshift", "nonsense", "start_lost"):
        return
    hp = parsed_data.get("hgvs_p") or ""
    debug = (parsed_data.get("debug_vep") or "").lower()
    orig = (parsed_data.get("original_consequence") or csq or "").lower()
    has_fs = (
        _hgvs_p_indicates_frameshift_ptc(hp)
        or "frameshift" in debug
        or "frameshift" in orig
        or _exonic_indel_deleted_bp_not_multiple_of_three(parsed_data.get("c_dot"))
    )
    if not has_fs:
        return
    if "splice" not in csq and csq not in ("unknown", ""):
        return
    parsed_data.setdefault("original_consequence", parsed_data.get("consequence"))
    parsed_data["consequence"] = "frameshift"
    parsed_data["exonic_indel_frameshift_primary"] = True
    parsed_data["splice_site_overlap_secondary"] = True


def _exonic_coding_indel_span_bp(c_dot):
    """Return (span_bp, kind) for coding range/single del|dup, else None."""
    s = re.sub(r"\s+", "", str(c_dot or ""))
    m = re.search(r"c\.(-?\d+)_(-?\d+)(del|dup)", s, re.I)
    if m:
        try:
            a, b = int(m.group(1)), int(m.group(2))
            return abs(b - a) + 1, m.group(3).lower()
        except (TypeError, ValueError):
            return None
    m2 = re.search(r"c\.(-?\d+)(del|dup)([ACGTNacgtn]*)", s, re.I)
    if m2:
        bases = m2.group(3) or ""
        return (len(bases) if bases else 1), m2.group(2).lower()
    return None


def _apply_exonic_coding_indel_consequence_heuristic(parsed_data):
    """
    When VEP/MyVariant leave consequence unknown, classify coding dels/dups from
    HGVS length (DTNA c.1651_1671del → inframe_deletion).
    """
    if not parsed_data or not _is_exonic_coding_indel_c_dot(parsed_data.get("c_dot")):
        return
    csq = (parsed_data.get("consequence") or "").lower().strip()
    if csq and csq not in ("unknown",):
        if "inframe" in csq or csq in ("frameshift", "nonsense", "start_lost", "missense"):
            return
    span = _exonic_coding_indel_span_bp(parsed_data.get("c_dot"))
    if not span:
        return
    n_bp, kind = span
    if n_bp <= 0:
        return
    parsed_data.setdefault("original_consequence", parsed_data.get("consequence"))
    if n_bp % 3 == 0:
        parsed_data["consequence"] = (
            "inframe_deletion" if kind == "del" else "inframe_insertion"
        )
        parsed_data["exonic_indel_inframe_heuristic"] = True
    else:
        parsed_data["consequence"] = "frameshift"
        parsed_data["exonic_indel_frameshift_primary"] = True


def _hgvs_p_is_placeholder(hgvs_p):
    hp = (hgvs_p or "").strip()
    if not hp or hp in ("?", "p.?", "p.=", "p.(=)"):
        return True
    return "Xaa" in hp or "p.X" == hp or hp.upper().startswith("P.XAA")


def _hgvs_p_from_clinvar_variation_name(variation_name):
    """Pull p.Lys552_Arg558del from ClinVar titles like NM_…:c.… (p.Lys552_Arg558del)."""
    name = str(variation_name or "")
    m = re.search(r"\(p\.([^)]+)\)", name)
    if m:
        tail = m.group(1).strip()
        if tail:
            return f"p.{tail}"
    m2 = re.search(r"\bp\.([A-Za-z*][A-Za-z0-9_*]+)", name)
    if m2:
        return f"p.{m2.group(1)}"
    return ""


def _upgrade_hgvs_p_from_named_sources(parsed_data, http_session=None):
    """
    Prefer ClinVar / intake named protein HGVS over derived p.Xaa… placeholders
    (common when CDS fetch fails because ENST never mapped).
    """
    if not parsed_data:
        return
    if not _hgvs_p_is_placeholder(parsed_data.get("hgvs_p")):
        return
    candidates = []
    for key in ("intake_hgvs_p", "clinvar_hgvs_p", "clinvar_variation_name", "clinvar_title"):
        raw = (parsed_data.get(key) or "").strip()
        if not raw:
            continue
        if raw.lower().startswith("p."):
            candidates.append(raw)
        else:
            extracted = _hgvs_p_from_clinvar_variation_name(raw)
            if extracted:
                candidates.append(extracted)
    vid = str(parsed_data.get("clinvar_rcv") or "").strip()
    if http_session is not None and vid and vid.isdigit() and not candidates:
        try:
            summaries = _fetch_clinvar_esummary_map(http_session, [vid])
            obj = summaries.get(vid) or {}
            vs0 = (obj.get("variation_set") or [{}])[0]
            title = (vs0.get("variation_name") or obj.get("title") or "").strip()
            if title:
                parsed_data["clinvar_variation_name"] = title
                extracted = _hgvs_p_from_clinvar_variation_name(title)
                if extracted:
                    candidates.append(extracted)
        except Exception as exc:
            print(f"[hgvs_p] ClinVar title fetch failed: {exc}")
    for cand in candidates:
        if cand and not _hgvs_p_is_placeholder(cand):
            parsed_data["hgvs_p"] = cand if cand.lower().startswith("p.") else f"p.{cand}"
            return


def _resolve_user_transcript_base(parsed_data, target_transcript):
    """User-selected NM (required for same-aa-position matching; never cross-transcript)."""
    tx = _transcript_base_id(parsed_data.get("transcript") or target_transcript)
    if tx:
        return tx
    for pair in parsed_data.get("refseq_nm_synonyms") or []:
        nm = (pair.get("nm") or pair.get("accession") or "").strip()
        if nm.upper().startswith("NM_"):
            return _transcript_base_id(nm)
    return ""


def _fetch_myvariant_hits_at_protein_position(http_session, gene, tx_base, protein_pos):
    if not (gene and tx_base and protein_pos is not None):
        return []
    try:
        q = (
            f"clinvar.gene.symbol:{gene} AND "
            f"snpeff.ann.feature_id:{tx_base}* AND "
            f"snpeff.ann.protein.position:{int(protein_pos)}"
        )
        url = (
            f"https://myvariant.info/v1/query?q={q}"
            f"&fields={_MYVARIANT_LOCAL_ALLELE_FIELDS}&size=1000"
        )
        resp = http_session.get(url, timeout=25)
        if resp.status_code != 200:
            return []
        return list(resp.json().get("hits") or [])
    except Exception as e:
        print(f"Same-protein-position MyVariant query error: {e}")
        return []


def _clinvar_hit_coding_on_user_transcript(hit, strict_tx_base):
    """ClinVar coding HGVS names on the curator's NM (when snpeff lacks that transcript)."""
    if not strict_tx_base:
        return []
    tx = strict_tx_base.upper()
    out = []
    for c in _clinvar_coding_hgvs_from_hit(hit):
        if tx in (c or "").replace(" ", "").upper():
            out.append(c)
    return out


def _clinvar_hit_protein_on_user_transcript(hit, strict_tx_base):
    """
    Protein position + HGVS on the user's NM from ClinVar names.
    MyVariant snpeff often annotates a different canonical NM (e.g. NFIX NM_002501)
    even when ClinVar lists NM_001365902.3 in coding HGVS.
    Returns (protein_pos, hgvs_p, hgvs_c) or (None, '', '').
    """
    coding = _clinvar_hit_coding_on_user_transcript(hit, strict_tx_base)
    if not coding:
        return None, "", ""
    hgvs_c = coding[0]
    if ":" in hgvs_c:
        hgvs_c = hgvs_c.split(":")[-1]
    m_c = re.search(r"(c\.[^(\s]+)", hgvs_c)
    if m_c:
        hgvs_c = m_c.group(1)
    prot_list = (hit.get("clinvar") or {}).get("hgvs", {}).get("protein", [])
    if isinstance(prot_list, str):
        prot_list = [prot_list]
    hgvs_p = ""
    pos = None
    for raw in prot_list:
        p = (raw or "").split(":")[-1].strip()
        if not p.startswith("p."):
            continue
        cand_pos = _protein_position_from_hgvs_p(p)
        if cand_pos is not None:
            pos = cand_pos
            hgvs_p = p
            break
    if pos is None:
        m = re.search(r"\((p\.[^)]+)\)", coding[0])
        if m:
            hgvs_p = m.group(1)
            pos = _protein_position_from_hgvs_p(hgvs_p)
    return pos, hgvs_p, hgvs_c


def _fetch_myvariant_plp_hits_on_transcript_coding(http_session, gene, tx_base):
    """P/LP ClinVar hits whose coding HGVS names include the user's NM."""
    if not (gene and tx_base):
        return []
    try:
        q = (
            f"clinvar.gene.symbol:{gene} AND clinvar.hgvs.coding:*{tx_base}* AND "
            f"(clinvar.rcv.clinical_significance:pathogenic OR "
            f'clinvar.rcv.clinical_significance:"likely pathogenic")'
        )
        url = (
            f"https://myvariant.info/v1/query?q={q}"
            f"&fields={_MYVARIANT_LOCAL_ALLELE_FIELDS}&size=1000"
        )
        resp = http_session.get(url, timeout=25)
        if resp.status_code != 200:
            return []
        return list(resp.json().get("hits") or [])
    except Exception as e:
        print(f"Transcript-coding MyVariant P/LP query error: {e}")
        return []


def _hit_has_snpeff_on_transcript(hit, transcript_base):
    ann = hit.get("snpeff", {}).get("ann", [])
    if isinstance(ann, dict):
        ann = [ann]
    return any(_snpeff_ann_on_transcript(a, transcript_base) for a in ann)


def _finalize_local_allele_scan_metadata(
    parsed_data, effective_gene, strict_tx_base, combined_hits, target_p_anchor,
):
    """
    Record that the local ClinVar allelic scan ran and how hits were mapped to the user's NM.
    Prevents silent 'no results' when MyVariant snpeff lacks the curated transcript.
    """
    if not (effective_gene and strict_tx_base):
        return
    hits = combined_hits or []
    on_tx_coding = sum(
        1 for h in hits if _clinvar_hit_coding_on_user_transcript(h, strict_tx_base)
    )
    on_tx_snpeff = sum(1 for h in hits if _hit_has_snpeff_on_transcript(h, strict_tx_base))
    same_pos = parsed_data.get("same_protein_position_alleles") or []
    regional = parsed_data.get("regional_hotspot") or []
    pm5 = parsed_data.get("pm5_local_alleles") or []
    alts = parsed_data.get("alternate_alleles") or []
    matched_ctx = len(same_pos) + len(regional) + len(pm5) + len(alts)

    nm = (parsed_data.get("transcript") or strict_tx_base or "").strip()
    anchor = target_p_anchor if target_p_anchor else "?"
    parsed_data["local_clinvar_scan_performed"] = True
    parsed_data["local_clinvar_hits_total"] = len(hits)
    parsed_data["local_clinvar_hits_on_transcript"] = on_tx_coding
    parsed_data["local_clinvar_snpeff_on_transcript"] = on_tx_snpeff
    parsed_data["local_clinvar_used_hgvs_fallback"] = on_tx_coding > 0 and on_tx_snpeff == 0
    parsed_data["local_clinvar_context_count"] = matched_ctx

    note_parts = [
        f"Local ClinVar allelic scan ({nm}): {len(hits)} hit(s) in query pool; "
        f"{on_tx_coding} name this transcript in ClinVar coding HGVS."
    ]
    if parsed_data["local_clinvar_used_hgvs_fallback"]:
        note_parts.append(
            f" MyVariant snpeff had 0 on {strict_tx_base}; "
            f"same-aa / ±5 aa context uses ClinVar protein names."
        )
    note_parts.append(
        f" Used for context: {len(same_pos)} same-aa, {len(regional)} regional ±5 aa "
        f"(center aa {anchor}), {len(pm5)} PM5 P/LP."
    )
    if on_tx_coding > 0 and matched_ctx == 0:
        note_parts.append(
            " Transcript-named P/LP entries were found but none classified for this variant — "
            "please flag for engine review."
        )
    elif on_tx_coding == 0 and matched_ctx == 0:
        note_parts.append(" No P/LP ClinVar entries name this transcript.")

    from vc_engine.clinvar import _clinvar_gene_plp_search_url

    search_url = _clinvar_gene_plp_search_url(effective_gene)
    if search_url:
        parsed_data["local_clinvar_exploratory_search_link"] = search_url

    parsed_data["local_clinvar_scan_note"] = "".join(note_parts)


def _fetch_myvariant_hits_at_splice_junction(http_session, gene, c_dot, junction_locus=None):
    """Other ClinVar alleles at the same canonical donor/acceptor (c.N±1, c.N±2, …)."""
    cj = junction_locus or _canonical_splice_junction_from_hgvs(c_dot)
    if not (gene and cj):
        return []
    sign = '+' if cj.get('site') == 'donor' else '-'
    anchor = cj.get('anchor')
    try:
        q = (
            f"clinvar.gene.symbol:{gene} AND "
            f"clinvar.hgvs.coding:*c.{anchor}{sign}*"
        )
        url = (
            f"https://myvariant.info/v1/query?q={q}"
            f"&fields={_MYVARIANT_LOCAL_ALLELE_FIELDS}&size=1000"
        )
        resp = http_session.get(url, timeout=25)
        if resp.status_code != 200:
            return []
        return list(resp.json().get("hits") or [])
    except Exception as e:
        print(f"Splice-junction MyVariant query error: {e}")
        return []


def _hgvs_c_from_ann(ann):
    if not ann:
        return None
    matched_c = (ann.get("hgvs_c") or "").strip()
    if matched_c and ":" in matched_c:
        matched_c = matched_c.split(":")[-1]
    return matched_c or None


def _hgvs_p_from_ann(ann):
    if not ann:
        return None
    hp = (ann.get("hgvs_p") or "").strip()
    if hp:
        return hp.split(":")[-1].strip()
    return None


def _classify_local_allele_hit(
    ah, parsed_data, strict_tx_base, target_p_anchor, user_c_anchor, pos_match, g_chrom,
):
    """
    Classify a ClinVar/MyVariant hit relative to the user's variant on the user's NM only.
    Returns one of: true_pathogenic, true_vus, same_protein, regional, or None.
    """
    cv_vid = _clinvar_variant_id_from_hit(ah)
    if not cv_vid or cv_vid == str(parsed_data.get("clinvar_rcv") or "").strip():
        return None

    rcv = _clinvar_rcv_list_from_hit(ah)
    cv_sig = _clinvar_display_sig_from_rcv(rcv)
    cv_hgvs = _clinvar_coding_hgvs_from_hit(ah)
    snpeff_ann = ah.get("snpeff", {}).get("ann", [])
    if isinstance(snpeff_ann, dict):
        snpeff_ann = [snpeff_ann]

    # Exact residue on the user's transcript only (never fallback to wrong aa index on same NM).
    exact_user_anns = (
        _clinvar_hit_anns_on_transcript_at_pos(ah, strict_tx_base, target_p_anchor)
        if strict_tx_base and target_p_anchor is not None
        else []
    )
    alt_ann = exact_user_anns[0] if exact_user_anns else None
    alt_hgvs_p = _hgvs_p_from_ann(alt_ann) or ""
    matched_c = _hgvs_c_from_ann(alt_ann) or ""
    if not alt_hgvs_p or not matched_c:
        cv_pos, cv_p, cv_c = _clinvar_hit_protein_on_user_transcript(ah, strict_tx_base)
        if cv_p and not alt_hgvs_p:
            alt_hgvs_p = cv_p
        if cv_c and not matched_c:
            matched_c = cv_c
    if not matched_c:
        for c in cv_hgvs:
            if strict_tx_base and strict_tx_base.upper() in c.replace(" ", "").upper():
                matched_c = _normalize_clinvar_c_dot(c.split(":")[-1] if ":" in c else c)
                break

    user_c_dot = (parsed_data.get("c_dot") or parsed_data.get("hgvs_c") or "").strip()
    is_true_allele = False
    if matched_c and "c." in matched_c:
        is_true_allele = _is_colocalized_cdna_alternate(
            user_c_dot, matched_c, user_c_anchor
        )

    user_hgvs_p = parsed_data.get("hgvs_p", "")
    is_same_protein = False
    if (
        not is_true_allele
        and alt_hgvs_p
        and user_hgvs_p
        and _same_protein_position_different_change(user_hgvs_p, alt_hgvs_p)
    ):
        is_same_protein = True

    if not matched_c and alt_hgvs_p:
        matched_c = alt_hgvs_p
    if not matched_c:
        matched_c = f"chr{g_chrom} (VID {cv_vid})" if g_chrom else f"(VID {cv_vid})"

    entry = {
        "hgvs_c": matched_c,
        "hgvs_p": alt_hgvs_p or "",
        "significance": cv_sig,
        "vid": cv_vid,
    }

    if is_true_allele:
        if _clinvar_rcv_any_pathogenic_or_likely(rcv):
            return "true_pathogenic", entry
        return "true_vus", entry
    cand_c = matched_c.split(":")[-1] if matched_c and ":" in matched_c else matched_c
    if cand_c and _hit_at_user_splice_junction_locus(user_c_dot, cand_c, parsed_data):
        if _clinvar_rcv_any_pathogenic_or_likely(rcv):
            return "splice_junction_plp", entry
        return "splice_junction_vus", entry
    if is_same_protein:
        return "same_protein", entry

    # Regional hotspot: P/LP within ±5 aa on the user's transcript numbering (not other NMs).
    user_ann_any = _pick_snpeff_ann_for_transcript(snpeff_ann, strict_tx_base, None)
    user_p_pos = _ann_protein_position(user_ann_any)
    user_p_hgvs = _hgvs_p_from_ann(user_ann_any) or alt_hgvs_p or ""
    clinvar_c_on_tx = matched_c if matched_c.startswith("c.") else ""
    if user_p_pos is None and strict_tx_base:
        cv_pos, cv_p, cv_c = _clinvar_hit_protein_on_user_transcript(
            ah, strict_tx_base
        )
        if cv_pos is not None:
            user_p_pos = cv_pos
            user_p_hgvs = cv_p or user_p_hgvs
            if cv_c:
                clinvar_c_on_tx = cv_c
    try:
        target_p_int = int(target_p_anchor) if target_p_anchor is not None else None
    except (TypeError, ValueError):
        target_p_int = None
    if (
        strict_tx_base
        and user_p_pos is not None
        and target_p_int is not None
        and _clinvar_rcv_any_pathogenic_or_likely(rcv)
        and 0 < abs(user_p_pos - target_p_int) <= 5
    ):
        uc = _hgvs_c_from_ann(user_ann_any) or clinvar_c_on_tx or matched_c
        up = user_p_hgvs or ""
        return "regional", {
            "hgvs_c": uc,
            "hgvs_p": up,
            "significance": cv_sig,
            "vid": cv_vid,
        }
    return None


def _ensure_derived_hgvs_p_for_inframe(parsed_data, http_session, c_dot):
    """Fill hgvs_p from CDS when APIs omit protein HGVS for in-frame coding indels."""
    cur = (parsed_data.get("hgvs_p") or "").strip()
    if cur and not _hgvs_p_is_placeholder(cur):
        return
    cons = (parsed_data.get("consequence") or "").lower()
    if "inframe" not in cons and _c_dot_change_class(c_dot) != "del":
        return
    if not re.search(r"c\.\d+_\d+del", str(c_dot or ""), re.I):
        return
    cds_seq = parsed_data.get("cds_seq") or ""
    if not cds_seq and http_session is not None:
        enst = (parsed_data.get("ensembl_transcript_id") or "").split(".")[0]
        if enst.startswith("ENST"):
            try:
                url = f"https://rest.ensembl.org/sequence/id/{enst}?type=cds"
                resp = http_session.get(url, timeout=60)
                if resp.status_code == 200:
                    cds_seq = (resp.json() or {}).get("seq", "") or ""
                    if cds_seq:
                        parsed_data["cds_seq"] = cds_seq
            except Exception:
                pass
    derived = _derive_inframe_hgvs_p_from_c_dot(c_dot, cds_seq)
    if derived:
        # Keep a named intake/ClinVar p. over derived Xaa placeholders.
        if _hgvs_p_is_placeholder(cur) or not cur:
            if not _hgvs_p_is_placeholder(derived) or not cur:
                parsed_data["hgvs_p"] = derived


def _populate_alternate_transcript_literature_for_curated_variant(
    http_session, parsed_data, strict_tx_base,
):
    """
    All non-primary ClinVar HGVS names for **the variant being curated** (same Variation ID).
    Includes other NM/LRG transcripts, intronic ClinVar aliases, and genomic (NC_/NG_/LRG g.) — for literature search.
    Excludes only the user's curated transcript (e.g. NM_019055 c.190C>T); not other ClinVar VIDs.
    """
    user_vid = str(parsed_data.get("clinvar_rcv") or "").strip()
    if not user_vid or not user_vid.isdigit():
        return []

    hit = _fetch_myvariant_clinvar_variant_hit(http_session, user_vid)
    if not hit:
        return []

    sig = _clinvar_display_sig_from_rcv(_clinvar_rcv_list_from_hit(hit))
    snpeff_ann = hit.get("snpeff", {}).get("ann", [])
    if isinstance(snpeff_ann, dict):
        snpeff_ann = [snpeff_ann]

    ann_by_tx = {}
    for a in snpeff_ann:
        fid = (a.get("feature_id") or "").strip()
        fid_base = fid.split(".")[0].upper() if "." in fid else fid.upper()
        if fid_base:
            ann_by_tx[fid_base] = a

    entries = []
    seen = set()

    def _append_entry(hgvs_full, hgvs_c, hgvs_p, transcript, effect=""):
        hgvs_full = (hgvs_full or "").strip()
        if not hgvs_full or hgvs_full in seen:
            return
        if strict_tx_base and _hgvs_on_user_transcript(hgvs_full, strict_tx_base):
            return
        seen.add(hgvs_full)
        entries.append({
            "vid": user_vid,
            "transcript": transcript or _transcript_label_from_hgvs_full(hgvs_full) or "?",
            "hgvs_full": hgvs_full,
            "hgvs_c": hgvs_c or hgvs_full.split(":")[-1] if ":" in hgvs_full else hgvs_full,
            "hgvs_p": hgvs_p or "",
            "hgvs_kind": _hgvs_kind_from_strings(hgvs_c, hgvs_p, effect),
            "significance": sig,
        })

    for coding in _clinvar_coding_hgvs_from_hit(hit):
        coding = (coding or "").strip()
        if not coding:
            continue
        tx = _transcript_label_from_hgvs_full(coding)
        hgvs_c = coding.split(":")[-1] if ":" in coding else coding
        ann = _snpeff_ann_for_transcript_prefix(ann_by_tx, tx) if tx else None
        hgvs_p = _hgvs_p_from_ann(ann) if ann else ""
        if not hgvs_p and tx and tx.upper().startswith("LRG_"):
            user_c = (parsed_data.get("hgvs_c") or "").strip()
            if user_c and hgvs_c == user_c:
                hgvs_p = (parsed_data.get("hgvs_p") or "").strip()
        effect = (ann.get("effect") or "") if ann else ""
        _append_entry(coding, hgvs_c, hgvs_p, tx or coding.split(":")[0], effect)

    for genomic in _clinvar_genomic_hgvs_from_hit(hit):
        genomic = (genomic or "").strip()
        if not genomic:
            continue
        tx = _transcript_label_from_hgvs_full(genomic)
        hgvs_g = genomic.split(":")[-1] if ":" in genomic else genomic
        _append_entry(genomic, hgvs_g, "", tx, "genomic")

    entries.sort(key=lambda x: (x.get("transcript") or "", x.get("hgvs_full") or ""))
    return entries


def _populate_local_allele_lists_from_hits(
    hits, parsed_data, strict_tx_base, target_p_anchor, user_c_anchor, pos_match, g_chrom,
    alternate_alleles, vus_alternate_alleles, same_protein_position_alleles,
    pm5_local_alleles, regional_hotspot,
    splice_junction_alleles=None, splice_junction_vus=None,
):
    for ah in hits:
        classified = _classify_local_allele_hit(
            ah, parsed_data, strict_tx_base, target_p_anchor, user_c_anchor, pos_match, g_chrom,
        )
        if not classified:
            continue
        bucket, entry = classified
        vid = entry.get("vid")
        if bucket == "true_pathogenic":
            if not any(x["vid"] == vid for x in alternate_alleles):
                alternate_alleles.append(
                    {"hgvs_c": entry["hgvs_c"], "significance": entry["significance"], "vid": vid}
                )
        elif bucket == "true_vus":
            if not any(x["vid"] == vid for x in vus_alternate_alleles):
                vus_alternate_alleles.append(
                    {"hgvs_c": entry["hgvs_c"], "significance": entry["significance"], "vid": vid}
                )
        elif bucket in ("splice_junction_plp", "splice_junction_vus"):
            target = splice_junction_alleles if bucket == "splice_junction_plp" else splice_junction_vus
            if target is not None and not any(x["vid"] == vid for x in target):
                target.append(
                    {"hgvs_c": entry["hgvs_c"], "significance": entry["significance"], "vid": vid}
                )
        elif bucket == "same_protein":
            if not any(x["vid"] == vid for x in same_protein_position_alleles):
                entry["transcript"] = (
                    parsed_data.get("transcript")
                    or strict_tx_base
                    or ""
                )
                same_protein_position_alleles.append(entry)
            if _clinvar_rcv_any_pathogenic_or_likely(_clinvar_rcv_list_from_hit(ah)):
                if not any(x["vid"] == vid for x in pm5_local_alleles):
                    pm5_local_alleles.append(entry)
        elif bucket == "regional":
            if not any(x["vid"] == vid for x in regional_hotspot):
                regional_hotspot.append(entry)


_RESIDUE_FLAGS = {
    # 3-letter AA -> biochemical note used when a residue is deleted in-frame.
    # The notes are intentionally short; they're rendered next to the HGVS-p
    # in the report and UI pill.
    'Cys': 'forms disulfide bonds and coordinates metals (e.g. Zn²⁺ in zinc-fingers); also a catalytic/redox center — deletion in a zinc-finger or disulfide cluster collapses the fold',
    'Pro': 'breaks α-helices and introduces backbone kinks/turns — deletion can disrupt local secondary structure',
    'Gly': 'provides backbone flexibility; essential at Gly-X-Y collagen triplets and tight turns — deletion disrupts backbone geometry',
    'His': 'coordinates metals (Zn²⁺, Fe³⁺) and acts at enzyme active sites — deletion in a metal-binding motif disrupts coordination',
    'Trp': 'large aromatic side chain anchoring hydrophobic cores and π-stacking — deletion is typically destabilizing',
    'Tyr': 'aromatic; commonly phosphorylated and in hydrogen-bond networks',
    'Phe': 'aromatic; anchors hydrophobic cores and π-stacking',
    'Asp': 'acidic side chain; common in catalytic triads and ion coordination',
    'Glu': 'acidic side chain; common in metal coordination and salt bridges',
    'Lys': 'basic side chain; common in ubiquitination, acetylation and DNA/RNA binding',
    'Arg': 'basic side chain; common in DNA/RNA binding and salt bridges',
    'Ser': 'small polar; common phospho-acceptor',
    'Thr': 'small polar; common phospho-acceptor',
    'Asn': 'polar; N-glycosylation acceptor in NxS/T motifs',
    'Gln': 'polar; hydrogen-bond donor',
    'Met': 'hydrophobic; initiator residue for translation',
    'Ala': 'small hydrophobic; structurally accommodating',
    'Val': 'aliphatic; hydrophobic core',
    'Leu': 'aliphatic; hydrophobic core',
    'Ile': 'aliphatic; hydrophobic core',
}


_HIGH_IMPACT_INFRAME_RESIDUES = {'Cys', 'Pro', 'Gly', 'His', 'Trp'}


_RE_INFRAME_RANGE_DELINS = re.compile(
    r'^([A-Z][a-z]{2})(\d+)_([A-Z][a-z]{2})(\d+)delins((?:[A-Z][a-z]{2})+)$'
)


_RE_INFRAME_SINGLE_DELINS = re.compile(
    r'^([A-Z][a-z]{2})(\d+)delins((?:[A-Z][a-z]{2})+)$'
)


_RE_INFRAME_RANGE_DEL = re.compile(
    r'^([A-Z][a-z]{2})(\d+)_([A-Z][a-z]{2})(\d+)del$'
)


_RE_INFRAME_SINGLE_DEL = re.compile(
    r'^([A-Z][a-z]{2})(\d+)del$'
)


_RE_INFRAME_INS = re.compile(
    r'^([A-Z][a-z]{2})(\d+)_([A-Z][a-z]{2})(\d+)ins((?:[A-Z][a-z]{2})+)$'
)


_RE_INFRAME_RANGE_DUP = re.compile(
    r'^([A-Z][a-z]{2})(\d+)_([A-Z][a-z]{2})(\d+)dup$'
)


_RE_INFRAME_SINGLE_DUP = re.compile(
    r'^([A-Z][a-z]{2})(\d+)dup$'
)


def _split_3letter_run(s):
    """Split a concatenated 3-letter AA string ('AlaArgGly') into a list."""
    return re.findall(r'[A-Z][a-z]{2}', s or '')


def _normalize_hgvs_p_to_3letter(s):
    """
    Best-effort conversion of any 1-letter HGVS-p AA codes to 3-letter form so
    the regexes above can parse the string. Idempotent for already-3-letter
    input (snpEff / VEP frequently mix both forms).
    """
    if not s:
        return s
    one_to_three = _AA_ONE_TO_THREE  # local alias
    # Strip "p.", "p.(", and trailing ")".
    s = re.sub(r'^p\.?\(?', '', s).rstrip(')').strip()
    # If the string already contains any 3-letter AA token (e.g. 'Cys') we
    # treat it as 3-letter throughout. Otherwise convert single letters that
    # are followed by a digit (e.g. 'C1208') or that follow ins/delins/dup.
    looks_three_letter = re.search(r'[A-Z][a-z]{2}\d', s) is not None
    if looks_three_letter:
        return s
    # 1-letter ref AA before a position (e.g. C1208, K100)
    s = re.sub(
        r'(^|_)([ACDEFGHIKLMNPQRSTVWY])(?=\d)',
        lambda m: m.group(1) + one_to_three.get(m.group(2), m.group(2)),
        s,
    )
    # 1-letter runs after 'ins' / 'delins' / 'dup' (capture trailing aa string).
    def _expand_run(m):
        run = m.group(2)
        return m.group(1) + ''.join(one_to_three.get(c, c) for c in run)
    s = re.sub(r'(delins)([ACDEFGHIKLMNPQRSTVWY]+)$', _expand_run, s)
    s = re.sub(r'(ins)([ACDEFGHIKLMNPQRSTVWY]+)$', _expand_run, s)
    return s


def _parse_inframe_hgvs_p(hgvs_p):
    """Parse an HGVS-p string for an in-frame indel; return a dict or None."""
    s = _normalize_hgvs_p_to_3letter(hgvs_p)
    if not s:
        return None

    m = _RE_INFRAME_RANGE_DELINS.match(s)
    if m:
        ins = _split_3letter_run(m.group(5))
        return {
            'kind': 'range_delins',
            'start_aa3': m.group(1), 'start_pos': int(m.group(2)),
            'end_aa3': m.group(3), 'end_pos': int(m.group(4)),
            'ins_aa3_list': ins,
            'del_aa_count': int(m.group(4)) - int(m.group(2)) + 1,
            'ins_aa_count': len(ins),
        }
    m = _RE_INFRAME_SINGLE_DELINS.match(s)
    if m:
        ins = _split_3letter_run(m.group(3))
        return {
            'kind': 'single_delins',
            'start_aa3': m.group(1), 'start_pos': int(m.group(2)),
            'end_aa3': m.group(1), 'end_pos': int(m.group(2)),
            'ins_aa3_list': ins,
            'del_aa_count': 1,
            'ins_aa_count': len(ins),
        }
    m = _RE_INFRAME_RANGE_DEL.match(s)
    if m:
        return {
            'kind': 'range_del',
            'start_aa3': m.group(1), 'start_pos': int(m.group(2)),
            'end_aa3': m.group(3), 'end_pos': int(m.group(4)),
            'ins_aa3_list': [],
            'del_aa_count': int(m.group(4)) - int(m.group(2)) + 1,
            'ins_aa_count': 0,
        }
    m = _RE_INFRAME_SINGLE_DEL.match(s)
    if m:
        return {
            'kind': 'single_del',
            'start_aa3': m.group(1), 'start_pos': int(m.group(2)),
            'end_aa3': m.group(1), 'end_pos': int(m.group(2)),
            'ins_aa3_list': [],
            'del_aa_count': 1,
            'ins_aa_count': 0,
        }
    m = _RE_INFRAME_INS.match(s)
    if m:
        ins = _split_3letter_run(m.group(5))
        return {
            'kind': 'ins',
            'start_aa3': m.group(1), 'start_pos': int(m.group(2)),
            'end_aa3': m.group(3), 'end_pos': int(m.group(4)),
            'ins_aa3_list': ins,
            'del_aa_count': 0,
            'ins_aa_count': len(ins),
        }
    m = _RE_INFRAME_RANGE_DUP.match(s)
    if m:
        n = int(m.group(4)) - int(m.group(2)) + 1
        return {
            'kind': 'range_dup',
            'start_aa3': m.group(1), 'start_pos': int(m.group(2)),
            'end_aa3': m.group(3), 'end_pos': int(m.group(4)),
            'ins_aa3_list': [],
            'del_aa_count': 0,
            'ins_aa_count': n,
        }
    m = _RE_INFRAME_SINGLE_DUP.match(s)
    if m:
        aa3 = m.group(1)
        return {
            'kind': 'single_dup',
            'start_aa3': aa3, 'start_pos': int(m.group(2)),
            'end_aa3': aa3, 'end_pos': int(m.group(2)),
            'ins_aa3_list': [aa3],
            'del_aa_count': 0,
            'ins_aa_count': 1,
        }
    return None


def _build_coding_inframe_indel_outcome(parsed_data):
    """
    Compute and attach a structured `inframe_coding_outcome` summary for plain
    coding in-frame indels (no splice modeling). Surfaces protein-length delta,
    deleted-residue identity + biochemical class, and an explicit "no PTC; NMD
    does not apply" verdict so the report and UI can render a parallel pill to
    the splice-driven cryptic outcome.

    Safe to call unconditionally: returns None and clears the field for any
    consequence that isn't an inframe coding indel or any HGVS-p we can't
    parse. If the delins inserts a Ter codon we flag it (has_ptc) and let the
    downstream truncation logic handle it.
    """
    consequence = (parsed_data.get('consequence') or '').lower()
    if 'inframe' not in consequence:
        parsed_data.setdefault('inframe_coding_outcome', None)
        return None

    hgvs_p_raw = parsed_data.get('hgvs_p') or ''
    info = _parse_inframe_hgvs_p(hgvs_p_raw)
    if not info:
        parsed_data['inframe_coding_outcome'] = None
        return None

    try:
        native_len = int(parsed_data.get('protein_length') or 0)
    except (TypeError, ValueError):
        native_len = 0

    has_ptc = 'Ter' in info['ins_aa3_list']
    net_change = info['ins_aa_count'] - info['del_aa_count']  # signed
    mutant_len = (native_len + net_change) if (native_len and not has_ptc) else None

    flagged_aa3 = info['start_aa3'] if info['del_aa_count'] >= 1 else ''
    residue_note = _RESIDUE_FLAGS.get(flagged_aa3, '')
    high_impact = flagged_aa3 in _HIGH_IMPACT_INFRAME_RESIDUES

    # Compose a short op phrase per kind.
    kind = info['kind']
    span_label = (
        f"{info['start_aa3']}{info['start_pos']}"
        + (f"–{info['end_aa3']}{info['end_pos']}" if info['start_pos'] != info['end_pos'] else '')
    )
    if kind in ('single_del', 'range_del'):
        op_phrase = f"In-frame deletion of {info['del_aa_count']} aa ({span_label})"
    elif kind in ('single_dup', 'range_dup'):
        op_phrase = f"In-frame duplication of {info['ins_aa_count']} aa ({span_label})"
    elif kind == 'ins':
        op_phrase = (
            f"In-frame insertion of {info['ins_aa_count']} aa between "
            f"{info['start_aa3']}{info['start_pos']} and {info['end_aa3']}{info['end_pos']}"
        )
    elif kind in ('single_delins', 'range_delins'):
        op_phrase = (
            f"In-frame delins: {info['del_aa_count']} aa removed ({span_label}) → "
            f"{info['ins_aa_count']} aa inserted"
        )
    else:
        op_phrase = f"In-frame change ({kind})"

    # Length math.
    if native_len and mutant_len is not None:
        sign = '+' if net_change > 0 else ''
        length_phrase = f"Protein {native_len} → {mutant_len} aa ({sign}{net_change})."
    elif net_change:
        sign = '+' if net_change > 0 else ''
        length_phrase = f"Net protein length change: {sign}{net_change} aa."
    else:
        length_phrase = "Net protein length change: 0 aa."

    # PTC / NMD verdict.
    if has_ptc:
        verdict_short = "Inserted Ter introduces a PTC — re-evaluate as truncation (see truncation/NMD section)."
        nmd_applies = None
    else:
        verdict_short = "No PTC; NMD does not apply. Reading frame preserved → native stop codon retained, transcript stable."
        nmd_applies = False

    residue_phrase = ''
    if residue_note:
        residue_phrase = f" {flagged_aa3} {residue_note}."

    narrative = f"{op_phrase}. {length_phrase}{residue_phrase} {verdict_short}"

    out = {
        'kind': kind,
        'hgvs_p': hgvs_p_raw,
        'start_aa3': info['start_aa3'],
        'start_pos': info['start_pos'],
        'end_aa3': info['end_aa3'],
        'end_pos': info['end_pos'],
        'del_aa_count': info['del_aa_count'],
        'ins_aa_count': info['ins_aa_count'],
        'ins_aa3_list': info['ins_aa3_list'],
        'net_aa_change': net_change,
        'native_protein_length': native_len or None,
        'mutant_protein_length': mutant_len,
        'flagged_residue_aa3': flagged_aa3,
        'flagged_residue_note': residue_note,
        'high_impact_residue': high_impact,
        'has_ptc': has_ptc,
        'nmd_applies': nmd_applies,
        'op_phrase': op_phrase,
        'length_phrase': length_phrase,
        'verdict_short': verdict_short,
        'narrative': narrative,
    }
    parsed_data['inframe_coding_outcome'] = out
    return out


def _reconcile_grch38_coords_via_vep_hgvs(parsed_data, http_session, target_transcript, c_dot, effective_gene):
    """
    Anchor GRCh38 coordinates on Ensembl VEP for the requested HGVS c. transcript.

    MyVariant/ClinVar genomic HGVS strings can point at a different locus than the
    NM_:c. the user entered (e.g. FGFR3 c.749C>G → ClinVar NC_000004.12:g.1803571…
    vs VEP chr4:1801844). SpliceAI/Pangolin must use the VEP locus or scores and
    splice math will be wrong or absent.
    """
    if not (c_dot or '').strip():
        return False
    tx = (target_transcript or '').strip()
    gene = (effective_gene or parsed_data.get('gene_symbol') or parsed_data.get('gene') or '').strip()
    hgvs_q = _vep_hgvs_query(tx, c_dot, gene)
    if not hgvs_q:
        return False
    try:
        import urllib.parse
        vep_url = (
            f"https://rest.ensembl.org/vep/human/hgvs/{urllib.parse.quote(hgvs_q, safe='')}"
            f"?content-type=application/json&vcf_string=1"
        )
        vresp = http_session.get(vep_url, timeout=60)
        if vresp.status_code != 200:
            return False
        payload = vresp.json()
        if not payload:
            return False
        v0 = payload[0]
        v_chrom = str(v0.get('seq_region_name') or '').strip()
        v_start = v0.get('start')
        if not v_chrom or not v_start:
            return False
        if not v_chrom.startswith('chr'):
            v_chrom = 'chr' + v_chrom
        try:
            cur_start = int(parsed_data.get('grch38_start') or 0)
        except (TypeError, ValueError):
            cur_start = 0
        vep_start = int(v_start)
        changed = cur_start != vep_start
        parsed_data['grch38_chrom'] = v_chrom
        parsed_data['grch38_start'] = vep_start
        parsed_data['grch38_end'] = v0.get('end', vep_start)
        _vep_vcf = v0.get('vcf_string')
        if _vep_vcf:
            parsed_data['vep_vcf_string'] = _vep_vcf
        _ale = str(v0.get('allele_string') or '')
        if '/' in _ale:
            _ra, _aa = _ale.split('/')[:2]
            if _ra and _aa:
                _ra_n, _aa_n, _ = _normalize_to_forward_strand(
                    http_session,
                    v_chrom,
                    vep_start,
                    _ra.upper(),
                    _aa.upper(),
                    parsed_data.get('grch38_end'),
                )
                parsed_data['ref'] = _ra_n
                parsed_data['alt'] = _aa_n
        if changed and cur_start:
            print(
                f"[coord-reconcile] VEP HGVS {hgvs_q} → {v_chrom}:{vep_start} "
                f"(replacing prior grch38_start {cur_start})"
            )
        return True
    except Exception as exc:
        print(f"[coord-reconcile] VEP HGVS lookup failed: {exc}")
        return False


def _reconcile_variant_exon_mrna_numbering(parsed_data):
    """
    Display mRNA exon numbers (counting 5′-UTR-only exons) instead of VEP coding-only ranks.
    e.g. NLRP3 c.2798G>T: VEP coding exon 7/9 → mRNA exon 8/10 when exon 1 is 5′-UTR only.
    """
    cds_pos = parsed_data.get('snpeff_cds_pos')
    try:
        cds_pos = int(cds_pos or 0)
    except (TypeError, ValueError):
        return

    coding_exons = parsed_data.get('coding_exons') or []
    if not coding_exons:
        return

    cx_hit = None
    for cx in coding_exons:
        try:
            sc = int(cx.get('start_cds') or 0)
            ec = int(cx.get('end_cds') or 0)
        except (TypeError, ValueError):
            continue
        if sc <= cds_pos <= ec:
            cx_hit = cx
            break
    if not cx_hit:
        return

    try:
        mrna_rank = int(cx_hit.get('anatomical_rank') or 0)
    except (TypeError, ValueError):
        return
    if mrna_rank < 1:
        return

    snpeff_r = parsed_data.get('snpeff_exon_rank')
    snpeff_t = parsed_data.get('snpeff_exon_total')
    try:
        snpeff_r_i = int(snpeff_r) if snpeff_r is not None else None
        snpeff_t_i = int(snpeff_t) if snpeff_t is not None else None
    except (TypeError, ValueError):
        snpeff_r_i, snpeff_t_i = None, None

    mrna_total = parsed_data.get('mrna_exon_total')
    try:
        mrna_total = int(mrna_total) if mrna_total is not None else None
    except (TypeError, ValueError):
        mrna_total = None
    if not mrna_total:
        mrna_total = _mrna_exon_total(parsed_data, coding_exons)
        if mrna_total > 0:
            parsed_data['mrna_exon_total'] = mrna_total

    parsed_data['variant_exon'] = mrna_rank
    parsed_data['nmd_exon_total'] = mrna_total
    parsed_data['coding_exon_rank'] = snpeff_r_i
    parsed_data['coding_exon_total'] = snpeff_t_i

    if (
        snpeff_r_i is not None
        and snpeff_t_i is not None
        and (snpeff_r_i != mrna_rank or snpeff_t_i != mrna_total)
    ):
        parsed_data['legacy_exon_label'] = (
            f"VEP/SnpEff coding-only exon {snpeff_r_i}/{snpeff_t_i} (5′-UTR exons excluded from count)"
        )


def _finalize_exon_display_fields(parsed_data, c_dot=""):
    """
    Ensure variant_exon / nmd_exon_total for UI and logic when VEP rank or Ensembl
    lookup was incomplete (shows as '?' in intro / missing Exon pill).
    """
    try:
        _ensure_coding_exons_for_splice_viz(parsed_data)
        _reconcile_variant_exon_mrna_numbering(parsed_data)
    except Exception:
        pass

    def _as_pos_int(val):
        try:
            n = int(val)
            return n if n > 0 else None
        except (TypeError, ValueError):
            return None

    ve = _as_pos_int(parsed_data.get("variant_exon"))
    nt = _as_pos_int(parsed_data.get("nmd_exon_total"))

    if ve is None:
        ve = _as_pos_int(parsed_data.get("snpeff_exon_rank"))

    if nt is None:
        for key in ("snpeff_exon_total", "mrna_exon_total"):
            nt = _as_pos_int(parsed_data.get(key))
            if nt:
                break
        if nt is None:
            ce = parsed_data.get("coding_exons") or []
            nt = _as_pos_int(_mrna_exon_total(parsed_data, ce))

    if ve is None:
        cds_pos = _as_pos_int(parsed_data.get("snpeff_cds_pos"))
        c_dot_use = (c_dot or parsed_data.get("c_dot") or "").strip()
        if not cds_pos and c_dot_use:
            m = re.search(r"c\.(\d+)", c_dot_use, re.I)
            if m:
                cds_pos = _as_pos_int(m.group(1))
        if not cds_pos and c_dot_use:
            cds_pos = _as_pos_int(
                _splice_cdna_anchor_from_hgvs(
                    c_dot_use, parsed_data.get("consequence") or ""
                )
            )
        if cds_pos:
            for cx in parsed_data.get("coding_exons") or []:
                try:
                    sc = int(cx.get("start_cds") or 0)
                    ec = int(cx.get("end_cds") or 0)
                except (TypeError, ValueError):
                    continue
                if sc <= cds_pos <= ec:
                    ve = _as_pos_int(cx.get("anatomical_rank"))
                    break

    if ve:
        parsed_data["variant_exon"] = ve
    if nt:
        parsed_data["nmd_exon_total"] = nt


def _resolve_ensembl_transcript_id(http_session, parsed_data, candidate=None):
    """Return an ENST id, mapping NM_/other accessions via Ensembl xrefs when needed.

    Never treat a bare RefSeq NM_ as an Ensembl transcript id — lookup/id rejects it
    and structural NMD / exon math then silently fails (TUBB1 NM_030773 regression).
    """
    raw = (
        candidate
        or parsed_data.get("ensembl_transcript_id")
        or parsed_data.get("transcript")
        or ""
    )
    clean = str(raw or "").strip().split(".")[0]
    if not clean:
        return ""
    if clean.startswith("ENST"):
        parsed_data["ensembl_transcript_id"] = clean
        return clean
    # RefSeq NM_ (or other) → ENST via xref
    if http_session is None:
        return ""
    try:
        xref_url = f"https://rest.ensembl.org/xrefs/symbol/homo_sapiens/{clean}"
        xref_resp = http_session.get(xref_url, timeout=20)
        if getattr(xref_resp, "status_code", 0) == 200:
            for item in xref_resp.json() or []:
                iid = str(item.get("id") or "")
                if item.get("type") == "transcript" and iid.startswith("ENST"):
                    parsed_data["ensembl_transcript_id"] = iid
                    return iid
    except Exception:
        pass
    return ""


def _mrna_exon_total(parsed_data, coding_exons=None):
    """Total mRNA exon count without requiring a local Ensembl `exons` list."""
    mt = parsed_data.get('mrna_exon_total')
    if mt is not None:
        try:
            n = int(mt)
            if n > 0:
                return n
        except (TypeError, ValueError):
            pass
    nt = parsed_data.get('nmd_exon_total')
    if nt is not None:

        try:
            n = int(nt)
            if n > 0:
                return n
        except (TypeError, ValueError):
            pass
    ce = coding_exons if coding_exons is not None else (parsed_data.get('coding_exons') or [])
    if ce:
        n = int(ce[-1]['anatomical_rank'])
        if parsed_data.get('first_mrna_exon_is_non_coding'):
            n += 1
        return n
    return 0


def _build_clinical_publication_summary(parsed_data):
    """
    Short prose for papers / reports from structured ai_logic + resolved HGVS.
    Expects optional keys on ai_logic from Gemini: patients_affected_count, disorders,
    inheritance_classification, inheritance_notes, affected_relatives_with_variant,
    clinical_extraction_confidence.
    """
    gene = (parsed_data.get('effective_gene') or parsed_data.get('gene') or '').strip()
    c_dot = (parsed_data.get('c_dot') or '').strip()
    p_raw = (parsed_data.get('hgvs_p') or '').strip()
    p_disp = ''
    if p_raw:
        p_disp = p_raw if p_raw.startswith('p.') else f'p.{p_raw}'
    tx_id = (
        (parsed_data.get('refseq_transcript_id') or '').strip()
        or (parsed_data.get('ensembl_transcript_id') or '').strip()
    )
    mut_bits = [gene]
    if c_dot:
        mut_bits.append(c_dot)
    if p_disp:
        mut_bits.append(f'({p_disp})')
    mutation_label = ' '.join(mut_bits)

    ai = parsed_data.get('ai_logic')
    if not isinstance(ai, dict):
        ai = {}

    disorders_raw = ai.get('disorders') or []
    if isinstance(disorders_raw, str):
        disorders_raw = [disorders_raw]
    disorders_plain = [str(d).strip() for d in disorders_raw if str(d).strip()]
    disorders_html = [html.escape(d) for d in disorders_plain]

    n_pat = ai.get('patients_affected_count')
    try:
        n_pat_i = int(n_pat) if n_pat is not None and str(n_pat).strip() != '' else None
    except (TypeError, ValueError):
        n_pat_i = None

    inh = str(ai.get('inheritance_classification') or 'unknown').strip().lower().replace(' ', '_').replace('-', '_')
    if inh in ('denovo',):
        inh = 'de_novo'
    if inh not in ('de_novo', 'inherited', 'unknown', 'mixed'):
        inh = 'unknown'

    inh_notes_raw = (ai.get('inheritance_notes') or '').strip()
    inh_notes_html = html.escape(inh_notes_raw) if inh_notes_raw else ''

    rel_raw = ai.get('affected_relatives_with_variant') or []
    if isinstance(rel_raw, str):
        rel_raw = [rel_raw]
    relatives_plain = [str(r).strip() for r in rel_raw if str(r).strip()]
    relatives_html = [html.escape(r) for r in relatives_plain]

    inh_labels = {
        'de_novo': 'Reported as de novo',
        'inherited': 'Reported as inherited / familial',
        'unknown': 'Inheritance not stated or unclear in the notes',
        'mixed': 'Mixed (multiple pedigrees, conflicting reports, or unclear)',
    }
    inh_plain = inh_labels.get(inh, inh)

    notes_provided = bool(parsed_data.get('clinical_notes_provided'))

    lines_plain = [f'Variant: {mutation_label}.']
    if tx_id:
        lines_plain.append(f'Transcript: {tx_id}.')
    if notes_provided:
        if n_pat_i is not None:
            lines_plain.append(f'Patients described (phenotype relevant to submission): {n_pat_i}.')
        if disorders_plain:
            lines_plain.append(f'Disorder(s): {", ".join(disorders_plain)}.')
        lines_plain.append(f'Inheritance: {inh_plain}.')
        if inh_notes_raw:
            lines_plain.append(inh_notes_raw)
        if inh in ('inherited', 'mixed') and relatives_plain:
            lines_plain.append(
                f'Affected relatives reported to carry this variant: {", ".join(relatives_plain)}.'
            )
        elif inh == 'de_novo' and relatives_plain:
            lines_plain.append(f'Pedigree notes in text: {", ".join(relatives_plain)}.')

        conf = str(ai.get('clinical_extraction_confidence') or '').strip().lower()
        if conf == 'partial':
            lines_plain.append('[Clinical extraction partial — confirm against primary records.]')
        elif conf == 'low':
            lines_plain.append('[Clinical extraction low confidence — confirm against primary records.]')
    else:
        lines_plain.append('No clinical chart notes were submitted; pedigree / inheritance summary not extracted.')

    plaintext = '\n'.join(lines_plain)

    lis = []
    lis.append(f'<strong>Variant:</strong> {html.escape(mutation_label)}')
    if tx_id:
        lis.append(f'<strong>Transcript:</strong> {html.escape(tx_id)}')
    if notes_provided:
        if n_pat_i is not None:
            lis.append(f'<strong>Patients (relevant phenotype):</strong> {n_pat_i}')
        if disorders_html:
            lis.append(f'<strong>Disorder(s):</strong> {", ".join(disorders_html)}')
        lis.append(f'<strong>Inheritance:</strong> {html.escape(inh_plain)}')
        if inh_notes_html:
            lis.append(f'<strong>Inheritance detail:</strong> {inh_notes_html}')
        if relatives_html:
            lab = (
                'Affected relatives with variant'
                if inh in ('inherited', 'mixed')
                else 'Pedigree / carrier notes'
            )
            lis.append(f'<strong>{lab}:</strong> {", ".join(relatives_html)}')
        conf = str(ai.get('clinical_extraction_confidence') or '').strip().lower()
        if conf in ('partial', 'low'):
            lis.append(
                '<span style="color:#94a3b8;font-size:0.88em;">'
                f'Extraction confidence: {html.escape(conf)}</span>'
            )
    else:
        lis.append('<span style="color:#94a3b8;">No clinical notes submitted.</span>')

    html_out = (
        '<ul style="margin:8px 0 0 0;padding-left:18px;line-height:1.45;font-size:0.92em;color:#e2e8f0;">'
        + ''.join(f'<li style="margin-bottom:6px;">{x}</li>' for x in lis)
        + '</ul>'
    )

    return {'html': html_out, 'plaintext': plaintext}


@analyze_bp.route('/api/analyze', methods=['POST'])
def analyze_variant():
    try:
        data = request.json
        gene = data.get('gene', '').strip()
        c_dot_raw = data.get('c_dot', '').strip()
        
        # Sanitize coordinate string globally, stripping out prepended NM_/NR_ IDs or appended text
        import re
        c_match = re.search(r'[cnr]\.[a-zA-Z0-9_*+->]+', c_dot_raw, re.I)
        if c_match:
            c_dot = c_match.group(0)
        else:
            c_dot = c_dot_raw
        c_dot = _normalize_dna_hgvs_prefix(c_dot)
            
        target_transcript = data.get('transcript', '').strip()
        if target_transcript and '.' in target_transcript:
            target_transcript = target_transcript.split('.')[0]
        clinical_notes = data.get('clinical_notes', '').strip()
        intake_hgvs_p = (
            data.get('hgvs_p')
            or data.get('p_dot')
            or data.get('p_nom')
            or data.get('pNom1')
            or ""
        )
        if isinstance(intake_hgvs_p, str):
            intake_hgvs_p = intake_hgvs_p.strip()
        else:
            intake_hgvs_p = ""
        splice_row = data.get('splice_row', '')
        if isinstance(splice_row, str): splice_row = splice_row.strip()
        splice_col = data.get('splice_col', '')
        if isinstance(splice_col, str): splice_col = splice_col.strip()
        splice_pts = data.get('splice_points')
        nmd_points = data.get('nmd_points')

        noncoding_track = _is_noncoding_dna_hgvs(c_dot, target_transcript)
        hgvs_dna_kind = _hgvs_dna_kind(c_dot) or ("n" if noncoding_track else "c")

        if not gene or not c_dot:
            return jsonify({"error": "Gene and HGVS notation (c./n./r.) are required."}), 400

        # Re-instituted the MyVariant base parser: The local VCF Regex explicitly drops complex Indels. 
        try:
            mv_url = f"https://myvariant.info/v1/query?q={gene}+AND+{c_dot}&fields=all"
            mv_data = http_session.get(mv_url, timeout=12).json()
        except Exception as e:
            print(f"Primary MyVariant Ping Offline: {e}")
            mv_data = {}
        # Determine effective gene from MyVariant response if possible
        effective_gene = gene
        valid_hit_found = False
        c_core = _myvariant_c_dot_tail_norm(c_dot)
        verified_hit = None
        myvariant_match_score = 0

        if mv_data.get('hits'):
            hits = mv_data['hits']
            verified_hit, myvariant_match_score = _pick_best_myvariant_hit(
                hits, c_core, target_transcript if target_transcript else None
            )
            if verified_hit is not None and myvariant_match_score >= 3:
                valid_hit_found = True
                effective_gene = _gene_symbol_from_myvariant_hit(
                    gene, verified_hit, target_transcript,
                )
        
        # Fallback 1: If MyVariant didn't confirm the c.dot, try to get the gene symbol using VEP quickly just for the AI prompts
        if not valid_hit_found:
            try:
                # Prefer NR_/NM_/ENST:HGVS when available (snRNA uses NR_:n.)
                _tmp_hgvs = _vep_hgvs_query(target_transcript, c_dot, gene) or f"{gene}:{c_dot}"
                # Add NMD=1 to get nonsense-mediated decay flags, Protein=1 for lengths, hgvs=1 for p. notation, mane=1 for MANE transcripts
                tmp_vep_url = f"https://rest.ensembl.org/vep/human/hgvs/{urllib.parse.quote(_tmp_hgvs, safe='')}"
                tmp_vep_response = http_session.get(tmp_vep_url, timeout=120)
                if tmp_vep_response.status_code == 200:
                    tmp_vep_data = tmp_vep_response.json()
                    if tmp_vep_data and len(tmp_vep_data) > 0:
                        vep_genes = []
                        for t in tmp_vep_data[0].get('transcript_consequences', []):
                            g_sym = t.get('gene_symbol')
                            if g_sym and g_sym not in vep_genes:
                                vep_genes.append(g_sym)
                        effective_gene = _resolve_effective_gene_from_vep_symbols(gene, vep_genes)
            except Exception as e:
                pass

        # 1. Ask Gemini to Parse Clinical Notes
        ai_logic = {}
        if clinical_notes and client:
            prompt = f"""
    You are a precision clinical genetics classifier.
    The variant being analyzed is in the {effective_gene} gene.
    Read the FOLLOWING COMPREHENSIVE MEDICAL HISTORY carefully.
    You MUST analyze the ENTIRE text, identifying EVERY separate independent family or patient described.

    "{clinical_notes}"

    Synthesize the evidence for EACH independent family/patient. Do not assign an institutional numeric score.

    Crucial Instructions:
    1. Return a JSON object with a "families" array.
    2. Each item in the array MUST represent a separate, unrelated family or index patient from the text. 
    3. If a patient/family is from a "small", "inbred", or "endogamous" community, note consanguinity even if the text says "parental consanguinity denied" for that specific family.
    4. If multiple patients are from the same inbred or consanguineous community, evaluate their relationship carefully to determine if they should be grouped or handled as independent alleles.
    5. "total_segregations_across_all_families" must be the GLOBAL SUM of all unique segregations observed across ALL families WHERE the phenotype matches the {effective_gene} gene. Do not count segregations from discordant families.
    6. "is_specific_etiology" applies globally if a family with a CONCORDANT phenotype has a highly specific match for disease with a single etiology.
    7. PHENOTYPE CONCORDANCE RULE: For EACH family, evaluate if their described clinical symptoms actually match the known genetic diseases associated with the {effective_gene} gene. If the phenotype is completely unrelated to {effective_gene}, set "phenotype_match" to false.
    8. PUBLICATION / METHODS SUMMARY (structured): Extract concise pedigree facts for the variant being analyzed in {effective_gene}.
       - patients_affected_count: integer — distinct affected individuals described whose phenotype matches the reported disorder context for this gene (probands + affected relatives with compatible phenotype). Use null only if impossible to estimate from text.
       - disorders: array of short strings — diagnoses/phenotypes tied to those patients (use plain clinical names as written).
       - inheritance_classification: one of exactly "de_novo", "inherited", "unknown", "mixed".
       - inheritance_notes: short free-text — e.g. maternal lineage, compound heterozygote with second variant (describe briefly), consanguinity. Empty string if none.
       - affected_relatives_with_variant: array of short strings — ONLY relatives explicitly stated as BOTH clinically affected AND confirmed (by sequencing/genotype wording) to carry THIS variant (or homozygous/compound het involving this allele as stated). Examples: "mother (II-2), affected, variant carrier", "affected sibling". Leave empty array if not confirmed in text.
       - clinical_extraction_confidence: "high", "partial", or "low" depending on how explicit the chart/text was.

    Output JSON exactly matching this schema:
    {{
      "families": [
        {{
          "phenotype_match": <boolean representing if the patient's symptoms match the {effective_gene} gene>
        }}
      ],
      "total_segregations_across_all_families": <integer representing the TOTAL SUM of segregations described across EVERY independent family, or 0>,
      "is_specific_etiology": <boolean>,
      "patients_affected_count": <integer or null>,
      "disorders": [<string>, ...],
      "inheritance_classification": "de_novo" | "inherited" | "unknown" | "mixed",
      "inheritance_notes": <string>,
      "affected_relatives_with_variant": [<string>, ...],
      "clinical_extraction_confidence": "high" | "partial" | "low"
    }}
    """
            try:
                response = client.models.generate_content(
                    model='gemini-2.5-flash',
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                    ),
                )
                ai_logic = json.loads(response.text)
            except Exception as e:
                print(f"Gemini API Error: {e}")

        # 2. Ask Gemini for Gene Knowledge Profile & Disease Mechanism
        gene_summary = ""
        disease_mechanism = "Unknown"
        mechanism_cite = ""

        if not client:
            print(f"DEBUG: Skipping Gemini Profile/Mechanism for {effective_gene} (client disabled)")
            gene_summary = (
                "<span style='color:#94a3b8;'>"
                "Gene profile / disease mechanism LLM skipped (Gemini disabled). "
                "ClinVar, ClinGen, scores, and allelic context still run. "
                "Mechanism treated as <b>Unknown</b> for PVS1."
                "</span>"
            )
            disease_mechanism = "Unknown"
        else:
            print(f"DEBUG: Requesting Gemini Profile/Mechanism for {effective_gene}")
            summary_prompt = f"""
    You are an expert clinical geneticist. Use Google Search to research the {effective_gene} gene.
    Synthesize information from sources like OMIM, ClinGen, GeneReviews, and Medline for the gene and disease description.

    1. Create a concise HTML clinical profile. Do not use markdown wrappers.
    Format the output purely as HTML with these exact bold headers:
    <br><b>Disease Association(s):</b> (List the exact, full disease names as listed in OMIM. Do NOT use broad or confusing abbreviations like "SMA" for conditions like Pontocerebellar Hypoplasia)
    <br><b>Inheritance Pattern(s):</b> (e.g., AD, AR, XL)

    2. Determine the primary mechanism of disease for {effective_gene}.
    - If the gene causes disease primarily when its function is destroyed (e.g. nonsense/frameshift variants cause disease), label it "LOF".
    - If the gene causes disease primarily when a specific variant creates a toxic new function, constitutive activation, or overactivity, label it "GOF". (Note: Do not assume recessive inheritance means LOF; e.g., MEFV causes recessive FMF via constitutive inflammasome activation, which is "GOF").
    - If the gene is highly established to cause disease via BOTH LOF and GOF mechanisms depending on the specific variant, the specific protein domain affected (e.g., classic LOF vs dominant-negative effects in different domains), or phenotype (e.g., SCN5A, STAT3, KDM2B), label it "Both".
    - If it is completely unclear or unknown, label it "Unknown".
    
    3. Briefly provide the source/citation where you found this mechanism (e.g., "ClinGen Expert Panel", "OMIM [ID]", "GeneReviews", or a specific paper).

    Return EXACTLY this JSON schema (ensure the JSON is strictly valid, and escape any newlines as \\n):
    {{
      "html_profile": "Your HTML string here",
      "disease_mechanism": "LOF" | "GOF" | "Both" | "Unknown",
      "mechanism_citation": "Short source string here"
    }}
    """
            try:
                print("DEBUG: Making Gemini API Call...")
                
                def fetch_gemini():
                    return client.models.generate_content(
                        model='gemini-2.5-flash',
                        contents=summary_prompt,
                        config=types.GenerateContentConfig(
                            tools=[{"google_search": {}}],
                        ),
                    )
                
                executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
                try:
                    future = executor.submit(fetch_gemini)
                    # Increased timeout to 30s to allow Gemini & Google Search to complete
                    summary_response = future.result(timeout=30)
                finally:
                    # Prevent the main Flask thread from hanging indefinitely waiting for the child to finish
                    executor.shutdown(wait=False)
                    
                print("DEBUG: Gemini API Call Complete.")
                
                text = summary_response.text
                if not text:
                    raise ValueError("Empty response from AI model")
                
                json_match = re.search(r'\{[\s\S]*\}', text)
                if json_match:
                    clean_text = json_match.group(0)
                else:
                    clean_text = text
                    
                parsed_summary = json.loads(clean_text, strict=False)
                gene_summary = parsed_summary.get("html_profile", "")
            
                # Format mechanism into the summary for the user to see
                mechanism_raw = parsed_summary.get("disease_mechanism", "Unknown")
                mechanism_cite = parsed_summary.get("mechanism_citation", "")
                cite_html = f" <span style='font-size: 0.85em; color: #9ca3af; font-style: italic;'>(Source: {mechanism_cite})</span>" if mechanism_cite else ""
                
                disease_mechanism = mechanism_raw
                if mechanism_raw == "LOF" or mechanism_raw == "GOF":
                    gene_summary += f"<br><b>Disease Mechanism:</b> {mechanism_raw}{cite_html}"
                elif mechanism_raw == "Both":
                    gene_summary += f"<br><b>Disease Mechanism:</b> Both (LOF & GOF){cite_html}"
                else:
                     gene_summary += f"<br><b>Disease Mechanism:</b> Unknown / Variable{cite_html}"
                 
            except concurrent.futures.TimeoutError:
                print("Gemini API Error (Gene Summary): Timeout after 30 seconds")
                gene_summary = "<span style='color: #fca5a5;'>Failed to load gene profile from AI. Request timed out.</span>"
                disease_mechanism = "Unknown"
            except Exception as e:
                err_msg = str(e) or type(e).__name__
                print(f"Gemini API Error (Gene Summary): {err_msg}")
                gene_summary = f"<span style='color: #fca5a5;'>Failed to load gene profile from AI. AI Quota may be exhausted. (Error: {err_msg})</span>"
                disease_mechanism = "Unknown"


        parsed_data = {
            "gene": gene,
            "user_gene": gene,
            "c_dot": c_dot,
            "transcript": target_transcript or "",
            "hgvs_dna_kind": hgvs_dna_kind,
            "noncoding_track": noncoding_track,
            "consequence": "unknown",
            "cadd_phred": 0,
            "revel_score": 0,
            "gnomad_af": None,
            "spliceai_ds_ag": 0.0,
            "spliceai_ds_al": 0.0,
            "spliceai_ds_dg": 0.0,
            "spliceai_ds_dl": 0.0,
            "clinvar_sig": "",
            "clinvar_rcv": "", # Added clinvar_rcv initialization
            "ai_logic": ai_logic,
            "clinical_notes_provided": bool(clinical_notes),
            "has_downstream_pathogenic": False,
            "refseq_nm_synonyms": [],
            "refseq_nm_synonym_c_tails": [],
            "disease_mechanism": disease_mechanism,
            "disease_mechanism_citation": mechanism_cite if 'mechanism_cite' in locals() else "",
            "effective_gene": effective_gene,
            "uniprot_link": f"https://www.uniprot.org/uniprotkb?query=gene_exact:{effective_gene}%20AND%20model_organism:9606",
            "spliceai_narrative": "",
            "cryptic_gain_outcome": None,
            "inframe_coding_outcome": None,
            "intake_hgvs_p": intake_hgvs_p,
        }
        if intake_hgvs_p:
            # Seed early so allelic ClinVar scoring can use the named p.; may be refined later.
            _p_seed = intake_hgvs_p if intake_hgvs_p.lower().startswith("p.") else f"p.{intake_hgvs_p}"
            # Strip "c.… (p.…)" wrappers from EMG nomen fields.
            _pm = re.search(r"p\.([A-Za-z*][A-Za-z0-9_*]+)", _p_seed)
            if _pm:
                parsed_data["hgvs_p"] = f"p.{_pm.group(1)}"
            elif _p_seed.lower().startswith("p."):
                parsed_data["hgvs_p"] = _p_seed

        # Pre-map RefSeq NM_/NR_ to Ensembl ENST_ so both MyVariant and VEP can find the exact transcript
        mapped_enst = ""
        if target_transcript and target_transcript.upper().startswith(("NM_", "NR_")):
            try:
                base_nm = target_transcript.split('.')[0]
                # We bypass xrefs/symbol for NM_ accessions because searching by gene symbol returns all transcripts
                # and picking the first one arbitrarily overwrites canonical dbnsfp priorities from MyVariant. 
                xref_url = f"https://rest.ensembl.org/xrefs/symbol/homo_sapiens/{base_nm}"
                xref_resp = http_session.get(xref_url, timeout=20)
                if xref_resp.status_code == 200:
                    for x in xref_resp.json():
                        if x.get('id', '').startswith('ENST'):
                            mapped_enst = x['id']
                            break
            except: pass

        hit = verified_hit if verified_hit else {}
        spliceai_fmt = None
        if valid_hit_found and verified_hit is not None:
            hit = verified_hit
            parsed_data['nmd_escape'] = False # Default assumption for old parser
            parsed_data['nmd_escape_truncation_fraction'] = 0.0
            parsed_data['protein_start'] = 0
            parsed_data['protein_length'] = 0
            # Keep intake/EMG named p. when MyVariant has not yet supplied protein HGVS.
            if _hgvs_p_is_placeholder(parsed_data.get('hgvs_p')):
                parsed_data['hgvs_p'] = ""
        
            # Get CADD
            if 'cadd' in hit and 'phred' in hit['cadd']:
                parsed_data['cadd_phred'] = hit['cadd']['phred']
            
            # Get REVEL
            if 'dbnsfp' in hit and 'revel' in hit['dbnsfp']:
                try:
                    revel_data = hit['dbnsfp']['revel']
                    if isinstance(revel_data, dict):
                        parsed_data['revel_score'] = float(revel_data.get('score', 0))
                    else:
                        parsed_data['revel_score'] = float(revel_data)
                except:
                    pass
            
            # Extract Native ClinVar Significance and RCV Variation Binding
            if 'clinvar' in hit and myvariant_match_score >= 3:
                cv_data = hit['clinvar']
                rcvs = cv_data.get('rcv', [])
                if isinstance(rcvs, dict): 
                    rcvs = [rcvs]
                if rcvs:
                    parsed_data['clinvar_sig'] = rcvs[0].get('clinical_significance', '')
                    parsed_data['clinvar_rcv'] = str(cv_data.get('variant_id', rcvs[0].get('accession', '')))

            _merge_refseq_synonyms_from_clinvar_myvariant_hit(hit, parsed_data)
            _vid_syn = hit.get("clinvar", {}).get("variant_id")
            if _vid_syn is not None and len(parsed_data.get("refseq_nm_synonyms") or []) < 3:
                _enrich_refseq_synonyms_clinvar_vid_lookup(http_session, str(_vid_syn), parsed_data)

            # Get Consequence (from snpeff or clinvar)
            if 'snpeff' in hit and 'ann' in hit['snpeff']:
                ann = hit['snpeff']['ann']
                if isinstance(ann, dict):
                    ann = [ann]
                
                best_score_unified = -1
                best_ann = None
            
                for a in ann:
                    # [NEW] Ensure this snpeff annotation is concordant with the requested c. dot.
                    # MyVariant groups by genomic locus, meaning we can pull a hit where clinvar has NM_004408.4:c.1594 but snpeff only has NM_004408.3:c.1591.
                    a_hgvsc = _myvariant_c_dot_tail_norm(a.get('hgvs_c', ''))
                    w_c = _myvariant_c_dot_tail_norm(c_core)
                    if w_c and not _hgvs_c_dot_alleles_equal(w_c, a_hgvsc):
                        continue

                    feature_id = a.get('feature_id', '')
                    feature_base = feature_id.split('.')[0] if '.' in feature_id else feature_id
                
                    transcript_score = 0
                    if target_transcript and target_transcript == feature_base:
                        transcript_score = 3
                    elif 'NM_' in feature_id:  # Prioritize RefSeq if no target given
                        transcript_score = 2
                    else:
                        transcript_score = 1
                    
                    # Extract HGVSP candidate
                    hgvsp_candidate = a.get('hgvs_p', '')
                    if not hgvsp_candidate:
                        hgvsp_candidate = a.get('putative_impact', '') or feature_id
                    
                    # Extract Math candidates
                    protein_data = a.get('protein', {})
                    start_pos = 0
                    seq_len_val = 0
                    effective_start = 0
                    trunc_frac = 0.0
                    
                    cdna_pos = 0
                    cds_pos = 0
                    exon_rank = 0
                    exon_total = 0
                    try:
                        cdna_pos = int(a.get('cdna', {}).get('position', 0) or 0)
                    except: cdna_pos = 0
                    
                    try:
                        cds_pos = int(a.get('cds', {}).get('position', 0) or 0)
                    except: cds_pos = 0
                    
                    try:
                        exon_rank = int(a.get('rank') or 0)
                    except: exon_rank = 0
                    
                    try:
                        exon_total = int(a.get('total') or 0)
                    except: exon_total = 0
                
                    if protein_data:
                        try:
                            start_str = protein_data.get('position', '')
                            if isinstance(start_str, str) and '/' in start_str:
                                start_str = start_str.split('/')[0]
                            start_pos = float(start_str) if start_str else 0
                        
                            len_str = protein_data.get('length', '')
                            if isinstance(len_str, str) and '/' in len_str:
                                len_str = len_str.split('/')[1]
                            seq_len_val = float(len_str) if len_str else 0
                        
                            if start_pos and seq_len_val and seq_len_val > 0:
                                effective_start = start_pos
                        except Exception as e:
                            pass
                        
                    # Apply Unified Decision
                    # We want to pick exactly ONE transcript to represent BOTH the label and the math.
                    should_update = False
                    if transcript_score > best_score_unified:
                        should_update = True
                    elif transcript_score == best_score_unified:
                        # Tiebreaker: pick the one with the longest valid p. string (often Canonical).
                        # NM_000272.3 is often better than NM_001128178.1 which has missing segments.
                        if len(hgvsp_candidate) > len(parsed_data.get('hgvs_p', '')):
                            should_update = True
                        
                    if should_update:
                        parsed_data['hgvs_p'] = hgvsp_candidate
                        parsed_data['protein_start'] = int(effective_start)
                        parsed_data['protein_length'] = int(seq_len_val)
                        parsed_data['snpeff_cdna_pos'] = cdna_pos
                        parsed_data['snpeff_cds_pos'] = cds_pos
                        parsed_data['snpeff_exon_rank'] = exon_rank
                        parsed_data['snpeff_exon_total'] = exon_total
                        best_score_unified = transcript_score
                        best_ann = a
                        
                # Commit the consequence based on the best parsed annotation
                if best_ann:
                    raw_effect = best_ann.get('effect', 'unknown').lower()
                    if 'stop_gained' in raw_effect:
                        parsed_data['consequence'] = 'nonsense'
                        ps = parsed_data.get('protein_start')
                        pl = parsed_data.get('protein_length')
                        if ps and pl:
                            parsed_data['nmd_escape_truncation_fraction'] = c_terminal_loss_fraction(
                                int(ps), int(pl),
                            )
                    elif 'frameshift' in raw_effect:
                        parsed_data['consequence'] = 'frameshift'
                    elif 'start_lost' in raw_effect:
                        parsed_data['consequence'] = 'start_lost'
                    elif 'missense' in raw_effect:
                        parsed_data['consequence'] = 'missense'
                        parsed_data['nmd_escape_truncation_fraction'] = 0.0
                    elif 'splice_donor' in raw_effect or 'splice_acceptor' in raw_effect:
                        parsed_data['consequence'] = raw_effect
                    elif 'splice_region' in raw_effect:
                        parsed_data['consequence'] = 'splice_region_variant'
                    else:
                        parsed_data['consequence'] = raw_effect
                        
                # [NEW] Fallback: If winning transcript lacks exon rank, salvage from any available transcript
                if not parsed_data.get('snpeff_exon_rank') or int(parsed_data.get('snpeff_exon_rank')) < 1:
                    for a in ann:
                        try:
                            fallback_r = int(a.get('rank') or 0)
                            fallback_t = int(a.get('total') or 0)
                            if fallback_r > 0 and fallback_t > 0:
                                parsed_data['snpeff_exon_rank'] = fallback_r
                                parsed_data['snpeff_exon_total'] = fallback_t
                                break
                        except: pass
                        
                # [Override logic moved to global scope]
            if 'dbnsfp' in hit and 'ensembl' in hit['dbnsfp']:
                tids = hit['dbnsfp']['ensembl'].get('transcriptid', [])
                
                selected_tid = None
                if isinstance(tids, list) and len(tids) > 0:
                    if mapped_enst and mapped_enst in tids:
                        selected_tid = mapped_enst
                    else:
                        selected_tid = tids[0]
                elif isinstance(tids, str):
                    selected_tid = tids
                    
                parsed_data['ensembl_transcript_id'] = selected_tid
            # dbnsfp hgvsp used as fallback ONLY if snpeff is missing it
            if not parsed_data.get('hgvs_p') and 'dbnsfp' in hit and 'hgvsp' in hit['dbnsfp']:
                p_val = hit['dbnsfp']['hgvsp']
                parsed_data['hgvs_p'] = p_val if isinstance(p_val, str) else str(p_val[0] if isinstance(p_val, list) else p_val)
                    
            # Sanitize: Only keep hgvs_p if it actually contains a 'p.' notation (e.g., 'p.Arg123Ser'), else wipe it
            if 'p.' not in parsed_data.get('hgvs_p', '') and 'p:' not in parsed_data.get('hgvs_p', ''):
                parsed_data['hgvs_p'] = ""
            elif ':' in parsed_data.get('hgvs_p', ''):
                # Clean up if dbnsfp gives "ENSPXXXX:p.Arg123"
                parsed_data['hgvs_p'] = parsed_data['hgvs_p'].split(':')[1]
        
            # Get gnomAD AF. A configured local sites VCF replaces MyVariant entirely.
            if not local_gnomad_configured():
                # Exomes first; genomes matter for snRNA / noncoding loci.
                if 'gnomad_exomes' in hit and 'af' in hit['gnomad_exomes']:
                    try:
                        parsed_data['gnomad_af'] = hit['gnomad_exomes']['af']['af']
                        parsed_data['gnomad_af_source'] = 'exomes'
                    except Exception:
                        pass
                if (parsed_data.get('gnomad_af') in (None, 0, 0.0)) and 'gnomad_genomes' in hit:
                    try:
                        gaf = hit['gnomad_genomes'].get('af')
                        if isinstance(gaf, dict):
                            parsed_data['gnomad_af'] = gaf.get('af') or gaf.get('AF') or 0
                        elif gaf is not None:
                            parsed_data['gnomad_af'] = float(gaf)
                        parsed_data['gnomad_af_source'] = 'genomes'
                    except Exception:
                        pass
                parsed_data['gnomad_checked'] = True
                if parsed_data.get('gnomad_af') is None:
                    parsed_data['gnomad_af'] = 0
                    parsed_data['gnomad_af_source'] = 'absent'
            if 'dbnsfp' in hit and 'uniprot' in hit['dbnsfp']:
                uniprot_acc = _pick_dbnsfp_uniprot_accession(
                    hit['dbnsfp']['uniprot'], effective_gene
                )
                if uniprot_acc:
                    parsed_data['uniprot_link'] = (
                        f"https://www.uniprot.org/uniprotkb/{uniprot_acc}/entry"
                    )
            
            # Removed hard wipe of clinvar_sig and clinvar_rcv to permit fallback on MyVariant data for indels failed by regex
            
        has_38_mapping = True if valid_hit_found else False
        if valid_hit_found:
            clinvar_g = hit.get('clinvar', {}).get('hgvs', {}).get('genomic', [])
            if isinstance(clinvar_g, str): clinvar_g = [clinvar_g]
            has_38_mapping = any(g.startswith('NC_') and '.11:' in g for g in clinvar_g)
        current_enst = parsed_data.get('ensembl_transcript_id', '')
        if not valid_hit_found or not current_enst or not current_enst.startswith('ENST') or parsed_data.get('consequence', 'unknown') == 'unknown' or not has_38_mapping:
            # 3. Secure VEP Fallback Mapping & Native Cross-referencing
            print(f"DEBUG: VEP Fallback Triggered. ENST present: {current_enst}")
            # We hit VEP specifically for rigorous MANE/Canonical ranking when local xref mapping fails
            # Fallback to Ensembl VEP for exact consequences if myvariant.info doesn't have it or lacks the ENST ID, or if we strictly require a clean Sequence mapping for Deep-Learning Splice predictions.
            c_lower = c_dot.lower()
            consequence = parsed_data.get('consequence', 'unknown')
            nmd_escape = parsed_data.get('nmd_escape', False)
            nmd_escape_truncation_fraction = parsed_data.get('nmd_escape_truncation_fraction', 0.0)
            best_protein_start = parsed_data.get('protein_start', 0)
            best_protein_length = parsed_data.get('protein_length', 0)
            best_hgvsp = parsed_data.get('hgvs_p', '')
            best_transcript_id = parsed_data.get('ensembl_transcript_id', mapped_enst)
            parsed_data['spliceai_ds_ag'] = 0.0
            parsed_data['spliceai_ds_al'] = 0.0
            parsed_data['spliceai_ds_dg'] = 0.0
            parsed_data['spliceai_ds_dl'] = 0.0
            parsed_data['spliceai_dp_ag'] = ""
            parsed_data['spliceai_dp_al'] = ""
            parsed_data['spliceai_dp_dg'] = ""
            parsed_data['spliceai_dp_dl'] = ""
            parsed_data['pangolin_ds_sg'] = 0.0
            parsed_data['pangolin_ds_sl'] = 0.0
            parsed_data['pangolin_dp_sg'] = ""
            parsed_data['pangolin_dp_sl'] = ""
        
            try:
                # Target specific transcript to bypass minus-strand reference phase errors in Ensembl
                hgvs_target = _vep_hgvs_query(target_transcript, c_dot, effective_gene) or f"{effective_gene}:{c_dot}"
                vep_url = f"https://rest.ensembl.org/vep/human/hgvs/{urllib.parse.quote(hgvs_target, safe='')}?NMD=1&Protein=1&hgvs=1&mane=1&canonical=1&numbers=1&vcf_string=1"
                vep_response = http_session.get(vep_url, timeout=120)
                
                if vep_response.status_code == 400:
                    try:
                        err_txt = vep_response.json().get('error', '')
                        if 'does not match reference allele' in err_txt:
                            return jsonify({"error": f"Invalid Variant Reference: {err_txt}"}), 400
                    except: pass
                    
                if vep_response.status_code != 200 and target_transcript:
                    vep_url = f"https://rest.ensembl.org/vep/human/hgvs/{urllib.parse.quote(f'{effective_gene}:{c_dot}', safe='')}?NMD=1&Protein=1&hgvs=1&mane=1&canonical=1&numbers=1&vcf_string=1"
                    vep_response = http_session.get(vep_url, timeout=120)
                    
                    if vep_response.status_code == 400:
                        try:
                            err_txt = vep_response.json().get('error', '')
                            if 'does not match reference allele' in err_txt:
                                return jsonify({"error": f"Invalid Variant Reference: {err_txt}"}), 400
                        except: pass
                    
                if vep_response.status_code == 200:
                    vep_data = vep_response.json()
                    if vep_data and len(vep_data) > 0:
                        parsed_data['grch38_chrom'] = vep_data[0].get('seq_region_name', '')
                        if not parsed_data['grch38_chrom'].startswith('chr'): parsed_data['grch38_chrom'] = 'chr' + parsed_data['grch38_chrom']
                        parsed_data['grch38_start'] = vep_data[0].get('start')
                        parsed_data['grch38_end'] = vep_data[0].get('end')
                        try:
                            _vep_ale = str(vep_data[0].get('allele_string', '') or '')
                            if '/' in _vep_ale:
                                _ra, _aa = _vep_ale.split('/')[:2]
                                if _ra and _aa:
                                    _ra_n, _aa_n, _ = _normalize_to_forward_strand(
                                        http_session,
                                        parsed_data.get('grch38_chrom'),
                                        parsed_data.get('grch38_start'),
                                        _ra.upper(), _aa.upper(),
                                        parsed_data.get('grch38_end'),
                                    )
                                    parsed_data['ref'] = _ra_n
                                    parsed_data['alt'] = _aa_n
                        except Exception:
                            pass
                    
                    if vep_data and len(vep_data) > 0:
                        _vep_vcf = vep_data[0].get('vcf_string')
                        if _vep_vcf:
                            parsed_data['vep_vcf_string'] = _vep_vcf
                        _syn_pack_vep = _collect_refseq_nm_synonyms_from_vep_tc(
                            vep_data[0].get("transcript_consequences", [])
                        )
                        _merge_into_parsed_refseq_synonyms(parsed_data, _syn_pack_vep)

                        best_score_math = -1
                        best_score_hgvsp = -1
                        best_t_dict = None
                    
                        # Check all transcripts for an NMD escape flag
                        for t in vep_data[0].get('transcript_consequences', []):
                            t_id = str(t.get('transcript_id', ''))
                            t_mane = str(t.get('mane_select', ''))
                            is_canonical = (t.get('canonical') == 1)
                        
                            transcript_score = 0
                            if mapped_enst and mapped_enst in t_id:
                                transcript_score = 4
                            elif target_transcript and (target_transcript in t_id or target_transcript in t_mane):
                                transcript_score = 3
                            elif t_mane:
                                transcript_score = 2
                            elif is_canonical:
                                transcript_score = 1
                            elif t.get('biotype') == 'protein_coding':
                                transcript_score = 0.5
                            elif noncoding_track and str(t.get('biotype') or '') in (
                                'snRNA', 'snoRNA', 'miRNA', 'lncRNA', 'misc_RNA',
                                'rRNA', 'scRNA', 'sRNA', 'vault_RNA',
                            ):
                                transcript_score = 1.5
                                
                            print(f"DEBUG: VEP evaluating ID {t_id} MANE {t_mane} against {target_transcript} -> Score {transcript_score}")
                            
                            # Track the best general transcript regardless of protein impacts for structural mapping
                            if transcript_score > best_score_math:
                                best_transcript_id = t_id
                                best_t_dict = t
                                best_score_math = transcript_score
                            elif transcript_score == best_score_math and transcript_score > 0:
                                # Tiebreaker: Ensure we pick the functionally longest physical protein string to aggressively protect against Ensembl API omitting MANE tags dynamically on pseudogenes
                                try:
                                    cl = int(t.get('amino_acid_length') or 0)
                                    bl = int(best_t_dict.get('amino_acid_length') or 0) if best_t_dict else 0
                                    if cl > bl:
                                        best_transcript_id = t_id
                                        best_t_dict = t
                                except: pass

                            # Try to extract the HGVS p. notation for any transcript
                            if t.get('hgvsp'):
                                if transcript_score > best_score_hgvsp:
                                    best_hgvsp = t.get('hgvsp')
                                    best_score_hgvsp = transcript_score
                                elif transcript_score == best_score_hgvsp:
                                    # keep the shortest/cleanest one or just the first matched
                                    if not best_hgvsp or len(t.get('hgvsp')) < len(best_hgvsp):
                                        best_hgvsp = t.get('hgvsp')
                                    
                            if t.get('nmd') == 'NMD_escaping_variant':
                                nmd_escape = True
                            
                        # ALWAYS check protein truncation math for frameshifts/nonsense on the WINNING transcript
                        if best_t_dict:
                            start_pos = best_t_dict.get('protein_start')
                            p_id = best_t_dict.get('protein_id')
                            
                            # Port VEP Exon values to match MyVariant namespace strictly for NMD Exon Mapping Logic
                            exon_str = best_t_dict.get('exon', '')
                            if not exon_str:
                                exon_str = best_t_dict.get('intron', '')
                                
                            if exon_str and '/' in exon_str:
                                try:
                                    parsed_data['snpeff_exon_rank'] = int(exon_str.split('/')[0])
                                    parsed_data['snpeff_exon_total'] = int(exon_str.split('/')[1])
                                except: pass
                                
                            # [NEW] Fallback: If winning transcript lacks exon rank, salvage from any available transcript
                            if not parsed_data.get('snpeff_exon_rank') or int(parsed_data.get('snpeff_exon_rank')) < 1:
                                for t in vep_data[0].get('transcript_consequences', []):
                                    fallback_exon = t.get('exon', '') or t.get('intron', '')
                                    if fallback_exon and '/' in fallback_exon:
                                        try:
                                            parsed_data['snpeff_exon_rank'] = int(fallback_exon.split('/')[0])
                                            parsed_data['snpeff_exon_total'] = int(fallback_exon.split('/')[1])
                                            break
                                        except: pass
                            
                            parsed_data['snpeff_cds_pos'] = best_t_dict.get('cds_start') or best_t_dict.get('cds_end')
                            parsed_data['snpeff_cdna_pos'] = best_t_dict.get('cdna_start') or best_t_dict.get('cdna_end')
                            parsed_data['ensembl_transcript_id'] = best_transcript_id
                        
                            if start_pos:
                                effective_start_pos = float(start_pos)
                                seq_len_val = 0
                                seq_response = None
                            
                                if p_id:
                                    try:
                                        seq_url = f"https://rest.ensembl.org/sequence/id/{p_id}"
                                        seq_response = http_session.get(seq_url, timeout=20)
                                        if seq_response.status_code == 200:
                                            seq_len_val = len(seq_response.json().get('seq', ''))
                                    except:
                                        pass
                                if not seq_len_val and best_transcript_id:
                                    try:
                                        lookup_url = f"https://rest.ensembl.org/lookup/id/{best_transcript_id}?expand=1"
                                        lookup_response = http_session.get(lookup_url, headers={'Content-Type': 'application/json'}, timeout=20)
                                        if lookup_response.status_code == 200:
                                            translation_data = lookup_response.json().get('Translation', {})
                                            if translation_data:
                                                seq_len_val = translation_data.get('length')
                                    except:
                                        pass
                            
                                if seq_len_val and int(seq_len_val) > 0:
                                    seq_len_val = int(seq_len_val)
                                    best_protein_start = int(effective_start_pos)
                                    best_protein_length = seq_len_val
                                    vep_msc = vep_data[0].get('most_severe_consequence', '') or ''
                                    if any(x in vep_msc for x in ('stop_gained', 'frameshift', 'start_lost')):
                                        nmd_escape_truncation_fraction = c_terminal_loss_fraction(
                                            int(effective_start_pos), seq_len_val,
                                        )
                                    else:
                                        nmd_escape_truncation_fraction = 0.0
                                    
                                    # Handle 5' Start Loss explicitly replacing NMD fraction
                                    if 'start_lost' in vep_data[0].get('most_severe_consequence', ''):
                                        if seq_response and seq_response.status_code == 200:
                                            full_seq = seq_response.json().get('seq', '')
                                            if full_seq:
                                                # Find the NEXT Methionine after the disrupted start codon position (start searching at index 1)
                                                next_m = full_seq.find('M', 1)
                                                if next_m != -1:
                                                    nmd_escape_truncation_fraction = next_m / float(best_protein_length)
                                                    next_m_aa_pos = next_m + 1
                                                    next_m_cds_pos = (next_m * 3) + 1
                                                    parsed_data['next_methionine_position'] = next_m_aa_pos
                                                    
                                                    # Try to map the next Met CDS position to its corresponding Exon
                                                    try:
                                                        map_url = f"https://rest.ensembl.org/map/cds/{best_transcript_id}/{next_m_cds_pos}..{next_m_cds_pos}"
                                                        r_map = http_session.get(map_url, timeout=20)
                                                        if r_map.status_code == 200:
                                                            coord = r_map.json()
                                                            if coord.get('mappings'):
                                                                gen_start = coord['mappings'][0]['start']
                                                                gen_end = coord['mappings'][0]['end']
                                                                
                                                                lookup_url = f"https://rest.ensembl.org/lookup/id/{best_transcript_id}?expand=1"
                                                                t_data = http_session.get(lookup_url, timeout=20).json()
                                                                exons = t_data.get('Exon', [])
                                                                
                                                                for idx, ex in enumerate(exons):
                                                                    if ex['start'] <= gen_start and ex['end'] >= gen_end:
                                                                        parsed_data['next_methionine_exon'] = idx + 1
                                                                        break
                                                    except Exception as e:
                                                        print(f"Error mapping next Met to Exon: {e}")
                                                else:
                                                    # If no downstream Met, 100% is lost
                                                    nmd_escape_truncation_fraction = 1.0
                                                    parsed_data['next_methionine_position'] = -1
                        vep_cons = ""
                        if best_t_dict and best_t_dict.get('consequence_terms'):
                            vep_cons = "_".join(best_t_dict.get('consequence_terms'))
                        else:
                            vep_cons = vep_data[0].get('most_severe_consequence', '')
                            
                        has_38_mapping = False
                        if valid_hit_found and hit.get('clinvar'):
                            clinvar_g = hit.get('clinvar', {}).get('hgvs', {}).get('genomic', [])
                            if isinstance(clinvar_g, str): clinvar_g = [clinvar_g]
                            has_38_mapping = any(g.startswith('NC_') and '.11:' in g for g in clinvar_g)
                        elif valid_hit_found and hit.get('vcf', {}).get('position'):
                            has_38_mapping = True
                        
                        csq_eval = parsed_data.get('consequence', '')
                        # Only bypass SpliceAI lookup if we specifically possess a known bad MyVariant mapping (i.e. we queried MyVariant but it's hg19). If MyVariant was completely empty mapping Ensembl direct, we assume hg38 canonical native.
                        is_splice_frameshift_override = True if ('dup' in csq_eval or 'del' in csq_eval or 'ins' in csq_eval or 'indel' in csq_eval or 'dup' in c_dot or 'del' in c_dot or 'ins' in c_dot or not has_38_mapping) else False
                        
                        # SpliceAI/Pangolin via VEP coordinates (SNVs and indels — not only indel override)
                        if not parsed_data.get('spliceai_fetched', False):
                            try:
                                root_vep = vep_data[0]
                                chrom = str(root_vep.get('seq_region_name', ''))
                                if not chrom.startswith('chr'): chrom = 'chr' + chrom
                            
                                start_pos = root_vep.get('start')
                                end_pos = root_vep.get('end')
                                alleles = root_vep.get('allele_string', '') # format: "C/T"
                                
                                mv_vcf = hit.get('vcf', {}) if valid_hit_found else {}
                                mv_ref = mv_vcf.get('ref')
                                mv_alt = mv_vcf.get('alt')
                                
                                if not alleles and mv_ref and mv_alt:
                                    # MyVariant VCF logic structurally directly mirrors the forward strand bounds perfectly.
                                    alleles = f"{mv_ref}/{mv_alt}"
                                
                                if chrom and start_pos and '/' in alleles:
                                    ref_a = alleles.split('/')[0]
                                    alt_a = alleles.split('/')[1]
                                    
                                    # VEP allele_string natively corresponds explicitly to the forward genomic strand unconditionally.
                                    parsed_data['grch38_chrom'] = chrom
                                    parsed_data['grch38_start'] = start_pos
                                    parsed_data['grch38_end'] = end_pos
                                    parsed_data['ref'] = ref_a
                                    parsed_data['alt'] = alt_a

                                    ref_a, alt_a, _flip_a = _normalize_to_forward_strand(http_session, chrom, start_pos, ref_a, alt_a, end_pos)
                                    parsed_data['ref'] = ref_a
                                    parsed_data['alt'] = alt_a
                                    spliceai_fmt = _spliceai_variant_locus_string(
                                        chrom,
                                        start_pos,
                                        ref_a,
                                        alt_a,
                                        vcf_string=root_vep.get('vcf_string') or parsed_data.get('vep_vcf_string'),
                                    )
                                    if not spliceai_fmt:
                                        spliceai_fmt = f'{chrom}-{start_pos}-{ref_a}-{alt_a}'
                                    _vcf_parts = (root_vep.get('vcf_string') or '').split('-')
                                    if len(_vcf_parts) >= 4 and _vcf_parts[1].isdigit():
                                        parsed_data['grch38_start'] = int(_vcf_parts[1])
                                        parsed_data['ref'] = _vcf_parts[2].upper()
                                        parsed_data['alt'] = _vcf_parts[3].upper()
                                    print(f"DEBUG: Pinging SpliceAI Broad API (VEP coords) -> {spliceai_fmt}")
                                    
                                    sai_url = f"https://spliceai-38-xwkwwwxdwq-uc.a.run.app/spliceai/?hg=38&variant={spliceai_fmt}"
                                    sai_resp = http_session.get(sai_url, timeout=30)
                                    if sai_resp.status_code == 200:
                                        sai_data = sai_resp.json()
                                        if sai_data and sai_data.get('error'):
                                            parsed_data['splice_api_error'] = "N/A (Variant Sequence Exceeds Broad Institute Pre-Computed Tensor Bounds)"
                                            print(f"SpliceAI Error Passed to UI: {sai_data['error']}")
                                        else:
                                            nm_for_pick = target_transcript if target_transcript and target_transcript.upper().startswith('NM_') else None
                                            _ingest_spliceai_broad_json(
                                                parsed_data, sai_data,
                                                gene_symbol=effective_gene,
                                                target_nm_base=nm_for_pick,
                                                enst_id=parsed_data.get('ensembl_transcript_id'),
                                            )
                            except Exception as e:
                                print(f"SpliceAI VEP Fallback Error: {e}")
                            
                            # Try to ping Pangolin Broad API via VEP Structural Coordinates only once per variant
                            if spliceai_fmt and not parsed_data.get('pangolin_fetched', False):
                                try:
                                    pan_url = f"https://pangolin-38-xwkwwwxdwq-uc.a.run.app/pangolin/?hg=38&variant={spliceai_fmt}"
                                    pan_resp = http_session.get(pan_url, timeout=30)
                                    if pan_resp.status_code == 200:
                                        parsed_data['pangolin_fetched'] = True
                                        pan_data = pan_resp.json()
                                        if pan_data and 'scores' in pan_data:
                                            scores_list = pan_data.get('scores', [])
                                            best_ds_sg = 0.0
                                            best_ds_sl = 0.0
                                            parsed_data['pangolin_dp_sg'] = ""
                                            parsed_data['pangolin_dp_sl'] = ""
                                            
                                            for s in scores_list:
                                                if isinstance(s, dict):
                                                    ds_sg = abs(float(s.get('DS_SG', 0.0)))
                                                    ds_sl = abs(float(s.get('DS_SL', 0.0)))
                                                    dp_sg = s.get('DP_SG', '')
                                                    dp_sl = s.get('DP_SL', '')
                                                    
                                                    if ds_sg > best_ds_sg: 
                                                        best_ds_sg, parsed_data['pangolin_dp_sg'] = ds_sg, dp_sg
                                                    if ds_sl > best_ds_sl: 
                                                        best_ds_sl, parsed_data['pangolin_dp_sl'] = ds_sl, dp_sl
                                                    
                                            parsed_data['pangolin_ds_sg'] = best_ds_sg
                                            parsed_data['pangolin_ds_sl'] = best_ds_sl
                                except Exception as e:
                                    print(f"Pangolin VEP Fallback Error: {e}")
                           
                        # Map VEP terms to our expected terms
                        _cj_vep = _canonical_splice_junction_from_hgvs(c_dot)
                        if _cj_vep:
                            consequence = (
                                'splice_donor_variant'
                                if _cj_vep['site'] == 'donor'
                                else 'splice_acceptor_variant'
                            )
                        elif 'stop_gained' in vep_cons:
                            consequence = 'nonsense'
                        elif 'frameshift' in vep_cons:
                            consequence = 'frameshift'
                        elif 'start_lost' in vep_cons:
                            consequence = 'start_lost'
                        elif 'missense' in vep_cons:
                            consequence = 'missense'
                        elif 'splice_donor' in vep_cons or 'splice_acceptor' in vep_cons:
                            consequence = vep_cons
                        elif 'splice_region' in vep_cons:
                            consequence = 'splice_region_variant'
                        elif 'stop_lost' in vep_cons:
                            consequence = 'stop_lost'
                        elif 'inframe' in vep_cons:
                            consequence = vep_cons
                        elif '3_prime_UTR' in vep_cons:
                            consequence = '3_prime_UTR_variant'
                        elif '5_prime_UTR' in vep_cons:
                            consequence = '5_prime_UTR_variant'
                        elif 'intron' in vep_cons:
                            consequence = 'intron_variant'
                        elif 'synonymous' in vep_cons:
                            consequence = 'synonymous_variant'
                        else:
                            consequence = vep_cons
                            
                        parsed_data['debug_vep'] = f"Success! Cons: {vep_cons}, Mapped: {consequence}"
            except Exception as e:
                import traceback
                parsed_data['debug_vep'] = f"Error: {e}, Trace: {traceback.format_exc()}"
                print(f"VEP Fallback Error: {e}")
            
            # If VEP fails or returns unknown, use the basic heuristic for structural hints
            if consequence == "unknown":
                p_lower = str(parsed_data.get('hgvs_p', '')).lower()
                _cj_fb = _canonical_splice_junction_from_hgvs(c_dot)
                _indel_span = _exonic_coding_indel_span_bp(c_dot)
                if _cj_fb:
                    consequence = (
                        'splice_donor_variant'
                        if _cj_fb['site'] == 'donor'
                        else 'splice_acceptor_variant'
                    )
                elif _indel_span and _is_exonic_coding_indel_c_dot(c_dot):
                    _n_bp, _kind = _indel_span
                    if _n_bp > 0 and _n_bp % 3 == 0:
                        consequence = (
                            'inframe_deletion' if _kind == 'del' else 'inframe_insertion'
                        )
                    elif _n_bp > 0:
                        consequence = 'frameshift'
                elif '+' in c_lower or re.search(r'c\.-?\d+\s*[\+\-]\s*\d+', c_lower):
                    splice_match = re.search(r'[\+\-]\s*([0-9]+)', c_lower)
                    if splice_match and int(splice_match.group(1)) <= 2:
                        if re.search(r'c\.-?\d+\s*\+', c_lower):
                            consequence = 'splice_donor_variant'
                        else:
                            consequence = 'splice_acceptor_variant'
                    else:
                        consequence = 'splice_region_variant'
                elif 'fs' in c_lower or 'frameshift' in c_lower or 'fs' in p_lower:
                    consequence = 'frameshift'
                elif '*' in c_lower or 'ter' in c_lower or 'nonsense' in c_lower or 'stop' in c_lower or '*' in p_lower or 'ter' in p_lower:
                    consequence = 'nonsense'
                elif '>' in c_lower:
                    consequence = 'missense'
                    
            parsed_data['consequence'] = consequence
            _apply_canonical_splice_hgvs_override(parsed_data)
            _apply_near_splice_region_context(parsed_data)
            if not parsed_data.get('clinvar_sig'):
                parsed_data['clinvar_sig'] = 'Not found in public databases'
            parsed_data['nmd_escape'] = nmd_escape
            if consequence in ('nonsense', 'frameshift', 'start_lost'):
                parsed_data['nmd_escape_truncation_fraction'] = nmd_escape_truncation_fraction
            else:
                parsed_data['nmd_escape_truncation_fraction'] = 0.0
            parsed_data['protein_start'] = best_protein_start
            parsed_data['protein_length'] = best_protein_length
            _vep_p = best_hgvsp.split(':')[1] if ':' in best_hgvsp else best_hgvsp
            if (_vep_p or "").strip() and not _hgvs_p_is_placeholder(_vep_p):
                parsed_data['hgvs_p'] = _vep_p
            elif _hgvs_p_is_placeholder(parsed_data.get('hgvs_p')) and (_vep_p or "").strip():
                parsed_data['hgvs_p'] = _vep_p
            # Only store real ENST ids here — NM_ placeholders break Ensembl lookup/id.
            _bt = (best_transcript_id or "").strip()
            if _bt.startswith("ENST"):
                parsed_data['ensembl_transcript_id'] = _bt.split(".")[0]
            elif target_transcript and str(target_transcript).startswith("ENST"):
                parsed_data['ensembl_transcript_id'] = str(target_transcript).split(".")[0]
            elif target_transcript and str(target_transcript).upper().startswith("NM_"):
                # Keep RefSeq for later NM→ENST xref; do not pretend it is ENST.
                parsed_data.setdefault("transcript", str(target_transcript).strip())
                parsed_data.setdefault("refseq_transcript_id", str(target_transcript).strip())
        # Global Override: Force "start_lost" if variant is on coding coordinates 1, 2, or 3, overriding API UTR/splice bugs
        c_lower = c_dot.lower()
        num_match = re.search(r'c\.([0-9]+)', c_lower)
        if num_match and 1 <= int(num_match.group(1)) <= 3 and '+' not in c_lower and '-' not in c_lower:
            parsed_data['consequence'] = 'start_lost'

        _apply_canonical_splice_hgvs_override(parsed_data)
        _apply_near_splice_region_context(parsed_data)
        _apply_exonic_coding_indel_consequence_heuristic(parsed_data)
        _promote_exonic_coding_indel_frameshift_primary(parsed_data)

        # Preload clinical numbering from upstream APIs before structural mappings overwrite it
        orig_clinical_rank = parsed_data.get('snpeff_exon_rank')
        orig_clinical_total = parsed_data.get('snpeff_exon_total')

        # Evaluate Structural NMD Escape
        if parsed_data.get('consequence') in ['nonsense', 'frameshift']:
            # Intercept Frameshift PTC Offset if present (e.g., Ter13 -> +13 AA distance downstream)
            # Formally calculate the New Stop Codon boundary to measure exact NMD junction distance
            p_current = parsed_data.get('protein_start', 0)
            try: p_current = int(p_current)
            except: p_current = 0
            
            # Never coerce missing length to 1 — that invents giant fake 3′ extensions
            # (NOTCH1 c.1651_1654dup → plen=1 → fraction −570).
            try:
                p_len = int(parsed_data.get('protein_length') or 0)
            except (TypeError, ValueError):
                p_len = 0
            if p_len < 0:
                p_len = 0

            # Prefer HGVS first affected residue (e.g. p.Q1756Pfs*74 -> 1756); snpeff can sit on the codon start (off-by-one vs HGVS).
            hgvsp_raw = parsed_data.get('hgvs_p', '') or ''
            if parsed_data.get('consequence') == 'frameshift':
                # Three-letter (p.Gln1756) or one-letter (p.Q1756) — snpeff position can disagree with HGVS by 1.
                m_first_aa = re.search(
                    r'p\.(?:([A-Z][a-z]{2})(\d+)|([A-Z*])(\d+))',
                    hgvsp_raw,
                )
                if m_first_aa:
                    try:
                        pos_g = m_first_aa.group(2) or m_first_aa.group(4)
                        if pos_g:
                            p_current = int(pos_g)
                    except Exception:
                        pass
            
            physical_stop_pos = -1
            ter_offset = 0
            if parsed_data.get('consequence') == 'frameshift' and hgvsp_raw:
                fs_match = re.search(r'fs(?:Ter|\*)([0-9]+)', hgvsp_raw, re.I)
                if fs_match:
                    try:
                        ter_offset = int(fs_match.group(1))
                        if ter_offset > 0:
                            if p_current > 0:
                                # Novel termination: first affected AA + fsTer N
                                # (e.g. Q1756fsTer74 → stop at 1830). Do NOT cap at WT
                                # length — stops past the native terminus are 3′ extensions
                                # (e.g. DOCK4 p.Q1974Vfs*19 on a 1975-aa protein).
                                physical_stop_pos = p_current + ter_offset
                            else:
                                c_match = re.search(r'c\.([0-9]+)', parsed_data.get('c_dot', '').lower())
                                if c_match:
                                    approx_aa = max(1, int(c_match.group(1)) // 3)
                                    physical_stop_pos = approx_aa + ter_offset
                    except Exception:
                        pass
            
            curr_stop_eval = physical_stop_pos if physical_stop_pos > 0 else p_current
            
            t_frac = c_terminal_loss_fraction(curr_stop_eval, p_len) if curr_stop_eval > 0 else 0.0
            if physical_stop_pos > 0 and p_current > 0:
                formalize_frameshift_ptc(parsed_data, p_current, physical_stop_pos, p_len)
                t_frac = float(parsed_data.get('nmd_escape_truncation_fraction') or t_frac)

            # Perform Structural NMD Exon Boundary Math (50–55 nt / last-exon rule).
            # Do NOT infer NMD escape from truncation % alone — small C-terminal loss
            # (e.g. OPA1 p.Val958Glyfs*3 at ~5.6%) can still undergo NMD when the PTC is
            # >50 nt upstream of the final exon-exon junction.
            cds_pos = parsed_data.get('snpeff_cds_pos', 0)
            try:
                cds_pos = int(cds_pos or 0)
            except (TypeError, ValueError):
                cds_pos = 0
            if cds_pos <= 0:
                # Nonsense/frameshift: fall back to c. CDS index when SnpEff omitted it.
                _cm = re.search(r'c\.([0-9]+)', str(parsed_data.get('c_dot') or c_dot or ''), re.I)
                if _cm:
                    try:
                        cds_pos = int(_cm.group(1))
                        parsed_data['snpeff_cds_pos'] = cds_pos
                    except (TypeError, ValueError):
                        pass

            # Preload variant_exon with the default API response
            parsed_data['variant_exon'] = orig_clinical_rank

            # Translate Protein-Level Stop Codon into DNA-Level Junction Math
            nmd_calc_cds_pos = cds_pos  # Default to the mutation start
            if physical_stop_pos > 0 and p_current > 0:
                # DNA boundary distance is simply (stop - start) * 3 base pairs
                ptc_nt_shift = (physical_stop_pos - p_current) * 3
                nmd_calc_cds_pos += ptc_nt_shift

            enst_id = _resolve_ensembl_transcript_id(http_session, parsed_data)
            if not enst_id and nmd_calc_cds_pos > 0:
                parsed_data['nmd_math_error'] = (
                    "Cannot perform structural NMD Mathematical bounding without a valid "
                    "Ensembl Transcript ID (ENST). Ensembl API mapping servers may be down."
                )

            # Prefer Ensembl exon map when ENST resolves; otherwise use any existing
            # coding_exons (e.g. RefSeq GFF) so last-exon PTC math still runs.
            if enst_id and nmd_calc_cds_pos > 0:
                try:
                    exon_url = f"https://rest.ensembl.org/lookup/id/{enst_id}?expand=1"
                    exon_resp = http_session.get(exon_url, timeout=120)
                    if exon_resp.status_code == 200:
                        exon_data = exon_resp.json()
                        exons = exon_data.get('Exon', [])
                        strand = exon_data.get('strand', 1)
                        trans = exon_data.get('Translation', {})

                        true_protein_length = trans.get('length', 0)
                        if true_protein_length > 0:
                            parsed_data['protein_length'] = true_protein_length

                        cds_genomic_start = trans.get('start')
                        cds_genomic_end = trans.get('end')

                        coding_exons = []
                        if cds_genomic_start and cds_genomic_end:
                            parsed_data['cds_genomic_start'] = cds_genomic_start
                            parsed_data['cds_genomic_end'] = cds_genomic_end
                            exons.sort(key=lambda x: x['start'] if strand == 1 else -x['start'])
                            cds_cursor = 0
                            for e_idx, e in enumerate(exons):
                                e_start = e['start']
                                e_end = e['end']
                                overlap_start = max(e_start, cds_genomic_start)
                                overlap_end = min(e_end, cds_genomic_end)
                                is_coding = overlap_start <= overlap_end
                                if is_coding:
                                    coding_len = overlap_end - overlap_start + 1
                                    start_cds = cds_cursor + 1
                                    cds_cursor += coding_len
                                    end_cds = cds_cursor
                                    coding_exons.append({
                                        'start_cds': start_cds,
                                        'end_cds': end_cds,
                                        'anatomical_rank': e_idx + 1,
                                        'length_bp': coding_len,
                                        'chr': exon_data.get('seq_region_name'),
                                        'start': e_start,
                                        'end': e_end
                                    })
                        parsed_data['coding_exons'] = coding_exons
                        parsed_data['coding_exons_source'] = 'ensembl'
                        _stash_transcript_mrna_exon_metadata(
                            parsed_data, exons, coding_exons,
                            cds_genomic_start=cds_genomic_start, cds_genomic_end=cds_genomic_end,
                        )

                        if coding_exons:
                            # Pass 1: Resolve the exact Native Mutation Origin for UI 'Exon X/Y'
                            if cds_pos and cds_pos > 0:
                                for cx in coding_exons:
                                    if cx['start_cds'] <= cds_pos <= cx['end_cds']:
                                        parsed_data['variant_exon'] = cx['anatomical_rank']
                                        break
                            apply_nmd_escape_from_coding_exons(parsed_data, nmd_calc_cds_pos)
                    else:
                        parsed_data['nmd_math_error'] = "Ensembl Exon Sequence Timeout/Error (Fetch Failed)"
                except Exception as e:
                    import traceback
                    parsed_data['nmd_math_error'] = f"Ensembl Exon Sequence Timeout/Error (Fetch Failed): {e} - Trace: {traceback.format_exc()}"
                    print(f"NMD Math Error: {e}")
                    print(f"NMD Exon Math Error: {e}")

            if (
                nmd_calc_cds_pos > 0
                and not parsed_data.get('nmd_decision_basis')
                and (parsed_data.get('coding_exons') or [])
            ):
                apply_nmd_escape_from_coding_exons(parsed_data, nmd_calc_cds_pos)

            # Ensembl may have updated protein length; recompute novel stop from fsTer
            # without clamping — stops past WT length are 3′ ORF extensions.
            try:
                p_len_final = int(parsed_data.get('protein_length') or 0) or int(p_len or 0)
            except (TypeError, ValueError):
                p_len_final = 0
            if parsed_data.get('consequence') == 'frameshift' and ter_offset > 0 and p_current > 0:
                physical_stop_pos = p_current + ter_offset
                curr_stop_eval = physical_stop_pos

            # Formalize Stop Codon metrics after all NMD heuristics and math calculations resolve
            if parsed_data.get('consequence') == 'frameshift':
                fs_stop = physical_stop_pos if physical_stop_pos > 0 else curr_stop_eval
                if p_len_final > 0:
                    formalize_frameshift_ptc(
                        parsed_data, p_current, fs_stop, p_len_final,
                    )
                elif p_current > 0 and fs_stop > 0:
                    # Still record onset/stop for UniProt / UI even without WT length %.
                    parsed_data["protein_start"] = p_current
                    parsed_data["novel_stop_aa"] = fs_stop
                    parsed_data["downstream_aas"] = max(0, int(fs_stop) - int(p_current))
                    # Clear any prior bogus extension % from a failed length coerce.
                    try:
                        if float(parsed_data.get("nmd_escape_truncation_fraction") or 0) < 0:
                            parsed_data["nmd_escape_truncation_fraction"] = 0.0
                    except (TypeError, ValueError):
                        parsed_data["nmd_escape_truncation_fraction"] = 0.0
            elif parsed_data.get('consequence') == 'nonsense':
                stop_aa = p_current or parse_nonsense_stop_aa_from_hgvs(hgvsp_raw)
                if stop_aa <= 0:
                    stop_aa = parse_nonsense_stop_aa_from_hgvs(parsed_data.get('hgvs_p') or '')
                if p_len_final > 0 and stop_aa > 0:
                    formalize_nonsense_ptc(parsed_data, stop_aa, p_len_final)
                elif stop_aa > 0:
                    # Record PTC onset even without WT length (fraction filled later).
                    parsed_data['protein_start'] = stop_aa
                    parsed_data['novel_stop_aa'] = stop_aa

        # [Start Loss block structurally relocated below Splicing block]

        # SpliceAI source-of-truth policy:
        #   1) Always try Broad first — its Δbp convention is the published
        #      standard (DP = site - variant, signed). Some LIMS dumps mix
        #      site-anchored vs variant-anchored Δbp (e.g. shows acceptor
        #      loss as "-8 bp" instead of "+7 bp"), which mis-leads readers.
        #   2) Stage provided DS so they survive if Broad fails to return DPs;
        #      fallback fills missing fields from provided scores when
        #      Broad couldn't be reached at all.
        emg_sai = data.get('emg_spliceai')
        if emg_sai:
            emg_ds_snap = _emg_spliceai_ds_snapshot(emg_sai)
            if emg_ds_snap:
                parsed_data['spliceai_emg_ds_snapshot'] = emg_ds_snap
                _apply_emg_spliceai_ds_only(parsed_data, emg_sai)
                print("DEBUG: SpliceAI DS staged from EMG paste — querying Broad for authoritative Δbp")
        if not parsed_data.get('spliceai_fetched', False):
            try:
                import re
                spliceai_fmt = None
                vep_anchored = False
                if target_transcript and target_transcript.startswith('NM_'):
                    vep_anchored = _reconcile_grch38_coords_via_vep_hgvs(
                        parsed_data, http_session, target_transcript, c_dot, effective_gene,
                    )
                if vep_anchored and parsed_data.get('grch38_chrom') and parsed_data.get('grch38_start'):
                    chrom = parsed_data['grch38_chrom']
                    pos = parsed_data['grch38_start']
                    ref = parsed_data.get('ref') or ''
                    alt = parsed_data.get('alt') or ''
                    ref, alt, _flip_v = _normalize_to_forward_strand(
                        http_session, chrom, pos, ref, alt, parsed_data.get('grch38_end'),
                    )
                    parsed_data['ref'] = ref
                    parsed_data['alt'] = alt
                    spliceai_fmt = _spliceai_variant_locus_string(
                        chrom, pos, ref, alt, vcf_string=parsed_data.get('vep_vcf_string')
                    )
                    if not spliceai_fmt:
                        spliceai_fmt = f'{chrom}-{pos}-{ref}-{alt}'
                    print(f"DEBUG: Pinging SpliceAI+Pangolin Broad API (VEP HGVS anchor) -> {spliceai_fmt}")
                    sai_resp, pan_resp = _fetch_broad_spliceai_and_pangolin(
                        http_session, spliceai_fmt, timeout=30
                    )
                    if sai_resp is not None and sai_resp.status_code == 200:
                        sai_data = sai_resp.json()
                        if sai_data and sai_data.get('error'):
                            parsed_data['splice_api_error'] = "N/A (Variant Sequence Exceeds Broad Institute Pre-Computed Tensor Bounds)"
                            print(f"SpliceAI Error Passed to UI: {sai_data['error']}")
                        else:
                            nm_for_pick = target_transcript if target_transcript and target_transcript.upper().startswith('NM_') else None
                            _ingest_spliceai_broad_json(
                                parsed_data, sai_data,
                                gene_symbol=effective_gene,
                                target_nm_base=nm_for_pick,
                                enst_id=parsed_data.get('ensembl_transcript_id'),
                            )
                    _ingest_pangolin_broad_response(parsed_data, pan_resp)
                else:
                    clinvar_data = hit.get('clinvar', {})
                    genomics = clinvar_data.get('hgvs', {}).get('genomic', [])
                    if isinstance(genomics, str): genomics = [genomics]
                    
                    grch38_coord = None
                    for g in genomics:
                        gl = g or ''
                        if gl.startswith('NC_') and ('.11:' in gl or '.12:' in gl) and 'g.' in gl.lower():
                            grch38_coord = g
                            break
                            
                    if grch38_coord:
                        m = re.match(r'NC_0000(\d{2})\.(11|12):gi?\.(\d+)([A-Z]+)>([A-Z]+)', grch38_coord, re.I)
                        if m:
                            chrom_num = int(m.group(1))
                            chrom = f'chr{chrom_num}' if chrom_num <= 22 else ('chrX' if chrom_num == 23 else 'chrY')
                            pos = m.group(3)
                            ref = m.group(4)
                            alt = m.group(5)
                            
                        # Native Local ClinVar Integration (Thread-Local Scope)
                            try:
                                vcf_chrom = chrom.replace('chr', '') # NCBI VCFs use raw numbers '1', '2', 'X' instead of 'chr1'
                                if _clinvar_vcf() is not None:
                                    for rec in _clinvar_vcf().fetch(vcf_chrom, int(pos) - 1, int(pos)):
                                        if rec.ref == ref and alt in [str(a) for a in rec.alts]:
                                                if 'CLNSIG' in rec.info:
                                                    sig = rec.info.get('CLNSIG', [''])[0]
                                                    parsed_data['clinvar_sig'] = sig.replace(',_', ', ').replace('_', ' ')
                                                
                                                if rec.id:
                                                    parsed_data['clinvar_rcv'] = str(rec.id)
                                                
                                                # Default search link generation
                                                parsed_data['clinvar_search_link'] = f"https://www.ncbi.nlm.nih.gov/clinvar/?term={gene}[gene]+AND+{c_dot}"
                            except Exception as e:
                                print(f"Local ClinVar pysam Error: {e}")
                        # HTML Scraper Decoupled. Placed after SpliceAI.
                            ref, alt, _flip_b = _normalize_to_forward_strand(http_session, chrom, pos, ref, alt, pos)
                            spliceai_fmt = _spliceai_variant_locus_string(
                                chrom, pos, ref, alt, vcf_string=parsed_data.get('vep_vcf_string')
                            )
                            if not spliceai_fmt:
                                spliceai_fmt = f'{chrom}-{pos}-{ref}-{alt}'
                            parsed_data['grch38_chrom'] = chrom
                            parsed_data['grch38_start'] = pos
                            parsed_data['grch38_end'] = pos
                            parsed_data['ref'] = ref
                            parsed_data['alt'] = alt
                            print(f"DEBUG: Pinging SpliceAI+Pangolin Broad API -> {spliceai_fmt}")
                            sai_resp, pan_resp = _fetch_broad_spliceai_and_pangolin(
                                http_session, spliceai_fmt, timeout=30
                            )
                            if sai_resp is not None and sai_resp.status_code == 200:
                                sai_data = sai_resp.json()
                                if sai_data and sai_data.get('error'):
                                    parsed_data['splice_api_error'] = "N/A (Variant Sequence Exceeds Broad Institute Pre-Computed Tensor Bounds)"
                                    print(f"SpliceAI Error Passed to UI: {sai_data['error']}")
                                else:
                                    nm_for_pick = target_transcript if target_transcript and target_transcript.upper().startswith('NM_') else None
                                    _ingest_spliceai_broad_json(
                                        parsed_data, sai_data,
                                        gene_symbol=effective_gene,
                                        target_nm_base=nm_for_pick,
                                        enst_id=parsed_data.get('ensembl_transcript_id'),
                                    )
                            _ingest_pangolin_broad_response(parsed_data, pan_resp)
            except Exception as e:
                print(f"SpliceAI Broad API Error: {e}")

        # Last resort: Ensembl VEP HGVS → chr-pos-ref-alt → Broad SpliceAI (covers SNVs when ClinVar genomic missing / regex failed)
        if not parsed_data.get('spliceai_fetched', False):
            try:
                import urllib.parse
                hgvs_q = _vep_hgvs_query(target_transcript, c_dot, effective_gene) or f"{effective_gene}:{c_dot}"
                vep_fb = f"https://rest.ensembl.org/vep/human/hgvs/{urllib.parse.quote(hgvs_q, safe='')}?canonical=1&vcf_string=1"
                vresp = http_session.get(vep_fb, timeout=120)
                if vresp.status_code == 200 and vresp.json():
                    vd0 = vresp.json()[0]
                    fb_chrom = str(vd0.get('seq_region_name', ''))
                    if fb_chrom and not fb_chrom.startswith('chr'):
                        fb_chrom = 'chr' + fb_chrom
                    sp = vd0.get('start')
                    ale = vd0.get('allele_string', '')
                    if fb_chrom and sp and ale and '/' in ale:
                        ra, aa = ale.split('/')[:2]
                        ra, aa, _flip_c = _normalize_to_forward_strand(http_session, fb_chrom, sp, ra, aa, vd0.get('end', sp))
                        parsed_data['vep_vcf_string'] = vd0.get('vcf_string') or parsed_data.get('vep_vcf_string')
                        spliceai_fmt = _spliceai_variant_locus_string(
                            fb_chrom, sp, ra, aa, vcf_string=vd0.get('vcf_string')
                        )
                        if not spliceai_fmt:
                            spliceai_fmt = f'{fb_chrom}-{sp}-{ra}-{aa}'
                        print(f"DEBUG: SpliceAI+Pangolin Broad API (VEP HGVS fallback) -> {spliceai_fmt}")
                        parsed_data['grch38_chrom'] = fb_chrom
                        parsed_data['grch38_start'] = sp
                        parsed_data['grch38_end'] = vd0.get('end', sp)
                        parsed_data['ref'] = ra
                        parsed_data['alt'] = aa
                        sai_resp, pan_resp = _fetch_broad_spliceai_and_pangolin(
                            http_session, spliceai_fmt, timeout=30
                        )
                        if sai_resp is not None and sai_resp.status_code == 200:
                            sai_data = sai_resp.json()
                            nm_for_pick = target_transcript if target_transcript and target_transcript.upper().startswith('NM_') else None
                            _ingest_spliceai_broad_json(
                                parsed_data, sai_data,
                                gene_symbol=effective_gene,
                                target_nm_base=nm_for_pick,
                                enst_id=parsed_data.get('ensembl_transcript_id'),
                            )
                        _ingest_pangolin_broad_response(parsed_data, pan_resp)
            except Exception as e:
                print(f"SpliceAI VEP HGVS fallback error: {e}")

        if emg_sai:
            _apply_emg_spliceai_if_broad_unavailable(parsed_data, emg_sai)
        _refresh_spliceai_in_silico_source(parsed_data)

        # Pangolin fallback if the parallel Broad pair above did not run / failed.
        pangolin_fmt = spliceai_fmt
        if not pangolin_fmt and target_transcript and str(target_transcript).upper().startswith(("NM_", "NR_")):
            _reconcile_grch38_coords_via_vep_hgvs(
                parsed_data, http_session, target_transcript, c_dot, effective_gene,
            )
            if parsed_data.get('grch38_chrom') and parsed_data.get('grch38_start'):
                _chrom = parsed_data['grch38_chrom']
                _pos = parsed_data['grch38_start']
                _ref = parsed_data.get('ref') or ''
                _alt = parsed_data.get('alt') or ''
                pangolin_fmt = _spliceai_variant_locus_string(
                    _chrom, _pos, _ref, _alt, vcf_string=parsed_data.get('vep_vcf_string'),
                )
                if not pangolin_fmt:
                    pangolin_fmt = f'{_chrom}-{_pos}-{_ref}-{_alt}'
        if not parsed_data.get('pangolin_fetched', False) and pangolin_fmt:
            try:
                pan_url = f"https://pangolin-38-xwkwwwxdwq-uc.a.run.app/pangolin/?hg=38&variant={pangolin_fmt}"
                pan_resp = http_session.get(pan_url, timeout=30)
                _ingest_pangolin_broad_response(parsed_data, pan_resp)
            except Exception as e:
                print(f"Pangolin Broad API Error: {e}")

        _set_spliceai_narrative_sentence(parsed_data)

        # Sequence-level "what if the new splice site is used?" math for non-splice
        # consequences (missense / synonymous SNVs that create a brand-new GT or AG
        # inside their exon). The splice-anchored resolver further down only fires for
        # splice_donor / splice_acceptor / splice_region consequences, so without this
        # call a high SpliceAI donor- or acceptor-gain on a missense like
        # TSC2 c.3881C>T (p.A1294V) would have no protein-level prediction in the UI.
        try:
            _ensure_coding_exons_for_splice_viz(parsed_data)
            _reconcile_variant_exon_mrna_numbering(parsed_data)
            _resolve_exon_internal_cryptic_outcome(http_session, parsed_data)
        except Exception as _eic_err:
            print(f"[exon-internal cryptic] resolver failure: {_eic_err}")

        # Protein-level summary for plain coding in-frame indels (not splice-driven).
        # Surfaces protein-length delta, deleted-residue identity + biochemical
        # class, and an explicit "no PTC / NMD does not apply" verdict so a variant
        # like UBR5 c.3622_3624del (p.Cys1208del) gets a parallel pill to the
        # splice-driven cryptic outcome instead of falling through silently.
        try:
            _build_coding_inframe_indel_outcome(parsed_data)
        except Exception as _ifc_err:
            print(f"[inframe coding indel] resolver failure: {_ifc_err}")

        # Evaluate Structural Splicing Frame Impact
        current_cons_splice = parsed_data.get('consequence', '')
        _intron_splice_hgvs = bool(re.search(r'c\.(-?\d+)([\+\-])(\d+)', c_dot or '', re.I))
        _splice_structural_ctx = (
            'splice_acceptor' in current_cons_splice
            or 'splice_donor' in current_cons_splice
            or 'splice_region' in current_cons_splice
            or _consequence_is_acceptor_splice(current_cons_splice, c_dot)
            or _consequence_is_donor_splice(current_cons_splice, c_dot)
            or ('intron' in current_cons_splice and _intron_splice_hgvs)
        )
        if _splice_structural_ctx:
            enst_id = parsed_data.get('ensembl_transcript_id')
            cds_pos = parsed_data.get('snpeff_cds_pos')
            if cds_pos is None: cds_pos = 0
            snpeff_rank = parsed_data.get('snpeff_exon_rank')
            if snpeff_rank is None: snpeff_rank = 0
            
            # cDNA anchor: for c.1387-4 use 1387 (3' exon), not the first run of digits in a range; prefer HGVS over SnpEff
            import re
            try:
                c_dot_str = c_dot
                from_sn = parsed_data.get('snpeff_cds_pos')
                try:
                    from_sn = int(from_sn) if from_sn is not None else 0
                except (TypeError, ValueError):
                    from_sn = 0
                anc = _splice_cdna_anchor_from_hgvs(c_dot_str, current_cons_splice)
                if anc:
                    cds_pos = anc
                elif from_sn:
                    cds_pos = from_sn
                else:
                    num_match = re.search(r'c\.(-?\d+)', c_dot_str)
                    if num_match:
                        cds_pos = int(num_match.group(1))
            except Exception:
                pass
            
            if not enst_id and (cds_pos != 0 or int(snpeff_rank) > 0):
                parsed_data['splice_math_error'] = "Cannot perform structural Splice Mathematical bounding without a valid Ensembl Transcript ID (ENST). Ensembl API mapping servers may be down."

            if enst_id and (cds_pos != 0 or int(snpeff_rank) > 0):
                try:
                    clean_enst = enst_id.split('.')[0]
                    if not clean_enst.startswith('ENST'):
                        try:
                            xref_url = f"https://rest.ensembl.org/xrefs/symbol/homo_sapiens/{clean_enst}"
                            xref_resp = http_session.get(xref_url, timeout=20)
                            if xref_resp.status_code == 200:
                                for item in xref_resp.json():
                                    if item.get('type') == 'transcript' and str(item.get('id')).startswith('ENST'):
                                        clean_enst = item.get('id')
                                        enst_id = clean_enst
                                        break
                        except: pass
                        
                    coding_exons = parsed_data.get('coding_exons')
                    if not coding_exons:
                        exon_url = f"https://rest.ensembl.org/lookup/id/{clean_enst}?expand=1"
                        print(f"DEBUG: Requesting Ensembl Exons -> {exon_url}")
                        exon_resp = http_session.get(exon_url, timeout=120)
                        print(f"DEBUG: Ensembl Exons Response -> {exon_resp.status_code}")
                        if exon_resp.status_code == 200:
                            exon_data = exon_resp.json()
                            exons = exon_data.get('Exon', [])
                            strand = exon_data.get('strand', 1)
                            parsed_data['transcript_strand'] = strand
                            parsed_data['transcript_chrom'] = exon_data.get('seq_region_name')
                            trans = exon_data.get('Translation', {})
                            true_protein_length = trans.get('length', 0)
                            if true_protein_length > 0:
                                parsed_data['protein_length'] = true_protein_length
                            cds_genomic_start = trans.get('start')
                            cds_genomic_end = trans.get('end')
                            coding_exons = []
                            if cds_genomic_start and cds_genomic_end:
                                parsed_data['cds_genomic_start'] = cds_genomic_start
                                parsed_data['cds_genomic_end'] = cds_genomic_end
                                exons.sort(key=lambda x: x['start'] if strand == 1 else -x['start'])
                                cds_cursor = 0
                                for e_idx, e in enumerate(exons):
                                    e_start = e['start']
                                    e_end = e['end']
                                    overlap_start = max(e_start, cds_genomic_start)
                                    overlap_end = min(e_end, cds_genomic_end)
                                    is_coding = overlap_start <= overlap_end
                                    if is_coding:
                                        coding_len = overlap_end - overlap_start + 1
                                        start_cds = cds_cursor + 1
                                        cds_cursor += coding_len
                                        end_cds = cds_cursor
                                        coding_exons.append({
                                            'start_cds': start_cds,
                                            'end_cds': end_cds,
                                            'anatomical_rank': e_idx + 1,
                                            'length_bp': coding_len,
                                            'chr': exon_data.get('seq_region_name'),
                                            'start': e_start,
                                            'end': e_end
                                        })
                            parsed_data['coding_exons'] = coding_exons
                            _stash_transcript_mrna_exon_metadata(
                                parsed_data, exons, coding_exons,
                                cds_genomic_start=cds_genomic_start, cds_genomic_end=cds_genomic_end,
                            )
                    
                    if coding_exons and not _defer_whole_exon_skip_to_deep_intronic(current_cons_splice, c_dot):
                        # RefSeq/VEP c.N (+/- intronic offets): acceptor c.N-k anchors the *downstream* exon at N; pick
                        # the best 3' coding exon, not the first in-list hit (fixes TRAF7 c.1387-4T>G → exon 16, not 15).
                        target_cx = _select_splice_coding_exon(
                            current_cons_splice, cds_pos, coding_exons, c_dot
                        ) if cds_pos else None
                        for cx in ([target_cx] if target_cx else []):
                                parsed_data['variant_exon'] = cx['anatomical_rank']
                                parsed_data['nmd_exon_total'] = _mrna_exon_total(parsed_data, coding_exons)
                                
                                try:
                                    if orig_clinical_total and orig_clinical_rank:
                                        orig_t = int(orig_clinical_total)
                                        orig_r = int(orig_clinical_rank)
                                        # Apply fallback only if we haven't captured exon info yet
                                        if parsed_data.get('variant_exon') is None:
                                            total_coding = len(coding_exons)
                                            parsed_data['variant_exon'] = orig_r
                                            parsed_data['nmd_exon_total'] = max(
                                                orig_t, _mrna_exon_total(parsed_data, coding_exons)
                                            )
                                except Exception as e:
                                    pass
                                
                                bp_len = cx['length_bp']
                                is_in_frame = (bp_len % 3 == 0)
                                aa_lost = bp_len // 3
                                fraction_lost = 0.0
                                _ensure_protein_length_from_coding_exons(parsed_data)
                                try:
                                    p_len = int(parsed_data.get('protein_length') or 0)
                                except (TypeError, ValueError):
                                    p_len = 0
                                if p_len > 0:
                                    fraction_lost = aa_lost / float(p_len)
                                
                                parsed_data['splice_target_start_cds'] = cx['start_cds']
                                parsed_data['splice_target_end_cds'] = cx['end_cds']
                                
                                frame_str = "In-Frame Skip" if is_in_frame else "Out-of-Frame Shift"
                                pct_str = f"{fraction_lost*100:.1f}%"
                                
                                if is_in_frame:
                                    for _k in (
                                        'exon_skip_oof_fs_ter',
                                        'exon_skip_oof_ptc_exon_rank',
                                        'exon_skip_oof_ptc_aa',
                                    ):
                                        parsed_data.pop(_k, None)
                                
                                ptc_exon_str = ""
                                cds_seq = ''
                                try:
                                    cds_seq = _ensure_cds_seq(parsed_data, http_session) or ''
                                    if not cds_seq:
                                        clean_seq_enst = enst_id.split('.')[0]
                                        seq_url = f"https://rest.ensembl.org/sequence/id/{clean_seq_enst}?type=cds"
                                        seq_resp = http_session.get(seq_url, timeout=120)
                                        if seq_resp.status_code == 200:
                                            cds_seq = seq_resp.json().get('seq', '') or ''
                                            if cds_seq:
                                                parsed_data['cds_seq'] = cds_seq
                                        else:
                                            print(f"DEBUG Ensembl CDS Fetch Failed: {seq_resp.status_code}")
                                    if cds_seq:
                                        target_start = cx['start_cds']
                                        target_end = cx['end_cds']
                                    
                                        mutated_cds = cds_seq[:target_start-1] + cds_seq[target_end:]
                                    
                                        CODON_TABLE = {
                                            'ATA':'I', 'ATC':'I', 'ATT':'I', 'ATG':'M', 'ACA':'T', 'ACC':'T', 'ACG':'T', 'ACT':'T',
                                            'AAC':'N', 'AAT':'N', 'AAA':'K', 'AAG':'K', 'AGC':'S', 'AGT':'S', 'AGA':'R', 'AGG':'R',
                                            'CTA':'L', 'CTC':'L', 'CTG':'L', 'CTT':'L', 'CCA':'P', 'CCC':'P', 'CCG':'P', 'CCT':'P',
                                            'CAC':'H', 'CAT':'H', 'CAA':'Q', 'CAG':'Q', 'CGA':'R', 'CGC':'R', 'CGG':'R', 'CGT':'R',
                                            'GTA':'V', 'GTC':'V', 'GTG':'V', 'GTT':'V', 'GCA':'A', 'GCC':'A', 'GCG':'A', 'GCT':'A',
                                            'GAC':'D', 'GAT':'D', 'GAA':'E', 'GAG':'E', 'GGA':'G', 'GGC':'G', 'GGG':'G', 'GGT':'G',
                                            'TCA':'S', 'TCC':'S', 'TCG':'S', 'TCT':'S', 'TTC':'F', 'TTT':'F', 'TTA':'L', 'TTG':'L',
                                            'TAC':'Y', 'TAT':'Y', 'TAA':'*', 'TAG':'*', 'TGC':'C', 'TGT':'C', 'TGA':'*', 'TGG':'W',
                                        }
                                    
                                        if is_in_frame:
                                            # Check where the native stop codon lives
                                            native_stop_bp_check = 0
                                            for i in range(0, len(cds_seq), 3):
                                                codon = cds_seq[i:i+3]
                                                if len(codon) == 3:
                                                    aa = CODON_TABLE.get(codon, 'X')
                                                    if aa == '*':
                                                        native_stop_bp_check = i + 3
                                                        break
                                                
                                            stop_codon_bp = 0
                                            for i in range(0, len(mutated_cds), 3):
                                                codon = mutated_cds[i:i+3]
                                                if len(codon) == 3:
                                                    aa = CODON_TABLE.get(codon, 'X')
                                                    if aa == '*':
                                                        stop_codon_bp = i + 3
                                                        break
                                                
                                            is_premature_stop = stop_codon_bp > 0
                                            if is_premature_stop and is_in_frame:
                                                native_mapped_bp = stop_codon_bp + (target_end - target_start + 1)
                                                if native_mapped_bp == native_stop_bp_check:
                                                    is_premature_stop = False
                                            
                                            if is_premature_stop:
                                                actual_stop_bp = stop_codon_bp
                                        
                                                aa_before_shift = (target_start - 1) // 3
                                                total_aa_in_mutant = stop_codon_bp // 3
                                                downstream_aas = total_aa_in_mutant - aa_before_shift - 1
                                                if downstream_aas < 0: downstream_aas = 0
                                                fs_ter_str = f"fsTer{downstream_aas + 1}"
                                        
                                                # If it's natively in-frame, but hits a STOP, redefine string appropriately
                                                if is_in_frame:
                                                    fs_ter_str = f"Ter{downstream_aas + 1}"
                                        
                                                for tcx in coding_exons:
                                                    native_stop_bp = actual_stop_bp + (target_end - target_start + 1)
                                                    if tcx['start_cds'] <= native_stop_bp <= tcx['end_cds']:
                                                        shift_desc = "creates a junctional Stop Codon" if is_in_frame else f"generates {downstream_aas} new amino acids before a novel Stop Codon"
                                                        ptc_exon_str = f" NMD Phase Shift {shift_desc} ({fs_ter_str}) which natively maps downstream into Exon {tcx['anatomical_rank']}."
                                                        if is_in_frame:
                                                            _hgp_if = _format_whole_exon_skip_hgvs_p(
                                                                mutated_cds,
                                                                target_start,
                                                                inframe_ter_codon_1b=int(stop_codon_bp // 3),
                                                            )
                                                            parsed_data['exon_skip_predicted_hgvs_p'] = _hgp_if
                                                            ptc_exon_str = f"{ptc_exon_str} <b>Predicted</b> protein: {_hgp_if}."
                                                        if not is_in_frame:
                                                            parsed_data['exon_skip_oof_fs_ter'] = fs_ter_str
                                                            parsed_data['exon_skip_oof_ptc_exon_rank'] = int(
                                                                tcx['anatomical_rank']
                                                            )
                                                            try:
                                                                parsed_data['exon_skip_oof_ptc_aa'] = int(
                                                                    stop_codon_bp // 3
                                                                )
                                                            except (TypeError, ValueError):
                                                                pass

                                                        derived_exon_rank = tcx['anatomical_rank']
                                                        derived_exon_total = _mrna_exon_total(parsed_data, coding_exons)
                                                
                                                        parsed_data['variant_exon'] = cx['anatomical_rank']
                                                        parsed_data['snpeff_exon_rank'] = derived_exon_rank
                                                        parsed_data['nmd_exon_total'] = derived_exon_total
                                                
                                                        # Restore clinical numbering for UI when it matches transcript depth.
                                                        # Do not replace structural mRNA exon (3&prime; at acceptor) with SnpEff&rsquo;s 5&prime; exon.
                                                        try:
                                                            if orig_clinical_total and orig_clinical_rank:
                                                                orig_t = int(orig_clinical_total)
                                                                orig_r = int(orig_clinical_rank)
                                                                struct_v_e = parsed_data.get('variant_exon')
                                                        
                                                                if orig_t >= derived_exon_total and struct_v_e:
                                                                    _csl = (current_cons_splice or "")
                                                                    ptc_diff = derived_exon_rank - struct_v_e
                                                                    clin_ptc = orig_r + ptc_diff
                                                                    parsed_data['snpeff_exon_rank'] = (
                                                                        clin_ptc if clin_ptc <= orig_t else orig_t
                                                                    )
                                                                    if not any(
                                                                        x in _csl
                                                                        for x in (
                                                                            'splice_acceptor',
                                                                            'splice_donor',
                                                                            'splice_region',
                                                                        )
                                                                    ):
                                                                        parsed_data['variant_exon'] = orig_r
                                                                        parsed_data['nmd_exon_total'] = orig_t
                                                        except Exception as e:
                                                            pass
                                                    
                                                        # Explicitly state protein_start mapped for UI truncation metric
                                                        onset_aa = aa_before_shift + 1
                                                        parsed_data['protein_start'] = onset_aa
                                                        parsed_data['downstream_aas'] = downstream_aas
                                                        stop_aa = total_aa_in_mutant
                                                        try:
                                                            p_len_i = int(parsed_data.get('protein_length') or 0)
                                                        except (TypeError, ValueError):
                                                            p_len_i = 0
                                                        if p_len_i > 0 and stop_aa > 0:
                                                            formalize_frameshift_ptc(
                                                                parsed_data, onset_aa, stop_aa, p_len_i,
                                                            )
                                                
                                                        if derived_exon_rank == derived_exon_total:
                                                            parsed_data['nmd_escape'] = True
                                                            parsed_data['nmd_exon_distance'] = tcx['end_cds'] - native_stop_bp
                                                            parsed_data['nmd_decision_basis'] = (
                                                                f"PTC in the last coding exon ({derived_exon_rank} of {derived_exon_total}) "
                                                                "after in-frame exon skip — no downstream exon-exon junction remains "
                                                                "(last-exon rule) — predicted to escape NMD."
                                                            )
                                                        elif derived_exon_rank == derived_exon_total - 1:
                                                            dist_to_junction = tcx['end_cds'] - native_stop_bp
                                                            parsed_data['nmd_exon_distance'] = dist_to_junction
                                                            if dist_to_junction < 50:
                                                                parsed_data['nmd_escape'] = True
                                                                parsed_data['nmd_decision_basis'] = (
                                                                    f"PTC in the penultimate coding exon ({derived_exon_rank} of "
                                                                    f"{derived_exon_total}), {dist_to_junction} nt upstream of the "
                                                                    "final exon-exon junction (within the last 50–55 nt) — predicted "
                                                                    "to escape NMD."
                                                                )
                                                            else:
                                                                parsed_data['nmd_escape'] = False
                                                                parsed_data['nmd_decision_basis'] = (
                                                                    f"PTC in the penultimate coding exon ({derived_exon_rank} of "
                                                                    f"{derived_exon_total}), {dist_to_junction} nt upstream of the "
                                                                    "final exon-exon junction (more than 50–55 nt) — predicted to "
                                                                    "trigger NMD."
                                                                )
                                                        else:
                                                            parsed_data['nmd_escape'] = False
                                                            parsed_data['nmd_decision_basis'] = (
                                                                f"PTC in coding exon {derived_exon_rank} of {derived_exon_total} "
                                                                "after in-frame exon skip, upstream of the penultimate exon-exon "
                                                                "junction — predicted to trigger NMD."
                                                            )
                                                        break
                                                
                                                # Override the internal UI to show NMD behavior even if structurally in-frame 
                                                parsed_data['is_splice_frameshift'] = True
                                        else:
                                            ptc_exon_str, oof_state = _oofs_exon_skip_ptc_cds_and_cdna(
                                                http_session,
                                                enst_id,
                                                cds_seq,
                                                target_start,
                                                target_end,
                                                coding_exons,
                                                p_len,
                                            )
                                            for _k, _v in oof_state.items():
                                                if _v is not None:
                                                    parsed_data[_k] = _v
                                            
                                    else:
                                        ptc_exon_str = " -> Sequence Timeout (PTC Unresolved)"
                                        print("DEBUG Ensembl CDS Fetch Failed: empty CDS sequence")
                                        if not is_in_frame:
                                            _mark_oof_exon_skip_nmd_provisional(
                                                parsed_data,
                                                aa_lost=aa_lost,
                                                fraction_lost=fraction_lost,
                                                ptc_unresolved=True,
                                            )
                                except Exception as e:
                                    ptc_exon_str = " -> Sequence Timeout (PTC Unresolved)"
                                    print(f"PTC Translation Array Error: {e}")
                                    if not is_in_frame:
                                        _mark_oof_exon_skip_nmd_provisional(
                                            parsed_data,
                                            aa_lost=aa_lost,
                                            fraction_lost=fraction_lost,
                                            ptc_unresolved=True,
                                        )
                                if not is_in_frame:
                                    parsed_data['is_splice_frameshift'] = True
                                    if not (parsed_data.get('nmd_decision_basis') or '').strip():
                                        _mark_oof_exon_skip_nmd_provisional(
                                            parsed_data,
                                            aa_lost=aa_lost,
                                            fraction_lost=fraction_lost,
                                            ptc_unresolved=not bool(parsed_data.get('exon_skip_oof_ptc_aa')),
                                        )
                                
                                _utr1 = (
                                    " (Exon 1 is 5′-UTR only; mRNA exon numbers still count all exons, including that one.)"
                                    if parsed_data.get('first_mrna_exon_is_non_coding') else ""
                                )
                                # Re-read length/% after provisional backfill / CDS success.
                                try:
                                    p_len = int(parsed_data.get('protein_length') or 0)
                                except (TypeError, ValueError):
                                    p_len = 0
                                if p_len > 0 and aa_lost is not None:
                                    try:
                                        cur_fl = float(parsed_data.get('splice_fraction_lost') or 0)
                                    except (TypeError, ValueError):
                                        cur_fl = 0.0
                                    if cur_fl <= 0:
                                        fraction_lost = aa_lost / float(p_len)
                                        parsed_data['splice_fraction_lost'] = fraction_lost
                                    else:
                                        fraction_lost = cur_fl
                                    pct_str = f"{fraction_lost*100:.1f}%"
                                _len3 = f"multiple of 3" if is_in_frame else f"not a multiple of 3"
                                math_str = (
                                    f"Exon {cx['anatomical_rank']} length {bp_len} bp: {_len3} — {frame_str} → {aa_lost} "
                                    f"amino acids lost ({pct_str} of protein).{ptc_exon_str}{_utr1}"
                                )
                                parsed_data['splice_frame_math'] = math_str
                                parsed_data['splice_is_in_frame'] = is_in_frame
                                parsed_data['splice_fraction_lost'] = fraction_lost
                                parsed_data['splice_target_start_cds'] = cx.get('start_cds')
                                parsed_data['splice_target_end_cds'] = cx.get('end_cds')
                                # Skipped mRNA exon in the loss product (in-frame and OOF); local ClinVar scans this interval
                                parsed_data['splice_deleted_coords'] = {
                                    'chr': cx.get('chr'),
                                    'start': cx.get('start'),
                                    'end': cx.get('end'),
                                }
                                
                                # ==========================================================
                                # SEQUENCE-DRIVEN CRYPTIC SPLICE TRANSLATION ENGINE
                                # Replaces the prior heuristic that only fired for the LAST coding exon
                                # and never actually translated the cryptic-spliced mRNA.
                                # ==========================================================
                                try:
                                    _strand = parsed_data.get('transcript_strand') or (locals().get('strand') if 'strand' in locals() else None)
                                    _chrom = parsed_data.get('transcript_chrom') or cx.get('chr') or parsed_data.get('grch38_chrom')
                                    _cds_seq_local = cds_seq if 'cds_seq' in locals() and cds_seq else ''
                                    cryptic_outcome = _resolve_cryptic_splice_outcome(
                                        http_session,
                                        parsed_data,
                                        cx,
                                        coding_exons,
                                        _cds_seq_local,
                                        c_dot,
                                        current_cons_splice,
                                        _strand if _strand is not None else 1,
                                        _chrom,
                                    )
                                    if cryptic_outcome and not parsed_data.get('deep_intronic_splice_products_active'):
                                        parsed_data['cryptic_splice_outcome'] = cryptic_outcome
                                        parsed_data['cryptic_splice_narrative'] = cryptic_outcome.get('narrative', '')
                                        parsed_data['cryptic_inserted_cdna'] = cryptic_outcome.get('inserted_cdna') or ''
                                        if cryptic_outcome.get('insert_triplet_decode'):
                                            parsed_data['cryptic_insert_triplet_decode'] = cryptic_outcome.get(
                                                'insert_triplet_decode'
                                            )
                                        if cryptic_outcome.get('ptc_aa_position'):
                                            parsed_data['cryptic_splice_ptc'] = cryptic_outcome['fs_ter_str']
                                except Exception as c_err:
                                    print(f"Cryptic Splice Resolver Failure (cds_pos branch): {c_err}")
                                
                                break
                    
                        # If cds_pos fails, try falling back to matching anatomical_rank to snpeff_exon_rank natively
                        if (
                            not parsed_data.get('splice_frame_math')
                            and snpeff_rank > 0
                            and not _defer_whole_exon_skip_to_deep_intronic(current_cons_splice, c_dot)
                        ):
                            target_rank = snpeff_rank
                        
                            # SnpEff assigns Intronic variants to the preceding Intron index.
                            # Splice Acceptors destroy the DOWNSTREAM Exon (+1).
                            # Splice Donors destroy the UPSTREAM Exon (Current).
                            if 'splice_acceptor' in current_cons_splice:
                                target_rank += 1
                            
                            for coding_idx, cx in enumerate(coding_exons, start=1):
                                if cx['anatomical_rank'] == target_rank:
                                    bp_len = cx['length_bp']
                                    is_in_frame = (bp_len % 3 == 0)
                                    aa_lost = bp_len // 3
                                    fraction_lost = 0.0
                                    _ensure_protein_length_from_coding_exons(parsed_data)
                                    try:
                                        p_len = int(parsed_data.get('protein_length') or 0)
                                    except (TypeError, ValueError):
                                        p_len = 0
                                    if p_len > 0:
                                        fraction_lost = aa_lost / float(p_len)
                                    
                                    frame_str = "In-Frame Skip" if is_in_frame else "Out-of-Frame Shift"
                                    pct_str = f"{fraction_lost*100:.1f}%"

                                    if is_in_frame:
                                        for _k in (
                                            'exon_skip_oof_fs_ter',
                                            'exon_skip_oof_ptc_exon_rank',
                                            'exon_skip_oof_ptc_aa',
                                        ):
                                            parsed_data.pop(_k, None)
                                
                                    ptc_exon_str = ""
                                    if not is_in_frame:
                                        try:
                                            cds_seq = _ensure_cds_seq(parsed_data, http_session) or ''
                                            if not cds_seq:
                                                clean_seq_enst = enst_id.split('.')[0]
                                                seq_url = f"https://rest.ensembl.org/sequence/id/{clean_seq_enst}?type=cds"
                                                seq_resp = http_session.get(seq_url, timeout=120)
                                                if seq_resp.status_code == 200:
                                                    cds_seq = seq_resp.json().get('seq', '') or ''
                                                    if cds_seq:
                                                        parsed_data['cds_seq'] = cds_seq
                                            if cds_seq:
                                                target_start = cx['start_cds']
                                                target_end = cx['end_cds']
                                            
                                                ptc_exon_str, oof_fb = _oofs_exon_skip_ptc_cds_and_cdna(
                                                    http_session,
                                                    enst_id,
                                                    cds_seq,
                                                    target_start,
                                                    target_end,
                                                    coding_exons,
                                                    p_len,
                                                )
                                                for _k, _v in oof_fb.items():
                                                    if _v is not None:
                                                        parsed_data[_k] = _v
                                            else:
                                                ptc_exon_str = " -> Sequence Timeout (PTC Unresolved)"
                                                _mark_oof_exon_skip_nmd_provisional(
                                                    parsed_data,
                                                    aa_lost=aa_lost,
                                                    fraction_lost=fraction_lost,
                                                    ptc_unresolved=True,
                                                )
                                        except Exception as e:
                                            ptc_exon_str = " -> Sequence Timeout (PTC Unresolved)"
                                            print(f"PTC Translation Array Error: {e}")
                                            _mark_oof_exon_skip_nmd_provisional(
                                                parsed_data,
                                                aa_lost=aa_lost,
                                                fraction_lost=fraction_lost,
                                                ptc_unresolved=True,
                                            )
                                        parsed_data['is_splice_frameshift'] = True
                                        if not (parsed_data.get('nmd_decision_basis') or '').strip():
                                            _mark_oof_exon_skip_nmd_provisional(
                                                parsed_data,
                                                aa_lost=aa_lost,
                                                fraction_lost=fraction_lost,
                                                ptc_unresolved=not bool(parsed_data.get('exon_skip_oof_ptc_aa')),
                                            )
                                
                                    _utr1_fb = (
                                        " (Exon 1 is 5′-UTR only; mRNA exon numbers still count all exons, including that one.)"
                                        if parsed_data.get('first_mrna_exon_is_non_coding') else ""
                                    )
                                    try:
                                        p_len = int(parsed_data.get('protein_length') or 0)
                                    except (TypeError, ValueError):
                                        p_len = 0
                                    if p_len > 0 and aa_lost is not None:
                                        try:
                                            cur_fl = float(parsed_data.get('splice_fraction_lost') or fraction_lost or 0)
                                        except (TypeError, ValueError):
                                            cur_fl = 0.0
                                        if cur_fl <= 0:
                                            fraction_lost = aa_lost / float(p_len)
                                            parsed_data['splice_fraction_lost'] = fraction_lost
                                        else:
                                            fraction_lost = cur_fl
                                        pct_str = f"{fraction_lost*100:.1f}%"
                                    _len3_fb = f"multiple of 3" if is_in_frame else f"not a multiple of 3"
                                    math_str = (
                                        f"Exon {cx['anatomical_rank']} length {bp_len} bp: {_len3_fb} — {frame_str} → {aa_lost} "
                                        f"amino acids lost ({pct_str} of protein).{ptc_exon_str}{_utr1_fb}"
                                    )
                                    parsed_data['splice_frame_math'] = math_str
                                    parsed_data['splice_is_in_frame'] = is_in_frame
                                    parsed_data['splice_fraction_lost'] = fraction_lost
                                    parsed_data['variant_exon'] = cx['anatomical_rank']
                                    parsed_data['nmd_exon_total'] = _mrna_exon_total(parsed_data, coding_exons)
                                    parsed_data['splice_target_start_cds'] = cx.get('start_cds')
                                    parsed_data['splice_target_end_cds'] = cx.get('end_cds')
                                    parsed_data['splice_deleted_coords'] = {
                                        'chr': cx.get('chr'),
                                        'start': cx.get('start'),
                                        'end': cx.get('end'),
                                    }
                                        
                                    # ==========================================================
                                    # SEQUENCE-DRIVEN CRYPTIC SPLICE TRANSLATION ENGINE (fallback path)
                                    # ==========================================================
                                    try:
                                        _strand = parsed_data.get('transcript_strand') or (locals().get('strand') if 'strand' in locals() else None)
                                        _chrom = parsed_data.get('transcript_chrom') or cx.get('chr') or parsed_data.get('grch38_chrom')
                                        cryptic_outcome = _resolve_cryptic_splice_outcome(
                                            http_session,
                                            parsed_data,
                                            cx,
                                            coding_exons,
                                            cds_seq if 'cds_seq' in locals() else '',
                                            c_dot,
                                            current_cons_splice,
                                            _strand if _strand is not None else 1,
                                            _chrom,
                                        )
                                        if cryptic_outcome and not parsed_data.get('deep_intronic_splice_products_active'):
                                            parsed_data['cryptic_splice_outcome'] = cryptic_outcome
                                            parsed_data['cryptic_splice_narrative'] = cryptic_outcome.get('narrative', '')
                                            parsed_data['cryptic_inserted_cdna'] = cryptic_outcome.get('inserted_cdna') or ''
                                        if cryptic_outcome.get('insert_triplet_decode'):
                                            parsed_data['cryptic_insert_triplet_decode'] = cryptic_outcome.get(
                                                'insert_triplet_decode'
                                            )
                                            if cryptic_outcome.get('ptc_aa_position'):
                                                parsed_data['cryptic_splice_ptc'] = cryptic_outcome['fs_ter_str']
                                    except Exception as c_err:
                                        print(f"Cryptic Splice Resolver Failure (snpeff fallback): {c_err}")
                                    
                    else:
                        parsed_data['splice_math_error'] = "Ensembl Exon Sequence Timeout/Error (Fetch Failed)"
                except Exception as e:
                    import traceback
                    parsed_data['splice_math_error'] = f"Ensembl Exon Sequence Timeout/Error (Fetch Failed): {e} - Trace: {traceback.format_exc()}"
                    print(f"Splicing Frame Math Error: {e}")
        _hydrate_exon_skip_truncation_metrics(parsed_data)
        _reconcile_splice_model_precedence(parsed_data)
        # When DS_AL (or DS_DL) clearly dwarves gain, do not let a weak cryptic / native-stop
        # resolver story override exon-skip in the Logic Explanation (e.g. KITLG c.715-2A>C).
        _spliceai_exon_skip_takes_precedence_over_weak_cryptic(parsed_data)
        _refresh_secondary_gain_at_spliceai_dp(http_session, parsed_data)
        # Parallel exon-skip (e.g. strong DS_DL 5&prime; of same intron): secondary whole-exon-skip of exon N-1
        _cdot_sec = (parsed_data.get("c_dot") or "") or ""
        _cons_sec = (parsed_data.get("consequence") or "") or ""
        _iacc_sec = _consequence_is_acceptor_splice(_cons_sec, _cdot_sec)
        _idon_sec = _consequence_is_donor_splice(_cons_sec, _cdot_sec)
        _spliceai_secondary_donor_parallel_exon_skip_math(
            http_session,
            parsed_data,
            parsed_data.get("coding_exons") or [],
            (parsed_data.get("ensembl_transcript_id", "") or ""),
            _iacc_sec,
            _idon_sec,
        )
        _spliceai_secondary_acceptor_parallel_exon_skip_math(
            http_session,
            parsed_data,
            parsed_data.get("coding_exons") or [],
            (parsed_data.get("ensembl_transcript_id", "") or ""),
            _iacc_sec,
            _idon_sec,
        )
        _apply_pre_atg_splice_acceptor_context(
            parsed_data, c_dot, parsed_data.get('consequence', ''),
        )
        _apply_exon_skip_truncation_as_primary(parsed_data)
        _finalize_splice_report_narratives(parsed_data)
        # Unified 5-Prime Start Loss Logic Integration
        current_cons = parsed_data.get('consequence', '')
        p_start = parsed_data.get('protein_start', 0)
        
        # Safely capture either the dynamically derived variant_exon from Splicing logic, or fallback natively
        current_rank = parsed_data.get('variant_exon') or parsed_data.get('snpeff_exon_rank')
        
        # Ensure the UI gets the Exon badges even if MyVariant structural lookup failed and splicing was skipped
        if parsed_data.get('variant_exon') is None:
            parsed_data['variant_exon'] = current_rank
        if parsed_data.get('nmd_exon_total') is None:
            parsed_data['nmd_exon_total'] = parsed_data.get('snpeff_exon_total')
            
        is_first_exon = (current_rank == 1)
        
        # Universal check: If Exon 1 is purely a 5' UTR, find the true First Coding Exon
        if not is_first_exon and current_rank and current_cons in ['nonsense', 'frameshift', 'splice_donor_variant', 'splice_acceptor_variant', 'start_lost']:
            enst_id = parsed_data.get('ensembl_transcript_id', '')
            if enst_id:
                try:
                    clean_id = enst_id.split('.')[0]
                    exon_url = f"https://rest.ensembl.org/lookup/id/{clean_id}?expand=1"
                    exon_resp = http_session.get(exon_url, timeout=120)
                    if exon_resp.status_code == 200:
                        trans = exon_resp.json().get('Translation', {})
                        if trans.get('start') and trans.get('end'):
                            strand = exon_resp.json().get('strand', 1)
                            exons = exon_resp.json().get('Exon', [])
                            exons.sort(key=lambda x: x['start'] if strand == 1 else -x['start'])
                            for e_idx, e in enumerate(exons):
                                overlap = max(e['start'], trans['start']) <= min(e['end'], trans['end'])
                                if overlap:
                                    if current_rank == (e_idx + 1):
                                        is_first_exon = True
                                    break # First coding exon located
                except: pass
        
        # Whole-exon skip primary: skip-product ORF is not start-loss re-initiation on the WT map.
        if _whole_exon_skip_primary_resolved(parsed_data):
            _suppress_start_loss_nmd_for_exon_skip_primary(parsed_data)
        elif _met_reinitiation_applies(
            parsed_data,
            current_cons=current_cons,
            current_rank=current_rank,
            is_first_exon=is_first_exon,
        ):
            enst_id = parsed_data.get('ensembl_transcript_id', '')
            if enst_id:
                enst_id = enst_id.split('.')[0]
                try:
                    seq_url = f"https://rest.ensembl.org/sequence/id/{enst_id}?type=protein"
                    seq_resp = http_session.get(seq_url, headers={"Content-Type": "application/json"}, timeout=20)
                    if seq_resp.status_code == 200:
                        seq = seq_resp.json().get('seq', '')
                        total_len = len(seq)
                        
                        if total_len > 0:
                            parsed_data.pop('nmd_math', None)
                            # Search for the next in-frame Met after the abolished initiator (index 0).
                            next_m_raw = seq.find('M', 1)
                            next_m = next_m_raw + 1 if next_m_raw != -1 else -1

                            if next_m != -1:
                                t_frac = start_loss_fraction_from_next_met(next_m, total_len)
                                parsed_data['nmd_escape_truncation_fraction'] = t_frac
                                parsed_data['next_methionine_position'] = next_m
                                parsed_data['nmd_escape'] = is_start_loss_reinit_viable(t_frac)
                                pct = round(t_frac * 100, 1)
                                if is_start_loss_reinit_viable(t_frac):
                                    parsed_data['nmd_math'] = (
                                        f"The primary start codon is abolished. Translation may re-initiate at the "
                                        f"next in-frame Methionine (aa {next_m}), removing only {pct}% of the "
                                        f"{total_len}-amino-acid protein (< 10% start-loss / re-initiation pathway)."
                                    )
                                else:
                                    parsed_data['nmd_math'] = (
                                        f"The primary start codon is abolished. The next in-frame Methionine "
                                        f"(aa {next_m}) is too far downstream, removing {pct}% of the "
                                        f"{total_len}-amino-acid protein (≥ 10% — severe N-terminal truncation)."
                                    )
                            else:
                                parsed_data['nmd_escape_truncation_fraction'] = 1.0
                                parsed_data['nmd_escape'] = False
                                parsed_data['nmd_math'] = (
                                    "The primary start codon is abolished and no downstream Methionine is "
                                    "available for re-initiation; 100% of the functional protein is lost."
                                )

                            parsed_data['protein_length'] = total_len
                            parsed_data['protein_start'] = 1
                except Exception as e:
                    print(f"5' Logic Error: {e}")

        # --- NCBI E-Utilities Rescue Hooks (ClinVar) ---
        _ensure_derived_hgvs_p_for_inframe(parsed_data, http_session, c_dot)
        # Prefer genomic ClinVar VCF + esummary concordance over MyVariant text hits or loose ESearch.
        _resolve_clinvar_from_genomic_locus(
            parsed_data,
            http_session,
            effective_gene,
            target_transcript=target_transcript,
            c_dot=c_dot,
            overwrite=bool(parsed_data.get("clinvar_rcv") and myvariant_match_score < 3),
        )

        try:
            rec_uid, rec_sig, es_score = _pick_clinvar_from_esearch(
                http_session,
                effective_gene,
                c_dot,
                target_transcript=target_transcript,
                hgvs_p=parsed_data.get("hgvs_p"),
            )
            cur_uid = str(parsed_data.get("clinvar_rcv") or "").strip()
            replace_rcv = False
            if rec_uid and es_score >= 70:
                if not cur_uid:
                    replace_rcv = True
                elif es_score >= 100:
                    replace_rcv = True
                elif _c_dot_requires_exact_allele_match(c_dot):
                    summaries = _fetch_clinvar_esummary_map(http_session, [cur_uid])
                    cur_obj = summaries.get(cur_uid) or {}
                    cur_vs = (cur_obj.get("variation_set") or [{}])[0]
                    cur_name = cur_vs.get("variation_name") or cur_obj.get("title") or ""
                    cur_score = _clinvar_variation_name_score(
                        cur_name, effective_gene, target_transcript, c_dot,
                        hgvs_p=parsed_data.get("hgvs_p"),
                    )
                    if cur_score < 100:
                        replace_rcv = True
            if replace_rcv:
                parsed_data['clinvar_rcv'] = rec_uid
                if rec_sig:
                    parsed_data['clinvar_sig'] = rec_sig
        except Exception as e_res:
            print(f"NCBI E-Utilities ClinVar Rescue Hook Error: {e_res}")

        # Upgrade p.Xaa… / empty protein HGVS using ClinVar title or intake (EMG) names.
        try:
            _upgrade_hgvs_p_from_named_sources(parsed_data, http_session)
        except Exception as _p_up_err:
            print(f"[hgvs_p] named-source upgrade failed: {_p_up_err}")

        from vc_engine.source_mode import clinvar_remote_active as _clinvar_remote

        if _clinvar_remote() and parsed_data.get('clinvar_rcv') and not parsed_data.get('legacy_exon_label'):
            try:
                rcv_uid = str(parsed_data.get('clinvar_rcv') or '').strip()
                sum_url = (
                    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"
                    f"?db=clinvar&id={rcv_uid}&retmode=json"
                )
                sum_resp = http_session.get(sum_url, timeout=10)
                if sum_resp.status_code == 200:
                    sum_data = sum_resp.json()
                    result_obj = sum_data.get('result', {}).get(rcv_uid, {})
                    vs0 = (result_obj.get('variation_set') or [{}])[0]
                    legacy = _parse_legacy_ivs_alias(vs0.get('aliases') or [])
                    if legacy:
                        parsed_data['legacy_exon_label'] = legacy['label']
                        parsed_data['legacy_exon_meta'] = legacy
            except Exception as e_legacy:
                print(f"ClinVar legacy alias fetch error: {e_legacy}")

        # Always try to resolve legacy IVS / exon aliases (independent of rescue hook)
        if _clinvar_remote() and parsed_data.get('clinvar_rcv') and not parsed_data.get('legacy_exon_label'):
            try:
                legacy_uid = _clinvar_variation_uid_for_pubmed_elink(
                    effective_gene, c_dot, str(parsed_data.get('clinvar_rcv'))
                )
                if legacy_uid:
                    aliases = _fetch_clinvar_aliases(http_session, legacy_uid)
                    legacy = _parse_legacy_ivs_alias(aliases)
                    if legacy:
                        parsed_data['legacy_exon_label'] = legacy['label']
                        parsed_data['legacy_exon_meta'] = legacy
            except Exception as e_alias:
                print(f"Legacy IVS alias resolver error: {e_alias}")

        # Decoupled HTML Scrape for Multi-Row Submission Metadata
        # Triggers natively if MyVariant, Pysam, OR E-Utilities identified a ClinVar linkage.
        # Skip when Gemini is disabled (standalone): full HTML page fetch often costs
        # several seconds and only populates the lab-submission footnote.
        if parsed_data.get('clinvar_rcv') and client:
            try:
                import requests, re
                from bs4 import BeautifulSoup
                cv_url = clinvar_portal_url(parsed_data['clinvar_rcv'])
                cv_html = requests.get(cv_url, timeout=4).text
                soup = BeautifulSoup(cv_html, 'html.parser')
                table = soup.find('table', {'id': 'assertion-list'})
                
                if table:
                    subs = []
                    for row in table.find('tbody').find_all('tr'):
                        cols = row.find_all('td')
                        if len(cols) >= 4:
                            # 0: Classification + Date
                            c0 = cols[0].get_text(separator=' ', strip=True)
                            interp = c0.split(' (')[0].strip() if ' (' in c0 else c0
                            year_match = re.search(r'(20\d{2})', c0)
                            year = year_match.group(1) if year_match else 'Unknown'
                            
                            # 3: Submitter
                            c3 = cols[3].get_text(separator=' ', strip=True)
                            lab = c3.split(' Accession:')[0].strip()
                            
                            # Minimize acronym bloat (e.g. "Evidence-based Network... (ENIGMA)" -> "ENIGMA")
                            acr_match = re.search(r'\(([^)]+)\)$', lab)
                            if acr_match and len(acr_match.group(1)) <= 15:
                                lab = acr_match.group(1)
                            
                            subs.append(f"{lab} ({interp}, {year})")
                    
                    if subs:
                        parsed_data['clinvar_lab'] = '\n  - '.join(subs)
            except Exception as html_err:
                print(f"HTML Clinvar Scrape Error: {html_err}")
        elif parsed_data.get('clinvar_rcv') and not client:
            print("DEBUG: Skipping ClinVar HTML lab scrape (Gemini disabled / fast path)")

        # 3. Auto-Lookup (P/LP in region): nonsense / frameshift NMD-escape protocol — P/LP
        # strictly 3′ of the PTC anchor (short 3′ loss, marginal fs extension, or structural
        # last-exon / penultimate escape with substantial C-terminal loss). Structural splice
        # (whole–exon loss, PTC in skipped exon, etc.) uses splice_deleted_coords VCF scan.
        sync_truncation_fraction_from_ptc(parsed_data)
        current_csq_nmd = parsed_data.get('consequence', '')
        is_core_nmd_csq = current_csq_nmd in ['nonsense', 'frameshift']
        trunc_frac = parsed_data.get('nmd_escape_truncation_fraction', 0.0)
        is_short_extension = is_core_nmd_csq and is_short_3prime_extension(trunc_frac)
        is_start_loss_escape = (
            current_csq_nmd == 'start_lost'
            and is_start_loss_reinit_viable(trunc_frac)
        )
        needs_downstream_plp = _needs_downstream_clinvar_plp(parsed_data)

        if needs_downstream_plp or is_start_loss_escape:
            if not parsed_data.get('has_downstream_pathogenic') and not parsed_data.get('has_upstream_pathogenic'):
                try:
                    p_query_url = (
                        f'https://myvariant.info/v1/query?q=clinvar.gene.symbol:"{effective_gene}"%20AND%20'
                        f'(clinvar.rcv.clinical_significance:pathogenic%20OR%20clinvar.rcv.clinical_significance:likely_pathogenic)'
                        f'&fields=snpeff.ann.protein.position,clinvar.rcv.accession,clinvar.gene,clinvar.hgvs,clinvar.variant_id&size=1000'
                    )
                    p_resp = http_session.get(p_query_url, timeout=15)
                    if p_resp.status_code == 200:
                        current_pos = _downstream_plp_anchor_aa(parsed_data)

                        try:
                            next_m_pos = int(parsed_data.get('next_methionine_position', 0))
                        except (ValueError, TypeError):
                            next_m_pos = 0
                        hits = p_resp.json().get('hits', [])
                        _upstream_seen = set()
                        _upstream_plp_accum = []
                        _downstream_seen = set()
                        _downstream_plp_accum = []

                        for hit in hits:
                            cv_gene = hit.get('clinvar', {}).get('gene', {})
                            if isinstance(cv_gene, list):
                                cv_gene_sym = cv_gene[0].get('symbol', '').upper()
                            else:
                                cv_gene_sym = cv_gene.get('symbol', '').upper()

                            if cv_gene_sym != effective_gene.upper():
                                continue  # Skip corrupted external database hits

                            ann = hit.get('snpeff', {}).get('ann', [])
                            if isinstance(ann, dict):
                                ann = [ann]

                            hgvs = hit.get('clinvar', {}).get('hgvs', {})
                            if isinstance(hgvs, dict):
                                hgvs_p = hgvs.get('protein', '')
                            elif isinstance(hgvs, list) and len(hgvs) > 0:
                                hgvs_p = hgvs[0].get('protein', '')
                            else:
                                hgvs_p = ''
                            if isinstance(hgvs_p, list):
                                hgvs_p = " ".join(hgvs_p)

                            accession = ""
                            rcv = hit.get('clinvar', {}).get('rcv', [])
                            if isinstance(rcv, dict):
                                rcv = [rcv]
                            if len(rcv) > 0:
                                accession = rcv[0].get('accession', '')
                            variant_id_hit = hit.get('clinvar', {}).get('variant_id')
                            if variant_id_hit is not None:
                                variant_id_hit = str(variant_id_hit)

                            hp = str(hgvs_p or '')
                            # Synonymous: no regional evidence
                            if hp and re.search(r'p\.\w+\d+=', hp):
                                continue

                            pos_vals_to_check = []
                            for a in ann:
                                pos_str = str(a.get('protein', {}).get('position', ''))
                                if pos_str:
                                    try:
                                        pos_vals_to_check.append(int(pos_str.split('/')[0]))
                                    except Exception:
                                        pass

                            for m in re.findall(r"p\.(?:[A-Za-z]{3}|[A-Za-z*])(\d+)", hp):
                                pos_vals_to_check.append(int(m))
                            for mo in re.finditer(r'(\d+)(?:fs|\*|Ter\b)', hp, re.I):
                                pos_vals_to_check.append(int(mo.group(1)))

                            pos_vals_to_check = sorted(set(pos_vals_to_check))
                            if not pos_vals_to_check:
                                continue

                            rcv_arr = hit.get('clinvar', {}).get('rcv', [])
                            if isinstance(rcv_arr, dict):
                                rcv_arr = [rcv_arr]
                            raw_sig = "Pathogenic"
                            if len(rcv_arr) > 0:
                                raw_sig = rcv_arr[0].get('clinical_significance', 'Pathogenic').replace('_', ' ').title()
                            sig_lower = raw_sig.lower()
                            if 'conflicting' in sig_lower:
                                continue
                            if 'pathogenic' not in sig_lower:
                                continue

                            c_notation = "Unknown c."
                            hgvs_c = hit.get('snpeff', {}).get('ann', [])
                            if isinstance(hgvs_c, dict):
                                hgvs_c = [hgvs_c]
                            if len(hgvs_c) > 0:
                                c_str = hgvs_c[0].get('hgvs_c', '')
                                if c_str:
                                    c_notation = c_str.split(':')[-1]
                            if (not c_notation) or c_notation == "Unknown c.":
                                cvhg = hit.get("clinvar", {}).get("hgvs", {})
                                cand = None
                                if isinstance(cvhg, dict):
                                    cand = cvhg.get("coding") or cvhg.get("shell")
                                elif isinstance(cvhg, list) and cvhg:
                                    c0 = cvhg[0]
                                    if isinstance(c0, dict):
                                        cand = c0.get("coding") or c0.get("shell")
                                if isinstance(cand, list) and cand:
                                    cand = cand[0]
                                if isinstance(cand, str) and cand.strip():
                                    cs = cand.strip()
                                    if ":c." in cs:
                                        c_notation = cs.split(":")[-1]
                                    elif cs.lower().startswith("c."):
                                        c_notation = cs
                                    elif re.search(r"\bc\.\d", cs, re.I):
                                        m = re.search(r"(c\.[^\s;]+)", cs, re.I)
                                        if m:
                                            c_notation = m.group(1)
                            if c_notation == "Unknown c." and variant_id_hit:
                                c_notation = f"ClinVar variation {variant_id_hit}"
                            formatted_pathogenic_str = f"{c_notation} ({raw_sig})"
                            link_id = accession or variant_id_hit
                            cv_vid = ""
                            if variant_id_hit is not None:
                                _cv = str(variant_id_hit).strip()
                                if _cv.isdigit():
                                    cv_vid = _cv

                            qual_down = [
                                p for p in pos_vals_to_check
                                if needs_downstream_plp and current_pos > 0 and p > current_pos
                            ]
                            if qual_down:
                                dk_ds = str(variant_id_hit or accession or formatted_pathogenic_str)
                                if dk_ds not in _downstream_seen:
                                    _downstream_seen.add(dk_ds)
                                    rep_ds = min(qual_down)
                                    _downstream_plp_accum.append(
                                        {
                                            'label': formatted_pathogenic_str,
                                            'link': clinvar_portal_url(link_id) if link_id else '',
                                            'clinvar_vid': cv_vid,
                                            'position': rep_ds,
                                            'source': 'clinvar',
                                            'c_dot_norm': _norm_c_dot_for_upstream_dedupe(c_notation),
                                        }
                                    )

                            for pos_val in pos_vals_to_check:
                                if (
                                    is_start_loss_escape
                                    and next_m_pos > 0
                                    and pos_val < next_m_pos
                                ):
                                    dedupe_key = str(variant_id_hit or accession or formatted_pathogenic_str)
                                    if dedupe_key not in _upstream_seen:
                                        _upstream_seen.add(dedupe_key)
                                        _upstream_plp_accum.append(
                                            {
                                                'label': formatted_pathogenic_str,
                                                'link': clinvar_portal_url(link_id) if link_id else '',
                                                'clinvar_vid': cv_vid,
                                                'position': pos_val,
                                                'source': 'clinvar',
                                                'c_dot_norm': _norm_c_dot_for_upstream_dedupe(c_notation),
                                            }
                                        )

                        if _downstream_plp_accum:
                            _downstream_plp_accum.sort(
                                key=lambda x: int(x.get('position') or 0)
                            )
                            parsed_data['downstream_pathogenic_hits'] = _downstream_plp_accum
                            parsed_data['has_downstream_pathogenic'] = True
                            parsed_data['auto_downstream_pathogenic'] = True
                            parsed_data['downstream_pathogenic_string'] = _downstream_plp_accum[0]['label']
                            lk0d = (_downstream_plp_accum[0].get('link') or '').strip()
                            if lk0d:
                                parsed_data['auto_downstream_pathogenic_link'] = lk0d

                        if _upstream_plp_accum:
                            _upstream_plp_accum.sort(key=lambda x: int(x.get('position') or 0))
                            parsed_data['upstream_pathogenic_hits'] = _upstream_plp_accum
                            parsed_data['has_upstream_pathogenic'] = True
                            parsed_data['auto_upstream_pathogenic'] = True
                            parsed_data['upstream_pathogenic_string'] = _upstream_plp_accum[0]['label']
                            lk0 = (_upstream_plp_accum[0].get('link') or '').strip()
                            if lk0:
                                parsed_data['auto_upstream_pathogenic_link'] = lk0
                except Exception as e:
                    print(f"Downstream P/LP auto-lookup error: {e}")

            if is_start_loss_escape:
                try:
                    nm_h = int(parsed_data.get("next_methionine_position"))
                except (TypeError, ValueError):
                    nm_h = 0
                if nm_h > 0:
                    merged_hits = list(parsed_data.get("upstream_pathogenic_hits") or [])
                    _merge_hgmd_upstream_hits(merged_hits, effective_gene, nm_h)
                    merged_hits.sort(
                        key=lambda x: (
                            int(x.get("position") or 0),
                            str(x.get("source") or ""),
                        )
                    )
                    if merged_hits:
                        parsed_data["upstream_pathogenic_hits"] = merged_hits
                        parsed_data["has_upstream_pathogenic"] = True
                        parsed_data["auto_upstream_pathogenic"] = True
                        if not (parsed_data.get("upstream_pathogenic_string") or "").strip():
                            parsed_data["upstream_pathogenic_string"] = merged_hits[0]["label"]
                            lk0 = (merged_hits[0].get("link") or "").strip()
                            if lk0:
                                parsed_data["auto_upstream_pathogenic_link"] = lk0

            if needs_downstream_plp:
                cur_d = _downstream_plp_anchor_aa(parsed_data)
                if cur_d > 0:
                    dm = list(parsed_data.get("downstream_pathogenic_hits") or [])
                    _merge_hgmd_downstream_hits(dm, effective_gene, cur_d)
                    dm.sort(
                        key=lambda x: (
                            int(x.get("position") or 0),
                            str(x.get("source") or ""),
                        )
                    )
                    if dm:
                        parsed_data["downstream_pathogenic_hits"] = dm
                        parsed_data["has_downstream_pathogenic"] = True
                        parsed_data["auto_downstream_pathogenic"] = True
                        if not (parsed_data.get("downstream_pathogenic_string") or "").strip():
                            parsed_data["downstream_pathogenic_string"] = dm[0]["label"]
                            lkd = (dm[0].get("link") or "").strip()
                            if lkd:
                                parsed_data["auto_downstream_pathogenic_link"] = lkd
            _finalize_plp_region_links(parsed_data, effective_gene)
            if needs_downstream_plp:
                _finalize_downstream_plp_scan_metadata(parsed_data, effective_gene)

            uh = parsed_data.get("upstream_pathogenic_hits")
            if uh and parsed_data.get("nmd_math"):
                try:
                    nm_int = int(parsed_data.get("next_methionine_position"))
                except (TypeError, ValueError):
                    nm_int = 0
                extra = _upstream_plp_hits_markup(
                    parsed_data, nm_int if nm_int > 0 else None
                )
                if extra:
                    parsed_data["nmd_math"] += extra
                    parsed_data["_upstream_plp_list_in_nmd_structure"] = True

            if (
                needs_downstream_plp
                and parsed_data.get("downstream_pathogenic_hits")
                and parsed_data.get("nmd_math")
            ):
                va_ext = _downstream_plp_anchor_aa(parsed_data)
                extra_ds = _downstream_plp_hits_markup(
                    parsed_data, va_ext if va_ext > 0 else None
                )
                if extra_ds:
                    parsed_data["nmd_math"] += extra_ds
                    parsed_data["_downstream_plp_list_in_nmd_structure"] = True

        # 4. Whole-exon–skip and cryptic-splice excised regions: scan local ClinVar
        # (GRCh38) for P/LP hits whose positions fall inside the skipped exon or
        # the excised segment when a cryptic donor/acceptor shortens an exon.
        # Ensure Ensembl coding_exons first — SpliceAI can mark exon-skip before
        # structural splice math populated genomic coords (common on slow REST).
        _ensure_skipped_exon_interval_and_plp_scan(parsed_data, effective_gene, http_session)

        # SOP narration for whole-exon-skip splice variants — converts the
        # raw size + in-frame + P/LP-lookup signals into the actual
        # ClinGen/Tayoun decision sentence ("≥10% → PVS1_Strong",
        # "<10% with P/LP → PVS1 (upgraded from PM4)", "<10% no P/LP →
        # PM4", "out-of-frame → PVS1"). Same fields drive the criterion
        # at line ~2605, but reviewers want the *logic* spelled out in the
        # write-up, not just the resulting code.
        # Whole-exon-skip → scan UniProt for protein domains/motifs removed by
        # the skip (the skipped exon's residue span), so reviewers see which
        # functional regions are deleted even for small in-frame skips.
        try:
            _skip_bounds = _hydrate_skipped_exon_aa_bounds(parsed_data)
            if _skip_bounds:
                _apply_uniprot_skipped_exon_domains(
                    http_session, parsed_data, effective_gene,
                    _skip_bounds[0], _skip_bounds[1],
                )
        except Exception as _usk_err:
            print(f"UniProt skipped-exon domain scan error: {_usk_err}")

        _spfm = (parsed_data.get('splice_frame_math') or '')
        _sif = parsed_data.get('splice_is_in_frame')
        _sfl = parsed_data.get('splice_fraction_lost')
        if _sif is not None and _sfl is not None:
            try:
                _frac = float(_sfl)
            except (TypeError, ValueError):
                _frac = None
            if _frac is not None:
                pct_lbl = f"{_frac * 100:.1f}%"
                plp_hit_n = len(parsed_data.get('skipped_exon_pathogenic_hits') or [])
                plp_checked = bool(parsed_data.get('skipped_exon_plp_checked'))
                _aa_rng = _skipped_exon_aa_range_label(parsed_data)
                _aa_clause = f" (protein {_aa_rng})" if _aa_rng else ""
                if not bool(_sif):
                    if parsed_data.get('exon_skip_oof_no_inframe_stop'):
                        nmd_bit = (
                            "no in-frame stop on the loss product (last-exon skip) — "
                            "<b>NMD escape</b>; still severe LoF from the skipped exon"
                        )
                    elif parsed_data.get('nmd_escape'):
                        nmd_bit = "<b>NMD escape</b> on the resolved skip product"
                    else:
                        nmd_bit = "NMD-predicted unless the variant escapes NMD"
                    logic_sentence = (
                        f"<b>SOP logic:</b> out-of-frame shift "
                        f"({pct_lbl} of protein lost in the spliced product) &rarr; "
                        f"<b>PVS1</b> by default ({nmd_bit})."
                    )
                elif _frac >= 0.10:
                    logic_sentence = (
                        f"<b>SOP logic:</b> in-frame skip removes {pct_lbl} of the protein "
                        f"(&ge;10% threshold) &rarr; <b>PVS1_Strong</b> (in-frame deletion of "
                        f"a region considered critical to function)."
                    )
                elif plp_hit_n > 0:
                    n_lbl = "1 established P/LP variant" if plp_hit_n == 1 else f"{plp_hit_n} established P/LP variants"
                    logic_sentence = (
                        f"<b>SOP logic:</b> in-frame skip removes {pct_lbl} of the protein "
                        f"(&lt;10% threshold), but the deleted exon{_aa_clause} harbors {n_lbl} in ClinVar "
                        f"&rarr; <b>PVS1</b> (upgraded from PM4 because known pathogenic "
                        f"variation lies in the excised region)."
                    )
                elif plp_checked:
                    logic_sentence = (
                        f"<b>SOP logic:</b> in-frame skip removes {pct_lbl} of the protein "
                        f"(&lt;10% threshold) and no overlapping P/LP variants were found in "
                        f"ClinVar for the deleted exon{_aa_clause} &rarr; <b>PM4</b>."
                    )
                else:
                    logic_sentence = (
                        f"<b>SOP logic:</b> in-frame skip removes {pct_lbl} of the protein "
                        f"(&lt;10% threshold); ClinVar P/LP scan for the deleted exon did not "
                        f"complete &rarr; <b>PM4</b> (default for small in-frame deletions); "
                        f"upgrade to PVS1 if a P/LP variant is later confirmed inside the "
                        f"skipped exon."
                    )
                parsed_data['splice_pvs1_logic_sentence'] = logic_sentence
                if logic_sentence and logic_sentence not in _spfm:
                    sep = '<br><br>' if _spfm and not _spfm.endswith(('<br>', '<br><br>')) else ''
                    parsed_data['splice_frame_math'] = _spfm + sep + logic_sentence

        # Predictive Matrix Auto-Calculation Engine (Replaces Advanced Missense Manual Matrix)
        if 'missense' in parsed_data.get('consequence', '') or 'inframe' in parsed_data.get('consequence', ''):
            try:
                cv_url = (
                    f"https://myvariant.info/v1/query?q=clinvar.gene.symbol:{effective_gene} AND "
                    f"(clinvar.rcv.clinical_significance:pathogenic OR "
                    f'clinvar.rcv.clinical_significance:"likely pathogenic")'
                    f"&fields=clinvar.hgvs.coding,clinvar.hgvs.protein,snpeff.ann.feature_id,"
                    f"snpeff.ann.protein.position,snpeff.ann.hgvs_p,clinvar.rcv.accession,clinvar.variant_id&size=1000"
                )
                cv_resp = http_session.get(cv_url, timeout=30).json()

                # Hotspot scoring must be transcript-aware: ClinVar groups variants by genomic
                # locus, so a single locus can carry multiple snpeff annotations against
                # different transcripts. The protein numbering at the same physical position
                # can differ between isoforms (e.g. p.Glu1295* vs p.Val1295fs at the same
                # genomic codon, mapped to two different reference proteins). Without
                # filtering by transcript we would silently mix isoforms in the ±5 aa
                # density count.
                target_tx_base = (target_transcript or '').strip()
                if target_tx_base and '.' in target_tx_base:
                    target_tx_base = target_tx_base.split('.')[0]
                target_tx_base = target_tx_base.upper()

                def _ann_matches_target_tx(a_dict):
                    fid = (a_dict.get('feature_id') or '')
                    fid_base = fid.split('.')[0].upper() if '.' in fid else fid.upper()
                    if target_tx_base:
                        return fid_base == target_tx_base
                    return fid_base.startswith('NM_')

                def _pick_ann_for_target_tx(ann_list, protein_pos=None):
                    return _pick_snpeff_ann_for_transcript(
                        ann_list, target_tx_base, protein_pos
                    )

                def _anns_at_target_protein_pos(ann_list, protein_pos):
                    """snpeff rows on the user's transcript at this protein index only."""
                    if isinstance(ann_list, dict):
                        ann_list = [ann_list]
                    out = []
                    for a in ann_list:
                        if target_tx_base and not _ann_matches_target_tx(a):
                            continue
                        if _ann_protein_position(a) == protein_pos:
                            out.append(a)
                    return out

                target_pos = None
                target_aa_change = None
                target_missense = None
                hgvs_p = parsed_data.get('hgvs_p', '')
                if hgvs_p:
                    target_missense = _parse_missense_substitution_hgvs_p(hgvs_p)
                    if target_missense:
                        target_pos = target_missense["pos"]
                        target_aa_change = target_missense["alt_3"]
                    else:
                        match = re.search(
                            r'p\.[a-zA-Z]{3}(\d+)([a-zA-Z]{3}|del|dup|ins)', hgvs_p
                        )
                        if match:
                            target_pos = int(match.group(1))
                            target_aa_change = match.group(2)
                        else:
                            target_pos = _protein_position_from_hgvs_p(hgvs_p)

                if not target_pos and verified_hit:
                    ann = verified_hit.get('snpeff', {}).get('ann', [])
                    if isinstance(ann, dict): ann = [ann]
                    # Prefer the ann entry on the user-selected transcript so that the
                    # "target_pos" anchor (which becomes the ±5 aa hotspot center) is
                    # always in the user's protein-numbering frame.
                    chosen = _pick_ann_for_target_tx(ann, target_pos)
                    if chosen is not None and target_pos is None:
                        target_pos = _ann_protein_position(chosen)

                parsed_data['internal_hotspot'] = False
                parsed_data['identical_pathogenic'] = False
                parsed_data['different_pathogenic'] = False
                parsed_data['inframe_overlap_pathogenic'] = False

                target_is_inframe = 'inframe' in parsed_data.get('consequence', '')

                if target_pos:
                    hotspot_variants = {}
                    for cv_hit in cv_resp.get('hits', []):
                        ann_full = cv_hit.get('snpeff', {}).get('ann', [])
                        if isinstance(ann_full, dict):
                            ann_full = [ann_full]

                        pos_rows = []
                        ann_iter = _anns_at_target_protein_pos(ann_full, target_pos)
                        if ann_iter:
                            for a in ann_iter:
                                pos_rows.append((a, _ann_protein_position(a)))
                        elif target_tx_base:
                            cv_pos, cv_p, _cv_c = _clinvar_hit_protein_on_user_transcript(
                                cv_hit, target_tx_base
                            )
                            if cv_pos is not None:
                                pos_rows.append((None, cv_pos, cv_p))
                        else:
                            chosen_ann = _pick_ann_for_target_tx(ann_full, target_pos)
                            if chosen_ann is not None:
                                pos_rows.append((chosen_ann, _ann_protein_position(chosen_ann)))

                        for row in pos_rows:
                            if len(row) == 3:
                                a, p_pos, clinvar_p = row[0], row[1], row[2]
                            else:
                                a, p_pos = row[0], row[1]
                                clinvar_p = ""
                            if p_pos is None:
                                continue
                            try:
                                p_pos = int(p_pos)
                            except (TypeError, ValueError):
                                continue

                            # Hotspot Density (+/- 5 AA threshold definition)
                            if abs(p_pos - target_pos) <= 5:
                                vid_val = cv_hit.get('clinvar', {}).get('variant_id', '')
                                if isinstance(vid_val, list) and len(vid_val) > 0: vid_val = vid_val[0]
                                vid_str = str(vid_val) or str(cv_hit.get('_id', ''))
                                if vid_str and vid_str not in hotspot_variants:
                                    if clinvar_p:
                                        h_hgvs = clinvar_p
                                    elif a:
                                        h_hgvs = a.get('hgvs_p', '')
                                        if ':' in h_hgvs:
                                            h_hgvs = h_hgvs.split(':')[1]
                                    else:
                                        h_hgvs = ''
                                    hotspot_variants[vid_str] = h_hgvs

                            if 'missense' in parsed_data.get('consequence', '') and p_pos == target_pos:
                                if clinvar_p:
                                    p_hgvs_p = clinvar_p
                                elif a:
                                    p_hgvs_p = a.get('hgvs_p', '')
                                    if ':' in p_hgvs_p:
                                        p_hgvs_p = p_hgvs_p.split(':')[-1]
                                else:
                                    p_hgvs_p = ''
                                if p_hgvs_p and (
                                    target_missense
                                    or target_aa_change
                                ):
                                    same_change = (
                                        _missense_same_aa_change(hgvs_p, p_hgvs_p)
                                        if target_missense
                                        else False
                                    )
                                    if not same_change and target_aa_change:
                                        p_match = re.search(
                                            r'p\.[a-zA-Z]{3}\d+([a-zA-Z]{3})', p_hgvs_p
                                        )
                                        if p_match:
                                            same_change = (
                                                p_match.group(1) == target_aa_change
                                            )
                                    diff_change = (
                                        _missense_same_codon_different_change(
                                            hgvs_p, p_hgvs_p
                                        )
                                        if target_missense
                                        else bool(
                                            p_hgvs_p
                                            and not same_change
                                        )
                                    )

                                    rcv_acc = ""
                                    rcv_data = cv_hit.get('clinvar', {}).get('rcv', [])
                                    if isinstance(rcv_data, dict):
                                        rcv_data = [rcv_data]
                                    if len(rcv_data) > 0:
                                        rcv_acc = rcv_data[0].get('accession', '')

                                    if same_change or diff_change:
                                        is_self_variant = False
                                        if rcv_acc and rcv_acc == parsed_data.get('clinvar_rcv'):
                                            is_self_variant = True
                                        if not is_self_variant:
                                            cv_coding = cv_hit.get('clinvar', {}).get('hgvs', {}).get('coding', [])
                                            if isinstance(cv_coding, str):
                                                cv_coding = [cv_coding]
                                            c_dot_raw = parsed_data.get('c_dot', '')
                                            c_match = re.search(
                                                r'c\.\d+[-+*]?\d*[a-zA-Z]>[a-zA-Z]', c_dot_raw
                                            )
                                            if c_match:
                                                c_dot_core = c_match.group(0).replace('c.', '')
                                            else:
                                                c_dot_core = c_dot_raw.replace('c.', '')
                                            for coding_str in cv_coding:
                                                if c_dot_core in coding_str:
                                                    is_self_variant = True
                                                    break

                                    if (same_change or diff_change) and not is_self_variant:
                                        if same_change:
                                            parsed_data['identical_pathogenic'] = True
                                            if rcv_acc:
                                                parsed_data['identical_pathogenic_rcv'] = rcv_acc
                                        elif diff_change and _clinvar_rcv_any_pathogenic_or_likely(rcv_data):
                                            parsed_data['different_pathogenic'] = True
                                            if rcv_acc:
                                                parsed_data['different_pathogenic_rcv'] = rcv_acc
                                            vid_val2 = cv_hit.get('clinvar', {}).get('variant_id', '')
                                            if vid_val2:
                                                if isinstance(vid_val2, list):
                                                    vid_val2 = vid_val2[0]
                                                parsed_data['different_pathogenic_details'] = {
                                                    "hgvs_p": p_hgvs_p,
                                                    "vid": str(vid_val2),
                                                }
                            if target_is_inframe and p_pos == target_pos:
                                parsed_data['inframe_overlap_pathogenic'] = True
                    
                    if len(hotspot_variants) >= 3:
                        parsed_data['internal_hotspot'] = hotspot_variants
                
                # Move block from here to outside
                
            except Exception as e:
                print(f"Predictive DB Auto-Lookup Error: {e}")

        # Collagen Gly-X-Y motif scan — COL missense/indels etc. (not in-frame exon skip)
        _col_anchor = locals().get('target_pos')
        _apply_collagen_motif_analysis(
            parsed_data,
            protein_anchor=_col_anchor,
            transcript_input=data.get('transcript', '').strip(),
        )

        # 4. Integrate splice logic and apply rules
        parsed_data['splice_row'] = splice_row
        parsed_data['splice_col'] = splice_col
        parsed_data['splice_points'] = splice_pts
        parsed_data['nmd_points'] = nmd_points
        current_csq = parsed_data.get('consequence', '')
        if current_csq not in ['nonsense', 'frameshift', 'start_lost']:
            is_truncating_splice = ('splice' in current_csq) and (parsed_data.get('splice_is_in_frame') is False)
            has_splice_ptc_metrics = bool(
                parsed_data.get('exon_skip_oof_ptc_aa')
                or parsed_data.get('junction_model_ptc_position')
                or parsed_data.get('is_splice_frameshift')
                or parsed_data.get('exon_skip_model_truncation_fraction') is not None
                or parsed_data.get('nmd_junction_model_truncation_fraction') is not None
            )
            if (
                not is_truncating_splice
                and not parsed_data.get('spliceai_junction_model_preferred')
                and not has_splice_ptc_metrics
            ):
                parsed_data['nmd_escape_truncation_fraction'] = 0.0
        
        # Convert hgvs_p to 1-letter amino acid codes for cleaner display
        if parsed_data.get('hgvs_p'):
            aa_map = {
                'Ala': 'A', 'Arg': 'R', 'Asn': 'N', 'Asp': 'D', 'Cys': 'C',
                'Gln': 'Q', 'Glu': 'E', 'Gly': 'G', 'His': 'H', 'Ile': 'I',
                'Leu': 'L', 'Lys': 'K', 'Met': 'M', 'Phe': 'F', 'Pro': 'P',
                'Ser': 'S', 'Thr': 'T', 'Trp': 'W', 'Tyr': 'Y', 'Val': 'V',
                'Ter': '*'
            }
            new_p = parsed_data['hgvs_p']
            for three, one in aa_map.items():
                new_p = new_p.replace(three, one)
            parsed_data['hgvs_p'] = new_p

        # External Search Links
        import urllib.parse
        gs_query = f'"{effective_gene}" "{c_dot}"'
        parsed_data['google_scholar_link'] = f'https://scholar.google.com/scholar?q={urllib.parse.quote(gs_query)}'
        # hgmd_link set after RefSeq synonym / HGMD resolution (prefers MANE c.)
        parsed_data['clinvar_search_link'] = f'https://www.ncbi.nlm.nih.gov/clinvar/?term={urllib.parse.quote(f"{effective_gene}[gene] AND {c_dot}")}'
        
        # ClinGen and GeneReviews Link logic — always use curator-entered gene symbol.
        # effective_gene can drift on ambiguous MyVariant/VEP loci (e.g. TRIM32 c.467
        # matching an ASTN2 ClinVar record at a different chr9 locus).
        clingen_gene = gene
        parsed_data['has_clingen'] = False
        parsed_data['clingen_link'] = (
            "https://search.clinicalgenome.org/kb/genes?page=1&size=50&search="
            + urllib.parse.quote(clingen_gene)
        )
        parsed_data['genereviews_link'] = f"https://www.ncbi.nlm.nih.gov/books/NBK1116/?term={urllib.parse.quote(clingen_gene)}"
        
        # Native Local ClinGen TSV Integration — gene presence vs haplo score are separate.
        _clingen_key, haplo_raw = clingen_gene_lookup(clingen_gene)
        if _clingen_key is not None:
            parsed_data['has_clingen'] = True
            haplo_score = str(haplo_raw or '').strip()
            parsed_data['clingen_haplo_score'] = haplo_score if haplo_score else 'N/A'
        else:
            parsed_data['has_clingen'] = False
            parsed_data['clingen_haplo_score'] = 'N/A'
        alternate_alleles = []
        vus_alternate_alleles = []
        splice_junction_alleles = []
        splice_junction_vus = []
        pm5_local_alleles = []
        same_protein_position_alleles = []
        regional_hotspot = []
        pos_match = re.search(r'[cnr]\.([0-9]+[+-]?[0-9]*)', c_dot, re.I)
        g_chrom = parsed_data.get('grch38_chrom', '').replace('chr', '')
        g_start = parsed_data.get('grch38_start')
        g_end = parsed_data.get('grch38_end')

        combined_hits = []
        hit_ids_seen = set()

        if g_chrom and g_start and g_end and _clinvar_vcf():
            all_vids = []
            try:
                # Provide a 15-bp genomic buffer to mathematically capture ClinVar INDELs that are natively left-aligned
                # along homopolymer arrays (e.g. c.2230del physically occupying position 11123260 instead of 11123263)
                fetch_start = max(0, int(g_start) - 15)
                fetch_end = int(g_end) + 15
                for rec in _clinvar_vcf().fetch(str(g_chrom), fetch_start, fetch_end):
                    vid = str(rec.id)
                    if vid != "None" and vid != str(parsed_data.get('clinvar_rcv', '')):
                        if vid not in all_vids:
                            all_vids.append(vid)
                            
                if all_vids and _clinvar_remote():
                    target_vids = all_vids[:80] # Protect URL length limits
                    q_str = " OR ".join([f"clinvar.variant_id:{v}" for v in target_vids])
                    alt_url = (
                        f"https://myvariant.info/v1/query?q={q_str}"
                        f"&fields={_MYVARIANT_LOCAL_ALLELE_FIELDS}&size=1000"
                    )
                    alt_resp = http_session.get(alt_url, timeout=20)
                    
                    if alt_resp.status_code == 200:
                        for h in alt_resp.json().get('hits', []):
                            oid = h.get('_id')
                            if oid and oid not in hit_ids_seen:
                                combined_hits.append(h)
                                hit_ids_seen.add(oid)
            except Exception as e:
                print(f"Error fetching Pysam-to-MyVariant tandem logic: {e}")

        # Fallback: local ClinVar VCF missing or returned no rows — same cDNA locus (other alleles) via MyVariant
        if _clinvar_remote() and pos_match and effective_gene:
            cpos_digits = pos_match.group(1).split('_')[0].split('+')[0].split('-')[0]
            if cpos_digits.isdigit():
                try:
                    fb_q = f'clinvar.gene.symbol:{effective_gene} AND clinvar.hgvs.coding:*{cpos_digits}*'
                    fb_url = (
                        f"https://myvariant.info/v1/query?q={fb_q}"
                        f"&fields={_MYVARIANT_LOCAL_ALLELE_FIELDS}&size=1000"
                    )
                    fb_resp = http_session.get(fb_url, timeout=20)
                    if fb_resp.status_code == 200:
                        for h in fb_resp.json().get('hits', []):
                            oid = h.get('_id')
                            if oid and oid not in hit_ids_seen:
                                combined_hits.append(h)
                                hit_ids_seen.add(oid)
                except Exception as e:
                    print(f"Alternate allele MyVariant locus fallback error: {e}")

        target_p_anchor = _protein_position_from_hgvs_p(parsed_data.get('hgvs_p', ''))
        if not target_p_anchor:
            try:
                target_p_anchor = int(parsed_data.get('protein_start'))
            except (TypeError, ValueError):
                target_p_anchor = None
        strict_tx_base = _resolve_user_transcript_base(parsed_data, target_transcript)
        if strict_tx_base:
            parsed_data['transcript'] = strict_tx_base

        _sj_locus = _resolve_splice_junction_locus(c_dot, parsed_data)
        _allele_fetchers = []
        if target_p_anchor and effective_gene and strict_tx_base:
            # Primary: ClinVar coding names on the curator's NM (snpeff often missing).
            _allele_fetchers.append(
                lambda eg=effective_gene, tx=strict_tx_base: (
                    _fetch_myvariant_plp_hits_on_transcript_coding(http_session, eg, tx)
                )
            )
            _allele_fetchers.append(
                lambda eg=effective_gene, tx=strict_tx_base, aa=target_p_anchor: (
                    _fetch_myvariant_hits_at_protein_position(http_session, eg, tx, aa)
                )
            )
        if _sj_locus and effective_gene:
            _allele_fetchers.append(
                lambda eg=effective_gene, cd=c_dot, loc=_sj_locus: (
                    _fetch_myvariant_hits_at_splice_junction(http_session, eg, cd, loc)
                )
            )
        if _allele_fetchers:
            try:
                with concurrent.futures.ThreadPoolExecutor(
                    max_workers=min(4, len(_allele_fetchers))
                ) as _ex:
                    _futs = [_ex.submit(fn) for fn in _allele_fetchers]
                    for _fut in concurrent.futures.as_completed(_futs):
                        try:
                            _hits = _fut.result() or []
                        except Exception as _af_err:
                            print(f"Allelic MyVariant parallel fetch error: {_af_err}")
                            continue
                        for h in _hits:
                            oid = h.get('_id')
                            if oid and oid not in hit_ids_seen:
                                combined_hits.append(h)
                                hit_ids_seen.add(oid)
            except Exception as _par_err:
                print(f"Allelic MyVariant parallel pool error: {_par_err}")

        user_c_anchor = None
        if pos_match:
            user_c_anchor = pos_match.group(1).split('_')[0].split('+')[0].split('-')[0]

        _populate_local_allele_lists_from_hits(
            combined_hits, parsed_data, strict_tx_base, target_p_anchor,
            user_c_anchor, pos_match, g_chrom,
            alternate_alleles, vus_alternate_alleles, same_protein_position_alleles,
            pm5_local_alleles, regional_hotspot,
            splice_junction_alleles, splice_junction_vus,
        )

        # Mandatory second pass: same amino-acid index on user's NM (e.g. c.532 p.T178A vs c.533 p.T178S).
        if (
            'missense' in parsed_data.get('consequence', '')
            and target_p_anchor
            and strict_tx_base
            and effective_gene
        ):
            sp_hits = [
                h for h in _fetch_myvariant_plp_hits_on_transcript_coding(
                    http_session, effective_gene, strict_tx_base
                )
                if _clinvar_hit_protein_on_user_transcript(h, strict_tx_base)[0]
                == int(target_p_anchor)
            ]
            sp_hits.extend(
                _fetch_myvariant_hits_at_protein_position(
                    http_session, effective_gene, strict_tx_base, target_p_anchor
                )
            )
            seen_sp = set()
            sp_unique = []
            for h in sp_hits:
                oid = h.get("_id")
                if oid and oid in seen_sp:
                    continue
                if oid:
                    seen_sp.add(oid)
                sp_unique.append(h)
            _populate_local_allele_lists_from_hits(
                sp_unique, parsed_data, strict_tx_base, target_p_anchor,
                user_c_anchor, pos_match, g_chrom,
                alternate_alleles, vus_alternate_alleles, same_protein_position_alleles,
                pm5_local_alleles, regional_hotspot,
                splice_junction_alleles, splice_junction_vus,
            )

        parsed_data['alternate_alleles'] = alternate_alleles
        parsed_data['vus_alternate_alleles'] = vus_alternate_alleles
        parsed_data['splice_junction_alleles'] = splice_junction_alleles
        parsed_data['splice_junction_vus_alleles'] = splice_junction_vus
        if splice_junction_alleles and _resolve_splice_junction_locus(c_dot, parsed_data):
            best = splice_junction_alleles[0]
            parsed_data['different_pathogenic'] = True
            parsed_data['different_pathogenic_details'] = {
                'hgvs_c': best.get('hgvs_c') or '',
                'hgvs_p': best.get('hgvs_p') or '',
                'vid': best.get('vid') or '',
                'significance': best.get('significance') or '',
            }
            if best.get('vid'):
                parsed_data['different_pathogenic_rcv'] = str(best.get('vid'))
        parsed_data['pm5_local_alleles'] = pm5_local_alleles
        parsed_data['same_protein_position_alleles'] = same_protein_position_alleles
        parsed_data['regional_hotspot'] = regional_hotspot
        _finalize_local_allele_scan_metadata(
            parsed_data, effective_gene, strict_tx_base, combined_hits, target_p_anchor
        )
        iso_tx = strict_tx_base or _resolve_user_transcript_base(
            parsed_data, target_transcript
        )
        # Alternate-transcript HGVS list is only consumed by literature PDF search.
        # Standalone / Gemini-off skips that step — avoid the extra MyVariant round-trip.
        if client:
            parsed_data["alternate_transcript_literature"] = (
                _populate_alternate_transcript_literature_for_curated_variant(
                    http_session, parsed_data, iso_tx,
                )
            )
        else:
            parsed_data["alternate_transcript_literature"] = []
        _c_dot_core = (c_dot or "").strip()
        if re.search(
            r"[cnr]\.\d+(?:_\d+)?(?:dup|del|ins|delins)\b",
            _c_dot_core,
            re.I,
        ):
            c_search_term = f"{effective_gene}[gene] AND {_c_dot_core}"
        elif re.search(r"[cnr]\.", _c_dot_core, re.I):
            c_search_term = f"{effective_gene}[gene] AND {_c_dot_core}"
        elif pos_match:
            c_search_term = f"{effective_gene}[gene] AND c.{pos_match.group(1)}"
        else:
            c_search_term = ""
        p_search_term = ""
        if parsed_data.get('hgvs_p'):
            p_sub = _parse_missense_substitution_hgvs_p(parsed_data.get('hgvs_p'))
            if p_sub:
                p_search_term = (
                    f"{effective_gene}[gene] AND p.{p_sub['ref_3']}{p_sub['pos']}{p_sub['alt_3']}"
                )
            else:
                p_match_search = re.search(r'p\.([a-zA-Z]{3}\d+)', parsed_data.get('hgvs_p'))
                if not p_match_search:
                    p_match_search = re.search(r'p\.([A-Z]\d+[A-Z])', parsed_data.get('hgvs_p'))
                if p_match_search:
                    p_search_term = f"{effective_gene}[gene] AND p.{p_match_search.group(1)}"
        
        vid_val = parsed_data.get('clinvar_rcv', '')
        if vid_val and str(vid_val).isdigit():
            if c_search_term:
                c_search_term += f" NOT {vid_val}[VariationID]"
            if p_search_term:
                p_search_term += f" NOT {vid_val}[VariationID]"
                
        parsed_data['c_allele_search_link'] = f"https://www.ncbi.nlm.nih.gov/clinvar/?term={urllib.parse.quote(c_search_term)}" if c_search_term else ""
        parsed_data['p_allele_search_link'] = f"https://www.ncbi.nlm.nih.gov/clinvar/?term={urllib.parse.quote(p_search_term)}" if p_search_term else parsed_data['c_allele_search_link']

        apply_local_gnomad(parsed_data)

        if noncoding_track:
            try:
                apply_noncoding_curation_pack(
                    parsed_data,
                    gene=effective_gene,
                    c_dot=c_dot,
                    transcript=target_transcript or "",
                    global_vcf=_clinvar_vcf(),
                )
            except Exception as _nc_err:
                print(f"Noncoding curation pack error: {_nc_err}")

        _ensure_user_nm_on_refseq_synonyms(parsed_data, target_transcript, c_dot)
        if target_transcript and target_transcript.upper().startswith(("NM_", "NR_")):
            if len(parsed_data.get("refseq_nm_synonyms") or []) < 2:
                _sup_syn = _fetch_vep_refseq_synonyms_supplemental(
                    http_session, target_transcript, c_dot
                )
                _merge_into_parsed_refseq_synonyms(parsed_data, _sup_syn)
            _ensure_user_nm_on_refseq_synonyms(parsed_data, target_transcript, c_dot)

        # Local HGMD Map Resolution
        # Candidate keys include ClinVar/VEP RefSeq isoform synonyms (e.g. DTNA
        # NM_001386795 c.1651_1671del ↔ NM_001390 c.1570_1590del) and normalize
        # HGMD length/base suffixes (1570_1590del21 ↔ c.1570_1590del).
        parsed_data['hgmd_local'] = "HGMD: Not Found"
        parsed_data['hgmd_excel_pmids'] = []
        _hgmd_matched_key = None
        try:
            hgmd_candidate_keys = _hgmd_ordered_candidate_keys(
                effective_gene.upper(), c_dot, parsed_data
            )
            for hgmd_key in hgmd_candidate_keys:
                if hgmd_key in GLOBAL_HGMD:
                    parsed_data['hgmd_local'] = GLOBAL_HGMD[hgmd_key]
                    parsed_data['hgmd_excel_pmids'] = list(GLOBAL_HGMD_PMIDS.get(hgmd_key, []))
                    _hgmd_matched_key = hgmd_key
                    break
        except Exception as hgmd_err:
            print(f"HGMD Index Collision Error: {hgmd_err}")

        _hgmd_mut_q = c_dot
        for _p in parsed_data.get("refseq_nm_synonyms") or []:
            if (_p.get("mane_select") or "").strip() and (_p.get("hgvs_c") or "").strip():
                _hgmd_mut_q = _p["hgvs_c"]
                break
        # Prefer the c. form that actually hit the spreadsheet (isoform synonym /
        # short del) so the Classic HGMD link lands on the curated row.
        if _hgmd_matched_key:
            _pref = f"{effective_gene.upper()}_"
            if _hgmd_matched_key.startswith(_pref):
                _hit_form = _hgmd_matched_key[len(_pref):]
                if _hit_form and not _hit_form.lower().startswith("c.") and _hit_form[0].isdigit():
                    _hit_form = f"c.{_hit_form}"
                if _hit_form:
                    _hgmd_mut_q = _hit_form
        parsed_data["hgmd_preferred_c_dot"] = _hgmd_mut_q
        parsed_data['hgmd_link'] = (
            f'https://www.hgmd.cf.ac.uk/ac/gene.php?gene={effective_gene}'
            f'&mutation={urllib.parse.quote(_hgmd_mut_q)}'
        )

        # Local Literature Index (supplement cohorts) — mutation search + HGMD PMID overlap
        try:
            parsed_data["literature_index"] = search_lit_index(
                effective_gene,
                c_dot,
                hgvs_p=(parsed_data.get("hgvs_p") or "").strip(),
                hgmd_pmids=parsed_data.get("hgmd_excel_pmids") or [],
            )
        except Exception as lit_idx_err:
            print(f"[lit_index] search failed: {lit_idx_err}", flush=True)
            parsed_data["literature_index"] = {
                "available": False,
                "hit_count": 0,
                "papers": [],
                "pmids": [],
                "hgmd_overlap_pmids": [],
                "message": str(lit_idx_err)[:200],
            }

        parsed_data['deep_intronic_splice'] = {'eligible': False}
        parsed_data['deep_intronic_splice_html'] = ''
        if not noncoding_track:
            try:
                di = compute_deep_intronic_splice_math(http_session, parsed_data, c_dot)
                parsed_data['deep_intronic_splice'] = di
                if di.get('eligible') and di.get('summary_html'):
                    parsed_data['deep_intronic_splice_html'] = di['summary_html']
                try:
                    _ensure_coding_exons_for_splice_viz(parsed_data, http_session)
                    _ensure_cds_seq(parsed_data, http_session)
                    compute_deep_intronic_spliceai_products(http_session, parsed_data, c_dot, di)
                    refresh_pre_atg_deep_intronic_readouts(parsed_data)
                except Exception as dip_err:
                    print(f"Deep intronic SpliceAI product math error: {dip_err}")
            except Exception as di_err:
                parsed_data['deep_intronic_splice'] = {'eligible': False, 'reason': str(di_err)}
                print(f"Deep intronic splice math error: {di_err}")
        else:
            parsed_data['deep_intronic_splice'] = {
                'eligible': False,
                'reason': 'Skipped for noncoding (n./NR_) track',
            }

        if parsed_data.get('dup_baseline_needs_3prime_plp'):
            _lookup_clinvar_plp_downstream_of_ptc(http_session, parsed_data, effective_gene)

        # Ensure mRNA exon numbering for all variants (missense, etc.), not only splice consequences.
        try:
            _finalize_exon_display_fields(parsed_data, c_dot)
        except Exception as _ex_reconcile_err:
            print(f"[exon numbering] reconcile failure: {_ex_reconcile_err}")

        sync_truncation_fraction_from_ptc(parsed_data)

        if not noncoding_track:
            _apply_uniprot_domain_lookup(http_session, parsed_data, effective_gene)
            try:
                apply_metadome_missense_lookup(http_session, parsed_data, effective_gene)
            except Exception as _md_err:
                print(f"MetaDome lookup error: {_md_err}")
                parsed_data["metadome_checked"] = True
                parsed_data["metadome_status"] = "error"
                parsed_data["metadome_error"] = str(_md_err)[:200]
        else:
            parsed_data['uniprot_domain_checked'] = True
            parsed_data['uniprot_domains_of_interest'] = []
            parsed_data['uniprot_skip_reason'] = 'noncoding_track'
            parsed_data['metadome_checked'] = True
            parsed_data['metadome_status'] = 'skipped'
            parsed_data['metadome_skip_reason'] = 'noncoding_track'

        # UniProt / RefSeq may have filled protein_length after the early NMD block.
        # Backfill PTC % and last-exon NMD when those steps ran with length=0 / no ENST.
        try:
            _ensure_protein_length_from_coding_exons(parsed_data)
            ensure_truncation_fraction_from_stop(parsed_data)
            if (
                parsed_data.get("consequence") in ("nonsense", "frameshift")
                and not parsed_data.get("nmd_decision_basis")
            ):
                _ensure_coding_exons_for_splice_viz(parsed_data, http_session)
                _cds = parsed_data.get("snpeff_cds_pos") or 0
                try:
                    _cds = int(_cds or 0)
                except (TypeError, ValueError):
                    _cds = 0
                if _cds <= 0:
                    _cm = re.search(r"c\.([0-9]+)", str(c_dot or ""), re.I)
                    if _cm:
                        _cds = int(_cm.group(1))
                if _cds > 0:
                    # Prefer ENST map when NM was the only id at early NMD time.
                    if not str(parsed_data.get("ensembl_transcript_id") or "").startswith("ENST"):
                        _resolve_ensembl_transcript_id(http_session, parsed_data)
                    apply_nmd_escape_from_coding_exons(parsed_data, _cds)
            # OOF whole-exon skip often ran before UniProt/CDS length was known.
            if parsed_data.get("splice_is_in_frame") is False:
                parsed_data["is_splice_frameshift"] = True
                try:
                    _pl = int(parsed_data.get("protein_length") or 0)
                except (TypeError, ValueError):
                    _pl = 0
                try:
                    _fl = float(parsed_data.get("splice_fraction_lost") or 0)
                except (TypeError, ValueError):
                    _fl = 0.0
                if _pl > 0 and _fl <= 0:
                    try:
                        _ts = int(parsed_data.get("splice_target_start_cds") or 0)
                        _te = int(parsed_data.get("splice_target_end_cds") or 0)
                    except (TypeError, ValueError):
                        _ts = _te = 0
                    if _te >= _ts > 0:
                        _aa = (_te - _ts + 1) // 3
                        _mark_oof_exon_skip_nmd_provisional(
                            parsed_data,
                            aa_lost=_aa,
                            ptc_unresolved=not bool(parsed_data.get("exon_skip_oof_ptc_aa")),
                        )
                if not parsed_data.get("exon_skip_oof_ptc_aa"):
                    _cds_retry = _ensure_cds_seq(parsed_data, http_session) or ""
                    try:
                        _ts = int(parsed_data.get("splice_target_start_cds") or 0)
                        _te = int(parsed_data.get("splice_target_end_cds") or 0)
                    except (TypeError, ValueError):
                        _ts = _te = 0
                    _ce = parsed_data.get("coding_exons") or []
                    _enst = (parsed_data.get("ensembl_transcript_id") or "").strip()
                    if _cds_retry and _ts > 0 and _te >= _ts and _ce:
                        try:
                            _ptc_s, _oof = _oofs_exon_skip_ptc_cds_and_cdna(
                                http_session, _enst, _cds_retry, _ts, _te, _ce, _pl
                            )
                            for _k, _v in (_oof or {}).items():
                                if _v is not None:
                                    parsed_data[_k] = _v
                            if _ptc_s and "Sequence Timeout" in str(
                                parsed_data.get("splice_frame_math_exon_skip_ref") or ""
                            ):
                                _ref = str(parsed_data.get("splice_frame_math_exon_skip_ref") or "")
                                parsed_data["splice_frame_math_exon_skip_ref"] = _ref.replace(
                                    " -> Sequence Timeout (PTC Unresolved)", _ptc_s
                                )
                        except Exception as _oof_retry_err:
                            print(f"[oof skip PTC retry] {_oof_retry_err}")
                    elif not (parsed_data.get("nmd_decision_basis") or "").strip():
                        _mark_oof_exon_skip_nmd_provisional(
                            parsed_data,
                            fraction_lost=parsed_data.get("splice_fraction_lost"),
                            ptc_unresolved=True,
                        )
                _apply_exon_skip_truncation_as_primary(parsed_data)
            sync_truncation_fraction_from_ptc(parsed_data)
        except Exception as _nmd_backfill_err:
            print(f"[nmd/ptc backfill] {_nmd_backfill_err}")

        # Universal Logic Explanation Generator
        try:
            csq = parsed_data.get('consequence', '')
            if not _logic_csq_is_splice_context(csq, parsed_data):
                parsed_data['spliceai_narrative'] = ''
            is_trunc = (
                csq in ['nonsense', 'frameshift']
                or (
                    parsed_data.get('is_splice_frameshift')
                    and not parsed_data.get('cryptic_gain_outcome')
                )
            )
            is_start_loss = csq == 'start_lost'
            is_nmd_escape = parsed_data.get('nmd_escape', False)
            trunc_frac = sync_truncation_fraction_from_ptc(parsed_data)
            
            if is_trunc or is_start_loss:
                sections = []
                _append_clingen_logic_section(sections, parsed_data, effective_gene)
                _di_products = bool(parsed_data.get('deep_intronic_splice_products_active'))

                part1 = f"{effective_gene} {c_dot} "
                if _di_products and not is_start_loss:
                    target_exon = parsed_data.get('variant_exon', '?')
                    _di_pri_m = (parsed_data.get('deep_intronic_viz_primary') or {}).get('mechanism')
                    if _di_pri_m == 'acceptor_gain':
                        part1 = (
                            f"{effective_gene} {c_dot} is a <b>deep intronic</b> variant in the intron "
                            f"upstream of coding exon {target_exon} (acceptor-side, c.N−). SpliceAI predicts a "
                            f"<b>primary acceptor-gain</b> pseudo-exon product and optional alternate "
                            f"geometries below (computational; not RNA-confirmed)."
                        )
                    else:
                        _alt_note = (
                            'two acceptor-gain alternates (2a canonical, 2b decoy)'
                            if parsed_data.get('deep_intronic_alternate2_splice_math')
                            else 'an alternate acceptor-gain model'
                        )
                        part1 = (
                            f"{effective_gene} {c_dot} is a <b>deep intronic</b> variant downstream of coding "
                            f"exon {target_exon}. SpliceAI predicts distinct splice products at separate intronic "
                            f"offsets: a <b>primary donor-gain</b> pseudo-exon product and {_alt_note} "
                            f"(computational models below; not RNA-confirmed)."
                        )
                elif is_start_loss:
                    part1 = _build_lof_variant_intro(
                        parsed_data, effective_gene, c_dot, csq, True, is_trunc
                    )
                elif not _di_products:
                    part1 = _build_lof_variant_intro(
                        parsed_data, effective_gene, c_dot, csq, False, is_trunc
                    )
                if parsed_data.get("splice_site_overlap_secondary"):
                    note = (
                        " Variant overlaps a splice acceptor/donor region; "
                        "direct exonic frameshift → PTC is the primary LOF model "
                        "(splice disruption is secondary unless RNA data show otherwise)."
                    )
                    if note.strip() not in part1:
                        part1 = part1.rstrip(".") + "." + note
                sections.append(("The Variant", part1))
                if parsed_data.get('legacy_exon_label'):
                    sections.append((
                        "Exon-numbering note",
                        f"This variant is also referenced under legacy nomenclature as <b>{parsed_data['legacy_exon_label']}</b>. "
                        f"The exon number above follows the modern MANE/RefSeq transcript model (which counts every exon, including 5′-UTR-only exons); the legacy literature/clinical labs may number exons differently."
                    ))

                _append_truncation_nmd_sections(
                    sections, parsed_data, effective_gene, csq,
                    is_trunc, is_start_loss, is_nmd_escape, trunc_frac,
                )

                _append_splice_product_logic_sections(sections, parsed_data)

                if 'splice_deleted_coords' in parsed_data and parsed_data.get('skipped_exon_plp_checked'):
                    _append_splice_support_sections(sections, parsed_data, effective_gene)
                elif parsed_data.get('auto_downstream_pathogenic'):
                    _append_splice_support_sections(sections, parsed_data, effective_gene, skip_deleted_exon=True)

                _append_nmd_escape_clinical_context(
                    sections, parsed_data, trunc_frac, is_start_loss, is_trunc,
                )

                _append_uniprot_domain_logic_section(sections, parsed_data)
                append_metadome_logic_section(sections, parsed_data)
                _append_allelic_context_logic_sections(sections, parsed_data)
                append_noncoding_curation_logic_section(sections, parsed_data)
                _append_clinical_overlap_sections(sections, parsed_data)

                if _logic_should_show_deep_intronic_context(parsed_data, c_dot):
                    sections.append(("Deep intronic splice context", parsed_data['deep_intronic_splice']['summary_html']))

                if parsed_data.get('inframe_coding_outcome'):
                    _append_inframe_coding_logic_section(sections, parsed_data)

                if _should_show_spliceai_narrative_in_logic(parsed_data, csq):
                    sections.append(("Computational splicing (SpliceAI)", parsed_data['spliceai_narrative']))

                _finalize_logic_explanation(parsed_data, sections)

            else:
                sections = []
                _append_clingen_logic_section(sections, parsed_data, effective_gene)
                target_exon = parsed_data.get('variant_exon') or parsed_data.get('snpeff_exon_rank', '?')
                hgvs_p = parsed_data.get('hgvs_p', '?')
                csq_display = csq.replace('_', ' ')
                
                if _logic_csq_is_splice_context(csq, parsed_data):
                    # Adaptive intro: the legacy "in-frame preservation / avoids the
                    # severe truncation pathway" sentence is correct ONLY for the
                    # exon-skip default path when the skip is a clean multiple of 3 and
                    # there is no competing/cryptic-gain readout. For competing,
                    # cryptic-gain primary, or natural-stop-preserved variants we
                    # describe what the splice analysis actually found so the intro
                    # doesn't contradict the Splice Structural Math block below.
                    _short_intro = _build_splice_variant_intro_short(
                        parsed_data, effective_gene, c_dot,
                    )
                    if _short_intro:
                        _intro_base = _short_intro
                    else:
                        _intro_base = (
                            f"{effective_gene} {c_dot} → "
                            f"{_logic_indefinite_article(csq_display)} {csq_display} at exon {target_exon}"
                        )
                        _hp_intro = (hgvs_p or '').strip()
                        if _hp_intro and _hp_intro not in ('?', ''):
                            _intro_base += f" ({_hp_intro})"
                        _intro_base += "."
                    if _splice_variant_intro_is_complete(parsed_data):
                        _intro_tail = ''
                    elif parsed_data.get('cryptic_natural_stop_preserved'):
                        _stop_aa = parsed_data.get('cryptic_preserved_stop_aa_pos')
                        _stop_bit = f" at p.Ter{_stop_aa}" if _stop_aa else ""
                        _intro_tail = (
                            f" The cryptic-splice resolver shows an <b>in-frame</b> insertion that <b>preserves the native terminator</b>"
                            f"{_stop_bit}, so this is a small in-frame protein-length change rather than a loss-of-function truncation; NMD does not apply."
                        )
                    elif parsed_data.get('spliceai_competing_splice_isoforms'):
                        _ag_c, _al_c, _dg_c, _dl_c = _spliceai_scores_4(parsed_data)
                        _is_don_c = _consequence_is_donor_splice(
                            parsed_data.get('consequence', '') or '', parsed_data.get('c_dot', '') or ''
                        )
                        _is_acc_c = _consequence_is_acceptor_splice(
                            parsed_data.get('consequence', '') or '', parsed_data.get('c_dot', '') or ''
                        )
                        if _is_don_c and not _is_acc_c:
                            _intro_tail = (
                                f" SpliceAI predicts competing <b>donor gain</b> (DS_DG {_dg_c:.2f}) and "
                                f"<b>donor loss / exon skip</b> (DS_DL {_dl_c:.2f}); both products are below."
                            )
                        elif _is_acc_c and not _is_don_c:
                            _intro_tail = (
                                f" SpliceAI predicts competing <b>acceptor gain</b> (DS_AG {_ag_c:.2f}) and "
                                f"<b>acceptor loss / exon skip</b> (DS_AL {_al_c:.2f}); both products are below."
                            )
                        else:
                            _intro_tail = (
                                " SpliceAI predicts competing gain and loss at this splice site; "
                                "both products are below."
                            )
                    elif parsed_data.get('deep_intronic_splice_products_active'):
                        _plan = parsed_data.get('deep_intronic_spliceai_signal_plan') or {}
                        _pri_l = _deep_intronic_signal_label(_plan.get('primary') or {})
                        _alt_l = _deep_intronic_signal_label(_plan.get('alternate') or {})
                        _bits = [b for b in (_pri_l, _alt_l) if b]
                        if _bits:
                            _intro_tail = (
                                f" Deep intronic variant. SpliceAI primary: {_bits[0]}; "
                                f"alternate: {_bits[1] if len(_bits) > 1 else 'see below'}."
                            )
                        else:
                            _intro_tail = (
                                " Deep intronic variant with SpliceAI-qualified splice products at distinct offsets."
                            )
                    elif parsed_data.get('cryptic_gain_outcome') and not (
                        _consequence_is_acceptor_splice(
                            parsed_data.get('consequence', '') or '', parsed_data.get('c_dot', '') or ''
                        )
                        or _consequence_is_donor_splice(
                            parsed_data.get('consequence', '') or '', parsed_data.get('c_dot', '') or ''
                        )
                    ):
                        _cg = parsed_data['cryptic_gain_outcome']
                        try:
                            _cg_sc = float(_cg.get('gain_score') or 0)
                        except (TypeError, ValueError):
                            _cg_sc = 0.0
                        _cg_dp = _cg.get('dp_offset')
                        _dp_s = f", Δ{int(_cg_dp):+d} bp" if _cg_dp is not None else ""
                        _intro_tail = (
                            f" SpliceAI predicts exon-internal <b>{_cg.get('cryptic_type', 'cryptic gain').lower()}</b> "
                            f"(DS {_cg_sc:.2f}{_dp_s}); splice product below."
                        )
                    elif parsed_data.get('spliceai_junction_model_preferred'):
                        _intro_tail = (
                            " The dominant computational readout is <b>cryptic gain</b> (junction-shift); "
                            "whole-exon skip is retained as a parallel baseline under <b>Splice Structural Math</b>."
                        )
                    else:
                        # Default exon-skip path (no competing block, no junction-primary):
                        # still call out when DS_AL (or DS_DL) clearly exceeds the gain term so
                        # the reader does not assume cryptic gain is the main story (e.g. KITLG
                        # c.715-2A>C with a high acceptor-loss score and a modest gain score).
                        _ag2, _al2, _dg2, _dl2 = _spliceai_scores_4(parsed_data)
                        _acc2 = _consequence_is_acceptor_splice(
                            parsed_data.get('consequence', '') or '', parsed_data.get('c_dot', '') or ''
                        )
                        _don2 = _consequence_is_donor_splice(
                            parsed_data.get('consequence', '') or '', parsed_data.get('c_dot', '') or ''
                        )
                        _loss_lead = ""
                        if _acc2 and _al2 > _ag2 + 0.01 and _al2 >= SPLICEAI_RECONCILE_MIN:
                            _loss_lead = (
                                " SpliceAI's numerically largest delta is <b>acceptor loss</b> (DS_AL) relative to acceptor gain — canonical site ablation / "
                                "whole-exon skip is often the primary LOF model for a 3&prime; splice acceptor variant. "
                            )
                        elif _don2 and _dl2 > _dg2 + 0.01 and _dl2 >= SPLICEAI_RECONCILE_MIN:
                            _loss_lead = (
                                " SpliceAI's numerically largest delta is <b>donor loss</b> (DS_DL) relative to donor gain — canonical site ablation / "
                                "whole-exon skip is often the primary LOF model for a 5&prime; splice donor variant. "
                            )
                        _si = parsed_data.get('splice_is_in_frame')
                        if _si is False:
                            _intro_tail = _loss_lead + (
                                " The predicted <b>whole-exon-skip</b> product is <b>out-of-frame</b>, so the re-read ORF is expected to encounter a "
                                "<b>premature termination codon</b> downstream of the splice junction (see splice products below), "
                                "not a benign in-frame deletion."
                            )
                        else:
                            _intro_tail = _loss_lead + (
                                " SpliceAI predicts an <b>in-frame whole-exon skip</b> as the primary "
                                "loss product (details below)."
                            )
                    sections.append(("The Variant", _intro_base + _intro_tail))
                    if parsed_data.get('legacy_exon_label'):
                        sections.append((
                            "Exon-numbering note",
                            f"Also referenced under legacy nomenclature as <b>{parsed_data['legacy_exon_label']}</b>. "
                            f"The exon number above follows the modern MANE/RefSeq transcript model (which counts every exon, including 5′-UTR-only exons); legacy clinical literature may number exons differently."
                        ))

                    if 'splice_deleted_coords' in parsed_data and parsed_data.get('skipped_exon_plp_checked'):
                        _append_splice_support_sections(sections, parsed_data, effective_gene)
                    elif parsed_data.get('auto_downstream_pathogenic'):
                        _append_splice_support_sections(sections, parsed_data, effective_gene, skip_deleted_exon=True)
                else:
                    _var_intro = _build_generic_variant_intro(
                        effective_gene, c_dot, csq_display, target_exon, hgvs_p,
                    )
                    _cg_intro = parsed_data.get('cryptic_gain_outcome') or {}
                    if _cg_intro.get('deleted_nt') and not _logic_csq_is_splice_context(csq, parsed_data):
                        try:
                            _cg_sc = float(_cg_intro.get('gain_score') or 0)
                        except (TypeError, ValueError):
                            _cg_sc = 0.0
                        _cg_dp = _cg_intro.get('dp_offset')
                        _cg_ct = (_cg_intro.get('cryptic_type') or 'cryptic gain').lower()
                        _dp_s = f"Δ{int(_cg_dp):+d} bp" if _cg_dp is not None else "see map"
                        _var_intro = (
                            _var_intro.rstrip('.')
                            + f". SpliceAI predicts exon-internal <b>{_cg_ct}</b> "
                            f"(DS {_cg_sc:.2f}, {_dp_s}); splice product below."
                        )
                    sections.append(("The Variant", _var_intro))
                    if parsed_data.get('legacy_exon_label'):
                        sections.append((
                            "Exon-numbering note",
                            f"Also referenced under legacy nomenclature as <b>{parsed_data['legacy_exon_label']}</b>. "
                            f"The exon number above follows the modern MANE/RefSeq transcript model (which counts every exon, including 5′-UTR-only exons); legacy clinical literature may number exons differently."
                        ))

                _append_collagen_logic_section(sections, parsed_data)
                _append_inframe_coding_logic_section(sections, parsed_data)
                _append_clinical_overlap_sections(sections, parsed_data)
                _append_uniprot_domain_logic_section(sections, parsed_data)
                append_metadome_logic_section(sections, parsed_data)
                _append_allelic_context_logic_sections(sections, parsed_data)
                append_noncoding_curation_logic_section(sections, parsed_data)

                _append_splice_product_logic_sections(sections, parsed_data)

                if _logic_should_show_deep_intronic_context(parsed_data, c_dot):
                    sections.append(("Deep intronic splice context", parsed_data['deep_intronic_splice']['summary_html']))

                if _should_show_spliceai_narrative_in_logic(parsed_data, csq):
                    sections.append(("Computational splicing (SpliceAI)", parsed_data['spliceai_narrative']))

                _finalize_logic_explanation(parsed_data, sections)

        except Exception as e:
            print(f"Logic Builder Error: {e}")

        apply_local_gnomad(parsed_data)
        results_custom = apply_rubric(parsed_data)
        results_acmg = apply_acmg(parsed_data)
        
        # Print unified checkpoint tracer directly to the terminal stdout for backend observability
        print(f"\n=======================================")
        print(f"  PIPELINE TRACE: {effective_gene} {c_dot}")
        print(f"=======================================")
        print(f" [✓] Initialized Base Sequence Map")
        csq = parsed_data.get('consequence', 'unknown')
        print(f" [{'✓' if csq and csq != 'unknown' else 'x'}] Retrieved Variant Consequence: {csq}")
        vex = parsed_data.get('variant_exon')
        ent = parsed_data.get('nmd_exon_total') or parsed_data.get('snpeff_exon_total', '?')
        print(f" [{'✓' if vex else '-'}] Validated Structural Exon Boundary: Exon {vex or '?'}/{ent}")
        trunc = parsed_data.get('nmd_escape_truncation_fraction') or parsed_data.get('splice_fraction_lost')
        print(f" [{'✓' if trunc else '-'}] Simulated Amino Acid Truncation Geometry")
        print(f" [{'✓' if parsed_data.get('cadd') or parsed_data.get('revel') or 'splice' in csq else '-'}] Requested Deep-Learning Server AI (CADD/REVEL/SpliceAI)")
        print(f" [✓] Cross-Referenced External Databases (ClinVar/Pangolin/UniProt/HGMD)")
        print(f" [✓] Initiated Autonomous Literature & Functional Sweeps (EuropePMC)")
        print(f" [✓] Evaluated Gene Mechanism Attributes (ClinGen/GeneReviews/EuropePMC)")
        acmg_label = (results_acmg.get("classification") or {}).get("label", "Unknown")
        inst_note = (
            f"institutional score {results_custom.get('total')} ({(results_custom.get('classification') or {}).get('label', 'n/a')})"
            if results_custom.get("enabled")
            else "institutional scoring off"
        )
        print(f" [✓] Finalized ACMG: {acmg_label} ({inst_note})")
        print(f"=======================================\n")
        
        # Late catch-up: maps need coding_exons; if the mid-pipeline Ensembl fetch
        # failed, hydrate + ClinVar skip scan must run again before panels build.
        try:
            _ensure_skipped_exon_interval_and_plp_scan(parsed_data, effective_gene, http_session)
        except Exception as _skip_late_err:
            print(f"late skipped-exon PLP hydrate: {_skip_late_err}")

        try:
            parsed_data['splice_products_panel_html'] = _build_splice_products_panel_html(parsed_data)
        except Exception as _spp_err:
            print(f"splice_products_panel: {_spp_err}")
            parsed_data['splice_products_panel_html'] = ''

        try:
            _ensure_coding_exons_for_splice_viz(parsed_data)
            _ensure_cds_seq(parsed_data, http_session)
            parsed_data['splice_viz'] = _build_splice_viz_payload(parsed_data)
        except Exception as _svis_err:
            print(f"splice_viz build: {_svis_err}")
            parsed_data['splice_viz'] = {
                'eligible': False,
                'reason': f'Splice exon map build failed: {_svis_err}',
            }

        try:
            _ensure_coding_exons_for_splice_viz(parsed_data)
            _ensure_cds_seq(parsed_data, http_session)
            _ensure_splice_secondary_cryptic_gain(http_session, parsed_data)
            parsed_data['junction_align_viz'] = _build_junction_align_payload(parsed_data)
            if not (parsed_data.get('junction_align_viz') or {}).get('eligible'):
                coll_ja = _build_collagen_gly_junction_align_viz(parsed_data)
                if coll_ja.get('eligible'):
                    parsed_data['junction_align_viz'] = coll_ja
        except Exception as _jalign_err:
            print(f"junction_align_viz build: {_jalign_err}")
            parsed_data['junction_align_viz'] = {
                'eligible': False,
                'reason': f'Junction map build failed: {_jalign_err}',
            }

        try:
            _cps = _build_clinical_publication_summary(parsed_data)
            parsed_data['clinical_publication_summary_html'] = _cps['html']
            parsed_data['clinical_publication_summary_plaintext'] = _cps['plaintext']
        except Exception as _cpsum_err:
            print(f"clinical_publication_summary: {_cpsum_err}")
            parsed_data['clinical_publication_summary_html'] = ''
            parsed_data['clinical_publication_summary_plaintext'] = ''

        return jsonify({
            "success": True,
            "parsed_data": parsed_data,
            "results_custom": results_custom,
            "results_acmg": results_acmg,
            "gene_summary": gene_summary,
            "effective_gene": effective_gene
        })

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"Failed to fetch data: {str(e)}"}), 500


def _parse_legacy_ivs_alias(aliases):
    """
    Scan ClinVar variation_set aliases for legacy 'IVS<n>(AS|DS), <ref>-<alt>, <offset>' nomenclature
    and emit a friendly label like 'IVS84 acceptor (legacy: exon 85)'. Handles plain IVS<n> too.
    """
    import re
    if not aliases:
        return None
    for raw in aliases:
        if not isinstance(raw, str):
            continue
        m = re.search(r'\bIVS\s*(\d+)\s*(AS|DS)?\b', raw, re.I)
        if not m:
            continue
        ivs_num = int(m.group(1))
        site = (m.group(2) or '').upper()
        if site == 'AS':
            site_label = 'acceptor'
            legacy_exon = ivs_num + 1
        elif site == 'DS':
            site_label = 'donor'
            legacy_exon = ivs_num
        else:
            site_label = ''
            legacy_exon = None
        bits = [f"IVS{ivs_num}"]
        if site_label:
            bits.append(site_label)
        legacy_str = ' '.join(bits)
        if legacy_exon is not None:
            legacy_str += f" (legacy nomenclature → exon {legacy_exon})"
        return {
            'raw_alias': raw.strip(),
            'ivs_intron': ivs_num,
            'site': site_label,
            'legacy_exon': legacy_exon,
            'label': legacy_str,
        }
    return None
