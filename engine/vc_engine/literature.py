"""Literature & disease-mechanism Flask blueprint.

Extracted from ``app_v11.py`` (Phase 3 step 5 of ``docs/ENGINE_SPLIT_PLAN.md``).
EuropePMC / PubMed search + PDF download helpers and the Gemini summarization
route bodies. Each summarize route builds its own genai.Client from
GEMINI_API_KEY (lazy local import), so this module needs no engine globals.
Registered by app_v11.py via ``app.register_blueprint(lit_bp)``.
"""
from __future__ import annotations

import os
import re

from flask import Blueprint, request, jsonify

from vc_engine.hgvs import (
    _parse_missense_substitution_hgvs_p,
    _AA_ONE_TO_THREE,
    _AA_THREE_TO_ONE,
    _AA_THREE_TO_FULL,
)
from vc_engine.clinvar import _clinvar_variation_uid_for_pubmed_elink
from vc_engine.lit_index import format_lit_index_document, search_lit_index
from vc_engine.state import clingen_db


def _ncbi_url(url: str) -> str:
    """Attach NCBI_API_KEY when present. Import is lazy so this module still loads standalone."""
    try:
        from engine.service.http_cache import with_ncbi_api_key
        return with_ncbi_api_key(url)
    except Exception:
        try:
            from service.http_cache import with_ncbi_api_key
            return with_ncbi_api_key(url)
        except Exception:
            return url

lit_bp = Blueprint("literature", __name__)

# Legacy literature folder (pre-consolidation). Used only as a fallback.
_LEGACY_PDF_DIR = "/Users/sammartin/Documents/Patient Letter/Variant Curation"


def _resolve_pdf_base_dir() -> str:
    """Folder that holds per-variant downloaded papers (<GENE>_<cdot>/...).

    Priority: VC_PDF_DIR → VC_DATA_ROOT/pdfs → legacy folder (if present).
    """
    explicit = (os.environ.get("VC_PDF_DIR") or "").strip()
    if explicit:
        return os.path.expanduser(explicit)
    root = (os.environ.get("VC_DATA_ROOT") or "~/Documents/Ploidy/VariantCurationData").strip()
    consolidated = os.path.join(os.path.expanduser(root), "pdfs")
    if os.path.isdir(consolidated) or not os.path.isdir(_LEGACY_PDF_DIR):
        return consolidated
    return _LEGACY_PDF_DIR


def _llm_via_gvi_proxy():
    """True when the GVI worker has pointed literature at the control-plane LLM."""
    return bool((os.environ.get("GVI_LLM_PROXY_URL") or "").strip())


def _require_llm_client():
    """Gemini client, or a dummy when the GVI proxy will handle the call."""
    if _llm_via_gvi_proxy():
        return object()
    key = (os.environ.get("GEMINI_API_KEY") or "").strip()
    if not key:
        return None
    from google import genai

    return genai.Client(api_key=key)


def _run_gemini(client, contents: str):
    """Call the GVI LLM proxy when configured, else Gemini with a model fallback."""
    proxy_url = (os.environ.get("GVI_LLM_PROXY_URL") or "").strip()
    token = (os.environ.get("ENGINE_WORKER_TOKEN") or "").strip()
    if proxy_url and token:
        import requests
        from types import SimpleNamespace

        response = requests.post(
            proxy_url,
            json={"purpose": "literature", "prompt": contents},
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            timeout=120,
        )
        response.raise_for_status()
        payload = response.json() if response.content else {}
        return SimpleNamespace(text=(payload or {}).get("text") or "")
    try:
        return client.models.generate_content(
            model='gemini-1.5-pro',
            contents=contents,
        )
    except Exception:
        return client.models.generate_content(
            model='gemini-2.5-flash',
            contents=contents,
        )


def _literature_isoform_searchable_entries(isoform_lit):
    """Non-genomic ClinVar alternate names on the curated VID — for PubMed / EuropePMC."""
    out = []
    for entry in isoform_lit or []:
        if not isinstance(entry, dict):
            continue
        kind = (entry.get("hgvs_kind") or "").strip().lower()
        if kind == "genomic":
            continue
        c_dot = (entry.get("hgvs_c") or "").strip()
        if not c_dot:
            full = (entry.get("hgvs_full") or "").strip()
            if ":" in full:
                c_dot = full.split(":", 1)[1].strip()
        if not c_dot:
            continue
        cm = re.search(
            r"c\.\d+[-+*]?\d*[a-zA-Z]>[a-zA-Z]"
            r"|c\.\d+[+-]\d+[a-zA-Z]>[a-zA-Z]"
            r"|c\.\d+(?:[+-]\d+)?(?:_\d+(?:[+-]\d+)?)?(?:dup|del|ins|delins)[a-zA-Z]*",
            c_dot,
            re.I,
        )
        if not cm:
            continue
        out.append({
            "transcript": (entry.get("transcript") or "").strip(),
            "c_dot": cm.group(0),
            "hgvs_p": (entry.get("hgvs_p") or "").strip(),
            "hgvs_full": (entry.get("hgvs_full") or "").strip(),
        })
    return out


def _literature_isoform_prompt_lines(isoform_lit):
    """Human-readable alternate HGVS for Gemini literature rules."""
    lines = []
    for iso in _literature_isoform_searchable_entries(isoform_lit):
        tx = iso.get("transcript") or "alternate"
        c_dot = iso.get("c_dot") or ""
        p = iso.get("hgvs_p") or ""
        line = f"  - {tx}: {c_dot}"
        if p:
            line += f" ({p})"
        lines.append(line)
    return lines


def _literature_queue_isoform_variant_papers(
    gene, isoform_entries, queue_pmid_fn, epmc_by_pmid, *,
    per_isoform_pubmed=6, per_isoform_epmc=10,
):
    """Extra PubMed / EuropePMC branches for other ClinVar HGVS on the same VID."""
    for iso in isoform_entries:
        c_iso = iso.get("c_dot") or ""
        if not c_iso:
            continue
        tx = iso.get("transcript") or "isoform"
        p_terms_iso = _literature_protein_search_terms(iso.get("hgvs_p") or "")
        for pid in _literature_pubmed_variant_ids(
            gene, c_iso, p_terms_iso, retmax=per_isoform_pubmed,
        ):
            queue_pmid_fn(pid, f"Isoform_{tx}_{pid}")
        for r in _literature_epmc_variant_search(
            gene, c_iso, p_terms_iso, page_size=per_isoform_epmc,
        ):
            blob = " ".join(
                str(r.get(k) or "") for k in ("title", "abstractText", "abstract")
            )
            if not _literature_variant_match_text(gene, c_iso, p_terms_iso, blob):
                continue
            pmid = str(r.get("pmid") or "").strip()
            if pmid:
                epmc_by_pmid[pmid] = r
                queue_pmid_fn(pmid, r.get("title") or f"IsoformEPMC_{tx}_{pmid}")


def _literature_protein_search_terms(hgvs_p):
    """p. notation strings for PubMed / EuropePMC (1- and 3-letter)."""
    if not hgvs_p or str(hgvs_p).strip() in ('', '?'):
        return []
    raw = str(hgvs_p).strip()
    p_clean = raw[2:].strip() if raw.lower().startswith('p.') else raw
    terms = []

    def _add(t):
        t = (t or '').strip()
        if not t:
            return
        if t not in terms:
            terms.append(t)

    _add(raw if raw.lower().startswith('p.') else f'p.{p_clean}')
    three_to_one = {
        'Ala': 'A', 'Arg': 'R', 'Asn': 'N', 'Asp': 'D', 'Cys': 'C',
        'Gln': 'Q', 'Glu': 'E', 'Gly': 'G', 'His': 'H', 'Ile': 'I',
        'Leu': 'L', 'Lys': 'K', 'Met': 'M', 'Phe': 'F', 'Pro': 'P',
        'Ser': 'S', 'Thr': 'T', 'Trp': 'W', 'Tyr': 'Y', 'Val': 'V',
        'Ter': '*',
    }
    one_to_three = {v: k for k, v in three_to_one.items()}
    m1 = re.match(r'^([A-Z])(\d+)([A-Z\*])$', p_clean)
    if m1:
        aa1, pos, aa2 = m1.groups()
        _add(f'p.{aa1}{pos}{aa2}')
        if aa1 in one_to_three and aa2 in one_to_three:
            _add(f'p.{one_to_three[aa1]}{pos}{one_to_three[aa2]}')
    else:
        m3 = re.match(r'^([A-Z][a-z]{2})(\d+)([A-Z][a-z]{2}|Ter)$', p_clean)
        if m3:
            aa1, pos, aa2 = m3.groups()
            _add(f'p.{aa1}{pos}{aa2}')
            if aa1 in three_to_one and aa2 in three_to_one:
                _add(f'p.{three_to_one[aa1]}{pos}{three_to_one[aa2]}')
    m_del3 = re.match(r'^([A-Z][a-z]{2})(\d+)(?:_([A-Z][a-z]{2})(\d+))?del$', p_clean)
    if m_del3:
        aa1, pos1, aa2, pos2 = m_del3.group(1), m_del3.group(2), m_del3.group(3), m_del3.group(4)
        _add(f'p.{aa1}{pos1}del')
        if aa1 in three_to_one:
            _add(f'p.{three_to_one[aa1]}{pos1}del')
        if aa2 and pos2:
            _add(f'p.{aa1}{pos1}_{aa2}{pos2}del')
            if aa1 in three_to_one and aa2 in three_to_one:
                _add(f'p.{three_to_one[aa1]}{pos1}{three_to_one[aa2]}{pos2}del')
    else:
        m_del1 = re.match(r'^([A-Z])(\d+)(?:_([A-Z])(\d+))?del$', p_clean)
        if m_del1:
            aa1, pos1, aa2, pos2 = m_del1.group(1), m_del1.group(2), m_del1.group(3), m_del1.group(4)
            _add(f'p.{aa1}{pos1}del')
            if aa1 in one_to_three:
                _add(f'p.{one_to_three[aa1]}{pos1}del')
            if aa2 and pos2 and aa2 in one_to_three:
                _add(f'p.{aa1}{pos1}_{aa2}{pos2}del')
                _add(f'p.{one_to_three.get(aa1, aa1)}{pos1}{one_to_three[aa2]}{pos2}del')
    return terms


def _literature_p_search_forms(p_terms):
    """All p. strings to search/match — with and without 'p.' prefix (papers often omit it)."""
    forms = []
    seen = set()

    def _add(s):
        s = (s or '').strip()
        if not s:
            return
        key = s.lower()
        if key in seen:
            return
        seen.add(key)
        forms.append(s)

    for pt in p_terms or []:
        _add(pt)
        if pt.lower().startswith('p.'):
            _add(pt[2:].strip())
    return forms


def _literature_variant_match_text(gene, c_dot, p_terms, text):
    """Paper must mention gene AND (c. or p. / protein notation)."""
    if not text:
        return False
    tl = text.lower()
    if gene.lower() not in tl:
        return False
    cd = c_dot.lower()
    if cd in tl:
        return True
    if cd.startswith('c.') and cd[2:] in tl:
        return True
    for form in _literature_p_search_forms(p_terms):
        fl = form.lower()
        if fl in tl:
            return True
        if fl.startswith('p.') and fl[2:] in tl:
            return True
    return False


def _literature_aa_substitution_prose_regexes(hgvs_p):
    """Match 'arginine to tryptophan' style prose for a curated missense p."""
    sub = _parse_missense_substitution_hgvs_p(hgvs_p)
    if not sub:
        return []
    ref_name = _AA_THREE_TO_FULL.get(sub['ref_3'], sub['ref_3'].lower())
    alt_name = _AA_THREE_TO_FULL.get(sub['alt_3'], sub['alt_3'].lower())
    sep = r'(?:\s*(?:to|into|by|→|->|-|/)\s*|\s+substitution\s+(?:to|with|by)\s+)'
    alt_flex = re.escape(alt_name[: max(5, len(alt_name) - 2)]) + r'\w*'
    return [
        re.compile(rf'{re.escape(ref_name)}{sep}{alt_flex}', re.I),
        re.compile(rf'{re.escape(ref_name)}\s+substitut', re.I),
    ]


def _literature_all_variant_terms(c_dot, hgvs_p, isoform_lit):
    """
    Primary + ClinVar alternate HGVS on the same VID — for literature search and summarize matching.
    Returns (c_dots_norm, p_terms, hgvs_ps, isoform_entries).
    """
    iso_entries = _literature_isoform_searchable_entries(isoform_lit)
    c_dots_norm = []

    def _add_c(cd):
        cn = re.sub(r'\s+', '', (cd or '').lower())
        if cn and cn not in c_dots_norm:
            c_dots_norm.append(cn)

    _add_c(c_dot)
    for iso in iso_entries:
        _add_c(iso.get('c_dot'))

    p_terms = []
    seen_p = set()

    def _add_p(hp):
        for t in _literature_protein_search_terms(hp):
            key = t.lower()
            if key not in seen_p:
                seen_p.add(key)
                p_terms.append(t)

    _add_p(hgvs_p)
    for iso in iso_entries:
        _add_p(iso.get('hgvs_p'))

    hgvs_ps = []
    for hp in [hgvs_p] + [iso.get('hgvs_p') for iso in iso_entries]:
        hp = (hp or '').strip()
        if hp and hp not in hgvs_ps:
            hgvs_ps.append(hp)
    return c_dots_norm, p_terms, hgvs_ps, iso_entries


def _literature_summary_chunk_matches_protein(
    chunk: str, p_terms, hgvs_p=None, hgvs_ps=None,
) -> bool:
    """True if Gemini PMID block cites the curated protein change (not only HGVS c.)."""
    if not chunk:
        return False
    low = chunk.lower()
    blob_compact = re.sub(r'\s+', '', low)
    for form in _literature_p_search_forms(p_terms):
        fc = re.sub(r'\s+', '', form.lower())
        if fc and fc in blob_compact:
            return True
        if form.lower().startswith('p.') and re.sub(r'\s+', '', form[2:].lower()) in blob_compact:
            return True
    hp_list = list(hgvs_ps or [])
    if hgvs_p and hgvs_p not in hp_list:
        hp_list.insert(0, hgvs_p)
    for hp in hp_list:
        for rx in _literature_aa_substitution_prose_regexes(hp):
            if rx.search(low):
                return True
    return False


def _literature_p_prompt_lines(p_terms):
    forms = _literature_p_search_forms(p_terms)
    if not forms:
        return []
    return [f"  • {f}" for f in forms[:20]]


def _literature_summarize_variant_context(gene, c_dot, hgvs_p, isoform_lit):
    """Shared ClinVar-aware HGVS blocks for clinical + functional Gemini prompts."""
    c_dots_all, p_terms_all, hgvs_ps, _ = _literature_all_variant_terms(
        c_dot, hgvs_p, isoform_lit,
    )
    primary_c_norm = re.sub(r'\s+', '', (c_dot or '').lower())
    isoform_c_dots = [cd for cd in c_dots_all if cd != primary_c_norm]

    isoform_str = ""
    iso_lines = _literature_isoform_prompt_lines(isoform_lit)
    if iso_lines:
        isoform_str = (
            "\n\nALTERNATE ISOFORM HGVS (same ClinVar record as the curated variant — "
            "papers often cite these instead of your primary transcript):\n"
            + "\n".join(iso_lines)
            + "\nTreat evidence for ANY of these HGVS names as evidence for "
            f"the curated {gene} allele (same variant, different transcript numbering).\n"
        )

    p_str = ""
    p_lines = _literature_p_prompt_lines(p_terms_all)
    if p_lines:
        p_str = (
            "\n\nCURATED PROTEIN NOTATION (gene + p. search terms — primary and ClinVar alternates):\n"
            + "\n".join(p_lines)
            + "\nTreat assays or patients citing ANY of these protein forms (or matching plain-language "
            "amino-acid substitution text) as this variant.\n"
        )
    return {
        'c_dots_all': c_dots_all,
        'p_terms_all': p_terms_all,
        'hgvs_ps': hgvs_ps,
        'isoform_c_dots': isoform_c_dots,
        'isoform_str': isoform_str,
        'p_str': p_str,
    }


def _literature_c_query_clause(c_dot):
    """Quoted HGVS DNA forms for literature search (c./n./r.)."""
    parts = [f'"{c_dot}"']
    low = c_dot.lower()
    if not low.startswith(("c.", "n.", "r.")):
        parts.append(f'"c.{c_dot}"')
    m = re.search(r"([cnr])\.(\d+)_(\d+)", str(c_dot or ""), re.I)
    if m:
        stem = f"{m.group(1)}.{m.group(2)}_{m.group(3)}"
        if stem.lower() not in low:
            parts.append(f'"{stem}"')
        if m.group(1).lower() == "c":
            parts.append(f'"c.{m.group(2)}TCT[2]"')
    return ' OR '.join(parts)


def _literature_p_query_clause(p_terms):
    """Quoted p. / protein forms — include bare Val523Leu-style (no 'p.' prefix)."""
    parts = []
    seen = set()
    for form in _literature_p_search_forms(p_terms):
        key = form.lower()
        if key in seen:
            continue
        seen.add(key)
        parts.append(f'"{form}"')
    return ' OR '.join(parts)


def _literature_pubmed_gene_c_query(gene, c_dot):
    return f'({gene}[Gene]) AND ({_literature_c_query_clause(c_dot)})'


def _literature_pubmed_gene_p_query(gene, p_terms):
    p_clause = _literature_p_query_clause(p_terms)
    if not p_clause:
        return None
    return f'({gene}[Gene]) AND ({p_clause})'


def _literature_epmc_gene_c_query(gene, c_dot):
    g = (gene or '').strip()
    return f'({g}) AND ({_literature_c_query_clause(c_dot)})'


def _literature_epmc_gene_p_query(gene, p_terms):
    g = (gene or '').strip()
    p_clause = _literature_p_query_clause(p_terms)
    if not p_clause:
        return None
    return f'({g}) AND ({p_clause})'


def _literature_pubmed_esearch(pm_query, retmax):
    import urllib.parse
    import requests as _req
    try:
        url = (
            'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed'
            f'&term={urllib.parse.quote(pm_query)}&retmode=json'
            f'&retmax={int(retmax)}&sort=relevance'
        )
        url = _ncbi_url(url)
        data = _req.get(url, timeout=12).json()
        return [str(x) for x in (data.get('esearchresult', {}).get('idlist') or []) if str(x).isdigit()]
    except Exception as e:
        print(f'PubMed variant esearch error ({pm_query[:80]}…): {e}')
        return []


def _literature_pubmed_variant_ids(gene, c_dot, p_terms, retmax=15):
    """
    Two PubMed passes when p. terms exist: (gene AND c.) and (gene AND p.) so
    papers that only list gene + protein notation are not missed.
    """
    p_query = _literature_pubmed_gene_p_query(gene, p_terms)
    if not p_query:
        return _literature_pubmed_esearch(_literature_pubmed_gene_c_query(gene, c_dot), retmax)

    per_branch = max(8, retmax // 2)
    ids_c = _literature_pubmed_esearch(_literature_pubmed_gene_c_query(gene, c_dot), per_branch)
    ids_p = _literature_pubmed_esearch(p_query, per_branch)
    merged = []
    seen = set()
    for pid in ids_p + ids_c:
        if pid not in seen:
            seen.add(pid)
            merged.append(pid)
    return merged[:retmax]


def _literature_epmc_fetch(query, page_size):
    import urllib.parse
    import requests as _req
    url = (
        'https://www.ebi.ac.uk/europepmc/webservices/rest/search'
        f'?query={urllib.parse.quote(query)}&format=json&resultType=core'
        f'&pageSize={int(page_size)}'
    )
    headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0 Safari/537.36'
    }
    for attempt, t in enumerate((25, 40, 60), start=1):
        try:
            res = _req.get(url, headers=headers, timeout=t)
            if res.status_code == 200:
                return res.json().get('resultList', {}).get('result', []) or []
        except Exception as e:
            print(f'EuropePMC search attempt {attempt} ({query[:60]}…): {e}')
    return []


def _literature_epmc_variant_search(gene, c_dot, p_terms, page_size=25):
    """
    Separate Europe PMC queries for (gene AND c.) and (gene AND p.), merged by PMID.
    Catches papers that only index gene + protein change without c. in metadata.
    """
    p_query = _literature_epmc_gene_p_query(gene, p_terms)
    c_query = _literature_epmc_gene_c_query(gene, c_dot)
    if not p_query:
        return _literature_epmc_fetch(c_query, page_size)

    per_branch = max(12, page_size // 2)
    by_pmid = {}
    for r in _literature_epmc_fetch(c_query, per_branch):
        pmid = str(r.get('pmid') or '').strip()
        if pmid:
            by_pmid[pmid] = r
    for r in _literature_epmc_fetch(p_query, per_branch):
        pmid = str(r.get('pmid') or '').strip()
        if pmid and pmid not in by_pmid:
            by_pmid[pmid] = r
    return list(by_pmid.values())[:page_size]


def _literature_paper_is_relevant(gene, c_dot, p_terms, result, trusted_pmids):
    pmid = str(result.get('pmid') or '').strip()
    if pmid and pmid in trusted_pmids:
        return True
    blob = ' '.join([
        str(result.get('title') or ''),
        str(result.get('abstractText') or result.get('abstract') or ''),
    ])
    return _literature_variant_match_text(gene, c_dot, p_terms, blob)


@lit_bp.route('/api/download_literature', methods=['POST'])
def download_literature():
    import requests
    import urllib.parse
    import re
    
    data = request.json
    gene = data.get('gene', '').strip()
    c_dot_raw = data.get('c_dot', '').strip()
    force_pmids_raw = data.get('force_pmids', '').strip()
    
    # Sanitize
    c_match = re.search(r'c\.\d+[-+*]?\d*[a-zA-Z]>[a-zA-Z]', c_dot_raw)
    c_dot = c_match.group(0) if c_match else c_dot_raw
    
    if not gene or not c_dot:
        return jsonify({"error": "Gene and c. notation are required."}), 400
        
    safe_c_dot = c_dot.replace('>', '_').replace('+', '_plus_').replace('*', '_star_')
    folder_name = f"{gene}_{safe_c_dot}"
    
    # Downloaded papers go under the consolidated data root (VC_DATA_ROOT/pdfs),
    # overridable with VC_PDF_DIR. Falls back to the legacy location if it still
    # exists and no consolidated/override path is configured.
    base_dir = _resolve_pdf_base_dir()
    folder_path = os.path.join(base_dir, folder_name)
    
    if not os.path.exists(folder_path):
        os.makedirs(folder_path, exist_ok=True)
        
    vid_raw = data.get('vid', '').strip()

    _hgmd_raw = data.get('hgmd_pmids')
    hgmd_pmids_list = []
    if isinstance(_hgmd_raw, list):
        hgmd_pmids_list = [str(p).strip() for p in _hgmd_raw if str(p).strip().isdigit()]
    elif isinstance(_hgmd_raw, str) and _hgmd_raw.strip():
        hgmd_pmids_list = re.findall(r'\d{5,}', _hgmd_raw)

    hgvs_p = data.get('hgvs_p', '').strip()
    isoform_lit = data.get('alternate_transcript_literature') or []
    _, p_terms, _, isoform_entries = _literature_all_variant_terms(c_dot, hgvs_p, isoform_lit)

    forced_list = []
    if force_pmids_raw:
        forced_list = [p.strip() for p in force_pmids_raw.split(',') if p.strip() and p.strip().isdigit()]

    trusted_pmids = set(str(p) for p in forced_list)
    trusted_pmids.update(str(p) for p in hgmd_pmids_list)

    # Priority: manual override → HGMD row PMIDs → gene+c./gene+p. PubMed/EuropePMC → ClinVar isoform alternates
    ordered_pmids = []
    seen_pmids = set()

    def _queue_pmid(pmid, label=''):
        sp = str(pmid).strip()
        if not sp or not sp.isdigit() or sp in seen_pmids:
            return
        seen_pmids.add(sp)
        ordered_pmids.append((sp, label or f'PubMed_{sp}'))

    for p in forced_list:
        _queue_pmid(p, f'Forced_{p}')
    for p in hgmd_pmids_list:
        _queue_pmid(p, f'HGMD_{p}')

    # Local Literature Index: mutation search; HGMD-overlapping PMIDs are trusted.
    lit_index_payload = search_lit_index(
        gene,
        c_dot,
        hgvs_p=hgvs_p,
        hgmd_pmids=hgmd_pmids_list,
    )
    for p in lit_index_payload.get("hgmd_overlap_pmids") or []:
        _queue_pmid(p, f'LitIndex_HGMD_{p}')
        trusted_pmids.add(str(p))
    for p in lit_index_payload.get("pmids") or []:
        _queue_pmid(p, f'LitIndex_{p}')
        trusted_pmids.add(str(p))
    try:
        doc_txt = format_lit_index_document(lit_index_payload, gene=gene, c_dot=c_dot)
        if doc_txt:
            with open(
                os.path.join(folder_path, "_local_literature_index.txt"),
                "w",
                encoding="utf-8",
            ) as f:
                f.write(doc_txt)
    except Exception as lit_idx_write_err:
        print(f"[lit_index] write folder note failed: {lit_idx_write_err}", flush=True)

    epmc_by_pmid = {}
    retmax_primary = 10 if hgmd_pmids_list else 15
    epmc_page = 18 if hgmd_pmids_list else 25
    pubmed_variant_ids = _literature_pubmed_variant_ids(gene, c_dot, p_terms, retmax=retmax_primary)
    for pid in pubmed_variant_ids:
        _queue_pmid(pid, f'PubMed_{pid}')

    epmc_raw = _literature_epmc_variant_search(gene, c_dot, p_terms, page_size=epmc_page)
    for r in epmc_raw:
        if not _literature_paper_is_relevant(gene, c_dot, p_terms, r, trusted_pmids):
            continue
        pmid = str(r.get('pmid') or '').strip()
        if pmid:
            epmc_by_pmid[pmid] = r
            _queue_pmid(pmid, r.get('title') or f'EuropePMC_{pmid}')

    if len(ordered_pmids) < 5:
        clinvar_uid = _clinvar_variation_uid_for_pubmed_elink(gene, c_dot, vid_raw)
        if clinvar_uid:
            try:
                elink_url = _ncbi_url(
                    'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi'
                    f'?dbfrom=clinvar&db=pubmed&id={clinvar_uid}&retmode=json'
                )
                elink_res = requests.get(elink_url, timeout=8).json()
                for lsd in (elink_res.get('linksets') or [{}])[0].get('linksetdbs') or []:
                    if lsd.get('dbto') == 'pubmed' and lsd.get('links'):
                        for pid in [str(p) for p in lsd['links'][:10]]:
                            stub = {'pmid': pid, 'title': f'ClinVar_linked_{pid}'}
                            if _literature_paper_is_relevant(gene, c_dot, p_terms, stub, trusted_pmids):
                                _queue_pmid(pid, stub['title'])
                        break
            except Exception as e:
                print(f'ClinVar elink (literature) error: {e}')

    if isoform_entries:
        _literature_queue_isoform_variant_papers(
            gene, isoform_entries, _queue_pmid, epmc_by_pmid,
        )

    results = []
    for pmid, title in ordered_pmids:
        if pmid in epmc_by_pmid:
            results.append(epmc_by_pmid[pmid])
        else:
            results.append({'pmid': pmid, 'title': title})

    try:
        downloaded = 0
        file_paths = []
        fetch_cap = 15
        if hgmd_pmids_list:
            fetch_cap = min(max(15, len(hgmd_pmids_list) + len(forced_list)), 30)
        for r in results[:fetch_cap]:
            pmcid = r.get('pmcid')
            pmid = r.get('pmid')
            doi = r.get('doi')
            title = r.get('title', 'Unknown Title')
            
            success = False
            
            # Step 1: Attempt NCBI OA Download (if open access)
            if pmcid:
                oa_url = f"https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id={pmcid}"
                try:
                    import xml.etree.ElementTree as ET
                    import tarfile
                    import io

                    oa_res = requests.get(oa_url, timeout=15)
                    if oa_res.status_code == 200:
                        root = ET.fromstring(oa_res.content)
                        for link in root.iter('link'):
                            if link.get('format') == 'tgz':
                                ftp_url = link.get('href')
                                if ftp_url:
                                    https_url = ftp_url.replace("ftp://", "https://")
                                    tar_res = requests.get(https_url, timeout=45)
                                    if tar_res.status_code == 200:
                                        tar_stream = io.BytesIO(tar_res.content)
                                        with tarfile.open(fileobj=tar_stream, mode='r:gz') as tar:
                                            found_any_file = False
                                            for member in tar.getmembers():
                                                ext = os.path.splitext(member.name)[1].lower()
                                                # Target PDFs and common supplemental data file extensions
                                                if ext in ['.pdf', '.xlsx', '.xls', '.csv', '.tsv', '.doc', '.docx', '.zip']:
                                                    if member.isreg(): # Ensure it's a regular file
                                                        extracted_file = tar.extractfile(member)
                                                        if extracted_file:
                                                            file_data = extracted_file.read()
                                                            safe_title = "".join([c for c in title if c.isalpha() or c.isdigit() or c==' ']).rstrip().replace(' ', '_')[:30]
                                                            orig_basename = os.path.basename(member.name)
                                                            # Use the original basename to retain context (e.g. Table_S1.xlsx)
                                                            filename = f"PMID_{pmid}_{orig_basename}" if pmid else f"{pmcid}_{orig_basename}"
                                                            file_path = os.path.join(folder_path, filename)
                                                            with open(file_path, 'wb') as f:
                                                                f.write(file_data)
                                                            found_any_file = True
                                            if found_any_file:
                                                downloaded += 1
                                                success = True
                except Exception as e:
                    print(f"OA API Extraction failed for {pmcid}: {e}")
                    
            # Step 2: Attempt Sci-Hub Scraper (if OA failed or paper is paywalled/has no PMC metadata)
            if not success and (pmid or doi):
                try:
                    from bs4 import BeautifulSoup
                    import urllib3
                    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
                    
                    sci_hub_domains = ['https://sci-hub.se', 'https://sci-hub.st', 'https://sci-hub.ru']
                    target_id = doi if doi else f"pmid/{pmid}"
                    
                    for sh_domain in sci_hub_domains:
                        try:
                            sh_url = f"{sh_domain}/{target_id}"
                            sh_res = requests.get(sh_url, timeout=15, verify=False)
                            if sh_res.status_code == 200:
                                soup = BeautifulSoup(sh_res.text, 'html.parser')
                                pdf_url = None
                                
                                iframe = soup.find('iframe', id='pdf')
                                if iframe and iframe.get('src'):
                                    pdf_url = iframe.get('src')
                                    
                                if not pdf_url:
                                    embed = soup.find('embed', id='pdf')
                                    if embed and embed.get('src'):
                                        pdf_url = embed.get('src')
                                        
                                if not pdf_url:
                                    button = soup.find('button', {"onclick": lambda v: v and "location.href" in v})
                                    if button:
                                        import re
                                        m = re.search(r"location\.href='(.*?)'", button['onclick'])
                                        if m: pdf_url = m.group(1)
                                        
                                if pdf_url:
                                    if pdf_url.startswith('//'): pdf_url = 'https:' + pdf_url
                                    elif pdf_url.startswith('/'): pdf_url = sh_domain + pdf_url
                                    
                                    pdf_res = requests.get(pdf_url, timeout=30, verify=False)
                                    if pdf_res.status_code == 200 and len(pdf_res.content) > 10000:
                                        safe_title = "".join([c for c in title if c.isalpha() or c.isdigit() or c==' ']).rstrip().replace(' ', '_')[:50]
                                        filename = f"SciHub_PMID_{pmid}_{safe_title}.pdf" if pmid else f"SciHub_{doi.replace('/','-')}.pdf"
                                        file_path = os.path.join(folder_path, filename)
                                        with open(file_path, 'wb') as f:
                                            f.write(pdf_res.content)
                                        downloaded += 1
                                        file_paths.append(file_path)
                                        success = True
                                        break
                        except Exception as e:
                            continue
                except Exception as e:
                    print(f"Sci-Hub framework error: {e}")
                    
            # Step 3: Fallback to XML Abstract/Full-Text Text ripping
            if not success and (pmcid or pmid):
                xml_url = _ncbi_url(
                    f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id={pmcid}&retmode=xml"
                    if pmcid
                    else f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id={pmid}&retmode=xml"
                )
                try:
                    import xml.etree.ElementTree as ET
                    import re
                    xml_res = requests.get(xml_url, timeout=15)
                    if xml_res.status_code == 200 and len(xml_res.content) > 100:
                        safe_title = "".join([c for c in title if c.isalpha() or c.isdigit() or c==' ']).rstrip().replace(' ', '_')[:50]
                        plain_text = ""
                        try:
                            root = ET.fromstring(xml_res.content)
                            plain_text = " ".join(root.itertext())
                            plain_text = re.sub(r'\s+', ' ', plain_text).strip()
                        except Exception:
                            plain_text = re.sub(r'<[^>]+>', ' ', xml_res.text)
                            plain_text = re.sub(r'\s+', ' ', plain_text).strip()
                            
                        if len(plain_text) > 100:
                            filename = f"PMID_{pmid}_{safe_title}.txt" if pmid else f"{pmcid}_{safe_title}.txt"
                            file_path = os.path.join(folder_path, filename)
                            with open(file_path, 'w', encoding='utf-8') as f:
                                f.write(plain_text)
                            downloaded += 1
                            file_paths.append(file_path)
                            success = True
                except Exception as fallback_e:
                    print(f"Failed to download PMC/PubMed XML fallback: {fallback_e}")
                    
        strategy = "hgmd_first+gene_c_p_search" if hgmd_pmids_list else "gene_c_p_search"
        if lit_index_payload.get("pmids"):
            strategy += "+local_literature_index"
        if isoform_entries:
            strategy += "+clinvar_isoform_hgvs"
        return jsonify({
            "status": "success",
            "literature_index": {
                "query": lit_index_payload.get("query"),
                "hit_count": lit_index_payload.get("hit_count", 0),
                "pmids": lit_index_payload.get("pmids") or [],
                "hgmd_overlap_pmids": lit_index_payload.get("hgmd_overlap_pmids") or [],
                "message": lit_index_payload.get("message"),
            },
            "message": f"Downloaded {downloaded} articles to {folder_name}",
            "count": downloaded,
            "folder": folder_path,
            "files": file_paths,
            "strategy": strategy,
            "isoform_literature_searched": len(isoform_entries),
            "queued_pmids": [str(r.get('pmid')) for r in results[:fetch_cap] if r.get('pmid')],
            "pmids": [str(r.get('pmid')) for r in results[:fetch_cap] if r.get('pmid')],
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        msg = str(e)
        if 'Read timed out' in msg or 'ConnectionError' in msg or 'ConnectTimeout' in msg:
            msg = "Literature server (EuropePMC / NCBI) timed out. Please retry in a moment."
        return jsonify({"error": msg}), 500


def _literature_queued_pmids_from_request(data) -> set[str] | None:
    """
    When the client passes queued_pmids, summarize only those files (avoids stale PDFs in folder).
    None = legacy behavior (scan entire folder).
    """
    import re

    raw = data.get('queued_pmids')
    if raw is None:
        raw = data.get('allowed_pmids')
    if raw is None:
        return None
    if isinstance(raw, list):
        items = [str(p).strip() for p in raw]
    else:
        items = [p.strip() for p in str(raw).split(',')]
    return {p for p in items if p.isdigit()}


def _literature_file_matches_queued_pmids(filename: str, queued: set[str] | None) -> bool:
    if not queued:
        return True
    # Always keep the local Literature Index note written during download.
    if filename.startswith("_local_literature_index"):
        return True
    import re
    m = re.search(r'PMID[_-]?(\d+)', filename, re.I)
    return bool(m and m.group(1) in queued)


def _filter_literature_summary_irrelevant(
    summary: str,
    gene: str,
    c_dot: str,
    *,
    extra_c_dots=None,
    hgvs_p=None,
    p_terms=None,
    hgvs_ps=None,
    hgmd_pmids=None,
    empty_sentinel=None,
) -> str:
    """
    Drop PMID blocks where Gemini admits the specific allele is absent (rule 3 violations).
    Keeps supplemental-table alerts and lines that cite HGVS c., p., or synonymous prose.
    """
    if not summary or not str(summary).strip():
        return summary

    c_norms = []
    for cd in [c_dot] + list(extra_c_dots or []):
        cn = re.sub(r'\s+', '', (cd or '').lower())
        if cn and cn not in c_norms:
            c_norms.append(cn)
    c_norm = c_norms[0] if c_norms else ""
    c_core = c_norm[2:] if c_norm.startswith('c.') else c_norm
    extra_cores = []
    for cn in c_norms[1:]:
        core = cn[2:] if cn.startswith('c.') else cn
        if core and core not in extra_cores:
            extra_cores.append(core)
    if p_terms is None:
        p_terms = _literature_protein_search_terms(hgvs_p)
    hgmd_set = set(re.findall(r'\d{5,}', str(hgmd_pmids or '')))
    if empty_sentinel is None:
        empty_sentinel = _LITERATURE_NO_PATIENTS_SENTINEL
    drop_phrases = (
        'not mentioned',
        'is not mentioned',
        'was not mentioned',
        'does not mention',
        'do not mention',
        'never explicitly mentions',
        'not describe',
        'does not describe',
        'no mention of',
        'other variants in',
        'heterozygous variants in',
    )
    blocks = re.split(r'(?=PMID\s*:?\s*\d+)', str(summary), flags=re.I)
    kept: list[str] = []
    for block in blocks:
        chunk = block.strip()
        if not chunk:
            continue
        if not re.match(r'PMID', chunk, re.I):
            kept.append(block)
            continue
        low = chunk.lower()
        if 'variant not found in main text' in low and 'supplement' in low:
            kept.append(block)
            continue
        blob_compact = re.sub(r'\s+', '', low)
        protein_hit = _literature_summary_chunk_matches_protein(
            chunk, p_terms, hgvs_p=hgvs_p, hgvs_ps=hgvs_ps,
        )
        if c_core and c_core in blob_compact:
            kept.append(block)
            continue
        if c_norm and c_norm in blob_compact:
            kept.append(block)
            continue
        if any(ec and ec in blob_compact for ec in extra_cores):
            kept.append(block)
            continue
        if any(en and en in blob_compact for en in c_norms[1:]):
            kept.append(block)
            continue
        if protein_hit:
            kept.append(block)
            continue
        if any(p in low for p in drop_phrases):
            continue
        kept.append(chunk)
    out = ''.join(kept).strip()
    if not out or not re.search(r'PMID\s*:?\s*\d+', out, re.I):
        return empty_sentinel
    return out


_LITERATURE_NO_PATIENTS_SENTINEL = (
    'Papers downloaded but no patients with variants in publications.'
)


_FUNCTIONAL_NO_STUDIES_SENTINEL = 'No functional studies found.'


def _literature_source_supports_c_dot(combined_text: str, c_dot: str) -> bool:
    """True when downloaded paper text contains the HGVS c. (or intronic offset) verbatim-ish."""
    if not combined_text or not c_dot:
        return False
    blob = re.sub(r'\s+', '', combined_text.lower())
    cn = re.sub(r'\s+', '', c_dot.lower())
    core = cn[2:] if cn.startswith('c.') else cn
    if core and core in blob:
        return True
    m = re.match(r'c\.(\d+)([-+])(\d+)', cn, re.I)
    if m:
        pos, op, off = m.group(1), m.group(2), m.group(3)
        for op_alt in (op, op.replace('-', '\u2212'), op.replace('+', '\u002b')):
            if f'{pos}{op_alt}{off}' in blob:
                return True
    return False


def _literature_filter_unsupported_allele_blocks(
    summary: str,
    combined_text: str,
    c_dot: str,
    *,
    p_terms=None,
    empty_sentinel=None,
) -> str:
    """
    Drop PMID blocks when the downloaded source text lacks the submitted allele.
    Stops Gemini from attributing same-gene papers (e.g. PMID 37980560) to the wrong c./p.
    """
    if not summary or not str(summary).strip() or not combined_text:
        return summary
    if empty_sentinel is None:
        empty_sentinel = _LITERATURE_NO_PATIENTS_SENTINEL
    if _literature_source_supports_c_dot(combined_text, c_dot):
        return summary
    blob = re.sub(r'\s+', '', combined_text.lower())
    if p_terms:
        for form in _literature_p_search_forms(p_terms):
            if form and re.sub(r'\s+', '', form.lower()) in blob:
                return summary
    blocks = re.split(r'(?=PMID\s*:?\s*\d+)', str(summary), flags=re.I)
    kept: list[str] = []
    for block in blocks:
        chunk = block.strip()
        if not chunk:
            continue
        if not re.match(r'PMID', chunk, re.I):
            kept.append(block)
            continue
        low = chunk.lower()
        if 'variant not found in main text' in low and 'supplement' in low:
            kept.append(block)
            continue
    out = ''.join(kept).strip()
    if not out or not re.search(r'PMID\s*:?\s*\d+', out, re.I):
        return empty_sentinel
    return out


def _literature_filter_hgmd_hallucinations(
    summary: str,
    combined_text: str,
    c_dot: str,
    *,
    p_terms=None,
    hgmd_pmids=None,
    empty_sentinel=None,
) -> str:
    """
    Drop HGMD-linked PMID blocks when the source PDF/text lacks the submitted c. or p. forms.
    Prevents attributing a catalog PMID to the wrong allele (e.g. INTS11 c.29-890 vs paper's missense).
    """
    if not summary or not str(summary).strip():
        return summary
    if empty_sentinel is None:
        empty_sentinel = _LITERATURE_NO_PATIENTS_SENTINEL
    filtered = _literature_filter_unsupported_allele_blocks(
        summary, combined_text, c_dot, p_terms=p_terms, empty_sentinel=empty_sentinel,
    )
    if not hgmd_pmids or filtered != summary:
        return filtered
    hgmd_set = set(re.findall(r'\d{5,}', str(hgmd_pmids)))
    if not hgmd_set:
        return filtered
    if _literature_source_supports_c_dot(combined_text, c_dot):
        return summary
    blob = re.sub(r'\s+', '', combined_text.lower())
    if p_terms:
        for form in _literature_p_search_forms(p_terms):
            if form and re.sub(r'\s+', '', form.lower()) in blob:
                return summary
    blocks = re.split(r'(?=PMID\s*:?\s*\d+)', str(summary), flags=re.I)
    kept: list[str] = []
    for block in blocks:
        chunk = block.strip()
        if not chunk:
            continue
        if not re.match(r'PMID', chunk, re.I):
            kept.append(block)
            continue
        pm = re.search(r'PMID\s*:?\s*(\d+)', chunk, re.I)
        low = chunk.lower()
        if pm and pm.group(1) in hgmd_set:
            if 'supplement' in low and 'not found in main text' in low:
                kept.append(block)
            continue
        kept.append(block)
    out = ''.join(kept).strip()
    if not out or not re.search(r'PMID\s*:?\s*\d+', out, re.I):
        return empty_sentinel
    return out


def _literature_hgmd_relaxed_prompt(
    gene: str,
    c_dot: str,
    hgvs_p: str,
    hgmd_pmids: str,
    p_terms,
    isoform_str: str,
    combined_text: str,
) -> str:
    p_lines = _literature_p_prompt_lines(p_terms)
    p_block = (
        "\n".join(p_lines)
        if p_lines
        else "  • (none — use HGVS c. and alternate isoforms only)"
    )
    sub = _parse_missense_substitution_hgvs_p(hgvs_p)
    prose_hint = ""
    if sub:
        ref_name = _AA_THREE_TO_FULL.get(sub['ref_3'], sub['ref_3'].lower())
        alt_name = _AA_THREE_TO_FULL.get(sub['alt_3'], sub['alt_3'].lower())
        prose_hint = (
            f"Papers may describe this allele only as plain language "
            f"(e.g. \"{ref_name} to {alt_name}\" or \"{ref_name} substitution\") "
            f"or a dbSNP rs ID — that still counts as THIS variant.\n"
        )
    return f"""
You are an expert clinical genetic counselor. HGMD links PMID(s) {hgmd_pmids} to {gene} {c_dot}
({hgvs_p or 'protein unknown'}). Review ONLY these HGMD-cited papers.

{prose_hint}{isoform_str}

SYNONYMOUS PROTEIN NOTATION (same allele — treat as equivalent to {c_dot}):
{p_block}

OUTPUT STYLE: For each PMID with patient-level evidence for THIS allele, print exactly:
"PMID [number]: " then one compact paragraph with: mutation; patient/carrier count; disorder;
inheritance (de novo / inherited / unclear); affected relatives if stated.

RULES:
1. VARIANT FOUND if patients/carriers carry {gene} with {c_dot}, any alternate isoform HGVS above,
   any synonymous protein form above, dbSNP rs ID cited for this change, or plain-language amino-acid
   substitution text matching the curated protein change — even when the exact HGVS c. string is absent.
2. Do NOT output a line that only says the c. string was "not mentioned" while describing matching
   patients — summarize the patients under rule 1 instead.
3. SUPPLEMENTAL: If variant lists are only in supplementary files, use the ⚠️ supplemental alert format.
4. Omit only papers with no patient-level evidence for this allele.

If no paper describes patients with this allele, output exactly and only:
"{_LITERATURE_NO_PATIENTS_SENTINEL}"

Papers:
{combined_text[:800000]}
"""


@lit_bp.route('/api/summarize_literature', methods=['POST'])
def summarize_literature():
    data = request.json
    folder_path = data.get('folder_path', '').strip()
    gene = data.get('gene', '').strip()
    c_dot = data.get('c_dot', '').strip()
    force_pmids = data.get('force_pmids', '').strip()
    isoform_lit = data.get('alternate_transcript_literature') or []
    hgvs_p = (data.get('hgvs_p') or '').strip()
    lit_ctx = _literature_summarize_variant_context(gene, c_dot, hgvs_p, isoform_lit)
    
    if not folder_path or not os.path.exists(folder_path):
        return jsonify({"error": "Invalid or missing folder path."}), 400
        
    try:
        import fitz

        queued_pmids = _literature_queued_pmids_from_request(data)
        if queued_pmids is not None and not queued_pmids:
            return jsonify({
                "status": "success",
                "summary": "Papers downloaded but no patients with variants in publications.",
            })

        # 1. Gather text (optionally restricted to this download's PMIDs only)
        documents_text = []
        for filename in os.listdir(folder_path):
            if not _literature_file_matches_queued_pmids(filename, queued_pmids):
                continue
            file_path = os.path.join(folder_path, filename)
            if filename.lower().endswith('.pdf'):
                doc = fitz.open(file_path)
                text = ""
                for page in doc:
                    text += page.get_text() + "\n"
                doc.close()
                documents_text.append(f"--- Document: {filename} ---\n{text}\n")
            elif filename.lower().endswith('.txt'):
                with open(file_path, 'r', encoding='utf-8') as f:
                    text = f.read()
                documents_text.append(f"--- Document: {filename} ---\n{text}\n")
                
        if not documents_text:
            return jsonify({"error": "No literature available to summarize."}), 400
            
        combined_text = "\n".join(documents_text)
        
        from dotenv import load_dotenv
        dotenv_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), '.env')
        load_dotenv(dotenv_path=dotenv_path, override=True)
        client = _require_llm_client()
        if client is None:
            return jsonify({"error": "LLM is not configured (GVI proxy or GEMINI_API_KEY)."}), 500
        
        isoform_str = lit_ctx['isoform_str']
        p_str = lit_ctx['p_str']
        p_terms_all = lit_ctx['p_terms_all']
        hgvs_ps = lit_ctx['hgvs_ps']
        isoform_c_dots = lit_ctx['isoform_c_dots']

        override_str = ""
        if force_pmids:
            override_str = (
                f"MANUAL OVERRIDE: The user forced these PMIDs: {force_pmids}. "
                f"Summarize only if the paper describes {gene} {c_dot} OR places variant lists in supplemental files; "
                "otherwise apply rule 3 (omit)."
            )
        hgmd_pmids = data.get('hgmd_pmids', '').strip()
        if hgmd_pmids:
            override_str += (
                "\n\nHGMD PRIMARY LITERature: PubMed ID(s) "
                f"{hgmd_pmids} are catalog links that may cite {gene} {c_dot}"
                f"{'; ' + hgvs_p if hgvs_p else ''}. "
                "Summarize patient evidence ONLY when the paper text explicitly describes this allele "
                "(HGVS c., HGVS p., rs ID, or plain-language substitution matching the submitted change). "
                "Quote the allele AS WRITTEN IN THE PAPER. If the paper describes a DIFFERENT "
                f"{gene} variant (other nucleotide, splice site, or protein change), apply rule 3 "
                f"(omit) — do NOT substitute {c_dot} for what the paper actually reports.\n"
            )

        prompt = f"""
You are an expert clinical genetic counselor. Review the following scientific papers related to the gene {gene} and variant {c_dot}.
Your primary goal is to determine if ANY of these papers describe actual patients carrying the specific variant {gene} {c_dot}.

{override_str}{isoform_str}{p_str}

OUTPUT STYLE (keep each PMID summary SHORT — suitable for methods / supplementary table text):
When you summarize patient-level evidence, ALWAYS include in plain language:
  • The mutation (gene + HGVS c.; add p. if stated in the paper).
  • How many patients / carriers are described with THIS variant (number; say "unclear" only if truly ambiguous).
  • Disorder(s) / phenotype attributed to the variant in that paper.
  • Whether inheritance is described as de novo, inherited/familial, unclear, or mixed across families.
  • If inherited: which affected relatives are stated to carry (or be homozygous for) THIS allele (e.g. "affected mother II-2").
If the paper does not provide one of these items, write "not stated" for that item rather than guessing.

Follow these strict rules for evaluating each paper:
1. VARIANT FOUND: If a paper contains clinical cases carrying {gene} {c_dot}, any alternate isoform HGVS listed above, any curated protein form listed above, a dbSNP rs ID for this same amino-acid change, or plain-language amino-acid substitution text matching the curated protein change (not merely other variants in the same gene), print exactly: "PMID [number]: " followed by one compact paragraph using the OUTPUT STYLE bullets above (you may use inline labels like "Patients: …; Disorder: …; Inheritance: …" instead of bullet glyphs). Do NOT print a PMID line that says the variant was "not mentioned" — summarize the patients under rule 1 instead.
2. SUPPLEMENTAL DATA ALERT: If a paper does NOT mention the specific variant {c_dot}, but the text explicitly states that tables of variants, patient genotypes, or clinical data have been placed in "Supplemental Tables", "Supplementary Data", or "Additional files", output exactly: "PMID [number]: ⚠️ Variant not found in main text, but the authors state that variant/patient lists are located in Supplementary Files. Please review the downloaded Excel/CSV files in your local folder."
3. IRRELEVANT: Ignore and do not summarize papers that lack the variant AND lack references to variants in supplemental files. Do not print anything for them.

If EVERY downloaded paper falls into category 3 (they all completely lack both the variant and supplemental references, and no manual overrides exist), you MUST output exactly and only:
"{_LITERATURE_NO_PATIENTS_SENTINEL}"


Papers:
{combined_text[:800000]}
        """

        response = _run_gemini(client, prompt)
        cleaned = _filter_literature_summary_irrelevant(
            response.text,
            gene,
            c_dot,
            extra_c_dots=isoform_c_dots,
            hgvs_p=hgvs_p,
            p_terms=p_terms_all,
            hgvs_ps=hgvs_ps,
            hgmd_pmids=hgmd_pmids,
        )
        cleaned = _literature_filter_unsupported_allele_blocks(
            cleaned, combined_text, c_dot, p_terms=p_terms_all,
        )
        cleaned = _literature_filter_hgmd_hallucinations(
            cleaned, combined_text, c_dot, p_terms=p_terms_all, hgmd_pmids=hgmd_pmids,
        )
        if cleaned == _LITERATURE_NO_PATIENTS_SENTINEL and hgmd_pmids:
            hgmd_retry_prompt = _literature_hgmd_relaxed_prompt(
                gene, c_dot, hgvs_p, hgmd_pmids, p_terms_all, isoform_str, combined_text,
            )
            retry_response = _run_gemini(client, hgmd_retry_prompt)
            cleaned = _filter_literature_summary_irrelevant(
                retry_response.text,
                gene,
                c_dot,
                extra_c_dots=isoform_c_dots,
                hgvs_p=hgvs_p,
                p_terms=p_terms_all,
                hgvs_ps=hgvs_ps,
                hgmd_pmids=hgmd_pmids,
            )
            cleaned = _literature_filter_unsupported_allele_blocks(
                cleaned, combined_text, c_dot, p_terms=p_terms_all,
            )
            cleaned = _literature_filter_hgmd_hallucinations(
                cleaned, combined_text, c_dot, p_terms=p_terms_all, hgmd_pmids=hgmd_pmids,
            )
        return jsonify({
            "status": "success",
            "summary": cleaned,
        })
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"AI Summarization failed: {str(e)}"}), 500


@lit_bp.route('/api/summarize_functional', methods=['POST'])
def summarize_functional():
    data = request.json
    folder_path = data.get('folder_path', '').strip()
    gene = data.get('gene', '').strip()
    c_dot = data.get('c_dot', '').strip()
    force_pmids = data.get('force_pmids', '').strip()
    isoform_lit = data.get('alternate_transcript_literature') or []
    hgvs_p = (data.get('hgvs_p') or '').strip()
    lit_ctx = _literature_summarize_variant_context(gene, c_dot, hgvs_p, isoform_lit)
    
    if not folder_path or not os.path.exists(folder_path):
        return jsonify({"error": "Invalid or missing folder path."}), 400
        
    try:
        import fitz

        queued_pmids = _literature_queued_pmids_from_request(data)
        if queued_pmids is not None and not queued_pmids:
            return jsonify({
                "status": "success",
                "summary": "No functional studies identified for this variant.",
            })

        documents_text = []
        for filename in os.listdir(folder_path):
            if not _literature_file_matches_queued_pmids(filename, queued_pmids):
                continue
            file_path = os.path.join(folder_path, filename)
            if filename.lower().endswith('.pdf'):
                doc = fitz.open(file_path)
                text = ""
                for page in doc:
                    text += page.get_text() + "\n"
                doc.close()
                documents_text.append(f"--- Document: {filename} ---\n{text}\n")
            elif filename.lower().endswith('.txt'):
                with open(file_path, 'r', encoding='utf-8') as f:
                    text = f.read()
                documents_text.append(f"--- Document: {filename} ---\n{text}\n")
                
        if not documents_text:
            return jsonify({"error": "No literature available to summarize."}), 400
            
        combined_text = "\n".join(documents_text)
        
        from dotenv import load_dotenv
        load_dotenv(override=True)
        client = _require_llm_client()
        if client is None:
            return jsonify({"error": "LLM is not configured (GVI proxy or GEMINI_API_KEY)."}), 500
        
        isoform_str = lit_ctx['isoform_str']
        p_str = lit_ctx['p_str']
        isoform_c_dots = lit_ctx['isoform_c_dots']
        p_terms_all = lit_ctx['p_terms_all']
        hgvs_ps = lit_ctx['hgvs_ps']

        override_str = ""
        if force_pmids:
            override_str = (
                f"MANUAL OVERRIDE: The user forced these PMIDs: {force_pmids}. "
                f"If a paper matches one of these PMIDs, summarize functional assay data for {gene} "
                f"{c_dot} or synonymous protein / alternate isoform HGVS forms listed below.\n"
            )
        hgmd_pmids = data.get('hgmd_pmids', '').strip()
        if hgmd_pmids:
            override_str += (
                f"\n\nHGMD PRIMARY LITERATURE: PubMed ID(s) {hgmd_pmids} are linked to THIS variant "
                f"({gene} {c_dot}{'; ' + hgvs_p if hgvs_p else ''}) in the local HGMD export. "
                "Summarize molecular/functional assay data for this allele when cited via HGVS c., HGVS p., "
                "dbSNP rs ID, or plain-language amino-acid substitution — even if the exact HGVS c. string "
                "is absent.\n"
            )

        prompt = f"""
You review downloaded papers for VARIANT-SPECIFIC molecular functional evidence (gene {gene}, variant {c_dot}).

{override_str}{isoform_str}{p_str}

GOAL — VERY SIMPLE: For each qualifying paper, state clearly **what biological function is impaired or altered** by THIS variant (e.g. enzyme activity loss, protein stability, membrane trafficking, DNA binding, signaling readout). Use plain language; 1–3 sentences after the PMID line.

RULES:
• Summarize assays that tested THIS allele: {gene} {c_dot}, any curated protein form above, or any ClinVar alternate isoform HGVS above (gene + c. OR gene + p.) — not a different amino-acid change.
• Do NOT treat clinical imaging or descriptive phenotyping alone as "functional"; there must be a molecular/cellular assay (e.g. western blot, reporter, complementation, kinase assay, binding assay).
• If the paper discusses functional impact only for another allele in {gene}, omit it entirely.

OUTPUT FORMAT:
1. FOUND: "PMID [number]: " then answer only: what does this variant impair or change in the assay(s)?
2. SUPPLEMENTAL: If the allele is absent from main text but supplementary variant tables are explicitly referenced: "PMID [number]: ⚠️ Variant not in main text — supplementary tables/files may list assays; check downloaded supplements."
3. IRRELEVANT: Omit papers with no molecular assay for this allele.

If nothing qualifies: output exactly:
"{_FUNCTIONAL_NO_STUDIES_SENTINEL}"

Papers:
{combined_text[:800000]}
        """

        response = _run_gemini(client, prompt)
        cleaned = _filter_literature_summary_irrelevant(
            response.text,
            gene,
            c_dot,
            extra_c_dots=isoform_c_dots,
            hgvs_p=hgvs_p,
            p_terms=p_terms_all,
            hgvs_ps=hgvs_ps,
            hgmd_pmids=hgmd_pmids,
            empty_sentinel=_FUNCTIONAL_NO_STUDIES_SENTINEL,
        )
        cleaned = _literature_filter_unsupported_allele_blocks(
            cleaned, combined_text, c_dot, p_terms=p_terms_all,
            empty_sentinel=_FUNCTIONAL_NO_STUDIES_SENTINEL,
        )
        return jsonify({
            "status": "success",
            "summary": cleaned,
        })
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"Functional Summarization failed: {str(e)}"}), 500


@lit_bp.route('/api/download_mechanism', methods=['POST'])
def download_mechanism():
    import requests
    import urllib.parse
    import os
    import re
    
    data = request.json
    gene = data.get('gene', '').strip()
    
    if not gene:
        return jsonify({"error": "Gene is required."}), 400
        
    folder_name = f"{gene}_mechanism"
    base_dir = _resolve_pdf_base_dir()
    folder_path = os.path.join(base_dir, folder_name)
    
    if not os.path.exists(folder_path):
        os.makedirs(folder_path, exist_ok=True)
        
    # 1. Native ClinGen Injection
    try:
        score = clingen_db.get(gene)
        if score:
            cg_path = os.path.join(folder_path, "ClinGen_Summary.txt")
            with open(cg_path, 'w') as f:
                f.write(f"Source: ClinGen Expert Panel\nClinGen Triplosensitivity/Haploinsufficiency Score for {gene}: {score}\nNote: 3 indicates sufficient evidence for Haploinsufficiency/Triplosensitivity, 0 indicates no evidence, 4 indicates restrictive region.")
    except Exception as e:
        print(f"ClinGen TSV Mechanism Error: {e}")
        
    # 2. GeneReviews BeautifulSoup Extraction
    try:
        from bs4 import BeautifulSoup
        search_url = f"https://www.ncbi.nlm.nih.gov/books/NBK1116/?term={urllib.parse.quote(gene)}"
        req_res = requests.get(search_url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=15)
        soup = BeautifulSoup(req_res.text, 'html.parser')
        links = soup.find_all('a', href=re.compile(r'/books/NBK\d+/$'))
        if links:
            gr_url = "https://www.ncbi.nlm.nih.gov" + links[0]['href']
            gr_res = requests.get(gr_url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=15)
            gr_soup = BeautifulSoup(gr_res.text, 'html.parser')
            text = gr_soup.get_text(separator=' ')
            text = re.sub(r'\s+', ' ', text).strip()
            gr_path = os.path.join(folder_path, "GeneReviews_Summary.txt")
            with open(gr_path, 'w', encoding='utf-8') as f:
                f.write(f"Source: GeneReviews ({gr_url})\n\n{text[:25000]}")
    except Exception as e:
        print(f"GeneReviews Fetch Error: {e}")

    # 3. EuropePMC Foundational Literature
    query_str = f'((TITLE:"{gene}" OR ABSTRACT:"{gene}") AND ("loss of function" OR "gain of function" OR "dominant negative" OR "haploinsufficiency" OR "disease mechanism"))'
    encoded_query = urllib.parse.quote(query_str)
    
    url = f"https://www.ebi.ac.uk/europepmc/webservices/rest/search?query={encoded_query}&format=json&resultType=core&pageSize=60"
    try:
        headers = {'User-Agent': 'Mozilla/5.0'}
        response_data = None
        last_err = None
        for attempt, t in enumerate((25, 40, 60), start=1):
            try:
                res = requests.get(url, headers=headers, timeout=t)
                if res.status_code == 200:
                    response_data = res.json()
                    break
                last_err = f"HTTP {res.status_code}"
            except Exception as _ep_err:
                last_err = str(_ep_err)
                print(f"EuropePMC mechanism search attempt {attempt} failed (timeout={t}s): {_ep_err}")
        if response_data is None:
            print(f"EuropePMC mechanism search exhausted retries; skipping foundational literature. Last error: {last_err}")
            response_data = {'resultList': {'result': []}}
        results = response_data.get('resultList', {}).get('result', [])
        
        def score_paper(r):
            score = 0
            citations = r.get('citedByCount', 0)
            score += citations * 2.0
            
            title = r.get('title', '').lower()
            abstract = r.get('abstractText', '').lower()
            
            # Mechanistic keywords
            mech_keys = ["loss of function", "loss-of-function", "gain of function", "dominant negative", "haploinsufficiency", "haploinsufficient"]
            
            if any(k in title for k in mech_keys):
                score += 100
            elif 'mechanism' in title or 'review' in title:
                score += 50
                
            if any(k in abstract for k in mech_keys):
                score += 40
            year_int = 0
            try:
                year = r.get('pubYear')
                if year:
                    year_int = int(year)
                    if year_int > 2000: score += (year_int - 2000) * 2.0
            except: pass
            return (score, year_int)
            
        results.sort(key=score_paper, reverse=True)
        
        downloaded = 0
        file_paths = []
        for r in results[:3]:
            pmcid = r.get('pmcid')
            pmid = r.get('pmid')
            title = r.get('title', 'Unknown Title')
            
            if pmcid:
                oa_url = f"https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id={pmcid}"
                success = False
                try:
                    import xml.etree.ElementTree as ET
                    import tarfile
                    import io
                    oa_res = requests.get(oa_url, timeout=15)
                    if oa_res.status_code == 200:
                        root = ET.fromstring(oa_res.content)
                        for link in root.iter('link'):
                            if link.get('format') == 'tgz':
                                ftp_url = link.get('href')
                                if ftp_url:
                                    https_url = ftp_url.replace("ftp://", "https://")
                                    tar_res = requests.get(https_url, timeout=45)
                                    if tar_res.status_code == 200:
                                        tar_stream = io.BytesIO(tar_res.content)
                                        with tarfile.open(fileobj=tar_stream, mode='r:gz') as tar:
                                            for member in tar.getmembers():
                                                if member.name.lower().endswith('.pdf'):
                                                    pdf_file = tar.extractfile(member)
                                                    if pdf_file:
                                                        pdf_data = pdf_file.read()
                                                        safe_title = "".join([c for c in title if c.isalpha() or c.isdigit() or c==' ']).rstrip().replace(' ', '_')[:50]
                                                        filename = f"PMID_{pmid}_{safe_title}.pdf" if pmid else f"{pmcid}_{safe_title}.pdf"
                                                        file_path = os.path.join(folder_path, filename)
                                                        with open(file_path, 'wb') as f:
                                                            f.write(pdf_data)
                                                        downloaded += 1
                                                        file_paths.append(file_path)
                                                        success = True
                                                    break
                except Exception as e:
                    print(f"OA API Extraction failed for {pmcid}: {e}")
                    
                if not success:
                    xml_url = _ncbi_url(
                        f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id={pmcid}&retmode=xml"
                    )
                    try:
                        import xml.etree.ElementTree as ET
                        xml_res = requests.get(xml_url, timeout=15)
                        if xml_res.status_code == 200 and len(xml_res.content) > 100:
                            safe_title = "".join([c for c in title if c.isalpha() or c.isdigit() or c==' ']).rstrip().replace(' ', '_')[:50]
                            plain_text = re.sub(r'<[^>]+>', ' ', xml_res.text)
                            plain_text = re.sub(r'\s+', ' ', plain_text).strip()
                            filename = f"PMID_{pmid}_{safe_title}.txt" if pmid else f"{pmcid}_{safe_title}.txt"
                            file_path = os.path.join(folder_path, filename)
                            with open(file_path, 'w', encoding='utf-8') as f:
                                f.write(plain_text)
                            downloaded += 1
                            file_paths.append(file_path)
                    except Exception as fallback_e:
                        print(f"Failed to download PMCID {pmcid} (TXT fallback): {fallback_e}")
                        
        return jsonify({
            "status": "success", 
            "message": f"Downloaded {downloaded} articles to {folder_name}",
            "count": downloaded,
            "folder": folder_path,
            "files": file_paths
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@lit_bp.route('/api/summarize_mechanism', methods=['POST'])
def summarize_mechanism():
    data = request.json
    folder_path = data.get('folder_path', '').strip()
    gene = data.get('gene', '').strip()
    
    if not folder_path or not os.path.exists(folder_path):
        return jsonify({"error": "Invalid or missing mechanism folder path."}), 400
        
    try:
        import fitz

        documents_text = []
        for filename in os.listdir(folder_path):
            file_path = os.path.join(folder_path, filename)
            if filename.lower().endswith('.pdf'):
                doc = fitz.open(file_path)
                text = ""
                for page in doc:
                    text += page.get_text() + "\n"
                doc.close()
                documents_text.append(f"--- Document: {filename} ---\n{text}\n")
            elif filename.lower().endswith('.txt'):
                with open(file_path, 'r', encoding='utf-8') as f:
                    text = f.read()
                documents_text.append(f"--- Document: {filename} ---\n{text}\n")
                
        if not documents_text:
            return jsonify({"error": "No literature available to summarize."}), 400
            
        combined_text = "\n".join(documents_text)
        
        from dotenv import load_dotenv
        load_dotenv(override=True)
        client = _require_llm_client()
        if client is None:
            return jsonify({"error": "LLM is not configured (GVI proxy or GEMINI_API_KEY)."}), 500
        
        prompt = f"""
You are an expert clinical genetic counselor and molecular biologist. Review the provided texts (which may include ClinGen data, GeneReviews, and primary Literature) related to the gene {gene}.
Your task is to identify the overarching mechanism of disease for this specific gene. 

Determine if the primary pathogenic mechanism is Loss of Function (LOF), Gain of Function (GOF), Dominant Negative, Haploinsufficiency, or another mechanism.
CRITICAL INSTRUCTION ON DOMAINS: Pay close attention to domain-specific effects. If the literature indicates that mutations in certain domains cause classic LOF, while mutations in other domains cause dominant-negative or GOF effects resulting in different episignatures or phenotypes, you MUST explicitly document this distinction. Do not generalize the entire gene if mechanisms are domain-dependent.
You MUST provide a clear, concise paragraph explaining the biological mechanism and summarizing the evidence.

CRITICAL INSTRUCTION: You MUST list your sources in exactly this order:
1. ClinGen
2. GeneReviews
3. Literature

For each source, state what mechanism it supports (or state if it was not found/inconclusive).
If a source was not provided in the text files, simply state "No data available" for that source.
For Literature, cite the relevant source using "PMID [number]" format when you reference specific evidence. 
CRITICAL ANTI-HALLUCINATION RULE: When citing Literature, YOU MUST ONLY use the exact PMIDs or PMCIDs that are explicitly provided in the `--- Document: ---` headers. Do NOT extract random inline bibliography footnote numbers (like [103], [40], etc.) from the raw PDF text and falsely label them as PMIDs. If a document does not have a clear PMID/PMCID in its header, do not invent one.

Provided Texts:
{combined_text[:800000]}
        """
        
        response = _run_gemini(client, prompt)
            
        return jsonify({
            "status": "success",
            "summary": response.text
        })
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"Mechanistic Summarization failed: {str(e)}"}), 500
