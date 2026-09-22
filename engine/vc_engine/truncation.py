"""Shared truncation fraction math and institutional 10% rule thresholds.

C-terminal loss (nonsense, frameshift, NMD-escape): stop removes aa stop..protein_length.
N-terminal loss (start_lost): next in-frame Met removes aa 1..(next_met-1).

Threshold convention (consistent across engine, scoring, UI):
  - marginal: 0 < fraction <= TRUNC_SEVERE_THRESHOLD (includes exactly 10%)
  - severe:   fraction > TRUNC_SEVERE_THRESHOLD
"""
from __future__ import annotations

import re
from typing import Any, Mapping, MutableMapping, Optional

TRUNC_SEVERE_THRESHOLD = 0.10

_HGVSP_NONSENSE_RE = re.compile(
    r"p\.(?:([A-Z][a-z]{2})(\d+)(?:\*|Ter)|([A-Z*])(\d+)\*)",
    re.I,
)


def c_terminal_loss_fraction(stop_aa: int, protein_length: int) -> float:
    """C-terminal length change when translation stops at ``stop_aa`` (1-based).

    Positive: fraction of the WT protein lost to a premature stop.
    Negative: fraction by which a frameshift stop past the native terminus
    extends the ORF (used by ``is_short_3prime_extension`` / long-extension rules).
    """
    try:
        stop = int(stop_aa)
        plen = int(protein_length)
    except (TypeError, ValueError):
        return 0.0
    if stop <= 0 or plen <= 0:
        return 0.0
    # Guard: never treat "unknown length coerced to 1" style inputs as a giant
    # 3′ extension (e.g. NOTCH1 p.C552Yfs*19 with plen=1 → −570).
    if plen < 10 and stop > plen * 2:
        return 0.0
    return 1.0 - (stop / float(plen))


def n_terminal_loss_fraction(next_met_aa: int, protein_length: int) -> float:
    """Fraction of the N-terminus lost when re-initiation occurs at ``next_met_aa``."""
    try:
        nmet = int(next_met_aa)
        plen = int(protein_length)
    except (TypeError, ValueError):
        return 0.0
    if nmet <= 1 or plen <= 0 or nmet > plen:
        return 0.0
    return (nmet - 1) / float(plen)


def parse_nonsense_stop_aa_from_hgvs(hgvs_p: str) -> int:
    """Extract PTC position from p.Ser1050* / p.S1050* style HGVS."""
    m = _HGVSP_NONSENSE_RE.search(str(hgvs_p or ""))
    if not m:
        return 0
    try:
        return int(m.group(2) or m.group(4))
    except (TypeError, ValueError):
        return 0


def is_marginal_loss(fraction: float) -> bool:
    """Within the <10% institutional pathway (strictly positive, up to and including 10%)."""
    try:
        f = float(fraction)
    except (TypeError, ValueError):
        return False
    return 0.0 < f <= TRUNC_SEVERE_THRESHOLD


def is_severe_loss(fraction: float) -> bool:
    """Above the 10% institutional threshold."""
    try:
        f = float(fraction)
    except (TypeError, ValueError):
        return False
    return f > TRUNC_SEVERE_THRESHOLD


def is_short_3prime_extension(fraction: float) -> bool:
    """Frameshift extends the ORF slightly (negative loss fraction, under 10%)."""
    try:
        f = float(fraction)
    except (TypeError, ValueError):
        return False
    return -TRUNC_SEVERE_THRESHOLD < f < 0.0


def is_long_3prime_extension(fraction: float) -> bool:
    """Frameshift extends the ORF by at least 10%."""
    try:
        f = float(fraction)
    except (TypeError, ValueError):
        return False
    return f <= -TRUNC_SEVERE_THRESHOLD


def truncation_rule_label(fraction: float) -> Optional[str]:
    """Short UI/logic label for the 10% rule bucket."""
    if is_marginal_loss(fraction):
        return "<10% rule"
    if is_severe_loss(fraction):
        return "≥10% rule"
    return None


def truncation_pct_display(fraction: float, digits: int = 1) -> Optional[float]:
    try:
        f = float(fraction)
    except (TypeError, ValueError):
        return None
    if f <= 0:
        return None
    return round(f * 100.0, digits)


def resolved_ptc_stop_aa(parsed_data: Mapping[str, Any]) -> int:
    """True PTC position (after frameshift extension when shift aa are present).

    Start-loss is N-terminal / re-initiation math — do not treat protein_start=1
    as a C-terminal PTC (that falsely yields ~99% "truncated").
    """
    csq = str(parsed_data.get("consequence") or "")
    if csq == "start_lost":
        return 0
    try:
        ps = int(parsed_data.get("protein_start") or 0)
        da = int(parsed_data.get("downstream_aas") or 0)
        if ps > 0 and da > 0:
            return ps + da
    except (TypeError, ValueError):
        pass
    for key in ("novel_stop_aa", "junction_model_ptc_position", "exon_skip_oof_ptc_aa"):
        try:
            v = int(parsed_data.get(key) or 0)
            if v > 0:
                return v
        except (TypeError, ValueError):
            pass
    if csq in ("nonsense", "frameshift") or parsed_data.get("is_splice_frameshift"):
        try:
            ps = int(parsed_data.get("protein_start") or 0)
            if ps > 0:
                return ps
        except (TypeError, ValueError):
            pass
    return 0


def sync_truncation_fraction_from_ptc(parsed_data: MutableMapping[str, Any]) -> float:
    """Recompute truncation fraction for nonsense/frameshift (C-term) or start-loss (N-term)."""
    if parsed_data.get("cryptic_natural_stop_preserved"):
        try:
            return float(parsed_data.get("nmd_escape_truncation_fraction") or 0)
        except (TypeError, ValueError):
            return 0.0
    # In-frame whole-exon skip without a PTC uses splice_fraction_lost (residues removed), not C-term loss.
    if (
        parsed_data.get("splice_is_in_frame")
        and not parsed_data.get("is_splice_frameshift")
        and not resolved_ptc_stop_aa(parsed_data)
    ):
        try:
            return float(parsed_data.get("nmd_escape_truncation_fraction") or 0)
        except (TypeError, ValueError):
            return 0.0
    csq = parsed_data.get("consequence") or ""

    # Start-loss: fraction is distance to the next in-frame Met, never C-terminal PTC math.
    if csq == "start_lost":
        try:
            plen = int(parsed_data.get("protein_length") or 0)
        except (TypeError, ValueError):
            plen = 0
        try:
            nmet = int(parsed_data.get("next_methionine_position") or 0)
        except (TypeError, ValueError):
            nmet = 0
        if nmet == -1 and plen > 0:
            parsed_data["nmd_escape_truncation_fraction"] = 1.0
            return 1.0
        if nmet > 0 and plen > 0:
            frac = start_loss_fraction_from_next_met(nmet, plen)
            parsed_data["nmd_escape_truncation_fraction"] = frac
            return frac
        try:
            return float(parsed_data.get("nmd_escape_truncation_fraction") or 0)
        except (TypeError, ValueError):
            return 0.0

    has_ptc = resolved_ptc_stop_aa(parsed_data) > 0
    splice_ptc = bool(
        parsed_data.get("junction_model_ptc_position")
        or parsed_data.get("exon_skip_oof_ptc_aa")
        or parsed_data.get("is_splice_frameshift")
    )
    if csq not in ("nonsense", "frameshift") and not splice_ptc and not has_ptc:
        parsed_data["nmd_escape_truncation_fraction"] = 0.0
        return 0.0
    try:
        plen = int(parsed_data.get("protein_length") or 0)
    except (TypeError, ValueError):
        plen = 0
    stop = resolved_ptc_stop_aa(parsed_data)
    if stop <= 0:
        stop = parse_nonsense_stop_aa_from_hgvs(parsed_data.get("hgvs_p") or "")
    if stop <= 0 or plen <= 0:
        # Do not keep a stale absurd extension % (e.g. −570 from plen coerced to 1).
        try:
            stale = float(parsed_data.get("nmd_escape_truncation_fraction") or 0)
        except (TypeError, ValueError):
            stale = 0.0
        if stale < 0 and (plen <= 0 or abs(stale) > 2.0):
            parsed_data["nmd_escape_truncation_fraction"] = 0.0
            return 0.0
        try:
            return float(parsed_data.get("nmd_escape_truncation_fraction") or 0)
        except (TypeError, ValueError):
            return 0.0
    frac = c_terminal_loss_fraction(stop, plen)
    # Persist truncations and 3′ extensions (negative fraction); leave 0.0 alone.
    if frac != 0.0:
        parsed_data["nmd_escape_truncation_fraction"] = frac
    elif float(parsed_data.get("nmd_escape_truncation_fraction") or 0) < 0:
        # Recomputed 0 after length was fixed — clear prior bogus extension.
        parsed_data["nmd_escape_truncation_fraction"] = 0.0
    return frac


def downstream_plp_anchor_aa(parsed_data: Mapping[str, Any]) -> int:
    """Amino-acid index for 3′ P/LP scans — delegates to resolved PTC stop."""
    return resolved_ptc_stop_aa(parsed_data or {})


def formalize_nonsense_ptc(
    parsed_data: MutableMapping[str, Any],
    stop_aa: int,
    protein_length: int,
) -> None:
    """Set canonical PTC fields for nonsense (stop aa == onset aa)."""
    try:
        stop = int(stop_aa)
        plen = int(protein_length)
    except (TypeError, ValueError):
        return
    if stop <= 0 or plen <= 0:
        return
    parsed_data["protein_start"] = stop
    parsed_data["novel_stop_aa"] = stop
    frac = c_terminal_loss_fraction(stop, plen)
    if frac > 0:
        parsed_data["nmd_escape_truncation_fraction"] = frac


def formalize_frameshift_ptc(
    parsed_data: MutableMapping[str, Any],
    onset_aa: int,
    stop_aa: int,
    protein_length: int,
) -> None:
    """Set canonical PTC fields for frameshift (onset != stop when extension present).

    Do not clamp ``stop_aa`` to WT ``protein_length`` — frameshifts that read into
    the 3′ UTR (e.g. DOCK4 p.Gln1974ValfsTer19) must keep stop > length so the
    negative extension fraction drives short/long 3′-extension matrix rules.
    """
    try:
        onset = int(onset_aa)
        stop = int(stop_aa)
        plen = int(protein_length)
    except (TypeError, ValueError):
        return
    if onset <= 0:
        return
    parsed_data["protein_start"] = onset
    if stop > 0:
        parsed_data["novel_stop_aa"] = stop
        parsed_data["downstream_aas"] = max(0, stop - onset)
    # Need a real WT length before claiming truncation % or 3′ extension %.
    if plen <= 0 or (plen < max(onset, 10) and stop > plen):
        return
    if stop > 0:
        frac = c_terminal_loss_fraction(stop, plen)
    else:
        frac = c_terminal_loss_fraction(onset, plen) if onset <= plen else 0.0
    if frac != 0.0:
        parsed_data["nmd_escape_truncation_fraction"] = frac


def is_start_loss_reinit_viable(fraction: float) -> bool:
    """Start-loss re-initiation escape: strictly under 10% (exactly 10% is severe)."""
    try:
        f = float(fraction)
    except (TypeError, ValueError):
        return False
    return 0.0 <= f < TRUNC_SEVERE_THRESHOLD


def start_loss_fraction_from_next_met(next_met_aa: int, protein_length: int) -> float:
    """Analyze convention: next in-frame Met rank / total protein length."""
    try:
        nmet = int(next_met_aa)
        plen = int(protein_length)
    except (TypeError, ValueError):
        return 0.0
    if nmet <= 0 or plen <= 0:
        return 0.0
    return nmet / float(plen)


def ensure_truncation_fraction_from_stop(parsed_data: MutableMapping[str, Any]) -> None:
    """
    Backfill C-terminal loss % for nonsense/frameshift when stop aa and protein
    length are known but ``nmd_escape_truncation_fraction`` was never set.
    """
    if parsed_data.get("cryptic_natural_stop_preserved"):
        return
    csq = parsed_data.get("consequence") or ""
    if csq not in ("nonsense", "frameshift"):
        return
    try:
        frac = float(parsed_data.get("nmd_escape_truncation_fraction") or 0)
    except (TypeError, ValueError):
        frac = 0.0
    if frac > 0:
        return
    stop_aa = resolved_ptc_stop_aa(parsed_data)
    if stop_aa <= 0:
        stop_aa = parse_nonsense_stop_aa_from_hgvs(parsed_data.get("hgvs_p") or "")
    try:
        p_len = int(parsed_data.get("protein_length") or 0)
    except (TypeError, ValueError):
        p_len = 0
    if stop_aa <= 0 or p_len <= 0:
        return
    if csq == "nonsense":
        formalize_nonsense_ptc(parsed_data, stop_aa, p_len)
    else:
        formalize_frameshift_ptc(parsed_data, stop_aa, stop_aa, p_len)


def apply_nmd_escape_from_coding_exons(
    parsed_data: MutableMapping[str, Any],
    nmd_calc_cds_pos: int,
) -> bool:
    """Set nmd_escape / nmd_decision_basis from coding_exons + PTC CDS index.

    Uses coding-exon list position for the escape decision (last / penultimate /
    50 nt rule) and anatomical ranks for display. Returns True when a decision
    was written.
    """
    try:
        cds_pos = int(nmd_calc_cds_pos or 0)
    except (TypeError, ValueError):
        return False
    if cds_pos <= 0:
        return False
    coding_exons = parsed_data.get("coding_exons") or []
    if not isinstance(coding_exons, list) or not coding_exons:
        return False

    ptc_cx = None
    for cx in coding_exons:
        try:
            sc = int(cx.get("start_cds") or 0)
            ec = int(cx.get("end_cds") or 0)
        except (TypeError, ValueError):
            continue
        if sc <= cds_pos <= ec:
            ptc_cx = cx
            break

    if ptc_cx is None:
        last_cx = coding_exons[-1]
        try:
            last_end = int(last_cx.get("end_cds") or 0)
        except (TypeError, ValueError):
            last_end = 0
        if last_end and cds_pos > last_end:
            ptc_rank = last_cx.get("anatomical_rank")
            try:
                parsed_data["snpeff_exon_rank"] = int(ptc_rank)
            except (TypeError, ValueError):
                parsed_data["snpeff_exon_rank"] = ptc_rank
            parsed_data["nmd_escape"] = True
            parsed_data["nmd_exon_distance"] = 0
            parsed_data["nmd_decision_basis"] = (
                f"Novel stop falls past the CDS end (3′ of last coding exon "
                f"{ptc_rank} of {ptc_rank}) — frameshift extends the ORF into the "
                f"3′ UTR; EJC-driven NMD is not engaged (last-exon / extension) — "
                f"predicted to escape NMD."
            )
            return True
        return False

    try:
        rank_index = coding_exons.index(ptc_cx)
    except ValueError:
        return False
    max_index = len(coding_exons) - 1
    ptc_rank = ptc_cx.get("anatomical_rank")
    n_coding = coding_exons[-1].get("anatomical_rank")
    try:
        parsed_data["snpeff_exon_rank"] = int(ptc_rank)
    except (TypeError, ValueError):
        parsed_data["snpeff_exon_rank"] = ptc_rank

    if rank_index == max_index:
        parsed_data["nmd_escape"] = True
        try:
            parsed_data["nmd_exon_distance"] = int(ptc_cx.get("end_cds") or 0) - cds_pos
        except (TypeError, ValueError):
            parsed_data["nmd_exon_distance"] = 0
        parsed_data["nmd_decision_basis"] = (
            f"PTC in the last coding exon ({ptc_rank} of {n_coding}); "
            "no downstream exon-exon junction remains, so the EJC-driven NMD "
            "machinery is not engaged (last-exon rule) — predicted to escape NMD."
        )
        return True

    if rank_index == max_index - 1:
        try:
            dist_to_junction = int(ptc_cx.get("end_cds") or 0) - cds_pos
        except (TypeError, ValueError):
            dist_to_junction = 0
        parsed_data["nmd_exon_distance"] = dist_to_junction
        if dist_to_junction < 50:
            parsed_data["nmd_escape"] = True
            parsed_data["nmd_decision_basis"] = (
                f"PTC in the penultimate coding exon ({ptc_rank} of {n_coding}), "
                f"{dist_to_junction} nt upstream of the final exon-exon junction "
                "(within the last 50-55 nt) — predicted to escape NMD."
            )
        else:
            parsed_data["nmd_escape"] = False
            parsed_data["nmd_decision_basis"] = (
                f"PTC in the penultimate coding exon ({ptc_rank} of {n_coding}), "
                f"{dist_to_junction} nt upstream of the final exon-exon junction "
                "(more than 50-55 nt) — predicted to trigger NMD."
            )
        return True

    parsed_data["nmd_escape"] = False
    parsed_data["nmd_decision_basis"] = (
        f"PTC in coding exon {ptc_rank} of {n_coding}, upstream of the "
        "penultimate exon-exon junction — predicted to trigger NMD."
    )
    return True
