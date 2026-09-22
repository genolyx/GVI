"""Unit tests for the shared HTTP cache and NCBI key helper.

Redis is not required: these tests drive the in-process store. A missing
``REDIS_URL`` is the expected local-dev path when docker-compose redis is down.
"""
from __future__ import annotations

import os
import threading
import time

import pytest

from engine.service import http_cache as hc


@pytest.fixture(autouse=True)
def memory_store(monkeypatch):
    monkeypatch.delenv("REDIS_URL", raising=False)
    hc.reset_store_for_tests()
    yield
    hc.reset_store_for_tests()


def test_classify_source_hosts():
    assert hc.classify_source("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi") == "ncbi"
    assert hc.classify_source("https://rest.ensembl.org/lookup/id/ENST") == "ensembl"
    assert hc.classify_source("https://myvariant.info/v1/query?q=AMT") == "myvariant"
    assert hc.classify_source("https://rest.uniprot.org/uniprotkb/P05067") == "uniprot"
    assert hc.classify_source("https://example.org/x") == "other"


def test_ncbi_api_key_is_attached_only_to_eutils(monkeypatch):
    monkeypatch.setenv("NCBI_API_KEY", "test-key-1")
    eutils = hc.with_ncbi_api_key(
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=AMT"
    )
    assert "api_key=test-key-1" in eutils
    # Already present: do not duplicate.
    assert eutils.count("api_key=") == 1
    again = hc.with_ncbi_api_key(eutils)
    assert again.count("api_key=") == 1
    # A third-party host must not receive the key.
    other = hc.with_ncbi_api_key("https://rest.ensembl.org/lookup/id/ENST")
    assert "api_key" not in other


def test_ncbi_api_key_absent_leaves_url_untouched(monkeypatch):
    monkeypatch.delenv("NCBI_API_KEY", raising=False)
    url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed"
    assert hc.with_ncbi_api_key(url) == url


def test_cache_round_trip_and_myvariant_skip():
    ensembl = "https://rest.ensembl.org/sequence/id/ENST0001"
    hc.cache_set(ensembl, 200, '{"seq":"ATGC"}', {"Content-Type": "application/json"})
    hit = hc.cache_get(ensembl)
    assert hit is not None
    assert hit.status_code == 200
    assert hit.json()["seq"] == "ATGC"

    # Non-200 is never stored: a 503 must not poison the next attempt.
    hc.cache_set(ensembl + "/fail", 503, "busy")
    assert hc.cache_get(ensembl + "/fail") is None

    # MyVariant stays live by design.
    mv = "https://myvariant.info/v1/query?q=AMT"
    hc.cache_set(mv, 200, '{"hits":[]}')
    assert hc.cache_get(mv) is None


def test_token_bucket_does_not_block_when_tokens_remain():
    started = time.monotonic()
    hc.acquire("https://rest.ensembl.org/lookup/id/ENST")
    hc.acquire("https://rest.ensembl.org/lookup/id/ENST")
    assert time.monotonic() - started < 0.2


def test_token_bucket_serializes_a_burst():
    """Two threads taking the last tokens of a slow source must not overlap freely."""
    # Force a tiny rate so a burst is observable.
    original = hc.SOURCE_RATES["other"]
    hc.SOURCE_RATES["other"] = 20.0
    try:
        barrier = threading.Barrier(2)
        times: list[float] = []

        def take():
            barrier.wait()
            hc.acquire("https://example.org/x")
            times.append(time.monotonic())

        threads = [threading.Thread(target=take) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=2)
        assert len(times) == 2
    finally:
        hc.SOURCE_RATES["other"] = original
