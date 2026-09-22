"""Noncoding / snRNA (n. / NR_) curation helpers.

Checklist, known critical regions, ClinVar genomic-neighbor scan, and search links
for the noncoding analyze track.
"""
from __future__ import annotations

import html
import re
import urllib.parse
from typing import Any, Optional

from vc_engine.clinvar import (
    _clinvar_geneinfo_matches,
    _clinvar_plp_sig_for_deleted_exon,
    clinvar_portal_url,
)
from vc_engine.hgvs import _hgvs_dna_kind, _is_noncoding_dna_hgvs, _normalize_dna_hgvs_prefix

# GRCh38 1-based inclusive windows with published structural disease relevance.
# Curators still verify against current literature; this is a hint, not a rule.
_NONCODING_CRITICAL_REGIONS: dict[str, dict[str, Any]] = {
    "RNU4-2": {
        "chrom": "12",
        "start": 120291825,
        "end": 120291842,
        "label": "18-bp critical region (U4/U6 duplex; ReNU / NDD hotspot)",
        "pmid": "38991538",
        "notes": (
            "Most published pathogenic alleles (e.g. n.64_65insT) map here. "
            "Alleles outside this window need stronger independent evidence."
        ),
    },
}


def noncoding_critical_region(gene: str) -> Optional[dict[str, Any]]:
    g = (gene or "").strip().upper().replace("−", "-")
    return _NONCODING_CRITICAL_REGIONS.get(g)


def _clinvar_search_url(term: str) -> str:
    return (
        "https://www.ncbi.nlm.nih.gov/clinvar/?term="
        + urllib.parse.quote((term or "").strip())
    )


def build_noncoding_clinvar_search_links(
    gene: str, c_dot: str, transcript: str = "", vid: str = ""
) -> dict[str, str]:
    """Gene + n. ClinVar portal queries (and gene P/LP / gene-all)."""
    g = (gene or "").strip()
    cd = _normalize_dna_hgvs_prefix(c_dot)
    tx = (transcript or "").strip()
    out: dict[str, str] = {}
    if not g:
        return out
    if cd:
        out["allele"] = _clinvar_search_url(f"{g}[gene] AND {cd}")
        if tx:
            out["transcript_allele"] = _clinvar_search_url(f"{tx}:{cd}")
    out["gene_all"] = _clinvar_search_url(f"{g}[gene]")
    out["gene_plp"] = _clinvar_search_url(
        f'{g}[gene] AND ("clinsig pathogenic"[Properties] OR '
        f'"clinsig likely pathogenic"[Properties])'
    )
    region = noncoding_critical_region(g)
    if region:
        chrom = region["chrom"]
        start, end = int(region["start"]), int(region["end"])
        # ClinVar genomic range search (GRCh38)
        out["critical_region"] = _clinvar_search_url(
            f"{g}[gene] AND {chrom}[CHR] AND {start}:{end}[CHRPOS]"
        )
    if vid and str(vid).isdigit():
        out["this_vid"] = clinvar_portal_url(vid)
    return out


def _in_critical_region(gene: str, chrom: str, pos: int) -> tuple[bool, Optional[dict]]:
    region = noncoding_critical_region(gene)
    if not region or not pos:
        return False, region
    rc = str(region["chrom"]).replace("chr", "")
    qc = str(chrom or "").replace("chr", "")
    if rc != qc:
        return False, region
    return int(region["start"]) <= int(pos) <= int(region["end"]), region


def scan_noncoding_clinvar_neighbors(
    parsed_data: dict,
    *,
    gene: str,
    window_bp: int = 40,
    global_vcf=None,
) -> list[dict[str, Any]]:
    """
    Local ClinVar VCF P/LP hits near the variant (or overlapping a known critical region).
    Returns structured neighbor rows for UI / logic.
    """
    if global_vcf is None:
        return []
    chrom = str(parsed_data.get("grch38_chrom") or "").replace("chr", "").strip()
    try:
        start = int(parsed_data.get("grch38_start") or 0)
        end = int(parsed_data.get("grch38_end") or start)
    except (TypeError, ValueError):
        return []
    if not chrom or not start:
        return []
    if start > end:
        start, end = end, start

    region = noncoding_critical_region(gene)
    fetch_lo = max(0, start - window_bp)
    fetch_hi = end + window_bp
    if region and str(region["chrom"]).replace("chr", "") == chrom:
        fetch_lo = min(fetch_lo, int(region["start"]) - 5)
        fetch_hi = max(fetch_hi, int(region["end"]) + 5)

    self_vid = str(parsed_data.get("clinvar_rcv") or "").strip()
    hits: list[dict[str, Any]] = []
    seen: set[str] = set()
    try:
        for rec in global_vcf.fetch(str(chrom), fetch_lo, fetch_hi):
            if not rec.id or str(rec.id) in ("None", ".", ""):
                continue
            vid = str(rec.id).strip()
            if vid == self_vid or vid in seen:
                continue
            gene_info = rec.info.get("GENEINFO", "")
            if gene and not _clinvar_geneinfo_matches(gene_info, gene):
                continue
            sig = ""
            try:
                cln = rec.info.get("CLNSIG")
                if isinstance(cln, (list, tuple)):
                    sig = ",".join(str(x) for x in cln)
                elif cln is not None:
                    sig = str(cln)
            except Exception:
                sig = ""
            if not _clinvar_plp_sig_for_deleted_exon(sig):
                continue
            # Prefer HGVS from INFO if present
            hgvs = ""
            for key in ("CLNHGVS", "CLNALLELEID"):
                try:
                    raw = rec.info.get(key)
                except Exception:
                    raw = None
                if raw is None:
                    continue
                if isinstance(raw, (list, tuple)):
                    raw = raw[0] if raw else ""
                s = str(raw)
                if "n." in s.lower() or "NR_" in s.upper():
                    hgvs = s
                    break
                if not hgvs:
                    hgvs = s
            in_crit, _ = _in_critical_region(gene, chrom, int(rec.pos))
            dist = min(abs(int(rec.pos) - start), abs(int(rec.pos) - end))
            seen.add(vid)
            hits.append(
                {
                    "vid": vid,
                    "pos": int(rec.pos),
                    "significance": sig.replace("_", " "),
                    "hgvs": hgvs,
                    "link": clinvar_portal_url(vid),
                    "in_critical_region": in_crit,
                    "distance_bp": dist,
                    "source": "clinvar_vcf",
                }
            )
    except Exception as e:
        print(f"Noncoding ClinVar neighbor scan error: {e}")
        return []

    hits.sort(key=lambda h: (0 if h.get("in_critical_region") else 1, h.get("distance_bp", 9999)))
    return hits[:25]


def build_noncoding_curation_checklist(
    parsed_data: dict, *, gene: str, c_dot: str, transcript: str = ""
) -> list[dict[str, str]]:
    """Curator checklist with auto-filled status where the engine already knows."""
    cd = _normalize_dna_hgvs_prefix(c_dot)
    tx = (transcript or parsed_data.get("transcript") or "").strip()
    chrom = parsed_data.get("grch38_chrom") or ""
    start = parsed_data.get("grch38_start")
    in_crit, region = _in_critical_region(gene, chrom, int(start or 0) if start else 0)
    af = parsed_data.get("gnomad_af")
    af_src = parsed_data.get("gnomad_af_source") or "exomes"
    cv_sig = (parsed_data.get("clinvar_sig") or "").strip()
    cv_vid = str(parsed_data.get("clinvar_rcv") or "").strip()
    neighbors = parsed_data.get("noncoding_clinvar_neighbors") or []
    plp_n = len(neighbors)

    def _status_done(msg: str) -> dict[str, str]:
        return {"status": "done", "text": msg}

    def _status_todo(msg: str) -> dict[str, str]:
        return {"status": "todo", "text": msg}

    def _status_na(msg: str) -> dict[str, str]:
        return {"status": "na", "text": msg}

    items: list[dict[str, str]] = []
    items.append(
        _status_done(f"Allele locked as noncoding track: {gene} {tx + ':' if tx else ''}{cd}".rstrip(":"))
        if cd
        else _status_todo("Confirm gene + NR_ transcript + n. HGVS (do not rewrite to c.).")
    )

    if region:
        if start:
            items.append(
                _status_done(
                    f"Maps inside {region['label']}"
                    if in_crit
                    else f"Outside published critical region ({region['label']}) — weigh carefully"
                )
            )
        else:
            items.append(
                _status_todo(
                    f"Map genomic position vs {region['label']} (PMID {region.get('pmid', '?')})"
                )
            )
    else:
        items.append(
            _status_todo(
                "Check literature for a critical stem/loop or hotspot for this RNA gene"
            )
        )

    if cv_vid or (cv_sig and cv_sig.lower() not in ("", "not found in public databases", "unknown")):
        items.append(
            _status_done(
                f"ClinVar for this allele: {cv_sig or 'record found'}"
                + (f" (VID {cv_vid})" if cv_vid else "")
            )
        )
    else:
        items.append(_status_todo("Search ClinVar for this exact n. allele and same genomic change"))

    if plp_n:
        items.append(
            _status_done(f"Nearby ClinVar P/LP in RNA locus: {plp_n} neighbor(s) listed")
        )
    else:
        items.append(
            _status_todo("Review gene-level / critical-region ClinVar P/LP neighbors")
        )

    try:
        af_f = float(af or 0)
    except (TypeError, ValueError):
        af_f = 0.0
    if af_f > 0:
        items.append(
            _status_done(f"gnomAD AF {af_f:g} ({af_src}) — confirm genomes coverage for snRNA")
        )
    else:
        items.append(
            _status_todo("Check gnomAD genomes AF at this locus (exomes often miss snRNA)")
        )

    items.append(_status_todo("Document gene–disease mechanism + phenotype match strength"))
    items.append(_status_todo("Document inheritance (de novo / inherited / mosaicism)"))
    items.append(
        _status_na(
            "Skip protein predictors (p., UniProt, REVEL, NMD %) — not applicable to n./NR_"
        )
    )
    return items


def apply_noncoding_curation_pack(
    parsed_data: dict,
    *,
    gene: str,
    c_dot: str,
    transcript: str = "",
    global_vcf=None,
) -> dict[str, Any]:
    """Populate parsed_data fields used by logic + UI for the noncoding track."""
    if not _is_noncoding_dna_hgvs(c_dot, transcript or parsed_data.get("transcript")):
        return {}

    gene = (gene or parsed_data.get("effective_gene") or parsed_data.get("gene") or "").strip()
    cd = _normalize_dna_hgvs_prefix(c_dot)
    tx = (transcript or parsed_data.get("transcript") or "").strip()
    chrom = parsed_data.get("grch38_chrom") or ""
    try:
        pos = int(parsed_data.get("grch38_start") or 0)
    except (TypeError, ValueError):
        pos = 0
    in_crit, region = _in_critical_region(gene, chrom, pos)

    neighbors = scan_noncoding_clinvar_neighbors(
        parsed_data, gene=gene, global_vcf=global_vcf
    )
    links = build_noncoding_clinvar_search_links(
        gene, cd, tx, str(parsed_data.get("clinvar_rcv") or "")
    )
    parsed_data["noncoding_clinvar_neighbors"] = neighbors
    parsed_data["noncoding_clinvar_search_links"] = links
    parsed_data["noncoding_critical_region"] = region
    parsed_data["noncoding_in_critical_region"] = bool(in_crit) if region else None
    # Prefer n. allele ClinVar search as the primary exploratory link.
    if links.get("allele"):
        parsed_data["c_allele_search_link"] = links["allele"]
        parsed_data["p_allele_search_link"] = links.get("gene_plp") or links["allele"]

    checklist = build_noncoding_curation_checklist(
        parsed_data, gene=gene, c_dot=cd, transcript=tx
    )
    parsed_data["noncoding_curation_checklist"] = checklist

    pack = {
        "checklist": checklist,
        "links": links,
        "neighbors": neighbors,
        "critical_region": region,
        "in_critical_region": parsed_data.get("noncoding_in_critical_region"),
        "hgvs_dna_kind": _hgvs_dna_kind(cd) or "n",
    }
    parsed_data["noncoding_curation"] = pack
    return pack


def format_noncoding_curation_logic_html(parsed_data: dict) -> str:
    """HTML block for Logic explanation → Noncoding RNA curation."""
    pack = parsed_data.get("noncoding_curation") or {}
    checklist = pack.get("checklist") or parsed_data.get("noncoding_curation_checklist") or []
    links = pack.get("links") or parsed_data.get("noncoding_clinvar_search_links") or {}
    neighbors = pack.get("neighbors") or parsed_data.get("noncoding_clinvar_neighbors") or []
    region = pack.get("critical_region") or parsed_data.get("noncoding_critical_region")
    in_crit = pack.get("in_critical_region")
    if parsed_data.get("noncoding_in_critical_region") is not None:
        in_crit = parsed_data.get("noncoding_in_critical_region")

    parts: list[str] = []
    parts.append(
        "<b>Noncoding RNA track</b> — curate on structure, ClinVar <code>n.</code>, "
        "population genomes AF, inheritance, and phenotype — not missense/NMD metrics."
    )
    if region:
        tag = (
            " <span style='color:#34d399;font-weight:600;'>inside published critical region</span>"
            if in_crit
            else " <span style='color:#fbbf24;font-weight:600;'>outside published critical region</span>"
        )
        pmid = region.get("pmid") or ""
        pmid_bit = f" (PMID {html.escape(str(pmid))})" if pmid else ""
        parts.append(f"{html.escape(region.get('label') or 'Critical region')}{pmid_bit}:{tag}.")
        if region.get("notes"):
            parts.append(html.escape(str(region["notes"])))

    if checklist:
        lis = []
        for it in checklist:
            st = it.get("status") or "todo"
            mark = {"done": "✓", "todo": "☐", "na": "–"}.get(st, "☐")
            lis.append(f"<li><b>{mark}</b> {html.escape(it.get('text') or '')}</li>")
        parts.append("<ul style='margin:6px 0 0 1.1em;padding:0;'>" + "".join(lis) + "</ul>")

    link_bits = []
    for key, label in (
        ("allele", "This n. allele"),
        ("gene_plp", "Gene P/LP"),
        ("gene_all", "All gene"),
        ("critical_region", "Critical region"),
        ("this_vid", "This ClinVar VID"),
    ):
        url = links.get(key)
        if url:
            link_bits.append(
                f"<a href='{html.escape(url)}' target='_blank' rel='noopener' "
                f"style='color:#93c5fd;'>{html.escape(label)}</a>"
            )
    if link_bits:
        parts.append("ClinVar searches: " + " · ".join(link_bits))

    if neighbors:
        rows = []
        for h in neighbors[:8]:
            lab = (h.get("hgvs") or f"chr pos {h.get('pos')}").strip()
            sig = h.get("significance") or "P/LP"
            vid = h.get("vid") or "?"
            href = h.get("link") or clinvar_portal_url(vid)
            crit = " [critical region]" if h.get("in_critical_region") else ""
            rows.append(
                f"{html.escape(lab)} ({html.escape(str(sig))}){html.escape(crit)} "
                f"<a href='{html.escape(href)}' target='_blank' rel='noopener' "
                f"style='color:#fbbf24;'>[VID {html.escape(str(vid))}]</a>"
            )
        parts.append(
            "<b>Nearby ClinVar P/LP:</b><br>"
            + "<br>".join(rows)
        )
    else:
        parts.append("Nearby ClinVar P/LP in scanned window: none matched (or VCF unavailable).")

    return "<br>".join(parts)


def append_noncoding_curation_logic_section(sections: list, parsed_data: dict) -> None:
    if not parsed_data.get("noncoding_track"):
        return
    html_body = format_noncoding_curation_logic_html(parsed_data)
    if html_body:
        sections.append(("Noncoding RNA curation", html_body))
