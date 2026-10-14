"""HGMD spreadsheet helpers — PubMed-ID parsing, lookup-key building, URLs.

Extracted verbatim from ``app_v11.py`` (Phase 3 of ``docs/ENGINE_SPLIT_PLAN.md``).
These are the pure HGMD helpers (no module-global state). The dataframe-backed
lookups (``_hgmd_row_protein_positions`` and the ``_merge_hgmd_*_hits`` family)
still read the in-RAM ``GLOBAL_HGMD_POSITIONAL_ENTRIES`` mounted in app_v11 and
are deferred to a later cut that injects that state explicitly.
"""
from __future__ import annotations

import re
import urllib.parse

import pandas as pd

from vc_engine.hgvs import (
    _hgvs_c_dot_alleles_equal,
    _hgvs_c_dot_clinvar_equivalent,
    _parse_c_dot_allele,
    _parse_missense_substitution_hgvs_p,
    _protein_position_from_hgvs_label,
)
from vc_engine.util import _safe_int_or_none

# In-RAM HGMD positional catalogue. Populated by the app_v11 HGMD mount at
# import time: app_v11 imports THIS list object and appends to it, so the
# merge helpers below see the same entries (shared mutable module state).
GLOBAL_HGMD_POSITIONAL_ENTRIES = []

# gene symbol -> rows used to find a different nucleotide or amino-acid change.
GLOBAL_HGMD_BY_GENE = {}


def _hgmd_cell_pubmed_ids(val):
    """Extract PubMed IDs from one HGMD spreadsheet cell (numeric or delimited text)."""
    if val is None:
        return []
    try:
        if pd.isna(val):
            return []
    except Exception:
        pass
    if isinstance(val, bool):
        return []
    if isinstance(val, (int, float)):
        try:
            vi = int(val)
        except (TypeError, ValueError):
            return []
        return [str(vi)] if vi > 0 else []
    s = str(val).strip()
    if not s or s.lower() in ('nan', 'none', '.', '-', 'na'):
        return []
    ids = re.findall(r'\b(\d{5,})\b', s)
    seen = set()
    out = []
    for x in ids:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


def _hgmd_column_carries_pubmed_ids(col_name):
    """True if column name matches PMID / PMIDall / allPMID-style HGMD fields."""
    nc = re.sub(r'[\s_\-]', '', str(col_name).strip().lower())
    # Spreadsheet typos (e.g. allPIMID) → normalize toward pmid
    nc = nc.replace('pimid', 'pmid')
    if not nc:
        return False
    if nc == 'pmid':
        return True
    if 'pmidall' in nc or nc.startswith('allpmid'):
        return True
    if nc in ('allpmids', 'pubmedid', 'pubmedids', 'pubmed'):
        return True
    return False


def _hgmd_row_pubmed_ids(row):
    """Union PMIDs from every PMID-like column on this HGMD row (order preserved)."""
    out = []
    seen = set()
    for col in row.index:
        if not _hgmd_column_carries_pubmed_ids(col):
            continue
        for pid in _hgmd_cell_pubmed_ids(row[col]):
            if pid not in seen:
                seen.add(pid)
                out.append(pid)
    return out


def _hgmd_strip_redundant_del_dup_bases(hgvs: str) -> str:
    """Drop redundant trailing payload after del/dup.

    HGMD often spells out either:
      - affected reference bases (e.g. ``4273_4274delGT``, ``123dupA``), or
      - a length suffix (e.g. ``1570_1590del21``),
    both of which are implied by the coordinates and match modern short HGVS
    (``4273_4274del``, ``1570_1590del``, ``123dup``).

    Inserted sequence is NOT stripped: ``ins`` / ``delins`` carry bases that
    distinguish alleles. Digit stripping only applies to bare ``del``/``dup``
    followed by digits (``delins`` starts with ``i``, so it is left intact).
    """
    if not hgvs:
        return hgvs
    s = re.sub(r'(del|dup)([ACGTNacgtn]+)', lambda m: m.group(1), hgvs)
    # Length suffix (HGMD gross dels): 1570_1590del21 → 1570_1590del
    s = re.sub(r'(del|dup)(\d+)\b', lambda m: m.group(1), s)
    return s


def _hgmd_lookup_keys(gene_upper: str, hgvs_raw: str):
    """
    HGMD rows may use 'c.256C>T' or '256C>T'. Match both against query clean_cdot / full c_dot.
    Also matches HGMD's spelled-out del/dup bases ('4273_4274delGT') and length
    suffixes ('1570_1590del21') against the short HGVS form ('4273_4274del',
    '1570_1590del') in either direction.
    """
    h = str(hgvs_raw).strip()
    variants = [h]
    stripped = _hgmd_strip_redundant_del_dup_bases(h)
    if stripped and stripped != h:
        variants.append(stripped)

    out = []
    seen = set()
    for v in variants:
        forms = [v]
        vl = v.lower()
        if vl.startswith(("c.", "n.", "r.")):
            forms.append(v[2:].strip())
        elif v and v[0].isdigit():
            forms.append(f"c.{v}")
        for f in forms:
            k = f"{gene_upper}_{f}"
            if k not in seen:
                seen.add(k)
                out.append(k)
    return out


def _hgmd_ordered_candidate_keys(effective_gene_upper: str, c_dot: str, parsed_data: dict):
    """HGMD spreadsheet keys: prefer MANE-linked / canonical RefSeq c. tails, then user notation."""
    keys_out = []
    seen_k = set()
    tails_ordered = []

    pair_list = list(parsed_data.get("refseq_nm_synonyms") or [])
    pair_list.sort(
        key=lambda p: (
            0 if (p.get("mane_select") or "").strip() else 1,
            0 if p.get("from_clinvar") else 1,
            0 if p.get("canonical") else 1,
            1 if p.get("user_input") else 0,
            p.get("refseq", ""),
        )
    )
    for p in pair_list:
        t = (p.get("hgvs_c") or "").strip()
        if t and t not in tails_ordered:
            tails_ordered.append(t)

    extra_tails = [
        str(c_dot or "").strip(),
        str(c_dot or "").replace("c.", "").replace("n.", "").replace("r.", "").strip(),
    ]
    for raw in extra_tails:
        if not raw:
            continue
        low = raw.lower()
        if low.startswith(("c.", "n.", "r.")):
            tt = raw
        elif raw[0].isdigit() or raw[0] in "+-*":
            tt = f"c.{raw}"
        else:
            tt = raw
        if tt not in tails_ordered:
            tails_ordered.append(tt)

    for tail in tails_ordered:
        for k in _hgmd_lookup_keys(effective_gene_upper, tail):
            if k not in seen_k:
                seen_k.add(k)
                keys_out.append(k)
    return keys_out


def _hgmd_display_c(hgvs_raw: str) -> str:
    """Show an HGMD cell as c./n./r. notation."""
    s = str(hgvs_raw or "").strip()
    if not s:
        return ""
    if re.match(r"^[cnr]\.", s, re.I):
        return s
    if s[0].isdigit() or s[0] in "+-*":
        return f"c.{s}"
    return s


def _same_hgmd_allele(left: str, right: str) -> bool:
    """True when two HGVS strings are the same allele, including del/dup spelling."""
    if _hgvs_c_dot_alleles_equal(left, right) or _hgvs_c_dot_clinvar_equivalent(left, right):
        return True
    a = _hgmd_strip_redundant_del_dup_bases(left or "")
    b = _hgmd_strip_redundant_del_dup_bases(right or "")
    return bool(a and b and (
        _hgvs_c_dot_alleles_equal(a, b) or _hgvs_c_dot_clinvar_equivalent(a, b)
    ))


def hgmd_codon_number(value):
    """HGMD ``codon`` is the amino-acid number, stored as 1338 or 1338.0."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text or text.lower() in ("nan", "none", ".", "-"):
            return None
        value = text
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def hgmd_protein_label(amino, positions) -> str:
    """Turn HGMD ``Asn-Thr`` plus codon 1338 into ``p.Asn1338Thr``."""
    text = str(amino or "").strip()
    if not text or text.lower() in ("nan", "none", ".", "-"):
        return ""
    bits = [bit for bit in re.split(r"[\s>/-]+", text) if bit]
    try:
        pos = int(positions[0]) if positions else None
    except (TypeError, ValueError, IndexError):
        pos = None
    if pos and len(bits) >= 2 and all(re.fullmatch(r"[A-Za-z*]+", bit) for bit in bits[:2]):
        return f"p.{bits[0]}{pos}{bits[1]}"
    return ""


def record_hgmd_allele(gene, hgvs_c, protein_positions, tag, disease, pmids, amino="") -> None:
    """Index one spreadsheet row for alternate-residue lookup. Called at HGMD mount."""
    gene_u = str(gene or "").strip().upper()
    shown = _hgmd_display_c(hgvs_c)
    if not gene_u or not shown:
        return
    parsed = _parse_c_dot_allele(shown)
    clean_pmids = []
    seen = set()
    for pid in pmids or []:
        s = str(pid).replace(".0", "").strip()
        if s.isdigit() and s not in seen:
            seen.add(s)
            clean_pmids.append(s)
    positions = []
    for p in protein_positions or []:
        try:
            pi = int(p)
        except (TypeError, ValueError):
            continue
        if pi > 0 and pi not in positions:
            positions.append(pi)
    GLOBAL_HGMD_BY_GENE.setdefault(gene_u, []).append(
        {
            "hgvs_c": shown,
            "anchor": parsed[0] if parsed else None,
            "positions": positions,
            "tag": str(tag or "DM").strip() or "DM",
            "disease": str(disease or "").strip()[:120],
            "pmids": clean_pmids,
            "amino": hgmd_protein_label(amino, positions),
        }
    )


def hgmd_alternate_residue_hits(gene, c_dot, hgvs_p="", equivalent=None, limit=25):
    """Other HGMD rows at this nucleotide coordinate or this amino-acid residue.

    The exact allele, including isoform synonyms passed in ``equivalent``, is left
    out. A different base change at the same c. coordinate is a nucleotide alternate.
    A different allele at the same amino-acid number, on another coordinate, is an
    amino-acid alternate. Each hit keeps the spreadsheet PMIDs.
    """
    gene_u = str(gene or "").strip().upper()
    query = _hgmd_display_c(c_dot)
    tails = []
    pref = f"{gene_u}_" if gene_u else ""
    for raw in [query, *(equivalent or [])]:
        s = str(raw or "").strip()
        if pref and s.startswith(pref):
            s = s[len(pref):]
        shown = _hgmd_display_c(s)
        if shown and shown not in tails:
            tails.append(shown)
    parsed = _parse_c_dot_allele(query)
    anchor = parsed[0] if parsed else None
    sub = _parse_missense_substitution_hgvs_p(hgvs_p)
    aa_pos = sub["pos"] if sub else _protein_position_from_hgvs_label(hgvs_p)
    nuc_q = f"c.{anchor}" if anchor is not None else ""
    if sub:
        aa_q = f"p.{sub['ref_3']}{sub['pos']}"
    elif aa_pos:
        aa_q = f"p.{aa_pos}"
    else:
        aa_q = ""

    def _pack(rows):
        ranked = sorted(
            rows,
            key=lambda ent: (
                0 if str(ent.get("tag") or "").upper().startswith("DM") else 1,
                ent.get("hgvs_c") or "",
            ),
        )
        out = []
        for ent in ranked[:limit]:
            out.append(
                {
                    "hgvs_c": ent["hgvs_c"],
                    "tag": ent.get("tag") or "",
                    "disease": ent.get("disease") or "",
                    "pmids": list(ent.get("pmids") or []),
                    "amino": ent.get("amino") or "",
                    "link": _hgmd_gene_mutation_url(gene_u, ent["hgvs_c"]),
                }
            )
        return out

    nucleotide = []
    amino = []
    seen_n = set()
    seen_a = set()
    for ent in GLOBAL_HGMD_BY_GENE.get(gene_u, []):
        hgvs_c = ent.get("hgvs_c") or ""
        if any(_same_hgmd_allele(hgvs_c, tail) for tail in tails):
            continue
        same_anchor = anchor is not None and ent.get("anchor") == anchor
        same_aa = aa_pos is not None and aa_pos in (ent.get("positions") or [])
        if same_anchor and hgvs_c not in seen_n:
            seen_n.add(hgvs_c)
            nucleotide.append(ent)
        if same_aa and hgvs_c not in seen_a:
            seen_a.add(hgvs_c)
            amino.append(ent)
    return {
        "nucleotide": _pack(nucleotide),
        "amino_acid": _pack(amino),
        "nucleotide_search": _hgmd_gene_mutation_url(gene_u, nuc_q) if nuc_q else "",
        "amino_acid_search": _hgmd_gene_mutation_url(gene_u, aa_q) if aa_q else "",
    }


def _hgmd_gene_mutation_url(gene_symbol: str, mutation_c_dot: str) -> str:
    """HGMD Classic gene search URL (matches hgmd_link construction elsewhere)."""
    g = (gene_symbol or "").strip()
    mut = (mutation_c_dot or "").strip()
    if not g or not mut:
        return ""
    return (
        "https://www.hgmd.cf.ac.uk/ac/gene.php?gene="
        f"{urllib.parse.quote(g, safe='')}&mutation={urllib.parse.quote(mut, safe='')}"
    )


def _clean_pmid_list(pmids) -> list:
    """Digit-only PubMed ids, order preserved."""
    out = []
    seen = set()
    for raw in pmids or []:
        s = str(raw).replace(".0", "").strip()
        if s.isdigit() and s not in seen:
            seen.add(s)
            out.append(s)
    return out


def hgmd_pmids_for_cdot(gene: str, hgvs_c: str) -> list:
    """PMIDs on the local HGMD row for this gene and c. allele, if one exists."""
    gene_u = (gene or "").strip().upper()
    shown = _hgmd_display_c(hgvs_c)
    if not gene_u or not shown:
        return []
    found = []
    seen = set()
    for ent in GLOBAL_HGMD_BY_GENE.get(gene_u, []):
        if not _same_hgmd_allele(ent.get("hgvs_c") or "", shown):
            continue
        for pid in _clean_pmid_list(ent.get("pmids")):
            if pid not in seen:
                seen.add(pid)
                found.append(pid)
    return found


def _cdot_from_plp_hit(hit) -> str:
    for key in ("hgvs_c", "c_dot_norm"):
        raw = str((hit or {}).get(key) or "").strip()
        if raw:
            return _hgmd_display_c(raw) or raw
    label = str((hit or {}).get("label") or "")
    match = re.search(r"([cnr]\.[^\s(]+|\d+[ACGTNacgtn]>[ACGTNacgtn])", label, re.I)
    return match.group(1) if match else ""


def annotate_plp_hits_with_hgmd_pmids(hits, gene: str) -> None:
    """Copy local HGMD PMIDs onto ClinVar and HGMD P/LP rows that lack them."""
    for hit in hits or []:
        existing = _clean_pmid_list(hit.get("pmids"))
        if existing:
            hit["pmids"] = existing
            continue
        pmids = hgmd_pmids_for_cdot(gene, _cdot_from_plp_hit(hit))
        if pmids:
            hit["pmids"] = pmids


def _hgmd_catalogue_hit(gene_u: str, ent, position: int) -> dict:
    hgvs_c = _hgmd_display_c(ent.get("hgvs_c") or "") or str(ent.get("hgvs_c") or "").strip()
    tag = str(ent.get("tag") or "DM").strip() or "DM"
    pmids = _clean_pmid_list(ent.get("pmids")) or hgmd_pmids_for_cdot(gene_u, hgvs_c)
    return {
        "label": f"{hgvs_c} (HGMD {tag})",
        "link": _hgmd_gene_mutation_url(gene_u, hgvs_c),
        "position": position,
        "source": "hgmd",
        "c_dot_norm": str(ent.get("c_dot_norm") or "").strip(),
        "hgvs_c": hgvs_c,
        "pmids": pmids,
    }


def _merge_hgmd_positional_hits(hits, effective_gene: str, pos: int, side: str) -> None:
    """Shared body for the upstream / downstream HGMD positional merges.

    Append HGMD catalogue rows (local spreadsheet) whose parsed protein position(s)
    lie on the requested side of ``pos`` (exclusive). ``side='upstream'`` keeps
    positions strictly N-terminal (``0 < pi < pos``); ``side='downstream'`` keeps
    positions strictly C-terminal (``pi > pos``). Dedupes against existing hits by
    normalized cDNA. Mutates ``hits`` in place.
    """
    gene_u = (effective_gene or "").strip().upper()
    if pos <= 0 or not gene_u or not GLOBAL_HGMD_POSITIONAL_ENTRIES:
        annotate_plp_hits_with_hgmd_pmids(hits, gene_u)
        return
    existing_norm = set()
    for h in hits:
        n = (h.get("c_dot_norm") or "").strip()
        if n:
            existing_norm.add(n)
    for ent in GLOBAL_HGMD_POSITIONAL_ENTRIES:
        if ent.get("gene") != gene_u:
            continue
        cnorm = (ent.get("c_dot_norm") or "").strip()
        if cnorm and cnorm in existing_norm:
            continue
        qualifying = []
        for p in ent.get("positions") or []:
            try:
                pi = int(float(p))
            except (TypeError, ValueError):
                continue
            in_region = (0 < pi < pos) if side == "upstream" else (pi > pos)
            if in_region:
                qualifying.append(pi)
        if not qualifying:
            continue
        sort_pos = min(qualifying)
        hits.append(_hgmd_catalogue_hit(gene_u, ent, sort_pos))
        if cnorm:
            existing_norm.add(cnorm)
    annotate_plp_hits_with_hgmd_pmids(hits, gene_u)


def _merge_hgmd_upstream_hits(hits, effective_gene: str, next_m_pos: int) -> None:
    """Append HGMD rows strictly N-terminal to ``next_m_pos``. See _merge_hgmd_positional_hits."""
    _merge_hgmd_positional_hits(hits, effective_gene, next_m_pos, "upstream")


def _merge_hgmd_downstream_hits(hits, effective_gene: str, current_pos: int) -> None:
    """Append HGMD rows strictly C-terminal to ``current_pos``. See _merge_hgmd_positional_hits."""
    _merge_hgmd_positional_hits(hits, effective_gene, current_pos, "downstream")


def _merge_hgmd_skipped_exon_hits(hits, effective_gene, aa_lo, aa_hi):
    """
    Append HGMD catalogue rows (local spreadsheet) whose parsed protein position(s) fall
    inside the skipped exon's amino-acid range [aa_lo, aa_hi]. Mirrors the upstream /
    downstream HGMD merge so the skipped-exon P/LP list is not ClinVar-only. Dedupes
    against existing hits by normalized cDNA. Mutates hits in place.
    """
    if not GLOBAL_HGMD_POSITIONAL_ENTRIES:
        return
    try:
        lo = int(aa_lo)
        hi = int(aa_hi)
    except (TypeError, ValueError):
        return
    if lo > hi:
        lo, hi = hi, lo
    if hi <= 0:
        return
    gene_u = (effective_gene or "").strip().upper()
    if not gene_u:
        return
    existing_norm = set()
    for h in hits:
        n = (h.get("c_dot_norm") or "").strip()
        if n:
            existing_norm.add(n)
    for ent in GLOBAL_HGMD_POSITIONAL_ENTRIES:
        if ent.get("gene") != gene_u:
            continue
        cnorm = (ent.get("c_dot_norm") or "").strip()
        if cnorm and cnorm in existing_norm:
            continue
        qualifying = [
            pi
            for p in (ent.get("positions") or [])
            for pi in (_safe_int_or_none(p),)
            if pi is not None and lo <= pi <= hi
        ]
        if not qualifying:
            continue
        hits.append(_hgmd_catalogue_hit(gene_u, ent, min(qualifying)))
        if cnorm:
            existing_norm.add(cnorm)
    annotate_plp_hits_with_hgmd_pmids(hits, gene_u)
