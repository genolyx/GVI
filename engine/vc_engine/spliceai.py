"""SpliceAI ingest + optional provided-score snapshot/apply policy.

Extracted from ``app_v11.py`` (Phase 3 step 4 of ``docs/ENGINE_SPLIT_PLAN.md``).
Pure functions over ``parsed_data`` / ``emg_spliceai`` dicts — no network, no
module globals. They encode the Broad-vs-provided SpliceAI source-of-truth policy.
The payload key remains ``emg_spliceai`` for engine compatibility.
"""
from __future__ import annotations

from typing import Any


def _parse_spliceai_dp(val):
    if val is None or val == '':
        return None
    try:
        return int(round(float(str(val).strip())))
    except (ValueError, TypeError):
        return None


def _pick_spliceai_score_row(scores_list, gene_symbol=None, target_nm_base=None, enst_id=None):
    """Pick one Broad SpliceAI score row so DS_* and DP_* stay on the same transcript (NM/ENST match → MANE select → gene)."""
    rows = [s for s in (scores_list or []) if isinstance(s, dict)]
    if not rows:
        return None
    nm_base = (target_nm_base or '').split('.')[0].upper().replace('NM_', '')
    if nm_base:
        for s in rows:
            tr = s.get('t_refseq_ids')
            if not tr:
                continue
            if isinstance(tr, str):
                tr = [tr]
            for x in tr:
                xs = str(x).split('.')[0].upper().replace('NM_', '')
                if xs == nm_base:
                    return s
    if enst_id:
        ep = str(enst_id).split('.')[0].upper()
        for s in rows:
            if ep and ep in str(s.get('t_id', '')).upper():
                return s
    for s in rows:
        if s.get('t_priority') == 'MS':
            return s
    if gene_symbol:
        for s in rows:
            if s.get('g_name') == gene_symbol:
                return s
    return rows[0]


def _emg_spliceai_ds_snapshot(emg_spliceai):
    """Return {ds_ag: float, ...} when EMG paste has all four DS scores; never includes DP."""
    if not emg_spliceai or not isinstance(emg_spliceai, dict):
        return None
    alias = {
        "DS_AG": "ds_ag",
        "DS_AL": "ds_al",
        "DS_DG": "ds_dg",
        "DS_DL": "ds_dl",
    }
    flat: dict[str, Any] = {}
    for k, v in emg_spliceai.items():
        key = alias.get(k, k)
        if key.startswith("ds_") and v is not None and v != "":
            flat[key] = v
    ds_keys = ("ds_ag", "ds_al", "ds_dg", "ds_dl")
    if sum(1 for k in ds_keys if flat.get(k) is not None) < 4:
        return None
    out = {}
    for k in ds_keys:
        try:
            out[k] = float(flat[k])
        except (TypeError, ValueError):
            return None
    return out


def _emg_spliceai_complete_snapshot(emg_spliceai):
    """All four DS and four Δbp from EMG — use paste as authoritative for display."""
    ds = _emg_spliceai_ds_snapshot(emg_spliceai)
    dp = _emg_spliceai_dp_snapshot(emg_spliceai, require_all_four=True)
    if not ds or not dp:
        return None
    return {**ds, **dp}


def _refresh_spliceai_in_silico_source(parsed_data):
    """UI badge for In silico splicing: emedgene | broad | emedgene+broad."""
    if parsed_data.get("spliceai_emg_full_fallback"):
        parsed_data["spliceai_in_silico_source"] = "emedgene"
        return
    if parsed_data.get("spliceai_emg_ds_pending_broad_dp"):
        parsed_data["spliceai_in_silico_source"] = "emedgene+broad"
        return
    if parsed_data.get("spliceai_from_emg") and parsed_data.get("spliceai_fetched"):
        parsed_data["spliceai_in_silico_source"] = "emedgene+broad"
        return
    if parsed_data.get("spliceai_from_emg"):
        parsed_data["spliceai_in_silico_source"] = "emedgene"
        return
    if parsed_data.get("spliceai_fetched"):
        parsed_data["spliceai_in_silico_source"] = "broad"
        return
    parsed_data.pop("spliceai_in_silico_source", None)


def _apply_emg_spliceai_complete(parsed_data, emg_spliceai):
    """Four DS + four Δbp provided — skip Broad SpliceAI."""
    snap = _emg_spliceai_complete_snapshot(emg_spliceai)
    if not snap:
        return False
    for k, val in snap.items():
        parsed_data[f"spliceai_{k}"] = val
    parsed_data["spliceai_fetched"] = True
    parsed_data["spliceai_from_emg"] = True
    parsed_data["spliceai_emg_full_fallback"] = True
    parsed_data.pop("splice_api_error", None)
    parsed_data.pop("spliceai_emg_ds_pending_broad_dp", None)
    parsed_data.pop("spliceai_emg_ds_snapshot", None)
    _refresh_spliceai_in_silico_source(parsed_data)
    print("DEBUG: SpliceAI DS + Δbp from EMG paste (skipping Broad API)", flush=True)
    return True


def _apply_emg_spliceai_ds_only(parsed_data, emg_spliceai):
    """
    Stage EMG delta scores only when Δbp missing from paste.
    Does not set spliceai_fetched (Broad still runs for DP_*).
    """
    snap = _emg_spliceai_ds_snapshot(emg_spliceai)
    if not snap:
        return False
    for k, val in snap.items():
        parsed_data[f"spliceai_{k}"] = val
    parsed_data["spliceai_from_emg"] = True
    parsed_data["spliceai_emg_ds_pending_broad_dp"] = True
    _refresh_spliceai_in_silico_source(parsed_data)
    return True


def _restore_emg_spliceai_ds_over_broad(parsed_data):
    """After Broad ingest: keep Broad DP_* but restore EMG DS_* if staged."""
    snap = parsed_data.pop("spliceai_emg_ds_snapshot", None)
    if not isinstance(snap, dict):
        return
    for k, val in snap.items():
        parsed_data[f"spliceai_{k}"] = val
    parsed_data["spliceai_from_emg"] = True
    parsed_data.pop("spliceai_emg_ds_pending_broad_dp", None)
    _refresh_spliceai_in_silico_source(parsed_data)


def _emg_spliceai_dp_snapshot(emg_spliceai, require_all_four=False):
    """Δbp offsets from EMG paste when Broad API is unavailable or incomplete."""
    if not emg_spliceai or not isinstance(emg_spliceai, dict):
        return None
    upper = {"dp_ag": "DP_AG", "dp_al": "DP_AL", "dp_dg": "DP_DG", "dp_dl": "DP_DL"}
    out = {}
    for k in ("dp_ag", "dp_al", "dp_dg", "dp_dl"):
        raw = emg_spliceai.get(k)
        if raw is None or raw == "":
            raw = emg_spliceai.get(upper[k])
        if raw is None or raw == "":
            continue
        dp = _parse_spliceai_dp(raw)
        if dp is not None:
            out[k] = dp
    if require_all_four:
        return out if len(out) == 4 else None
    return out if len(out) >= 2 else None


def _apply_emg_spliceai_if_broad_unavailable(parsed_data, emg_spliceai):
    """When Broad fails, use provided SpliceAI DS + Δbp."""
    if parsed_data.get("spliceai_fetched"):
        return False
    ds_snap = _emg_spliceai_ds_snapshot(emg_spliceai)
    if not ds_snap:
        return False
    for k, val in ds_snap.items():
        parsed_data[f"spliceai_{k}"] = val
    dp_snap = _emg_spliceai_dp_snapshot(emg_spliceai)
    if dp_snap:
        for k, val in dp_snap.items():
            parsed_data[f"spliceai_{k}"] = val
    parsed_data["spliceai_fetched"] = True
    parsed_data["spliceai_from_emg"] = True
    parsed_data["spliceai_emg_full_fallback"] = True
    parsed_data.pop("splice_api_error", None)
    parsed_data.pop("spliceai_emg_ds_pending_broad_dp", None)
    _refresh_spliceai_in_silico_source(parsed_data)
    print("DEBUG: Broad SpliceAI unavailable — using EMG paste for DS and Δbp", flush=True)
    return True


def _apply_emg_spliceai(parsed_data, emg_spliceai):
    """Legacy name — DS-only staging for workbench EMG paste."""
    return _apply_emg_spliceai_ds_only(parsed_data, emg_spliceai)


def _ingest_spliceai_broad_json(parsed_data, sai_data, gene_symbol=None, target_nm_base=None, enst_id=None):
    """Apply one SpliceAI transcript row to parsed_data; returns True if scores applied."""
    if not sai_data or sai_data.get('error'):
        if sai_data and sai_data.get('error'):
            parsed_data['splice_api_error'] = "N/A (Variant Sequence Exceeds Broad Institute Pre-Computed Tensor Bounds)"
        return False
    if 'scores' not in sai_data:
        return False
    scores_list = sai_data.get('scores') or []
    row = _pick_spliceai_score_row(scores_list, gene_symbol, target_nm_base, enst_id)
    if not row:
        for s in scores_list:
            if isinstance(s, str) and '|' in s:
                parts = str(s).split('|')
                if len(parts) >= 5:
                    row = {
                        'DS_AG': float(parts[1]) if parts[1] else 0.0,
                        'DS_AL': float(parts[2]) if parts[2] else 0.0,
                        'DS_DG': float(parts[3]) if parts[3] else 0.0,
                        'DS_DL': float(parts[4]) if parts[4] else 0.0,
                        'DP_AG': parts[5] if len(parts) > 5 else '',
                        'DP_AL': parts[6] if len(parts) > 6 else '',
                        'DP_DG': parts[7] if len(parts) > 7 else '',
                        'DP_DL': parts[8] if len(parts) > 8 else '',
                    }
                    break
        if not row:
            return False

    def _f(k, d=0.0):
        try:
            v = row.get(k, d)
            return float(v) if v not in (None, '') else d
        except (TypeError, ValueError):
            return d

    def _dp(k):
        v = row.get(k, '')
        return v if v not in (None, '') else ''

    parsed_data['spliceai_ds_ag'] = _f('DS_AG')
    parsed_data['spliceai_ds_al'] = _f('DS_AL')
    parsed_data['spliceai_ds_dg'] = _f('DS_DG')
    parsed_data['spliceai_ds_dl'] = _f('DS_DL')
    parsed_data['spliceai_dp_ag'] = _dp('DP_AG')
    parsed_data['spliceai_dp_al'] = _dp('DP_AL')
    parsed_data['spliceai_dp_dg'] = _dp('DP_DG')
    parsed_data['spliceai_dp_dl'] = _dp('DP_DL')
    parsed_data.pop('splice_api_error', None)
    parsed_data['spliceai_fetched'] = True
    _restore_emg_spliceai_ds_over_broad(parsed_data)
    if not parsed_data.get('spliceai_from_emg'):
        _refresh_spliceai_in_silico_source(parsed_data)
    return True
