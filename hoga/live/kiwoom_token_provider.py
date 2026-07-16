"""키움 access-token provider — 동기 토큰 발급 (KisTokenProvider 브로커-대칭).

키움은 POST /oauth2/token (`appkey`/`secretkey`) → {"token", "expires_dt"} 를 준다.
만료는 발급 익일 동시각(~24h). KIS와 동일하게 3-tier 캐시(메모리→디스크→발급) +
10분 조기 갱신 + 0600 원자 저장. kis_* 모듈은 import하지 않는다(ADR-0116 규율 1) —
KST 등 공유값은 로컬 정의한다.
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
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

log = logging.getLogger(__name__)

KIWOOM_KST = timezone(timedelta(hours=9))
_BASE_REAL = "https://api.kiwoom.com"
# 키움 토큰 발급 쿨다운 — 문서에 분당 상한 명시는 없으나 KIS와 동일하게 보수적 60s.
# 발급 시도(성공 아닌) 시점에 마킹해 장애 엔드포인트에서 10s POST 반복을 막는다.
_REISSUE_COOLDOWN_MS = 60_000


class KiwoomAuthError(RuntimeError):
    """키움 토큰 발급/인증 실패."""


def _key_fingerprint(app_key: str) -> str:
    return hashlib.sha256(app_key.encode()).hexdigest()[:16]


@dataclass(frozen=True)
class KiwoomCredentials:
    app_key: str
    app_secret: str

    @property
    def base_url(self) -> str:
        return _BASE_REAL


class KiwoomTokenProvider:
    """유효한 키움 bearer 토큰의 동기 provider.

    인터페이스: get_token() -> str, invalidate(), close(). 3-tier 캐시·10분 조기
    갱신·발급 쿨다운·0600 원자 저장을 숨긴다. 디스크 캐시는 앱키 지문으로 키잉 —
    키 교체 후 옛 토큰은 auth 불일치라 miss로 읽혀야 한다. 스레드 안전(캐시 히트는
    lock-and-return, 실제 발급만 lock 안에서 네트워크).
    """

    def __init__(
        self,
        credentials: KiwoomCredentials,
        token_cache_path: Path,
        *,
        _transport: httpx.BaseTransport | None = None,
        on_issue_failure: Callable[[], None] | None = None,
    ):
        self._creds = credentials
        self._cache_path = token_cache_path
        self._client = httpx.Client(
            base_url=credentials.base_url, transport=_transport, timeout=10.0
        )
        self._token: str | None = None
        self._token_expires_at: datetime | None = None
        self._last_issued_monotonic_ms: int | None = None
        self._lock = threading.Lock()
        self._on_issue_failure = on_issue_failure

    def close(self) -> None:
        self._client.close()

    def get_token(self) -> str:
        with self._lock:
            if (
                self._token
                and self._token_expires_at
                and datetime.now(KIWOOM_KST) < self._token_expires_at - timedelta(minutes=10)
            ):
                return self._token
            cached = self._read_cache()
            if cached:
                self._token, self._token_expires_at = cached
                return self._token
            try:
                return self._issue_token()
            except Exception:
                if self._on_issue_failure is not None:
                    try:
                        self._on_issue_failure()
                    except Exception:  # noqa: BLE001 — 콜백 실패가 토큰 에러를 못 가리게
                        log.warning("kiwoom token on_issue_failure raised", exc_info=True)
                raise

    def invalidate(self) -> None:
        with self._lock:
            self._token = None
            self._token_expires_at = None
            try:
                self._cache_path.unlink(missing_ok=True)
            except OSError:
                log.warning("kiwoom token cache unlink failed: %s", self._cache_path)

    def _issue_token(self) -> str:
        """POST /oauth2/token 로 신규 발급. 호출자가 self._lock 보유."""
        now_ms = int(time.monotonic() * 1000)
        if (
            self._last_issued_monotonic_ms is not None
            and now_ms - self._last_issued_monotonic_ms < _REISSUE_COOLDOWN_MS
        ):
            raise KiwoomAuthError("token reissue cooldown")
        self._last_issued_monotonic_ms = now_ms
        resp = self._client.post(
            "/oauth2/token",
            json={
                "grant_type": "client_credentials",
                "appkey": self._creds.app_key,
                "secretkey": self._creds.app_secret,
            },
            headers={"Content-Type": "application/json;charset=UTF-8"},
        )
        if resp.status_code != 200:  # noqa: PLR2004
            raise KiwoomAuthError(f"token issue HTTP {resp.status_code} {resp.text[:200]}")
        body = resp.json()
        token = body.get("token") or body.get("access_token")
        if not token:
            raise KiwoomAuthError(f"token issue: no token in response {str(body)[:200]}")
        expires_at = self._parse_expiry(body)
        self._token = token
        self._token_expires_at = expires_at
        self._write_cache(token, expires_at)
        return token

    @staticmethod
    def _parse_expiry(body: dict) -> datetime:
        """expires_dt("YYYYMMDDHHMMSS", KST) 우선, 없으면 expires_in(초), 없으면 +24h."""
        raw = body.get("expires_dt")
        if isinstance(raw, str) and len(raw) == 14 and raw.isdigit():  # noqa: PLR2004
            return datetime.strptime(raw, "%Y%m%d%H%M%S").replace(tzinfo=KIWOOM_KST)
        expires_in = int(body.get("expires_in", 86400))
        return datetime.now(KIWOOM_KST) + timedelta(seconds=expires_in)

    def _read_cache(self) -> tuple[str, datetime] | None:
        if not self._cache_path.exists():
            return None
        try:
            data = json.loads(self._cache_path.read_text())
            if not isinstance(data, dict):
                return None
            if data.get("app_key_sha256") != _key_fingerprint(self._creds.app_key):
                return None
            exp = datetime.fromisoformat(data["expires_at"])
            if datetime.now(KIWOOM_KST) >= exp - timedelta(minutes=10):
                return None
            return data["access_token"], exp
        except (json.JSONDecodeError, KeyError, ValueError, TypeError, OSError):
            return None

    def _write_cache(self, token: str, expires_at: datetime) -> None:
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
            log.warning("kiwoom token cache write failed: %s", self._cache_path)
