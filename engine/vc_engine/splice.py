"""Splice / SpliceAI / junction / NMD / cryptic-splice subsystem.

Extracted from ``app_v11.py`` (Phase 4 of ``docs/ENGINE_SPLIT_PLAN.md``): the
cohesive ~10k-line splice cluster that ``analyze_variant`` leans on -- cryptic
splice outcome resolution, junction-alignment / pseudoexon viz, exon-skip +
PTC/NMD reasoning, codon decoding, and the SpliceAI Delta-bp narration policy.

No engine globals are baked in except ``http_session`` (the shared
EnsemblCurlSession), injected by the app_v11 mount as a module attribute
(``vc_engine.splice.http_session = http_session``) before any request runs.
"""
from __future__ import annotations

import os
import re
import json
import html

from flask import render_template

from vc_engine.hgvs import _AA_ONE_TO_THREE, _hgvs_c_dot_alleles_equal, _parse_missense_substitution_hgvs_p
from vc_engine.spliceai import _parse_spliceai_dp
from vc_engine.clinvar import clinvar_portal_url
from vc_engine.regions import (
    _deleted_exon_analysis_evidence_html,
    _downstream_plp_hits_markup,
    _finalize_plp_region_links,
    _skipped_exon_plp_hits_markup,
    _skipped_exon_plp_scan_banner_html,
    _skipped_exon_region_context_html,
    _upstream_plp_hits_markup,
)
from vc_engine.truncation import (
    c_terminal_loss_fraction,
    is_marginal_loss,
    is_severe_loss,
    is_start_loss_reinit_viable,
    resolved_ptc_stop_aa,
    truncation_pct_display,
)

# Injected by the app_v11 mount (shared EnsemblCurlSession), used by
# _ensure_coding_exons_for_splice_viz for Ensembl REST lookups.
http_session = None


def _logic_lines_block(*parts):
    lines = []
    for p in parts:
        if p is None:
            continue
        s = str(p).strip().rstrip('.')
        if s:
            lines.append(s)
    return '<br>'.join(lines) + ('.' if lines else '')


def _nmd_math_narrative_only(nmd_math):
    """Strip ClinVar/HGMD PLP catalogues appended to nmd_math (shown under Clinical context)."""
    s = str(nmd_math or '').strip()
    if not s:
        return ''
    s = re.sub(
        r'<br\s*/?\s*><br\s*/?\s*><span[^>]*>\s*ClinVar P/LP.*',
        '',
        s,
        flags=re.I | re.DOTALL,
    )
    s = re.sub(
        r'ClinVar P/LP(?: and HGMD catalogue)? variants.*',
        '',
        s,
        flags=re.I | re.DOTALL,
    )
    return s.strip().rstrip(';, ')


def _append_splice_product_logic_sections(sections, parsed_data, include_deep_intronic=True):
    """
    Append splice product blocks to logic explanation.
    Deep-intronic variants: concise summary here; full coordinates/ORF math in splice products panel.
    """
    _di_products = bool(parsed_data.get('deep_intronic_splice_products_active'))
    if _di_products:
        if include_deep_intronic:
            _append_deep_intronic_splice_logic_sections(sections, parsed_data)
        return

    parts = []
    mech = (parsed_data.get('deep_intronic_mechanism_html') or '').strip()
    if mech and _di_products:
        parts.append(f"<b>Deep intronic context:</b> {mech}")

    _cry = parsed_data.get('cryptic_splice_narrative')
    _sfm = (parsed_data.get('splice_frame_math') or '').strip()
    _jp = bool(parsed_data.get('spliceai_junction_model_preferred'))
    _comp = bool(parsed_data.get('spliceai_competing_splice_isoforms'))
    _sfm_has_gain = _splice_frame_math_has_product_summaries(_sfm)
    _suppress_cry = _di_products or (_sfm_has_gain and (_jp or _comp))

    if _cry and not _suppress_cry and not _sfm_has_gain:
        parts.append(f"<b>Cryptic narrative:</b> {_cry}")

    if _sfm and not _di_products:
        parts.append(_strip_html_trailing_breaks(_sfm))

    _sec_gain_html = _format_secondary_cryptic_gain_logic_html(parsed_data)
    if _sec_gain_html and not _di_products:
        parts.append(_sec_gain_html)
    _sfm2_sec = parsed_data.get('spliceai_secondary_splice_frame_math')
    if _sfm2_sec and not _di_products:
        parts.append(
            f"<b>Product (parallel whole-exon skip — second splice-site hypothesis):</b><br>"
            f"{_strip_html_trailing_breaks(_sfm2_sec)}"
        )

    if parts:
        sections.append(('Splice products', '<br><br>'.join(parts)))


def _append_truncation_nmd_sections(
    sections, parsed_data, effective_gene, csq, is_trunc, is_start_loss, is_nmd_escape, trunc_frac,
):
    lines = []
    p_len = parsed_data.get('protein_length', '?')
    nmd_math = _nmd_math_narrative_only(parsed_data.get('nmd_math') or '')
    nmd_basis = (parsed_data.get('nmd_decision_basis') or '').strip()
    if nmd_math:
        plain = _logic_section_text_plain(nmd_math) if '<' in nmd_math else nmd_math
        for chunk in re.split(r'(?:<br\s*/?\s*|\n)+', plain, flags=re.I):
            for sent in re.split(r'(?<=[.;])\s+', chunk):
                s = sent.strip()
                if s:
                    lines.append(s)
    elif nmd_basis and is_trunc and not is_start_loss:
        # Show the actual structural basis (PTC exon + distance to the final exon-exon
        # junction), not a fraction-of-protein heuristic, since the 50-55 nt junction
        # rule — not the truncated percentage — determines NMD.
        lines.append(nmd_basis)
        if not is_nmd_escape and trunc_frac and trunc_frac > 0:
            math_line = _truncation_math_line_for_logic(parsed_data, p_len, trunc_frac)
            if math_line:
                lines.append(math_line)
    elif (
        not is_nmd_escape
        and not is_start_loss
        and is_trunc
        and parsed_data.get('variant_exon') != 1
        and parsed_data.get('variant_exon') not in (
            parsed_data.get('nmd_exon_total'), parsed_data.get('snpeff_exon_total'),
        )
    ):
        if trunc_frac and trunc_frac > 0:
            math_line = _truncation_math_line_for_logic(parsed_data, p_len, trunc_frac)
            if math_line:
                lines.append(f"NMD predicted — {math_line}")
        else:
            lines.append("NMD predicted — premature stop triggers transcript decay.")

    if trunc_frac and trunc_frac > 0:
        pct = round(trunc_frac * 100, 1)
        if is_start_loss:
            # nmd_math already narrates next-Met / N-terminal % — avoid a second
            # (and historically wrong C-term) percentage line.
            if not nmd_math:
                next_met = parsed_data.get('next_methionine_position', '?')
                if is_start_loss_reinit_viable(trunc_frac):
                    lines.append(
                        f"N-terminal loss: {pct}% of protein; next Met at aa {next_met} "
                        f"(&lt;10% start-loss / re-initiation pathway)."
                    )
                else:
                    lines.append(
                        f"N-terminal loss: {pct}% of protein; next Met at aa {next_met} "
                        f"(≥10% — severe N-terminal truncation)."
                    )
        elif is_nmd_escape:
            t_m = _format_truncation_coord_for_logic(parsed_data, p_len, trunc_frac)
            if is_marginal_loss(trunc_frac):
                lines.append(f"NMD escape: {pct}% C-terminal lost ({t_m}).")
                lines.append(
                    "<10% truncation — requires evidence the lost C-terminal region is clinically critical."
                )
            elif is_severe_loss(trunc_frac):
                lines.append(f"NMD escape: {pct}% C-terminal lost ({t_m}).")
                lines.append(
                    f"≥10% C-terminal truncation ({pct}% of {p_len}-aa protein) — severe loss "
                    "despite NMD escape (PVS1 pathway)."
                )

    lcr = parsed_data.get('nmd_last_coding_exon_rank')
    tot = parsed_data.get('nmd_exon_total')
    trail = parsed_data.get('nmd_trailing_mrna_exons_after_cds') or 0
    if lcr and tot and trail > 0:
        if trail == 1:
            lines.append(f"ORF ends in coding exon {lcr}; exon {tot} is 3′-UTR only.")
        else:
            lines.append(f"ORF ends in coding exon {lcr}; exons {int(lcr) + 1}–{tot} are 3′-UTR.")

    if lines:
        sections.append(("Truncation & NMD", _logic_lines_block(*lines)))


def _append_nmd_escape_clinical_context(
    sections, parsed_data, trunc_frac, is_start_loss, is_trunc,
):
    from vc_engine.regions import _downstream_plp_anchor_aa, _needs_downstream_clinvar_plp

    if (
        is_trunc
        and parsed_data.get('nmd_escape')
        and _needs_downstream_clinvar_plp(parsed_data)
    ):
        anchor = _downstream_plp_anchor_aa(parsed_data)
        pct = round(trunc_frac * 100, 1) if trunc_frac and trunc_frac > 0 else None
        if parsed_data.get('auto_downstream_pathogenic'):
            pct_s = f" ({pct}% C-terminal loss)" if pct is not None else ""
            body = f"ClinVar: P/LP variant(s) downstream of the novel PTC (aa {anchor}){pct_s}."
            ext_d = _downstream_plp_hits_markup(parsed_data)
            if ext_d:
                body += ext_d
            sections.append(("Clinical context", body))
            return
        if parsed_data.get('downstream_plp_scan_performed') and anchor > 0:
            pct_line = (
                f"{pct}% C-terminal lost; evaluate whether the truncated segment is clinically critical."
                if pct is not None else
                "Evaluate whether the truncated C-terminal segment is clinically critical."
            )
            search_link = (parsed_data.get('downstream_pathogenic_clinvar_search_link') or '').strip()
            link_html = ""
            if search_link:
                link_html = (
                    f' <a href="{search_link}" target="_blank" rel="noopener noreferrer" '
                    f'style="color:#fbbf24;text-decoration:underline;">ClinVar P/LP catalogue</a>'
                )
            sections.append((
                "Clinical context",
                _logic_lines_block(
                    f"No ClinVar P/LP variants downstream of the novel PTC (protein position &gt; {anchor}) "
                    "among gene P/LP entries scanned.",
                    pct_line,
                ) + link_html,
            ))
            return

    if not (
        trunc_frac > 0
        and is_marginal_loss(trunc_frac)
        and is_start_loss
    ):
        return
    pct = round(trunc_frac * 100, 1)
    if parsed_data.get('auto_downstream_pathogenic'):
        body = f"ClinVar: P/LP variant(s) downstream of stop ({pct}% N-terminal loss)."
        ext_d = _downstream_plp_hits_markup(parsed_data)
        if ext_d:
            body += ext_d
        sections.append(("Clinical context", body))
        return
    if parsed_data.get('auto_upstream_pathogenic'):
        body = f"ClinVar: P/LP variant(s) upstream of re-init boundary ({pct}% N-terminal loss)."
        try:
            nm_int = int(parsed_data.get("next_methionine_position"))
        except (TypeError, ValueError):
            nm_int = 0
        ext = _upstream_plp_hits_markup(parsed_data, nm_int if nm_int > 0 else None)
        if ext:
            body += ext
        sections.append(("Clinical context", body))
        return
    if parsed_data.get('has_critical_domain'):
        sections.append((
            "Clinical context",
            _logic_lines_block(
                f"No P/LP in {pct}% lost segment.",
                f"UniProt overlap: {parsed_data.get('critical_domain_names')}.",
            ),
        ))
    elif parsed_data.get('uniprot_domain_checked') and not parsed_data.get('has_critical_domain'):
        sections.append((
            "Clinical context",
            _logic_lines_block(
                f"No P/LP in {pct}% lost segment.",
                "UniProt: no domain of interest.",
                "May be benign without further evidence.",
            ),
        ))
    else:
        sections.append((
            "Clinical context",
            f"No P/LP variants in the {pct}% lost segment.",
        ))


def _append_splice_support_sections(sections, parsed_data, effective_gene, skip_deleted_exon=False):
    if not skip_deleted_exon and 'splice_deleted_coords' in parsed_data and parsed_data.get('skipped_exon_plp_checked'):
        if parsed_data.get('has_pathogenic_in_deleted_exon'):
            _dex_ev = _skipped_exon_plp_hits_markup(parsed_data)
            _region = 'excised region' if parsed_data.get('splice_excised_partial') else 'skipped exon'
            sections.append((
                "Clinical context",
                f"P/LP variant(s) inside the {_region} (local ClinVar)"
                + (_dex_ev or "."),
            ))
        else:
            _ctx = _skipped_exon_region_context_html(parsed_data)
            _region = 'excised region' if parsed_data.get('splice_excised_partial') else 'skipped exon'
            sections.append((
                "Clinical context",
                f"No P/LP variants inside the {_region} interval (local ClinVar)."
                + (f"<br>{_ctx}" if _ctx else ""),
            ))
    if parsed_data.get('auto_downstream_pathogenic'):
        dc_body = "P/LP truncating variant downstream supports LOF at this locus."
        ext_dc = _downstream_plp_hits_markup(parsed_data)
        if ext_dc and not parsed_data.get("_downstream_plp_list_in_nmd_structure"):
            dc_body += ext_dc
        sections.append(("Clinical context", dc_body))


def _dna_revcomp(s):
    tbl = str.maketrans('ACGTNacgtn', 'TGCANtgcan')
    return str(s).translate(tbl)[::-1]


def _hgvs_coding_anchor_nt(c_dot):
    """1-based c. anchor for exonic HGVS without intronic ±offset (c.477dup → 477)."""
    cd = str(c_dot or '').strip()
    if cd and not cd.lower().startswith('c.'):
        cd = f'c.{cd}'
    if re.search(r'c\.\d+[\+\-]', cd, re.I):
        return None
    m = re.search(r'c\.(\d+)', cd, re.I)
    if not m:
        return None
    try:
        return int(m.group(1))
    except (TypeError, ValueError):
        return None


def _hgvs_is_coding_exon_body(c_dot):
    """True for c.N dup/del/ins (and ranges) in the CDS body, not c.N±k intronic HGVS."""
    anchor = _hgvs_coding_anchor_nt(c_dot)
    if anchor is None:
        return False
    cd = str(c_dot or '').lower()
    return bool(
        re.search(r'(?:dup|del|ins|delins)\b', cd)
        or re.search(r'c\.\d+_\d+', cd)
    )


def _first_coding_mrna_exon_rank(coding_exons):
    """mRNA exon rank of the first CDS-overlap exon (may be exon 2 when exon 1 is 5′ UTR)."""
    first = _deep_intronic_first_coding_exon(coding_exons)
    if not first:
        return None
    try:
        rank = int(first.get('anatomical_rank') or 0)
    except (TypeError, ValueError):
        return None
    return rank if rank > 0 else None


def _variant_in_first_coding_mrna_exon(parsed_data):
    rank = parsed_data.get('variant_exon') or parsed_data.get('snpeff_exon_rank')
    first_rank = _first_coding_mrna_exon_rank((parsed_data or {}).get('coding_exons') or [])
    if rank is None or first_rank is None:
        return False
    try:
        return int(rank) == int(first_rank)
    except (TypeError, ValueError):
        return False


def _met_reinitiation_applies(parsed_data, *, current_cons, current_rank, is_first_exon):
    """
    Next-Met / 5′ re-initiation applies only when the primary start codon is abolished
    (start_lost). Early nonsense/frameshift in exon 1 does not qualify (e.g. FLG c.477dup).
    """
    return current_cons == 'start_lost'


def _deep_intronic_should_run(consequence, c_dot):
    csq = (consequence or '').lower()
    # Canonical ±k junction variants (e.g. c.4206+1dup) are not deep-intronic body variants.
    if c_dot and _canonical_splice_junction_from_hgvs(c_dot):
        return False
    # Exonic c.N dup/del/ins (no intronic ±offset) — e.g. FLG c.477dup in coding exon 3.
    if c_dot and _hgvs_is_coding_exon_body(c_dot):
        return False
    if 'intron_variant' in csq:
        return True
    if c_dot and re.search(r'c\.-?\d+[\+\-]\d+', c_dot):
        return True
    return False


def _defer_whole_exon_skip_to_deep_intronic(consequence, c_dot):
    """
    True for deep intron-body variants (e.g. c.930+189) where whole-exon skip on the
    anchor exon is misleading — SpliceAI pseudo-exon products should lead instead.
    """
    if not _deep_intronic_should_run(consequence, c_dot):
        return False
    plus_off = _deep_intronic_hgvs_plus_offset(c_dot)
    minus_off = _deep_intronic_hgvs_minus_offset(c_dot)
    off = plus_off if plus_off is not None else minus_off
    if off is None:
        return False
    try:
        return int(off) >= 25
    except (TypeError, ValueError):
        return False


def _set_spliceai_narrative_sentence(parsed_data):
    """Plain-language sentence when SpliceAI was successfully queried (computational only)."""
    parsed_data['spliceai_narrative'] = ''
    if not parsed_data.get('spliceai_fetched'):
        return
    if parsed_data.get('splice_api_error'):
        return
    csq = (parsed_data.get('consequence') or '').lower()
    if not (
        _canonical_splice_junction_from_hgvs(parsed_data.get('c_dot'))
        or 'splice' in csq
        or csq == 'intron_variant'
        or (parsed_data.get('deep_intronic_splice') or {}).get('eligible')
    ):
        return
    try:
        ag = float(parsed_data.get('spliceai_ds_ag') or 0)
        al = float(parsed_data.get('spliceai_ds_al') or 0)
        dg = float(parsed_data.get('spliceai_ds_dg') or 0)
        dl = float(parsed_data.get('spliceai_ds_dl') or 0)
    except (TypeError, ValueError):
        return
    all_slots = [
        (ag, parsed_data.get('spliceai_dp_ag'), 'acceptor gain'),
        (al, parsed_data.get('spliceai_dp_al'), 'acceptor loss'),
        (dg, parsed_data.get('spliceai_dp_dg'), 'donor gain'),
        (dl, parsed_data.get('spliceai_dp_dl'), 'donor loss'),
    ]

    def dp_clause(dp):
        if dp is None or dp == '':
            return ''
        return f", with the strongest offset for that term at approximately {dp} bp from the variant (per SpliceAI)"

    def fmt_side_term(sc, dp, lbl):
        if sc < 0.15:
            return ''
        bit = f"{lbl} (score {sc:.2f})"
        if dp not in (None, ''):
            bit += f" at Δ{dp} bp"
        return bit

    cons = parsed_data.get('consequence', '') or ''
    c_dot = parsed_data.get('c_dot', '') or ''
    is_acc = _consequence_is_acceptor_splice(cons, c_dot)
    is_don = _consequence_is_donor_splice(cons, c_dot)

    top_all = max(s[0] for s in all_slots)
    if top_all < 0.15:
        return

    # For acceptor- or donor-anchored VEP/RefSeq c. coordinates, the variant physically
    # maps to one end of the intron. The same ±window reports four deltas (two sites × two
    # directions). The global max of all four (old behavior) can make a 5&prime; donor
    # term look "co-dominant" with a 3&prime; acceptor term. Mechanistic readout: prioritize
    # the variant-anchored site (3&prime; AG for c.N&minus; acceptor, 5&prime; GT for c.N+).
    if is_acc and not is_don:
        primary = [
            (ag, parsed_data.get('spliceai_dp_ag'), 'acceptor gain'),
            (al, parsed_data.get('spliceai_dp_al'), 'acceptor loss'),
        ]
        secondary = [
            (dg, parsed_data.get('spliceai_dp_dg'), 'donor gain'),
            (dl, parsed_data.get('spliceai_dp_dl'), 'donor loss'),
        ]
        best_p = max(primary, key=lambda x: x[0])
        p_sc, p_dp, p_lbl = best_p
        other_pri = [fmt_side_term(s[0], s[1], s[2]) for s in primary if s != best_p and s[0] >= 0.15]
        other_pri = [b for b in other_pri if b]
        sec_bits = [fmt_side_term(s[0], s[1], s[2]) for s in secondary]
        sec_bits = [b for b in sec_bits if b]
        sec_join = "; ".join(sec_bits)
        core = (
            f"Computational SpliceAI analysis: primary readout (3' acceptor / AG, variant-anchored) is "
            f"{p_lbl} (score {p_sc:.2f}){dp_clause(p_dp)}. "
        )
        if other_pri:
            core += f" Other 3' terms: {'; '.join(other_pri)}. "
        if sec_join:
            core += (
                f"Secondary (5' donor / GT in the same SpliceAI window, different site than this acceptor) includes: {sec_join}. "
                f"These are not co-equal with 3' acceptor terms for mechanistic readout. "
            )
        parsed_data['spliceai_narrative'] = (
            core
            + "Scores reflect predicted splice-site usage on the alternate allele relative to reference, not proof of an abnormal transcript in patient RNA."
        )
        return
    if is_don and not is_acc:
        primary = [
            (dg, parsed_data.get('spliceai_dp_dg'), 'donor gain'),
            (dl, parsed_data.get('spliceai_dp_dl'), 'donor loss'),
        ]
        secondary = [
            (ag, parsed_data.get('spliceai_dp_ag'), 'acceptor gain'),
            (al, parsed_data.get('spliceai_dp_al'), 'acceptor loss'),
        ]
        best_p = max(primary, key=lambda x: x[0])
        p_sc, p_dp, p_lbl = best_p
        other_pri = [fmt_side_term(s[0], s[1], s[2]) for s in primary if s != best_p and s[0] >= 0.15]
        other_pri = [b for b in other_pri if b]
        sec_bits = [fmt_side_term(s[0], s[1], s[2]) for s in secondary]
        sec_bits = [b for b in sec_bits if b]
        sec_join = "; ".join(sec_bits)
        core = (
            f"Computational SpliceAI analysis: primary readout (5' donor / GT, variant-anchored) is "
            f"{p_lbl} (score {p_sc:.2f}){dp_clause(p_dp)}. "
        )
        if other_pri:
            core += f" Other 5' terms: {'; '.join(other_pri)}. "
        if sec_join:
            core += (
                f"Secondary (3' acceptor / AG in the same SpliceAI window, different site) includes: {sec_join}. "
                f"These are not co-equal with 5' donor terms for mechanistic readout. "
            )
        parsed_data['spliceai_narrative'] = (
            core
            + "Scores reflect predicted splice-site usage on the alternate allele relative to reference, not proof of an abnormal transcript in patient RNA."
        )
        return

    # Splice region / ambiguous: keep legacy four-way top term + notable tail.
    ranked = sorted(all_slots, key=lambda x: x[0], reverse=True)
    best_sc, best_dp, best_lbl = ranked[0]

    def _dp_brief(dp_val):
        if dp_val is None or dp_val == '':
            return ''
        try:
            n = int(dp_val)
            sign = '+' if n > 0 else ('−' if n < 0 else '')
            return f" at Δ{sign}{abs(n)} bp"
        except (TypeError, ValueError):
            return f" at Δ{dp_val} bp"

    def _short_term(sc, dp, lbl):
        if sc < 0.15:
            return ''
        return f"{lbl} ({sc:.2f}){_dp_brief(dp)}"

    extras = [s for s in (_short_term(sc, dp, lbl) for sc, dp, lbl in ranked[1:]) if s]
    extras_str = f"; also {', '.join(extras)}" if extras else ''
    parsed_data['spliceai_narrative'] = (
        f"SpliceAI: dominant signal is {best_lbl} ({best_sc:.2f}){_dp_brief(best_dp)}{extras_str}."
    )


_CODON_TABLE_FULL = {
    'TTT':'F','TTC':'F','TTA':'L','TTG':'L','CTT':'L','CTC':'L','CTA':'L','CTG':'L',
    'ATT':'I','ATC':'I','ATA':'I','ATG':'M','GTT':'V','GTC':'V','GTA':'V','GTG':'V',
    'TCT':'S','TCC':'S','TCA':'S','TCG':'S','CCT':'P','CCC':'P','CCA':'P','CCG':'P',
    'ACT':'T','ACC':'T','ACA':'T','ACG':'T','GCT':'A','GCC':'A','GCA':'A','GCG':'A',
    'TAT':'Y','TAC':'Y','TAA':'*','TAG':'*','CAT':'H','CAC':'H','CAA':'Q','CAG':'Q',
    'AAT':'N','AAC':'N','AAA':'K','AAG':'K','GAT':'D','GAC':'D','GAA':'E','GAG':'E',
    'TGT':'C','TGC':'C','TGA':'*','TGG':'W','CGT':'R','CGC':'R','CGA':'R','CGG':'R',
    'AGT':'S','AGC':'S','AGA':'R','AGG':'R','GGT':'G','GGC':'G','GGA':'G','GGG':'G',
}


def _missense_same_codon_different_change(hgvs_p_a, hgvs_p_b):
    a = _parse_missense_substitution_hgvs_p(hgvs_p_a)
    b = _parse_missense_substitution_hgvs_p(hgvs_p_b)
    if not a or not b or a["pos"] != b["pos"]:
        return False
    return not (a["ref_1"] == b["ref_1"] and a["alt_1"] == b["alt_1"])


def _decode_cds_triplet(dna3):
    """Map a 3-bp CDS triplet to (one-letter, three-letter) amino acid labels (e.g. CAG → Q, Gln)."""
    s = (dna3 or "").upper()
    if len(s) != 3:
        return None, None
    one = _CODON_TABLE_FULL.get(s)
    if one is None:
        return "X", "Xaa"
    three = _AA_ONE_TO_THREE.get(one, one)
    return one, three


_EXON_INTERNAL_CRYPTIC_GAIN_THRESHOLD = 0.20


def _resolve_exon_internal_cryptic_outcome(http_session, parsed_data):
    """
    Sequence-level "what if the new splice site is used?" resolver for variants
    whose VEP consequence is NOT splice-anchored (typically missense or
    synonymous) but where SpliceAI predicts a strong cryptic donor or acceptor
    GAIN inside the exon containing the variant.

    Complements the existing splice-anchored resolver
    (_resolve_cryptic_splice_outcome), which only fires for splice_donor /
    splice_acceptor / splice_region consequences. A coding SNV can also create
    a brand-new GT (donor) or AG (acceptor) inside an exon — the case the user
    asked about — and that path was previously unscored.

    Math:
      * Donor gain   - new exon ends at the cryptic donor cDNA position;
                       (cryptic_donor + 1 .. canonical_exon_end) is excised.
      * Acceptor gain- new exon starts at the cryptic acceptor cDNA position;
                       (canonical_exon_start .. cryptic_acceptor - 1) is excised.
      * Frame        - deleted_nt mod 3.
      * Translates the mutant CDS (variant ALT applied first, then the lost
        segment removed) from codon 1 to find the first downstream stop codon.
      * NMD likely if the predicted PTC sits more than 50 nt 5' of the last
        exon-exon junction in the mutant transcript (last-exon / 50-nt rule).

    Side effects on parsed_data:
      - 'cryptic_gain_outcome'   : structured dict consumed by the UI
      - 'spliceai_narrative'     : appended plain-text sentence describing the
                                   predicted protein consequence

    The helper is conservative: it bails (without modifying parsed_data) when
    coordinates, alleles, or the cryptic-site location cannot be resolved
    cleanly, rather than synthesize a misleading product.
    """
    GAIN_THRESH = _EXON_INTERNAL_CRYPTIC_GAIN_THRESHOLD

    try:
        ag = float(parsed_data.get('spliceai_ds_ag') or 0.0)
        dg = float(parsed_data.get('spliceai_ds_dg') or 0.0)
        al = float(parsed_data.get('spliceai_ds_al') or 0.0)
        dl = float(parsed_data.get('spliceai_ds_dl') or 0.0)
    except (TypeError, ValueError):
        return

    _signal_slots = (
        ('donor_gain', dg, 'spliceai_dp_dg', True, 'Donor Gain'),
        ('acceptor_gain', ag, 'spliceai_dp_ag', False, 'Acceptor Gain'),
        ('donor_loss', dl, 'spliceai_dp_dl', True, 'Donor Loss'),
        ('acceptor_loss', al, 'spliceai_dp_al', False, 'Acceptor Loss'),
    )
    _eligible = [
        (kind, sc, dp_key, use_donor, label)
        for kind, sc, dp_key, use_donor, label in _signal_slots
        if sc >= GAIN_THRESH
    ]
    if not _eligible:
        return
    _kind, score, _dp_key, use_donor, cryptic_label = max(_eligible, key=lambda x: x[1])

    cons = parsed_data.get('consequence', '') or ''
    c_dot = parsed_data.get('c_dot', '') or ''
    cons_l = cons.lower()
    if any(tok in cons_l for tok in ('splice_acceptor', 'splice_donor', 'splice_region',
                                     'splice_polypyrimidine', 'splice_donor_5th_base',
                                     'splice_donor_region')):
        return
    if _consequence_is_donor_splice(cons, c_dot) or _consequence_is_acceptor_splice(cons, c_dot):
        return

    cds_pos = 0
    try:
        cds_pos = int(parsed_data.get('snpeff_cds_pos') or 0)
    except (TypeError, ValueError):
        cds_pos = 0
    if cds_pos <= 0:
        m = re.search(r'c\.([0-9]+)', c_dot or '')
        if m:
            try:
                cds_pos = int(m.group(1))
            except ValueError:
                cds_pos = 0
    if cds_pos <= 0:
        return

    coding_exons = parsed_data.get('coding_exons') or []
    enst_id = parsed_data.get('ensembl_transcript_id', '') or ''
    strand = parsed_data.get('transcript_strand')

    if not coding_exons and enst_id and http_session is not None:
        try:
            clean_enst = enst_id.split('.')[0]
            url = f"https://rest.ensembl.org/lookup/id/{clean_enst}?expand=1"
            resp = http_session.get(url, timeout=60)
            if getattr(resp, 'status_code', 0) == 200:
                exon_data = resp.json() or {}
                exons = exon_data.get('Exon', []) or []
                if strand is None:
                    strand = exon_data.get('strand', 1)
                    parsed_data['transcript_strand'] = strand
                trans = exon_data.get('Translation', {}) or {}
                cds_g_start = trans.get('start')
                cds_g_end = trans.get('end')
                if cds_g_start and cds_g_end and exons:
                    exons.sort(key=lambda x: x['start'] if strand == 1 else -x['start'])
                    cds_cursor = 0
                    fetched = []
                    for e_idx, e in enumerate(exons):
                        e_s, e_e = e['start'], e['end']
                        ovs = max(e_s, cds_g_start)
                        ove = min(e_e, cds_g_end)
                        if ovs <= ove:
                            clen = ove - ovs + 1
                            start_c = cds_cursor + 1
                            cds_cursor += clen
                            end_c = cds_cursor
                            fetched.append({
                                'start_cds': start_c,
                                'end_cds': end_c,
                                'anatomical_rank': e_idx + 1,
                                'length_bp': clen,
                                'chr': exon_data.get('seq_region_name'),
                                'start': e_s,
                                'end': e_e,
                            })
                    coding_exons = fetched
                    parsed_data['coding_exons'] = coding_exons
                    _stash_transcript_mrna_exon_metadata(
                        parsed_data, exons, coding_exons,
                        cds_genomic_start=cds_g_start, cds_genomic_end=cds_g_end,
                    )
        except Exception as exc:
            print(f"[exon-internal cryptic] coding_exons fetch failed: {exc}")

    if not coding_exons:
        return

    try:
        strand_int = int(strand) if strand is not None else 1
    except (TypeError, ValueError):
        strand_int = 1

    cx = None
    for c in coding_exons:
        try:
            sc = int(c.get('start_cds') or 0)
            ec = int(c.get('end_cds') or 0)
        except (TypeError, ValueError):
            continue
        if sc <= cds_pos <= ec:
            cx = c
            break
    if not cx:
        return

    dp = _parse_spliceai_dp(parsed_data.get(_dp_key))
    if dp is None:
        return

    new_site_cdna = _spliceai_cdna_site_1based(cds_pos, dp, strand_int)
    if new_site_cdna is None:
        return

    try:
        ex_start = int(cx.get('start_cds') or 0)
        ex_end = int(cx.get('end_cds') or 0)
    except (TypeError, ValueError):
        return
    if ex_start <= 0 or ex_end <= 0:
        return

    whole_exon_skip = False
    if not (ex_start <= new_site_cdna <= ex_end):
        return

    if use_donor:
        deleted_nt = ex_end - new_site_cdna
    else:
        deleted_nt = new_site_cdna - ex_start

    # Canonical donor/acceptor loss at the exon boundary (SpliceAI Δ≈0 at last/first base):
    # model whole-exon skip — not "0 nt deleted" (e.g. CDK13 c.2543G>A, donor loss DS 0.67).
    if deleted_nt <= 0 and str(_kind).endswith('_loss'):
        if use_donor and abs(int(new_site_cdna) - int(ex_end)) <= 1:
            whole_exon_skip = True
        elif not use_donor and abs(int(new_site_cdna) - int(ex_start)) <= 1:
            whole_exon_skip = True
    if deleted_nt <= 0 and not whole_exon_skip:
        return
    if whole_exon_skip:
        try:
            deleted_nt = int(cx.get('length_bp') or 0)
        except (TypeError, ValueError):
            deleted_nt = 0
        if deleted_nt <= 0:
            deleted_nt = ex_end - ex_start + 1

    in_frame = (deleted_nt % 3 == 0)
    aa_lost = deleted_nt // 3 if in_frame else None

    cds_seq = parsed_data.get('cds_seq') or ''
    if not cds_seq and enst_id and http_session is not None:
        try:
            clean_enst = enst_id.split('.')[0]
            seq_url = f"https://rest.ensembl.org/sequence/id/{clean_enst}?type=cds"
            sresp = http_session.get(seq_url, timeout=60)
            if getattr(sresp, 'status_code', 0) == 200:
                cds_seq = (sresp.json() or {}).get('seq', '') or ''
                if cds_seq:
                    parsed_data['cds_seq'] = cds_seq
        except Exception as exc:
            print(f"[exon-internal cryptic] cds fetch failed: {exc}")

    new_stop_aa = None
    hgvs_p = ''
    fs_ter_count = 0
    new_aa3 = ''
    native_aa3 = ''
    nmd_likely = None
    nmd_short = ''
    truncation_fraction = None
    truncated_protein_length = None
    in_frame_internal_only = False
    ptc_exon_rank = None
    ptc_exon_total = None
    ptc_cds_in_native = None
    ptc_cds_in_mutant = None
    ptc_codon_native_bases = ''
    ptc_native_pos_range = ''

    if whole_exon_skip:
        first_changed_codon_pos = ((ex_start - 1) // 3) + 1
    elif use_donor:
        first_changed_codon_pos = (new_site_cdna // 3) + 1
    else:
        first_changed_codon_pos = ((ex_start - 1) // 3) + 1

    try:
        p_len = int(parsed_data.get('protein_length') or 0)
    except (TypeError, ValueError):
        p_len = 0

    last_cx_rank = None
    if coding_exons:
        try:
            last_cx_rank = int(coding_exons[-1].get('anatomical_rank') or 0)
        except (TypeError, ValueError):
            last_cx_rank = None

    if cds_seq:
        ref = (parsed_data.get('ref') or '').upper()
        alt = (parsed_data.get('alt') or '').upper()
        if (
            len(ref) == 1 and len(alt) == 1
            and 1 <= cds_pos <= len(cds_seq)
            and cds_seq[cds_pos - 1].upper() == ref
        ):
            mutated_full = cds_seq[:cds_pos - 1] + alt + cds_seq[cds_pos:]
        else:
            mutated_full = cds_seq

        if whole_exon_skip:
            mutant_cds = mutated_full[:ex_start - 1] + mutated_full[ex_end:]
        elif use_donor:
            mutant_cds = mutated_full[:new_site_cdna] + mutated_full[ex_end:]
        else:
            mutant_cds = mutated_full[:ex_start - 1] + mutated_full[new_site_cdna - 1:]

        for i in range(0, len(mutant_cds) - 2, 3):
            codon = mutant_cds[i:i + 3].upper()
            if codon in ('TAA', 'TAG', 'TGA'):
                new_stop_aa = (i // 3) + 1
                break

        native_stop_aa = None
        try:
            for i in range(0, len(cds_seq) - 2, 3):
                codon = cds_seq[i:i + 3].upper()
                if codon in ('TAA', 'TAG', 'TGA'):
                    native_stop_aa = (i // 3) + 1
                    break
        except Exception:
            native_stop_aa = None

        if (
            in_frame and new_stop_aa is not None and native_stop_aa is not None
            and aa_lost is not None
            and new_stop_aa == max(0, native_stop_aa - aa_lost)
        ):
            in_frame_internal_only = True
            new_stop_aa = None

        # Decode native + new amino acid at the first changed codon (HGVS-style label).
        try:
            n0 = (first_changed_codon_pos - 1) * 3
            if 0 <= n0 + 3 <= len(cds_seq):
                _, native_aa3 = _decode_cds_triplet(cds_seq[n0:n0 + 3])
            m0 = (first_changed_codon_pos - 1) * 3
            if 0 <= m0 + 3 <= len(mutant_cds):
                _, new_aa3 = _decode_cds_triplet(mutant_cds[m0:m0 + 3])
        except Exception:
            native_aa3 = native_aa3 or ''
            new_aa3 = new_aa3 or ''

        if new_stop_aa is not None:
            # PTC location in the MUTANT CDS (1-based end of the stop codon)
            ptc_cds_in_mutant = new_stop_aa * 3
            # Map back to NATIVE CDS coordinates so we can name an anatomical
            # exon for the PTC (the existing frameshift / nonsense math reports
            # "PTC falls in exon X of Y coding exons" — mirror that here).
            if whole_exon_skip:
                ptc_cds_in_native = (
                    ptc_cds_in_mutant
                    if ptc_cds_in_mutant <= (ex_start - 1)
                    else ptc_cds_in_mutant + deleted_nt
                )
            elif use_donor:
                # Mutant CDS = native[1..new_site_cdna] + native[ex_end+1..end]
                ptc_cds_in_native = (
                    ptc_cds_in_mutant
                    if ptc_cds_in_mutant <= new_site_cdna
                    else ptc_cds_in_mutant + deleted_nt
                )
            else:
                # Mutant CDS = native[1..ex_start-1] + native[new_site_cdna..end]
                ptc_cds_in_native = (
                    ptc_cds_in_mutant
                    if ptc_cds_in_mutant <= (ex_start - 1)
                    else ptc_cds_in_mutant + deleted_nt
                )
            ptc_native_pos_range = (
                f"c.{ptc_cds_in_native - 2}-c.{ptc_cds_in_native}"
                if ptc_cds_in_native and ptc_cds_in_native >= 3
                else ''
            )
            try:
                if ptc_cds_in_native and ptc_cds_in_native - 3 >= 0 and ptc_cds_in_native <= len(cds_seq):
                    ptc_codon_native_bases = cds_seq[ptc_cds_in_native - 3:ptc_cds_in_native].upper()
            except Exception:
                ptc_codon_native_bases = ''

            ptc_exon_rank = None
            ptc_exon_total = None
            try:
                ptc_exon_total = int(coding_exons[-1].get('anatomical_rank') or 0)
            except (TypeError, ValueError):
                ptc_exon_total = None
            for tcx in coding_exons:
                try:
                    ts = int(tcx.get('start_cds') or 0)
                    te = int(tcx.get('end_cds') or 0)
                except (TypeError, ValueError):
                    continue
                if ts <= ptc_cds_in_native <= te:
                    try:
                        ptc_exon_rank = int(tcx.get('anatomical_rank') or 0) or None
                    except (TypeError, ValueError):
                        ptc_exon_rank = None
                    break

            # NMD verdict using the standard last-exon-junction rule:
            #   * PTC in the last coding exon → escape (no downstream EJC to trigger NMD).
            #   * PTC in the penultimate coding exon → 50 nt rule applies:
            #       <50 nt 5' of the last exon-exon junction → escape;
            #       ≥50 nt 5' of the last exon-exon junction → NMD predicted.
            #   * PTC in any earlier internal coding exon → NMD predicted by default
            #     (multiple downstream exon-exon junctions deposit EJCs ≥55 nt 3' of
            #     the PTC; the 50 nt threshold is only the deciding factor for the
            #     penultimate-exon case, so we do not invoke it here).
            nmd_likely = True
            nmd_short = 'NMD: predicted (internal coding exon).'
            if ptc_exon_rank is not None and ptc_exon_total:
                if ptc_exon_rank == ptc_exon_total:
                    nmd_likely = False
                    nmd_short = f'NMD: escape (PTC in last coding exon {ptc_exon_rank}/{ptc_exon_total}).'
                elif ptc_exon_rank == ptc_exon_total - 1:
                    target_tcx = next(
                        (t for t in coding_exons if int(t.get('anatomical_rank') or 0) == ptc_exon_rank),
                        None,
                    )
                    if target_tcx:
                        try:
                            te2 = int(target_tcx.get('end_cds') or 0)
                        except (TypeError, ValueError):
                            te2 = 0
                        dist_to_eej = te2 - ptc_cds_in_native
                        if dist_to_eej < 50:
                            nmd_likely = False
                            nmd_short = (
                                f'NMD: escape (PTC in penultimate exon {ptc_exon_rank}/{ptc_exon_total}, '
                                f'{dist_to_eej} nt from last exon-exon junction; <50 nt rule).'
                            )
                        else:
                            nmd_short = (
                                f'NMD: predicted (PTC in penultimate exon {ptc_exon_rank}/{ptc_exon_total}, '
                                f'{dist_to_eej} nt from last exon-exon junction; ≥50 nt rule).'
                            )
                else:
                    nmd_short = (
                        f'NMD: predicted (PTC in internal coding exon {ptc_exon_rank}/{ptc_exon_total}; '
                        f'multiple downstream exon-exon junctions deposit EJCs that trigger NMD).'
                    )
            else:
                # Fallback to a coarser mutant-coordinate ≥50 nt rule when we
                # could not resolve an anatomical exon rank for the PTC.
                try:
                    last_cx_native_start = int(coding_exons[-1].get('start_cds') or 0)
                except (TypeError, ValueError):
                    last_cx_native_start = 0
                last_junction_in_mutant = max(0, last_cx_native_start - deleted_nt)
                if last_junction_in_mutant and ptc_cds_in_mutant < (last_junction_in_mutant - 50):
                    nmd_likely = True
                    nmd_short = 'NMD: predicted (PTC >50 nt 5′ of last exon-exon junction).'
                else:
                    nmd_likely = False
                    nmd_short = 'NMD: escape (PTC near/in last exon).'

            if in_frame:
                hgvs_p = f"p.Ter{new_stop_aa}"
            else:
                fs_ter_count = max(0, new_stop_aa - first_changed_codon_pos) + 1
                aa3 = new_aa3 or 'Xaa'
                hgvs_p = f"p.{aa3}{first_changed_codon_pos}fsTer{fs_ter_count}"

            truncated_protein_length = max(0, new_stop_aa - 1)
            if p_len > 0 and new_stop_aa is not None:
                from vc_engine.truncation import c_terminal_loss_fraction
                truncation_fraction = c_terminal_loss_fraction(int(new_stop_aa), int(p_len))

        elif in_frame and aa_lost is not None:
            # In-frame internal deletion only — predict residue range removed.
            last_deleted_codon_pos = first_changed_codon_pos + aa_lost - 1
            try:
                ld0 = (last_deleted_codon_pos - 1) * 3
                last_aa3 = ''
                if 0 <= ld0 + 3 <= len(cds_seq):
                    _, last_aa3 = _decode_cds_triplet(cds_seq[ld0:ld0 + 3])
            except Exception:
                last_aa3 = ''
            n_aa3 = native_aa3 or 'Xaa'
            l_aa3 = last_aa3 or 'Xaa'
            if last_deleted_codon_pos == first_changed_codon_pos:
                hgvs_p = f"p.{n_aa3}{first_changed_codon_pos}del"
            else:
                hgvs_p = f"p.{n_aa3}{first_changed_codon_pos}_{l_aa3}{last_deleted_codon_pos}del"
            if p_len > 0 and aa_lost is not None:
                truncated_protein_length = max(0, p_len - aa_lost)
                truncation_fraction = max(0.0, aa_lost / float(p_len))

    exon_rank = cx.get('anatomical_rank')
    frame_word = 'in-frame' if in_frame else 'out-of-frame'

    if whole_exon_skip:
        excised_cdna_lo = ex_start
        excised_cdna_hi = ex_end
    elif use_donor:
        excised_cdna_lo = new_site_cdna + 1
        excised_cdna_hi = ex_end
    else:
        excised_cdna_lo = ex_start
        excised_cdna_hi = new_site_cdna - 1

    def _dp_brief(dp_val):
        try:
            n = int(dp_val)
            sign = '+' if n > 0 else ('−' if n < 0 else '')
            return f"Δ{sign}{abs(n)}"
        except (TypeError, ValueError):
            return f"Δ{dp_val}"

    if whole_exon_skip:
        head = (
            f"If used: canonical {cryptic_label.lower()} ({score:.2f} at {_dp_brief(dp)} bp) "
            f"at the 3′ end of coding exon {exon_rank} → whole-exon skip "
            f"({deleted_nt} nt excised, {frame_word})"
        )
    else:
        head = (
            f"If used: cryptic {cryptic_label.lower()} ({score:.2f} at {_dp_brief(dp)} bp) "
            f"shortens exon {exon_rank} by {deleted_nt} nt ({frame_word})"
        )
    if hgvs_p:
        head += f" → {hgvs_p}"
    head += "."

    ptc_clause = ''
    if ptc_exon_rank is not None and ptc_exon_total:
        coord_bit = ''
        if ptc_native_pos_range:
            coord_bit = f" at native {ptc_native_pos_range}"
            if ptc_codon_native_bases:
                coord_bit += f" ({ptc_codon_native_bases})"
        frame_note = " — frame-shifted stop" if (not in_frame and ptc_native_pos_range) else ""
        ptc_clause = f" PTC in exon {ptc_exon_rank}/{ptc_exon_total}{coord_bit}{frame_note}."

    length_short = ''
    if truncated_protein_length is not None and p_len > 0:
        pct = (truncation_fraction or 0) * 100
        if in_frame and new_stop_aa is None:
            length_short = f" Protein ≈ {truncated_protein_length}/{p_len} aa ({pct:.1f}% internal residues lost)."
        else:
            length_short = f" Truncated ≈ {truncated_protein_length}/{p_len} aa ({pct:.1f}% C-term lost)."

    # Compact NMD verdict (drops the verbose explanatory tail of nmd_short).
    nmd_compact = ''
    if nmd_short:
        if nmd_likely is False:
            if 'last coding exon' in nmd_short:
                nmd_compact = ' NMD-escape (PTC in last exon).'
            elif 'penultimate exon' in nmd_short:
                nmd_compact = ' NMD-escape (penultimate exon, <50 nt to last junction).'
            else:
                nmd_compact = ' NMD-escape.'
        else:
            if 'penultimate exon' in nmd_short:
                m = re.search(r'(\d+)\s*nt', nmd_short)
                dist = m.group(1) if m else ''
                nmd_compact = f' NMD-predicted (penultimate exon, {dist} nt to last junction; ≥50 nt rule).' if dist else ' NMD-predicted (penultimate exon; ≥50 nt rule).'
            elif 'internal coding exon' in nmd_short:
                nmd_compact = ' NMD-predicted (internal exon; downstream EJCs).'
            else:
                nmd_compact = ' NMD-predicted.'

    sentence = head + ptc_clause + length_short + nmd_compact + " Computational only — not RNA evidence."

    _ei_ctx = _pack_exon_internal_junction_align_ctx(
        cds_seq=cds_seq or parsed_data.get('cds_seq') or '',
        cx=cx,
        new_site_cdna=new_site_cdna,
        cds_pos=cds_pos,
        ref=parsed_data.get('ref') or '',
        alt=parsed_data.get('alt') or '',
        use_donor=use_donor,
        deleted_nt=deleted_nt,
    )
    _cg_out = {
        'cryptic_type': cryptic_label,
        'gain_score': score,
        'dp_offset': dp,
        'new_site_cdna': new_site_cdna,
        'exon_rank': exon_rank,
        'exon_cds_start': ex_start,
        'exon_cds_end': ex_end,
        'use_donor_cryptic': use_donor,
        'excised_cdna_lo': excised_cdna_lo,
        'excised_cdna_hi': excised_cdna_hi,
        'deleted_nt': deleted_nt,
        'whole_exon_skip': whole_exon_skip,
        'in_frame': in_frame,
        'aa_lost': aa_lost,
        'first_changed_codon_pos': first_changed_codon_pos,
        'native_aa3': native_aa3,
        'new_aa3': new_aa3,
        'new_stop_aa': new_stop_aa,
        'hgvs_p': hgvs_p,
        'fs_ter_str': hgvs_p,
        'fs_ter_count': fs_ter_count if fs_ter_count > 0 else None,
        'ptc_aa_position': new_stop_aa,
        'ptc_exon_rank': ptc_exon_rank,
        'ptc_exon_total': ptc_exon_total,
        'ptc_cds_in_native': ptc_cds_in_native,
        'ptc_cds_in_mutant': ptc_cds_in_mutant,
        'ptc_codon_native_bases': ptc_codon_native_bases,
        'ptc_native_pos_range': ptc_native_pos_range,
        'nmd_likely': nmd_likely,
        'nmd_short': nmd_short,
        'truncated_protein_length': truncated_protein_length,
        'truncation_fraction': truncation_fraction,
        'in_frame_internal_only': in_frame_internal_only,
        'narrative': sentence,
    }
    if _ei_ctx:
        _cg_out['junction_align_ctx'] = _ei_ctx
    parsed_data['cryptic_gain_outcome'] = _cg_out
    # splice_viz uses cryptic_splice_outcome for junction rows; exon-internal path only fills cryptic_gain_outcome.
    parsed_data['splice_viz_exon_internal_cryptic'] = True

    existing = parsed_data.get('spliceai_narrative', '') or ''
    if existing:
        parsed_data['spliceai_narrative'] = existing.rstrip() + " " + sentence
    else:
        parsed_data['spliceai_narrative'] = sentence

    _apply_exon_internal_cryptic_splice_report(parsed_data)


def _build_exon_internal_cryptic_splice_frame_html(cg, parsed_data=None):
    """Structured splice product block for exon-internal cryptic outcomes (unified layout)."""
    if not cg:
        return ''
    ctype = cg.get('cryptic_type') or 'Cryptic gain'
    ct_l = ctype.lower()
    try:
        score = float(cg.get('gain_score') or 0)
    except (TypeError, ValueError):
        score = 0.0
    dp = cg.get('dp_offset')
    ex_rank = cg.get('exon_rank')
    del_nt = cg.get('deleted_nt')
    in_frame = cg.get('in_frame')
    hgvs = (cg.get('hgvs_p') or '').strip()
    fs_ter = cg.get('fs_ter_count')
    ptc_er = cg.get('ptc_exon_rank')
    ptc_et = cg.get('ptc_exon_total')
    ptc_range = (cg.get('ptc_native_pos_range') or '').strip()
    ptc_bases = (cg.get('ptc_codon_native_bases') or '').strip()
    nmd_likely = cg.get('nmd_likely')
    nmd_short = (cg.get('nmd_short') or '').strip()
    trunc_len = cg.get('truncated_protein_length')
    trunc_frac = cg.get('truncation_fraction')
    new_site = cg.get('new_site_cdna')
    fcp = cg.get('first_changed_codon_pos')
    native_aa3 = (cg.get('native_aa3') or '').strip()
    new_aa3 = (cg.get('new_aa3') or '').strip()

    frame_word = 'in-frame' if in_frame else 'out-of-frame'
    mech = f"exon-internal {ct_l}"
    role = "Product 1 (primary)"

    geo_parts = [
        f"cryptic site at cDNA position <code>{new_site}</code> inside coding exon {ex_rank or '?'} —"
    ]
    if 'acceptor' in ct_l:
        geo_parts.append(
            f"new 3&prime; splice acceptor truncates the 3&prime; end of the exon "
            f"(<b>{del_nt} nt</b> removed from the mature mRNA ORF)"
        )
    else:
        geo_parts.append(
            f"new 5&prime; splice donor truncates the 3&prime; end of the exon "
            f"(<b>{del_nt} nt</b> removed from the mature mRNA ORF)"
        )
    if del_nt is not None:
        codon_bit = ''
        if in_frame and del_nt % 3 == 0:
            codon_bit = f" = {del_nt // 3} codon{'s' if del_nt // 3 != 1 else ''}"
        geo_parts.append(f"net ORF change: {del_nt} nt deleted{codon_bit}")

    junction = ''
    if fcp and (native_aa3 or new_aa3):
        n3 = native_aa3 or 'Xaa'
        j3 = new_aa3 or 'Xaa'
        if in_frame:
            junction = f"first changed codon ≈ p.{n3}{fcp} (native triplet at this position)"
        else:
            junction = (
                f"reading frame shifts at codon {fcp} (p.{n3}{fcp} → p.{j3}{fcp}… in mutant ORF)"
            )

    protein = ''
    if hgvs:
        protein = f"<code>{hgvs}</code>"
        if fs_ter:
            protein += f" ({int(fs_ter)} aa before stop in shifted frame)"

    ptc = ''
    if ptc_er and ptc_et:
        ptc = f"PTC in exon {ptc_er}/{ptc_et}"
        if ptc_range:
            ptc += f" at native {ptc_range}"
            if ptc_bases:
                ptc += f" (<code>{ptc_bases}</code>)"
        if not in_frame:
            ptc += " — frame-shifted stop codon"

    length = ''
    if trunc_len is not None and parsed_data:
        pl = parsed_data.get('protein_length')
        try:
            pl_i = int(pl) if pl is not None else 0
        except (TypeError, ValueError):
            pl_i = 0
        if pl_i > 0 and trunc_frac is not None:
            pct = round(float(trunc_frac) * 100, 1)
            length = (
                f"truncated ≈ {trunc_len}/{pl_i} aa ({pct}% C-terminus lost if this product is translated)"
            )

    nmd = ''
    if nmd_likely is not None:
        nmd_body = nmd_short
        if nmd_body.lower().startswith('nmd:'):
            nmd_body = nmd_body[4:].strip()
        nmd = nmd_body or ('predicted' if nmd_likely else 'escape — PTC in last/penultimate exon window')

    return _format_unified_splice_product_html(
        role,
        mech,
        spliceai_ds=score,
        spliceai_dp=dp,
        parsed_data=parsed_data,
        geometry=' '.join(geo_parts),
        frame=frame_word,
        junction_codon=junction,
        predicted_protein=protein,
        ptc=ptc,
        protein_length=length,
        nmd=nmd,
        context_note="Exon-internal model — GT/AG dinucleotides at splice sites are excluded from ORF body counts on deep-intronic maps",
    )


def _apply_exon_internal_cryptic_splice_report(parsed_data):
    """Promote cryptic_gain_outcome into splice_frame_math + shared truncation/NMD fields."""
    cg = parsed_data.get('cryptic_gain_outcome') or {}
    if not cg or not cg.get('deleted_nt'):
        return
    html = _build_exon_internal_cryptic_splice_frame_html(cg, parsed_data)
    if html and not (parsed_data.get('splice_frame_math') or '').strip():
        parsed_data['splice_frame_math'] = html
    if cg.get('in_frame') is True:
        parsed_data['splice_is_in_frame'] = True
    elif cg.get('in_frame') is False:
        parsed_data['splice_is_in_frame'] = False
    tf = cg.get('truncation_fraction')
    if tf is not None:
        try:
            parsed_data['nmd_escape_truncation_fraction'] = float(tf)
        except (TypeError, ValueError):
            pass
    if cg.get('nmd_likely') is not None:
        parsed_data['nmd_escape'] = not bool(cg['nmd_likely'])
    if cg.get('hgvs_p'):
        parsed_data.setdefault('junction_model_hgvs_p', cg['hgvs_p'])
    if cg.get('new_stop_aa') is not None:
        parsed_data.setdefault('junction_model_ptc_position', cg['new_stop_aa'])
        try:
            nsa = int(cg['new_stop_aa'])
            fcp = cg.get('first_changed_codon_pos')
            parsed_data['novel_stop_aa'] = nsa
            if fcp is not None:
                fcp_i = int(fcp)
                parsed_data['protein_start'] = fcp_i
                parsed_data['downstream_aas'] = max(0, nsa - fcp_i)
            if cg.get('in_frame') is False:
                parsed_data['is_splice_frameshift'] = True
        except (TypeError, ValueError):
            pass
    if cg.get('ptc_exon_rank') is not None:
        parsed_data.setdefault('junction_model_ptc_exon_rank', cg['ptc_exon_rank'])
    if cg.get('nmd_likely') is not None and not parsed_data.get('nmd_decision_basis'):
        if cg['nmd_likely']:
            parsed_data['nmd_decision_basis'] = (
                "Exon-internal cryptic splice product places the PTC more than 50–55 nt "
                "upstream of the final exon-exon junction — predicted to trigger NMD."
            )
        else:
            parsed_data['nmd_decision_basis'] = (
                "Exon-internal cryptic splice product places the PTC in or near the last "
                "coding exon — predicted to escape NMD."
            )


def _ensure_protein_length_from_coding_exons(parsed_data):
    """Fill protein_length from coding_exons CDS span when Ensembl/VEP left it at 0."""
    try:
        cur = int(parsed_data.get('protein_length') or 0)
    except (TypeError, ValueError):
        cur = 0
    if cur > 0:
        return cur
    ce = parsed_data.get('coding_exons') or []
    if not isinstance(ce, list):
        return 0
    max_end = 0
    for cx in ce:
        if not isinstance(cx, dict):
            continue
        try:
            max_end = max(max_end, int(cx.get('end_cds') or 0))
        except (TypeError, ValueError):
            continue
    if max_end < 3:
        return 0
    # Prefer excluding the stop codon when CDS length is a multiple of 3.
    pl = (max_end // 3 - 1) if (max_end % 3 == 0) else (max_end // 3)
    if pl > 0:
        parsed_data['protein_length'] = pl
        return pl
    return 0


def _mark_oof_exon_skip_nmd_provisional(
    parsed_data,
    *,
    aa_lost=None,
    fraction_lost=None,
    ptc_unresolved=False,
):
    """
    Drive NMD Escape / truncation % pills for out-of-frame whole-exon skip even when
    the mutant CDS could not be translated (Ensembl timeout / empty CDS).
    """
    parsed_data['splice_is_in_frame'] = False
    parsed_data['is_splice_frameshift'] = True
    if parsed_data.get('nmd_escape') is None or (
        ptc_unresolved and not parsed_data.get('nmd_decision_basis')
    ):
        parsed_data['nmd_escape'] = False
    if not (parsed_data.get('nmd_decision_basis') or '').strip():
        if ptc_unresolved:
            parsed_data['nmd_decision_basis'] = (
                "Out-of-frame whole-exon skip → frameshift with an expected PTC; "
                "CDS sequence was unavailable to locate the stop — predicted to trigger "
                "NMD unless the PTC maps in the last/penultimate exon window "
                "(re-run when CDS is available)."
            )
        else:
            parsed_data['nmd_decision_basis'] = (
                "Out-of-frame whole-exon skip introduces a frameshift → predicted to "
                "trigger NMD."
            )
    fl = fraction_lost
    if fl is None and aa_lost is not None:
        try:
            pl = int(parsed_data.get('protein_length') or 0)
            aa = int(aa_lost)
            if pl > 0 and aa >= 0:
                fl = aa / float(pl)
        except (TypeError, ValueError):
            fl = None
    if fl is not None:
        try:
            fl_f = float(fl)
        except (TypeError, ValueError):
            fl_f = None
        if fl_f is not None and fl_f > 0:
            parsed_data['splice_fraction_lost'] = fl_f
            try:
                cur_tf = float(parsed_data.get('nmd_escape_truncation_fraction') or 0)
            except (TypeError, ValueError):
                cur_tf = 0.0
            if cur_tf <= 0 and not parsed_data.get('exon_skip_oof_ptc_aa'):
                # Exon-size baseline only when PTC C-term loss is unresolved.
                parsed_data['nmd_escape_truncation_fraction'] = fl_f
                parsed_data['exon_skip_model_truncation_fraction'] = fl_f


def _hydrate_exon_skip_truncation_metrics(parsed_data):
    """
    Whole-exon skip (OOF) product only: stash truncation % / length from resolved skip-product PTC.
    Sidecar keys only — cryptic/junction path still mirrors into canonical fields until
    _apply_exon_skip_truncation_as_primary runs for competing or exon-skip-primary isoforms.
    """
    if parsed_data.get('splice_is_in_frame'):
        return
    if parsed_data.get('exon_skip_oof_no_inframe_stop'):
        pl = parsed_data.get('protein_length')
        if pl is None:
            return
        try:
            pl_i = int(pl)
        except (TypeError, ValueError):
            return
        if pl_i <= 0:
            return
        frac = parsed_data.get('exon_skip_model_truncation_fraction')
        if frac is None:
            frac = parsed_data.get('splice_fraction_lost')
        if frac is not None:
            try:
                parsed_data['exon_skip_model_truncation_fraction'] = float(frac)
            except (TypeError, ValueError):
                pass
        ps = parsed_data.get('exon_skip_model_protein_start')
        if ps is None:
            ts = parsed_data.get('splice_target_start_cds')
            if ts is not None:
                try:
                    ps = max(1, (int(ts) - 1) // 3)
                except (TypeError, ValueError):
                    ps = None
        if ps is not None:
            try:
                ps_i = int(ps)
                parsed_data['exon_skip_model_protein_start'] = ps_i
                parsed_data['exon_skip_model_truncated_protein_length'] = ps_i
            except (TypeError, ValueError):
                pass
        parsed_data['exon_skip_model_downstream_aas'] = 0
        return
    ptc_p = parsed_data.get('exon_skip_oof_ptc_aa')
    if ptc_p is None:
        ptc_p = parsed_data.get('exon_skip_oof_ptc_mrna_codon_aug')
    pl = parsed_data.get('protein_length')
    if ptc_p is None or pl is None:
        return
    try:
        ptc_i = int(ptc_p)
        pl_i = int(pl)
    except (TypeError, ValueError):
        return
    if pl_i <= 0 or ptc_i < 1:
        return
    trunc_len = max(0, ptc_i - 1)
    frac_lost = max(0.0, min(1.0, (pl_i - trunc_len) / float(pl_i)))
    parsed_data['exon_skip_model_truncation_fraction'] = frac_lost
    parsed_data['exon_skip_model_truncated_protein_length'] = trunc_len
    fs = str(parsed_data.get('exon_skip_oof_fs_ter') or '')
    m = re.search(r'fsTer(\d+)', fs, re.I)
    if not m:
        m = re.search(r'fsTer(\d+)', str(parsed_data.get('exon_skip_predicted_hgvs_p') or ''), re.I)
    d_shift = int(m.group(1)) if m else None
    if d_shift is not None and d_shift >= 0:
        parsed_data['exon_skip_model_downstream_aas'] = d_shift
        parsed_data['exon_skip_model_protein_start'] = max(1, ptc_i - d_shift)
    else:
        parsed_data['exon_skip_model_downstream_aas'] = 0
        parsed_data['exon_skip_model_protein_start'] = ptc_i


def _whole_exon_skip_primary_resolved(parsed_data):
    """True when whole-exon skip structural math is the primary splice readout."""
    if not parsed_data.get('splice_deleted_coords'):
        return False
    if parsed_data.get('spliceai_exon_skip_spliceai_primary'):
        return True
    return bool((parsed_data.get('splice_frame_math') or '').strip())


def _suppress_start_loss_nmd_for_exon_skip_primary(parsed_data):
    """
    Start-loss / next-Met re-initiation applies to the reference ORF, not a skip isoform.
    Met residues mapped inside the skipped exon are removed on the loss product and must
    not be treated as downstream re-initiation sites.
    """
    if not _whole_exon_skip_primary_resolved(parsed_data):
        return
    parsed_data.pop('nmd_math', None)
    parsed_data.pop('next_methionine_position', None)
    parsed_data.pop('next_methionine_exon', None)
    oc = (parsed_data.get('original_consequence') or '').strip()
    if oc and 'splice' in oc.lower():
        parsed_data['consequence'] = oc
    if parsed_data.get('splice_is_in_frame') is True:
        parsed_data['nmd_escape'] = True
        pct = parsed_data.get('splice_fraction_lost')
        try:
            pct_f = float(pct) * 100.0 if pct is not None else None
        except (TypeError, ValueError):
            pct_f = None
        pct_bit = f" ({pct_f:.1f}% of the protein removed)" if pct_f is not None else ""
        parsed_data['nmd_decision_basis'] = (
            f"In-frame whole-exon skip{pct_bit}: the loss product has no premature "
            "termination codon, so classical NMD does not apply."
        )


def _apply_exon_skip_truncation_as_primary(parsed_data):
    """
    Mirror whole-exon skip (OOF) PTC into canonical truncation fields when skip is the
    primary splice product — not a stale SnpEff/junction placeholder from pre-splice init.
    """
    if parsed_data.get('splice_is_in_frame'):
        return
    competing = bool(parsed_data.get('spliceai_competing_splice_isoforms'))
    if parsed_data.get('spliceai_junction_model_preferred') and not competing:
        return
    if not competing and not (
        parsed_data.get('spliceai_exon_skip_spliceai_primary')
        or _whole_exon_skip_primary_resolved(parsed_data)
    ):
        return
    _hydrate_exon_skip_truncation_metrics(parsed_data)
    esf = parsed_data.get('exon_skip_model_truncation_fraction')
    if esf is None:
        return
    try:
        parsed_data['nmd_escape_truncation_fraction'] = float(esf)
    except (TypeError, ValueError):
        return
    ps = parsed_data.get('exon_skip_model_protein_start')
    da = parsed_data.get('exon_skip_model_downstream_aas')
    if ps is not None:
        try:
            parsed_data['protein_start'] = int(ps)
        except (TypeError, ValueError):
            pass
    if da is not None:
        try:
            parsed_data['downstream_aas'] = int(da)
        except (TypeError, ValueError):
            pass
    ptc_aa = parsed_data.get('exon_skip_oof_ptc_aa')
    if ptc_aa is not None:
        try:
            parsed_data['novel_stop_aa'] = int(ptc_aa)
        except (TypeError, ValueError):
            pass
    elif ps is not None and da is not None:
        try:
            parsed_data['novel_stop_aa'] = int(ps) + int(da)
        except (TypeError, ValueError):
            pass
    if parsed_data.get('exon_skip_oof_no_inframe_stop'):
        for _k in (
            'exon_skip_oof_ptc_aa',
            'exon_skip_oof_fs_ter',
            'exon_skip_oof_ptc_mrna_codon_aug',
            'exon_skip_oof_terminus_in_utr3',
            'exon_skip_oof_ptc_exon_rank',
            'exon_skip_oof_ptc_fraction_in_exon',
        ):
            parsed_data.pop(_k, None)


def _apply_exon_skip_as_primary_truncation_for_competing(parsed_data):
    """Backward-compatible alias — competing isoforms use the shared apply helper."""
    _apply_exon_skip_truncation_as_primary(parsed_data)


def _build_splice_loss_summary_html(parsed_data, loss_signal=None, mode='acceptor', product_role='Product 2 (loss / exon skip)'):
    """
    Whole-exon skip product (canonical site loss) in the unified splice product layout.
    """
    exon_math = (
        parsed_data.get('splice_frame_math_exon_skip_ref')
        or parsed_data.get('splice_frame_math')
        or ''
    )
    if not exon_math or 'SpliceAI signal:' in exon_math:
        return ""
    is_in_frame = bool(parsed_data.get('splice_is_in_frame'))

    bp_len = None
    aa_lost = None
    pct_str = None
    exon_n = parsed_data.get('variant_exon')
    try:
        m = re.search(r"Exon\s+(\d+)\s+length\s+(\d+)\s*bp", exon_math)
        if m:
            if exon_n is None:
                exon_n = int(m.group(1))
            bp_len = int(m.group(2))
        m2 = re.search(r"(\d+)\s*amino acids lost\s*\(([\d.]+)%\s*of protein\)", exon_math)
        if m2:
            aa_lost = int(m2.group(1))
            pct_str = m2.group(2)
    except (TypeError, ValueError):
        pass

    site_label = "acceptor loss" if mode == 'acceptor' else "donor loss"
    mech = f"canonical {site_label} → whole-exon skip"
    try:
        loss_ds = float(loss_signal) if loss_signal is not None else None
    except (TypeError, ValueError):
        loss_ds = None
    if loss_ds is None:
        try:
            loss_ds = float(parsed_data.get('spliceai_ds_al') or 0) if mode == 'acceptor' else float(parsed_data.get('spliceai_ds_dl') or 0)
        except (TypeError, ValueError):
            loss_ds = 0.0
    loss_dp = parsed_data.get('spliceai_dp_al') if mode == 'acceptor' else parsed_data.get('spliceai_dp_dl')

    geo = []
    if exon_n is not None:
        geo.append(f"canonical {('3&prime;' if mode == 'acceptor' else '5&prime;')} splice site abolished")
        geo.append(f"whole-exon-<b>{exon_n}</b> skip is the dominant loss product")
    else:
        geo.append(f"canonical {('3&prime;' if mode == 'acceptor' else '5&prime;')} splice site abolished")
        geo.append("whole-exon skip is the dominant loss product")
    if bp_len is not None:
        geo.append(f"exon length {bp_len} bp ({'multiple of 3' if is_in_frame else 'not a multiple of 3'})")
    if aa_lost is not None:
        if is_in_frame:
            geo.append(f"in-frame deletion of <b>{aa_lost} aa</b>" + (f" (<b>{pct_str}%</b> of protein)" if pct_str else ""))
        else:
            geo.append(
                f"out-of-frame skip → frameshift downstream of the junction"
                + (f"; ~<b>{pct_str}%</b> C-term affected" if pct_str else "")
            )

    frame = 'in-frame' if is_in_frame else 'out-of-frame'
    ptc = ''
    if not is_in_frame:
        _fs = parsed_data.get('exon_skip_oof_fs_ter')
        _ex = parsed_data.get('exon_skip_oof_ptc_exon_rank')
        _aa = parsed_data.get('exon_skip_oof_ptc_aa')
        if _fs and _ex is not None:
            ptc = f"<b>{_fs}</b>, novel stop in exon {_ex}"
            if _aa:
                ptc += f" (≈aa {_aa} before termination in the re-read ORF)"

    length = ''
    esl = parsed_data.get('exon_skip_model_truncated_protein_length')
    plen = parsed_data.get('protein_length')
    esfrac = parsed_data.get('exon_skip_model_truncation_fraction')
    if esl is not None and plen is not None and esfrac is not None:
        try:
            pct_ct = round(float(esfrac) * 100.0, 1)
            length = f"truncated ≈ {int(esl)}/{int(plen)} aa ({pct_ct}% C-terminus lost vs full-length reference)"
        except (TypeError, ValueError):
            pass

    nmd = ''
    if is_in_frame:
        nmd = "does not apply — in-frame internal deletion (no PTC from skip itself)"
    else:
        nmd_esc = parsed_data.get('nmd_escape')
        if nmd_esc is True:
            nmd = "escape (PTC near/in last exon)"
        elif nmd_esc is False:
            nmd = "predicted (frameshift → PTC in an internal coding exon)"

    return _format_unified_splice_product_html(
        product_role,
        mech,
        spliceai_ds=loss_ds,
        spliceai_dp=loss_dp,
        parsed_data=parsed_data,
        geometry='; '.join(geo),
        frame=frame,
        ptc=ptc,
        protein_length=length,
        nmd=nmd,
    )


def _splice_summary_block_html(title_html, bits):
    """One splice product per line for readable logic explanation."""
    lines = [str(b).rstrip('. ').strip() for b in (bits or []) if b]
    if not lines:
        return ""
    return f"{title_html}<br>" + "<br>".join(lines) + ".<br><br>"


def _spliceai_dp_brief(dp_val):
    """SpliceAI Δ offset as Δ+20 / Δ−2 (shared across all splice product blocks)."""
    if dp_val is None or dp_val == '':
        return ''
    try:
        n = int(dp_val)
        sign = '+' if n > 0 else ('−' if n < 0 else '')
        return f"Δ{sign}{abs(n)} bp"
    except (TypeError, ValueError):
        return f"Δ{dp_val} bp"


def _junction_canonical_dinuc_label(co):
    """Canonical splice dinucleotide at the affected junction (GT donor / AG acceptor)."""
    if not co:
        return None
    ct = (co.get('cryptic_type') or '').lower()
    geom = co.get('pseudoexon_geometry') or {}
    mech = (geom.get('mechanism') or '').lower()
    model = (geom.get('model') or '').lower()
    if co.get('pre_atg_utr_pseudoexon') or geom.get('pre_atg_utr'):
        return None
    if 'acceptor' in ct or mech == 'acceptor_gain' or geom.get('junction_proximal_acceptor'):
        return 'AG'
    if 'donor' in ct or mech == 'donor_gain' or model in ('canonical_proximal', 'nearest_intronic_ag'):
        return 'GT'
    return None


def _junction_orf_body_nt(co):
    """ORF-body nt between splice dinucleotides (excludes GT/AG splice signals)."""
    if not co:
        return None
    if co.get('orf_body_nt') is not None:
        try:
            return int(co['orf_body_nt'])
        except (TypeError, ValueError):
            pass
    geom = co.get('pseudoexon_geometry') or {}
    for key in ('shift_nt', 'body_nt'):
        raw = co.get(key) if key == 'shift_nt' else geom.get('body_nt')
        if raw is None and key == 'shift_nt':
            raw = geom.get('body_nt')
        if raw is None:
            continue
        try:
            val = int(raw)
            if val > 0:
                return val
        except (TypeError, ValueError):
            continue
    ins = co.get('inserted_cdna') or ''
    if ins:
        return len(ins)
    return None


def _junction_total_extension_nt(co):
    """
    Total junction extension incl. the canonical splice dinucleotide at the affected junction.
    ORF body excludes both splice dinucleotides; this adds back the canonical GT/AG only.
    """
    if not co or co.get('exon_skip'):
        return None
    if co.get('total_junction_extension_nt') is not None:
        try:
            return int(co['total_junction_extension_nt'])
        except (TypeError, ValueError):
            pass
    body = _junction_orf_body_nt(co)
    if body is None or body <= 0:
        return None
    if not _junction_canonical_dinuc_label(co):
        return None
    return body + 2


def _annotate_junction_extension_fields(co):
    """Stamp orf_body_nt and total_junction_extension_nt on a splice product outcome."""
    if not isinstance(co, dict):
        return co
    body = _junction_orf_body_nt(co)
    if body is not None and body > 0:
        co['orf_body_nt'] = body
        total = _junction_total_extension_nt(co)
        if total is not None and total > body:
            co['total_junction_extension_nt'] = total
    return co


def _format_junction_length_dual_label(co, *, html=True, plain=False):
    """Dual length readout: ORF body vs total junction extension incl. canonical GT/AG."""
    body = _junction_orf_body_nt(co)
    total = co.get('total_junction_extension_nt') if co else None
    if total is None and co:
        total = _junction_total_extension_nt(co)
    dinuc = _junction_canonical_dinuc_label(co) if co else None
    if body is None or body <= 0:
        return ''
    if total is None or total <= body or not dinuc:
        if html and not plain:
            return f'<b>+{body} nt</b> ORF body'
        return f'+{body} nt ORF body'
    if plain:
        return (
            f'+{body} nt ORF body (between splice dinucleotides); '
            f'+{total} nt total junction extension (incl. canonical {dinuc})'
        )
    if html:
        return (
            f'<b>+{body} nt</b> ORF body (between splice dinucleotides); '
            f'<b>+{total} nt</b> total junction extension (incl. canonical {dinuc})'
        )
    return (
        f'+{body} nt ORF body (between splice dinucleotides); '
        f'+{total} nt total junction extension (incl. canonical {dinuc})'
    )


def _junction_insert_length_clause(co, *, html=True):
    """Parenthetical length clause for junction-insert narrative lines."""
    dual = _format_junction_length_dual_label(co, html=html)
    if not dual:
        return ''
    return f"; {dual}" if html else f"; {dual}"


def _spliceai_ds_label_for_mechanism(mechanism):
    """Map mechanism string to SpliceAI DS column label."""
    m = (mechanism or '').lower()
    if 'acceptor' in m and 'loss' in m:
        return 'DS_AL'
    if 'acceptor' in m:
        return 'DS_AG'
    if 'donor' in m and 'loss' in m:
        return 'DS_DL'
    if 'donor' in m:
        return 'DS_DG'
    return 'DS'


def _spliceai_signal_line(mechanism, ds=None, dp=None, parsed_data=None):
    """
    Standard SpliceAI signal clause used at the top of every splice product block.
    e.g. acceptor loss — DS_AL 0.22 at Δ+20 bp from variant
    """
    mech = (mechanism or 'splice signal').strip()
    ds_lbl = _spliceai_ds_label_for_mechanism(mech)
    try:
        ds_f = float(ds if ds is not None else 0)
    except (TypeError, ValueError):
        ds_f = 0.0
    if parsed_data and ds_f == 0.0:
        try:
            if ds_lbl == 'DS_AG':
                ds_f = float(parsed_data.get('spliceai_ds_ag') or 0)
            elif ds_lbl == 'DS_AL':
                ds_f = float(parsed_data.get('spliceai_ds_al') or 0)
            elif ds_lbl == 'DS_DG':
                ds_f = float(parsed_data.get('spliceai_ds_dg') or 0)
            elif ds_lbl == 'DS_DL':
                ds_f = float(parsed_data.get('spliceai_ds_dl') or 0)
        except (TypeError, ValueError):
            pass
    dp_b = _spliceai_dp_brief(dp)
    bits = [f"<b>{mech}</b> — {ds_lbl} {ds_f:.2f}"]
    if dp_b:
        bits.append(f"at {dp_b} from variant")
    return ' '.join(bits)


def _format_unified_splice_product_html(
    product_role,
    mechanism,
    *,
    spliceai_ds=None,
    spliceai_dp=None,
    parsed_data=None,
    geometry=None,
    frame=None,
    junction_codon=None,
    predicted_protein=None,
    ptc=None,
    protein_length=None,
    nmd=None,
    footnote=None,
    unresolved=None,
    context_note=None,
):
    """
    Single canonical layout for every splice product (canonical junction, exon-internal,
    deep intronic pseudo-exon, whole-exon skip). Field order is fixed so logic write-ups,
    UI panels, and copy/paste all read the same way regardless of variant class.
    """
    role = (product_role or 'Product').strip()
    mech = (mechanism or 'splice alteration').strip()
    lines = [f"<b>{role} — {mech}:</b>"]

    if unresolved:
        sig = _spliceai_signal_line(mech, spliceai_ds, spliceai_dp, parsed_data)
        lines.append(f"<b>SpliceAI signal:</b> {sig}.")
        lines.append(
            f"<b>Geometry:</b> sequence-level resolver could not pinpoint the new junction "
            f"({unresolved}). Manual review of the ±30 nt window around the canonical splice site is recommended."
        )
    else:
        sig = _spliceai_signal_line(mech, spliceai_ds, spliceai_dp, parsed_data)
        lines.append(f"<b>SpliceAI signal:</b> {sig}.")

        if geometry:
            if isinstance(geometry, (list, tuple)):
                geo_body = ' '.join(str(g).rstrip('. ') for g in geometry if g)
            else:
                geo_body = str(geometry).rstrip('. ')
            lines.append(f"<b>Geometry:</b> {geo_body}.")

        if frame:
            lines.append(f"<b>Frame:</b> <b>{frame}</b>.")

        if junction_codon:
            lines.append(f"<b>Junction codon:</b> {junction_codon.rstrip('. ')}.")

        if predicted_protein:
            lines.append(f"<b>Predicted protein:</b> {predicted_protein.rstrip('. ')}.")

        if ptc:
            lines.append(f"<b>Premature termination:</b> {ptc.rstrip('. ')}.")

        if protein_length:
            lines.append(f"<b>Protein length:</b> {protein_length.rstrip('. ')}.")

        if nmd:
            nmd_body = str(nmd).rstrip('. ')
            if nmd_body.lower().startswith('nmd:'):
                nmd_body = nmd_body[4:].strip()
            elif nmd_body.lower().startswith('<b>nmd'):
                import re as _re_nmd
                nmd_body = _re_nmd.sub(r'^<b>NMD:?\s*</b>\s*', '', nmd_body, flags=_re_nmd.I).strip()
            lines.append(f"<b>NMD:</b> {nmd_body}.")

        if footnote:
            lines.append(
                f"<span style='color:#a7f3d0;font-size:0.92em'>{footnote.rstrip('. ')}.</span>"
            )

    if context_note:
        lines.append(
            f"<span style='color:#94a3b8;font-size:0.88em'>{context_note.rstrip('. ')}.</span>"
        )
    else:
        lines.append(
            "<span style='color:#94a3b8;font-size:0.88em'>"
            "Computational splice model only — not RNA/minigene evidence."
            "</span>"
        )
    return '<br>'.join(lines) + '<br><br>'


def _splice_frame_math_has_product_summaries(html):
    s = html or ''
    return any(
        token in s
        for token in (
            'Gain product', 'Loss product', 'Splice gain', 'Splice loss',
            'SpliceAI signal:', 'Product 1', 'Product 2',
        )
    )


def _logic_should_show_deep_intronic_context(parsed_data, c_dot):
    di = parsed_data.get('deep_intronic_splice') or {}
    if not di.get('eligible'):
        return False
    if parsed_data.get('deep_intronic_splice_products_active'):
        return False
    cons = (parsed_data.get('consequence') or '').lower()
    if 'splice_acceptor' in cons or 'splice_donor' in cons:
        return False
    if _canonical_splice_junction_from_hgvs(c_dot):
        return False
    co = parsed_data.get('cryptic_splice_outcome') or {}
    if co.get('canonical_junction_dup_model'):
        return False
    return True


def _build_inframe_preserved_stop_outcome(
    cryptic_type,
    shift_nt,
    inserted_cdna,
    first_new_codon_str,
    first_changed_codon_idx,
    preserved_stop_codon_idx,
    gain_signal,
    loss_signal,
    mutant_cds,
    edit_anchor,
    parsed_data,
):
    """
    Build a cryptic_splice_outcome dict for the case where the cryptic event is in-frame
    and the WT terminator is preserved (just shifted). This is NOT a PTC; the spliced ORF
    encodes the same C-terminal ending plus/minus a small in-frame indel of N/3 amino acids
    (e.g. TRAF7 c.1387-4T>G with a 3-bp CAG insert ⇒ +1 Gln, native stop at p.Ter672 instead
    of p.Ter671). Returns a dict that downstream consumers can render without invoking the
    truncation/NMD pathway.
    """
    n = len(inserted_cdna or "")
    n_codons_changed = (n // 3) if (shift_nt is not None and shift_nt > 0) else \
                       -(abs(shift_nt) // 3) if (shift_nt is not None and shift_nt < 0) else 0

    gain_block_html, gain_plain = _format_splice_gain_insert_explain(
        inserted_cdna,
        first_new_codon_str,
        mutant_cds=mutant_cds,
        edit_anchor=edit_anchor,
    )

    preserved_stop_aa_pos = preserved_stop_codon_idx + 1
    direction = "shifted +" if n_codons_changed > 0 else ("shifted -" if n_codons_changed < 0 else "at the same position as")
    abs_codons = abs(n_codons_changed)
    codon_word = "codon" if abs_codons == 1 else "codons"
    aa_word = "amino acid" if abs_codons == 1 else "amino acids"

    if n_codons_changed > 0:
        change_phrase = (
            f"the in-frame insert adds <b>+{n_codons_changed}</b> {aa_word} to the protein "
            f"and pushes the native terminator downstream by {abs_codons} {codon_word}"
        )
        net_aa_change = f"+{n_codons_changed}"
    elif n_codons_changed < 0:
        change_phrase = (
            f"the in-frame deletion removes <b>{abs_codons}</b> {aa_word} from the protein "
            f"and pulls the native terminator upstream by {abs_codons} {codon_word}"
        )
        net_aa_change = f"-{abs_codons}"
    else:
        change_phrase = "the cryptic event is silent at the protein level"
        net_aa_change = "0"

    narrative = (
        (gain_block_html or "")
        + f"<b>{cryptic_type}</b> ({'+' if (shift_nt or 0) > 0 else ''}{shift_nt} nt vs canonical; "
        f"SpliceAI gain {gain_signal:.2f}, loss {loss_signal:.2f}). "
        f"<b>In-frame &mdash; native terminator preserved</b> at <b>p.Ter{preserved_stop_aa_pos}</b> "
        f"({direction}{abs_codons} {codon_word} relative to the WT stop). "
        f"Effect: {change_phrase}. "
        f"<b>No truncation</b>; NMD pathway does not apply (no premature stop). "
        f"This is a small in-frame protein-length change, not a loss-of-function truncation."
    )

    return {
        'shift_nt': shift_nt,
        'inserted_cdna': inserted_cdna or '',
        'insert_triplet_decode': gain_plain,
        'cryptic_type': cryptic_type,
        'in_frame_shift': True,
        'first_new_codon': first_new_codon_str,
        'natural_stop_preserved': True,
        'preserved_stop_aa_pos': preserved_stop_aa_pos,
        'net_aa_change': net_aa_change,
        'gain_signal': gain_signal,
        'loss_signal': loss_signal,
        # Truncation fields are intentionally omitted so downstream NMD/truncation
        # consumers won't mis-classify this as a loss-of-function event.
        'narrative': narrative,
    }


def _splice_gain_spliceai_lead_html(cryptic_type, parsed_data):
    """
    Opening clause parallel to loss summary's 'canonical site abolished (SpliceAI loss X)'.
    Uses DS_AG / DS_DG when transcript-level parsed_data is available.
    """
    if not parsed_data:
        return ""
    ct = (cryptic_type or "").lower()
    try:
        ag = float(parsed_data.get("spliceai_ds_ag") or 0)
        dg = float(parsed_data.get("spliceai_ds_dg") or 0)
    except (TypeError, ValueError):
        ag = dg = 0.0
    if "acceptor" in ct:
        return (
            f"cryptic 3&prime; splice acceptor strengthened vs canonical junction "
            f"(SpliceAI DS_AG {ag:.2f}) &rarr; alternative splice geometry"
        )
    if "donor" in ct:
        return (
            f"cryptic 5&prime; splice donor strengthened vs canonical junction "
            f"(SpliceAI DS_DG {dg:.2f}) &rarr; alternative splice geometry"
        )
    return ""


def _splice_variant_intro_is_complete(parsed_data):
    """True when the one-line splice intro already states the primary product."""
    if parsed_data.get('deep_intronic_splice_products_active'):
        # Multi-product deep-intronic: one-line cryptic primary must not suppress alternate.
        if (parsed_data.get('deep_intronic_alternate_splice_math') or '').strip():
            return False
        if (parsed_data.get('deep_intronic_alternate2_splice_math') or '').strip():
            return False
    co = parsed_data.get('cryptic_splice_outcome') or {}
    if parsed_data.get('cryptic_natural_stop_preserved'):
        return True
    if (
        parsed_data.get('spliceai_junction_model_preferred')
        and co
        and not co.get('minimal_signal')
        and co.get('shift_nt') is not None
    ):
        return True
    if parsed_data.get('exon_skip_oof_fs_ter') and not parsed_data.get('spliceai_junction_model_preferred'):
        return True
    if parsed_data.get('splice_is_in_frame') and (parsed_data.get('splice_frame_math') or '').strip():
        return True
    return False


def _build_splice_variant_intro_short(parsed_data, gene, c_dot):
    """
    One-line Logic Explanation opener for splice variants.
    Uses resolved junction / exon-skip geometry — not stale SnpEff exon ranks.
    """
    vex = parsed_data.get('variant_exon')
    vex_s = str(vex) if vex is not None else '?'
    c_dot_s = (c_dot or parsed_data.get('c_dot') or '').strip()
    cons = (parsed_data.get('consequence') or '').strip()
    if _consequence_is_acceptor_splice(cons, c_dot_s):
        site = f"acceptor-side splice variant at exon {vex_s}"
    elif _consequence_is_donor_splice(cons, c_dot_s):
        site = f"donor-side splice variant at exon {vex_s}"
    else:
        site = f"splice variant at exon {vex_s}"

    if parsed_data.get('deep_intronic_splice_products_active'):
        plan = parsed_data.get('deep_intronic_spliceai_signal_plan') or {}
        pri_l = _deep_intronic_signal_label(plan.get('primary') or {})
        alt_l = _deep_intronic_signal_label(plan.get('alternate') or {})
        alt_co = parsed_data.get('deep_intronic_alternate_outcome') or {}
        alt_bits = []
        if alt_l:
            if alt_co.get('in_frame_shift') and not alt_co.get('ptc_aa_position'):
                alt_bits.append(f"alternate <b>in-frame</b> {alt_l}")
            else:
                alt_bits.append(f"alternate {alt_l}")
        product_bits = []
        if pri_l:
            product_bits.append(f"primary {pri_l}")
        product_bits.extend(alt_bits)
        products = '; '.join(product_bits) if product_bits else 'multiple splice products'
        return (
            f"{gene} {c_dot_s} → deep intronic {site}; SpliceAI {products} "
            f"(details in <b>Deep intronic splice</b> and <b>Splice products</b> below)."
        )

    co = parsed_data.get('cryptic_splice_outcome') or {}
    cryptic_resolved = bool(
        co and not co.get('minimal_signal') and co.get('shift_nt') is not None
    )
    junction_primary = bool(parsed_data.get('spliceai_junction_model_preferred'))

    if parsed_data.get('cryptic_natural_stop_preserved'):
        return (
            f"{gene} {c_dot_s} → {site}; predicted <b>in-frame</b> splice product "
            f"preserving the native stop codon."
        )

    if cryptic_resolved and junction_primary:
        in_frame = bool(co.get('in_frame_shift')) and not co.get('ptc_aa_position')
        hgvs_p = (
            (co.get('fs_ter_str') or '').strip()
            or (parsed_data.get('cryptic_splice_ptc') or '').strip()
            or (parsed_data.get('junction_model_hgvs_p') or '').strip()
        )
        ctype = (co.get('cryptic_type') or 'Cryptic splice').lower()
        if 'acceptor' in ctype:
            product = 'cryptic acceptor gain'
        elif 'donor' in ctype:
            product = 'cryptic donor gain'
        else:
            product = 'cryptic splice product'
        hp = f" ({hgvs_p})" if hgvs_p else ''
        if in_frame:
            return f"{gene} {c_dot_s} → {site}; predicted <b>in-frame</b> {product}{hp}."
        return (
            f"{gene} {c_dot_s} → {site}; predicted <b>out-of-frame</b> {product} "
            f"with new PTC{hp}."
        )

    oof_ter = (parsed_data.get('exon_skip_oof_fs_ter') or '').strip()
    if oof_ter:
        hp = f" ({oof_ter})"
        return (
            f"{gene} {c_dot_s} → {site}; predicted <b>out-of-frame</b> whole-exon skip "
            f"with new PTC{hp}."
        )

    if parsed_data.get('splice_is_in_frame') and (parsed_data.get('splice_frame_math') or '').strip():
        return (
            f"{gene} {c_dot_s} → {site}; predicted <b>in-frame</b> exon skip "
            f"(internal deletion; no novel PTC)."
        )

    if parsed_data.get('is_splice_frameshift'):
        return (
            f"{gene} {c_dot_s} → {site}; predicted splice-mediated "
            f"<b>out-of-frame</b> loss-of-function product."
        )

    if _logic_csq_is_splice_context(cons, parsed_data):
        return f"{gene} {c_dot_s} → {site}."

    return ''


def _build_splice_gain_summary_html(co, parsed_data=None, product_role='Product 1 (gain / cryptic junction)'):
    """
    Build a compact HTML block summarizing the splice-gain math from a resolved
    cryptic_splice_outcome dict. Designed to be prepended to splice_frame_math so the
    bp / amino-acid / frame / phase math sits right next to the exon-skip baseline.

    Cases:
      - co is missing/empty                     → returns "" (no SpliceAI gain context to show)
      - co.minimal_signal == True               → returns a "gain detected but resolver bailed" block
                                                  with the scores and the bail-out reason from the
                                                  narrative, so the user is never left wondering why
                                                  the math is missing.
      - co has a real shift / inserted_cdna     → full gain math (bp, frame, phase, junction codons)

    parsed_data: optional; used to echo DS_AG / DS_DG in the opening clause (parallel to loss summaries).
    """
    if not co:
        return ""
    cryptic_type = (co.get('cryptic_type') or 'Cryptic gain').lower()
    is_junction_dup = bool(co.get('canonical_junction_dup_model'))

    if co.get('minimal_signal'):
        gs = co.get('gain_signal')
        ls = co.get('loss_signal')
        narrative = co.get('narrative', '') or ''
        reason = ''
        try:
            import re as _re
            m = _re.search(r"could not resolve the new splice geometry\s*\(([^()]+)\)", narrative)
            if m:
                reason = m.group(1).strip()
        except Exception:
            reason = ''
        try:
            gain_ds = float(gs or 0)
        except (TypeError, ValueError):
            gain_ds = 0.0
        gain_dp = None
        if parsed_data:
            if 'acceptor' in cryptic_type:
                gain_dp = parsed_data.get('spliceai_dp_ag')
            elif 'donor' in cryptic_type:
                gain_dp = parsed_data.get('spliceai_dp_dg')
        return _format_unified_splice_product_html(
            product_role,
            cryptic_type,
            spliceai_ds=gain_ds,
            spliceai_dp=gain_dp,
            parsed_data=parsed_data,
            unresolved=reason or f'gain {gain_ds:.2f}, loss {float(ls or 0):.2f}',
        )

    shift_nt = co.get('shift_nt')
    ins = co.get('inserted_cdna') or ''
    n = len(ins)
    decode_plain = co.get('insert_triplet_decode') or ''
    in_frame = co.get('in_frame_shift')
    fs_ter = co.get('fs_ter_str') or ''
    no_stop = bool(co.get('no_stop_found'))
    nat_stop_preserved = bool(co.get('natural_stop_preserved'))
    preserved_stop_aa_pos = co.get('preserved_stop_aa_pos')
    net_aa_change = co.get('net_aa_change')

    if nat_stop_preserved:
        bits = []
        if shift_nt is not None:
            try:
                sh = int(shift_nt)
                dual = _format_junction_length_dual_label(co)
                if dual and sh > 0:
                    bits.append(f"net junction shift {dual}")
                else:
                    bits.append(f"net junction shift {'+' if sh > 0 else ''}{sh} nt")
            except (TypeError, ValueError):
                pass
        if n:
            bits.append(f"insert <code>{ins}</code> ({n} bp)")
        bits.append("<b>in-frame</b>")
        if net_aa_change is not None:
            bits.append(f"net protein length change <b>{net_aa_change} aa</b>")
        if preserved_stop_aa_pos is not None:
            bits.append(
                f"<b>native terminator preserved</b> at <b>p.Ter{preserved_stop_aa_pos}</b>"
            )
        bits.append("<b>no truncation; NMD does not apply</b>")
        lead = _splice_gain_spliceai_lead_html(cryptic_type, parsed_data)
        if lead:
            bits.insert(0, lead)
        return _co_gain_bits_to_unified_html(
            co, parsed_data, cryptic_type, bits, decode_plain,
            product_role=product_role,
        )

    bits = []
    if is_junction_dup:
        site_lbl = (co.get('canonical_junction_site_label') or 'junction dup').strip()
        gain_title = f"<b>Gain product ({cryptic_type}, {site_lbl}):</b>"
        bits.append(
            "Duplicated intronic sequence retained at the canonical splice junction "
            "(parallel to whole-exon skip from site loss)."
        )
    else:
        gain_title = f"<b>Gain product ({cryptic_type}):</b>"
        lead = _splice_gain_spliceai_lead_html(cryptic_type, parsed_data)
        if lead:
            bits.append(lead)
    if shift_nt is not None or n:
        ins_bits = []
        if shift_nt is not None:
            try:
                sh = int(shift_nt)
                dual = _format_junction_length_dual_label(co)
                if dual and sh > 0:
                    ins_bits.append(dual)
                elif sh != 0:
                    ins_bits.append(f"{'+' if sh > 0 else ''}{sh} nt")
            except (TypeError, ValueError):
                pass
        if n:
            ins_bits.append(f"<code>{ins}</code> ({n} bp)")
        if ins_bits:
            frame_note = ""
            if in_frame is False:
                frame_note = " → <b>out-of-frame</b> frameshift downstream of the new splice site"
            elif in_frame is True:
                frame_note = " → <b>in-frame</b> junction shift"
            bits.append(f"Junction insert: {'; '.join(ins_bits)}{frame_note}.")
    elif in_frame is True:
        bits.append("<b>in-frame junction shift</b>")
    elif in_frame is False:
        bits.append(
            "<b>out-of-frame junction shift</b> &rarr; frameshift downstream of the new splice site"
        )

    ptc_exon_rank_local = co.get('ptc_exon_rank')
    last_coding_rank_local = co.get('last_coding_rank')
    nmd_escape_local = co.get('nmd_escape')

    if not no_stop and fs_ter:
        ptc_aa_pos = co.get('ptc_aa_position')
        ptc_core = f"<b>PTC in the junction-product ORF</b>: <b>{fs_ter}</b>"
        loc = co.get('ptc_location_label')
        detail = co.get('ptc_location_detail')
        if loc:
            ptc_core += f" — <b>Location:</b> {loc}"
            if detail:
                ptc_core += f" ({detail})"
        elif ptc_exon_rank_local is not None:
            if last_coding_rank_local is not None:
                ptc_core += f", novel stop in <b>exon {ptc_exon_rank_local}</b> of {last_coding_rank_local}"
            else:
                ptc_core += f", novel stop in <b>exon {ptc_exon_rank_local}</b>"
        if ptc_aa_pos is not None and not loc:
            try:
                ptc_core += f" (≈aa {int(ptc_aa_pos)} before termination in the re-read ORF)"
            except (TypeError, ValueError):
                pass
        bits.append(ptc_core)
        try:
            tlen = co.get('truncated_protein_length')
            full_len = co.get('full_protein_length')
            esfrac = co.get('truncation_fraction')
            if (not full_len or not esfrac) and parsed_data:
                try:
                    plen = int(parsed_data.get('protein_length') or 0)
                except (TypeError, ValueError):
                    plen = 0
                if plen > 0 and tlen is not None:
                    full_len = full_len or plen
                    esfrac = esfrac if esfrac is not None else round(
                        max(0.0, (plen - int(tlen)) / float(plen)), 4
                    )
            if tlen is not None and full_len is not None and esfrac is not None:
                pct_ct = round(float(esfrac) * 100.0, 1)
                bits.append(
                    f"<b>Truncated protein (junction-product ORF)</b>: &asymp; <b>{int(tlen)} aa</b> "
                    f"(of <b>{int(full_len)}</b>; <b>{pct_ct}%</b> C-terminus lost vs full-length reference)."
                )
            elif tlen is not None:
                bits.append(
                    f"<b>Truncated protein (junction-product ORF)</b>: &asymp; <b>{int(tlen)} aa</b>"
                )
        except (TypeError, ValueError):
            pass
        if nmd_escape_local is True:
            esc_detail = (co.get('nmd_reason') or 'PTC near/in last exon').strip()
            bits.append(f"<b>NMD: escape</b> — {esc_detail}")
        elif nmd_escape_local is False:
            bits.append("<b>NMD: predicted</b> (internal exon PTC).")
    elif no_stop:
        bits.append("no premature stop in the re-read ORF")

    return _co_gain_bits_to_unified_html(
        co, parsed_data, cryptic_type, bits, decode_plain,
        product_role=product_role,
    )


def _co_gain_bits_to_unified_html(co, parsed_data, cryptic_type, bits, decode_plain='', product_role='Product 1 (gain / cryptic junction)'):
    """Map resolved cryptic_splice_outcome fields to the shared splice product layout."""
    ct = (cryptic_type or 'cryptic gain').lower()
    mech = f"canonical junction {ct}"
    try:
        if 'acceptor' in ct:
            gain_ds = float((parsed_data or {}).get('spliceai_ds_ag') or co.get('gain_signal') or 0)
            gain_dp = (parsed_data or {}).get('spliceai_dp_ag')
        else:
            gain_ds = float((parsed_data or {}).get('spliceai_ds_dg') or co.get('gain_signal') or 0)
            gain_dp = (parsed_data or {}).get('spliceai_dp_dg')
    except (TypeError, ValueError):
        gain_ds = 0.0
        gain_dp = None

    geo = '; '.join(
        str(b).replace('<b>', '').replace('</b>', '')
        for b in (bits or []) if b and 'NMD' not in str(b) and 'PTC' not in str(b) and 'Truncated' not in str(b)
    )
    in_frame = co.get('in_frame_shift')
    frame = 'in-frame' if in_frame is True else ('out-of-frame' if in_frame is False else None)
    fs_ter = co.get('fs_ter_str') or ''
    ptc = fs_ter if fs_ter and not co.get('no_stop_found') else ''
    length = ''
    try:
        tlen = co.get('truncated_protein_length')
        plen = co.get('full_protein_length') or (parsed_data or {}).get('protein_length')
        plen = int(plen) if plen else 0
        if tlen is not None and plen > 0:
            pct = co.get('truncation_pct')
            if pct is None:
                pct = round(max(0.0, (plen - int(tlen)) / float(plen)) * 100.0, 1)
            length = f"truncated ≈ {int(tlen)}/{plen} aa ({float(pct):.1f}% C-terminus lost vs full-length reference)"
    except (TypeError, ValueError):
        pass
    nmd = ''
    if co.get('natural_stop_preserved') or co.get('nmd_escape') is True:
        nmd = co.get('nmd_reason') or 'escape — native terminator preserved or PTC near/in last exon'
    elif co.get('nmd_escape') is False:
        nmd = 'predicted (internal exon PTC)'
    elif co.get('no_stop_found'):
        nmd = 'not assessed — no premature stop in re-read ORF before native stop'

    footnote = f"Junction codons: {decode_plain}" if decode_plain else None
    return _format_unified_splice_product_html(
        product_role,
        mech,
        spliceai_ds=gain_ds,
        spliceai_dp=gain_dp,
        parsed_data=parsed_data,
        geometry=geo or None,
        frame=frame,
        predicted_protein=fs_ter if co.get('natural_stop_preserved') else None,
        ptc=ptc,
        protein_length=length or None,
        nmd=nmd or None,
        footnote=footnote,
    )


def _format_splice_gain_insert_explain(
    inserted_cdna,
    first_new_codon_str=None,
    mutant_cds=None,
    edit_anchor=None,
):
    """
    Explicit, exon-phase-aware gain math for ANY resolved splice donor/acceptor insert.

    Steps reported:
      1) bp count (n)
      2) frame call: n mod 3 (0 → in-frame, 1/2 → out-of-frame, frameshift +R nt)
      3) exon phase at the new splice (only when mutant_cds + edit_anchor are supplied):
           phase 0 → intron between codons; insert begins at codon position 1
           phase 1 → intron splits codon 1|2 (prev exon contributes 1 nt to the junction codon)
           phase 2 → intron splits codon 2|1 (prev exon contributes 2 nt to the junction codon)
      4) the actual junction codons read from the spliced mRNA, with each codon's
         composition annotated (e.g. "1 nt prev exon + 2 nt insert"). This is what makes
         the math correct when the exon's first nt is not at codon position 1.

    Returns (html_block, plain_one_liner). Both are empty/None when there is no insert.
    """
    ins = (inserted_cdna or "").upper()
    n = len(ins)
    if n == 0:
        return "", None

    phase = None
    phase_text = ""
    if mutant_cds is not None and edit_anchor is not None and edit_anchor >= 0:
        phase = edit_anchor % 3
        phase_label = {
            0: "phase 0 (intron between codons; insert begins at codon position 1)",
            1: "phase 1 (intron splits codon 1|2; previous exon contributes 1 nt to the junction codon)",
            2: "phase 2 (intron splits codon 2|1; previous exon contributes 2 nt to the junction codon)",
        }[phase]
        phase_text = f" Exon phase at the new splice: {phase_label}."

    rem = n % 3

    junction_html = ""
    junction_plain = ""
    if mutant_cds is not None and edit_anchor is not None and phase is not None:
        num_overlap = (phase + n + 2) // 3  # ceil((phase + n) / 3) codons that contain ≥1 inserted nt
        start_cod_idx = edit_anchor // 3
        lines_html = []
        lines_plain = []
        max_jc = MAX_JUNCTION_CODON_DECODE
        for k in range(num_overlap):
            if k >= max_jc:
                omitted = num_overlap - max_jc
                if omitted > 0:
                    tail = f"; … +{omitted} more junction codon{'s' if omitted != 1 else ''} omitted"
                    lines_plain.append(tail.lstrip('; '))
                    lines_html.append(
                        f"<li style='color:#94a3b8;'>… +{omitted} more junction codon"
                        f"{'s' if omitted != 1 else ''} omitted (detail capped at {max_jc})</li>"
                    )
                break
            cod_start = (start_cod_idx + k) * 3
            codon = mutant_cds[cod_start:cod_start + 3]
            if len(codon) != 3:
                break
            aa1, aa3 = _decode_cds_triplet(codon)
            ins_lo = max(0, edit_anchor - cod_start)
            ins_hi = max(0, min(3, edit_anchor + n - cod_start))
            pre_n = ins_lo
            ins_n = max(0, ins_hi - ins_lo)
            post_n = max(0, 3 - ins_lo - ins_n)
            comp_pieces = []
            if pre_n:
                comp_pieces.append(f"{pre_n} nt prev exon")
            if ins_n:
                comp_pieces.append(f"{ins_n} nt insert")
            if post_n:
                comp_pieces.append(f"{post_n} nt next exon")
            comp = " + ".join(comp_pieces) if comp_pieces else "—"
            aa_pos = start_cod_idx + k + 1
            lines_html.append(
                f"<li>aa {aa_pos}: <code>{codon}</code> &rarr; <b>{aa3 or 'Xaa'}</b> "
                f"({aa1 or 'X'}) <span style='color:#94a3b8;'>[{comp}]</span></li>"
            )
            lines_plain.append(f"aa{aa_pos} {codon}→{aa3 or 'Xaa'}({aa1 or 'X'}) [{comp}]")
        if lines_html:
            junction_html = (
                "Junction codons read from the spliced mRNA:"
                "<ul style='margin:4px 0 4px 18px;padding-left:0;'>"
                + "".join(lines_html) + "</ul>"
            )
            junction_plain = "junction codons: " + "; ".join(lines_plain)

    if rem == 0:
        n_codons_added = n // 3
        codon_word = "codon" if n_codons_added == 1 else "codons"
        aa_word = "amino acid" if n_codons_added == 1 else "amino acids"

        if junction_html:
            html = (
                f"<b>Gain math:</b> {n} bp inserted; {n} mod 3 = 0 &rarr; <b>in-frame</b> "
                f"(net +{n_codons_added} {codon_word} / +{n_codons_added} {aa_word} downstream)."
                f"{phase_text} {junction_html}<br>"
            )
            plain = (
                f"{n} bp inserted (in-frame, net +{n_codons_added} {codon_word}); "
                f"phase {phase}; {junction_plain}."
            )
            return html, plain

        # Fallback when mutant_cds/edit_anchor are unavailable: decode the insert as triplets
        # (assumes phase 0; the narrative flags this assumption).
        triplets = [ins[i:i + 3] for i in range(0, n, 3)]
        decoded = [_decode_cds_triplet(t) for t in triplets]
        aa1_seq = "".join((d[0] or "X") for d in decoded)
        show_triplets = triplets[:MAX_JUNCTION_CODON_DECODE]
        show_decoded = decoded[:MAX_JUNCTION_CODON_DECODE]
        aa3_pairs_html = ", ".join(
            f"<code>{t}</code>&rarr;<b>{d[1] or 'Xaa'}</b> ({d[0] or 'X'})"
            for t, d in zip(show_triplets, show_decoded)
        )
        aa3_pairs_plain = ", ".join(
            f"{t}→{d[1] or 'Xaa'} ({d[0] or 'X'})" for t, d in zip(show_triplets, show_decoded)
        )
        if len(triplets) > MAX_JUNCTION_CODON_DECODE:
            extra = len(triplets) - MAX_JUNCTION_CODON_DECODE
            aa3_pairs_html += f", … +{extra} more codon{'s' if extra != 1 else ''} omitted"
            aa3_pairs_plain += f", … +{extra} more codons omitted"
        cross = ""
        if n == 3 and first_new_codon_str and str(first_new_codon_str).upper() != ins:
            cross = (
                f" Note: first ORF codon from the boundary scan is <b>{first_new_codon_str}</b> "
                f"(can differ if the junction re-phases the downstream exon); the "
                f"<b>inserted intronic segment</b> is still <code>{ins}</code>."
            )
        html = (
            f"<b>Gain math:</b> {n} bp inserted; {n} mod 3 = 0 &rarr; <b>in-frame</b> "
            f"({n_codons_added} {codon_word}, {n_codons_added} extra {aa_word} at the new splice; "
            f"phase-0 boundary assumed). Triplet decode: {aa3_pairs_html}. "
            f"Inserted peptide: <b>p.({aa1_seq})</b>.{cross}<br><br>"
        )
        plain = (
            f"{n} bp inserted (in-frame, {n_codons_added} {codon_word}, phase-0 assumed); "
            f"{aa3_pairs_plain}; inserted peptide p.({aa1_seq})."
        )
        return html, plain

    # Out-of-frame insert: net frameshift of +rem nt downstream → expected PTC.
    if junction_html:
        html = (
            f"<b>Gain math:</b> {n} bp inserted; {n} mod 3 = {rem} &rarr; <b>out-of-frame</b> "
            f"(net frameshift of +{rem} nt downstream of the new splice).{phase_text} "
            f"{junction_html} The re-read ORF is expected to encounter a premature termination "
            f"codon (PTC); see the truncation block below for the predicted stop and NMD call.<br>"
        )
        if num_overlap > max_jc:
            plain = (
                f"{n} bp inserted (out-of-frame, +{rem} nt frameshift); phase {phase}; "
                f"junction spans ~{num_overlap} codons → expected PTC in the re-read ORF."
            )
        else:
            plain = (
                f"{n} bp inserted (out-of-frame, +{rem} nt frameshift); phase {phase}; "
                f"{junction_plain} → expected PTC in the re-read ORF."
            )
        return html, plain

    html = (
        f"<b>Gain math:</b> {n} bp inserted; {n} mod 3 = {rem} &rarr; <b>out-of-frame</b> "
        f"(net frameshift of +{rem} nt at the new splice). The downstream ORF is re-read in a "
        f"new frame and is expected to encounter a premature termination codon (PTC); see the "
        f"truncation block below for the predicted stop and NMD call.<br><br>"
    )
    plain = (
        f"{n} bp inserted (out-of-frame, +{rem} nt frameshift) → expected PTC in the re-read ORF."
    )
    return html, plain


def _revcomp(s):
    comp = str.maketrans("ACGTacgtNn", "TGCAtgcaNn")
    return s.translate(comp)[::-1]


def _fetch_plus_strand_sequence(http_session, chrom, start, end, *, timeout=45):
    """
    Fetch plus-strand DNA for an inclusive GRCh38 interval.

    Tries Ensembl REST first, then UCSC as fallback (Ensembl outages otherwise
    collapse cryptic-splice math to a generic ±30 nt failure message).
    Returns uppercase sequence or None.
    """
    try:
        lo = int(start)
        hi = int(end)
    except (TypeError, ValueError):
        return None
    if hi < lo or lo < 1:
        return None
    c_raw = str(chrom or '').strip()
    if not c_raw:
        return None
    c_clean = c_raw.replace('chr', '').replace('CHR', '').strip()
    c_chr = c_clean if c_clean.startswith('chr') else f'chr{c_clean}'

    ensembl_urls = [
        f"https://rest.ensembl.org/sequence/region/human/{c_clean}:{lo}..{hi}:1?content-type=text/plain",
        f"https://rest.ensembl.org/sequence/region/human/{c_clean}:{lo}-{hi}?content-type=text/plain",
    ]
    for url in ensembl_urls:
        try:
            resp = http_session.get(url, timeout=timeout)
            if getattr(resp, 'status_code', 0) == 200:
                seq = (getattr(resp, 'text', None) or '').strip().replace('\n', '').replace('\r', '')
                if seq and not seq.lstrip().startswith('<') and all(
                    ch in 'ACGTacgtN' for ch in seq[:20]
                ):
                    return seq.upper()
        except Exception as exc:
            print(f"[seq-fetch] Ensembl failed ({url}): {exc}", flush=True)

    # UCSC API uses 0-based half-open coordinates.
    ucsc_url = (
        "https://api.genome.ucsc.edu/getData/sequence"
        f"?genome=hg38&chrom={c_chr}&start={lo - 1}&end={hi}"
    )
    try:
        resp = http_session.get(ucsc_url, timeout=timeout)
        if getattr(resp, 'status_code', 0) != 200:
            print(f"[seq-fetch] UCSC HTTP {getattr(resp, 'status_code', '?')}", flush=True)
            return None
        payload = None
        try:
            payload = resp.json()
        except Exception:
            text = (getattr(resp, 'text', None) or '').strip()
            if text and not text[:1] in '{[':
                return text.replace('\n', '').upper()
            return None
        dna = (payload or {}).get('dna') or ''
        dna = str(dna).strip().replace('\n', '').replace('\r', '')
        if dna:
            print(f"[seq-fetch] UCSC fallback ok ({c_chr}:{lo}-{hi}, {len(dna)} bp)", flush=True)
            return dna.upper()
    except Exception as exc:
        print(f"[seq-fetch] UCSC failed: {exc}", flush=True)
    return None


def _normalize_to_forward_strand(http_session, chrom, pos, ref_a, alt_a, end_pos=None):
    """
    Force ref/alt onto the forward genomic strand.

    VEP's allele_string is reported on whatever orientation the *input* uses.
    For an HGVS query on a minus-strand transcript (e.g. SYNE1 c.A>G), VEP
    returns transcript-strand alleles even though SpliceAI / our resolver
    require forward-genomic-strand alleles. We verify ref against the actual
    genomic reference base and revcomp both alleles if needed.

    Returns (ref_forward, alt_forward, was_flipped) for SNVs. For indels or
    on lookup failure, returns the inputs unchanged.
    """
    try:
        if not ref_a or not alt_a:
            return ref_a, alt_a, False
        # Only normalize SNVs — indels need different handling and VEP
        # already reports indels on the forward strand for HGVS-c input.
        if len(ref_a) != 1 or len(alt_a) != 1:
            return ref_a, alt_a, False
        if not chrom or not pos:
            return ref_a, alt_a, False
        c_clean = str(chrom).replace('chr', '').strip()
        p = int(pos)
        url = f"https://rest.ensembl.org/sequence/region/human/{c_clean}:{p}-{p}?content-type=text/plain"
        resp = http_session.get(url, timeout=15)
        if resp.status_code != 200:
            return ref_a, alt_a, False
        genomic_ref = resp.text.strip().upper()
        if not genomic_ref or len(genomic_ref) != 1:
            return ref_a, alt_a, False
        ref_u = ref_a.upper()
        alt_u = alt_a.upper()
        if genomic_ref == ref_u:
            return ref_u, alt_u, False
        rc_ref = _revcomp(ref_u)
        rc_alt = _revcomp(alt_u)
        if genomic_ref == rc_ref:
            print(f"[strand-norm] flipped allele orientation at chr{c_clean}:{p}: {ref_u}/{alt_u} -> {rc_ref}/{rc_alt} (forward-strand ref={genomic_ref})")
            return rc_ref, rc_alt, True
        print(f"[strand-norm] WARNING: neither {ref_u} nor revcomp {rc_ref} matches forward genomic {genomic_ref} at chr{c_clean}:{p}")
        return ref_u, alt_u, False
    except Exception as e:
        print(f"[strand-norm] error: {e}")
        return ref_a, alt_a, False


def _splice_cdna_anchor_from_hgvs(c_dot, cons_splice):
    """
    Intronic cDNA: do not use the *first* c.(digits) in a range — use the anchor next to the intron.
    c.N-kT>G (3' to intron): N is the *first* base of the 3' exon at that acceptor — whole-exon skip
    should delete that exon, not the 5' neighbor (e.g. TRAF7 c.1387-4 → exon 16, not 15).
    c.N+k (5' to intron): N is the last base of the 5' exon; 3' exon is the next coding exon.
    """
    s = (c_dot or "").replace(" ", "")
    s_low = s.lower()
    cons = (cons_splice or "")
    m_minus = re.search(r'c\.(-?\d+)\s*-\s*', s_low)  # c.1387-4, c.-37-1; not c.5_10del
    m_plus = re.search(r'c\.(-?\d+)\s*\+', s_low)  # c.1234+5, not delins if only single site
    if 'splice_acceptor' in cons and m_minus:
        return int(m_minus.group(1))
    if 'splice_donor' in cons and m_plus and not m_minus:
        return int(m_plus.group(1))
    if m_minus:
        return int(m_minus.group(1))
    if m_plus and not m_minus:
        return int(m_plus.group(1))
    m0 = re.search(r'c\.(-?\d+)', s_low, re.I)
    return int(m0.group(1)) if m0 else 0


def _apply_pre_atg_splice_acceptor_context(parsed_data, c_dot, cons):
    """5′-UTR / pre-ATG canonical acceptor (e.g. c.-37-1G>T): splice impact, not coding PTC/NMD."""
    if not _consequence_is_acceptor_splice(cons, c_dot):
        return
    try:
        anc = int(_splice_cdna_anchor_from_hgvs(c_dot, cons) or 0)
    except (TypeError, ValueError):
        return
    if anc >= 1:
        return
    parsed_data['pre_atg_splice_acceptor'] = True
    if not parsed_data.get('variant_exon') and parsed_data.get('snpeff_exon_rank'):
        parsed_data['variant_exon'] = parsed_data['snpeff_exon_rank']
    note = (
        "<b>Pre-ATG / 5′-UTR acceptor:</b> canonical acceptor change before the start codon "
        f"(HGVS anchor c.{anc}). Whole-exon skip at this junction alters 5′-UTR splicing, not "
        "coding sequence directly — prioritize SpliceAI, ClinVar/HGMD, and gene mechanism over "
        "PTC/NMD protein-length models."
    )
    existing = (parsed_data.get('splice_frame_math') or '').strip()
    if note not in existing:
        parsed_data['splice_frame_math'] = f"{existing}<br><br>{note}" if existing else note


def _select_splice_coding_exon(cons, cds_pos, coding_exons, c_dot=""):
    """
    Map RefSeq/VEP cDNA position to the correct coding exon for whole-exon skip models.

    For splice_acceptor, c.N-k anchors N to the first CDS base 3' of the intron (the exon
    that is spliced in at that acceptor). Exact start_cds==N first, then 5' intron c.N+ form,
    then min distance, then the more 3' exon (e.g. 16 vs 15).
    For splice_donor, anchor is at 3' of the upstream exon; match on end_cds.
    For splice_region, match any exon that spans or neighbors cds_pos.
    """
    if not coding_exons or not cds_pos:
        return None
    if _consequence_is_acceptor_splice(cons, c_dot):
        c_low = (c_dot or "").lower()
        m_plus = re.search(r'c\.(-?\d+)\s*\+', c_low) if c_low else None
        m_minus = re.search(r'c\.(-?\d+)\s*-\s*', c_low) if c_low else None
        # 1) Exact: acceptor c.N-… → N = first base of 3' exon (e.g. 1387-4 → that exon, not 15)
        for cx in coding_exons:
            if int(cx.get('start_cds') or 0) == int(cds_pos):
                return cx
        # 2) c.N-k only: if exact start_cds==N failed (transcript cDNA offset), first coding exon 3' of N
        if m_minus and not m_plus:
            try:
                n3 = int(m_minus.group(1))
            except (TypeError, ValueError):
                n3 = 0
            if n3 < 1:
                return None
            if n3:
                c3 = [cx for cx in coding_exons if int(cx.get('start_cds') or 0) >= n3]
                if c3:
                    c3.sort(
                        key=lambda x: (int(x.get('start_cds') or 0), int(x.get('anatomical_rank') or 0))
                    )
                    return c3[0]
        # 3) 5' side only c.N+k: N is 5' exon; skip target is the first coding exon 3' of N
        if m_plus and not m_minus:
            try:
                n5 = int(m_plus.group(1))
            except (TypeError, ValueError):
                n5 = 0
            if n5:
                after = [cx for cx in coding_exons if int(cx.get('start_cds') or 0) > n5]
                if after:
                    after.sort(
                        key=lambda x: (int(x.get('start_cds') or 0), -int(x.get('anatomical_rank') or 0))
                    )
                    return after[0]
        for window in (5, 10):
            cands = []
            for cx in coding_exons:
                d = abs(cx['start_cds'] - cds_pos)
                if d > window:
                    continue
                exact = 0 if cx['start_cds'] == cds_pos else 1
                cands.append((exact, d, -cx['anatomical_rank'], cx))
            if cands:
                cands.sort(key=lambda x: (x[0], x[1], x[2]))
                return cands[0][3]
        return None
    if _consequence_is_donor_splice(cons, c_dot):
        cands = []
        for cx in coding_exons:
            d = abs(cx['end_cds'] - cds_pos)
            if d <= 5:
                cands.append((d, cx['anatomical_rank'], cx))
        if cands:
            cands.sort(key=lambda x: (x[0], x[1]))
            return cands[0][2]
        for cx in coding_exons:
            if abs(cx['end_cds'] - cds_pos) <= 3:
                return cx
        return None
    # Splice region + c.N-: loose neighbor matching can map the first base 3' of the intron (N)
    # to the *upstream* exon via (end+3) slack. Prefer the 3' exon if N is at/near that exon start.
    c_low = (c_dot or "").lower()
    m_minus_sr = re.search(r'c\.([0-9]+)\s*-\s*', c_low) if c_low else None
    m_plus_sr = re.search(r'c\.([0-9]+)\s*\+', c_low) if c_low else None
    if (
        'splice_region' in (cons or '')
        and m_minus_sr
        and not m_plus_sr
        and 'splice_acceptor' not in (cons or '')
        and 'splice_donor' not in (cons or '')
    ):
        try:
            n_sr = int(m_minus_sr.group(1))
        except (TypeError, ValueError):
            n_sr = 0
        if n_sr and coding_exons:
            c3 = [cx for cx in coding_exons if int(cx.get('start_cds') or 0) >= n_sr]
            c3.sort(
                key=lambda x: (int(x.get('start_cds') or 0), int(x.get('anatomical_rank') or 0))
            )
            if c3:
                s0 = int(c3[0].get('start_cds') or 0) - n_sr
                if 0 <= s0 <= 5:
                    return c3[0]
    for cx in coding_exons:
        if (cx['start_cds'] - 3) <= cds_pos <= (cx['end_cds'] + 3):
            return cx
    return None


def _frameshift_onset_aa(parsed_data):
    """Frameshift onset aa — matches Truncated pill (HGVS position, not conflated with stop)."""
    try:
        ps = int(parsed_data.get('protein_start') or 0)
    except (TypeError, ValueError):
        ps = 0
    try:
        da = int(parsed_data.get('downstream_aas') or 0)
    except (TypeError, ValueError):
        da = 0
    try:
        nsv = int(parsed_data.get('novel_stop_aa') or 0)
    except (TypeError, ValueError):
        nsv = 0
    if (parsed_data.get('consequence') or '') == 'frameshift':
        hgvs_p = str(parsed_data.get('hgvs_p') or '')
        m = re.match(r'p\.(?:[A-Z][a-z]{2}|[A-Z*])(\d+)', hgvs_p)
        fs_onset = int(m.group(1)) if m else ps
        if nsv > 0 and fs_onset == nsv and da > 0:
            fs_onset = nsv - da
        if fs_onset > 0:
            return fs_onset
    return ps


def _format_truncation_coord_for_logic(parsed_data, p_len_display, trunc_frac):
    """
    Match the 'Truncated:' bander math: Stop: pStart [WT] + shift = end/wt, or stop/wt.
    """
    try:
        p_wt = int(parsed_data.get('protein_length') or 0)
    except (TypeError, ValueError):
        p_wt = 0
    if p_wt <= 0 and p_len_display is not None:
        try:
            p_wt = int(p_len_display)
        except (TypeError, ValueError):
            p_wt = 0
    ps = _frameshift_onset_aa(parsed_data)
    d_aas = parsed_data.get('downstream_aas')
    nsv = parsed_data.get('novel_stop_aa')
    try:
        da_i = int(d_aas or 0)
    except (TypeError, ValueError):
        da_i = 0
    if p_wt and ps and da_i > 0:
        return f"Stop: {int(ps)} [WT] + {da_i} [shift] = {int(ps) + da_i}/{p_wt} aa"
    stop = resolved_ptc_stop_aa(parsed_data)
    if p_wt and stop > 0:
        return f"Stop: {stop}/{p_wt} aa"
    if p_wt and nsv is not None:
        try:
            return f"Stop: {int(nsv)}/{p_wt} aa"
        except (TypeError, ValueError):
            pass
    if p_wt and trunc_frac is not None:
        try:
            tf = float(trunc_frac)
            approx = max(0, int(round(p_wt * (1.0 - tf))))
            return f"~{approx}/{p_wt} aa"
        except (TypeError, ValueError):
            pass
    if p_wt:
        return f"{p_wt} aa (WT length)"
    return f"{p_len_display} AA"


def _truncation_math_line_for_logic(parsed_data, p_len_display, trunc_frac):
    """Single truncation math line for logic / copy-paste (onset + shift when present)."""
    stop = resolved_ptc_stop_aa(parsed_data)
    try:
        p_wt = int(parsed_data.get('protein_length') or p_len_display or 0)
    except (TypeError, ValueError):
        p_wt = 0
    if stop > 0 and p_wt > 0:
        trunc_frac = c_terminal_loss_fraction(stop, p_wt)
    coord = _format_truncation_coord_for_logic(parsed_data, p_len_display, trunc_frac)
    if not coord:
        return ''
    pct = truncation_pct_display(trunc_frac)
    if pct is not None:
        return f"{coord} ({pct}% C-terminal lost)"
    return coord


def _dup_insert_cds_orientation(ins_extra, strand):
    """Map genomic dup alleles to cDNA / CDS 5′→3′ orientation."""
    ins = str(ins_extra or '').upper()
    if not ins:
        return ''
    try:
        st = int(strand)
    except (TypeError, ValueError):
        st = 1
    if st == -1:
        return _revcomp(ins)
    return ins


def _build_canonical_junction_dup_outcome(
    parsed_data,
    cx,
    coding_exons,
    cds_seq,
    c_dot,
    is_acceptor,
    is_donor,
    ins_extra,
    gain_signal,
    loss_signal,
    cryptic_type,
):
    """
    c.N±kdup / c.N+K_N+Mdup: secondary donor/acceptor-gain product = duplicated intronic
    sequence retained at the splice junction (+k nt). When k mod 3 ≠ 0 → OOF → PTC.
    (Parallel to whole-exon-skip from donor/acceptor loss.)
    """
    cj = _canonical_splice_junction_from_hgvs(c_dot)
    if not cj or cj.get('kind') != 'dup':
        return None
    if cj.get('site') == 'donor' and not is_donor:
        return None
    if cj.get('site') == 'acceptor' and not is_acceptor:
        return None
    ins_nt = _dup_insert_cds_orientation(ins_extra, parsed_data.get('transcript_strand', 1))
    if not ins_nt:
        return None
    site_word = _canonical_junction_dup_site_label(cj)
    seq_noun = 'sequence' if len(ins_nt) > 1 else 'base'
    try:
        cx_end = int(cx.get('end_cds') or 0)
        cx_start = int(cx.get('start_cds') or 0)
    except (TypeError, ValueError):
        return None
    if is_donor:
        if cx_end <= 0 or cx_end > len(cds_seq):
            return None
        edit_anchor = cx_end
        mutant_cds = cds_seq[:edit_anchor] + ins_nt + cds_seq[edit_anchor:]
    else:
        if cx_start <= 1 or cx_start > len(cds_seq) + 1:
            return None
        edit_anchor = cx_start - 1
        mutant_cds = cds_seq[:edit_anchor] + ins_nt + cds_seq[edit_anchor:]
    shift_nt = len(ins_nt)
    co = _ptc_nmd_outcome_from_mutant_cds(
        mutant_cds,
        cds_seq,
        edit_anchor,
        shift_nt,
        coding_exons,
        parsed_data,
        cryptic_type=cryptic_type,
        gain_signal=gain_signal,
        loss_signal=loss_signal,
        inserted_cdna=ins_nt,
    )
    if not co:
        return None
    co['canonical_junction_dup_model'] = True
    co['secondary_splice_product'] = True
    if co.get('no_stop_found'):
        co['narrative'] = (
            f"<b>{cryptic_type}</b> ({site_word}): junction retains duplicated intronic {seq_noun} "
            f"<code>{ins_nt}</code> (+{shift_nt} nt) — no premature stop resolved before CDS end."
        )
        return co
    fs_ter = co.get('fs_ter_str') or ''
    ptc_aa = co.get('ptc_aa_position')
    ptc_er = co.get('ptc_exon_rank')
    in_fr = co.get('in_frame_shift')
    first_codon = co.get('first_new_codon') or ''
    first_aa = co.get('first_new_aa') or ''
    first_aa_3 = _AA_ONE_TO_THREE.get(first_aa, first_aa)
    first_aa_pos = co.get('first_insert_aa_pos')
    gain_block, gain_plain = _format_splice_gain_insert_explain(
        ins_nt, first_codon, mutant_cds=mutant_cds, edit_anchor=edit_anchor
    )
    co['insert_triplet_decode'] = gain_plain
    frame_bit = (
        f"<b>in-frame</b> (+{shift_nt} nt)"
        if in_fr
        else f"<b>out-of-frame</b> (+{shift_nt} nt &rarr; frameshift)"
    )
    ptc_loc = ''
    if ptc_er is not None:
        ptc_loc = f" — PTC in <b>exon {ptc_er}</b>"
    co['narrative'] = (
        f"{gain_block}"
        f"<b>{cryptic_type}</b> ({site_word}, <span style='color:#fde68a'>secondary product</span>): "
        f"duplicated intronic {seq_noun} <code>{ins_nt}</code> retained at the canonical splice junction "
        f"({frame_bit}). "
        f"First re-read codon: <b>{first_codon or '—'}</b> &rarr; {first_aa_3}"
        f"{f' (aa {first_aa_pos})' if first_aa_pos else ''}. "
        f"Predicted protein: <b>{fs_ter}</b>{ptc_loc}."
        + (
            f" <span style='color:#a7f3d0;font-size:0.92em'>{co.get('nmd_reason')}</span>"
            if co.get('nmd_reason')
            else ''
        )
    )
    return co


def _resolve_cryptic_splice_outcome(
    http_session, parsed_data, cx, coding_exons, cds_seq, c_dot, current_csq, strand, chrom,
    skip_dup_shortcut=False,
):
    """
    Sequence-driven cryptic splice resolver.

    For canonical splice acceptor or donor variants, fetches the local genomic context
    around the canonical splice junction in transcript orientation, applies the variant,
    finds the dominant cryptic AG / GT site, computes the resulting net insertion or
    deletion of nucleotides relative to the canonical exon, builds the mutant CDS,
    translates from the native ATG, and returns a structured dict describing the
    predicted outcome and a UI-ready narrative.

    Returns None if a plausible cryptic outcome cannot be resolved.
    Returns a "minimal_signal" dict when SpliceAI strongly predicts a gain but the
    sequence-level math could not be completed (so the UI can still surface that fact).
    """
    def _gain_loss():
        try:
            ag = float(parsed_data.get('spliceai_ds_ag') or 0.0)
            dg = float(parsed_data.get('spliceai_ds_dg') or 0.0)
            al = float(parsed_data.get('spliceai_ds_al') or 0.0)
            dl = float(parsed_data.get('spliceai_ds_dl') or 0.0)
        except (TypeError, ValueError):
            ag = dg = al = dl = 0.0
        try:
            psg = abs(float(parsed_data.get('pangolin_ds_sg') or 0.0))
            psl = abs(float(parsed_data.get('pangolin_ds_sl') or 0.0))
        except (TypeError, ValueError):
            psg = psl = 0.0
        return max(ag, dg, psg), max(al, dl, psl)

    def _signal_only_fallback(reason):
        gs, ls = _gain_loss()
        if gs < 0.20 and ls < 0.50:
            return None
        # Prefer explicit splice_acceptor / splice_donor; otherwise use c-dot offset sign,
        # then fall back to whichever SpliceAI side (acceptor vs donor) is dominant.
        if 'splice_acceptor' in current_csq:
            cryptic_type_local = 'Acceptor Gain'
        elif 'splice_donor' in current_csq:
            cryptic_type_local = 'Donor Gain'
        else:
            cdot_str = str(c_dot or '')
            cryptic_type_local = None
            try:
                import re as _re_fb
                m = _re_fb.search(r"c\.[0-9]+([+-])[0-9]+", cdot_str)
                if m:
                    cryptic_type_local = 'Acceptor Gain' if m.group(1) == '-' else 'Donor Gain'
            except Exception:
                cryptic_type_local = None
            if cryptic_type_local is None:
                try:
                    ag_v = float(parsed_data.get('spliceai_ds_ag') or 0.0)
                    al_v = float(parsed_data.get('spliceai_ds_al') or 0.0)
                    dg_v = float(parsed_data.get('spliceai_ds_dg') or 0.0)
                    dl_v = float(parsed_data.get('spliceai_ds_dl') or 0.0)
                    cryptic_type_local = 'Acceptor Gain' if max(ag_v, al_v) >= max(dg_v, dl_v) else 'Donor Gain'
                except Exception:
                    cryptic_type_local = 'Acceptor Gain'
        return {
            'shift_nt': None,
            'cryptic_type': cryptic_type_local,
            'minimal_signal': True,
            'gain_signal': gs,
            'loss_signal': ls,
            'narrative': (
                f"<b>{cryptic_type_local}</b> predicted by SpliceAI/Pangolin (gain {gs:.2f}, loss {ls:.2f}), "
                f"but the sequence-level cryptic-splice translator could not resolve the new splice geometry "
                f"({reason}). Manual inspection of the ±30 nt window around the canonical splice junction is recommended."
            ),
        }

    try:
        _hydrate_exon_skip_truncation_metrics(parsed_data)
        # Enter the resolver for any splice* consequence with a real SpliceAI/Pangolin
        # signal. Strict splice_acceptor / splice_donor used to be required, which silently
        # dropped splice_region_variant calls (e.g. TRAF7 c.1387-4T>G at acceptor -4),
        # leaving the user with only the exon-skip baseline and no gain math.
        gain_signal, loss_signal = _gain_loss()
        consequence_is_splice_like = any(
            tok in current_csq for tok in (
                'splice_acceptor', 'splice_donor', 'splice_region',
                'splice_polypyrimidine', 'splice_donor_5th_base', 'splice_donor_region',
            )
        )
        has_strong_signal = (gain_signal >= 0.20 or loss_signal >= 0.50)
        if not consequence_is_splice_like and not has_strong_signal:
            print(
                f"[cryptic-resolver] skip: consequence='{current_csq}' is not splice-like and "
                f"SpliceAI gain={gain_signal:.2f} loss={loss_signal:.2f} below thresholds"
            )
            return None
        if not has_strong_signal:
            print(f"[cryptic-resolver] skip: SpliceAI gain={gain_signal:.2f}, loss={loss_signal:.2f} both below thresholds")
            return None

        # Deep-intronic body variants use compute_deep_intronic_spliceai_products.
        # Junction-proximal intron_variant (c.N±k within 20 nt, e.g. c.151-9) stays on the
        # cryptic + exon-skip dual-product path instead.
        csq_l = (current_csq or '').lower()
        if 'intron_variant' in csq_l and not any(
            tok in csq_l for tok in ('splice_acceptor', 'splice_donor', 'splice_region')
        ):
            if not _near_junction_intronic_locus(c_dot):
                print(
                    "[cryptic-resolver] skip: intron_variant — deep intronic product "
                    "module owns splice math"
                )
                return None

        if not cx:
            print("[cryptic-resolver] skip: missing cx (canonical exon dict)")
            return _signal_only_fallback("affected exon record unavailable")
        if not cds_seq:
            print("[cryptic-resolver] skip: missing cds_seq")
            return _signal_only_fallback("transcript CDS sequence unavailable")
        if not chrom:
            print("[cryptic-resolver] skip: missing chrom")
            return _signal_only_fallback("transcript chromosome unavailable")

        # Infer acceptor vs donor when the consequence isn't strictly splice_acceptor /
        # splice_donor. Order of preference:
        #   1) explicit splice_acceptor / splice_donor consequence string
        #   2) c-dot offset sign: c.N-K → acceptor side; c.N+K → donor side
        #   3) dominant SpliceAI delta (max of AG/AL vs DG/DL)
        is_acceptor = 'splice_acceptor' in current_csq
        is_donor = 'splice_donor' in current_csq
        if not (is_acceptor or is_donor):
            cdot_str = str(c_dot or '')
            try:
                import re as _re_csq
                m = _re_csq.search(r"c\.[0-9]+([+-])[0-9]+", cdot_str)
                if m:
                    is_acceptor = (m.group(1) == '-')
                    is_donor = not is_acceptor
            except Exception:
                pass
        if not (is_acceptor or is_donor):
            try:
                ag_v = float(parsed_data.get('spliceai_ds_ag') or 0.0)
                al_v = float(parsed_data.get('spliceai_ds_al') or 0.0)
                dg_v = float(parsed_data.get('spliceai_ds_dg') or 0.0)
                dl_v = float(parsed_data.get('spliceai_ds_dl') or 0.0)
                acc_max = max(ag_v, al_v)
                don_max = max(dg_v, dl_v)
                is_acceptor = acc_max >= don_max
                is_donor = not is_acceptor
            except Exception:
                is_acceptor = True
                is_donor = False
        cryptic_type = 'Acceptor Gain' if is_acceptor else 'Donor Gain'

        var_chrom_raw = str(parsed_data.get('grch38_chrom') or chrom or '').strip()
        var_chrom = var_chrom_raw.replace('chr', '') or str(chrom).replace('chr', '')
        try:
            var_g_pos = int(parsed_data.get('grch38_start') or 0)
        except (TypeError, ValueError):
            var_g_pos = 0
        if not var_chrom or var_g_pos <= 0:
            print(f"[cryptic-resolver] skip: no GRCh38 coords on parsed_data (chrom='{var_chrom}', pos={var_g_pos})")
            return _signal_only_fallback("variant GRCh38 position not propagated to splice resolver")

        ref_allele = str(parsed_data.get('ref') or '').upper()
        alt_allele = str(parsed_data.get('alt') or '').upper()
        # Fallback: if ref/alt weren't propagated, recover them via a lightweight
        # VEP HGVS lookup so the resolver never silently bails on missing alleles.
        if (len(ref_allele) != 1 or len(alt_allele) != 1 or ref_allele in ('-', '.') or alt_allele in ('-', '.')) and c_dot:
            try:
                import urllib.parse as _urlparse
                _tx = parsed_data.get('refseq_transcript_id') or parsed_data.get('mane_transcript') or parsed_data.get('ensembl_transcript_id')
                _gene = parsed_data.get('gene_symbol') or parsed_data.get('gene') or ''
                _hgvs = f"{_tx}:{c_dot}" if _tx else (f"{_gene}:{c_dot}" if _gene else None)
                if _hgvs:
                    _vep_url = f"https://rest.ensembl.org/vep/human/hgvs/{_urlparse.quote(_hgvs, safe='')}?content-type=application/json"
                    _vresp = http_session.get(_vep_url, timeout=20)
                    if _vresp.status_code == 200 and _vresp.json():
                        _v0 = _vresp.json()[0]
                        _ale = str(_v0.get('allele_string', '') or '')
                        if '/' in _ale:
                            _ra, _aa = _ale.split('/')[:2]
                            if _ra and _aa:
                                if not parsed_data.get('grch38_start'):
                                    parsed_data['grch38_start'] = _v0.get('start')
                                if not parsed_data.get('grch38_chrom'):
                                    _c = str(_v0.get('seq_region_name', '') or '')
                                    if _c and not _c.startswith('chr'):
                                        _c = 'chr' + _c
                                    parsed_data['grch38_chrom'] = _c
                                _ra_n, _aa_n, _ = _normalize_to_forward_strand(
                                    http_session,
                                    parsed_data.get('grch38_chrom'),
                                    parsed_data.get('grch38_start'),
                                    _ra.upper(), _aa.upper(),
                                    parsed_data.get('grch38_end'),
                                )
                                ref_allele = _ra_n
                                alt_allele = _aa_n
                                parsed_data['ref'] = ref_allele
                                parsed_data['alt'] = alt_allele
                                print(f"[cryptic-resolver] recovered ref/alt from VEP (forward-strand normalized): {ref_allele}/{alt_allele}")
            except Exception as _vep_err:
                print(f"[cryptic-resolver] VEP fallback for ref/alt failed: {_vep_err}")

        if not _alleles_usable_for_cryptic_resolver(ref_allele, alt_allele):
            _parsed_vcf = _parse_vcf_locus_string(parsed_data.get('vep_vcf_string'))
            if _parsed_vcf:
                _vc, _vp, _vr, _va = _parsed_vcf
                ref_allele = _vr
                alt_allele = _va
                var_g_pos = _vp
                parsed_data['grch38_start'] = _vp
                if not parsed_data.get('grch38_chrom'):
                    parsed_data['grch38_chrom'] = _vc

        is_snv = len(ref_allele) == 1 and len(alt_allele) == 1 and ref_allele not in ('-', '.') and alt_allele not in ('-', '.')
        is_dup = (
            len(ref_allele) >= 1
            and len(alt_allele) > len(ref_allele)
            and alt_allele.startswith(ref_allele)
        )
        is_del = (
            (
                alt_allele in ('', '-', '.')
                and len(ref_allele) >= 1
                and ref_allele not in ('-', '.')
            )
            or (
                len(ref_allele) > 1
                and alt_allele not in ('', '-', '.')
                and len(alt_allele) < len(ref_allele)
                and ref_allele.startswith(alt_allele)
            )
        )
        if not (is_snv or is_dup or is_del):
            print(f"[cryptic-resolver] skip: ref/alt not SNV, dup, or del (ref='{ref_allele}', alt='{alt_allele}')")
            return _signal_only_fallback(
                f"ref/alt allele not single-base SNV, duplication, or deletion (ref='{ref_allele}', alt='{alt_allele}')"
            )
        ins_extra = alt_allele[len(ref_allele):].upper() if is_dup else ''

        dup_co_candidate = None
        if is_dup and ins_extra:
            dup_co_candidate = _build_canonical_junction_dup_outcome(
                parsed_data,
                cx,
                coding_exons,
                cds_seq,
                c_dot,
                is_acceptor,
                is_donor,
                ins_extra,
                gain_signal,
                loss_signal,
                cryptic_type,
            )

        cx_g_start = cx.get('start')
        cx_g_end = cx.get('end')
        if not cx_g_start or not cx_g_end:
            print("[cryptic-resolver] skip: cx missing genomic start/end")
            return _signal_only_fallback("canonical exon genomic coordinates missing")

        intron_window = 60
        exon_window = 45

        if strand == 1:
            if is_acceptor:
                fetch_start = max(1, cx_g_start - intron_window)
                fetch_end = cx_g_start + exon_window
                junction_g_pos = cx_g_start
            else:
                fetch_start = max(1, cx_g_end - exon_window)
                fetch_end = cx_g_end + intron_window
                junction_g_pos = cx_g_end
        else:
            if is_acceptor:
                fetch_start = max(1, cx_g_end - exon_window)
                fetch_end = cx_g_end + intron_window
                junction_g_pos = cx_g_end
            else:
                fetch_start = max(1, cx_g_start - intron_window)
                fetch_end = cx_g_start + exon_window
                junction_g_pos = cx_g_start

        seq_url = f"https://rest.ensembl.org/sequence/region/human/{var_chrom}:{fetch_start}-{fetch_end}?content-type=text/plain"
        plus_seq = _fetch_plus_strand_sequence(
            http_session, var_chrom, fetch_start, fetch_end, timeout=45,
        )
        if not plus_seq:
            print(
                f"[cryptic-resolver] genomic sequence fetch failed for "
                f"{var_chrom}:{fetch_start}-{fetch_end}"
            )
            return _signal_only_fallback(
                f"genomic sequence fetch failed for {var_chrom}:{fetch_start}-{fetch_end}"
            )

        if not (fetch_start <= var_g_pos <= fetch_end):
            print(f"[cryptic-resolver] variant pos {var_g_pos} outside fetch window {fetch_start}-{fetch_end}; cx may not match variant exon")
            return _signal_only_fallback("variant position fell outside the canonical splice junction window for this exon")
        var_idx_plus = var_g_pos - fetch_start

        if is_dup:
            ins_at_plus = var_idx_plus + 1
            if ins_at_plus < 0 or ins_at_plus > len(plus_seq):
                return _signal_only_fallback("duplication index out of fetched window")
            mut_plus = plus_seq[:ins_at_plus] + ins_extra + plus_seq[ins_at_plus:]
            if strand == 1:
                transcript_seq = plus_seq
                mut_seq = mut_plus
                var_idx_t = var_idx_plus
                junction_t_idx = junction_g_pos - fetch_start
            else:
                transcript_seq = _revcomp(plus_seq)
                mut_seq = _revcomp(mut_plus)
                var_idx_t = (len(plus_seq) - 1) - var_idx_plus
                junction_t_idx = (len(plus_seq) - 1) - (junction_g_pos - fetch_start)
        elif is_del:
            del_start_g, del_end_g = _cryptic_resolver_deletion_bounds(
                parsed_data, var_g_pos, ref_allele, alt_allele,
            )
            del_start_plus = del_start_g - fetch_start
            del_end_plus = del_end_g - fetch_start
            if del_end_plus < del_start_plus:
                del_end_plus = del_start_plus + max(0, len(ref_allele) - 1)
            if del_start_plus < 0 or del_end_plus >= len(plus_seq):
                return _signal_only_fallback("deletion interval out of fetched window")
            mut_plus = plus_seq[:del_start_plus] + plus_seq[del_end_plus + 1:]
            if strand == 1:
                transcript_seq = plus_seq
                mut_seq = mut_plus
                var_idx_t = del_start_plus
                junction_t_idx = junction_g_pos - fetch_start
            else:
                transcript_seq = _revcomp(plus_seq)
                mut_seq = _revcomp(mut_plus)
                var_idx_t = (len(plus_seq) - 1) - del_end_plus
                junction_t_idx = (len(plus_seq) - 1) - (junction_g_pos - fetch_start)
        elif strand == 1:
            transcript_seq = plus_seq
            mut_seq = transcript_seq[:var_idx_plus] + alt_allele + transcript_seq[var_idx_plus + 1:]
            junction_t_idx = junction_g_pos - fetch_start
            var_idx_t = var_idx_plus
        else:
            transcript_seq = _revcomp(plus_seq)
            comp = {'A':'T','T':'A','G':'C','C':'G','N':'N'}
            ref_t = comp.get(ref_allele, ref_allele)
            alt_t = comp.get(alt_allele, alt_allele)
            var_idx_t = (len(plus_seq) - 1) - var_idx_plus
            if var_idx_t < 0 or var_idx_t >= len(transcript_seq):
                return None
            mut_seq = transcript_seq[:var_idx_t] + alt_t + transcript_seq[var_idx_t + 1:]
            junction_t_idx = (len(plus_seq) - 1) - (junction_g_pos - fetch_start)

        if (
            dup_co_candidate
            and not dup_co_candidate.get('no_stop_found')
            and not skip_dup_shortcut
        ):
            _layout = 'acceptor_junction' if is_acceptor else 'donor_junction'
            return _junction_align_attach_cryptic_ctx(
                dup_co_candidate,
                parsed_data=parsed_data,
                cx=cx,
                cds_seq=cds_seq,
                layout=_layout,
                transcript_seq=transcript_seq,
                mut_seq=mut_seq,
                junction_t_idx=junction_t_idx,
                var_idx_t=var_idx_t,
                inserted_cdna=dup_co_candidate.get('inserted_cdna') or ins_extra,
                dup_ins=ins_extra,
            )

        chosen_site = -1
        if is_acceptor:
            canon_ag_start = junction_t_idx - 2
            if canon_ag_start < 0 or canon_ag_start + 2 > len(transcript_seq):
                return _signal_only_fallback("canonical acceptor index out of fetched window")

            chosen_ag_pos, _sai_site = _junction_spliceai_cryptic_site(
                parsed_data, mut_seq, transcript_seq, var_idx_t, True, strand, c_dot, junction_t_idx
            )
            if chosen_ag_pos is None:
                return _signal_only_fallback("no plausible cryptic AG within 30 nt of canonical acceptor")

            chosen_site = chosen_ag_pos
            new_exon_start_t_idx = chosen_ag_pos + 2
            shift_nt = junction_t_idx - new_exon_start_t_idx
        else:
            canon_gt_start = junction_t_idx + 1
            if canon_gt_start < 0 or canon_gt_start + 2 > len(transcript_seq):
                return _signal_only_fallback("canonical donor index out of fetched window")

            chosen_gt_pos, _sai_site = _junction_spliceai_cryptic_site(
                parsed_data, mut_seq, transcript_seq, var_idx_t, False, strand, c_dot, junction_t_idx
            )
            if chosen_gt_pos is None:
                return _signal_only_fallback("no plausible cryptic GT within 30 nt of canonical donor")

            chosen_site = chosen_gt_pos
            new_exon_end_t_idx = chosen_gt_pos - 1
            shift_nt = new_exon_end_t_idx - junction_t_idx

        if shift_nt == 0:
            return _signal_only_fallback("dominant cryptic site coincides with canonical position (zero shift)")

        retained = ""  # intronic cDNA spliced in (positive net shift) for junction math
        if is_acceptor:
            cx_start_cds = int(cx.get('start_cds') or 0)
            if cx_start_cds <= 0 or cx_start_cds > len(cds_seq):
                return _signal_only_fallback("invalid start_cds for affected exon")
            if shift_nt > 0:
                junction_mut_idx = _junction_exon_start_mut_idx(
                    transcript_seq, mut_seq, junction_t_idx, var_idx_t,
                )
                retained = mut_seq[new_exon_start_t_idx:junction_mut_idx]
                if not retained:
                    return _signal_only_fallback("empty retained intronic body at cryptic acceptor")
                shift_nt = len(retained)
                mutant_cds = cds_seq[:cx_start_cds - 1] + retained + cds_seq[cx_start_cds - 1:]
                edit_anchor_cds = cx_start_cds - 1
            else:
                deleted = -shift_nt
                if cx_start_cds - 1 + deleted > len(cds_seq):
                    return _signal_only_fallback("deletion would run past end of CDS")
                mutant_cds = cds_seq[:cx_start_cds - 1] + cds_seq[cx_start_cds - 1 + deleted:]
                edit_anchor_cds = cx_start_cds - 1
        else:
            cx_end_cds = int(cx.get('end_cds') or 0)
            if cx_end_cds <= 0 or cx_end_cds > len(cds_seq):
                return _signal_only_fallback("invalid end_cds for affected exon")
            if shift_nt > 0:
                # ORF insert excludes canonical GT (junction+1,+2) and cryptic GT — same rule as deep intronic.
                body_start_mut = _junction_ref_idx_to_mut_idx(
                    transcript_seq, mut_seq, junction_t_idx + 3, var_idx_t,
                )
                if chosen_gt_pos <= body_start_mut:
                    return _signal_only_fallback("cryptic donor GT leaves no ORF body after canonical GT")
                retained = mut_seq[body_start_mut:chosen_gt_pos]
                shift_nt = len(retained)
                if shift_nt < 1:
                    return _signal_only_fallback("empty ORF body between canonical and cryptic donor GT")
                prefix_end = _junction_donor_cds_prefix_end(
                    cx_end_cds, junction_t_idx, var_idx_t, transcript_seq, mut_seq,
                )
                mutant_cds = cds_seq[:prefix_end] + retained + cds_seq[cx_end_cds:]
                edit_anchor_cds = prefix_end
            else:
                deleted = -shift_nt
                if cx_end_cds - deleted < 0:
                    return _signal_only_fallback("deletion would run past start of CDS")
                mutant_cds = cds_seq[:cx_end_cds - deleted] + cds_seq[cx_end_cds:]
                edit_anchor_cds = cx_end_cds - deleted

        inserted_cdna = (retained or "").upper() if (shift_nt and shift_nt > 0) else ""

        first_changed_codon_idx = edit_anchor_cds // 3
        ptc_codon_idx = -1
        ptc_codon_str = ''
        first_new_codon_str = ''
        first_new_aa = ''
        for i in range(0, len(mutant_cds) - 2, 3):
            codon = mutant_cds[i:i+3]
            if len(codon) != 3:
                break
            aa = _CODON_TABLE_FULL.get(codon, 'X')
            codon_idx = i // 3
            if codon_idx == first_changed_codon_idx and not first_new_codon_str:
                first_new_codon_str = codon
                first_new_aa = aa
            if aa == '*':
                ptc_codon_idx = codon_idx
                ptc_codon_str = codon
                break

        # Detect "preserved natural stop": for an IN-FRAME insert (or in-frame deletion)
        # the WT stop codon simply shifts by insert_codons (or -deleted_codons); the codon
        # we just found is then the native terminator, not a premature one.
        natural_stop_codon_idx_wt = -1
        for i in range(0, len(cds_seq) - 2, 3):
            cod_wt = cds_seq[i:i + 3]
            if len(cod_wt) != 3:
                break
            if _CODON_TABLE_FULL.get(cod_wt, 'X') == '*':
                natural_stop_codon_idx_wt = i // 3
                break
        natural_stop_preserved = False
        if (
            ptc_codon_idx >= 0
            and natural_stop_codon_idx_wt >= 0
            and shift_nt is not None
            and (shift_nt % 3 == 0)
        ):
            expected_shift_codons = shift_nt // 3  # may be negative for in-frame deletions
            expected_new_stop_codon_idx = natural_stop_codon_idx_wt + expected_shift_codons
            # Exact match OR off-by-one to tolerate any 0/1-indexing slack between
            # parsed_data['protein_length'] and the actual cds_seq stop position.
            if abs(ptc_codon_idx - expected_new_stop_codon_idx) <= 1:
                natural_stop_preserved = True

        if natural_stop_preserved:
            # Re-route: this is an in-frame insertion / deletion that preserves the
            # native terminator. Build a no-truncation outcome instead of a PTC outcome.
            _co_preserved = _build_inframe_preserved_stop_outcome(
                cryptic_type=cryptic_type,
                shift_nt=shift_nt,
                inserted_cdna=inserted_cdna,
                first_new_codon_str=first_new_codon_str,
                first_changed_codon_idx=first_changed_codon_idx,
                preserved_stop_codon_idx=ptc_codon_idx,
                gain_signal=gain_signal,
                loss_signal=loss_signal,
                mutant_cds=mutant_cds,
                edit_anchor=edit_anchor_cds,
                parsed_data=parsed_data,
            )
            return _junction_align_attach_cryptic_ctx(
                _co_preserved,
                parsed_data=parsed_data,
                cx=cx,
                cds_seq=cds_seq,
                layout='acceptor_junction' if is_acceptor else 'donor_junction',
                transcript_seq=transcript_seq,
                mut_seq=mut_seq,
                junction_t_idx=junction_t_idx,
                var_idx_t=var_idx_t,
                cryptic_site_pos=chosen_site,
                inserted_cdna=inserted_cdna,
            )

        if ptc_codon_idx < 0:
            in_frame = (abs(shift_nt) % 3 == 0)
            _ins0 = len(inserted_cdna) if inserted_cdna else 0
            _gain0_html = ""
            _insert_triplet_decode0 = None
            if inserted_cdna and _ins0 > 0:
                _gain0_html, _insert_triplet_decode0 = _format_splice_gain_insert_explain(
                    inserted_cdna,
                    first_new_codon_str,
                    mutant_cds=mutant_cds,
                    edit_anchor=edit_anchor_cds,
                )
            _ins_narr0 = ""
            if inserted_cdna and _ins0:
                _len_co = _annotate_junction_extension_fields({
                    'shift_nt': shift_nt,
                    'inserted_cdna': inserted_cdna,
                    'cryptic_type': cryptic_type,
                })
                _len_clause = _junction_insert_length_clause(_len_co)
                if _ins0 % 3 == 0:
                    _nc0 = _ins0 // 3
                    _ins_narr0 = (
                        f"<b>Junction insert (cDNA):</b> <code>{inserted_cdna}</code> ({_ins0} bp{_len_clause}; {_nc0} codon"
                        f"{'s' if _nc0 != 1 else ''} in the spliced ORF if the reading frame is maintained). "
                    )
                else:
                    _ins_narr0 = (
                        f"<b>Junction insert (cDNA):</b> <code>{inserted_cdna}</code> ({_ins0} bp{_len_clause}; not a multiple of 3 "
                        f"&rarr; <b>out-of-frame</b> for the ORF at the new splice). "
                    )
            return _junction_align_attach_cryptic_ctx(
                _annotate_junction_extension_fields({
                    'shift_nt': shift_nt,
                    'inserted_cdna': inserted_cdna,
                    'insert_triplet_decode': _insert_triplet_decode0,
                    'cryptic_type': cryptic_type,
                    'in_frame_shift': in_frame,
                    'first_new_codon': first_new_codon_str,
                    'first_new_aa': first_new_aa,
                    'no_stop_found': True,
                    'narrative': (
                        _gain0_html
                        + _ins_narr0
                        + f"{cryptic_type} at the canonical splice junction (net {'+' if shift_nt > 0 else ''}{shift_nt} nt; "
                        f"SpliceAI gain {gain_signal:.2f}, loss {loss_signal:.2f}). "
                        f"{'In-frame' if in_frame else 'Out-of-frame'} for the ORF; no premature stop before the end of the CDS. "
                    ),
                }),
                parsed_data=parsed_data,
                cx=cx,
                cds_seq=cds_seq,
                layout='acceptor_junction' if is_acceptor else 'donor_junction',
                transcript_seq=transcript_seq,
                mut_seq=mut_seq,
                junction_t_idx=junction_t_idx,
                var_idx_t=var_idx_t,
                cryptic_site_pos=chosen_site,
                inserted_cdna=inserted_cdna,
            )

        in_frame = (abs(shift_nt) % 3 == 0)
        ptc_aa_position = ptc_codon_idx + 1
        downstream_aas = max(0, ptc_aa_position - first_changed_codon_idx - 1)
        first_new_aa_3 = _AA_ONE_TO_THREE.get(first_new_aa, first_new_aa)
        first_changed_aa_pos = first_changed_codon_idx + 1
        if in_frame:
            fs_ter_str = f"p.Ter{ptc_aa_position}"
        else:
            fs_ter_str = f"p.{first_new_aa_3}{first_changed_aa_pos}fsTer{downstream_aas + 1}"

        ptc_exon_rank = None
        ptc_fraction_in_exon = None
        ptc_cds_pos = (ptc_codon_idx * 3) + 3
        delta_at_anchor = shift_nt if is_acceptor else (shift_nt if shift_nt > 0 else shift_nt)
        for tcx in coding_exons:
            ts = int(tcx.get('start_cds') or 0)
            te = int(tcx.get('end_cds') or 0)
            adjusted_ts = ts + delta_at_anchor if ts > edit_anchor_cds else ts
            adjusted_te = te + delta_at_anchor if te > edit_anchor_cds else te
            if adjusted_ts <= ptc_cds_pos <= adjusted_te:
                ptc_exon_rank = tcx.get('anatomical_rank')
                span = adjusted_te - adjusted_ts + 1
                if span > 0:
                    # Middle nucleotide of Ter codon (1-based CDS); clip to annotated exon span.
                    cds_tick_1b = (ptc_codon_idx * 3) + 2
                    cds_tick_1b = min(max(cds_tick_1b, adjusted_ts), adjusted_te)
                    ptc_fraction_in_exon = round((cds_tick_1b - adjusted_ts) / float(span), 4)
                break

        last_rank = coding_exons[-1].get('anatomical_rank') if coding_exons else None
        nmd_escape = False
        nmd_reason = ''
        if ptc_exon_rank is not None and last_rank is not None:
            if ptc_exon_rank == last_rank:
                nmd_escape = True
                nmd_reason = 'PTC lies in the last exon → escapes NMD.'
            elif ptc_exon_rank == (last_rank - 1):
                target_tcx = next((t for t in coding_exons if t.get('anatomical_rank') == ptc_exon_rank), None)
                if target_tcx:
                    target_te = int(target_tcx.get('end_cds') or 0)
                    adj_te = target_te + delta_at_anchor if target_te > edit_anchor_cds else target_te
                    dist_to_eej = adj_te - ptc_cds_pos
                    if dist_to_eej < 50:
                        nmd_escape = True
                        nmd_reason = f'PTC is {dist_to_eej} nt from the penultimate exon junction (<50 nt rule) → escapes NMD.'
                    else:
                        nmd_reason = f'PTC is {dist_to_eej} nt from the penultimate exon junction (≥50 nt) → predicted to undergo NMD.'
            else:
                nmd_reason = (
                    f'PTC lies in exon {ptc_exon_rank} (an internal coding exon; '
                    f'last coding exon is exon {last_rank}) → predicted to undergo NMD.'
                )

        # Truncated-protein math: if the cryptic-spliced mRNA escaped NMD and were
        # translated, how long would the resulting protein be, and how much of the
        # canonical product is lost?
        try:
            full_protein_length = int(parsed_data.get('protein_length') or 0)
        except (TypeError, ValueError):
            full_protein_length = 0
        truncated_protein_length = max(0, ptc_aa_position - 1)
        if full_protein_length > 0:
            aas_lost = full_protein_length - truncated_protein_length
            truncation_fraction = round(aas_lost / float(full_protein_length), 4)
            truncation_pct = round(truncation_fraction * 100, 1)
            retained_pct = round(100.0 - truncation_pct, 1)
            length_clause = (
                f"If the message escaped NMD, the resulting truncated product would be "
                f"<b>{truncated_protein_length} aa</b> out of the {full_protein_length}-aa "
                f"full-length {parsed_data.get('gene_symbol') or parsed_data.get('gene') or 'protein'} "
                f"({retained_pct}% retained / {truncation_pct}% C-terminus lost)."
            )
        else:
            aas_lost = None
            truncation_fraction = None
            truncation_pct = None
            retained_pct = None
            length_clause = (
                f"If the message escaped NMD, the resulting truncated product would be "
                f"<b>{truncated_protein_length} aa</b> long (canonical full-length unknown — "
                f"protein_length not provided)."
            )

        frame_word = 'in-frame' if in_frame else 'out-of-frame'
        shift_str = f"{'+' if shift_nt > 0 else ''}{shift_nt}"
        if full_protein_length > 0:
            length_short = (
                f"Truncated protein ≈ <b>{truncated_protein_length} aa</b> "
                f"(of {full_protein_length}; {truncation_pct}% C-term lost)."
            )
        else:
            length_short = f"Truncated protein ≈ <b>{truncated_protein_length} aa</b>."
        nmd_short = 'NMD: predicted (internal exon).'
        if nmd_escape:
            nmd_short = 'NMD: escape (PTC near/in last exon).'
        elif ptc_exon_rank is not None and last_rank is not None:
            if ptc_exon_rank == last_rank:
                nmd_short = 'NMD: escape (last exon).'
            elif ptc_exon_rank == (last_rank - 1):
                nmd_short = 'NMD: predicted (penultimate exon, ≥50 nt rule).' if not nmd_escape else 'NMD: escape (penultimate exon, <50 nt).'

        ins_len = len(inserted_cdna) if inserted_cdna else 0
        insert_triplet_decode = None
        junction_math_html = ""
        _len_co = _annotate_junction_extension_fields({
            'shift_nt': shift_nt,
            'inserted_cdna': inserted_cdna,
            'cryptic_type': cryptic_type,
        })
        _len_clause = _junction_insert_length_clause(_len_co)
        if inserted_cdna and ins_len > 0:
            gain_block, gain_plain = _format_splice_gain_insert_explain(
                inserted_cdna,
                first_new_codon_str,
                mutant_cds=mutant_cds,
                edit_anchor=edit_anchor_cds,
            )
            insert_triplet_decode = gain_plain
            if ins_len % 3 == 0:
                n_cod = ins_len // 3
                junction_math_html = gain_block + (
                    f"<b>Junction insert (intronic cDNA, spliced in):</b> <code>{inserted_cdna}</code> "
                    f"({ins_len} bp{_len_clause} &rarr; {n_cod} in-frame codon{'s' if n_cod != 1 else ''} in the spliced ORF). "
                    f"First junction codon: <b>{first_new_codon_str or '—'}</b> &rarr; {first_new_aa_3} (aa {first_changed_aa_pos}). "
                    "<br><br>"
                )
            else:
                junction_math_html = gain_block + (
                    f"<b>Junction insert (intronic cDNA, spliced in):</b> <code>{inserted_cdna}</code> "
                    f"({ins_len} bp{_len_clause}; not a multiple of 3 &rarr; <b>out-of-frame</b> gain at the splice). "
                    f"First re-read: <b>{first_new_codon_str or '—'}</b> ({first_new_aa_3}).<br><br>"
                )
        elif shift_nt > 0:
            _dual = _format_junction_length_dual_label(_len_co)
            junction_math_html = (
                f"<b>Net junction extension:</b> {_dual or f'+{abs(shift_nt)} nt'} "
                f"(sequence not echoed in this summary).<br><br>"
            )

        if ptc_exon_rank is not None:
            if last_rank is not None:
                ptc_exon_loc = f" — new stop falls in <b>exon {ptc_exon_rank}</b> of {last_rank} coding exons"
            else:
                ptc_exon_loc = f" — new stop falls in <b>exon {ptc_exon_rank}</b>"
        else:
            ptc_exon_loc = ""
        narrative = (
            junction_math_html
            + f"<b>{cryptic_type}</b> {shift_str} nt from canonical (SpliceAI gain {gain_signal:.2f}). "
            f"{frame_word.capitalize()} → PTC at aa {ptc_aa_position} (<b>{fs_ter_str}</b>){ptc_exon_loc}. "
            f"{length_short} {nmd_short}"
            + (f" <span style='color:#a7f3d0;font-size:0.92em'>PTC location detail: {nmd_reason}</span>" if nmd_reason else "")
        )

        # Propagate the truncation math to parsed_data so the downstream Truncation /
        # NMD logic can pick it up just like for a regular nonsense / frameshift call.
        if truncated_protein_length > 0:
            parsed_data['cryptic_truncated_protein_length'] = truncated_protein_length
            parsed_data['cryptic_full_protein_length'] = full_protein_length or None
            if truncation_fraction is not None:
                parsed_data['cryptic_truncation_fraction'] = truncation_fraction
                parsed_data['cryptic_truncation_pct'] = truncation_pct
                parsed_data['cryptic_retained_pct'] = retained_pct
                # Mirror into the canonical truncation field so the existing UI
                # "Truncation Geometry" and ACMG modules can act on it.
                if not parsed_data.get('nmd_escape_truncation_fraction'):
                    parsed_data['nmd_escape_truncation_fraction'] = truncation_fraction
            # setdefault would skip when an earlier path stamped the
            # `protein_start = 0` placeholder; force-overwrite when we have a
            # real cryptic PTC so the Truncated/PTC banner gets the right aa.
            existing_ps = parsed_data.get('protein_start')
            if not isinstance(existing_ps, int) or existing_ps <= 0:
                fs_aa = _cryptic_outcome_fs_start_aa({
                    'first_changed_aa_pos': first_changed_aa_pos,
                    'truncated_protein_length': truncated_protein_length,
                })
                if fs_aa:
                    parsed_data['protein_start'] = int(fs_aa)
            existing_da = parsed_data.get('downstream_aas')
            if not isinstance(existing_da, int) or existing_da == 0:
                parsed_data['downstream_aas'] = downstream_aas

        return _junction_align_attach_cryptic_ctx(
            _annotate_junction_extension_fields({
                'shift_nt': shift_nt,
                'inserted_cdna': inserted_cdna,
                'insert_triplet_decode': insert_triplet_decode,
                'cryptic_type': cryptic_type,
                'in_frame_shift': in_frame,
                'first_new_codon': first_new_codon_str,
                'first_new_aa': first_new_aa,
                'first_new_aa_3': first_new_aa_3,
                'first_changed_aa_pos': first_changed_aa_pos,
                'ptc_aa_position': ptc_aa_position,
                'downstream_new_aas': downstream_aas,
                'fs_ter_str': fs_ter_str,
                'ptc_exon_rank': ptc_exon_rank,
                'ptc_fraction_in_exon': ptc_fraction_in_exon,
                'last_coding_rank': last_rank,
                'nmd_escape': nmd_escape,
                'nmd_reason': nmd_reason,
                'gain_signal': gain_signal,
                'loss_signal': loss_signal,
                'truncated_protein_length': truncated_protein_length,
                'full_protein_length': full_protein_length or None,
                'truncation_fraction': truncation_fraction,
                'truncation_pct': truncation_pct,
                'retained_pct': retained_pct,
                'narrative': narrative,
            }),
            parsed_data=parsed_data,
            cx=cx,
            cds_seq=cds_seq,
            layout='acceptor_junction' if is_acceptor else 'donor_junction',
            transcript_seq=transcript_seq,
            mut_seq=mut_seq,
            junction_t_idx=junction_t_idx,
            var_idx_t=var_idx_t,
            cryptic_site_pos=chosen_site,
            inserted_cdna=inserted_cdna,
        )
    except Exception as e:
        print(f"Cryptic splice resolver error: {e}")
        return None


def _spliceai_scores_4(parsed_data):
    """Return (ds_ag, ds_al, ds_dg, ds_dl) as floats."""
    def _f(k, d=0.0):
        try:
            return float(parsed_data.get(k) or d)
        except (TypeError, ValueError):
            return d
    return (
        _f('spliceai_ds_ag'),
        _f('spliceai_ds_al'),
        _f('spliceai_ds_dg'),
        _f('spliceai_ds_dl'),
    )


SPLICEAI_RECONCILE_MIN = 0.2  # need at least this on the max relevant delta to run any reconcile


SPLICEAI_JUNCTION_PRIMARY_MIN = 0.5  # "gain" path: DS_AG/DS_DG must clear this


SPLICEAI_COMPETING_FLOOR = 0.5  # competing: both gain and loss must clear this (e.g. 0.85 & 0.99)


_CANONICAL_JUNCTION_DUP_MAX_OFFSET = 20


def _canonical_junction_dup_site_label(cj):
    """Human label for donor (+K) or acceptor (−K) junction duplication."""
    if not cj:
        return 'junction dup'
    side = 'donor' if cj.get('site') == 'donor' else 'acceptor'
    sign = '+' if cj.get('site') == 'donor' else '−'
    try:
        off = int(cj.get('offset') or 0)
    except (TypeError, ValueError):
        off = 0
    off_end = cj.get('offset_end')
    try:
        off_end_i = int(off_end) if off_end is not None else None
    except (TypeError, ValueError):
        off_end_i = None
    if off_end_i is not None and off_end_i > off:
        return f'{side} ({sign}{off} to {sign}{off_end_i} dup)'
    if off:
        return f'{side} ({sign}{off} dup)'
    return f'{side} junction dup'


def _canonical_splice_junction_from_hgvs(c_dot):
    """
    Canonical splice-junction HGVS (c.N±k, c.N±K_±M dup/del). VEP often labels junction
    dups as frameshift; curators and the CGI matrix treat ±1 dup as donor/acceptor variants.
    """
    if not c_dot:
        return None
    s = re.sub(r'\s+', '', str(c_dot)).lower()
    if not s.startswith('c.'):
        return None
    # Range intronic dup/del on one anchor: c.4156+1_4156+4dup
    m_rng = re.search(r'c\.(-?\d+)([\+\-])(\d+)_\1\2(\d+)(dup|del)$', s)
    if m_rng:
        sign = m_rng.group(2)
        try:
            off_start = int(m_rng.group(3))
            off_end = int(m_rng.group(4))
        except ValueError:
            return None
        off_lo, off_hi = min(off_start, off_end), max(off_start, off_end)
        if off_lo >= 1 and off_hi <= _CANONICAL_JUNCTION_DUP_MAX_OFFSET:
            return {
                'site': 'donor' if sign == '+' else 'acceptor',
                'offset': off_lo,
                'offset_end': off_hi,
                'kind': m_rng.group(5),
                'anchor': int(m_rng.group(1)),
            }
        return None
    m_dup = re.search(r'c\.(-?\d+)([\+\-])(\d+)(dup|del)$', s)
    if m_dup:
        sign, off_s, op = m_dup.group(2), m_dup.group(3), m_dup.group(4)
        try:
            off = int(off_s)
        except ValueError:
            return None
        if 1 <= off <= _CANONICAL_JUNCTION_DUP_MAX_OFFSET:
            return {
                'site': 'donor' if sign == '+' else 'acceptor',
                'offset': off,
                'kind': op,
                'anchor': int(m_dup.group(1)),
            }
        return None
    m_junc = re.search(r'c\.(-?\d+)([\+\-])(\d+)', s)
    if not m_junc:
        return None
    sign, off_s = m_junc.group(2), m_junc.group(3)
    try:
        off = int(off_s)
    except ValueError:
        return None
    if off not in (1, 2):
        return None
    return {
        'site': 'donor' if sign == '+' else 'acceptor',
        'offset': off,
        'kind': 'sub',
        'anchor': int(m_junc.group(1)),
    }


def _cdot_body_from_hgvs_label(label):
    """Return ``c.…`` tail from ``NM_…:c.…`` or bare ``c.…``."""
    s = str(label or '').strip()
    if ':' in s:
        s = s.split(':')[-1].strip()
    return s if s.lower().startswith('c.') else ''


def _same_canonical_splice_junction_locus(c_dot_a, c_dot_b):
    """
    Same exon–intron anchor and donor/acceptor side, different allele
    (e.g. c.87+1G>C vs c.87+2dup at the 5′ donor of exon 3).
    """
    a = _cdot_body_from_hgvs_label(c_dot_a)
    b = _cdot_body_from_hgvs_label(c_dot_b)
    if not a or not b:
        return False
    if _hgvs_c_dot_alleles_equal(a, b):
        return False
    ja = _canonical_splice_junction_from_hgvs(a)
    jb = _canonical_splice_junction_from_hgvs(b)
    if not ja or not jb:
        return False
    return ja.get('anchor') == jb.get('anchor') and ja.get('site') == jb.get('site')


def _splice_intronic_locus_from_hgvs(c_dot):
    """Parse c.N±k (or junction dup/del range) into anchor, site, and intronic offset."""
    if not c_dot:
        return None
    s = re.sub(r'\s+', '', str(c_dot)).lower()
    if not s.startswith('c.'):
        return None
    m_rng = re.search(r'c\.(-?\d+)([\+\-])(\d+)_\1\2(\d+)(dup|del)$', s)
    if m_rng:
        sign = m_rng.group(2)
        try:
            off_lo = int(m_rng.group(3))
            off_hi = int(m_rng.group(4))
        except ValueError:
            return None
        return {
            'site': 'donor' if sign == '+' else 'acceptor',
            'offset': min(off_lo, off_hi),
            'offset_end': max(off_lo, off_hi),
            'kind': m_rng.group(5),
            'anchor': int(m_rng.group(1)),
        }
    m = re.search(r'c\.(-?\d+)([\+\-])(\d+)', s)
    if not m:
        return None
    try:
        off = int(m.group(3))
    except ValueError:
        return None
    return {
        'site': 'donor' if m.group(2) == '+' else 'acceptor',
        'offset': off,
        'kind': 'sub',
        'anchor': int(m.group(1)),
    }


def _near_junction_intronic_locus(c_dot, max_offset=_CANONICAL_JUNCTION_DUP_MAX_OFFSET):
    """c.N±k within 1..max_offset of the exon junction (e.g. BICRA c.151-9, DDX39B c.212-8)."""
    locus = _splice_intronic_locus_from_hgvs(c_dot)
    if not locus:
        return None
    try:
        off = int(locus.get('offset') or 0)
    except (TypeError, ValueError):
        return None
    if off < 1 or off > int(max_offset):
        return None
    return locus


def _primary_splice_affects_canonical_junction(parsed_data, locus):
    """
    True when the modeled primary splice readout targets the canonical AG/GT at this junction
    (whole-exon skip, strict splice consequence, or SpliceAI loss at the variant-anchored site).
    """
    if not parsed_data or not locus:
        return False
    site = locus.get('site')
    try:
        off = int(locus.get('offset') or 0)
    except (TypeError, ValueError):
        off = 0
    if parsed_data.get('splice_deleted_coords'):
        return True
    cons = (parsed_data.get('consequence') or '').lower()
    oc = (parsed_data.get('original_consequence') or '').lower()
    c_dot = parsed_data.get('c_dot') or ''
    if site == 'acceptor' and (
        'splice_acceptor' in cons or 'splice_acceptor' in oc
        or _consequence_is_acceptor_splice(cons, c_dot)
    ):
        return True
    if site == 'donor' and (
        'splice_donor' in cons or 'splice_donor' in oc
        or _consequence_is_donor_splice(cons, c_dot)
    ):
        return True
    ag, al, dg, dl = _spliceai_scores_4(parsed_data)
    if site == 'acceptor':
        loss, gain = float(al or 0), float(ag or 0)
    else:
        loss, gain = float(dl or 0), float(dg or 0)
    if loss >= SPLICEAI_RECONCILE_MIN and loss >= gain:
        return True
    if off <= _CANONICAL_JUNCTION_DUP_MAX_OFFSET and (
        'splice_region' in cons
        or 'splice_region' in oc
        or 'intron' in cons
        or 'intron' in oc
    ):
        return True
    return False


def _resolve_splice_junction_locus(c_dot, parsed_data=None):
    """
    Junction anchor for ClinVar allele lookup: canonical ±1/±2 always; nearby intronic variants
    (e.g. c.2002-3) when the primary splice model affects the canonical acceptor/donor.
    """
    cj = _canonical_splice_junction_from_hgvs(c_dot)
    if cj:
        return cj
    locus = _splice_intronic_locus_from_hgvs(c_dot)
    if not locus:
        return None
    try:
        off = int(locus.get('offset') or 0)
    except (TypeError, ValueError):
        return None
    if off < 1 or off > _CANONICAL_JUNCTION_DUP_MAX_OFFSET:
        return None
    if parsed_data is None:
        return None
    if not _primary_splice_affects_canonical_junction(parsed_data, locus):
        return None
    return locus


def _hit_at_user_splice_junction_locus(user_c_dot, cand_c, parsed_data=None):
    """
    ClinVar hit at the canonical ±1/±2 (or junction dup) for the user's acceptor/donor anchor.
    User may be canonical (c.N±1) or proximal (c.N-3) when primary targets the canonical site.
    """
    cand_body = _cdot_body_from_hgvs_label(cand_c)
    if not cand_body:
        return False
    if _hgvs_c_dot_alleles_equal(_cdot_body_from_hgvs_label(user_c_dot) or '', cand_body):
        return False
    cand_cj = _canonical_splice_junction_from_hgvs(cand_body)
    if not cand_cj:
        return False
    user_locus = _resolve_splice_junction_locus(user_c_dot, parsed_data)
    if user_locus:
        return (
            user_locus.get('anchor') == cand_cj.get('anchor')
            and user_locus.get('site') == cand_cj.get('site')
        )
    return _same_canonical_splice_junction_locus(user_c_dot, cand_c)


def _apply_canonical_splice_hgvs_override(parsed_data):
    """Force splice_donor/splice_acceptor when HGVS is a canonical junction change."""
    cj = _canonical_splice_junction_from_hgvs(parsed_data.get('c_dot') or '')
    if not cj:
        return
    parsed_data.setdefault('original_consequence', parsed_data.get('consequence'))
    parsed_data['canonical_splice_junction'] = True
    parsed_data['consequence'] = (
        'splice_donor_variant' if cj['site'] == 'donor' else 'splice_acceptor_variant'
    )


def _apply_near_splice_region_context(parsed_data):
    """
    Promote junction-proximal intron_variant (e.g. c.151-9G>A) to splice_region_variant.

    VEP often labels −3…−20 / +3…+20 as intron_variant, which previously skipped the
    cryptic resolver and dual-product reconcile used for canonical-adjacent splicing
    (same path as DDX39B c.212-8). Does not mark canonical_splice_junction (±1/±2 only).
    """
    if not parsed_data or parsed_data.get('canonical_splice_junction'):
        return
    cons = (parsed_data.get('consequence') or '').strip().lower()
    if not cons or 'splice_' in cons:
        return
    if 'intron' not in cons:
        return
    locus = _near_junction_intronic_locus(parsed_data.get('c_dot') or '')
    if not locus:
        return
    parsed_data.setdefault('original_consequence', parsed_data.get('consequence'))
    parsed_data['near_canonical_splice_junction'] = True
    parsed_data['consequence'] = 'splice_region_variant'


def _effective_splice_consequence(parsed_data):
    """Splice anchoring for maps/logic after downstream rewrites (e.g. start_lost)."""
    c_dot = parsed_data.get('c_dot') or ''
    orig = (parsed_data.get('original_consequence') or '').lower()
    if orig and (
        'splice' in orig
        or _canonical_splice_junction_from_hgvs(c_dot)
        or parsed_data.get('spliceai_exon_skip_spliceai_primary')
    ):
        return parsed_data.get('original_consequence') or parsed_data.get('consequence') or ''
    return parsed_data.get('consequence') or ''


def _parse_vcf_locus_string(vcf_string):
    """
    Parse Ensembl/Broad chr-pos-ref-alt strings without breaking on hyphens in chrom
    (e.g. chr3-186787485-TAATT-T → ref TAATT, not TAATT from a naive split).
    """
    vs = (vcf_string or '').strip()
    if not vs:
        return None
    parts = vs.split('-')
    if len(parts) < 4:
        return None
    alt = (parts[-1] or '').upper()
    ref = (parts[-2] or '').upper()
    pos_s = parts[-3]
    chrom = '-'.join(parts[:-3])
    if not chrom or not str(pos_s).isdigit() or not ref:
        return None
    return chrom, int(pos_s), ref, alt


def _cryptic_resolver_deletion_bounds(parsed_data, var_g_pos, ref_allele, alt_allele):
    """
    Genomic [del_start, del_end] inclusive for cryptic splice deletion math.

    Prefer ref-allele length over grch38_end when VEP coordinates disagree (e.g.
    EIF4A2 c.910-9_910-6del: AATT/- but grch38_end spans 5 bp).
    """
    ref_u = (ref_allele or '').upper()
    alt_u = (alt_allele or '').upper()
    if (
        alt_u not in ('', '-', '.')
        and len(ref_u) > len(alt_u)
        and ref_u.startswith(alt_u)
    ):
        return var_g_pos + len(alt_u), var_g_pos + len(ref_u) - 1

    ref_len = len(ref_u) if ref_u not in ('', '-', '.') else 0
    del_start_g = var_g_pos
    del_end_g = var_g_pos + max(0, ref_len - 1)
    if ref_len <= 0:
        return del_start_g, del_end_g

    try:
        vep_end = int(parsed_data.get('grch38_end') or 0)
    except (TypeError, ValueError):
        vep_end = 0
    if vep_end >= var_g_pos and (vep_end - var_g_pos + 1) == ref_len:
        del_end_g = vep_end
    return del_start_g, del_end_g


def _alleles_usable_for_cryptic_resolver(ref_allele, alt_allele):
    """True when ref/alt are sufficient to enter SNV, dup, or del cryptic math."""
    ref_u = (ref_allele or '').upper()
    alt_u = (alt_allele or '').upper()
    if not ref_u or ref_u in ('-', '.'):
        return False
    if alt_u in ('', '-', '.'):
        return True
    if len(ref_u) == 1 and len(alt_u) == 1:
        return True
    if len(alt_u) > len(ref_u) and alt_u.startswith(ref_u):
        return True
    if len(ref_u) > len(alt_u) and ref_u.startswith(alt_u):
        return True
    return False


def _spliceai_variant_locus_string(chrom, start, ref, alt, vcf_string=None):
    """
    chr-pos-ref-alt for Broad SpliceAI/Pangolin. VEP allele_string -/G is invalid;
    prefer Ensembl vcf_string (e.g. 6-78947622-C-CC for c.4206+1dup).
    """
    c = str(chrom or '').strip()
    if c and not c.startswith('chr'):
        c = 'chr' + c.replace('chr', '')
    parsed = _parse_vcf_locus_string(vcf_string)
    if parsed:
        _chrom, pos, ref_p, alt_p = parsed
        return f"{c}-{pos}-{ref_p}-{alt_p}"
    ref_u = (ref or '').strip().upper()
    alt_u = (alt or '').strip().upper()
    if ref_u and alt_u and ref_u not in ('-', '.') and alt_u not in ('-', '.'):
        try:
            return f"{c}-{int(start)}-{ref_u}-{alt_u}"
        except (TypeError, ValueError):
            pass
    return None


def _consequence_is_acceptor_splice(cons, c_dot=""):
    """
    Acceptor-anchored: canonical splice_acceptor*, or VEP splice_region with c.N- (no c.N+ in same
    heuristics). Many intronic c.1387-4&ndash;style VEPs are splice_region, not splice_acceptor.
    Junction-proximal intron HGVS (c.N−k within 20 nt) is also acceptor-anchored so dual-product
    reconcile matches canonical-adjacent logic (e.g. BICRA c.151-9).
    """
    c = (c_dot or "").lower()
    con = (cons or "").lower()
    if "splice_acceptor" in con:
        return True
    if "splice_region" in con:
        m_minus = re.search(r"c\.\-?\d+\s*-\s*", c)
        m_plus = re.search(r"c\.\-?\d+\s*\+\s*", c)
        if m_minus and m_plus:
            return m_minus.start() < m_plus.start()
        if m_minus and not m_plus:
            return True
    cj = _canonical_splice_junction_from_hgvs(c_dot)
    if cj and cj.get('site') == 'acceptor':
        return True
    locus = _near_junction_intronic_locus(c_dot)
    if locus and locus.get('site') == 'acceptor':
        return True
    return False


def _consequence_is_donor_splice(cons, c_dot=""):
    c = (c_dot or "").lower()
    con = (cons or "").lower()
    if "splice_donor" in con:
        return True
    if "splice_region" in con:
        m_minus = re.search(r"c\.\-?\d+\s*-\s*", c)
        m_plus = re.search(r"c\.\-?\d+\s*\+\s*", c)
        if m_plus and m_minus:
            return m_plus.start() < m_minus.start()
        if m_plus and not m_minus:
            return True
    cj = _canonical_splice_junction_from_hgvs(c_dot)
    if cj and cj.get('site') == 'donor':
        return True
    locus = _near_junction_intronic_locus(c_dot)
    if locus and locus.get('site') == 'donor':
        return True
    return False


def _spliceai_acceptor_gain_dominant(parsed_data, ag=None, al=None):
    """
    Heuristic: cryptic-acceptor use (DS_AG) is plausibly stronger than canonical
    acceptor loss (DS_AL) — use junction as primary for NMD/length fields.
    """
    if not _consequence_is_acceptor_splice(
        parsed_data.get("consequence", "") or "", parsed_data.get("c_dot", "") or ""
    ):
        return False
    if ag is None or al is None:
        ag, al, _, _ = _spliceai_scores_4(parsed_data)
    co = parsed_data.get("cryptic_splice_outcome") or {}
    cryptic_resolved = (
        co
        and not co.get("minimal_signal")
        and co.get("shift_nt") is not None
    )
    min_gain = SPLICEAI_RECONCILE_MIN if cryptic_resolved else SPLICEAI_JUNCTION_PRIMARY_MIN
    if ag < min_gain:
        return False
    if ag <= al + 0.01:
        return False
    return True


def _spliceai_donor_gain_dominant(parsed_data, dg=None, dl=None):
    """Heuristic: cryptic-donor gain (DS_DG) clearly exceeds donor loss (DS_DL)."""
    if not _consequence_is_donor_splice(
        parsed_data.get("consequence", "") or "", parsed_data.get("c_dot", "") or ""
    ):
        return False
    if dg is None or dl is None:
        _, _, dg, dl = _spliceai_scores_4(parsed_data)
    co = parsed_data.get("cryptic_splice_outcome") or {}
    cryptic_resolved = (
        co
        and not co.get("minimal_signal")
        and co.get("shift_nt") is not None
    )
    min_gain = SPLICEAI_RECONCILE_MIN if cryptic_resolved else SPLICEAI_JUNCTION_PRIMARY_MIN
    if dg < min_gain:
        return False
    if dg <= dl + 0.01:
        return False
    return True


def _spliceai_acceptor_both_sides_strong(ag, al, threshold=None):
    """Competing acceptor: gain and loss both high — show both products."""
    t = threshold if threshold is not None else SPLICEAI_COMPETING_FLOOR
    return ag >= t and al >= t


def _spliceai_donor_both_sides_strong(dg, dl, threshold=None):
    t = threshold if threshold is not None else SPLICEAI_COMPETING_FLOOR
    return dg >= t and dl >= t


def _cryptic_outcome_fs_start_aa(co):
    """First aa position of frameshift / altered ORF (not the PTC aa)."""
    if not co:
        return None
    for key in ('first_changed_aa_pos', 'first_insert_aa_pos', 'dup_baseline_naming_aa'):
        try:
            v = int(co.get(key) or 0)
        except (TypeError, ValueError):
            v = 0
        if v > 0:
            return v
    try:
        tlen = int(co.get('truncated_protein_length') or 0)
    except (TypeError, ValueError):
        tlen = 0
    return tlen + 1 if tlen > 0 else None


def _apply_cryptic_truncation_to_parsed_data(parsed_data, co, *, force=False):
    """Mirror cryptic / deep-intronic splice PTC onto top-level truncation banner fields."""
    if not co or co.get('minimal_signal') or co.get('no_stop_found'):
        return
    if co.get('natural_stop_preserved') or co.get('in_frame_exonization') or co.get('pre_atg_utr_pseudoexon'):
        return
    if not co.get('ptc_aa_position'):
        return
    tf = co.get('truncation_fraction')
    if tf is not None:
        try:
            if force or parsed_data.get('deep_intronic_splice_products_active'):
                parsed_data['nmd_escape_truncation_fraction'] = float(tf)
            elif not parsed_data.get('nmd_escape_truncation_fraction'):
                parsed_data['nmd_escape_truncation_fraction'] = float(tf)
        except (TypeError, ValueError):
            pass
    tlen = co.get('truncated_protein_length')
    if tlen is not None:
        try:
            parsed_data['cryptic_truncated_protein_length'] = int(tlen)
        except (TypeError, ValueError):
            pass
    if co.get('full_protein_length') is not None:
        parsed_data['cryptic_full_protein_length'] = co.get('full_protein_length')
    if co.get('truncation_pct') is not None:
        parsed_data['cryptic_truncation_pct'] = co.get('truncation_pct')
    if co.get('retained_pct') is not None:
        parsed_data['cryptic_retained_pct'] = co.get('retained_pct')
    fs_aa = _cryptic_outcome_fs_start_aa(co)
    if fs_aa is not None:
        if force or parsed_data.get('deep_intronic_splice_products_active'):
            parsed_data['protein_start'] = int(fs_aa)
        else:
            existing_ps = parsed_data.get('protein_start')
            if not isinstance(existing_ps, int) or existing_ps <= 0:
                parsed_data['protein_start'] = int(fs_aa)
    da = co.get('downstream_new_aas')
    if da is not None:
        try:
            if force or parsed_data.get('deep_intronic_splice_products_active'):
                parsed_data['downstream_aas'] = int(da)
            else:
                existing_da = parsed_data.get('downstream_aas')
                if not isinstance(existing_da, int) or existing_da == 0:
                    parsed_data['downstream_aas'] = int(da)
        except (TypeError, ValueError):
            pass
    if co.get('fs_ter_str'):
        parsed_data['cryptic_splice_ptc'] = str(co['fs_ter_str']).strip()
        parsed_data['junction_model_hgvs_p'] = str(co['fs_ter_str']).strip()
    try:
        parsed_data['junction_model_ptc_position'] = int(co['ptc_aa_position'])
    except (TypeError, ValueError):
        pass
    try:
        ptc_i = int(co['ptc_aa_position'])
        parsed_data['novel_stop_aa'] = ptc_i
    except (TypeError, ValueError):
        pass
    if co.get('ptc_exon_rank') is not None:
        try:
            parsed_data['junction_model_ptc_exon_rank'] = int(co['ptc_exon_rank'])
        except (TypeError, ValueError):
            pass
    if 'nmd_escape' in co:
        parsed_data['nmd_escape'] = co['nmd_escape']
    if co.get('nmd_reason'):
        parsed_data['nmd_reason'] = co['nmd_reason']
    in_fr = co.get('in_frame_shift', False)
    parsed_data['is_splice_frameshift'] = not in_fr or bool(co.get('ptc_aa_position'))
    parsed_data['splice_is_in_frame'] = in_fr


def _apply_junction_outcome_to_parsed_data(parsed_data, co):
    """Map a resolved cryptic_splice_outcome onto parsed_data (overwrites exon-skip NMD)."""
    if not co or co.get('minimal_signal'):
        return
    if parsed_data.get('deep_intronic_splice_products_active'):
        return
    in_fr = co.get('in_frame_shift', False)
    # In-frame indel that PRESERVES the native terminator: no truncation, no NMD pathway.
    # This is the TRAF7 c.1387-4T>G case where +3 nt CAG just shifts the natural stop by
    # 1 codon (e.g., from p.Ter671 to p.Ter672). Do NOT write any truncation/NMD fields.
    if co.get('natural_stop_preserved'):
        parsed_data['splice_is_in_frame'] = True
        parsed_data['is_splice_frameshift'] = False
        parsed_data['nmd_escape'] = False  # NMD does not apply (no PTC)
        parsed_data['is_nonstop_decay'] = False
        parsed_data['cryptic_natural_stop_preserved'] = True
        if co.get('preserved_stop_aa_pos') is not None:
            parsed_data['cryptic_preserved_stop_aa_pos'] = co['preserved_stop_aa_pos']
        if co.get('net_aa_change') is not None:
            parsed_data['cryptic_net_aa_change'] = co['net_aa_change']
        # Make absolutely sure no stale truncation math leaks through from the exon-skip
        # baseline so the UI doesn't report a false "truncated to N of M aa" line.
        for k in (
            'nmd_escape_truncation_fraction', 'cryptic_truncated_protein_length',
            'cryptic_full_protein_length', 'cryptic_truncation_fraction',
            'cryptic_truncation_pct', 'cryptic_retained_pct', 'cryptic_splice_ptc',
        ):
            parsed_data.pop(k, None)
        return
    if co.get('in_frame_exonization'):
        parsed_data['splice_is_in_frame'] = True
        parsed_data['is_splice_frameshift'] = False
        parsed_data['nmd_escape'] = False
        parsed_data['is_nonstop_decay'] = False
        parsed_data['deep_intronic_in_frame_exonization'] = True
        if co.get('predicted_hgvs_p'):
            parsed_data['deep_intronic_predicted_hgvs_p'] = co['predicted_hgvs_p']
        if co.get('mutant_protein_length') is not None:
            parsed_data['deep_intronic_mutant_protein_length'] = co['mutant_protein_length']
        for k in (
            'nmd_escape_truncation_fraction', 'cryptic_truncated_protein_length',
            'cryptic_full_protein_length', 'cryptic_truncation_fraction',
            'cryptic_truncation_pct', 'cryptic_retained_pct', 'cryptic_splice_ptc',
        ):
            parsed_data.pop(k, None)
        return
    if co.get('no_stop_found'):
        parsed_data['nmd_escape'] = True
        parsed_data['is_nonstop_decay'] = True
        if not in_fr:
            parsed_data['is_splice_frameshift'] = True
        else:
            parsed_data['is_splice_frameshift'] = False
        parsed_data['splice_is_in_frame'] = in_fr
        return
    if not co.get('ptc_aa_position'):
        return
    _apply_cryptic_truncation_to_parsed_data(parsed_data, co)


def _store_junction_model_sidecar(parsed_data, co, ag=None, al=None, dg=None, dl=None):
    """
    For competing-isoform mode: keep main NMD as exon-skip; add parallel junction metrics.
    """
    if not co or co.get('minimal_signal'):
        if co and co.get('minimal_signal'):
            bit = []
            if ag is not None and al is not None:
                bit.append(f"DS_AG={ag:.2f}, DS_AL={al:.2f}")
            if dg is not None and dl is not None:
                bit.append(f"DS_DG={dg:.2f}, DS_DL={dl:.2f}")
            if bit:
                parsed_data['junction_model_narrative_note'] = (
                    "SpliceAI: " + " | ".join(bit) + " — sequence-resolved cryptic translation not completed."
                )
        return
    in_fr = co.get('in_frame_shift', False)
    tf = co.get('truncation_fraction')
    if tf is not None:
        try:
            parsed_data['nmd_junction_model_truncation_fraction'] = float(tf)
        except (TypeError, ValueError):
            pass
    tlen = co.get('truncated_protein_length')
    if tlen is not None:
        try:
            parsed_data['junction_model_truncated_protein_length'] = int(tlen)
        except (TypeError, ValueError):
            pass
    if co.get('ptc_aa_position'):
        try:
            parsed_data['junction_model_ptc_position'] = int(co['ptc_aa_position'])
        except (TypeError, ValueError):
            pass
    if co.get('ptc_exon_rank') is not None:
        try:
            parsed_data['junction_model_ptc_exon_rank'] = int(co['ptc_exon_rank'])
        except (TypeError, ValueError):
            pass
    frac_j = co.get('ptc_fraction_in_exon')
    if frac_j is not None:
        try:
            parsed_data['junction_model_ptc_fraction_in_exon'] = float(frac_j)
        except (TypeError, ValueError):
            pass
    if co.get('fs_ter_str'):
        parsed_data['junction_model_hgvs_p'] = str(co['fs_ter_str'])
    if co.get('nmd_escape') is not None:
        parsed_data['junction_model_nmd_escape'] = co['nmd_escape']
    if co.get('nmd_reason'):
        parsed_data['junction_model_nmd_reason'] = str(co['nmd_reason'])
    if co.get('no_stop_found'):
        parsed_data['junction_model_is_nonstop'] = True
        parsed_data['junction_model_in_frame'] = in_fr
    dnote = (co.get('narrative') or '').replace('<b>', '').replace('</b>', '')[:500]
    if dnote:
        parsed_data['junction_model_summary'] = dnote
    d_a = co.get('downstream_new_aas')
    if d_a is not None:
        try:
            parsed_data['junction_model_downstream_aas'] = int(d_a)
        except (TypeError, ValueError):
            pass


def _finalize_splice_report_narratives(parsed_data):
    """
    When competing-isoform or junction-primary mode ships a full Splice Structural Math
    block, the UI otherwise repeats the same DS_AG/DS_AL story four ways (summary box,
    splice-model box, parallel-junction strip, logic list). Collapse to one short disclaimer
    and rely on structural math for numbers + ordering.
    """
    sfm = (parsed_data.get('splice_frame_math') or '').strip()
    if not sfm:
        return
    competing = bool(parsed_data.get('spliceai_competing_splice_isoforms'))
    jpref = bool(parsed_data.get('spliceai_junction_model_preferred'))
    if not (competing or jpref):
        return
    # Competing mode with no cryptic outcome keeps the short backend interpretation
    # ("use RNA / whole-exon math"); do not wipe it.
    if competing and not (parsed_data.get('cryptic_splice_outcome') or {}):
        return
    # Junction-primary with only the parallel baseline (resolver empty) still needs the
    # long SpliceAI narrative + green splice-model box.
    has_product_summary = _splice_frame_math_has_product_summaries(sfm)
    if not has_product_summary:
        return
    parsed_data['spliceai_narrative_condensed'] = True
    parsed_data['spliceai_narrative'] = (
        "SpliceAI scores predict splice-site usage on the alternate allele, not proof from patient RNA. "
        "Gain vs loss deltas and product-level consequences are summarized under Splice Structural Math."
    )
    parsed_data['splice_model_interpretation'] = ''
    parsed_data['splice_suppress_parallel_junction_ui'] = True


def _reconcile_splice_model_precedence(parsed_data):
    """
    Three paths:
    (1) Competing: both gain and loss (acceptor: AG+AL, donor: DG+DL) are strong — show both
        whole-exon and junction models; do not single-path override NMD.
    (2) Junction-primary: one side clearly larger (e.g. AG > AL) — cryptic is primary for NMD/length.
    (3) Otherwise: exon-skip default only.
    """
    cons = parsed_data.get('consequence', '') or ''
    c_d = parsed_data.get('c_dot', '') or ''
    is_acc = _consequence_is_acceptor_splice(cons, c_d)
    is_don = _consequence_is_donor_splice(cons, c_d)
    if not is_acc and not is_don:
        return
    ag, al, dg, dl = _spliceai_scores_4(parsed_data)
    # No competing/junction-primary extras when the relevant site deltas are SpliceAI noise
    acc_ok = (not is_acc) or (max(ag, al) >= SPLICEAI_RECONCILE_MIN)
    don_ok = (not is_don) or (max(dg, dl) >= SPLICEAI_RECONCILE_MIN)
    if not (acc_ok and don_ok):
        return
    esfx = parsed_data.get('exon_skip_model_truncation_fraction')
    nmd0 = parsed_data.get('nmd_escape_truncation_fraction')
    if esfx is not None and 'nmd_exon_skip_model_truncation_fraction' not in parsed_data:
        try:
            parsed_data['nmd_exon_skip_model_truncation_fraction'] = float(esfx)
        except (TypeError, ValueError):
            pass
    elif nmd0 is not None and 'nmd_exon_skip_model_truncation_fraction' not in parsed_data:
        try:
            parsed_data['nmd_exon_skip_model_truncation_fraction'] = float(nmd0)
        except (TypeError, ValueError):
            pass
    # --- Competing isoforms: strong gain AND strong loss (literature can favor either; scores need not be equal)
    if is_acc and _spliceai_acceptor_both_sides_strong(ag, al):
        _reconcile_competing_splice(parsed_data, ag, al, 'acceptor', dg, dl)
        return
    if is_don and _spliceai_donor_both_sides_strong(dg, dl):
        _reconcile_competing_splice(parsed_data, ag, al, 'donor', dg, dl)
        return
    exon_math = parsed_data.get('splice_frame_math', '')
    # Standard for the splice-block write-up:
    #   1. Cryptic-gain summary (when SpliceAI gain is dominant) goes first.
    #   2. Whole-exon-skip baseline (size + % of protein + SOP logic sentence)
    #      ALWAYS follows — never gated on whether the loss delta is "strong
    #      enough" to be parallel. Reviewers must see the same size+threshold
    #      structure on every splice variant; the strength of the loss signal
    #      changes only the *label* over the baseline, not whether it appears.
    def _label_exon_skip_baseline(label_text):
        return (
            f'<b>{label_text}</b> '
            f'<span style="color:#94a3b8;font-size:0.9em">(skip-the-whole-exon outcome — used for the &lt;10% / &ge;10% PVS1/PM4 SOP decision)</span>: '
            f'{exon_math}'
        )

    if is_acc and _spliceai_acceptor_gain_dominant(parsed_data, ag, al):
        if exon_math and 'Whole-exon delete (reference)' not in exon_math:
            parsed_data['splice_frame_math_exon_skip_ref'] = exon_math
            _co0 = parsed_data.get("cryptic_splice_outcome") or {}
            gain_summary_html = _build_splice_gain_summary_html(_co0, parsed_data)
            loss_supports_parallel_skip = float(al or 0) >= SPLICEAI_RECONCILE_MIN
            _locus = ""
            _vex = parsed_data.get("variant_exon")
            if loss_supports_parallel_skip and _vex is not None:
                _sh0 = _co0.get("shift_nt")
                _locus = (
                    f"<span style=\"color:#94a3b8;font-size:0.85em\">"
                    f"Same-locus context: the gain above is the cryptic 3&prime; splice; the exon-skip line below "
                    f"is the worst-case alternative if the canonical acceptor were fully ablated."
                )
                if _sh0 is not None and not _co0.get("minimal_signal"):
                    try:
                        _locus += f" Sequence-resolved offset: {abs(int(_sh0))} nt."
                    except (TypeError, ValueError):
                        pass
                _locus += "</span>"
            baseline_label = (
                'Parallel exon-skip baseline'
                if loss_supports_parallel_skip
                else 'Whole-exon-skip baseline'
            )
            parsed_data['splice_frame_math'] = (
                gain_summary_html
                + (f"{_locus}<br><br>" if _locus else "")
                + _label_exon_skip_baseline(baseline_label)
            )
        return _reconcile_junction_only_acceptor(parsed_data, ag, al)
    if is_don and _spliceai_donor_gain_dominant(parsed_data, dg, dl):
        if exon_math and 'Whole-exon delete (reference' not in exon_math and 'Competing' not in exon_math:
            parsed_data['splice_frame_math_exon_skip_ref'] = exon_math
            _co0d = parsed_data.get("cryptic_splice_outcome") or {}
            gain_summary_html = _build_splice_gain_summary_html(_co0d, parsed_data)
            loss_supports_parallel_skip = float(dl or 0) >= SPLICEAI_RECONCILE_MIN
            baseline_label = (
                'Parallel exon-skip baseline'
                if loss_supports_parallel_skip
                else 'Whole-exon-skip baseline'
            )
            parsed_data['splice_frame_math'] = (
                gain_summary_html
                + _label_exon_skip_baseline(baseline_label)
            )
        return _reconcile_junction_only_donor(parsed_data, dg, dl)


def _reconcile_junction_only_acceptor(parsed_data, ag, al):
    co = parsed_data.get('cryptic_splice_outcome') or {}
    if not co:
        parsed_data['spliceai_junction_model_preferred'] = True
        parsed_data['splice_model_interpretation'] = (
            f"SpliceAI: DS_AG={ag:.2f} and DS_AL={al:.2f} with gain > loss, but the sequence-based cryptic resolver "
            f"returned no window. NMD/length fields use whole-exon-skip; confirm with RNA or manual review."
        )
        return
    parsed_data['spliceai_junction_model_preferred'] = True
    if float(al or 0) >= SPLICEAI_RECONCILE_MIN:
        parallel_note = "whole-exon skipping may still occur in parallel."
    else:
        parallel_note = (
            f"a parallel whole-exon skip from canonical acceptor loss is not modeled here "
            f"(DS_AL &lt; {SPLICEAI_RECONCILE_MIN:.2f})."
        )
    parsed_data['splice_model_interpretation'] = (
        f"SpliceAI: acceptor-gain (DS_AG={ag:.2f}) exceeds loss (DS_AL={al:.2f}). The primary quantitative model is "
        f"cryptic-acceptor splicing; {parallel_note}"
    )
    if co.get('minimal_signal'):
        return
    _apply_junction_outcome_to_parsed_data(parsed_data, co)


def _reconcile_junction_only_donor(parsed_data, dg, dl):
    co = parsed_data.get('cryptic_splice_outcome') or {}
    if not co:
        parsed_data['spliceai_junction_model_preferred'] = True
        parsed_data['splice_model_interpretation'] = (
            f"SpliceAI: DS_DG={dg:.2f} and DS_DL={dl:.2f} with gain > loss, but the cryptic resolver had no window. "
            f"NMD/length from whole-exon-skip; confirm with RNA."
        )
        return
    parsed_data['spliceai_junction_model_preferred'] = True
    if float(dl or 0) >= SPLICEAI_RECONCILE_MIN:
        parallel_note = "exon-skip in parallel is possible when donor loss is supported at this threshold."
    else:
        parallel_note = (
            f"a parallel whole-exon skip from canonical donor loss is not modeled here "
            f"(DS_DL &lt; {SPLICEAI_RECONCILE_MIN:.2f})."
        )
    parsed_data['splice_model_interpretation'] = (
        f"SpliceAI: donor-gain (DS_DG={dg:.2f}) exceeds loss (DS_DL={dl:.2f}). Primary model: cryptic-donor; "
        f"{parallel_note}"
    )
    if co.get('minimal_signal'):
        return
    _apply_junction_outcome_to_parsed_data(parsed_data, co)


def _competing_splice_product_roles(gain_ds, loss_ds):
    """
    Product 1 = stronger SpliceAI delta at this site; Product 2 = weaker.
    Returns (gain_role, loss_role, product1_is_loss).
    """
    try:
        g = float(gain_ds or 0)
        l = float(loss_ds or 0)
    except (TypeError, ValueError):
        g, l = 0.0, 0.0
    if l > g + 0.01:
        return (
            'Product 2 (gain / cryptic junction)',
            'Product 1 (loss / exon skip)',
            True,
        )
    return (
        'Product 1 (gain / cryptic junction)',
        'Product 2 (loss / exon skip)',
        False,
    )


def _reconcile_competing_splice(parsed_data, ag, al, mode, dg, dl):
    """Both gain and loss are high; do not treat the numerically higher delta as sole truth."""
    pd = parsed_data
    co = pd.get('cryptic_splice_outcome') or {}
    if mode == 'acceptor':
        score_bits = f"DS_AG={ag:.2f}, DS_AL={al:.2f}"
        gain_ds, loss_ds = ag, al
    else:
        score_bits = f"DS_DG={dg:.2f}, DS_DL={dl:.2f}"
        gain_ds, loss_ds = dg, dl
    exon = pd.get('splice_frame_math', '') or ''
    if exon and 'Competing' not in exon:
        loss_higher = (loss_ds > gain_ds + 0.01)
        gain_higher = (gain_ds > loss_ds + 0.01)
        pd['spliceai_loss_delta_exceeds_gain'] = bool(loss_higher)
        pd['spliceai_gain_delta_exceeds_loss'] = bool(gain_higher)
        gain_role, loss_role, product1_is_loss = _competing_splice_product_roles(gain_ds, loss_ds)
        gain_summary_html = _build_splice_gain_summary_html(co, pd, product_role=gain_role)
        loss_signal = loss_ds
        loss_summary_html = _build_splice_loss_summary_html(
            pd, loss_signal=loss_signal, mode=mode, product_role=loss_role,
        )
        pd.setdefault('splice_frame_math_exon_skip_ref', exon)
        # Product 1 (stronger SpliceAI delta) always appears first in the report.
        # Always append the whole-exon-skip baseline (size + % of protein +
        # SOP logic sentence) so the size+threshold structure is consistent
        # across every splice variant, regardless of which SpliceAI deltas
        # are dominant.
        baseline = (
            f'<b>Whole-exon-skip baseline</b> '
            f'<span style="color:#94a3b8;font-size:0.9em">(size + % of protein — used for the &lt;10% / &ge;10% PVS1/PM4 SOP decision)</span>: '
            f'{exon}'
        )
        if product1_is_loss:
            pd['splice_frame_math'] = loss_summary_html + gain_summary_html + baseline
        else:
            pd['splice_frame_math'] = gain_summary_html + loss_summary_html + baseline
    elif exon and 'Competing' in exon:
        pass
    pd['spliceai_competing_splice_isoforms'] = True
    pd['splice_model_interpretation'] = (
        f"SpliceAI: strong gain and loss at one locus ({score_bits}). Different RNA products; RNA studies may "
        "not match the numerically stronger delta."
    )
    if co and not co.get('minimal_signal'):
        if mode == 'acceptor':
            _store_junction_model_sidecar(pd, co, ag=ag, al=al, dg=None, dl=None)
        else:
            _store_junction_model_sidecar(pd, co, ag=None, al=None, dg=dg, dl=dl)
    elif co and co.get('minimal_signal'):
        if mode == 'acceptor':
            _store_junction_model_sidecar(pd, co, ag=ag, al=al, dg=None, dl=None)
        else:
            _store_junction_model_sidecar(pd, co, ag=None, al=None, dg=dg, dl=dl)
    if not co:
        pd['splice_model_interpretation'] = (
            f"Strong competing SpliceAI deltas ({score_bits}) with no full cryptic resolution. Use RNA and the whole-exon math below."
        )
    _apply_exon_skip_as_primary_truncation_for_competing(pd)
    return


SPLICEAI_EXON_SKIP_PRIMARY_MIN_LOSS = 0.3


SPLICEAI_EXON_SKIP_PRIMARY_GAP = 0.3

# Variant-anchored junction: SpliceAI loss at the canonical site (small |Δ|) beats weak
# same-side gain even when DS_DL/DS_AL is below the strict exon-skip-primary floor.
SPLICEAI_JUNCTION_PROXIMAL_MAX_BP = 10
SPLICEAI_JUNCTION_PROXIMAL_GAIN_GAP = 0.05


def _spliceai_junction_proximal_loss_wins(parsed_data, loss, gain, dp_key):
    """SpliceAI site-anchored loss at the variant junction beats weak same-side gain."""
    dp = _parse_spliceai_dp(parsed_data.get(dp_key))
    if dp is None or abs(dp) > SPLICEAI_JUNCTION_PROXIMAL_MAX_BP:
        return False
    try:
        loss_v = float(loss or 0.0)
        gain_v = float(gain or 0.0)
    except (TypeError, ValueError):
        return False
    return (
        loss_v >= SPLICEAI_RECONCILE_MIN
        and loss_v > gain_v + SPLICEAI_JUNCTION_PROXIMAL_GAIN_GAP
    )


def _secondary_cryptic_gain_signal(parsed_data, is_don, is_acc, dg=None, ag=None):
    """
    Best secondary cryptic-gain score for labeling/maps.
    Pangolin may carry the deep-intron gain when SpliceAI DS_DG/DS_AG at the junction is weak.
    Returns (score, dp_key, label_fragment).
    """
    if dg is None or ag is None:
        _, _, dg, ag = _spliceai_scores_4(parsed_data)
    try:
        dg = float(dg or 0.0)
        ag = float(ag or 0.0)
        psg = abs(float(parsed_data.get('pangolin_ds_sg') or 0.0))
    except (TypeError, ValueError):
        dg = ag = psg = 0.0
    if is_don and not is_acc:
        if dg >= SPLICEAI_RECONCILE_MIN:
            return dg, 'spliceai_dp_dg', f'donor gain (DS_DG {dg:.2f})'
        if psg >= SPLICEAI_RECONCILE_MIN:
            return psg, 'pangolin_dp_sg', f'donor gain (Pangolin DS_SG {psg:.2f})'
        return dg, 'spliceai_dp_dg', f'donor gain (DS_DG {dg:.2f})'
    if is_acc and not is_don:
        if ag >= SPLICEAI_RECONCILE_MIN:
            return ag, 'spliceai_dp_ag', f'acceptor gain (DS_AG {ag:.2f})'
        if psg >= SPLICEAI_RECONCILE_MIN:
            return psg, 'pangolin_dp_sg', f'acceptor gain (Pangolin DS_SG {psg:.2f})'
        return ag, 'spliceai_dp_ag', f'acceptor gain (DS_AG {ag:.2f})'
    best = max(dg, ag, psg)
    if best == psg and psg >= SPLICEAI_RECONCILE_MIN:
        return psg, 'pangolin_dp_sg', f'cryptic splice gain (Pangolin DS_SG {psg:.2f})'
    if dg >= ag:
        return dg, 'spliceai_dp_dg', f'cryptic splice gain (DS_DG {dg:.2f})'
    return ag, 'spliceai_dp_ag', f'cryptic splice gain (DS_AG {ag:.2f})'


def _format_secondary_cryptic_gain_logic_html(parsed_data):
    """Logic-explanation block for SpliceAI cryptic gain when exon-skip is primary."""
    if not parsed_data.get('spliceai_secondary_gain_product'):
        return ''
    co = parsed_data.get('spliceai_secondary_cryptic_outcome') or {}
    co_resolved = bool(co and not co.get('minimal_signal'))
    schematic = _splice_viz_secondary_gain_schematic_fields(parsed_data) if not co_resolved else {}
    if not co_resolved and not schematic:
        return ''
    c_dot = parsed_data.get('c_dot') or ''
    cons = _effective_splice_consequence(parsed_data)
    is_don = _consequence_is_donor_splice(cons, c_dot)
    is_acc = _consequence_is_acceptor_splice(cons, c_dot)
    try:
        dg = float(parsed_data.get('spliceai_ds_dg') or 0.0)
        ag = float(parsed_data.get('spliceai_ds_ag') or 0.0)
    except (TypeError, ValueError):
        dg = ag = 0.0
    ds, dp_key, lbl = _secondary_cryptic_gain_signal(parsed_data, is_don, is_acc, dg, ag)
    dp = _parse_spliceai_dp(parsed_data.get(dp_key))
    src = 'Pangolin' if dp_key.startswith('pangolin') else 'SpliceAI'
    dp_bit = f' at &Delta;{dp:+d} bp ({src})' if dp is not None else ''
    lead = (
        f"<div style='color:#fde68a;border-left:3px solid #fbbf24;padding:8px 10px;margin-bottom:8px;'>"
        f"<b>Secondary product:</b> {lbl}{dp_bit} "
        f"— shown on the maps below but <b>not</b> the primary mechanistic driver "
        f"(whole-exon skip from site loss is primary).</div>"
    )
    body_parts = []
    if co_resolved:
        narr = (co.get('narrative') or '').strip()
        if narr:
            body_parts.append(_strip_html_trailing_breaks(narr))
        decode = (co.get('insert_triplet_decode') or parsed_data.get('cryptic_insert_triplet_decode') or '').strip()
        if decode and decode not in narr:
            body_parts.append(decode)
        fs = (co.get('fs_ter_str') or '').strip()
        if fs and fs not in narr:
            body_parts.append(f"Predicted protein: <b>{fs}</b>")
        if not body_parts:
            shift = co.get('shift_nt')
            if shift is not None:
                body_parts.append(f"Net junction shift: {shift:+d} nt relative to canonical splice site.")
    elif schematic:
        retained = schematic.get('pseudoexon_retained_nt')
        try:
            ve = int(parsed_data.get('variant_exon') or 0)
        except (TypeError, ValueError):
            ve = 0
        if is_don and not is_acc and ve > 0:
            body_parts.append(
                f"<b>Geometry (schematic):</b> mRNA exon {ve} is <b>preserved</b> "
                f"(contrast the primary whole-exon skip). "
                f"~{retained} nt of downstream intronic sequence is retained as a "
                f"<b>pseudo-exon</b> between the canonical GT donor and the next acceptor."
            )
        elif is_acc and not is_don and ve > 0:
            body_parts.append(
                f"<b>Geometry (schematic):</b> ~{retained} nt retained upstream of the gained acceptor "
                f"as a pseudo-exon (exon {ve} preserved relative to the primary skip model)."
            )
        else:
            body_parts.append(
                f"<b>Geometry (schematic):</b> ~{retained} nt intronic pseudo-exon retained in the "
                f"mature mRNA (cryptic splice gain product)."
            )
        body_parts.append(
            "<span style='color:#94a3b8;'>Sequence-level ORF / PTC for this secondary product was not "
            "fully resolved (cryptic geometry fetch unavailable). The exon map and junction sequence "
            "map show the schematic retained-intron product.</span>"
        )
    return lead + ('<br><br>'.join(body_parts) if body_parts else '')


def _refresh_secondary_gain_at_spliceai_dp(http_session, parsed_data):
    """
    When exon-skip is primary, re-resolve secondary cryptic gain at the SpliceAI DP
    (e.g. DS_DG at +14) instead of the dup-at-junction shortcut (+2 dup retained at GT).
    """
    c_dot = parsed_data.get('c_dot') or ''
    cons = _effective_splice_consequence(parsed_data)
    is_don = _consequence_is_donor_splice(cons, c_dot)
    is_acc = _consequence_is_acceptor_splice(cons, c_dot)
    try:
        dg = float(parsed_data.get('spliceai_ds_dg') or 0.0)
        ag = float(parsed_data.get('spliceai_ds_ag') or 0.0)
    except (TypeError, ValueError):
        return
    gain_ds, dp_key, _ = _secondary_cryptic_gain_signal(parsed_data, is_don, is_acc, dg, ag)
    co_existing = parsed_data.get('spliceai_secondary_cryptic_outcome') or {}
    if co_existing.get('junction_align_ctx') and not co_existing.get('minimal_signal'):
        return
    loss_primary = bool(parsed_data.get('spliceai_exon_skip_spliceai_primary'))
    if not loss_primary and not parsed_data.get('spliceai_secondary_gain_product'):
        return
    if loss_primary and gain_ds < SPLICEAI_RECONCILE_MIN:
        return
    parsed_data['spliceai_secondary_gain_product'] = True
    dp = _parse_spliceai_dp(parsed_data.get(dp_key))
    if gain_ds < SPLICEAI_RECONCILE_MIN or dp is None:
        return
    co = parsed_data.get('spliceai_secondary_cryptic_outcome') or {}
    cj = _canonical_splice_junction_from_hgvs(c_dot)
    need = False
    if cj and cj.get('kind') == 'dup':
        try:
            need = abs(int(dp)) != int(cj.get('offset') or 0)
        except (TypeError, ValueError):
            need = True
    elif not str(co.get('inserted_cdna') or '').strip():
        need = True
    if not need:
        return
    coding_exons = parsed_data.get('coding_exons') or []
    ve = parsed_data.get('variant_exon')
    try:
        ve = int(ve) if ve is not None else 0
    except (TypeError, ValueError):
        ve = 0
    cx = None
    if ve > 0:
        cx = next(
            (c for c in coding_exons if int(c.get('anatomical_rank', -1)) == ve),
            None,
        )
    if not cx and coding_exons:
        cx = coding_exons[-1]
    cds = parsed_data.get('cds_seq') or ''
    if not cds and http_session:
        _ensure_cds_seq(parsed_data, http_session)
        cds = parsed_data.get('cds_seq') or ''
    if not (http_session and cx and cds):
        return
    alt = _resolve_cryptic_splice_outcome(
        http_session,
        parsed_data,
        cx,
        coding_exons,
        cds,
        c_dot,
        cons,
        parsed_data.get('transcript_strand') or 1,
        parsed_data.get('transcript_chrom') or parsed_data.get('grch38_chrom'),
        skip_dup_shortcut=True,
    )
    if alt and not alt.get('minimal_signal'):
        parsed_data['spliceai_secondary_cryptic_outcome'] = alt
        parsed_data['spliceai_secondary_mechanism'] = (
            'donor_gain' if (is_don and not is_acc) else 'acceptor_gain'
        )


def _ensure_splice_secondary_cryptic_gain(http_session, parsed_data):
    """Last-chance secondary cryptic-gain resolve before junction map build."""
    _refresh_secondary_gain_at_spliceai_dp(http_session, parsed_data)


def _stash_secondary_cryptic_gain_before_strip(parsed_data, co, is_don, is_acc, ag, al, dg, dl):
    """When exon-skip is primary, keep a resolved cryptic-gain model for secondary maps."""
    gain_ds, _, _ = _secondary_cryptic_gain_signal(parsed_data, is_don, is_acc, dg, ag)
    if gain_ds < SPLICEAI_RECONCILE_MIN:
        return
    if co and not co.get('minimal_signal') and (
        co.get('junction_align_ctx')
        or co.get('shift_nt') is not None
        or co.get('inserted_cdna')
    ):
        parsed_data['spliceai_secondary_cryptic_outcome'] = dict(co)
    parsed_data['spliceai_secondary_gain_product'] = True
    if is_don and not is_acc:
        _store_junction_model_sidecar(parsed_data, co, dg=dg, dl=dl)
    elif is_acc and not is_don:
        _store_junction_model_sidecar(parsed_data, co, ag=ag, al=al)


def _spliceai_exon_skip_takes_precedence_over_weak_cryptic(parsed_data):
    """
    If SpliceAI site loss (DS_AL for acceptor, DS_DL for donor) is high and the same-site
    gain is weak, clear the long cryptic-junction / native-terminator narrative and
    mark whole-exon-skip as the primary SpliceAI mechanistic readout. Prepends a short
    banner onto splice_frame_math (including 5' donor / 3' acceptor as secondary when SpliceAI
    is significant) so the Logic Explanation is not a wall of contradictions.
    """
    if not parsed_data.get('spliceai_fetched'):
        return
    if parsed_data.get('splice_api_error'):
        return
    if parsed_data.get('spliceai_junction_model_preferred') or parsed_data.get('spliceai_competing_splice_isoforms'):
        return
    ag, al, dg, dl = _spliceai_scores_4(parsed_data)
    cons = (parsed_data.get('consequence') or '') or ''
    c_dot = (parsed_data.get('c_dot') or '') or ''
    is_acc = _consequence_is_acceptor_splice(cons, c_dot)
    is_don = _consequence_is_donor_splice(cons, c_dot)

    def _dp_bit(dp_key):
        v = parsed_data.get(dp_key)
        if v is None or v == '':
            return ''
        return f" at {v} bp from the variant (per SpliceAI)"

    do_strip = False
    sec_lines = []
    if is_acc and not is_don:
        if al >= SPLICEAI_EXON_SKIP_PRIMARY_MIN_LOSS and (al - ag) >= SPLICEAI_EXON_SKIP_PRIMARY_GAP:
            do_strip = True
        elif _spliceai_junction_proximal_loss_wins(parsed_data, al, ag, 'spliceai_dp_al'):
            do_strip = True
        if (dg >= 0.15 or dl >= 0.15) and is_acc:
            b = f"5' side of same intron (GT: donor): donor gain DS_DG={dg:.2f}{_dp_bit('spliceai_dp_dg')}, donor loss DS_DL={dl:.2f}{_dp_bit('spliceai_dp_dl')} — <b>secondary</b> (different site; not the variant-anchored acceptor)"
            sec_lines.append(b)
    elif is_don and not is_acc:
        if dl >= SPLICEAI_EXON_SKIP_PRIMARY_MIN_LOSS and (dl - dg) >= SPLICEAI_EXON_SKIP_PRIMARY_GAP:
            do_strip = True
        elif _spliceai_junction_proximal_loss_wins(parsed_data, dl, dg, 'spliceai_dp_dl'):
            do_strip = True
        if (ag >= 0.15 or al >= 0.15) and is_don:
            _dp_al = _parse_spliceai_dp(parsed_data.get('spliceai_dp_al'))
            try:
                _ve_note = int(parsed_data.get('variant_exon') or 0)
            except (TypeError, ValueError):
                _ve_note = 0
            if _dp_al is not None and _dp_al < 0 and _ve_note > 0:
                b = (
                    f"acceptor loss DS_AL={al:.2f}{_dp_bit('spliceai_dp_al')} — "
                    f"<b>upstream</b> of variant (&Delta;{_dp_al:+d} bp) targets the acceptor before "
                    f"mRNA exon {_ve_note}; <b>corroborates primary</b> exon {_ve_note} skip "
                    f"(not a separate downstream exon skip)."
                )
            else:
                b = (
                    f"3' side of same intron (AG: acceptor): acceptor gain DS_AG={ag:.2f}{_dp_bit('spliceai_dp_ag')}, "
                    f"acceptor loss DS_AL={al:.2f}{_dp_bit('spliceai_dp_al')} — <b>secondary</b> "
                    f"(different site; not the variant-anchored donor)"
                )
            sec_lines.append(b)

    if not do_strip:
        return

    co = parsed_data.get('cryptic_splice_outcome') or {}
    _stash_secondary_cryptic_gain_before_strip(parsed_data, co, is_don, is_acc, ag, al, dg, dl)
    has_sec_gain = bool(parsed_data.get('spliceai_secondary_gain_product'))

    parsed_data['spliceai_exon_skip_spliceai_primary'] = True
    parsed_data['splice_lof_mechanism_established'] = True
    parsed_data['cryptic_splice_narrative'] = ''
    parsed_data.pop('junction_align_viz_ctx', None)
    for k in (
        'cryptic_splice_outcome', 'cryptic_inserted_cdna', 'cryptic_insert_triplet_decode',
    ):
        parsed_data.pop(k, None)
    for k2 in (
        'cryptic_natural_stop_preserved', 'cryptic_preserved_stop_aa_pos',
        'cryptic_net_aa_change', 'cryptic_splice_ptc',
    ):
        parsed_data.pop(k2, None)

    sfm0 = (parsed_data.get('splice_frame_math') or '').strip()
    if is_acc and not is_don:
        gain_note = ''
        sec_ds, _, sec_lbl = _secondary_cryptic_gain_signal(parsed_data, False, True, dg, ag)
        if has_sec_gain and sec_ds >= SPLICEAI_RECONCILE_MIN:
            gain_note = (
                f"<br><span style='color:#94a3b8;font-size:0.92em'>"
                f"Secondary {sec_lbl} is on the maps below."
                f"</span>"
            )
        lead = (
            f"<div style='color:#a7f3d0;border-left:3px solid #34d399;padding:8px 10px;margin-bottom:10px;'>"
            f"<b>Primary (SpliceAI, variant-anchored 3&prime; acceptor):</b> whole-exon-skip from <b>acceptor loss</b> "
            f"DS_AL={al:.2f}. "
            f"The sequence-level &ldquo;cryptic / native-terminator preserved&rdquo; readout is <b>suppressed</b> for this locus. "
            f"See the exon-skip / ORF readout below."
            f"{gain_note}"
        )
    else:
        gain_note = ''
        sec_ds, _, sec_lbl = _secondary_cryptic_gain_signal(parsed_data, True, False, dg, ag)
        if has_sec_gain and sec_ds >= SPLICEAI_RECONCILE_MIN:
            gain_note = (
                f"<br><span style='color:#94a3b8;font-size:0.92em'>"
                f"Secondary {sec_lbl} is on the maps below."
                f"</span>"
            )
        lead = (
            f"<div style='color:#a7f3d0;border-left:3px solid #34d399;padding:8px 10px;margin-bottom:10px;'>"
            f"<b>Primary (SpliceAI, variant-anchored 5&prime; donor):</b> whole-exon-skip from <b>donor loss</b> "
            f"DS_DL={dl:.2f}. "
            f"Cryptic-junction &ldquo;native stop preserved&rdquo; is <b>suppressed</b> as the primary readout. "
            f"See the exon-skip / ORF readout below."
            f"{gain_note}"
        )
    if sec_lines:
        lead += f"<br><span style='color:#e2e8f0;font-size:0.92em'>{' '.join(sec_lines)}</span>"
    lead += "</div>"

    if sfm0:
        parsed_data['splice_frame_math'] = lead + "<br><br>" + sfm0
    else:
        parsed_data['splice_frame_math'] = lead


def _splice_structural_math_section_title(parsed_data):
    """Unified section title — product detail lives inside the block."""
    return "Splice products"


def _spliceai_secondary_section_title(parsed_data):
    m = (parsed_data.get("spliceai_secondary_mechanism") or "").strip()
    if m == "3prime_acceptor_loss":
        return "SpliceAI secondary (parallel acceptor / downstream exon-skip product)"
    return "SpliceAI secondary (parallel donor / upstream exon-skip product)"


def _spliceai_viz_junction_row_first(parsed_data, is_acc, is_don, j_pref):
    """
    Whether to place the gain/junction strip directly under reference (vs below whole-exon-skip).
    Entirely from SpliceAI deltas for the variant class, except j_pref (reconcile already
    set junction as the tool's primary NMD/length model).
    """
    if j_pref:
        return True
    if parsed_data.get('spliceai_exon_skip_spliceai_primary'):
        return False
    ag, al, dg, dl = _spliceai_scores_4(parsed_data)
    ga = float(ag or 0.0)
    g_al = float(al or 0.0)
    gd = float(dg or 0.0)
    g_dl = float(dl or 0.0)
    if is_acc:
        return ga >= g_al
    if is_don:
        return gd >= g_dl
    # Exonic cryptic, intron_variant, etc.: place junction row by strongest gain vs loss quadrant.
    return max(ga, gd) >= max(g_al, g_dl)


EXON_SKIP_CODON_TABLE = {
    "ATA": "I", "ATC": "I", "ATT": "I", "ATG": "M", "ACA": "T", "ACC": "T", "ACG": "T", "ACT": "T",
    "AAC": "N", "AAT": "N", "AAA": "K", "AAG": "K", "AGC": "S", "AGT": "S", "AGA": "R", "AGG": "R",
    "CTA": "L", "CTC": "L", "CTG": "L", "CTT": "L", "CCA": "P", "CCC": "P", "CCG": "P", "CCT": "P",
    "CAC": "H", "CAT": "H", "CAA": "Q", "CAG": "Q", "CGA": "R", "CGC": "R", "CGG": "R", "CGT": "R",
    "GTA": "V", "GTC": "V", "GTG": "V", "GTT": "V", "GCA": "A", "GCC": "A", "GCG": "A", "GCT": "A",
    "GAC": "D", "GAT": "D", "GAA": "E", "GAG": "E", "GGA": "G", "GGC": "G", "GGG": "G", "GGT": "G",
    "TCA": "S", "TCC": "S", "TCG": "S", "TCT": "S", "TTC": "F", "TTT": "F", "TTA": "L", "TTG": "L",
    "TAC": "Y", "TAT": "Y", "TAA": "*", "TAG": "*", "TGC": "C", "TGT": "C", "TGA": "*", "TGG": "W",
}


def _map_mut_cds0_to_orig_cds0(mut0, del_start0, del_len):
    """0-based index in spliced mutant CDS -> 0-based in reference CDS after whole-exon removal."""
    if mut0 < del_start0:
        return mut0
    return mut0 + int(del_len)


def _orfs0_first_stop_in_seq(seq, orf_start0, codon_table=None):
    """
    ORF-0 (triplet steps) from orf_start0. Returns (start0, exclusive_end0, triplet) or (None, None, None).
    """
    ctab = codon_table or EXON_SKIP_CODON_TABLE
    u = (seq or "").upper()
    for i in range(orf_start0, len(u) - 2, 3):
        tri = u[i : i + 3]
        if len(tri) < 3:
            break
        if ctab.get(tri) == "*":
            return i, i + 3, tri
    return None, None, None


def _find_cds_head_in_cdna(cdna, cds_seq, head_len=30):
    """Locate start of the CDS in spliced cDNA; returns 0-based offset or -1."""
    cna = (cdna or "").upper()
    che = (cds_seq or "").upper()
    if not cna or not che:
        return -1
    h = min(head_len, len(che))
    pos = cna.find(che[:h])
    if pos != -1:
        return pos
    for h2 in (25, 20, 15, 9):
        if h2 < len(che):
            pos = cna.find(che[:h2])
            if pos != -1:
                return pos
    return -1


def _format_whole_exon_skip_hgvs_p(
    mut_cds,
    t_start_1b,
    *,
    ref_cds=None,
    fs_ter_num=0,
    in_utr3=False,
    utr3_codon_from_aug=None,
    inframe_ter_codon_1b=None,
):
    """
    Predicted p. for whole–exon–skip when the loss product re-reads to a PTC.
    Out-of-frame matches the same pattern as the generic splice-frameshift line in this file
    (cryptic gain): p.{first_junction_aa_3}{pos}fsTer{n}, with the junction aa = first codon
    3' of the skip in the spliced mutant CDS, pos = that codon’s 1-based index, and n the same
    as the fsTer{n} / phase-shift count shown alongside (not a separate notation).
    - In-frame junction stop: p.Ter{pos}
    - 3'UTR first in-frame stop: p.?fsTer{c} 3'UTR (c = codon index from AUG)
    ref_cds is only kept for call-site keyword compatibility.
    """
    if inframe_ter_codon_1b and int(inframe_ter_codon_1b) > 0:
        return f"p.Ter{int(inframe_ter_codon_1b)}"
    if in_utr3 and utr3_codon_from_aug is not None:
        c = int(utr3_codon_from_aug)
        return f"p.?fsTer{c} 3'UTR"
    fsn = int(fs_ter_num) if fs_ter_num is not None else 0
    pos_j = (int(t_start_1b) - 1) // 3 + 1
    rc = (ref_cds or mut_cds or "").upper()
    cd0 = (pos_j - 1) * 3
    mc = (mut_cds or "").upper()
    tri_src = rc if rc and cd0 + 2 < len(rc) else mc
    tri_off = cd0 if tri_src is rc else min(max(0, len(mc) - 3), ((int(t_start_1b) - 1) // 3) * 3)
    if tri_off + 2 < len(tri_src):
        m_one, _ = _decode_cds_triplet(tri_src[tri_off : tri_off + 3])
    else:
        m_one = None
    if not m_one or m_one in ("X",):
        m3 = "Xaa"
    else:
        m3 = _AA_ONE_TO_THREE.get(m_one, "Xaa")
    if m_one == "*":
        return f"p.?(fsTer{fsn})" if fsn else "p.?"
    if fsn:
        return f"p.{m3}{pos_j}fsTer{fsn}"
    return f"p.{m3}{pos_j}"


def _coding_exon_skip_is_last(coding_exons, t_start_1b, t_end_1b):
    """True when the skipped interval is the last coding exon on the transcript."""
    if not coding_exons:
        return False
    skipped = None
    ts, te = int(t_start_1b), int(t_end_1b)
    for cx in coding_exons:
        try:
            cs, ce = int(cx.get('start_cds') or 0), int(cx.get('end_cds') or 0)
        except (TypeError, ValueError):
            continue
        if cs == ts and ce == te:
            skipped = cx
            break
    if skipped is None:
        for cx in coding_exons:
            try:
                cs, ce = int(cx.get('start_cds') or 0), int(cx.get('end_cds') or 0)
            except (TypeError, ValueError):
                continue
            if cs <= ts and te <= ce:
                skipped = cx
                break
    if skipped is None:
        return False
    try:
        skip_rank = int(skipped.get('anatomical_rank') or 0)
        last_rank = max(int(cx.get('anatomical_rank') or 0) for cx in coding_exons)
    except (TypeError, ValueError):
        return False
    return skip_rank > 0 and skip_rank == last_rank


def _oof_last_exon_skip_no_inframe_stop_result(mut, cds_seq, t_start_1b, t_end_1b, p_len):
    """
    OOF skip of the terminal coding exon: spliced mRNA is upstream CDS only — no reference
    3′UTR readthrough (UTR is removed with the skipped last exon).
    """
    del_len = int(t_end_1b) - int(t_start_1b) + 1
    aa_lost = del_len // 3
    try:
        pl_i = int(p_len) if p_len else 0
    except (TypeError, ValueError):
        pl_i = 0
    frac = (aa_lost / float(pl_i)) if pl_i > 0 else None
    junction_aa = (int(t_start_1b) - 1) // 3 + 1
    wt_anchor = max(1, junction_aa - 1)
    _base = _format_whole_exon_skip_hgvs_p(
        mut, t_start_1b, ref_cds=cds_seq, fs_ter_num=0
    )
    _hgv = f"{_base}fs" if _base and not str(_base).rstrip().endswith('fs') else _base
    pct_bit = f" ({100.0 * frac:.1f}% of reference protein in the skipped exon)" if frac is not None else ""
    ptc_exon_str = (
        " Out-of-frame skip of the <b>last coding exon</b>: the spliced mRNA retains upstream CDS"
        f" only — <b>no in-frame stop</b> on the loss product{pct_bit}. Reference 3&prime;UTR"
        " readthrough is <b>not</b> modeled (removed with the skipped last exon). Junction"
        f" frameshift at codon {junction_aa}; nonstop / run-off translation likely."
        " NMD escape applies (no classical ORF-embedded PTC)."
        f" <b>Predicted</b> protein: {_hgv} (no stable Ter)."
    )
    out = {
        "exon_skip_oof_last_exon_skip": True,
        "exon_skip_oof_no_inframe_stop": True,
        "exon_skip_predicted_hgvs_p": _hgv,
        "nmd_escape": True,
        "is_splice_frameshift": True,
        "is_nonstop_decay": True,
        "exon_skip_model_protein_start": wt_anchor,
        "exon_skip_model_downstream_aas": 0,
        "exon_skip_model_truncation_fraction": frac,
        "exon_skip_model_truncated_protein_length": wt_anchor,
    }
    return ptc_exon_str, out


def _oofs_exon_skip_ptc_cds_and_cdna(
    http_session,
    enst_id,
    cds_seq,
    t_start_1b,
    t_end_1b,
    coding_exons,
    p_len,
):
    """
    OOF whole-exon skip: resolve first ORF-0 stop in spliced mutant CDS, then (if needed) in full cDNA+UTR.
    Returns: (ptc_exon_str, field_updates) where field_updates is merged into parsed_data.
    p_len: reference polypeptide length (aa).
    """
    out = {
        "nmd_escape": None,
        "is_splice_frameshift": None,
        "is_nonstop_decay": None,
    }
    del_start0 = t_start_1b - 1
    del_len = t_end_1b - t_start_1b + 1
    mut = cds_seq[: t_start_1b - 1] + cds_seq[t_end_1b:]

    ptc_exon_str = ""
    st0, _se0, tri = _orfs0_first_stop_in_seq(mut, 0, EXON_SKIP_CODON_TABLE)
    if st0 is not None:
        o_st0 = _map_mut_cds0_to_orig_cds0(st0, del_start0, del_len)
        aa_before = (t_start_1b - 1) // 3
        total_aa_in_mutant = (st0 + 3) // 3
        downstream_aas = max(0, total_aa_in_mutant - aa_before - 1)
        fs_ter_str = f"fsTer{downstream_aas + 1}"
        shift_desc = f"generates {downstream_aas} new amino acids before a novel Stop Codon"
        ptc_tcx = None
        for tcx in coding_exons:
            o_i1 = o_st0 + 1  # 1-based first base of PTC in ref CDS
            o_i2 = o_st0 + 3
            if tcx["start_cds"] <= o_i1 and o_i2 <= tcx["end_cds"]:
                ptc_tcx = tcx
                break
            if tcx["start_cds"] <= o_i1 <= tcx["end_cds"] or tcx["start_cds"] <= o_i2 <= tcx["end_cds"]:
                ptc_tcx = tcx
                break
        if ptc_tcx is not None:
            er = ptc_tcx["anatomical_rank"]
            ptc_exon_str = f" NMD Phase Shift {shift_desc} ({fs_ter_str}, {tri}) which natively maps into Exon {er} of the spliced CDS."
            out["exon_skip_oof_fs_ter"] = fs_ter_str
            out["exon_skip_oof_ptc_exon_rank"] = int(er)
            try:
                out["exon_skip_oof_ptc_aa"] = int((st0 + 3) // 3)
            except (TypeError, ValueError):
                pass
            ts = int(ptc_tcx["start_cds"])
            te = int(ptc_tcx["end_cds"])
            span = te - ts + 1
            if span > 0:
                tick_1b = int(o_st0) + 2
                tick_1b = min(max(tick_1b, ts), te)
                out["exon_skip_oof_ptc_fraction_in_exon"] = round((tick_1b - ts) / float(span), 4)
        else:
            ptc_exon_str = f" NMD Phase Shift {shift_desc} ({fs_ter_str}, {tri}) in the spliced mutant CDS; exon of termination not resolved in the coding-exon model."
        _hgv = _format_whole_exon_skip_hgvs_p(
            mut, t_start_1b, ref_cds=cds_seq, fs_ter_num=int(downstream_aas) + 1
        )
        out["exon_skip_predicted_hgvs_p"] = _hgv
        ptc_exon_str = f"{ptc_exon_str} <b>Predicted</b> protein: {_hgv}."
        out["nmd_escape"] = False
        out["is_splice_frameshift"] = True
        out["is_nonstop_decay"] = False
        out["nmd_decision_basis"] = (
            "Out-of-frame whole-exon skip introduces a premature termination codon in the "
            "spliced CDS — predicted to trigger NMD."
        )
        return ptc_exon_str, out

    if _coding_exon_skip_is_last(coding_exons, t_start_1b, t_end_1b):
        return _oof_last_exon_skip_no_inframe_stop_result(
            mut, cds_seq, t_start_1b, t_end_1b, p_len
        )

    # cDNA+3′UTR ORF-0 extension (OOF: ann. CDS can lack an in-frame stop while the mature transcript does not)
    try:
        clean = enst_id.split(".")[0] if enst_id else ""
        if not clean:
            raise ValueError("no enst")
        c_url = f"https://rest.ensembl.org/sequence/id/{clean}?type=cdna"
        r1 = http_session.get(c_url, timeout=120)
        if r1.status_code == 200:
            cdna = (r1.json() or {}).get("seq", "")
            cds0 = _find_cds_head_in_cdna(cdna, cds_seq)
            if cds0 >= 0 and len(cds_seq) > 0:
                a0 = cds0 + (t_start_1b - 1)
                b0 = cds0 + t_end_1b
                mcdna = cdna[:a0] + cdna[b0:]
                st1, _se1, tri2 = _orfs0_first_stop_in_seq(mcdna, cds0, EXON_SKIP_CODON_TABLE)
                if st1 is not None:
                    codon_index = (st1 - cds0) // 3 + 1
                    cds3_end0 = cds0 + len(cds_seq)
                    in_cds = (st1 + 2) < cds3_end0
                    st_in_mut = st1 - cds0
                    if in_cds:
                        ptc_exon_str = f" NMD Phase Shift: ORF-0 first in-frame stop on mature cDNA is {tri2} (codon {codon_index} from AUG) within the annotated spliced CDS (after the skip; not reached by CDS-only string when len%3≠0)."
                        _aa_b = (t_start_1b - 1) // 3
                        _taa = int(codon_index)
                        _da = max(0, _taa - _aa_b - 1)
                        fs_ter_str = f"fsTer{_da + 1}"
                        _hgv2 = _format_whole_exon_skip_hgvs_p(
                            mut, t_start_1b, ref_cds=cds_seq, fs_ter_num=int(_da) + 1
                        )
                        out["exon_skip_oof_fs_ter"] = fs_ter_str
                        out["exon_skip_oof_ptc_aa"] = _taa
                        ptc_bp_1b = (_taa - 1) * 3 + 1
                        for tcx in coding_exons:
                            if tcx["start_cds"] <= ptc_bp_1b <= tcx["end_cds"]:
                                out["exon_skip_oof_ptc_exon_rank"] = int(tcx["anatomical_rank"])
                                ts = int(tcx["start_cds"])
                                te = int(tcx["end_cds"])
                                span = te - ts + 1
                                if span > 0:
                                    tick_1b = min(max(ptc_bp_1b, ts), te)
                                    out["exon_skip_oof_ptc_fraction_in_exon"] = round(
                                        (tick_1b - ts) / float(span), 4
                                    )
                                break
                    else:
                        p_ref = int(p_len) if p_len and int(p_len) > 0 else 0
                        ptc_exon_str = (
                            f" ORF-0: the annotated spliced <b>CDS</b> (after the skip) has <b>no in-frame TAA/TAG/TGA</b>, but the"
                            f" <b>first in-frame</b> stop on the <b>full</b> mature cDNA (CDS+3&prime;UTR) is <b>{tri2}</b> at <b>codon {codon_index}</b> from AUG"
                        )
                        if p_ref and codon_index > p_ref:
                            ptc_exon_str += (
                                f" (downstream of the reference p.Ter{p_ref}; 3&prime;UTR sequence, consistent with"
                                f" C-terminal readthrough. Stops in 3&prime;UTR are not classic ORF-embedded PTCs for NMD.)"
                            )
                        else:
                            ptc_exon_str += "."
                        _hgv2 = _format_whole_exon_skip_hgvs_p(
                            mut, t_start_1b, ref_cds=cds_seq, in_utr3=True, utr3_codon_from_aug=codon_index
                        )
                    out["exon_skip_oof_ptc_mrna_codon_aug"] = int(codon_index)
                    out["exon_skip_oof_terminus_in_utr3"] = not in_cds
                    out["exon_skip_predicted_hgvs_p"] = _hgv2
                    ptc_exon_str = f"{ptc_exon_str} <b>Predicted</b> protein: {_hgv2}."
                    out["nmd_escape"] = True
                    out["is_splice_frameshift"] = True
                    out["is_nonstop_decay"] = False
                    return ptc_exon_str, out
    except Exception as ex:
        print(f"OOF cDNA/UTR PTC extension: {ex}")

    out["nmd_escape"] = True
    out["is_splice_frameshift"] = True
    out["is_nonstop_decay"] = True
    ptc_exon_str = (
        " NMD Phase shift: the spliced mutant <b>CDS</b> alone has no in-frame stop; full mature cDNA was not"
        " resolved here — possible 3&prime;UTR termination, nonstop, or use RNA-Seq to confirm. "
        "NMD escape can apply if there is no classical ORF-embedded PTC."
    )
    out["exon_skip_predicted_hgvs_p"] = "p.?"
    ptc_exon_str = f"{ptc_exon_str} <b>Predicted</b> protein: p.? (unresolved)."
    return ptc_exon_str, out


def _spliceai_secondary_donor_parallel_exon_skip_math(
    http_session, parsed_data, coding_exons, enst_id, is_acc, is_don
):
    """
    When a 3&prime; acceptor variant is SpliceAI-primary (acceptor loss) and donor loss is clearly secondary,
    model a parallel whole–exon–skip of the upstream mRNA exon (variant_exon-1) from 5&prime; donor ablation
    in the same intron, with the same PTC / frame math as the primary skip.
    """
    if not (coding_exons and enst_id and http_session):
        return
    if parsed_data.get('spliceai_secondary_gain_product'):
        return
    _ds_dl = float(parsed_data.get("spliceai_ds_dl", 0) or 0)
    if not (
        (parsed_data.get("spliceai_exon_skip_spliceai_primary") or (is_acc and _ds_dl >= 0.15))
        and is_acc
        and (not is_don)
    ):
        return
    ag, al, dg, dl = _spliceai_scores_4(parsed_data)
    if float(dl or 0) < 0.15 and not (float(dl or 0) >= 0.3 and al >= SPLICEAI_EXON_SKIP_PRIMARY_MIN_LOSS):
        return
    ve = parsed_data.get("variant_exon")
    try:
        ve = int(ve) if ve is not None else 0
    except (TypeError, ValueError):
        ve = 0
    if ve is None or ve < 2:
        return
    sec_rank = ve - 1
    cx2 = next((c for c in coding_exons if int(c.get("anatomical_rank", -1)) == sec_rank), None)
    if not cx2:
        return
    p_len = int(parsed_data.get("protein_length", 0) or 0)
    t_start, t_end = int(cx2["start_cds"]), int(cx2["end_cds"])
    bp_len = int(cx2.get("length_bp", 0) or 0) or (t_end - t_start + 1)
    is_in_frame = (bp_len % 3 == 0)
    aa_lost = bp_len // 3
    fraction_lost = (aa_lost / float(p_len)) if p_len and p_len > 0 else 0.0
    frame_str = "In-Frame Skip" if is_in_frame else "Out-of-Frame Shift"
    pct_s = f"{fraction_lost * 100:.1f}%"
    # Exon map + in-frame call must not depend on a successful Ensembl CDS fetch
    try:
        parsed_data["spliceai_secondary_exon_rank"] = int(sec_rank)
    except (TypeError, ValueError):
        pass
    parsed_data["spliceai_secondary_mechanism"] = "5prime_donor_loss"
    parsed_data["spliceai_secondary_donor_oof"] = (not is_in_frame)
    ptc_exon_str = ""
    ptc_out = {}
    cds = ""
    if http_session and enst_id:
        try:
            clean = enst_id.split(".")[0]
            c_url = f"https://rest.ensembl.org/sequence/id/{clean}?type=cds"
            r = http_session.get(c_url, timeout=120)
            if r.status_code == 200:
                cds = (r.json() or {}).get("seq", "") or ""
        except Exception as ex_fetch:
            print(f"SpliceAI secondary exon-skip CDS fetch: {ex_fetch}")
    if (not is_in_frame) and cds:
        try:
            ptc_exon_str, ptc_out = _oofs_exon_skip_ptc_cds_and_cdna(
                http_session,
                enst_id,
                cds,
                t_start,
                t_end,
                coding_exons,
                p_len,
            )
        except Exception as ex_oof:
            ptc_exon_str = f" <span style='color:#94a3b8'>(ORF-0 PTC resolution failed: {ex_oof})</span>"
    elif (not is_in_frame) and not cds:
        ptc_exon_str = (
            " <span style='color:#94a3b8'>(ORF-0 PTC not computed: CDS sequence unavailable; "
            "exon map still shows the parallel upstream exon&mdash;skip model.)</span>"
        )
    _ut1 = (
        " (Exon 1 is 5′-UTR only; mRNA exon numbers still count all exons, including that one.)"
        if parsed_data.get("first_mrna_exon_is_non_coding")
        else ""
    )
    _l3 = "multiple of 3" if is_in_frame else f"not a multiple of 3"
    dpb = (parsed_data.get("spliceai_dp_dl") or parsed_data.get("spliceai_dp_dg") or "")
    dpb = str(dpb).strip()
    dpbit = f" (SpliceAI DP {dpb} bp from variant)" if dpb not in ("", "None", "none") else ""
    lead = (
        f"<div style='color:#bae6fd;border-left:3px solid #38bdf8;padding:6px 8px;margin-bottom:8px;'>"
        f"<b>SpliceAI secondary (5&prime; GT donor, same intron; different site from the 3&prime; acceptor):</b> "
        f"modelling a <b>parallel</b> <b>whole-exon-skip of mRNA exon {sec_rank}</b> (upstream 5&prime; of the "
        f"intron&mdash;5&prime; donor&mdash;when SpliceAI reports strong <b>DS_DL={float(dl or 0):.2f}</b>"
        f"{dpbit}). This is a distinct isoform from the primary skip of exon {ve}.</div>"
    )
    smath = (
        f"Exon {sec_rank} length {bp_len} bp: {_l3} — {frame_str} → {aa_lost} "
        f"amino acids lost ({pct_s} of protein, secondary donor-loss model).{ptc_exon_str}{_ut1}"
    )
    parsed_data["spliceai_secondary_splice_frame_math"] = lead + smath
    for k, v in ptc_out.items():
        if v is not None:
            parsed_data[f"spliceai_secondary_donor_{k}"] = v


def _spliceai_secondary_acceptor_parallel_exon_skip_math(
    http_session, parsed_data, coding_exons, enst_id, is_acc, is_don
):
    """
    When a 5&prime; donor variant is SpliceAI-primary (donor site loss) and 3&prime; acceptor loss is
    clearly secondary, model a parallel whole-exon-skip of the <b>downstream</b> mRNA exon in that
    intron (the exon 3&prime; of the AG) — mirror of _spliceai_secondary_donor_parallel_exon_skip_math.
    """
    if not (coding_exons and enst_id and http_session):
        return
    if parsed_data.get('spliceai_secondary_gain_product'):
        return
    _ds_al = float(parsed_data.get("spliceai_ds_al", 0) or 0)
    if not (
        (parsed_data.get("spliceai_exon_skip_spliceai_primary") or (is_don and _ds_al >= 0.15))
        and is_don
        and (not is_acc)
    ):
        return
    ag, al, dg, dl = _spliceai_scores_4(parsed_data)
    if float(al or 0) < 0.15 and not (float(al or 0) >= 0.3 and float(dl or 0) >= SPLICEAI_EXON_SKIP_PRIMARY_MIN_LOSS):
        return
    ve = parsed_data.get("variant_exon")
    try:
        ve = int(ve) if ve is not None else 0
    except (TypeError, ValueError):
        ve = 0
    dp_al = _parse_spliceai_dp(parsed_data.get("spliceai_dp_al"))
    # Upstream acceptor-loss (negative Δ) targets the AG before variant_exon → same skip as primary.
    if dp_al is not None and dp_al < 0 and ve > 0:
        dpb = f"{dp_al:+d}"
        note = (
            f"<div style='color:#cbd5e1;border-left:3px solid #64748b;padding:6px 8px;margin-top:8px;'>"
            f"<b>SpliceAI acceptor loss corroborates primary:</b> DS_AL={float(al or 0):.2f} at "
            f"&Delta;{dpb} bp points <b>upstream</b> to the canonical acceptor before mRNA exon {ve} "
            f"(5&prime; end of that exon / intron before it)&mdash;predicting the same <b>exon {ve} skip</b> "
            f"as the primary donor-loss model, not a separate skip of exon {ve + 1}.</div>"
        )
        sfm = (parsed_data.get("splice_frame_math") or "").strip()
        parsed_data["splice_frame_math"] = (sfm + "<br><br>" + note) if sfm else note
        parsed_data["spliceai_al_corroborates_primary"] = True
        return
    c_sorted = sorted(
        coding_exons,
        key=lambda c: int(c.get("anatomical_rank", 0) or 0),
    )
    cx2 = next(
        (c for c in c_sorted if int(c.get("anatomical_rank", 0) or 0) > ve),
        None,
    )
    if not cx2:
        return
    try:
        sec_rank = int(cx2.get("anatomical_rank", -1))
    except (TypeError, ValueError):
        return
    if sec_rank < 1:
        return
    p_len = int(parsed_data.get("protein_length", 0) or 0)
    t_start, t_end = int(cx2["start_cds"]), int(cx2["end_cds"])
    bp_len = int(cx2.get("length_bp", 0) or 0) or (t_end - t_start + 1)
    is_in_frame = (bp_len % 3 == 0)
    aa_lost = bp_len // 3
    fraction_lost = (aa_lost / float(p_len)) if p_len and p_len > 0 else 0.0
    frame_str = "In-Frame Skip" if is_in_frame else "Out-of-Frame Shift"
    pct_s = f"{fraction_lost * 100:.1f}%"
    try:
        parsed_data["spliceai_secondary_exon_rank"] = int(sec_rank)
    except (TypeError, ValueError):
        pass
    parsed_data["spliceai_secondary_mechanism"] = "3prime_acceptor_loss"
    parsed_data["spliceai_secondary_donor_oof"] = (not is_in_frame)
    ptc_exon_str = ""
    ptc_out = {}
    cds = ""
    if http_session and enst_id:
        try:
            clean = enst_id.split(".")[0]
            c_url = f"https://rest.ensembl.org/sequence/id/{clean}?type=cds"
            r = http_session.get(c_url, timeout=120)
            if r.status_code == 200:
                cds = (r.json() or {}).get("seq", "") or ""
        except Exception as ex_fetch:
            print(f"SpliceAI secondary acceptor exon-skip CDS fetch: {ex_fetch}")
    if (not is_in_frame) and cds:
        try:
            ptc_exon_str, ptc_out = _oofs_exon_skip_ptc_cds_and_cdna(
                http_session,
                enst_id,
                cds,
                t_start,
                t_end,
                coding_exons,
                p_len,
            )
        except Exception as ex_oof:
            ptc_exon_str = f" <span style='color:#94a3b8'>(ORF-0 PTC resolution failed: {ex_oof})</span>"
    elif (not is_in_frame) and not cds:
        ptc_exon_str = (
            " <span style='color:#94a3b8'>(ORF-0 PTC not computed: CDS sequence unavailable; "
            "exon map still shows the parallel downstream exon&mdash;skip model.)</span>"
        )
    _ut1 = (
        " (Exon 1 is 5′-UTR only; mRNA exon numbers still count all exons, including that one.)"
        if parsed_data.get("first_mrna_exon_is_non_coding")
        else ""
    )
    _l3 = "multiple of 3" if is_in_frame else f"not a multiple of 3"
    dpb = (parsed_data.get("spliceai_dp_al") or parsed_data.get("spliceai_dp_ag") or "")
    dpb = str(dpb).strip()
    dpbit = f" (SpliceAI DP {dpb} bp from variant)" if dpb not in ("", "None", "none") else ""
    _dp_note = ""
    if dpb not in ("", "None", "none"):
        _dp_note = (
            f" SpliceAI&rsquo;s <b>&Delta;{dpb} bp</b> is the offset to the strongest acceptor-<b>loss</b> signal "
            f"in its window&mdash;not an AG dinucleotide sitting in exon coding sequence. Canonical 3&prime; "
            f"acceptors (AG) sit at the <b>3&prime; end of the intron</b> (just upstream of the next exon); "
            f"when DS_AL is high, that junction is predicted to be used <b>less</b>, which can yield exon skipping "
            f"rather than &ldquo;defaulting&rdquo; to another canonical acceptor elsewhere."
        )
    lead = (
        f"<div style='color:#bae6fd;border-left:3px solid #38bdf8;padding:6px 8px;margin-bottom:8px;'>"
        f"<b>SpliceAI secondary (3&prime; AG acceptor, same intron; different site from the 5&prime; donor):</b> "
        f"modelling a <b>parallel</b> <b>whole-exon-skip of mRNA exon {sec_rank}</b> (the exon 3&prime; of the "
        f"canonical AG at the <b>3&prime; end of the variant&rsquo;s intron</b>) when SpliceAI reports strong "
        f"<b>DS_AL={float(al or 0):.2f}</b>{dpbit}.{_dp_note} "
        f"This is a distinct isoform from the primary skip of exon {ve}.</div>"
    )
    smath = (
        f"Exon {sec_rank} length {bp_len} bp: {_l3} — {frame_str} → {aa_lost} "
        f"amino acids lost ({pct_s} of protein, secondary acceptor-loss model).{ptc_exon_str}{_ut1}"
    )
    parsed_data["spliceai_secondary_splice_frame_math"] = lead + smath
    for k, v in ptc_out.items():
        if v is not None:
            parsed_data[f"spliceai_secondary_donor_{k}"] = v


def _splice_viz_should_include(parsed_data):
    """
    Show the exon-strip diagram for canonical splice sites, deep intronic models,
    exonic cryptic / SpliceAI-positive variants, and any case with splice structural math.
    """
    if _canonical_splice_junction_from_hgvs(parsed_data.get('c_dot')):
        return True
    cons = (parsed_data.get('consequence') or '').lower()
    if any(
        s in cons
        for s in (
            'splice_acceptor',
            'splice_donor',
            'splice_region',
            'splice_donor_variant',
            'splice_acceptor_variant',
        )
    ):
        return True
    if 'splice' in cons:
        return True
    if 'intron_variant' in cons:
        return True
    if parsed_data.get('deep_intronic_splice', {}).get('eligible'):
        return True
    if parsed_data.get('cryptic_gain_outcome'):
        return True
    if (parsed_data.get('splice_frame_math') or '').strip():
        return True
    co = parsed_data.get('cryptic_splice_outcome') or {}
    if co and not co.get('minimal_signal'):
        return True
    if parsed_data.get('spliceai_junction_model_preferred') or parsed_data.get(
        'spliceai_competing_splice_isoforms'
    ):
        return True
    if parsed_data.get('is_splice_frameshift'):
        return True
    if parsed_data.get('spliceai_fetched') and not parsed_data.get('splice_api_error'):
        ag, al, dg, dl = _spliceai_scores_4(parsed_data)
        if max(float(ag or 0), float(al or 0), float(dg or 0), float(dl or 0)) >= 0.15:
            return True
    try:
        sg = float(parsed_data.get('pangolin_ds_sg') or 0)
        sl = float(parsed_data.get('pangolin_ds_sl') or 0)
        if max(sg, sl) >= 0.15:
            return True
    except (TypeError, ValueError):
        pass
    return False


def _ensure_coding_exons_for_splice_viz(parsed_data, session=None):
    """Populate coding_exons from Ensembl when the splice pipeline did not run (e.g. intron_variant only)."""
    ce = parsed_data.get('coding_exons')
    if (
        ce and isinstance(ce, list) and len(ce) > 0
        and parsed_data.get('cds_genomic_start') and parsed_data.get('cds_genomic_end')
        and parsed_data.get('coding_exons_source') == 'ensembl'
    ):
        return True
    # Transcript-coordinate map is enough for exon pills / CDS-index lookups when
    # genomic CDS bounds are unavailable (Ensembl down / NM never mapped to ENST).
    # Prefer upgrading to Ensembl when an ENST id is (or can be) resolved.
    enst_id = (parsed_data.get('ensembl_transcript_id') or '').strip()
    clean_enst = enst_id.split('.')[0] if enst_id else ''
    if (
        ce and isinstance(ce, list) and len(ce) > 0
        and parsed_data.get('coding_exons_source') == 'refseq_gff'
        and not clean_enst.startswith('ENST')
    ):
        return True
    if not enst_id:
        return _ensure_coding_exons_from_refseq_nm(parsed_data, session)
    if not clean_enst.startswith('ENST'):
        return _ensure_coding_exons_from_refseq_nm(parsed_data, session)
    sess = session or http_session
    if sess is None:
        return _ensure_coding_exons_from_refseq_nm(parsed_data, session)
    try:
        url = f"https://rest.ensembl.org/lookup/id/{clean_enst}?expand=1"
        resp = sess.get(url, timeout=60)
        if getattr(resp, 'status_code', 0) != 200:
            return _ensure_coding_exons_from_refseq_nm(parsed_data, session)
        exon_data = resp.json() or {}
        exons = exon_data.get('Exon', []) or []
        strand = exon_data.get('strand', 1)
        parsed_data['transcript_strand'] = strand
        parsed_data['transcript_chrom'] = exon_data.get('seq_region_name')
        trans = exon_data.get('Translation', {}) or {}
        tpl = trans.get('length')
        if tpl:
            try:
                pl = int(tpl)
                if pl > 0:
                    parsed_data['protein_length'] = pl
            except (TypeError, ValueError):
                pass
        cds_genomic_start = trans.get('start')
        cds_genomic_end = trans.get('end')
        if not (cds_genomic_start and cds_genomic_end and exons):
            return _ensure_coding_exons_from_refseq_nm(parsed_data, session)
        parsed_data['cds_genomic_start'] = cds_genomic_start
        parsed_data['cds_genomic_end'] = cds_genomic_end
        exons.sort(key=lambda x: x['start'] if strand == 1 else -x['start'])
        coding_exons = []
        cds_cursor = 0
        for e_idx, e in enumerate(exons):
            e_start, e_end = e['start'], e['end']
            overlap_start = max(e_start, cds_genomic_start)
            overlap_end = min(e_end, cds_genomic_end)
            if overlap_start <= overlap_end:
                coding_len = overlap_end - overlap_start + 1
                start_cds = cds_cursor + 1
                cds_cursor += coding_len
                end_cds = cds_cursor
                coding_exons.append(
                    {
                        'start_cds': start_cds,
                        'end_cds': end_cds,
                        'anatomical_rank': e_idx + 1,
                        'length_bp': coding_len,
                        'chr': exon_data.get('seq_region_name'),
                        'start': e_start,
                        'end': e_end,
                    }
                )
        if not coding_exons:
            return _ensure_coding_exons_from_refseq_nm(parsed_data, session)
        parsed_data['coding_exons'] = coding_exons
        parsed_data['coding_exons_source'] = 'ensembl'
        _stash_transcript_mrna_exon_metadata(
            parsed_data, exons, coding_exons,
            cds_genomic_start=cds_genomic_start, cds_genomic_end=cds_genomic_end,
        )
        return True
    except Exception as exc:
        print(f"[splice viz] coding_exons fetch failed: {exc}")
        return _ensure_coding_exons_from_refseq_nm(parsed_data, session)


def _ensure_coding_exons_from_refseq_nm(parsed_data, session=None):
    """
    Build coding_exons from NCBI RefSeq GFF3 (transcript coordinates) when Ensembl
    ENST mapping is unavailable — e.g. DTNA NM_001386795 with Ensembl 5xx.
    """
    if not parsed_data:
        return False
    ce = parsed_data.get('coding_exons')
    if ce and isinstance(ce, list) and len(ce) > 0:
        return True
    tx = (
        (parsed_data.get('transcript') or '')
        or (parsed_data.get('refseq_transcript_id') or '')
        or (parsed_data.get('ensembl_transcript_id') or '')
    ).strip()
    if not tx.upper().startswith('NM_'):
        return False
    nm = tx.split('.')[0]
    # Prefer versioned accession when present for GFF stability.
    nm_query = tx if '.' in tx else nm
    sess = session or http_session
    if sess is None:
        return False
    try:
        resp = sess.get(
            'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi',
            params={
                'db': 'nuccore',
                'id': nm_query,
                'rettype': 'gff3',
                'retmode': 'text',
            },
            timeout=45,
        )
        if getattr(resp, 'status_code', 0) != 200 or not (resp.text or '').strip():
            if nm_query != nm:
                resp = sess.get(
                    'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi',
                    params={
                        'db': 'nuccore',
                        'id': nm,
                        'rettype': 'gff3',
                        'retmode': 'text',
                    },
                    timeout=45,
                )
        if getattr(resp, 'status_code', 0) != 200:
            return False
        cds_lo = cds_hi = None
        exons = []  # (start, end) in transcript/mRNA coordinates
        for ln in (resp.text or '').splitlines():
            if not ln or ln.startswith('#'):
                continue
            parts = ln.split('\t')
            if len(parts) < 5:
                continue
            ftype = parts[2]
            try:
                start_i, end_i = int(parts[3]), int(parts[4])
            except (TypeError, ValueError):
                continue
            if ftype == 'CDS':
                if cds_lo is None:
                    cds_lo, cds_hi = start_i, end_i
                else:
                    cds_lo = min(cds_lo, start_i)
                    cds_hi = max(cds_hi, end_i)
            elif ftype == 'exon':
                exons.append((start_i, end_i))
        if not exons or cds_lo is None or cds_hi is None:
            return False
        exons.sort(key=lambda x: x[0])
        coding_exons = []
        cds_cursor = 0
        for e_idx, (e_start, e_end) in enumerate(exons):
            overlap_start = max(e_start, cds_lo)
            overlap_end = min(e_end, cds_hi)
            if overlap_start <= overlap_end:
                coding_len = overlap_end - overlap_start + 1
                start_cds = cds_cursor + 1
                cds_cursor += coding_len
                end_cds = cds_cursor
                coding_exons.append(
                    {
                        'start_cds': start_cds,
                        'end_cds': end_cds,
                        'anatomical_rank': e_idx + 1,
                        'length_bp': coding_len,
                        'chr': None,
                        'start': e_start,
                        'end': e_end,
                        'coord_system': 'mrna',
                    }
                )
        if not coding_exons:
            return False
        parsed_data['coding_exons'] = coding_exons
        parsed_data['coding_exons_source'] = 'refseq_gff'
        parsed_data['mrna_exon_total'] = len(exons)
        # Protein length excluding stop when CDS length is divisible by 3.
        # Use fill-if-missing-or-zero: analyze() initializes protein_length=0, so
        # setdefault() would leave a broken 0.0% exon-skip baseline.
        if cds_cursor >= 3 and cds_cursor % 3 == 0:
            try:
                cur_pl = int(parsed_data.get('protein_length') or 0)
            except (TypeError, ValueError):
                cur_pl = 0
            if cur_pl <= 0:
                parsed_data['protein_length'] = cds_cursor // 3 - 1
        _ensure_protein_length_from_coding_exons(parsed_data)
        # Seed CDS index from c. for exon finalize when VEP never set snpeff_cds_pos.
        if not parsed_data.get('snpeff_cds_pos'):
            m = re.search(r'c\.(\d+)', str(parsed_data.get('c_dot') or ''), re.I)
            if m:
                try:
                    parsed_data['snpeff_cds_pos'] = int(m.group(1))
                except (TypeError, ValueError):
                    pass
        print(
            f"[splice viz] coding_exons from RefSeq GFF ({nm_query}): "
            f"{len(coding_exons)} coding / {len(exons)} mRNA exons",
            flush=True,
        )
        return True
    except Exception as exc:
        print(f"[splice viz] RefSeq GFF coding_exons failed: {exc}")
        return False


def _stash_transcript_mrna_exon_metadata(
    parsed_data, exons, coding_exons, *, cds_genomic_start=None, cds_genomic_end=None
):
    """
    After Ensembl lookup: full mRNA exon count (all exons, UTR included) for X/Y display.
    coding_exons remains CDS-overlap rows only; anatomical_rank on each row is mRNA exon #.
    """
    if not exons:
        return
    n_ex = len(exons)
    parsed_data['mrna_exon_total'] = n_ex
    parsed_data['nmd_exon_total'] = n_ex
    if cds_genomic_start is not None and cds_genomic_end is not None:
        e0 = exons[0]
        _g1 = max(int(e0['start']), int(cds_genomic_start))
        _g2 = min(int(e0['end']), int(cds_genomic_end))
        if _g1 > _g2:
            parsed_data['first_mrna_exon_is_non_coding'] = True
        else:
            parsed_data.pop('first_mrna_exon_is_non_coding', None)
    if coding_exons:
        parsed_data['nmd_last_coding_exon_rank'] = coding_exons[-1]['anatomical_rank']
        try:
            last_rank = int(coding_exons[-1].get('anatomical_rank') or 0)
        except (TypeError, ValueError):
            last_rank = 0
        trailing = n_ex - last_rank
        if trailing > 0:
            parsed_data['nmd_trailing_mrna_exons_after_cds'] = trailing
        else:
            parsed_data.pop('nmd_trailing_mrna_exons_after_cds', None)
    else:
        parsed_data.pop('nmd_last_coding_exon_rank', None)
        parsed_data.pop('nmd_trailing_mrna_exons_after_cds', None)


def _ensure_cds_seq(parsed_data, http_session):
    """Fetch CDS sequence from Ensembl when missing (required for intron_variant splice product math)."""
    cds_seq = parsed_data.get('cds_seq') or ''
    if cds_seq:
        return cds_seq
    enst_id = (parsed_data.get('ensembl_transcript_id') or '').strip()
    if not enst_id or http_session is None:
        return ''
    try:
        clean_enst = enst_id.split('.')[0]
        seq_url = f"https://rest.ensembl.org/sequence/id/{clean_enst}?type=cds"
        sresp = http_session.get(seq_url, timeout=60)
        if getattr(sresp, 'status_code', 0) == 200:
            cds_seq = (sresp.json() or {}).get('seq', '') or ''
            if cds_seq:
                parsed_data['cds_seq'] = cds_seq
                return cds_seq
    except Exception as exc:
        print(f"[deep intronic] cds fetch failed: {exc}")
    return ''


def _infer_viz_target_exon_rank(parsed_data, coding_exons):
    """
    mRNA exon to highlight for whole-exon skip / junction rows when variant_exon was not
    set by the canonical splice pipeline (intronic HGVS, synonymous/missense + cryptic, etc.).
    """
    if not coding_exons:
        return None
    ve = parsed_data.get('variant_exon')
    if ve is not None:
        try:
            return int(ve)
        except (TypeError, ValueError):
            pass
    c_dot = parsed_data.get('c_dot') or ''
    cons = parsed_data.get('consequence') or ''
    cds_pos = parsed_data.get('snpeff_cds_pos')
    try:
        cds_pos = int(cds_pos) if cds_pos is not None else 0
    except (TypeError, ValueError):
        cds_pos = 0
    if cds_pos <= 0:
        cds_pos = _splice_cdna_anchor_from_hgvs(c_dot, cons)
    if cds_pos <= 0:
        return None
    if _consequence_is_acceptor_splice(cons, c_dot) or _consequence_is_donor_splice(cons, c_dot):
        tcx = _select_splice_coding_exon(cons, cds_pos, coding_exons, c_dot)
        if tcx:
            try:
                return int(tcx.get('anatomical_rank') or 0) or None
            except (TypeError, ValueError):
                pass
    c_low = (c_dot or '').lower()
    if re.search(r'c\.\d+\s*-\s*', c_low):
        tcx = _select_splice_coding_exon('splice_acceptor_variant', cds_pos, coding_exons, c_dot)
        if tcx:
            try:
                return int(tcx.get('anatomical_rank') or 0) or None
            except (TypeError, ValueError):
                pass
    if re.search(r'c\.\d+\s*\+\s*', c_low) and not re.search(r'c\.\d+\s*-\s*', c_low):
        tcx = _select_splice_coding_exon('splice_donor_variant', cds_pos, coding_exons, c_dot)
        if tcx:
            try:
                return int(tcx.get('anatomical_rank') or 0) or None
            except (TypeError, ValueError):
                pass
    for cx in coding_exons:
        try:
            sc = int(cx.get('start_cds') or 0)
            ec = int(cx.get('end_cds') or 0)
        except (TypeError, ValueError):
            continue
        if sc <= cds_pos <= ec:
            try:
                return int(cx.get('anatomical_rank') or 0) or None
            except (TypeError, ValueError):
                pass
    return None


def _viz_cds_pos(parsed_data):
    """Best-effort 1-based CDS position for exon-map variant tick."""
    cds_pos = parsed_data.get('snpeff_cds_pos')
    try:
        cds_pos = int(cds_pos) if cds_pos is not None else 0
    except (TypeError, ValueError):
        cds_pos = 0
    if cds_pos <= 0:
        c_dot = parsed_data.get('c_dot') or ''
        cons = parsed_data.get('consequence') or ''
        cds_pos = _splice_cdna_anchor_from_hgvs(c_dot, cons)
    if cds_pos <= 0:
        m = re.search(r'c\.([0-9]+)', parsed_data.get('c_dot') or '')
        if m:
            try:
                cds_pos = int(m.group(1))
            except ValueError:
                cds_pos = 0
    return cds_pos if cds_pos > 0 else None


def _viz_cds_fraction_in_anatomical_exon(coding_exons, anatomical_rank, cds_pos):
    """0–1 schematic position of variant within the coding segment of an anatomical exon."""
    if not coding_exons or anatomical_rank is None or cds_pos is None:
        return None
    try:
        tar = int(anatomical_rank)
        pos = int(cds_pos)
    except (TypeError, ValueError):
        return None
    for cx in coding_exons:
        try:
            if int(cx.get('anatomical_rank') or 0) != tar:
                continue
            sc = int(cx.get('start_cds') or 0)
            ec = int(cx.get('end_cds') or 0)
        except (TypeError, ValueError):
            continue
        if sc <= pos <= ec and ec >= sc:
            span = ec - sc + 1
            if span <= 0:
                return None
            frac = (pos - sc + 0.5) / float(span)
            return round(min(0.97, max(0.03, frac)), 4)
    return None


def _splice_viz_resolve_target_rank(parsed_data, coding_rows):
    """Resolve anatomical exon rank for map centering / variant marker."""
    tr = parsed_data.get('variant_exon')
    try:
        tr = int(tr) if tr is not None else None
    except (TypeError, ValueError):
        tr = None
    if tr is not None and tr >= 1:
        return tr
    inferred = _infer_viz_target_exon_rank(parsed_data, coding_rows)
    if inferred is not None:
        return inferred
    ser = parsed_data.get('snpeff_exon_rank')
    try:
        ser = int(ser) if ser is not None else None
    except (TypeError, ValueError):
        ser = None
    if ser is not None and ser >= 1:
        ranks = {int(x.get('anatomical_rank') or 0) for x in (coding_rows or [])}
        if ser in ranks:
            return ser
    return None


def _compute_splice_viz_variant_marker(parsed_data, cons, c_dot, tr, last_rank):
    """
    HGVS / consequence-driven schematic locus for the splice map (not spliceAI coords).
    intron: upstream_exon–downstream_exon gap (acceptor before tr; donor after tr).
    exon: variant_exon when unknown intronic offset.
    """
    _ce = parsed_data.get('coding_exons') or []
    _det = (parsed_data.get('deep_intronic_splice') or {}).get('details') or {}
    _co = parsed_data.get('deep_intronic_primary_outcome') or {}
    if _splice_viz_pre_atg_context(parsed_data, _ce, _det):
        anchor, dn = _resolve_pre_atg_mrna_exon_ranks(
            parsed_data, _ce, _det,
            _co.get('anchor_exon_rank'),
            _co.get('downstream_exon_rank'),
        )
        if anchor and dn:
            return {'mode': 'intron', 'upstream_exon': anchor, 'downstream_exon': dn}
    c_low = (c_dot or '').lower()
    try:
        lr = int(last_rank or 0)
    except (TypeError, ValueError):
        lr = 0
    try:
        tr_int = int(tr)
    except (TypeError, ValueError):
        return None
    if tr_int < 1 or lr < 1:
        return None

    is_acc = _consequence_is_acceptor_splice(cons, c_dot)
    is_don = _consequence_is_donor_splice(cons, c_dot)
    m_minus = re.search(r'c\.\d+\s*-\s*', c_low)
    m_plus = re.search(r'c\.\d+\s*\+\s*', c_low)

    # Acceptor / minus-offset intronic → intron before coding exon tr_int
    if is_acc or (m_minus and (not m_plus or m_minus.start() <= m_plus.start())):
        if tr_int > 1:
            return {'mode': 'intron', 'upstream_exon': tr_int - 1, 'downstream_exon': tr_int}
        return {'mode': 'intron', 'upstream_exon': None, 'downstream_exon': 1}

    # Donor / plus-offset intronic → intron after coding exon tr_int
    if is_don or (m_plus and not m_minus):
        if tr_int < lr:
            return {'mode': 'intron', 'upstream_exon': tr_int, 'downstream_exon': tr_int + 1}
        if tr_int > 1:
            return {'mode': 'intron', 'upstream_exon': tr_int - 1, 'downstream_exon': tr_int}
        return None

    ve = parsed_data.get('variant_exon')
    try:
        ve_int = int(ve) if ve is not None else tr_int
    except (TypeError, ValueError):
        ve_int = tr_int
    out = {'mode': 'exon', 'exon_rank': ve_int}
    cds_pos = _viz_cds_pos(parsed_data)
    if cds_pos is not None:
        frac = _viz_cds_fraction_in_anatomical_exon(
            parsed_data.get('coding_exons') or [], ve_int, cds_pos
        )
        if frac is not None:
            out['fraction_in_exon'] = frac
        out['cds_pos'] = cds_pos
    return out


_SPLICE_VIZ_SEC_SKIP_PTC_PREFIX = "spliceai_secondary_donor_"


def _ptc_aa_to_anatomical_exon(coding_rows, ptc_aa_1b):
    """Map 1-based protein Ter position to anatomical exon rank (reference CDS model)."""
    if not coding_rows or ptc_aa_1b is None:
        return None
    try:
        ptc_nt = int(ptc_aa_1b) * 3
    except (TypeError, ValueError):
        return None
    try:
        sorted_rows = sorted(coding_rows, key=lambda x: int(x.get('anatomical_rank') or 0))
    except (TypeError, ValueError):
        return None
    for cx in sorted_rows:
        try:
            sc = int(cx.get('start_cds') or 0)
            ec = int(cx.get('end_cds') or 0)
            ar = int(cx.get('anatomical_rank') or 0)
        except (TypeError, ValueError):
            continue
        if ar >= 1 and sc <= ptc_nt <= ec:
            return ar
    return None


def _ptc_aa_fraction_in_anatomical_exon(coding_rows, anatomical_rank, global_aa_1b):
    """
    Approximate Ter tick position within an anatomical exon box from 1-based protein Ter position,
    using reference CDS exon lengths (schematic only).
    """
    if not coding_rows or anatomical_rank is None or global_aa_1b is None:
        return None
    try:
        tar = int(anatomical_rank)
        gaa = int(global_aa_1b)
    except (TypeError, ValueError):
        return None
    try:
        sorted_rows = sorted(coding_rows, key=lambda x: int(x.get('anatomical_rank') or 0))
    except (TypeError, ValueError):
        return None
    aa_before = 0
    for x in sorted_rows:
        r = int(x.get('anatomical_rank') or 0)
        n_aa = max(0, int(x.get('length_bp') or 0) // 3)
        if r == tar:
            if n_aa <= 0:
                return None
            i = gaa - aa_before
            if i < 1:
                i = 1
            elif i > n_aa:
                i = n_aa
            return round((i - 0.5) / float(n_aa), 4)
        aa_before += n_aa
    return None


def _splice_viz_ptc_location_from_layer(layer):
    """Shared caption fields for exon-strip PTC location (primary / secondary skip / junction)."""
    if not layer or layer.get('exon_rank') is None:
        return None, None, None
    try:
        er = int(layer.get('exon_rank'))
    except (TypeError, ValueError):
        return None, None, None
    if er < 1:
        return None, None, None
    label = f'native coding exon {er}'
    detail = None
    if layer.get('fraction_in_exon') is not None:
        try:
            detail = f"~{round(float(layer['fraction_in_exon']) * 100)}% along exon {er} box"
        except (TypeError, ValueError):
            pass
    return 'coding_exon', label, detail


def _splice_viz_ptc_layer_skip(parsed_data, secondary=False):
    """OOF whole-exon skip product: anatomical exon of the first novel stop (if resolved)."""
    pfx = _SPLICE_VIZ_SEC_SKIP_PTC_PREFIX if secondary else ""
    if secondary:
        if parsed_data.get("spliceai_secondary_donor_oof") is not True:
            return None
    elif parsed_data.get("splice_is_in_frame") is True:
        return None
    er = parsed_data.get(f"{pfx}exon_skip_oof_ptc_exon_rank")
    try:
        er = int(er) if er is not None else None
    except (TypeError, ValueError):
        er = None
    if er is None or er < 1:
        return None
    hgvs_p = parsed_data.get(f"{pfx}exon_skip_predicted_hgvs_p") or parsed_data.get(f"{pfx}exon_skip_oof_fs_ter") or ""
    hgvs_p = str(hgvs_p).strip() if hgvs_p else ""
    aa = parsed_data.get(f"{pfx}exon_skip_oof_ptc_aa")
    try:
        aa_i = int(aa) if aa is not None else None
    except (TypeError, ValueError):
        aa_i = None
    out = {"exon_rank": er, "hgvs_p": hgvs_p}
    if aa_i is not None:
        out["ptc_aa_position"] = aa_i
    frac = parsed_data.get(f"{pfx}exon_skip_oof_ptc_fraction_in_exon")
    if frac is not None:
        try:
            out["fraction_in_exon"] = float(frac)
            return out
        except (TypeError, ValueError):
            pass
    ce = parsed_data.get("coding_exons") or []
    fa = _ptc_aa_fraction_in_anatomical_exon(ce, er, aa_i)
    if fa is not None:
        out["fraction_in_exon"] = fa
    return out


def _splice_viz_ptc_layer_junction(parsed_data):
    """Cryptic / junction-shift isoform: novel stop exon from resolver or gain outcome."""
    co = parsed_data.get("cryptic_splice_outcome") or {}
    if parsed_data.get('deep_intronic_pre_atg_utr_pseudoexon') or co.get('pre_atg_utr_pseudoexon'):
        return None
    if not (co.get("ptc_exon_rank") or co.get("fs_ter_str")):
        co = parsed_data.get("spliceai_secondary_cryptic_outcome") or co
    if co.get("ptc_within_insert"):
        return None
    if co.get("in_frame_exonization") or parsed_data.get("deep_intronic_in_frame_exonization"):
        return None
    cg = parsed_data.get("cryptic_gain_outcome") or {}
    if co.get("minimal_signal"):
        # Competing / weak-delta paths may still carry a resolved PTC for the junction model.
        if (
            co.get("ptc_exon_rank") is None
            and cg.get("ptc_exon_rank") is None
            and parsed_data.get("junction_model_ptc_exon_rank") is None
        ):
            return None
    er = co.get("ptc_exon_rank")
    if er is None:
        er = cg.get("ptc_exon_rank")
    if er is None:
        er = parsed_data.get("junction_model_ptc_exon_rank")
    try:
        er = int(er) if er is not None else None
    except (TypeError, ValueError):
        er = None
    if er is None or er < 1:
        return None
    hgvs_p = str(co.get("fs_ter_str") or parsed_data.get("junction_model_hgvs_p") or "").strip()
    if not hgvs_p:
        hgvs_p = str(cg.get("hgvs_p") or "").strip()
    aa = co.get("ptc_aa_position") or parsed_data.get("junction_model_ptc_position")
    try:
        aa_i = int(aa) if aa is not None else None
    except (TypeError, ValueError):
        aa_i = None
    out = {"exon_rank": er, "hgvs_p": hgvs_p}
    if aa_i is not None:
        out["ptc_aa_position"] = aa_i
    frac = co.get("ptc_fraction_in_exon")
    if frac is None:
        frac = parsed_data.get("junction_model_ptc_fraction_in_exon")
    if frac is not None:
        try:
            out["fraction_in_exon"] = float(frac)
            return out
        except (TypeError, ValueError):
            pass
    ce = parsed_data.get("coding_exons") or []
    fa = _ptc_aa_fraction_in_anatomical_exon(ce, er, aa_i)
    if fa is not None:
        out["fraction_in_exon"] = fa
    return out


def _splice_viz_ptc_layer_reference(parsed_data):
    """Direct nonsense/frameshift on the reference transcript (non-splice exon map)."""
    if _splice_viz_should_include(parsed_data):
        return None
    cons = (parsed_data.get('consequence') or '').lower()
    if not any(x in cons for x in ('nonsense', 'frameshift', 'stop_gained')):
        return None
    ptc_aa = None
    try:
        nsv = parsed_data.get('novel_stop_aa')
        if nsv is not None and int(nsv) > 0:
            ptc_aa = int(nsv)
    except (TypeError, ValueError):
        ptc_aa = None
    if not ptc_aa:
        try:
            ps = parsed_data.get('protein_start')
            if ps is not None and int(ps) > 0:
                ptc_aa = int(ps)
        except (TypeError, ValueError):
            ptc_aa = None
    if not ptc_aa:
        return None
    ce = parsed_data.get('coding_exons') or []
    er = _ptc_aa_to_anatomical_exon(ce, ptc_aa)
    if er is None:
        try:
            ser = parsed_data.get('snpeff_exon_rank')
            if ser is not None and int(ser) >= 1:
                er = int(ser)
        except (TypeError, ValueError):
            er = None
    if er is None or er < 1:
        return None
    hgvs_p = str(parsed_data.get('hgvs_p') or '').strip()
    if not hgvs_p and 'nonsense' in cons:
        hgvs_p = f'p.Ter{ptc_aa}'
    out = {'exon_rank': er, 'hgvs_p': hgvs_p, 'ptc_aa_position': ptc_aa}
    fa = _ptc_aa_fraction_in_anatomical_exon(ce, er, ptc_aa)
    if fa is not None:
        out['fraction_in_exon'] = fa
    return out


def _build_splice_viz_ptc_markers(parsed_data, has_junction_row, has_secondary_skip_row):
    skip_l = _splice_viz_ptc_layer_skip(parsed_data, secondary=False)
    sec_l = _splice_viz_ptc_layer_skip(parsed_data, secondary=True) if has_secondary_skip_row else None
    jun_l = _splice_viz_ptc_layer_junction(parsed_data) if has_junction_row else None
    ref_l = _splice_viz_ptc_layer_reference(parsed_data)
    return {
        "reference": ref_l,
        "skip": skip_l,
        "junction": jun_l,
        "secondary_skip": sec_l,
    }


def _splice_viz_exons_full_from_rows(rows):
    """All mRNA coding exons with widths ∝ length (full transcript for reference strip)."""
    if not rows:
        return []
    try:
        sorted_rows = sorted(rows, key=lambda x: int(x.get('anatomical_rank') or 0))
    except (TypeError, ValueError):
        return []
    total = sum(int(x.get('length_bp') or 0) for x in sorted_rows) or 1
    out = []
    for x in sorted_rows:
        L = int(x.get('length_bp') or 0)
        r = int(x.get('anatomical_rank') or 0)
        w = max(0.0008, L / float(total))
        out.append({'rank': r, 'w': round(w, 6), 'len_bp': L})
    return out


def _splice_viz_pre_atg_context(parsed_data, coding_rows, details=None):
    """True when splice map should use pre-AUG product layout (not merely when gene has a 5′ UTR exon)."""
    _di = details if details is not None else (
        (parsed_data.get('deep_intronic_splice') or {}).get('details') or {}
    )
    return bool(
        parsed_data.get('deep_intronic_pre_atg_utr_pseudoexon')
        or (parsed_data.get('deep_intronic_primary_outcome') or {}).get('pre_atg_utr_pseudoexon')
        or _deep_intronic_cdot_in_pre_first_coding_intron(
            parsed_data.get('c_dot'), coding_rows or [], _di,
        )
        or _deep_intronic_intron_upstream_of_first_coding(coding_rows or [], _di)
    )


def _splice_viz_utr_exon_len_bp(parsed_data, coding_rows):
    """Approximate 5′-UTR exon length for schematic width (nt before first CDS base)."""
    m = re.search(r'c\.(\d+)-', str(parsed_data.get('c_dot') or ''), re.I)
    if m:
        try:
            anchor = int(m.group(1))
            if anchor > 1:
                return max(28, anchor - 1)
        except (TypeError, ValueError):
            pass
    first = _deep_intronic_first_coding_exon(coding_rows or [])
    if first:
        try:
            sc = int(first.get('start_cds') or 1)
            if sc > 1:
                return sc - 1
        except (TypeError, ValueError):
            pass
    return 80


def _splice_viz_exons_full_mrna(parsed_data, coding_rows):
    """
    mRNA exon ranks for the reference strip — prepend 5′-UTR exon 1 when the first
    mature exon is non-coding (INTS11: E1 UTR, E2 AUG) even if coding_exons uses VEP ranks.
    """
    exons = _splice_viz_exons_full_from_rows(coding_rows)
    show_utr_exon1 = bool(
        parsed_data.get('first_mrna_exon_is_non_coding')
        or _splice_viz_pre_atg_context(parsed_data, coding_rows)
    )
    if not exons or not show_utr_exon1:
        return exons
    ranks = sorted(int(e['rank']) for e in exons)
    utr_bp = _splice_viz_utr_exon_len_bp(parsed_data, coding_rows)
    if ranks and ranks[0] >= 2:
        if 1 not in ranks:
            exons = [{'rank': 1, 'len_bp': utr_bp, 'w': 0.01}] + list(exons)
    elif ranks and ranks[0] == 1:
        exons = [{'rank': 1, 'len_bp': utr_bp, 'w': 0.01}] + [
            {'rank': int(e['rank']) + 1, 'len_bp': int(e['len_bp']), 'w': e['w']}
            for e in exons
        ]
    total = sum(int(e['len_bp']) for e in exons) or 1
    for e in exons:
        e['w'] = round(max(0.0008, int(e['len_bp']) / float(total)), 6)
    return exons


def _splice_viz_focus_window(exons_full, center_rank, neighbor=2):
    """
    Neighboring exons only (±neighbor) around center_rank for isoform-specific rows.
    Returns renormalized widths within the slice plus truncation counts for ellipsis pills.
    """
    if not exons_full:
        return {'exons': [], 'trunc_before': 0, 'trunc_after': 0, 'window_lo': None, 'window_hi': None}
    if center_rank is None:
        cp = [dict(e) for e in exons_full]
        bp = sum(int(e['len_bp']) for e in cp) or 1
        for e in cp:
            e['w'] = round(max(0.02, int(e['len_bp']) / float(bp)), 4)
        return {'exons': cp, 'trunc_before': 0, 'trunc_after': 0, 'window_lo': None, 'window_hi': None}
    try:
        cr = int(center_rank)
    except (TypeError, ValueError):
        cp = [dict(e) for e in exons_full]
        bp = sum(int(e['len_bp']) for e in cp) or 1
        for e in cp:
            e['w'] = round(max(0.02, int(e['len_bp']) / float(bp)), 4)
        return {'exons': cp, 'trunc_before': 0, 'trunc_after': 0, 'window_lo': None, 'window_hi': None}
    ranks = [int(e['rank']) for e in exons_full]
    rmin, rmax = min(ranks), max(ranks)
    lo = max(rmin, cr - int(neighbor))
    hi = min(rmax, cr + int(neighbor))
    subset_raw = [e for e in exons_full if lo <= int(e['rank']) <= hi]
    subset_raw.sort(key=lambda e: int(e['rank']))
    trunc_before = sum(1 for e in exons_full if int(e['rank']) < lo)
    trunc_after = sum(1 for e in exons_full if int(e['rank']) > hi)
    bp = sum(int(e['len_bp']) for e in subset_raw) or 1
    subset = [
        {
            'rank': int(e['rank']),
            'len_bp': int(e['len_bp']),
            'w': round(max(0.02, int(e['len_bp']) / float(bp)), 4),
        }
        for e in subset_raw
    ]
    return {
        'exons': subset,
        'trunc_before': trunc_before,
        'trunc_after': trunc_after,
        'window_lo': lo,
        'window_hi': hi,
    }


def _junction_align_hgvs_intron(anchor_c, offset_from_acceptor):
    try:
        return f'c.{int(anchor_c)}-{int(offset_from_acceptor)}'
    except (TypeError, ValueError):
        return ''


def _junction_align_hgvs_exon(anchor_c, pos_0based_in_exon):
    try:
        return f'c.{int(anchor_c) + int(pos_0based_in_exon)}'
    except (TypeError, ValueError):
        return ''


def _junction_align_cryptic_acceptor_product_bases(ins, cds, anchor_c, *, exon_cont_len=14):
    """
    Mature mRNA product for canonical-junction cryptic acceptor gain.

    All retained intronic nt (``shift_nt`` / ``inserted_cdna``) render as pseudo-exon;
    downstream exon 5′ is trimmed when it duplicates the insert suffix (e.g. CATG at
    c.910) so reviewers see +16 nt green, not 12 nt green + 4 nt blue at the junction.
    """
    ins = str(ins or '').upper()
    cds = str(cds or '').upper()
    try:
        anchor = int(anchor_c)
    except (TypeError, ValueError):
        anchor = 0
    if not ins or anchor <= 0:
        return [], []
    exon_head = cds[anchor - 1:anchor - 1 + max(1, int(exon_cont_len or 14))]
    _k, exon_tail = _junction_align_overlap_trim_suffix_prefix(ins, exon_head)
    bases = []
    for i, nt in enumerate(ins):
        bases.append({
            'nt': nt,
            'kind': 'exon_extension_intronic',
            'hgvs': _junction_align_hgvs_intron(anchor, len(ins) - i),
        })
    for i, nt in enumerate(exon_tail):
        bases.append({
            'nt': nt,
            'kind': 'exon',
            'hgvs': _junction_align_hgvs_exon(anchor, len(ins) + i),
        })
    spans = [{
        'start': 0,
        'end': len(ins),
        'kind': 'exon_extension',
        'label': f'+{len(ins)} nt retained (cryptic acceptor)',
    }]
    return bases, spans


def _junction_align_flat_bases(intron, ag, exon_head, anchor_c, *, ext_first=False, ext_len=0):
    """
    Flat per-nt list for junction alignment tracks.
    Pre-mRNA: intron (c.N−k) → AG → exon 14 (c.N…).
    Mature with extension: extension nt (c.N…) → exon continuation.
    """
    bases = []
    intron = str(intron or '').upper()
    ag = str(ag or '').upper()
    exon_head = str(exon_head or '').upper()
    try:
        anchor = int(anchor_c)
    except (TypeError, ValueError):
        anchor = 0

    if not ext_first:
        ilen = len(intron)
        for i, nt in enumerate(intron):
            off = ilen - i
            bases.append({
                'nt': nt,
                'kind': 'intron',
                'hgvs': _junction_align_hgvs_intron(anchor, off) if anchor and off > 0 else '',
            })
        for i, nt in enumerate(ag):
            off = len(ag) - i
            bases.append({
                'nt': nt,
                'kind': 'splice_ag',
                'hgvs': _junction_align_hgvs_intron(anchor, off) if anchor and off > 0 else '',
            })
        for i, nt in enumerate(exon_head):
            bases.append({
                'nt': nt,
                'kind': 'exon',
                'hgvs': _junction_align_hgvs_exon(anchor, i) if anchor else '',
            })
    else:
        ext = str(intron or '').upper()
        for i, nt in enumerate(ext):
            bases.append({
                'nt': nt,
                'kind': 'exon_extension',
                'hgvs': _junction_align_hgvs_exon(anchor, i) if anchor else '',
            })
        for i, nt in enumerate(exon_head):
            bases.append({
                'nt': nt,
                'kind': 'exon',
                'hgvs': _junction_align_hgvs_exon(anchor, ext_len + i) if anchor else '',
            })
    return bases


def _junction_align_track_origin_from_bases(bases):
    """0-based mutant-CDS index of the first base on a junction-align track."""
    for b in bases or []:
        hgvs = (b or {}).get('hgvs') or ''
        m = re.search(r'c\.(\d+)', hgvs)
        if m:
            try:
                return int(m.group(1)) - 1
            except (TypeError, ValueError):
                pass
    return None


def _junction_align_upstream_exon_tail_bases(cds, upstream_end_cds, *, tail_len=12):
    """Last ``tail_len`` nt of upstream exon for mature product junction context."""
    cds = str(cds or '').upper()
    try:
        up_end = int(upstream_end_cds)
    except (TypeError, ValueError):
        return []
    if up_end <= 0:
        return []
    n = max(1, min(int(tail_len or 12), up_end))
    lo = up_end - n
    return [
        {'nt': nt, 'kind': 'exon', 'hgvs': f'c.{lo + i + 1}'}
        for i, nt in enumerate(cds[lo:up_end])
    ]


def _junction_align_downstream_exon_head_bases(cds, downstream_start_cds, *, head_len=14):
    """First ``head_len`` nt of downstream exon in mature mRNA product context."""
    cds = str(cds or '').upper()
    try:
        start = int(downstream_start_cds)
    except (TypeError, ValueError):
        return []
    if start <= 0:
        return []
    n = max(1, int(head_len or 14))
    head = cds[start - 1:start - 1 + n]
    return [
        {'nt': nt, 'kind': 'exon', 'hgvs': _junction_align_hgvs_exon(start, i)}
        for i, nt in enumerate(head)
    ]


def _junction_align_downstream_slice_start(
    *,
    upstream_end_cds=None,
    downstream_start_cds=None,
    anchor_c=1,
):
    """
    0-based CDS index where downstream exon head begins in a mature product track.

    Upstream prefix uses cds[lo:upstream_end_cds] (exclusive end). The next base is
    downstream 5′ and must not repeat the last upstream nt already shown in the prefix
    (e.g. c.2250 G after exon 16 when pseudo-exon follows).
    """
    try:
        up = int(upstream_end_cds or 0)
    except (TypeError, ValueError):
        up = 0
    if up > 0:
        return up
    try:
        dn = int(downstream_start_cds or 0)
    except (TypeError, ValueError):
        dn = 0
    if dn > 0:
        return dn - 1
    try:
        return max(0, int(anchor_c or 1) - 1)
    except (TypeError, ValueError):
        return 0


def _junction_align_shift_track_annotations(spans, markers, offset):
    """Shift span/marker base indices after prepending context to a product track."""
    try:
        off = int(offset or 0)
    except (TypeError, ValueError):
        off = 0
    if off <= 0:
        return list(spans or []), list(markers or [])
    out_spans = []
    for sp in spans or []:
        s = dict(sp)
        s['start'] = int(sp.get('start') or 0) + off
        s['end'] = int(sp.get('end') or 0) + off
        out_spans.append(s)
    out_markers = []
    for m in markers or []:
        mk = dict(m)
        if mk.get('index') is not None:
            mk['index'] = int(mk['index']) + off
        out_markers.append(mk)
    return out_spans, out_markers


def _junction_align_prepend_upstream_exon_context(
    bases, spans, markers, *, prefix_bases, upstream_exon_rank,
):
    """Prepend upstream exon 3′ tail; annotate splice junction before insert/pseudo-exon."""
    pre = list(prefix_bases or [])
    if not pre:
        return bases, spans, markers, 0
    off = len(pre)
    merged = pre + list(bases or [])
    sp, mk = _junction_align_shift_track_annotations(spans, markers, off)
    try:
        er = int(upstream_exon_rank or 0)
    except (TypeError, ValueError):
        er = 0
    sp.insert(0, {
        'start': 0,
        'end': off,
        'kind': 'exon',
        'label': f'exon {er} 3\u2032 ({off} nt)' if er else f'upstream exon 3\u2032 ({off} nt)',
    })
    mk.insert(0, {
        'index': off,
        'kind': 'splice_gain',
        'label': f'cryptic splice after exon {er}' if er else 'cryptic splice junction',
    })
    return merged, sp, mk, off


def _junction_align_pseudoexon_len(bases):
    """Count retained pseudo-exon / UTR extension nt on a mature product track."""
    pseudo_kinds = {'exon_extension', 'exon_extension_intronic', 'utr_extension'}
    return len([b for b in (bases or []) if (b or {}).get('kind') in pseudo_kinds])


def _junction_align_ptc_marker_product(
    bases, co, *, insert_len=None, track_origin_cds_0based=None, display_prefix_len=0,
):
    """
    PTC span on a mature splice-product track.
    When the stop lies in / overlaps the pseudo-exon, align with the splice exon map
    (fraction along pseudo-exon box) instead of showing a junction-straddling triplet.
    """
    if not co or not bases:
        return None
    try:
        ins_len = int(insert_len or 0)
    except (TypeError, ValueError):
        ins_len = 0
    if ins_len <= 0:
        ins_len = _junction_align_pseudoexon_len(bases)

    in_pseudo = bool(
        co.get('ptc_within_insert')
        or co.get('ptc_in_pseudoexon_nt')
        or co.get('ptc_location_kind') == 'pseudo_exon'
    )

    try:
        prefix = int(display_prefix_len or 0)
    except (TypeError, ValueError):
        prefix = 0

    if in_pseudo and ins_len > 0:
        label = (co.get('fs_ter_str') or '').strip() or f"Ter aa {co.get('ptc_aa_position') or '?'}"
        frac = co.get('ptc_fraction_in_insert')
        if frac is not None:
            try:
                center = int(round(float(frac) * ins_len))
            except (TypeError, ValueError):
                center = ins_len - 1
        else:
            try:
                ptc_aa = int(co.get('ptc_aa_position') or 0)
                fs_aa = int(co.get('first_changed_aa_pos') or co.get('first_insert_aa_pos') or 0)
                if ptc_aa > 0 and fs_aa > 0:
                    center = min(ins_len - 1, max(0, (ptc_aa - fs_aa + 1) * 3 - 2))
                else:
                    center = ins_len - 1
            except (TypeError, ValueError):
                center = ins_len - 1
        center = min(max(0, center), ins_len - 1)
        rel_start = max(0, min(center - 1, ins_len - 3))
        rel_end = min(ins_len, rel_start + 3)
        t_start = prefix + rel_start
        t_end = prefix + rel_end
        codon = ''.join((bases[i] or {}).get('nt', '?') for i in range(t_start, t_end))
        note = ''
        raw = _junction_align_ptc_marker(
            bases, co, track_origin_cds_0based=track_origin_cds_0based,
        )
        if raw and not raw.get('off_window') and int(raw.get('end') or 0) > prefix + ins_len:
            note = ' (stop triplet completes in downstream exon sequence)'
        return {
            'start': t_start,
            'end': t_end,
            'kind': 'ptc',
            'label': label + note,
            'codon': codon or None,
            'ptc_aa': co.get('ptc_aa_position'),
            'in_pseudoexon': True,
        }

    raw = _junction_align_ptc_marker(
        bases, co, track_origin_cds_0based=track_origin_cds_0based,
    )
    if raw and prefix and not raw.get('off_window'):
        raw = dict(raw)
        raw['start'] = int(raw.get('start') or 0) + prefix
        raw['end'] = int(raw.get('end') or 0) + prefix
    return raw


def _junction_align_ptc_off_window_note(co, *, ptc_aa, downstream_nt=None, suffix=''):
    """Human-readable PTC note when the stop triplet is outside the junction zoom."""
    ex_bit = ''
    try:
        er = int(co.get('ptc_exon_rank') or 0)
        if er > 0:
            ex_bit = f' in exon {er}'
    except (TypeError, ValueError):
        pass
    if downstream_nt is not None and int(downstream_nt) > 0:
        return (
            f'PTC at aa {ptc_aa}{ex_bit} is {int(downstream_nt)} nt 3′ of this junction window '
            f'(stop codon not shown — map is junction-schematic only).{suffix}'
        )
    return f'PTC at aa {ptc_aa}{ex_bit} (beyond junction window).{suffix}'


def _junction_align_ptc_marker(bases, co, *, track_origin_cds_0based=None):
    """
    Map predicted PTC to a 3-nt stop-codon span on a mature-mRNA/cDNA track.
    Returns dict: {start, end, label, codon?, off_window?, downstream_nt?} or None.
    track_origin_cds_0based: mutant CDS index (0-based) of track[0].
    """
    if not co or not bases:
        return None
    if co.get('pre_atg_utr_pseudoexon'):
        return None
    try:
        ptc_aa = int(co.get('ptc_aa_position') or 0)
    except (TypeError, ValueError):
        return None
    if ptc_aa <= 0:
        return None
    label = (co.get('fs_ter_str') or f'Ter aa {ptc_aa}').strip()
    ptc_codon_idx = ptc_aa - 1
    ptc_nt_start_mut = ptc_codon_idx * 3
    ptc_nt_end_mut = ptc_nt_start_mut + 3

    if track_origin_cds_0based is not None:
        try:
            origin = int(track_origin_cds_0based)
        except (TypeError, ValueError):
            origin = None
    else:
        origin = None

    if origin is not None:
        t_start = ptc_nt_start_mut - origin
        t_end = ptc_nt_end_mut - origin
        codon = ''.join((bases[i] or {}).get('nt', '?') for i in range(t_start, t_end)
                        if 0 <= i < len(bases))
        if t_end <= 0 or t_start >= len(bases):
            downstream = max(0, t_start - len(bases))
            return {
                'off_window': True,
                'label': label,
                'downstream_nt': downstream,
                'ptc_aa': ptc_aa,
                'note': _junction_align_ptc_off_window_note(co, ptc_aa=ptc_aa, downstream_nt=downstream),
            }
        t_start = max(0, t_start)
        t_end = min(len(bases), t_end)
        if t_end - t_start < 1:
            return None
        return {
            'start': t_start,
            'end': t_end,
            'kind': 'ptc',
            'label': label,
            'codon': codon or None,
            'ptc_aa': ptc_aa,
        }

    # Fallback: no CDS anchor — do not clamp to window tail
    ext_kind = {'exon_extension', 'exon_extension_intronic', 'exon_extension_prior_exon', 'exon'}
    coding_idx = [i for i, b in enumerate(bases) if b.get('kind') in ext_kind]
    if not coding_idx:
        return {
            'off_window': True,
            'label': label,
            'ptc_aa': ptc_aa,
            'note': _junction_align_ptc_off_window_note(co, ptc_aa=ptc_aa),
        }
    try:
        fs_aa = int(co.get('first_changed_aa_pos') or co.get('first_insert_aa_pos') or 0)
    except (TypeError, ValueError):
        fs_aa = 0
    if fs_aa <= 0:
        return {
            'off_window': True,
            'label': label,
            'ptc_aa': ptc_aa,
            'note': _junction_align_ptc_off_window_note(co, ptc_aa=ptc_aa),
        }
    ds_aa = max(0, ptc_aa - fs_aa)
    start_coding = coding_idx[0]
    t_start = start_coding + ds_aa * 3
    t_end = t_start + 3
    if t_start >= len(bases):
        return {
            'off_window': True,
            'label': label,
            'downstream_nt': t_start - len(bases),
            'ptc_aa': ptc_aa,
            'note': _junction_align_ptc_off_window_note(
                co, ptc_aa=ptc_aa, downstream_nt=t_start - len(bases),
            ),
        }
    t_end = min(len(bases), t_end)
    codon = ''.join((bases[i] or {}).get('nt', '?') for i in range(t_start, t_end))
    return {'start': t_start, 'end': t_end, 'kind': 'ptc', 'label': label, 'codon': codon, 'ptc_aa': ptc_aa}


def _parse_dup_range_hgvs_acceptor(c_dot):
    """Parse c.N−k_Mdup range (dup spans intron into exon). Returns None if not matched."""
    s = re.sub(r'\s+', '', str(c_dot or ''))
    m = re.search(r'c\.(\d+)-(\d+)_(\d+)dup', s, re.I)
    if not m:
        return None
    try:
        return {
            'anchor_c': int(m.group(1)),
            'intron_off_start': int(m.group(2)),
            'exon_end_c': int(m.group(3)),
        }
    except (TypeError, ValueError):
        return None


def _junction_align_bases_hgvs_index(bases, hgvs_label):
    target = str(hgvs_label or '').strip()
    if not target:
        return -1
    for i, b in enumerate(bases or []):
        if (b or {}).get('hgvs') == target:
            return i
    return -1


def _junction_align_bases_from_dup_seq(dup_seq, ref_slice):
    """Label dup-insert bases using reference slice kinds/hgvs where possible."""
    dup_seq = str(dup_seq or '').upper()
    out = []
    for i, nt in enumerate(dup_seq):
        if i < len(ref_slice):
            b = dict(ref_slice[i])
            b['nt'] = nt
            out.append(b)
        else:
            out.append({'nt': nt, 'kind': 'intron', 'hgvs': ''})
    return out


def _junction_align_dup_premrna_pair(
    intron_pre_ref, ag_ref, exon_head, anchor_c, dup, dup_rng, dn_rank,
):
    """
    Reference + tandem-dup mutant pre-mRNA tracks.
    Reference: red span = duplicated source (c.N−k … c.M).
    Mutant: red span = inserted copy placed 3′ of original span.
    """
    ref_bases = _junction_align_flat_bases(intron_pre_ref, ag_ref, exon_head, anchor_c)
    tracks_ref = {
        'bases': ref_bases,
        'spans': [],
        'markers': [
            {'index': len(intron_pre_ref), 'kind': 'splice_ag', 'label': 'canonical AG'},
            {'index': len(intron_pre_ref) + len(ag_ref), 'kind': 'exon_start', 'label': f'exon {dn_rank} (c.{anchor_c})'},
        ],
    }
    if not dup_rng:
        return tracks_ref, None

    start_hgvs = f"c.{dup_rng['anchor_c']}-{dup_rng['intron_off_start']}"
    end_hgvs = f"c.{dup_rng['exon_end_c']}"
    dup_start = _junction_align_bases_hgvs_index(ref_bases, start_hgvs)
    dup_end = _junction_align_bases_hgvs_index(ref_bases, end_hgvs)
    if dup_start < 0 or dup_end < 0:
        dup_end = len(ref_bases)
        dup_start = max(0, dup_end - len(dup))
    else:
        dup_end += 1

    tracks_ref['spans'] = [{
        'start': dup_start,
        'end': dup_end,
        'kind': 'dup',
        'label': f'dup source ({dup_end - dup_start} nt: intron → exon {dn_rank})',
    }]

    ref_slice = ref_bases[dup_start:dup_end]
    ins_bases = _junction_align_bases_from_dup_seq(dup, ref_slice)
    mut_bases = ref_bases[:dup_end] + ins_bases + ref_bases[dup_end:]
    ins_start = dup_end
    ins_end = dup_end + len(ins_bases)
    intronic_in_source = max(0, len(intron_pre_ref) + len(ag_ref) - dup_start)

    tracks_mut = {
        'bases': mut_bases,
        'spans': [{
            'start': ins_start,
            'end': ins_end,
            'kind': 'dup',
            'label': f'{len(ins_bases)} nt dup insert',
        }],
        'markers': [
            {'index': len(intron_pre_ref), 'kind': 'splice_ag', 'label': 'canonical AG'},
            {'index': ins_end, 'kind': 'splice_ag', 'label': 'canonical AG (2nd copy)'},
            {'index': ins_end + len(ag_ref), 'kind': 'exon_start', 'label': f'exon {dn_rank} (c.{anchor_c})'},
        ],
        'dup_meta': {
            'intron_nt_in_dup': intronic_in_source,
            'exon_nt_in_dup': max(0, len(ins_bases) - intronic_in_source),
            'exon_end_c': dup_rng['exon_end_c'],
        },
    }
    return tracks_ref, tracks_mut


def _junction_align_mature_dup_retained_bases(dup, cds, anchor_c, dup_rng, exon_cont_len=14):
    """Product 1: full dup becomes 5′ of exon; continuation from c.(exon_end+1)."""
    dup = str(dup or '').upper()
    cds = str(cds or '').upper()
    if not dup or not dup_rng:
        return [], [], []
    try:
        exon_end_c = int(dup_rng['exon_end_c'])
        intron_off = int(dup_rng['intron_off_start'])
    except (TypeError, ValueError):
        return [], [], []
    intronic_nt = intron_off
    exonic_nt = max(0, len(dup) - intronic_nt)
    bases = []
    for i, nt in enumerate(dup):
        if i < intronic_nt:
            kind = 'exon_extension_intronic'
            hgvs = _junction_align_hgvs_intron(anchor_c, intron_off - i)
        else:
            # Dup'd exon 14 segment is canonical exon sequence in mature mRNA (c.N…c.M).
            kind = 'exon'
            hgvs = _junction_align_hgvs_exon(anchor_c, i - intronic_nt)
        bases.append({'nt': nt, 'kind': kind, 'hgvs': hgvs})
    cont = cds[exon_end_c:exon_end_c + exon_cont_len]
    for i, nt in enumerate(cont):
        bases.append({'nt': nt, 'kind': 'exon', 'hgvs': f'c.{exon_end_c + 1 + i}'})
    spans = [
        {'start': 0, 'end': intronic_nt, 'kind': 'exon_extension', 'label': f'{intronic_nt} nt was intronic'},
        {
            'start': intronic_nt,
            'end': len(dup),
            'kind': 'exon',
            'label': f'exon 14 c.{anchor_c}–c.{exon_end_c} ({exonic_nt} nt dup′d)',
        },
    ]
    markers = [{'index': intronic_nt, 'kind': 'exon_start', 'label': f'exon 14 starts c.{anchor_c}'}]
    if len(dup) < len(bases):
        markers.append({'index': len(dup), 'kind': 'exon_start', 'label': f'c.{exon_end_c + 1} continuation'})
    return bases, spans, markers


def _junction_align_overlap_trim_suffix_prefix(left, right):
    """Return (overlap_nt, right_trimmed) for longest suffix(left)==prefix(right)."""
    left = str(left or '').upper()
    right = str(right or '').upper()
    max_k = min(len(left), len(right))
    for k in range(max_k, 0, -1):
        if left[-k:] == right[:k]:
            return k, right[k:]
    return 0, right


def _acceptor_gain_body_bounds_from_pick(pick):
    """Resolve GT→AG body slice indices from geometry / picked_ag dicts."""
    pick = pick or {}
    bs = pick.get('body_start_0based')
    if bs is None:
        bs = pick.get('body_start')
    ag_i = pick.get('ag_start')
    if ag_i is None:
        ag_i = pick.get('body_end_0based')
    try:
        bs_i = int(bs) if bs is not None else None
    except (TypeError, ValueError):
        bs_i = None
    try:
        ag_i = int(ag_i) if ag_i is not None else None
    except (TypeError, ValueError):
        ag_i = None
    gt_i = pick.get('gt_start')
    if gt_i is not None and bs_i is not None:
        try:
            if int(bs_i) == int(gt_i):
                bs_i = int(gt_i) + 2
        except (TypeError, ValueError):
            pass
    return bs_i, ag_i


def _acceptor_gain_strip_duplicate_exon_junction_nt(body, cds, downstream_start_0):
    """Remove pseudo-exon nt duplicated from native downstream exon 5′ (e.g. c.2250 G)."""
    body = str(body or '').upper()
    cds = str(cds or '').upper()
    try:
        ds = int(downstream_start_0 or 0)
    except (TypeError, ValueError):
        return body
    if ds < 0 or ds >= len(cds):
        return body
    exon5 = cds[ds]
    k, _ = _junction_align_overlap_trim_suffix_prefix(body, cds[ds:])
    if k:
        body = body[:-k]
    while body and body[0] == exon5:
        body = body[1:]
    return body


def _acceptor_gain_mature_retained_body(
    retained,
    *,
    mut_seq=None,
    picked_ag=None,
    cds_seq='',
    downstream_start_0=0,
    target_body_nt=None,
):
    """
    Acceptors gain pseudo-exon body only (between GT and gained AG).
    Strip any suffix duplicated from native downstream exon 5′ (e.g. c.2250 G must
    not sit inside the body when it also starts the continuation exon).
    """
    body = str(retained or '').upper()
    seq = str(mut_seq or '').upper()
    pick = picked_ag or {}
    bs_i, ag_i = _acceptor_gain_body_bounds_from_pick(pick)
    if bs_i is not None and ag_i is not None and seq and 0 <= bs_i < ag_i <= len(seq):
        body = seq[bs_i:ag_i]
    target = target_body_nt
    if target is None:
        target = pick.get('target_body_nt')
    if target is None:
        target = pick.get('body_nt')
    try:
        target = int(target or 0)
    except (TypeError, ValueError):
        target = 0
    cds = str(cds_seq or '').upper()
    try:
        ds = int(downstream_start_0 or 0)
    except (TypeError, ValueError):
        ds = 0
    if ds >= 0 and ds < len(cds):
        body = _acceptor_gain_strip_duplicate_exon_junction_nt(body, cds, ds)
    if target > 0 and len(body) > target:
        body = body[len(body) - target:]
    if ds >= 0 and ds < len(cds):
        body = _acceptor_gain_strip_duplicate_exon_junction_nt(body, cds, ds)
    return body


def _junction_align_mature_acceptor_gain_bases(
    ins, cds, anchor_c, exon_cont_len=14, *, geom=None, exon_rank=None,
    upstream_end_cds=None, upstream_exon_rank=None, upstream_tail_len=12, co=None,
    mut_seq=None, downstream_start_cds=None,
):
    """
    Product 2: upstream exon 3′ + pseudo-exon body (GT→gained AG) + downstream exon 5′.
    Duplicate downstream-exon nt (e.g. c.2250 G) must not appear inside the pseudo-exon track.
    """
    ins = str(ins or '').upper()
    cds = str(cds or '').upper()
    co = co or {}
    geom = geom or co.get('pseudoexon_geometry') or {}
    try:
        anchor = int(anchor_c)
    except (TypeError, ValueError):
        anchor = 1
    try:
        dn_start = int(downstream_start_cds or anchor)
    except (TypeError, ValueError):
        dn_start = anchor
    dn_slice = _junction_align_downstream_slice_start(
        upstream_end_cds=upstream_end_cds,
        downstream_start_cds=dn_start,
        anchor_c=anchor,
    )
    ds0 = max(0, dn_start - 1)
    target_nt = co.get('shift_nt')
    if target_nt is None:
        target_nt = geom.get('body_nt')
    ins = _acceptor_gain_mature_retained_body(
        ins,
        mut_seq=mut_seq,
        picked_ag=geom,
        cds_seq=cds,
        downstream_start_0=ds0,
        target_body_nt=target_nt,
    )
    if not ins:
        return [], [], []
    exon_first = cds[dn_slice] if 0 <= dn_slice < len(cds) else ''
    while ins and exon_first and ins[0] == exon_first:
        ins = ins[1:]
    exon_tail = cds[dn_slice:dn_slice + exon_cont_len]
    exon_hgvs_start = dn_slice + 1

    bases = []
    for i, nt in enumerate(ins):
        bases.append({
            'nt': nt,
            'kind': 'exon_extension_intronic',
            'hgvs': _junction_align_hgvs_intron(anchor, len(ins) - i),
        })
    for i, nt in enumerate(exon_tail):
        bases.append({'nt': nt, 'kind': 'exon', 'hgvs': _junction_align_hgvs_exon(exon_hgvs_start, i)})

    spans = []
    if ins:
        spans.append({
            'start': 0,
            'end': len(ins),
            'kind': 'exon_extension',
            'label': f'{len(ins)} nt pseudo-exon (was intronic)',
        })

    markers = []
    for i in range(max(0, len(ins) - 1)):
        if ins[i:i + 2] == 'AG':
            markers.append({
                'index': i,
                'kind': 'splice_ag_skipped',
                'label': 'AG motif in pseudo-exon (not used as acceptor)',
            })
    _jp = bool((geom or {}).get('junction_proximal_acceptor'))
    splice_lbl = (
        'gained AG splice → exon '
        + (str(int(exon_rank)) if exon_rank else f'c.{anchor}')
        + (' (canonical-proximal; ref acceptor skipped)' if _jp else '')
    )
    markers.append({'index': len(ins), 'kind': 'splice_ag', 'label': splice_lbl})
    if exon_tail:
        markers.append({
            'index': len(ins),
            'kind': 'exon_start',
            'label': f'exon {exon_rank or "?"} continues c.{exon_hgvs_start}',
        })
    prefix = _junction_align_upstream_exon_tail_bases(
        cds, upstream_end_cds, tail_len=upstream_tail_len,
    )
    bases, spans, markers, _pfx = _junction_align_prepend_upstream_exon_context(
        bases, spans, markers,
        prefix_bases=prefix,
        upstream_exon_rank=upstream_exon_rank,
    )
    return bases, spans, markers


def _junction_align_mature_donor_gain_bases(
    ins, cds, donor_end, dn_start, *, upstream_exon_rank=None, downstream_exon_rank=None,
    upstream_tail_len=12, downstream_head_len=14,
):
    """Mature mRNA: upstream exon 3′ + retained insert + downstream exon 5′."""
    ins = str(ins or '').upper()
    cds = str(cds or '').upper()
    if not ins:
        return [], [], []
    try:
        donor_end = int(donor_end)
        dn_start = int(dn_start)
    except (TypeError, ValueError):
        return [], [], []
    prefix = _junction_align_upstream_exon_tail_bases(
        cds, donor_end, tail_len=upstream_tail_len,
    )
    body = []
    for i, nt in enumerate(ins):
        body.append({
            'nt': nt,
            'kind': 'exon_extension',
            'hgvs': f'c.{donor_end}+{1 + i}',
        })
    suffix = _junction_align_downstream_exon_head_bases(
        cds, dn_start, head_len=downstream_head_len,
    )
    bases = prefix + body + suffix
    spans = []
    if prefix:
        sp_up = int(upstream_exon_rank or 0)
        spans.append({
            'start': 0,
            'end': len(prefix),
            'kind': 'exon',
            'label': f'exon {sp_up} 3\u2032 ({len(prefix)} nt)' if sp_up else f'upstream exon 3\u2032',
        })
    spans.append({
        'start': len(prefix),
        'end': len(prefix) + len(body),
        'kind': 'exon_extension',
        'label': f'+{len(body)} nt retained',
    })
    if suffix:
        sp_dn = int(downstream_exon_rank or 0)
        spans.append({
            'start': len(prefix) + len(body),
            'end': len(bases),
            'kind': 'exon',
            'label': f'exon {sp_dn} 5\u2032 ({len(suffix)} nt)' if sp_dn else 'downstream exon 5\u2032',
        })
    markers = []
    if prefix:
        mk_up = int(upstream_exon_rank or 0)
        markers.append({
            'index': len(prefix),
            'kind': 'splice_gain',
            'label': f'cryptic splice after exon {mk_up}' if mk_up else 'cryptic donor splice',
        })
    if suffix:
        markers.append({
            'index': len(prefix) + len(body),
            'kind': 'exon_start',
            'label': f'exon {downstream_exon_rank or dn_start} (c.{dn_start})',
        })
    return bases, spans, markers


def _junction_align_ruler_ticks(bases, every=10, *, extra_indices=None):
    """Ruler labels every N nt aligned to base grid."""
    ticks = []
    n = len(bases or [])
    if n > 180:
        every = max(every, 50)
    elif n > 80:
        every = max(every, 20)
    seen = set()
    for i in range(0, n, every):
        hgvs = (bases[i] or {}).get('hgvs') or str(i + 1)
        short = hgvs.replace('c.', '') if hgvs.startswith('c.') else hgvs
        ticks.append({'index': i, 'label': short})
        seen.add(i)
    for ei in extra_indices or []:
        try:
            idx = int(ei)
        except (TypeError, ValueError):
            continue
        if 0 <= idx < n and idx not in seen:
            hgvs = (bases[idx] or {}).get('hgvs') or str(idx + 1)
            short = hgvs.replace('c.', '') if hgvs.startswith('c.') else hgvs
            ticks.append({'index': idx, 'label': short})
            seen.add(idx)
    ticks.sort(key=lambda t: int(t['index']))
    if n and (n - 1) not in seen:
        last = bases[-1].get('hgvs') or ''
        ticks.append({
            'index': n - 1,
            'label': last.replace('c.', '') if last.startswith('c.') else last,
        })
    return ticks


def _junction_align_legend(tracks=None):
    # The red underline marks the *variant* span (deletion, duplication, or SNV).
    # Inspect the actual spans so the legend names what is really shown rather
    # than always saying "duplication".
    has_dup = has_del = has_ins = has_snv = False
    for tr in (tracks or []):
        for sp in (tr.get('spans') or []):
            k = sp.get('kind')
            if k == 'dup':
                has_dup = True
            elif k == 'variant':
                lbl = str(sp.get('label') or '').lower()
                if 'del' in lbl:
                    has_del = True
                elif 'dup' in lbl:
                    has_dup = True
                elif 'ins' in lbl:
                    has_ins = True
                else:
                    has_snv = True
    _types = []
    if has_del:
        _types.append('Deletion')
    if has_dup:
        _types.append('Duplication')
    if has_ins:
        _types.append('Insertion')
    if has_snv and not _types:
        _types.append('Variant base')
    if _types:
        underline_label = ' / '.join(_types) + ' span (red underline)'
    else:
        underline_label = 'Variant / indel span (red underline)'
    return [
        {'kind': 'intron', 'label': 'Intron (pre-mRNA only)'},
        {'kind': 'splice_ag', 'label': 'Canonical AG / other intronic AG (acceptor) · GT (donor)'},
        {'kind': 'splice_loss', 'label': 'Splice site LOST (canonical disrupted)'},
        {'kind': 'splice_gain', 'label': 'Splice site GAINED (cryptic site used)'},
        {'kind': 'exon', 'label': 'Exon (coding in mature mRNA)'},
        {'kind': 'exon_extension', 'label': 'Spliced-in / retained extension'},
        {'kind': 'exon_extension_intronic', 'label': 'Was intronic → now coding'},
        {'kind': 'dup', 'label': underline_label},
        {'kind': 'ptc', 'label': 'Predicted PTC (Ter)'},
        {'kind': 'exon_skip', 'label': 'Exon skipped / excised'},
    ]


def _junction_align_flat_bases_donor(exon_tail, gt, intron, anchor_c_end, *, win_offset=1, hgvs_intron_anchor=None):
    """Donor-side junction: exon 3′ tail → GT → intron 5′ (c.N+k coordinates).

    ``anchor_c_end`` sets exon c. labels (last base of upstream exon).  When
    HGVS uses a different reference digit (e.g. c.648+5 while exon ends at
    c.700), pass that digit as ``hgvs_intron_anchor`` for +offset labels.
    """
    bases = []
    tail = str(exon_tail or '').upper()
    gt = str(gt or '').upper()
    intron = str(intron or '').upper()
    try:
        anchor = int(anchor_c_end)
    except (TypeError, ValueError):
        anchor = 0
    try:
        hgvs_a = int(hgvs_intron_anchor) if hgvs_intron_anchor is not None else anchor
    except (TypeError, ValueError):
        hgvs_a = anchor
    for i, nt in enumerate(tail):
        pos = anchor - len(tail) + i + 1
        bases.append({'nt': nt, 'kind': 'exon', 'hgvs': f'c.{pos}' if pos > 0 else ''})
    for i, nt in enumerate(gt):
        off = win_offset + i
        bases.append({'nt': nt, 'kind': 'splice_gt', 'hgvs': f'c.{hgvs_a}+{off}' if hgvs_a else ''})
    for i, nt in enumerate(intron):
        off = win_offset + len(gt) + i
        bases.append({'nt': nt, 'kind': 'intron', 'hgvs': f'c.{hgvs_a}+{off}' if hgvs_a else ''})
    return bases


def _junction_align_flat_bases_acceptor(intron, ag, exon_head, anchor_c_start):
    """Acceptor-side junction: intron 3′ (c.N−k) → AG → exon 5′ (c.N…).

    Coordinates are correct here — intron offsets sit ABOVE the 2-nt AG (…−4,−3
    then −2,−1) — unlike the generic _junction_align_flat_bases, whose intron
    offsets collide with the AG. That quirk is invisible with 'n' placeholders
    but produces wrong c. labels once real sequence is shown.
    """
    bases = []
    intron = str(intron or '').upper()
    ag = str(ag or '').upper()
    exon_head = str(exon_head or '').upper()
    try:
        anchor = int(anchor_c_start)
    except (TypeError, ValueError):
        anchor = 0
    a = len(ag)
    total = len(intron) + a
    for i, nt in enumerate(intron):
        off = total - i  # farthest upstream first
        bases.append({'nt': nt, 'kind': 'intron',
                      'hgvs': f'c.{anchor}-{off}' if anchor and off > 0 else ''})
    for i, nt in enumerate(ag):
        off = a - i  # 2, 1
        bases.append({'nt': nt, 'kind': 'splice_ag',
                      'hgvs': f'c.{anchor}-{off}' if anchor and off > 0 else ''})
    for i, nt in enumerate(exon_head):
        bases.append({'nt': nt, 'kind': 'exon',
                      'hgvs': f'c.{anchor + i}' if anchor else ''})
    return bases


def _junction_align_acceptor_intron_flank(parsed_data, cx, win):
    """Real genomic AG acceptor + upstream intron bases for the 3′ acceptor of
    coding exon ``cx`` (transcript orientation).

    Returns ``(ag_seq, intron_seq)`` where ``ag_seq`` is c.N−2/−1 and
    ``intron_seq`` is c.N−3 upstream (5′→3′ order, farthest first), or
    ``(None, None)`` so the caller falls back to schematic placeholders.
    Mirror of _junction_align_donor_intron_flank for the upstream splice site.
    """
    try:
        chrom = (parsed_data.get('transcript_chrom') or cx.get('chr') or '').strip()
        strand = int(parsed_data.get('transcript_strand') or 1)
        e_start = int(cx.get('start') or 0)
        e_end = int(cx.get('end') or 0)
    except (TypeError, ValueError):
        return None, None
    need = 2 + int(win or 0)
    if not chrom or e_start <= 0 or e_end <= 0 or need <= 2 or http_session is None:
        return None, None
    try:
        if strand == -1:
            lo, hi = e_end + 1, e_end + need
        else:
            lo, hi = e_start - need, e_start - 1
        if lo < 1 or hi < lo:
            return None, None
        url = f'https://rest.ensembl.org/sequence/region/human/{chrom}:{lo}..{hi}:1?content-type=text/plain'
        r = http_session.get(url, timeout=60)
        if getattr(r, 'status_code', 0) != 200:
            return None, None
        raw = (getattr(r, 'text', None) or '').strip().replace('\n', '').upper()
        if len(raw) < need:
            return None, None
        seq = _dna_revcomp(raw) if strand == -1 else raw
        # seq (transcript orientation) = [intron far … intron near][A][G]
        return seq[need - 2:need], seq[:need - 2]
    except Exception as exc:
        print(f"[junction-align] acceptor intron flank fetch failed: {exc}")
        return None, None


def _junction_align_apply_donor_deletion(mut_bases, mut_spans, ref_spans, c_dot, anchor_c):
    """Remove deleted bases on the donor-side pre-mRNA track (c.N…c.N+M del spans).

    Handles exon-through-intron ranges (``c.2256_2256+4del``) and intronic-only
    ranges (``c.2256+1_2256+4del`` / ``c.2256+1_+4del``). Returns
    ``(applied, splice_loss_index)`` for repositioning the donor-loss marker.
    """
    c_low = re.sub(r'\s+', '', (c_dot or '').lower())
    if not c_low.endswith('del'):
        return False, None
    start_hgvs = end_hgvs = None
    m_ex = re.search(r'c\.(\d+)_(?:\1\+|\+)(\d+)del$', c_low)
    if m_ex:
        anc = int(m_ex.group(1))
        off_hi = int(m_ex.group(2))
        start_hgvs = f'c.{anc}'
        end_hgvs = f'c.{anc}+{off_hi}'
    else:
        m_in = re.search(r'c\.(\d+)\+(\d+)_(?:\d+\+)?\+(\d+)del$', c_low)
        if m_in:
            anc = int(m_in.group(1))
            off_lo = int(m_in.group(2))
            off_hi = int(m_in.group(3))
            start_hgvs = f'c.{anc}+{off_lo}'
            end_hgvs = f'c.{anc}+{off_hi}'
    if not start_hgvs:
        return False, None
    i0 = _junction_align_bases_hgvs_index(mut_bases, start_hgvs)
    i1 = _junction_align_bases_hgvs_index(mut_bases, end_hgvs)
    if i0 < 0 or i1 < i0:
        return False, None
    n_del = i1 - i0 + 1
    label = f'{n_del} nt deleted ({start_hgvs}…{end_hgvs})'
    if ref_spans is not None:
        ref_spans.append({'start': i0, 'end': i1 + 1, 'kind': 'variant', 'label': label})
    mut_spans.append({'start': i0, 'end': i1 + 1, 'kind': 'variant', 'label': label})
    gt_idx = _junction_align_bases_hgvs_index(mut_bases, f'c.{anchor_c}+1')
    loss_idx = gt_idx if gt_idx >= 0 else i0
    del mut_bases[i0:i1 + 1]
    if loss_idx > i0:
        loss_idx = i0
    return True, loss_idx


def _junction_align_apply_insertion(mut_bases, mut_spans, c_low):
    """Insert inserted base(s) into the mutant track for a c.A_B insSEQ variant
    and underline them, so the mutation is visible (not just deletions).

    Works for both donor (c.N+a_N+b) and acceptor (c.N−a_N−b) flanks by looking
    up the flanking c. labels in ``mut_bases``. Returns True if applied.
    """
    m_ins = re.search(r'c\.([\d+\-*]+)_([\d+\-*]+)ins([acgtn]+)', c_low)
    if not m_ins:
        return False
    p1, p2, ins = m_ins.group(1), m_ins.group(2), m_ins.group(3).upper()
    i1 = _junction_align_bases_hgvs_index(mut_bases, f'c.{p1}')
    i2 = _junction_align_bases_hgvs_index(mut_bases, f'c.{p2}')
    cands = [x for x in (i1, i2) if x >= 0]
    if not cands:
        return False
    at = min(cands) + 1  # insert just 3′ of the 5′-most flank
    new = [{'nt': nt, 'kind': 'variant', 'hgvs': f'c.{p1}_{p2}ins{ins}'} for nt in ins]
    mut_bases[at:at] = new
    mut_spans.append({
        'start': at, 'end': at + len(new), 'kind': 'variant',
        'label': f'{len(ins)} nt insertion ({ins})',
    })
    return True


def _junction_align_apply_dup(mut_bases, mut_spans, c_dot, parsed_data=None, *, is_donor=True, ref_spans=None):
    """Tandem dup on pre-mRNA track: c.N±kdup / c.N±a_±bdup (canonical junction).

    Inserts a copy 3′ of the duplicated source span; optional ``ref_spans`` gets
    the source underline on the reference row. Returns True if applied.
    """
    cj = _canonical_splice_junction_from_hgvs(c_dot or '')
    if not cj or cj.get('kind') != 'dup':
        return False
    if is_donor and cj.get('site') != 'donor':
        return False
    if not is_donor and cj.get('site') != 'acceptor':
        return False

    anchor = int(cj['anchor'])
    off_end = int(cj.get('offset_end') or cj.get('offset') or 0)
    off_lo = min(int(cj['offset']), off_end)
    off_hi = max(int(cj['offset']), off_end)

    if is_donor:
        start_hgvs = f'c.{anchor}+{off_lo}'
        end_hgvs = f'c.{anchor}+{off_hi}'
    else:
        start_hgvs = f'c.{anchor}-{off_hi}'
        end_hgvs = f'c.{anchor}-{off_lo}'

    dup_start = _junction_align_bases_hgvs_index(mut_bases, start_hgvs)
    dup_end = _junction_align_bases_hgvs_index(mut_bases, end_hgvs)
    if dup_start < 0 or dup_end < 0:
        return False
    dup_end += 1

    ref_slice = mut_bases[dup_start:dup_end]
    dup_seq = ''
    if parsed_data:
        ref = str(parsed_data.get('ref') or '').upper()
        alt = str(parsed_data.get('alt') or '').upper()
        if ref and alt and len(alt) > len(ref) and alt.startswith(ref):
            dup_seq = alt[len(ref):]
    if not dup_seq:
        dup_seq = ''.join(str(b.get('nt') or '').upper() for b in ref_slice)
    if not dup_seq:
        return False

    ins_bases = _junction_align_bases_from_dup_seq(dup_seq, ref_slice)
    ins_at = dup_end
    mut_bases[ins_at:ins_at] = ins_bases
    mut_spans.append({
        'start': ins_at,
        'end': ins_at + len(ins_bases),
        'kind': 'dup',
        'label': f'{len(ins_bases)} nt dup insert',
    })
    if ref_spans is not None:
        ref_spans.append({
            'start': dup_start,
            'end': dup_end,
            'kind': 'dup',
            'label': f'dup source ({dup_end - dup_start} nt)',
        })
    return True


def _junction_align_apply_substitution(mut_bases, mut_spans, c_low, parsed_data=None):
    """Apply a single-base SNV to the mutant track (e.g. c.4755+1G>A → show A not G)."""
    m = re.search(r'c\.(\d+)(\+(\d+)|-(\d+))([acgtn])>([acgtn])', c_low)
    if not m:
        return False
    anchor = m.group(1)
    if m.group(3) is not None:
        hgvs = f'c.{anchor}+{m.group(3)}'
    else:
        hgvs = f'c.{anchor}-{m.group(4)}'
    ref, alt = m.group(5).upper(), m.group(6).upper()
    i = _junction_align_bases_hgvs_index(mut_bases, hgvs)
    if i < 0:
        return False
    if mut_bases[i].get('nt', '').upper() not in ('', ref):
        # Allow applying alt even if fetched intron base differs from HGVS ref.
        pass
    mut_bases[i]['nt'] = alt
    mut_bases[i]['kind'] = 'variant'
    mut_spans.append({
        'start': i, 'end': i + 1, 'kind': 'variant',
        'label': f'{ref}>{alt}',
    })
    return True


def _strip_html_for_plain_note(text):
    """Plain text for junction-map notes (no HTML entities or tags)."""
    import re
    s = str(text or '')
    s = re.sub(r'<[^>]+>', '', s)
    for ent, ch in (
        ('&rarr;', '→'), ('&ndash;', '–'), ('&ge;', '≥'), ('&le;', '≤'),
        ('&lt;', '<'), ('&gt;', '>'), ('&amp;', '&'), ('&nbsp;', ' '),
    ):
        s = s.replace(ent, ch)
    return ' '.join(s.split())


def _junction_ref_idx_to_mut_idx(transcript_seq, mut_seq, ref_idx, var_idx_t):
    """
    Map a reference-transcript index to mut_seq after an upstream indel.

    Used for cryptic splice retained-body slices so reference junction
    coordinates are not applied directly to mut_seq (e.g. intronic del
    shortening retention on acceptor or donor gain alleles).
    """
    try:
        ri = int(ref_idx)
        var_i = int(var_idx_t) if var_idx_t is not None else None
    except (TypeError, ValueError):
        return int(ref_idx or 0)
    ref_len = len(transcript_seq or '')
    mut_len = len(mut_seq or '')
    delta = ref_len - mut_len
    if delta == 0 or var_i is None:
        return ri
    if delta > 0:
        if ri < var_i:
            return ri
        if ri < var_i + delta:
            return var_i
        return ri - delta
    ins_len = abs(delta)
    if ri <= var_i:
        return ri
    return ri + ins_len


def _junction_exon_start_mut_idx(transcript_seq, mut_seq, junction_t_idx, var_idx_t):
    """Canonical exon-start index in mut_seq."""
    return _junction_ref_idx_to_mut_idx(
        transcript_seq, mut_seq, junction_t_idx, var_idx_t,
    )


def _junction_donor_cds_prefix_end(cx_end_cds, junction_t_idx, var_idx_t, transcript_seq, mut_seq):
    """Exclusive CDS index for exon prefix before donor-side cryptic retention.

    When a junction-spanning del removes the last exon base (e.g. c.2256_2256+4del),
    the mature gain product must not include that base.
    """
    try:
        cx_end = int(cx_end_cds)
        junc = int(junction_t_idx)
        vi = int(var_idx_t) if var_idx_t is not None else None
    except (TypeError, ValueError):
        return int(cx_end_cds or 0)
    if cx_end <= 0:
        return 0
    del_len = len(transcript_seq or '') - len(mut_seq or '')
    if del_len <= 0 or vi is None or vi > junc:
        return cx_end
    exon_bases_deleted = min(junc - vi + 1, del_len)
    return max(0, cx_end - exon_bases_deleted)


def _junction_align_hgvs_deletion_span(c_dot, anchor_c):
    """Return (off_lo, off_hi, del_len) for c.N-offLo_offHi del or None."""
    c_low = (c_dot or '').lower()
    m = re.search(r'c\.\d+-(\d+)_(?:\d+)?-(\d+)del', c_low)
    if not m:
        return None
    try:
        off_lo = int(m.group(1))
        off_hi = int(m.group(2))
    except (TypeError, ValueError):
        return None
    if off_lo <= 0 or off_hi < 0:
        return None
    return off_lo, off_hi, abs(off_lo - off_hi) + 1


def _junction_align_mut_nt_at_ref_idx(ref_idx, transcript_seq, mut_seq, del_start, del_len):
    """Map a reference-transcript index to the mutant base (None = deleted)."""
    if del_len > 0 and del_start <= ref_idx < del_start + del_len:
        return None
    if del_len > 0 and ref_idx >= del_start + del_len:
        mi = ref_idx - del_len
    else:
        mi = ref_idx
    if 0 <= mi < len(mut_seq):
        return mut_seq[mi]
    return 'N'


def _junction_align_build_aligned_intron(
    transcript_seq, mut_seq, start, end, var_idx_t, del_len,
):
    """Build intron slice [start:end) in reference coordinates; None = deleted base."""
    out = []
    for ti in range(start, end):
        nt = _junction_align_mut_nt_at_ref_idx(ti, transcript_seq, mut_seq, var_idx_t, del_len)
        out.append(nt)
    return out


def _pack_junction_cryptic_align_ctx(
    *,
    cx,
    cds_seq,
    layout,
    transcript_seq,
    mut_seq,
    junction_t_idx,
    var_idx_t,
    cryptic_site_pos=-1,
    inserted_cdna='',
    dup_ins=None,
    win=36,
    parsed_data=None,
):
    """Pack reference/mutant/product slices for canonical-junction cryptic splice variants."""
    cds = (cds_seq or '').upper()
    transcript_seq = str(transcript_seq or '').upper()
    mut_seq = str(mut_seq or '').upper()
    inserted_cdna = str(inserted_cdna or '').upper()
    dup_ins = str(dup_ins or '').upper() or None
    if not transcript_seq or not cx or not cds:
        return None
    try:
        dn_rank = int(cx.get('anatomical_rank') or 0)
    except (TypeError, ValueError):
        dn_rank = 0

    if layout == 'acceptor_junction':
        try:
            anchor_c = int(cx.get('start_cds') or 0)
        except (TypeError, ValueError):
            anchor_c = 0
        if anchor_c <= 0:
            return None
        canon_ag = max(0, int(junction_t_idx) - 2)
        ref_intron_start = max(0, canon_ag - win)
        intron_pre_ref = transcript_seq[ref_intron_start:canon_ag]
        ag_ref = transcript_seq[canon_ag:canon_ag + 2]
        exon_head = cds[anchor_c - 1:anchor_c - 1 + 14]
        ref_bases = _junction_align_flat_bases(intron_pre_ref, ag_ref, exon_head, anchor_c)

        c_dot = (parsed_data or {}).get('c_dot') or ''
        seq_del_len = max(0, len(transcript_seq) - len(mut_seq))
        del_span = _junction_align_hgvs_deletion_span(c_dot, anchor_c)
        hgvs_del_len = del_span[2] if del_span else 0
        if del_span:
            _off_lo, _off_hi, _hgvs_len = del_span
            del_len = seq_del_len if seq_del_len > 0 else _hgvs_len
        else:
            del_len = seq_del_len

        # Always keep ref/mut pre-mRNA on the same coordinate window; apply indels
        # in reference space so a 4 bp deletion is visible (not a shifted window).
        intron_start = ref_intron_start
        ag_mut = canon_ag
        intron_nts = _junction_align_build_aligned_intron(
            transcript_seq, mut_seq, ref_intron_start, canon_ag, var_idx_t, del_len,
        )
        intron_pre_mut = ''.join('·' if nt is None else nt for nt in intron_nts)
        ag_mut_canon = ''.join(
            _junction_align_mut_nt_at_ref_idx(canon_ag + i, transcript_seq, mut_seq, var_idx_t, del_len) or 'N'
            for i in range(2)
        )
        exon_from_tx = (
            del_len > 0
            and var_idx_t + del_len <= junction_t_idx
            and junction_t_idx + 14 <= len(transcript_seq)
        )
        exon_head_mut = (
            transcript_seq[junction_t_idx:junction_t_idx + 14]
            if exon_from_tx else exon_head
        )
        mut_bases = _junction_align_flat_bases(intron_pre_mut, ag_mut_canon, exon_head_mut, anchor_c)
        for i, b in enumerate(mut_bases):
            if (b or {}).get('nt') == '·':
                b['nt'] = '·'
                b['kind'] = 'deleted'

        ref_spans = []
        if del_len > 0 and var_idx_t >= 0:
            ds = var_idx_t - ref_intron_start
            de = ds + del_len
            if 0 <= ds < len(intron_pre_ref):
                de = min(de, len(intron_pre_ref))
                if del_span:
                    lbl = f'{del_span[2]} nt deleted (c.{anchor_c}-{del_span[0]}_{anchor_c}-{del_span[1]})'
                else:
                    lbl = f'{de - ds} nt deleted'
                ref_spans.append({'start': ds, 'end': de, 'kind': 'variant', 'label': lbl})
        elif 0 <= var_idx_t < len(transcript_seq):
            vri = var_idx_t - ref_intron_start
            if 0 <= vri < len(intron_pre_ref):
                wt_nt = transcript_seq[var_idx_t:var_idx_t + 1] or '?'
                ref_spans.append({
                    'start': vri,
                    'end': vri + 1,
                    'kind': 'variant',
                    'label': f'WT {wt_nt}',
                })

        mut_spans = []
        if del_len > 0 and var_idx_t >= 0:
            ds = var_idx_t - ref_intron_start
            de = ds + del_len
            if 0 <= ds < len(intron_pre_mut):
                de = min(de, len(intron_pre_mut))
                if del_span:
                    lbl = f'{del_span[2]} nt deleted (c.{anchor_c}-{del_span[0]}_{anchor_c}-{del_span[1]})'
                else:
                    lbl = f'{de - ds} nt deleted'
                mut_spans.append({'start': ds, 'end': de, 'kind': 'variant', 'label': lbl})
        elif dup_ins:
            di = intron_pre_mut.find(dup_ins.replace('·', ''))
            if di < 0:
                dup_pos = mut_seq.find(dup_ins)
                if dup_pos >= 0:
                    di = dup_pos - ref_intron_start
            if 0 <= di:
                mut_spans.append({
                    'start': di,
                    'end': min(len(intron_pre_mut), di + len(dup_ins)),
                    'kind': 'dup',
                    'label': f'{len(dup_ins)} nt dup',
                })
        elif 0 <= var_idx_t < len(mut_seq) and not del_len:
            vi = var_idx_t - ref_intron_start
            if 0 <= vi < len(intron_pre_mut):
                mut_nt = mut_seq[var_idx_t:var_idx_t + 1] or '?'
                mut_spans.append({
                    'start': vi,
                    'end': vi + 1,
                    'kind': 'variant',
                    'label': f'variant {mut_nt}',
                })

        canon_ag_idx = len(intron_pre_mut)
        mut_markers = []
        canon_ag_lost = (ag_mut_canon or '').upper() != (ag_ref or '').upper()
        if cryptic_site_pos >= 0 and cryptic_site_pos < canon_ag:
            ci = cryptic_site_pos - ref_intron_start
            ci = _junction_align_snap_cryptic_gain_index(
                mut_bases, ci, is_donor=False, slack=12,
                max_idx=canon_ag_idx - 1 if canon_ag_idx > 0 else None,
                inserted_cdna=inserted_cdna,
            )
            if 0 <= ci < len(intron_pre_mut) and ci != canon_ag_idx:
                mut_markers.append({'index': ci, 'kind': 'splice_gain', 'label': 'cryptic AG used'})
                mut_markers.append({'index': canon_ag_idx, 'kind': 'splice_loss', 'label': 'canonical AG lost'})
                mut_bases = _junction_align_mark_intronic_splice_dinucs(
                    mut_bases, is_donor=False, primary_gain_idx=ci,
                    intron_start=0, intron_end=canon_ag_idx + 1,
                    layout='acceptor_junction',
                )
            else:
                mut_markers.append({'index': canon_ag_idx, 'kind': 'splice_ag', 'label': 'canonical AG'})
        elif canon_ag_lost:
            mut_markers.append({'index': canon_ag_idx, 'kind': 'splice_loss', 'label': 'canonical AG lost'})
        else:
            mut_markers.append({'index': canon_ag_idx, 'kind': 'splice_ag', 'label': 'canonical AG'})
        mut_markers.append({
            'index': canon_ag_idx + 2,
            'kind': 'exon_start',
            'label': f'exon {dn_rank}',
        })

        product_bases = None
        product_spans = []
        if inserted_cdna:
            product_bases, _ = _junction_align_cryptic_acceptor_product_bases(
                inserted_cdna, cds, anchor_c,
            )
        elif cryptic_site_pos >= 0 and cryptic_site_pos + 2 > int(junction_t_idx):
            deleted = cryptic_site_pos + 2 - int(junction_t_idx)
            prod_head = exon_head[deleted:] if deleted < len(exon_head) else ''
            if prod_head:
                product_bases = []
                for i, nt in enumerate(prod_head):
                    product_bases.append({
                        'nt': nt,
                        'kind': 'exon',
                        'hgvs': f'c.{anchor_c + deleted + i}',
                    })
                product_spans = [{
                    'start': 0,
                    'end': len(prod_head),
                    'kind': 'exon',
                    'label': f"E{dn_rank} 5′ — {deleted} nt excised (cryptic acceptor)",
                }]
        return {
            'layout': layout,
            'anchor_c': anchor_c,
            'exon_rank': dn_rank,
            'upstream_exon': max(0, dn_rank - 1),
            'ref_bases': ref_bases,
            'ref_spans': ref_spans,
            'mut_bases': mut_bases,
            'mut_spans': mut_spans,
            'mut_markers': mut_markers,
            'dup_seq': dup_ins,
            'product_bases': product_bases,
            'product_spans': product_spans or None,
            'product_title': 'Cryptic acceptor gain — mature mRNA',
            'mut_title': 'Mutant pre-mRNA (cryptic splice)',
        }

    if layout == 'donor_junction':
        try:
            anchor_c = int(cx.get('end_cds') or 0)
        except (TypeError, ValueError):
            anchor_c = 0
        if anchor_c <= 0:
            return None
        canon_gt = int(junction_t_idx) + 1
        exon_tail = cds[max(0, anchor_c - 14):anchor_c]
        gt_ref = transcript_seq[canon_gt:canon_gt + 2] if canon_gt + 2 <= len(transcript_seq) else 'GT'
        intron_head = transcript_seq[canon_gt + 2:canon_gt + 2 + win]
        ref_bases = _junction_align_flat_bases_donor(exon_tail, gt_ref, intron_head, anchor_c)

        gt_mut = canon_gt
        if cryptic_site_pos >= 0:
            gt_mut = _snap_cryptic_site_in_seq(
                mut_seq, cryptic_site_pos, is_donor=True, slack=12,
                min_pos=canon_gt + 1,
            )
            if gt_mut < 0:
                gt_mut = cryptic_site_pos
        elif 0 <= canon_gt < len(mut_seq) and mut_seq[canon_gt:canon_gt + 2] != gt_ref:
            gt_mut = mut_seq.find('GT', max(0, canon_gt - 30), min(len(mut_seq), canon_gt + 30))
            if gt_mut < 0:
                gt_mut = canon_gt
        tail_start_ref = max(0, int(junction_t_idx) - 14)
        tail_start_mut = _junction_ref_idx_to_mut_idx(
            transcript_seq, mut_seq, tail_start_ref, var_idx_t,
        )
        junc_mut = _junction_ref_idx_to_mut_idx(
            transcript_seq, mut_seq, junction_t_idx, var_idx_t,
        )
        prefix_end_cds = _junction_donor_cds_prefix_end(
            anchor_c, junction_t_idx, var_idx_t, transcript_seq, mut_seq,
        )
        exon_end_mut = junc_mut - 1 if prefix_end_cds < anchor_c else junc_mut
        exon_tail_mut = mut_seq[tail_start_mut:exon_end_mut + 1]
        gt_mut_seq = mut_seq[gt_mut:gt_mut + 2] if gt_mut + 2 <= len(mut_seq) else 'GT'
        intron_mut = mut_seq[gt_mut + 2:gt_mut + 2 + win]
        mut_bases = []
        for i, nt in enumerate(exon_tail_mut):
            pos = prefix_end_cds - len(exon_tail_mut) + i + 1
            mut_bases.append({'nt': nt, 'kind': 'exon', 'hgvs': f'c.{pos}' if pos > 0 else ''})
        for i, nt in enumerate(gt_mut_seq):
            mut_bases.append({'nt': nt, 'kind': 'splice_gt', 'hgvs': f'c.{anchor_c}+{1 + i}'})
        for i, nt in enumerate(intron_mut):
            mut_bases.append({'nt': nt, 'kind': 'intron', 'hgvs': f'c.{anchor_c}+{3 + i}'})
        if inserted_cdna and not dup_ins:
            ext = inserted_cdna
            product_bases = []
            for b in mut_bases:
                k = b.get('kind') or ''
                if k == 'exon':
                    product_bases.append(dict(b))
                else:
                    break
            for i, nt in enumerate(ext):
                product_bases.append({
                    'nt': nt,
                    'kind': 'exon_extension',
                    'hgvs': f'c.{prefix_end_cds}+{1 + i}',
                })
        else:
            product_bases = None
        mut_spans = []
        if dup_ins and dup_ins in mut_seq:
            di = mut_seq.find(dup_ins) - tail_start_mut
            if di >= 0:
                mut_spans.append({
                    'start': di, 'end': di + len(dup_ins), 'kind': 'dup', 'label': f'{len(dup_ins)} nt dup',
                })
        elif 0 <= var_idx_t < len(mut_seq):
            vi = var_idx_t - tail_start_mut
            if 0 <= vi < len(mut_bases):
                mut_spans.append({'start': vi, 'end': vi + 1, 'kind': 'variant', 'label': 'variant'})
        _gt_is_cryptic = gt_mut != canon_gt
        canon_gt_idx = len(exon_tail_mut)
        mut_markers = [
            {
                'index': canon_gt_idx,
                'kind': 'splice_loss',
                'label': 'canonical GT lost (donor loss)',
            },
        ]
        if _gt_is_cryptic:
            cryptic_idx = canon_gt_idx + (gt_mut - canon_gt)
            cryptic_idx = _junction_align_snap_cryptic_gain_index(
                mut_bases, cryptic_idx, is_donor=True, slack=12,
                min_idx=canon_gt_idx + 1,
                inserted_cdna=inserted_cdna,
            )
            if 0 <= cryptic_idx < len(mut_bases):
                mut_markers.append({
                    'index': cryptic_idx,
                    'kind': 'splice_gain',
                    'label': 'cryptic GT gained',
                })
                mut_bases = _junction_align_mark_intronic_splice_dinucs(
                    mut_bases, is_donor=True, primary_gain_idx=cryptic_idx,
                    intron_start=canon_gt_idx, intron_end=len(mut_bases) - 1,
                    layout='donor_junction',
                )
        return {
            'layout': layout,
            'anchor_c': anchor_c,
            'exon_rank': dn_rank,
            'upstream_exon': dn_rank,
            'ref_bases': ref_bases,
            'mut_bases': mut_bases,
            'mut_spans': mut_spans,
            'mut_markers': mut_markers,
            'dup_seq': dup_ins,
            'product_bases': product_bases,
            'product_title': 'Cryptic donor gain — mature mRNA',
            'mut_title': 'Mutant pre-mRNA (cryptic splice)',
        }
    return None


def _pack_exon_internal_junction_align_ctx(
    *, cds_seq, cx, new_site_cdna, cds_pos, ref, alt, use_donor, deleted_nt,
):
    """Exon-internal cryptic donor/acceptor gain — exon window with site + deletion."""
    cds = (cds_seq or '').upper()
    ref = str(ref or '').upper()
    alt = str(alt or '').upper()
    if not cds or not cx:
        return None
    try:
        ex_start = int(cx.get('start_cds') or 0)
        ex_end = int(cx.get('end_cds') or 0)
        ex_rank = int(cx.get('anatomical_rank') or 0)
        new_site = int(new_site_cdna)
        cds_pos = int(cds_pos)
        deleted_nt = int(deleted_nt)
    except (TypeError, ValueError):
        return None
    if ex_start <= 0 or ex_end < ex_start or deleted_nt <= 0:
        return None

    pad = 12
    lo = max(ex_start, new_site - pad)
    hi = min(ex_end, new_site + pad + 2)
    window = cds[lo - 1:hi]
    if not window:
        return None

    def _bases_from_window(seq, *, deleted_lo=None, deleted_hi=None, cryptic_idx=None, var_idx=None):
        bases = []
        for i, nt in enumerate(seq):
            pos = lo + i
            kind = 'exon'
            if deleted_lo is not None and deleted_hi is not None and deleted_lo <= pos <= deleted_hi:
                kind = 'exon_deleted'
            bases.append({'nt': nt, 'kind': kind, 'hgvs': f'c.{pos}'})
        spans = []
        if deleted_lo is not None and deleted_hi is not None:
            ds = deleted_lo - lo
            de = deleted_hi - lo + 1
            if ds >= 0 and de > ds:
                spans.append({
                    'start': ds, 'end': de, 'kind': 'exon_skip',
                    'label': f'{deleted_hi - deleted_lo + 1} nt excised',
                })
        markers = []
        if cryptic_idx is not None and 0 <= cryptic_idx < len(bases):
            lbl = 'cryptic GT gained' if use_donor else 'cryptic AG gained'
            markers.append({'index': cryptic_idx, 'kind': 'splice_gain', 'label': lbl})
        if var_idx is not None and 0 <= var_idx < len(bases):
            spans.append({'start': var_idx, 'end': var_idx + 1, 'kind': 'variant', 'label': 'variant'})
        return bases, spans, markers

    if use_donor:
        del_lo, del_hi = new_site + 1, ex_end
        cryptic_idx = new_site - lo
        var_idx = cds_pos - lo if ex_start <= cds_pos <= ex_end else None
    else:
        del_lo, del_hi = ex_start, new_site - 1
        cryptic_idx = new_site - 1 - lo
        var_idx = cds_pos - lo if ex_start <= cds_pos <= ex_end else None

    cryptic_idx = _snap_cryptic_site_in_seq(
        window.upper(), cryptic_idx, is_donor=use_donor, slack=10,
    )
    if cryptic_idx < 0:
        cryptic_idx = (new_site - lo) if use_donor else (new_site - 1 - lo)

    # Translate ref/alt into transcript orientation. parsed_data['ref'] / ['alt']
    # carry forward-genomic-strand alleles after _normalize_to_forward_strand,
    # but the CDS is in transcript orientation. For minus-strand genes (e.g.
    # NLRP3), the genomic G>T is transcript C>A and vice versa, so we need to
    # complement before substituting — otherwise the mutant strand keeps the WT
    # base and the variant is invisible on the map.
    _COMP = {'A': 'T', 'T': 'A', 'G': 'C', 'C': 'G', 'N': 'N'}
    tx_ref, tx_alt = ref, alt
    if (len(ref) == 1 and len(alt) == 1 and ex_start <= cds_pos <= ex_end
            and 0 < cds_pos <= len(cds)):
        txn_base = cds[cds_pos - 1]
        if ref and ref != txn_base and _COMP.get(ref, '') == txn_base:
            tx_ref = _COMP.get(ref, ref)
            tx_alt = _COMP.get(alt, alt)

    ref_bases, ref_spans, ref_markers = _bases_from_window(window)
    mut_seq = window
    sub_applied = False
    if (len(tx_ref) == 1 and len(tx_alt) == 1 and ex_start <= cds_pos <= ex_end
            and cds[cds_pos - 1] == tx_ref):
        mut_seq = window[:cds_pos - lo] + tx_alt + window[cds_pos - lo + 1:]
        sub_applied = True
    mut_bases, mut_spans, mut_markers = _bases_from_window(
        mut_seq, deleted_lo=del_lo, deleted_hi=del_hi, cryptic_idx=cryptic_idx, var_idx=var_idx,
    )
    # Replace the generic 'variant' span with one carrying the actual mutant
    # nucleotide so reviewers can see the substitution at a glance.
    if sub_applied and var_idx is not None and 0 <= var_idx < len(mut_bases):
        for sp in mut_spans:
            if sp.get('kind') == 'variant' and sp.get('start') == var_idx:
                sp['label'] = f'variant {tx_alt}'
                break
        if not any(sp.get('kind') == 'variant' for sp in mut_spans):
            mut_spans.append({
                'start': var_idx, 'end': var_idx + 1,
                'kind': 'variant', 'label': f'variant {tx_alt}',
            })
        # Also surface a WT-base marker on the reference track so ref vs mut
        # can be compared base-for-base, matching the acceptor-junction layout.
        if 0 <= var_idx < len(ref_bases):
            ref_spans.append({
                'start': var_idx, 'end': var_idx + 1,
                'kind': 'variant', 'label': f'WT {tx_ref}',
            })

    if cryptic_idx >= 0:
        mut_bases = _junction_align_mark_intronic_splice_dinucs(
            mut_bases, is_donor=use_donor, primary_gain_idx=cryptic_idx,
            layout='exon_internal',
        )

    product_bases = []
    if use_donor:
        product_bases = [b for b in mut_bases if b.get('kind') != 'exon_deleted']
    else:
        for b in mut_bases:
            if b.get('kind') == 'exon_deleted':
                continue
            product_bases.append(b)

    return {
        'layout': 'exon_internal',
        'anchor_c': ex_start,
        'exon_rank': ex_rank,
        'upstream_exon': ex_rank,
        'ref_bases': ref_bases,
        'mut_bases': mut_bases,
        'mut_spans': mut_spans,
        'mut_markers': mut_markers,
        'ref_spans': ref_spans,
        'ref_markers': ref_markers,
        'product_bases': product_bases or None,
        'product_title': f'Exon-internal cryptic {"donor" if use_donor else "acceptor"} gain — mature mRNA',
        'mut_title': 'Mutant exon (cryptic splice site)',
    }


def _junction_align_attach_cryptic_ctx(
    co,
    *,
    parsed_data,
    cx,
    cds_seq,
    layout,
    transcript_seq,
    mut_seq,
    junction_t_idx,
    var_idx_t,
    cryptic_site_pos=-1,
    inserted_cdna='',
    dup_ins=None,
):
    if not isinstance(co, dict) or co.get('minimal_signal'):
        return co
    try:
        ctx = _pack_junction_cryptic_align_ctx(
            cx=cx,
            cds_seq=cds_seq,
            layout=layout,
            transcript_seq=transcript_seq,
            mut_seq=mut_seq,
            junction_t_idx=junction_t_idx,
            var_idx_t=var_idx_t,
            cryptic_site_pos=cryptic_site_pos,
            inserted_cdna=inserted_cdna or co.get('inserted_cdna') or '',
            dup_ins=dup_ins,
            parsed_data=parsed_data,
        )
        if ctx:
            co['junction_align_ctx'] = ctx
            parsed_data['junction_align_viz_ctx'] = ctx
    except Exception as _jctx_err:
        print(f'junction_align_ctx attach: {_jctx_err}')
    return _annotate_junction_extension_fields(co)


def _junction_align_product_from_co(co, *, title, note='', bases=None, span_label='',
                                      track_origin_cds_0based=None, extra_markers=None):
    if not bases:
        return None
    pre_atg = bool((co or {}).get('pre_atg_utr_pseudoexon'))
    ptc_m = None if pre_atg else _junction_align_ptc_marker(
        bases, co, track_origin_cds_0based=track_origin_cds_0based,
    )
    markers = list(extra_markers or [])
    ptc_span = None
    ptc_note = ''
    if ptc_m:
        if ptc_m.get('off_window'):
            ptc_note = ptc_m.get('note') or f"PTC: {ptc_m.get('label', '')}"
        else:
            ptc_span = {
                'start': int(ptc_m['start']),
                'end': int(ptc_m['end']),
                'kind': 'ptc',
                'label': (ptc_m.get('label') or '') + (
                    f" ({ptc_m.get('codon')})" if ptc_m.get('codon') else ''
                ),
            }
    ins = str((co or {}).get('inserted_cdna') or '')
    ext_len = _junction_align_pseudoexon_len(bases) or len(ins)
    spans = []
    if ext_len > 0:
        span_kind = 'utr_extension' if pre_atg else 'exon_extension'
        spans.append({
            'start': 0,
            'end': ext_len,
            'kind': span_kind,
            'label': span_label or (f'+{ext_len} nt 5\u2032 UTR' if pre_atg else f'+{ext_len} nt'),
        })
    if ptc_span:
        spans.append(ptc_span)
    full_note = note or (co.get('cryptic_type') or '')
    if pre_atg and not full_note:
        full_note = (
            f'{ext_len} nt 5\u2032 UTR pseudo-exon (pre-AUG); annotated protein ORF unchanged. '
            f'Possible mRNA effects: UTR length/structure, uORFs, translation initiation.'
        )
    if ptc_note:
        full_note = (full_note + ' ' + ptc_note).strip()
    if pre_atg and ext_len > 0 and not any(m.get('kind') == 'start_codon' for m in markers):
        for i, b in enumerate(bases):
            if (b or {}).get('kind') == 'exon' and i + 2 < len(bases):
                tri = ''.join((bases[j] or {}).get('nt', '') for j in range(i, i + 3)).upper()
                if tri == 'ATG':
                    markers.append({'index': i, 'kind': 'start_codon', 'label': 'AUG / Met (original)'})
                    break
    return {
        'id': 'cryptic_product',
        'title': title,
        'kind': 'mature',
        'summary': (
            '5\u2032 UTR insert — ORF unchanged'
            if pre_atg
            else (co.get('fs_ter_str') or co.get('hgvs_p') or '').strip()
        ),
        'note': full_note,
        'bases': bases,
        'spans': spans,
        'markers': markers,
    }


def _junction_align_product_note_plain(co):
    """Short plain-text note for mature product track (no HTML)."""
    if not co or co.get('minimal_signal'):
        return ''
    shift = co.get('shift_nt')
    ins = str(co.get('inserted_cdna') or '')
    fs = (co.get('fs_ter_str') or '').strip()
    if ins and shift is not None:
        try:
            sh = int(shift)
            frame = 'in-frame' if sh % 3 == 0 else 'out-of-frame'
            return (
                f"Gain math: {len(ins)} bp retained at new splice ({frame})"
                + (f"; {fs}" if fs else '')
            )
        except (TypeError, ValueError):
            pass
    if fs:
        return fs
    return _strip_html_for_plain_note((co.get('narrative') or '')[:220])


def _junction_align_payload_from_ctx(parsed_data, ctx, outcome_co, *, extra_products=None):
    """Build full junction_align_viz payload from a pre-packed context dict."""
    c_dot = (parsed_data.get('c_dot') or '').strip()
    gene = (parsed_data.get('gene_symbol') or parsed_data.get('gene') or '').strip()
    anchor_c = ctx.get('anchor_c')
    dn_rank = ctx.get('exon_rank')
    up_rank = ctx.get('upstream_exon') or max(0, (dn_rank or 0) - 1)
    ref_bases = ctx.get('ref_bases') or []
    mut_bases = ctx.get('mut_bases') or []
    layout = ctx.get('layout') or 'acceptor_junction'

    mut_bases = ctx.get('mut_bases') or []
    mut_markers = ctx.get('mut_markers') or []
    mut_bases, mut_markers = _junction_align_refresh_gain_markers(
        mut_bases, mut_markers,
        parsed_data=parsed_data, co=outcome_co, layout=layout,
    )

    if layout == 'acceptor_junction':
        ref_markers = [
            {'index': len([b for b in ref_bases if b.get('kind') == 'intron']),
             'kind': 'splice_ag', 'label': 'canonical AG'},
        ]
        intron_n = len([b for b in ref_bases if b.get('kind') in ('intron', 'splice_ag')])
        ref_markers.append({'index': intron_n + 2, 'kind': 'exon_start', 'label': f'exon {dn_rank}'})
    elif layout == 'donor_junction':
        ref_markers = [{'index': len([b for b in ref_bases if b.get('kind') == 'exon']),
                        'kind': 'splice_gt', 'label': 'canonical GT'}]
    else:
        ref_markers = ctx.get('ref_markers') or []

    tracks = [
        {
            'id': 'reference',
            'title': 'Reference' if layout == 'exon_internal' else 'Reference pre-mRNA',
            'kind': 'premrna' if layout != 'exon_internal' else 'exon',
            'bases': ref_bases,
            'spans': ctx.get('ref_spans') or [],
            'markers': ref_markers,
        },
        {
            'id': 'mutant',
            'title': ctx.get('mut_title') or 'Mutant allele',
            'kind': 'premrna' if layout != 'exon_internal' else 'exon',
            'bases': mut_bases,
            'spans': ctx.get('mut_spans') or [],
            'markers': ctx.get('mut_markers') or [],
            'dup_seq': ctx.get('dup_seq'),
        },
    ]

    prod_origin = ctx.get('product_track_origin_cds_0based')
    if prod_origin is None and ctx.get('product_bases'):
        prod_origin = _junction_align_track_origin_from_bases(ctx.get('product_bases'))
    prod = _junction_align_product_from_co(
        outcome_co or {},
        title=ctx.get('product_title') or 'Cryptic splice product',
        note=_junction_align_product_note_plain(outcome_co or {}),
        bases=ctx.get('product_bases'),
        span_label=(
            f"+{int((outcome_co or {}).get('shift_nt') or len((outcome_co or {}).get('inserted_cdna') or ''))} nt"
            if (outcome_co or {}).get('inserted_cdna') else ''
        ),
        track_origin_cds_0based=prod_origin,
    )
    if prod:
        if ctx.get('product_spans'):
            prod['spans'] = list(ctx.get('product_spans') or []) + list(prod.get('spans') or [])
        tracks.append(prod)
    for ep in extra_products or []:
        if ep:
            tracks.append(ep)

    ruler = _junction_align_ruler_ticks(ref_bases, every=10)
    return {
        'eligible': True,
        'title': f'{gene} {c_dot}'.strip(),
        'anchor_hgvs': f'c.{anchor_c}',
        'upstream_exon': up_rank,
        'downstream_exon': dn_rank,
        'tracks': tracks,
        'ruler': ruler,
        'legend': _junction_align_legend(tracks),
    }


def _junction_align_extra_deep_intronic_products(parsed_data, exon_head, anchor_c, dn_rank, tracks):
    """Append deep-intronic product tracks not yet present (donor gain, exon skip)."""
    extras = []
    existing = {t.get('id') for t in tracks}

    _donor_track_ids = {
        'deep_intronic_primary_outcome': 'donor_gain',
        'deep_intronic_alternate_outcome': 'donor_gain_alt',
        'deep_intronic_alternate2_outcome': 'donor_gain_alt2',
    }
    for key, label_default, kind_match in (
        ('deep_intronic_primary_outcome', 'Product — donor gain (splice)', 'donor'),
        ('deep_intronic_alternate_outcome', 'Product 2 — donor gain (splice)', 'donor'),
        ('deep_intronic_alternate2_outcome', 'Product 3 — donor gain (splice)', 'donor'),
    ):
        co = parsed_data.get(key) or {}
        ins = str(co.get('inserted_cdna') or '').upper()
        ctype = str(co.get('cryptic_type') or '')
        track_id = _donor_track_ids.get(key, 'donor_gain')
        if not ins or kind_match not in ctype.lower() or track_id in existing:
            continue
        pre_atg = bool(co.get('pre_atg_utr_pseudoexon'))
        if pre_atg:
            cds = (parsed_data.get('cds_seq') or '').upper()
            try:
                first_cx = _deep_intronic_first_coding_exon(parsed_data.get('coding_exons') or [])
                cds_start = int(first_cx.get('start_cds') or anchor_c)
                anchor_c_utr = cds_start - 1
            except (TypeError, ValueError):
                cds_start, anchor_c_utr = anchor_c, max(0, anchor_c - 1)
            p_bases, prod_markers, p_spans_pre = _junction_align_pre_atg_product_bases(
                ins, cds, cds_start, anchor_c_utr,
                upstream_end_cds=anchor_c_utr,
                upstream_exon_rank=dn_rank - 1 if dn_rank else None,
                downstream_exon_rank=dn_rank,
            )
            dg_note = (
                f'{len(ins)} nt 5\u2032 UTR pseudo-exon (pre-AUG); original AUG/Met in exon {dn_rank} unchanged.'
            )
            dg_span = f'+{len(ins)} nt 5\u2032 UTR'
        else:
            prod_markers = []
            p_spans = []
            p_bases = _junction_align_flat_bases(ins, '', exon_head, anchor_c, ext_first=True, ext_len=len(ins))
            dg_note = f'{len(ins)} nt retained after cryptic donor GT.'
            dg_span = f'+{len(ins)} nt exon'
        ep = _junction_align_product_from_co(
            co, title=label_default,
            note=dg_note,
            bases=p_bases, span_label=dg_span,
            extra_markers=prod_markers if pre_atg else None,
        )
        if ep:
            ep['id'] = track_id
            if pre_atg:
                ep['spans'] = p_spans_pre
            else:
                ep['spans'] = p_spans
            extras.append(ep)
            existing.add(track_id)

    if 'exon_skip' not in existing:
        co_skip = parsed_data.get('deep_intronic_alternate2_outcome') or {}
        if not co_skip.get('exon_skip'):
            co_skip = parsed_data.get('deep_intronic_alternate_outcome') or {}
        if co_skip.get('exon_skip'):
            try:
                skip_rank = int(co_skip.get('skipped_exon_rank') or dn_rank)
            except (TypeError, ValueError):
                skip_rank = dn_rank
            extras.append({
                'id': 'exon_skip',
                'title': f'Product — exon {skip_rank} skipped',
                'kind': 'mature',
                'summary': (co_skip.get('fs_ter_str') or '').strip(),
                'note': f'Exon {skip_rank} not in mature mRNA.',
                'bases': [],
                'spans': [{'start': 0, 'end': 1, 'kind': 'exon_skip', 'label': f'exon {skip_rank} skipped'}],
                'markers': [],
            })
    return extras


def _junction_align_pre_atg_product_bases(
    ins, cds, dn_start, anchor_c_utr, *, exon_head_len=18,
    upstream_end_cds=None, upstream_exon_rank=None, upstream_tail_len=12,
    downstream_exon_rank=None,
):
    """Mature mRNA product: upstream UTR exon 3′ + 5′ UTR pseudo-exon + first coding exon (Met)."""
    p_bases = []
    ins = str(ins or '').upper()
    try:
        utr_anchor = int(anchor_c_utr)
        cds_start = int(dn_start)
    except (TypeError, ValueError):
        utr_anchor, cds_start = 28, 29
    for i, nt in enumerate(ins):
        p_bases.append({
            'nt': nt,
            'kind': 'utr_extension',
            'hgvs': f'c.{utr_anchor}+{1 + i}',
        })
    markers = []
    cds_u = str(cds or '').upper()
    head_len = min(exon_head_len, max(0, len(cds_u) - cds_start + 1))
    if cds_start > 0 and head_len >= 1:
        head = cds_u[cds_start - 1:cds_start - 1 + head_len]
        met_idx = len(p_bases)
        for i, nt in enumerate(head):
            p_bases.append({
                'nt': nt,
                'kind': 'exon',
                'hgvs': f'c.{cds_start + i}',
            })
        if head_len >= 3 and head[:3] == 'ATG':
            markers.append({'index': met_idx, 'kind': 'start_codon', 'label': 'AUG / Met (original)'})
    spans = [{
        'start': 0,
        'end': len(ins),
        'kind': 'utr_extension',
        'label': f'+{len(ins)} nt 5\u2032 UTR',
    }]
    if head_len >= 1:
        spans.append({
            'start': len(ins),
            'end': len(p_bases),
            'kind': 'exon',
            'label': (
                f'exon {downstream_exon_rank} 5\u2032 ({head_len} nt)'
                if downstream_exon_rank else f'exon 5\u2032 ({head_len} nt)'
            ),
        })
    up_end = upstream_end_cds if upstream_end_cds is not None else utr_anchor
    prefix = _junction_align_upstream_exon_tail_bases(cds, up_end, tail_len=upstream_tail_len)
    p_bases, spans, markers, _pfx = _junction_align_prepend_upstream_exon_context(
        p_bases, spans, markers,
        prefix_bases=prefix,
        upstream_exon_rank=upstream_exon_rank,
    )
    return p_bases, markers, spans


def _junction_align_deep_intronic_premrna_window(
    wt, mut, *, ag_pos, anchor_c, exon_head, c_dot, details, win=36,
):
    """
    Pre-mRNA reference/mutant tracks. Deep intronic variants (e.g. c.29-890) use a
    long horizontal scroll from variant locus → canonical AG → exon head.
    """
    wt = str(wt or '').upper()
    mut = str(mut or '').upper()
    ag_mut = mut.rfind('AG')
    if ag_mut < 0:
        ag_mut = ag_pos
    ag_ref = wt[ag_pos:ag_pos + 2] if ag_pos + 2 <= len(wt) else 'AG'
    ag_mut_seq = mut[ag_mut:ag_mut + 2] if ag_mut + 2 <= len(mut) else 'AG'
    minus_off = _deep_intronic_hgvs_minus_offset(c_dot)
    j_var = details.get('variant_intron_j_var_hgvs')
    if j_var is None:
        j_var = details.get('variant_intron_j_var')
    try:
        j_var_i = int(j_var) if j_var is not None else None
    except (TypeError, ValueError):
        j_var_i = None
    deep_map = minus_off is not None and minus_off > 80 and j_var_i is not None
    meta = {
        'deep_map': deep_map,
        'variant_base_index': None,
        'scroll_default': 'junction',
        'scroll_junction_at': 'end' if deep_map else '',
        'minus_offset': minus_off,
    }
    if deep_map:
        pad = 6
        intron_lo = max(0, j_var_i - pad)
        intron_pre_ref = wt[intron_lo:ag_pos]
        intron_pre_mut = mut[intron_lo:ag_mut]
        meta['variant_base_index'] = j_var_i - intron_lo
    else:
        intron_pre_ref = wt[max(0, ag_pos - win):ag_pos]
        intron_pre_mut = mut[max(0, ag_mut - win):ag_mut]
    ref_bases = _junction_align_flat_bases_acceptor(intron_pre_ref, ag_ref, exon_head, anchor_c)
    mut_bases = _junction_align_flat_bases_acceptor(intron_pre_mut, ag_mut_seq, exon_head, anchor_c)
    return ref_bases, mut_bases, meta


def _junction_align_deep_intronic_donor_premrna_window(
    wt, mut, *, gt_i, exon_tail, donor_end, hgvs_intron_anchor, c_dot, details, win=36,
):
    """
    Donor-side pre-mRNA tracks. Deep c.N+k variants (e.g. c.2250+6051) scroll from
    exon/GT junction (left) through intron to the variant locus (right).
    """
    wt = str(wt or '').upper()
    mut = str(mut or '').upper()
    exon_tail = str(exon_tail or '').upper()
    plus_off = _deep_intronic_hgvs_plus_offset(c_dot)
    j_var = details.get('variant_intron_j_var_hgvs')
    if j_var is None:
        j_var = details.get('variant_intron_j_var')
    try:
        j_var_i = int(j_var) if j_var is not None else None
    except (TypeError, ValueError):
        j_var_i = None
    try:
        gt_i = int(gt_i)
    except (TypeError, ValueError):
        gt_i = max(0, wt.find('GT'))
    deep_map = plus_off is not None and plus_off > 80 and j_var_i is not None and j_var_i >= 0
    meta = {
        'deep_map': deep_map,
        'variant_base_index': None,
        'scroll_default': 'junction',
        'scroll_junction_at': 'start' if deep_map else '',
        'plus_offset': plus_off,
    }
    gt_ref = wt[gt_i:gt_i + 2] if gt_i + 2 <= len(wt) else 'GT'
    gt_mut = mut[gt_i:gt_i + 2] if gt_i + 2 <= len(mut) else gt_ref
    if deep_map:
        intron_ref = wt[gt_i + 2:]
        intron_mut = mut[gt_i + 2:]
        try:
            meta['variant_base_index'] = len(exon_tail) + 2 + (j_var_i - (gt_i + 2))
        except (TypeError, ValueError):
            pass
    else:
        intron_ref = wt[gt_i + 2:gt_i + 2 + win]
        intron_mut = mut[gt_i + 2:gt_i + 2 + win]
    ref_bases = _junction_align_flat_bases_donor(
        exon_tail, gt_ref, intron_ref, donor_end,
        hgvs_intron_anchor=hgvs_intron_anchor,
    )
    mut_bases = [
        dict(b) for b in _junction_align_flat_bases_donor(
            exon_tail, gt_mut, intron_mut, donor_end,
            hgvs_intron_anchor=hgvs_intron_anchor,
        )
    ]
    return ref_bases, mut_bases, meta


def _junction_align_payload_deep_intronic(parsed_data):
    """
    Nucleotide-level junction alignment for splice UI popup (reference vs mutant vs products).
    Similar to an IGV-style junction view: intron tail, AG, exon head, dup highlight.
    """
    out = {'eligible': False, 'reason': ''}
    di = parsed_data.get('deep_intronic_splice') or {}
    details = di.get('details') or {}
    wt = (details.get('wt_intron_tx_seq') or '').upper()
    mut = (details.get('mut_intron_tx_seq') or wt).upper()
    dup = (details.get('dup_insert_seq') or '').upper()
    cds = (parsed_data.get('cds_seq') or '').upper()
    c_dot = (parsed_data.get('c_dot') or '').strip()
    c_low = c_dot.lower()
    gene = (parsed_data.get('gene_symbol') or parsed_data.get('gene') or '').strip()
    coding_exons = parsed_data.get('coding_exons') or []

    if not di.get('eligible') or not wt:
        out['reason'] = 'Junction sequence map needs deep-intronic intron sequence (SpliceAI gate).'
        return out
    if not cds or not coding_exons:
        out['reason'] = 'CDS / exon map unavailable for junction alignment.'
        return out

    cx_up = _deep_intronic_upstream_exon_for_acceptor_side(parsed_data, coding_exons, details)
    cx_dn = _deep_intronic_downstream_exon_for_acceptor_side(parsed_data, coding_exons, details)
    if not cx_dn:
        out['reason'] = 'Could not map acceptor-side junction exons.'
        return out

    try:
        up_end = int(cx_up.get('end_cds') or 0) if cx_up else 0
        dn_start = int(cx_dn.get('start_cds') or 1)
        dn_rank = int(cx_dn.get('anatomical_rank') or 0)
        up_rank = int(cx_up.get('anatomical_rank') or max(0, dn_rank - 1)) if cx_up else max(0, dn_rank - 1)
    except (TypeError, ValueError):
        out['reason'] = 'Exon coordinate error.'
        return out

    exon_tail = cds[max(0, up_end - 10):up_end] if up_end > 0 else ''
    dup_rng = _parse_dup_range_hgvs_acceptor(c_dot) if dup else None

    m_anchor = re.search(r'c\.(\d+)', c_dot, re.I)
    try:
        anchor_c = int(dup_rng['anchor_c']) if dup_rng else (int(m_anchor.group(1)) if m_anchor else int(dn_start))
    except (TypeError, ValueError):
        anchor_c = dn_start

    try:
        exon_through = int(dup_rng['exon_end_c']) if dup_rng else dn_start + 13
    except (TypeError, ValueError):
        exon_through = dn_start + 13
    exon_head = cds[dn_start - 1:exon_through] if dn_start > 0 else ''

    try:
        ag_pos = int(details.get('canonical_last_ag_0based'))
    except (TypeError, ValueError):
        ag_pos = wt.rfind('AG')
    if ag_pos < 0:
        ag_pos = max(0, len(wt) - 2)

    win = 36
    deep_intronic_map_meta = {}
    if dup_rng:
        try:
            win = max(win, int(dup_rng['intron_off_start']) + 6)
        except (TypeError, ValueError):
            pass
    intron_pre_ref = wt[max(0, ag_pos - win):ag_pos]
    ag_ref = wt[ag_pos:ag_pos + 2] if ag_pos + 2 <= len(wt) else 'AG'

    if dup and dup_rng:
        ref_pack, mut_pack = _junction_align_dup_premrna_pair(
            intron_pre_ref, ag_ref, exon_head, anchor_c, dup, dup_rng, dn_rank,
        )
        ref_bases = ref_pack['bases']
        tracks = [
            {
                'id': 'reference',
                'title': 'Reference pre-mRNA (dup source span underlined)',
                'kind': 'premrna',
                'bases': ref_bases,
                'spans': ref_pack['spans'],
                'markers': ref_pack['markers'],
            },
            {
                'id': 'mutant',
                'title': f'Mutant pre-mRNA ({len(dup)} nt tandem dup)',
                'kind': 'premrna',
                'bases': mut_pack['bases'],
                'spans': mut_pack['spans'],
                'markers': mut_pack['markers'],
                'dup_seq': dup,
                'note': (
                    f'Dup spans c.{anchor_c}-{dup_rng["intron_off_start"]} through c.{dup_rng["exon_end_c"]} '
                    f'({dup_rng["intron_off_start"]} nt intronic + '
                    f'{max(0, len(dup) - dup_rng["intron_off_start"])} nt exon {dn_rank}).'
                ),
            },
        ]
    else:
        plus_off = _deep_intronic_hgvs_plus_offset(c_dot)
        minus_off = _deep_intronic_hgvs_minus_offset(c_dot)
        use_donor_view = plus_off is not None and minus_off is None

        if use_donor_view:
            # c.N+k variants: show donor-side junction (GT + 5′ intron), not acceptor AG.
            try:
                hgvs_intron_anchor = int(re.search(r'c\.(\d+)', c_dot, re.I).group(1))
            except (AttributeError, TypeError, ValueError):
                hgvs_intron_anchor = int(cx_up.get('end_cds') or up_end or 0)
            cx_donor = None
            for x in coding_exons:
                try:
                    sc = int(x.get('start_cds') or 0)
                    ec = int(x.get('end_cds') or 0)
                    if sc <= hgvs_intron_anchor <= ec:
                        cx_donor = x
                        break
                except (TypeError, ValueError):
                    continue
            donor_end = int((cx_donor or cx_up or {}).get('end_cds') or hgvs_intron_anchor)
            donor_rank = int((cx_donor or cx_up or {}).get('anatomical_rank') or up_rank or max(0, dn_rank - 1))
            exon_tail_donor = cds[max(0, donor_end - 14):donor_end] if donor_end > 0 else ''
            try:
                gt_i = int(details.get('canonical_first_gt_0based'))
            except (TypeError, ValueError):
                gt_i = -1
            if gt_i < 0:
                gt_i = wt.upper().find('GT')
            if gt_i < 0:
                gt_i = 0
            gt_ref = wt[gt_i:gt_i + 2] if gt_i + 2 <= len(wt) else 'GT'
            gt_mut = mut[gt_i:gt_i + 2] if gt_i + 2 <= len(mut) else gt_ref
            ref_bases, mut_bases, deep_intronic_map_meta = _junction_align_deep_intronic_donor_premrna_window(
                wt, mut, gt_i=gt_i, exon_tail=exon_tail_donor, donor_end=donor_end,
                hgvs_intron_anchor=hgvs_intron_anchor, c_dot=c_dot, details=details, win=win,
            )
            mut_spans = []
            _junction_align_apply_substitution(mut_bases, mut_spans, c_low, parsed_data)
            if deep_intronic_map_meta.get('variant_base_index') is not None and not any(
                s.get('kind') == 'variant' for s in mut_spans
            ):
                vi = int(deep_intronic_map_meta['variant_base_index'])
                if 0 <= vi < len(mut_bases):
                    mut_bases[vi]['kind'] = 'variant'
                    mut_spans.append({
                        'start': vi, 'end': vi + 1, 'kind': 'variant',
                        'label': re.sub(r'^.*c\.', 'c.', c_dot, flags=re.I),
                    })
            mut_markers = [
                {'index': len(exon_tail_donor), 'kind': 'splice_gt', 'label': 'canonical GT'},
            ]
            ref_markers = list(mut_markers)
            if deep_intronic_map_meta.get('variant_base_index') is not None:
                vi = int(deep_intronic_map_meta['variant_base_index'])
                var_lbl = re.sub(r'^.*?(c\.[^\s]+).*', r'\1', c_dot, flags=re.I)
                if var_lbl == c_dot:
                    var_lbl = re.sub(r'^.*c\.', 'c.', c_dot, flags=re.I)
                ref_markers.insert(0, {
                    'index': vi, 'kind': 'variant_locus',
                    'label': f'{var_lbl} (ref)',
                })
                mut_markers.insert(0, {
                    'index': vi, 'kind': 'variant_locus',
                    'label': var_lbl,
                })
            anchor_c = hgvs_intron_anchor
            up_rank = donor_rank
            tracks = [
                {
                    'id': 'reference',
                    'title': 'Reference pre-mRNA',
                    'kind': 'premrna',
                    'bases': ref_bases,
                    'spans': [],
                    'markers': ref_markers,
                },
                {
                    'id': 'mutant',
                    'title': 'Mutant allele (variant in intron)',
                    'kind': 'premrna',
                    'bases': mut_bases,
                    'spans': mut_spans,
                    'markers': mut_markers,
                    'dup_seq': None,
                },
            ]
        else:
            ref_bases, mut_bases, deep_intronic_map_meta = _junction_align_deep_intronic_premrna_window(
                wt, mut, ag_pos=ag_pos, anchor_c=anchor_c, exon_head=exon_head,
                c_dot=c_dot, details=details, win=win,
            )
            mut_spans = []
            dup_span = None
            if dup:
                dup_pos_full = mut.find(dup)
                if dup_pos_full >= 0:
                    ag_mut = mut.rfind('AG')
                    if ag_mut < 0:
                        ag_mut = ag_pos
                    if deep_intronic_map_meta.get('deep_map') and deep_intronic_map_meta.get('variant_base_index') is not None:
                        try:
                            jv = int(details.get('variant_intron_j_var_hgvs') or details.get('variant_intron_j_var'))
                            di = dup_pos_full - max(0, jv - 6)
                        except (TypeError, ValueError):
                            di = dup_pos_full - max(0, ag_mut - win)
                    else:
                        di = dup_pos_full - max(0, ag_mut - win)
                    if 0 <= di:
                        dup_span = {
                            'start': di, 'end': di + len(dup), 'kind': 'dup',
                            'label': f'{len(dup)} nt dup',
                        }
            if dup_span:
                mut_spans.append(dup_span)
            _junction_align_apply_substitution(mut_bases, mut_spans, c_low, parsed_data)
            if deep_intronic_map_meta.get('variant_base_index') is not None and not any(
                s.get('kind') == 'variant' for s in mut_spans
            ):
                vi = int(deep_intronic_map_meta['variant_base_index'])
                if 0 <= vi < len(mut_bases):
                    mut_bases[vi]['kind'] = 'variant'
                    mut_spans.append({
                        'start': vi, 'end': vi + 1, 'kind': 'variant',
                        'label': re.sub(r'^.*c\.', 'c.', c_dot, flags=re.I),
                    })
            intron_n = len([b for b in ref_bases if b.get('kind') == 'intron'])
            ref_markers = [
                {'index': intron_n, 'kind': 'splice_ag', 'label': 'canonical AG'},
                {'index': intron_n + 2, 'kind': 'exon_start',
                 'label': f'exon {dn_rank} (c.{anchor_c})'},
            ]
            mut_markers = [
                {'index': intron_n, 'kind': 'splice_ag', 'label': 'canonical AG'},
                {'index': intron_n + 2, 'kind': 'exon_start',
                 'label': f'exon {dn_rank}'},
            ]
            if deep_intronic_map_meta.get('variant_base_index') is not None:
                vi = int(deep_intronic_map_meta['variant_base_index'])
                var_lbl = re.sub(r'^.*?(c\.[^\s]+).*', r'\1', c_dot, flags=re.I)
                if var_lbl == c_dot:
                    var_lbl = re.sub(r'^.*c\.', 'c.', c_dot, flags=re.I)
                ref_markers.insert(0, {
                    'index': vi, 'kind': 'variant_locus',
                    'label': f'{var_lbl} (ref)',
                })
                mut_markers.insert(0, {
                    'index': vi, 'kind': 'variant_locus',
                    'label': var_lbl,
                })
            tracks = [
                {
                    'id': 'reference',
                    'title': 'Reference pre-mRNA',
                    'kind': 'premrna',
                    'bases': ref_bases,
                    'spans': [],
                    'markers': ref_markers,
                },
                {
                    'id': 'mutant',
                    'title': 'Mutant allele' + (f' ({len(dup)} nt dup)' if dup else ' (variant in intron)'),
                    'kind': 'premrna',
                    'bases': mut_bases,
                    'spans': mut_spans,
                    'markers': mut_markers,
                    'dup_seq': dup or None,
                },
            ]

    bl = parsed_data.get('deep_intronic_dup_baseline_outcome') or {}
    insert_idx = _deep_intronic_dup_cds_insert_index(c_dot)
    if dup and dup_rng:
        p1_bases, p1_spans, p1_markers = _junction_align_mature_dup_retained_bases(
            dup, cds, anchor_c, dup_rng,
        )
        p1_note = (
            f'No intron in mature mRNA. Full dup ({len(dup)} nt) is coding at exon {dn_rank} 5′; '
            f'exon continues from c.{dup_rng["exon_end_c"] + 1}.'
        )
        ptc_m = _junction_align_ptc_marker(
            p1_bases, bl, track_origin_cds_0based=insert_idx,
        )
        if ptc_m:
            if ptc_m.get('off_window'):
                p1_note = (p1_note + ' ' + (ptc_m.get('note') or '')).strip()
            else:
                p1_spans.append({
                    'start': int(ptc_m['start']),
                    'end': int(ptc_m['end']),
                    'kind': 'ptc',
                    'label': (ptc_m.get('label') or '') + (
                        f" ({ptc_m.get('codon')})" if ptc_m.get('codon') else ''
                    ),
                })
        tracks.append({
            'id': 'dup_baseline',
            'title': 'Product 1 — mature mRNA (dup retained, no splice)',
            'kind': 'mature',
            'summary': (bl.get('fs_ter_str') or parsed_data.get('hgvs_p') or '').strip(),
            'note': p1_note,
            'bases': p1_bases,
            'spans': p1_spans,
            'markers': p1_markers,
        })
    elif dup:
        p1_bases = _junction_align_flat_bases(dup, '', exon_head, anchor_c, ext_first=True, ext_len=len(dup))
        p1_spans = [{'start': 0, 'end': len(dup), 'kind': 'exon_extension', 'label': f'+{len(dup)} nt'}]
        p1_note = f'Full {len(dup)} nt duplication enters mature mRNA as the new 5′ end of exon {dn_rank}.'
        ptc_m = _junction_align_ptc_marker(
            p1_bases, bl, track_origin_cds_0based=insert_idx,
        )
        if ptc_m:
            if ptc_m.get('off_window'):
                p1_note = (p1_note + ' ' + (ptc_m.get('note') or '')).strip()
            else:
                p1_spans.append({
                    'start': int(ptc_m['start']),
                    'end': int(ptc_m['end']),
                    'kind': 'ptc',
                    'label': (ptc_m.get('label') or '') + (
                        f" ({ptc_m.get('codon')})" if ptc_m.get('codon') else ''
                    ),
                })
        tracks.append({
            'id': 'dup_baseline',
            'title': 'Product 1 — dup retained (no splice)',
            'kind': 'mature',
            'summary': (bl.get('fs_ter_str') or parsed_data.get('hgvs_p') or '').strip(),
            'note': p1_note,
            'bases': p1_bases,
            'spans': p1_spans,
            'markers': [],
        })

    for key, track_id, title in (
        ('deep_intronic_primary_outcome', 'acceptor_gain', 'Product — closest GT→AG (acceptor gain splice)'),
        ('deep_intronic_acceptor_next_outcome', 'acceptor_gain_next', 'Product — next upstream GT→AG (acceptor gain splice)'),
        ('deep_intronic_alternate_outcome', 'acceptor_gain_alt', 'Product 2 — mature mRNA (acceptor gain splice)'),
        ('deep_intronic_alternate2_outcome', 'acceptor_gain_alt2', 'Product 3 — mature mRNA (acceptor gain splice)'),
    ):
        co = parsed_data.get(key) or {}
        ins = str(co.get('inserted_cdna') or '').upper()
        ctype = str(co.get('cryptic_type') or '')
        if not ins or 'acceptor' not in ctype.lower():
            continue
        if any(t.get('id') == track_id for t in tracks):
            continue
        if track_id == 'acceptor_gain_alt' and any(
            t.get('id') in ('acceptor_gain', 'acceptor_gain_next') for t in tracks
        ):
            _pri = parsed_data.get('deep_intronic_primary_outcome') or {}
            if _pri.get('inserted_cdna') == co.get('inserted_cdna'):
                continue
        if track_id == 'acceptor_gain_alt2' and any(
            t.get('id') in ('acceptor_gain', 'acceptor_gain_next', 'acceptor_gain_alt') for t in tracks
        ):
            _seen = {
                (parsed_data.get(k) or {}).get('inserted_cdna')
                for k in (
                    'deep_intronic_primary_outcome',
                    'deep_intronic_acceptor_next_outcome',
                    'deep_intronic_alternate_outcome',
                )
            }
            if co.get('inserted_cdna') in _seen:
                continue
        geom = co.get('pseudoexon_geometry') or {}
        jp = geom.get('junction_proximal_acceptor')
        p2_bases, p2_spans, p2_markers = _junction_align_mature_acceptor_gain_bases(
            ins, cds, dn_start,
            geom=geom, exon_rank=dn_rank,
            upstream_end_cds=(cx_up.get('end_cds') if cx_up else None),
            upstream_exon_rank=up_rank,
            downstream_start_cds=dn_start,
            co=co,
            mut_seq=mut,
        )
        try:
            _track_origin = int(cx_up.get('end_cds') or 0) if cx_up else None
            _prefix_len = len(_junction_align_upstream_exon_tail_bases(
                cds, _track_origin,
            )) if _track_origin else 0
        except (TypeError, ValueError):
            _track_origin = None
            _prefix_len = 0
        if _track_origin is None or _track_origin <= 0:
            _track_origin = _junction_align_track_origin_from_bases(p2_bases)
        try:
            _pseudo_len = int(co.get('shift_nt') or geom.get('body_nt') or 0)
        except (TypeError, ValueError):
            _pseudo_len = 0
        if _pseudo_len <= 0:
            _pseudo_len = len([
                b for b in p2_bases
                if (b or {}).get('kind') == 'exon_extension_intronic'
            ]) or len(ins)
        _norm_ins = _acceptor_gain_mature_retained_body(
            ins,
            mut_seq=mut,
            picked_ag=geom,
            cds_seq=cds,
            downstream_start_0=int(cx_up.get('end_cds') or 0) if cx_up else max(0, anchor_c - 1),
            target_body_nt=co.get('shift_nt') or geom.get('body_nt'),
        )
        _plain = (co.get('product_plain_summary') or _format_splice_product_plain_summary(co, parsed_data)).strip()
        _schematic_note = (
            f'No intron in mature mRNA. {_pseudo_len} nt pseudo-exon (GT→gained AG) splices onto '
            f'exon {dn_rank} at c.{dn_start} '
            f'({"canonical-proximal gained AG; reference acceptor skipped" if jp else "cryptic gained AG"}). '
            f'AG motifs inside the pseudo-exon are not used as acceptors.'
        )
        p2_note = _schematic_note
        ptc_m = _junction_align_ptc_marker_product(
            p2_bases, co,
            insert_len=_pseudo_len,
            track_origin_cds_0based=_track_origin,
            display_prefix_len=_prefix_len,
        )
        if ptc_m:
            if ptc_m.get('off_window'):
                p2_note = (p2_note + ' ' + (ptc_m.get('note') or '')).strip()
            else:
                p2_spans.append({
                    'start': int(ptc_m['start']),
                    'end': int(ptc_m['end']),
                    'kind': 'ptc',
                    'label': (ptc_m.get('label') or '') + (
                        f" ({ptc_m.get('codon')})" if ptc_m.get('codon') else ''
                    ),
                })
        tracks.append({
            'id': track_id,
            'title': title,
            'kind': 'mature',
            'summary': _plain or (co.get('fs_ter_str') or '').strip(),
            'note': p2_note,
            'bases': p2_bases,
            'spans': p2_spans,
            'markers': p2_markers,
        })

    _donor_track_ids = {
        'deep_intronic_primary_outcome': 'donor_gain',
        'deep_intronic_alternate_outcome': 'donor_gain_alt',
        'deep_intronic_alternate2_outcome': 'donor_gain_alt2',
    }
    for key, label_default in (
        ('deep_intronic_primary_outcome', 'Product — donor gain (splice)'),
        ('deep_intronic_alternate_outcome', 'Product 2 — donor gain (splice)'),
        ('deep_intronic_alternate2_outcome', 'Product 3 — donor gain (splice)'),
    ):
        co = parsed_data.get(key) or {}
        ins = str(co.get('inserted_cdna') or '').upper()
        ctype = str(co.get('cryptic_type') or '')
        track_id = _donor_track_ids.get(key, 'donor_gain')
        if not ins or 'donor' not in ctype.lower():
            continue
        if any(t.get('id') == track_id for t in tracks):
            continue
        pre_atg = bool(co.get('pre_atg_utr_pseudoexon'))
        try:
            donor_anchor = int(cx_up.get('end_cds') or anchor_c) if cx_up else anchor_c
        except (TypeError, ValueError):
            donor_anchor = anchor_c
        prod_markers = []
        if pre_atg:
            up_rank, dn_rank = _resolve_pre_atg_mrna_exon_ranks(
                parsed_data, coding_exons, details, up_rank, dn_rank,
            )
            try:
                first_cx = _deep_intronic_first_coding_exon(coding_exons)
                cds_start = int(first_cx.get('start_cds') or dn_start)
                anchor_c_utr = cds_start - 1
            except (TypeError, ValueError):
                cds_start, anchor_c_utr = dn_start, max(0, dn_start - 1)
            p_bases, prod_markers, p_spans_pre = _junction_align_pre_atg_product_bases(
                ins, cds, cds_start, anchor_c_utr,
                upstream_end_cds=anchor_c_utr,
                upstream_exon_rank=up_rank,
                downstream_exon_rank=dn_rank,
            )
            dg_note = (
                f'{len(ins)} nt 5\u2032 UTR pseudo-exon between exon {up_rank} and coding exon {dn_rank} '
                f'(pre-AUG; original AUG/Met in exon {dn_rank} unchanged). Consider mRNA/translation effects.'
            )
            dg_span = f'+{len(ins)} nt 5\u2032 UTR'
        else:
            p_bases, p_spans, p_markers = _junction_align_mature_donor_gain_bases(
                ins, cds, donor_anchor, dn_start,
                upstream_exon_rank=up_rank,
                downstream_exon_rank=dn_rank,
            )
            dg_note = f'{len(ins)} nt retained after cryptic donor GT (between exon {up_rank} and exon {dn_rank}).'
            dg_span = f'+{len(ins)} nt'
            prod_markers = p_markers
        ep = _junction_align_product_from_co(
            co,
            title=label_default,
            note=dg_note,
            bases=p_bases,
            span_label=dg_span,
            extra_markers=prod_markers,
        )
        if ep:
            if pre_atg:
                ep['spans'] = p_spans_pre
            else:
                ep['spans'] = p_spans
            ep['id'] = track_id
            tracks.append(ep)

    co_skip = parsed_data.get('deep_intronic_alternate2_outcome') or {}
    if not co_skip.get('exon_skip') and parsed_data.get('spliceai_secondary_mechanism') == '3prime_acceptor_loss':
        co_skip = parsed_data.get('deep_intronic_alternate_outcome') or co_skip
    if co_skip.get('exon_skip'):
        try:
            skip_rank = int(co_skip.get('skipped_exon_rank') or dn_rank)
        except (TypeError, ValueError):
            skip_rank = dn_rank
        tail_ctx = exon_tail[-6:] if exon_tail else ''
        skip_bases = []
        if tail_ctx and up_end > 0:
            for i, nt in enumerate(tail_ctx):
                pos = up_end - len(tail_ctx) + i + 1
                skip_bases.append({
                    'nt': nt,
                    'kind': 'exon',
                    'hgvs': f'c.{pos}',
                })
        tracks.append({
            'id': 'exon_skip',
            'title': f'Product 3 — exon {skip_rank} skipped',
            'kind': 'mature',
            'summary': (co_skip.get('fs_ter_str') or '').strip(),
            'note': (
                f'Canonical acceptor weakened; exon {skip_rank} not in mature mRNA '
                f'(only if dup AG acceptor(s) are not used).'
            ),
            'bases': skip_bases,
            'spans': [{
                'start': len(skip_bases),
                'end': len(skip_bases) + 1,
                'kind': 'exon_skip',
                'label': f'exon {skip_rank} skipped',
            }],
            'markers': [],
        })

    ruler_extra = []
    if deep_intronic_map_meta.get('variant_base_index') is not None:
        try:
            ruler_extra.append(int(deep_intronic_map_meta['variant_base_index']))
        except (TypeError, ValueError):
            pass
    ref_track = next((t for t in tracks if t.get('id') == 'reference'), None)
    ref_bases_ruler = (ref_track or {}).get('bases') or []
    ruler = _junction_align_ruler_ticks(ref_bases_ruler, every=10, extra_indices=ruler_extra)

    deep_map = bool(deep_intronic_map_meta.get('deep_map'))
    scroll_hint = ''
    if deep_map:
        if deep_intronic_map_meta.get('scroll_junction_at') == 'start':
            scroll_hint = (
                'Long intron — scroll right on the pre-mRNA row from the exon/GT junction '
                'to reach the variant locus (red underline on mutant track).'
            )
        else:
            scroll_hint = (
                'Long intron — scroll left on the pre-mRNA row from the AG/exon junction '
                'to reach the variant locus (red underline on mutant track).'
            )

    return {
        'eligible': True,
        'title': f'{gene} {c_dot}'.strip(),
        'anchor_hgvs': f'c.{anchor_c}',
        'upstream_exon': up_rank,
        'downstream_exon': dn_rank,
        'tracks': tracks,
        'ruler': ruler,
        'legend': _junction_align_legend(tracks),
        'deep_map': deep_map,
        'scroll_default': deep_intronic_map_meta.get('scroll_default') or ('junction' if deep_map else ''),
        'scroll_junction_at': deep_intronic_map_meta.get('scroll_junction_at') or '',
        'variant_base_index': deep_intronic_map_meta.get('variant_base_index'),
        'scroll_hint': scroll_hint,
    }


def _junction_align_resolve_skipped_exon_cx(parsed_data, coding_exons):
    """Map splice_deleted_coords / variant_exon to the skipped coding-exon row."""
    del_c = parsed_data.get('splice_deleted_coords') or {}
    cx_skip = None
    if del_c.get('start') and del_c.get('end'):
        for x in coding_exons:
            try:
                if (
                    str(x.get('chr')) == str(del_c.get('chr'))
                    and int(x.get('start') or 0) == int(del_c['start'])
                    and int(x.get('end') or 0) == int(del_c['end'])
                ):
                    cx_skip = x
                    break
            except (TypeError, ValueError):
                continue
    if not cx_skip:
        try:
            ve = int(parsed_data.get('variant_exon') or 0)
        except (TypeError, ValueError):
            ve = 0
        if ve:
            cx_skip = next(
                (x for x in coding_exons if int(x.get('anatomical_rank') or 0) == ve),
                None,
            )
    return cx_skip


def _junction_align_donor_intron_flank(parsed_data, cx, win):
    """Real genomic donor dinucleotide + downstream intron bases for the 5′ donor
    of coding exon ``cx``.

    Returns ``(donor2_seq, intron_seq)`` in transcript orientation (so
    ``donor2_seq`` is c.N+1/+2 and ``intron_seq`` is c.N+3 onward), or
    ``(None, None)`` so the caller can fall back to schematic placeholders.
    Without this the intron window renders as 'n' placeholders and an intronic
    deletion (e.g. c.N+5_N+8del) has no real bases to point at.
    """
    try:
        chrom = (parsed_data.get('transcript_chrom') or cx.get('chr') or '').strip()
        strand = int(parsed_data.get('transcript_strand') or 1)
        e_start = int(cx.get('start') or 0)
        e_end = int(cx.get('end') or 0)
    except (TypeError, ValueError):
        return None, None
    need = 2 + int(win or 0)
    if not chrom or e_start <= 0 or e_end <= 0 or need <= 2:
        return None, None
    try:
        if strand == -1:
            lo, hi = e_start - need, e_start - 1
        else:
            lo, hi = e_end + 1, e_end + need
        if lo < 1 or hi < lo:
            return None, None
        url = f'https://rest.ensembl.org/sequence/region/human/{chrom}:{lo}..{hi}:1?content-type=text/plain'
        r = http_session.get(url, timeout=60)
        if getattr(r, 'status_code', 0) != 200:
            return None, None
        raw = (getattr(r, 'text', None) or '').strip().replace('\n', '').upper()
        if len(raw) < need:
            return None, None
        seq = _dna_revcomp(raw) if strand == -1 else raw
        return seq[:2], seq[2:need]
    except Exception as exc:
        print(f"[junction-align] donor intron flank fetch failed: {exc}")
        return None, None


def _junction_align_payload_exon_skip_loss(parsed_data):
    """
    Junction sequence map for canonical whole-exon skip (donor/acceptor loss)
    when cryptic/deep-intronic contexts are absent (e.g. intronic c.N+del near GT).
    """
    out = {'eligible': False, 'reason': ''}
    has_skip_math = bool((parsed_data.get('splice_frame_math') or '').strip())
    has_skip_signal = bool(
        has_skip_math
        or parsed_data.get('splice_fraction_lost') is not None
        or parsed_data.get('exon_skip_oof_fs_ter')
        or parsed_data.get('spliceai_exon_skip_spliceai_primary')
    )
    if not has_skip_signal:
        out['reason'] = 'Whole-exon skip model not resolved.'
        return out
    coding_exons = parsed_data.get('coding_exons') or []
    cds = (parsed_data.get('cds_seq') or '').upper()
    if not coding_exons or not cds:
        out['reason'] = 'CDS / exon map unavailable for junction alignment.'
        return out

    cx_skip = _junction_align_resolve_skipped_exon_cx(parsed_data, coding_exons)
    if not cx_skip:
        out['reason'] = 'Skipped exon interval not mapped on transcript.'
        return out

    try:
        skip_rank = int(cx_skip.get('anatomical_rank') or 0)
        ts = int(cx_skip.get('start_cds') or 0)
        te = int(cx_skip.get('end_cds') or 0)
    except (TypeError, ValueError):
        out['reason'] = 'Skipped exon CDS bounds unavailable.'
        return out
    if skip_rank < 1 or ts < 1 or te < ts:
        out['reason'] = 'Skipped exon CDS bounds unavailable.'
        return out

    c_dot = (parsed_data.get('c_dot') or '').strip()
    c_low = c_dot.lower()
    cons = (parsed_data.get('consequence') or '').lower()
    if re.search(r'c\.\d+\+', c_low):
        is_donor_side = True
        is_acceptor_side = False
    elif re.search(r'c\.\d+-', c_low):
        is_acceptor_side = True
        is_donor_side = False
    else:
        is_acceptor_side = 'splice_acceptor' in cons
        is_donor_side = 'splice_donor' in cons or not is_acceptor_side

    win = 28
    mut_spans = []
    ref_spans = []
    dup_seq = ''
    if is_donor_side:
        anchor_c = te
        exon_tail = cds[max(0, anchor_c - 14):anchor_c]
        # Real donor GT + intron bases when available, else schematic placeholders.
        real_gt, real_intron = _junction_align_donor_intron_flank(parsed_data, cx_skip, win)
        gt_seq = real_gt if (real_gt and len(real_gt) == 2) else 'GT'
        intron_seq = real_intron if real_intron else ('n' * win)
        ref_bases = _junction_align_flat_bases_donor(exon_tail, gt_seq, intron_seq, anchor_c)
        mut_bases = [dict(b) for b in ref_bases]
        donor_loss_idx = len(exon_tail)
        applied_del, loss_idx = _junction_align_apply_donor_deletion(
            mut_bases, mut_spans, ref_spans, c_dot, anchor_c,
        )
        if applied_del:
            donor_loss_idx = loss_idx
        elif _junction_align_apply_insertion(mut_bases, mut_spans, c_low):
            pass
        elif _junction_align_apply_dup(
            mut_bases, mut_spans, c_dot, parsed_data, is_donor=True, ref_spans=ref_spans,
        ):
            ref = str(parsed_data.get('ref') or '').upper()
            alt = str(parsed_data.get('alt') or '').upper()
            if ref and alt and len(alt) > len(ref) and alt.startswith(ref):
                dup_seq = alt[len(ref):]
        elif _junction_align_apply_substitution(mut_bases, mut_spans, c_low, parsed_data):
            pass
        up_tail = cds[max(0, ts - 1 - 10):ts - 1] if ts > 1 else ''
        dn_head = cds[te:min(len(cds), te + 14)]
        product_bases = []
        for i, nt in enumerate(up_tail):
            pos = ts - len(up_tail) + i
            product_bases.append({'nt': nt, 'kind': 'exon', 'hgvs': f'c.{pos}' if pos > 0 else ''})
        junc = len(product_bases)
        for i, nt in enumerate(dn_head):
            product_bases.append({'nt': nt, 'kind': 'exon', 'hgvs': f'c.{te + 1 + i}'})
        product_spans = [{
            'start': junc, 'end': junc + 1, 'kind': 'exon_skip',
            'label': f'E{skip_rank} skipped',
        }]
        dn_rank = skip_rank + 1
        ctx = {
            'layout': 'donor_junction',
            'anchor_c': anchor_c,
            'exon_rank': dn_rank,
            'upstream_exon': max(0, skip_rank - 1),
            'ref_bases': ref_bases,
            'ref_spans': ref_spans,
            'mut_bases': mut_bases,
            'mut_spans': mut_spans,
            'mut_markers': [
                {'index': donor_loss_idx, 'kind': 'splice_loss',
                 'label': f'5′ donor lost → E{skip_rank} skipped'},
            ],
            'dup_seq': dup_seq or None,
            'product_bases': product_bases,
            'product_spans': product_spans,
            'product_title': f'Whole-exon skip — E{skip_rank} removed',
            'mut_title': 'Mutant pre-mRNA (donor / intronic disruption)',
        }
    else:
        anchor_c = ts
        exon_head = cds[anchor_c - 1:min(len(cds), anchor_c - 1 + 14)]
        # Real AG + upstream intron bases when available, else schematic 'n'.
        real_ag, real_intron = _junction_align_acceptor_intron_flank(parsed_data, cx_skip, win)
        ag_seq = real_ag if (real_ag and len(real_ag) == 2) else 'AG'
        intron_seq = real_intron if real_intron else ('n' * win)
        ref_bases = _junction_align_flat_bases_acceptor(intron_seq, ag_seq, exon_head, anchor_c)
        mut_bases = [dict(b) for b in ref_bases]
        # Standard HGVS repeats the anchor on both sides (c.N-8_N-4del); also
        # tolerate the collapsed single-anchor form (c.N-8_-4del).
        m_del = re.search(r'c\.\d+-(\d+)_(?:\d+)?-(\d+)del', c_low)
        if m_del:
            try:
                off_lo = int(m_del.group(1))
                off_hi = int(m_del.group(2))
                i0 = _junction_align_bases_hgvs_index(mut_bases, f'c.{anchor_c}-{off_hi}')
                i1 = _junction_align_bases_hgvs_index(mut_bases, f'c.{anchor_c}-{off_lo}')
                if i0 >= 0 and i1 >= i0:
                    mut_spans.append({
                        'start': i0, 'end': i1 + 1, 'kind': 'variant',
                        'label': f'{off_hi - off_lo + 1} nt intronic deletion',
                    })
            except (TypeError, ValueError):
                pass
        else:
            if not _junction_align_apply_insertion(mut_bases, mut_spans, c_low):
                if _junction_align_apply_dup(
                    mut_bases, mut_spans, c_dot, parsed_data, is_donor=False, ref_spans=ref_spans,
                ):
                    ref = str(parsed_data.get('ref') or '').upper()
                    alt = str(parsed_data.get('alt') or '').upper()
                    if ref and alt and len(alt) > len(ref) and alt.startswith(ref):
                        dup_seq = alt[len(ref):]
        if not mut_spans:
            _junction_align_apply_substitution(mut_bases, mut_spans, c_low, parsed_data)
        # Acceptor disruption marker → the AG (c.N-2); recompute after any
        # insertion may have shifted indices.
        _ag_idx = _junction_align_bases_hgvs_index(mut_bases, f'c.{anchor_c}-2')
        if _ag_idx < 0:
            _ag_idx = len(intron_seq)
        up_tail = cds[max(0, ts - 1 - 14):ts - 1] if ts > 1 else ''
        dn_head = cds[te:min(len(cds), te + 10)]
        product_bases = []
        for i, nt in enumerate(up_tail):
            pos = ts - len(up_tail) + i
            product_bases.append({'nt': nt, 'kind': 'exon', 'hgvs': f'c.{pos}' if pos > 0 else ''})
        junc = len(product_bases)
        for i, nt in enumerate(dn_head):
            product_bases.append({'nt': nt, 'kind': 'exon', 'hgvs': f'c.{te + 1 + i}'})
        product_spans = [{
            'start': junc, 'end': junc + 1, 'kind': 'exon_skip',
            'label': f'E{skip_rank} skipped',
        }]
        ctx = {
            'layout': 'acceptor_junction',
            'anchor_c': anchor_c,
            'exon_rank': skip_rank,
            'upstream_exon': max(0, skip_rank - 1),
            'ref_bases': ref_bases,
            'ref_spans': ref_spans,
            'mut_bases': mut_bases,
            'mut_spans': mut_spans,
            'mut_markers': [
                {'index': _ag_idx, 'kind': 'splice_loss',
                 'label': f'3′ acceptor lost → E{skip_rank} skipped'},
            ],
            'dup_seq': dup_seq or None,
            'product_bases': product_bases,
            'product_spans': product_spans,
            'product_title': f'Whole-exon skip — E{skip_rank} removed',
            'mut_title': 'Mutant pre-mRNA (acceptor / intronic disruption)',
        }

    outcome_co = _junction_align_skip_outcome_co(parsed_data, cx_skip)
    if ctx.get('product_bases'):
        ctx['product_track_origin_cds_0based'] = _junction_align_track_origin_from_bases(
            ctx.get('product_bases'),
        )
    payload = _junction_align_payload_from_ctx(parsed_data, ctx, outcome_co)
    return payload


def _junction_align_whole_exon_skip_product_parts(parsed_data, cx_skip):
    """Bases/spans for a mature mRNA with one coding exon removed."""
    cds = (parsed_data.get('cds_seq') or '').upper()
    if not cds or not cx_skip:
        return None, None, None
    try:
        skip_rank = int(cx_skip.get('anatomical_rank') or 0)
        ts = int(cx_skip.get('start_cds') or 0)
        te = int(cx_skip.get('end_cds') or 0)
    except (TypeError, ValueError):
        return None, None, None
    if skip_rank < 1 or ts < 1 or te < ts:
        return None, None, None
    up_tail = cds[max(0, ts - 1 - 10):ts - 1] if ts > 1 else ''
    dn_head = cds[te:min(len(cds), te + 14)]
    product_bases = []
    for i, nt in enumerate(up_tail):
        pos = ts - len(up_tail) + i
        product_bases.append({'nt': nt, 'kind': 'exon', 'hgvs': f'c.{pos}' if pos > 0 else ''})
    junc = len(product_bases)
    for i, nt in enumerate(dn_head):
        product_bases.append({'nt': nt, 'kind': 'exon', 'hgvs': f'c.{te + 1 + i}'})
    product_spans = [{
        'start': junc,
        'end': junc + 1,
        'kind': 'exon_skip',
        'label': f'E{skip_rank} skipped',
    }]
    return product_bases, product_spans, skip_rank


def _junction_align_skip_outcome_co(parsed_data, cx_skip, *, field_prefix=''):
    """Outcome dict for junction-map PTC placement (primary or prefixed secondary skip)."""
    pfx = field_prefix or ''
    fs = parsed_data.get(f'{pfx}exon_skip_oof_fs_ter') or ''
    if not fs and field_prefix:
        fs = parsed_data.get(f'{pfx}exon_skip_predicted_hgvs_p') or ''
    if not fs and not field_prefix:
        fs = parsed_data.get('exon_skip_predicted_hgvs_p') or ''
    first_aa = parsed_data.get(f'{pfx}exon_skip_model_protein_start')
    if first_aa is None and not field_prefix:
        first_aa = parsed_data.get('exon_skip_model_protein_start')
    if first_aa is None and cx_skip:
        try:
            ts = int(cx_skip.get('start_cds') or 0)
            if ts > 0:
                first_aa = (ts - 1) // 3 + 1
        except (TypeError, ValueError):
            first_aa = None
    try:
        skip_rank = int(cx_skip.get('anatomical_rank') or 0) if cx_skip else 0
    except (TypeError, ValueError):
        skip_rank = 0
    return {
        'exon_skip': True,
        'skipped_exon_rank': skip_rank or None,
        'fs_ter_str': str(fs).strip() if fs else '',
        'ptc_aa_position': parsed_data.get(f'{pfx}exon_skip_oof_ptc_aa'),
        'ptc_exon_rank': parsed_data.get(f'{pfx}exon_skip_oof_ptc_exon_rank'),
        'first_changed_aa_pos': first_aa,
    }


def _junction_align_exon_skip_product_track(
    parsed_data,
    cx_skip,
    *,
    track_id,
    title,
    note='',
    summary='',
    field_prefix='',
):
    """Mature mRNA whole-exon skip track with unified fsTer / PTC nucleotide placement."""
    if not cx_skip:
        return None
    product_bases, product_spans, skip_rank = _junction_align_whole_exon_skip_product_parts(
        parsed_data, cx_skip,
    )
    if not product_bases:
        return None
    outcome_co = _junction_align_skip_outcome_co(parsed_data, cx_skip, field_prefix=field_prefix)
    if not summary:
        summary = outcome_co.get('fs_ter_str') or ''
    origin = _junction_align_track_origin_from_bases(product_bases)
    prod = _junction_align_product_from_co(
        outcome_co,
        title=title,
        note=note,
        bases=product_bases,
        track_origin_cds_0based=origin,
    )
    if not prod:
        return None
    prod['id'] = track_id
    if summary:
        prod['summary'] = summary
    prod['spans'] = list(product_spans or []) + list(prod.get('spans') or [])
    return prod


def _junction_align_resolve_skip_cx_for_secondary(parsed_data, ctx):
    coding_exons = parsed_data.get('coding_exons') or []
    cx_skip = _junction_align_resolve_skipped_exon_cx(parsed_data, coding_exons)
    if cx_skip:
        return cx_skip
    try:
        skip_rank = int(
            parsed_data.get('exon_skip_oof_ptc_exon_rank')
            or parsed_data.get('variant_exon')
            or ctx.get('upstream_exon')
            or 0
        )
    except (TypeError, ValueError):
        skip_rank = 0
    if skip_rank > 0:
        return next(
            (x for x in coding_exons if int(x.get('anatomical_rank') or 0) == skip_rank),
            None,
        )
    return None


def _junction_align_secondary_products_for_donor(parsed_data, ctx):
    """
    Donor variants with competing SpliceAI DS_DG + DS_DL (e.g. c.N+1G>A): primary map
    is often cryptic donor gain; add whole-exon skip as the parallel donor-loss product.
    """
    extras = []
    cons = _effective_splice_consequence(parsed_data) or (parsed_data.get('consequence') or '')
    c_dot = (parsed_data.get('c_dot') or '').lower()
    if not _consequence_is_donor_splice(cons, c_dot) and not re.search(r'c\.\d+\+', c_dot):
        return extras
    try:
        ds_dl = float(parsed_data.get('spliceai_ds_dl') or 0.0)
        ds_dg = float(parsed_data.get('spliceai_ds_dg') or 0.0)
    except (TypeError, ValueError):
        ds_dl = ds_dg = 0.0
    skip_summary = (parsed_data.get('exon_skip_oof_fs_ter') or '').strip()
    has_skip_math = bool((parsed_data.get('splice_frame_math') or '').strip())
    if (
        ds_dl < SPLICEAI_RECONCILE_MIN
        and not skip_summary
        and not has_skip_math
    ):
        return extras

    cx_skip = _junction_align_resolve_skip_cx_for_secondary(parsed_data, ctx)
    if not cx_skip:
        return extras

    try:
        skip_rank = int(cx_skip.get('anatomical_rank') or 0)
    except (TypeError, ValueError):
        skip_rank = 0
    if not skip_rank:
        return extras

    note = (
        f'SpliceAI DS_DL {ds_dl:.2f} — canonical 5′ donor (GT) lost at c.{ctx.get("anchor_c") or "?"}+1; '
        f'if cryptic donor use fails, exon {skip_rank} is skipped in mature mRNA.'
    )
    if ds_dg >= SPLICEAI_RECONCILE_MIN:
        note += f' Competes with donor gain (DS_DG {ds_dg:.2f}) shown as primary product above.'

    prod = _junction_align_exon_skip_product_track(
        parsed_data,
        cx_skip,
        track_id='exon_skip_secondary',
        title=f'Secondary product — exon {skip_rank} skipped (donor loss / DS_DL)',
        note=note,
        summary=skip_summary,
    )
    if prod:
        extras.append(prod)
    return extras


def _junction_align_secondary_products_for_acceptor(parsed_data, ctx):
    """
    Build secondary product tracks for canonical-proximal cryptic-splice maps.

    DDX39B c.212-8A>G is a textbook two-outcome variant: SpliceAI calls both
    DS_AG (cryptic acceptor created by the variant) and DS_AL (canonical
    acceptor abolished). The primary track shows the cryptic-splice product;
    this helper emits the *secondary* outcome — usually whole-exon skipping
    of the downstream exon — so reviewers see both possibilities side by side.
    """
    extras = []
    try:
        dn_rank = int(ctx.get('exon_rank') or 0)
    except (TypeError, ValueError):
        dn_rank = 0

    # Whole-exon skip secondary (canonical-acceptor loss outcome).
    skip_aa = parsed_data.get('exon_skip_oof_ptc_aa')
    skip_rank_raw = (parsed_data.get('exon_skip_oof_ptc_exon_rank')
                     or parsed_data.get('whole_exon_skip_rank')
                     or dn_rank)
    try:
        skip_rank = int(skip_rank_raw) if skip_rank_raw else dn_rank
    except (TypeError, ValueError):
        skip_rank = dn_rank
    skip_summary = (parsed_data.get('exon_skip_oof_fs_ter') or '').strip()
    has_skip_math = bool((parsed_data.get('splice_frame_math') or '').strip())
    if skip_aa is not None or skip_summary or has_skip_math:
        try:
            ds_al = float(parsed_data.get('spliceai_ds_al') or 0.0)
        except (TypeError, ValueError):
            ds_al = 0.0
        if ds_al >= SPLICEAI_RECONCILE_MIN or skip_summary or has_skip_math:
            cx_skip = _junction_align_resolve_skip_cx_for_secondary(parsed_data, ctx)
            if cx_skip:
                try:
                    skip_rank = int(cx_skip.get('anatomical_rank') or skip_rank)
                except (TypeError, ValueError):
                    pass
            prod = _junction_align_exon_skip_product_track(
                parsed_data,
                cx_skip,
                track_id='exon_skip_secondary',
                title=f'Secondary product — exon {skip_rank} skipped (canonical AG loss)',
                note=(
                    f'SpliceAI DS_AL {ds_al:.2f} predicts loss of the canonical '
                    f'acceptor; if the cryptic AG fails to rescue, exon '
                    f'{skip_rank} drops out of the mature mRNA.'
                ),
                summary=skip_summary,
            )
            if prod:
                extras.append(prod)

    return extras


def _junction_align_leading_exon_bases(bases):
    """Exon bases at the 5′ end of a pre-mRNA junction track (stop at first non-exon)."""
    out = []
    for b in bases or []:
        if (b.get('kind') or '') == 'exon':
            out.append(dict(b))
        else:
            break
    return out


def _junction_align_hgvs_at_marker(ctx, marker_kind):
    """Return the c. label at a junction-align marker index (from any ctx window)."""
    for m in ctx.get('mut_markers') or []:
        if m.get('kind') != marker_kind:
            continue
        try:
            idx = int(m.get('index'))
        except (TypeError, ValueError):
            continue
        mb = ctx.get('mut_bases') or []
        if 0 <= idx < len(mb):
            hgvs = (mb[idx].get('hgvs') or '').strip()
            if hgvs:
                return hgvs
    return ''


def _junction_align_cryptic_gt_after_retained(mut_bases, inserted_cdna):
    """Donor gain: cryptic GT sits immediately 3′ of the retained intronic body."""
    ins = str(inserted_cdna or '').upper()
    if not ins or not mut_bases:
        return -1
    seq = _junction_align_track_seq(mut_bases)
    intron_start = len(_junction_align_leading_exon_bases(mut_bases))

    pos = seq.find(ins, max(intron_start, 0))
    if pos >= 0:
        gt_idx = pos + len(ins)
        if gt_idx + 1 < len(seq) and seq[gt_idx:gt_idx + 2] == 'GT':
            return gt_idx

    ins_len = len(ins)
    min_before_gt = max(8, ins_len - 4)
    best_gt = -1
    best_match = 0
    for gt_i in range(max(intron_start + min_before_gt, intron_start), len(seq) - 1):
        if seq[gt_i:gt_i + 2] != 'GT':
            continue
        retained = seq[intron_start:gt_i]
        for skip in range(0, 4):
            chunk = retained[skip:]
            match_len = min(len(chunk), ins_len)
            if match_len >= ins_len - 4 and chunk[:match_len] == ins[:match_len]:
                if match_len > best_match:
                    best_match = match_len
                    best_gt = gt_i
    return best_gt


def _junction_align_intronic_scan_range(mut_bases, *, is_donor=True, layout=''):
    """Index range [lo, hi) for scanning splice dinucleotides on a pre-mRNA track."""
    n = len(mut_bases or [])
    if n < 2:
        return 0, 0
    layout_l = str(layout or '').lower()
    if layout_l == 'exon_internal':
        return 0, n - 1
    if layout_l == 'acceptor_junction' or (not is_donor and layout_l != 'donor_junction'):
        ex_start = next(
            (i for i, b in enumerate(mut_bases) if (b.get('kind') or '') == 'exon'),
            n,
        )
        return 0, max(ex_start - 1, 0)
    lo = len(_junction_align_leading_exon_bases(mut_bases))
    return lo, n - 1


def _junction_align_mark_intronic_splice_dinucs(
    mut_bases,
    *,
    is_donor=True,
    primary_gain_idx=-1,
    intron_start=None,
    intron_end=None,
    layout='',
):
    """
    Yellow-highlight every GT (donor) or AG (acceptor) in the intronic window.

    The SpliceAI primary gain index (green splice_gain marker) is excluded so it
    remains the only cryptic-gain callout; other dinucleotides are context only.
    """
    if not mut_bases:
        return mut_bases
    dinuc = 'GT' if is_donor else 'AG'
    splice_kind = 'splice_gt' if is_donor else 'splice_ag'
    if intron_start is None or intron_end is None:
        scan_lo, scan_hi = _junction_align_intronic_scan_range(
            mut_bases, is_donor=is_donor, layout=layout,
        )
    else:
        scan_lo = max(int(intron_start or 0), 0)
        scan_hi = int(intron_end if intron_end is not None else len(mut_bases) - 1)
    skip = set()
    if primary_gain_idx >= 0:
        skip.add(primary_gain_idx)
        skip.add(primary_gain_idx + 1)
    out = [dict(b) for b in mut_bases]
    for i in range(scan_lo, min(scan_hi, len(out) - 1)):
        if i in skip:
            continue
        n0 = (out[i].get('nt') or '').upper()
        n1 = (out[i + 1].get('nt') or '').upper()
        if n0 + n1 != dinuc:
            continue
        if (out[i].get('kind') or '') in ('exon', 'exon_deleted', 'deleted'):
            continue
        out[i] = dict(out[i], kind=splice_kind)
        out[i + 1] = dict(out[i + 1], kind=splice_kind)
    return out


def _junction_align_cryptic_gain_on_exon_skip_mutant(mut_tr, ctx, parsed_data, co_sec=None, *, is_don=True):
    """
    Reuse the primary exon-skip pre-mRNA window; overlay cryptic splice markers only.

    Snap to GT/AG near the predicted site — never blindly highlight the +bp label.
    """
    mut_bases = [dict(b) for b in (mut_tr.get('bases') or [])]
    if not mut_bases:
        return None

    co_sec = co_sec or {}
    anchor_c = ctx.get('anchor_c') or parsed_data.get('snpeff_cds_pos')
    exon_end = len(_junction_align_leading_exon_bases(mut_bases))

    center = -1
    cryptic_hgvs = _junction_align_hgvs_at_marker(ctx, 'splice_gain')
    if not cryptic_hgvs:
        for b in ctx.get('mut_bases') or []:
            if (b.get('kind') or '') in ('splice_gt', 'splice_gain') and (b.get('hgvs') or '').strip():
                cryptic_hgvs = b['hgvs'].strip()
                break
    if cryptic_hgvs:
        center = _junction_align_bases_hgvs_index(mut_bases, cryptic_hgvs)

    min_idx = exon_end + (1 if is_don else 0)
    cryptic_idx = _junction_align_snap_cryptic_gain_index(
        mut_bases, center,
        is_donor=is_don,
        min_idx=min_idx,
        inserted_cdna=co_sec.get('inserted_cdna'),
        parsed_data=parsed_data,
        anchor_c=anchor_c,
    )

    canon_idx = exon_end
    if canon_idx >= len(mut_bases):
        canon_idx = max(len(mut_bases) - 1, 0)

    if is_don:
        loss_lbl = 'canonical GT lost (donor loss)'
        gain_lbl = 'cryptic GT gained'
        gain_kind = 'splice_gt'
    else:
        loss_lbl = 'canonical AG lost (acceptor loss)'
        gain_lbl = 'cryptic AG gained'
        gain_kind = 'splice_ag'

    markers = [{
        'index': min(max(canon_idx, 0), max(len(mut_bases) - 1, 0)),
        'kind': 'splice_loss',
        'label': loss_lbl,
    }]
    if cryptic_idx >= 0:
        for j in range(cryptic_idx, min(cryptic_idx + 2, len(mut_bases))):
            mut_bases[j] = dict(mut_bases[j], kind=gain_kind)
        markers.append({'index': cryptic_idx, 'kind': 'splice_gain', 'label': gain_lbl})

    scan_lo, scan_hi = _junction_align_intronic_scan_range(
        mut_bases, is_donor=is_don, layout='donor_junction' if is_don else 'acceptor_junction',
    )
    mut_bases = _junction_align_mark_intronic_splice_dinucs(
        mut_bases,
        is_donor=is_don,
        primary_gain_idx=cryptic_idx,
        intron_start=scan_lo,
        intron_end=scan_hi,
    )

    return mut_bases, markers


def _junction_align_secondary_cryptic_product_bases(mut_tr, co_sec, ctx):
    """Mature mRNA product: exon prefix from the primary skip track + retained intron body."""
    exon = _junction_align_leading_exon_bases(mut_tr.get('bases') or [])
    ins = str(co_sec.get('inserted_cdna') or '').upper()
    if not exon or not ins:
        return ctx.get('product_bases')
    try:
        last_hgvs = (exon[-1].get('hgvs') or '').strip()
        m = re.search(r'c\.(\d+)', last_hgvs)
        prefix_end = int(m.group(1)) if m else int(ctx.get('anchor_c') or 0)
    except (TypeError, ValueError):
        prefix_end = int(ctx.get('anchor_c') or 0)
    product = list(exon)
    for i, nt in enumerate(ins):
        product.append({
            'nt': nt,
            'kind': 'exon_extension',
            'hgvs': f'c.{prefix_end}+{1 + i}' if prefix_end else '',
        })
    return product


def _junction_align_schematic_secondary_gain_tracks(parsed_data):
    """
    Fallback secondary gain tracks when the cryptic resolver could not attach ctx
    but SpliceAI gain still qualifies (e.g. transient Ensembl failure on first pass).
    Reuses the primary exon-skip junction geometry and adds a retained-intron product.
    """
    if not parsed_data.get('spliceai_exon_skip_spliceai_primary'):
        return []
    cons = _effective_splice_consequence(parsed_data) or ''
    c_dot = (parsed_data.get('c_dot') or '').lower()
    is_don = _consequence_is_donor_splice(cons, c_dot)
    is_acc = _consequence_is_acceptor_splice(cons, c_dot)
    try:
        dg = float(parsed_data.get('spliceai_ds_dg') or 0.0)
        ag = float(parsed_data.get('spliceai_ds_ag') or 0.0)
    except (TypeError, ValueError):
        return []
    gain_ds, _, gain_lbl = _secondary_cryptic_gain_signal(parsed_data, is_don, is_acc, dg, ag)
    if gain_ds < SPLICEAI_RECONCILE_MIN:
        return []

    skip_payload = _junction_align_payload_exon_skip_loss(parsed_data)
    if not skip_payload.get('eligible'):
        return []
    ref_tr = next((t for t in skip_payload.get('tracks') or [] if t.get('id') == 'reference'), None)
    mut_tr = next((t for t in skip_payload.get('tracks') or [] if t.get('id') == 'mutant'), None)
    if not ref_tr or not mut_tr:
        return []

    mut_bases = mut_tr.get('bases') or []
    retained_nt = 0
    co_sec = parsed_data.get('spliceai_secondary_cryptic_outcome') or {}
    if co_sec.get('shift_nt') is not None:
        try:
            retained_nt = abs(int(co_sec['shift_nt']))
        except (TypeError, ValueError):
            retained_nt = 0
    if retained_nt <= 0:
        c_dot = (parsed_data.get('c_dot') or '').lower()
        hgvs_m = _deep_intronic_hgvs_minus_offset(c_dot)
        dp = _parse_spliceai_dp(parsed_data.get('spliceai_dp_ag'))
        if hgvs_m is not None and dp is not None:
            try:
                retained_nt = abs(int(hgvs_m) + int(dp))
            except (TypeError, ValueError):
                retained_nt = 0
    gain_bases = []
    ext_start = None
    for i, b in enumerate(mut_bases):
        kind = b.get('kind') or 'intron'
        if kind in ('exon', 'splice_gt'):
            gain_bases.append(dict(b))
        elif kind in ('intron', 'splice_gain', 'splice_loss', 'variant'):
            nb = dict(b)
            nb['kind'] = 'exon_extension_intronic'
            gain_bases.append(nb)
            if ext_start is None and kind in ('intron', 'splice_gain'):
                ext_start = len(gain_bases) - 1
    if ext_start is None:
        return []
    if retained_nt > 0:
        ext_end = ext_start
        while ext_end < len(gain_bases) and gain_bases[ext_end].get('kind') == 'exon_extension_intronic':
            ext_end += 1
        body_len = ext_end - ext_start
        if body_len > retained_nt:
            trim = body_len - retained_nt
            ext_start += trim
            gain_bases = gain_bases[:ext_start] + gain_bases[ext_start + trim:]
            ext_end = ext_start + retained_nt

    return [{
        'id': 'mutant_cryptic_secondary',
        'title': f'Mutant pre-mRNA (secondary {gain_lbl}, schematic)',
        'kind': 'premrna',
        'bases': mut_bases,
        'spans': mut_tr.get('spans') or [],
        'markers': mut_tr.get('markers') or [],
        'note': 'Schematic — cryptic gain geometry from junction map; sequence-level product unresolved.',
    }, {
        'id': 'cryptic_gain_secondary',
        'title': f'Secondary product — cryptic {gain_lbl} (retained intronic extension)',
        'kind': 'mature',
        'summary': '',
        'note': (
            f'SpliceAI {gain_lbl}: intronic sequence retained in mature mRNA '
            f'(schematic product when full cryptic geometry could not be fetched).'
        ),
        'bases': gain_bases,
        'spans': [{
            'start': ext_start,
            'end': len(gain_bases),
            'kind': 'exon_extension',
            'label': 'retained intron (gain)',
        }],
        'markers': [],
    }]


def _splice_viz_secondary_gain_schematic_fields(parsed_data):
    """
    Infer junction-row geometry for the exon strip map when exon-skip is primary and
    SpliceAI secondary gain is flagged but cryptic resolution did not attach shift_nt.
    """
    if not (
        parsed_data.get('spliceai_exon_skip_spliceai_primary')
        and parsed_data.get('spliceai_secondary_gain_product')
    ):
        return {}
    co_sec = parsed_data.get('spliceai_secondary_cryptic_outcome') or {}
    if co_sec.get('shift_nt') is not None and not co_sec.get('minimal_signal'):
        try:
            sh = int(co_sec['shift_nt'])
            return {
                'shift_nt': sh,
                'pseudoexon_retained_nt': abs(sh) if sh else None,
            }
        except (TypeError, ValueError):
            pass
    tracks = _junction_align_schematic_secondary_gain_tracks(parsed_data)
    if not tracks:
        return {}
    mature = next((t for t in tracks if t.get('id') == 'cryptic_gain_secondary'), None)
    if not mature:
        return {}
    spans = mature.get('spans') or []
    bases = mature.get('bases') or []
    retained_nt = 0
    if spans:
        try:
            ext_start = int(spans[0].get('start') or 0)
            ext_end = int(spans[0].get('end') or len(bases))
            retained_nt = sum(
                1 for b in bases[ext_start:ext_end]
                if (b.get('kind') or '') in ('exon_extension_intronic', 'intron', 'splice_gain')
            )
        except (TypeError, ValueError):
            retained_nt = 0
    if retained_nt <= 0:
        retained_nt = sum(
            1 for b in bases if (b.get('kind') or '') == 'exon_extension_intronic'
        )
    if retained_nt <= 0:
        return {}
    return {
        'shift_nt': retained_nt,
        'pseudoexon_retained_nt': retained_nt,
        'schematic_secondary': True,
    }


def _junction_align_secondary_cryptic_gain_products(parsed_data):
    """Cryptic donor/acceptor gain tracks when whole-exon skip is the primary junction map."""
    co_sec = parsed_data.get('spliceai_secondary_cryptic_outcome') or {}
    ctx = co_sec.get('junction_align_ctx')
    if not ctx or co_sec.get('minimal_signal'):
        return _junction_align_schematic_secondary_gain_tracks(parsed_data)

    cons = (_effective_splice_consequence(parsed_data) or '').lower()
    c_dot = (parsed_data.get('c_dot') or '').lower()
    is_don = _consequence_is_donor_splice(cons, c_dot)
    is_acc = _consequence_is_acceptor_splice(cons, c_dot)
    try:
        ds_dg = float(parsed_data.get('spliceai_ds_dg') or 0.0)
        ds_ag = float(parsed_data.get('spliceai_ds_ag') or 0.0)
    except (TypeError, ValueError):
        ds_dg = ds_ag = 0.0

    _, _, gain_lbl = _secondary_cryptic_gain_signal(
        parsed_data, is_don, is_acc, ds_dg, ds_ag,
    )

    extras = []
    skip_payload = _junction_align_payload_exon_skip_loss(parsed_data)
    mut_tr = None
    if skip_payload.get('eligible'):
        mut_tr = next(
            (t for t in skip_payload.get('tracks') or [] if t.get('id') == 'mutant'),
            None,
        )

    if mut_tr:
        overlay = _junction_align_cryptic_gain_on_exon_skip_mutant(
            mut_tr, ctx, parsed_data, co_sec, is_don=(is_don and not is_acc),
        )
        if overlay:
            mut_bases, mut_markers = overlay
            extras.append({
                'id': 'mutant_cryptic_secondary',
                'title': 'Mutant pre-mRNA (cryptic splice)',
                'kind': 'premrna',
                'bases': mut_bases,
                'spans': list(mut_tr.get('spans') or []),
                'markers': mut_markers,
                'dup_seq': ctx.get('dup_seq'),
            })
        prod_bases = _junction_align_secondary_cryptic_product_bases(mut_tr, co_sec, ctx)
    else:
        prod_bases = ctx.get('product_bases')
        mut_bases = [dict(b) for b in (ctx.get('mut_bases') or [])]
        mut_markers = list(ctx.get('mut_markers') or [])
        mut_bases, mut_markers = _junction_align_refresh_gain_markers(
            mut_bases, mut_markers,
            parsed_data=parsed_data, co=co_sec,
            layout=ctx.get('layout') or '',
            is_donor=(is_don and not is_acc),
        )
        if mut_bases:
            extras.append({
                'id': 'mutant_cryptic_secondary',
                'title': ctx.get('mut_title') or f'Mutant pre-mRNA (secondary {gain_lbl})',
                'kind': 'premrna',
                'bases': mut_bases,
                'spans': ctx.get('mut_spans') or [],
                'markers': ctx.get('mut_markers') or [],
                'dup_seq': ctx.get('dup_seq'),
            })

    ins = str(co_sec.get('inserted_cdna') or '')
    prod_origin = _junction_align_track_origin_from_bases(prod_bases)
    prod = _junction_align_product_from_co(
        co_sec,
        title=f'Secondary product — cryptic {gain_lbl}',
        note=(co_sec.get('narrative') or '')[:200],
        bases=prod_bases,
        span_label=f'+{len(ins)} nt' if ins else '',
        track_origin_cds_0based=prod_origin,
    )
    if prod:
        prod['id'] = 'cryptic_gain_secondary'
        extras.append(prod)
    return extras


def _junction_align_secondary_products(parsed_data, ctx):
    """Parallel SpliceAI loss (exon skip) products alongside cryptic-gain primary maps."""
    cons = _effective_splice_consequence(parsed_data) or (parsed_data.get('consequence') or '')
    c_dot = (parsed_data.get('c_dot') or '').lower()
    extras = []
    if _consequence_is_donor_splice(cons, c_dot):
        extras.extend(_junction_align_secondary_products_for_donor(parsed_data, ctx))
    elif _consequence_is_acceptor_splice(cons, c_dot):
        extras.extend(_junction_align_secondary_products_for_acceptor(parsed_data, ctx))
    return extras


def _junction_align_secondary_parallel_exon_skip_products(parsed_data):
    """
    SpliceAI parallel whole-exon skip at a second site in the same intron
    (e.g. upstream donor loss when acceptor skip is primary).
    """
    extras = []
    sec_rank = parsed_data.get('spliceai_secondary_exon_rank')
    sec_math = (parsed_data.get('spliceai_secondary_splice_frame_math') or '').strip()
    if sec_rank is None or not sec_math:
        return extras
    try:
        sec_rank_i = int(sec_rank)
    except (TypeError, ValueError):
        return extras
    coding_exons = parsed_data.get('coding_exons') or []
    cx = next(
        (c for c in coding_exons if int(c.get('anatomical_rank') or 0) == sec_rank_i),
        None,
    )
    if not cx:
        return extras
    mech = (parsed_data.get('spliceai_secondary_mechanism') or '').strip()
    ag, al, dg, dl = _spliceai_scores_4(parsed_data)
    note = f'Parallel SpliceAI hypothesis ({mech or "secondary skip"}). '
    if mech == '5prime_donor_loss':
        note += f'DS_DL {float(dl or 0):.2f}.'
    elif mech == '3prime_acceptor_loss':
        note += f'DS_AL {float(al or 0):.2f}.'
    else:
        note += (
            f'DS_AL {float(al or 0):.2f}, DS_DL {float(dl or 0):.2f}.'
        )
    summary = (
        parsed_data.get('spliceai_secondary_donor_exon_skip_oof_fs_ter')
        or parsed_data.get('spliceai_secondary_donor_exon_skip_predicted_hgvs_p')
        or ''
    )
    prod = _junction_align_exon_skip_product_track(
        parsed_data,
        cx,
        track_id='exon_skip_parallel_secondary',
        title=f'Parallel product — exon {sec_rank_i} skipped ({mech or "secondary site"})',
        note=note,
        summary=str(summary).strip(),
        field_prefix='spliceai_secondary_donor_',
    )
    if prod:
        extras.append(prod)
    return extras


def _junction_align_merge_secondary_tracks(parsed_data, payload, ctx=None, primary_kind='cryptic'):
    """Attach all SpliceAI-qualified secondary junction tracks not already on the payload."""
    if not payload or not payload.get('eligible'):
        return payload
    tracks = payload.setdefault('tracks', [])
    existing_ids = {t.get('id') for t in tracks if isinstance(t, dict)}

    def _extend(new_tracks):
        for t in new_tracks or []:
            tid = t.get('id')
            if tid and tid not in existing_ids:
                tracks.append(t)
                existing_ids.add(tid)

    if ctx and primary_kind in ('cryptic', 'deep_intronic', 'cryptic_gain'):
        _extend(_junction_align_secondary_products(parsed_data, ctx))
    if primary_kind == 'exon_skip':
        _extend(_junction_align_secondary_cryptic_gain_products(parsed_data))
    _extend(_junction_align_secondary_parallel_exon_skip_products(parsed_data))
    return payload


def _normalize_deep_intronic_acceptor_outcomes(parsed_data):
    """Repair acceptor-gain inserted_cdna / shift_nt before junction map build (cached or live)."""
    if not parsed_data.get('deep_intronic_splice_products_active'):
        return False
    cds = (parsed_data.get('cds_seq') or '').upper()
    if not cds:
        return False
    di = parsed_data.get('deep_intronic_splice') or {}
    details = di.get('details') or {}
    mut_seq = (details.get('mut_intron_tx_seq') or details.get('wt_intron_tx_seq') or '').upper()
    coding_exons = parsed_data.get('coding_exons') or []
    cx_up = _deep_intronic_upstream_exon_for_acceptor_side(parsed_data, coding_exons, details)
    try:
        ds0 = int(cx_up.get('end_cds') or 0) if cx_up else 0
    except (TypeError, ValueError):
        ds0 = 0
    changed = False
    for key in (
        'deep_intronic_primary_outcome',
        'deep_intronic_acceptor_next_outcome',
        'deep_intronic_alternate_outcome',
    ):
        co = parsed_data.get(key)
        if not isinstance(co, dict):
            continue
        if 'acceptor' not in str(co.get('cryptic_type') or '').lower():
            continue
        ins_raw = (co.get('inserted_cdna') or '').upper()
        if not ins_raw:
            continue
        geom = co.get('pseudoexon_geometry') or {}
        ins = _acceptor_gain_mature_retained_body(
            ins_raw,
            mut_seq=mut_seq,
            picked_ag=geom,
            cds_seq=cds,
            downstream_start_0=ds0,
            target_body_nt=co.get('shift_nt') or geom.get('body_nt'),
        )
        if not ins:
            continue
        if ins != ins_raw or co.get('shift_nt') != len(ins):
            co['inserted_cdna'] = ins
            co['shift_nt'] = len(ins)
            if geom.get('body_nt') != len(ins):
                geom = dict(geom)
                geom['body_nt'] = len(ins)
                co['pseudoexon_geometry'] = geom
            changed = True
    if changed and parsed_data.get('deep_intronic_primary_outcome'):
        _sync_deep_intronic_primary_to_cryptic_fields(parsed_data)
    return changed


def _build_junction_align_payload(parsed_data):
    """
    Nucleotide-level junction alignment for cryptic splice, deep intronic,
    and canonical whole-exon skip products.
    """
    out = {'eligible': False, 'reason': ''}
    cds = (parsed_data.get('cds_seq') or '').upper()
    coding_exons = parsed_data.get('coding_exons') or []
    if not cds or not coding_exons:
        out['reason'] = 'CDS / exon map unavailable for junction alignment.'
        return out

    # Variant-anchored SpliceAI donor/acceptor loss (exon skip) outranks deep-intronic
    # schematic maps and stale cryptic-primary geometry (e.g. MAOA c.955+5G>A).
    if parsed_data.get('spliceai_exon_skip_spliceai_primary'):
        skip_payload = _junction_align_payload_exon_skip_loss(parsed_data)
        if skip_payload.get('eligible'):
            return _junction_align_merge_secondary_tracks(
                parsed_data, skip_payload, primary_kind='exon_skip',
            )

    if parsed_data.get('deep_intronic_splice_products_active'):
        _reconcile_deep_intronic_pre_atg_outcome(parsed_data)
        _normalize_deep_intronic_acceptor_outcomes(parsed_data)

    di = parsed_data.get('deep_intronic_splice') or {}
    details = di.get('details') or {}
    if (
        parsed_data.get('deep_intronic_splice_products_active')
        and di.get('eligible')
        and details.get('wt_intron_tx_seq')
    ):
        di_payload = _junction_align_payload_deep_intronic(parsed_data)
        if di_payload.get('eligible'):
            di_ctx = None
            try:
                ve = int(parsed_data.get('variant_exon') or 0)
            except (TypeError, ValueError):
                ve = 0
            if ve > 0:
                cx_ve = next(
                    (
                        c for c in (parsed_data.get('coding_exons') or [])
                        if int(c.get('anatomical_rank') or 0) == ve
                    ),
                    None,
                )
                if cx_ve:
                    di_ctx = {
                        'exon_rank': ve,
                        'anchor_c': cx_ve.get('start_cds'),
                        'upstream_exon': max(0, ve - 1),
                    }
            return _junction_align_merge_secondary_tracks(
                parsed_data, di_payload, ctx=di_ctx, primary_kind='deep_intronic',
            )

    co = parsed_data.get('cryptic_splice_outcome') or {}
    ctx = co.get('junction_align_ctx') or parsed_data.get('junction_align_viz_ctx')
    if ctx and co and not co.get('minimal_signal'):
        payload = _junction_align_payload_from_ctx(parsed_data, ctx, co, extra_products=[])
        return _junction_align_merge_secondary_tracks(
            parsed_data, payload, ctx=ctx, primary_kind='cryptic',
        )

    cg = parsed_data.get('cryptic_gain_outcome') or {}
    ctx = cg.get('junction_align_ctx')
    if ctx:
        payload = _junction_align_payload_from_ctx(parsed_data, ctx, cg, extra_products=[])
        return _junction_align_merge_secondary_tracks(
            parsed_data, payload, ctx=ctx, primary_kind='cryptic_gain',
        )

    if di.get('eligible') and details.get('wt_intron_tx_seq'):
        di_payload = _junction_align_payload_deep_intronic(parsed_data)
        if di_payload.get('eligible'):
            di_ctx = None
            try:
                ve = int(parsed_data.get('variant_exon') or 0)
            except (TypeError, ValueError):
                ve = 0
            if ve > 0:
                cx_ve = next(
                    (
                        c for c in coding_exons
                        if int(c.get('anatomical_rank') or 0) == ve
                    ),
                    None,
                )
                if cx_ve:
                    di_ctx = {
                        'exon_rank': ve,
                        'anchor_c': cx_ve.get('start_cds'),
                        'upstream_exon': max(0, ve - 1),
                    }
            return _junction_align_merge_secondary_tracks(
                parsed_data, di_payload, ctx=di_ctx, primary_kind='deep_intronic',
            )
        out['reason'] = di_payload.get('reason') or out['reason']

    skip_payload = _junction_align_payload_exon_skip_loss(parsed_data)
    if skip_payload.get('eligible'):
        return _junction_align_merge_secondary_tracks(
            parsed_data, skip_payload, primary_kind='exon_skip',
        )

    if co.get('minimal_signal') and (
        (parsed_data.get('splice_frame_math') or '').strip()
        or parsed_data.get('exon_skip_oof_fs_ter')
    ):
        skip_fallback = _junction_align_payload_exon_skip_loss(parsed_data)
        if skip_fallback.get('eligible'):
            return _junction_align_merge_secondary_tracks(
                parsed_data, skip_fallback, primary_kind='exon_skip',
            )

    if co.get('minimal_signal'):
        out['reason'] = 'Cryptic splice predicted but sequence geometry could not be resolved for the map.'
    elif di.get('eligible'):
        out['reason'] = 'Intron sequence unavailable for junction alignment.'
    else:
        out['reason'] = (
            'Junction map needs a resolved cryptic splice outcome, deep-intronic intron sequence, '
            'or whole-exon skip model.'
        )
    return out


# ---------------------------------------------------------------------------
# Splice exon map — unified product rules (every variant class)
# ---------------------------------------------------------------------------
# 1. Reference row always (when eligible).
# 2. Loss/skip row: variant exon striped (whole-exon skip product).
# 3. Gain/junction row: ONE renderer — anchor exon preserved, +N nt pseudo-exon
#    after anchor when shift_nt > 0 or pseudoexon_retained_nt is set (exon-internal
#    cryptic uses cut fraction instead).
# 4. Parallel skip2 row: different exon (secondary_target_rank), yellow stripe.
# 5. Row order: primary product first (loss-primary → skip then gain; gain-primary
#    or junction_preferred → gain then skip; competing → stronger site delta).
# 6. primary / secondary / competing labels are metadata only — geometry is identical.
# ---------------------------------------------------------------------------


def _splice_viz_has_gain_row(parsed_data, co_viz, co_sec, shift, cg_junction, schematic_fields):
    """Whether to emit the gain/junction isoform row — same gate for all variant classes."""
    if cg_junction:
        return True
    if parsed_data.get('nmd_junction_model_truncation_fraction') is not None:
        return True
    if parsed_data.get('spliceai_junction_model_preferred'):
        return True
    if parsed_data.get('spliceai_competing_splice_isoforms'):
        return True
    if co_viz and not co_viz.get('minimal_signal') and shift is not None:
        return True
    if (
        co_sec
        and not co_sec.get('minimal_signal')
        and (co_sec.get('shift_nt') is not None or co_sec.get('junction_align_ctx'))
    ):
        return True
    return bool(schematic_fields)


def _splice_viz_apply_gain_row_geometry(
    parsed_data,
    *,
    has_gain_row,
    shift,
    tr,
    ex_ic,
    viz_don,
    viz_acc,
    anchor_exon_rank,
    next_exon_rank,
    donor_offset_1based,
    pseudo_retained_nt,
    schematic_fields,
):
    """
    Resolve pseudo-exon placement for the gain/junction strip — one rule set for
    gain-primary, loss-primary secondary gain, competing, and schematic fallback.
    """
    if not has_gain_row or ex_ic or tr is None:
        return anchor_exon_rank, next_exon_rank, donor_offset_1based, pseudo_retained_nt

    if pseudo_retained_nt is None and shift is not None:
        try:
            sh = int(shift)
            if sh > 0:
                pseudo_retained_nt = sh
        except (TypeError, ValueError):
            pass
    if pseudo_retained_nt is None and schematic_fields.get('pseudoexon_retained_nt') is not None:
        try:
            pseudo_retained_nt = int(schematic_fields['pseudoexon_retained_nt'])
        except (TypeError, ValueError):
            pass

    if pseudo_retained_nt is not None and anchor_exon_rank is None:
        try:
            sh_pos = int(shift) if shift is not None else 0
        except (TypeError, ValueError):
            sh_pos = 0
        if viz_acc and not viz_don and sh_pos > 0 and int(tr) > 1:
            anchor_exon_rank = int(tr) - 1
            next_exon_rank = int(tr)
        else:
            anchor_exon_rank = int(tr)
            if next_exon_rank is None:
                try:
                    next_exon_rank = int(tr) + 1
                except (TypeError, ValueError):
                    pass
        if donor_offset_1based is None and viz_don and not viz_acc:
            donor_offset_1based = 1

    return anchor_exon_rank, next_exon_rank, donor_offset_1based, pseudo_retained_nt


def _build_splice_viz_payload(parsed_data):
    """
    JSON for exon-strip diagram: reference row for every mapped transcript;
    optional isoform rows (skip / junction) when splice context applies.
    """
    splice_mode = _splice_viz_should_include(parsed_data)
    _ensure_coding_exons_for_splice_viz(parsed_data)
    if parsed_data.get('deep_intronic_splice_products_active'):
        _reconcile_deep_intronic_pre_atg_outcome(parsed_data)
    ce = parsed_data.get('coding_exons')
    if not ce or not isinstance(ce, list):
        return {
            'eligible': False,
            'reason': 'Exon map unavailable (need ENST + transcript exons). Map appears once a transcript is mapped.',
        }
    try:
        rows = sorted(ce, key=lambda x: int(x.get('anatomical_rank') or 0))
    except (TypeError, ValueError):
        return {
            'eligible': False,
            'reason': 'Exon map could not be sorted (invalid anatomical_rank on coding exons).',
        }
    if not rows:
        return {
            'eligible': False,
            'reason': 'No coding exons mapped on this transcript.',
        }

    tr = _splice_viz_resolve_target_rank(parsed_data, rows)
    if tr is not None:
        parsed_data.setdefault('variant_exon', tr)

    cons = _effective_splice_consequence(parsed_data)
    lcons = (cons or '').lower()
    c_d_v = parsed_data.get('c_dot') or ''
    exons_full = _splice_viz_exons_full_mrna(parsed_data, rows)
    total_exons_full = len(exons_full)
    try:
        last_anat = max(int(e['rank']) for e in exons_full) if exons_full else int(rows[-1].get('anatomical_rank') or 0)
    except (TypeError, ValueError):
        last_anat = 0
    variant_marker = (
        _compute_splice_viz_variant_marker(parsed_data, cons, c_d_v, tr, last_anat)
        if tr is not None
        else None
    )

    if not splice_mode:
        ref_focus = _splice_viz_focus_window(exons_full, tr, 2) if tr is not None else None
        ptc_markers = _build_splice_viz_ptc_markers(parsed_data, False, False)
        out = {
            'eligible': True,
            'reference_only': True,
            'gene': (parsed_data.get('gene_symbol') or parsed_data.get('gene') or '') or '',
            'exons_full': exons_full,
            'total_exons_full': total_exons_full,
            'target_rank': tr,
            'variant_marker': variant_marker,
            'hgvs_c_for_viz': (c_d_v or '').strip(),
            'is_donor': _consequence_is_donor_splice(cons, c_d_v),
            'is_acceptor': _consequence_is_acceptor_splice(cons, c_d_v),
            'ptc_markers': ptc_markers,
        }
        if ref_focus:
            out['focus_primary'] = ref_focus
        ref_ptc = ptc_markers.get('reference')
        if ref_ptc:
            out['has_reference_ptc'] = True
            out['reference_ptc_location_kind'] = 'coding_exon'
            er = ref_ptc.get('exon_rank')
            if er is not None:
                out['reference_ptc_location_label'] = f'native coding exon {er}'
                if ref_ptc.get('fraction_in_exon') is not None:
                    try:
                        out['reference_ptc_location_detail'] = (
                            f"~{round(float(ref_ptc['fraction_in_exon']) * 100)}% along exon {er} box"
                        )
                    except (TypeError, ValueError):
                        pass
        return out

    if tr is None:
        return {
            'eligible': False,
            'reason': 'Could not map HGVS c. to an mRNA exon on this transcript (needed to center the skip / junction model).',
        }

    co = parsed_data.get('cryptic_splice_outcome') or {}
    co_sec = parsed_data.get('spliceai_secondary_cryptic_outcome') or {}
    co_viz = co if (co and not co.get('minimal_signal')) else {}
    if not co_viz and co_sec and not co_sec.get('minimal_signal'):
        co_viz = co_sec
    cg = parsed_data.get('cryptic_gain_outcome') or {}
    shift = co_viz.get('shift_nt')
    ex_ic = bool(parsed_data.get('splice_viz_exon_internal_cryptic'))
    try:
        cg_dn = int(cg.get('deleted_nt') or 0)
    except (TypeError, ValueError):
        cg_dn = 0
    cg_junction = ex_ic and cg_dn > 0

    # Where inside the variant exon the cryptic GT/AG sits — used by the splice
    # viz JS to draw a vertical cut line on the mRNA exon box and shade the
    # spliced-out portion. Without this, an exon-internal cryptic donor gain
    # (e.g. NLRP3 c.2798G>T) renders as a full-length E8 in the mRNA strip,
    # which reads as if E8 is preserved when in fact the 3' tail is excised.
    ei_cut_fraction = None
    ei_cut_side = None
    ei_cut_exon_rank = None
    if ex_ic and cg_dn > 0:
        try:
            new_site_cdna = int(cg.get('new_site_cdna') or 0)
        except (TypeError, ValueError):
            new_site_cdna = 0
        for _cx in (parsed_data.get('coding_exons') or []):
            try:
                _es = int(_cx.get('start_cds') or 0)
                _ee = int(_cx.get('end_cds') or 0)
                _er = int(_cx.get('anatomical_rank') or 0)
            except (TypeError, ValueError):
                continue
            if _es > 0 and _ee >= _es and _es <= new_site_cdna <= _ee:
                _exon_len = max(1, _ee - _es + 1)
                _frac = (new_site_cdna - _es + 1) / float(_exon_len)
                ei_cut_fraction = max(0.0, min(1.0, _frac))
                _ct = str(cg.get('cryptic_type') or '').lower()
                ei_cut_side = 'donor' if 'donor' in _ct else (
                    'acceptor' if 'acceptor' in _ct else None
                )
                ei_cut_exon_rank = _er
                break

    if not ex_ic and ei_cut_fraction is None and co_viz and tr is not None:
        try:
            sh_neg = int(co_viz.get('shift_nt') or 0)
        except (TypeError, ValueError):
            sh_neg = 0
        _c_d_j = parsed_data.get('c_dot') or ''
        _cons_j = _effective_splice_consequence(parsed_data)
        if sh_neg < 0 and _consequence_is_acceptor_splice(_cons_j, _c_d_j):
            deleted = abs(sh_neg)
            ex_row = next(
                (e for e in exons_full if int(e.get('rank') or 0) == int(tr)),
                None,
            )
            if ex_row:
                try:
                    ex_len = int(ex_row.get('len_bp') or 0)
                except (TypeError, ValueError):
                    ex_len = 0
                if ex_len > 0:
                    ei_cut_fraction = max(0.03, min(0.97, deleted / float(ex_len)))
                    ei_cut_side = 'acceptor'
                    ei_cut_exon_rank = int(tr)

    _viz_sec_schematic = _splice_viz_secondary_gain_schematic_fields(parsed_data)
    has_j = _splice_viz_has_gain_row(
        parsed_data, co_viz, co_sec, shift, cg_junction, _viz_sec_schematic,
    )
    if shift is None and cg_junction:
        ct = str(cg.get('cryptic_type') or '')
        if ct == 'Acceptor Gain':
            shift = -cg_dn
        elif ct == 'Donor Gain':
            shift = cg_dn
    if shift is None and _viz_sec_schematic.get('shift_nt') is not None:
        try:
            shift = int(_viz_sec_schematic['shift_nt'])
        except (TypeError, ValueError):
            pass
    in_fr = parsed_data.get('splice_is_in_frame')
    if in_fr is not None:
        in_fr = bool(in_fr)
    c_d_v = parsed_data.get('c_dot') or ''
    is_acc = _consequence_is_acceptor_splice(cons, c_d_v)
    is_don = _consequence_is_donor_splice(cons, c_d_v)
    if is_acc:
        site = 'acceptor'
    elif is_don:
        site = 'donor'
    elif 'intron_variant' in lcons or parsed_data.get('deep_intronic_splice', {}).get('eligible'):
        site = 'intronic'
    elif 'splice_region' in lcons:
        site = 'splice_region'
    else:
        site = 'splice'
    j_pref = bool(parsed_data.get('spliceai_junction_model_preferred'))
    comp = bool(parsed_data.get('spliceai_competing_splice_isoforms'))
    viz_acc = is_acc or (str(cg.get('cryptic_type') or '') == 'Acceptor Gain')
    viz_don = is_don or (str(cg.get('cryptic_type') or '') == 'Donor Gain')
    suppress_skip_strip = ex_ic
    if (
        (not suppress_skip_strip)
        and j_pref
        and (not comp)
        and parsed_data.get('spliceai_fetched')
        and not parsed_data.get('splice_api_error')
    ):
        _agv, _alv, _dgv, _dlv = _spliceai_scores_4(parsed_data)
        if viz_acc and (not viz_don) and float(_alv or 0) < SPLICEAI_RECONCILE_MIN:
            suppress_skip_strip = True
        elif viz_don and (not viz_acc) and float(_dlv or 0) < SPLICEAI_RECONCILE_MIN:
            suppress_skip_strip = True
    if not has_j:
        # Reference + whole-exon-skip (loss) model only
        row_order = 'ref_skip'
    else:
        # Row order follows SpliceAI: higher gain vs loss delta for acceptor (AG/AL) or donor (DG/DL);
        # if reconcile set spliceai_junction_model_preferred, junction is always first under reference.
        gain_row_first = _spliceai_viz_junction_row_first(parsed_data, viz_acc, viz_don, j_pref)
        row_order = 'ref_junction_skip' if gain_row_first else 'ref_skip_junction'
    sec_rank = None
    sec_in_fr = None
    viz_mech = (parsed_data.get("spliceai_secondary_mechanism") or "").strip() or None
    _ser = parsed_data.get("spliceai_secondary_exon_rank")
    if _ser is not None and str(_ser).strip() != "":
        try:
            sec_rank = int(_ser)
        except (TypeError, ValueError):
            sec_rank = None
    _di_alt_viz = parsed_data.get('deep_intronic_viz_alternate') or {}
    if sec_rank is None and _di_alt_viz.get('exon_rank') is not None:
        try:
            sec_rank = int(_di_alt_viz['exon_rank'])
            viz_mech = _di_alt_viz.get('mechanism') or '5prime_donor_loss'
        except (TypeError, ValueError):
            pass
    if sec_rank is None:
        try:
            vxe = int(parsed_data.get("variant_exon") or 0)
            _m = (parsed_data.get("spliceai_secondary_mechanism") or "").strip()
            if _m == "3prime_acceptor_loss" and vxe > 0:
                sec_rank = vxe + 1
            elif _m == "5prime_donor_loss" and vxe > 1:
                sec_rank = vxe - 1
        except (TypeError, ValueError):
            pass
    if (
        sec_rank is None
        and is_acc
        and (not is_don)
        and tr is not None
        and tr > 1
    ):
        try:
            dl_v = float(parsed_data.get("spliceai_ds_dl") or 0)
        except (TypeError, ValueError):
            dl_v = 0.0
        if dl_v >= 0.15:
            cand = tr - 1
            if any(int(x.get("anatomical_rank", 0) or 0) == cand for x in rows):
                sec_rank = cand
                if not viz_mech:
                    viz_mech = "5prime_donor_loss"
    if (
        sec_rank is None
        and (not is_acc)
        and is_don
        and tr is not None
    ):
        try:
            al_v = float(parsed_data.get("spliceai_ds_al") or 0)
        except (TypeError, ValueError):
            al_v = 0.0
        if al_v >= 0.15:
            _pal_dp = _parse_spliceai_dp(parsed_data.get("spliceai_dp_al"))
            if _pal_dp is not None and _pal_dp < 0:
                cx_dn = None
            else:
                c_sorted = sorted(rows, key=lambda x: int(x.get("anatomical_rank", 0) or 0))
                cx_dn = next(
                    (c for c in c_sorted if int(c.get("anatomical_rank", 0) or 0) > tr),
                    None,
                )
            if cx_dn:
                try:
                    cand2 = int(cx_dn.get("anatomical_rank", 0) or 0)
                except (TypeError, ValueError):
                    cand2 = 0
                if cand2 >= 1:
                    sec_rank = cand2
                    if not viz_mech:
                        viz_mech = "3prime_acceptor_loss"
    if parsed_data.get("spliceai_secondary_donor_oof") is True:
        sec_in_fr = False
    elif parsed_data.get("spliceai_secondary_donor_oof") is False:
        sec_in_fr = True
    if sec_in_fr is None and sec_rank is not None:
        e_sec = next((e for e in exons_full if int(e.get('rank')) == sec_rank), None)
        if e_sec and e_sec.get('len_bp') is not None:
            try:
                lp = int(e_sec['len_bp'])
                if lp > 0:
                    sec_in_fr = (lp % 3 == 0)
            except (TypeError, ValueError):
                pass

    neigh = 2
    focus_primary = _splice_viz_focus_window(exons_full, tr, neigh)
    focus_junction = focus_primary
    focus_secondary = (
        _splice_viz_focus_window(exons_full, sec_rank, neigh) if sec_rank is not None else None
    )

    try:
        last_anat = int(rows[-1].get('anatomical_rank') or 0)
    except (TypeError, ValueError):
        last_anat = 0
    if variant_marker is None:
        variant_marker = _compute_splice_viz_variant_marker(parsed_data, cons, c_d_v, tr, last_anat)
    ptc_markers = _build_splice_viz_ptc_markers(parsed_data, has_j, bool(sec_rank))

    di_products = bool(parsed_data.get('deep_intronic_splice_products_active'))
    if di_products:
        suppress_skip_strip = True

    di_exonization = bool(
        parsed_data.get('deep_intronic_in_frame_exonization')
        or co_viz.get('in_frame_exonization')
    )
    pseudo_insert_nt = None
    if di_exonization and shift is not None:
        try:
            pseudo_insert_nt = int(shift)
        except (TypeError, ValueError):
            pseudo_insert_nt = None
    if di_exonization:
        in_fr = True

    di_viz_pri = parsed_data.get('deep_intronic_viz_primary') or {}
    di_viz_alt = parsed_data.get('deep_intronic_viz_alternate') or {}
    pri_mech = str(di_viz_pri.get('mechanism') or '').strip()
    use_exonization_schematic = bool(
        di_products
        and di_viz_pri.get('anchor_exon_rank') is not None
        and di_viz_pri.get('downstream_exon_rank') is not None
    )
    anchor_exon_rank = di_viz_pri.get('anchor_exon_rank')
    next_exon_rank = di_viz_pri.get('downstream_exon_rank')
    donor_offset_1based = di_viz_pri.get('donor_offset_1based')
    acceptor_offset_1based = di_viz_pri.get('acceptor_offset_1based')
    gt_offset_1based = di_viz_pri.get('gt_offset_1based')
    intronic_skipped_nt = di_viz_pri.get('intronic_skipped_nt')
    pseudo_retained_nt = di_viz_pri.get('pseudoexon_retained_nt')
    if pseudo_retained_nt is not None and pseudo_insert_nt is None:
        try:
            pseudo_insert_nt = int(pseudo_retained_nt)
        except (TypeError, ValueError):
            pass

    co_pri = parsed_data.get('deep_intronic_primary_outcome') or co_viz or {}
    _di_details = (parsed_data.get('deep_intronic_splice') or {}).get('details') or {}
    di_pre_atg_utr = bool(
        parsed_data.get('deep_intronic_pre_atg_utr_pseudoexon')
        or co_pri.get('pre_atg_utr_pseudoexon')
        or di_viz_pri.get('pre_atg_utr')
        or _deep_intronic_cdot_in_pre_first_coding_intron(
            parsed_data.get('c_dot'), parsed_data.get('coding_exons') or [], _di_details,
        )
    )
    anchor_exon_rank, next_exon_rank, donor_offset_1based, pseudo_retained_nt = (
        _splice_viz_apply_gain_row_geometry(
            parsed_data,
            has_gain_row=has_j,
            shift=shift,
            tr=tr,
            ex_ic=ex_ic,
            viz_don=viz_don,
            viz_acc=viz_acc,
            anchor_exon_rank=anchor_exon_rank,
            next_exon_rank=next_exon_rank,
            donor_offset_1based=donor_offset_1based,
            pseudo_retained_nt=pseudo_retained_nt,
            schematic_fields=_viz_sec_schematic,
        )
    )
    if pseudo_retained_nt is not None and not di_pre_atg_utr:
        try:
            if int(pseudo_retained_nt) % 3 != 0:
                di_exonization = False
                in_fr = False
        except (TypeError, ValueError):
            pass
    start_codon_exon_rank = None
    if di_pre_atg_utr:
        di_exonization = False
        in_fr = True
        pseudo_ptc_within = False
        pseudo_ptc_hgvs = None
        pseudo_ptc_aa = None
        _pre_anchor, _pre_dn = _resolve_pre_atg_mrna_exon_ranks(
            parsed_data,
            parsed_data.get('coding_exons') or rows,
            _di_details,
            anchor_exon_rank or co_pri.get('anchor_exon_rank'),
            next_exon_rank or co_pri.get('downstream_exon_rank'),
        )
        anchor_exon_rank = _pre_anchor
        next_exon_rank = _pre_dn
        start_codon_exon_rank = _pre_dn
        variant_marker = {
            'mode': 'intron',
            'upstream_exon': _pre_anchor,
            'downstream_exon': _pre_dn,
        }
        tr = _pre_dn
        use_exonization_schematic = bool(di_products and _pre_anchor and _pre_dn)
        focus_primary = _splice_viz_focus_window(exons_full, tr, neigh)
        focus_junction = focus_primary
        viz_patch = dict(parsed_data.get('deep_intronic_viz_primary') or {})
        viz_patch.update({
            'anchor_exon_rank': _pre_anchor,
            'downstream_exon_rank': _pre_dn,
            'pre_atg_utr': True,
        })
        parsed_data['deep_intronic_viz_primary'] = viz_patch
        di_viz_pri = viz_patch
    else:
        if co_pri.get('fs_ter_str') or co_pri.get('frameshift'):
            di_exonization = False
            in_fr = False
        pseudo_ptc_within = bool(co_pri.get('ptc_within_insert'))
        pseudo_ptc_hgvs = str(co_pri.get('fs_ter_str') or co_pri.get('p_hgvs') or '').strip() or None
        pseudo_ptc_aa = co_pri.get('ptc_aa_position')
    first_ins_aa = co_pri.get('first_insert_aa_pos')
    ins_codons_v = co_pri.get('insert_codons')
    pseudo_ptc_frac_in_insert = co_pri.get('ptc_fraction_in_insert')
    if pseudo_ptc_frac_in_insert is None and pseudo_ptc_within and pseudo_ptc_aa is not None and first_ins_aa is not None and ins_codons_v:
        try:
            ptc_i = int(pseudo_ptc_aa)
            start_i = int(first_ins_aa)
            ic = int(ins_codons_v)
            if ic > 0 and ptc_i >= start_i:
                pseudo_ptc_frac_in_insert = round((ptc_i - start_i + 0.5) / float(ic), 4)
                pseudo_ptc_frac_in_insert = min(0.97, max(0.03, pseudo_ptc_frac_in_insert))
        except (TypeError, ValueError):
            pass

    co_alt_out = parsed_data.get('deep_intronic_alternate_outcome') or {}
    alt_ptc_within = bool(co_alt_out.get('ptc_within_insert'))
    alt_ptc_hgvs = str(co_alt_out.get('fs_ter_str') or '').strip() or None
    alt_ptc_frac = None
    if alt_ptc_within and co_alt_out.get('ptc_aa_position') and co_alt_out.get('first_insert_aa_pos') and co_alt_out.get('insert_codons'):
        try:
            alt_ptc_frac = round(
                (int(co_alt_out['ptc_aa_position']) - int(co_alt_out['first_insert_aa_pos']) + 0.5)
                / float(int(co_alt_out['insert_codons'])),
                4,
            )
            alt_ptc_frac = min(0.97, max(0.03, alt_ptc_frac))
        except (TypeError, ValueError):
            pass
    if di_viz_alt and alt_ptc_within:
        di_viz_alt = dict(di_viz_alt)
        di_viz_alt['ptc_within_insert'] = True
        di_viz_alt['ptc_hgvs'] = alt_ptc_hgvs
        di_viz_alt['ptc_frac_in_insert'] = alt_ptc_frac
    elif di_viz_alt and co_alt_out.get('fs_ter_str'):
        di_viz_alt = dict(di_viz_alt)
        di_viz_alt['ptc_hgvs'] = str(co_alt_out.get('fs_ter_str') or '').strip() or None

    def _skip_deep_intronic_alt_viz(viz):
        if not viz:
            return True
        if viz.get('model') == 'acceptor_gain_full_intron':
            return True
        try:
            retained = int(viz.get('pseudoexon_retained_nt') or 0)
        except (TypeError, ValueError):
            retained = 0
        if (
            viz.get('mechanism') == 'acceptor_gain'
            and viz.get('canonical_proximal_acceptor')
            and retained > 600
        ):
            return True
        return False

    has_deep_intronic_alternate = bool(parsed_data.get('deep_intronic_alternate_splice_math'))
    if has_deep_intronic_alternate and _skip_deep_intronic_alt_viz(di_viz_alt):
        has_deep_intronic_alternate = False
        di_viz_alt = {}

    di_viz_alt2 = parsed_data.get('deep_intronic_viz_alternate2') or {}
    co_alt2_out = parsed_data.get('deep_intronic_alternate2_outcome') or {}
    alt2_ptc_within = bool(co_alt2_out.get('ptc_within_insert'))
    alt2_ptc_hgvs = str(co_alt2_out.get('fs_ter_str') or '').strip() or None
    alt2_ptc_frac = None
    if alt2_ptc_within and co_alt2_out.get('ptc_aa_position') and co_alt2_out.get('first_insert_aa_pos') and co_alt2_out.get('insert_codons'):
        try:
            alt2_ptc_frac = round(
                (int(co_alt2_out['ptc_aa_position']) - int(co_alt2_out['first_insert_aa_pos']) + 0.5)
                / float(int(co_alt2_out['insert_codons'])),
                4,
            )
            alt2_ptc_frac = min(0.97, max(0.03, alt2_ptc_frac))
        except (TypeError, ValueError):
            pass
    if di_viz_alt2 and alt2_ptc_within:
        di_viz_alt2 = dict(di_viz_alt2)
        di_viz_alt2['ptc_within_insert'] = True
        di_viz_alt2['ptc_hgvs'] = alt2_ptc_hgvs
        di_viz_alt2['ptc_frac_in_insert'] = alt2_ptc_frac
    elif di_viz_alt2 and co_alt2_out.get('fs_ter_str'):
        di_viz_alt2 = dict(di_viz_alt2)
        di_viz_alt2['ptc_hgvs'] = str(co_alt2_out.get('fs_ter_str') or '').strip() or None

    def _viz_ptc_loc_from_outcome(outcome):
        if not outcome or outcome.get('no_stop_found'):
            return None, None, None
        return (
            outcome.get('ptc_location_kind'),
            outcome.get('ptc_location_label'),
            outcome.get('ptc_location_detail'),
        )

    def _enrich_alt_viz_ptc(viz, outcome):
        if not viz or not outcome:
            return viz
        viz = dict(viz)
        if outcome.get('ptc_location_kind'):
            viz['ptc_location_kind'] = outcome.get('ptc_location_kind')
        if outcome.get('ptc_location_label'):
            viz['ptc_location_label'] = outcome.get('ptc_location_label')
        if outcome.get('ptc_location_detail'):
            viz['ptc_location_detail'] = outcome.get('ptc_location_detail')
        if outcome.get('ptc_fraction_in_insert') is not None:
            viz['ptc_frac_in_insert'] = outcome.get('ptc_fraction_in_insert')
        return viz

    if di_viz_alt:
        di_viz_alt = _enrich_alt_viz_ptc(di_viz_alt, co_alt_out)
    if di_viz_alt2:
        di_viz_alt2 = _enrich_alt_viz_ptc(di_viz_alt2, co_alt2_out)

    ptc_loc_kind, ptc_loc_label, ptc_loc_detail = _viz_ptc_loc_from_outcome(co_pri or co)
    skip_ptc_kind, skip_ptc_label, skip_ptc_detail = None, None, None
    sec_skip_ptc_kind, sec_skip_ptc_label, sec_skip_ptc_detail = None, None, None
    jun_ptc_kind, jun_ptc_label, jun_ptc_detail = ptc_loc_kind, ptc_loc_label, ptc_loc_detail
    if di_pre_atg_utr:
        ptc_loc_kind = ptc_loc_label = ptc_loc_detail = None
        jun_ptc_kind = jun_ptc_label = jun_ptc_detail = None
    if ptc_markers.get('skip'):
        skip_ptc_kind, skip_ptc_label, skip_ptc_detail = _splice_viz_ptc_location_from_layer(
            ptc_markers['skip'],
        )
    if ptc_markers.get('secondary_skip'):
        sec_skip_ptc_kind, sec_skip_ptc_label, sec_skip_ptc_detail = _splice_viz_ptc_location_from_layer(
            ptc_markers['secondary_skip'],
        )
    if not jun_ptc_label and ptc_markers.get('junction'):
        jun_ptc_kind, jun_ptc_label, jun_ptc_detail = _splice_viz_ptc_location_from_layer(
            ptc_markers['junction'],
        )

    return {
        'eligible': True,
        'reference_only': False,
        'gene': (parsed_data.get('gene_symbol') or parsed_data.get('gene') or '') or '',
        'exons_full': exons_full,
        'focus_neighbor': neigh,
        'focus_primary': focus_primary,
        'focus_junction': focus_junction,
        'focus_secondary': focus_secondary,
        'exons': focus_primary['exons'],
        'target_rank': tr,
        'anatomical_last_rank': int(rows[-1].get('anatomical_rank') or 0) if rows else 0,
        'total_exons_full': total_exons_full,
        'window_lo_rank': focus_primary.get('window_lo'),
        'window_hi_rank': focus_primary.get('window_hi'),
        'truncated_before': focus_primary.get('trunc_before', 0),
        'truncated_after': focus_primary.get('trunc_after', 0),
        'site': site,
        'in_frame_skip': in_fr,
        'competing': comp,
        'spliceai_loss_delta_exceeds_gain': bool(parsed_data.get('spliceai_loss_delta_exceeds_gain')),
        'spliceai_gain_delta_exceeds_loss': bool(parsed_data.get('spliceai_gain_delta_exceeds_loss')),
        'exon_skip_spliceai_primary': bool(parsed_data.get('spliceai_exon_skip_spliceai_primary')),
        'spliceai_secondary_gain_product': bool(parsed_data.get('spliceai_secondary_gain_product')),
        'junction_row': has_j,
        'junction_is_primary': j_pref,
        'row_order': row_order,
        'shift_nt': int(shift) if shift is not None else None,
        'is_acceptor': viz_acc,
        'is_donor': viz_don,
        'suppress_whole_exon_skip_row': suppress_skip_strip,
        'first_mrna_utr': bool(parsed_data.get('first_mrna_exon_is_non_coding')),
        'secondary_target_rank': sec_rank,
        'secondary_mechanism': viz_mech,
        'has_secondary_skip': bool(sec_rank),
        'secondary_in_frame_skip': sec_in_fr,
        'variant_marker': variant_marker,
        'hgvs_c_for_viz': (c_d_v or '').strip(),
        'ptc_markers': ptc_markers,
        'deep_intronic_products': di_products,
        'in_frame_exonization': di_exonization,
        'pre_atg_utr_pseudoexon': di_pre_atg_utr,
        'start_codon_exon_rank': start_codon_exon_rank if di_pre_atg_utr else None,
        'pseudoexon_insert_nt': pseudo_insert_nt,
        'use_exonization_schematic': use_exonization_schematic,
        'primary_mechanism': pri_mech or None,
        'pseudoexon_model': di_viz_pri.get('model') or parsed_data.get('deep_intronic_pseudoexon_model'),
        'intronic_ag_offset_1based': di_viz_pri.get('intronic_ag_offset_1based'),
        'pseudo_after_rank': anchor_exon_rank,
        'anchor_exon_rank': anchor_exon_rank,
        'next_exon_rank': next_exon_rank,
        'acceptor_offset_1based': acceptor_offset_1based,
        'gt_offset_1based': gt_offset_1based,
        'donor_offset_1based': donor_offset_1based,
        'canonical_gt_offset_1based': di_viz_pri.get('canonical_gt_offset_1based') or 1,
        'canonical_acceptor_offset_1based': di_viz_pri.get('canonical_acceptor_offset_1based'),
        'intron_length_nt': di_viz_pri.get('intron_length_nt'),
        'intronic_skipped_nt': intronic_skipped_nt,
        'pseudoexon_retained_nt': pseudo_retained_nt,
        'schematic_secondary_gain': bool(_viz_sec_schematic.get('schematic_secondary')),
        'spliceai_dg_delta': di_viz_pri.get('spliceai_dg_delta'),
        'pseudoexon_ptc_within_insert': pseudo_ptc_within,
        'pseudoexon_ptc_hgvs': pseudo_ptc_hgvs,
        'pseudoexon_ptc_aa': pseudo_ptc_aa,
        'pseudoexon_ptc_frac_in_insert': pseudo_ptc_frac_in_insert,
        'first_insert_aa_pos': first_ins_aa,
        'insert_codons': ins_codons_v,
        'ptc_location_kind': ptc_loc_kind,
        'ptc_location_label': ptc_loc_label,
        'ptc_location_detail': ptc_loc_detail,
        'skip_ptc_location_kind': skip_ptc_kind,
        'skip_ptc_location_label': skip_ptc_label,
        'skip_ptc_location_detail': skip_ptc_detail,
        'secondary_skip_ptc_location_kind': sec_skip_ptc_kind,
        'secondary_skip_ptc_location_label': sec_skip_ptc_label,
        'secondary_skip_ptc_location_detail': sec_skip_ptc_detail,
        'junction_ptc_location_kind': jun_ptc_kind,
        'junction_ptc_location_label': jun_ptc_label,
        'junction_ptc_location_detail': jun_ptc_detail,
        'has_deep_intronic_alternate': has_deep_intronic_alternate,
        'deep_intronic_viz_alternate': di_viz_alt if di_viz_alt else None,
        'has_deep_intronic_alternate2': bool(parsed_data.get('deep_intronic_alternate2_splice_math')),
        'deep_intronic_viz_alternate2': di_viz_alt2 if di_viz_alt2 else None,
        # Exon-internal cryptic donor / acceptor gain — fraction (0..1) of the
        # variant exon at which the cryptic site cuts, plus which side gets
        # spliced out.  Consumed by buildStrip() so the mRNA exon box can show
        # a vertical cut line + shaded "excised" remainder rather than a
        # full-length box that misleads readers.
        'exon_internal_cut_fraction': ei_cut_fraction,
        'exon_internal_cut_side': ei_cut_side,
        'exon_internal_cut_rank': ei_cut_exon_rank,
        'caption': '',
    }


def _find_gt_ag_pairs(seq, min_internal=8, max_pairs=400):
    """First downstream AG for each GT with internal >= min_internal (transcript-oriented DNA)."""
    seq_u = seq.upper()
    n = len(seq_u)
    pairs = []
    for i in range(0, n - 1):
        if seq_u[i : i + 2] != 'GT':
            continue
        for j in range(i + 2, n - 1):
            if seq_u[j : j + 2] != 'AG':
                continue
            internal = j - i - 2
            if internal < min_internal:
                continue
            pairs.append(
                {
                    'donor_gt_0based': i,
                    'acceptor_ag_0based': j,
                    'internal_nt': internal,
                    'span_including_dinucs_nt': internal + 4,
                }
            )
            break
        if len(pairs) >= max_pairs:
            break
    return pairs


DEEP_INTRONIC_MIN_SPLICE_PREDICTOR = 0.2

# When donor gain is junction-proximal (|Δ| small) and acceptor gain has a large |Δ|,
# prefer the acceptor-gain pseudo-exon sized from SpliceAI (Alamut-like) over a tiny
# nearest-AG mini-exon at a variant-created GT.
DEEP_INTRONIC_DUAL_GAIN_ACCEPTOR_DELTA_MIN = 25
DEEP_INTRONIC_DUAL_GAIN_DONOR_PROXIMAL_MAX = 5
DEEP_INTRONIC_DUAL_GAIN_DS_TOLERANCE = 0.15


MAX_JUNCTION_CODON_DECODE = 20  # omit per-codon junction detail beyond this in UI / logic


DONOR_GAIN_BODY_START = 2


ACCEPTOR_GAIN_BODY_START = 2

# Lazy-loaded from deep_intronic_rna_evidence.json (module-level; app_v11 also sets this).
_DEEP_INTRONIC_RNA_SPLICE_EVIDENCE_CACHE = None


def _deep_intronic_rna_evidence_table():
    global _DEEP_INTRONIC_RNA_SPLICE_EVIDENCE_CACHE
    if _DEEP_INTRONIC_RNA_SPLICE_EVIDENCE_CACHE is not None:
        return _DEEP_INTRONIC_RNA_SPLICE_EVIDENCE_CACHE
    table = {}
    # splice.py lives in vc_engine/, one level below the engine root, so walk up
    # one extra dir to reach the repo-root data file (parity with app_v11.py).
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'deep_intronic_rna_evidence.json')
    if os.path.isfile(path):
        try:
            with open(path, 'r', encoding='utf-8') as fh:
                loaded = json.load(fh)
            if isinstance(loaded, dict):
                table = loaded
        except Exception as exc:
            print(f'Deep intronic RNA evidence JSON skipped: {exc}')
    _DEEP_INTRONIC_RNA_SPLICE_EVIDENCE_CACHE = table
    return table


def _deep_intronic_hgvs_intron_key(c_dot):
    m = re.search(r'c\.(\d+[\+\-]\d+)', str(c_dot or ''), re.I)
    return m.group(1) if m else None


def _deep_intronic_hgvs_minus_offset(c_dot):
    """c.N-k offset: k nt upstream of the downstream exon acceptor (3′ intron end)."""
    m = re.search(r'c\.\d+-(\d+)', str(c_dot or ''), re.I)
    if not m:
        return None
    try:
        return int(m.group(1))
    except (TypeError, ValueError):
        return None


def _deep_intronic_hgvs_plus_offset(c_dot):
    """c.N+k offset: k nt into intron from the upstream exon donor (5′ intron start)."""
    m = re.search(r'c\.\d+\+(\d+)', str(c_dot or ''), re.I)
    if not m:
        return None
    try:
        return int(m.group(1))
    except (TypeError, ValueError):
        return None


def _deep_intronic_rna_evidence(gene, c_dot):
    g = (gene or '').upper()
    key = _deep_intronic_hgvs_intron_key(c_dot)
    if not g or not key:
        return None
    return (_deep_intronic_rna_evidence_table().get(g) or {}).get(key)


def _donor_gain_retained_body(mut_seq, gt_start, body_start=None):
    """Unified donor-gain insert: intron[body_start:gt_start] (default after 5′ GT)."""
    seq = str(mut_seq or '').upper()
    try:
        gt = int(gt_start)
        bs = int(DONOR_GAIN_BODY_START if body_start is None else body_start)
    except (TypeError, ValueError):
        return ''
    if gt <= bs or gt > len(seq):
        return ''
    return seq[bs:gt]


def _acceptor_gain_retained_body(mut_seq, ag_start, gt_start=None):
    """Unified acceptor-gain insert: after 5′ GT through base before gained AG (AG excluded)."""
    seq = str(mut_seq or '').upper()
    try:
        ag = int(ag_start)
    except (TypeError, ValueError):
        return ''
    if gt_start is None:
        bs = ACCEPTOR_GAIN_BODY_START if (len(seq) >= 2 and seq[0:2] == 'GT') else 0
    else:
        try:
            bs = int(gt_start) + 2
        except (TypeError, ValueError):
            bs = ACCEPTOR_GAIN_BODY_START
    if ag <= bs or ag > len(seq):
        return ''
    return seq[bs:ag]


def _retained_body_length_ok(body, dinuc_start, body_start):
    """True when len(body) matches dinuc_start - body_start (standard splice body counting)."""
    try:
        return len(body or '') == int(dinuc_start) - int(body_start)
    except (TypeError, ValueError):
        return False


def _reconcile_deep_intronic_pre_atg_outcome(parsed_data):
    """
    Repair a mis-modeled coding PTC outcome when the insert is pre-AUG (5′ UTR before first coding exon).
    Safe to call after primary outcome is set and before viz / junction payloads are built.
    """
    co = parsed_data.get('deep_intronic_primary_outcome') or {}
    if co.get('pre_atg_utr_pseudoexon'):
        return False
    details = (parsed_data.get('deep_intronic_splice') or {}).get('details') or {}
    coding_exons = parsed_data.get('coding_exons') or []
    cx = _deep_intronic_donor_gain_anchor_exon(parsed_data, coding_exons, details)
    if not _deep_intronic_insert_is_pre_atg(parsed_data, coding_exons, details, cx):
        return False
    ins = (co.get('inserted_cdna') or parsed_data.get('cryptic_inserted_cdna') or '').strip()
    if not ins:
        return False
    first = _deep_intronic_first_coding_exon(coding_exons)
    anchor_rank = co.get('anchor_exon_rank')
    if anchor_rank is None and cx:
        anchor_rank = cx.get('anatomical_rank')
    anchor_rank, dn_rank = _resolve_pre_atg_mrna_exon_ranks(
        parsed_data, coding_exons, details, anchor_rank, co.get('downstream_exon_rank'),
    )
    plan = parsed_data.get('deep_intronic_spliceai_signal_plan') or {}
    pri = plan.get('primary') or {}
    new_co = _pre_atg_utr_pseudoexon_outcome(
        ins,
        coding_exons,
        parsed_data,
        cryptic_type=co.get('cryptic_type') or 'Donor gain',
        gain_signal=float(co.get('gain_signal') or pri.get('ds') or 0),
        loss_signal=float(co.get('loss_signal') or 0),
        model_label=co.get('pseudoexon_model') or parsed_data.get('deep_intronic_pseudoexon_model') or '',
        anchor_exon_rank=anchor_rank,
        downstream_exon_rank=dn_rank,
    )
    if not new_co:
        return False
    geom = dict(co.get('pseudoexon_geometry') or {})
    if geom:
        geom['pre_atg_utr'] = True
        new_co['pseudoexon_geometry'] = geom
    new_co['pseudoexon_model'] = co.get('pseudoexon_model') or parsed_data.get('deep_intronic_pseudoexon_model')
    sig = {'kind': 'donor_gain', 'ds': pri.get('ds'), 'dp': pri.get('dp')}
    html_out = _format_splice_product_outcome_html(
        new_co, parsed_data, '', product_role='Product 1 (primary)', signal_sig=sig,
    )
    parsed_data['deep_intronic_primary_outcome'] = new_co
    parsed_data['deep_intronic_primary_splice_math'] = html_out
    parsed_data['cryptic_splice_outcome'] = new_co
    parsed_data['cryptic_inserted_cdna'] = ins
    viz = parsed_data.get('deep_intronic_viz_primary') or {}
    if isinstance(viz, dict):
        viz = dict(viz)
        viz['pre_atg_utr'] = True
        parsed_data['deep_intronic_viz_primary'] = viz
    return True


def _sync_deep_intronic_primary_to_cryptic_fields(parsed_data):
    """
    Single source of truth: when deep intronic products are active, top-level cryptic_*
    fields must mirror deep_intronic_primary_outcome (avoids stale junction-resolver values).
    """
    if not parsed_data.get('deep_intronic_splice_products_active'):
        return
    _reconcile_deep_intronic_pre_atg_outcome(parsed_data)
    co = parsed_data.get('deep_intronic_primary_outcome')
    if not co:
        return
    ins = (co.get('inserted_cdna') or '').upper()
    if ins:
        co['shift_nt'] = len(ins)
        parsed_data['cryptic_inserted_cdna'] = ins
    _annotate_junction_extension_fields(co)
    co.pop('junction_align_ctx', None)
    parsed_data.pop('junction_align_viz_ctx', None)
    parsed_data['cryptic_splice_outcome'] = co
    if co.get('insert_triplet_decode'):
        parsed_data['cryptic_insert_triplet_decode'] = co['insert_triplet_decode']
    _apply_deep_intronic_primary_splice_flags(parsed_data)
    _apply_cryptic_truncation_to_parsed_data(parsed_data, co, force=True)


def refresh_pre_atg_deep_intronic_readouts(parsed_data):
    """
    Reconcile mis-labeled deep-intronic products and rebuild splice/junction viz.
    Safe to call when serving cached analyze JSON (workbench DB) after engine fixes.
    """
    if not parsed_data or not parsed_data.get('deep_intronic_splice_products_active'):
        return False
    changed = _reconcile_deep_intronic_pre_atg_outcome(parsed_data)
    changed = _normalize_deep_intronic_acceptor_outcomes(parsed_data) or changed
    co = parsed_data.get('deep_intronic_primary_outcome') or {}
    is_pre = bool(
        changed
        or parsed_data.get('deep_intronic_pre_atg_utr_pseudoexon')
        or co.get('pre_atg_utr_pseudoexon')
    )
    is_acceptor = 'acceptor' in str(co.get('cryptic_type') or '').lower()
    has_alt = bool((parsed_data.get('deep_intronic_alternate_splice_math') or '').strip())
    if not is_pre and not is_acceptor and not has_alt:
        return False
    _apply_deep_intronic_primary_splice_flags(parsed_data)
    try:
        _ensure_coding_exons_for_splice_viz(parsed_data)
    except Exception:
        pass
    try:
        parsed_data['splice_viz'] = _build_splice_viz_payload(parsed_data)
    except Exception as exc:
        print(f'pre-atg splice_viz refresh: {exc}')
    try:
        parsed_data['junction_align_viz'] = _build_junction_align_payload(parsed_data)
    except Exception as exc:
        print(f'pre-atg junction_align refresh: {exc}')
    try:
        parsed_data['splice_products_panel_html'] = _build_splice_products_panel_html(parsed_data)
    except Exception as exc:
        print(f'pre-atg splice panel refresh: {exc}')
    pri = (parsed_data.get('deep_intronic_primary_splice_math') or '').strip()
    if pri:
        for key in ('logic_explanation', 'logic_explanation_plaintext'):
            blob = parsed_data.get(key) or ''
            if not blob:
                continue
            blob2 = re.sub(
                r'(<b>Product 1 \(primary[^)]*\):</b>\s*(?:<br>)?).*?(?=<b>Product 2|<b>Product \(|<br><br><b>|$)',
                r'\1' + pri,
                blob,
                count=1,
                flags=re.I | re.S,
            )
            if blob2 != blob:
                parsed_data[key] = blob2
            else:
                blob2 = re.sub(r'p\.Gly10Aspfs\*53', '', blob, flags=re.I)
                blob2 = re.sub(r'out-of-frame', '5′ UTR (pre-AUG) — ORF unchanged', blob2, flags=re.I)
                blob2 = re.sub(r'NMD: predicted \(internal exon PTC\)\.?', 'NMD: not applicable (pre-AUG UTR insert).', blob2, flags=re.I)
                parsed_data[key] = blob2
    parsed_data.pop('is_splice_frameshift', None)
    parsed_data['is_splice_frameshift'] = False
    parsed_data['nmd_escape'] = True
    return True


def _deep_intronic_first_coding_exon(coding_exons):
    if not coding_exons:
        return None
    return min(
        coding_exons,
        key=lambda c: (
            int(c.get('start_cds') or 999999),
            int(c.get('anatomical_rank') or 999999),
        ),
    )


def _deep_intronic_intron_upstream_anatomical_rank(details):
    try:
        return int((details or {}).get('intron_index_1based') or 0)
    except (TypeError, ValueError):
        return 0


def _deep_intronic_intron_upstream_of_first_coding(coding_exons, details):
    """True when variant intron lies entirely upstream of the first CDS-overlap exon."""
    first = _deep_intronic_first_coding_exon(coding_exons)
    if not first:
        return False
    try:
        first_rank = int(first.get('anatomical_rank') or 0)
    except (TypeError, ValueError):
        return False
    upstream_rank = _deep_intronic_intron_upstream_anatomical_rank(details)
    return upstream_rank > 0 and upstream_rank < first_rank


def _deep_intronic_cdot_in_pre_first_coding_intron(c_dot, coding_exons, details):
    """
    HGVS c.N−K in the intron immediately upstream of the first coding (AUG) exon only.

    Examples:
      • INTS11 c.29-890 — intron before AUG at c.29 (transcript HGVS; VEP start_cds=1).
      • CSMD1 c.932-2692 — intron before CDS nt 932 (deep ORF); NOT pre-AUG.
    """
    cd = str(c_dot or '').strip()
    if cd and not cd.lower().startswith('c.'):
        cd = f'c.{cd}'
    if not re.search(r'c\.\d+-', cd, re.I):
        return False
    m = re.search(r'c\.(\d+)-', cd, re.I)
    if not m:
        return False
    try:
        anchor = int(m.group(1))
    except (TypeError, ValueError):
        return False
    first = _deep_intronic_first_coding_exon(coding_exons)
    if not first:
        return False
    try:
        first_rank = int(first.get('anatomical_rank') or 0)
        start_cds = int(first.get('start_cds') or 1)
    except (TypeError, ValueError):
        return False
    intron_idx = _deep_intronic_intron_upstream_anatomical_rank(details)
    if intron_idx > 0:
        return intron_idx < first_rank
    # Missing intron_index: only INTS11-style first-coding HGVS (c.29−), not deep c.932−.
    if first_rank >= 2 and start_cds == 1 and anchor <= 120:
        return True
    return False


def _deep_intronic_insert_is_pre_atg(parsed_data, coding_exons, details, cx):
    """
    True when a pseudo-exon insert sits between a 5′ UTR exon and the CDS (upstream of AUG).
    Example: INTS11 exon 1 (UTR) + intron pseudo-exon + exon 2 (c.29 / start codon).
    """
    c_dot = (parsed_data or {}).get('c_dot') or ''
    if _hgvs_is_coding_exon_body(c_dot):
        anchor = _hgvs_coding_anchor_nt(c_dot)
        first = _deep_intronic_first_coding_exon(coding_exons)
        if anchor is not None and first:
            try:
                start_cds = int(first.get('start_cds') or 1)
            except (TypeError, ValueError):
                start_cds = 1
            if anchor >= start_cds:
                return False
    if _deep_intronic_intron_upstream_of_first_coding(coding_exons, details):
        return True
    if _deep_intronic_cdot_in_pre_first_coding_intron(c_dot, coding_exons, details):
        return True
    first = _deep_intronic_first_coding_exon(coding_exons)
    if not first:
        return False
    try:
        first_rank = int(first.get('anatomical_rank') or 0)
    except (TypeError, ValueError):
        return False
    if cx and cx.get('non_coding_upstream'):
        return True
    try:
        anchor_rank = int((cx or {}).get('anatomical_rank') or 0)
    except (TypeError, ValueError):
        anchor_rank = 0
    try:
        end_cds = int((cx or {}).get('end_cds') or 0)
    except (TypeError, ValueError):
        end_cds = 0
    return anchor_rank > 0 and anchor_rank < first_rank and end_cds == 0


def _deep_intronic_donor_gain_anchor_exon(parsed_data, coding_exons, details):
    """Upstream mRNA exon for donor-side deep-intronic insert (intron N follows exon N)."""
    c_dot = (parsed_data or {}).get('c_dot') or ''
    if _deep_intronic_cdot_in_pre_first_coding_intron(c_dot, coding_exons, details):
        first = _deep_intronic_first_coding_exon(coding_exons)
        try:
            ur = int(first.get('anatomical_rank') or 2) - 1 if first else 1
        except (TypeError, ValueError):
            ur = 1
        if ur > 0:
            return {
                'anatomical_rank': ur,
                'start_cds': 0,
                'end_cds': 0,
                'non_coding_upstream': True,
            }
    upstream_rank = _deep_intronic_intron_upstream_anatomical_rank(details)
    first = _deep_intronic_first_coding_exon(coding_exons)
    try:
        first_rank = int(first.get('anatomical_rank') or 999999) if first else 999999
    except (TypeError, ValueError):
        first_rank = 999999
    if upstream_rank > 0:
        hit = _deep_intronic_coding_exon_by_rank(coding_exons, upstream_rank)
        if hit:
            return hit
        if upstream_rank < first_rank:
            return {
                'anatomical_rank': upstream_rank,
                'start_cds': 0,
                'end_cds': 0,
                'non_coding_upstream': True,
            }
    anchor_rank = parsed_data.get('variant_exon') or parsed_data.get('snpeff_exon_rank')
    hit = _deep_intronic_coding_exon_by_rank(coding_exons, anchor_rank)
    if hit:
        return hit
    return None


def _resolve_pre_atg_mrna_exon_ranks(
    parsed_data,
    coding_exons,
    details,
    anchor_rank=None,
    downstream_rank=None,
):
    """
    mRNA exon numbers for pre-AUG UTR pseudo-exons.
    VEP/SnpEff coding-only lists label the first CDS exon as 1 even when mRNA exon 1 is 5′ UTR only
    (e.g. INTS11: UTR exon 1 → coding/AUG exon 2).
    """
    first = _deep_intronic_first_coding_exon(coding_exons or [])
    first_rank = None
    if first:
        try:
            first_rank = int(first.get('anatomical_rank') or 0) or None
        except (TypeError, ValueError):
            first_rank = None
    try:
        anchor = int(anchor_rank) if anchor_rank is not None else None
    except (TypeError, ValueError):
        anchor = None
    try:
        dn = int(downstream_rank) if downstream_rank is not None else None
    except (TypeError, ValueError):
        dn = None
    if anchor is None:
        cx = _deep_intronic_donor_gain_anchor_exon(parsed_data, coding_exons or [], details or {})
        if cx:
            try:
                anchor = int(cx.get('anatomical_rank') or 0) or None
            except (TypeError, ValueError):
                anchor = None
    if anchor is None:
        anchor = 1
    if dn is None:
        dn = first_rank
    pre_atg = bool(
        (parsed_data or {}).get('first_mrna_exon_is_non_coding')
        or _deep_intronic_cdot_in_pre_first_coding_intron(
            (parsed_data or {}).get('c_dot'), coding_exons or [], details or {},
        )
        or _deep_intronic_intron_upstream_of_first_coding(coding_exons or [], details or {})
    )
    if pre_atg:
        if dn is None or dn <= anchor:
            dn = anchor + 1
        elif anchor == 1 and dn == 1 and (parsed_data or {}).get('first_mrna_exon_is_non_coding'):
            dn = 2
    elif dn is None:
        dn = first_rank
    return anchor, dn


def _pre_atg_utr_pseudoexon_outcome(
    retained,
    coding_exons,
    parsed_data,
    cryptic_type='Donor gain',
    gain_signal=0.0,
    loss_signal=0.0,
    model_label='',
    anchor_exon_rank=None,
    downstream_exon_rank=None,
):
    """5′ UTR pseudo-exon: mature mRNA change only — annotated CDS/protein unchanged."""
    shift_nt = len(retained or '')
    if shift_nt <= 0:
        return None
    _di = (parsed_data or {}).get('deep_intronic_splice') or {}
    _details = _di.get('details') if isinstance(_di, dict) else {}
    anchor_rank, dn_rank = _resolve_pre_atg_mrna_exon_ranks(
        parsed_data,
        coding_exons,
        _details or {},
        anchor_exon_rank,
        downstream_exon_rank,
    )
    utr_note = (
        f"<b>5\u2032 UTR / pre-AUG pseudo-exon:</b> <b>{shift_nt} nt</b> inserted into the "
        f"mature transcript between non-coding exon {anchor_rank} and coding "
        f"exon {dn_rank or '?'} (upstream of the start codon). The annotated "
        f"<b>protein ORF is unchanged</b> — this is not a coding frameshift and does not "
        f"predict a novel PTC or NMD from ORF translation. Possible mRNA-level effects "
        f"include altered 5\u2032 UTR length or structure, uORFs, and translation initiation "
        f"efficiency — prioritize SpliceAI/RNA assays and gene mechanism over protein "
        f"frameshift models."
    )
    co = {
        'shift_nt': shift_nt,
        'inserted_cdna': retained,
        'cryptic_type': cryptic_type,
        'pre_atg_utr_pseudoexon': True,
        'no_coding_impact': True,
        'in_frame_shift': None,
        'gain_signal': gain_signal,
        'loss_signal': loss_signal,
        'pseudoexon_model': model_label,
        'insert_triplet_decode': (
            f'{shift_nt} bp inserted in 5\u2032 UTR (pre-AUG); annotated CDS/protein unchanged.'
        ),
        'pre_atg_utr_note': utr_note,
        'anchor_exon_rank': anchor_rank,
        'downstream_exon_rank': dn_rank,
    }
    co['product_plain_summary'] = _format_splice_product_plain_summary(co, parsed_data)
    return co


def _apply_deep_intronic_primary_splice_flags(parsed_data):
    """Map deep_intronic_primary_outcome onto top-level splice/NMD flags for UI + logic."""
    co = parsed_data.get('deep_intronic_primary_outcome') or {}
    if not co.get('pre_atg_utr_pseudoexon'):
        return
    parsed_data['deep_intronic_pre_atg_utr_pseudoexon'] = True
    parsed_data['splice_is_in_frame'] = True
    parsed_data['is_splice_frameshift'] = False
    parsed_data['nmd_escape'] = True
    parsed_data['is_nonstop_decay'] = False
    parsed_data.pop('deep_intronic_in_frame_exonization', None)
    for k in (
        'nmd_escape_truncation_fraction', 'cryptic_truncated_protein_length',
        'cryptic_full_protein_length', 'cryptic_truncation_fraction',
        'cryptic_truncation_pct', 'cryptic_retained_pct', 'cryptic_splice_ptc',
        'deep_intronic_predicted_hgvs_p', 'deep_intronic_mutant_protein_length',
    ):
        parsed_data.pop(k, None)
    note = (co.get('pre_atg_utr_note') or '').strip()
    if note:
        existing = (parsed_data.get('splice_frame_math') or '').strip()
        if note not in existing:
            parsed_data['splice_frame_math'] = f"{existing}<br><br>{note}" if existing else note


def _resolve_donor_gain_gt_anchor(mut_seq, wt_seq, j_var, pdg, strand, rna_evidence=None, c_dot=''):
    """
    Pick cryptic donor GT (0-based start). Default: SpliceAI DP anchor.
    Published RNA may pin donor via cryptic_donor_hgvs_offset (HGVS intron position of donor G).
    """
    seq = str(mut_seq or '').upper()
    rna = rna_evidence or {}
    rna_donor = rna.get('cryptic_donor_hgvs_offset')
    if rna_donor is not None:
        try:
            gt = int(rna_donor) - 1
            if 0 <= gt <= len(seq) - 2 and seq[gt : gt + 2] == 'GT':
                return gt
        except (TypeError, ValueError):
            pass
    spliceai_gt = None
    if pdg is not None and j_var is not None:
        spliceai_gt, _ = _spliceai_site_locus(
            seq, j_var, pdg, 'donor_gain', c_dot, strand
        )
        if spliceai_gt is None:
            idx = _spliceai_dp_to_intron_idx(j_var, pdg, strand)
            spliceai_gt = _find_dinuc_near(seq, idx, 'GT')
    if spliceai_gt is not None:
        return int(spliceai_gt)
    vgt = _variant_created_cryptic_dinuc(seq, wt_seq, j_var, 'GT')
    if vgt is not None:
        return int(vgt)
    return None


def _variant_created_cryptic_dinuc(mut_seq, wt_seq, j_var, dinuc='GT'):
    """Return 0-based start index when the variant creates a new AG/GT dinucleotide."""
    if mut_seq is None or wt_seq is None or j_var is None:
        return None
    want = (dinuc or '').upper()
    if len(want) != 2:
        return None
    try:
        j = int(j_var)
    except (TypeError, ValueError):
        return None
    mut = str(mut_seq).upper()
    wt = str(wt_seq).upper()
    if j < 0 or j + 1 >= len(mut) or j + 1 >= len(wt):
        return None
    if mut[j : j + 2] == want and wt[j : j + 2] != want:
        return j
    if j >= 1 and mut[j - 1 : j + 1] == want and wt[j - 1 : j + 1] != want:
        return j - 1
    return None


def _cds_splice_insert_preserves_native_orf(ref_cds, mut_cds, cx_end):
    """
    True when a splice insert at cx_end keeps the native stop (no early fsTer / PTC).
    Uses translation, not len(insert) % 3 (exon phase at the junction matters).
    """
    ref_aas = _translate_cds_aas(ref_cds)
    mut_aas = _translate_cds_aas(mut_cds)
    if '*' not in ref_aas or '*' not in mut_aas:
        return False
    r_stop = ref_aas.index('*')
    m_stop = mut_aas.index('*')
    ins_bp = len(mut_cds) - len(ref_cds)
    if ins_bp <= 0:
        return False
    anchor_aa = max(0, (int(cx_end) - 1) // 3)
    # Premature stop in the novel reading frame before the native stop would have occurred.
    if m_stop < r_stop:
        if m_stop <= anchor_aa + max(2, ins_bp // 3 + 1):
            return False
    return m_stop >= r_stop


def _canonical_proximal_body_candidates(mut_seq, gt_i_anchor, rna_evidence=None):
    """
    Sweep cryptic GT placement near SpliceAI anchor; body = intron after canonical GT (2:gt_start).
    Optional published RNA lengths (any gene) may add an anchored candidate when configured.
    """
    seq = str(mut_seq).upper()
    gt_i_anchor = int(gt_i_anchor)
    out = []
    seen = set()
    for gt_start in range(max(0, gt_i_anchor - 3), min(len(seq) - 1, gt_i_anchor + 4)):
        if seq[gt_start : gt_start + 2] != 'GT':
            continue
        body = _donor_gain_retained_body(seq, gt_start)
        if len(body) < 3:
            continue
        key = (gt_start, body)
        if key in seen:
            continue
        seen.add(key)
        out.append({
            'model': 'canonical_proximal',
            'retained': body,
            'mRNA_span_nt': gt_start + 2,
            'gt_start': gt_start,
            'body_start': DONOR_GAIN_BODY_START,
            'acceptor': 'canonical_exon_acceptor',
        })
    target_body = (rna_evidence or {}).get('coding_body_nt')
    if target_body is not None:
        try:
            tb = int(target_body)
        except (TypeError, ValueError):
            tb = 0
        try:
            body_start = int((rna_evidence or {}).get('body_start_offset') or DONOR_GAIN_BODY_START)
        except (TypeError, ValueError):
            body_start = DONOR_GAIN_BODY_START
        rna_donor = (rna_evidence or {}).get('cryptic_donor_hgvs_offset')
        gt_start = None
        if rna_donor is not None:
            try:
                gt_start = int(rna_donor) - 1
            except (TypeError, ValueError):
                gt_start = None
        if gt_start is not None and 0 <= gt_start <= len(seq) - 2:
            body = _donor_gain_retained_body(seq, gt_start, body_start)
        elif tb >= 3 and body_start + tb <= len(seq):
            gt_start = body_start + tb
            body = _donor_gain_retained_body(seq, gt_start, body_start)
            while (
                gt_start < len(seq) - 1
                and seq[gt_start : gt_start + 2] != 'GT'
                and gt_start <= body_start + tb + 3
            ):
                gt_start += 1
                body = _donor_gain_retained_body(seq, gt_start, body_start)
        else:
            body = ''
        if len(body) >= 3 and (tb <= 0 or len(body) == tb or abs(len(body) - tb) <= 2):
            if not _retained_body_length_ok(body, gt_start if gt_start is not None else body_start + len(body), body_start):
                body = ''
        if body and len(body) >= 3 and (tb <= 0 or len(body) == tb or abs(len(body) - tb) <= 2):
            key = ('rna', gt_start, body)
            if key not in seen:
                seen.add(key)
                out.append({
                    'model': 'canonical_proximal',
                    'retained': body,
                    'mRNA_span_nt': (rna_evidence or {}).get('pseudo_exon_nt') or ((gt_start or 0) + 2),
                    'gt_start': gt_start if gt_start is not None else body_start + len(body),
                    'body_start': body_start,
                    'acceptor': 'canonical_exon_acceptor',
                    'rna_anchored': True,
                })
    return out


def _deep_intronic_donor_gain_retained_candidates(
    mut_seq, gt_i, cds_seq=None, cx_end=None, rna_evidence=None,
    wt_seq=None, j_var=None,
):
    """
    Build competing pseudo-exon models for donor gain after an upstream coding exon:
      • canonical_proximal — exon acceptor → cryptic donor (5′ intron through GT at gt_i)
      • nearest_intronic_ag — nearest upstream AG → cryptic GT (local mini-exon)
    Both are scored; either can win depending on geometry and reading frame.
    """
    if not mut_seq or gt_i is None:
        return []
    seq = str(mut_seq).upper()
    gt_i = int(gt_i)
    out = _canonical_proximal_body_candidates(seq, gt_i, rna_evidence)
    vgt = _variant_created_cryptic_dinuc(seq, wt_seq, j_var, 'GT')
    if vgt is not None and int(vgt) != int(gt_i):
        extra = _canonical_proximal_body_candidates(seq, int(vgt), None)
        seen = {(c.get('gt_start'), c.get('retained')) for c in out}
        for c in extra:
            key = (c.get('gt_start'), c.get('retained'))
            if key not in seen:
                seen.add(key)
                c = dict(c)
                c['variant_created_donor'] = True
                out.append(c)
    if not out and gt_i >= 2:
        body = _donor_gain_retained_body(seq, gt_i)
        if body:
            out.append({
                'model': 'canonical_proximal',
                'retained': body,
                'mRNA_span_nt': gt_i + 2,
                'gt_start': gt_i,
                'body_start': DONOR_GAIN_BODY_START,
                'acceptor': 'canonical_exon_acceptor',
            })
    gt_for_near = gt_i
    if out:
        gt_for_near = out[0].get('gt_start', gt_i)
    for i in range(int(gt_for_near) - 2, max(-1, int(gt_for_near) - 120), -1):
        if i >= 0 and seq[i : i + 2] == 'AG':
            mini = seq[i + 2 : int(gt_for_near)]
            if mini:
                out.append({
                    'model': 'nearest_intronic_ag',
                    'retained': mini,
                    'mRNA_span_nt': len(mini) + 4,
                    'acceptor': f'intronic_ag_{i + 1}',
                    'ag_start': i,
                    'gt_start': int(gt_for_near),
                    'body_start': i + 2,
                    'ag_offset_from_gt': int(gt_for_near) - i,
                })
            break
    if cds_seq and cx_end:
        for c in out:
            mut = cds_seq[: int(cx_end)] + c['retained'] + cds_seq[int(cx_end) :]
            c['orf_in_frame'] = _cds_splice_insert_preserves_native_orf(cds_seq, mut, cx_end)
    # Drop candidates whose retained length disagrees with dinuc_start - body_start (miscount guard).
    filtered = []
    for c in out:
        model = c.get('model') or ''
        if model == 'canonical_proximal':
            gt_s = c.get('gt_start')
            bs = c.get('body_start', DONOR_GAIN_BODY_START)
            retained = c.get('retained') or ''
            if gt_s is None:
                continue
            if retained != _donor_gain_retained_body(seq, gt_s, bs):
                continue
            if not _retained_body_length_ok(retained, gt_s, bs):
                continue
        elif model == 'nearest_intronic_ag':
            gt_s = c.get('gt_start')
            ag_s = c.get('ag_start')
            retained = c.get('retained') or ''
            if gt_s is None or ag_s is None:
                continue
            if retained != seq[int(ag_s) + 2 : int(gt_s)]:
                continue
        filtered.append(c)
    return filtered


def _score_deep_intronic_donor_gain_candidate(c, gt_i, intron_len, all_candidates):
    """Heuristic score — either canonical-proximal or nearest-AG can win."""
    retained = c.get('retained') or ''
    n = len(retained)
    model = c.get('model') or ''
    score = 0.0
    if c.get('orf_in_frame') is True:
        score += 18.0
    elif c.get('orf_in_frame') is False:
        score -= 12.0
    else:
        in_frame = (n % 3 == 0) if n else False
        if in_frame:
            score += 8.0
        else:
            score -= 2.0
    if c.get('rna_anchored'):
        score += 25.0

    ilen = max(int(intron_len or 0), len(retained) + 1, 1)
    donor_gt = c.get('gt_start', gt_i)
    try:
        donor_frac = (int(donor_gt) + 1) / float(ilen)
    except (TypeError, ValueError):
        donor_frac = (int(gt_i) + 1) / float(ilen)

    canon = next((x for x in all_candidates if x.get('model') == 'canonical_proximal'), None)
    near = next((x for x in all_candidates if x.get('model') == 'nearest_intronic_ag'), None)
    canon_orf = canon.get('orf_in_frame') if canon else None
    near_orf = near.get('orf_in_frame') if near else None

    if model == 'canonical_proximal':
        if donor_frac <= 0.33:
            score += 14.0
        elif donor_frac <= 0.55:
            score += 5.0
        else:
            score -= 10.0
        if n > 150:
            score -= 8.0
        if near and c.get('orf_in_frame') and near_orf is False:
            score += 6.0
        if c.get('orf_in_frame') is True:
            score += 20.0
    else:
        if donor_frac > 0.20:
            score += 12.0
        ag_dist = c.get('ag_offset_from_gt')
        if ag_dist is not None and int(ag_dist) <= 40:
            score += 4.0
        if n <= 51:
            score += 5.0
        if n <= 21:
            score += 3.0
        if canon and c.get('orf_in_frame') and canon_orf is False:
            score += 6.0
        if canon and donor_frac > 0.45 and n < len(canon.get('retained') or ''):
            score += 8.0
        if canon_orf is True and donor_frac <= 0.35:
            score -= 25.0

    return score


def _pick_deep_intronic_donor_gain_candidate(
    candidates, rna_evidence=None, gt_i=None, intron_len=None, cds_seq=None, cx_end=None
):
    """Pick best pseudo-exon model; canonical acceptor → cryptic donor preferred when ORF-safe."""
    if not candidates:
        return None
    target_span = (rna_evidence or {}).get('pseudo_exon_nt')
    target_body = (rna_evidence or {}).get('coding_body_nt')
    canon_cands = [c for c in candidates if c.get('model') == 'canonical_proximal']
    if target_body is not None or target_span is not None:
        for c in canon_cands:
            body = len(c.get('retained') or '')
            span = c.get('mRNA_span_nt')
            body_match = target_body is not None and abs(body - int(target_body)) <= 2
            span_match = target_span is not None and span is not None and abs(int(span) - int(target_span)) <= 2
            if (body_match or span_match) and c.get('orf_in_frame') is not False:
                out = dict(c)
                out['pick_reason'] = 'published RNA/minigene'
                return out
        for c in canon_cands:
            if c.get('rna_anchored'):
                out = dict(c)
                out['pick_reason'] = 'published RNA/minigene'
                return out
    orf_canon = [c for c in canon_cands if c.get('orf_in_frame') is True]
    if orf_canon:
        ilen = max(int(intron_len or 0), 1)
        def _canon_key(c):
            gs = int(c.get('gt_start') or gt_i or 0)
            return (-int(c.get('rna_anchored') or 0), -len(c.get('retained') or ''), gs)
        orf_canon.sort(key=_canon_key)
        best = dict(orf_canon[0])
        gs = int(best.get('gt_start') or gt_i or 0)
        if (gs + 1) / float(ilen) <= 0.40:
            best['pick_reason'] = 'canonical acceptor \u2192 cryptic donor (ORF preserved)'
            return best
    if gt_i is None:
        gt_i = 0
    scored = [
        (
            c,
            _score_deep_intronic_donor_gain_candidate(c, gt_i, intron_len, candidates),
        )
        for c in candidates
    ]
    scored.sort(key=lambda x: (-x[1], len(x[0].get('retained') or '')))
    best = dict(scored[0][0])
    best['pick_score'] = scored[0][1]
    if len(scored) > 1:
        best['pick_runner_up_model'] = scored[1][0].get('model')
    return best


def _translate_cds_aas(cds):
    aas = []
    seq = (cds or '').upper()
    for i in range(0, len(seq) - 2, 3):
        codon = seq[i : i + 3]
        aa = _CODON_TABLE_FULL.get(codon, 'X')
        aas.append(aa)
        if aa == '*':
            break
    return aas


def _inframe_exonization_outcome_from_insert(
    mutant_cds,
    cds_seq,
    cx_end,
    retained,
    coding_exons,
    parsed_data,
    cryptic_type='Donor gain',
    gain_signal=0.0,
    loss_signal=0.0,
    model_label='',
    rna_evidence=None,
):
    """In-frame deep-intronic pseudo-exon: no PTC, native stop retained downstream."""
    shift_nt = len(retained or '')
    if shift_nt <= 0:
        return None
    if not _cds_splice_insert_preserves_native_orf(cds_seq, mutant_cds, cx_end):
        return None
    ref_aas = _translate_cds_aas(cds_seq)
    mut_aas = _translate_cds_aas(mutant_cds)
    if not ref_aas or '*' not in ref_aas:
        return None
    ref_stop = ref_aas.index('*')
    mut_stop = mut_aas.index('*') if '*' in mut_aas else len(mut_aas)
    inserted_codons = max(0, mut_stop - ref_stop)
    if inserted_codons <= 0:
        inserted_codons = shift_nt // 3
    change_cod = int(cx_end) // 3
    if change_cod >= len(ref_aas):
        return None
    # Premature stop before the native stop position → treat as PTC path.
    if mut_stop < ref_stop + inserted_codons:
        return None

    aa_pos = change_cod + 1
    ref_aa1 = ref_aas[change_cod]
    ref_aa3 = _AA_ONE_TO_THREE.get(ref_aa1, 'Xaa')
    ins_end = min(change_cod + inserted_codons + 1, mut_stop)
    ins_parts = [_AA_ONE_TO_THREE.get(a, 'Xaa') for a in mut_aas[change_cod:ins_end]]
    ins_str = ''.join(ins_parts)
    aa_word = 'amino acid' if inserted_codons == 1 else 'amino acids'
    if inserted_codons >= 4:
        predicted_hgvs = f'p.{ref_aa3}{aa_pos}delins({inserted_codons} {aa_word})'
    else:
        predicted_hgvs = f'p.{ref_aa3}{aa_pos}delins{ins_str}'

    try:
        full_plen = int(parsed_data.get('protein_length') or 0)
    except (TypeError, ValueError):
        full_plen = 0
    if full_plen <= 0 and cds_seq:
        full_plen = len(cds_seq) // 3
        if full_plen > 0:
            parsed_data['protein_length'] = full_plen
    mutant_plen = mut_stop

    if inserted_codons >= 4:
        gain_block = ''
        gain_plain = (
            f'{shift_nt} bp inserted; in-frame (+{inserted_codons} {aa_word} at p.{ref_aa3}{aa_pos}).'
        )
    else:
        gain_block, gain_plain = _format_splice_gain_insert_explain(
            retained, None, mutant_cds=mutant_cds, edit_anchor=cx_end
        )

    rna_note = (rna_evidence or {}).get('summary')
    if rna_note:
        rna_note = (
            f'<span style="color:#a7f3d0">Published RNA evidence: {rna_note}</span>'
        )

    return {
        'shift_nt': shift_nt,
        'inserted_cdna': retained,
        'insert_triplet_decode': gain_plain,
        'cryptic_type': cryptic_type,
        'in_frame_shift': True,
        'in_frame_exonization': True,
        'pseudoexon_model': model_label,
        'predicted_hgvs_p': predicted_hgvs,
        'inserted_aa_count': inserted_codons,
        'full_protein_length': full_plen or None,
        'mutant_protein_length': mutant_plen,
        'gain_signal': gain_signal,
        'loss_signal': loss_signal,
        'rna_evidence_note': rna_note,
        'no_stop_found': False,
    }


def _deep_intronic_in_silico_support_html(parsed_data):
    """
    Require meaningful SpliceAI or Pangolin signal before deep-intronic narrative.
    Returns (supported, html_fragment) listing DS with Δbp from DP_* when present.
    """
    thr = DEEP_INTRONIC_MIN_SPLICE_PREDICTOR
    try:
        ag = float(parsed_data.get('spliceai_ds_ag') or 0)
        al = float(parsed_data.get('spliceai_ds_al') or 0)
        dg = float(parsed_data.get('spliceai_ds_dg') or 0)
        dl = float(parsed_data.get('spliceai_ds_dl') or 0)
    except (TypeError, ValueError):
        ag = al = dg = dl = 0.0
    try:
        sg = float(parsed_data.get('pangolin_ds_sg') or 0)
        sl = float(parsed_data.get('pangolin_ds_sl') or 0)
    except (TypeError, ValueError):
        sg = sl = 0.0

    parts = []
    if ag >= thr:
        dp = _parse_spliceai_dp(parsed_data.get('spliceai_dp_ag'))
        parts.append(f"SpliceAI DS_AG {ag:.2f}" + (f", Δ{dp:+d} bp" if dp is not None else ''))
    if al >= thr:
        dp = _parse_spliceai_dp(parsed_data.get('spliceai_dp_al'))
        parts.append(f"SpliceAI DS_AL {al:.2f}" + (f", Δ{dp:+d} bp" if dp is not None else ''))
    if dg >= thr:
        dp = _parse_spliceai_dp(parsed_data.get('spliceai_dp_dg'))
        parts.append(f"SpliceAI DS_DG {dg:.2f}" + (f", Δ{dp:+d} bp" if dp is not None else ''))
    if dl >= thr:
        dp = _parse_spliceai_dp(parsed_data.get('spliceai_dp_dl'))
        parts.append(f"SpliceAI DS_DL {dl:.2f}" + (f", Δ{dp:+d} bp" if dp is not None else ''))

    if abs(sg) >= thr:
        dp = _parse_spliceai_dp(parsed_data.get('pangolin_dp_sg'))
        parts.append(f"Pangolin splice gain {sg:.2f}" + (f", Δ{dp:+d} bp" if dp is not None else ''))
    if abs(sl) >= thr:
        dp = _parse_spliceai_dp(parsed_data.get('pangolin_dp_sl'))
        parts.append(f"Pangolin splice loss {sl:.2f}" + (f", Δ{dp:+d} bp" if dp is not None else ''))

    if not parts:
        return False, ""
    frag = (
        f"<strong>In silico splice (&ge; {thr:.2f})</strong> &mdash; "
        + "; ".join(parts)
        + ". <span style=\"color:#94a3b8\">Deep intronic geometry below is contingent on these signals.</span>"
    )
    return True, frag


def _ensure_splice_ref_alt(parsed_data, http_session, c_dot):
    """Recover ref/alt for intron sequence modeling (SNV or duplication)."""
    ref = str(parsed_data.get('ref') or '').upper()
    alt = str(parsed_data.get('alt') or '').upper()
    if (
        ref and alt
        and ref not in ('-', '.')
        and alt not in ('-', '.')
    ):
        return ref, alt
    if alt and len(alt) > 1 and ref in ('-', '.', ''):
        return '-', alt
    try:
        import urllib.parse as _urlparse
        _tx = (
            parsed_data.get('refseq_transcript_id')
            or parsed_data.get('transcript')
            or parsed_data.get('mane_transcript')
            or parsed_data.get('ensembl_transcript_id')
        )
        _gene = parsed_data.get('gene_symbol') or parsed_data.get('gene') or ''
        _hgvs = f"{_tx}:{c_dot}" if _tx else (f"{_gene}:{c_dot}" if _gene else None)
        if _hgvs:
            _vep_url = (
                f"https://rest.ensembl.org/vep/human/hgvs/"
                f"{_urlparse.quote(_hgvs, safe='')}?content-type=application/json"
            )
            _vresp = http_session.get(_vep_url, timeout=20)
            if _vresp.status_code == 200 and _vresp.json():
                _v0 = _vresp.json()[0]
                _ale = str(_v0.get('allele_string', '') or '')
                if '/' in _ale:
                    _ra, _aa = _ale.split('/')[:2]
                    if _aa:
                        _ra_n, _aa_n, _ = _normalize_to_forward_strand(
                            http_session,
                            parsed_data.get('grch38_chrom'),
                            parsed_data.get('grch38_start'),
                            (_ra or '-').upper(),
                            _aa.upper(),
                            parsed_data.get('grch38_end'),
                        )
                        parsed_data['ref'] = _ra_n
                        parsed_data['alt'] = _aa_n
                        return _ra_n, _aa_n
    except Exception as exc:
        print(f"[deep-intronic] VEP ref/alt recovery failed: {exc}")
    _vcf_parsed = _parse_vcf_locus_string(parsed_data.get('vep_vcf_string'))
    if _vcf_parsed:
        return _vcf_parsed[2], _vcf_parsed[3]
    return ref, alt


def _apply_ref_alt_to_intron_sequence(intron_tx, j_var, ref, alt):
    """
    Apply VEP ref/alt to transcript-oriented intron sequence.
    Returns (mut_seq, inserted_seq, change_kind).
    """
    seq = str(intron_tx or '').upper()
    ref_u = str(ref or '').upper()
    alt_u = str(alt or '').upper()
    try:
        j = int(j_var)
    except (TypeError, ValueError):
        j = 0
    if (
        alt_u
        and (ref_u in ('-', '.', '') or (len(alt_u) > len(ref_u) and alt_u.startswith(ref_u)))
    ):
        ins = alt_u[len(ref_u):] if ref_u not in ('-', '.', '') else alt_u
        pos = min(max(j + 1, 0), len(seq))
        return seq[:pos] + ins + seq[pos:], ins, 'dup'
    if len(ref_u) == 1 and len(alt_u) == 1 and 0 <= j < len(seq) and seq[j] == ref_u:
        m = list(seq)
        m[j] = alt_u
        return ''.join(m), '', 'snv'
    return seq, '', 'unchanged'


def _dup_baseline_naming_aa_pos(insert_idx):
    """HGVS anchor for dup-retained frameshift (first complete codon at/after insert site)."""
    try:
        idx = int(insert_idx)
    except (TypeError, ValueError):
        return None
    if idx < 0:
        return None
    if idx % 3 == 0:
        return idx // 3 + 1
    return idx // 3 + 2


def _deep_intronic_dup_cds_insert_index(c_dot):
    """
    cDNA index (0-based) where duplicated sequence is inserted 3′ of the original span.
    Range dup c.1614-16_1622dup → insert after c.1622 (index 1622 → p.Ala542Serfs*19).
    """
    s = str(c_dot or '')
    m_rng = re.search(r'c\.\d+(?:-\d+|\+\d+)?_(\d+)(?:dup|del)', s, re.I)
    if m_rng:
        try:
            end_c = int(m_rng.group(1))
            return max(0, end_c)
        except (TypeError, ValueError):
            pass
    m = re.search(r'c\.(\d+)', s, re.I)
    if not m:
        return None
    try:
        anchor_c = int(m.group(1))
    except (TypeError, ValueError):
        return None
    return max(0, anchor_c - 1)


def _dup_insert_ag_offsets(ins_seq):
    """0-based offsets of AG dinucleotides inside a duplicated insert (cryptic acceptor candidates)."""
    s = str(ins_seq or '').upper()
    return [i for i in range(len(s) - 1) if s[i:i + 2] == 'AG']


def _deep_intronic_dup_ag_competition_html(ins_seq, details):
    """Note when duplication introduces AG motif(s) that may compete with canonical acceptor."""
    ag_offs = _dup_insert_ag_offsets(ins_seq)
    if not ag_offs:
        return ''
    try:
        canon_ag = int(details.get('canonical_last_ag_0based'))
        intron_len = int(details.get('intron_length_nt') or 0)
    except (TypeError, ValueError):
        canon_ag = None
        intron_len = 0
    canon_note = ''
    if canon_ag is not None and intron_len:
        canon_note = (
            f" Canonical intron 3′ <b>AG</b> remains at position {canon_ag + 1} "
            f"(using it without the duplicated AG → exon skipping / loss product)."
        )
    off_txt = ', '.join(f'+{o + 1}' for o in ag_offs[:4])
    return (
        f"<span style='color:#94a3b8;font-size:0.9em'>"
        f"Duplication introduces <b>AG</b> at insert offset(s) {off_txt} nt — "
        f"spliceosome may use the <b>new AG</b> (pseudo-exon inclusion) or the "
        f"<b>canonical AG</b> (downstream exon retained / skip of duplicated segment)."
        f"{canon_note}</span>"
    )


def _apply_dup_baseline_to_parsed_data(parsed_data, co):
    """Promote duplication-baseline PTC onto parsed_data (3′ truncation / NMD fields)."""
    if not co or co.get('no_stop_found'):
        return
    parsed_data['consequence'] = 'frameshift'
    parsed_data['is_splice_frameshift'] = True
    parsed_data['splice_is_in_frame'] = False
    if co.get('fs_ter_str'):
        fs = str(co['fs_ter_str']).strip()
        if fs.startswith('p.') and not fs.startswith('p.('):
            parsed_data['hgvs_p'] = 'p.(' + fs[2:] + ')'
        else:
            parsed_data['hgvs_p'] = fs
    tf = co.get('truncation_fraction')
    if tf is not None:
        try:
            parsed_data['nmd_escape_truncation_fraction'] = float(tf)
        except (TypeError, ValueError):
            pass
    if co.get('truncated_protein_length') is not None:
        try:
            parsed_data['protein_start'] = int(co.get('first_insert_aa_pos') or 0)
        except (TypeError, ValueError):
            pass
    if co.get('ptc_aa_position') is not None:
        try:
            parsed_data['novel_stop_aa'] = int(co['ptc_aa_position'])
            parsed_data['downstream_aas'] = int(co.get('downstream_new_aas') or 0)
        except (TypeError, ValueError):
            pass
    if 'nmd_escape' in co:
        parsed_data['nmd_escape'] = co['nmd_escape']
    if co.get('nmd_reason'):
        parsed_data['nmd_reason'] = co['nmd_reason']
    trunc_pct = co.get('truncation_pct')
    full_len = co.get('full_protein_length')
    ptc_aa = co.get('ptc_aa_position')
    if tf is not None and full_len and ptc_aa:
        pct = round(float(tf) * 100, 1)
        if is_severe_loss(float(tf)):
            parsed_data['nmd_math'] = (
                f"Duplication-baseline PTC at aa {ptc_aa} truncates ≥10% of the "
                f"{full_len}-aa protein ({pct}% lost) → severe C-terminal loss."
            )
        elif co.get('nmd_escape') and is_marginal_loss(float(tf)):
            parsed_data['nmd_math'] = (
                f"Duplication-baseline PTC at aa {ptc_aa} escapes NMD but only {pct}% "
                f"of the {full_len}-aa protein is lost (<10%) → scan 3′ truncated region "
                f"for pathogenic variants in the missing C-terminal segment."
            )
            parsed_data['dup_baseline_needs_3prime_plp'] = True
        else:
            parsed_data['nmd_math'] = (
                f"Duplication-baseline PTC at aa {ptc_aa} ({pct}% of {full_len} aa lost, "
                f"<10%) → NMD may apply; still evaluate pathogenic change in the truncated "
                f"C-terminal region."
            )
            parsed_data['dup_baseline_needs_3prime_plp'] = True


def _lookup_clinvar_plp_downstream_of_ptc(http_session, parsed_data, effective_gene):
    """3′ follow-up: P/LP in ClinVar downstream of duplication-baseline PTC / fs anchor."""
    if parsed_data.get('has_downstream_pathogenic'):
        return
    from vc_engine.regions import _downstream_plp_anchor_aa

    current_pos = _downstream_plp_anchor_aa(parsed_data)
    if current_pos <= 0:
        return
    try:
        p_query_url = (
            f'https://myvariant.info/v1/query?q=clinvar.gene.symbol:"{effective_gene}"%20AND%20'
            f'(clinvar.rcv.clinical_significance:pathogenic%20OR%20clinvar.rcv.clinical_significance:likely_pathogenic)'
            f'&fields=snpeff.ann.protein.position,clinvar.rcv.accession,clinvar.gene,clinvar.hgvs,clinvar.variant_id&size=1000'
        )
        p_resp = http_session.get(p_query_url, timeout=15)
        if p_resp.status_code != 200:
            return
        _downstream_seen = set()
        _downstream_plp_accum = []
        for hit in p_resp.json().get('hits', []):
            ann = hit.get('snpeff', {}).get('ann', [])
            if isinstance(ann, dict):
                ann = [ann]
            hgvs = hit.get('clinvar', {}).get('hgvs', {})
            hgvs_p = hgvs.get('protein', '') if isinstance(hgvs, dict) else ''
            if isinstance(hgvs_p, list):
                hgvs_p = ' '.join(hgvs_p)
            pos_vals = []
            for a in ann:
                pos_str = str(a.get('protein', {}).get('position', ''))
                if pos_str:
                    try:
                        pos_vals.append(int(pos_str.split('/')[0]))
                    except Exception:
                        pass
            for m in re.findall(r"p\.(?:[A-Za-z]{3}|[A-Za-z*])(\d+)", str(hgvs_p)):
                pos_vals.append(int(m))
            qual = [p for p in sorted(set(pos_vals)) if p > current_pos]
            if not qual:
                continue
            rcv_arr = hit.get('clinvar', {}).get('rcv', [])
            if isinstance(rcv_arr, dict):
                rcv_arr = [rcv_arr]
            raw_sig = 'Pathogenic'
            if rcv_arr:
                raw_sig = rcv_arr[0].get('clinical_significance', 'Pathogenic').replace('_', ' ').title()
            if 'pathogenic' not in raw_sig.lower() or 'conflicting' in raw_sig.lower():
                continue
            variant_id_hit = str(hit.get('clinvar', {}).get('variant_id') or '')
            accession = (rcv_arr[0].get('accession', '') if rcv_arr else '') or variant_id_hit
            dk = str(variant_id_hit or accession)
            if dk in _downstream_seen:
                continue
            _downstream_seen.add(dk)
            c_notation = 'Unknown c.'
            if ann:
                c_str = (ann[0].get('hgvs_c') or '')
                if c_str and ':' in c_str:
                    c_notation = c_str.split(':')[-1]
            _downstream_plp_accum.append({
                'label': f"{c_notation} ({raw_sig})",
                'link': clinvar_portal_url(accession) if accession else '',
                'clinvar_vid': variant_id_hit if variant_id_hit.isdigit() else '',
                'position': min(qual),
                'source': 'clinvar',
            })
        if _downstream_plp_accum:
            _downstream_plp_accum.sort(key=lambda x: int(x.get('position') or 0))
            parsed_data['downstream_pathogenic_hits'] = _downstream_plp_accum
            parsed_data['has_downstream_pathogenic'] = True
            parsed_data['auto_downstream_pathogenic'] = True
            parsed_data['downstream_pathogenic_string'] = _downstream_plp_accum[0]['label']
            _finalize_plp_region_links(parsed_data, effective_gene)
            parsed_data['nmd_math'] = (
                (parsed_data.get('nmd_math') or '')
                + f" ClinVar P/LP downstream of novel PTC (aa >{current_pos}): "
                + _downstream_plp_accum[0]['label']
            ).strip()
    except Exception as exc:
        print(f"Dup-baseline 3′ P/LP lookup error: {exc}")


def _deep_intronic_dup_baseline_bundle(parsed_data, cds_seq, coding_exons, c_dot, ins_seq, details):
    """
    Primary product when an intronic duplication is modeled first: retained dup in transcript
    → frameshift PTC (e.g. p.Ala542Serfs*19) before alternate SpliceAI splice fates.
    """
    if not ins_seq or not cds_seq:
        return None
    insert_idx = _deep_intronic_dup_cds_insert_index(c_dot)
    if insert_idx is None or insert_idx > len(cds_seq):
        return None
    ins = str(ins_seq).upper()
    mutant_cds = cds_seq[:insert_idx] + ins + cds_seq[insert_idx:]
    co = _ptc_nmd_outcome_from_mutant_cds(
        mutant_cds,
        cds_seq,
        insert_idx,
        len(ins),
        coding_exons,
        parsed_data,
        cryptic_type='Duplication (retained in transcript)',
        gain_signal=0.0,
        loss_signal=0.0,
        inserted_cdna=ins,
        dup_baseline_naming=True,
        dup_insert_idx=insert_idx,
    )
    if not co or co.get('no_stop_found'):
        return None
    cx = _deep_intronic_upstream_exon_for_acceptor_side(parsed_data, coding_exons, details)
    anchor_rank = int(cx.get('anatomical_rank') or 0) if cx else None
    if anchor_rank:
        co = _annotate_ptc_location(co, anchor_exon_rank=anchor_rank, downstream_exon_rank=anchor_rank + 1)
    mech = (
        f"<b>Duplication baseline ({len(ins)} nt)</b>: duplicated sequence retained in the "
        f"mature transcript at c.{insert_idx + 1} (before modeling cryptic splice). "
        f"Not splice-corrected — direct ORF consequence of the inserted material."
    )
    ag_note = _deep_intronic_dup_ag_competition_html(ins, details)
    if ag_note:
        mech += f"<br>{ag_note}"
    html = _format_splice_product_outcome_html(
        co,
        parsed_data,
        mech,
        product_role='Product 1 (duplication baseline)',
        signal_sig=None,
    )
    return {
        'html': html,
        'outcome': co,
        'viz': {
            'model': 'dup_baseline',
            'anchor_exon_rank': anchor_rank,
            'pseudoexon_retained_nt': len(ins),
            'mechanism': 'dup_retained',
        },
    }


def compute_deep_intronic_splice_math(http_session, parsed_data, c_dot):
    """
    Transcript-oriented intron scan: AG/GT positions, AGT overlap at variant, and GT→AG pseudo-exon spans.
    Runs only when SpliceAI or Pangolin crosses DEEP_INTRONIC_MIN_SPLICE_PREDICTOR (in silico gate).
    Heuristic only — not proof of splicing.
    """
    out = {
        'eligible': False,
        'summary_html': '',
        'details': {},
    }
    if not _deep_intronic_should_run(parsed_data.get('consequence'), c_dot):
        out['reason'] = 'Not an intron HGVS / intron_variant consequence.'
        return out

    supported, pred_html = _deep_intronic_in_silico_support_html(parsed_data)
    if not supported:
        out['reason'] = (
            f'No SpliceAI or Pangolin score ≥ {DEEP_INTRONIC_MIN_SPLICE_PREDICTOR:.2f}; '
            'deep intronic scan omitted until in silico splicing suggests cryptic site involvement.'
        )
        out['details']['predictor_gate_failed'] = True
        return out

    enst = (parsed_data.get('ensembl_transcript_id') or '').strip()
    if not enst.startswith('ENST'):
        out['reason'] = 'Missing Ensembl transcript (ENST) for intron structure.'
        return out

    chrom = (parsed_data.get('grch38_chrom') or '').replace('chr', '')
    vpos = parsed_data.get('grch38_start')
    if not chrom or vpos is None:
        out['reason'] = 'Missing GRCh38 coordinates (grch38_chrom / grch38_start).'
        return out
    vpos = int(vpos)

    clean_enst = enst.split('.')[0]
    lookup_url = f'https://rest.ensembl.org/lookup/id/{clean_enst}?expand=1'
    lk = http_session.get(lookup_url, timeout=120)
    if lk.status_code != 200:
        out['reason'] = f'Ensembl lookup failed ({lk.status_code}).'
        return out

    try:
        d = lk.json()
    except Exception:
        out['reason'] = 'Ensembl lookup returned non-JSON.'
        return out

    exons = d.get('Exon') or []
    strand = d.get('strand') or 1
    if not exons or len(exons) < 2:
        out['reason'] = 'Transcript has no multi-exon structure in Ensembl.'
        return out

    exons = list(exons)
    exons.sort(key=lambda x: x['start'] if strand == 1 else -x['start'])

    introns = []
    for i in range(len(exons) - 1):
        e5, e3 = exons[i], exons[i + 1]
        if strand == 1:
            lo = int(e5['end']) + 1
            hi = int(e3['start']) - 1
        else:
            lo = int(e3['end']) + 1
            hi = int(e5['start']) - 1
        if hi < lo:
            continue
        introns.append(
            {
                'intron_index_1based': i + 1,
                'lo': lo,
                'hi': hi,
                'length_nt': hi - lo + 1,
            }
        )

    hit = None
    for it in introns:
        if it['lo'] <= vpos <= it['hi']:
            hit = it
            break
    if not hit:
        out['reason'] = 'Variant position is not inside a computed intron interval.'
        out['details'] = {'introns_preview': introns[:8], 'vpos': vpos}
        return out

    lo, hi = hit['lo'], hit['hi']
    raw = _fetch_plus_strand_sequence(http_session, chrom, lo, hi, timeout=120)
    if not raw:
        out['reason'] = f'Genomic intron sequence fetch failed ({chrom}:{lo}-{hi}).'
        return out

    L = len(raw)
    if strand == 1:
        j_var = vpos - lo
    else:
        j_var = hi - vpos
    if j_var < 0 or j_var >= L:
        out['reason'] = 'Variant index falls outside fetched intron sequence.'
        return out

    intron_tx = _dna_revcomp(raw) if strand == -1 else raw.upper()

    hgvs_off = None
    hgvs_minus = _deep_intronic_hgvs_minus_offset(c_dot)
    hgvs_plus = _deep_intronic_hgvs_plus_offset(c_dot)
    if hgvs_minus is not None:
        hgvs_off = hgvs_minus
    elif hgvs_plus is not None:
        hgvs_off = hgvs_plus
    one_based_intron = j_var + 1
    offset_mismatch = None
    if hgvs_off is not None:
        if hgvs_minus is not None:
            from_acceptor = L - one_based_intron + 1
            if abs(hgvs_off - from_acceptor) > 2:
                offset_mismatch = (
                    f'HGVS c.N−{hgvs_off} ({from_acceptor} nt from acceptor in fetched intron) '
                    f'vs 5′-oriented index {one_based_intron} (check transcript/strand).'
                )
        elif hgvs_plus is not None and abs(hgvs_off - one_based_intron) > 2:
            offset_mismatch = (
                f'HGVS c.N+{hgvs_off} vs transcript-oriented 5′ index {one_based_intron} '
                f'(check transcript/strand).'
            )

    ref_b, alt_b = _ensure_splice_ref_alt(parsed_data, http_session, c_dot)
    j_var_hgvs = _intronic_j_var_from_hgvs(L, c_dot, j_var)
    mut_seq, dup_insert, change_kind = _apply_ref_alt_to_intron_sequence(
        intron_tx, j_var_hgvs, ref_b, alt_b,
    )
    if change_kind == 'unchanged' and re.search(r'dup', (c_dot or ''), re.I):
        snv = re.search(r'([ACGT])>([ACGT])', (c_dot or '').upper())
        if snv and intron_tx[j_var].upper() == snv.group(1).upper():
            m = list(intron_tx)
            m[j_var] = snv.group(2).upper()
            mut_seq = ''.join(m)
            change_kind = 'snv'
    if change_kind == 'unchanged':
        mut_seq = intron_tx

    def agt_note(seq, j):
        if j >= 1 and j + 1 < len(seq):
            trip = seq[j - 1 : j + 2].upper()
            if trip == 'AGT':
                return (
                    'Variant sits in an AGT context (A is the first base of AG; G is donor G). '
                    'An A→G-style change can remove the AG acceptor dinucleotide while leaving a downstream GT donor intact—evaluate competition with the canonical splice sites.'
                )
        return None

    pairs_wt = _find_gt_ag_pairs(intron_tx)
    pairs_mut = _find_gt_ag_pairs(mut_seq) if mut_seq else []

    def filt_down(ps, j):
        return [p for p in ps if p['donor_gt_0based'] >= max(0, j - 1)]

    down_wt = filt_down(pairs_wt, j_var)[:8]
    down_mut = filt_down(pairs_mut, j_var)[:8] if mut_seq else []

    def _pseudo_exon_from_pair(p, source_label):
        """Cryptic donor GT … cryptic acceptor AG: size if this pair defined a retained mini-exon."""
        if not p:
            return None
        inc = p['span_including_dinucs_nt']
        return {
            'source': source_label,
            'cryptic_gt_0based': p['donor_gt_0based'],
            'cryptic_ag_0based': p['acceptor_ag_0based'],
            'intervening_nt_between_splice_dinucs': p['internal_nt'],
            'inclusive_pseudo_exon_nt': inc,
        }

    pseudo_wt = _pseudo_exon_from_pair(down_wt[0], 'downstream_of_variant') if down_wt else None
    if not pseudo_wt and pairs_wt:
        pseudo_wt = _pseudo_exon_from_pair(pairs_wt[0], 'first_in_intron_from_5prime')
    pseudo_mut = _pseudo_exon_from_pair(down_mut[0], 'downstream_of_variant') if (mut_seq and down_mut) else None

    first_gt = intron_tx.upper().find('GT')
    last_ag = intron_tx.upper().rfind('AG')

    deep_flag = False
    if hgvs_off is not None and hgvs_off >= 25:
        deep_flag = True
    elif hit['length_nt'] >= 80 and one_based_intron >= 25:
        deep_flag = True

    pdg = _parse_spliceai_dp(parsed_data.get('spliceai_dp_dg'))
    pag = _parse_spliceai_dp(parsed_data.get('spliceai_dp_ag'))
    sdg = float(parsed_data.get('spliceai_ds_dg') or 0.0)
    sag = float(parsed_data.get('spliceai_ds_ag') or 0.0)
    spliceai_implied = None
    if pdg is not None and pag is not None:
        spliceai_implied = {
            'donor_gain_delta_bp': pdg,
            'acceptor_gain_delta_bp': pag,
            'donor_gain_score': sdg,
            'acceptor_gain_score': sag,
            'distance_between_gain_peaks_nt': abs(pag - pdg),
        }

    details = {
        'ensembl_transcript': enst,
        'strand': strand,
        'chromosome': chrom,
        'intron_index_1based': hit['intron_index_1based'],
        'intron_length_nt': hit['length_nt'],
        'variant_genomic_pos': vpos,
        'variant_intron_pos_1based': one_based_intron,
        'canonical_first_gt_0based': first_gt if first_gt >= 0 else None,
        'canonical_last_ag_0based': last_ag if last_ag >= 0 else None,
        'gt_ag_pairs_wt': pairs_wt[:12],
        'gt_ag_pairs_downstream_of_variant_wt': down_wt,
        'gt_ag_pairs_downstream_of_variant_mut': down_mut,
        'pseudo_exon_candidate_wt': pseudo_wt,
        'pseudo_exon_candidate_mut': pseudo_mut,
        'agt_note_wt': agt_note(intron_tx, j_var),
        'agt_note_mut': agt_note(mut_seq, j_var) if mut_seq else None,
        'hgvs_offset_mismatch': offset_mismatch,
        'deep_intronic_evidence': deep_flag,
        'spliceai_implied_span': spliceai_implied,
        'dup_insert_seq': dup_insert or None,
        'intron_change_kind': change_kind,
    }
    out['details'] = details
    out['eligible'] = True

    esc = html.escape
    depth_word = 'Deep intronic' if deep_flag else 'Intronic'
    bits = []
    if pred_html:
        bits.append(pred_html)
    bits.append(
        f"<strong>{depth_word}</strong>: {one_based_intron} nt into intron {hit['intron_index_1based']}/{max(1, len(exons) - 1)} "
        f"({hit['length_nt']} nt, {esc(enst)})."
    )
    if dup_insert:
        bits.append(
            f"<b>Duplication modeled first</b> ({len(dup_insert)} nt inserted into intron sequence); "
            f"SpliceAI products below are <b>alternate splice fates</b> on the duplicated allele."
        )
        ag_note = _deep_intronic_dup_ag_competition_html(dup_insert, details)
        if ag_note:
            bits.append(ag_note)
    pseudo_size = (pseudo_mut or pseudo_wt or {}).get('inclusive_pseudo_exon_nt')
    if pseudo_size:
        seq_lbl = (
            'mutant intron (with duplication)'
            if dup_insert
            else 'reference intron sequence only'
        )
        bits.append(
            f"Heuristic GT→AG scan on <b>{seq_lbl}</b>: nearest downstream pair spans ~{pseudo_size} nt "
            f"including splice dinucleotides — hypothetical cryptic mini-exon if both motifs were used."
        )
    if spliceai_implied and (spliceai_implied['donor_gain_score'] >= 0.20 or spliceai_implied['acceptor_gain_score'] >= 0.20):
        si = spliceai_implied
        bits.append(
            f"SpliceAI gain peaks ≈ {si['distance_between_gain_peaks_nt']} nt apart "
            f"(donor Δ{si['donor_gain_delta_bp']} bp DS {si['donor_gain_score']:.2f}; "
            f"acceptor Δ{si['acceptor_gain_delta_bp']} bp DS {si['acceptor_gain_score']:.2f})."
        )
    out['summary_html'] = '<span style="font-size:0.95em;">' + ' '.join(bits) + '</span>'
    out['summary_plain'] = html.unescape(
        re.sub(r'<[^>]+>', ' ', out['summary_html'].replace('<br>', ' '))
    )
    out['summary_plain'] = ' '.join(out['summary_plain'].split())

    details['mut_intron_tx_seq'] = mut_seq if mut_seq else None
    details['wt_intron_tx_seq'] = intron_tx
    details['variant_intron_j_var'] = j_var
    details['variant_intron_j_var_hgvs'] = _intronic_j_var_from_hgvs(L, c_dot, j_var)
    out['details'] = details
    return out


def _spliceai_dp_to_intron_idx(j_var, dp, strand):
    """Map SpliceAI DP to index in transcript-oriented intron (5′→3′). Same rule everywhere."""
    return _spliceai_dp_transcript_oriented(j_var, dp, strand)


def _spliceai_dp_transcript_oriented(j_var, dp, transcript_strand):
    """
    SpliceAI Δ is on the reference genome; flip sign on minus-strand transcripts so
    Δ is always relative to the variant along transcript-oriented intron sequence.
    """
    if dp is None or j_var is None:
        return None
    try:
        j = int(j_var)
        d = int(dp)
    except (TypeError, ValueError):
        return None
    if int(transcript_strand or 1) == -1:
        d = -d
    return j + d


def _intronic_j_var_from_hgvs(intron_len, c_dot, j_var_fallback):
    """Canonical variant index (0-based, 5′→3′ intron) from HGVS c.N± when available."""
    try:
        L = int(intron_len or 0)
    except (TypeError, ValueError):
        L = 0
    if L <= 0:
        return j_var_fallback
    hgvs_m = _deep_intronic_hgvs_minus_offset(c_dot)
    if hgvs_m is not None:
        return L - int(hgvs_m)
    hgvs_p = _deep_intronic_hgvs_plus_offset(c_dot)
    if hgvs_p is not None:
        return int(hgvs_p) - 1
    return j_var_fallback


_SPLICEAI_KIND_DINUC = {
    'acceptor_gain': 'AG',
    'donor_gain': 'GT',
    'acceptor_loss': 'AG',
    'donor_loss': 'GT',
}


def _spliceai_cdna_site_1based(cds_pos, dp, transcript_strand):
    """SpliceAI Δ → 1-based cDNA position (transcript-oriented). Used in exon-internal cryptic math."""
    if cds_pos is None or dp is None:
        return None
    try:
        c0 = int(cds_pos) - 1
    except (TypeError, ValueError):
        return None
    idx0 = _spliceai_dp_transcript_oriented(c0, dp, transcript_strand)
    if idx0 is None:
        return None
    return int(idx0) + 1


def _spliceai_site_locus(mut_seq, j_var, dp, kind, c_dot, transcript_strand, hgvs_intron=True):
    """
    Step 2 for every SpliceAI signal: Δ → 0-based dinucleotide start (5′→3′).

    Unified placement: variant_index + transcript-oriented Δ, then snap to nearest dinuc.
    hgvs_intron=True only re-anchors j_var from HGVS c.N± on the full intron sequence;
    hgvs_intron=False keeps j_var as already mapped in a junction/exon slice.
    """
    dinuc = _SPLICEAI_KIND_DINUC.get(kind)
    if not dinuc:
        return None, j_var
    seq = str(mut_seq or '')
    L = len(seq)
    if L < 2 or dp is None:
        return None, j_var
    if hgvs_intron:
        j_var = _intronic_j_var_from_hgvs(L, c_dot, j_var)
    center = _spliceai_dp_transcript_oriented(j_var, dp, transcript_strand)
    idx = _find_dinuc_near(seq, center, dinuc)
    if idx is not None:
        return idx, j_var
    if center is not None and 0 <= int(center) <= L - 2:
        return int(center), j_var
    return None, j_var


def _junction_spliceai_cryptic_site(
    parsed_data, mut_seq, transcript_seq, var_idx_t, is_acceptor, strand, c_dot, junction_t_idx,
    search_radius=30,
):
    """
    Canonical-junction resolver: same SpliceAI Δ math as deep intronic (_spliceai_site_locus),
    with j_var already mapped in the junction slice (hgvs_intron=False).

    Falls back to scanning ±search_radius nt if SpliceAI site is missing or below threshold.
    Returns (site_start_0based, used_spliceai) or (None, False).
    """
    if is_acceptor:
        kind = 'acceptor_gain'
        canon_start = junction_t_idx - 2
        dp = _parse_spliceai_dp(parsed_data.get('spliceai_dp_ag'))
        try:
            ds = float(parsed_data.get('spliceai_ds_ag') or 0)
        except (TypeError, ValueError):
            ds = 0.0
        dinuc = 'AG'
    else:
        kind = 'donor_gain'
        canon_start = junction_t_idx + 1
        dp = _parse_spliceai_dp(parsed_data.get('spliceai_dp_dg'))
        try:
            ds = float(parsed_data.get('spliceai_ds_dg') or 0)
        except (TypeError, ValueError):
            ds = 0.0
        dinuc = 'GT'

    canonical_still = (
        0 <= canon_start <= len(transcript_seq) - 2
        and transcript_seq[canon_start : canon_start + 2] == dinuc
        and mut_seq[canon_start : canon_start + 2] == dinuc
    )

    def _gain_shift(site):
        if site is None:
            return None
        if is_acceptor:
            return junction_t_idx - (site + 2)
        return (site - 1) - junction_t_idx

    def _valid_gain_site(site):
        sh = _gain_shift(site)
        if sh is None or sh == 0:
            return False
        if is_acceptor:
            return -search_radius <= sh <= search_radius
        return 0 < sh <= search_radius

    site_i = None
    used_spliceai = False
    dp_center = None
    if dp is not None and ds >= 0.20:
        site_i, _ = _spliceai_site_locus(
            mut_seq, var_idx_t, dp, kind, c_dot, strand, hgvs_intron=False,
        )
        try:
            dp_center = _spliceai_dp_transcript_oriented(var_idx_t, dp, strand)
        except Exception:
            dp_center = None

    if site_i is not None:
        # Require a real AG/GT (SpliceAI Δ can land between dinucleotides, e.g. +21 → GT at +23).
        snapped = _snap_cryptic_site_in_seq(
            mut_seq,
            site_i,
            is_donor=not is_acceptor,
            slack=12,
            min_pos=max(0, junction_t_idx - search_radius),
            max_pos=min(len(mut_seq) - 2, junction_t_idx + search_radius),
        )
        site_i = snapped if snapped >= 0 else None
        if site_i is not None:
            if canonical_still and site_i == canon_start:
                site_i = None
            elif not _valid_gain_site(site_i):
                site_i = None
            else:
                used_spliceai = True

    search_lo = max(0, junction_t_idx - search_radius)
    search_hi = min(len(mut_seq) - 1, junction_t_idx + search_radius)
    wt_set = set()
    for i in range(search_lo, search_hi):
        if transcript_seq[i : i + 2] == dinuc:
            wt_set.add(i)

    valid_sites = [
        i for i in range(search_lo, search_hi + 1)
        if mut_seq[i : i + 2] == dinuc
        and _valid_gain_site(i)
        and not (canonical_still and i == canon_start)
    ]
    if not valid_sites:
        return None, False

    if site_i is not None and _valid_gain_site(site_i):
        return site_i, True

    # Fallback: prefer SpliceAI Δ neighborhood when available; else closest to junction.
    # Prefer dinucleotides created by the variant over pre-existing WT sites.
    def _sort_key(i):
        sh = abs(_gain_shift(i) or 999)
        dp_dist = abs(i - dp_center) if dp_center is not None else sh
        return (dp_dist if dp_center is not None else sh, sh, 1 if i in wt_set else 0)

    valid_sites.sort(key=_sort_key)
    return valid_sites[0], False


def _spliceai_loss_skip_exon(kind, parsed_data, coding_exons, details):
    """
    Step 3 for loss signals: which coding exon is skipped when the canonical site is lost.
    Donor loss → upstream (5′) exon of the intron; acceptor loss → downstream (3′) exon.
    """
    if kind == 'acceptor_loss':
        return _deep_intronic_downstream_exon_for_acceptor_side(parsed_data, coding_exons, details)
    if kind == 'donor_loss':
        return _deep_intronic_upstream_exon_for_acceptor_side(parsed_data, coding_exons, details)
    return None


def _spliceai_loss_product(cx_skip, cds_seq, coding_exons, parsed_data, kind, dp, ds):
    """Step 4 for loss: whole-exon skip outcome + mechanism line."""
    if not cx_skip:
        return None
    co = _exon_skip_product_outcome(cx_skip, cds_seq, coding_exons, parsed_data, loss_signal=ds)
    if not co:
        return None
    co['product_plain_summary'] = _format_splice_product_plain_summary(co, parsed_data)
    side = 'acceptor' if kind == 'acceptor_loss' else 'donor'
    rank = cx_skip.get('anatomical_rank')
    mech = (
        f"Canonical <b>{side} loss</b> at Δ{int(dp):+d} bp from variant "
        f"(SpliceAI DS_{'AL' if kind == 'acceptor_loss' else 'DL'} {ds:.2f}) "
        f"&rarr; whole-exon skip of exon {rank}"
    )
    return {
        'html': _format_splice_product_outcome_html(
            co, parsed_data, mech,
            product_role='Product 2 (loss / exon skip)',
            signal_sig={'kind': kind, 'ds': ds, 'dp': dp},
        ),
        'outcome': co,
        'viz': {
            'exon_rank': rank,
            'mechanism': f"3prime_{side}_loss" if kind == 'acceptor_loss' else '5prime_donor_loss',
            'outcome': co,
        },
    }


def _find_dinuc_near(seq, center_idx, dinuc, slack=5):
    """Return start index of dinuc (AG/GT) within ±slack of center, or None."""
    if not seq or center_idx is None:
        return None
    try:
        c = int(center_idx)
    except (TypeError, ValueError):
        return None
    want = (dinuc or '').upper()
    if len(want) != 2:
        return None
    n = len(seq)
    best = None
    best_dist = slack + 1
    for delta in range(-slack, slack + 1):
        i = c + delta
        if 0 <= i <= n - 2 and str(seq[i : i + 2]).upper() == want:
            dist = abs(delta)
            if dist < best_dist:
                best_dist = dist
                best = i
    return best


def _junction_align_track_seq(bases):
    """Uppercase nt string for a junction map track (deleted gaps → N)."""
    return ''.join(
        (b.get('nt') or 'N').upper()
        for b in (bases or [])
        if (b.get('nt') or '') != '·'
    )


def _snap_cryptic_site_in_seq(seq, site_pos, *, is_donor=True, slack=12, min_pos=0, max_pos=None):
    """
    Map a predicted cryptic gain coordinate to the nearest GT (donor) or AG (acceptor).
    Never return site_pos when that index is not the dinucleotide itself.
    """
    seq = str(seq or '').upper()
    if not seq:
        return -1
    try:
        pos = int(site_pos)
    except (TypeError, ValueError):
        return -1
    dinuc = 'GT' if is_donor else 'AG'
    if 0 <= pos <= len(seq) - 2 and seq[pos:pos + 2] == dinuc:
        if pos >= min_pos and (max_pos is None or pos <= max_pos):
            return pos
    snapped = _find_dinuc_near(seq, pos, dinuc, slack=slack)
    if snapped is None:
        snapped = _find_dinuc_near(seq, pos, dinuc, slack=max(slack, 20))
    if snapped is None:
        return -1
    if snapped < min_pos or (max_pos is not None and snapped > max_pos):
        return -1
    return snapped


def _junction_align_cryptic_ag_after_retained(mut_bases, inserted_cdna):
    """Acceptor gain: cryptic AG sits immediately 3′ of the retained intronic body."""
    ins = str(inserted_cdna or '').upper()
    if not ins or not mut_bases:
        return -1
    seq = _junction_align_track_seq(mut_bases)
    intron_start = len(_junction_align_leading_exon_bases(mut_bases))

    pos = seq.find(ins, max(intron_start, 0))
    if pos >= 0:
        ag_idx = pos + len(ins)
        if ag_idx + 1 < len(seq) and seq[ag_idx:ag_idx + 2] == 'AG':
            return ag_idx

    ins_len = len(ins)
    min_before = max(8, ins_len - 4)
    best_ag = -1
    best_match = 0
    for ag_i in range(max(intron_start + min_before, intron_start), len(seq) - 1):
        if seq[ag_i:ag_i + 2] != 'AG':
            continue
        retained = seq[intron_start:ag_i]
        for skip in range(0, 4):
            chunk = retained[skip:]
            match_len = min(len(chunk), ins_len)
            if match_len >= ins_len - 4 and chunk[:match_len] == ins[:match_len]:
                if match_len > best_match:
                    best_match = match_len
                    best_ag = ag_i
    return best_ag


def _junction_align_snap_cryptic_gain_index(
    bases,
    center_idx=-1,
    *,
    is_donor=True,
    slack=12,
    min_idx=0,
    max_idx=None,
    inserted_cdna=None,
    parsed_data=None,
    anchor_c=None,
):
    """
    Unified cryptic splice gain placement: snap to GT/AG near the predicted +bp,
    not blindly on the HGVS coordinate.
    """
    if not bases:
        return -1
    ins = str(inserted_cdna or '').upper() or None
    if ins:
        if is_donor:
            idx = _junction_align_cryptic_gt_after_retained(bases, ins)
        else:
            idx = _junction_align_cryptic_ag_after_retained(bases, ins)
        if idx >= 0:
            return idx

    seq = _junction_align_track_seq(bases)
    if not seq:
        return -1

    center = center_idx
    if center is None or center < 0:
        center = -1
    else:
        try:
            center = int(center_idx)
        except (TypeError, ValueError):
            center = -1

    if center < 0 and parsed_data is not None:
        dp_key = 'spliceai_dp_dg' if is_donor else 'spliceai_dp_ag'
        dp = _parse_spliceai_dp(parsed_data.get(dp_key))
        if dp is not None:
            try:
                anchor = int(anchor_c or parsed_data.get('snpeff_cds_pos') or 0)
            except (TypeError, ValueError):
                anchor = 0
            strand = int(parsed_data.get('transcript_strand') or 1)
            j_idx = _junction_align_bases_hgvs_index(bases, f'c.{anchor}')
            if j_idx < 0:
                ex = _junction_align_leading_exon_bases(bases)
                j_idx = len(ex) - 1 if ex else 0
            center = _spliceai_dp_transcript_oriented(j_idx, dp, strand)

    if center >= 0:
        snapped = _snap_cryptic_site_in_seq(
            seq, center, is_donor=is_donor, slack=slack,
            min_pos=min_idx, max_pos=max_idx,
        )
        if snapped >= 0:
            return snapped

    return -1


def _junction_align_refresh_gain_markers(
    bases, markers, *, parsed_data=None, co=None, layout='', is_donor=None,
):
    """Re-snap splice_gain markers to nearest GT/AG (fixes cached/stale ctx)."""
    mut_bases = [dict(b) for b in (bases or [])]
    mut_markers = [dict(m) for m in (markers or [])]
    gain_m = next((m for m in mut_markers if m.get('kind') == 'splice_gain'), None)
    if not gain_m or not mut_bases:
        return mut_bases, mut_markers

    co = co or {}
    if is_donor is None:
        ctype = str(co.get('cryptic_type') or '').lower()
        layout_l = str(layout or '').lower()
        if 'acceptor' in ctype or layout_l == 'acceptor_junction':
            is_donor = False
        elif 'donor' in ctype or layout_l == 'donor_junction':
            is_donor = True
        else:
            lbl = str(gain_m.get('label') or '').lower()
            is_donor = 'gt' in lbl or 'donor' in lbl
            if 'ag' in lbl or 'acceptor' in lbl:
                is_donor = False

    exon_n = len(_junction_align_leading_exon_bases(mut_bases))
    center = gain_m.get('index', -1)
    snapped = _junction_align_snap_cryptic_gain_index(
        mut_bases, center,
        is_donor=is_donor,
        min_idx=exon_n + (1 if is_donor else 0),
        inserted_cdna=co.get('inserted_cdna'),
        parsed_data=parsed_data,
        anchor_c=(parsed_data or {}).get('snpeff_cds_pos'),
    )
    primary = snapped if snapped >= 0 else center
    if snapped >= 0 and snapped != center:
        gain_kind = 'splice_gt' if is_donor else 'splice_ag'
        gain_lbl = 'cryptic GT gained' if is_donor else 'cryptic AG gained'
        for j in range(snapped, min(snapped + 2, len(mut_bases))):
            mut_bases[j] = dict(mut_bases[j], kind=gain_kind)
        gain_m['index'] = snapped
        gain_m['label'] = gain_lbl

    scan_lo, scan_hi = _junction_align_intronic_scan_range(
        mut_bases, is_donor=is_donor, layout=layout,
    )
    mut_bases = _junction_align_mark_intronic_splice_dinucs(
        mut_bases,
        is_donor=is_donor,
        primary_gain_idx=primary,
        intron_start=scan_lo,
        intron_end=scan_hi,
        layout=layout,
    )
    return mut_bases, mut_markers


def _annotate_ptc_location(co, anchor_exon_rank=None, downstream_exon_rank=None):
    """Add ptc_location_kind / ptc_location_label / ptc_location_detail for text + splice map."""
    if not co or co.get('no_stop_found'):
        return co
    if not co.get('fs_ter_str') and co.get('ptc_aa_position') is None:
        return co
    if co.get('ptc_within_insert') or co.get('ptc_in_pseudoexon_nt'):
        e_lo = anchor_exon_rank if anchor_exon_rank is not None else co.get('anchor_exon_rank')
        e_hi = downstream_exon_rank if downstream_exon_rank is not None else co.get('downstream_exon_rank')
        co['ptc_location_kind'] = 'pseudo_exon'
        if e_lo is not None and e_hi is not None:
            co['ptc_location_label'] = f'retained pseudo-exon between exon {e_lo} and exon {e_hi}'
        elif e_lo is not None:
            co['ptc_location_label'] = f'retained pseudo-exon after exon {e_lo}'
        else:
            co['ptc_location_label'] = 'retained intronic pseudo-exon'
        try:
            frac = co.get('ptc_fraction_in_insert')
            ptc_aa = int(co.get('ptc_aa_position') or 0)
            if frac is not None and ptc_aa:
                co['ptc_location_detail'] = (
                    f'~{round(float(frac) * 100)}% along pseudo-exon box; stop at aa {ptc_aa}'
                )
            elif ptc_aa:
                co['ptc_location_detail'] = f'stop at aa {ptc_aa} in mutant ORF'
        except (TypeError, ValueError):
            pass
    elif co.get('exon_skip') and co.get('skipped_exon_rank'):
        co['ptc_location_kind'] = 'coding_exon'
        sk = co.get('skipped_exon_rank')
        if co.get('ptc_exon_rank') is not None:
            er = co['ptc_exon_rank']
            last = co.get('last_coding_rank')
            if last:
                co['ptc_location_label'] = f'native coding exon {er} of {last} (after skip of exon {sk})'
            else:
                co['ptc_location_label'] = f'native coding exon {er} (after skip of exon {sk})'
        else:
            co['ptc_location_label'] = f'ORF after skip of exon {sk}'
    elif co.get('ptc_exon_rank') is not None:
        co['ptc_location_kind'] = 'coding_exon'
        er = co['ptc_exon_rank']
        last = co.get('last_coding_rank')
        if last:
            co['ptc_location_label'] = f'native coding exon {er} of {last}'
        else:
            co['ptc_location_label'] = f'native coding exon {er}'
        try:
            frac = co.get('ptc_fraction_in_exon')
            ptc_aa = int(co.get('ptc_aa_position') or 0)
            if frac is not None:
                co['ptc_location_detail'] = (
                    f'~{round(float(frac) * 100)}% along exon {er} box'
                    + (f'; stop at aa {ptc_aa}' if ptc_aa else '')
                )
            elif ptc_aa:
                co['ptc_location_detail'] = f'stop at aa {ptc_aa} in mutant ORF'
        except (TypeError, ValueError):
            pass
    else:
        co['ptc_location_kind'] = 'unknown'
        co['ptc_location_label'] = 'mutant ORF (anatomical exon not resolved)'
    return co


def _ptc_nmd_outcome_from_mutant_cds(
    mutant_cds,
    cds_seq,
    edit_anchor_cds,
    shift_nt,
    coding_exons,
    parsed_data,
    cryptic_type='Donor gain',
    gain_signal=0.0,
    loss_signal=0.0,
    inserted_cdna='',
    dup_baseline_naming=False,
    dup_insert_idx=None,
):
    """
    Translate a splice-product CDS (after junction edit) into PTC / NMD / truncation fields
    matching cryptic_splice_outcome shape for _build_splice_gain_summary_html.
    """
    if not mutant_cds or not coding_exons:
        return None
    first_changed_codon_idx = max(0, edit_anchor_cds // 3)
    ptc_codon_idx = -1
    first_new_codon_str = ''
    first_new_aa = ''
    for i in range(0, len(mutant_cds) - 2, 3):
        codon = mutant_cds[i : i + 3]
        if len(codon) != 3:
            break
        aa = _CODON_TABLE_FULL.get(codon, 'X')
        codon_idx = i // 3
        if codon_idx == first_changed_codon_idx and not first_new_codon_str:
            first_new_codon_str = codon
            first_new_aa = aa
        if aa == '*':
            ptc_codon_idx = codon_idx
            break

    shift_nt = int(shift_nt or 0)
    in_frame = (abs(shift_nt) % 3 == 0)
    if ptc_codon_idx < 0:
        return {
            'shift_nt': shift_nt,
            'inserted_cdna': inserted_cdna,
            'cryptic_type': cryptic_type,
            'in_frame_shift': in_frame,
            'no_stop_found': True,
            'gain_signal': gain_signal,
            'loss_signal': loss_signal,
        }

    ptc_aa_position = ptc_codon_idx + 1
    first_changed_aa_pos = first_changed_codon_idx + 1
    if cds_seq and len(cds_seq) >= first_changed_aa_pos * 3:
        ref_codon = cds_seq[(first_changed_aa_pos - 1) * 3 : first_changed_aa_pos * 3]
        ref_aa = _CODON_TABLE_FULL.get(ref_codon, 'X')
        ref_aa_3 = _AA_ONE_TO_THREE.get(ref_aa, 'Xaa')
    else:
        ref_aa_3 = _AA_ONE_TO_THREE.get(first_new_aa, first_new_aa)
    first_new_aa_3 = _AA_ONE_TO_THREE.get(first_new_aa, first_new_aa)
    downstream_aas = max(0, ptc_aa_position - first_changed_aa_pos)
    insert_codons = (shift_nt // 3) if (in_frame and shift_nt > 0) else 0
    ptc_cds_pos = (ptc_codon_idx * 3) + 3
    insert_lo = edit_anchor_cds + 1
    insert_hi = edit_anchor_cds + shift_nt if shift_nt > 0 else edit_anchor_cds
    ptc_in_pseudoexon_nt = bool(
        shift_nt > 0 and insert_lo <= ptc_cds_pos <= insert_hi
    )
    if in_frame and insert_codons > 0:
        ptc_within_insert = bool(
            first_changed_codon_idx <= ptc_codon_idx < first_changed_codon_idx + insert_codons
        )
    else:
        ptc_within_insert = ptc_in_pseudoexon_nt
    if in_frame:
        fs_ter_str = f"p.Ter{ptc_aa_position}"
    else:
        fs_ter_str = f"p.{ref_aa_3}{first_changed_aa_pos}{first_new_aa_3}fs*{downstream_aas}"

    naming_aa_pos = None
    if dup_baseline_naming and dup_insert_idx is not None:
        naming_aa_pos = _dup_baseline_naming_aa_pos(dup_insert_idx)
        if naming_aa_pos:
            naming_codon_idx = naming_aa_pos - 1
            if cds_seq and len(cds_seq) >= naming_aa_pos * 3:
                ref_codon_nb = cds_seq[naming_codon_idx * 3 : naming_aa_pos * 3]
                ref_aa_3 = _AA_ONE_TO_THREE.get(_CODON_TABLE_FULL.get(ref_codon_nb, 'X'), 'Xaa')
            if mutant_cds and len(mutant_cds) >= naming_aa_pos * 3:
                mut_codon_nb = mutant_cds[naming_codon_idx * 3 : naming_aa_pos * 3]
                nb_aa = _CODON_TABLE_FULL.get(mut_codon_nb, 'X')
                first_new_aa_3 = _AA_ONE_TO_THREE.get(nb_aa, nb_aa)
            first_changed_aa_pos = naming_aa_pos
            downstream_aas = max(0, ptc_aa_position - (naming_aa_pos - 1))
            fs_ter_str = f"p.{ref_aa_3}{naming_aa_pos}{first_new_aa_3}fs*{downstream_aas}"

    ptc_fraction_in_insert = None
    if ptc_in_pseudoexon_nt and shift_nt > 0:
        try:
            ptc_fraction_in_insert = round((ptc_cds_pos - insert_lo + 0.5) / float(shift_nt), 4)
            ptc_fraction_in_insert = min(0.97, max(0.03, ptc_fraction_in_insert))
        except (TypeError, ValueError, ZeroDivisionError):
            ptc_fraction_in_insert = None
    elif ptc_within_insert and insert_codons > 0 and ptc_aa_position and first_changed_aa_pos:
        try:
            ptc_fraction_in_insert = round(
                (int(ptc_aa_position) - int(first_changed_aa_pos) + 0.5) / float(insert_codons),
                4,
            )
            ptc_fraction_in_insert = min(0.97, max(0.03, ptc_fraction_in_insert))
        except (TypeError, ValueError, ZeroDivisionError):
            ptc_fraction_in_insert = None

    ptc_exon_rank = None
    ptc_fraction_in_exon = None
    delta_at_anchor = shift_nt if shift_nt > 0 else shift_nt
    if not ptc_in_pseudoexon_nt:
        for tcx in coding_exons:
            ts = int(tcx.get('start_cds') or 0)
            te = int(tcx.get('end_cds') or 0)
            adjusted_ts = ts + delta_at_anchor if ts > edit_anchor_cds else ts
            adjusted_te = te + delta_at_anchor if te > edit_anchor_cds else te
            if adjusted_ts <= ptc_cds_pos <= adjusted_te:
                ptc_exon_rank = tcx.get('anatomical_rank')
                span = adjusted_te - adjusted_ts + 1
                if span > 0:
                    cds_tick_1b = min(max((ptc_codon_idx * 3) + 2, adjusted_ts), adjusted_te)
                    ptc_fraction_in_exon = round((cds_tick_1b - adjusted_ts) / float(span), 4)
                break

    last_rank = coding_exons[-1].get('anatomical_rank') if coding_exons else None
    nmd_escape = False
    nmd_reason = ''
    if ptc_in_pseudoexon_nt:
        nmd_escape = False
        nmd_reason = (
            f'PTC within retained pseudo-exon ({shift_nt} nt intronic insert) '
            f'→ predicted NMD'
        )
    elif ptc_exon_rank is not None and last_rank is not None:
        if ptc_exon_rank == last_rank:
            nmd_escape = True
            nmd_reason = 'PTC lies in the last coding exon → escapes NMD.'
        elif ptc_exon_rank == (last_rank - 1):
            target_tcx = next((t for t in coding_exons if t.get('anatomical_rank') == ptc_exon_rank), None)
            if target_tcx:
                target_te = int(target_tcx.get('end_cds') or 0)
                adj_te = target_te + delta_at_anchor if target_te > edit_anchor_cds else target_te
                dist_to_eej = adj_te - ptc_cds_pos
                if dist_to_eej < 50:
                    nmd_escape = True
                    nmd_reason = (
                        f'PTC is {dist_to_eej} nt from the penultimate exon junction (<50 nt rule) → escapes NMD.'
                    )
                else:
                    nmd_reason = (
                        f'PTC is {dist_to_eej} nt from the penultimate exon junction (≥50 nt) → predicted NMD.'
                    )
        else:
            nmd_reason = (
                f'PTC in exon {ptc_exon_rank} (internal; last coding exon {last_rank}) → predicted NMD.'
            )

    try:
        full_protein_length = int(parsed_data.get('protein_length') or 0)
    except (TypeError, ValueError):
        full_protein_length = 0
    if full_protein_length <= 0 and cds_seq:
        full_protein_length = len(cds_seq) // 3
        if full_protein_length > 0:
            parsed_data['protein_length'] = full_protein_length
    truncated_protein_length = max(0, ptc_aa_position - 1)
    truncation_fraction = None
    truncation_pct = None
    retained_pct = None
    if full_protein_length > 0:
        if dup_baseline_naming and naming_aa_pos:
            native_lost_start = naming_aa_pos - 1
            if ptc_aa_position > full_protein_length:
                aas_lost = max(0, full_protein_length - native_lost_start)
                truncated_protein_length = native_lost_start
            else:
                aas_lost = full_protein_length - truncated_protein_length
        else:
            aas_lost = full_protein_length - truncated_protein_length
        truncation_fraction = round(aas_lost / float(full_protein_length), 4)
        truncation_pct = round(truncation_fraction * 100, 1)
        retained_pct = round(100.0 - truncation_pct, 1)

    return _annotate_ptc_location({
        'shift_nt': shift_nt,
        'inserted_cdna': inserted_cdna,
        'cryptic_type': cryptic_type,
        'in_frame_shift': in_frame,
        'first_new_codon': first_new_codon_str,
        'first_new_aa': first_new_aa,
        'ptc_aa_position': ptc_aa_position,
        'downstream_new_aas': downstream_aas,
        'fs_ter_str': fs_ter_str,
        'ptc_exon_rank': ptc_exon_rank,
        'ptc_fraction_in_exon': ptc_fraction_in_exon,
        'ptc_fraction_in_insert': ptc_fraction_in_insert,
        'ptc_in_pseudoexon_nt': ptc_in_pseudoexon_nt,
        'last_coding_rank': last_rank,
        'nmd_escape': nmd_escape,
        'nmd_reason': nmd_reason,
        'gain_signal': gain_signal,
        'loss_signal': loss_signal,
        'truncated_protein_length': truncated_protein_length,
        'full_protein_length': full_protein_length or None,
        'truncation_fraction': truncation_fraction,
        'truncation_pct': truncation_pct,
        'retained_pct': retained_pct,
        'ptc_within_insert': ptc_within_insert,
        'insert_codons': insert_codons if insert_codons > 0 else None,
        'first_insert_aa_pos': (
            (naming_aa_pos - 1) if naming_aa_pos else (first_changed_aa_pos if shift_nt > 0 else None)
        ),
        'first_changed_aa_pos': naming_aa_pos or first_changed_aa_pos,
        'dup_baseline_naming_aa': naming_aa_pos,
        'ref_aa_at_fs': ref_aa_3 if not in_frame else None,
    })


def _hgvs_intron_pos(c_dot, offset_1based, intron_len=None):
    """
    Format HGVS intronic offset. For c.N− variants, convert 5′→3′ intron index to
    acceptor-relative distance (true c.N−k), not raw slice position.
    """
    if offset_1based is None:
        return None
    try:
        off = int(offset_1based)
    except (TypeError, ValueError):
        return None
    m = re.search(r'c\.(\d+)([\+\-])', str(c_dot or ''), re.I)
    if m:
        sign = m.group(2)
        if sign == '-' and intron_len is not None:
            try:
                off = int(intron_len) - off + 1
            except (TypeError, ValueError):
                pass
        return f"c.{m.group(1)}{sign}{off}"
    return f"+{off}"


def _acceptor_gain_junction_proximal(intron_len, ag_start_0based, threshold=50):
    """True when gained AG sits near the canonical acceptor (exon-extension splice)."""
    try:
        L = int(intron_len or 0)
        ag = int(ag_start_0based)
    except (TypeError, ValueError):
        return False
    if L <= 0 or ag < 0:
        return False
    return (L - ag) <= int(threshold)


def _append_pseudoexon_length_compare_lines(lines, geom):
    """
    ORF body vs GT+body+AG span, plus SpliceAI |Δ| when present — for comparison with
    external predictors (e.g. Almut) that often report span or |Δ| instead of ORF body.
    """
    if not lines or not geom:
        return
    try:
        body_nt = int(geom.get('body_nt') or 0)
    except (TypeError, ValueError):
        return
    if body_nt <= 0:
        return
    try:
        span_nt = int(geom.get('span_nt') or 0)
    except (TypeError, ValueError):
        span_nt = 0
    if span_nt <= body_nt:
        span_nt = body_nt + 4
    lines.append(
        f"<b>Length comparison:</b> <b>{body_nt} nt</b> ORF body "
        f"(sequence between splice dinucleotides — enters the CDS) vs "
        f"<b>{span_nt} nt</b> full pseudo-exon span "
        f"(GT + body + AG; splice dinucleotides not translated)"
    )
    target = geom.get('target_body_nt')
    if target is None and geom.get('spliceai_delta') is not None:
        target = geom.get('spliceai_delta')
    try:
        target_i = abs(int(target)) if target is not None else None
    except (TypeError, ValueError):
        target_i = None
    if target_i is not None and target_i != body_nt:
        lines.append(
            f"SpliceAI |Δ| sizing target = <b>{target_i} nt</b>; "
            f"nearest matching GT\u2192AG body in this intron = <b>{body_nt} nt</b> "
            f"(full span <b>{span_nt} nt</b>)"
        )
    lines.append(
        "<span style='color:#94a3b8;font-size:0.92em'>"
        "External splice predictors may report GT+body+AG span or SpliceAI |Δ| rather than ORF body; "
        f"compare using <b>{body_nt} nt</b> (CDS insert) vs <b>{span_nt} nt</b> (full span)."
        "</span>"
    )


def _format_pseudoexon_length_math_html(geom, c_dot=''):
    """
    Line-by-line splice-product length derivation for deep-intronic write-ups.
    Junction-proximal acceptor gain uses exon-extension wording; deep body uses pseudo-exon.
    """
    if not geom:
        return ''
    lines = []
    model = str(geom.get('model') or '')
    mechanism = str(geom.get('mechanism') or '')
    anchor = geom.get('anchor_exon_rank')
    dn_exon = geom.get('downstream_exon_rank')
    body_nt = geom.get('body_nt')
    span_nt = geom.get('span_nt')
    bs = geom.get('body_start_0based')
    de = geom.get('body_end_0based')
    spliceai_dp = geom.get('spliceai_delta')
    intron_len = geom.get('intron_length_nt')
    junction_prox = bool(geom.get('junction_proximal_acceptor'))
    pre_atg_utr = bool(geom.get('pre_atg_utr'))
    var_hgvs = _hgvs_intron_pos(c_dot, geom.get('variant_hgvs_offset'), intron_len)

    try:
        bs_i = int(bs) if bs is not None else None
        de_i = int(de) if de is not None else None
    except (TypeError, ValueError):
        bs_i, de_i = None, None

    if mechanism == 'donor_gain' or model in ('canonical_proximal', 'nearest_intronic_ag'):
        canon_gt = _hgvs_intron_pos(c_dot, geom.get('canonical_gt_hgvs') or 1)
        cryp_gt = _hgvs_intron_pos(c_dot, geom.get('dinuc_hgvs_offset'))
        if anchor and canon_gt:
            lines.append(
                f"5\u2032 splice site: canonical <b>GT</b> at {canon_gt} "
                f"(exon {anchor} donor — splice signal only, not inserted)"
            )
        if model == 'nearest_intronic_ag':
            ag_hgvs = _hgvs_intron_pos(c_dot, geom.get('ag_hgvs_offset'))
            if ag_hgvs and cryp_gt:
                lines.append(
                    f"5\u2032 splice site: intronic <b>AG</b> at {ag_hgvs} "
                    f"(nearest upstream acceptor before cryptic donor)"
                )
        if cryp_gt:
            if spliceai_dp is not None and var_hgvs:
                lines.append(
                    f"3\u2032 splice site: cryptic <b>GT</b> at {cryp_gt} "
                    f"(SpliceAI \u0394{spliceai_dp:+d} bp from variant at {var_hgvs})"
                )
            else:
                lines.append(f"3\u2032 splice site: cryptic <b>GT</b> at {cryp_gt}")
        if bs_i is not None and de_i is not None and body_nt is not None:
            first_hgvs = _hgvs_intron_pos(c_dot, bs_i + 1)
            last_hgvs = _hgvs_intron_pos(c_dot, de_i)
            if model == 'nearest_intronic_ag':
                body_desc = 'bases after intronic AG through base before cryptic GT'
            elif model == 'canonical_proximal':
                body_desc = 'bases after canonical GT through base before cryptic GT'
            else:
                body_desc = (
                    'bases after 5\u2032 splice dinucleotide through base before 3\u2032 splice dinucleotide'
                )
            _body_dest = '5\u2032 UTR (pre-AUG)' if pre_atg_utr else 'ORF'
            lines.append(
                f"Body spliced into {_body_dest}: "
                f"intron[{bs_i}:{de_i}] = <b>{body_nt} nt</b> "
                f"({body_desc})"
            )
            if first_hgvs and last_hgvs:
                lines.append(
                    f"HGVS intron coordinates: {first_hgvs} \u2026 {last_hgvs} "
                    f"({de_i} \u2212 {bs_i} = {de_i - bs_i} nt)"
                )
        if span_nt and body_nt:
            body_dest = (
                f"5\u2032 UTR of the mature mRNA (pre-AUG; annotated CDS unchanged)"
                if pre_atg_utr
                else "CDS"
            )
            lines.append(
                f"Full pseudo-exon span: <b>{span_nt} nt</b> "
                f"(5\u2032 dinucleotide + {body_nt} nt body + 3\u2032 dinucleotide; "
                f"only the {body_nt} nt body enters the {body_dest})"
            )
            total_junc = body_nt + 2
            lines.append(
                f"Total junction extension (incl. canonical GT): <b>{total_junc} nt</b> "
                f"(ORF body {body_nt} nt + canonical GT 2 nt; cryptic GT excluded)"
            )
        if anchor and model == 'canonical_proximal':
            lines.append(
                f"Exon {anchor} <b>AG acceptor reused</b> — not counted in the insert"
            )
    elif mechanism == 'acceptor_gain' or 'acceptor' in model:
        gt_hgvs = _hgvs_intron_pos(c_dot, geom.get('gt_hgvs_offset'), intron_len)
        ag_hgvs = _hgvs_intron_pos(c_dot, geom.get('ag_hgvs_offset'), intron_len)
        exon_lbl = int(dn_exon or (int(anchor) + 1 if anchor else 0) or 0)
        if junction_prox and exon_lbl:
            if ag_hgvs:
                if spliceai_dp is not None and var_hgvs:
                    lines.append(
                        f"3\u2032 splice site: <b>AG</b> at {ag_hgvs} "
                        f"(canonical-proximal acceptor; SpliceAI \u0394{spliceai_dp:+d} bp from variant at {var_hgvs})"
                    )
                else:
                    lines.append(f"3\u2032 splice site: <b>AG</b> at {ag_hgvs} (canonical-proximal acceptor)")
            if gt_hgvs:
                lines.append(
                    f"5\u2032 splice site: <b>GT</b> at {gt_hgvs} (upstream donor paired with acceptor; not inserted)"
                )
            if body_nt is not None:
                lines.append(
                    f"<b>Exon {exon_lbl} extension</b>: <b>{body_nt} nt</b> spliced into the mature mRNA "
                    f"(reference-annotated as intron before splicing, but becomes the new 5\u2032 end of exon {exon_lbl}; "
                    f"AG dinucleotide excluded)"
                )
                total_junc = body_nt + 2
                lines.append(
                    f"Total junction extension (incl. canonical AG): <b>{total_junc} nt</b> "
                    f"(ORF body {body_nt} nt + canonical AG 2 nt)"
                )
            if bs_i is not None and de_i is not None and body_nt is not None:
                first_hgvs = _hgvs_intron_pos(c_dot, bs_i + 1, intron_len)
                last_hgvs = _hgvs_intron_pos(c_dot, de_i, intron_len)
                if first_hgvs and last_hgvs:
                    lines.append(
                        f"Pre-splice slice (intron coordinates): {first_hgvs} \u2026 {last_hgvs} "
                        f"({de_i} \u2212 {bs_i} = {de_i - bs_i} nt)"
                    )
        else:
            if gt_hgvs:
                lines.append(
                    f"5\u2032 splice site: intronic <b>GT</b> at {gt_hgvs} "
                    f"(5\u2032 GT reused — not inserted)"
                )
            if ag_hgvs:
                if spliceai_dp is not None and var_hgvs:
                    lines.append(
                        f"3\u2032 splice site: gained <b>AG</b> at {ag_hgvs} "
                        f"(SpliceAI \u0394{spliceai_dp:+d} bp from variant at {var_hgvs})"
                    )
                else:
                    lines.append(f"3\u2032 splice site: gained <b>AG</b> at {ag_hgvs}")
            if bs_i is not None and de_i is not None and body_nt is not None:
                first_hgvs = _hgvs_intron_pos(c_dot, bs_i + 1, intron_len)
                last_hgvs = _hgvs_intron_pos(c_dot, de_i, intron_len)
                lines.append(
                    f"Retained pseudo-exon body: intron[{bs_i}:{de_i}] = <b>{body_nt} nt</b> "
                    f"(between GT and gained AG; AG excluded)"
                )
                if first_hgvs and last_hgvs:
                    lines.append(
                        f"HGVS intron coordinates: {first_hgvs} \u2026 {last_hgvs} "
                        f"({de_i} \u2212 {bs_i} = {de_i - bs_i} nt)"
                    )
            if span_nt and body_nt:
                lines.append(
                    f"Full pseudo-exon span: <b>{span_nt} nt</b> "
                    f"(5\u2032 GT + {body_nt} nt body + gained AG; only the {body_nt} nt body enters the CDS)"
                )
                total_junc = body_nt + 2
                lines.append(
                    f"Total junction extension (incl. canonical AG): <b>{total_junc} nt</b> "
                    f"(ORF body {body_nt} nt + canonical AG 2 nt; cryptic GT excluded)"
                )
            if anchor:
                lines.append(
                    f"Canonical 3\u2032 acceptor before exon {int(anchor) + 1} is skipped in this model"
                )

    if lines and body_nt:
        try:
            if int(body_nt) > 0:
                _append_pseudoexon_length_compare_lines(lines, geom)
        except (TypeError, ValueError):
            pass

    if not lines:
        return ''
    if junction_prox and (mechanism == 'acceptor_gain' or 'acceptor' in model):
        return '<b>Exon extension (acceptor-gain splice):</b><br>' + '<br>'.join(lines)
    return '<b>Pseudo-exon length:</b><br>' + '<br>'.join(lines)


def _format_splice_product_plain_summary(co, parsed_data=None):
    """One-line product readout: pseudo-exon size, flanking exons, PTC, NMD, truncation %."""
    if not co:
        return ''
    parsed_data = parsed_data or {}
    geom = co.get('pseudoexon_geometry') or {}
    if co.get('exon_skip'):
        rank = co.get('skipped_exon_rank')
        parts = [f'exon {rank} skipped' if rank else 'whole-exon skip']
        fs = (co.get('fs_ter_str') or '').strip()
        if fs and not co.get('no_stop_found'):
            parts.append(f'new PTC ({fs})' if co.get('in_frame_shift') is False else f'outcome ({fs})')
        elif co.get('in_frame_shift'):
            parts.append('in-frame deletion; native stop may be retained')
        if co.get('nmd_escape') is True:
            parts.append('NMD escape predicted')
        elif co.get('nmd_escape') is False:
            parts.append('NMD predicted')
        trunc = co.get('truncation_pct')
        retained = co.get('retained_pct')
        if trunc is not None:
            try:
                tp = float(trunc)
                rp = float(retained) if retained is not None else round(100.0 - tp, 1)
                parts.append(f'~{tp:g}% of protein truncated (~{rp:g}% retained)')
            except (TypeError, ValueError):
                pass
        return '; '.join(p for p in parts if p) + '.'
    if co.get('pre_atg_utr_pseudoexon') or co.get('no_coding_impact'):
        try:
            nt = int(co.get('shift_nt') or len(co.get('inserted_cdna') or '') or 0)
        except (TypeError, ValueError):
            nt = len(co.get('inserted_cdna') or '') or 0
        up = co.get('anchor_exon_rank') or geom.get('anchor_exon_rank')
        dn = co.get('downstream_exon_rank') or geom.get('downstream_exon_rank')
        loc = f'between exons {up} and {dn}' if up and dn else 'before first coding exon'
        return (
            f'{nt} nt 5\u2032 UTR pseudo-exon {loc}; '
            f'annotated ORF unchanged; no coding PTC or NMD.'
        )
    try:
        nt = int(co.get('shift_nt') or len(co.get('inserted_cdna') or '') or geom.get('body_nt') or 0)
    except (TypeError, ValueError):
        nt = len(co.get('inserted_cdna') or '') or 0
    up = co.get('anchor_exon_rank') or geom.get('anchor_exon_rank')
    dn = co.get('downstream_exon_rank') or geom.get('downstream_exon_rank')
    if up and dn:
        loc = f'between exons {up} and {dn}'
    elif up:
        loc = f'after exon {up}'
    else:
        loc = 'in intron'
    try:
        _span = int(geom.get('span_nt') or 0)
    except (TypeError, ValueError):
        _span = 0
    if _span <= nt:
        _span = nt + 4 if nt > 0 else 0
    if _span > nt:
        len_bit = (
            f'{nt} nt ORF body ({_span} nt GT+body+AG span) pseudo-exon {loc}'
        )
    else:
        _len_co = _annotate_junction_extension_fields(dict(co))
        _dual_plain = _format_junction_length_dual_label(_len_co, html=False, plain=True)
        len_bit = f'{nt} nt pseudo-exon {loc}'
        if _dual_plain and _len_co.get('total_junction_extension_nt'):
            len_bit = f'{len_bit} ({_dual_plain})'
    parts = [len_bit]
    if co.get('in_frame_exonization') or co.get('natural_stop_preserved'):
        parts.append('no new PTC (in-frame insert; native stop retained)')
        parts.append('NMD not applicable')
    elif co.get('no_stop_found'):
        parts.append('no premature stop found in ORF')
        parts.append('NMD not applicable')
    else:
        fs = (co.get('fs_ter_str') or '').strip()
        if fs:
            parts.append(f'new PTC ({fs})')
        else:
            parts.append('new PTC predicted')
        if co.get('nmd_escape') is True:
            parts.append('NMD escape predicted')
        elif co.get('nmd_escape') is False:
            parts.append('NMD predicted')
        elif co.get('nmd_reason'):
            parts.append(str(co.get('nmd_reason')).rstrip('.'))
        trunc = co.get('truncation_pct')
        retained = co.get('retained_pct')
        if trunc is not None:
            try:
                tp = float(trunc)
                rp = float(retained) if retained is not None else round(100.0 - tp, 1)
                parts.append(f'~{tp:g}% of protein truncated (~{rp:g}% retained)')
            except (TypeError, ValueError):
                pass
    return '; '.join(p for p in parts if p) + '.'


def _format_splice_product_outcome_html(co, parsed_data, mechanism_intro='', product_role='Product 1 (primary)', signal_sig=None):
    """
    Single-product splice readout for deep-intronic primary/alternate products.
    Uses the same field order as canonical and exon-internal splice products.
    """
    if not co:
        return ''
    bits = []
    _plain = co.get('product_plain_summary') or _format_splice_product_plain_summary(co, parsed_data)
    if _plain:
        bits.append(f'<b>Summary:</b> {_plain}')
    if mechanism_intro:
        bits.append(mechanism_intro.rstrip('.'))
    _c_dot = (parsed_data or {}).get('c_dot') or ''
    _geom = co.get('pseudoexon_geometry') or {}
    _di_details = (parsed_data or {}).get('deep_intronic_splice') or {}
    _di_details = _di_details.get('details') if isinstance(_di_details, dict) else {}
    _pre_atg = bool(
        co.get('pre_atg_utr_pseudoexon')
        or _geom.get('pre_atg_utr')
        or co.get('no_coding_impact')
        or _deep_intronic_cdot_in_pre_first_coding_intron(
            (parsed_data or {}).get('c_dot'),
            (parsed_data or {}).get('coding_exons') or [],
            _di_details or {},
        )
    )
    _geom_html = _format_pseudoexon_length_math_html(_geom, _c_dot)
    if _geom_html:
        bits.append(_geom_html)
    if _pre_atg:
        shift_nt = co.get('shift_nt')
        ins = co.get('inserted_cdna') or ''
        try:
            sh = int(shift_nt or len(ins) or 0)
        except (TypeError, ValueError):
            sh = len(ins) or 0
        anchor = co.get('anchor_exon_rank')
        dn = co.get('downstream_exon_rank')
        if ins:
            _ins_ellipsis = '\u2026' if len(ins) > 40 else ''
            bits.append(
                f"retained sequence in 5\u2032 UTR "
                f"<code>{ins[:40]}{_ins_ellipsis}</code> "
                f"({len(ins)} bp between exon {anchor or '?'} and coding exon {dn or '?'}; "
                f"pre-AUG — not translated as part of the annotated ORF)"
            )
        elif sh > 0:
            bits.append(f"{sh} bp 5\u2032 UTR insert (pre-AUG)")
        bits.append(
            '<b>5\u2032 UTR / pre-AUG</b> — annotated protein ORF unchanged; '
            'not a coding frameshift or predicted ORF-embedded PTC/NMD'
        )
        bits.append(
            'Possible mRNA effects: 5\u2032 UTR length/structure, uORFs, translation initiation — '
            'RNA assays and gene mechanism over protein truncation models'
        )
        if co.get('pre_atg_utr_note'):
            bits.append(co['pre_atg_utr_note'])
        sig = signal_sig or {}
        kind = (sig.get('kind') or 'pseudo-exon gain').replace('_', ' ')
        return _format_unified_splice_product_html(
            product_role,
            f"deep intronic {kind}",
            spliceai_ds=sig.get('ds'),
            spliceai_dp=sig.get('dp'),
            parsed_data=parsed_data,
            geometry='. '.join(b.rstrip('.') for b in bits if b),
            frame='5\u2032 UTR (pre-AUG) — annotated ORF unchanged',
            ptc='not applicable (pre-AUG UTR insert)',
            nmd='not applicable — no coding PTC predicted',
            footnote=co.get('insert_triplet_decode'),
            context_note='Deep intronic pseudo-exon in 5\u2032 UTR',
        )
    shift_nt = co.get('shift_nt')
    if shift_nt is not None:
        try:
            sh = int(shift_nt)
            _len_co = _annotate_junction_extension_fields(dict(co))
            _dual = _format_junction_length_dual_label(_len_co)
            if sh > 0:
                ins = co.get('inserted_cdna') or ''
                _geom = co.get('pseudoexon_geometry') or {}
                _dn_ex = _geom.get('downstream_exon_rank')
                if ins and _geom.get('junction_proximal_acceptor') and _dn_ex:
                    bits.append(
                        f"new 5\u2032 end of <b>exon {_dn_ex}</b>: "
                        f"<code>{ins[:40]}{'…' if len(ins) > 40 else ''}</code> "
                        f"({len(ins)} nt in mature mRNA; {_dual or f'net +{sh} nt to CDS'} — not retained as intron)"
                    )
                elif ins:
                    bits.append(
                        f"retained sequence spliced into ORF "
                        f"<code>{ins[:40]}{'…' if len(ins) > 40 else ''}</code> "
                        f"({len(ins)} bp; {_dual or f'net +{sh} nt'})"
                    )
                else:
                    bits.append(_dual or f"net junction extension +{sh} nt")
            elif sh < 0:
                bits.append(f"whole-exon or junction deletion ({abs(sh)} bp removed from ORF)")
        except (TypeError, ValueError):
            pass
    if co.get('in_frame_shift') is True:
        if co.get('ptc_within_insert'):
            try:
                ins_nt = int(co.get('shift_nt') or 0)
                ins_c = int(co.get('insert_codons') or (ins_nt // 3 if ins_nt else 0))
            except (TypeError, ValueError):
                ins_nt, ins_c = 0, 0
            if ins_nt > 0 and ins_c > 0:
                bits.append(
                    f'<b>phase-preserving insert</b> (+{ins_nt} nt, +{ins_c} codons; '
                    f'no frameshift at the splice junction — reading frame stays in phase with exon 3)'
                )
            else:
                bits.append('<b>phase-preserving insert</b> (no frameshift at the splice junction)')
        else:
            bits.append('<b>in-frame</b> for the ORF')
    elif co.get('in_frame_shift') is False:
        bits.append('<b>out-of-frame</b> &rarr; frameshift downstream of the new splice site')
    if co.get('in_frame_exonization'):
        pmodel = co.get('pseudoexon_model') or ''
        if pmodel == 'nearest_intronic_ag':
            bits.append(
                '<b>in-frame exonization</b> — cryptic intronic acceptor → donor (nearest AG–GT pair)'
            )
        else:
            bits.append(
                '<b>in-frame exonization</b> — canonical exon acceptor → cryptic donor'
            )
        hgvs_p = co.get('predicted_hgvs_p') or ''
        ins_aa = co.get('inserted_aa_count')
        try:
            ins_aa_i = int(ins_aa) if ins_aa is not None else None
        except (TypeError, ValueError):
            ins_aa_i = None
        if hgvs_p:
            bits.append(f'<b>Predicted protein</b>: <b>{hgvs_p}</b>')
        elif ins_aa_i is not None and ins_aa_i > 0:
            aa_w = 'amino acid' if ins_aa_i == 1 else 'amino acids'
            bits.append(f'<b>Predicted protein</b>: in-frame insert of <b>{ins_aa_i} {aa_w}</b>')
        try:
            mplen = co.get('mutant_protein_length')
            fplen = co.get('full_protein_length') or (parsed_data or {}).get('protein_length')
            fplen = int(fplen) if fplen else 0
            if mplen is not None and fplen > 0:
                bits.append(
                    f'Mutant ORF ≈ <b>{int(mplen)} aa</b> (reference <b>{fplen} aa</b>; native stop retained)'
                )
        except (TypeError, ValueError):
            pass
        bits.append('<b>NMD: does not apply</b> — no premature stop; stable in-frame transcript expected')
        if co.get('rna_evidence_note'):
            bits.append(co['rna_evidence_note'])
        decode = co.get('insert_triplet_decode')
        footnote = f"Codon math: {decode}" if decode and (ins_aa_i is None or ins_aa_i <= MAX_JUNCTION_CODON_DECODE) else None
        sig = signal_sig or {}
        kind = (sig.get('kind') or 'pseudo-exon gain').replace('_', ' ')
        return _format_unified_splice_product_html(
            product_role,
            f"deep intronic {kind}",
            spliceai_ds=sig.get('ds'),
            spliceai_dp=sig.get('dp'),
            parsed_data=parsed_data,
            geometry='. '.join(b.rstrip('.') for b in bits),
            frame='in-frame',
            predicted_protein=hgvs_p or (f"in-frame insert of {ins_aa_i} aa" if ins_aa_i else None),
            protein_length=(
                f"mutant ORF ≈ {int(mplen)} aa (reference {int(fplen)} aa; native stop retained)"
                if mplen is not None and fplen else None
            ),
            nmd='does not apply — no premature stop; stable in-frame transcript expected',
            footnote=footnote,
            context_note='Deep intronic pseudo-exon model',
        )
    fs_ter = co.get('fs_ter_str') or ''
    if fs_ter and not co.get('no_stop_found'):
        ptc_ex = co.get('ptc_exon_rank')
        last_ex = co.get('last_coding_rank')
        if co.get('ptc_within_insert'):
            if co.get('in_frame_shift') is False:
                try:
                    ins_nt = int(co.get('shift_nt') or 0)
                except (TypeError, ValueError):
                    ins_nt = 0
                _gjp = (co.get('pseudoexon_geometry') or {}).get('junction_proximal_acceptor')
                _gex = (co.get('pseudoexon_geometry') or {}).get('downstream_exon_rank')
                if _gjp and _gex:
                    ptc_bit = (
                        f"<b>PTC after exon extension</b>: <b>{fs_ter}</b> — "
                        f"first stop in the out-of-frame ORF after the <b>{ins_nt} nt</b> "
                        f"acceptor-gain extension at the 5\u2032 end of <b>exon {_gex}</b>"
                    )
                else:
                    ptc_bit = (
                        f"<b>PTC in new pseudo-exon</b>: <b>{fs_ter}</b> — "
                        f"first stop in the out-of-frame ORF within the spliced-in "
                        f"<b>{ins_nt} nt</b> segment "
                        f"(between flanking exons; <em>not</em> native downstream exon sequence)"
                    )
                try:
                    ptc_aa = int(co.get('ptc_aa_position') or 0)
                    ins_start = int(co.get('first_insert_aa_pos') or 0)
                except (TypeError, ValueError):
                    ptc_aa, ins_start = 0, 0
                if ptc_aa and ins_start:
                    ptc_bit += f" (frameshift at aa {ins_start}; stop at aa {ptc_aa})"
            else:
                ptc_bit = (
                    f"<b>PTC in new pseudo-exon</b>: <b>{fs_ter}</b> — "
                    f"first in-phase stop codon (TAA/TAG/TGA) within the spliced-in intronic segment; "
                    f"<em>not</em> a junction frameshift"
                )
                try:
                    ptc_aa = int(co.get('ptc_aa_position') or 0)
                    ins_c = int(co.get('insert_codons') or 0)
                    ins_start = int(co.get('first_insert_aa_pos') or 0)
                except (TypeError, ValueError):
                    ptc_aa, ins_c, ins_start = 0, 0, 0
                if ptc_aa and ins_c and ins_start:
                    ins_end = ins_start + ins_c - 1
                    ptc_bit += f" (pseudo-exon spans ~aa {ins_start}–{ins_end}; stop at aa {ptc_aa})"
                elif ptc_aa and ins_c:
                    ptc_bit += f" (within +{ins_c}-codon pseudo-exon)"
            loc = co.get('ptc_location_label')
            detail = co.get('ptc_location_detail')
            if loc:
                ptc_bit += f" — <b>Location:</b> {loc}"
                if detail:
                    ptc_bit += f" ({detail})"
        else:
            ptc_bit = f"<b>PTC</b>: <b>{fs_ter}</b>"
            if ptc_ex is not None and last_ex is not None:
                ptc_bit += f", novel stop in <b>exon {ptc_ex}</b> of {last_ex}"
            elif ptc_ex is not None:
                ptc_bit += f", novel stop in <b>exon {ptc_ex}</b>"
            loc = co.get('ptc_location_label')
            detail = co.get('ptc_location_detail')
            if loc:
                ptc_bit += f" — <b>Location:</b> {loc}"
                if detail:
                    ptc_bit += f" ({detail})"
        bits.append(ptc_bit)
        try:
            tlen = co.get('truncated_protein_length')
            plen = co.get('full_protein_length') or (parsed_data or {}).get('protein_length')
            plen = int(plen) if plen else 0
            if tlen is not None and plen > 0:
                pct = co.get('truncation_pct')
                if pct is None:
                    pct = round(max(0.0, (plen - int(tlen)) / float(plen)) * 100.0, 1)
                bits.append(
                    f"<b>Truncated protein</b>: &asymp; <b>{int(tlen)} aa</b> of <b>{plen}</b> "
                    f"(<b>{float(pct):.1f}%</b> C-terminus lost vs full-length reference)"
                )
        except (TypeError, ValueError):
            pass
        if co.get('nmd_escape') is True:
            bits.append(f"<b>NMD: escape</b> — {(co.get('nmd_reason') or 'PTC near/in last exon')}")
        elif co.get('nmd_escape') is False:
            bits.append("<b>NMD: predicted</b> (internal exon PTC).")
    elif co.get('no_stop_found'):
        bits.append('no premature stop in the re-read ORF before native stop')
    decode = co.get('insert_triplet_decode')
    footnote = None
    if decode:
        ins_nt = len(co.get('inserted_cdna') or '')
        if not ins_nt:
            try:
                sh = int(co.get('shift_nt') or 0)
                if sh > 0:
                    ins_nt = sh
            except (TypeError, ValueError):
                ins_nt = 0
        n_codons = ins_nt // 3 if ins_nt and ins_nt % 3 == 0 else None
        rem = ins_nt % 3 if ins_nt else 0
        show_decode = n_codons is not None and n_codons <= MAX_JUNCTION_CODON_DECODE
        if show_decode:
            footnote = f"Codon math: {decode}"
        elif n_codons is not None and n_codons > MAX_JUNCTION_CODON_DECODE:
            footnote = (
                f"Codon math: {ins_nt} bp inserted (in-frame, net +{n_codons} codons); "
                f"per-codon detail omitted (>{MAX_JUNCTION_CODON_DECODE} codons)"
            )
        elif ins_nt and rem:
            footnote = (
                f"Codon math: {ins_nt} bp inserted (out-of-frame, +{rem} nt frameshift); "
                f"per-codon detail omitted → expected PTC in re-read ORF"
            )

    geo_lines = [str(b).rstrip('. ').strip() for b in bits if b]
    frame = None
    if co.get('in_frame_shift') is True:
        frame = 'in-frame'
    elif co.get('in_frame_shift') is False:
        frame = 'out-of-frame'
    ptc_line = ''
    for b in geo_lines:
        if 'PTC' in b:
            ptc_line = b
            geo_lines = [x for x in geo_lines if x != b]
            break
    length_line = ''
    for b in geo_lines:
        if 'Truncated protein' in b:
            length_line = b.replace('<b>Truncated protein</b>:', '').replace('<b>', '').replace('</b>', '').strip()
            geo_lines = [x for x in geo_lines if x != b]
            break
    nmd_line = ''
    for b in geo_lines:
        if 'NMD' in b:
            nmd_line = b.replace('<b>NMD:', '').replace('</b>', '').strip()
            geo_lines = [x for x in geo_lines if x != b]
            break

    sig = signal_sig or {}
    kind = (sig.get('kind') or 'pseudo-exon').replace('_', ' ')
    return _format_unified_splice_product_html(
        product_role,
        f"deep intronic {kind}",
        spliceai_ds=sig.get('ds'),
        spliceai_dp=sig.get('dp'),
        parsed_data=parsed_data,
        geometry='; '.join(geo_lines) if geo_lines else mechanism_intro.rstrip('.'),
        frame=frame,
        ptc=ptc_line.replace('<b>', '').replace('</b>', '') if ptc_line else None,
        protein_length=length_line or None,
        nmd=nmd_line or None,
        footnote=footnote,
        context_note='Deep intronic pseudo-exon model',
    )


def _exon_skip_product_outcome(cx, cds_seq, coding_exons, parsed_data, loss_signal=0.0):
    """Whole-exon skip product after canonical donor/acceptor loss (deep-intronic alternate)."""
    try:
        ts = int(cx.get('start_cds') or 0)
        te = int(cx.get('end_cds') or 0)
    except (TypeError, ValueError):
        return None
    if ts <= 0 or te < ts or te > len(cds_seq):
        return None
    deleted_bp = te - ts + 1
    mutant_cds = cds_seq[: ts - 1] + cds_seq[te:]
    co = _ptc_nmd_outcome_from_mutant_cds(
        mutant_cds,
        cds_seq,
        ts - 1,
        -deleted_bp,
        coding_exons,
        parsed_data,
        cryptic_type='Donor loss',
        gain_signal=0.0,
        loss_signal=loss_signal,
        inserted_cdna='',
    )
    if co:
        co['in_frame_shift'] = (deleted_bp % 3 == 0)
        co['exon_skip'] = True
        co['skipped_exon_rank'] = cx.get('anatomical_rank')
        co = _annotate_ptc_location(co)
    return co


def _apply_co_to_secondary_skip_viz(parsed_data, co):
    """Map whole-exon skip outcome onto spliceai_secondary_donor_* keys for alternate splice viz."""
    if not co:
        return
    pfx = _SPLICE_VIZ_SEC_SKIP_PTC_PREFIX
    parsed_data['spliceai_secondary_donor_oof'] = not co.get('in_frame_shift', True)
    if co.get('ptc_exon_rank') is not None:
        try:
            parsed_data[f'{pfx}exon_skip_oof_ptc_exon_rank'] = int(co['ptc_exon_rank'])
        except (TypeError, ValueError):
            pass
    if co.get('ptc_aa_position') is not None:
        try:
            parsed_data[f'{pfx}exon_skip_oof_ptc_aa'] = int(co['ptc_aa_position'])
        except (TypeError, ValueError):
            pass
    if co.get('ptc_fraction_in_exon') is not None:
        parsed_data[f'{pfx}exon_skip_oof_ptc_fraction_in_exon'] = co['ptc_fraction_in_exon']
    fs = co.get('fs_ter_str') or ''
    if fs:
        parsed_data[f'{pfx}exon_skip_predicted_hgvs_p'] = fs
        if not co.get('in_frame_shift', True):
            parsed_data[f'{pfx}exon_skip_oof_fs_ter'] = fs


def _logic_csq_is_splice_context(csq, parsed_data):
    """True when variant should receive splice / deep-intronic logic sections."""
    if _canonical_splice_junction_from_hgvs(parsed_data.get('c_dot')):
        return True
    lcsq = (csq or '').lower()
    if 'splice' in lcsq or lcsq == 'intron_variant':
        return True
    if parsed_data.get('deep_intronic_splice_products_active'):
        return True
    if parsed_data.get('deep_intronic_splice', {}).get('eligible'):
        return True
    if parsed_data.get('cryptic_gain_outcome'):
        return True
    if (parsed_data.get('splice_frame_math') or '').strip():
        return True
    return False


def _should_show_spliceai_narrative_in_logic(parsed_data, csq):
    """Logic report only — omit generic SpliceAI prose when splice path did not run."""
    if not (parsed_data.get('spliceai_narrative') or '').strip():
        return False
    if not _logic_csq_is_splice_context(csq, parsed_data):
        return False
    if parsed_data.get('deep_intronic_splice_products_active'):
        return False
    if parsed_data.get('spliceai_narrative_condensed'):
        return False
    if parsed_data.get('spliceai_competing_splice_isoforms'):
        return False
    if parsed_data.get('cryptic_gain_outcome') and (parsed_data.get('splice_frame_math') or '').strip():
        return False
    return True


DEEP_INTRONIC_ACCEPTOR_CANONICAL_MAX_AG = 120


def _acceptor_gain_gt_ag_pairs(mut_seq, ag_i, max_dist=120):
    """All upstream GT→gained AG pairs near ag_i; shortest body first (closest donor)."""
    seq = str(mut_seq or '').upper()
    try:
        ag_i = int(ag_i)
        max_dist = int(max_dist)
    except (TypeError, ValueError):
        return []
    if ag_i < 2 or max_dist < 3:
        return []
    lo = max(0, ag_i - max_dist)
    pairs = []
    for i in range(ag_i - 2, lo - 1, -1):
        if i < 0 or seq[i:i + 2] != 'GT':
            continue
        body = _acceptor_gain_retained_body(seq, ag_i, gt_start=i)
        if len(body) < 3:
            continue
        pairs.append({
            'model': 'nearest_intronic_gt',
            'retained': body,
            'mRNA_span_nt': len(body) + 4,
            'ag_start': ag_i,
            'gt_start': i,
            'body_start': i + 2,
            'body_nt': len(body),
        })
    pairs.sort(key=lambda p: (len(p.get('retained') or ''), -int(p.get('gt_start') or 0)))
    out = []
    seen = set()
    for p in pairs:
        key = (int(p.get('gt_start') or -1), len(p.get('retained') or ''))
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return out


def _acceptor_gain_next_gt_ag_pair(mut_seq, ag_i, primary, max_dist=120):
    """Second GT→AG pair (next upstream donor) for the same gained AG."""
    if not primary:
        return None
    pairs = _acceptor_gain_gt_ag_pairs(mut_seq, ag_i, max_dist=max_dist)
    if len(pairs) < 2:
        return None
    try:
        pri_gt = int(primary.get('gt_start'))
        pri_len = len(primary.get('retained') or '')
    except (TypeError, ValueError):
        return pairs[1]
    for p in pairs[1:]:
        try:
            if int(p.get('gt_start') or -1) != pri_gt or len(p.get('retained') or '') != pri_len:
                p = dict(p)
                p['model'] = 'acceptor_gain_next_gt'
                return p
        except (TypeError, ValueError):
            continue
    return None


def _acceptor_gain_gt_for_target_body(mut_seq, ag_i, target_body_len, slack=120):
    """Find GT→AG with retained body length nearest to target_body_len; prefer in-frame."""
    seq = str(mut_seq or '').upper()
    try:
        ag_i = int(ag_i)
        target = int(target_body_len)
    except (TypeError, ValueError):
        return None
    if ag_i < 2 or target < 3:
        return None
    guess = ag_i - target - 2
    lo = max(0, guess - slack)
    hi = min(ag_i - 2, guess + slack)
    candidates = []
    for i in range(lo, hi + 1):
        if seq[i : i + 2] != 'GT':
            continue
        body = _acceptor_gain_retained_body(seq, ag_i, gt_start=i)
        if len(body) < 3:
            continue
        diff = abs(len(body) - target)
        cand = {
            'model': 'acceptor_gain',
            'retained': body,
            'mRNA_span_nt': len(body) + 4,
            'ag_start': ag_i,
            'gt_start': i,
            'body_start': i + 2,
            'target_body_nt': target,
        }
        candidates.append(cand)
    if not candidates:
        return None
    inframe_near = [
        c for c in candidates
        if len(c.get('retained') or '') % 3 == 0
        and abs(len(c.get('retained') or '') - target) <= 8
    ]
    if inframe_near:
        return min(inframe_near, key=lambda c: abs(len(c.get('retained') or '') - target))
    return min(candidates, key=lambda c: abs(len(c.get('retained') or '') - target))


def _acceptor_gain_target_body_nt(pag, transcript_strand):
    """Heuristic GT→AG body length from oriented SpliceAI Δ (not HGVS offset + Δ)."""
    if pag is None:
        return None
    try:
        d = int(pag)
    except (TypeError, ValueError):
        return None
    if int(transcript_strand or 1) == -1:
        d = -d
    d = abs(d)
    return d if d >= 3 else None


def _acceptor_gain_intronic_geometry(mut_seq, j_var, pag, c_dot, transcript_strand):
    """
    Single acceptor-gain geometry for all intronic variants (deep intronic, alternates).

    Same rules every time:
      1. Variant position: HGVS c.N± when present (c.N− counts from acceptor / 3′ end).
      2. Gained AG: variant_index + oriented Δ (_spliceai_site_locus).
      3. Pseudo-exon:
         • |oriented Δ| ≥3 → local GT→AG with body length ≈ |Δ|.
         • gained AG ≤120 nt from 5′ intron → canonical intronic GT → gained AG.
         • else → nearest upstream GT → gained AG (≤120 nt).
    """
    seq = str(mut_seq or '').upper()
    L = len(seq)
    if L < 4 or pag is None:
        return None

    j_var = _intronic_j_var_from_hgvs(L, c_dot, j_var)

    ag_i, j_var = _spliceai_site_locus(seq, j_var, pag, 'acceptor_gain', c_dot, transcript_strand)
    target_body = _acceptor_gain_target_body_nt(pag, transcript_strand)

    if ag_i is None:
        return None

    if target_body and target_body >= 3:
        pick = _acceptor_gain_gt_for_target_body(seq, ag_i, target_body)
        if pick:
            return pick

    if ag_i <= DEEP_INTRONIC_ACCEPTOR_CANONICAL_MAX_AG:
        pick = _deep_intronic_acceptor_gain_canonical_proximal(seq, ag_i)
        if pick:
            pick['model'] = 'acceptor_gain'
            return pick

    pick = _deep_intronic_acceptor_gain_decoy_mini(seq, ag_i)
    if pick:
        pick['model'] = 'acceptor_gain'
    return pick


def _acceptor_gain_intronic_alternate(mut_seq, ag_i, primary):
    """Optional full-intron canonical GT→AG when primary is a shorter local pair."""
    if not primary or not ag_i:
        return None
    try:
        pri_len = len(primary.get('retained') or '')
        ai = int(ag_i)
    except (TypeError, ValueError):
        return None
    if pri_len <= DEEP_INTRONIC_ACCEPTOR_CANONICAL_MAX_AG:
        return None
    canon = _deep_intronic_acceptor_gain_canonical_proximal(mut_seq, ai)
    if not canon:
        return None
    if len(canon.get('retained') or '') == pri_len:
        return None
    canon['model'] = 'acceptor_gain_full_intron'
    return canon


def _deep_intronic_acceptor_gain_canonical_proximal(mut_seq, ag_i):
    """
    Junction-proximal acceptor gain only: reuse intron 5′ GT when gained AG is near the
    upstream exon (within DEEP_INTRONIC_ACCEPTOR_CANONICAL_MAX_AG nt). Not for deep-intronic
    AG signals far from the intron start — use _deep_intronic_acceptor_gain_decoy_mini.
    """
    seq = str(mut_seq or '').upper()
    try:
        ag_i = int(ag_i)
    except (TypeError, ValueError):
        return None
    if ag_i < 2 or len(seq) < ag_i + 2:
        return None
    if seq[0:2] != 'GT':
        return None
    body = _acceptor_gain_retained_body(seq, ag_i, gt_start=0)
    if len(body) < 3:
        return None
    return {
        'model': 'canonical_proximal_acceptor',
        'retained': body,
        'mRNA_span_nt': ag_i + 2,
        'ag_start': ag_i,
        'gt_start': 0,
        'body_start': ACCEPTOR_GAIN_BODY_START,
    }


def _deep_intronic_acceptor_gain_decoy_mini(mut_seq, ag_i):
    """Fallback: nearest upstream intronic GT → gained AG (local decoy mini-exon)."""
    seq = str(mut_seq or '').upper()
    try:
        ag_i = int(ag_i)
    except (TypeError, ValueError):
        return None
    if ag_i < 2:
        return None
    for i in range(ag_i - 2, max(-1, ag_i - 120), -1):
        if i >= 0 and seq[i : i + 2] == 'GT':
            body = _acceptor_gain_retained_body(seq, ag_i, gt_start=i)
            if len(body) >= 3:
                return {
                    'model': 'nearest_intronic_gt',
                    'retained': body,
                    'mRNA_span_nt': len(body) + 4,
                    'ag_start': ag_i,
                    'gt_start': i,
                    'body_start': i + 2,
                }
            break
    return None


def _deep_intronic_acceptor_gain_product_bundle(
    picked_ag, mut_seq, j_var, pag, sag, sdl, cx, cds_seq, coding_exons, parsed_data, details, c_dot=''
):
    """One acceptor-gain geometry → {html, outcome, viz} or None."""
    retained_ag = picked_ag.get('retained')
    if not retained_ag:
        return None
    ag_model = picked_ag.get('model') or 'canonical_proximal_acceptor'
    try:
        cx_end = int(cx.get('end_cds') or 0)
    except (TypeError, ValueError):
        cx_end = 0
    if not (0 < cx_end <= len(cds_seq)):
        return None
    retained_ag = _acceptor_gain_mature_retained_body(
        retained_ag,
        mut_seq=mut_seq,
        picked_ag=picked_ag,
        cds_seq=cds_seq,
        downstream_start_0=cx_end,
        target_body_nt=picked_ag.get('target_body_nt'),
    )
    if not retained_ag:
        return None
    mutant_cds_ag = cds_seq[:cx_end] + retained_ag + cds_seq[cx_end:]
    co_ag = _inframe_exonization_outcome_from_insert(
        mutant_cds_ag,
        cds_seq,
        cx_end,
        retained_ag,
        coding_exons,
        parsed_data,
        cryptic_type='Acceptor gain',
        gain_signal=sag,
        loss_signal=sdl,
        model_label=ag_model,
    )
    if not co_ag:
        co_ag = _ptc_nmd_outcome_from_mutant_cds(
            mutant_cds_ag,
            cds_seq,
            cx_end,
            len(retained_ag),
            coding_exons,
            parsed_data,
            cryptic_type='Acceptor gain',
            gain_signal=sag,
            loss_signal=sdl,
            inserted_cdna=retained_ag,
        )
    if not co_ag:
        return None
    co_ag['inserted_cdna'] = retained_ag
    co_ag['shift_nt'] = len(retained_ag)
    body_nt = len(retained_ag)
    span_nt = picked_ag.get('mRNA_span_nt') or (body_nt + 4)
    _tgt = picked_ag.get('target_body_nt')
    _dn_rank = None
    _cx_dn = _deep_intronic_downstream_exon_for_acceptor_side(parsed_data, coding_exons, details)
    if _cx_dn:
        _dn_rank = _cx_dn.get('anatomical_rank')
    co_ag = _annotate_ptc_location(
        co_ag,
        anchor_exon_rank=cx.get('anatomical_rank'),
        downstream_exon_rank=_dn_rank,
    )
    if ag_model == 'acceptor_gain_full_intron':
        mech_ag = (
            f"Cryptic <b>acceptor gain</b> at Δ{pag:+d} bp from variant "
            f"(SpliceAI DS_AG {sag:.2f}); alternate model: <b>canonical intronic GT → gained AG</b> → "
            f"<b>{body_nt} nt</b> (full intron pseudo-exon; unlikely if primary local model applies)"
        )
    elif _tgt and _dn_rank:
        mech_ag = (
            f"Cryptic <b>acceptor gain</b> at Δ{pag:+d} bp from variant "
            f"(SpliceAI DS_AG {sag:.2f}); <b>GT→AG pseudo-exon {body_nt} nt</b> "
            f"after exon {cx.get('anatomical_rank')} before exon {_dn_rank} "
            f"(HGVS c.N\u2212 offset + SpliceAI \u0394 = {_tgt} nt; canonical 3\u2032 acceptor skipped)"
        )
    elif picked_ag.get('gt_start') == 0:
        mech_ag = (
            f"Cryptic <b>acceptor gain</b> at Δ{pag:+d} bp from variant "
            f"(SpliceAI DS_AG {sag:.2f}); model: <b>canonical intronic GT → gained AG</b> → "
            f"<b>{body_nt} nt</b> spliced into the ORF after coding exon {cx.get('anatomical_rank')}"
            f" ({span_nt}-nt pseudo-exon span; 5\u2032 GT reused, new AG only; "
            f"then splice to exon {int(cx.get('anatomical_rank') or 0) + 1} — canonical 3\u2032 intron AG skipped)"
        )
    else:
        _jp = _acceptor_gain_junction_proximal(len(mut_seq or ''), picked_ag.get('ag_start'))
        _exon_n = int(_dn_rank or (int(cx.get('anatomical_rank') or 0) + 1))
        if _jp and _exon_n:
            mech_ag = (
                f"<b>Acceptor gain</b> at Δ{pag:+d} bp from variant (SpliceAI DS_AG {sag:.2f}): "
                f"canonical-proximal <b>AG</b> splices with upstream <b>GT</b> → "
                f"<b>{body_nt} nt</b> extends the 5\u2032 end of <b>exon {_exon_n}</b> "
                f"(exonic in mature mRNA; reference annotation still calls this intron)"
            )
        else:
            mech_ag = (
                f"Cryptic <b>acceptor gain</b> at Δ{pag:+d} bp from variant "
                f"(SpliceAI DS_AG {sag:.2f}); model: <b>local GT → gained AG</b> → "
                f"<b>{body_nt} nt</b> ORF insert after exon {cx.get('anatomical_rank')}"
            )
    _ag_hgvs = None
    _gt_hgvs = None
    try:
        if picked_ag.get('ag_start') is not None:
            _ag_hgvs = int(picked_ag['ag_start']) + 1
        elif j_var is not None and pag is not None:
            _j = _intronic_j_var_from_hgvs(len(mut_seq or ''), c_dot, j_var)
            _ag_hgvs = int(_j) + 1 + int(pag)
        if picked_ag.get('gt_start') is not None:
            _gt_hgvs = int(picked_ag['gt_start']) + 1
    except (TypeError, ValueError):
        pass
    try:
        _gt_i = int(picked_ag.get('gt_start')) if picked_ag.get('gt_start') is not None else None
    except (TypeError, ValueError):
        _gt_i = None
    try:
        _ag_i = int(picked_ag.get('ag_start')) if picked_ag.get('ag_start') is not None else None
    except (TypeError, ValueError):
        _ag_i = None
    if _gt_i is not None and _gt_i >= 0:
        _bs_ag = _gt_i + 2
    else:
        _bs_ag = ACCEPTOR_GAIN_BODY_START
    _j_hgvs = None
    try:
        _j_hgvs = int(_intronic_j_var_from_hgvs(len(mut_seq or ''), c_dot, j_var)) + 1
    except (TypeError, ValueError):
        pass
    _intron_L = len(mut_seq or '')
    _jp_ag = _acceptor_gain_junction_proximal(_intron_L, _ag_i)
    co_ag['pseudoexon_geometry'] = {
        'model': ag_model,
        'mechanism': 'acceptor_gain',
        'anchor_exon_rank': cx.get('anatomical_rank'),
        'downstream_exon_rank': _dn_rank,
        'body_nt': body_nt,
        'span_nt': span_nt,
        'target_body_nt': picked_ag.get('target_body_nt'),
        'body_start_0based': _bs_ag,
        'body_end_0based': _ag_i,
        'gt_start_0based': _gt_i,
        'ag_start_0based': _ag_i,
        'gt_hgvs_offset': _gt_hgvs,
        'ag_hgvs_offset': _ag_hgvs,
        'spliceai_delta': pag,
        'variant_hgvs_offset': _j_hgvs,
        'intron_length_nt': _intron_L,
        'junction_proximal_acceptor': _jp_ag,
    }
    if _jp_ag:
        _exon_n = int(_dn_rank or (int(cx.get('anatomical_rank') or 0) + 1))
        if not (
            co_ag.get('ptc_in_pseudoexon_nt')
            or co_ag.get('ptc_within_insert')
            or co_ag.get('ptc_location_kind') == 'pseudo_exon'
        ):
            co_ag['ptc_location_kind'] = 'extended_exon'
            if _exon_n:
                co_ag['ptc_location_label'] = f'extended exon {_exon_n} (acceptor-gain splice)'
            try:
                ptc_aa = int(co_ag.get('ptc_aa_position') or 0)
                if ptc_aa:
                    co_ag['ptc_location_detail'] = f'stop at aa {ptc_aa} in mutant ORF after exon extension'
            except (TypeError, ValueError):
                pass
    _alt_next = None
    try:
        _anchor_r = int(cx.get('anatomical_rank') or 0)
    except (TypeError, ValueError):
        _anchor_r = 0
    _cx_dn = _deep_intronic_downstream_exon_for_acceptor_side(parsed_data, coding_exons, details)
    if _cx_dn:
        _alt_next = _cx_dn.get('anatomical_rank')
    elif _anchor_r > 0:
        for _ex in coding_exons:
            try:
                er = int(_ex.get('anatomical_rank') or 0)
            except (TypeError, ValueError):
                continue
            if er == _anchor_r + 1:
                _alt_next = er
                break
    _skipped_ag = None
    try:
        _ilen = int(details.get('intron_length_nt') or len(mut_seq) or 0)
        if _ag_hgvs and _ilen > _ag_hgvs:
            _skipped_ag = _ilen - _ag_hgvs
    except (TypeError, ValueError):
        pass
    _annotate_junction_extension_fields(co_ag)
    co_ag['product_plain_summary'] = _format_splice_product_plain_summary(co_ag, parsed_data)
    viz = {
        'anchor_exon_rank': cx.get('anatomical_rank'),
        'downstream_exon_rank': _alt_next,
        'mechanism': 'acceptor_gain',
        'model': ag_model,
        'canonical_proximal_acceptor': picked_ag.get('gt_start') == 0,
        'acceptor_offset_1based': _ag_hgvs,
        'gt_offset_1based': _gt_hgvs,
        'pseudoexon_retained_nt': body_nt,
        'pseudoexon_span_nt': span_nt,
        'intronic_skipped_nt': _skipped_ag,
        'spliceai_ag_delta': pag,
        'outcome': co_ag,
    }
    return {
        'html': _format_splice_product_outcome_html(
            co_ag, parsed_data, mech_ag,
            product_role='Product 1 (primary)',
            signal_sig={'kind': 'acceptor_gain', 'ds': sag, 'dp': pag},
        ),
        'outcome': co_ag,
        'viz': viz,
        'model': ag_model,
    }


def _deep_intronic_apply_acceptor_next_bundle(parsed_data, bundle, pag, sag):
    """Second GT→AG pair at the same gained AG (next upstream donor); original primary unchanged."""
    if not bundle:
        return
    co = bundle['outcome']
    co['acceptor_pair_rank'] = 'next'
    html_out = _format_splice_product_outcome_html(
        co, parsed_data, '',
        product_role='Product — next upstream GT (acceptor gain)',
        signal_sig={'kind': 'acceptor_gain', 'ds': sag, 'dp': pag},
    )
    parsed_data['deep_intronic_acceptor_next_splice_math'] = html_out
    parsed_data['deep_intronic_acceptor_next_outcome'] = co
    parsed_data['deep_intronic_viz_acceptor_next'] = bundle.get('viz') or {}


def _deep_intronic_signal_label(sig):
    if not sig:
        return ''
    kind = (sig.get('kind') or '').replace('_', ' ')
    try:
        ds = float(sig.get('ds') or 0)
        dp = int(sig.get('dp'))
        return f"{kind} (DS {ds:.2f}, Δ{dp:+d} bp)"
    except (TypeError, ValueError):
        return kind or 'splice signal'


def _strip_html_trailing_breaks(html):
    return re.sub(r'(?:<br\s*/?>\s*)+$', '', str(html or '').strip(), flags=re.I)


def _format_splice_product_logic_brief(co, parsed_data, product_role='', signal_sig=None):
    """One-line logic readout; full splice-site/ORF detail stays in the splice products panel."""
    if not co or co.get('minimal_signal'):
        return ''
    plain = (co.get('product_plain_summary') or _format_splice_product_plain_summary(co, parsed_data)).strip()
    if not plain:
        return ''
    role = (product_role or 'Product').strip()
    sig = _deep_intronic_signal_label(signal_sig) if signal_sig else ''
    head = f"<b>{role}</b>"
    if sig:
        head += f" ({sig})"
    return f"{head}: {plain}"


def _deep_intronic_logic_product_rows(parsed_data):
    """Ordered (outcome_key, signal, role) for deep-intronic logic + panel."""
    plan = parsed_data.get('deep_intronic_spliceai_signal_plan') or {}
    return (
        ('deep_intronic_primary_outcome', plan.get('primary'), 'Product 1 (primary)'),
        ('deep_intronic_acceptor_next_outcome', plan.get('primary'), 'Product 2 (next GT→AG)'),
        ('deep_intronic_alternate_outcome', plan.get('alternate'), 'Product 2 (alternate splice)'),
        ('deep_intronic_alternate2_outcome', None, 'Product 3 (alternate splice)'),
    )


def _deep_intronic_full_product_html_blocks(parsed_data):
    """Full HTML blocks for the splice products panel (same order as logic summaries)."""
    rows = (
        ('deep_intronic_primary_splice_math', 'deep_intronic_primary_outcome'),
        ('deep_intronic_acceptor_next_splice_math', 'deep_intronic_acceptor_next_outcome'),
        ('deep_intronic_alternate_splice_math', 'deep_intronic_alternate_outcome'),
        ('deep_intronic_alternate2_splice_math', 'deep_intronic_alternate2_outcome'),
    )
    out = []
    for html_key, _outcome_key in rows:
        html = (parsed_data.get(html_key) or '').strip()
        if html:
            out.append(_strip_html_trailing_breaks(html))
    return out


def _build_splice_products_panel_html(parsed_data):
    """UI panel — full splice product detail (coordinates, geometry, frame, PTC, NMD)."""
    parts = []
    plp_banner = (_skipped_exon_plp_scan_banner_html(parsed_data) or '').strip()
    if plp_banner:
        parts.append(plp_banner)
    if parsed_data.get('deep_intronic_splice_products_active'):
        mech = (parsed_data.get('deep_intronic_mechanism_html') or '').strip()
        if mech:
            parts.append(f"<b>Mechanism:</b> {mech}")
        parts.extend(_deep_intronic_full_product_html_blocks(parsed_data))
    else:
        sfm = (parsed_data.get('splice_frame_math') or '').strip()
        if sfm:
            parts.append(sfm)
    sec_gain = _format_secondary_cryptic_gain_logic_html(parsed_data)
    if sec_gain:
        parts.append(sec_gain)
    sec = (parsed_data.get('spliceai_secondary_splice_frame_math') or '').strip()
    if sec and not parsed_data.get('spliceai_secondary_gain_product'):
        parts.append(
            f"<b>Product (parallel whole-exon skip — second splice-site hypothesis):</b><br>{sec}"
        )
    sk_plp = (_deleted_exon_analysis_evidence_html(parsed_data) or '').strip()
    if sk_plp:
        parts.append(sk_plp)
    elif (
        not plp_banner
        and parsed_data.get('skipped_exon_plp_checked')
        and not parsed_data.get('has_pathogenic_in_deleted_exon')
    ):
        _ctx = _skipped_exon_region_context_html(parsed_data)
        _region = 'excised region' if parsed_data.get('splice_excised_partial') else 'skipped exon'
        parts.append(
            f'<span style="color:#94a3b8;">No P/LP variants inside the {_region} interval (local ClinVar).</span>'
            + (f'<br>{_ctx}' if _ctx else '')
        )
    if not parts:
        return ''
    return '<br><br>'.join(parts)


def _append_deep_intronic_splice_logic_sections(sections, parsed_data):
    """Concise deep-intronic readout for logic explanation; details in splice products panel."""
    if not parsed_data.get('deep_intronic_splice_products_active'):
        return
    parts = []
    mech = (parsed_data.get('deep_intronic_mechanism_html') or '').strip()
    if mech:
        parts.append(f"<b>Mechanism:</b> {_strip_html_trailing_breaks(mech)}")
    for outcome_key, sig, role in _deep_intronic_logic_product_rows(parsed_data):
        co = parsed_data.get(outcome_key) or {}
        brief = _format_splice_product_logic_brief(co, parsed_data, product_role=role, signal_sig=sig)
        if brief:
            parts.append(brief)
    parts.append(
        "<span style='color:#94a3b8;font-size:0.88em'>"
        "Full splice-site coordinates, retained sequence, frame/ORF math, and junction map — "
        "<b>Splice products</b> panel."
        "</span>"
    )
    if parts:
        sections.append(('Deep intronic splice', '<br><br>'.join(parts)))


def _deep_intronic_prefer_acceptor_gain_primary(gains, thr):
    """
    True when both donor and acceptor gain qualify and the acceptor |Δ| defines a
    full pseudo-exon while donor gain sits at/near the variant (local GT mini-exon).

    Do not require DS_AG ≈ DS_DG: junction-proximal donor gain (|Δ| ≤ 5) often scores
    higher than the acceptor gain that sizes the pseudo-exon (e.g. COL6A1 c.930+189C>T).
    """
    ag = next((g for g in (gains or []) if g.get('kind') == 'acceptor_gain'), None)
    dg = next((g for g in (gains or []) if g.get('kind') == 'donor_gain'), None)
    if not ag or not dg:
        return False
    if float(ag.get('ds') or 0) < thr or float(dg.get('ds') or 0) < thr:
        return False
    try:
        pag = abs(int(ag.get('dp')))
        pdg = abs(int(dg.get('dp')))
    except (TypeError, ValueError):
        return False
    if pag < DEEP_INTRONIC_DUAL_GAIN_ACCEPTOR_DELTA_MIN:
        return False
    if pdg > DEEP_INTRONIC_DUAL_GAIN_DONOR_PROXIMAL_MAX:
        return False
    return True


def _deep_intronic_spliceai_signal_plan(parsed_data, thr, c_dot=None):
    """
    Rank SpliceAI signals (DS + Δ) to decide which deep-intronic product(s) to calculate.
    Primary = highest qualifying DS; alternate = next highest (gain or loss).
    """
    try:
        sag = float(parsed_data.get('spliceai_ds_ag') or 0)
        sal = float(parsed_data.get('spliceai_ds_al') or 0)
        sdg = float(parsed_data.get('spliceai_ds_dg') or 0)
        sdl = float(parsed_data.get('spliceai_ds_dl') or 0)
    except (TypeError, ValueError):
        return None
    pag = _parse_spliceai_dp(parsed_data.get('spliceai_dp_ag'))
    pal = _parse_spliceai_dp(parsed_data.get('spliceai_dp_al'))
    pdg = _parse_spliceai_dp(parsed_data.get('spliceai_dp_dg'))
    pdl = _parse_spliceai_dp(parsed_data.get('spliceai_dp_dl'))

    scored = []
    for kind, ds, dp in (
        ('acceptor_gain', sag, pag),
        ('donor_gain', sdg, pdg),
        ('acceptor_loss', sal, pal),
        ('donor_loss', sdl, pdl),
    ):
        if ds >= thr and dp is not None:
            scored.append({'kind': kind, 'ds': ds, 'dp': int(dp)})

    if not scored:
        return None

    ranked = sorted(scored, key=lambda x: (-x['ds'], x['kind']))
    primary = ranked[0]
    alternate = ranked[1] if len(ranked) > 1 else None
    gains = [s for s in ranked if s['kind'].endswith('_gain')]
    losses = [s for s in ranked if s['kind'].endswith('_loss')]
    acceptor_delta_sized_primary = _deep_intronic_prefer_acceptor_gain_primary(gains, thr)

    return {
        'primary': primary,
        'alternate': alternate,
        'gains': gains,
        'losses': losses,
        'acceptor_delta_sized_primary': acceptor_delta_sized_primary,
    }


def _deep_intronic_coding_exon_by_rank(coding_exons, rank):
    try:
        r = int(rank)
    except (TypeError, ValueError):
        return None
    for c in coding_exons or []:
        try:
            if int(c.get('anatomical_rank') or 0) == r:
                return c
        except (TypeError, ValueError):
            continue
    return None


def _deep_intronic_upstream_exon_for_acceptor_side(parsed_data, coding_exons, details):
    """Minus-intronic / acceptor-side: pseudo-exon inserts after the 5′ exon of the intron."""
    intron_idx = details.get('intron_index_1based')
    try:
        ii = int(intron_idx)
        if ii > 0:
            hit = _deep_intronic_coding_exon_by_rank(coding_exons, ii)
            if hit:
                return hit
    except (TypeError, ValueError):
        pass
    anchor_rank = parsed_data.get('variant_exon') or parsed_data.get('snpeff_exon_rank')
    try:
        ar = int(anchor_rank)
        if ar > 1:
            hit = _deep_intronic_coding_exon_by_rank(coding_exons, ar - 1)
            if hit:
                return hit
    except (TypeError, ValueError):
        pass
    return None


def _deep_intronic_downstream_exon_for_acceptor_side(parsed_data, coding_exons, details):
    """3′ exon at the acceptor end of a c.N− intron (e.g. exon 4 after intron 3)."""
    intron_idx = details.get('intron_index_1based')
    try:
        ii = int(intron_idx)
        if ii > 0:
            hit = _deep_intronic_coding_exon_by_rank(coding_exons, ii + 1)
            if hit:
                return hit
    except (TypeError, ValueError):
        pass
    anchor_rank = parsed_data.get('variant_exon') or parsed_data.get('snpeff_exon_rank')
    try:
        ar = int(anchor_rank)
        hit = _deep_intronic_coding_exon_by_rank(coding_exons, ar)
        if hit:
            return hit
    except (TypeError, ValueError):
        pass
    return None


def _deep_intronic_donor_gain_signal_from_plan(plan):
    alt = plan.get('alternate') or {}
    if alt.get('kind') == 'donor_gain':
        return alt
    pri = plan.get('primary') or {}
    if pri.get('kind') == 'donor_gain':
        return pri
    for g in plan.get('gains') or []:
        if g.get('kind') == 'donor_gain':
            return g
    return None


def _deep_intronic_outcome_slots():
    return (
        'deep_intronic_primary_outcome',
        'deep_intronic_acceptor_next_outcome',
        'deep_intronic_alternate_outcome',
        'deep_intronic_alternate2_outcome',
    )


def _deep_intronic_has_gain_outcome(parsed_data, gain_kind):
    """True when any product slot already holds an acceptor- or donor-gain outcome."""
    want = str(gain_kind or '').lower()
    for key in _deep_intronic_outcome_slots():
        co = parsed_data.get(key) or {}
        ct = (co.get('cryptic_type') or '').lower()
        if want == 'acceptor' and 'acceptor' in ct:
            return True
        if want == 'donor' and 'donor' in ct:
            return True
    return False


def _deep_intronic_dual_gain_both_qualify(plan, thr):
    gains = (plan or {}).get('gains') or []
    ag = next((g for g in gains if g.get('kind') == 'acceptor_gain'), None)
    dg = next((g for g in gains if g.get('kind') == 'donor_gain'), None)
    if not ag or not dg:
        return False
    try:
        return float(ag.get('ds') or 0) >= thr and float(dg.get('ds') or 0) >= thr
    except (TypeError, ValueError):
        return False


def _deep_intronic_format_acceptor_alternate_html(parsed_data, bundle, ag_sig, *, product_role=None):
    role = product_role or 'Product 2 (alternate splice — acceptor gain)'
    return _format_splice_product_outcome_html(
        bundle['outcome'],
        parsed_data,
        '',
        product_role=role,
        signal_sig={'kind': 'acceptor_gain', 'ds': ag_sig.get('ds'), 'dp': ag_sig.get('dp')},
    )


def _deep_intronic_apply_companion_acceptor_bundle(parsed_data, bundle, ag_sig):
    html_out = _deep_intronic_format_acceptor_alternate_html(parsed_data, bundle, ag_sig)
    if not parsed_data.get('deep_intronic_alternate_splice_math'):
        parsed_data['deep_intronic_alternate_splice_math'] = html_out
        parsed_data['deep_intronic_alternate_outcome'] = bundle['outcome']
        parsed_data['deep_intronic_viz_alternate'] = bundle.get('viz') or {}
    else:
        parsed_data['deep_intronic_alternate2_splice_math'] = html_out
        parsed_data['deep_intronic_alternate2_outcome'] = bundle['outcome']
        parsed_data['deep_intronic_viz_alternate2'] = bundle.get('viz') or {}


def _deep_intronic_ensure_dual_gain_companion(
    parsed_data,
    plan,
    thr,
    *,
    mut_seq,
    j_var,
    strand,
    c_dot_s,
    cds_seq,
    coding_exons,
    details,
    sdl,
):
    """When both SpliceAI gains qualify, ensure acceptor + donor products are both present."""
    if not _deep_intronic_dual_gain_both_qualify(plan, thr):
        return False
    added = False
    gains = plan.get('gains') or []
    ag_sig = next((g for g in gains if g.get('kind') == 'acceptor_gain'), None)
    dg_sig = next((g for g in gains if g.get('kind') == 'donor_gain'), None)
    if not ag_sig or not dg_sig:
        return False

    if not _deep_intronic_has_gain_outcome(parsed_data, 'acceptor'):
        cx_ag = _deep_intronic_upstream_exon_for_acceptor_side(parsed_data, coding_exons, details)
        geom = _acceptor_gain_intronic_geometry(mut_seq, j_var, ag_sig['dp'], c_dot_s, strand)
        if geom and cx_ag:
            bundle = _deep_intronic_acceptor_gain_product_bundle(
                geom,
                mut_seq,
                j_var,
                ag_sig['dp'],
                ag_sig['ds'],
                sdl,
                cx_ag,
                cds_seq,
                coding_exons,
                parsed_data,
                details,
                c_dot_s,
            )
            if bundle:
                _deep_intronic_apply_companion_acceptor_bundle(parsed_data, bundle, ag_sig)
                added = True

    if not _deep_intronic_has_gain_outcome(parsed_data, 'donor'):
        cx_dg = _deep_intronic_donor_gain_anchor_exon(parsed_data, coding_exons, details)
        if cx_dg:
            bundle = _deep_intronic_donor_gain_product_bundle(
                parsed_data,
                cds_seq,
                coding_exons,
                details,
                c_dot_s,
                mut_seq,
                j_var,
                strand,
                dg_sig['dp'],
                dg_sig['ds'],
                sdl,
                product_role='Product 2 (canonical intronic GT → cryptic donor)',
                cx=cx_dg,
            )
            if bundle:
                _deep_intronic_apply_donor_gain_bundle(parsed_data, bundle, as_alternate=True)
                added = True
    return added


def _deep_intronic_apply_donor_gain_bundle(parsed_data, bundle, *, as_alternate=False):
    co_pri = bundle['outcome']
    if as_alternate:
        alt_key = (
            'deep_intronic_alternate2_splice_math'
            if parsed_data.get('deep_intronic_alternate_splice_math')
            else 'deep_intronic_alternate_splice_math'
        )
        parsed_data[alt_key] = bundle['html']
        if alt_key.endswith('alternate_splice_math'):
            parsed_data['deep_intronic_alternate_outcome'] = co_pri
            parsed_data['deep_intronic_viz_alternate'] = bundle['viz']
        parsed_data['spliceai_secondary_mechanism'] = bundle.get('model') or 'donor_gain'
        return
    parsed_data['deep_intronic_primary_splice_math'] = bundle['html']
    parsed_data['deep_intronic_primary_outcome'] = co_pri
    parsed_data['cryptic_splice_outcome'] = co_pri
    parsed_data['cryptic_inserted_cdna'] = bundle.get('retained') or co_pri.get('inserted_cdna') or ''
    parsed_data['deep_intronic_pseudoexon_model'] = bundle.get('model')
    parsed_data['deep_intronic_viz_primary'] = bundle['viz']
    if bundle.get('mechanism_html'):
        parsed_data['deep_intronic_mechanism_html'] = bundle['mechanism_html']
    _apply_junction_outcome_to_parsed_data(parsed_data, co_pri)
    parsed_data['spliceai_junction_model_preferred'] = True


def _deep_intronic_donor_gain_product_bundle(
    parsed_data, cds_seq, coding_exons, details, c_dot_s, mut_seq, j_var, strand,
    pdg, sdg, sdl, *, product_role='Product 1 (primary)', cx=None,
):
    """Build donor-gain pseudo-exon product bundle or None."""
    if cx is None:
        cx = _deep_intronic_donor_gain_anchor_exon(parsed_data, coding_exons, details)
    if not cx or pdg is None:
        return None
    is_pre_atg = _deep_intronic_insert_is_pre_atg(parsed_data, coding_exons, details, cx)
    wt_seq = details.get('wt_intron_tx_seq') or mut_seq
    gene_sym = (parsed_data.get('gene_symbol') or parsed_data.get('gene') or '').strip()
    rna_ev = _deep_intronic_rna_evidence(gene_sym, c_dot_s)
    gt_i = _resolve_donor_gain_gt_anchor(
        mut_seq, wt_seq, j_var, pdg, strand, rna_evidence=rna_ev, c_dot=c_dot_s
    )
    if gt_i is None:
        return None
    try:
        cx_end = 0 if is_pre_atg else int(cx.get('end_cds') or 0)
    except (TypeError, ValueError):
        cx_end = 0
    if not is_pre_atg and not (0 < cx_end <= len(cds_seq)):
        return None
    cand_kw = dict(
        mut_seq=mut_seq,
        gt_i=gt_i,
        rna_evidence=rna_ev,
        wt_seq=wt_seq,
        j_var=j_var,
    )
    if not is_pre_atg:
        cand_kw['cds_seq'] = cds_seq
        cand_kw['cx_end'] = cx_end
    candidates = _deep_intronic_donor_gain_retained_candidates(**cand_kw)
    intron_len = details.get('intron_length_nt') or len(mut_seq)
    pick_kw = dict(
        candidates=candidates,
        rna_evidence=rna_ev,
        gt_i=gt_i,
        intron_len=intron_len,
    )
    if not is_pre_atg:
        pick_kw['cds_seq'] = cds_seq
        pick_kw['cx_end'] = cx_end
    picked = _pick_deep_intronic_donor_gain_candidate(**pick_kw)
    if not picked or not picked.get('retained'):
        return None
    retained = picked['retained']
    model = picked.get('model') or 'canonical_proximal'
    if is_pre_atg:
        _pre_anchor, _pre_dn = _resolve_pre_atg_mrna_exon_ranks(
            parsed_data,
            coding_exons,
            details,
            int(cx.get('anatomical_rank') or 1),
            (
                int(_deep_intronic_first_coding_exon(coding_exons).get('anatomical_rank'))
                if _deep_intronic_first_coding_exon(coding_exons)
                else None
            ),
        )
        co_pri = _pre_atg_utr_pseudoexon_outcome(
            retained,
            coding_exons,
            parsed_data,
            cryptic_type='Donor gain',
            gain_signal=sdg,
            loss_signal=sdl,
            model_label=model,
            anchor_exon_rank=_pre_anchor,
            downstream_exon_rank=_pre_dn,
        )
        mutant_cds = None
    else:
        mutant_cds = cds_seq[:cx_end] + retained + cds_seq[cx_end:]
        co_pri = _inframe_exonization_outcome_from_insert(
            mutant_cds,
            cds_seq,
            cx_end,
            retained,
            coding_exons,
            parsed_data,
            cryptic_type='Donor gain',
            gain_signal=sdg,
            loss_signal=sdl,
            model_label=model,
            rna_evidence=rna_ev,
        )
        if not co_pri:
            co_pri = _ptc_nmd_outcome_from_mutant_cds(
                mutant_cds,
                cds_seq,
                cx_end,
                len(retained),
                coding_exons,
                parsed_data,
                cryptic_type='Donor gain',
                gain_signal=sdg,
                loss_signal=sdl,
                inserted_cdna=retained,
            )
    if not co_pri:
        return None
    try:
        anchor_rank = int(cx.get('anatomical_rank') or 0)
    except (TypeError, ValueError):
        anchor_rank = None
    next_rank = co_pri.get('downstream_exon_rank')
    if next_rank is None and anchor_rank is not None:
        for _ex in coding_exons:
            try:
                er = int(_ex.get('anatomical_rank') or 0)
            except (TypeError, ValueError):
                continue
            if er == anchor_rank + 1:
                next_rank = er
                break
    if not is_pre_atg:
        co_pri = _annotate_ptc_location(
            co_pri,
            anchor_exon_rank=anchor_rank,
            downstream_exon_rank=next_rank,
        )
    co_pri['pseudoexon_model'] = model
    if not is_pre_atg and not co_pri.get('insert_triplet_decode'):
        _gb, gain_plain = _format_splice_gain_insert_explain(
            retained,
            co_pri.get('first_new_codon'),
            mutant_cds=mutant_cds,
            edit_anchor=cx_end,
        )
        if gain_plain:
            co_pri['insert_triplet_decode'] = gain_plain
    if model == 'canonical_proximal':
        acc_note = 'canonical exon acceptor → cryptic donor'
    else:
        acc_note = 'nearest intronic AG → cryptic donor'
    span_nt = picked.get('mRNA_span_nt') or (len(retained) + 2)
    body_nt = len(retained)
    mechanism_html = None
    if is_pre_atg:
        mech = (
            f"Cryptic <b>donor gain</b> at Δ{pdg:+d} bp from variant "
            f"(SpliceAI DS_DG {sdg:.2f}); model: <b>{acc_note}</b> → "
            f"<b>{body_nt} nt</b> spliced into the <b>5\u2032 UTR</b> between "
            f"non-coding exon {anchor_rank} and coding exon {next_rank or '?'} "
            f"(pre-AUG; annotated ORF unchanged; {span_nt}-nt pseudo-exon span)"
        )
    else:
        mech = (
            f"Cryptic <b>donor gain</b> at Δ{pdg:+d} bp from variant "
            f"(SpliceAI DS_DG {sdg:.2f}); model: <b>{acc_note}</b> → "
            f"<b>{body_nt} nt</b> spliced into the ORF after coding exon {cx.get('anatomical_rank')}"
            f" ({span_nt}-nt intronic pseudo-exon span from 5\u2032 intronic GT through cryptic GT; "
            f"exon {cx.get('anatomical_rank')} <b>AG acceptor reused</b>, not added to the insert)"
        )
    runner = picked.get('pick_runner_up_model')
    if runner and runner != model:
        mech += (
            f' <span style="color:#94a3b8">(alternate geometry considered: '
            f'{runner.replace("_", " ")})</span>'
        )
    if picked.get('pick_reason') == 'published RNA/minigene':
        mech += ' <span style="color:#a7f3d0">(selected to match published RNA/minigene)</span>'
    try:
        _ilen = int(intron_len or len(mut_seq) or 0)
    except (TypeError, ValueError):
        _ilen = len(mut_seq) or 0
    _gt_start = picked.get('gt_start')
    try:
        _donor_seq_off = int(_gt_start) + 1 if _gt_start is not None else None
    except (TypeError, ValueError):
        _donor_seq_off = None
    _donor_hgvs_off = None
    if j_var is not None and pdg is not None:
        try:
            _donor_hgvs_off = int(j_var) + 1 + int(pdg)
        except (TypeError, ValueError):
            pass
    if _donor_hgvs_off is None:
        _hm = re.search(r'c\.\d+[\+\-](\d+)', c_dot_s)
        if _hm and pdg is not None:
            try:
                _donor_hgvs_off = int(_hm.group(1)) + int(pdg)
            except (TypeError, ValueError):
                pass
    _donor_off = _donor_hgvs_off if _donor_hgvs_off is not None else _donor_seq_off
    _bs_geom = int(picked.get('body_start', DONOR_GAIN_BODY_START))
    try:
        _gt_geom = int(_gt_start) if _gt_start is not None else None
    except (TypeError, ValueError):
        _gt_geom = None
    co_pri['pseudoexon_geometry'] = {
        'model': model,
        'mechanism': 'donor_gain',
        'anchor_exon_rank': anchor_rank,
        'body_nt': body_nt,
        'span_nt': span_nt,
        'body_start_0based': _bs_geom,
        'body_end_0based': _gt_geom,
        'dinuc_hgvs_offset': _donor_off,
        'canonical_gt_hgvs': 1,
        'spliceai_delta': pdg,
        'variant_hgvs_offset': int(j_var) + 1 if j_var is not None else None,
        'pre_atg_utr': is_pre_atg,
        'downstream_exon_rank': next_rank,
    }
    if model == 'nearest_intronic_ag' and picked.get('ag_start') is not None:
        try:
            co_pri['pseudoexon_geometry']['ag_hgvs_offset'] = int(picked['ag_start']) + 1
        except (TypeError, ValueError):
            pass
    _annotate_junction_extension_fields(co_pri)
    html_out = _format_splice_product_outcome_html(
        co_pri, parsed_data, '',
        product_role=product_role,
        signal_sig={'kind': 'donor_gain', 'ds': sdg, 'dp': pdg},
    )
    _skipped_nt = None
    if _donor_off is not None and _ilen > _donor_off:
        _skipped_nt = _ilen - _donor_off
    if model == 'nearest_intronic_ag' and co_pri.get('pseudoexon_geometry', {}).get('ag_hgvs_offset') is not None:
        try:
            _ag_off = int(co_pri['pseudoexon_geometry']['ag_hgvs_offset'])
        except (TypeError, ValueError):
            _ag_off = None
    else:
        _ag_off = None
    if is_pre_atg and anchor_rank is not None:
        _donor_disp = _donor_hgvs_off if _donor_hgvs_off is not None else _donor_off
        _ag_disp = _ag_off if _ag_off is not None else '?'
        _pdg_disp = f'{int(pdg):+d}' if pdg is not None else '?'
        mechanism_html = (
            f"Exon {anchor_rank} (5\u2032 UTR): intronic <b>AG(+{_ag_disp})</b> \u2192 cryptic "
            f"<b>GT(+{_donor_disp})</b> (SpliceAI DS_DG Δ{_pdg_disp} bp) retains "
            f"<b>{len(retained)} nt</b> in the 5\u2032 UTR before coding exon {next_rank or '?'} "
            f"\u2014 annotated ORF / start codon unchanged."
        )
    elif model == 'canonical_proximal' and anchor_rank is not None:
        _donor_disp = _donor_hgvs_off if _donor_hgvs_off is not None else _donor_off
        _pdg_disp = f'{int(pdg):+d}' if pdg is not None else '?'
        mechanism_html = (
            f"Exon {anchor_rank} <b>canonical AG acceptor</b> pairs with cryptic "
            f"<b>GT(+{_donor_disp})</b> (SpliceAI DS_DG Δ{_pdg_disp} bp from variant) "
            f"→ <b>{len(retained)} nt</b> of intron retained as an in-frame pseudo-exon "
            f"<em>after exon {anchor_rank}</em>"
        )
        if next_rank is not None:
            mechanism_html += f" (not an extension of exon {next_rank})"
        mechanism_html += (
            ". Only the <b>donor</b> is new; the <b>acceptor</b> is reused from the "
            f"exon {anchor_rank} junction."
        )
        if rna_ev and rna_ev.get('summary'):
            mechanism_html += f' <span style="color:#a7f3d0">{rna_ev["summary"]}</span>'
    viz = {
        'anchor_exon_rank': anchor_rank,
        'downstream_exon_rank': next_rank,
        'donor_offset_1based': _donor_off,
        'donor_hgvs_offset_1based': _donor_hgvs_off,
        'donor_seq_offset_1based': _donor_seq_off,
        'intronic_ag_offset_1based': _ag_off,
        'canonical_gt_offset_1based': 1,
        'canonical_acceptor_offset_1based': (_ilen - 1) if _ilen else None,
        'pseudoexon_retained_nt': len(retained),
        'pseudoexon_span_nt': span_nt,
        'intron_length_nt': _ilen,
        'intronic_skipped_nt': _skipped_nt,
        'canonical_proximal': model == 'canonical_proximal',
        'model': model,
        'mechanism': 'donor_gain',
        'spliceai_dg_delta': pdg,
        'pre_atg_utr': is_pre_atg,
    }
    return {
        'outcome': co_pri,
        'html': html_out,
        'viz': viz,
        'mechanism_html': mechanism_html,
        'retained': retained,
        'model': model,
    }


def _deep_intronic_apply_primary_from_acceptor_bundle(
    parsed_data, bundle, pag, sag, cx, details, mut_seq, *, as_alternate=False, product_label=None,
):
    """Promote acceptor-gain product bundle to primary (or alternate) deep-intronic fields."""
    co_pri = bundle['outcome']
    role = product_label or ('Product 2 (alternate splice)' if as_alternate else 'Product 1 (primary)')
    html_out = _format_splice_product_outcome_html(
        co_pri, parsed_data, '',
        product_role=role,
        signal_sig={'kind': 'acceptor_gain', 'ds': sag, 'dp': pag},
    )
    if as_alternate:
        if not parsed_data.get('deep_intronic_alternate_splice_math'):
            parsed_data['deep_intronic_alternate_splice_math'] = html_out
            parsed_data['deep_intronic_alternate_outcome'] = co_pri
            parsed_data['deep_intronic_viz_alternate'] = bundle.get('viz') or {}
        else:
            parsed_data['deep_intronic_alternate2_splice_math'] = html_out
        return
    parsed_data['deep_intronic_primary_splice_math'] = html_out
    parsed_data['deep_intronic_primary_outcome'] = co_pri
    parsed_data['cryptic_splice_outcome'] = co_pri
    retained = co_pri.get('inserted_cdna') or ''
    if retained:
        parsed_data['cryptic_inserted_cdna'] = retained
    viz = bundle.get('viz') or {}
    try:
        _ilen = int(details.get('intron_length_nt') or len(mut_seq or '') or 0)
    except (TypeError, ValueError):
        _ilen = len(mut_seq or '') or 0
    parsed_data['deep_intronic_viz_primary'] = {
        'anchor_exon_rank': viz.get('anchor_exon_rank'),
        'downstream_exon_rank': viz.get('downstream_exon_rank'),
        'acceptor_offset_1based': viz.get('acceptor_offset_1based'),
        'gt_offset_1based': viz.get('gt_offset_1based'),
        'canonical_acceptor_offset_1based': viz.get('acceptor_offset_1based'),
        'pseudoexon_retained_nt': viz.get('pseudoexon_retained_nt'),
        'pseudoexon_span_nt': viz.get('pseudoexon_span_nt'),
        'intronic_skipped_nt': viz.get('intronic_skipped_nt'),
        'intron_length_nt': _ilen,
        'canonical_proximal': bool(viz.get('canonical_proximal_acceptor')),
        'model': viz.get('model'),
        'mechanism': 'acceptor_gain',
        'spliceai_ag_delta': pag,
    }
    parsed_data['deep_intronic_pseudoexon_model'] = viz.get('model')
    if viz.get('canonical_proximal_acceptor') and cx:
        try:
            anchor_rank = int(cx.get('anatomical_rank') or 0)
        except (TypeError, ValueError):
            anchor_rank = 0
        body_nt = viz.get('pseudoexon_retained_nt')
        try:
            body_i = int(body_nt or 0)
        except (TypeError, ValueError):
            body_i = 0
        _frame = (
            'out-of-frame ORF shift \u2192 frameshift/PTC'
            if body_i % 3 != 0
            else 'in-frame pseudo-exon'
        )
        _ag_disp = viz.get('acceptor_offset_1based')
        _pdg_disp = f'{int(pag):+d}' if pag is not None else '?'
        _mech = (
            f"Exon {anchor_rank} <b>canonical intronic GT</b> pairs with cryptic "
            f"<b>AG(+{_ag_disp})</b> (SpliceAI DS_AG Δ{_pdg_disp} bp from variant) "
            f"→ <b>{body_nt} nt</b> retained as a {_frame} "
            f"<em>after exon {anchor_rank}</em> (computational model)."
        )
        parsed_data['deep_intronic_mechanism_html'] = _mech
    elif viz.get('model') == 'acceptor_gain' and cx:
        try:
            anchor_rank = int(cx.get('anatomical_rank') or 0)
        except (TypeError, ValueError):
            anchor_rank = 0
        body_nt = viz.get('pseudoexon_retained_nt')
        _ag_disp = viz.get('acceptor_offset_1based')
        _gt_disp = viz.get('gt_offset_1based')
        _pdg_disp = f'{int(pag):+d}' if pag is not None else '?'
        _dn = viz.get('downstream_exon_rank') or (anchor_rank + 1 if anchor_rank else '?')
        _mech = (
            f"Intron exon {anchor_rank}–{_dn}: SpliceAI acceptor gain "
            f"\u0394{_pdg_disp} bp \u2192 <b>GT(+{_gt_disp})\u2026AG(+{_ag_disp})</b> "
            f"pseudo-exon (<b>{body_nt} nt</b> after exon {anchor_rank}, before exon {_dn}; "
            f"HGVS c.N\u2212 + SpliceAI \u0394; canonical 3\u2032 acceptor skipped)."
        )
        parsed_data['deep_intronic_mechanism_html'] = _mech
    elif viz.get('model') == 'nearest_intronic_gt' and cx:
        try:
            anchor_rank = int(cx.get('anatomical_rank') or 0)
        except (TypeError, ValueError):
            anchor_rank = 0
        body_nt = viz.get('pseudoexon_retained_nt')
        _ag_disp = viz.get('acceptor_offset_1based')
        _gt_disp = viz.get('gt_offset_1based')
        _pdg_disp = f'{int(pag):+d}' if pag is not None else '?'
        _mech = (
            f"SpliceAI acceptor gain Δ{_pdg_disp} bp → local cryptic "
            f"<b>GT(+{_gt_disp})…AG(+{_ag_disp})</b> mini-exon "
            f"(<b>{body_nt} nt</b> ORF insert after exon {anchor_rank}; "
            f"nearest upstream intronic GT to the gained AG, not the intron 5′ anchor)."
        )
        parsed_data['deep_intronic_mechanism_html'] = _mech
    _apply_junction_outcome_to_parsed_data(parsed_data, co_pri)
    parsed_data['spliceai_junction_model_preferred'] = True


def compute_deep_intronic_spliceai_products(http_session, parsed_data, c_dot, di):
    """
    Deep intronic: SpliceAI-qualified products at distinct offsets:
      Donor-side (c.N+): primary donor gain (DS_DG); alternate donor loss (DS_DL) or acceptor gain.
      Acceptor-side (c.N−): primary acceptor gain (DS_AG); alternate acceptor loss (DS_AL) whole-exon skip.
    Intronic duplications: establish duplication-baseline frameshift first; SpliceAI fates are alternates.
    """
    if not di or not di.get('eligible'):
        return
    details = di.get('details') or {}
    mut_seq = details.get('mut_intron_tx_seq') or details.get('wt_intron_tx_seq')
    j_var = details.get('variant_intron_j_var')
    strand = details.get('strand', parsed_data.get('transcript_strand', 1))
    c_dot_s = str(c_dot or '')
    if not mut_seq or j_var is None:
        return

    j_var = _intronic_j_var_from_hgvs(len(mut_seq), c_dot_s, j_var)

    # Canonical junction splice variants use _resolve_cryptic_splice_outcome (±30 nt window).
    # Deep intronic product math is only for intron-body / non-junction-annotated variants.
    cons_l = (parsed_data.get('consequence') or '').lower()
    if 'splice_donor' in cons_l or 'splice_acceptor' in cons_l:
        return

    try:
        sdg = float(parsed_data.get('spliceai_ds_dg') or 0)
        sdl = float(parsed_data.get('spliceai_ds_dl') or 0)
        sag = float(parsed_data.get('spliceai_ds_ag') or 0)
        sal = float(parsed_data.get('spliceai_ds_al') or 0)
    except (TypeError, ValueError):
        return

    thr = DEEP_INTRONIC_MIN_SPLICE_PREDICTOR

    # SpliceAI's DS + Δbp already places every signaled splice site, so we should
    # not fabricate an upstream/downstream partner via heuristic GT…AG scanning.
    # When SpliceAI's signal is single-sided at a junction-proximal variant, the
    # canonical-proximal cryptic-splice path (cryptic_inserted_cdna / cryptic_*
    # fields) is the correct model — the unchanged canonical site on the other
    # side handles its end. A pseudo-exon model only makes biological sense
    # when SpliceAI predicts both an acceptor-side AND a donor-side change,
    # which is the deep-intronic exonization case.
    minus_off = _deep_intronic_hgvs_minus_offset(c_dot_s)
    plus_off = _deep_intronic_hgvs_plus_offset(c_dot_s)
    junction_offset = minus_off if minus_off is not None else plus_off
    junction_prox = junction_offset is not None and junction_offset <= 15
    acceptor_signal = max(sag, sal) >= thr
    donor_signal = max(sdg, sdl) >= thr
    if junction_prox and acceptor_signal != donor_signal:
        # Exactly one side signals (XOR): canonical-proximal cryptic shift, not
        # a pseudo-exon. Skip the heuristic GT…AG construction so the panel
        # falls back to the SpliceAI-anchored cryptic-splice product.
        parsed_data.setdefault(
            'deep_intronic_skip_reason',
            'Junction-proximal single-sided SpliceAI signal '
            f'(acceptor={acceptor_signal}, donor={donor_signal}); '
            'using SpliceAI-anchored cryptic-splice product, no GT…AG pseudo-exon scan.',
        )
        return

    plan = _deep_intronic_spliceai_signal_plan(parsed_data, thr, c_dot=c_dot_s)
    if not plan or not plan.get('primary'):
        return
    parsed_data['deep_intronic_spliceai_signal_plan'] = plan
    pk = plan['primary']['kind']
    alt_sig = plan.get('alternate')

    coding_exons = parsed_data.get('coding_exons') or []
    if not coding_exons:
        return
    cds_seq = _ensure_cds_seq(parsed_data, http_session)
    if not cds_seq:
        return

    dup_insert = details.get('dup_insert_seq') or ''
    has_dup_baseline = False
    if dup_insert:
        bl = _deep_intronic_dup_baseline_bundle(
            parsed_data, cds_seq, coding_exons, c_dot_s, dup_insert, details,
        )
        if bl:
            has_dup_baseline = True
            parsed_data['deep_intronic_dup_baseline_outcome'] = bl['outcome']
            parsed_data['deep_intronic_primary_splice_math'] = bl['html']
            parsed_data['deep_intronic_primary_outcome'] = bl['outcome']
            parsed_data['deep_intronic_viz_primary'] = bl.get('viz') or {}
            parsed_data['deep_intronic_pseudoexon_model'] = 'dup_baseline'
            fs = (bl['outcome'].get('fs_ter_str') or '').strip()
            parsed_data['deep_intronic_mechanism_html'] = (
                f"<b>Step 1 — duplication in transcript</b> ({len(dup_insert)} nt retained at "
                f"c.{_deep_intronic_dup_cds_insert_index(c_dot_s) + 1 if _deep_intronic_dup_cds_insert_index(c_dot_s) is not None else '?'})"
                f"{': ' + fs if fs else ''}. "
                f"<b>Step 2 — alternate splice fates</b> (SpliceAI) may use a <b>new AG</b> in the "
                f"duplicated sequence or the <b>canonical acceptor</b> (exon skip)."
            )
            _apply_dup_baseline_to_parsed_data(parsed_data, bl['outcome'])
            parsed_data['deep_intronic_splice_products_active'] = True

    built_any = has_dup_baseline

    # --- Primary: driven by top SpliceAI gain (or loss if no gain qualifies) ---
    if pk == 'acceptor_gain':
        cx_ag = _deep_intronic_upstream_exon_for_acceptor_side(parsed_data, coding_exons, details)
        cx_dn = _deep_intronic_downstream_exon_for_acceptor_side(parsed_data, coding_exons, details)
        if cx_dn:
            parsed_data['variant_exon'] = cx_dn.get('anatomical_rank')
        pag = plan['primary']['dp']
        sag = plan['primary']['ds']
        if cx_ag and pag is not None:
            primary_geom = _acceptor_gain_intronic_geometry(
                mut_seq, j_var, pag, c_dot_s, strand
            )
            built_ag = []
            if primary_geom:
                bundle = _deep_intronic_acceptor_gain_product_bundle(
                    primary_geom, mut_seq, j_var, pag, sag, sdl, cx_ag, cds_seq, coding_exons, parsed_data, details, c_dot_s
                )
                if bundle:
                    built_ag.append(bundle)
                    try:
                        _ag_i = primary_geom.get('ag_start')
                        next_geom = _acceptor_gain_next_gt_ag_pair(mut_seq, _ag_i, primary_geom)
                        if next_geom:
                            next_geom = dict(next_geom)
                            next_geom['acceptor_pair_rank'] = 'next'
                            next_bundle = _deep_intronic_acceptor_gain_product_bundle(
                                next_geom, mut_seq, j_var, pag, sag, sdl, cx_ag, cds_seq,
                                coding_exons, parsed_data, details, c_dot_s,
                            )
                            if next_bundle:
                                _deep_intronic_apply_acceptor_next_bundle(
                                    parsed_data, next_bundle, pag, sag,
                                )
                    except (TypeError, ValueError):
                        pass
            if built_ag:
                _deep_intronic_apply_primary_from_acceptor_bundle(
                    parsed_data,
                    built_ag[0],
                    pag,
                    sag,
                    cx_ag,
                    details,
                    mut_seq,
                    as_alternate=has_dup_baseline,
                    product_label='Product 2 (SpliceAI acceptor gain)' if has_dup_baseline else None,
                )
                built_any = True
                if alt_sig and alt_sig.get('kind') == 'donor_gain':
                    cx_dg = _deep_intronic_donor_gain_anchor_exon(parsed_data, coding_exons, details)
                    dg_bundle = _deep_intronic_donor_gain_product_bundle(
                        parsed_data, cds_seq, coding_exons, details, c_dot_s,
                        mut_seq, j_var, strand, alt_sig['dp'], alt_sig['ds'], sdl,
                        product_role='Product 2 (canonical intronic GT → cryptic donor)',
                        cx=cx_dg,
                    )
                    if dg_bundle:
                        _deep_intronic_apply_donor_gain_bundle(parsed_data, dg_bundle, as_alternate=True)
                if len(built_ag) > 1:
                    alt_key = (
                        'deep_intronic_alternate2_splice_math'
                        if parsed_data.get('deep_intronic_alternate_splice_math')
                        else 'deep_intronic_alternate_splice_math'
                    )
                    parsed_data[alt_key] = built_ag[1]['html']
                    if alt_key.endswith('alternate_splice_math'):
                        parsed_data['deep_intronic_alternate_outcome'] = built_ag[1]['outcome']
                        parsed_data['deep_intronic_viz_alternate'] = built_ag[1]['viz']
                    parsed_data['spliceai_secondary_mechanism'] = 'acceptor_gain_decoy'
            if alt_sig and alt_sig['kind'] in ('acceptor_loss', 'donor_loss'):
                pal = alt_sig['dp']
                sal = alt_sig['ds']
                loss_kind = alt_sig['kind']
                if pal is not None and abs(pal - pag) >= 10:
                    cx_skip = _spliceai_loss_skip_exon(loss_kind, parsed_data, coding_exons, details)
                    bundle_loss = _spliceai_loss_product(
                        cx_skip, cds_seq, coding_exons, parsed_data, loss_kind, pal, sal
                    )
                    if bundle_loss:
                        loss_label = (
                            'Product 3 (canonical acceptor / exon skip)'
                            if has_dup_baseline and loss_kind == 'acceptor_loss'
                            else 'Product 2 (alternate splice loss)'
                        )
                        loss_html = _format_splice_product_outcome_html(
                            bundle_loss['outcome'],
                            parsed_data,
                            (
                                'Uses canonical acceptor — duplicated segment spliced out / exon skipping.'
                                if has_dup_baseline and loss_kind == 'acceptor_loss'
                                else ''
                            ),
                            product_role=loss_label,
                            signal_sig={'kind': loss_kind, 'ds': sal, 'dp': pal},
                        )
                        alt_key = (
                            'deep_intronic_alternate2_splice_math'
                            if parsed_data.get('deep_intronic_alternate_splice_math')
                            else 'deep_intronic_alternate_splice_math'
                        )
                        parsed_data[alt_key] = loss_html
                        if alt_key.endswith('alternate_splice_math'):
                            parsed_data['deep_intronic_alternate_outcome'] = bundle_loss['outcome']
                            parsed_data['deep_intronic_viz_alternate'] = bundle_loss['viz']
                        parsed_data['spliceai_secondary_mechanism'] = (
                            '3prime_acceptor_loss' if loss_kind == 'acceptor_loss' else '5prime_donor_loss'
                        )
                        parsed_data['spliceai_secondary_exon_rank'] = cx_skip.get('anatomical_rank')
                        _apply_co_to_secondary_skip_viz(parsed_data, bundle_loss['outcome'])
                        built_any = True

    run_donor_primary = pk == 'donor_gain' or (
        pk == 'acceptor_gain' and not built_any and not has_dup_baseline
    )
    if run_donor_primary:
        dg_sig = plan['primary'] if pk == 'donor_gain' else _deep_intronic_donor_gain_signal_from_plan(plan)
        cx = _deep_intronic_donor_gain_anchor_exon(parsed_data, coding_exons, details)
        if dg_sig and cx:
            pdg = dg_sig['dp']
            sdg = dg_sig['ds']
            dg_bundle = _deep_intronic_donor_gain_product_bundle(
                parsed_data, cds_seq, coding_exons, details, c_dot_s,
                mut_seq, j_var, strand, pdg, sdg, sdl,
                product_role='Product 1 (primary)', cx=cx,
            )
            if dg_bundle:
                _deep_intronic_apply_donor_gain_bundle(parsed_data, dg_bundle)
                built_any = True

            if pk == 'donor_gain' and not parsed_data.get('deep_intronic_alternate_splice_math') and alt_sig:
                if alt_sig['kind'] in ('donor_loss', 'acceptor_loss'):
                    p_loss = alt_sig['dp']
                    s_loss = alt_sig['ds']
                    pri_dp = pdg
                    if pri_dp is not None and p_loss is not None and abs(p_loss - pri_dp) >= 10:
                        bundle_loss = _spliceai_loss_product(
                            _spliceai_loss_skip_exon(alt_sig['kind'], parsed_data, coding_exons, details),
                            cds_seq, coding_exons, parsed_data, alt_sig['kind'], p_loss, s_loss,
                        )
                        if bundle_loss:
                            parsed_data['deep_intronic_alternate_splice_math'] = bundle_loss['html']
                            parsed_data['deep_intronic_alternate_outcome'] = bundle_loss['outcome']
                            parsed_data['deep_intronic_viz_alternate'] = bundle_loss['viz']
                            parsed_data['spliceai_secondary_mechanism'] = bundle_loss['viz']['mechanism']
                            parsed_data['spliceai_secondary_exon_rank'] = bundle_loss['viz'].get('exon_rank')
                            _apply_co_to_secondary_skip_viz(parsed_data, bundle_loss['outcome'])
                            built_any = True
                elif alt_sig['kind'] == 'acceptor_gain':
                    pag_alt = alt_sig['dp']
                    sag_alt = alt_sig['ds']
                    if abs(pag_alt - pdg) >= 10:
                        cx_ag_alt = _deep_intronic_upstream_exon_for_acceptor_side(parsed_data, coding_exons, details)
                        primary_geom = _acceptor_gain_intronic_geometry(
                            mut_seq, j_var, pag_alt, c_dot_s, strand
                        )
                        built_ag = []
                        for picked in [primary_geom] if primary_geom else []:
                            bundle = _deep_intronic_acceptor_gain_product_bundle(
                                picked, mut_seq, j_var, pag_alt, sag_alt, sdl, cx_ag_alt or cx, cds_seq, coding_exons,
                                parsed_data, details, c_dot_s,
                            )
                            if bundle:
                                built_ag.append(bundle)
                        if built_ag:
                            alt_html = _deep_intronic_format_acceptor_alternate_html(
                                parsed_data,
                                built_ag[0],
                                {'ds': sag_alt, 'dp': pag_alt},
                            )
                            parsed_data['deep_intronic_alternate_splice_math'] = alt_html
                            parsed_data['deep_intronic_alternate_outcome'] = built_ag[0]['outcome']
                            parsed_data['deep_intronic_viz_alternate'] = built_ag[0]['viz']
                            parsed_data['spliceai_secondary_mechanism'] = 'acceptor_gain'
                            if len(built_ag) > 1:
                                parsed_data['deep_intronic_alternate2_splice_math'] = built_ag[1]['html']
                                parsed_data['deep_intronic_alternate2_outcome'] = built_ag[1]['outcome']
                                parsed_data['deep_intronic_viz_alternate2'] = built_ag[1]['viz']
                            built_any = True

    elif pk in ('acceptor_loss', 'donor_loss'):
        p_loss = plan['primary']['dp']
        s_loss = plan['primary']['ds']
        cx_skip = _spliceai_loss_skip_exon(pk, parsed_data, coding_exons, details)
        bundle_loss = _spliceai_loss_product(
            cx_skip, cds_seq, coding_exons, parsed_data, pk, p_loss, s_loss
        )
        if bundle_loss:
            parsed_data['deep_intronic_primary_splice_math'] = bundle_loss['html']
            parsed_data['deep_intronic_primary_outcome'] = bundle_loss['outcome']
            parsed_data['cryptic_splice_outcome'] = bundle_loss['outcome']
            parsed_data['deep_intronic_viz_primary'] = bundle_loss['viz']
            parsed_data['spliceai_secondary_mechanism'] = bundle_loss['viz']['mechanism']
            _apply_co_to_secondary_skip_viz(parsed_data, bundle_loss['outcome'])
            built_any = True

    if plan and _deep_intronic_dual_gain_both_qualify(plan, thr):
        if _deep_intronic_ensure_dual_gain_companion(
            parsed_data,
            plan,
            thr,
            mut_seq=mut_seq,
            j_var=j_var,
            strand=strand,
            c_dot_s=c_dot_s,
            cds_seq=cds_seq,
            coding_exons=coding_exons,
            details=details,
            sdl=sdl,
        ):
            built_any = True

    if built_any:
        parsed_data['deep_intronic_splice_products_active'] = True
        parsed_data['cryptic_splice_narrative'] = ''
        parsed_data['spliceai_narrative_condensed'] = True
        parsed_data['spliceai_narrative'] = ''
        parsed_data['deep_intronic_splice_html'] = ''
        if parsed_data.get('splice_frame_math') and 'Exon' in str(parsed_data.get('splice_frame_math')):
            parsed_data['splice_frame_math_exon_skip_ref'] = parsed_data.get('splice_frame_math')
            parsed_data.pop('splice_frame_math', None)
        _sync_deep_intronic_primary_to_cryptic_fields(parsed_data)


def _logic_section_text_plain(desc):
    """
    Strip HTML for logic_explanation_plaintext copy-paste while PRESERVING line
    breaks. The renderer puts <br> between sub-bullets and <br><br> between major
    blocks (gain/loss/lead in Splice Structural Math, junction insert / summary
    in Cryptic Splice / NMD Evaluation, etc.). The previous implementation flattened
    everything to a single line which made the copy/paste output unreadable.
    """
    if not desc:
        return desc
    t = str(desc)
    t = re.sub(r'<\s*br\s*/?\s*>\s*<\s*br\s*/?\s*>', '\n\n', t, flags=re.IGNORECASE)
    t = re.sub(r'<\s*br\s*/?\s*>', '\n', t, flags=re.IGNORECASE)

    def _anchor_to_plain(m):
        href = (m.group(2) or '').strip()
        inner = m.group(3) or ''
        inner = re.sub(r'<[^>]+>', '', inner)
        inner = html.unescape(inner).strip()
        # ClinVar variation pages: copy/paste should show HGVS + variation ID text only, not full URLs.
        cm = re.search(
            r'https?://(?:www\.)?ncbi\.nlm\.nih\.gov/clinvar/variation/(\d+)/?',
            href,
            flags=re.I,
        )
        if cm:
            return inner if inner else cm.group(1)
        if href and 'uniprot.org' in href.lower():
            return inner if inner else 'UniProt'
        if href and 'metadome' in href.lower():
            return inner if inner else 'MetaDome'
        if href and inner:
            return f"{inner} ({href})"
        if href:
            return href
        return inner

    t = re.sub(
        r'<a\s+[^>]*?\bhref\s*=\s*(["\'])(.*?)\1[^>]*>(.*?)</a>',
        _anchor_to_plain,
        t,
        flags=re.IGNORECASE | re.DOTALL,
    )
    t = re.sub(r'<[^>]+>', '', t)
    t = html.unescape(t)
    cleaned_lines = []
    for raw_line in t.splitlines():
        line = re.sub(r'[ \t]+', ' ', raw_line).strip()
        cleaned_lines.append(line)
    out_lines = []
    blank_streak = 0
    for line in cleaned_lines:
        if line:
            out_lines.append(line)
            blank_streak = 0
        else:
            if blank_streak == 0 and out_lines:
                out_lines.append('')
            blank_streak += 1
    while out_lines and out_lines[-1] == '':
        out_lines.pop()
    text = '\n'.join(out_lines)
    # Fine-print line from cryptic gain resolver; exon + NMD already stated above.
    text = re.sub(
        r'(?m)^\s*PTC location detail:\s*.+\s*$',
        '',
        text,
    )
    text = re.sub(r'\n{3,}', '\n\n', text).strip()
    return text
