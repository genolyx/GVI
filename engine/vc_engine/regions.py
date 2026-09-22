"""P/LP region-evidence markup builders.

Extracted from ``app_v11.py`` (Phase 3 of ``docs/ENGINE_SPLIT_PLAN.md``).
These build the upstream / downstream / skipped-exon ClinVar P/LP evidence HTML
for the analyze pipeline. They take the ``parsed_data`` dict (and hit lists) as
arguments; ClinVar URL/link builders are imported from ``vc_engine.clinvar``.
Shared by the analyze route and the splice subsystem.
"""
from __future__ import annotations

import html
import re

from vc_engine.clinvar import (
    _plp_region_clinvar_list_url,
    _plp_region_matched_clinvar_link_html,
    _clinvar_multi_vid_search_url,
)
from vc_engine.truncation import (
    is_long_3prime_extension,
    is_marginal_loss,
    is_severe_loss,
    is_short_3prime_extension,
    resolved_ptc_stop_aa,
)
from vc_engine.uniprot import _skipped_exon_uniprot_report_line


def _downstream_plp_anchor_aa(parsed_data):
    """
    Amino-acid index for 3′ P/LP region scans (NMD-escape protocol).
    Frameshift: strictly 3′ of the novel PTC (onset + shift when present).
    Nonsense: the stop position.
    """
    return resolved_ptc_stop_aa(parsed_data or {})


def _needs_downstream_clinvar_plp(parsed_data):
    """
    Whether to scan ClinVar for P/LP strictly 3′ of the PTC anchor.

    Covers short 3′ extensions (<10% lost), marginal fs extensions, and
    structural NMD escape (last-exon / penultimate <50 nt) where a substantial
    C-terminal segment is still lost (e.g. MC4R c.771C>A, p.C257*).
    """
    if not parsed_data:
        return False
    csq = parsed_data.get("consequence", "")
    is_core_nmd_csq = csq in ("nonsense", "frameshift")
    try:
        trunc_frac = float(parsed_data.get("nmd_escape_truncation_fraction") or 0.0)
    except (TypeError, ValueError):
        trunc_frac = 0.0
    is_short_extension = is_core_nmd_csq and is_short_3prime_extension(trunc_frac)
    is_nmd_escape_downstream = (
        is_core_nmd_csq
        and bool(parsed_data.get("nmd_escape"))
        and trunc_frac >= 0.0
    )
    is_splice_oof_escape = (
        bool(parsed_data.get("is_splice_frameshift"))
        and bool(parsed_data.get("nmd_escape"))
        and "splice" in csq
        and trunc_frac > 0
    )
    return bool(is_short_extension or is_nmd_escape_downstream or is_splice_oof_escape)


def _finalize_plp_region_links(parsed_data, effective_gene=None):
    """Set matched-only ClinVar list URLs after upstream/downstream hits are merged."""
    gene = (effective_gene or parsed_data.get("gene_symbol") or parsed_data.get("gene") or "").strip()
    for direction in ("upstream", "downstream"):
        hits = parsed_data.get(f"{direction}_pathogenic_hits") or []
        if not hits:
            continue
        cv_hits = [h for h in hits if str(h.get("source") or "clinvar").lower() != "hgmd"]
        parsed_data[f"{direction}_pathogenic_hit_count"] = len(hits)
        parsed_data[f"{direction}_pathogenic_clinvar_count"] = len(cv_hits)
        list_url = _plp_region_clinvar_list_url(hits, gene=gene)
        if list_url:
            parsed_data[f"{direction}_pathogenic_clinvar_list_link"] = list_url
            parsed_data[f"auto_{direction}_pathogenic_link"] = list_url


def _finalize_downstream_plp_scan_metadata(parsed_data, effective_gene=None):
    """
    After the 3′ P/LP scan runs: flag completion, set exploratory ClinVar link when
    no matched hits, and populate nmd_math when structural NMD left it empty.
    """
    if not _needs_downstream_clinvar_plp(parsed_data):
        return
    anchor = _downstream_plp_anchor_aa(parsed_data)
    if anchor <= 0:
        return
    parsed_data["downstream_plp_scan_performed"] = True
    gene = (effective_gene or parsed_data.get("gene_symbol") or parsed_data.get("gene") or "").strip()
    if not parsed_data.get("downstream_pathogenic_clinvar_list_link"):
        from vc_engine.clinvar import _clinvar_gene_plp_search_url

        search_url = _clinvar_gene_plp_search_url(gene)
        if search_url:
            parsed_data["downstream_pathogenic_clinvar_search_link"] = search_url
    try:
        trunc_frac = float(parsed_data.get("nmd_escape_truncation_fraction") or 0.0)
    except (TypeError, ValueError):
        trunc_frac = 0.0
    p_len = parsed_data.get("protein_length") or "?"
    if is_short_3prime_extension(trunc_frac) or is_long_3prime_extension(trunc_frac):
        ext_pct = round(abs(trunc_frac) * 100, 1)
        bucket = "≥10%" if is_long_3prime_extension(trunc_frac) else "<10%"
        pct_clause = (
            f" (frameshift stop past the native terminus — extends the ORF by "
            f"{ext_pct}% vs the {p_len}-aa reference; {bucket} 3′ extension)"
        )
        scan_bit = (
            f" ClinVar/HGMD scanned for P/LP strictly 3′ of aa {anchor} "
            f"(coordinate past WT end; exploratory)."
        )
    elif trunc_frac > 0:
        pct = round(trunc_frac * 100, 1)
        if is_severe_loss(trunc_frac):
            pct_clause = f" ({pct}% of {p_len}-aa protein lost — ≥10% C-terminal truncation)"
        elif is_marginal_loss(trunc_frac):
            pct_clause = f" ({pct}% of {p_len}-aa protein lost — <10%; evaluate clinical criticality)"
        else:
            pct_clause = f" ({pct}% of {p_len}-aa protein lost)"
        scan_bit = f" ClinVar/HGMD scanned for P/LP strictly 3′ of aa {anchor}."
    else:
        pct_clause = ""
        scan_bit = f" ClinVar/HGMD scanned for P/LP strictly 3′ of aa {anchor}."
    base = f"Novel PTC at aa {anchor}{pct_clause}.{scan_bit}"
    if not (parsed_data.get("nmd_math") or "").strip():
        parsed_data["nmd_math"] = base
    elif parsed_data.get("downstream_pathogenic_hits"):
        pass
    elif "3′ of aa" not in str(parsed_data.get("nmd_math") or ""):
        parsed_data["nmd_math"] = f"{parsed_data['nmd_math'].rstrip()} {base}"
    if not parsed_data.get("downstream_pathogenic_hits"):
        zero_note = f" No matched ClinVar P/LP variants downstream of aa {anchor}."
        if zero_note.strip() not in str(parsed_data.get("nmd_math") or ""):
            parsed_data["nmd_math"] = f"{(parsed_data.get('nmd_math') or '').rstrip()}{zero_note}"


def _finalize_skipped_exon_plp_links(parsed_data):
    """Matched-only ClinVar list URL for P/LP variants inside the skipped exon."""
    hits = parsed_data.get("skipped_exon_pathogenic_hits") or []
    if not hits:
        return
    cv_hits = [h for h in hits if str(h.get("source") or "clinvar").lower() != "hgmd"]
    parsed_data["skipped_exon_pathogenic_hit_count"] = len(hits)
    parsed_data["skipped_exon_pathogenic_clinvar_count"] = len(cv_hits)
    list_url = _clinvar_multi_vid_search_url(
        [str(h.get("clinvar_vid") or "").strip() for h in cv_hits]
    )
    if list_url:
        parsed_data["skipped_exon_pathogenic_clinvar_list_link"] = list_url
        parsed_data["deleted_exon_pathogenic_link"] = list_url
    if hits:
        parsed_data["has_pathogenic_in_deleted_exon"] = True
        rep = cv_hits[0] if cv_hits else hits[0]
        parsed_data["deleted_exon_pathogenic_string"] = rep.get("label") or ""
        parsed_data["deleted_exon_pathogenic_vid"] = rep.get("clinvar_vid") or ""


def _cds_pos_to_genomic(parsed_data, cds_pos):
    """Map one 1-based CDS coordinate to genomic position on the curated transcript."""
    try:
        cds_pos = int(cds_pos)
    except (TypeError, ValueError):
        return None, None
    if cds_pos <= 0:
        return None, None
    g0 = parsed_data.get("cds_genomic_start")
    g1 = parsed_data.get("cds_genomic_end")
    if g0 is None or g1 is None:
        return None, None
    try:
        g0, g1 = int(g0), int(g1)
        strand = int(parsed_data.get("transcript_strand") or 1)
    except (TypeError, ValueError):
        return None, None
    for cx in parsed_data.get("coding_exons") or []:
        try:
            sc = int(cx.get("start_cds") or 0)
            ec = int(cx.get("end_cds") or 0)
        except (TypeError, ValueError):
            continue
        if not (sc <= cds_pos <= ec):
            continue
        ol_s = max(int(cx["start"]), g0)
        ol_e = min(int(cx["end"]), g1)
        if ol_s > ol_e:
            return None, None
        offset = cds_pos - sc
        chrom = cx.get("chr") or parsed_data.get("transcript_chrom") or parsed_data.get("grch38_chrom")
        if strand == -1:
            return chrom, ol_e - offset
        return chrom, ol_s + offset
    return None, None


def _cds_interval_to_genomic(parsed_data, cdna_lo, cdna_hi):
    """Map inclusive 1-based CDS interval → genomic interval for ClinVar VCF fetch."""
    try:
        cdna_lo = int(cdna_lo)
        cdna_hi = int(cdna_hi)
    except (TypeError, ValueError):
        return None
    if cdna_lo <= 0 or cdna_hi < cdna_lo:
        return None
    chr_lo, g_lo = _cds_pos_to_genomic(parsed_data, cdna_lo)
    chr_hi, g_hi = _cds_pos_to_genomic(parsed_data, cdna_hi)
    if not chr_lo or g_lo is None or g_hi is None:
        return None
    return {
        "chr": str(chr_lo).replace("chr", ""),
        "start": min(int(g_lo), int(g_hi)),
        "end": max(int(g_lo), int(g_hi)),
    }


def _cryptic_excised_cdna_bounds(parsed_data):
    """Return inclusive 1-based CDS bounds for a cryptic-splice excised segment, if any."""
    cg = parsed_data.get("cryptic_gain_outcome") or {}
    lo = cg.get("excised_cdna_lo")
    hi = cg.get("excised_cdna_hi")
    if lo is not None and hi is not None:
        try:
            lo_i, hi_i = int(lo), int(hi)
            if lo_i > 0 and hi_i >= lo_i:
                return lo_i, hi_i
        except (TypeError, ValueError):
            pass
    new_site = cg.get("new_site_cdna")
    ex_lo = cg.get("exon_cds_start")
    ex_hi = cg.get("exon_cds_end")
    use_donor = cg.get("use_donor_cryptic")
    try:
        new_site = int(new_site)
        ex_lo = int(ex_lo)
        ex_hi = int(ex_hi)
    except (TypeError, ValueError):
        return None
    if use_donor:
        lo_i, hi_i = new_site + 1, ex_hi
    else:
        lo_i, hi_i = ex_lo, new_site - 1
    if lo_i > 0 and hi_i >= lo_i:
        return lo_i, hi_i
    return None


def _splice_deleted_coords_complete(parsed_data):
    """True when splice_deleted_coords has usable chr/start/end for VCF fetch."""
    del_c = parsed_data.get("splice_deleted_coords") or {}
    if not isinstance(del_c, dict):
        return False
    return bool(del_c.get("chr") and del_c.get("start") and del_c.get("end"))


def _whole_exon_skip_modeled(parsed_data):
    """True when a whole-exon skip product is active but coords may still be missing."""
    if _splice_deleted_coords_complete(parsed_data):
        return False
    if parsed_data.get("spliceai_exon_skip_spliceai_primary"):
        return True
    if parsed_data.get("splice_fraction_lost") is not None:
        return True
    if parsed_data.get("splice_is_in_frame") is not None:
        return True
    if parsed_data.get("exon_skip_oof_fs_ter"):
        return True
    if parsed_data.get("splice_target_start_cds") and parsed_data.get("splice_target_end_cds"):
        return True
    sfm = (parsed_data.get("splice_frame_math") or "").lower()
    return "exon" in sfm and "skip" in sfm


def _resolve_skipped_coding_exon_row(parsed_data, coding_exons):
    """Pick the coding-exon row removed by whole-exon skip when coords are not set yet."""
    if not coding_exons:
        return None
    try:
        sc = int(parsed_data.get("splice_target_start_cds") or 0)
        ec = int(parsed_data.get("splice_target_end_cds") or 0)
        if sc > 0 and ec >= sc:
            for cx in coding_exons:
                if int(cx.get("start_cds") or 0) == sc and int(cx.get("end_cds") or 0) == ec:
                    return cx
    except (TypeError, ValueError):
        pass

    c_dot = (parsed_data.get("c_dot") or "").lower()
    m_minus = re.search(r"c\.(-?\d+)\s*-\s*", c_dot)
    m_plus = re.search(r"c\.(-?\d+)\s*\+", c_dot)
    try:
        ve = int(parsed_data.get("variant_exon") or 0)
    except (TypeError, ValueError):
        ve = 0

    if m_minus and not m_plus:
        if ve > 0:
            for cx in coding_exons:
                if int(cx.get("anatomical_rank") or 0) == ve:
                    return cx
        try:
            n = int(m_minus.group(1))
        except (TypeError, ValueError):
            n = 0
        if n:
            c3 = [cx for cx in coding_exons if int(cx.get("start_cds") or 0) >= n]
            if c3:
                c3.sort(
                    key=lambda x: (
                        int(x.get("start_cds") or 0),
                        int(x.get("anatomical_rank") or 0),
                    )
                )
                return c3[0]
    elif m_plus and not m_minus:
        if ve > 0:
            for cx in coding_exons:
                if int(cx.get("anatomical_rank") or 0) == ve:
                    return cx
        try:
            n = int(m_plus.group(1))
        except (TypeError, ValueError):
            n = 0
        if n:
            cands = [
                cx for cx in coding_exons
                if int(cx.get("start_cds") or 0) <= n <= int(cx.get("end_cds") or 0)
            ]
            if cands:
                cands.sort(key=lambda x: abs(int(x.get("end_cds") or 0) - n))
                return cands[0]
            ranked = sorted(
                coding_exons,
                key=lambda x: (abs(int(x.get("end_cds") or 0) - n), int(x.get("anatomical_rank") or 0)),
            )
            if ranked:
                return ranked[0]
    elif ve > 0:
        for cx in coding_exons:
            if int(cx.get("anatomical_rank") or 0) == ve:
                return cx
    return None


def _hydrate_whole_exon_skip_deleted_coords(parsed_data):
    """
    Fill splice_deleted_coords when exon skip is modeled (SpliceAI or structural math)
    but the classic splice-frame block did not run (e.g. intron_variant + c.N± only).
    """
    if _splice_deleted_coords_complete(parsed_data):
        return True
    # Drop incomplete placeholders so a later coding_exons fetch can refill.
    if parsed_data.get("splice_deleted_coords"):
        parsed_data.pop("splice_deleted_coords", None)
    if not _whole_exon_skip_modeled(parsed_data):
        return False
    coding_exons = parsed_data.get("coding_exons") or []
    cx = _resolve_skipped_coding_exon_row(parsed_data, coding_exons)
    if not cx or not cx.get("chr") or not cx.get("start") or not cx.get("end"):
        return False
    parsed_data["splice_deleted_coords"] = {
        "chr": cx.get("chr"),
        "start": cx.get("start"),
        "end": cx.get("end"),
    }
    if not parsed_data.get("splice_target_start_cds"):
        parsed_data["splice_target_start_cds"] = cx.get("start_cds")
        parsed_data["splice_target_end_cds"] = cx.get("end_cds")
    if parsed_data.get("splice_is_in_frame") is None:
        try:
            bp = int(cx.get("length_bp") or 0)
            if bp > 0:
                parsed_data["splice_is_in_frame"] = (bp % 3 == 0)
        except (TypeError, ValueError):
            pass
    return True


def _skipped_exon_plp_scan_banner_html(parsed_data):
    """Prominent skipped-exon ClinVar P/LP scan status for splice product panels."""
    region = _excised_region_noun(parsed_data)
    aa_lbl = _skipped_exon_aa_range_label(parsed_data)
    aa_bit = f" (protein {aa_lbl})" if aa_lbl else ""
    if parsed_data.get("has_pathogenic_in_deleted_exon"):
        n = len(parsed_data.get("skipped_exon_pathogenic_hits") or [])
        lbl = "1 P/LP match" if n == 1 else f"{n} P/LP matches"
        link = parsed_data.get("skipped_exon_pathogenic_clinvar_list_link") or parsed_data.get(
            "deleted_exon_pathogenic_link"
        )
        if link:
            return (
                f'<b>Skipped exon ClinVar P/LP scan:</b> <a href="{html.escape(link)}" '
                f'target="_blank" style="color:#fca5a5;text-decoration:underline;font-weight:bold;">'
                f"{lbl} in the {region}{aa_bit}</a>."
            )
        return f"<b>Skipped exon ClinVar P/LP scan:</b> {lbl} in the {region}{aa_bit}."
    if parsed_data.get("skipped_exon_plp_checked"):
        return (
            f"<b>Skipped exon ClinVar P/LP scan:</b> No P/LP variants in the {region}{aa_bit} "
            f"(local ClinVar VCF + HGMD protein-position scan)."
        )
    if parsed_data.get("skipped_exon_plp_vcf_unavailable"):
        return (
            f"<b>Skipped exon ClinVar P/LP scan:</b> "
            f"<span style=\"color:#fbbf24;\">Local ClinVar VCF not loaded on this server — "
            f"HGMD-only / manual ClinVar check may still be needed for the {region}{aa_bit}.</span>"
        )
    if _whole_exon_skip_modeled(parsed_data) or parsed_data.get("splice_deleted_coords"):
        reason = (
            "transcript exon coordinates were not available yet (Ensembl lookup)"
            if not (parsed_data.get("coding_exons") or [])
            else "could not map the skipped exon interval on this transcript"
        )
        return (
            f"<b>Skipped exon ClinVar P/LP scan:</b> "
            f"<span style=\"color:#fbbf24;\">Not run — {reason}.</span>"
        )
    return ""


def _hydrate_splice_excised_region(parsed_data):
    """Promote cryptic-splice excised CDNA into splice_deleted_coords for P/LP scan."""
    if _splice_deleted_coords_complete(parsed_data):
        return True
    if parsed_data.get("splice_deleted_coords"):
        parsed_data.pop("splice_deleted_coords", None)
    bounds = _cryptic_excised_cdna_bounds(parsed_data)
    if not bounds:
        return False
    excised_lo, excised_hi = bounds
    geo = _cds_interval_to_genomic(parsed_data, excised_lo, excised_hi)
    if not geo or not geo.get("chr") or not geo.get("start") or not geo.get("end"):
        return False
    parsed_data["splice_deleted_coords"] = geo
    parsed_data["splice_excised_partial"] = True
    parsed_data["splice_target_start_cds"] = excised_lo
    parsed_data["splice_target_end_cds"] = excised_hi
    parsed_data["skipped_exon_aa_range"] = [
        (excised_lo + 2) // 3,
        (excised_hi + 2) // 3,
    ]
    return True


def _excised_region_noun(parsed_data):
    return "excised region" if parsed_data.get("splice_excised_partial") else "skipped exon"


def _hydrate_skipped_exon_aa_bounds(parsed_data):
    """CDS bounds of the skipped exon → inclusive protein aa [lo, hi] on the curated transcript."""
    rng = parsed_data.get("skipped_exon_aa_range")
    if isinstance(rng, (list, tuple)) and len(rng) == 2:
        try:
            lo, hi = int(rng[0]), int(rng[1])
            if lo > 0 and hi > 0:
                if lo > hi:
                    lo, hi = hi, lo
                return lo, hi
        except (TypeError, ValueError):
            pass
    bounds = []
    for key in ("splice_target_start_cds", "splice_target_end_cds"):
        try:
            vi = int(parsed_data.get(key) or 0)
            if vi > 0:
                bounds.append((vi + 2) // 3)
        except (TypeError, ValueError):
            continue
    if len(bounds) != 2:
        return None
    lo, hi = min(bounds), max(bounds)
    parsed_data["skipped_exon_aa_range"] = [lo, hi]
    parsed_data["skipped_exon_aa_lo"] = lo
    parsed_data["skipped_exon_aa_hi"] = hi
    return lo, hi


def _skipped_exon_aa_range_label(parsed_data):
    """Plain 'aa lo–hi' label for skipped-exon headers."""
    bounds = _hydrate_skipped_exon_aa_bounds(parsed_data)
    if not bounds:
        return ""
    lo, hi = bounds
    return f"aa {lo}–{hi}"


def _skipped_exon_uniprot_overlap_html(parsed_data):
    """UniProt domains/motifs overlapping the skipped exon protein span."""
    line = _skipped_exon_uniprot_report_line(parsed_data)
    return f"<br>{line}" if line else ""


def _skipped_exon_region_context_html(parsed_data):
    """Skipped-exon aa span + UniProt cross-reference for review panels."""
    aa_lbl = _skipped_exon_aa_range_label(parsed_data)
    if not aa_lbl:
        return ""
    region = _excised_region_noun(parsed_data)
    if parsed_data.get("splice_excised_partial"):
        lead = f"Excised splice region maps to protein {html.escape(aa_lbl)} on the curated transcript."
    else:
        lead = f"Skipped exon maps to protein {html.escape(aa_lbl)} on the curated transcript."
    parts = [
        f'<span style="color:#94a3b8;">{lead}</span>'
    ]
    up = _skipped_exon_uniprot_overlap_html(parsed_data)
    if up:
        parts.append(up)
    return "<br>".join(parts)


def _skipped_exon_plp_hits_markup(parsed_data):
    """HTML fragment: P/LP variants inside skipped exon (local ClinVar VCF scan)."""
    hits = parsed_data.get("skipped_exon_pathogenic_hits") or []
    if not hits:
        return ""
    parts = [_plp_region_hit_item_html(h) for h in hits]
    list_url = (
        parsed_data.get("skipped_exon_pathogenic_clinvar_list_link")
        or parsed_data.get("deleted_exon_pathogenic_link")
        or _clinvar_multi_vid_search_url([h.get("clinvar_vid") for h in hits])
    )
    has_hgmd = any(str(h.get("source") or "").lower() == "hgmd" for h in hits)
    aa_lbl = _skipped_exon_aa_range_label(parsed_data)
    range_txt = f" ({aa_lbl})" if aa_lbl else ""
    region = _excised_region_noun(parsed_data)
    label_txt = (
        f"ClinVar / HGMD P/LP variants inside the {region}"
        if has_hgmd
        else f"ClinVar P/LP variants inside the {region}"
    )
    head = (
        '<br><br><span style="font-weight:600;color:#cbd5e1;">'
        f"{label_txt}{range_txt}</span>"
    )
    head += _plp_region_matched_clinvar_link_html(hits, list_url)
    head += ": "
    body = head + "; ".join(parts) + "."
    up = _skipped_exon_uniprot_overlap_html(parsed_data)
    return body + (up or "")


def _plp_region_hit_item_html(h):
    """
    One semicolon-delimited hit for upstream/downstream P/LP lists.
    ClinVar: HGVS/classification as plain text plus gold [VID: nnn] link (alternate-allele UI).
    HGMD: HGVS stays linked to HGMD gene search when a URL is present.
    """
    src = str(h.get("source") or "clinvar").lower()
    lab = html.escape(str(h.get("label") or ""))
    lk = str(h.get("link") or "").strip()
    badge = (
        ' <span style="color:#94a3b8;font-size:0.85em;">(HGMD)</span>'
        if src == "hgmd"
        else ' <span style="color:#94a3b8;font-size:0.85em;">(ClinVar)</span>'
    )
    if src == "hgmd":
        if lk:
            return (
                f'<a href="{html.escape(lk, quote=True)}" target="_blank" rel="noopener noreferrer">{lab}</a>{badge}'
            )
        return lab + badge
    vid = str(h.get("clinvar_vid") or "").strip()
    vid_html = ""
    if vid.isdigit():
        vurl = f"https://www.ncbi.nlm.nih.gov/clinvar/variation/{vid}/"
        vid_html = (
            f' <a href="{html.escape(vurl, quote=True)}" target="_blank" rel="noopener noreferrer" '
            f'style="color:#fbbf24;text-decoration:underline;">[VID: {html.escape(vid)}]</a>'
        )
    elif lk:
        vid_html = (
            f' <a href="{html.escape(lk, quote=True)}" target="_blank" rel="noopener noreferrer" '
            f'style="color:#fbbf24;text-decoration:underline;">ClinVar record</a>'
        )
    pos = h.get("position")
    pos_html = ""
    if pos is not None:
        try:
            pos_html = (
                f' <span style="color:#94a3b8;font-size:0.9em;">(aa {int(pos)})</span>'
            )
        except (TypeError, ValueError):
            pass
    return lab + pos_html + vid_html + badge


def _upstream_plp_hits_markup(parsed_data, next_met_pos=None):
    """HTML fragment: upstream_pathogenic_hits with ClinVar / HGMD links (empty if none)."""
    uh = parsed_data.get("upstream_pathogenic_hits")
    if not uh:
        return ""
    parts = []
    has_hgmd = False
    has_cv = False
    for h in uh:
        src = str(h.get("source") or "clinvar").lower()
        if src == "hgmd":
            has_hgmd = True
        else:
            has_cv = True
        parts.append(_plp_region_hit_item_html(h))
    if not parts:
        return ""
    try:
        nm = int(next_met_pos)
    except (TypeError, ValueError):
        nm = 0
    if nm > 0:
        if has_cv and has_hgmd:
            head = (
                '<br><br><span style="font-weight:600;color:#cbd5e1;">ClinVar P/LP and HGMD catalogue variants upstream of the '
                f"next Met (protein position &lt; {nm})</span>: "
            )
        elif has_hgmd:
            head = (
                '<br><br><span style="font-weight:600;color:#cbd5e1;">HGMD catalogue variants upstream of the '
                f"next Met (protein position &lt; {nm})</span>: "
            )
        else:
            head = (
                '<br><br><span style="font-weight:600;color:#cbd5e1;">ClinVar P/LP variants upstream of the '
                f"next Met (protein position &lt; {nm})</span>: "
            )
    else:
        if has_cv and has_hgmd:
            head = (
                '<br><br><span style="font-weight:600;color:#cbd5e1;">'
                "ClinVar P/LP and HGMD catalogue variants (N-terminal segment)</span>: "
            )
        elif has_hgmd:
            head = (
                '<br><br><span style="font-weight:600;color:#cbd5e1;">'
                "HGMD catalogue variants (N-terminal segment)</span>: "
            )
        else:
            head = (
                '<br><br><span style="font-weight:600;color:#cbd5e1;">'
                "ClinVar P/LP variants (N-terminal segment)</span>: "
            )
    gene = (parsed_data.get("gene_symbol") or parsed_data.get("gene") or "").strip()
    list_url = (
        parsed_data.get("upstream_pathogenic_clinvar_list_link")
        or _plp_region_clinvar_list_url(uh, gene=gene)
    )
    head += _plp_region_matched_clinvar_link_html(uh, list_url)
    return head + "; ".join(parts) + "."


def _downstream_plp_hits_markup(parsed_data, variant_aa_pos=None):
    """HTML fragment: downstream_pathogenic_hits with ClinVar / HGMD links (empty if none)."""
    dh = parsed_data.get("downstream_pathogenic_hits")
    if not dh:
        return ""
    parts = []
    has_hgmd = False
    has_cv = False
    for h in dh:
        src = str(h.get("source") or "clinvar").lower()
        if src == "hgmd":
            has_hgmd = True
        else:
            has_cv = True
        parts.append(_plp_region_hit_item_html(h))
    if not parts:
        return ""
    if variant_aa_pos is not None:
        try:
            va = int(variant_aa_pos)
        except (TypeError, ValueError):
            va = 0
    else:
        va = _downstream_plp_anchor_aa(parsed_data)
    try:
        ps = int(parsed_data.get("protein_start") or 0)
    except (TypeError, ValueError):
        ps = 0
    region_label = "the novel PTC" if va > 0 and va != ps else "this variant"
    if va > 0:
        if has_cv and has_hgmd:
            head = (
                '<br><br><span style="font-weight:600;color:#cbd5e1;">ClinVar P/LP and HGMD catalogue variants downstream of '
                f"{region_label} (protein position &gt; {va})</span>: "
            )
        elif has_hgmd:
            head = (
                '<br><br><span style="font-weight:600;color:#cbd5e1;">HGMD catalogue variants downstream of '
                f"{region_label} (protein position &gt; {va})</span>: "
            )
        else:
            head = (
                '<br><br><span style="font-weight:600;color:#cbd5e1;">ClinVar P/LP variants downstream of '
                f"{region_label} (protein position &gt; {va})</span>: "
            )
    else:
        if has_cv and has_hgmd:
            head = (
                '<br><br><span style="font-weight:600;color:#cbd5e1;">'
                "ClinVar P/LP and HGMD catalogue variants (downstream / 3′)</span>: "
            )
        elif has_hgmd:
            head = (
                '<br><br><span style="font-weight:600;color:#cbd5e1;">'
                "HGMD catalogue variants (downstream / 3′)</span>: "
            )
        else:
            head = (
                '<br><br><span style="font-weight:600;color:#cbd5e1;">'
                "ClinVar P/LP variants (downstream / 3′)</span>: "
            )
    gene = (parsed_data.get("gene_symbol") or parsed_data.get("gene") or "").strip()
    list_url = (
        parsed_data.get("downstream_pathogenic_clinvar_list_link")
        or _plp_region_clinvar_list_url(dh, gene=gene)
    )
    head += _plp_region_matched_clinvar_link_html(dh, list_url)
    return head + "; ".join(parts) + "."


def _deleted_exon_analysis_evidence_html(parsed_data):
    """Skipped-exon P/LP list for logic / report prose (matched ClinVar hits only)."""
    return _skipped_exon_plp_hits_markup(parsed_data)
