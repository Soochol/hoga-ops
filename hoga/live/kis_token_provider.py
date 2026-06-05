"""KIS access-token provider — sync token acquisition.

Extracted from KisClient (ADR-0050 amendment 2026-06-05) so token lifecycle
lives in ONE place and both the event-loop fetch path (KisClient) and the
sync executor/threadpool holiday path (Phase 3) share one cache + cooldown.

Issuance is synchronous (httpx.Client) so this module never touches an event
loop — that is precisely what lets the sync calendar path reuse it without
the AsyncClient loop-binding hazard. get_token() is guarded by a
threading.Lock because it is called from three thread contexts at once:
the event-loop thread, executor threads, and FastAPI's sync-route threadpool.
"""
from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import httpx

from hoga.live.kis_client import (
    KIS_KST,
    _REISSUE_COOLDOWN_MS,
    KisAuthError,
    KisCredentials,
)


class KisTokenProvider:
    """Sync provider of a valid KIS bearer token.

    Interface: ``get_token() -> str`` (+ ``close()``). Hides the 3-tier cache
    (memory → disk → issue), the 10-minute early-refresh buffer, the
    1-per-minute reissue cooldown, and chmod-600 persistence. Thread-safe:
    cache hits lock-and-return with no I/O; only a genuine issue does network,
    inside the lock, so concurrent callers serialize to a single POST.
    """

    def __init__(
        self,
        credentials: KisCredentials,
        token_cache_path: Path,
        *,
        _transport: Optional[httpx.BaseTransport] = None,
    ):
        self._creds = credentials
        self._cache_path = token_cache_path
        self._client = httpx.Client(
            base_url=credentials.base_url, transport=_transport, timeout=10.0
        )
        self._token: Optional[str] = None
        self._token_expires_at: Optional[datetime] = None
        # monotonic clock so NTP steps / DST don't confuse the cooldown.
        self._last_issued_monotonic_ms: Optional[int] = None
        self._lock = threading.Lock()

    def close(self) -> None:
        self._client.close()

    def get_token(self) -> str:
        with self._lock:
            # in-memory hit (early-refresh 10 min before expiry)
            if (
                self._token
                and self._token_expires_at
                and datetime.now(KIS_KST) < self._token_expires_at - timedelta(minutes=10)
            ):
                return self._token
            # disk cache hit
            cached = self._read_cache()
            if cached:
                self._token, self._token_expires_at = cached
                return self._token
            return self._issue_token()

    def _issue_token(self) -> str:
        """Issue a fresh access_token via POST /oauth2/tokenP.

        Caller holds ``self._lock``. KIS limits issuance to 1/min and returns
        the SAME token for any reissue within 6 hours — so the disk cache is
        essential and a real issue is rare in steady state.
        """
        now_ms = int(time.monotonic() * 1000)
        if (
            self._last_issued_monotonic_ms is not None
            and now_ms - self._last_issued_monotonic_ms < _REISSUE_COOLDOWN_MS
        ):
            raise KisAuthError(
                "token reissue cooldown: KIS allows 1 issuance per minute"
            )
        resp = self._client.post(
            "/oauth2/tokenP",
            json={
                "grant_type": "client_credentials",
                "appkey": self._creds.app_key,
                "appsecret": self._creds.app_secret,
            },
        )
        if resp.status_code != 200:
            raise KisAuthError(
                f"token issue failed: HTTP {resp.status_code} {resp.text[:200]}"
            )
        body = resp.json()
        token: str = body["access_token"]
        expires_in = int(body.get("expires_in", 86400))
        expires_at = datetime.now(KIS_KST) + timedelta(seconds=expires_in)
        self._token = token
        self._token_expires_at = expires_at
        self._last_issued_monotonic_ms = now_ms
        self._write_cache(token, expires_at)
        return token

    def _read_cache(self) -> Optional[tuple[str, datetime]]:
        if not self._cache_path.exists():
            return None
        try:
            data = json.loads(self._cache_path.read_text())
            exp = datetime.fromisoformat(data["expires_at"])
            if datetime.now(KIS_KST) >= exp - timedelta(minutes=10):
                return None
            return data["access_token"], exp
        except (json.JSONDecodeError, KeyError, ValueError):
            return None

    def _write_cache(self, token: str, expires_at: datetime) -> None:
        self._cache_path.parent.mkdir(parents=True, exist_ok=True)
        self._cache_path.write_text(
            json.dumps({"access_token": token, "expires_at": expires_at.isoformat()})
        )
        self._cache_path.chmod(0o600)
