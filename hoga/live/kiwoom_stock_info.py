"""키움 ka10001 주식기본정보 fetcher — 10호가 요약 패널의 상하한가·250일 최고/최저.

/live 10호가 창 요약 패널이 대시(−)로 비워 두던 상한가·하한가·52주(키움은 250
거래일 기준) 행의 데이터 소스다. WS `0g`(305/306)로도 상하한가가 오지만 발화
빈도·조건이 미실측이라, 일 1회로 충분한 성격의 값은 결정론적인 REST 를 쓴다.

실호출 검증(2026-07-21, 018260): 필드표대로 응답이 오며 산술 검산 통과
(upl_pric = base_pric×1.3 틱 반올림). 공식 Response Example 의 "값 밀림"은
문서 예제만의 결함이고 실응답은 정상이다 — 파서는 필드표 기준.

파싱 규약(키움 REST 공통): 전 필드 String + 부호 prefix("+241500"). 부호는
기준가 대비 등락방향일 뿐이므로 가격은 크기만 취한다(WS 파서 `_price` 와 동형).

캐시는 KST 날짜 단위다 — 상하한가·기준가는 당일 고정값. 250일 최고/최저는 당일
신고가 돌파를 다음 날에야 반영하는 지연을 허용한다(당일 고가는 0B FID 17 이
실시간으로 따로 있어 패널의 "최고" 행이 담당).
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import httpx

from .kiwoom_token_provider import KiwoomTokenProvider
from .single_flight import SingleFlight

log = logging.getLogger(__name__)

_KST = timezone(timedelta(hours=9))
_BASE_REAL = "https://api.kiwoom.com"
_STKINFO_PATH = "/api/dostk/stkinfo"
_API_ID = "ka10001"


class KiwoomStockInfoError(RuntimeError):
    """ka10001 호출/응답 실패 (HTTP 오류 또는 return_code != 0)."""


@dataclass(frozen=True)
class StockLimits:
    """ka10001 중 10호가 요약 패널이 소비하는 부분집합. 미제공 필드는 None
    (예: 일부 ETN/신규상장은 250일 이력이 없다) — 소비자는 대시로 렌더한다."""

    code: str
    base_price: int | None
    upper_limit: int | None
    lower_limit: int | None
    high_250: int | None
    low_250: int | None
    high_250_date: str | None  # YYYYMMDD
    low_250_date: str | None  # YYYYMMDD


def _abs_price(raw: object) -> int | None:
    """부호 prefix 가격 문자열 → 양수 int. 빈 값·0·비숫자는 None(미제공)."""
    if not isinstance(raw, str):
        return None
    s = raw.strip().lstrip("+-")
    if not s.isdigit():
        return None
    v = int(s)
    return v if v > 0 else None


def _yyyymmdd(raw: object) -> str | None:
    if isinstance(raw, str):
        s = raw.strip()
        if len(s) == 8 and s.isdigit():  # noqa: PLR2004
            return s
    return None


def parse_ka10001(code: str, body: dict) -> StockLimits:
    """ka10001 응답 body → StockLimits. 필드표 기준(예제 아님 — 모듈 docstring)."""
    return StockLimits(
        code=code,
        base_price=_abs_price(body.get("base_pric")),
        upper_limit=_abs_price(body.get("upl_pric")),
        lower_limit=_abs_price(body.get("lst_pric")),
        high_250=_abs_price(body.get("250hgst")),
        low_250=_abs_price(body.get("250lwst")),
        high_250_date=_yyyymmdd(body.get("250hgst_pric_dt")),
        low_250_date=_yyyymmdd(body.get("250lwst_pric_dt")),
    )


class KiwoomStockInfoFetcher:
    """종목별 StockLimits 의 KST 날짜 단위 캐시 + single-flight fetcher.

    네트워크는 동기 httpx 를 `asyncio.to_thread` 로 돌린다 — 일 1회/종목이라
    비동기 클라이언트를 새로 들일 무게가 없다. httpx.Client 와 토큰 provider 는
    스레드 안전. 실패는 캐시하지 않는다(다음 요청이 재시도) — single-flight 가
    스탬피드를 막고, 프론트 React Query 백오프가 재시도 간격을 벌린다.
    """

    def __init__(
        self,
        token_provider: KiwoomTokenProvider,
        *,
        base_url: str = _BASE_REAL,
        _transport: httpx.BaseTransport | None = None,
    ):
        self._provider = token_provider
        self._client = httpx.Client(base_url=base_url, transport=_transport, timeout=10.0)
        # code → (kst_date "YYYYMMDD", limits, fetched_at_ms)
        self._cache: dict[str, tuple[str, StockLimits, int]] = {}
        self._flight = SingleFlight()

    def close(self) -> None:
        self._client.close()

    async def get(self, code: str) -> tuple[StockLimits, int]:
        today = datetime.now(_KST).strftime("%Y%m%d")
        hit = self._cache.get(code)
        if hit is not None and hit[0] == today:
            return hit[1], hit[2]
        async with self._flight.acquire(code):
            hit = self._cache.get(code)  # 대기 중 선행자가 채웠으면 재사용
            if hit is not None and hit[0] == today:
                return hit[1], hit[2]
            limits = await asyncio.to_thread(self._fetch_sync, code)
            fetched_at_ms = int(time.time() * 1000)
            self._cache[code] = (today, limits, fetched_at_ms)
            return limits, fetched_at_ms

    def _fetch_sync(self, code: str) -> StockLimits:
        token = self._provider.get_token()
        resp = self._client.post(
            _STKINFO_PATH,
            json={"stk_cd": code},
            headers={
                "Content-Type": "application/json;charset=UTF-8",
                "authorization": f"Bearer {token}",
                "api-id": _API_ID,
            },
        )
        if resp.status_code != 200:  # noqa: PLR2004
            raise KiwoomStockInfoError(
                f"ka10001 HTTP {resp.status_code} {resp.text[:200]}"
            )
        body = resp.json()
        if body.get("return_code") != 0:
            raise KiwoomStockInfoError(
                f"ka10001 return_code={body.get('return_code')} {body.get('return_msg')}"
            )
        return parse_ka10001(code, body)
