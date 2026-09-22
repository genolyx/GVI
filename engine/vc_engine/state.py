"""Shared mutable engine state populated by the app_v11 mount at import time.

app_v11.py imports these container objects and fills them in place (no
rebinding), so other extracted modules (e.g. vc_engine.literature) observe the
same data. Mirrors the GLOBAL_HGMD_POSITIONAL_ENTRIES pattern in vc_engine.hgmd.
"""
from __future__ import annotations

# ClinGen haploinsufficiency scores keyed by gene symbol. Populated from the
# ClinGen gene-curation TSV during the app_v11 mount.
clingen_db: dict = {}


def clingen_gene_lookup(gene: str):
    """
    Return (matched_key, haplo_score_raw) when gene is in the ClinGen curation TSV,
    else (None, None). Presence in the list is independent of whether a haplo score
    is populated (column may be blank).
    """
    g = (gene or "").strip()
    if not g:
        return None, None
    if g in clingen_db:
        return g, clingen_db[g]
    gu = g.upper()
    if gu in clingen_db:
        return gu, clingen_db[gu]
    return None, None
