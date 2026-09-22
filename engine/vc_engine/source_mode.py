"""Settings choices for reference sources.

Each choice is one line in ``{VC_DATA_ROOT}/{stem}-source``. The curation
engine reads it on every lookup, so a Settings change applies to the next
analysis without a restart.
"""
from __future__ import annotations

import os
from pathlib import Path

_env_loaded = False


def _load_repo_env() -> None:
    global _env_loaded
    if _env_loaded:
        return
    _env_loaded = True
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    root = Path(__file__).resolve().parents[2]
    load_dotenv(root / ".env", override=False)
    load_dotenv(root / ".env.local", override=False)


def data_root() -> str:
    root = os.path.expanduser((os.environ.get("VC_DATA_ROOT") or "").strip())
    if not root:
        _load_repo_env()
        root = os.path.expanduser((os.environ.get("VC_DATA_ROOT") or "").strip())
    return root or str(Path.home() / "gvi-data")


def read_choice(stem: str, allowed: tuple[str, ...], default: str) -> str:
    try:
        value = Path(data_root(), f"{stem}-source").read_text(encoding="utf-8").strip().lower()
    except OSError:
        value = ""
    if value in allowed:
        return value
    return default


def clinvar_local_configured() -> bool:
    explicit = os.path.expanduser((os.environ.get("VC_CLINVAR_PATH") or "").strip())
    if explicit:
        return os.path.isfile(explicit)
    return os.path.isfile(os.path.join(data_root(), "reference", "clinvar", "clinvar.vcf.gz"))


def clinvar_mode() -> str:
    """``local`` reads the ClinVar VCF. ``ncbi`` uses NCBI and MyVariant instead."""
    return read_choice(
        "clinvar",
        ("local", "ncbi"),
        "local" if clinvar_local_configured() else "ncbi",
    )


def clinvar_file_active() -> bool:
    return clinvar_mode() == "local"


def clinvar_remote_active() -> bool:
    return clinvar_mode() == "ncbi"
