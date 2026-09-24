"""MetaDome missense tolerance lookup (complementary to UniProt domains).

Uses the public MetaDome web API (no key):
  https://stuart.radboudumc.nl/metadome/api

Returns per-residue sliding-window dN/dS (``sw_dn_ds``; lower = more intolerant)
plus Pfam domain counts when the landscape is already built. Cold builds may
return ``status=processing`` with a deep-link for the curator.

Cite: Wiel et al., Hum Mutat. 2019;40(8):1030-1038. doi:10.1002/humu.23798
"""
from __future__ import annotations

import time
import urllib.parse
from typing import Any, Optional

from vc_engine.hgvs import _parse_missense_substitution_hgvs_p

_METADOME_API = "https://stuart.radboudumc.nl/metadome/api"
_METADOME_UI = "https://stuart.radboudumc.nl/metadome/"
_METADOME_CITATION = (
    "Wiel L et al. MetaDome: Pathogenicity analysis of genetic variants through "
    "aggregation of homologous human protein domains. Hum Mutat. 2019;40(8):1030-1038."
)

# UCSC / MetaDome FAQ bins (lower sw_dn_ds = more constrained).
_HIGHLY_INTOLERANT = 0.175
_INTOLERANT = 0.525
_SLIGHTLY_INTOLERANT = 0.7


def metadome_ui_url(gene: str = "", transcript_id: str = "") -> str:
    g = (gene or "").strip()
    if g:
        return f"{_METADOME_UI}?gene={urllib.parse.quote(g)}"
    return _METADOME_UI


def _tolerance_label(sw_dn_ds: Optional[float]) -> str:
    if sw_dn_ds is None:
        return "unknown"
    try:
        v = float(sw_dn_ds)
    except (TypeError, ValueError):
        return "unknown"
    if v <= _HIGHLY_INTOLERANT:
        return "highly intolerant"
    if v <= _INTOLERANT:
        return "intolerant"
    if v <= _SLIGHTLY_INTOLERANT:
        return "slightly intolerant"
    return "tolerant"


def _missense_aa_position(parsed_data: dict) -> int:
    try:
        ps = int(parsed_data.get("protein_start") or 0)
        if ps > 0:
            return ps
    except (TypeError, ValueError):
        pass
    sub = _parse_missense_substitution_hgvs_p(parsed_data.get("hgvs_p") or "")
    if sub and sub.get("pos"):
        try:
            return int(sub["pos"])
        except (TypeError, ValueError):
            return 0
    return 0


def _is_missense_context(parsed_data: dict) -> bool:
    if parsed_data.get("noncoding_track"):
        return False
    csq = str(parsed_data.get("consequence") or "").lower()
    if "missense" in csq:
        return True
    return bool(_parse_missense_substitution_hgvs_p(parsed_data.get("hgvs_p") or ""))


def _split_refseq(value: object) -> list[str]:
    if not isinstance(value, str) or not value.strip():
        return []
    return [t.strip() for t in value.split(",") if t.strip()]


def _pick_metadome_transcript(
    entries: list[dict], *, target_nm: str = "", ensembl_id: str = ""
) -> Optional[dict]:
    """Prefer ENST matching curated NM / ENST, else longest protein-bearing transcript."""
    nm_base = (target_nm or "").split(".")[0].upper()
    enst_base = (ensembl_id or "").split(".")[0].upper()
    protein = [e for e in entries if e.get("has_protein_data") and e.get("gencode_id")]
    if not protein:
        protein = [e for e in entries if e.get("gencode_id")]
    if not protein:
        return None

    if nm_base:
        for e in protein:
            refs = [r.split(".")[0].upper() for r in (e.get("refseq_ids") or [])]
            if nm_base in refs:
                return e
    if enst_base:
        for e in protein:
            gid = str(e.get("gencode_id") or "").upper()
            if gid.startswith(enst_base):
                return e

    def _score(e: dict) -> tuple:
        return (
            1 if e.get("has_protein_data") else 0,
            int(e.get("aa_length") or 0),
            1 if (e.get("refseq_ids") or []) else 0,
        )

    return max(protein, key=_score)


def _fetch_transcripts(http_session, gene: str) -> list[dict]:
    url = f"{_METADOME_API}/get_transcripts/{urllib.parse.quote(gene, safe='')}"
    resp = http_session.get(url, timeout=20)
    if resp.status_code != 200:
        return []
    body = resp.json() if hasattr(resp, "json") else {}
    if not isinstance(body, dict):
        return []
    raw = body.get("trancript_ids") or body.get("transcript_ids") or []
    out = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        out.append(
            {
                "gencode_id": entry.get("gencode_id"),
                "aa_length": entry.get("aa_length"),
                "has_protein_data": bool(entry.get("has_protein_data", False)),
                "refseq_ids": _split_refseq(entry.get("refseq_nm_numbers", "")),
            }
        )
    return out


def _ensure_landscape(http_session, transcript_id: str, *, soft_deadline_s: float = 12.0):
    """Submit + short poll. Returns (status, result_or_none)."""
    tid = (transcript_id or "").strip()
    if not tid or "." not in tid:
        return "failed", {"error": "MetaDome requires a versioned ENST id."}

    try:
        http_session.post(
            f"{_METADOME_API}/submit_visualization/",
            json={"transcript_id": tid},
            timeout=20,
        )
    except Exception as e:
        return "failed", {"error": f"submit failed: {e}"}

    start = time.monotonic()
    interval = 0.8
    while True:
        try:
            st_resp = http_session.get(f"{_METADOME_API}/status/{tid}/", timeout=15)
            status = ""
            if st_resp.status_code == 200:
                body = st_resp.json()
                status = str((body or {}).get("status") or "")
        except Exception as e:
            return "failed", {"error": f"status failed: {e}"}

        if status == "SUCCESS":
            try:
                res = http_session.get(f"{_METADOME_API}/result/{tid}/", timeout=45)
                if res.status_code == 200:
                    return "ready", res.json()
                return "failed", {"error": f"result HTTP {res.status_code}"}
            except Exception as e:
                return "failed", {"error": f"result failed: {e}"}
        if status == "FAILURE":
            try:
                err = http_session.get(f"{_METADOME_API}/error/{tid}/", timeout=15)
                return "failed", err.json() if err.status_code == 200 else {"error": "build failed"}
            except Exception:
                return "failed", {"error": "build failed"}

        if time.monotonic() - start >= soft_deadline_s:
            return "processing", None
        remain = soft_deadline_s - (time.monotonic() - start)
        if remain <= 0:
            return "processing", None
        time.sleep(min(interval, remain))
        interval = min(interval * 1.4, 3.0)


def _position_entry(landscape: dict, aa_pos: int) -> Optional[dict]:
    positions = landscape.get("positional_annotation") or []
    if not isinstance(positions, list) or aa_pos < 1:
        return None
    if 0 <= aa_pos - 1 < len(positions):
        entry = positions[aa_pos - 1]
        if isinstance(entry, dict):
            ppos = int(entry.get("protein_pos") or 0)
            if ppos in (0, aa_pos):
                return entry
    for entry in positions:
        if isinstance(entry, dict) and int(entry.get("protein_pos") or 0) == aa_pos:
            return entry
    return None


def _summarize_domains(entry: dict) -> list[dict[str, Any]]:
    domains = entry.get("domains") or {}
    if not isinstance(domains, dict):
        return []
    out = []
    for pfam_id, info in domains.items():
        if not isinstance(info, dict):
            continue
        out.append(
            {
                "pfam_id": pfam_id,
                "consensus_pos": (info.get("consensus_pos") or [None])[0],
                "pathogenic_missense_variant_count": info.get(
                    "pathogenic_missense_variant_count", 0
                ),
                "normal_missense_variant_count": info.get("normal_missense_variant_count", 0),
            }
        )
    return out


def apply_metadome_missense_lookup(http_session, parsed_data: dict, effective_gene: str) -> dict:
    """Populate ``parsed_data['metadome_*']`` for missense alleles. Safe no-op otherwise."""
    gene = (effective_gene or parsed_data.get("gene") or "").strip()
    parsed_data["metadome_checked"] = True
    parsed_data["metadome_link"] = metadome_ui_url(gene)
    parsed_data["metadome_citation"] = _METADOME_CITATION

    if not _is_missense_context(parsed_data):
        parsed_data["metadome_status"] = "skipped"
        parsed_data["metadome_skip_reason"] = "not_missense"
        return {}

    aa_pos = _missense_aa_position(parsed_data)
    if aa_pos <= 0:
        parsed_data["metadome_status"] = "skipped"
        parsed_data["metadome_skip_reason"] = "no_protein_position"
        return {}

    if not gene:
        parsed_data["metadome_status"] = "skipped"
        parsed_data["metadome_skip_reason"] = "no_gene"
        return {}

    try:
        txs = _fetch_transcripts(http_session, gene)
    except Exception as e:
        parsed_data["metadome_status"] = "error"
        parsed_data["metadome_error"] = str(e)[:200]
        return {}

    if not txs:
        parsed_data["metadome_status"] = "not_found"
        parsed_data["metadome_error"] = "Gene not in MetaDome transcript set"
        return {}

    target_nm = (parsed_data.get("transcript") or "").strip()
    enst = (parsed_data.get("ensembl_transcript_id") or "").strip()
    picked = _pick_metadome_transcript(txs, target_nm=target_nm, ensembl_id=enst)
    if not picked:
        parsed_data["metadome_status"] = "not_found"
        parsed_data["metadome_error"] = "No MetaDome protein transcript"
        return {}

    tid = str(picked.get("gencode_id") or "")
    parsed_data["metadome_transcript_id"] = tid
    parsed_data["metadome_aa_position"] = aa_pos

    try:
        status, payload = _ensure_landscape(http_session, tid, soft_deadline_s=12.0)
    except Exception as e:
        parsed_data["metadome_status"] = "error"
        parsed_data["metadome_error"] = str(e)[:200]
        return {}

    if status == "processing":
        parsed_data["metadome_status"] = "processing"
        parsed_data["metadome_message"] = (
            "MetaDome landscape still building — open the link; re-run later for the score."
        )
        return {"status": "processing", "transcript_id": tid}

    if status != "ready" or not isinstance(payload, dict):
        parsed_data["metadome_status"] = "error"
        err = ""
        if isinstance(payload, dict):
            err = str(payload.get("error") or payload)[:200]
        parsed_data["metadome_error"] = err or "landscape unavailable"
        return {}

    entry = _position_entry(payload, aa_pos)
    if not entry:
        parsed_data["metadome_status"] = "no_position"
        parsed_data["metadome_error"] = f"No MetaDome annotation at p.{aa_pos}"
        return {}

    try:
        sw = float(entry.get("sw_dn_ds")) if entry.get("sw_dn_ds") is not None else None
    except (TypeError, ValueError):
        sw = None
    label = _tolerance_label(sw)
    domains = _summarize_domains(entry)
    clinvar_n = len(entry.get("ClinVar") or []) if isinstance(entry.get("ClinVar"), list) else 0

    parsed_data["metadome_status"] = "ready"
    parsed_data["metadome_sw_dn_ds"] = sw
    parsed_data["metadome_tolerance_label"] = label
    parsed_data["metadome_ref_aa"] = entry.get("ref_aa") or ""
    parsed_data["metadome_domains"] = domains
    parsed_data["metadome_clinvar_at_residue"] = clinvar_n
    parsed_data["metadome_intolerant"] = bool(sw is not None and sw <= _INTOLERANT)

    domain_bit = ""
    if domains:
        d0 = domains[0]
        domain_bit = f"; Pfam {d0['pfam_id']}"
        if d0.get("pathogenic_missense_variant_count"):
            domain_bit += (
                f" (meta-domain P/LP missense≈{d0['pathogenic_missense_variant_count']})"
            )
    parsed_data["metadome_summary"] = (
        f"p.{aa_pos} {label} (sw_dn_ds={sw:.3f})" if sw is not None else f"p.{aa_pos} {label}"
    ) + domain_bit

    return {
        "status": "ready",
        "sw_dn_ds": sw,
        "label": label,
        "aa_pos": aa_pos,
        "domains": domains,
    }


def append_metadome_logic_section(sections: list, parsed_data: dict) -> None:
    if not parsed_data.get("metadome_checked"):
        return
    status = parsed_data.get("metadome_status") or ""
    if status in ("skipped",):
        return
    link = (parsed_data.get("metadome_link") or _METADOME_UI).strip()
    head = (
        f"<a href='{link}' target='_blank' rel='noopener' "
        f"style='color:#93c5fd;'>MetaDome</a>:"
    )
    if status == "ready":
        body = parsed_data.get("metadome_summary") or "tolerance retrieved"
        sections.append(("MetaDome", f"{body}."))
    elif status == "processing":
        sections.append((
            "MetaDome tolerance",
            f"{head} landscape building — open link / re-run for score.",
        ))
    elif status in ("not_found", "no_position"):
        err = parsed_data.get("metadome_error") or status
        sections.append(("MetaDome tolerance", f"{head} {err}."))
    elif status == "error":
        err = parsed_data.get("metadome_error") or "lookup failed"
        sections.append(("MetaDome tolerance", f"{head} unavailable ({err})."))
