"""Shared HTTP cache and per-source rate limits for engine outbound calls.

The engine used to keep a process-local ``dict`` of ``requests.Response`` objects.
That cache vanished on every worker restart and was not shared across replicas, so
the second worker to curate the same Ensembl transcript paid the full cold-start
cost again. Redis is the shared store: cache loss is harmless (the source is
re-fetched) and the token bucket is what keeps NCBI from 429-ing a burst of
workers.

Redis is optional. When ``REDIS_URL`` is unset or unreachable the same APIs fall
back to an in-process store so a missing cache never fails a run.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from dataclasses import dataclass
from typing import Any, Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# ── Source classification ───────────────────────────────────────────────────────

#: Tokens replenished per second. NCBI's published cap is ~3/s without a key and
#: ~10/s with one; the others are conservative so a multi-worker burst cannot
#: trip a source we do not have a published quota for.
_NCBI_HAS_KEY = bool(os.environ.get("NCBI_API_KEY", "").strip())

SOURCE_RATES: dict[str, float] = {
    "ncbi": 10.0 if _NCBI_HAS_KEY else 3.0,
    "ensembl": 15.0,
    "myvariant": 8.0,
    "spliceai": 4.0,
    "pangolin": 4.0,
    "uniprot": 5.0,
    "metadome": 2.0,
    "ucsc": 5.0,
    "other": 8.0,
}

#: Seconds a successful GET is reusable. MyVariant allele lists stay uncached
#: because the original session already treated them as live.
SOURCE_TTL: dict[str, int] = {
    "ncbi": 24 * 3600,
    "ensembl": 7 * 24 * 3600,
    "myvariant": 0,
    "spliceai": 7 * 24 * 3600,
    "pangolin": 7 * 24 * 3600,
    "uniprot": 7 * 24 * 3600,
    "metadome": 24 * 3600,
    "ucsc": 7 * 24 * 3600,
    "other": 3600,
}

_BUCKET_CAPACITY = 20.0
_CACHE_PREFIX = "gvi:http:"
_BUCKET_PREFIX = "gvi:rl:"


def classify_source(url: str) -> str:
    host = (urlsplit(url).hostname or "").lower()
    if "eutils.ncbi.nlm.nih.gov" in host or host.endswith("ncbi.nlm.nih.gov"):
        return "ncbi"
    if "rest.ensembl.org" in host:
        return "ensembl"
    if "myvariant.info" in host:
        return "myvariant"
    if "spliceailookup-api.broadinstitute.org" in host or "spliceai" in host:
        return "spliceai"
    if "pangolin" in host:
        return "pangolin"
    if "uniprot.org" in host:
        return "uniprot"
    if "metadome" in host:
        return "metadome"
    if "genome.ucsc.edu" in host or "api.genome.ucsc.edu" in host:
        return "ucsc"
    return "other"


def with_ncbi_api_key(url: str, api_key: Optional[str] = None) -> str:
    """Attach ``api_key`` to an NCBI eutils URL when one is configured.

    NCBI ignores unknown parameters on other hosts, but we still only rewrite
    eutils URLs so a leaked key cannot travel to a third party.
    """
    key = (api_key if api_key is not None else os.environ.get("NCBI_API_KEY", "")).strip()
    if not key:
        return url
    parts = urlsplit(url)
    if "eutils.ncbi.nlm.nih.gov" not in (parts.hostname or "").lower():
        return url
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    if query.get("api_key") == key:
        return url
    query["api_key"] = key
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


@dataclass
class CachedResponse:
    """A reconstructable GET result. ``requests.Response`` itself is not picklable."""

    status_code: int
    text: str
    headers: dict[str, str]

    def json(self) -> Any:
        if not self.text:
            return {}
        return json.loads(self.text)


class _MemoryStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._items: dict[str, tuple[float, str]] = {}
        self._buckets: dict[str, tuple[float, float]] = {}

    def get(self, key: str) -> Optional[str]:
        with self._lock:
            hit = self._items.get(key)
            if hit is None:
                return None
            expires, value = hit
            if expires < time.time():
                self._items.pop(key, None)
                return None
            return value

    def set(self, key: str, value: str, ttl: int) -> None:
        with self._lock:
            self._items[key] = (time.time() + ttl, value)

    def take_token(self, source: str, rate: float) -> None:
        """Block until one token is available. Capacity is ``_BUCKET_CAPACITY``."""
        while True:
            wait = 0.0
            with self._lock:
                now = time.monotonic()
                tokens, last = self._buckets.get(source, (_BUCKET_CAPACITY, now))
                tokens = min(_BUCKET_CAPACITY, tokens + (now - last) * rate)
                if tokens >= 1.0:
                    self._buckets[source] = (tokens - 1.0, now)
                    return
                self._buckets[source] = (tokens, now)
                wait = (1.0 - tokens) / rate if rate > 0 else 0.05
            time.sleep(min(max(wait, 0.01), 0.5))


class _RedisStore:
    def __init__(self, client: Any) -> None:
        self._client = client

    def get(self, key: str) -> Optional[str]:
        raw = self._client.get(key)
        if raw is None:
            return None
        return raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else str(raw)

    def set(self, key: str, value: str, ttl: int) -> None:
        self._client.set(key, value, ex=ttl)

    def take_token(self, source: str, rate: float) -> None:
        key = f"{_BUCKET_PREFIX}{source}"
        # Atomic refill + consume. The script returns the seconds to wait when
        # the bucket is empty, or 0 when a token was taken.
        script = """
        local key = KEYS[1]
        local rate = tonumber(ARGV[1])
        local capacity = tonumber(ARGV[2])
        local now = tonumber(ARGV[3])
        local data = redis.call('HMGET', key, 'tokens', 'ts')
        local tokens = tonumber(data[1])
        local ts = tonumber(data[2])
        if tokens == nil then
            tokens = capacity
            ts = now
        end
        tokens = math.min(capacity, tokens + (now - ts) * rate)
        if tokens >= 1.0 then
            tokens = tokens - 1.0
            redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
            redis.call('EXPIRE', key, 60)
            return 0
        end
        redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
        redis.call('EXPIRE', key, 60)
        return (1.0 - tokens) / rate
        """
        while True:
            wait = float(self._client.eval(script, 1, key, rate, _BUCKET_CAPACITY, time.time()))
            if wait <= 0:
                return
            time.sleep(min(max(wait, 0.01), 0.5))


_store: Any = None
_store_lock = threading.Lock()


def _connect_redis(url: str) -> Any:
    import redis  # type: ignore[import-untyped]

    client = redis.Redis.from_url(url, socket_connect_timeout=0.4, socket_timeout=0.8)
    client.ping()
    return client


def get_store() -> Any:
    """Return the shared store, preferring Redis and falling back to memory."""
    global _store
    if _store is not None:
        return _store
    with _store_lock:
        if _store is not None:
            return _store
        url = os.environ.get("REDIS_URL", "").strip()
        if url:
            try:
                _store = _RedisStore(_connect_redis(url))
                return _store
            except Exception as exc:  # noqa: BLE001 - cache must never fail a run
                print(f"[http_cache] Redis unavailable ({exc}); using in-process store", flush=True)
        _store = _MemoryStore()
        return _store


def reset_store_for_tests() -> None:
    """Drop the cached store so a test can swap REDIS_URL."""
    global _store
    _store = None


def cache_key(url: str) -> str:
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()
    return f"{_CACHE_PREFIX}{classify_source(url)}:{digest}"


def cache_get(url: str) -> Optional[CachedResponse]:
    ttl = SOURCE_TTL.get(classify_source(url), 0)
    if ttl <= 0:
        return None
    raw = get_store().get(cache_key(url))
    if not raw:
        return None
    try:
        payload = json.loads(raw)
        return CachedResponse(
            status_code=int(payload["status_code"]),
            text=str(payload.get("text") or ""),
            headers=dict(payload.get("headers") or {}),
        )
    except (ValueError, KeyError, TypeError):
        return None


def cache_set(url: str, status_code: int, text: str, headers: Optional[dict[str, str]] = None) -> None:
    source = classify_source(url)
    ttl = SOURCE_TTL.get(source, 0)
    if ttl <= 0 or status_code != 200:
        return
    payload = json.dumps(
        {"status_code": status_code, "text": text, "headers": headers or {}},
        ensure_ascii=False,
    )
    get_store().set(cache_key(url), payload, ttl)


def acquire(url: str) -> None:
    """Block until this source has a token. Called immediately before a live GET."""
    source = classify_source(url)
    get_store().take_token(source, SOURCE_RATES.get(source, SOURCE_RATES["other"]))
