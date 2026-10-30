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


def frameshift_ter_index(onset_aa: int, fs_ter_n: int) -> int:
    """HGVS ``fsTerN`` / ``fs*N`` termination-codon index.

    The count starts at the first changed residue and includes the stop codon,
    so the codon index is ``onset + N - 1``.
    """
    try:
        onset = int(onset_aa)
        n = int(fs_ter_n)
    except (TypeError, ValueError):
        return 0
    if onset <= 0 or n <= 0:
        return 0
    return onset + n - 1


def frameshift_product_length(ter_index: int) -> int:
    """Translated length of the mutant product. The stop codon is not an amino acid."""
    try:
        ter = int(ter_index)
    except (TypeError, ValueError):
        return 0
    if ter <= 1:
        return 0
    return ter - 1


def protein_extension_fraction(ter_index: int, protein_length: int) -> float:
    """Signed fraction for a 3′ protein extension.

    ``-((product_length - WT_length) / WT_length)``, where
    ``product_length = Ter_index - 1``. Negative so callers still recognize an
    extension via ``fraction < 0``. ``0.0`` when ``Ter_index`` is not past the
    native terminus (that case stays C-terminal loss).

    Do not use ``Ter / WT``. That counts the stop codon as an amino acid
    (TWIST1 233/202 = 15.3% instead of (232 − 202) / 202 = 14.9%).

    A protein length below 10 with a stop far past that length is a failed
    length lookup, not a real extension.
    """
    try:
        ter = int(ter_index)
        plen = int(protein_length)
    except (TypeError, ValueError):
        return 0.0
    if ter <= 0 or plen <= 0 or ter <= plen:
        return 0.0
    if plen < 10 and ter > plen * 2:
        return 0.0
    product = ter - 1
    if product <= plen:
        return 0.0
    return -((product - plen) / float(plen))


_STOP_LOST_HGVS_RE = re.compile(
    r"p\.(?:\*|Ter)(\d+)([A-Za-z]{1,3})ext(?:\*|Ter)(\?|\d+)",
    re.I,
)
_STOP_CODONS = {"TAA", "TAG", "TGA"}
_SNV_CDOT_RE = re.compile(r"c\.(\d+)([ACGT])>([ACGT])", re.I)

STOP_LOST_NMD_BASIS = (
    "Stop-lost read-through continues past the native CDS end into the 3′ UTR; "
    "no exon–exon junction remains downstream of the original terminus — predicted to escape NMD."
)


def stop_lost_ter_index(onset_aa: int, ext_n: int) -> int:
    """HGVS ``p.*{onset}Xext*{N}`` termination-codon index.

    Unlike ``fs*N`` (onset + N − 1), the extension count is added to the
    native stop index: novel Ter = onset + N.
    """
    try:
        onset = int(onset_aa)
        n = int(ext_n)
    except (TypeError, ValueError):
        return 0
    if onset <= 0 or n < 0:
        return 0
    return onset + n


def parse_stop_lost_hgvs(hgvs_p: str) -> Optional[dict]:
    """Parse ``p.*278Cext*?`` / ``p.Ter278CysextTer15``. ``n`` is None when N is ``?``."""
    raw = str(hgvs_p or "").replace("(", "").replace(")", "")
    m = _STOP_LOST_HGVS_RE.search(raw)
    if not m:
        return None
    nraw = m.group(3)
    return {
        "onset": int(m.group(1)),
        "aa": m.group(2),
        "n": None if nraw == "?" else int(nraw),
    }


def parse_snv_cdot(c_dot: str) -> Optional[tuple]:
    """Return ``(c_pos, ref, alt)`` for a coding SNV, or None."""
    m = _SNV_CDOT_RE.search(str(c_dot or ""))
    if not m:
        return None
    return int(m.group(1)), m.group(2).upper(), m.group(3).upper()


def stop_lost_ter_from_readthrough(cds: str, utr: str, c_pos: int, alt: str) -> int:
    """Mutate the native stop in the CDS, append the 3′ UTR, and return the next stop's codon index.

    The codon index is 1-based from the CDS start (the native stop is ``protein_length + 1``).
    Returns 0 when the mutated codon is still a stop or no later in-frame stop is in the sequence.
    """
    seq_cds = (cds or "").upper().replace("U", "T")
    tail = (utr or "").upper().replace("U", "T")
    try:
        pos = int(c_pos)
    except (TypeError, ValueError):
        return 0
    alt_b = str(alt or "").upper().replace("U", "T")
    if pos < 1 or pos > len(seq_cds) or alt_b not in "ACGT":
        return 0
    bases = list(seq_cds)
    bases[pos - 1] = alt_b
    seq = "".join(bases) + tail
    codon0 = ((pos - 1) // 3) * 3
    native_index = codon0 // 3 + 1
    for i in range(codon0, len(seq) - 2, 3):
        tri = seq[i:i + 3]
        if tri in _STOP_CODONS:
            idx = i // 3 + 1
            if idx == native_index:
                return 0
            return idx
    return 0


def protein_extension_explanation(
    ter_index: int,
    protein_length: int,
    nmd_basis: str = "",
    kind: str = "frameshift",
) -> str:
    """Explanation for an elongated ORF, including the percent and both lengths."""
    try:
        ter = int(ter_index)
        plen = int(protein_length)
    except (TypeError, ValueError):
        return ""
    frac = protein_extension_fraction(ter, plen)
    if frac == 0.0:
        return ""
    product = frameshift_product_length(ter)
    pct = round(abs(frac) * 100.0, 1)
    if kind == "stop_lost":
        lead = "Stop-lost read-through past the native terminus — extends the protein"
    else:
        lead = "Frameshift stop past the native terminus — extends the protein"
    sent = (
        f"{lead} by {pct}% "
        f"({product} vs {plen}) (novel stop at aa {ter} vs {plen}-aa reference) — "
        f"elongated ORF with a novel C-terminus (not a shorter truncation)."
    )
    basis = str(nmd_basis or "").strip()
    if basis and basis not in sent:
        return f"{sent} {basis}"
    return sent


def stop_lost_unknown_explanation(onset_aa: int, protein_length: int, nmd_basis: str = "") -> str:
    """Elongated-ORF sentence when ``ext*?`` did not resolve to a codon index."""
    try:
        onset = int(onset_aa or 0)
    except (TypeError, ValueError):
        onset = 0
    try:
        plen = int(protein_length or 0)
    except (TypeError, ValueError):
        plen = 0
    if plen > 0:
        where = f"native stop after aa {plen}"
    else:
        where = "native terminus"
    label = f"p.*{onset}ext*?" if onset > 0 else "ext*?"
    sent = (
        "Stop-lost read-through past the native terminus — extends the protein "
        f"({where}, {label}; novel Ter length not resolved) — "
        "elongated ORF with a novel C-terminus (not a shorter truncation)."
    )
    basis = str(nmd_basis or "").strip()
    if basis and basis not in sent:
        return f"{sent} {basis}"
    return sent


def refresh_protein_extension_readout(parsed_data: MutableMapping[str, Any]) -> float:
    """Store the extension fraction and explanation when the Ter codon is past WT.

    C-terminal loss (stop inside the reference protein) is left unchanged.
    """
    if parsed_data.get("met_reinitiation"):
        return 0.0
    try:
        ter = int(parsed_data.get("novel_stop_aa") or 0)
        plen = int(parsed_data.get("protein_length") or 0)
    except (TypeError, ValueError):
        return 0.0
    if ter <= 0:
        ter = resolved_ptc_stop_aa(parsed_data)
    frac = protein_extension_fraction(ter, plen)
    if frac == 0.0:
        return 0.0
    parsed_data["protein_extension"] = True
    parsed_data.pop("stop_lost_ter_unknown", None)
    parsed_data["protein_product_length"] = frameshift_product_length(ter)
    parsed_data["nmd_escape_truncation_fraction"] = frac
    kind = "stop_lost" if "stop_lost" in str(parsed_data.get("consequence") or "") else "frameshift"
    expl = protein_extension_explanation(
        ter, plen, str(parsed_data.get("nmd_decision_basis") or ""), kind=kind,
    )
    parsed_data["protein_extension_explanation"] = expl
    existing = str(parsed_data.get("nmd_math") or "")
    basis = str(parsed_data.get("nmd_decision_basis") or "").strip()
    if expl and (
        "extends the protein by" not in existing
        or (basis and basis not in existing)
    ):
        parsed_data["nmd_math"] = expl
    return frac


def c_terminal_loss_fraction(stop_aa: int, protein_length: int) -> float:
    """C-terminal length change when translation stops at ``stop_aa`` (1-based).

    Positive: fraction of the WT protein lost to a premature stop inside the
    reference protein (``1 - stop / length``). Unchanged for C-terminal loss.

    When ``stop_aa`` is a termination-codon index past the native terminus,
    returns the protein-extension fraction ``-((product - WT) / WT)`` with
    ``product = stop_aa - 1`` (the stop codon is not an amino acid).

    A protein length below 10 with a stop far past that length is a failed
    length lookup (e.g. NOTCH1 with length coerced to 1), not a real extension.
    """
    try:
        stop = int(stop_aa)
        plen = int(protein_length)
    except (TypeError, ValueError):
        return 0.0
    if stop <= 0 or plen <= 0:
        return 0.0
    if plen < 10 and stop > plen * 2:
        return 0.0
    if stop > plen:
        return protein_extension_fraction(stop, plen)
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


def _restore_early_frameshift_dual_readout(parsed_data: MutableMapping[str, Any]) -> None:
    """Put structural NMD and the next-Met line back if a C-terminal rewrite dropped one."""
    csq = str(parsed_data.get("consequence") or parsed_data.get("original_consequence") or "")
    if csq not in ("nonsense", "frameshift"):
        return
    if not parsed_data.get("met_reinitiation"):
        return
    sop = str(parsed_data.get("next_met_sop_line") or "").strip()
    if not sop:
        return
    basis = str(parsed_data.get("nmd_decision_basis") or "").strip()
    math = str(parsed_data.get("nmd_math") or "")
    has_sop = "N-terminal loss" in math or "next in-frame" in math.lower()
    has_basis = (not basis) or (basis[:48] in math)
    if has_sop and has_basis:
        return
    parsed_data["nmd_math"] = f"{basis} {sop}".strip() if basis else sop


def sync_truncation_fraction_from_ptc(parsed_data: MutableMapping[str, Any]) -> float:
    """Recompute truncation fraction for nonsense/frameshift (C-term) or start-loss (N-term)."""
    if parsed_data.get("cryptic_natural_stop_preserved"):
        try:
            return float(parsed_data.get("nmd_escape_truncation_fraction") or 0)
        except (TypeError, ValueError):
            return 0.0
    # Exon-internal out-of-frame cryptic splice: keep the translated product percent.
    # A later skipped-exon pass must not replace it with whole-exon onset math.
    if parsed_data.get("splice_viz_exon_internal_cryptic"):
        cg = parsed_data.get("cryptic_gain_outcome") or {}
        if isinstance(cg, dict) and not cg.get("whole_exon_skip") and cg.get("in_frame") is False:
            try:
                tf = float(cg.get("truncation_fraction"))
            except (TypeError, ValueError):
                tf = None
            if tf is not None and tf > 0:
                parsed_data["nmd_escape_truncation_fraction"] = tf
                return tf
    # Early OOF exon skip that keeps Met1: percent is next in-frame Met / protein length.
    if parsed_data.get("early_oof_exon_skip_next_met"):
        try:
            plen = int(parsed_data.get("protein_length") or 0)
        except (TypeError, ValueError):
            plen = 0
        try:
            nmet = int(parsed_data.get("next_methionine_position") or 0)
        except (TypeError, ValueError):
            nmet = 0
        if nmet > 0 and plen > 0:
            frac = start_loss_fraction_from_next_met(nmet, plen)
            parsed_data["nmd_escape_truncation_fraction"] = frac
            return frac
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

    # Start-loss, or an early PTC that entered the same next-Met block:
    # fraction is distance to the next in-frame Met, never C-terminal PTC math.
    if csq == "start_lost" or parsed_data.get("met_reinitiation"):
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
            _restore_early_frameshift_dual_readout(parsed_data)
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
    if stop > plen:
        parsed_data["novel_stop_aa"] = stop
        ext = refresh_protein_extension_readout(parsed_data)
        if ext != 0.0:
            return ext
    frac = c_terminal_loss_fraction(stop, plen)
    # Persist truncations and 3′ extensions (negative fraction); leave 0.0 alone.
    if frac != 0.0:
        parsed_data["nmd_escape_truncation_fraction"] = frac
    elif float(parsed_data.get("nmd_escape_truncation_fraction") or 0) < 0:
        # Recomputed 0 after length was fixed — clear prior bogus extension.
        parsed_data["nmd_escape_truncation_fraction"] = 0.0
        parsed_data.pop("protein_extension", None)
        parsed_data.pop("protein_extension_explanation", None)
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
    if parsed_data.get("met_reinitiation"):
        return
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

    Do not clamp ``stop_aa`` to WT ``protein_length``. When ``stop_aa`` is a
    termination-codon index past the native terminus (TWIST1 p.His180MetfsTer54,
    Ter 233 on a 202-aa protein), the fraction is the extension
    ``(product − WT) / WT`` with ``product = Ter − 1``. Stops inside the
    reference protein keep the C-terminal loss fraction.
    """
    if parsed_data.get("met_reinitiation"):
        return
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
    if plen > 0:
        parsed_data["protein_length"] = plen
    # Need a real WT length before claiming truncation % or 3′ extension %.
    if plen <= 0 or (plen < max(onset, 10) and stop > plen):
        return
    if stop > plen > 0:
        refresh_protein_extension_readout(parsed_data)
        return
    if stop > 0:
        frac = c_terminal_loss_fraction(stop, plen)
    else:
        frac = c_terminal_loss_fraction(onset, plen) if onset <= plen else 0.0
    if frac != 0.0:
        parsed_data["nmd_escape_truncation_fraction"] = frac


def apply_stop_lost_extension(
    parsed_data: MutableMapping[str, Any],
    cds: str = "",
    utr: str = "",
) -> None:
    """Formalize a stop-lost as a protein extension (same fraction as a frameshift past WT).

    ``p.*{onset}Xext*{N}`` uses Ter = onset + N (not the frameshift onset+N−1 rule).
    When N is ``?``, ``cds`` + ``utr`` are scanned after the coding SNV is applied
    to the native stop. An unresolved stop still flags an elongated ORF so the
    map can draw native Stop + 3′ UTR + Ter?.
    """
    if parsed_data.get("met_reinitiation"):
        return
    if "stop_lost" not in str(parsed_data.get("consequence") or ""):
        return
    spec = parse_stop_lost_hgvs(parsed_data.get("hgvs_p") or "")
    try:
        plen = int(parsed_data.get("protein_length") or 0)
    except (TypeError, ValueError):
        plen = 0
    if plen < 0:
        plen = 0
    if not str(parsed_data.get("nmd_decision_basis") or "").strip():
        parsed_data["nmd_decision_basis"] = STOP_LOST_NMD_BASIS
    parsed_data["nmd_escape"] = True

    onset = int(spec["onset"]) if spec else (plen + 1 if plen > 0 else 0)
    n = spec.get("n") if spec else None
    ter = 0
    if n is not None:
        ter = stop_lost_ter_index(onset, n)
    elif cds:
        snv = parse_snv_cdot(parsed_data.get("c_dot") or "")
        if snv:
            ter = stop_lost_ter_from_readthrough(cds, utr or "", snv[0], snv[2])
    if ter <= 0:
        try:
            existing = int(parsed_data.get("novel_stop_aa") or 0)
        except (TypeError, ValueError):
            existing = 0
        if existing > plen > 0:
            ter = existing
    if ter > plen > 0:
        if onset > 0:
            parsed_data["protein_start"] = onset
        parsed_data["novel_stop_aa"] = ter
        if onset > 0:
            parsed_data["downstream_aas"] = max(0, ter - onset)
        if plen > 0:
            parsed_data["protein_length"] = plen
        refresh_protein_extension_readout(parsed_data)
        return

    parsed_data["stop_lost_ter_unknown"] = True
    parsed_data["protein_extension"] = True
    parsed_data.pop("novel_stop_aa", None)
    parsed_data.pop("protein_product_length", None)
    parsed_data.pop("downstream_aas", None)
    try:
        stale = float(parsed_data.get("nmd_escape_truncation_fraction") or 0)
    except (TypeError, ValueError):
        stale = 0.0
    if stale < 0:
        parsed_data["nmd_escape_truncation_fraction"] = 0.0
    if onset > 0:
        parsed_data["protein_start"] = onset
    expl = stop_lost_unknown_explanation(
        onset, plen, str(parsed_data.get("nmd_decision_basis") or ""),
    )
    parsed_data["protein_extension_explanation"] = expl
    parsed_data["nmd_math"] = expl


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
    if parsed_data.get("met_reinitiation"):
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
