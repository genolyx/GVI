"""Local gnomAD sites-VCF allele frequency.

When ``VC_GNOMAD_DIR`` (a directory of per-chromosome files) or
``VC_GNOMAD_PATH`` (one indexed VCF) is set, frequency comes from those
files. MyVariant ``gnomad_exomes`` / ``gnomad_genomes`` fields are not used.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Optional

_AF_KEYS = ("AF", "AF_total", "AF_joint", "AF_popmax", "AF_POPMAX")
_DEFAULT_GENOMES_GLOB = "gnomad.genomes.v*.sites*.bgz"
_DEFAULT_EXOMES_GLOB = "gnomad.exomes.v*.sites*.bgz"
_CHR_IN_NAME = re.compile(r"(?:^|[._])chr([0-9]+|[xyxm])(?:[._]|$)", re.I)
_RELEASE_IN_NAME = re.compile(r"\.v(\d+(?:\.\d+)*)", re.I)

_annotator: Optional["LocalGnomad"] = None
_annotator_key: Optional[tuple] = None
_env_loaded = False


def _load_repo_env() -> None:
    """Pick up VC_GNOMAD_* from the repo env files when the process did not export them."""
    global _env_loaded
    if _env_loaded:
        return
    _env_loaded = True
    if (os.environ.get("VC_GNOMAD_DIR") or "").strip() or (os.environ.get("VC_GNOMAD_PATH") or "").strip():
        return
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    root = Path(__file__).resolve().parents[2]
    load_dotenv(root / ".env", override=False)
    load_dotenv(root / ".env.local", override=False)


def configured_dir() -> str:
    _load_repo_env()
    raw = (os.environ.get("VC_GNOMAD_DIR") or "").strip()
    return os.path.expanduser(raw) if raw else ""


def configured_path() -> str:
    _load_repo_env()
    raw = (os.environ.get("VC_GNOMAD_PATH") or "").strip()
    return os.path.expanduser(raw) if raw else ""


def gnomad_mode() -> str:
    """``local`` reads the configured sites VCF. ``myvariant`` leaves that file unused.

    The choice is ``{VC_DATA_ROOT}/gnomad-source``. A missing file keeps the
    local VCF when a path is configured.
    """
    from vc_engine.source_mode import read_choice

    return read_choice(
        "gnomad",
        ("local", "myvariant"),
        "local" if (configured_dir() or configured_path()) else "myvariant",
    )


def local_gnomad_configured() -> bool:
    return gnomad_mode() == "local" and bool(configured_dir() or configured_path())


def release_from_names(names: list[str]) -> Optional[str]:
    for name in names:
        match = _RELEASE_IN_NAME.search(name)
        if match:
            return f"v{match.group(1)}"
    return None


def pick_file_for_chrom(paths: list[str], chrom: str) -> Optional[str]:
    """Choose the sites file for one chromosome.

    ``chr1`` must not match ``chr10``. A single indexed file is treated as a
    whole-genome sites VCF.
    """
    token = str(chrom or "").strip().lower()
    if token.startswith("chr"):
        token = token[3:]
    if not token:
        return None
    matches = []
    for path in paths:
        found = _CHR_IN_NAME.search(Path(path).name)
        if found and found.group(1).lower() == token:
            matches.append(path)
    if matches:
        return sorted(matches)[0]
    if len(paths) == 1:
        return paths[0]
    return None


def first_numeric(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        value = value[0] if value else None
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def af_for_alt(value: Any, alts: Any, alt: str) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        alt_list = list(alts or [])
        try:
            index = alt_list.index(alt)
        except ValueError:
            return None
        if index >= len(value):
            return None
        return first_numeric(value[index])
    return first_numeric(value)


def _has_index(path: str) -> bool:
    return os.path.exists(path + ".tbi") or os.path.exists(path + ".csi")


class LocalGnomad:
    def __init__(self, directory: str = "", single_path: str = "", genomes_glob: str = "", exomes_glob: str = ""):
        self.directory = directory
        self.single_path = single_path
        self.genomes_glob = genomes_glob or os.environ.get("VC_GNOMAD_GENOMES_GLOB") or _DEFAULT_GENOMES_GLOB
        self.exomes_glob = exomes_glob or os.environ.get("VC_GNOMAD_EXOMES_GLOB") or _DEFAULT_EXOMES_GLOB
        self._handles: dict[str, Any] = {}
        self._chr_prefix: dict[str, bool] = {}

    def indexed_files(self, dataset: str) -> list[str]:
        if self.single_path:
            return [self.single_path] if _has_index(self.single_path) else []
        if not self.directory or not os.path.isdir(self.directory):
            return []
        pattern = self.exomes_glob if dataset == "exomes" else self.genomes_glob
        found = [str(path) for path in Path(self.directory).glob(pattern) if _has_index(str(path))]
        return sorted(found)

    def lookup(self, chrom: str, pos: int, ref: str, alt: str) -> dict[str, Any]:
        exomes_files = self.indexed_files("exomes")
        genomes_files = self.indexed_files("genomes")
        queried = bool(exomes_files or genomes_files)
        return {
            "queried": queried,
            "exomes": self._lookup_one(exomes_files, chrom, pos, ref, alt) if exomes_files else None,
            "genomes": self._lookup_one(genomes_files, chrom, pos, ref, alt) if genomes_files else None,
        }

    def _lookup_one(self, files: list[str], chrom: str, pos: int, ref: str, alt: str) -> Optional[float]:
        path = pick_file_for_chrom(files, chrom)
        if not path:
            return None
        try:
            handle = self._open(path)
            query_chrom = self._contig(path, chrom)
            for record in handle.fetch(query_chrom, pos - 1, pos):
                if record.pos != pos:
                    continue
                record_ref = str(record.ref or "").upper()
                if record_ref != ref:
                    continue
                alts = [str(item).upper() for item in (record.alts or [])]
                if alt not in alts:
                    continue
                for key in _AF_KEYS:
                    if key not in record.info:
                        continue
                    af = af_for_alt(record.info[key], alts, alt)
                    if af is not None:
                        return af
        except Exception as exc:
            print(f"[gnomad-local] lookup failed {chrom}:{pos} {ref}>{alt}: {exc}")
        return None

    def _open(self, path: str):
        handle = self._handles.get(path)
        if handle is None:
            import pysam
            handle = pysam.VariantFile(path)
            self._handles[path] = handle
            contigs = list(handle.header.contigs)
            self._chr_prefix[path] = any(str(contig).startswith("chr") for contig in contigs)
        return handle

    def _contig(self, path: str, chrom: str) -> str:
        token = str(chrom).strip()
        bare = token[3:] if token.lower().startswith("chr") else token
        if self._chr_prefix.get(path, True):
            return token if token.lower().startswith("chr") else f"chr{bare}"
        return bare


def _annotator_for_env() -> LocalGnomad:
    global _annotator, _annotator_key
    key = (
        configured_dir(),
        configured_path(),
        os.environ.get("VC_GNOMAD_GENOMES_GLOB") or _DEFAULT_GENOMES_GLOB,
        os.environ.get("VC_GNOMAD_EXOMES_GLOB") or _DEFAULT_EXOMES_GLOB,
    )
    if _annotator is None or _annotator_key != key:
        _annotator = LocalGnomad(directory=key[0], single_path=key[1], genomes_glob=key[2], exomes_glob=key[3])
        _annotator_key = key
        where = key[1] or key[0]
        print(f"[gnomad-local] using {where}")
    return _annotator


def apply_local_gnomad(parsed_data: dict, lookup=None) -> bool:
    """Fill gnomad_af from the configured files. Returns False when no path is set."""
    if not local_gnomad_configured():
        return False
    if parsed_data.get("_gnomad_local_applied"):
        return True
    parsed_data["_gnomad_local_applied"] = True

    chrom = parsed_data.get("grch38_chrom") or parsed_data.get("chrom")
    pos = parsed_data.get("grch38_start") or parsed_data.get("pos")
    ref = str(parsed_data.get("ref") or "").upper()
    alt = str(parsed_data.get("alt") or "").upper()
    try:
        pos_i = int(pos)
    except (TypeError, ValueError):
        pos_i = 0
    if not chrom or pos_i <= 0 or not ref or not alt:
        parsed_data["gnomad_af_source"] = "local_unmapped"
        return True

    found = (lookup or _annotator_for_env().lookup)(str(chrom), pos_i, ref, alt)
    if not found.get("queried"):
        parsed_data["gnomad_af_source"] = "local_missing"
        return True

    exomes = found.get("exomes")
    genomes = found.get("genomes")
    # Same preference as the MyVariant path: exomes, then genomes when exomes are missing or zero.
    if exomes not in (None, 0, 0.0):
        parsed_data["gnomad_af"] = exomes
        parsed_data["gnomad_af_source"] = "exomes-file"
    elif genomes is not None:
        parsed_data["gnomad_af"] = genomes
        parsed_data["gnomad_af_source"] = "genomes-file"
    elif exomes is not None:
        parsed_data["gnomad_af"] = exomes
        parsed_data["gnomad_af_source"] = "exomes-file"
    else:
        parsed_data["gnomad_af"] = 0
        parsed_data["gnomad_af_source"] = "absent"
    parsed_data["gnomad_checked"] = True
    return True
