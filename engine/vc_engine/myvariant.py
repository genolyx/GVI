"""MyVariant.info hit selection / RefSeq matching.

Extracted verbatim from ``app_v11.py`` (Phase 3 of ``docs/ENGINE_SPLIT_PLAN.md``).
MyVariant often returns several documents for one c. search (different isoforms
share the same position number); these helpers pick the document whose ClinVar /
snpeff HGVS exactly matches the queried c. allele (and, ideally, the RefSeq).
"""
from __future__ import annotations

from vc_engine.hgvs import (
    _hgvs_c_dot_alleles_equal,
    _myvariant_c_dot_tail_norm,
    _refseq_base_match,
)

# MyVariant.info `fields=` projection shared by the ClinVar allele/region lookups
# (coding + genomic HGVS, RCV significance, snpeff annotations, variant id).
_MYVARIANT_LOCAL_ALLELE_FIELDS = (
    "clinvar.hgvs.coding,clinvar.hgvs.genomic,clinvar.rcv.clinical_significance,clinvar.rcv,"
    "snpeff.ann.feature_id,snpeff.ann.hgvs_c,snpeff.ann.hgvs_p,snpeff.ann.effect,"
    "snpeff.ann.protein.position,clinvar.variant_id"
)


def _myvariant_hit_c_dot_match_score(hit, c_core, refseq_base=None):
    """
    Score MyVariant hit against query c. (higher = better). 0 = no match.
    refseq_base optional: bonus when allele is on that NM_* accession.
    """
    want = _myvariant_c_dot_tail_norm(c_core)
    if not want:
        return 0
    best = 0

    coding = hit.get('clinvar', {}).get('hgvs', {}).get('coding', [])
    if isinstance(coding, str):
        coding = [coding]
    for c_str in coding or []:
        if ':' not in str(c_str):
            continue
        left, right = str(c_str).split(':', 1)
        if not _hgvs_c_dot_alleles_equal(want, right):
            continue
        if refseq_base and _refseq_base_match(left, refseq_base):
            best = max(best, 3)
        else:
            best = max(best, 2)

    ann = hit.get('snpeff', {}).get('ann', [])
    if isinstance(ann, dict):
        ann = [ann]
    for a in ann or []:
        hg = a.get('hgvs_c') or ''
        if ':' not in str(hg):
            continue
        left, right = str(hg).split(':', 1)
        if not _hgvs_c_dot_alleles_equal(want, right):
            continue
        if refseq_base and _refseq_base_match(left, refseq_base):
            best = max(best, 3)
        else:
            best = max(best, 1)

    # Noncoding / genomic ClinVar strings (NR_*:n. or NC_*:g.) when coding list is empty.
    genomic = hit.get('clinvar', {}).get('hgvs', {}).get('genomic', [])
    if isinstance(genomic, str):
        genomic = [genomic]
    for g_str in genomic or []:
        gs = str(g_str)
        if ':' not in gs:
            continue
        left, right = gs.split(':', 1)
        if right.lower().startswith(('n.', 'r.')) and _hgvs_c_dot_alleles_equal(want, right):
            if refseq_base and _refseq_base_match(left, refseq_base):
                best = max(best, 3)
            else:
                best = max(best, 2)

    return best


def myvariant_hit_matches_refseq(hit, refseq_base, c_core):
    """
    True when ClinVar or snpeff HGVS names the requested RefSeq (NM_...) and the c. allele matches.
    MyVariant often returns multiple documents for one c. search (different isoforms share the same
    dup position number); without this, the first hit can be the wrong ClinVar Variation ID.
    """
    return _myvariant_hit_c_dot_match_score(hit, c_core, refseq_base) >= 3


def _pick_best_myvariant_hit(hits, c_core, refseq_base=None):
    """Choose the MyVariant document with the strongest exact c. (and NM) match."""
    best_hit = None
    best_score = 0
    for hit in hits or []:
        sc = _myvariant_hit_c_dot_match_score(hit, c_core, refseq_base)
        if sc > best_score:
            best_score = sc
            best_hit = hit
    if best_score > 0:
        return best_hit, best_score
    for hit in hits or []:
        sc = _myvariant_hit_c_dot_match_score(hit, c_core, None)
        if sc > best_score:
            best_score = sc
            best_hit = hit
    if best_score > 0:
        return best_hit, best_score
    return None, 0


def _gene_symbol_from_myvariant_hit(user_gene, hit, target_transcript=None):
    """Pick a gene symbol from MyVariant without cross-locus drift (e.g. TRIM32 vs ASTN2)."""
    user_gene = (user_gene or '').strip()
    if not hit or not user_gene:
        return user_gene
    ann = hit.get('snpeff', {}).get('ann', [])
    if isinstance(ann, dict):
        ann = [ann]
    tx_base = (target_transcript or '').split('.')[0].upper()
    if tx_base:
        for a in ann or []:
            fid = str(a.get('feature_id') or '')
            if fid.upper().startswith(tx_base):
                gs = (a.get('gene_symbol') or '').strip()
                if gs:
                    return gs
    cv = hit.get('clinvar', {}).get('gene', {})
    if isinstance(cv, list):
        cv = cv[0] if cv else {}
    cv_sym = (cv.get('symbol') or '').strip()
    if cv_sym and cv_sym.upper() == user_gene.upper():
        return cv_sym
    for a in ann or []:
        gs = (a.get('gene_symbol') or '').strip()
        if gs and gs.upper() == user_gene.upper():
            return gs
    return user_gene


def _resolve_effective_gene_from_vep_symbols(user_gene, vep_genes):
    """Keep the curator-entered gene; VEP can list unrelated neighbors at the same c. number."""
    user_gene = (user_gene or '').strip()
    if not user_gene:
        return vep_genes[0] if vep_genes else user_gene
    if user_gene.upper() in {g.upper() for g in (vep_genes or [])}:
        return user_gene
    return user_gene


def revel_score_from_dbnsfp(revel):
    """Read a REVEL score from a MyVariant dbNSFP block.

    dbNSFP repeats the score once per transcript, so ``score`` is usually a list.
    A missing or non-numeric value stays unset. When transcripts disagree, the
    highest score is kept.
    """
    if revel is None:
        return None
    raw = revel.get("score") if isinstance(revel, dict) else revel
    values = raw if isinstance(raw, (list, tuple)) else [raw]
    scores = []
    for item in values:
        try:
            number = float(item)
        except (TypeError, ValueError):
            continue
        if number > 0:
            scores.append(number)
    if not scores:
        return None
    return max(scores)
