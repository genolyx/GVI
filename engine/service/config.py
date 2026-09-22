"""Worker configuration and ``sys.path`` setup for the vendored engine."""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

#: Directory holding ``app_v11.py`` and ``vc_engine/``.
ENGINE_ROOT = Path(__file__).resolve().parent.parent

#: Sentinel path handed to VC_HGMD_PATH when HGMD is switched off. The engine
#: guards its HGMD mount with ``os.path.exists``, so pointing at a path that
#: cannot exist disables the source without patching engine code.
HGMD_DISABLED_SENTINEL = "/nonexistent/gvi-hgmd-disabled"


def _flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def ensure_engine_importable() -> None:
    """Make ``vc_engine`` and ``app_v11`` importable as top-level modules."""
    root = str(ENGINE_ROOT)
    if root not in sys.path:
        sys.path.insert(0, root)


@dataclass(frozen=True)
class WorkerSettings:
    """Resolved worker configuration."""

    api_url: str
    worker_token: str
    worker_id: str
    engine_version: str
    hgmd_enabled: bool
    gemini_enabled: bool
    run_literature: bool
    poll_interval_seconds: float
    heartbeat_interval_seconds: float
    health_port: int
    data_root: str
    redis_url: str = ""
    ncbi_api_key: str = ""
    consulted_source_overrides: tuple[str, ...] = field(default=())

    @classmethod
    def from_env(cls) -> "WorkerSettings":
        import socket
        import uuid

        hgmd_enabled = _flag("ENGINE_HGMD_ENABLED", True)
        # LLM is opt-out. The worker prefers the GVI proxy (no Gemini key on
        # the worker). A local GEMINI_API_KEY is the standalone fallback.
        gemini_enabled = not _flag("VC_DISABLE_GEMINI", False) and (
            bool(os.environ.get("GEMINI_API_KEY", "").strip())
            or bool(os.environ.get("ENGINE_API_URL", "").strip())
        )

        return cls(
            api_url=os.environ.get("ENGINE_API_URL", "http://localhost:3010").rstrip("/"),
            worker_token=os.environ.get("ENGINE_WORKER_TOKEN", ""),
            worker_id=os.environ.get(
                "ENGINE_WORKER_ID", f"{socket.gethostname()}-{uuid.uuid4().hex[:8]}"
            ),
            engine_version=os.environ.get("ENGINE_VERSION", "v11"),
            hgmd_enabled=hgmd_enabled,
            gemini_enabled=gemini_enabled,
            run_literature=_flag("ENGINE_RUN_LITERATURE", True),
            poll_interval_seconds=float(os.environ.get("ENGINE_POLL_INTERVAL_SECONDS", "5")),
            heartbeat_interval_seconds=float(
                os.environ.get("ENGINE_HEARTBEAT_INTERVAL_SECONDS", "60")
            ),
            health_port=int(os.environ.get("ENGINE_HEALTH_PORT", "8080")),
            data_root=os.path.expanduser(
                os.environ.get("VC_DATA_ROOT", "~/Documents/Ploidy/VariantCurationData")
            ),
            redis_url=os.environ.get("REDIS_URL", "").strip(),
            ncbi_api_key=os.environ.get("NCBI_API_KEY", "").strip(),
        )

    def apply_engine_env(self) -> None:
        """Translate worker settings into the env vars the engine reads at import."""
        os.environ.setdefault("VC_DATA_ROOT", self.data_root)
        if self.redis_url:
            os.environ.setdefault("REDIS_URL", self.redis_url)
        if self.ncbi_api_key:
            os.environ.setdefault("NCBI_API_KEY", self.ncbi_api_key)
        if not self.hgmd_enabled:
            os.environ["VC_HGMD_PATH"] = HGMD_DISABLED_SENTINEL
        if not self.gemini_enabled:
            os.environ["VC_DISABLE_GEMINI"] = "1"
        elif self.api_url and self.worker_token:
            os.environ.setdefault("GVI_LLM_PROXY_URL", f"{self.api_url}/api/engine/v1/llm")
            os.environ.setdefault("ENGINE_WORKER_TOKEN", self.worker_token)
