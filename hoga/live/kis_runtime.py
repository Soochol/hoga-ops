"""KIS process-resource singletons (token provider + client).

Extracted from lifecycle.py (SPEC §10, 아키텍처 그릴링 2026-06-05) so that
poller-independent consumers — the sync holiday path (kis_holidays), the
screener EOD update, /api/live/quotes — obtain KIS resources without importing
the poller lifecycle module. Singleton-ness is unchanged (ADR-0038/0050):
one token provider + one client (one 15/s bucket) per process; closed only at
process shutdown via aclose_kis_client.

Thread-safety: the ensure_* getters are reached concurrently from the event
loop (poller start, /quotes lazy ensure, screener recovery) and executor
threads (calendar month fetch, captures range expansion) — ``_lock`` makes the
check-then-create atomic so two threads can't each build a provider (split
cooldown state + a leaked httpx.Client). Construction does no I/O, so the
critical section is microseconds.
"""
from __future__ import annotations

import os
import threading
from pathlib import Path

from .kis_client import KisClient, KisCredentials
from .kis_token_provider import KisTokenProvider

_kis_client: KisClient | None = None
_kis_token_provider: KisTokenProvider | None = None
_lock = threading.Lock()


def get_kis_client() -> KisClient | None:
    return _kis_client


def set_kis_client(client: KisClient | None) -> None:
    """Stage 8 hook: inject the KisClient singleton."""
    global _kis_client
    _kis_client = client


def ensure_kis_token_provider(
    token_cache_path: Path, creds: KisCredentials
) -> KisTokenProvider:
    """Return the process-wide KisTokenProvider singleton, creating it once.

    Token lifecycle (cache + 1/min cooldown) must be shared by the async fetch
    path (KisClient) and the sync holiday path (Phase 3), so there is exactly
    ONE provider per process. The token cache path is decided here — the single
    source that downstream consumers inherit.
    """
    global _kis_token_provider
    with _lock:
        if _kis_token_provider is None:
            _kis_token_provider = KisTokenProvider(creds, token_cache_path)
        return _kis_token_provider


def ensure_kis_client(creds: KisCredentials, provider: KisTokenProvider) -> KisClient:
    """Return the process-wide KisClient singleton, creating it once.

    The KIS rate-limit invariant ("one app key = one 15/s token bucket")
    requires exactly ONE KisClient per process, decoupled from poller
    start/stop. The injected ``provider`` supplies tokens; the client owns only
    the fetch AsyncClient + rate bucket. Closed at process shutdown via
    ``aclose_kis_client`` — a poller stop must NOT close it.
    """
    global _kis_client
    with _lock:
        if _kis_client is None:
            _kis_client = KisClient(credentials=creds, token_provider=provider)
        return _kis_client


def _reload_env_for_retry() -> None:
    """Re-read .env (non-override — shell env still wins). A dedicated seam so
    the test suite can no-op it (an autouse conftest guard does): without the
    guard, any test reaching the retry path re-loads the developer's REAL
    .env and silently un-does monkeypatch.delenv creds isolation."""
    from hoga.env import load_env  # late import: keeps module import light

    load_env()


def _resolve_env_creds(*, reload_env: bool) -> KisCredentials | None:
    """env → KisCredentials, or None when KIS_APP_KEY/SECRET are absent.

    With ``reload_env``, a miss re-reads .env once before giving up: the UI's
    remediation copy says "set the keys in .env and retry", and pre-migration
    that loop worked via the KRX refresh path's load_env(override=True).
    Only USER-RETRY-reachable paths pass True — boot paths (poller start,
    /quotes) keep boot-time env semantics.
    """
    app_key = os.environ.get("KIS_APP_KEY")
    app_secret = os.environ.get("KIS_APP_SECRET")
    if (not app_key or not app_secret) and reload_env:
        _reload_env_for_retry()
        app_key = os.environ.get("KIS_APP_KEY")
        app_secret = os.environ.get("KIS_APP_SECRET")
    if not app_key or not app_secret:
        return None
    return KisCredentials(app_key=app_key, app_secret=app_secret, env="real")


def ensure_kis_token_provider_from_env(
    data_dir: Path | None = None,
    *,
    reload_env: bool = False,
) -> tuple[KisTokenProvider, KisCredentials] | None:
    """Resolve creds from env and return (provider, creds), or None when
    KIS_APP_KEY/SECRET are absent. For consumers that need the token + auth
    headers but NOT the async data client (e.g. the sync holiday path).

    ``data_dir`` defaults to :func:`hoga.config.resolve_data_dir` — pass it
    when the caller owns a custom data dir so the token cache lands there.
    ``reload_env`` re-reads .env on a creds miss (user-retry paths only).
    """
    creds = _resolve_env_creds(reload_env=reload_env)
    if creds is None:
        return None
    if data_dir is None:
        from hoga.config import resolve_data_dir

        data_dir = resolve_data_dir()
    provider = ensure_kis_token_provider(data_dir / ".local" / "kis-token.json", creds)
    return provider, creds


def ensure_kis_client_from_env(data_dir: Path) -> KisClient | None:
    """Resolve KIS creds from the environment and return the process singleton,
    or None when creds are absent.

    Delegates to :func:`ensure_kis_token_provider_from_env` so there is exactly
    ONE env→creds→token-path recipe in this module (the two used to diverge on
    the token-cache path: caller ``data_dir`` here vs ``resolve_data_dir()``
    there, and first-caller-wins silently pinned whichever ran first). A new
    consumer obtains the shared 15/s-bucket singleton with one call + a None
    check.
    """
    got = ensure_kis_token_provider_from_env(data_dir)  # no reload_env: boot semantics
    if got is None:
        return None
    provider, creds = got
    return ensure_kis_client(creds, provider)


async def aclose_kis_client() -> None:
    """Close and drop the KisClient + KisTokenProvider singletons — PROCESS
    shutdown only. A poller stop must not call this.
    """
    global _kis_client, _kis_token_provider
    if _kis_client is not None:
        try:
            await _kis_client.aclose()
        except Exception:  # noqa: BLE001
            pass
        _kis_client = None
    if _kis_token_provider is not None:
        try:
            _kis_token_provider.close()
        except Exception:  # noqa: BLE001
            pass
        _kis_token_provider = None


def reset_for_tests() -> None:
    """Test helper — drop both singletons. Closes the provider's sync httpx
    client best-effort (the async client can't be closed from sync context;
    an unused AsyncClient holds no sockets, so dropping it is safe)."""
    global _kis_client, _kis_token_provider
    if _kis_token_provider is not None:
        try:
            _kis_token_provider.close()
        except Exception:  # noqa: BLE001
            pass
    _kis_client = None
    _kis_token_provider = None
