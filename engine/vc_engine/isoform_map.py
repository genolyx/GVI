"""RefSeq isoform numbering for one genomic allele.

``cds_delta`` / ``aa_delta`` are alternate-minus-curated. They label a neighbor
under the other transcript. They are not a second residue to search as if it
were the curated amino acid.
"""
from __future__ import annotations

import re
from typing import Any, Mapping, Optional

from vc_engine.hgvs import (
    _parse_c_dot_allele,
    _parse_missense_substitution_hgvs_p,
    _protein_position_from_hgvs_label,
)


def transcript_base(transcript: str) -> str:
    tx = str(transcript or "").strip().replace(" ", "")
    if "." in tx:
        tx = tx.split(".", 1)[0]
    return tx.upper()


def coding_anchor(cdot: str) -> Optional[int]:
    """Plain coding c. position, or None for intronic / unparsed tails."""
    parsed = _parse_c_dot_allele(cdot)
    if not parsed or not isinstance(parsed[0], int):
        return None
    return parsed[0]


def protein_anchor(hgvs_p: str) -> Optional[int]:
    sub = _parse_missense_substitution_hgvs_p(hgvs_p)
    if sub:
        return int(sub["pos"])
    pos = _protein_position_from_hgvs_label(hgvs_p)
    return int(pos) if isinstance(pos, int) and pos > 0 else None


def _shift_cdot(hgvs_c: str, delta: int) -> str:
    parsed = _parse_c_dot_allele(hgvs_c)
    if not parsed or not isinstance(parsed[0], int):
        return ""
    shown = str(hgvs_c or "").strip()
    if shown and not re.match(r"^[cnr]\.", shown, re.I):
        shown = f"c.{shown}"
    return re.sub(r"-?\d+", str(parsed[0] + int(delta)), shown, count=1)


def _shift_protein(hgvs_p: str, delta: int) -> str:
    sub = _parse_missense_substitution_hgvs_p(hgvs_p)
    if not sub:
        return ""
    return f"p.{sub['ref_3']}{int(sub['pos']) + int(delta)}{sub['alt_3']}"


def build_refseq_isoform_maps(
    synonyms: list,
    curated_refseq: str,
    curated_c: str,
    curated_p: str,
) -> list:
    """One map per other NM/NR numbering of this allele."""
    user_base = transcript_base(curated_refseq)
    user_c_pos = coding_anchor(curated_c)
    user_aa = protein_anchor(curated_p)
    maps = []
    seen = set()
    for pair in synonyms or []:
        if not isinstance(pair, dict):
            continue
        refseq = str(pair.get("refseq") or "").strip()
        base = transcript_base(refseq)
        if not base or (user_base and base == user_base):
            continue
        alt_c = str(pair.get("hgvs_c") or "").strip()
        alt_p = str(pair.get("hgvs_p") or "").strip()
        full = str(pair.get("full") or "").strip() or (f"{refseq}:{alt_c}" if refseq and alt_c else "")
        key = full or f"{base}:{alt_c}"
        if key in seen:
            continue
        seen.add(key)
        alt_c_pos = coding_anchor(alt_c)
        alt_aa = protein_anchor(alt_p)
        cds_delta = None
        aa_delta = None
        if user_c_pos is not None and alt_c_pos is not None:
            cds_delta = alt_c_pos - user_c_pos
        if user_aa is not None and alt_aa is not None:
            aa_delta = alt_aa - user_aa
        elif cds_delta is not None and cds_delta % 3 == 0:
            aa_delta = cds_delta // 3
        maps.append({
            "refseq": refseq,
            "hgvs_c": alt_c,
            "hgvs_p": alt_p,
            "full": full,
            "cds_delta": cds_delta,
            "aa_delta": aa_delta,
        })
    return maps


def same_residue_on_curated_frame(
    entry: Mapping[str, Any],
    curated_aa: Optional[int],
    curated_c_pos: Optional[int],
    maps: list,
) -> bool:
    """Keep a same-residue neighbor only on the curated codon.

    (a) its protein position is the curated residue, or
    (b) its c. position shifts by an isoform ``cds_delta`` onto the curated codon.
    A hit that only shares the remapped number (211 when curated is 241) is rejected.
    """
    positions = []
    for raw in entry.get("positions") or []:
        try:
            positions.append(int(raw))
        except (TypeError, ValueError):
            continue
    if curated_aa is not None and curated_aa in positions:
        return True
    anchor = entry.get("anchor")
    if not isinstance(anchor, int) or curated_c_pos is None:
        return False
    for item in maps or []:
        delta = item.get("cds_delta")
        if not isinstance(delta, int):
            continue
        if anchor - delta == curated_c_pos:
            return True
    return False


def alias_clause(
    hgvs_c: str,
    hgvs_p: str,
    anchor: Optional[int],
    curated_refseq: str,
    curated_c_pos: Optional[int],
    maps: list,
) -> str:
    """Compact ``also NM_…:c.… / p.…`` when a neighbor remaps across isoforms."""
    bits = []
    seen = set()
    for item in maps or []:
        delta = item.get("cds_delta")
        if not isinstance(delta, int) or not isinstance(anchor, int) or curated_c_pos is None:
            continue
        aa_delta = item.get("aa_delta")
        if anchor == curated_c_pos:
            alt_c = _shift_cdot(hgvs_c, delta)
            refseq = str(item.get("refseq") or "").strip()
            label = f"{refseq}:{alt_c}" if refseq and alt_c else alt_c
            if isinstance(aa_delta, int):
                alt_p = _shift_protein(hgvs_p, aa_delta)
                if alt_p:
                    label = f"{label} / {alt_p}" if label else alt_p
        elif anchor - delta == curated_c_pos:
            cur_c = _shift_cdot(hgvs_c, -delta)
            refseq = str(curated_refseq or "").strip()
            label = f"{refseq}:{cur_c}" if refseq and cur_c else cur_c
            if isinstance(aa_delta, int):
                cur_p = _shift_protein(hgvs_p, -aa_delta)
                if cur_p:
                    label = f"{label} / {cur_p}" if label else cur_p
        else:
            continue
        if label and label not in seen:
            seen.add(label)
            bits.append(label)
    if not bits:
        return ""
    return "also " + "; ".join(bits)


def browser_links(chrom: str, start) -> dict:
    """GRCh38 browser links so a curator can confirm isoforms share the base."""
    try:
        pos = int(start)
    except (TypeError, ValueError):
        return {}
    if pos <= 0:
        return {}
    raw = str(chrom or "").strip()
    if not raw:
        return {}
    if not raw.lower().startswith("chr"):
        raw = "chr" + raw
    bare = raw[3:] if raw.lower().startswith("chr") else raw
    return {
        "ucsc": f"https://genome.ucsc.edu/cgi-bin/hgTracks?db=hg38&position={raw}:{pos}-{pos}",
        "ensembl": f"https://www.ensembl.org/Homo_sapiens/Location/View?r={bare}:{pos}-{pos}",
        "ncbi": f"https://www.ncbi.nlm.nih.gov/genome/gdv/browser/?q={raw}:{pos}",
    }


def also_reported_line(maps: list) -> str:
    bits = []
    for item in maps or []:
        full = str(item.get("full") or "").strip()
        if not full:
            refseq = str(item.get("refseq") or "").strip()
            hgvs_c = str(item.get("hgvs_c") or "").strip()
            full = f"{refseq}:{hgvs_c}" if refseq and hgvs_c else ""
        if not full:
            continue
        hgvs_p = str(item.get("hgvs_p") or "").strip()
        bits.append(f"{full} ({hgvs_p})" if hgvs_p else full)
    if not bits:
        return ""
    return (
        "Also reported as (alternate transcript numbering — search papers with these): "
        + "; ".join(bits)
    )
