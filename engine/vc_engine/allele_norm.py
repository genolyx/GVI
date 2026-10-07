"""Left-align an indel onto the forward reference, in VCF form.

ClinVar stores every allele on the forward strand with an anchor base.
A c. deletion can arrive as coding-strand bases, a dash, or a right-shifted
repeat. This rewrites that allele to the same chrom/pos/ref/alt ClinVar uses.
A single-base change is left untouched.
"""

from __future__ import annotations

import os
from typing import Callable, Optional

BaseAt = Callable[[int], Optional[str]]

_MISSING = {"", "-", "."}
_BASES = set("ACGTN")
_COMP = str.maketrans("ACGTN", "TGCAN")


def _revcomp(sequence: str) -> str:
    return sequence.translate(_COMP)[::-1]


def _matches(position: int, sequence: str, base_at: BaseAt) -> bool:
    if not sequence:
        return True
    bases = []
    for offset in range(len(sequence)):
        base = base_at(position + offset)
        if not base:
            return False
        bases.append(base)
    return "".join(bases) == sequence


def _clean(value) -> Optional[str]:
    text = str(value or "").strip().upper()
    if text in _MISSING:
        return ""
    if any(base not in _BASES for base in text):
        return None
    return text


def align_forward_indel(
    position: int, ref: str, alt: str, base_at: BaseAt
) -> Optional[tuple[int, str, str]]:
    """Return the left-aligned forward allele, or None when it cannot be proven."""
    try:
        pos = int(position)
    except (TypeError, ValueError):
        return None
    ref_s = _clean(ref)
    alt_s = _clean(alt)
    if ref_s is None or alt_s is None or pos < 1:
        return None
    if not ref_s and not alt_s:
        return None
    if ref_s and alt_s and len(ref_s) == len(alt_s):
        return None

    if ref_s and not _matches(pos, ref_s, base_at):
        flipped_ref = _revcomp(ref_s)
        flipped_alt = _revcomp(alt_s) if alt_s else ""
        if not _matches(pos, flipped_ref, base_at):
            return None
        ref_s, alt_s = flipped_ref, flipped_alt

    while ref_s and alt_s and ref_s[-1] == alt_s[-1]:
        ref_s = ref_s[:-1]
        alt_s = alt_s[:-1]
    while ref_s and alt_s and ref_s[0] == alt_s[0]:
        ref_s = ref_s[1:]
        alt_s = alt_s[1:]
        pos += 1
    if not ref_s or not alt_s:
        if pos <= 1:
            return None
        pos -= 1
        anchor = base_at(pos)
        if not anchor:
            return None
        ref_s = anchor + ref_s
        alt_s = anchor + alt_s

    steps = 0
    while pos > 1 and ref_s and alt_s and ref_s[-1] == alt_s[-1]:
        steps += 1
        if steps > 10000:
            return None
        pos -= 1
        anchor = base_at(pos)
        if not anchor:
            return None
        ref_s = anchor + ref_s
        alt_s = anchor + alt_s
        while ref_s and alt_s and ref_s[-1] == alt_s[-1]:
            ref_s = ref_s[:-1]
            alt_s = alt_s[:-1]
    if not ref_s or not alt_s or not _matches(pos, ref_s, base_at):
        return None
    return pos, ref_s, alt_s


def reference_fasta_path() -> str:
    override = (os.environ.get("VC_REFERENCE_FASTA") or "").strip()
    if override:
        return os.path.expanduser(override)
    root = (os.environ.get("GX_EXOME_DATA_DIR") or "/home/ken/gx-exome").strip()
    return os.path.join(os.path.expanduser(root), "data", "refs", "GRCh38.fasta")


_fasta = None
_fasta_missing = False


def _open_fasta():
    global _fasta, _fasta_missing
    if _fasta_missing:
        return None
    if _fasta is not None:
        return _fasta
    path = reference_fasta_path()
    if not path or not os.path.exists(path):
        _fasta_missing = True
        return None
    try:
        import pysam

        _fasta = pysam.FastaFile(path)
    except Exception as exc:
        print(f"[allele-norm] reference FASTA unavailable: {exc}")
        _fasta_missing = True
        return None
    return _fasta


def _contig_name(fasta, chrom: str) -> Optional[str]:
    bare = str(chrom or "").strip()
    if bare.lower().startswith("chr"):
        bare = bare[3:]
    if bare.upper() == "MT":
        bare = "M"
    names = {str(name) for name in fasta.references}
    for candidate in (f"chr{bare}", bare, f"chr{bare.upper()}", bare.upper()):
        if candidate in names:
            return candidate
    return None


def align_query_allele(chrom, position, ref, alt) -> tuple:
    """Aligned allele when the reference can prove it; otherwise the input allele."""
    try:
        pos = int(position)
    except (TypeError, ValueError):
        return position, ref, alt
    fasta = _open_fasta()
    if fasta is None:
        return position, ref, alt
    contig = _contig_name(fasta, chrom)
    if contig is None:
        return position, ref, alt

    def base_at(site: int) -> Optional[str]:
        if site < 1:
            return None
        try:
            base = fasta.fetch(contig, site - 1, site)
        except Exception:
            return None
        if not base:
            return None
        return base.upper()

    aligned = align_forward_indel(pos, ref, alt, base_at)
    if aligned is None:
        return position, ref, alt
    return aligned
