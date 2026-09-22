"""Variant Curation Flask application — v11 (development)."""
from flask import Flask, jsonify
from flask_cors import CORS
import requests

import subprocess

class EnsemblCurlSession:
    """
    Shared HTTP helper for Ensembl + other GETs.

    Ensembl GETs prefer requests.Session (connection reuse). Spawning curl per
    URL was the main cold-start cost for standalone / first analyze. Curl remains
    as a 503 fallback for the historically flaky Content-Type / edge cases.
    """

    def __init__(self):
        self._session = requests.Session()
        self.headers = self._session.headers
        self.cache = {}

    def _ensembl_headers(self, headers=None):
        # Ensembl REST dislikes Content-Type: application/json on some GET routes (503).
        merged = {"Accept": "application/json"}
        for k, v in dict(self.headers).items():
            if str(k).lower() == "content-type":
                continue
            merged[k] = v
        if headers:
            for k, v in headers.items():
                if str(k).lower() == "content-type":
                    continue
                merged[k] = v
        return merged

    def _curl_ensembl(self, url, headers=None, timeout=30):
        import time

        merged_headers = self._ensembl_headers(headers)
        cmd = ["curl", "-s", "-m", str(timeout), "-w", "%{http_code}"]
        for k, v in merged_headers.items():
            cmd.extend(["-H", f"{k}: {v}"])
        cmd.append(url)

        class MockResp:
            def __init__(self, text, code):
                self.text = text
                self.status_code = code

            def json(self):
                import json as internal_json
                try:
                    return internal_json.loads(self.text) if self.text else {}
                except Exception:
                    return {}

        for attempt in range(3):
            try:
                res = subprocess.run(cmd, capture_output=True, text=True, check=True)
                out_str = res.stdout
                if len(out_str) >= 3:
                    http_code_str = out_str[-3:]
                    try:
                        http_code = int(http_code_str)
                        body = out_str[:-3]
                    except Exception:
                        http_code = 500
                        body = out_str
                else:
                    http_code = 500
                    body = out_str

                if http_code >= 500 and attempt < 2:
                    time.sleep(0.35 * (attempt + 1))
                    continue
                return MockResp(body, http_code)
            except subprocess.CalledProcessError as e:
                if e.returncode == 28:  # curl timeout
                    return MockResp(getattr(e, "stderr", str(e)) or "", 500)
                if attempt < 2:
                    time.sleep(0.35 * (attempt + 1))
                    continue
                return MockResp(getattr(e, "stderr", str(e)) or "", 500)
            except Exception as e:
                if attempt < 2:
                    time.sleep(0.35 * (attempt + 1))
                    continue
                return MockResp(str(e), 500)
        return MockResp("", 500)

    def get(self, url, headers=None, timeout=30, **kwargs):
        try:
            from engine.service.http_cache import acquire, cache_get, cache_set, with_ncbi_api_key
        except ImportError:
            from service.http_cache import acquire, cache_get, cache_set, with_ncbi_api_key

        url = with_ncbi_api_key(url)
        cached = cache_get(url)
        if cached is not None:
            print(f"DEBUG intercepted (Cached): {url}", flush=True)
            return cached
        # Process-local fallback for callers that still poke ``self.cache`` in tests.
        if url in self.cache:
            print(f"DEBUG intercepted (Cached): {url}", flush=True)
            return self.cache[url]

        print(f"DEBUG intercepted: {url}", flush=True)
        acquire(url)
        if "rest.ensembl.org" in url:
            import time

            ens_headers = self._ensembl_headers(headers)
            resp_obj = None
            for attempt in range(2):
                try:
                    req_resp = self._session.get(
                        url, headers=ens_headers, timeout=timeout, **kwargs
                    )
                    code = getattr(req_resp, "status_code", 500)
                    if code == 503 and attempt < 1:
                        time.sleep(0.25)
                        continue
                    if code == 503:
                        print("DEBUG Ensembl requests 503 → curl fallback", flush=True)
                        resp_obj = self._curl_ensembl(url, headers=headers, timeout=timeout)
                    else:
                        resp_obj = req_resp
                    break
                except Exception as e:
                    if attempt < 1:
                        time.sleep(0.25)
                        continue
                    print(f"DEBUG Ensembl requests failed ({e}) → curl fallback", flush=True)
                    resp_obj = self._curl_ensembl(url, headers=headers, timeout=timeout)
                    break
            if resp_obj is None:
                resp_obj = self._curl_ensembl(url, headers=headers, timeout=timeout)
            if getattr(resp_obj, "status_code", 500) == 200:
                cache_set(
                    url,
                    resp_obj.status_code,
                    getattr(resp_obj, "text", "") or "",
                    dict(getattr(resp_obj, "headers", {}) or {}),
                )
                self.cache[url] = resp_obj
            return resp_obj

        print(f"DEBUG FALLEN BACK TO REQUESTS FOR: {url}")
        req_resp = self._session.get(url, headers=headers, timeout=timeout, **kwargs)
        # Do not cache MyVariant query responses — allele lists must stay fresh in long-running servers.
        if getattr(req_resp, "status_code", 500) == 200:
            cache_set(
                url,
                req_resp.status_code,
                req_resp.text or "",
                dict(req_resp.headers or {}),
            )
            if "myvariant.info" not in url:
                self.cache[url] = req_resp
        return req_resp

    def post(self, url, headers=None, timeout=30, **kwargs):
        """JSON/form POSTs (MetaDome submit, etc.). Not cached — side-effecting."""
        print(f"DEBUG POST: {url}", flush=True)
        return self._session.post(url, headers=headers, timeout=timeout, **kwargs)


http_session = EnsemblCurlSession()
http_session.headers.update({"Content-Type": "application/json", "Accept": "application/json"})
import json
import logging
import re
import html
import urllib.parse
import os
from google import genai
from google.genai import types
import concurrent.futures

import pysam

# --- Consolidated data root ------------------------------------------------
# All large reference data lives under one folder on fast local storage.
# Override the whole root with VC_DATA_ROOT, or any single file with its own
# env var (VC_CLINVAR_PATH / VC_CLINGEN_PATH / VC_HGMD_PATH). Falls back to the
# legacy scattered locations when the consolidated copy is absent, so migration
# is non-breaking.
VC_DATA_ROOT = os.path.expanduser(
    os.environ.get('VC_DATA_ROOT', '~/Documents/Ploidy/VariantCurationData')
)


def _resolve_data_path(env_key, consolidated_rel, *legacy_paths):
    """Pick the data file: explicit env override → consolidated root → legacy."""
    explicit = (os.environ.get(env_key) or '').strip()
    if explicit:
        return os.path.expanduser(explicit)
    consolidated = os.path.join(VC_DATA_ROOT, consolidated_rel)
    if os.path.exists(consolidated):
        return consolidated
    for legacy in legacy_paths:
        if legacy and os.path.exists(legacy):
            return legacy
    return consolidated


# Initialize heavy C-extensions directly when needed to prevent htslib thread deadlocks
CLINVAR_PATH = _resolve_data_path(
    'VC_CLINVAR_PATH',
    'reference/clinvar/clinvar.vcf.gz',
    '/Users/sammartin/Documents/Ploidy/Genomics_Pipeline/phenotype_portal/clinvar/clinvar.vcf.gz',
)

GLOBAL_VCF = None
target_file = CLINVAR_PATH
try:
    if os.path.exists(target_file):
        GLOBAL_VCF = pysam.VariantFile(target_file)
except Exception as e:
    print(f"Warning: ClinVar local VCF failed to load globally: {e}")

# --- Local HGMD Excel Cache Mount --- #
import pandas as pd

# Engine package (vc_engine, not engine) so it does not shadow workbench/engine.py.
from vc_engine.clinvar import (
    clinvar_portal_url,
    _clinvar_multi_vid_search_url,
    _clinvar_gene_plp_search_url,
    _clinvar_geneinfo_matches,
    _clinvar_name_change_class,
    _clinvar_sig_from_esummary_obj,
    _clinvar_plp_sig_for_deleted_exon,
    _clinvar_cdot_label_from_esummary,
    _clinvar_sig_is_pathogenic_or_likely_pathogenic,
    _clinvar_rcv_any_pathogenic_or_likely,
    _clinvar_display_sig_from_rcv,
    _clinvar_dict_from_hit,
    _clinvar_variant_id_from_hit,
    _clinvar_rcv_list_from_hit,
    _clinvar_coding_hgvs_from_hit,
    _clinvar_genomic_hgvs_from_hit,
    _plp_region_clinvar_list_url,
    _plp_region_matched_clinvar_link_html,
    _fetch_clinvar_esummary_map,
    _clinvar_synthetic_hit_from_esummary,
    _fetch_myvariant_clinvar_variant_hit,
    _fetch_clinvar_aliases,
    _clinvar_variation_uid_for_pubmed_elink,
)
from vc_engine.regions import (
    _deleted_exon_analysis_evidence_html,
    _downstream_plp_hits_markup,
    _finalize_plp_region_links,
    _finalize_skipped_exon_plp_links,
    _plp_region_hit_item_html,
    _skipped_exon_plp_hits_markup,
    _upstream_plp_hits_markup,
)
from vc_engine.scoring import classify_score, apply_rubric, apply_acmg, clMatrixDef
import vc_engine.splice as _vc_splice
from vc_engine.splice import (
    _append_deep_intronic_splice_logic_sections,
    _append_nmd_escape_clinical_context,
    _append_splice_product_logic_sections,
    _append_splice_support_sections,
    _append_truncation_nmd_sections,
    _apply_canonical_splice_hgvs_override,
    _apply_near_splice_region_context,
    _build_junction_align_payload,
    _build_splice_products_panel_html,
    _build_splice_viz_payload,
    _canonical_splice_junction_from_hgvs,
    _consequence_is_acceptor_splice,
    _consequence_is_donor_splice,
    _deep_intronic_signal_label,
    _ensure_cds_seq,
    _ensure_coding_exons_for_splice_viz,
    _finalize_splice_report_narratives,
    _format_whole_exon_skip_hgvs_p,
    _hydrate_exon_skip_truncation_metrics,
    _logic_csq_is_splice_context,
    _logic_lines_block,
    _logic_section_text_plain,
    _logic_should_show_deep_intronic_context,
    _lookup_clinvar_plp_downstream_of_ptc,
    _missense_same_codon_different_change,
    _normalize_to_forward_strand,
    _oofs_exon_skip_ptc_cds_and_cdna,
    _reconcile_splice_model_precedence,
    _resolve_cryptic_splice_outcome,
    _resolve_exon_internal_cryptic_outcome,
    _select_splice_coding_exon,
    _set_spliceai_narrative_sentence,
    _should_show_spliceai_narrative_in_logic,
    _splice_cdna_anchor_from_hgvs,
    _spliceai_exon_skip_takes_precedence_over_weak_cryptic,
    _spliceai_scores_4,
    _spliceai_secondary_acceptor_parallel_exon_skip_math,
    _spliceai_secondary_donor_parallel_exon_skip_math,
    _spliceai_site_locus,
    _spliceai_variant_locus_string,
    _stash_transcript_mrna_exon_metadata,
    compute_deep_intronic_splice_math,
    compute_deep_intronic_spliceai_products,
    ACCEPTOR_GAIN_BODY_START,
    DEEP_INTRONIC_ACCEPTOR_CANONICAL_MAX_AG,
    DEEP_INTRONIC_MIN_SPLICE_PREDICTOR,
    DONOR_GAIN_BODY_START,
    EXON_SKIP_CODON_TABLE,
    MAX_JUNCTION_CODON_DECODE,
    SPLICEAI_COMPETING_FLOOR,
    SPLICEAI_EXON_SKIP_PRIMARY_GAP,
    SPLICEAI_EXON_SKIP_PRIMARY_MIN_LOSS,
    SPLICEAI_JUNCTION_PRIMARY_MIN,
    SPLICEAI_RECONCILE_MIN,
    _CANONICAL_JUNCTION_DUP_MAX_OFFSET,
    _CODON_TABLE_FULL,
    _EXON_INTERNAL_CRYPTIC_GAIN_THRESHOLD,
    _SPLICEAI_KIND_DINUC,
    _SPLICE_VIZ_SEC_SKIP_PTC_PREFIX,
)
# Inject the shared EnsemblCurlSession into the splice module so its Ensembl
# REST lookups use the same cached session as the rest of the engine.
_vc_splice.http_session = http_session
import vc_engine.analyze as _vc_analyze
from vc_engine.analyze import (
    analyze_bp,
    _norm_c_dot_for_upstream_dedupe,
    _protein_positions_from_text_blob,
)
from vc_engine.hgvs import (
    _AA_ONE_TO_THREE,
    _AA_THREE_TO_ONE,
    _AA_THREE_TO_FULL,
    _myvariant_c_dot_tail_norm,
    _c_dot_change_class,
    _parse_c_dot_allele,
    _hgvs_c_dot_alleles_equal,
    _c_dot_requires_exact_allele_match,
    _is_same_cdna_allele,
    _refseq_base_match,
    _parse_missense_substitution_hgvs_p,
)
from vc_engine.state import clingen_db
from vc_engine.literature import lit_bp
from vc_engine.myvariant import (
    _MYVARIANT_LOCAL_ALLELE_FIELDS,
    _myvariant_hit_c_dot_match_score,
    myvariant_hit_matches_refseq,
    _pick_best_myvariant_hit,
)
from vc_engine.uniprot import (
    _uniprot_feature_included,
    _uniprot_feature_display_name,
    _uniprot_truncation_positions,
    _uniprot_truncation_feature_relation,
    _uniprot_domain_overlap_matches,
    _uniprot_domain_lookup_mode,
    _format_uniprot_feature_label,
    _apply_uniprot_domain_lookup,
)
from vc_engine.util import _safe_int_or_none
from vc_engine.hgmd import (
    GLOBAL_HGMD_POSITIONAL_ENTRIES,
    _hgmd_cell_pubmed_ids,
    _hgmd_column_carries_pubmed_ids,
    _hgmd_row_pubmed_ids,
    _hgmd_lookup_keys,
    _hgmd_ordered_candidate_keys,
    _hgmd_gene_mutation_url,
    _merge_hgmd_upstream_hits,
    _merge_hgmd_downstream_hits,
    _merge_hgmd_skipped_exon_hits,
)
from vc_engine.spliceai import (
    _parse_spliceai_dp,
    _pick_spliceai_score_row,
    _emg_spliceai_ds_snapshot,
    _emg_spliceai_complete_snapshot,
    _refresh_spliceai_in_silico_source,
    _apply_emg_spliceai_complete,
    _apply_emg_spliceai_ds_only,
    _restore_emg_spliceai_ds_over_broad,
    _emg_spliceai_dp_snapshot,
    _apply_emg_spliceai_if_broad_unavailable,
    _apply_emg_spliceai,
    _ingest_spliceai_broad_json,
)






















def _hgmd_row_protein_positions(row):
    """
    Best-effort protein residue indices from an HGMD spreadsheet row.
    Requires explicit protein HGVS / p. notation (no inference from cDNA only).

    Bootstrap-only: used by the HGMD Excel mount below to build the in-RAM
    positional index. Kept in the shim (rather than vc_engine.hgmd) because it
    depends on _protein_positions_from_text_blob, which lives in vc_engine.analyze
    -- importing it into hgmd would create an analyze<->hgmd import cycle.
    """
    pos_vals = []
    skip_exact = {
        "gene",
        "disease",
        "tag",
        "comments",
        "reference",
        "ref",
        "chromosome",
        "chr",
    }
    risky_sub = ("chr", "chrom", "coordinate", "hg19", "hg38", "grch37", "grch38", "genomic")
    for col in row.index:
        cn = str(col).lower().replace(" ", "")
        if cn in skip_exact:
            continue
        if any(s in cn for s in risky_sub):
            continue
        prot_hint = any(
            x in cn
            for x in (
                "hgvs_protein",
                "hgvs.protein",
                "hgvsp",
                "hgvs_p",
                "protchg",
                "_prot",
                "protein",
                "amino",
                "peptide",
                "aac",
            )
        )
        if prot_hint:
            pos_vals.extend(_protein_positions_from_text_blob(row[col]))
    for col in row.index:
        cn = str(col).lower()
        if cn in skip_exact:
            continue
        val = row[col]
        if isinstance(val, str) and "p." in val.lower():
            pos_vals.extend(_protein_positions_from_text_blob(val))
    seen = set()
    out = []
    for p in pos_vals:
        if p > 0 and p not in seen:
            seen.add(p)
            out.append(p)
    return sorted(out)


GLOBAL_HGMD = {}
GLOBAL_HGMD_PMIDS = {}
hgmd_path = _resolve_data_path(
    'VC_HGMD_PATH',
    'reference/hgmd/HGMD_2025_V4_hg38.xltx',
    '/Users/sammartin/Documents/Patient Letter/Variant Curation/HGMD_2025_V4_hg38.xltx',
)
if os.path.exists(hgmd_path):
    print("Mounting Local HGMD Excel Database into RAM...")
    try:
        hgmd_df = pd.read_excel(hgmd_path, engine='openpyxl')
        for _, row in hgmd_df.dropna(subset=['gene', 'hgvs']).iterrows():
            gene_upper = str(row['gene']).strip().upper()
            pmids_union = _hgmd_row_pubmed_ids(row)
            tag = str(row.get('tag', 'DM')).strip()
            disease = str(row.get('disease', 'Unknown Phenotype')).strip()
            pmid = str(row.get('pmid', '')).strip()
            pmid_str = f" [PMID: {pmid}]" if pmid and pmid != 'nan' else ""
            banner = f"HGMD: Yes - {tag} - {disease}{pmid_str}"
            hgvs_c_cell = str(row['hgvs']).strip()
            positions = _hgmd_row_protein_positions(row)
            if positions:
                GLOBAL_HGMD_POSITIONAL_ENTRIES.append(
                    {
                        "gene": gene_upper,
                        "hgvs_c": hgvs_c_cell,
                        "c_dot_norm": _norm_c_dot_for_upstream_dedupe(hgvs_c_cell),
                        "tag": tag or "DM",
                        "positions": positions,
                    }
                )
            for key in _hgmd_lookup_keys(gene_upper, hgvs_c_cell):
                GLOBAL_HGMD[key] = banner
                GLOBAL_HGMD_PMIDS[key] = list(pmids_union)
        print(f"Mounted {len(GLOBAL_HGMD)} standalone HGMD evaluations.")
    except Exception as e:
        print(f"Failed to compile proprietary HGMD dictionary natively: {e}")

CLINGEN_PATH = _resolve_data_path(
    'VC_CLINGEN_PATH',
    'reference/clingen/ClinGen_gene_curation_list_GRCh38.tsv',
    '/Users/sammartin/Documents/Ploidy/Genomics_Pipeline/phenotype_portal/clingen/ClinGen_gene_curation_list_GRCh38.tsv',
)
# clingen_db is the shared dict imported from vc_engine.state; populate it in
# place (do not rebind) so vc_engine.literature sees the same entries.
try:
    with open(CLINGEN_PATH, 'r') as f:
        for _ in range(5): next(f)
        for line in f:
            parts = line.strip().split('\t')
            if len(parts) >= 5:
                clingen_db[parts[0].strip()] = parts[4].strip()
except Exception as e:
    print(f"Warning: ClinGen local db failed to load: {e}")


app = Flask(__name__, template_folder=None)
# Literature + disease-mechanism routes (EuropePMC/PubMed search, PDF download,
# Gemini summaries) live in vc_engine.literature as a Blueprint.
app.register_blueprint(lit_bp)


# Initialize Gemini Client
# Set GEMINI_API_KEY in your environment or in a .env file.
# Standalone curation sets VC_DISABLE_GEMINI=1 so analyze runs without LLM calls.
_disable_gemini = (os.environ.get('VC_DISABLE_GEMINI') or '').strip().lower() in (
    '1', 'true', 'yes', 'on',
)
if _disable_gemini:
    print("Gemini disabled (VC_DISABLE_GEMINI) — gene profile/mechanism LLM skipped.")
    client = None
else:
    try:
        from dotenv import load_dotenv
        dotenv_path = os.path.join(os.path.dirname(__file__), '.env')
        load_dotenv(dotenv_path=dotenv_path, override=True)

        _gemini_api_key = os.environ.get('GEMINI_API_KEY', '')
        if not _gemini_api_key:
            raise ValueError("GEMINI_API_KEY environment variable is not set")
        client = genai.Client(api_key=_gemini_api_key)
    except Exception as e:
        print(f"Warning: Gemini Client not initialized. {e}")
        client = None

# --- Variant Classification Logic ---
# clMatrixDef, classify_score, apply_rubric, apply_acmg now live in
# vc_engine/scoring.py and are imported above.

























































# ---------------------------------------------------------------------------
# Coding in-frame indel resolver (NOT splice-driven).
# ---------------------------------------------------------------------------
# Handles plain CDS-level inframe_deletion / inframe_insertion / inframe_indel
# / inframe_delins consequences (e.g. UBR5 c.3622_3624del -> p.Cys1208del).
# These keep the reading frame, retain the native stop codon, and therefore do
# NOT engage NMD. The cryptic-splice in-frame resolver above only fires for
# splice-driven events, so without this helper a clean coding 3-nt deletion
# never gets an explicit "no PTC / NMD does not apply / protein length N-1"
# protein-level summary in the report.



# HGVS-p regexes (3-letter form, which is what VEP/Ensembl return).






































































# SpliceAI reconcile: skip weak deltas — no extra competing/junction callouts in noise.


# Max intronic offset for canonical junction dup/del HGVS (c.N±k dup, c.N+K_N+M dup).






































# When DS_AL (acceptor) or DS_DL (donor) dwarves the "gain" term, the sequence
# resolver's weak-gain / native-stop story must not override whole-exon-skip in the
# Logic Explanation. Thresholds are intentionally conservative to avoid clobbering
# real TRAF7-style in-frame CAG cases where both sides are in play.










# Spliced-CDS triplet read from the canonical start (ORF-0) for whole–exon–skip; used with full cDNA+UTR
# to resolve PTCs when the annotated spliced CDS is not a multiple of 3 and has no in-frame stop in the CDS
# string alone.














































































































# Minimum delta score to surface deep-intronic splice geometry (aligned with other in silico gates).
# Canonical donor-gain retained segment: intron bases after the 5′ GT dinucleotide (indices 0–1)
# through the base before the cryptic donor GT — always body = seq[DONOR_GAIN_BODY_START:gt_start].
# Acceptor-gain (5′ GT reused → gained AG): body = seq[DONOR_GAIN_BODY_START:ag_start] (AG excluded).

# Optional published RNA/minigene overrides for any gene: deep_intronic_rna_evidence.json
# alongside this module ({GENE: {HGVS_intron_key: {pseudo_exon_nt, coding_body_nt,
# cryptic_donor_hgvs_offset, body_start_offset, pmids, summary}}}).
# All genes run in silico (SpliceAI + intron sequence + ORF) without that file.
_DEEP_INTRONIC_RNA_SPLICE_EVIDENCE_CACHE = None


































































# ---------------------------------------------------------------------------
# Unified SpliceAI intronic pipeline (same shape for all four signal types):
#   1. SpliceAI DS + Δ (DP) from variant
#   2. Map Δ → splice dinucleotide locus in transcript-oriented intron (_spliceai_site_locus)
#   3. Gain: pair cryptic site with canonical partner → retained body → CDS insert
#      Loss: identify weakened canonical site → whole-exon skip of partner exon
#   4. Translate mutant CDS → frame / PTC / NMD
# ---------------------------------------------------------------------------



































# Acceptor-gain: canonical 5′ GT → gained AG only when AG lies near intron start (c.N+ side).


@app.route('/')
def index():
    return jsonify({
        "app": "variant-classifier-engine",
        "ui": "gvi-worker",
        "hint": "This process is the GVI curation worker. The SAM-VC Flask workbench is not part of this deployment.",
    })


# Wire the analyze engine blueprint and inject the mounted runtime state into it
# (pysam VCF handle, HGMD dicts, EnsemblCurlSession, Gemini client). Done here,
# after the full mount, so the injected objects are fully populated.
_vc_analyze.GLOBAL_VCF = GLOBAL_VCF
_vc_analyze.GLOBAL_HGMD = GLOBAL_HGMD
_vc_analyze.GLOBAL_HGMD_PMIDS = GLOBAL_HGMD_PMIDS
_vc_analyze.http_session = http_session
_vc_analyze.client = client
app.register_blueprint(analyze_bp)


if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5001))
    app.run(debug=False, port=port)
