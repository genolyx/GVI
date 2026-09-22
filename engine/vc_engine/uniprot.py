"""UniProt domain / feature overlap + truncation logic.

Extracted verbatim from ``app_v11.py`` (Phase 3 of ``docs/ENGINE_SPLIT_PLAN.md``).
``_apply_uniprot_domain_lookup`` takes the shared HTTP session as an explicit
argument (no module-global session), so the module is import-safe and testable.
"""
from __future__ import annotations

import re

from vc_engine.hgvs import _parse_missense_substitution_hgvs_p

_UNIPROT_CRITICAL_DOMAIN_TYPES = ('Domain', 'Motif', 'Zinc finger')
_SWISS_PROT_PREFIXES = frozenset('OPQ')


def _normalize_uniprot_accession(acc):
    """Strip isoform suffix (e.g. Q96P20-5 → Q96P20)."""
    return (acc or '').strip().split('-', 1)[0]


def _is_swiss_prot_accession(acc):
    """True for canonical reviewed Swiss-Prot accessions (P/O/Q + 5 alnum)."""
    base = _normalize_uniprot_accession(acc)
    return len(base) == 6 and base[0] in _SWISS_PROT_PREFIXES and base[1:].isalnum()


def _pick_dbnsfp_uniprot_accession(uniprot_data, effective_gene):
    """Prefer reviewed Swiss-Prot entries whose gene symbol matches *effective_gene*."""
    gene = (effective_gene or '').strip().upper()
    entries = []
    if isinstance(uniprot_data, dict):
        entries = [uniprot_data]
    elif isinstance(uniprot_data, list):
        entries = [e for e in uniprot_data if isinstance(e, dict)]

    def _entry_score(entry):
        acc = (entry.get('acc') or '').strip()
        if not acc:
            return (-999, 0, 0, 0)
        entry_gene = (entry.get('gene') or entry.get('genename') or '').strip().upper()
        if gene and entry_gene == gene:
            gene_rank = 2
        elif entry_gene:
            gene_rank = 0
        else:
            gene_rank = 1
        swiss = 1 if _is_swiss_prot_accession(acc) else 0
        isoform = 0 if '-' not in acc else -1
        return (gene_rank, swiss, isoform, len(_normalize_uniprot_accession(acc)))

    best_acc = ''
    best_score = (-999, 0, 0, 0)
    for entry in entries:
        score = _entry_score(entry)
        if score > best_score:
            best_score = score
            best_acc = entry.get('acc', '')
    return best_acc


def _rank_uniprot_search_entry(results, effective_gene):
    """Pick the canonical reviewed human entry for *effective_gene*."""
    gene = (effective_gene or '').strip().upper()
    if not results:
        return None

    def _entry_score(entry):
        primary = entry.get('primaryAccession') or ''
        uid = (entry.get('uniProtkbId') or '').upper()
        genes = [
            (g.get('geneName') or {}).get('value', '').upper()
            for g in entry.get('genes', [])
        ]
        gene_rank = 2 if gene and gene in genes else 0
        uid_rank = 1 if gene and uid == f'{gene}_HUMAN' else 0
        swiss = 1 if _is_swiss_prot_accession(primary) else 0
        length = int(entry.get('sequence', {}).get('length') or 0)
        return (gene_rank, uid_rank, swiss, length)

    return max(results, key=_entry_score)


def _uniprot_entry_url(accession, domains_anchor=False):
    acc = _normalize_uniprot_accession(accession)
    if not acc:
        return ''
    suffix = '/entry#family_and_domains' if domains_anchor else '/entry'
    return f"https://www.uniprot.org/uniprotkb/{acc}{suffix}"


def _sync_uniprot_link(parsed_data):
    """Align the UI pill link with the accession chosen for domain lookup."""
    acc = (parsed_data.get('uniprot_primary_accession') or '').strip()
    if acc:
        parsed_data['uniprot_link'] = _uniprot_entry_url(acc)


def _uniprot_gene_search_url(effective_gene):
    gene = (effective_gene or '').strip()
    if not gene:
        return ''
    return (
        'https://rest.uniprot.org/uniprotkb/search?query='
        f'(gene_exact:{gene})+AND+(reviewed:true)+AND+(organism_id:9606)&format=json'
    )


def _uniprot_feature_included(feat):
    ftype = feat.get('type')
    if ftype in _UNIPROT_CRITICAL_DOMAIN_TYPES:
        return True
    if ftype == 'Region':
        return (feat.get('description') or '').strip().lower() == 'disordered'
    return False


def _uniprot_feature_display_name(desc, ftype):
    label = (desc or ftype or 'Feature').strip()
    if ftype == 'Region' and label.lower() == 'disordered':
        return 'Disordered region'
    return label


def _uniprot_truncation_positions(parsed_data):
    """First affected residue and premature stop (Ter) for domain truncation math."""
    from vc_engine.truncation import resolved_ptc_stop_aa

    try:
        variant_aa = int(parsed_data.get('protein_start', 0) or 0)
    except (TypeError, ValueError):
        variant_aa = 0
    ptc_aa = resolved_ptc_stop_aa(parsed_data or {})
    if ptc_aa <= 0:
        ptc_aa = variant_aa
    return variant_aa, ptc_aa


def _uniprot_truncation_feature_relation(start_val, end_val, variant_aa, ptc_aa):
    """
    Classify UniProt feature vs PTC.
    at_ptc — feature contains the stop; lost_downstream — entirely 3′ of Ter.
    """
    if not start_val or not end_val or ptc_aa <= 0:
        return None
    if start_val <= ptc_aa <= end_val:
        return 'at_ptc'
    if start_val > ptc_aa:
        return 'lost_downstream'
    if end_val > ptc_aa and variant_aa > 0 and start_val <= variant_aa <= end_val:
        return 'truncated_through'
    return None


def _uniprot_domain_overlap_matches(start_val, end_val, current_pos, mode, ftype=None):
    """Point / Region: aa within feature. Truncation: use _uniprot_truncation_feature_relation."""
    if not start_val or not end_val or not current_pos:
        return False
    if ftype == 'Region' or mode == 'point':
        return start_val <= current_pos <= end_val
    return current_pos <= end_val


def _uniprot_domain_lookup_mode(consequence):
    csq = (consequence or '').lower()
    if 'missense' in csq or 'inframe' in csq:
        return 'point'
    return 'truncation'


def _resolve_protein_aa_for_uniprot(parsed_data):
    """AA index for UniProt overlap — prefer protein_start, else parse hgvs_p.

    Missense runs often keep protein_start=0 when VEP/MyVariant omit protein_start
    even though hgvs_p is present (e.g. HDAC3 p.Y182C). Without an AA the domain
    lookup used to no-op and the logic line never printed.
    """
    try:
        ps = int(parsed_data.get("protein_start") or 0)
    except (TypeError, ValueError):
        ps = 0
    if ps > 0:
        return ps

    hgvs_p = (parsed_data.get("hgvs_p") or "").strip()
    if not hgvs_p:
        return 0

    sub = _parse_missense_substitution_hgvs_p(hgvs_p)
    if sub and sub.get("pos"):
        return int(sub["pos"])

    from vc_engine.truncation import parse_nonsense_stop_aa_from_hgvs

    nonsense = parse_nonsense_stop_aa_from_hgvs(hgvs_p)
    if nonsense > 0:
        return nonsense

    # Frameshift / in-frame indel: first residue in p.X123… / p.Xaa123_…
    m = re.search(
        r"p\.(?:[A-Z][a-z]{2}|[A-Z*])(\d+)",
        hgvs_p,
    )
    if m:
        try:
            return int(m.group(1))
        except (TypeError, ValueError):
            return 0
    return 0


def _format_uniprot_feature_label(desc, start_val, end_val):
    label = (desc or 'Feature').strip()
    try:
        s = int(start_val)
        e = int(end_val)
    except (TypeError, ValueError):
        s = e = 0
    if s > 0 and e > 0:
        return f"{label} (aa {s}–{e})"
    return label


def _apply_uniprot_skipped_exon_domains(http_session, parsed_data, effective_gene, aa_lo, aa_hi):
    """Flag reviewed UniProt domains/motifs removed by a whole-exon skip.

    For exon-skip splice outcomes the clinically relevant question is which protein
    domains the skipped residues delete. This mirrors ``_apply_uniprot_domain_lookup``
    but scans for features overlapping the skipped exon's amino-acid span
    ``[aa_lo, aa_hi]`` rather than the variant residue / PTC. Results are stored under
    ``skipped_exon_*`` keys so they do not collide with the point/truncation lookup.
    """
    if parsed_data.get('uniprot_skipped_exon_checked'):
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

    parsed_data['uniprot_skipped_exon_checked'] = True
    parsed_data['skipped_exon_has_critical_domain'] = False
    parsed_data['skipped_exon_critical_domains'] = []
    parsed_data['skipped_exon_critical_domain_names'] = ''
    parsed_data['skipped_exon_aa_range'] = [lo, hi]

    try:
        url = _uniprot_gene_search_url(effective_gene)
        if not url:
            return
        resp = http_session.get(url, timeout=25)
        if resp.status_code != 200:
            return
        data = resp.json()
        results = data.get('results') or []
        entry = _rank_uniprot_search_entry(results, effective_gene)
        if not entry:
            return

        primary_accession = entry.get('primaryAccession', '')
        if primary_accession:
            parsed_data['uniprot_primary_accession'] = primary_accession
            _sync_uniprot_link(parsed_data)

        found = []
        seen_labels = set()
        domain_link = None
        for feat in entry.get('features', []):
            if not _uniprot_feature_included(feat):
                continue
            loc = feat.get('location', {})
            start_val = loc.get('start', {}).get('value', 0)
            end_val = loc.get('end', {}).get('value', 0)
            if not start_val or not end_val:
                continue
            # Feature overlaps the skipped exon span [lo, hi].
            if start_val > hi or end_val < lo:
                continue
            desc = feat.get('description', feat.get('type'))
            display = _uniprot_feature_display_name(desc, feat.get('type'))
            label = _format_uniprot_feature_label(display, start_val, end_val)
            if label in seen_labels:
                continue
            seen_labels.add(label)
            found.append(label)
            if primary_accession and domain_link is None:
                domain_link = (
                    f"https://www.uniprot.org/uniprotkb/{primary_accession}/entry#family_and_domains"
                )

        parsed_data['skipped_exon_critical_domains'] = found
        if found:
            parsed_data['skipped_exon_has_critical_domain'] = True
            parsed_data['skipped_exon_critical_domain_names'] = ", ".join(found)
            if domain_link:
                parsed_data['skipped_exon_critical_domain_link'] = domain_link
        _sync_uniprot_link(parsed_data)
    except Exception as e:
        print(f"UniProt Skipped-Exon Lookup Error: {e}")


def _skipped_exon_uniprot_report_line(parsed_data):
    """Linked UniProt line for skipped-exon overlap (matches point-variant logic style)."""
    if not parsed_data.get('uniprot_skipped_exon_checked'):
        return ''
    link = (parsed_data.get('skipped_exon_critical_domain_link') or '').strip()
    acc = (parsed_data.get('uniprot_primary_accession') or '').strip()
    if not link and acc:
        link = f"https://www.uniprot.org/uniprotkb/{acc}/entry#family_and_domains"
    if link:
        head = (
            f"<a href='{link}' target='_blank' style='text-decoration: underline; "
            f"color: #4338ca;'>UniProt</a>:"
        )
    else:
        head = "UniProt:"
    rng = parsed_data.get('skipped_exon_aa_range') or []
    aa_note = ''
    if isinstance(rng, (list, tuple)) and len(rng) == 2:
        try:
            lo, hi = int(rng[0]), int(rng[1])
            if lo > hi:
                lo, hi = hi, lo
            aa_note = f" (skipped exon aa {lo}–{hi})"
        except (TypeError, ValueError):
            pass
    if parsed_data.get('skipped_exon_has_critical_domain'):
        domains = parsed_data.get('skipped_exon_critical_domains') or []
        dom_txt = '; '.join(str(d) for d in domains) if domains else (
            parsed_data.get('skipped_exon_critical_domain_names') or ''
        )
        return (
            f"{head} Excised region{aa_note} overlaps annotated functional "
            f"region(s): {dom_txt}."
        )
    return f"{head} No curated domain overlaps the skipped exon{aa_note}."


def _apply_uniprot_domain_lookup(http_session, parsed_data, effective_gene):
    """Query reviewed UniProt features at the variant (point) or lost at the PTC (truncation)."""
    if parsed_data.get('uniprot_domain_checked'):
        return
    current_pos = _resolve_protein_aa_for_uniprot(parsed_data)
    if current_pos <= 0:
        return
    # Backfill so logic / allelic context see the same residue as UniProt.
    try:
        if int(parsed_data.get('protein_start') or 0) <= 0:
            parsed_data['protein_start'] = current_pos
    except (TypeError, ValueError):
        parsed_data['protein_start'] = current_pos

    mode = _uniprot_domain_lookup_mode(parsed_data.get('consequence', ''))
    variant_aa, ptc_aa = _uniprot_truncation_positions(parsed_data)
    if mode == 'point' and (variant_aa or 0) <= 0:
        variant_aa = current_pos
    parsed_data['uniprot_domain_checked'] = True
    parsed_data['uniprot_domain_mode'] = mode
    parsed_data['has_critical_domain'] = False
    parsed_data['critical_domain_names'] = ''
    parsed_data['critical_domain_at_ptc'] = []
    parsed_data['critical_domain_lost_downstream'] = []
    if mode == 'truncation' and ptc_aa > 0:
        parsed_data['uniprot_ptc_aa'] = ptc_aa
        parsed_data['uniprot_variant_aa'] = variant_aa or current_pos

    try:
        url = _uniprot_gene_search_url(effective_gene)
        if not url:
            return
        resp = http_session.get(url, timeout=25)
        if resp.status_code != 200:
            return
        data = resp.json()
        results = data.get('results') or []
        entry = _rank_uniprot_search_entry(results, effective_gene)
        if not entry:
            return

        primary_accession = entry.get('primaryAccession', '')
        if primary_accession:
            parsed_data['uniprot_primary_accession'] = primary_accession
            _sync_uniprot_link(parsed_data)

        # Backfill WT protein length when Ensembl/VEP failed (needed for truncation %).
        try:
            u_len = int(entry.get('sequence', {}).get('length') or 0)
        except (TypeError, ValueError):
            u_len = 0
        try:
            cur_len = int(parsed_data.get('protein_length') or 0)
        except (TypeError, ValueError):
            cur_len = 0
        if u_len > 0 and cur_len <= 0:
            parsed_data['protein_length'] = u_len
            from vc_engine.truncation import sync_truncation_fraction_from_ptc
            sync_truncation_fraction_from_ptc(parsed_data)

        at_ptc = []
        lost_ds = []
        domain_links = {}
        seen_labels = set()
        for feat in entry.get('features', []):
            if not _uniprot_feature_included(feat):
                continue
            loc = feat.get('location', {})
            start_val = loc.get('start', {}).get('value', 0)
            end_val = loc.get('end', {}).get('value', 0)
            if mode == 'truncation':
                rel = _uniprot_truncation_feature_relation(
                    start_val, end_val, variant_aa, ptc_aa
                )
                if not rel:
                    continue
            elif not _uniprot_domain_overlap_matches(
                start_val, end_val, current_pos, mode, feat.get('type')
            ):
                continue
            else:
                rel = 'point'
            desc = feat.get('description', feat.get('type'))
            display = _uniprot_feature_display_name(desc, feat.get('type'))
            label = _format_uniprot_feature_label(display, start_val, end_val)
            if label in seen_labels:
                continue
            seen_labels.add(label)
            if rel in ('at_ptc', 'truncated_through'):
                at_ptc.append(label)
            elif rel == 'lost_downstream':
                lost_ds.append(label)
            else:
                at_ptc.append(label)
            if primary_accession and desc not in domain_links:
                domain_links[desc] = (
                    f"https://www.uniprot.org/uniprotkb/{primary_accession}/entry#family_and_domains"
                )

        parsed_data['critical_domain_at_ptc'] = at_ptc
        parsed_data['critical_domain_lost_downstream'] = lost_ds
        domains_list = at_ptc + lost_ds
        if domains_list:
            parsed_data['has_critical_domain'] = True
            parsed_data['critical_domain_names'] = ", ".join(domains_list)
            if domain_links:
                parsed_data['critical_domain_link'] = next(iter(domain_links.values()))
        _sync_uniprot_link(parsed_data)
    except Exception as e:
        print(f"UniProt Lookup Error: {e}")
