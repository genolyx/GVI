#!/usr/bin/env python3
"""Build a tabix allele-frequency index from gnomAD sites VCFs.

The sites VCFs stay where they are. This writes one bgzipped TSV per source
file, with one row per allele:

    CHROM  POS  REF  ALT  AF  NHOMALT

Case filtering and the classifier read ``<source>/af-index`` when a
chromosome index exists. A finished ``.tbi`` is left in place, so the script
can be run again to resume.

    python3 scripts/build_gnomad_af_index.py /data/reference/annotation/gnomad4
    python3 scripts/build_gnomad_af_index.py /data/reference/annotation/gnomad4 -j 2 --chrom Y
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path


def expand_query_line(line: str) -> list[str]:
    """Split one bcftools query row into one output row per allele."""
    parts = line.rstrip("\n").split("\t")
    if len(parts) < 6:
        return []
    chrom, pos, ref, alt, af, nhom = parts[:6]
    alts = [item for item in alt.split(",") if item and item != "."]
    afs = af.split(",")
    nhoms = nhom.split(",")
    rows: list[str] = []
    for index, allele in enumerate(alts):
        af_value = afs[index] if index < len(afs) else "."
        nhom_value = nhoms[index] if index < len(nhoms) else "."
        if af_value in ("", "."):
            af_value = "."
        if nhom_value in ("", "."):
            nhom_value = "."
        if af_value == "." and nhom_value == ".":
            continue
        rows.append(f"{chrom}\t{pos}\t{ref}\t{allele}\t{af_value}\t{nhom_value}\n")
    return rows


def _self_test() -> None:
    rows = expand_query_line("chr1\t10\tA\tC,G\t0.1,.\t.,2\n")
    assert rows == [
        "chr1\t10\tA\tC\t0.1\t.\n",
        "chr1\t10\tA\tG\t.\t2\n",
    ], rows
    assert expand_query_line("chr1\t10\tA\tC\t.\t.\n") == []
    print("self-test ok")


def sites_files(source: Path) -> list[Path]:
    found: list[Path] = []
    for path in sorted(source.iterdir()):
        name = path.name
        if not path.is_file():
            continue
        if "gnomad" not in name.lower() or "sites" not in name.lower():
            continue
        if not name.endswith((".vcf.gz", ".vcf.bgz", ".bgz")):
            continue
        if not (Path(str(path) + ".tbi").exists() or Path(str(path) + ".csi").exists()):
            continue
        found.append(path)
    return found


def output_path(source_file: Path, dest_dir: Path) -> Path:
    name = source_file.name
    for suffix in (".vcf.bgz", ".vcf.gz", ".bgz"):
        if name.endswith(suffix):
            name = name[: -len(suffix)]
            break
    return dest_dir / f"{name}.af.tsv.gz"


def build_one(source_file: str, dest_file: str) -> str:
    os.nice(10)
    src = Path(source_file)
    dest = Path(dest_file)
    index = Path(str(dest) + ".tbi")
    if index.exists() and index.stat().st_mtime >= src.stat().st_mtime:
        return f"skip {dest.name}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    partial = dest.with_suffix(dest.suffix + ".partial")
    if partial.exists():
        partial.unlink()
    started = time.time()
    query = subprocess.Popen(
        [
            "bcftools",
            "query",
            "-f",
            "%CHROM\t%POS\t%REF\t%ALT\t%INFO/AF\t%INFO/nhomalt\n",
            str(src),
        ],
        stdout=subprocess.PIPE,
    )
    compressed = subprocess.Popen(
        ["bgzip", "-c"],
        stdin=subprocess.PIPE,
        stdout=open(partial, "wb"),
    )
    assert query.stdout is not None and compressed.stdin is not None
    written = 0
    try:
        compressed.stdin.write(b"#CHROM\tPOS\tREF\tALT\tAF\tNHOMALT\n")
        for raw in query.stdout:
            for row in expand_query_line(raw.decode("utf-8")):
                compressed.stdin.write(row.encode("utf-8"))
                written += 1
        compressed.stdin.close()
        query_code = query.wait()
        zip_code = compressed.wait()
        if query_code != 0 or zip_code != 0:
            raise RuntimeError(f"bcftools={query_code} bgzip={zip_code}")
        os.replace(partial, dest)
        subprocess.run(
            ["tabix", "-f", "-s", "1", "-b", "2", "-e", "2", "-c", "#", str(dest)],
            check=True,
        )
    except Exception:
        compressed.kill()
        query.kill()
        partial.unlink(missing_ok=True)
        dest.unlink(missing_ok=True)
        Path(str(dest) + ".tbi").unlink(missing_ok=True)
        raise
    elapsed = time.time() - started
    return f"wrote {dest.name} alleles={written} seconds={elapsed:.0f}"


def main() -> int:
    if "--self-test" in sys.argv:
        _self_test()
        return 0
    parser = argparse.ArgumentParser(description="Build a gnomAD AF tabix index")
    parser.add_argument("source", type=Path, help="Directory of gnomAD sites VCFs")
    parser.add_argument("-j", type=int, default=2, help="Chromosome files to convert at once")
    parser.add_argument("--chrom", action="append", default=[], help="Limit to these chromosomes, e.g. Y")
    args = parser.parse_args()
    source = args.source.expanduser().resolve()
    if not source.is_dir():
        print(f"Not a directory: {source}", file=sys.stderr)
        return 1
    wanted = {item.lower().removeprefix("chr") for item in args.chrom}
    files = sites_files(source)
    if wanted:
        files = [
            path
            for path in files
            if any(token in path.name.lower() for token in (f"chr{item}." for item in wanted))
            or any(path.name.lower().endswith(f"chr{item}.vcf.bgz") for item in wanted)
        ]
    if not files:
        print(f"No indexed gnomAD sites VCFs in {source}", file=sys.stderr)
        return 1
    dest_dir = source / "af-index"
    jobs = [(str(path), str(output_path(path, dest_dir))) for path in files]
    print(f"source {source}", flush=True)
    print(f"dest {dest_dir}", flush=True)
    print(f"files {len(jobs)} jobs {args.j}", flush=True)
    workers = max(1, args.j)
    failed = 0
    if workers == 1:
        for src, dest in jobs:
            try:
                print(build_one(src, dest), flush=True)
            except Exception as exc:
                failed += 1
                print(f"failed {Path(src).name}: {exc}", file=sys.stderr, flush=True)
    else:
        with ProcessPoolExecutor(max_workers=workers) as pool:
            pending = {pool.submit(build_one, src, dest): src for src, dest in jobs}
            for future in as_completed(pending):
                src = pending[future]
                try:
                    print(future.result(), flush=True)
                except Exception as exc:
                    failed += 1
                    print(f"failed {Path(src).name}: {exc}", file=sys.stderr, flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
