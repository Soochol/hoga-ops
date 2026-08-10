"""시장 종합(`/market`) 읽기 전용 API (#1121).

**저장 축과 분리돼 있다.** 여기 표면들은 놓친 폴링의 대가가 잠깐의 낡음뿐이라
수요 구동 TTL 로 충분하다 — 결손이 영구 구멍인 장중 수급만 서버가 무조건 적재한다
(`investor_flow_collector`, #1099).

캐시 규약은 `_get_index_quotes`(live/api.py)의 확립된 패턴을 그대로 따른다:

1. 스냅샷은 **캐시만** 보고 만든다 — 자격증명·용량이 없어도 last-good 을 돌려준다.
2. `asyncio.Lock` 이 곧 단일비행. TTL 재확인은 **락 안에서** 한다.
3. 실패해도 last-good 을 **축출하지 않고**, `fetched_at` 은 갱신한다 — 업스트림이
   죽었을 때 TTL 주기로만 재시도하고 뜨거운 루프에 빠지지 않는다.
4. 로그는 `debug` — 배경 폴링의 실패를 warning 으로 남기면 로그 벽이 된다.

유량은 제약이 아니다: 버킷이 `(앱키, TR)` 당 5 req/s 이고 신규 TR 은 전부 자기 창구를
새로 받는다(#1015·ADR-0138). 그래도 우선순위는 `background` 다 — 클릭 응답이 아니라
주기 폴링이므로 사용자 조작에 양보하는 쪽이 맞다.
"""
from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from typing import Any, get_args

from fastapi import APIRouter
from pydantic import BaseModel, Field

from hoga.live import kiwoom_access, market_overview
from hoga.live.market_funds_runtime import MarketFundsCache
from hoga.live.market_overview import MarketName, StreakDirection

log = logging.getLogger(__name__)


# ── Wire models (ADR-0004) ────────────────────────────────────────────────────
#
# 라우터 전용이라 `hoga/api/models.py` 가 아니라 여기 산다 — `lifecycle.py::LiveStatus`
# 와 같은 선례다. 라우트 바로 위에 있어야 응답과 계약을 한 화면에서 대조할 수 있다.
#
# **수집 함수는 여전히 dict 를 만든다.** 라우트 애노테이션만 바꿔서 FastAPI 가 검증·
# 직렬화하게 한다 — 수집기를 모델 생성으로 바꾸면 캐시·파서까지 번지는데, 이번 작업의
# 계약은 "wire shape 을 선언한다" 지 "내부를 리팩터한다" 가 아니다.
#
# ⚠ **기본값 규칙**: 어느 한 분기에서라도 빠질 수 있는 키는 반드시 기본값을 준다.
# 여기 라우트들은 벤더 실패 시 `or {...}` 폴백 dict 를 돌려주는데, 그 폴백에 없는
# 키가 모델에서 필수면 ValidationError 로 500 이 난다. 폴백이 곧 정상 경로다(무자격
# 환경에서는 항상 그 길로 간다).
#
# `session` 류를 `Literal` 로 좁히지 않은 것은 의도다. 값 계약은
# `futures_runtime.FuturesSession` ↔ FE `marketFutures.ts` 쌍이 이미 갖고 있고,
# 그 lockstep 은 `tests/unit/api/test_rest_wire_schema_contract.py` 의
# `WIRE_ENUM_MIRRORS` 가 강제한다. 여기서 다시 좁히면 미러가 3벌이 되고, 무엇보다
# `futures_runtime` 을 상단에서 import 하게 되는데 그건 이 파일이 일부러 피하는
# heavy import 다(KIS 스택 전체).


class MarketIndexRow(BaseModel):
    """종합지수 행 — 등락종목수는 여기에만 실린다(#1100)."""

    code: str
    name: str
    value: float | None = None
    change_pct: float | None = None
    rising: int | None = None
    falling: int | None = None
    flat: int | None = None
    upper: int | None = None
    lower: int | None = None
    trade_value_eok: float | None = None
    listed_count: int | None = None


class MarketSectorRow(BaseModel):
    code: str
    name: str
    value: float | None = None
    change_pct: float | None = None
    trade_value_eok: float | None = None


class MarketVolatility(BaseModel):
    code: str
    name: str
    value: float | None = None
    change_pct: float | None = None


class MarketSideBundle(BaseModel):
    index: MarketIndexRow | None = None
    sectors: list[MarketSectorRow] = Field(default_factory=list)


class MarketSectorsResponse(BaseModel):
    # 키는 mrkt_tp("0"=코스피 · "1"=코스닥) — 동적이라 dict 로 남긴다.
    markets: dict[str, MarketSideBundle] = Field(default_factory=dict)
    # 벤더 실패 폴백(`{"markets": {}}`)엔 이 키가 없었다. 기본값이 `null` 을 채워
    # 넣으므로 **폴백 응답이 오히려 FE 타입에 맞아진다**(FE 는 필수 필드로 선언).
    volatility: MarketVolatility | None = None


class ProgramPoint(BaseModel):
    t: str
    arb_net_eok: float | None = None
    non_arb_net_eok: float | None = None
    total_net_eok: float | None = None
    # 일별 축 + 코스닥에서 벤더 값이 틀려 파서가 접는다 — 그래서 정상적으로 null 이다.
    kospi200: float | None = None
    basis: float | None = None


class ProgramResponse(BaseModel):
    axis: str
    markets: dict[str, list[ProgramPoint]] = Field(default_factory=dict)


class BreadthCountRow(BaseModel):
    """`truncated` 가 값과 동급이다 — 상한에 닿았으면 count 는 하한이다(#1099).

    이름이 `market_overview.BreadthCount` 와 다른 것은 의도다. 그쪽은 파서 내부
    자료구조고 이쪽은 wire model 이라, 같은 이름이면 import 두 개가 서로를 가린다.
    """

    count: int
    truncated: bool


class BreadthBucket(BaseModel):
    # 벤더 호출이 실패한 축은 **키 자체가 빠진다**. 라우트에
    # `response_model_exclude_none=True` 를 붙여 그 부재를 보존한다 — 기본 직렬화면
    # `null` 이 새로 실려서 FE 의 `?:`(부재) 계약과 어긋난다.
    new_high_52w: BreadthCountRow | None = None
    new_low_52w: BreadthCountRow | None = None


class BreadthResponse(BaseModel):
    markets: dict[str, BreadthBucket] = Field(default_factory=dict)


class FundsRow(BaseModel):
    date: str
    # 원(raw). 세 계열의 최신일이 어긋나므로 없는 값은 null 이다(0 으로 채우면 거짓말).
    deposit_won: int | None = None
    credit_won: int | None = None
    cma_won: int | None = None


class FundsResponse(BaseModel):
    unavailable: str | None = None
    as_of: str | None = None
    series: list[FundsRow] = Field(default_factory=list)


class InvestorValues(BaseModel):
    """3주체 순매수. 단위는 요청의 `amt_qty_tp` 가 정했다 — 여기 값은 억원(#1117)."""

    individual: int | None = None
    foreign: int | None = None
    institution: int | None = None


class InvestorFlowPoint(InvestorValues):
    t_ms: int


class GapRange(BaseModel):
    start_ms: int
    end_ms: int


class InvestorFlowCoverage(BaseModel):
    first_sample_ms: int | None = None
    last_sample_ms: int | None = None
    sample_count: int = 0
    expected_count: int | None = None
    gap_ranges: list[GapRange] = Field(default_factory=list)


class InvestorFlowDailyRow(BaseModel):
    date: str
    markets: dict[str, InvestorValues] = Field(default_factory=dict)


class InvestorFlowResponse(BaseModel):
    date: str
    daily: list[InvestorFlowDailyRow] = Field(default_factory=list)
    unit: str
    confirmed: bool
    #: 시장 라벨 → 커버리지. **시장별인 것이 계약**이다(2026-08-10) — 한 덩어리로
    #: 세면 분자만 두 시장 합이 되어 2배가 되고, 같은 사이클의 두 표본이 거의 같은
    #: 시각이라 간격이 0 에 수렴해 `gap_ranges` 가 항상 비게 된다. 산출부 주석 참조.
    coverage: dict[str, InvestorFlowCoverage] = Field(default_factory=dict)
    markets: dict[str, list[InvestorFlowPoint]] = Field(default_factory=dict)


class DerivFlowPoint(BaseModel):
    """파생 표본 하나 — 3주체 순매수.

    **두 축을 함께 싣는다.** `contracts` 는 벤더 원값(계약)이고 국내 HTS 의 표준 축이며,
    `amount_eok` 는 화면이 주식 카드와 같은 축을 쓰기 위한 파생값이다. 억원 환산은
    단위 판정이 서야만 가능하므로 **미확정이면 `amount_eok` 가 통째로 null** 이다 —
    이때 계약 축은 멀쩡하다.
    """

    t_ms: int
    individual: float | None = None
    foreign: float | None = None
    institution: float | None = None
    individual_qty: float | None = None
    foreign_qty: float | None = None
    institution_qty: float | None = None


class DerivFlowUnits(BaseModel):
    """단위 판정 — 벤더가 말해 주지 않아 값에서 역산한 결과(`deriv_flow_units`).

    화면이 "단위 미확정" 을 말할 수 있어야 하므로 이유까지 그대로 내보낸다. 숨기면
    억원 축이 빈 이유를 아무도 모른다.
    """

    quantity: str | None = None
    amount: str | None = None
    resolved: bool = False
    reason: str = ""


class DerivFlowProduct(BaseModel):
    label: str
    iscd: str
    #: `futures` · `call` · `put`
    family: str
    points: list[DerivFlowPoint] = Field(default_factory=list)
    coverage: InvestorFlowCoverage


class DerivFlowResponse(BaseModel):
    date: str
    #: 억원 축이 살아 있으면 `amt_eok`, 단위 미확정이면 null. 이름에 단위를 박는
    #: 규약(#1117)을 따르되 **null 이 가능한 것**이 이 표면의 차이다.
    unit: str | None = None
    units: DerivFlowUnits
    #: 파생 세션(초, KST 자정 기준) — 주식과 다르다(09:00–15:45). 화면이 x축을
    #: 하드코딩하지 않게 응답이 말한다.
    session_start_sec: int
    session_end_sec: int
    products: dict[str, DerivFlowProduct] = Field(default_factory=dict)


class SectorFlowRow(InvestorValues):
    """업종 1행 — 3주체 순매수(억원) + 지수 레벨·등락률.

    `InvestorValues` 를 상속하는 이유는 같은 TR(ka10051)의 같은 세 필드이기 때문이다.
    단위도 같다(요청의 `amt_qty_tp="0"` → 억원).

    ⚠ `value`·`change_pct` 는 **ka20003 과 스케일이 다르다** — 파서가 ÷100 하고
    레벨의 방향 부호를 벗겨서 준다(`parse_sector_investor_rows`).
    """

    code: str
    name: str
    value: float | None = None
    change_pct: float | None = None


class SectorFlowResponse(BaseModel):
    date: str
    unit: str
    # 표본이 아직 없는 날은 null — 화면이 "언제 것인지" 를 말해야 멎은 걸 알아챈다.
    sampled_at_ms: int | None = None
    # 시장 라벨("KOSPI"/"KOSDAQ") → 업종 행. **종합 행이 맨 앞**이다(화면의 기준선).
    markets: dict[str, list[SectorFlowRow]] = Field(default_factory=dict)


class StreakRow(BaseModel):
    code: str
    name: str
    actor: str
    streak_days: int
    streak_net_eok: float | None = None
    streak_net_qty_shares: int | None = None
    period_change_pct: float | None = None


class StreaksResponse(BaseModel):
    """주체 키가 **한글**이라 alias 로 받는다.

    한글 식별자는 파이썬 문법상 되지만 쓰지 않는다. alias 로 충분한 이유가 둘 있다:
    pydantic v2 는 dict 입력을 **alias 로** 검증하고(수집 함수가 `"외국인"` 키로
    만든다), FastAPI 는 응답 모델을 **`by_alias=True`** 로 직렬화한다. 즉 wire 는
    바이트 단위로 그대로다.
    """

    warnings: list[str] = Field(default_factory=list)
    foreign_investor: list[StreakRow] = Field(default_factory=list, alias="외국인")
    institution: list[StreakRow] = Field(default_factory=list, alias="기관")


class FuturesDayValues(BaseModel):
    """야간 틱이 덮기 **전**의 주간 값 — 카드에서 주간↔야간을 고를 수 있게 하는 짝.

    `data_session == "night"` 인 quote 에만 실린다. 주간 카드는 최상위 필드가 이미
    주간 값이라 여기 넣으면 같은 숫자가 두 벌이 된다.

    **정체성 필드(코드·만기·최종거래일)는 넣지 않는다** — 두 세션이 같은 월물을
    가리키므로 값만 갈린다. 복제하면 둘이 어긋날 자리를 새로 만드는 셈이다.
    """
    value: float
    change: float
    change_rate: float
    prev_close: float
    volume: int
    open_interest: int
    oi_change: int
    market_basis: float | None = None
    disparity: float | None = None
    t_ms: int


class FuturesNightValues(BaseModel):
    """**직전 야간장의 마지막 값** — `FuturesDayValues` 의 반대 방향.

    낮·마감에만 실린다. 출처가 벤더가 아니라 **우리가 그 밤에 적어 둔 기록**이라는
    점이 `day` 와 다르다 — KIS 에 야간 소급 경로가 없어서(4표면 전수 실측) 저장을
    켜기 전의 밤은 영영 `null` 이다.

    `session_day` 가 **필수**다. 화면이 `8/7 야간` 처럼 날짜를 함께 말하지 않으면
    오늘 야간과 구별되지 않는다.
    """
    #: 이 값이 속한 야간장의 거래일 `YYYYMMDD`.
    session_day: str
    value: float
    change: float
    change_rate: float
    prev_close: float
    volume: int
    open_interest: int
    oi_change: int
    market_basis: float | None = None
    disparity: float | None = None
    t_ms: int


class FuturesQuoteRow(BaseModel):
    id: str
    underlying_id: str | None = None
    label: str
    code: str
    expiry: str
    days_left: int | None = None
    last_trade_date: str | None = None
    value: float
    change: float
    change_rate: float
    prev_close: float
    volume: int
    open_interest: int
    oi_change: int
    # 시장 베이시스(선물−기초자산). 이론 베이시스가 아니다 — 부호까지 다르다.
    market_basis: float | None = None
    disparity: float | None = None
    # 이 값이 속한 세션. 최상위 `session`(지금 열린 세션)과 다를 수 있고 종목마다 다르다.
    data_session: str
    t_ms: int
    # 야간 값이 덮기 전의 주간 값. `data_session == "night"` 일 때만 실린다 —
    # 있으면 화면이 그 카드에서 주간↔야간을 고를 수 있다는 뜻이다.
    day: FuturesDayValues | None = None
    # 직전 야간장의 마지막 값. **낮·마감에만** 실리고, 그 밤을 저장해 뒀을 때만 있다.
    # `day` 와 정확히 반대 방향이라 둘이 동시에 차는 일은 없다.
    night: FuturesNightValues | None = None


class FuturesQuotesResponse(BaseModel):
    quotes: list[FuturesQuoteRow] = Field(default_factory=list)
    session: str
    unavailable: str | None = None


class FuturesSparkCoverage(BaseModel):
    first_hhmm: str
    observed_buckets: int
    gap_count: int


class FuturesDaySeries(BaseModel):
    """야간 시리즈와 함께 실리는 **그날 주간장** 모양. 카드가 '주간' 을 고르면 이걸 그린다.

    `coverage` 가 없는 것이 의도다 — 주간은 REST 로 날짜를 지정해 다시 받으므로
    "놓친 구간" 이라는 개념 자체가 없다.
    """
    closes: list[float] = Field(default_factory=list)
    day_open: float | None = None


class FuturesNightSeries(BaseModel):
    """주간 시리즈와 함께 실리는 **직전 야간장** 모양. 값 쪽 `night` 와 짝이다.

    기준선(`day_open`)이 없는 것은 야간 시리즈의 규칙 그대로다 — 첫 점이 곧 야간
    시가이고, 주간 시가로 색칠하면 등락 방향이 뒤집힌다.
    """
    closes: list[float] = Field(default_factory=list)
    #: 이 그림이 속한 야간장의 거래일. 값 쪽과 어긋나면 화면이 두 날짜를 섞는다.
    session_day: str


class FuturesSpark(BaseModel):
    closes: list[float] = Field(default_factory=list)
    day_open: float | None = None
    session: str
    # 야간 시리즈에만 실린다 — 주간은 REST 소급 조회가 되므로 "놓친 구간" 이 없다.
    coverage: FuturesSparkCoverage | None = None
    # 야간 시리즈일 때 같이 오는 주간 모양. `session == "day"` 면 최상위가 이미 주간이다.
    day: FuturesDaySeries | None = None
    # 주간 시리즈일 때 같이 오는 직전 야간 모양. `day` 와 반대 방향이다.
    night: FuturesNightSeries | None = None


class FuturesCandlesResponse(BaseModel):
    series: dict[str, FuturesSpark] = Field(default_factory=dict)

# TTL 은 벤더 갱신 주기와 화면 위치가 정한다(#1099) — 유량이 정하지 않는다.
TTL_SECTORS_S = 30.0      # 지수·등락종목수: 화면 최상단(0J/0U WS 오버레이의 baseline)
# 장중 축은 벤더가 **요청 직전 1초 이내** 행까지 준다(2026-08-10 실측: `cntr_tm
# 103441` 행을 10:34:41 에 관측, 3회 연속 지연 0~1초). 즉 화면 지연을 지배하는 항이
# 벤더가 아니라 이 TTL 이었다 — 15초로 폴링해도 갱신이 62·62·67초 간격으로만 보였다.
# 100행 ≈ 100분이라 자기 백필이므로 놓쳐도 값이 빠지지 않는다(신선도 문제일 뿐).
TTL_PROGRAM_INTRADAY_S = 20.0
# 일별 축은 하루 한 번 바뀐다. **상수를 나눈 이유**: 하나로 두면 장중을 조일 때
# 일별 TTL 까지 조용히 따라 내려가 같은 값을 세 배로 물어보게 된다.
TTL_PROGRAM_DAILY_S = 60.0
TTL_STREAKS_S = 300.0     # 연속일수는 일 단위 축
TTL_BREADTH_S = 300.0     # 52주 신고·신저는 느리게 움직인다
# 선물: 지수 카드와 같은 줄에 서므로 `/live/index-quotes`(20s)와 신선도를 맞춘다.
# 벤더가 KIS 라 키움 거버너와 무관하고, 라인업이 3콜뿐이라 유량도 제약이 아니다.
TTL_FUTURES_S = 20.0
# 선물 스파크라인: 5분봉이라 그보다 자주 물어봐야 얻는 게 없다.
TTL_FUTURES_SPARK_S = 60.0

_MARKETS = ("0", "1")  # 코스피 · 코스닥 — 별도 콜이다
#: `mrkt_tp` → 화면 라벨. 투자자 표면이 이 라벨로 키잉한다(`market_investor_row` 와 동일).
_MARKET_LABELS = {"0": "KOSPI", "1": "KOSDAQ"}
_STEX_ALL = "3"
#: 연속매매 방향 → 벤더 `netslmt_tp`(ka10131). **실측으로 확정한 코드표다**(2026-08-10):
#: 리서치 문서는 "2=순매수 추정 · 배선 전에 흔들 것" 으로 남겨 뒀었고, 두 값의 응답을
#: 대조해 보니 종목 코드 집합의 **교집합이 0** 이라 정렬 축이 아니라 필터임이 갈렸다.
_NETSLMT_TP: dict[str, str] = {"buy": "2", "sell": "1"}
#: 시장 → 벤더 `mrkt_tp`(ka10131). 같은 리포 안에서도 코스닥 코드가 TR 마다 다르다
#: (`ka20003` 은 `"1"`, `ka90005` 는 `"P10102"`) — 여기선 `"101"` 이다(2026-08-10 실측:
#: 100행 전부 코스닥, 코스피와 교집합 0).
#:
#: ⚠ **모르는 코드는 거절되지 않는다.** `"1"` · `"000"` 도 HTTP 200 · `return_code=0` 인데
#: 응답이 **코스피**다. 그래서 화면 라벨(`MarketName`)만 wire 로 받고 여기서 매핑한다 —
#: 원시 코드를 통과시키면 오타가 "코스닥" 이라 쓰인 코스피 카드로 조용히 나타난다.
_MRKT_TP: dict[str, str] = {"KOSPI": "001", "KOSDAQ": "101"}


class _TtlCache:
    """TTL + 단일비행 + last-good. 네 규약(모듈 docstring)을 한 곳에 봉인한다."""

    def __init__(self, ttl_s: float) -> None:
        self._ttl_s = ttl_s
        self._value: Any = None
        self._fetched_at = float("-inf")
        self._lock = asyncio.Lock()

    @property
    def value(self) -> Any:
        return self._value

    async def get(self, fetch: Any) -> Any:
        now = time.monotonic()
        if now - self._fetched_at < self._ttl_s and self._value is not None:
            return self._value
        async with self._lock:
            # 락 안에서 재확인 — 대기 중에 다른 코루틴이 이미 채웠을 수 있다.
            now = time.monotonic()
            if now - self._fetched_at < self._ttl_s and self._value is not None:
                return self._value
            try:
                fresh = await fetch()
            except Exception as e:  # noqa: BLE001 — 배경 폴링의 실패는 last-good 으로 흡수한다.
                log.debug("market_routes.fetch_failed error=%s", e)
                self._fetched_at = time.monotonic()  # 뜨거운 재시도 루프 방지
                return self._value
            if fresh is not None:
                self._value = fresh
            self._fetched_at = time.monotonic()
            return self._value


# 시장 폭 질의 표 — `(api_id, 고정 파라미터, 가변 축, 출력 이름)`. 표로 두는 이유는
# 네 카운트가 파라미터 하나만 다른 같은 모양이라, 코드로 펼치면 build_router 가
# 읽을 수 없게 길어지기 때문이다.
#: 급등·급락(ka10019) 두 줄은 뺐다 — 소비하던 시장 폭 카드가 업종 수급으로 교체되며
#: 화면 소비자가 0 이 됐다. 이 라우터에서 가장 무거운 콜이었다(`jmp_rt` 내림차순
#: 페이지 walk × 2시장). 되살릴 때는 `_KA10019_BASE` 와 `_collect_breadth` 의 임계
#: 조기종료(`is_jump`)를 함께 되살려야 한다 — 그게 없으면 1,000행을 그냥 센다.
_BREADTH_QUERIES: tuple[tuple[str, str, str, str], ...] = (
    ("ka10016", "ntl_tp", "1", "new_high_52w"),
    ("ka10016", "ntl_tp", "2", "new_low_52w"),
)

_KA10016_BASE = {
    "high_low_close_tp": "1", "stk_cnd": "0", "trde_qty_tp": "00000",
    "crd_cnd": "0", "updown_incls": "0", "dt": "250", "stex_tp": _STEX_ALL,
}


# 정규장 09:00–15:30 = 390분. 커버리지 분모의 근거이고, 수집 게이트
# (`ws_capture_window`)와 같은 창이다.
_SESSION_MINUTES = 390


def _recent_dates(today: str, *, days: int) -> list[str]:
    """오늘부터 거슬러 달력일 목록(오래된 순). 확정본이 없는 날은 호출부가 건너뛰므로
    휴장일을 여기서 거를 필요가 없다 — 파일 존재가 곧 거래일 판정이다."""
    import datetime as _dt  # noqa: PLC0415

    base = _dt.datetime.strptime(today, "%Y%m%d")
    out = [(base - _dt.timedelta(days=i)).strftime("%Y%m%d") for i in range(days)]
    return sorted(out)


def _investor_flow_payload(data_dir: Path, *, daily_days: int = 40) -> dict[str, Any]:
    """장중 수급 — 저장된 표본을 읽어 3주체 누적 시계열 + 커버리지로.

    **읽기 경로는 벤더를 부르지 않는다.** 표본은 수집기가 이미 찍어 뒀고, 소급 조회가
    불가능한 데이터라 여기서 다시 부를 수도 없다(#1105).

    잠정/확정은 **확정 파일의 존재로 파생**한다 — 플래그를 저장하지 않는다(#1115).
    """
    from hoga.collector.orchestrator import now_kst  # noqa: PLC0415
    from hoga.live.investor_flow_collector import POLL_INTERVAL_S  # noqa: PLC0415
    from hoga.live.investor_flow_store import InvestorFlowStore, compute_coverage  # noqa: PLC0415

    date = now_kst().strftime("%Y%m%d")
    store = InvestorFlowStore(data_dir)
    samples = store.load_samples(date)
    poll_ms = int(POLL_INTERVAL_S * 1000)

    series: dict[str, list[dict[str, Any]]] = {}
    # 커버리지는 **시장별**이다. 한 파일에 코스피·코스닥 표본이 섞여 있어서, 전량을
    # 한 덩어리로 세면 두 가지가 동시에 틀어졌다(2026-08-10):
    #
    # 1. `sample_count` 는 두 시장 합인데 `expected_count` 는 한 시장 기준(390분 ÷
    #    주기)이라 **분자가 2배**였다 — 30초 폴로 하루를 채우면 200% 로 표시된다.
    #    60초 시절엔 51% 라 그럴듯해 보여서 드러나지 않았다.
    # 2. 더 나쁜 쪽: 같은 사이클의 두 시장 표본이 **거의 같은 시각**이라 섞으면
    #    간격이 0 에 수렴한다 → 갭 임계(주기×3)를 넘을 일이 없어 `gap_ranges` 가
    #    사실상 항상 빈다. "재시작 공백이 정직하게 드러난다"(#1105)는 계약이
    #    무력화돼 있었다.
    #
    # 한 시장만 실패한 사이클은 그 시장의 줄만 빠지므로(수집기 주석) 시장별로
    # 나눠야 그 비대칭도 보인다 — 합치면 그것마저 가려진다.
    by_market_samples: dict[str, list[Any]] = {}
    for s in samples:
        got = market_overview.market_investor_row(s.rows)
        if got is None:
            continue
        label, values = got
        series.setdefault(label, []).append({"t_ms": s.sampled_at_ms, **values})
        by_market_samples.setdefault(label, []).append(s)

    # 일별(확정) 이력 — 확정본이 있는 날만. **비어 있는 것이 정상 시작 상태**다:
    # 장중 표본은 소급 백필이 불가능하지만 확정본은 `base_dt` 랜덤 액세스라 뒤늦게도
    # 채워진다(일일 배치의 캐치업). 화면은 "확정 이력이 쌓이는 중" 을 말해야 한다.
    daily: list[dict[str, Any]] = []
    for d in _recent_dates(date, days=daily_days):
        confirmed = store.load_confirmed(d)
        if confirmed is None:
            continue
        got = market_overview.market_investor_row(confirmed.rows)
        by_market: dict[str, Any] = {}
        for label in market_overview.WHOLE_MARKET_INDS.values():
            picked = market_overview.market_investor_row(
                [r for r in confirmed.rows
                 if market_overview.WHOLE_MARKET_INDS.get(str(r.get("inds_cd") or "")) == label]
            )
            if picked is not None:
                by_market[label] = picked[1]
        if got is not None or by_market:
            daily.append({"date": d, "markets": by_market})

    expected = market_overview.expected_sample_count(
        session_minutes=_SESSION_MINUTES, poll_interval_ms=poll_ms
    )
    coverage: dict[str, Any] = {}
    for label, market_samples in by_market_samples.items():
        cov = compute_coverage(market_samples, poll_interval_ms=poll_ms)
        coverage[label] = {
            "first_sample_ms": cov.first_sample_ms,
            "last_sample_ms": cov.last_sample_ms,
            "sample_count": cov.sample_count,
            "expected_count": expected,
            "gap_ranges": cov.gap_ranges,
        }
    return {
        "daily": daily,
        "date": date,
        # 단위는 수집 시 요청이 정했다 — 이름에 박아 화면이 축을 못 헷갈리게 한다.
        "unit": "amt_eok",
        "confirmed": store.is_confirmed(date),
        "coverage": coverage,
        "markets": series,
    }


#: 파생 응답에서 3주체를 뽑는 필드 쌍 — (대금, 수량). 12주체 중 셋만 쓴다:
#: 화면이 그 셋을 그리고, 나머지 9종은 필드명이 불규칙하다(`pe_fund_ntby_vol` 처럼
#: `_qty` 가 아닌 것이 섞인다).
_DERIV_ACTOR_FIELDS: tuple[tuple[str, str, str], ...] = (
    ("individual", "prsn_ntby_tr_pbmn", "prsn_ntby_qty"),
    ("foreign", "frgn_ntby_tr_pbmn", "frgn_ntby_qty"),
    ("institution", "orgn_ntby_tr_pbmn", "orgn_ntby_qty"),
)


def _deriv_num(row: dict[str, Any], key: str) -> float | None:
    v = row.get(key)
    if v is None or str(v).strip() == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _deriv_flow_payload(data_dir: Path) -> dict[str, Any]:
    """파생 투자자 수급 — 저장된 표본을 상품별 시계열로. **벤더를 부르지 않는다.**

    표본은 수집기가 이미 찍어 뒀고, 소급 조회가 불가능한 데이터라 여기서 다시 부를
    수도 없다(주식 `/investor-flow` 와 같은 성질).

    **단위는 저장하지 않고 매번 역산한다.** 판정 로직이 바뀌면 과거 표본도 새 판정으로
    다시 읽혀야 하는데, 저장해 두면 그날의 옛 판정이 화석으로 남는다. 역산 비용은
    선물 표본 하나를 보는 것뿐이다.

    판정은 **그날의 마지막 선물 표본**으로 한다 — 누적이 가장 많이 쌓인 표본이라
    자릿수 검사가 가장 확실하다(장 초반 표본으로 재면 임계에 못 미쳐 보류가 된다).

    ⚠ 그렇게 얻은 판정 하나를 **그날 전 이력에 소급 적용한다**(표본마다 따로 재지
    않는다). 이게 자기치유의 근거다: 09:05 표본은 그 시점엔 판정이 안 서지만, 10시에
    이 라우트를 부르면 마지막 표본 기준으로 확정된 단위가 09:05 점에도 걸려 억원 축이
    통째로 살아난다. **"표본별로 판정을 캐시" 하는 최적화를 하면 이 성질이 조용히
    깨진다** — 장 초반 점들이 영영 null 로 굳는다.
    """
    from hoga.collector.orchestrator import now_kst  # noqa: PLC0415
    from hoga.live.deriv_flow_collector import POLL_INTERVAL_S  # noqa: PLC0415
    from hoga.live.deriv_flow_products import BY_KEY, PRODUCTS, UNIT_PROBE_KEY  # noqa: PLC0415
    from hoga.live.deriv_flow_store import (  # noqa: PLC0415
        GAP_MIN_JUMP_INTERVALS,
        DerivFlowStore,
        expected_sample_count,
    )
    from hoga.live.deriv_flow_units import AMOUNT_UNITS, UnitVerdict, infer_units  # noqa: PLC0415
    from hoga.live.session_gate import DERIV_CLOSE_MIN, DERIV_OPEN_MIN  # noqa: PLC0415

    date = now_kst().strftime("%Y%m%d")
    samples = DerivFlowStore(data_dir).load_samples(date)
    poll_ms = int(POLL_INTERVAL_S * 1000)

    by_product: dict[str, list[Any]] = {}
    for s in samples:
        by_product.setdefault(s.product, []).append(s)

    # 단위 판정 — 마지막 선물 표본 하나.
    probe = BY_KEY[UNIT_PROBE_KEY]
    verdict = UnitVerdict(None, None, None, 0, "표본 없음 — 판정 보류")
    probe_samples = by_product.get(UNIT_PROBE_KEY) or []
    if probe_samples and probe.multiplier_won is not None:
        verdict = infer_units(probe_samples[-1].row, multiplier_won=probe.multiplier_won)
    to_eok = AMOUNT_UNITS[verdict.amount] / 1e8 if verdict.amount else None

    products: dict[str, Any] = {}
    for product in PRODUCTS:
        rows = by_product.get(product.key) or []
        points: list[dict[str, Any]] = []
        for s in rows:
            pt: dict[str, Any] = {"t_ms": s.sampled_at_ms}
            for name, amt_key, qty_key in _DERIV_ACTOR_FIELDS:
                amt = _deriv_num(s.row, amt_key)
                pt[name] = None if (amt is None or to_eok is None) else amt * to_eok
                pt[f"{name}_qty"] = _deriv_num(s.row, qty_key)
            points.append(pt)
        ts = sorted(s.sampled_at_ms for s in rows)
        gaps = [
            {"start_ms": prev, "end_ms": cur}
            for prev, cur in zip(ts, ts[1:], strict=False)
            if cur - prev > poll_ms * GAP_MIN_JUMP_INTERVALS
        ]
        products[product.key] = {
            "label": product.label,
            "iscd": product.iscd,
            "family": product.family,
            "points": points,
            "coverage": {
                "first_sample_ms": ts[0] if ts else None,
                "last_sample_ms": ts[-1] if ts else None,
                "sample_count": len(ts),
                "expected_count": expected_sample_count(poll_interval_ms=poll_ms),
                "gap_ranges": gaps,
            },
        }

    return {
        "date": date,
        "unit": "amt_eok" if verdict.amount else None,
        "units": {
            "quantity": verdict.quantity,
            "amount": verdict.amount,
            "resolved": verdict.resolved,
            "reason": verdict.reason,
        },
        "session_start_sec": DERIV_OPEN_MIN * 60,
        "session_end_sec": DERIV_CLOSE_MIN * 60,
        "products": products,
    }


#: VKOSPI(변동성지수)의 ka20003 업종코드. **업종이 아니라 지수**라서 업종 배열에
#: 남겨 두면 두 곳에서 틀린다: 업종 온도 리스트에 한 줄로 섞이고, 업종 분산·쏠림
#: 계산이 변동성지수를 업종으로 세어 왜곡된다. 그래서 최상위로 승격해서 뺀다.
_VKOSPI_SECTOR_CODE = "603"


def _sector_flow_payload(data_dir: Path) -> dict[str, Any]:
    """업종별 투자자 순매수 — 저장된 **최신 표본 1개**를 시장별로 읽는다.

    **읽기 경로는 벤더를 부르지 않는다.** ka10051 이 이미 수집 주기마다 업종 행
    전부를 싣고 있었고 수집기가 그대로 저장해 왔다(#1105 가 종합 행만 소비했을
    뿐이다). 그래서 이 표면을 여는 데 새 벤더 호출이 0 이다.

    시계열이 아니라 **스냅샷**인 이유: 업종 30개 × 3주체를 시각축으로 그리면 읽을 수
    없다. 카드가 답하는 질문은 "지금 어느 업종에 누가 들어와 있나" 이고 그건 최신
    표본 하나로 답해진다.

    ⚠ **호출부에 TTL 캐시가 없다** — 예전 주석은 "60초 TTL 로 감싼다" 고 적어 두었는데
    호출부(`get_sector_flow`)는 `to_thread` 로 직접 부른다. 그 주석이 죽은 채 남아
    있었고, 같은 함수의 핸들러 docstring 은 반대로 "캐시를 두지 않는다" 고 말하고
    있었다(2026-08-10 정정).

    비용 자체는 여전히 실재한다: `load_samples` 가 **하루치를 통째로 파싱**한다(장
    마감 무렵 4MB+). 캐시가 없으므로 그 비용은 **프론트 폴링 주기에 그대로 비례**하고,
    `/investor-flow` 가 같은 파일을 따로 또 파싱한다. 두 훅의 주기를 함께 움직여야
    하는 이유다(둘 다 30초 — 수집 주기와 같다).
    """
    from hoga.collector.orchestrator import now_kst  # noqa: PLC0415
    from hoga.live.investor_flow_store import InvestorFlowStore  # noqa: PLC0415

    date = now_kst().strftime("%Y%m%d")
    samples = InvestorFlowStore(data_dir).load_samples(date)

    # 시장별 마지막 표본. 두 시장이 한 파일에 번갈아 쌓이므로 뒤에서부터 덮어쓴다.
    latest: dict[str, Any] = {}
    for s in samples:
        mrkt = str(s.request.get("mrkt_tp") or "")
        if mrkt in _MARKETS:
            latest[mrkt] = s

    markets: dict[str, Any] = {}
    sampled_at: int | None = None
    for mrkt, s in latest.items():
        markets[_MARKET_LABELS[mrkt]] = market_overview.parse_sector_investor_rows(s.rows)
        sampled_at = max(sampled_at or 0, s.sampled_at_ms)

    return {
        "date": date,
        # 단위를 이름이 아니라 필드로 말한다(#1117 규약) — 억원.
        "unit": "amt_eok",
        # 데이터 나이를 화면이 말할 수 있어야 한다. 수집기가 죽으면 카드는 마지막
        # 표본을 계속 그리는데, 그게 언제 것인지 없으면 멎은 걸 알 수 없다.
        "sampled_at_ms": sampled_at,
        "markets": markets,
    }


async def _collect_sectors(call: Any) -> dict[str, Any]:
    """지수 값 + 등락종목수 + KRX 업종 + **변동성지수** (ka20003, 시장별 1콜).

    등락종목수는 **종합지수 행에만** 싣는다(#1100) — 업종 행에는 화면이 쓰지 않아
    싣지 않고, 지수 상품(코스피200·코스닥150)은 표시 규칙상 대상이 아니다.

    `volatility`(VKOSPI)는 **코스피 응답의 업종행 하나**(`603`)에서 온다. 화면에서는
    시장 구분 없는 단독 카드라 최상위로 올린다 — 벤더가 KIS 선물(`A04608`)이 아니라
    키움이라는 점이 중요하다. 그 선물은 미결제 54계약·당일 거래량 0 이라 정산가가
    현재가로 굳어 장중 내내 움직이지 않았다(2026-08-07 실측). 같은 값을 이 TR 이
    이미 30초마다 싣고 있었다.
    """
    out: dict[str, Any] = {"markets": {}, "volatility": None}
    for mrkt_tp in _MARKETS:
        inds_cd = "001" if mrkt_tp == "0" else "101"
        rows = await call("ka20003", {"mrkt_tp": mrkt_tp, "inds_cd": inds_cd},
                          key=("market-sectors", mrkt_tp))
        if rows is None:
            continue
        parsed = market_overview.parse_index_sectors(rows)
        out["markets"][mrkt_tp] = {
            "index": next(
                ({"code": b.code, "name": b.name, "value": b.value,
                  "change_pct": b.change_pct, "rising": b.rising, "falling": b.falling,
                  "flat": b.flat, "upper": b.upper, "lower": b.lower,
                  "trade_value_eok": b.trade_value_eok, "listed_count": b.listed_count}
                 for b in parsed if b.is_whole_market),
                None,
            ),
            # 업종 행에도 거래대금을 싣는다 — 규모별(대형/중형/소형) 쏠림과 업종
            # 분산도가 이 필드 위에 선다. `listed_count` 는 종합 행에만 의미가 있다.
            "sectors": [
                {"code": b.code, "name": b.name, "value": b.value,
                 "change_pct": b.change_pct, "trade_value_eok": b.trade_value_eok}
                for b in parsed
                if not b.is_whole_market and b.code != _VKOSPI_SECTOR_CODE
            ],
        }
        vkospi = next((b for b in parsed if b.code == _VKOSPI_SECTOR_CODE), None)
        if vkospi is not None:
            out["volatility"] = {
                "code": vkospi.code, "name": vkospi.name,
                "value": vkospi.value, "change_pct": vkospi.change_pct,
            }
    return out


async def _collect_program(call: Any, api_id: str, *, scaled: bool, axis: str) -> dict[str, Any]:
    """프로그램 매매 추이. `scaled` 는 **기본값 없이** 호출부가 밝힌다 — 같은 이름의
    `kospi200` 이 ka90005 는 ×100, ka90010 은 소수점이라 한 파서로 묶으면 100배 틀린다."""
    from hoga.collector.orchestrator import now_kst  # noqa: PLC0415

    date = now_kst().strftime("%Y%m%d")
    out: dict[str, Any] = {"axis": axis, "markets": {}}
    for mrkt_tp, label in (("P00101", "KOSPI"), ("P10102", "KOSDAQ")):
        rows = await call(
            api_id,
            {"date": date, "amt_qty_tp": "1", "mrkt_tp": mrkt_tp,
             "min_tic_tp": "0" if scaled else "1", "stex_tp": _STEX_ALL},
            key=("market-program", api_id, mrkt_tp),
        )
        if rows is None:
            continue
        out["markets"][label] = market_overview.parse_program_trend(
            rows,
            kospi200_scaled=scaled,
            # 일별 축 + 코스닥의 kospi200·basis 는 실측상 틀린 값이다(파서 독스트링).
            trust_index_columns=scaled or label == "KOSPI",
        )
    return out


async def _collect_breadth(walk: Any) -> dict[str, Any]:
    """52주 신고·신저 2카운트 × 2시장. `walk` 는 `(rows, truncated)` 를 주는 커서 호출.

    ka10016 은 임계 개념이 없어 전량 센다 — 급등락(ka10019)이 쓰던 `jmp_rt` 내림차순
    조기종료는 그 쿼리와 함께 빠졌다(`_BREADTH_QUERIES` 주석 참조).
    """
    out: dict[str, Any] = {"markets": {}}
    for mrkt_tp, label in (("001", "KOSPI"), ("101", "KOSDAQ")):
        bucket: dict[str, Any] = {}
        for api_id, axis_key, axis_val, name in _BREADTH_QUERIES:
            got = await walk(
                api_id,
                {"mrkt_tp": mrkt_tp, axis_key: axis_val, **_KA10016_BASE},
                key=("market-breadth", api_id, mrkt_tp, axis_val),
                stop=None,
            )
            if got is None:
                continue
            rows, truncated = got
            bucket[name] = {"count": len(rows), "truncated": truncated}
        if bucket:
            out["markets"][label] = bucket
    return out


class _FuturesRuntimeHolder:
    """KIS 선물 런타임의 **지연 생성** + 마지막 관측 상태 보관.

    지연 생성인 이유는 `_seam` 이 키움에 대해 하는 판단과 같다 — `hoga.live.*` 는
    heavy import 라 `build_router` 시점에 끌어오면 무자격 환경(테스트·e2e)에서도
    KIS 스택 전체가 로드된다.

    **세션·사유를 따로 들고 있는 이유**가 더 중요하다. `_TtlCache` 는 실패해도
    last-good 을 축출하지 않으므로(규약 3) 벤더가 저하되면 캐시는 옛 quotes 를 계속
    돌려준다. 그때 세션까지 옛것이면 화면이 "야간인데 주간 마감본" 을 말하지 못하고
    낡은 값을 실시간처럼 그린다 — 값은 낡아도 되지만 **낡았다는 사실은 최신**이어야 한다.
    """

    def __init__(self, data_dir: Path | None) -> None:
        self._data_dir = data_dir
        self._runtime: Any = None
        self.session = "closed"
        self.unavailable: str | None = None

    def _ensure(self) -> Any:
        if self._runtime is None:
            # **프로세스 싱글턴을 공유한다 — 여기서 새로 만들면 안 된다.** 이 런타임이
            # 야간 WS 를 소유하는데 슬롯을 두 벌 쥐면 벤더가 한쪽을 끊는다. 스케줄러
            # keeper 도 같은 인스턴스를 쓰므로, 배선은 `futures_runtime` 한 곳에 있다.
            from hoga.live.futures_runtime import ensure_runtime  # noqa: PLC0415

            self._runtime = ensure_runtime(self._data_dir)
        return self._runtime

    async def collect_sparks(self) -> dict[str, Any] | None:
        """스파크라인. 비면 None — 시세와 마찬가지로 last-good 을 덮지 않는다."""
        series = await self._ensure().sparks()
        if not series:
            return None
        return {
            "series": {
                item_id: {
                    "closes": list(s.closes),
                    "day_open": s.day_open,
                    # 종목마다 다르다 — 야간 봉이 쌓인 카드는 야간 모양, 무음인 카드는
                    # 그날 주간장 모양이다. 시세의 `data_session` 과 짝을 이룬다.
                    "session": s.session,
                    # 야간만 실린다(주간은 REST 로 소급 조회되므로 "놓친 구간" 이 없다).
                    # 스파크라인엔 축이 없어 앞이 잘린 선을 화면만으로는 못 가린다.
                    "coverage": None
                    if s.coverage is None
                    else {
                        "first_hhmm": s.coverage.first_hhmm,
                        "observed_buckets": s.coverage.observed_buckets,
                        "gap_count": s.coverage.gap_count,
                    },
                    # 야간 시리즈일 때 같이 오는 주간 모양. 값 쪽 `day` 와 짝이다 —
                    # 한쪽만 있으면 '주간' 선택이 숫자만 바꾸고 그림은 비운다.
                    "day": None
                    if s.day_series is None
                    else {"closes": list(s.day_series[0]), "day_open": s.day_series[1]},
                    # 주간 시리즈에 붙는 직전 야간 그림. 값 쪽 `night` 와 짝이라
                    # 한쪽만 있으면 '야간' 선택이 숫자만 바꾸고 그림을 비운다.
                    "night": None
                    if s.night_series is None
                    else {"closes": list(s.night_series[0]), "session_day": s.night_series[1]},
                }
                for item_id, s in series.items()
            }
        }

    async def collect(self) -> dict[str, Any] | None:
        """한 번 수집. **quotes 가 비면 None** — last-good 을 덮지 않기 위해서다."""
        snap = await self._ensure().snapshot()
        self.session = snap.session
        self.unavailable = snap.unavailable
        if not snap.cards:
            return None
        return {
            "quotes": [
                {
                    "id": c.item.id,
                    "underlying_id": c.item.underlying_id,
                    "label": c.item.label,
                    "code": c.quote.code,
                    "expiry": c.quote.expiry,
                    "days_left": c.quote.days_left,
                    "last_trade_date": c.quote.last_trade_date,
                    "value": c.quote.value,
                    "change": c.quote.change,
                    "change_rate": c.quote.change_rate,
                    "prev_close": c.quote.prev_close,
                    "volume": c.quote.volume,
                    "open_interest": c.quote.open_interest,
                    "oi_change": c.quote.oi_change,
                    # 시장 베이시스(선물−기초자산). 이론 베이시스(`basis`)가 아니다 —
                    # 둘을 바꾸면 부호까지 뒤집힌다(kis_futures_endpoints docstring).
                    "market_basis": c.quote.market_basis,
                    "disparity": c.quote.disparity,
                    # **종목마다 다르다.** 야간 유동성이 상품별로 갈려서, 같은 순간에
                    # KOSPI200 은 night 이고 코스닥150 은 day(주간 마감본)일 수 있다.
                    "data_session": c.data_session,
                    "t_ms": c.quote.t_ms,
                    # 야간 카드에만 실린다 — 있으면 화면이 주간↔야간을 고를 수 있다.
                    # 야간 REST 가 주간 마감본이라 이 값은 이미 손에 있었고, 여기까지
                    # 흘려보내는 데 벤더 호출이 늘지 않는다.
                    "day": None
                    if c.day_quote is None
                    else {
                        "value": c.day_quote.value,
                        "change": c.day_quote.change,
                        "change_rate": c.day_quote.change_rate,
                        "prev_close": c.day_quote.prev_close,
                        "volume": c.day_quote.volume,
                        "open_interest": c.day_quote.open_interest,
                        "oi_change": c.day_quote.oi_change,
                        "market_basis": c.day_quote.market_basis,
                        "disparity": c.day_quote.disparity,
                        "t_ms": c.day_quote.t_ms,
                    },
                    # 직전 야간장의 마지막 값 — 낮·마감에만. 출처는 벤더가 아니라
                    # 디스크 기록이라(야간 소급 경로 없음) 저장 전의 밤은 영영 없다.
                    "night": None
                    if c.night_quote is None or c.night_session_day is None
                    else {
                        "session_day": c.night_session_day,
                        "value": c.night_quote.value,
                        "change": c.night_quote.change,
                        "change_rate": c.night_quote.change_rate,
                        "prev_close": c.night_quote.prev_close,
                        "volume": c.night_quote.volume,
                        "open_interest": c.night_quote.open_interest,
                        "oi_change": c.night_quote.oi_change,
                        "market_basis": c.night_quote.market_basis,
                        "disparity": c.night_quote.disparity,
                        "t_ms": c.night_quote.t_ms,
                    },
                }
                for c in snap.cards
            ],
        }


def _register_futures_routes(router: APIRouter, *, data_dir: Path | None) -> None:
    """선물 표면 2개(시세·스파크라인)를 등록한다.

    `build_router` 에서 떼어낸 이유는 길이 때문만이 아니다 — 이 두 라우트는 벤더가
    **KIS** 라 키움 시임(`_seam`)·거버너·유량 버킷과 아무 것도 공유하지 않는다.
    나란히 두면 `_call` 을 쓰지 않는 라우트가 키움 헬퍼 사이에 끼어 읽기 어려워진다.
    """
    # `/live/index-quotes`(키움 칼 컷오버, #1039)에 섞지 않고 표면을 따로 두는 이유:
    # 한 응답에 두 벤더를 담으면 "어느 쪽이 늦었나" 가 응답에서 사라진다.
    futures_cache = _TtlCache(TTL_FUTURES_S)
    # 분봉은 5분에 한 번만 늘어난다 — 시세(20s)와 한 캐시에 묶으면 3콜이 시세
    # 주기로 끌려 올라간다.
    futures_spark_cache = _TtlCache(TTL_FUTURES_SPARK_S)
    futures_runtime = _FuturesRuntimeHolder(data_dir)

    @router.get("/futures-quotes")
    async def get_futures_quotes() -> FuturesQuotesResponse:
        """지수선물 근월물 시세 (KIS `FHMIF10000000`) — 지수 카드의 선물 토글.

        **키움에는 파생 TR 이 0건이라 대체 경로가 없다**(337개 전수 조사). 그래서
        ADR-0136 의 "실시간·폴링은 전부 키움" 분담에서 이 표면만 KIS 로 남는다 —
        옵션 심리 패널(ADR-0135)과 같은 이유다.

        최상위 `session`(지금 열린 세션)과 각 quote 의 `data_session`(그 값이 속한
        세션)이 **다를 수 있고, 종목마다도 다르다**. 야간에 REST 는 주간 마감본을
        주고 WS 틱은 유동성 있는 종목에만 온다 — 실측(2026-08-07 00:36, 40초)에서
        KOSPI200 48틱 / 코스닥150 0틱 / VKOSPI 0틱이었다. 화면은 카드마다 그 차이를
        말해야 한다. 안 그러면 6시간 전 값을 실시간으로 읽는다.
        """
        got = await futures_cache.get(futures_runtime.collect)
        # 세션·사유는 **항상 최신 관측**으로 덮는다. quotes 는 last-good 일 수 있다.
        head = {
            "session": futures_runtime.session,
            "unavailable": futures_runtime.unavailable,
        }
        return {**(got or {"quotes": []}), **head}

    @router.get("/futures-candles")
    async def get_futures_candles() -> FuturesCandlesResponse:
        """선물 카드 스파크라인 — 당일 **5분봉** 종가 (KIS `FHKIF03020200`).

        5분인 이유는 취향이 아니라 상한이다: 이 TR 은 102건까지만 주므로 1분봉이면
        13:54~15:45 만 와서 스파크라인이 하루의 1/4을 그린다. 5분봉은 83건으로
        08:45~15:45 전 구간을 덮는다(2026-08-06 실측).

        **주간 데이터뿐이다.** 야간 틱은 이 REST 에 오지 않으므로, 야간에는 그날
        주간장의 모양을 그린다 — 시세 카드가 "주간 마감값" 배지를 다는 것과 같은 상태다.
        """
        got = await futures_spark_cache.get(futures_runtime.collect_sparks)
        return got or {"series": {}}


def build_router(*, data_dir: Path) -> APIRouter:  # noqa: PLR0915 — 라우트 조립점: 문장 수는 라우트 개수의 함수다
    router = APIRouter(prefix="/api/market", tags=["market"])

    sectors_cache = _TtlCache(TTL_SECTORS_S)
    # 축마다 캐시가 갈려야 한다 — 한 캐시를 공유하면 당일/일별 토글이 서로의 값을 지운다.
    program_cache = _TtlCache(TTL_PROGRAM_INTRADAY_S)
    daily_program_cache = _TtlCache(TTL_PROGRAM_DAILY_S)
    # 시장·방향 **조합마다** 캐시가 갈려야 한다 — 위 프로그램 축과 같은 이유다. 한
    # 슬롯을 공유하면 토글이 서로의 값을 지우고, 더 나쁘게는 TTL 안에서 **다른 축의
    # payload 를 그대로** 받는다(`_TtlCache` 는 키 없는 단일 슬롯이다). 축이 둘이 되며
    # 조합이 4개로 늘었는데, 축을 하나만 키잉하는 실수가 그중 절반에서만 드러나므로
    # 처음부터 조합을 키로 쓴다.
    streaks_caches = {
        (m, d): _TtlCache(TTL_STREAKS_S)
        for m in get_args(MarketName)
        for d in get_args(StreakDirection)
    }
    breadth_cache = _TtlCache(TTL_BREADTH_S)
    # 증시 주변 자금은 벤더가 다르다(KOFIA) — 키움 거버너·TTL 축과 분리해 자체 캐시를 쓴다.
    funds_cache = MarketFundsCache()
    _register_futures_routes(router, data_dir=data_dir)

    def _seam() -> tuple[Any, Any] | None:
        """(거버너, 클라이언트). 무자격이면 None — 라우트는 빈 응답을 돌려준다."""
        from hoga.live import kiwoom_rest_runtime  # noqa: PLC0415 — 지연 import(heavy·시임)

        client = kiwoom_rest_runtime.ensure_rest_client(data_dir)
        if client is None:
            return None
        return kiwoom_rest_runtime.ensure_scheduler(data_dir), client

    async def _call(api_id: str, body: dict[str, str], *, key: tuple) -> list[dict[str, Any]] | None:
        seam = _seam()
        if seam is None:
            return None
        scheduler, client = seam
        page = await kiwoom_access.run_with_capacity(
            scheduler,
            key=key,
            api_id=api_id,
            priority="background",
            client=client,
            # 기본인자 바인딩 — late binding 이면 모든 호출이 마지막 body 를 본다.
            fetch_fn=lambda c, b=body: c.call(api_id, b),
        )
        return list(getattr(page, "rows", []) or [])

    @router.get("/sectors")
    async def get_sectors() -> MarketSectorsResponse:
        """지수 값 + **등락종목수** + KRX 업종 (ka20003, 시장별 1콜).

        등락종목수는 종합지수(001/101)에만 싣는다(#1100) — 지수 상품(코스피200·
        코스닥150)에는 표시 규칙상 붙이지 않는다. 코스피200 은 벤더에 값 자체가 없다.
        """

        return await sectors_cache.get(lambda: _collect_sectors(_call)) or {"markets": {}}

    @router.get("/program")
    async def get_program(axis: str = "intraday") -> ProgramResponse:
        """프로그램 매매 추이. `axis=intraday`(ka90005) | `daily`(ka90010).

        ⚠ 두 TR 은 응답 스키마가 같고 **`kospi200` 스케일만 다르다** — 파서에
        `kospi200_scaled` 를 명시적으로 넘기는 이유다(기본값을 두지 않았다).
        """
        api_id = "ka90005" if axis == "intraday" else "ka90010"
        scaled = axis == "intraday"

        cache = program_cache if axis == "intraday" else daily_program_cache
        got = await cache.get(
            lambda: _collect_program(_call, api_id, scaled=scaled, axis=axis)
        )
        return got or {"axis": axis, "markets": {}}

    async def _walk(
        api_id: str, body: dict[str, str], *, key: tuple, stop: Any = None
    ) -> tuple[list[dict[str, Any]], bool] | None:
        """커서를 따라가는 호출. `(rows, truncated)` — 절사 여부가 값과 동급이다.

        **페이지 1장 = submit 1건**이다(ADR-0137). walk 전체를 한 submit 으로 감싸면
        버킷은 1 을 세고 벤더는 N 을 센다 — 그래서 `run_page` 이음매에 넣는다.
        """
        seam = _seam()
        if seam is None:
            return None
        scheduler, client = seam

        def _run_page(fetch_fn: Any, page_idx: int) -> Any:
            return kiwoom_access.run_with_capacity(
                scheduler,
                key=(*key, page_idx),
                api_id=api_id,
                priority="background",
                client=client,
                fetch_fn=fetch_fn,
            )

        return await client.walk(
            api_id,
            body,
            max_pages=market_overview.MAX_BREADTH_PAGES,
            stop=stop,
            run_page=_run_page,
        )

    @router.get("/breadth", response_model_exclude_none=True)
    async def get_breadth() -> BreadthResponse:
        """52주 신고·신저 (ka10016).

        **카운트를 주지 않고 목록을 준다**(#1096) — 행을 세야 하고, 상한에 닿았으면
        `truncated` 로 말한다. 조용한 절사는 "전부 셌다" 로 읽힌다(#1099).

        **급등·급락(ka10019)은 뺐다.** 그 두 값을 쓰던 시장 폭 카드가 업종 수급으로
        교체되면서 소비자가 0 이 됐다. ka10019 는 이 라우터에서 가장 무거운 콜이었다 —
        `jmp_rt` 내림차순 페이지 walk 를 시장마다 도는데, 아무도 안 보는 숫자를 위해
        5분마다 그걸 돌 이유가 없다. 상·하한 종목수는 원래 여기 없었고 `/sectors` 의
        `upper`/`lower`(ka20003)가 답한다.
        """

        return await breadth_cache.get(lambda: _collect_breadth(_walk)) or {"markets": {}}

    @router.get("/sector-flow")
    async def get_sector_flow() -> SectorFlowResponse:
        """업종별 투자자 순매수 — 저장된 최신 표본(ka10051, 벤더 호출 없음).

        수집기가 30초마다 찍어 온 표본에 업종 행이 처음부터 들어 있었다 — 종합 행만
        소비하고 나머지를 흘려보내고 있었을 뿐이다(#1105 의 파서 주석이 그렇게 적어
        두었다). 그래서 이 표면은 **새 벤더 호출이 0** 이다.

        **TTL 캐시를 두지 않는다** — 형제인 `/investor-flow` 와 같은 규율이다. 저 캐시는
        벤더 유량을 아끼는 장치인데 여기는 벤더가 없다. 디스크 파싱 비용(하루치 전량)은
        `to_thread` 로 이벤트 루프 밖에 두고, 호출 빈도는 프론트 폴링(30초)이 정한다.
        """
        return await asyncio.to_thread(_sector_flow_payload, data_dir)

    @router.get("/funds")
    async def get_funds() -> FundsResponse:
        """증시 주변 자금 — 예탁금·신용융자·CMA (KOFIA, 이 페이지의 유일한 제3 벤더).

        `KOFIA_API_KEY` 가 없으면 `unavailable="credentials_missing"` 로 이 카드만
        비고 나머지 표면은 정상 동작한다(ADR-0134). 기준일(`as_of`)은 **응답에서**
        오므로 화면은 "T+2" 를 고정 문구로 박으면 안 된다.
        """
        return await funds_cache.get()

    @router.get("/investor-flow")
    async def get_investor_flow() -> InvestorFlowResponse:
        """장중 수급 — 수집기가 적재한 표본(#1120)을 읽는다. 벤더를 부르지 않는다.

        커버리지가 값과 동급이다: 수집이 죽으면 차트가 **짧은 선을 사실처럼** 그린다.
        재시작 공백은 `gap_ranges` 로 정직하게 드러나고 **메울 수는 없다**(#1105).
        """
        return await asyncio.to_thread(_investor_flow_payload, data_dir)

    @router.get("/deriv-flow")
    async def get_deriv_flow() -> DerivFlowResponse:
        """파생 투자자 수급 — 수집기가 적재한 표본(KIS `FHPTJ04030000`)을 읽는다.
        벤더를 부르지 않는다.

        `/investor-flow` 와 두 가지가 다르다:

        - **세션이 15:45 까지다**(주식 15:30). x축을 화면이 하드코딩하지 않게
          `session_*_sec` 로 응답이 말한다.
        - **`unit` 이 null 일 수 있다.** 벤더가 대금 단위를 말해 주지 않아 값에서
          역산하는데(`deriv_flow_units`), 장 초반처럼 판정이 안 서면 억원 축이 통째로
          빈다. 그때도 계약 축(`*_qty`)은 멀쩡하다 — 화면은 `units.reason` 을 그대로
          보여 주면 된다. 억지로 환산하면 그게 #1117 이다.

        **KIS 키가 없으면 통째로 빈다**(ADR-0134) — 파생 투자자 수급은 KIS 만 주고
        (키움 REST 337 TR 중 파생 투자자 TR 0건) 이 TR 은 모의투자 미지원이다.
        """
        return await asyncio.to_thread(_deriv_flow_payload, data_dir)

    @router.get("/streaks")
    async def get_streaks(
        direction: StreakDirection = "buy", market: MarketName = "KOSPI"
    ) -> StreaksResponse:
        """연속 순매수/순매도 — **한 콜이 외국인·기관 두 카드**를 채운다(ka10131, #1096).

        `direction`·`market` 은 각각 벤더 `netslmt_tp`·`mrkt_tp` 로 매핑된다. 축을
        **쿼리 파라미터로** 가르고 응답 키(`외국인`·`기관`)는 그대로 둔다 — 한 응답에
        네 조합을 다 실으면 평소 아무도 안 보는 3/4 까지 매번 벤더를 부르게 된다.
        화면이 토글할 때만 그 조합을 부르는 것이 이 갈래의 목적이다(기본값
        `buy`·`KOSPI` 라 기존 호출자는 무변경).

        방향별 부호 필터가 왜 여전히 필요한지는 `parse_streaks` 의 docstring 에,
        시장 코드를 왜 라벨로 받는지는 `_MRKT_TP` 주석에 있다.
        """

        async def _fetch() -> dict[str, Any]:
            rows = await _call(
                "ka10131",
                {"dt": "1", "mrkt_tp": _MRKT_TP[market], "netslmt_tp": _NETSLMT_TP[direction],
                 "stk_inds_tp": "0", "amt_qty_tp": "0", "stex_tp": _STEX_ALL},
                # 유량 키도 조합별이다 — 같은 TR 이라도 조합마다 서로 다른 페이지라
                # 한 키로 묶으면 한쪽의 페이싱이 다른 쪽을 대신 소모한다.
                key=("market-streaks", market, direction),
            )
            if rows is None:
                return {"외국인": [], "기관": [], "warnings": []}
            # ETF·ETN 제외 — 순위 드로어와 같은 방식(심볼 마스터 기반). KODEX 레버리지
            # 류가 상위를 채우면 "누가 무엇을 사나" 라는 카드의 질문에 답이 안 된다.
            # 마스터 미로드면 못 거른 채 경고를 실어 보낸다(조용한 실패 금지).
            from hoga.api import symbols  # noqa: PLC0415

            warnings: list[str] = []
            drop = symbols.all_etf_etn_codes()
            if drop is None:
                warnings.append("etf_filter_unavailable")
            else:
                rows = [r for r in rows
                        if str(r.get("stk_cd") or "").split("_")[0] not in drop]
            return {
                "warnings": warnings,
                **{
                    actor: market_overview.parse_streaks(rows, actor=actor, direction=direction)
                    for actor in ("외국인", "기관")
                },
            }

        return await streaks_caches[(market, direction)].get(_fetch) or {
            "외국인": [], "기관": [], "warnings": []
        }

    return router
