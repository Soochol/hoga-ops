"""KIS WS 승인키 provider — `KisTokenProvider` 대칭.

**REST 토큰과 다른 자격이다.** REST 는 `POST /oauth2/tokenP` 의 Bearer 토큰,
WS 는 `POST /oauth2/Approval` 의 `approval_key` 다. PR-J(#1046)에서 함께 지워졌고
야간 선물(ADR-0141)이 WS 쪽만 되살린다.

표면은 `KisTokenProvider` 와 맞춘다 — `get_key()` / `invalidate()` / `close()` +
메모리 캐시 + 1분 발급 쿨다운. 그쪽 docstring 이 설명하는 이유가 여기도 그대로다:
발급 chokepoint 를 한 곳으로 모아야 재연결이 잦을 때 발급이 폭주하지 않는다.

**디스크 캐시는 두지 않는다 — 이것이 토큰과 갈리는 유일한 지점이다.**
`/oauth2/Approval` 응답은 `approval_key` 만 주고 **만료 시각을 주지 않는다**(실측
2026-08-07). 만료를 모르면 디스크에서 읽은 키가 유효한지 판정할 수 없고, 죽은 키를
계속 먹이면 재연결이 조용히 실패한다. 토큰 쪽이 디스크 캐시를 둘 수 있는 근거는
`expires_in` 이 응답에 오기 때문이다.

**실패를 두 종류로 나눈다.** 이 구분이 없으면 호출부가 백오프 여부를 결정할 수 없다:

    KisApprovalUnavailable   자격증명 없음 — 재시도해도 같다. 포기가 정답.
    KisApprovalTransient     네트워크·벤더 5xx — 백오프 재시도가 정답.

한 예외로 뭉치면 일시 장애를 영구 실패로 오분류해 **백오프 없이 폴링 주기마다**
재시도하게 되고(30초 × 11시간 ≈ 1,300줄), 배경 폴링의 실패를 warning 으로 남기면
로그 벽이 된다(`market_routes` 규약 4 · kis_client 의 EGW00201 교훈).
"""
from __future__ import annotations

import logging
import threading
import time

import httpx

from hoga.live.kis_client import KisCredentials

log = logging.getLogger(__name__)

_APPROVAL_PATH = "/oauth2/Approval"

#: 발급 쿨다운. 토큰 쪽과 같은 값이다 — KIS 인증 엔드포인트는 분당 1회를 전제한다.
_REISSUE_COOLDOWN_MS = 60_000

_HTTP_OK = 200


class KisApprovalUnavailable(RuntimeError):
    """**영구** 실패 — 자격증명 부재 등. 호출부는 재시도하지 말고 포기할 것."""


class KisApprovalTransient(RuntimeError):
    """**일시** 실패 — 네트워크·벤더 장애·쿨다운. 호출부는 백오프 재시도할 것."""


class KisApprovalProvider:
    """유효한 WS 승인키의 동기 provider.

    스레드 안전: 캐시 히트는 락 안에서 I/O 없이 반환하고, 실제 발급만 락 안에서
    네트워크를 타므로 동시 호출이 POST 한 번으로 직렬화된다(토큰 provider 와 같다).
    """

    def __init__(
        self,
        credentials: KisCredentials,
        *,
        _transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._creds = credentials
        self._client = httpx.Client(
            base_url=credentials.base_url, transport=_transport, timeout=15.0
        )
        self._key: str | None = None
        # monotonic 시계 — NTP 스텝·DST 가 쿨다운을 흔들지 않게.
        self._last_issued_monotonic_ms: int | None = None
        self._lock = threading.Lock()

    def close(self) -> None:
        self._client.close()

    def get_key(self) -> str:
        """캐시된 승인키, 없으면 신규 발급. **블로킹** — to_thread 로 부를 것."""
        with self._lock:
            if self._key:
                return self._key
            return self._issue_key()

    def invalidate(self) -> None:
        """캐시를 버린다 — 벤더가 이 키를 거부했을 때.

        쿨다운은 그대로 적용된다: 왜 새 키가 필요한지와 무관하게 발급은 분당 1회다.
        """
        with self._lock:
            self._key = None

    def _issue_key(self) -> str:
        """`POST /oauth2/Approval`. 호출자가 락을 쥐고 있다."""
        app_key = self._creds.app_key
        app_secret = self._creds.app_secret
        if not app_key or not app_secret:
            # 영구 실패 — 무자격 dev 프로필(ADR-0134)에서 정상 경로다.
            raise KisApprovalUnavailable("KIS 자격증명 없음")

        now_ms = int(time.monotonic() * 1000)
        if (
            self._last_issued_monotonic_ms is not None
            and now_ms - self._last_issued_monotonic_ms < _REISSUE_COOLDOWN_MS
        ):
            # 일시 실패로 분류한다 — 기다리면 풀린다.
            raise KisApprovalTransient("승인키 발급 쿨다운(분당 1회)")
        # POST **전에** 시도를 기록한다: 인증 엔드포인트가 매달리거나 계속 실패할 때
        # 다음 60초의 요청이 각자 15초 블로킹을 치르는 대신 위 쿨다운에서 빠르게 실패한다.
        self._last_issued_monotonic_ms = now_ms

        try:
            resp = self._client.post(
                _APPROVAL_PATH,
                json={
                    "grant_type": "client_credentials",
                    "appkey": app_key,
                    "secretkey": app_secret,
                },
            )
        except httpx.HTTPError as e:
            raise KisApprovalTransient(f"승인키 발급 전송 실패: {e}") from e

        if resp.status_code != _HTTP_OK:
            raise KisApprovalTransient(
                f"승인키 발급 실패: HTTP {resp.status_code} {resp.text[:200]}"
            )
        key = (resp.json() or {}).get("approval_key")
        if not key:
            # 200 인데 키가 없다 — 스펙 위반이지만 자격 문제일 수도 있어 일시로 둔다
            # (영구로 분류하면 벤더 일시 이상에 야간 경로가 그날 내내 죽는다).
            raise KisApprovalTransient("승인키가 응답에 없다")
        self._key = str(key)
        return self._key
