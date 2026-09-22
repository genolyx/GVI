"""Duck-typed Gemini client that forwards prompts to the GVI control plane.

The vendored engine calls ``client.models.generate_content(model=..., contents=...)``
and reads ``.text`` on the result. Installing this client on the loaded engine
module (and setting ``GVI_LLM_PROXY_URL`` for literature routes) keeps every
LLM call on the Node side, where the API key, audit trail and classification
guardrail already live.
"""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Callable, Optional

CompleteFn = Callable[[str, Optional[str]], str]

_shared_client: Optional["GviLlmClient"] = None


def set_shared_client(client: Optional["GviLlmClient"]) -> None:
    global _shared_client
    _shared_client = client


def get_shared_client() -> Optional["GviLlmClient"]:
    return _shared_client


class _Models:
    def __init__(self, complete: CompleteFn) -> None:
        self._complete = complete

    def generate_content(self, model: str = "", contents: str = "", config: Any = None, **_: Any):
        del config
        text = self._complete(contents, model or None)
        return SimpleNamespace(text=text)


class GviLlmClient:
    """Stand-in for ``google.genai.Client`` used by ``app_v11`` / ``analyze``."""

    def __init__(self, complete: CompleteFn) -> None:
        self.models = _Models(complete)
