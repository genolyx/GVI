"""HGVS DNA/RNA notation parsing / allele-equality helpers.

Extracted from ``app_v11.py`` (Phase 3 of ``docs/ENGINE_SPLIT_PLAN.md``).
These are pure string helpers (only depend on ``re``) used by MyVariant matching,
ClinVar name parsing, and allele de-duplication throughout the engine.

Supports coding (``c.``), non-coding transcript (``n.``), and RNA (``r.``) HGVS.
"""
from __future__ import annotations

import re

_HGVS_DNA_PREFIXES = ("c.", "n.", "r.")
_HGVS_DNA_PREFIX_RE = re.compile(r"^[cnr]\.", re.I)


def _hgvs_dna_kind(c_dot) -> str:
    """Return ``c``, ``n``, ``r``, or ``\"\"`` for the leading DNA/RNA HGVS prefix."""
    s = (c_dot or "").strip().lower()
    for p in _HGVS_DNA_PREFIXES:
        if s.startswith(p):
            return p[0]
    return ""


def _is_noncoding_dna_hgvs(c_dot, transcript=None) -> bool:
    """True for ``n.``/``r.`` alleles or ``NR_`` RefSeq transcripts (snRNA / ncRNA)."""
    kind = _hgvs_dna_kind(c_dot)
    if kind in ("n", "r"):
        return True
    tx = (transcript or "").strip().upper()
    return tx.startswith("NR_")


def _normalize_dna_hgvs_prefix(c_dot) -> str:
    """Keep ``c.``/``n.``/``r.``; invent ``c.`` only for bare coding-style tails."""
    s = (c_dot or "").strip()
    if not s:
        return ""
    if _HGVS_DNA_PREFIX_RE.match(s):
        return s
    if re.match(r"^-?\d+", s) or (s[0] in "+-*"):
        return f"c.{s}"
    return s


def _strip_dna_hgvs_prefix(cc) -> str:
    """Lowercase allele tail with ``c.``/``n.``/``r.`` removed (MyVariant / equality)."""
    s = re.sub(r"\s+", "", (cc or "").lower())
    if _HGVS_DNA_PREFIX_RE.match(s):
        return s[2:]
    return s


def _myvariant_c_dot_tail_norm(cc):
    return _strip_dna_hgvs_prefix(cc)


def _vep_hgvs_query(transcript, c_dot, gene="") -> str:
    """Build Ensembl VEP HGVS path segment (``NM_/NR_/ENST:…`` or ``GENE:…``)."""
    cd = (c_dot or "").strip()
    if not cd:
        return ""
    tx = (transcript or "").strip()
    if "." in tx:
        tx = tx.split(".", 1)[0]
    tx_u = tx.upper()
    if tx_u.startswith(("NM_", "NR_", "ENST")):
        return f"{tx}:{cd}"
    g = (gene or "").strip()
    if g:
        return f"{g}:{cd}"
    return ""


def _c_dot_change_class(c_tail):
    s = _myvariant_c_dot_tail_norm(c_tail)
    if not s:
        return ""
    if "delins" in s or "del" in s and "ins" in s:
        return "indel"
    if re.search(r"[atgc]+\[\d+\]$", s):
        return "del"
    if s.endswith("del") or re.search(r"del[^a-z]", s):
        return "del"
    if "dup" in s:
        return "dup"
    if "ins" in s:
        return "ins"
    if re.search(r"^[atgcu]\>", s) or re.search(r"\>[atgcu]$", s):
        return "sub"
    if re.search(r"\>[atgcu]$", s) or re.search(r"[atgcu]\>", s):
        return "sub"
    return ""


def _parse_c_dot_allele(c_dot_or_tail):
    """
    Parse HGVS c. tail into (signed_position, change_token).
    c.382del -> (382, 'del'); c.-382del -> (-382, 'del').
    """
    s = _myvariant_c_dot_tail_norm(c_dot_or_tail)
    if not s:
        return None
    m = re.match(r'^(-?\d+(?:[+-]\d+)?)(.*)$', s, re.I)
    if not m:
        return None
    pos_part = m.group(1)
    change = (m.group(2) or '').lower()
    if re.fullmatch(r'-?\d+', pos_part):
        try:
            pos = int(pos_part)
        except ValueError:
            pos = pos_part.lower()
    else:
        pos = pos_part.lower()
    return (pos, change)


def _hgvs_c_dot_alleles_equal(want_raw, cand_raw):
    """
    Exact c. allele match — rejects substring traps (e.g. 382del matching c.-382del or c.38del).
    """
    w = _parse_c_dot_allele(want_raw)
    c = _parse_c_dot_allele(cand_raw)
    if not w or not c:
        return False
    return w == c


def _hgvs_c_dot_clinvar_equivalent(want_raw, cand_raw):
    """
    ClinVar often uses repeat bracket notation (c.461TCT[2]) for the same allele as
    HGVS range del (c.467_469del) on another transcript anchor.
    """
    if _hgvs_c_dot_alleles_equal(want_raw, cand_raw):
        return True
    wc = _myvariant_c_dot_tail_norm(want_raw)
    cc = _myvariant_c_dot_tail_norm(cand_raw)
    if not wc or not cc:
        return False
    m_w = re.match(r"^(\d+)_(\d+)(del|dup)$", wc)
    m_c = re.match(r"^(\d+)([atgc]+)\[(\d+)\]$", cc)
    if m_w and m_c and m_w.group(3) == "del":
        del_len = int(m_w.group(2)) - int(m_w.group(1)) + 1
        if del_len == len(m_c.group(2)):
            return True
    m_w2 = re.match(r"^(\d+)([atgc]+)\[(\d+)\]$", wc)
    m_c2 = re.match(r"^(\d+)_(\d+)del$", cc)
    if m_w2 and m_c2:
        del_len = int(m_c2.group(2)) - int(m_c2.group(1)) + 1
        if del_len == len(m_w2.group(2)):
            return True
    return False


def _clinvar_esearch_stem_terms(c_dot):
    """Extra ClinVar ESearch tokens when full HGVS (e.g. c.467_469del) returns no hits."""
    stems = []
    cd = str(c_dot or "").strip()
    for pref in ("c", "n", "r"):
        m = re.search(rf"{pref}\.(\d+)_(\d+)(?:del|dup|ins|delins)?", cd, re.I)
        if m:
            stems.append(f"{pref}.{m.group(1)}_{m.group(2)}")
        m2 = re.search(rf"{pref}\.(\d+)(?:del|dup|ins)(?:ins)?", cd, re.I)
        if m2:
            stems.append(f"{pref}.{m2.group(1)}")
    return stems


def _derive_inframe_hgvs_p_from_c_dot(c_dot, cds_seq=None):
    """Build p.XaaNdel from c.N_Mdel when VEP/MyVariant omit hgvsp (e.g. SLC16A2 c.467_469del)."""
    m = re.search(r"c\.(\d+)_(\d+)del", str(c_dot or ""), re.I)
    if not m:
        return ""
    try:
        cds_lo = int(m.group(1))
        cds_hi = int(m.group(2))
    except (TypeError, ValueError):
        return ""
    if cds_lo <= 0 or cds_hi < cds_lo:
        return ""
    del_nt = cds_hi - cds_lo + 1
    if del_nt % 3 != 0:
        return ""
    aa_lo = (cds_lo - 1) // 3 + 1
    aa_hi = aa_lo + (del_nt // 3) - 1
    aa3_lo = aa3_hi = "Xaa"
    seq = str(cds_seq or "").upper()
    if seq and cds_hi <= len(seq):
        try:
            from vc_engine.splice import _decode_cds_triplet
            _, aa3_lo = _decode_cds_triplet(seq[(aa_lo - 1) * 3:(aa_lo - 1) * 3 + 3])
            _, aa3_hi = _decode_cds_triplet(seq[(aa_hi - 1) * 3:(aa_hi - 1) * 3 + 3])
        except Exception:
            pass
    if aa_lo == aa_hi:
        return f"p.{aa3_lo}{aa_lo}del"
    return f"p.{aa3_lo}{aa_lo}_{aa3_hi}{aa_hi}del"


def _c_dot_requires_exact_allele_match(c_dot):
    """SNVs and indels at the same anchor are different alleles (e.g. c.4755+1G>A ≠ G>T)."""
    return _c_dot_change_class(_myvariant_c_dot_tail_norm(c_dot)) in (
        "dup", "del", "ins", "indel", "sub",
    )


def _is_same_cdna_allele(user_c_dot, candidate_c_dot, user_c_anchor=None):
    """
    True when candidate is the same cDNA allele as the user's — not merely the same exon anchor.
    Range dups (c.1614-16_1622dup vs c.1614-6_1628dup) require full HGVS equality.
    """
    if not user_c_dot or not candidate_c_dot:
        return False
    if _c_dot_requires_exact_allele_match(user_c_dot):
        return _hgvs_c_dot_alleles_equal(user_c_dot, candidate_c_dot)
    if _hgvs_c_dot_alleles_equal(user_c_dot, candidate_c_dot):
        return True
    if user_c_anchor is None:
        m = re.search(r"c\.([0-9]+)", user_c_dot)
        user_c_anchor = m.group(1) if m else None
    if not user_c_anchor:
        return False
    m_match = re.search(r"c\.([0-9]+)", candidate_c_dot)
    if not m_match or m_match.group(1) != user_c_anchor:
        return False
    return not re.search(rf"c\.{re.escape(user_c_anchor)}_", candidate_c_dot)


def _is_colocalized_cdna_alternate(user_c_dot, candidate_c_dot, user_c_anchor=None):
    """
    True when candidate is a different ClinVar allele at the same c. coordinate
    (e.g. c.904G>T vs c.904G>A). Not the same as _is_same_cdna_allele (identity).
    """
    if not user_c_dot or not candidate_c_dot or "c." not in candidate_c_dot:
        return False
    if _hgvs_c_dot_alleles_equal(user_c_dot, candidate_c_dot):
        return False
    u_tail = _myvariant_c_dot_tail_norm(user_c_dot)
    c_tail = _myvariant_c_dot_tail_norm(candidate_c_dot)
    if _c_dot_change_class(u_tail) == "sub" and _c_dot_change_class(c_tail) == "sub":
        if user_c_anchor is None:
            m = re.search(r"c\.([0-9]+)", user_c_dot)
            user_c_anchor = m.group(1) if m else None
        m_match = re.search(r"c\.([0-9]+)", candidate_c_dot)
        return bool(
            user_c_anchor
            and m_match
            and m_match.group(1) == user_c_anchor
        )
    if _c_dot_requires_exact_allele_match(user_c_dot):
        return False
    if user_c_anchor is None:
        m = re.search(r"c\.([0-9]+)", user_c_dot)
        user_c_anchor = m.group(1) if m else None
    if not user_c_anchor:
        return False
    m_match = re.search(r"c\.([0-9]+)", candidate_c_dot)
    if not m_match or m_match.group(1) != user_c_anchor:
        return False
    return not re.search(rf"c\.{re.escape(user_c_anchor)}_", candidate_c_dot)


def _refseq_base_match(hgvs_left, refseq_base):
    """True when HGVS left side names the requested RefSeq (version suffix optional)."""
    if not refseq_base or not hgvs_left:
        return False
    nm = str(refseq_base).upper().split('.')[0]
    left = str(hgvs_left).upper()
    if nm not in left:
        return False
    m = re.search(r'(N[MR]_\d+)', left)
    if not m:
        return False
    return m.group(1) == nm


# --- Amino-acid lookup tables + missense p. parser (shared with literature) ---

_AA_ONE_TO_THREE = {
    'A':'Ala','R':'Arg','N':'Asn','D':'Asp','C':'Cys','Q':'Gln','E':'Glu','G':'Gly',
    'H':'His','I':'Ile','L':'Leu','K':'Lys','M':'Met','F':'Phe','P':'Pro','S':'Ser',
    'T':'Thr','W':'Trp','Y':'Tyr','V':'Val','*':'Ter','X':'Xaa',
}

_AA_THREE_TO_ONE = {v: k for k, v in _AA_ONE_TO_THREE.items() if len(k) == 1}

def _parse_missense_substitution_hgvs_p(hgvs_p):
    """
    Parse simple missense HGVS protein strings (1- or 3-letter).
    Returns {pos, ref_1, alt_1, ref_3, alt_3} or None.
    """
    if not hgvs_p:
        return None
    s = str(hgvs_p).strip()
    if ":" in s:
        s = s.split(":")[-1].strip()
    if not s.lower().startswith("p."):
        return None
    core = s[2:]
    m3 = re.match(r"^([A-Z][a-z]{2})(\d+)([A-Z][a-z]{2})$", core)
    if m3:
        ref3, pos, alt3 = m3.group(1), int(m3.group(2)), m3.group(3)
        ref1 = _AA_THREE_TO_ONE.get(ref3, ref3[0] if ref3 else "X")
        alt1 = _AA_THREE_TO_ONE.get(alt3, alt3[0] if alt3 else "X")
        return {"pos": pos, "ref_1": ref1, "alt_1": alt1, "ref_3": ref3, "alt_3": alt3}
    m1 = re.match(r"^([A-Z*])(\d+)([A-Z*])$", core)
    if m1:
        ref1, pos, alt1 = m1.group(1), int(m1.group(2)), m1.group(3)
        ref3 = _AA_ONE_TO_THREE.get(ref1, ref1)
        alt3 = _AA_ONE_TO_THREE.get(alt1, alt1)
        return {"pos": pos, "ref_1": ref1, "alt_1": alt1, "ref_3": ref3, "alt_3": alt3}
    return None


def _protein_position_from_hgvs_label(label):
    """First protein residue number parsed from a ClinVar-style c./p. label."""
    s = str(label or '')
    if not s:
        return None
    patterns = (
        r'p\.(?:[A-Za-z]{3}|[A-Z*])(\d+)',
        r'p\.\(\*?(\d+)',
        r'p\.\([A-Za-z]{3}(\d+)',
        r'p\.\([A-Za-z]{3}(\d+)(?:Ter|fs|\*)',
    )
    for pat in patterns:
        m = re.search(pat, s)
        if m:
            try:
                return int(m.group(1))
            except (TypeError, ValueError):
                continue
    return None


_AA_THREE_TO_FULL = {
    'Ala': 'alanine', 'Arg': 'arginine', 'Asn': 'asparagine', 'Asp': 'aspartate',
    'Cys': 'cysteine', 'Gln': 'glutamine', 'Glu': 'glutamate', 'Gly': 'glycine',
    'His': 'histidine', 'Ile': 'isoleucine', 'Leu': 'leucine', 'Lys': 'lysine',
    'Met': 'methionine', 'Phe': 'phenylalanine', 'Pro': 'proline', 'Ser': 'serine',
    'Thr': 'threonine', 'Trp': 'tryptophan', 'Tyr': 'tyrosine', 'Val': 'valine',
}
