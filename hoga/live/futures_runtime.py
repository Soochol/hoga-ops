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
from pathlib import Path
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
#:
#: **VKOSPI 선물(`A04608`)도 뺐다 — 상품이 죽어 있다.** 2026-08-07 실측: 미결제
#: 54계약 · 당일 거래량 0 이라 벤더가 정산가를 현재가로 되돌려주고(`futs_prpr` =
#: `futs_prdy_clpr` = 73.50, 등락 0.00), 5분봉 TR 은 `rt_cd=0` 정상처리로 **0봉**을
#: 준다(스파크라인이 빈 이유 — 에러가 아니다). 롤오버해도 같다. 화면의 변동성 카드는
#: 키움 ka20003 의 업종행 `603`(같은 시각 75.97 · -1.56%)이 대신한다 — 실시간·폴링은
#: 키움이라는 ADR-0136 분담과도 맞다.
LINEUP: tuple[FuturesLineupItem, ...] = (
    FuturesLineupItem(
        id="KOSPI200_F", product="kospi200", label="KOSPI 200 F", underlying_id="KOSPI200"
    ),
    FuturesLineupItem(
        id="KOSDAQ150_F", product="kosdaq150", label="KOSDAQ 150 F", underlying_id="KOSDAQ150"
    ),
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
        #: 종목별 마지막 성공 REST 시세. **야간에 REST 실패를 견디기 위한 것**이고,
        #: 쓰이는 것은 정적 메타데이터(만기·최종거래일·남은 일수)뿐이다 — 값은 틱이
        #: 덮어쓴다(`snapshot` 참조). 그 필드들은 하루 단위로만 바뀌어 낡아도 무해하다.
        self._last_quotes: dict[str, FuturesQuote] = {}
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
        self._last_quotes.update(by_code)
        ticks = await self._night_ticks(session, tuple(r.code for r in rows))

        cards: list[FuturesCard] = []
        for item, row in zip(items, rows, strict=True):
            tick = ticks.get(row.code)
            quote = by_code.get(row.code)
            if quote is None and tick is not None:
                # **야간 틱이 있으면 REST 실패를 견딘다.** 야간 REST 는 어차피 주간
                # 마감본(15:45 동결)이라 값으로서 아무 정보가 없는데, 그게 안 왔다는
                # 이유로 살아 있는 실시간 값까지 버리면 **카드가 통째로 사라진다** —
                # 화면에서는 토글이 없어져 "선물 기능이 사라진" 것으로 보인다.
                # 실측(2026-08-07 21:4x, 25초 간격 6회): 부분 실패 4회, 빠지는 종목은
                # 매번 달랐다(무작위 — 종목 특성이 아니다).
                #
                # 이때 쓰는 것은 옛 값이 아니라 **정적 메타데이터**뿐이다. 값·등락·
                # 거래량·미결제·베이시스·괴리율은 아래에서 틱이 전부 덮어쓰고, 남는 것은
                # 만기·최종거래일·남은 일수뿐이라 하루 단위로만 바뀐다.
                quote = self._last_quotes.get(row.code)
            if quote is None:
                # 틱도 없고 REST 도 없다 — 값을 지어내지 않는다. 주간 부분 실패가 여기다:
                # 그쪽은 REST 가 유일한 실시간 소스라, 옛 값을 최신인 척 그리는 것보다
                # 카드를 비우는 편이 정직하다(다음 폴링이면 대개 복구된다).
                continue
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
                        # **전일 종가는 틱에서 되계산한다.** REST 것을 그대로 두면
                        # last-good 을 쓴 경로에서 어제 값이 남을 수 있고, 그러면
                        # 등락과 기준선이 서로 다른 날을 가리킨다.
                        prev_close=tick.price - tick.change,
                        volume=tick.volume,
                        open_interest=tick.open_interest,
                        oi_change=tick.oi_change,
                        market_basis=tick.market_basis,
                        disparity=tick.disparity,
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

    async def ensure_night_stream(self) -> bool:
        """야간이면 WS 를 깨워 두고, 아니면 닫는다. **REST 는 건드리지 않는다.**

        스케줄러 keeper 가 부른다. `snapshot()` 을 대신 부르면 안 되는 이유는 야간
        REST 가 주간 마감본에 동결돼 있어서다(모듈 docstring) — 아무도 안 보는 밤에
        60초마다 의미 없는 시세 TR 을 태우게 된다.

        돌아오는 값은 "야간 스트림을 유지했는가". 세션 밖·무자격·마스터 실패가 모두
        False 이고, **셋 다 정상 경로**다(로그 수준이 다른 이유).
        """
        now_ms = int(dt.datetime.now(KST).timestamp() * 1000)
        session = await asyncio.to_thread(futures_session, now_ms)
        if session != "night":
            # 세션 밖 — 슬롯을 붙들지 않는다. codes 가 비면 `_night_ticks` 가 닫는다.
            await self._night_ticks(session, ())
            return False
        if self._client_factory() is None:
            return False
        try:
            master = await self._ensure_master()
        except KisFuturesMasterFetchError as e:
            log.warning("야간 keeper: 선물 마스터 실패: %s", e)
            return False

        codes: list[str] = []
        for item in LINEUP:
            try:
                codes.append(near_month(master, item.product).code)
            except KisFuturesMasterFetchError:
                continue
        if not codes:
            return False
        await self._night_ticks(session, tuple(codes))
        return True

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


# ── 프로세스 싱글턴 배선 ────────────────────────────────────────────────────

_RUNTIME: FuturesQuotesRuntime | None = None


def ensure_runtime(data_dir: Path | None) -> FuturesQuotesRuntime:
    """이 프로세스의 유일한 런타임.

    **싱글턴이 규율이 아니라 요구사항이다.** 이 런타임이 야간 WS 를 소유하는데
    `KisFuturesNightWs` 는 슬롯을 두 벌 쥐면 벤더가 한쪽을 끊는다. 라우트 홀더와
    스케줄러 keeper 가 각자 만들면 **한 프로세스 안에서** 킥 전쟁이 나고, 증상은
    "틱이 가끔 끊긴다" 라서 원인에 도달하기 어렵다.

    `data_dir` 은 **첫 호출이 이긴다** — 한 프로세스에 데이터 디렉터리는 하나다.
    """
    global _RUNTIME  # noqa: PLW0603 — 프로세스 싱글턴은 모듈 상태가 유일한 자리다
    if _RUNTIME is None:

        def factory() -> Any:
            if data_dir is None:
                return None
            from hoga.live.kis_runtime import ensure_kis_client_from_env  # noqa: PLC0415

            return ensure_kis_client_from_env(data_dir)

        _RUNTIME = FuturesQuotesRuntime(factory)
    return _RUNTIME


async def aclose_runtime() -> None:
    """종료 시 야간 WS 를 닫는다. 런타임이 만들어진 적 없으면 아무 일도 하지 않는다.

    **graceful shutdown 에서 닫는 것이 keeper 와 짝이다.** keeper 는 야간 내내 소켓을
    열어두므로, 안 닫고 내려가면 재시작 직후 옛 소켓이 잠시 살아 있어 새 프로세스와
    슬롯을 다툰다 — 이 표면에서 가장 아픈 실패(킥 전쟁)를 우리 손으로 만드는 셈이다.
    lazy 시절엔 10분 유휴 정지가 이걸 대충 가려줬다.
    """
    if _RUNTIME is not None:
        await _RUNTIME.aclose()


def reset_runtime_for_tests() -> None:
    """싱글턴을 비운다. **테스트 전용** — 프로덕션에서 부르면 옛 런타임이 WS 를 쥔 채
    남아 두 벌이 된다(`ensure_runtime` 의 킥 전쟁 그대로)."""
    global _RUNTIME  # noqa: PLW0603
    _RUNTIME = None


# ── 야간 keeper (스케줄러 소유) ─────────────────────────────────────────────

#: keeper 가 세션을 다시 확인하는 주기. `KisFuturesNightWs._IDLE_STOP_S`(600초)보다
#: 충분히 짧아야 한다 — keeper 의 호출이 곧 유휴 타이머 갱신이기 때문이다. 유휴 정지
#: 자체는 **지우지 않는다**: 주간 동작(아무도 안 보면 닫힘)은 그대로 두고, 야간에만
#: keeper 가 계속 두드려서 무의미해지게 하는 것이 이 설계다.
_KEEPER_TICK_S = 60.0


def night_keeper_enabled_from_env() -> bool:
    """야간 keeper 를 띄울지. **기본은 꺼짐**이고 prod `.env` 에서만 켠다.

    **왜 opt-in 인가** — 워크트리·e2e 백엔드는 `.env` 가 없으면 메인 체크아웃 것을
    상속한다(ADR-0134). 지금까지는 야간 WS 가 화면 수요에 묶여 있어서, 아무도 그
    워크트리의 `/market` 을 안 보는 한 슬롯을 열지 않았다 — **lazy 가 우연히 사고를
    막고 있었다.** keeper 는 그 우연한 보호를 없애므로, 키를 상속한 모든 프로세스가
    매일 밤 KIS WS 를 연다. REST 유량 초과와 달리 WS 슬롯 경합은 **킥 전쟁이라 양쪽이
    다 죽고**(#1088 과 같은 유형), 증상이 조용해서 피해자가 알아채지 못한다.

    같은 파일의 `HOGA_STARTUP_CATCHUP_ENABLED` 와 같은 관례다.
    """
    import os  # noqa: PLC0415 — 이 함수 하나가 유일한 사용처다

    return os.environ.get("HOGA_NIGHT_FUTURES_KEEPER") == "true"


def is_available(data_dir: Path) -> bool:
    """KIS 자격이 있어 keeper 가 의미 있는가. 스케줄러가 태스크 생성 여부를 정한다.

    무자격이면 태스크를 **아예 안 만든다** — 만들면 health 에 "도는 중인데 아무것도
    안 하는" 거짓 행이 영원히 남는다(투자자 수급 수집기와 같은 판단, ADR-0134).
    """
    from hoga.live.kis_runtime import configured_account_ids  # noqa: PLC0415

    return bool(configured_account_ids(data_dir))


async def run_night_keeper(
    data_dir: Path,
    *,
    tick_s: float = _KEEPER_TICK_S,
    sleep: Any = None,
) -> None:
    """야간 세션 동안 WS 를 상시 유지한다 — **화면 수요와 무관하게**.

    이 태스크가 있어야 야간 봉이 18:00 부터 쌓인다. 없으면 시계열이 "누가 보고
    있었는가" 의 함수가 된다(`scheduler.start_scheduler` 가 투자자 수급 수집기에 대해
    적어둔 것과 같은 이유). 실측 2026-08-07: 18:00 개장인데 관측 시작이 19:10 —
    정확히 사람이 페이지를 연 시각이었다.

    **퍼페추얼 루프다** — 정상 반환이 곧 조용한 죽음이므로 `ONE_SHOT_TASK_NAMES` 에
    넣으면 안 된다(ADR-0064). 그래서 어떤 예외도 루프를 끊지 못하게 한다.
    """
    sleep_fn = sleep if sleep is not None else asyncio.sleep
    runtime = ensure_runtime(data_dir)
    while True:
        try:
            await runtime.ensure_night_stream()
        except asyncio.CancelledError:
            # 종료 경로다 — 삼키면 프로세스가 안 내려간다.
            raise
        except Exception:
            log.exception("야간 keeper 틱 실패; 루프는 계속한다")
        await sleep_fn(tick_s)
