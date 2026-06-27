"""KIS access-token provider — sync token acquisition.

Extracted from KisClient (ADR-0050 amendment 2026-06-05) so token lifecycle
lives in ONE place and both the event-loop fetch path (KisClient) and the
sync executor/threadpool holiday path (Phase 3) share one cache + cooldown.

Issuance is synchronous (httpx.Client) so this module never touches an event
loop — that is precisely what lets the sync calendar path reuse it without
the AsyncClient loop-binding hazard. get_token() is guarded by a
threading.Lock because it is called from three thread contexts at once:
the event-loop thread, executor threads, and FastAPI's sync-route threadpool.
NOTE: get_token() can block on network for seconds — async callers must wrap
it in ``asyncio.to_thread`` (KisClient does); never call it bare on the loop.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
import threading
import time
from collections.abc import Callable
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import httpx

from hoga.live.kis_client import (
    KIS_KST,
    KisAuthError,
    KisCredentials,
)

log = logging.getLogger(__name__)

# KIS: 1 issuance per minute. Lives here (not kis_client) because issuance is
# this module's concern — the marker is set on ATTEMPT, not success, so a
# hanging/failing KIS auth endpoint is also throttled to one blocking POST per
# minute instead of retrying a 10s timeout on every cache miss.
_REISSUE_COOLDOWN_MS = 60_000


def _key_fingerprint(app_key: str) -> str:
    """Non-reversible fingerprint of the app key for cache-identity checks —
    the cache file must never persist the key itself."""
    return hashlib.sha256(app_key.encode()).hexdigest()[:16]


class KisTokenProvider:
    """Sync provider of a valid KIS bearer token.

    Interface: ``get_token() -> str``, ``invalidate()``, ``close()``. Hides the
    3-tier cache (memory → disk → issue), the 10-minute early-refresh buffer,
    the 1-per-minute reissue cooldown, and 0600-atomic persistence. The disk
    cache is keyed by an app-key fingerprint: after a key rotation the old
    key's token is a guaranteed auth mismatch, so it must read as a miss.
    Thread-safe: cache hits lock-and-return with no I/O; only a genuine issue
    does network, inside the lock, so concurrent callers serialize to a single
    POST.
    """

    def __init__(
        self,
        credentials: KisCredentials,
        token_cache_path: Path,
        *,
        _transport: Optional[httpx.BaseTransport] = None,
        on_issue_failure: Optional[Callable[[], None]] = None,
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
        # REST bearer 토큰 발급 실패 시 호출되는 콜백. kis_runtime이 account_id에
        # 바인딩해 주입하므로, scheduler/account pool은 해당 계정을 REST-degraded로
        # 보고 제외할 수 있다. 토큰 발급 chokepoint에서 감지하므로 호출부는 account를
        # 몰라도 된다.
        self._on_issue_failure = on_issue_failure

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
            # 캐시 미스 → 신규 발급. 실패(KisAuthError 등) 시 on_issue_failure를 1회
            # 호출하고 에러를 그대로 전파한다(FM5 latch). 첫 시도는 cooldown을 건너뛰므로
            # 첫 실패는 항상 실제 POST 실패 → latch가 실제 장애에서 켜진다. 콜백 자체의
            # 예외는 토큰 에러를 가리지 않도록 삼킨다.
            try:
                return self._issue_token()
            except Exception:
                if self._on_issue_failure is not None:
                    try:
                        self._on_issue_failure()
                    except Exception:  # noqa: BLE001 — 콜백 실패가 토큰 에러를 못 가리게
                        log.warning("kis token on_issue_failure callback raised", exc_info=True)
                raise

    def invalidate(self) -> None:
        """Drop the cached token (memory + disk) after KIS rejected it.

        Without this there was NO recovery from a server-side revocation:
        memory and disk kept serving the dead token until expires_at (~24h),
        and a restart re-read the same dead token from disk. The reissue
        cooldown still applies to the next get_token() — KIS allows 1
        issuance per minute regardless of why we want a new one.
        """
        with self._lock:
            self._token = None
            self._token_expires_at = None
            try:
                self._cache_path.unlink(missing_ok=True)
            except OSError:
                log.warning("kis token cache unlink failed: %s", self._cache_path)

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
        # Mark the ATTEMPT before the POST: on a hanging/failing auth endpoint
        # the next 60s of cache misses fail fast on the cooldown above instead
        # of each paying a fresh 10s blocking POST.
        self._last_issued_monotonic_ms = now_ms
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
        self._write_cache(token, expires_at)
        return token

    def _read_cache(self) -> Optional[tuple[str, datetime]]:
        if not self._cache_path.exists():
            return None
        try:
            data = json.loads(self._cache_path.read_text())
            if not isinstance(data, dict):
                return None
            # Cache identity: a token issued for a different app key (rotation)
            # is a guaranteed auth mismatch — treat as miss. Old cache files
            # without the fingerprint also miss (one extra reissue, then fine).
            if data.get("app_key_sha256") != _key_fingerprint(self._creds.app_key):
                return None
            exp = datetime.fromisoformat(data["expires_at"])
            if datetime.now(KIS_KST) >= exp - timedelta(minutes=10):
                return None
            return data["access_token"], exp
        # TypeError: non-string expires_at / non-str token shapes.
        # OSError: file vanished or unreadable between exists() and read_text()
        # (e.g. root-owned after a sudo run). Either way fall through to
        # re-issuance instead of failing every get_token() forever.
        except (json.JSONDecodeError, KeyError, ValueError, TypeError, OSError):
            return None

    def _write_cache(self, token: str, expires_at: datetime) -> None:
        """Best-effort 0600-atomic persist. mkstemp creates the temp file 0600
        (no world-readable window for the live bearer token, unlike
        write_text-then-chmod) and os.replace is atomic, so a concurrent
        reader in another process never sees torn JSON."""
        payload = json.dumps({
            "access_token": token,
            "expires_at": expires_at.isoformat(),
            "app_key_sha256": _key_fingerprint(self._creds.app_key),
        })
        try:
            self._cache_path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp_name = tempfile.mkstemp(dir=self._cache_path.parent)
            try:
                os.write(fd, payload.encode())
            finally:
                os.close(fd)
            os.replace(tmp_name, self._cache_path)
        except OSError:
            # The token is already served from memory; a failed persist must
            # not fail the call. Next process start just re-issues.
            log.warning("kis token cache write failed: %s", self._cache_path)
