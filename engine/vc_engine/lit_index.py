"""Local Literature Index lookup (supplement tables → mutation → PMID + summary).

Uses the SQLite FTS index built by the sibling ``Literature Index`` app:

  - DB (default): ``/Volumes/SD Storage/literature/literature.db``
  - Search code: ``Literature Index/literature-index-server/db.py`` (or ``ingest/db.py``)

Legacy ``data/index.json`` is no longer the live source.

Env:
  - ``VC_LIT_INDEX_DB`` — absolute path to ``literature.db``
  - ``VC_LIT_INDEX_ROOT`` — Literature Index project root (for db.py + fallbacks)
"""

from __future__ import annotations

import importlib.util
import os
import re
import sqlite3
import sys
import threading
from pathlib import Path
from typing import Any, Optional

from vc_engine.hgvs import _normalize_dna_hgvs_prefix

_lock = threading.Lock()
_cache: dict[str, Any] = {
    "db_path": None,
    "db_mtime": None,
    "lit_db": None,  # imported Literature Index db module
}


def default_lit_index_root() -> str:
    env = (os.environ.get("VC_LIT_INDEX_ROOT") or "").strip()
    if env:
        return os.path.abspath(os.path.expanduser(env))
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    sibling = os.path.join(os.path.dirname(here), "Literature Index")
    if os.path.isdir(sibling):
        return sibling
    return ""


def default_lit_db_path(root: Optional[str] = None) -> str:
    """Resolve the live SQLite index path."""
    env_db = (os.environ.get("VC_LIT_INDEX_DB") or "").strip()
    if env_db:
        return os.path.abspath(os.path.expanduser(env_db))

    root = root if root is not None else default_lit_index_root()
    candidates: list[str] = []
    if root:
        candidates.extend(
            [
                os.path.join(root, "data", "literature.db"),
                os.path.join(root, "literature-index-server", "data", "literature.db"),
            ]
        )
    candidates.append("/Volumes/SD Storage/literature/literature.db")
    for path in candidates:
        if path and os.path.isfile(path):
            return path
    # Prefer the SD-card convention even if missing (clearer unavailable message).
    return candidates[-1] if candidates else ""


def lit_index_available(root: Optional[str] = None) -> bool:
    db = default_lit_db_path(root)
    return bool(db and os.path.isfile(db))


def _import_lit_db_module(root: Optional[str] = None):
    """Load Literature Index ``db.py`` so FTS search stays in sync with that app."""
    root = root if root is not None else default_lit_index_root()
    if not root:
        return None
    for rel in ("literature-index-server/db.py", "ingest/db.py"):
        path = os.path.join(root, rel)
        if not os.path.isfile(path):
            continue
        try:
            # source_label.py lives beside db.py
            side = os.path.dirname(path)
            if side not in sys.path:
                sys.path.insert(0, side)
            spec = importlib.util.spec_from_file_location("vc_lit_index_db", path)
            if not spec or not spec.loader:
                continue
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            if hasattr(mod, "search") and hasattr(mod, "connect"):
                return mod
        except Exception as exc:
            print(f"[lit_index] failed to import {path}: {exc}", flush=True)
    return None


def _ensure_lit_db(root: Optional[str] = None):
    root = root if root is not None else default_lit_index_root()
    db_path = default_lit_db_path(root)
    if not db_path or not os.path.isfile(db_path):
        return None, "", None
    try:
        mtime = os.path.getmtime(db_path)
    except OSError:
        return None, db_path, None

    with _lock:
        if (
            _cache["lit_db"] is not None
            and _cache["db_path"] == db_path
            and _cache["db_mtime"] == mtime
        ):
            return _cache["lit_db"], db_path, mtime

        lit_db = _import_lit_db_module(root)
        if lit_db is None:
            print(
                "[lit_index] Literature Index db.py not found — "
                f"set VC_LIT_INDEX_ROOT (tried {root!r})",
                flush=True,
            )
            return None, db_path, mtime

        _cache["lit_db"] = lit_db
        _cache["db_path"] = db_path
        _cache["db_mtime"] = mtime
        print(f"[lit_index] using SQLite {db_path}", flush=True)
        return lit_db, db_path, mtime


def _normalize_c_dot(c_dot: str) -> str:
    """Preserve c./n./r.; invent c. only for bare coding-style tails."""
    return _normalize_dna_hgvs_prefix(c_dot)


def _query_variants(gene: str, c_dot: str, hgvs_p: str = "") -> list[str]:
    """Build progressive query strings (most specific first).

    Always gene-scoped — never bare ``c.`` / ``p.`` alone.
    """
    g = (gene or "").strip()
    c = _normalize_c_dot(c_dot)
    p = (hgvs_p or "").strip()
    queries: list[str] = []
    if g and c:
        queries.append(f"{g} {c}")
    if g and p:
        queries.append(f"{g} {p}")
    seen: set[str] = set()
    out: list[str] = []
    for q in queries:
        key = q.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(q)
    return out


def _clean_field(value: Any, missing: str = "not reported") -> str:
    s = str(value or "").strip()
    if not s:
        return missing
    if ";" not in s:
        return re.sub(r" \(n=\d+\)", "", s)
    return s


def _variant_line(rec: dict[str, Any]) -> str:
    mut = str(rec.get("variant") or "").strip() or "(variant)"
    also = str(rec.get("also") or "").strip()
    if also:
        mut = f"{mut} (also {also} on other transcripts)"
    n = rec.get("n")
    if n is None:
        n = rec.get("n_patients")
    if not n:
        patients = "patient count not reported"
    else:
        try:
            ni = int(n)
            patients = "1 patient" if ni == 1 else f"{ni} patients"
        except (TypeError, ValueError):
            patients = f"{n} patients"
    source = str(rec.get("source") or "").strip() or "supplement not named"
    parts = [
        f"PMID {rec.get('pmid')}",
        mut,
        patients,
        f"zygosity: {_clean_field(rec.get('zygosity'))}",
        f"diagnosis: {_clean_field(rec.get('diagnosis'))}",
        f"inheritance: {_clean_field(rec.get('inheritance'))}",
        f"found in: {source}",
    ]
    return " — ".join(parts)


def _filter_gene(hits: list[dict[str, Any]], gene: str) -> list[dict[str, Any]]:
    gene_need = (gene or "").strip().lower()
    if not gene_need:
        return hits
    out = []
    for rec in hits:
        rec_gene = str(rec.get("gene") or "").strip().lower()
        if rec_gene == gene_need:
            out.append(rec)
    return out


def _search_sqlite(
    lit_db,
    db_path: str,
    query: str,
    *,
    gene: str = "",
    limit: int = 400,
) -> list[dict[str, Any]]:
    # Read-only: curation search must not create WAL sidecars on the SD-card DB.
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        hits = lit_db.search(conn, query, limit=limit) or []
    finally:
        conn.close()
    return _filter_gene(hits, gene)


def _hgmd_pmid_fallback(
    lit_db,
    db_path: str,
    *,
    gene: str,
    c_dot: str,
    hgmd_set: set[str],
    limit: int = 80,
) -> list[dict[str, Any]]:
    """Pull indexed rows for HGMD PMIDs that also match gene + c."""
    if not hgmd_set:
        return []
    gene_u = (gene or "").strip()
    c_norm = _normalize_c_dot(c_dot).lower()
    if not gene_u or not c_norm:
        return []
    pmids = sorted(hgmd_set)
    marks = ",".join("?" * len(pmids))
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            f"""
            SELECT v.pmid, v.gene, v.variant, v.cdna, v.protein, v.transcript, v.also,
                   v.n_patients AS n, v.zygosity, v.diagnosis, v.inheritance, v.source,
                   v.search, COALESCE(p.summary, '') AS summary,
                   COALESCE(p.abstract, '') AS abstract
            FROM variants v
            LEFT JOIN papers p ON p.pmid = v.pmid
            WHERE v.pmid IN ({marks})
              AND lower(v.gene) = lower(?)
              AND instr(lower(v.search), ?) > 0
            LIMIT ?
            """,
            (*pmids, gene_u, c_norm, limit),
        ).fetchall()
        out = []
        for row in rows:
            item = dict(row)
            item.pop("search", None)
            src = item.get("source") or ""
            try:
                from source_label import human_source  # type: ignore

                item["source"] = human_source(src)
            except Exception:
                item["source"] = src
            out.append(item)
        return out
    except sqlite3.Error as exc:
        print(f"[lit_index] HGMD PMID fallback failed: {exc}", flush=True)
        return []
    finally:
        conn.close()


def search_lit_index(
    gene: str,
    c_dot: str,
    *,
    hgvs_p: str = "",
    hgmd_pmids: Optional[list[str] | str] = None,
    root: Optional[str] = None,
    max_hits: int = 40,
    max_per_paper: int = 12,
) -> dict[str, Any]:
    """Search the local SQLite index for a mutation; flag overlap with HGMD PMIDs."""
    root = root if root is not None else default_lit_index_root()
    empty = {
        "available": False,
        "root": root or "",
        "db_path": default_lit_db_path(root),
        "query": "",
        "hit_count": 0,
        "papers": [],
        "pmids": [],
        "hgmd_overlap_pmids": [],
        "message": "Literature Index not configured or literature.db missing.",
    }
    if not lit_index_available(root):
        return empty

    lit_db, db_path, _mtime = _ensure_lit_db(root)
    if lit_db is None:
        empty["message"] = (
            "Literature Index database found but search module (db.py) could not be loaded. "
            "Set VC_LIT_INDEX_ROOT to the Literature Index project."
        )
        empty["db_path"] = db_path
        empty["root"] = root
        return empty

    hgmd_set: set[str] = set()
    if isinstance(hgmd_pmids, list):
        hgmd_set = {str(p).strip() for p in hgmd_pmids if str(p).strip().isdigit()}
    elif isinstance(hgmd_pmids, str) and hgmd_pmids.strip():
        hgmd_set = set(re.findall(r"\d{5,}", hgmd_pmids))

    queries = _query_variants(gene, c_dot, hgvs_p)
    hits: list[dict[str, Any]] = []
    used_query = ""
    for q in queries:
        cand = _search_sqlite(lit_db, db_path, q, gene=gene, limit=max(400, max_hits * 3))
        if cand:
            hits = cand
            used_query = q
            break

    if not hits and hgmd_set:
        hits = _hgmd_pmid_fallback(
            lit_db, db_path, gene=gene, c_dot=c_dot, hgmd_set=hgmd_set
        )
        if hits:
            used_query = f"HGMD PMID ∩ {gene} {_normalize_c_dot(c_dot)}".strip()

    hit_count = len(hits)
    hits = hits[: max(1, int(max_hits))]

    order: list[str] = []
    groups: dict[str, list[dict[str, Any]]] = {}
    for rec in hits:
        pmid = str(rec.get("pmid") or "").strip()
        if not pmid:
            continue
        if pmid not in groups:
            groups[pmid] = []
            order.append(pmid)
        groups[pmid].append(rec)

    paper_payload: list[dict[str, Any]] = []
    overlap: list[str] = []
    for pmid in order:
        rows = groups[pmid]
        extra = max(0, len(rows) - max_per_paper)
        rows = rows[:max_per_paper]
        is_hgmd = pmid in hgmd_set
        if is_hgmd:
            overlap.append(pmid)
        summary = ""
        abstract = ""
        for r in rows:
            if not summary:
                summary = str(r.get("summary") or "").strip()
            if not abstract:
                abstract = str(r.get("abstract") or "").strip()
            if summary and abstract:
                break
        paper_payload.append(
            {
                "pmid": pmid,
                "summary": summary,
                "abstract": abstract,
                "hgmd_overlap": is_hgmd,
                "pubmed_url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
                "variant_count": len(groups[pmid]),
                "extra": extra,
                "variants": [
                    {
                        "variant": r.get("variant") or "",
                        "gene": r.get("gene") or "",
                        "n": r.get("n"),
                        "zygosity": r.get("zygosity") or "",
                        "diagnosis": r.get("diagnosis") or "",
                        "inheritance": r.get("inheritance") or "",
                        "also": r.get("also") or "",
                        "source": r.get("source") or "",
                        "line": _variant_line(r),
                    }
                    for r in rows
                ],
            }
        )

    return {
        "available": True,
        "root": root,
        "db_path": db_path,
        "query": used_query,
        "hit_count": hit_count,
        "papers": paper_payload,
        "pmids": order,
        "hgmd_overlap_pmids": overlap,
        "message": (
            f"{hit_count} match(es) in {len(order)} paper(s)"
            if hit_count
            else "No matches in the indexed supplements."
        ),
    }


def format_lit_index_document(payload: dict[str, Any], *, gene: str = "", c_dot: str = "") -> str:
    """Plain-text block for PDF folder / Gemini context."""
    if not payload or not payload.get("papers"):
        return ""
    lines = [
        "=== Local Literature Index (supplement tables) ===",
        f"Query: {payload.get('query') or (gene + ' ' + c_dot).strip()}",
        f"Matches: {payload.get('hit_count', 0)}",
    ]
    if payload.get("db_path"):
        lines.append(f"Index: {payload['db_path']}")
    overlap = payload.get("hgmd_overlap_pmids") or []
    if overlap:
        lines.append("HGMD PMID overlap: " + ", ".join(str(p) for p in overlap))
    lines.append("")
    for paper in payload.get("papers") or []:
        pmid = paper.get("pmid")
        blurb = paper.get("summary") or ""
        abstract = paper.get("abstract") or ""
        tag = " [also in HGMD for this variant]" if paper.get("hgmd_overlap") else ""
        lines.append(f"PMID {pmid}{tag}")
        if blurb:
            lines.append(f"  Paper: {blurb}")
        if abstract:
            lines.append(f"  Abstract: {abstract}")
        for v in paper.get("variants") or []:
            lines.append(f"  - {v.get('line') or v.get('variant')}")
        if paper.get("extra"):
            lines.append(f"  … {paper['extra']} more in this paper")
        lines.append("")
    return "\n".join(lines).strip() + "\n"
