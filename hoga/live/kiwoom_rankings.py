"""키움 순위정보 fetcher — /live 우측 RightRail "순위" 드로어(특징주).

시장 전체 순위 REST TR 4종을 조회한다. 전부 `POST /api/dostk/rkinfo` 공통 path,
api-id 헤더로 분기(스펙 실측: docs/research/2026-07-22-kiwoom-ranking-tr-spec.md).

| kind     | api-id  | 정렬(sort_tp)         | 응답 래퍼 키              |
|----------|---------|-----------------------|---------------------------|
| change   | ka10027 | 1=상승 / 3=하락       | pred_pre_flu_rt_upper     |
| surge    | ka10023 | 2=급증률              | trde_qty_sdnin            |
| volume   | ka10030 | 1=거래량              | tdy_trde_qty_upper        |
| value    | ka10032 | (없음, 거래대금 고정) | trde_prica_upper          |

파싱 규약(키움 REST 공통): 전 필드 String + 부호 prefix. 가격(cur_prc)은 기준가
대비 등락방향 부호가 붙으므로 크기만 취하고(`kiwoom_stock_info._abs_price` 와 동형),
등락률(flu_rt)은 부호를 보존한다(상승 +/하락 −). 콤마는 방어적으로 제거한다.

캐시는 (kind, market, direction) 키의 TTL(~8s) 단위 — 프론트가 10s 폴링하므로
연타·다중 소비자를 single-flight + TTL 로 흡수해 상류 유량을 아낀다(WS 순위 푸시가
없어 REST 폴링이 유일 경로). 실패는 캐시하지 않는다(다음 요청이 재시도).

거래일 게이트: 비거래일(주말·휴일)이면 상류 호출을 건너뛰고 빈 목록을 준다 —
장중에만 순위가 의미 있고, 비거래일 폴링은 유령 데이터 전례(REST30)를 답습한다.
장 개장 여부(market_open)는 프론트 폴링 on/off 를 가르는 신호로 함께 내려준다.
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from datetime import time as dt_time
from typing import Literal

import httpx

from hoga.api.calendar import is_trading_day

from .kiwoom_token_provider import KiwoomTokenProvider
from .single_flight import SingleFlight

log = logging.getLogger(__name__)

_KST = timezone(timedelta(hours=9))
_BASE_REAL = "https://api.kiwoom.com"
_RKINFO_PATH = "/api/dostk/rkinfo"
_CACHE_TTL_MS = 8_000

# 정규장 시간(KST): 09:00 ~ 15:30. 이 창 밖이면 market_open=False → 프론트 폴링 정지
# (그릴링 결정 9: 장외엔 열 때 1회 조회 후 정지). 동시호가/시간외는 순위 갱신 관성이
# 커 별도 취급하지 않는다.
_MARKET_OPEN = dt_time(9, 0)
_MARKET_CLOSE = dt_time(15, 30)

RankingKind = Literal["change", "surge", "volume", "value"]
Market = Literal["all", "kospi", "kosdaq"]
Direction = Literal["up", "down"]

# 시장구분 mrkt_tp: zero-pad 문자열(공식 문서 관례). ⚠️ .NET enum 정수는 0/1/101 —
# 실콜로 zero-pad 여부 최종확정 필요(research §검증 필요 1).
_MARKET_CODE: dict[Market, str] = {"all": "000", "kospi": "001", "kosdaq": "101"}

_STEX_KRX = "1"  # 거래소구분: KRX 고정(기존 캡처 기준)


class KiwoomRankingsError(RuntimeError):
    """순위 TR 호출/응답 실패 (HTTP 오류 또는 return_code != 0)."""


@dataclass(frozen=True)
class RankingRow:
    """드로어 행이 소비하는 부분집합. 기준값(급증률·거래량·거래대금) 열은
    사용자 결정으로 제거 — 순서가 곧 기준값이라 code/name/price/change_pct 만 쓴다."""

    rank: int
    code: str
    name: str
    price: int | None
    change_pct: float | None


@dataclass(frozen=True)
class RankingSnapshot:
    kind: RankingKind
    market: Market
    direction: Direction
    rows: tuple[RankingRow, ...]
    market_open: bool
    fetched_at_ms: int


@dataclass(frozen=True)
class _KindSpec:
    api_id: str
    wrapper_key: str


_KIND_SPEC: dict[RankingKind, _KindSpec] = {
    "change": _KindSpec("ka10027", "pred_pre_flu_rt_upper"),
    "surge": _KindSpec("ka10023", "trde_qty_sdnin"),
    "volume": _KindSpec("ka10030", "tdy_trde_qty_upper"),
    "value": _KindSpec("ka10032", "trde_prica_upper"),
}


def _abs_price(raw: object) -> int | None:
    """부호 prefix 가격 문자열 → 양수 int. 빈 값·0·비숫자는 None."""
    if not isinstance(raw, str):
        return None
    s = raw.strip().replace(",", "").lstrip("+-")
    if not s.isdigit():
        return None
    v = int(s)
    return v if v > 0 else None


def _signed_float(raw: object) -> float | None:
    """부호 보존 실수 문자열(flu_rt "+29.97" / "-18.32") → float. 비숫자는 None.

    하한가 특수표기 "--"(이중 마이너스)는 첫 부호만 유효로 본다(음수)."""
    if not isinstance(raw, str):
        return None
    s = raw.strip().replace(",", "")
    if s.startswith("--"):
        s = "-" + s[2:]
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def parse_rankings(kind: RankingKind, body: dict) -> tuple[RankingRow, ...]:
    """순위 TR 응답 body → RankingRow 튜플. 순위는 응답 순서(1-기반)."""
    spec = _KIND_SPEC[kind]
    raw_rows = body.get(spec.wrapper_key)
    if not isinstance(raw_rows, list):
        return ()
    rows: list[RankingRow] = []
    for i, item in enumerate(raw_rows, start=1):
        if not isinstance(item, dict):
            continue
        code = item.get("stk_cd")
        name = item.get("stk_nm")
        if not isinstance(code, str) or not code.strip():
            continue
        rows.append(
            RankingRow(
                rank=i,
                code=code.strip(),
                name=name.strip() if isinstance(name, str) else "",
                price=_abs_price(item.get("cur_prc")),
                change_pct=_signed_float(item.get("flu_rt")),
            )
        )
    return tuple(rows)


def _build_body(kind: RankingKind, market: Market, direction: Direction) -> dict[str, str]:
    """kind 별 요청 body. 조건 파라미터는 전체(0) 기본값 — 필터는 mrkt_tp 만."""
    mrkt = _MARKET_CODE[market]
    if kind == "change":  # ka10027 전일대비등락률상위
        return {
            "mrkt_tp": mrkt,
            "sort_tp": "1" if direction == "up" else "3",  # 상승률 / 하락률
            "trde_qty_cnd": "0000",
            "stk_cnd": "0",
            "crd_cnd": "0",
            "updown_incls": "1",
            "pric_cnd": "0",
            "trde_prica_cnd": "0",
            "stex_tp": _STEX_KRX,
        }
    if kind == "surge":  # ka10023 거래량급증
        return {
            "mrkt_tp": mrkt,
            "sort_tp": "2",  # 급증률
            "tm_tp": "1",  # 분
            "tm": "1",
            "trde_qty_tp": "0",
            "stk_cnd": "0",
            "pric_tp": "0",
            "stex_tp": _STEX_KRX,
        }
    if kind == "volume":  # ka10030 당일거래량상위
        return {
            "mrkt_tp": mrkt,
            "sort_tp": "1",  # 거래량
            "mang_stk_incls": "0",
            "crd_tp": "0",
            "trde_qty_tp": "0",
            "pric_tp": "0",
            "trde_prica_tp": "0",
            "mrkt_open_tp": "0",
            "stex_tp": _STEX_KRX,
        }
    # value — ka10032 거래대금상위 (정렬 파라미터 없음)
    return {
        "mrkt_tp": mrkt,
        "mang_stk_incls": "0",
        "stex_tp": _STEX_KRX,
    }


def _market_open_now(now: datetime | None = None) -> bool:
    """거래일 && 정규장 시간(09:00~15:30 KST). is_trading_day None(캘린더 부재)은
    관용 기본(개장으로 간주) — live-path 정책(폴링을 막지 않음)."""
    now = now or datetime.now(_KST)
    today = now.strftime("%Y%m%d")
    if is_trading_day(today) is False:
        return False
    return _MARKET_OPEN <= now.timetz().replace(tzinfo=None) < _MARKET_CLOSE


def _is_trading_day_now(now: datetime | None = None) -> bool:
    """비거래일 상류 스킵 판정. None(캘린더 부재)은 관용 기본(거래일로 간주)."""
    now = now or datetime.now(_KST)
    return is_trading_day(now.strftime("%Y%m%d")) is not False


class KiwoomRankingsFetcher:
    """순위 스냅샷의 (kind, market, direction) TTL 캐시 + single-flight fetcher.

    동기 httpx 를 `asyncio.to_thread` 로 돌린다(stock_info 와 동형) — 폴링 주기가
    10s 라 비동기 클라이언트를 새로 들일 무게가 없다. 비거래일엔 상류를 건너뛰고
    빈 스냅샷(웜 캐시가 있으면 그 rows 유지)을 준다.
    """

    def __init__(
        self,
        token_provider: KiwoomTokenProvider,
        *,
        base_url: str = _BASE_REAL,
        _transport: httpx.BaseTransport | None = None,
        _now: Callable[[], datetime] | None = None,
    ):
        self._provider = token_provider
        self._client = httpx.Client(base_url=base_url, transport=_transport, timeout=10.0)
        # (kind, market, direction) → (snapshot, cached_at_ms)
        self._cache: dict[tuple[str, str, str], tuple[RankingSnapshot, int]] = {}
        self._flight = SingleFlight()
        self._now = _now  # 테스트 주입용 시각 소스

    def close(self) -> None:
        self._client.close()

    def _now_kst(self) -> datetime:
        return self._now() if self._now is not None else datetime.now(_KST)

    async def get(
        self, kind: RankingKind, market: Market, direction: Direction
    ) -> RankingSnapshot:
        # direction 은 change 에서만 의미 — 캐시 키를 갈라 상승/하락을 각각 캐시한다.
        key = (kind, market, direction if kind == "change" else "-")
        now_ms = int(time.time() * 1000)
        hit = self._cache.get(key)
        if hit is not None and now_ms - hit[1] < _CACHE_TTL_MS:
            return hit[0]
        async with self._flight.acquire(key):
            now_ms = int(time.time() * 1000)
            hit = self._cache.get(key)  # 대기 중 선행자가 채웠으면 재사용
            if hit is not None and now_ms - hit[1] < _CACHE_TTL_MS:
                return hit[0]
            now = self._now_kst()
            market_open = _market_open_now(now)
            if not _is_trading_day_now(now):
                # 비거래일: 상류 스킵. 웜 캐시 rows 는 유지하되 신선도·개장만 갱신.
                prev_rows = hit[0].rows if hit is not None else ()
                snap = RankingSnapshot(
                    kind=kind, market=market, direction=direction,
                    rows=prev_rows, market_open=False, fetched_at_ms=now_ms,
                )
                self._cache[key] = (snap, now_ms)
                return snap
            rows = await asyncio.to_thread(self._fetch_sync, kind, market, direction)
            snap = RankingSnapshot(
                kind=kind, market=market, direction=direction,
                rows=rows, market_open=market_open, fetched_at_ms=now_ms,
            )
            self._cache[key] = (snap, now_ms)
            return snap

    def _fetch_sync(
        self, kind: RankingKind, market: Market, direction: Direction
    ) -> tuple[RankingRow, ...]:
        spec = _KIND_SPEC[kind]
        token = self._provider.get_token()
        resp = self._client.post(
            _RKINFO_PATH,
            json=_build_body(kind, market, direction),
            headers={
                "Content-Type": "application/json;charset=UTF-8",
                "authorization": f"Bearer {token}",
                "api-id": spec.api_id,
            },
        )
        if resp.status_code != 200:  # noqa: PLR2004
            raise KiwoomRankingsError(
                f"{spec.api_id} HTTP {resp.status_code} {resp.text[:200]}"
            )
        body = resp.json()
        if body.get("return_code") != 0:
            raise KiwoomRankingsError(
                f"{spec.api_id} return_code={body.get('return_code')} {body.get('return_msg')}"
            )
        return parse_rankings(kind, body)
