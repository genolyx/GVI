"""ClinVar URL/link helpers.

First slice of the ClinVar module (see ``docs/ENGINE_SPLIT_PLAN.md``). Only the
self-contained URL builder is extracted so far; the esearch/esummary lookups
remain in ``app_v11.py`` until a later cut.
"""
from __future__ import annotations

import re
import urllib.parse
import html
import time

import requests  # noqa: F401  (used by extracted esearch/elink fetchers)

from vc_engine.hgvs import _c_dot_change_class
from vc_engine.myvariant import _MYVARIANT_LOCAL_ALLELE_FIELDS


def clinvar_portal_url(clinvar_id):
    """Canonical ClinVar URL: numeric IDs are /variation/; RCV/SCV/VCV use /clinvar/{acc}/."""
    if not clinvar_id:
        return ""
    s = str(clinvar_id).strip()
    if s.isdigit():
        return f"https://www.ncbi.nlm.nih.gov/clinvar/variation/{s}/"
    return f"https://www.ncbi.nlm.nih.gov/clinvar/{s}/"


def _clinvar_multi_vid_search_url(vids):
    """ClinVar web search for one or more Variation IDs (OR query)."""
    clean = []
    seen = set()
    for v in vids or []:
        s = str(v).strip()
        if s.isdigit() and s not in seen:
            seen.add(s)
            clean.append(s)
    if not clean:
        return ""
    if len(clean) == 1:
        return clinvar_portal_url(clean[0])
    # Bare numeric OR terms match unrelated ClinVar rows; require [VariationID].
    term = " OR ".join(f"{v}[VariationID]" for v in clean[:40])
    return f"https://www.ncbi.nlm.nih.gov/clinvar/?term={urllib.parse.quote(term)}"


def _clinvar_gene_plp_search_url(gene):
    """Gene-wide P/LP ClinVar search (broader than filtered upstream/downstream lists)."""
    g = (gene or "").strip()
    if not g:
        return ""
    term = f'{g}[gene] AND (pathogenic[CLNSIG] OR "likely pathogenic"[CLNSIG])'
    return f"https://www.ncbi.nlm.nih.gov/clinvar/?term={urllib.parse.quote(term)}"


def _clinvar_geneinfo_matches(geneinfo, symbol):
    """
    ClinVar VCF INFO GENEINFO is 'SYMBOL:gene_id|...'. Match by symbol field only so we do
    not mis-attribute variants to the wrong gene (substring matches on a shared substring).
    """
    if not geneinfo or not symbol:
        return False
    want = str(symbol).strip().upper()
    for tok in str(geneinfo).split("|"):
        if not tok.strip():
            continue
        name = tok.split(":", 1)[0].strip().upper()
        if name == want:
            return True
    return False


def _clinvar_name_change_class(variation_name):
    m = re.search(r":(?:c|n|r)\.([^ (]+)", str(variation_name or ""), re.I)
    return _c_dot_change_class(m.group(1)) if m else ""


def _clinvar_sig_from_esummary_obj(result_obj):
    germline = (result_obj or {}).get("germline_classification", {}).get("description")
    clin_impact = (result_obj or {}).get("clinical_impact_classification", {}).get("description")
    extracted = germline if germline else (clin_impact if clin_impact else "Unknown")
    return str(extracted).capitalize()


def _clinvar_plp_sig_for_deleted_exon(sig_raw):
    """P/LP for skipped-exon proof (exclude B/LB/VUS)."""
    s = (sig_raw or "").lower()
    if "conflicting" in s:
        return False
    if "pathogenic" in s:
        return True
    return False


def _clinvar_cdot_label_from_esummary(obj):
    """
    Extract a 'c.xxx (p.Yyy)' label from a ClinVar esummary title.

    The local ClinVar VCF's CLNHGVS field only carries the genomic (g.) HGVS, never the
    transcript c. notation, so the skipped-exon scan cannot read c./p. from the VCF.
    The esummary `title` (e.g. "NM_017799.4(TMEM260):c.862del (p.Gln288fs)") does.
    """
    title = str((obj or {}).get("title") or "").strip()
    if not title:
        return ""
    m = re.search(r":(c\.\S+?)(\s*\(p\.[^)]*\))?$", title)
    if not m:
        m = re.search(r"(c\.\S+)(\s*\(p\.[^)]*\))?", title)
    if not m:
        return ""
    c_part = m.group(1).rstrip()
    p_part = (m.group(2) or "").strip()
    return f"{c_part} {p_part}".strip()


def _clinvar_sig_is_pathogenic_or_likely_pathogenic(sig):
    """True only for ClinVar Pathogenic or Likely pathogenic (exclude B, LB, VUS, conflicting, etc.)."""
    if not sig:
        return False
    st = str(sig).strip()
    low = st.lower()
    if low in ('unknown', 'not provided', 'no assertion provided', 'n/a', '-'):
        return False
    s = low.replace('_', ' ')
    if 'conflicting' in s:
        return False
    if 'uncertain' in s:
        return False
    if 'likely benign' in s:
        return False
    if re.match(r'^(likely\s+)?benign(\s|/|$)', s):
        return False
    if 'benign' in s and 'pathogenic' in s:
        return False
    if 'likely pathogenic' in s:
        return True
    if 'pathogenic' in s:
        return True
    return False


def _clinvar_rcv_any_pathogenic_or_likely(rcv):
    """True if any RCV entry (not only the first) is classified P or LP."""
    if isinstance(rcv, dict):
        rcv = [rcv]
    if not isinstance(rcv, list):
        return False
    for r in rcv:
        if _clinvar_sig_is_pathogenic_or_likely_pathogenic(r.get('clinical_significance', '')):
            return True
    return False


def _clinvar_display_sig_from_rcv(rcv):
    """Prefer a P/LP label when present among multiple submissions."""
    if isinstance(rcv, dict):
        rcv = [rcv]
    if not isinstance(rcv, list) or not rcv:
        return "Unknown"
    for r in rcv:
        sig = r.get('clinical_significance', '')
        if _clinvar_sig_is_pathogenic_or_likely_pathogenic(sig):
            return str(sig).replace('_', ' ')
    return str(rcv[0].get('clinical_significance', 'Unknown')).replace('_', ' ')


def _clinvar_dict_from_hit(hit):
    cv = hit.get("clinvar")
    if isinstance(cv, dict):
        return cv
    if isinstance(cv, list) and cv and isinstance(cv[0], dict):
        return cv[0]
    return {}


def _clinvar_variant_id_from_hit(hit):
    vid = _clinvar_dict_from_hit(hit).get("variant_id")
    if isinstance(vid, list) and vid:
        vid = vid[0]
    if vid is None or vid == "":
        return ""
    return str(vid).strip()


def _clinvar_rcv_list_from_hit(hit):
    rcv = _clinvar_dict_from_hit(hit).get("rcv", [])
    if isinstance(rcv, dict):
        return [rcv]
    if isinstance(rcv, list):
        return rcv
    return []


def _clinvar_coding_hgvs_from_hit(hit):
    hgvs = _clinvar_dict_from_hit(hit).get("hgvs", {})
    if isinstance(hgvs, dict):
        coding = hgvs.get("coding", [])
    else:
        coding = []
    if isinstance(coding, str):
        return [coding]
    return coding if isinstance(coding, list) else []


def _clinvar_genomic_hgvs_from_hit(hit):
    hgvs = _clinvar_dict_from_hit(hit).get("hgvs", {})
    if isinstance(hgvs, dict):
        genomic = hgvs.get("genomic", [])
    else:
        genomic = []
    if isinstance(genomic, str):
        return [genomic]
    return genomic if isinstance(genomic, list) else []


def _plp_region_clinvar_list_url(hits, *, gene=None):
    """ClinVar URL for matched P/LP hits only (VID OR query, or single /variation/ page)."""
    vids = []
    for h in hits or []:
        if str(h.get("source") or "clinvar").lower() == "hgmd":
            continue
        vid = str(h.get("clinvar_vid") or "").strip()
        if vid.isdigit():
            vids.append(vid)
    return _clinvar_multi_vid_search_url(vids)


def _plp_region_matched_clinvar_link_html(hits, list_url):
    """Header suffix: link to matched ClinVar P/LP hits only."""
    if not list_url:
        return ""
    cv_n = sum(1 for h in (hits or []) if str(h.get("source") or "clinvar").lower() != "hgmd")
    if cv_n <= 0:
        return ""
    matched_lbl = f"Matched variants ({cv_n})" if cv_n > 1 else "Matched variant"
    return (
        f' <a href="{html.escape(list_url, quote=True)}" target="_blank" rel="noopener noreferrer" '
        f'style="color:#fbbf24;text-decoration:underline;font-size:0.9em;">{matched_lbl}</a>'
    )


def _fetch_clinvar_esummary_map(http_session, uid_list):
    """Batch ClinVar esummary for variation IDs -> {uid: result_obj}.

    Retries transient failures (NCBI throttles eutils to ~3 req/s without an API key, so a
    burst of pipeline calls can return HTTP 429); a silent skip here would otherwise drop
    the c./p. labels for skipped-exon and region hits.
    """
    from vc_engine.source_mode import clinvar_remote_active

    if not clinvar_remote_active():
        return {}
    import time

    out = {}
    ids = [str(u).strip() for u in (uid_list or []) if str(u).strip()]
    if not ids:
        return out
    chunk = 40
    for i in range(0, len(ids), chunk):
        batch = ids[i : i + chunk]
        url = (
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"
            f"?db=clinvar&id={','.join(batch)}&retmode=json"
        )
        for attempt in range(3):
            try:
                resp = http_session.get(url, timeout=15)
                if resp.status_code != 200:
                    if attempt < 2:
                        time.sleep(0.5 * (attempt + 1))
                        continue
                    break
                result = resp.json().get("result", {})
                for uid in batch:
                    if uid in result:
                        out[uid] = result[uid]
                break
            except Exception as e:
                print(f"ClinVar esummary batch error (attempt {attempt + 1}): {e}")
                if attempt < 2:
                    time.sleep(0.5 * (attempt + 1))
                    continue
    return out


def _fetch_myvariant_clinvar_variant_hit(http_session, variant_id):
    """Single ClinVar variation record (the variant being curated)."""
    from vc_engine.source_mode import clinvar_remote_active

    if not clinvar_remote_active():
        return None
    vid = str(variant_id or "").strip()
    if not vid or not vid.isdigit():
        return None
    try:
        url = (
            f"https://myvariant.info/v1/variant/clinvar.variant_id:{vid}"
            f"?fields={_MYVARIANT_LOCAL_ALLELE_FIELDS}"
        )
        resp = http_session.get(url, timeout=25)
        if resp.status_code != 200:
            return _clinvar_synthetic_hit_from_esummary(http_session, vid)
        doc = resp.json()
        return doc if isinstance(doc, dict) else _clinvar_synthetic_hit_from_esummary(http_session, vid)
    except Exception as e:
        print(f"ClinVar variant fetch error ({vid}): {e}")
        return _clinvar_synthetic_hit_from_esummary(http_session, vid)


def _clinvar_synthetic_hit_from_esummary(http_session, variant_id):
    """
    MyVariant often lacks newer ClinVar VIDs (e.g. HEXB c.1614-16_1622dup / 565742).
    Build a minimal hit-shaped dict from ClinVar esummary for isoform HGVS + sig.
    """
    vid = str(variant_id or "").strip()
    if not vid or not vid.isdigit():
        return None
    summaries = _fetch_clinvar_esummary_map(http_session, [vid])
    result_obj = summaries.get(vid) or {}
    if not result_obj:
        return None
    vs0 = (result_obj.get("variation_set") or [{}])[0]
    cdna = (vs0.get("cdna_change") or vs0.get("variation_name") or result_obj.get("title") or "").strip()
    coding = [cdna] if cdna else []
    sig = _clinvar_sig_from_esummary_obj(result_obj)
    return {
        "clinvar": {
            "variant_id": int(vid) if vid.isdigit() else vid,
            "hgvs": {"coding": coding, "genomic": []},
            "rcv": [{"clinical_significance": sig.replace(" ", "_")}],
        },
    }


def _fetch_clinvar_aliases(http_session, clinvar_uid):
    """Return list of aliases from ClinVar esummary variation_set, or None on failure."""
    from vc_engine.source_mode import clinvar_remote_active

    if not clinvar_remote_active():
        return None
    if not clinvar_uid:
        return None
    try:
        sum_url = (
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?"
            f"db=clinvar&id={clinvar_uid}&retmode=json"
        )
        resp = http_session.get(sum_url, timeout=10)
        if resp.status_code != 200:
            return None
        data = resp.json()
        rec = data.get('result', {}).get(str(clinvar_uid), {})
        vs = rec.get('variation_set') or []
        if vs and isinstance(vs, list):
            aliases = vs[0].get('aliases') or []
            return aliases
    except Exception as e:
        print(f"ClinVar esummary alias fetch error: {e}")
    return None


def _clinvar_variation_uid_for_pubmed_elink(gene, c_dot, vid_hint=None):
    """
    NCBI elink (clinvar→pubmed) requires a numeric ClinVar variation ID.
    UI may pass an RCV accession, VCV, or empty string; resolve via ClinVar esearch.
    """
    import re
    import urllib.parse
    h = (vid_hint or "").strip()
    if h:
        m = re.match(r"^(\d+)(?:\.0+)?$", h)
        if m:
            return m.group(1)
        if re.search(r"\b(RCV|VCV)\d", h, re.I):
            h = ""
    if not gene or not c_dot:
        return None
    try:
        term = f"{gene}[gene] AND {c_dot}"
        url = (
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=clinvar"
            f"&term={urllib.parse.quote(term)}&retmode=json&retmax=5"
        )
        r = requests.get(url, timeout=10)
        if r.status_code != 200:
            return None
        ids = r.json().get("esearchresult", {}).get("idlist") or []
        return str(ids[0]) if ids else None
    except Exception as e:
        print(f"ClinVar esearch (literature UID) error: {e}")
        return None
