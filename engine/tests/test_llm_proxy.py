"""Duck-typed Gemini client used when the worker routes LLM calls through GVI."""
from __future__ import annotations

from engine.service.llm_proxy import GviLlmClient, get_shared_client, set_shared_client


def test_generate_content_returns_text():
    client = GviLlmClient(lambda prompt, model: f"echo:{prompt}:{model or ''}")
    result = client.models.generate_content(model="ignored", contents="AMT profile")
    assert result.text == "echo:AMT profile:ignored"


def test_shared_client_roundtrip():
    set_shared_client(None)
    assert get_shared_client() is None
    client = GviLlmClient(lambda prompt, model: "ok")
    set_shared_client(client)
    assert get_shared_client() is client
    set_shared_client(None)
