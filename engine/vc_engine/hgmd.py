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

from vc_engine.util import _safe_int_or_none

# In-RAM HGMD positional catalogue. Populated by the app_v11 HGMD mount at
# import time: app_v11 imports THIS list object and appends to it, so the
# merge helpers below see the same entries (shared mutable module state).
GLOBAL_HGMD_POSITIONAL_ENTRIES = []


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


def _merge_hgmd_positional_hits(hits, effective_gene: str, pos: int, side: str) -> None:
    """Shared body for the upstream / downstream HGMD positional merges.

    Append HGMD catalogue rows (local spreadsheet) whose parsed protein position(s)
    lie on the requested side of ``pos`` (exclusive). ``side='upstream'`` keeps
    positions strictly N-terminal (``0 < pi < pos``); ``side='downstream'`` keeps
    positions strictly C-terminal (``pi > pos``). Dedupes against existing hits by
    normalized cDNA. Mutates ``hits`` in place.
    """
    if pos <= 0 or not GLOBAL_HGMD_POSITIONAL_ENTRIES:
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
        hgvs_c = (ent.get("hgvs_c") or "").strip()
        tag = (ent.get("tag") or "DM").strip()
        label = f"{hgvs_c} (HGMD {tag})"
        hits.append(
            {
                "label": label,
                "link": _hgmd_gene_mutation_url(gene_u, hgvs_c),
                "position": sort_pos,
                "source": "hgmd",
                "c_dot_norm": cnorm,
            }
        )
        if cnorm:
            existing_norm.add(cnorm)


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
        hgvs_c = (ent.get("hgvs_c") or "").strip()
        tag = (ent.get("tag") or "DM").strip()
        hits.append(
            {
                "label": f"{hgvs_c} (HGMD {tag})",
                "link": _hgmd_gene_mutation_url(gene_u, hgvs_c),
                "position": min(qualifying),
                "source": "hgmd",
                "c_dot_norm": cnorm,
            }
        )
        if cnorm:
            existing_norm.add(cnorm)
