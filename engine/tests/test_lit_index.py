"""Local Literature Index search (SQLite FTS + HGMD PMID overlap)."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

from vc_engine import lit_index


def _load_lit_db(root: Path):
    path = root / "literature-index-server" / "db.py"
    side = str(path.parent)
    if side not in sys.path:
        sys.path.insert(0, side)
    spec = importlib.util.spec_from_file_location("test_lit_db", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def tiny_index(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Build a mini Literature Index project + SQLite DB for unit tests."""
    # Prefer real Literature Index search module when present; else skip.
    real_root = Path("/Users/sammartin/Documents/Ploidy/Literature Index")
    if not (real_root / "literature-index-server" / "db.py").is_file():
        pytest.skip("Literature Index project not available")

    root = tmp_path / "Literature Index"
    server = root / "literature-index-server"
    data = root / "data"
    server.mkdir(parents=True)
    data.mkdir(parents=True)

    # Copy db.py + source_label.py into the fake project so lit_index can import them.
    import shutil

    src_server = real_root / "literature-index-server"
    shutil.copy2(src_server / "db.py", server / "db.py")
    shutil.copy2(src_server / "source_label.py", server / "source_label.py")

    lit_db = _load_lit_db(root)
    db_path = data / "literature.db"
    conn = lit_db.connect(db_path)
    lit_db.upsert_paper(conn, "37586838", "KBG imaging cohort.")
    lit_db.upsert_paper(conn, "38958063", "SPARK autism cohort.")
    lit_db.replace_file_variants(
        conn,
        "37586838-sup2.xlsx",
        [
            {
                "pmid": "37586838",
                "gene": "ANKRD11",
                "variant": "ANKRD11 p.(Pro1510Alafs*43) (NM_013275.5 c.4528_4529del)",
                "cdna": "c.4528_4529del",
                "protein": "p.(Pro1510Alafs*43)",
                "transcript": "NM_013275.5",
                "also": "",
                "n": 1,
                "zygosity": "",
                "diagnosis": "KBG syndrome (n=1)",
                "inheritance": "de novo (n=1)",
                "source": "37586838-sup2.xlsx",
                "search": (
                    "ankrd11 p.(pro1510alafs*43) c.4528_4529del nm_013275.5 "
                    "p.pro1510alafs* p.p1510afs*"
                ),
            }
        ],
    )
    lit_db.replace_file_variants(
        conn,
        "38958063.csv",
        [
            {
                "pmid": "38958063",
                "gene": "SCN2A",
                "variant": "SCN2A p.(Ser1758Arg) (NM_021007.2 c.5272A>C)",
                "cdna": "c.5272A>C",
                "protein": "p.(Ser1758Arg)",
                "transcript": "NM_021007.2",
                "also": "",
                "n": 2,
                "zygosity": "heterozygous (n=2)",
                "diagnosis": "ASD (n=2)",
                "inheritance": "de novo (n=1); unknown (n=1)",
                "source": "38958063.csv",
                "search": (
                    "scn2a p.(ser1758arg) c.5272a>c nm_021007.2 p.ser1758arg p.s1758r"
                ),
            }
        ],
    )
    conn.commit()
    conn.close()

    monkeypatch.setenv("VC_LIT_INDEX_ROOT", str(root))
    monkeypatch.setenv("VC_LIT_INDEX_DB", str(db_path))
    with lit_index._lock:
        lit_index._cache.update({"db_path": None, "db_mtime": None, "lit_db": None})
    return root, db_path, lit_db


def test_search_mutation_and_hgmd_overlap(tiny_index):
    out = lit_index.search_lit_index(
        "ANKRD11",
        "c.4528_4529del",
        hgmd_pmids=["37586838", "99999999"],
    )
    assert out["available"] is True
    assert out["hit_count"] == 1
    assert out["pmids"] == ["37586838"]
    assert out["hgmd_overlap_pmids"] == ["37586838"]
    assert "KBG" in (out["papers"][0]["summary"] or "")
    assert "KBG" in out["papers"][0]["variants"][0]["line"]
    assert "found in:" in out["papers"][0]["variants"][0]["line"]
    assert "37586838-sup2.xlsx" in out["papers"][0]["variants"][0]["line"]


def test_search_requires_gene_not_cdot_alone(tiny_index):
    root, db_path, lit_db = tiny_index
    conn = lit_db.connect(db_path)
    lit_db.upsert_paper(conn, "11111111", "decoy")
    lit_db.replace_file_variants(
        conn,
        "decoy.csv",
        [
            {
                "pmid": "11111111",
                "gene": "OTHERGENE",
                "variant": "OTHERGENE (NM_000000.1 c.4528_4529del)",
                "cdna": "c.4528_4529del",
                "protein": "",
                "transcript": "NM_000000.1",
                "also": "",
                "n": 3,
                "zygosity": "",
                "diagnosis": "decoy",
                "inheritance": "",
                "source": "decoy.csv",
                "search": "othergene c.4528_4529del nm_000000.1",
            }
        ],
    )
    conn.commit()
    conn.close()
    with lit_index._lock:
        lit_index._cache.update({"db_path": None, "db_mtime": None, "lit_db": None})

    out = lit_index.search_lit_index("ANKRD11", "c.4528_4529del")
    assert out["hit_count"] == 1
    assert out["pmids"] == ["37586838"]
    assert all(v.get("gene") == "ANKRD11" for p in out["papers"] for v in p["variants"])

    out2 = lit_index.search_lit_index("WRONGGENE", "c.4528_4529del")
    assert out2["hit_count"] == 0
    assert out2["pmids"] == []


def test_format_document_includes_overlap(tiny_index):
    out = lit_index.search_lit_index(
        "ANKRD11", "c.4528_4529del", hgmd_pmids=["37586838"]
    )
    doc = lit_index.format_lit_index_document(out, gene="ANKRD11", c_dot="c.4528_4529del")
    assert "PMID 37586838" in doc
    assert "HGMD" in doc
    assert "KBG" in doc


def test_missing_index_reports_unavailable(tmp_path, monkeypatch):
    monkeypatch.setenv("VC_LIT_INDEX_ROOT", str(tmp_path / "missing"))
    monkeypatch.setenv("VC_LIT_INDEX_DB", str(tmp_path / "missing" / "literature.db"))
    with lit_index._lock:
        lit_index._cache.update({"db_path": None, "db_mtime": None, "lit_db": None})
    out = lit_index.search_lit_index("ANKRD11", "c.4528_4529del")
    assert out["available"] is False
    assert out["hit_count"] == 0
