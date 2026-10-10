"""키움 순위정보 fetcher — /live 우측 RightRail "순위" 드로어(특징주).

프로그램 순매수 금액 순위(ka90003)는 stkinfo 경로의 연속조회다. 공용 REST
거버너를 거쳐 시장별 상위 50개를 확보·병합하고 30초 동안 결과를 공유한다.
기관·외국인(ka10065)은 장중 추정 순매수 금액이며 거래소 지정이 없다.
순위 거래소는 null로 명시하고 선택 거래소의 ka10095 시세를 별도로 보완한다.

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
import math
import time
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import datetime, time as dt_time
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Literal

import httpx

from hoga.api.calendar import is_trading_day
from hoga.config import resolve_data_dir
from hoga.live import kiwoom_access, kiwoom_http, kiwoom_multi_quote, kiwoom_rest_runtime
from hoga.util.timeenc import KST

from .kiwoom_errors import KiwoomRestError
from .kiwoom_token_provider import KiwoomTokenProvider
from .kiwoom_venue import split_venue
from .single_flight import SingleFlight
from .venue import Venue

log = logging.getLogger(__name__)

# 정본은 hoga.util.timeenc.KST 하나다 — 벤더별로 다른 값이 아니다.
_KST = KST
_BASE_REAL = "https://api.kiwoom.com"
_RKINFO_PATH = "/api/dostk/rkinfo"
_CACHE_TTL_MS = 8_000
_NET_BUY_CACHE_TTL_MS = 30_000
_PROGRAM_LIMIT = 50
_INVESTOR_LIMIT = 100
_NET_BUY_MAX_PAGES = 8

# 정규장 시간(KST): 09:00 ~ 15:30. 이 창 밖이면 market_open=False → 프론트 폴링 정지
# (그릴링 결정 9: 장외엔 열 때 1회 조회 후 정지). 동시호가/시간외는 순위 갱신 관성이
# 커 별도 취급하지 않는다.
_MARKET_OPEN = dt_time(9, 0)
_MARKET_CLOSE = dt_time(15, 30)

RankingKind = Literal["change", "surge", "volume", "value", "program", "institution", "foreign"]
_INVESTOR_KINDS = ("institution", "foreign")
_NET_BUY_KINDS = ("program", *_INVESTOR_KINDS)
Market = Literal["all", "kospi", "kosdaq"]
Direction = Literal["up", "down"]

# 시장구분 mrkt_tp: zero-pad 문자열(공식 문서 관례). ⚠️ .NET enum 정수는 0/1/101 —
# 실콜로 zero-pad 여부 최종확정 필요(research §검증 필요 1).
_MARKET_CODE: dict[Market, str] = {"all": "000", "kospi": "001", "kosdaq": "101"}

#: 거래소구분 `stex_tp` — 벤더가 세 값을 지원한다(스펙: docs/research/
#: 2026-07-22-kiwoom-ranking-tr-spec.md §26). 예전엔 `"1"`(KRX) 하드코딩이었고
#: 근거가 *"기존 캡처가 KRX 기준"* 이었는데, 그건 **venue 축이 생기기 전** 이야기라
#: 더는 유효하지 않다(ADR-0140).
_STEX_BY_VENUE: dict[str, str] = {"KRX": "1", "NXT": "2", "UN": "3"}


class KiwoomRankingsError(RuntimeError):
    """순위 TR 호출/응답 실패 (HTTP 오류 또는 return_code != 0)."""


@dataclass(frozen=True)
class RankingRow:
    """공유 순위 행. 거래대금은 시장 종합에서 소비하며 드로어 열은 그대로 둔다."""

    rank: int
    code: str
    name: str
    price: int | None
    change_pct: float | None
    trade_value_won: int | None = None
    program_net_buy_won: int | None = None
    investor_net_buy_won: int | None = None


@dataclass(frozen=True)
class RankingSnapshot:
    kind: RankingKind
    market: Market
    direction: Direction
    rows: tuple[RankingRow, ...]
    market_open: bool
    fetched_at_ms: int
    #: 이 순위를 뽑은 거래소. 응답에 되싣어 프론트가 **받은 것이 무엇인지** 알게 한다
    #: — 요청 venue 를 그대로 믿으면 폴백이 생겼을 때 조용히 어긋난다.
    #: 기본값이라 맨 끝이다(dataclass 는 기본값 뒤에 비기본값을 못 둔다).
    venue: str | None = "KRX"
    # ka10065에는 거래소 입력이 없다. 순위의 거래소를 추정해 붙이지 않는다.
    # 보완 시세만 사용자가 고른 거래소를 따른다.
    quote_venue: str | None = None


@dataclass(frozen=True)
class _KindSpec:
    api_id: str
    wrapper_key: str


_KIND_SPEC: dict[RankingKind, _KindSpec] = {
    "change": _KindSpec("ka10027", "pred_pre_flu_rt_upper"),
    "surge": _KindSpec("ka10023", "trde_qty_sdnin"),
    "volume": _KindSpec("ka10030", "tdy_trde_qty_upper"),
    "value": _KindSpec("ka10032", "trde_prica_upper"),
    "program": _KindSpec("ka90003", "prm_netprps_upper_50"),
    "institution": _KindSpec("ka10065", "opmr_invsr_trde_upper"),
    "foreign": _KindSpec("ka10065", "opmr_invsr_trde_upper"),
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


def _trade_value_won(raw: object) -> int | None:
    """ka10032 trde_prica (백만원) → 원. 결측·비유한·음수는 0으로 꾸미지 않는다."""
    value = _signed_float(raw)
    if value is None or not math.isfinite(value) or value < 0:
        return None
    return round(value * 1_000_000)


def _net_buy_won(raw: object) -> int | None:
    """ka90003/ka10065의 부호 있는 백만원 금액. 결측·음수를 보존한다."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        value = Decimal(raw.strip().replace(",", ""))
    except InvalidOperation:
        return None
    return int(value * 1_000_000) if value.is_finite() else None


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
        # `stex_tp` 가 KRX 가 아니면 벤더가 **venue 접미를 그대로 에코**한다
        # (`064550_AL`). 접미는 wire 인코딩이지 종목 식별자가 아니므로 파스 경계에서
        # 벗긴다 — 여기서 새지 않게 하는 것이 계약이다(#1124 와 같은 부류).
        # 새면 두 곳이 조용히 깨졌다: ① 프론트 workarea 코드 공간은 6자리 전용이라
        # 순위 행을 클릭하면 `/api/live/past-daily-candles` 가 422(INVALID_CODE),
        # ② 아래 라우트의 `exclude_etf` 가 심볼 마스터 코드와 영영 불일치해 **경고
        # 없이 무동작**(마스터는 로드돼 있으니 etf_filter_unavailable 도 안 뜬다).
        bare_code, _venue = split_venue(code.strip())
        rows.append(
            RankingRow(
                rank=i,
                code=bare_code,
                name=name.strip() if isinstance(name, str) else "",
                price=_abs_price(item.get("cur_prc")),
                change_pct=_signed_float(item.get("flu_rt")),
                trade_value_won=_trade_value_won(item.get("trde_prica")) if kind == "value" else None,
                program_net_buy_won=_net_buy_won(item.get("prm_netprps_amt"))
                if kind == "program" else None,
                investor_net_buy_won=_net_buy_won(item.get("netslmt"))
                if kind in _INVESTOR_KINDS else None,
            )
        )
    return tuple(rows)


def _build_body(
    kind: RankingKind, market: Market, direction: Direction, venue: str = "KRX",
) -> dict[str, str]:
    """kind 별 요청 body. 조건 파라미터는 전체(0) 기본값 — 필터는 mrkt_tp·stex_tp.

    `mrkt_tp`(코스피/코스닥)와 `stex_tp`(KRX/NXT/통합)는 **다른 축**이다 — 둘 다
    필터이고 서로 직교한다. 모르는 venue 는 KRX 로 떨어진다(기존 동작 보존).
    """
    if kind in _NET_BUY_KINDS:
        raise ValueError("순매수 순위는 공용 REST 연속조회 경로를 사용해야 합니다")
    mrkt = _MARKET_CODE[market]
    stex = _STEX_BY_VENUE.get(venue, "1")
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
            "stex_tp": stex,
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
            "stex_tp": stex,
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
            "stex_tp": stex,
        }
    # value — ka10032 거래대금상위 (정렬 파라미터 없음)
    return {
        "mrkt_tp": mrkt,
        "mang_stk_incls": "0",
        "stex_tp": stex,
    }


def _market_open_now(now: datetime | None = None, venue: str = "KRX") -> bool:
    """거래일 && 시행일·거래소별 거래 시간. is_trading_day None(캘린더 부재)은
    관용 기본(개장으로 간주) — live-path 정책(폴링을 막지 않음)."""
    now = now or datetime.now(_KST)
    today = now.strftime("%Y%m%d")
    if now.weekday() >= 5 or is_trading_day(today) is False:  # noqa: PLR2004 — Saturday/Sunday
        return False
    from hoga.live.stock_sessions import krx_aftermarket_window  # noqa: PLC0415

    clock = now.timetz().replace(tzinfo=None)
    if venue in ("NXT", "UN"):
        return dt_time(8, 0) <= clock < dt_time(20, 0)
    return _MARKET_OPEN <= clock < _MARKET_CLOSE or krx_aftermarket_window(int(now.timestamp() * 1000))


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
        data_dir: Path | None = None,
    ):
        self._provider = token_provider
        self._client = httpx.Client(
            base_url=base_url,
            # 주입이 이긴다(테스트 MockTransport). 기본은 연결 재사용 + 연결 단계
            # 재시도 — 근거·함정은 `kiwoom_http` 도크스트링.
            transport=_transport or kiwoom_http.sync_transport(),
            timeout=10.0,
        )
        # (kind, market, direction) → (snapshot, cached_at_ms)
        self._cache: dict[tuple[str, ...], tuple[RankingSnapshot, int]] = {}
        self._flight = SingleFlight()
        self._now = _now  # 테스트 주입용 시각 소스
        self._data_dir = data_dir

    def close(self) -> None:
        self._client.close()

    def _now_kst(self) -> datetime:
        return self._now() if self._now is not None else datetime.now(_KST)

    def _market_open(self, kind: RankingKind, now: datetime, venue: str) -> bool:
        if kind in _INVESTOR_KINDS:
            # 장중 잠정치는 정규장에 갱신한다. NXT 시세를 붙여도 순위 갱신 창을
            # NXT 야간 세션까지 연장하지 않는다.
            return _is_trading_day_now(now) and _MARKET_OPEN <= now.time() < _MARKET_CLOSE
        return _market_open_now(now, venue)

    async def get(
        self, kind: RankingKind, market: Market, direction: Direction,
        venue: str = "KRX",
    ) -> RankingSnapshot:
        # direction 은 change 에서만 의미 — 캐시 키를 갈라 상승/하락을 각각 캐시한다.
        # ⚠ venue 도 키에 있어야 한다. 없으면 NXT 요청이 30초 TTL 안에서 KRX 순위를
        # 그대로 받는다 — 값이 그럴듯해 화면에서 안 드러난다.
        now = self._now_kst()
        key = (kind, market, direction if kind == "change" else "-", venue)
        ttl_ms = _CACHE_TTL_MS
        if kind in _NET_BUY_KINDS:
            direction = "up"  # 이 탭은 순매수 금액 상위이며 등락률 방향과 무관하다.
            day = now.strftime("%Y%m%d")
            key += (day,)
            # 순매수 순위의 전일 캐시를 다음 거래일/휴장일에 재사용하지 않는다.
            self._cache = {
                k: v for k, v in self._cache.items() if k[0] not in _NET_BUY_KINDS or k[-1] == day
            }
            ttl_ms = _NET_BUY_CACHE_TTL_MS if self._market_open(kind, now, venue) else 60_000
        snapshot_venue = None if kind in _INVESTOR_KINDS else venue
        quote_venue = venue if kind in _INVESTOR_KINDS else None
        now_ms = int(time.time() * 1000)
        hit = self._cache.get(key)
        if hit is not None and now_ms - hit[1] < ttl_ms:
            return hit[0]
        async with self._flight.acquire(key):
            now_ms = int(time.time() * 1000)
            hit = self._cache.get(key)  # 대기 중 선행자가 채웠으면 재사용
            if hit is not None and now_ms - hit[1] < ttl_ms:
                return hit[0]
            now = self._now_kst()
            market_open = self._market_open(kind, now, venue)
            if not _is_trading_day_now(now):
                # 비거래일: 상류 스킵. 웜 캐시 rows 는 유지하되 신선도·개장만 갱신.
                prev_rows = hit[0].rows if hit is not None else ()
                snap = RankingSnapshot(
                    kind=kind, market=market, direction=direction,
                    rows=prev_rows, market_open=False, fetched_at_ms=now_ms,
                    venue=snapshot_venue, quote_venue=quote_venue,
                )
                self._cache[key] = (snap, now_ms)
                return snap
            if kind == "program":
                rows = await self._fetch_program(market, venue)
            elif kind in _INVESTOR_KINDS:
                rows = await self._fetch_investor(kind, market, venue)
            else:
                rows = await asyncio.to_thread(self._fetch_sync, kind, market, direction, venue)
            now_ms = int(time.time() * 1000)
            snap = RankingSnapshot(
                kind=kind, market=market, direction=direction,
                rows=rows, market_open=market_open, fetched_at_ms=now_ms,
                venue=snapshot_venue, quote_venue=quote_venue,
            )
            self._cache[key] = (snap, now_ms)
            return snap

    async def _fetch_investor(
        self, kind: RankingKind, market: Market, venue: Venue,
    ) -> tuple[RankingRow, ...]:
        """기관계/외국인 장중 추정 순매수 금액 + 선택 거래소의 배치 시세.

        ka10065는 거래소·날짜 입력이 없으며 amt_qty_tp=1의 netslmt는 백만원.
        ka90009(일자별, 천만원)와 단위·자료 성격이 다르다.
        """
        data_dir = self._data_dir or resolve_data_dir()
        client = kiwoom_rest_runtime.ensure_rest_client(data_dir)
        if client is None:
            raise KiwoomRankingsError("kiwoom client not initialized")
        scheduler = kiwoom_rest_runtime.ensure_scheduler(data_dir)
        body = {
            "trde_tp": "1", "mrkt_tp": _MARKET_CODE[market],
            "orgn_tp": "9999" if kind == "institution" else "9000", "amt_qty_tp": "1",
        }

        async def run_page(fetch_fn, page_idx):
            page = await kiwoom_access.run_with_capacity(
                scheduler, key=("investor-rankings", kind, market, page_idx),
                api_id="ka10065", priority="user_visible", client=client, fetch_fn=fetch_fn,
            )
            if not isinstance(page.raw.get("opmr_invsr_trde_upper"), list):
                raise KiwoomRankingsError("투자자 순위 응답 형식이 올바르지 않습니다")
            if page.cont and not page.next_key:
                raise KiwoomRankingsError("투자자 순위 연속 조회 키가 없습니다")
            return page

        try:
            raw, truncated = await client.walk(
                "ka10065", body, max_pages=_NET_BUY_MAX_PAGES,
                stop=lambda rows, _page: len(rows) >= _INVESTOR_LIMIT, run_page=run_page,
            )
            if truncated:
                raise KiwoomRankingsError("투자자 순위 연속 조회 한도에 도달했습니다")
            parsed = parse_rankings(kind, {"opmr_invsr_trde_upper": raw})
            ordered = sorted(
                (r for r in parsed if r.investor_net_buy_won is not None and r.investor_net_buy_won > 0),
                key=lambda r: (-(r.investor_net_buy_won or 0), r.code),
            )
            by_code: dict[str, RankingRow] = {}
            for row in ordered:
                by_code.setdefault(row.code, row)
            rows = sorted(by_code.values(), key=lambda r: (-(r.investor_net_buy_won or 0), r.code))[:_INVESTOR_LIMIT]
            if not rows:
                return ()
            quotes = await kiwoom_access.run_with_capacity(
                scheduler, key=("investor-ranking-quotes", venue, tuple(r.code for r in rows)),
                api_id="ka10095", priority="user_visible", client=client,
                fetch_fn=lambda picked: kiwoom_multi_quote.fetch_chunk(
                    picked, [r.code for r in rows], venue=venue,
                ),
            )
        except KiwoomRestError as exc:
            raise KiwoomRankingsError(str(exc)) from exc
        by_code_quote = {q.code: q for q in quotes}
        return tuple(
            replace(
                row, rank=i,
                price=by_code_quote[row.code].price if row.code in by_code_quote else None,
                change_pct=by_code_quote[row.code].change_pct if row.code in by_code_quote else None,
            )
            for i, row in enumerate(rows, 1)
        )

    async def _fetch_program(self, market: Market, venue: str) -> tuple[RankingRow, ...]:
        """시장별 상위 50개를 조회해 전체 시장에서는 순매수 금액으로 병합한다.

        실측: 한 페이지 15개이며 50위 뒤로도 커서가 계속된다. 50개를 확보한
        시점에 멈추고, 각 페이지를 공용 거버너에 제출해 유량·인증 복구를 공유한다.
        """
        data_dir = self._data_dir or resolve_data_dir()
        client = kiwoom_rest_runtime.ensure_rest_client(data_dir)
        if client is None:
            raise KiwoomRankingsError("kiwoom client not initialized")
        scheduler = kiwoom_rest_runtime.ensure_scheduler(data_dir)
        markets = ("kospi", "kosdaq") if market == "all" else (market,)

        async def fetch_market(selected_market: str) -> tuple[RankingRow, ...]:
            body = {
                "trde_upper_tp": "2", "amt_qty_tp": "1",
                "mrkt_tp": "P00101" if selected_market == "kospi" else "P10102",
                "stex_tp": _STEX_BY_VENUE[venue],
            }

            async def run_page(fetch_fn, page_idx):
                page = await kiwoom_access.run_with_capacity(
                    scheduler, key=("program-rankings", selected_market, venue, page_idx),
                    api_id="ka90003", priority="user_visible", client=client, fetch_fn=fetch_fn,
                )
                if not isinstance(page.raw.get("prm_netprps_upper_50"), list):
                    raise KiwoomRankingsError("프로그램 순위 응답 형식이 올바르지 않습니다")
                if page.cont and not page.next_key:
                    raise KiwoomRankingsError("프로그램 순위 연속 조회 키가 없습니다")
                return page

            raw, truncated = await client.walk(
                "ka90003", body, max_pages=_NET_BUY_MAX_PAGES,
                stop=lambda rows, _page: len(rows) >= _PROGRAM_LIMIT, run_page=run_page,
            )
            if truncated:
                raise KiwoomRankingsError("프로그램 순위 연속 조회 한도에 도달했습니다")
            return parse_rankings("program", {"prm_netprps_upper_50": raw[:_PROGRAM_LIMIT]})

        try:
            batches = await asyncio.gather(*(fetch_market(m) for m in markets))
        except KiwoomRestError as exc:
            raise KiwoomRankingsError(str(exc)) from exc
        by_code: dict[str, RankingRow] = {}
        for batch in batches:
            for row in batch:
                if row.program_net_buy_won is not None and row.program_net_buy_won > 0:
                    by_code.setdefault(row.code, row)
        ordered = sorted(by_code.values(), key=lambda r: (-(r.program_net_buy_won or 0), r.code))
        return tuple(replace(row, rank=i) for i, row in enumerate(ordered[:_PROGRAM_LIMIT], 1))

    def _fetch_sync(
        self, kind: RankingKind, market: Market, direction: Direction,
        venue: str = "KRX",
    ) -> tuple[RankingRow, ...]:
        spec = _KIND_SPEC[kind]
        token = self._provider.get_token()
        resp = self._client.post(
            _RKINFO_PATH,
            json=_build_body(kind, market, direction, venue),
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
