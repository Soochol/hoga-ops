"""지수선물 시세 런타임 — 마스터 캐시 + 라인업 + 세션 판정 (`/market` 선물 토글).

응답 TTL·단일비행·last-good 은 여기 없다 — `market_routes._TtlCache` 가 이미 그 네
규약을 봉인하고 있어 두 벌로 두면 어느 쪽이 늦었는지 알 수 없어진다. 이 모듈은
**"지금 한 번 가져오기"** 와 그에 필요한 마스터 캐시만 맡는다.

**세션 판정을 주식 것으로 대신하면 안 된다.** `session_gate.market_phase` 는 주식
정규장(09:00–15:30)이고 선물은 15:45 까지다. 게다가 선물엔 야간장이 있어 **날짜
경계가 어긋난다** — 새벽 02:00 은 "오늘" 이 아니라 **전 거래일의 야간장**이다.
거기서 `is_trading_day_now()` 를 그대로 부르면 토요일 새벽(=금요일 야간장)이
비거래일로 판정된다. 그래서 거래일 술어만 재사용하고 시계는 여기서 따로 읽는다.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import logging
import time
from dataclasses import dataclass, replace
from typing import Any, Literal

from hoga.api.kis_futures_master import (
    FuturesMasterRow,
    FuturesProduct,
    KisFuturesMasterFetchError,
    fetch_futures_master,
    near_month,
)
from hoga.live.kis_futures_endpoints import FuturesQuote
from hoga.util.timeenc import KST

log = logging.getLogger(__name__)

#: 마스터는 하루 단위로 바뀐다 — 일중 재다운로드는 낭비다(옵션 런타임과 같은 값).
_MASTER_TTL_S = 6 * 3600.0

FuturesSession = Literal["day", "night", "closed"]


@dataclass(frozen=True)
class FuturesLineupItem:
    """카드 1장의 정체성. `product` 는 마스터 쪽, `underlying_id` 는 현물 카드 쪽 키다."""
    id: str
    product: FuturesProduct
    label: str
    #: 대응하는 현물 지수(`LiveIndexId`). None 이면 토글 짝이 없는 **선물 전용 카드**다.
    underlying_id: str | None


#: 화면 라인업. 미니(`kospi200_mini`)는 일부러 뺐다 — 계약 승수가 달라 정규와
#: 거래량·미결제를 나란히 두면 합산으로 오독된다. 마스터 파서는 미니도 읽으므로
#: 필요해지면 여기 한 줄만 늘리면 된다.
LINEUP: tuple[FuturesLineupItem, ...] = (
    FuturesLineupItem(
        id="KOSPI200_F", product="kospi200", label="KOSPI 200 F", underlying_id="KOSPI200"
    ),
    FuturesLineupItem(
        id="KOSDAQ150_F", product="kosdaq150", label="KOSDAQ 150 F", underlying_id="KOSDAQ150"
    ),
    # VKOSPI 는 현물 지수 카드가 없다(`index_registry` 에 없음) — 토글 짝 없는 단독 카드다.
    FuturesLineupItem(id="VKOSPI_F", product="vkospi", label="VKOSPI F", underlying_id=None),
)

# 선물 거래시간(KST). 주간은 주식보다 15분 길고, 야간은 자정을 넘는다.
_DAY_OPEN_MIN = 9 * 60
_DAY_CLOSE_MIN = 15 * 60 + 45
_NIGHT_OPEN_MIN = 18 * 60
#: 야간 종료 05:00 — KRX 자체 야간시장(2025-06-09 CME/EUREX 연계 종료 후) 기준이다.
#: 실측으로 확인한 것은 23:50 에 틱이 온다는 것까지이고, 새벽 경계는 문서값이다.
#: 어긋나면 증상은 "새벽에 카드가 live 라고 표시되는데 값이 안 변함" 이다.
_NIGHT_CLOSE_MIN = 5 * 60


def _is_trading_day(date: dt.date) -> bool:
    """캘린더 술어. 모름(`None`)은 **거래일로 본다** — 시드 범위 밖에서 카드를 조용히
    끄는 것보다, 값이 안 변하는 것으로 사용자가 알아채는 편이 낫다."""
    from hoga.api.calendar import is_trading_day  # noqa: PLC0415 — 지연 import(순환 회피)

    return is_trading_day(date.strftime("%Y%m%d")) is not False


def futures_session(t_ms: int) -> FuturesSession:
    """이 시각에 열려 있는 선물 세션. **블로킹**(캘린더 조회) — to_thread 로 부를 것.

    새벽 구간은 **전날** 거래일 여부를 본다. 야간장이 자정을 넘기 때문이다.
    """
    now = dt.datetime.fromtimestamp(t_ms / 1000, KST)
    minute = now.hour * 60 + now.minute
    if minute < _NIGHT_CLOSE_MIN:
        # 00:00–05:00 — 전 거래일 야간장의 연장이다.
        return "night" if _is_trading_day(now.date() - dt.timedelta(days=1)) else "closed"
    if _DAY_OPEN_MIN <= minute < _DAY_CLOSE_MIN:
        return "day" if _is_trading_day(now.date()) else "closed"
    if minute >= _NIGHT_OPEN_MIN:
        return "night" if _is_trading_day(now.date()) else "closed"
    return "closed"


#: 마지막 거래일을 찾을 때 거슬러 올라갈 최대 일수(연휴 대비).
_MAX_LOOKBACK_DAYS = 10


def spark_date(t_ms: int) -> str:
    """스파크라인이 그릴 **주간장**의 날짜. 블로킹(캘린더) — to_thread 로 부를 것.

    REST 분봉은 주간 데이터만 준다. 그래서 기준은 "지금" 이 아니라 **마지막으로
    주간장이 있었던 거래일**이다:

    - 새벽(00:00–05:00)은 야간장 진행 중이지만 그 야간장의 주간은 **전날**이다.
    - 주말·휴장이면 거슬러 올라간다. 안 그러면 토요일에 카드 값(금요일 종가)은
      있는데 스파크라인만 사라진다.
    """
    now = dt.datetime.fromtimestamp(t_ms / 1000, KST)
    minute = now.hour * 60 + now.minute
    ref = now.date() - dt.timedelta(days=1) if minute < _NIGHT_CLOSE_MIN else now.date()
    for _ in range(_MAX_LOOKBACK_DAYS):
        if _is_trading_day(ref):
            break
        ref -= dt.timedelta(days=1)
    return ref.strftime("%Y%m%d")


#: 스파크라인 최소 점 수. 야간 봉이 이보다 적으면 주간 모양으로 폴백한다 —
#: 야간 개장 직후(18:00~18:10)가 그 구간이다. 한 점짜리 선은 거짓 정보다.
_MIN_SPARK_POINTS = 2


@dataclass(frozen=True)
class SparkSeries:
    """스파크라인 1개분 + **어느 세션 모양인지**.

    세션을 실어야 화면이 시세 배지와 그림이 어긋나지 않았는지 말할 수 있다 —
    값은 야간인데 그림이 주간이면 사용자는 그 하락이 야간에 일어난 줄로 읽는다.
    """
    closes: tuple[float, ...]
    day_open: float | None
    session: FuturesSession
    #: 야간 시리즈의 관측 구간. **주간은 None** — REST 는 날짜를 지정해 언제든 다시
    #: 받을 수 있어서 "놓친 구간" 이라는 개념이 없다. 야간만 재구성이 불가능하다.
    coverage: Any = None


@dataclass(frozen=True)
class FuturesCard:
    """카드 1장분 — 정체성 + 값 + **그 값이 어느 세션 것인지**."""
    item: FuturesLineupItem
    quote: FuturesQuote
    #: 값이 속한 세션. `FuturesSnapshot.session` 과 다르면 낡은 값이다.
    #:
    #: **종목마다 다를 수 있다.** 야간 유동성이 상품별로 크게 갈리기 때문이다 —
    #: 2026-08-07 00:36 실측 40초에 KOSPI200 48틱 / 코스닥150 0틱 / VKOSPI 0틱.
    #: 스냅샷 하나에 세션을 매달면 그 순간 카드 둘 중 하나는 반드시 거짓말을 한다.
    data_session: FuturesSession


@dataclass(frozen=True)
class FuturesSnapshot:
    cards: tuple[FuturesCard, ...]
    #: 지금 열려 있는 세션(시계·캘린더 기준).
    session: FuturesSession
    #: 휴면 사유. None 이면 정상.
    unavailable: str | None


class FuturesQuotesRuntime:
    """프로세스 싱글턴. 마스터를 캐시하고 라인업 근월물 시세를 한 번에 가져온다."""

    def __init__(self, client_factory) -> None:
        # client_factory: () -> KisClient | None  (자격증명 없으면 None)
        self._client_factory = client_factory
        self._master: list[FuturesMasterRow] | None = None
        self._master_at = 0.0
        self._master_lock = asyncio.Lock()
        # 야간 WS 는 필요할 때 처음 만든다 — 주간에만 도는 프로세스가 websockets 를
        # import 할 이유가 없다.
        self._ws: Any = None

    async def aclose(self) -> None:
        if self._ws is not None:
            await self._ws.aclose()

    async def _ensure_master(self) -> list[FuturesMasterRow]:
        # 락 밖 빠른 경로 — 대부분의 호출이 여기서 끝난다.
        if self._master is not None and time.monotonic() - self._master_at < _MASTER_TTL_S:
            return self._master
        async with self._master_lock:
            if self._master is not None and time.monotonic() - self._master_at < _MASTER_TTL_S:
                return self._master
            rows = await asyncio.to_thread(fetch_futures_master)
            self._master = rows
            self._master_at = time.monotonic()
            return rows

    async def snapshot(self) -> FuturesSnapshot:
        """라인업 전체의 근월물 시세. 실패는 사유를 실어 돌려준다(빈 응답과 구분).

        **부분 성공을 허용한다** — 한 상품이 롤오버 직후라 조회에 실패해도 나머지
        카드는 살아야 한다. 전부 실패하면 quotes 가 비고 호출자가 last-good 을 유지한다.
        """
        now_ms = int(dt.datetime.now(KST).timestamp() * 1000)
        session = await asyncio.to_thread(futures_session, now_ms)

        client = self._client_factory()
        if client is None:
            return FuturesSnapshot((), session, unavailable="credentials_missing")

        try:
            master = await self._ensure_master()
        except KisFuturesMasterFetchError as e:
            log.warning("선물 마스터 실패: %s", e)
            return FuturesSnapshot((), session, unavailable="futures_master_unavailable")

        rows: list[FuturesMasterRow] = []
        items: list[FuturesLineupItem] = []
        for item in LINEUP:
            try:
                rows.append(near_month(master, item.product))
            except KisFuturesMasterFetchError as e:
                # 상품 하나가 마스터에서 사라지는 것은 라인업 오류지 런타임 오류가 아니다.
                log.warning("선물 근월물 없음 product=%s: %s", item.product, e)
                continue
            items.append(item)

        # REST 는 세션과 무관하게 **주간** 값을 준다(야간에도 15:45 스냅샷에 동결).
        # 야간 실시간은 WS 에서만 오므로, 아래에서 종목별로 덮어쓴다.
        quotes = await client.fetch_futures_quotes(rows)
        by_code = {q.code: q for q in quotes}
        ticks = await self._night_ticks(session, tuple(r.code for r in rows))

        cards: list[FuturesCard] = []
        for item, row in zip(items, rows, strict=True):
            quote = by_code.get(row.code)
            if quote is None:
                continue
            tick = ticks.get(row.code)
            if tick is None:
                # 야간이어도 틱이 없으면 주간 마감본이 **옳은 값**이다. 유동성이 낮은
                # 상품은 야간 내내 무음일 수 있다(실측: 코스닥150·VKOSPI).
                cards.append(FuturesCard(item, quote, "day"))
                continue
            cards.append(
                FuturesCard(
                    item,
                    replace(
                        quote,
                        value=tick.price,
                        change=tick.change,
                        change_rate=tick.change_rate,
                        volume=tick.volume,
                        open_interest=tick.open_interest,
                        oi_change=tick.oi_change,
                        market_basis=tick.market_basis,
                        t_ms=tick.t_ms,
                    ),
                    "night",
                )
            )
        return FuturesSnapshot(tuple(cards), session, unavailable=None)

    async def _night_ticks(self, session: FuturesSession, codes: tuple[str, ...]) -> dict:
        """야간이면 WS 를 깨우고 최신 틱을, 아니면 빈 dict 를 돌려준다.

        **야간이 아니면 세션을 닫는다** — 주간에 WS 슬롯을 쥐고 있을 이유가 없고,
        REST 가 이미 실시간이라 틱이 있어도 쓰지 않는다.
        """
        if session != "night" or not codes:
            if self._ws is not None:
                await self._ws.aclose()
            return {}
        if self._ws is None:
            from hoga.live.kis_futures_ws import KisFuturesNightWs  # noqa: PLC0415
            from hoga.live.kis_runtime import (  # noqa: PLC0415
                ensure_kis_approval_provider_from_env,
            )

            # 승인키는 REST 토큰과 다른 자격이라 provider 도 따로다. 팩토리로 넘겨
            # 무자격 환경에서 httpx 클라이언트를 만들지 않는다.
            self._ws = KisFuturesNightWs(ensure_kis_approval_provider_from_env)
        # 세션 날짜는 봉 리셋 기준이다 — `spark_date` 와 같은 규칙(새벽은 전날)을 써야
        # 저녁·새벽 봉이 한 세션으로 이어진다.
        now_ms = int(dt.datetime.now(KST).timestamp() * 1000)
        session_day = await asyncio.to_thread(spark_date, now_ms)
        await self._ws.ensure_running(codes, session_day=session_day)
        return {code: tick for code in codes if (tick := self._ws.latest(code)) is not None}

    async def sparks(self) -> dict[str, SparkSeries]:
        """라인업의 5분봉 종가 — `{카드 id: SparkSeries}`.

        quotes 와 **캐시를 나눈 이유**는 갱신 축이 다르기 때문이다: 시세는 20초마다
        의미가 바뀌지만 5분봉은 5분에 한 번만 늘어난다. 한 캐시에 묶으면 분봉 3콜이
        시세 주기로 끌려 올라간다.

        **소스는 종목마다 갈린다** — 시세 카드와 정확히 같은 규칙이다. 야간 봉이
        충분히 쌓인 종목은 야간 모양을, 무음인 종목은 그날 주간장 모양을 그린다.
        섞으면 값은 야간인데 그림은 주간인 카드가 생긴다.
        """
        client = self._client_factory()
        if client is None:
            return {}
        try:
            master = await self._ensure_master()
        except KisFuturesMasterFetchError:
            return {}

        now_ms = int(dt.datetime.now(KST).timestamp() * 1000)
        date = await asyncio.to_thread(spark_date, now_ms)

        async def one(item: FuturesLineupItem) -> tuple[str, SparkSeries] | None:
            try:
                row = near_month(master, item.product)
            except KisFuturesMasterFetchError:
                return None

            # **그림의 소스를 값의 소스와 강제로 일치시킨다.** 판정 기준은 시세 카드와
            # 똑같이 "틱이 왔는가" 다(`snapshot` 의 `data_session`).
            #
            # 틱이 있는데 봉이 아직 2개가 안 되는 구간(야간 개장 직후 ~10분)에
            # 주간 그림으로 폴백하면, 값은 야간인데 그림은 주간인 카드가 된다 —
            # 사용자는 그날 주간 하락을 **야간에 일어난 것**으로 읽는다. 그래서
            # 그 구간은 아무것도 그리지 않는다(없는 편이 거짓보다 낫다).
            if self._ws is not None and self._ws.latest(row.code) is not None:
                night = self._ws.night_series(row.code)
                if len(night) < _MIN_SPARK_POINTS:
                    return None
                # 기준선을 주지 않는다 — 야간 시가가 곧 첫 점이라 Sparkline 이 알아서
                # 쓴다. 주간 시가를 기준선으로 주면 야간 등락을 주간 대비로 색칠한다.
                #
                # 커버리지를 함께 싣는다. 스파크라인엔 축이 없어서 18:00 부터 8시간을
                # 그린 선과 02:00 부터 10분을 그린 선이 화면에서 구별되지 않는다 —
                # 재시작·유휴 정지로 앞이 잘렸다는 사실은 응답이 말해야 한다.
                return item.id, SparkSeries(night, None, "night", self._ws.night_coverage())

            try:
                spark = await client.fetch_futures_spark(row, date_yyyymmdd=date)
            except Exception as e:  # noqa: BLE001 — 스파크라인은 장식이다. 카드를 죽이지 않는다.
                log.debug("선물 스파크라인 실패 id=%s: %s", item.id, e)
                return None
            if spark is None:
                return None
            return item.id, SparkSeries(spark.closes, spark.day_open, "day")

        results = await asyncio.gather(*(one(i) for i in LINEUP))
        return {item_id: series for got in results if got is not None for item_id, series in [got]}
