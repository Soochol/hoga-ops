"""KIS process-resource singletons (token provider + client).

Extracted from lifecycle.py (SPEC §10, 아키텍처 그릴링 2026-06-05) so that
poller-independent consumers — the sync holiday path (kis_holidays), the
screener EOD update, /api/live/quotes — obtain KIS resources without importing
the poller lifecycle module. Singleton-ness is unchanged (ADR-0038/0050):
one token provider + one client (one 15/s bucket) per process; closed only at
process shutdown via aclose_kis_client.
"""
from __future__ import annotations

import os
from pathlib import Path

from .kis_client import KisClient, KisCredentials
from .kis_token_provider import KisTokenProvider

_kis_client: KisClient | None = None
_kis_token_provider: KisTokenProvider | None = None


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
    if _kis_client is None:
        _kis_client = KisClient(credentials=creds, token_provider=provider)
    return _kis_client


def ensure_kis_client_from_env(data_dir: Path) -> KisClient | None:
    """Resolve KIS creds from the environment and return the process singleton,
    or None when creds are absent.

    The single source of the env→creds→token-path recipe shared by the live
    poller, the screener EOD update, and the /api/live/quotes route. Centralizing
    it here means a consumer can't drift on env-var names / env / token path, and
    it makes ensure_kis_client's "reuse existing, ignore later args" behavior
    safe-by-construction (every caller resolves identical values). A new consumer
    obtains the shared 15/s-bucket singleton with one call + a None check.
    """
    import os

    app_key = os.environ.get("KIS_APP_KEY")
    app_secret = os.environ.get("KIS_APP_SECRET")
    if not app_key or not app_secret:
        return None
    creds = KisCredentials(app_key=app_key, app_secret=app_secret, env="real")
    provider = ensure_kis_token_provider(data_dir / ".local" / "kis-token.json", creds)
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


def ensure_kis_token_provider_from_env() -> tuple[KisTokenProvider, KisCredentials] | None:
    """Resolve creds from env and return (provider, creds), or None when
    KIS_APP_KEY/SECRET are absent. For consumers that need the token + auth
    headers but NOT the async data client (e.g. the sync holiday path)."""
    app_key = os.environ.get("KIS_APP_KEY")
    app_secret = os.environ.get("KIS_APP_SECRET")
    if not app_key or not app_secret:
        return None
    from hoga.config import resolve_data_dir

    creds = KisCredentials(app_key=app_key, app_secret=app_secret, env="real")
    provider = ensure_kis_token_provider(
        resolve_data_dir() / ".local" / "kis-token.json", creds
    )
    return provider, creds


def reset_for_tests() -> None:
    """Test helper — drop both singletons (no close; tests own teardown)."""
    global _kis_client, _kis_token_provider
    _kis_client = None
    _kis_token_provider = None
