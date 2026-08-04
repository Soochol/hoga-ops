"""KIS endpoint fetch methods (KisEndpointsMixin) + their parsers/dataclasses.

Split from kis_client.py (Stage 4, 2026-07-08) so the transport core stays
independently readable. ``KisClient`` composes ``KisEndpointsMixin``; the method
bodies are verbatim and reference ``self._get`` (resolved via the KisClient MRO)
plus this module's own helpers only — no state beyond the injected getter.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Literal

from hoga.live.candle_models import IndexCandlePoint
from hoga.live.index_registry import RepresentativeIndex
from hoga.live.investor import InvestorNetPoint
from hoga.live.kis_errors import KisApiError
from hoga.live.kis_venue import kis_venue_div
from hoga.live.venue import Venue
from hoga.util.timeenc import KST

log = logging.getLogger(__name__)

# Default KIS Venue for backwards-compatible callers. New /live candle routes
# pass an explicit venue value and include it in cache/query keys.
_DEFAULT_KIS_VENUE: Venue = "KRX"
_STOCK_MRKT_DIV = kis_venue_div(_DEFAULT_KIS_VENUE)

@dataclass(frozen=True)
class IndexQuoteSnapshot:
    """국내업종 현재지수 1건 (FHPUP02100000) — 하단 시장지표 바 용.

    change/change_rate 는 부호 정규화 완료값 (KRX 하락 = 음수).
    t_ms 는 fetch 시각(epoch ms) — KIS 응답에 체결 시각이 없어 수신 시각으로 대체.
    """
    index_id: str
    value: float
    change: float
    change_rate: float
    t_ms: int


@dataclass(frozen=True)
class KisQuote:
    """One row of intstock-multprice (현재가 + 등락률 + 전일대비 등락액 + 당일 OHLCV) for a Code."""
    code: str
    price: int
    change_pct: float | None
    change_won: int | None = None
    # 당일 OHLC(inter2_oprc/hgpr/lwpr). 기본 None — positional 생성자/동등성 테스트 보존.
    open: int | None = None
    high: int | None = None
    low: int | None = None
    volume: int | None = None
    previous_close: int | None = None


@dataclass(frozen=True)
class InvestorNetInvariantViolation:
    """A row dropped by fetch_investor_net boundary defense.

    Investor rows carry no OHLC invariant, so the only drop reason is a
    malformed/missing trading date. Surfaced to wire data_warnings.
    """
    date_yyyymmdd: str
    reason: Literal["malformed_row"]
    detail: str


@dataclass(frozen=True)
class InvestorNetFetchResult:
    """Return value of fetch_investor_net.

    `points` is ASC-sorted by t_ms; `violations` is the per-row drop log.
    """
    points: list[InvestorNetPoint]
    violations: list[InvestorNetInvariantViolation] = field(default_factory=list)


def _daily_anchor_t_ms(date_yyyymmdd: str) -> int:
    """Epoch-ms anchor for a daily datum: 09:00:00 KST of the trading day.

    Single source of truth shared by daily candles and investor-net so the
    frontend pins both series to the same x-coordinate. Callers must pass a
    validated 8-char YYYYMMDD (boundary defense lives in the caller).
    """
    dt = datetime(
        int(date_yyyymmdd[:4]), int(date_yyyymmdd[4:6]), int(date_yyyymmdd[6:8]),
        9, 0, tzinfo=KST,
    )
    return int(dt.timestamp() * 1000)


def _row_value(row: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = row.get(key)
        if value not in (None, ""):
            return value
    raise KeyError(keys[0])


def _parse_index_daily_row(row: dict[str, Any]) -> IndexCandlePoint:
    date_str = str(_row_value(row, "stck_bsop_date", "bsop_date"))
    if len(date_str) != 8:  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
        raise ValueError("stck_bsop_date missing or wrong length")
    return IndexCandlePoint(
        t_ms=_daily_anchor_t_ms(date_str),
        open=float(_row_value(row, "bstp_nmix_oprc", "oprc")),
        high=float(_row_value(row, "bstp_nmix_hgpr", "hgpr")),
        low=float(_row_value(row, "bstp_nmix_lwpr", "lwpr")),
        close=float(_row_value(row, "bstp_nmix_prpr", "prpr")),
        volume=int(float(_row_value(row, "acml_vol", "cntg_vol", "volume"))),
    )


# KIS 업종분봉(FHKUP03500200)이 FID_PW_DATA_INCU_YN=Y 응답에 매 거래일마다 끼워
# 넣는 시각 더미 — 999999 = 장마감 집계 행, 888888 = 예상체결 행. 실제 체결 시각이
# 아니라 프로토콜이 규정한 자리표시자다. _parse_index_minute_row 에 넘기면
# datetime() 이 ValueError("hour must be in 0..23") 를 던지고, 호출자는 그것을
# malformed_row violation 으로 승격시켜 정상 응답이 프론트에 "일부 과거구간 로딩
# 실패" 로 보고된다(2026-07-29 실측: 거래일당 2건). 같은 봉 데이터는 정상 시각 행에
# 이미 들어 있으므로 조용히 버려도 손실이 없다.
_INDEX_MINUTE_SENTINEL_HOURS = frozenset({"999999", "888888"})


def _is_index_minute_sentinel_row(row: dict[str, Any]) -> bool:
    """True iff the row's time field is a KIS filler, not a real HHMMSS.

    판정을 파서 밖(원본 row)에 두는 이유: 파서의 실패 채널은 ValueError 하나뿐이라
    "규약상 더미"와 "진짜 malformed"를 구분할 수 없다. 알려진 더미 값만 정확히
    맞출 때 skip 하고, 그 외의 깨진 시각은 기존 malformed_row 경로로 흘려보낸다.
    """
    hour_str = str(row.get("stck_cntg_hour") or row.get("bsop_hour") or "").strip()
    return hour_str[:6] in _INDEX_MINUTE_SENTINEL_HOURS


def _parse_index_minute_row(row: dict[str, Any]) -> IndexCandlePoint:
    date_str = str(_row_value(row, "stck_bsop_date", "bsop_date"))
    hour_str = str(_row_value(row, "stck_cntg_hour", "bsop_hour"))
    if len(date_str) != 8:  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
        raise ValueError("stck_bsop_date missing or wrong length")
    if len(hour_str) < 6:  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
        raise ValueError("stck_cntg_hour missing or wrong length")
    hour_str = hour_str[:6]
    dt = datetime(
        int(date_str[:4]), int(date_str[4:6]), int(date_str[6:8]),
        int(hour_str[:2]), int(hour_str[2:4]), int(hour_str[4:6]),
        tzinfo=KST,
    )
    return IndexCandlePoint(
        t_ms=int(dt.timestamp() * 1000),
        open=float(_row_value(row, "bstp_nmix_oprc", "oprc")),
        high=float(_row_value(row, "bstp_nmix_hgpr", "hgpr")),
        low=float(_row_value(row, "bstp_nmix_lwpr", "lwpr")),
        close=float(_row_value(row, "bstp_nmix_prpr", "prpr")),
        volume=int(float(_row_value(row, "cntg_vol", "acml_vol", "volume"))),
    )


def _aggregate_index_minute_candles(
    candles: list[IndexCandlePoint],
    bucket_seconds: int,
    source_seconds: int = 60,
) -> list[IndexCandlePoint]:
    """소스 주기 캔들을 표시 버킷으로 접는다. 소스가 이미 표시 버킷 이상이면
    (= _kis_index_minute_unit_seconds 가 정확한 소스를 골랐을 때) 정렬만 하고
    그대로 통과 — 접기는 약수 폴백 경로 전용이다."""
    if bucket_seconds <= source_seconds:
        return sorted(candles, key=lambda c: c.t_ms)
    bucket_ms = bucket_seconds * 1000
    buckets: dict[int, list[IndexCandlePoint]] = {}
    for candle in sorted(candles, key=lambda c: c.t_ms):
        dt = datetime.fromtimestamp(candle.t_ms / 1000, KST)
        session_open = dt.replace(hour=9, minute=0, second=0, microsecond=0)
        session_open_ms = int(session_open.timestamp() * 1000)
        bucket_start = session_open_ms + ((candle.t_ms - session_open_ms) // bucket_ms) * bucket_ms
        buckets.setdefault(bucket_start, []).append(candle)

    aggregated: list[IndexCandlePoint] = []
    for bucket_start in sorted(buckets):
        rows = buckets[bucket_start]
        aggregated.append(IndexCandlePoint(
            t_ms=bucket_start,
            open=rows[0].open,
            high=max(r.high for r in rows),
            low=min(r.low for r in rows),
            close=rows[-1].close,
            volume=sum(r.volume for r in rows),
        ))
    return aggregated


# KIS 업종분봉(FHKUP03500200)이 서버측 주기로 받아들이는 초 단위 — 실측 2026-07-29.
#
# 이 TR 의 FID_INPUT_HOUR_1 은 종목분봉(FHKST03010230)과 **의미가 다르다**: 종목 쪽은
# 시각 앵커(HHMMSS)라 페이지를 시간 주소로 걸어갈 수 있지만(_minute_page_anchors),
# 업종 쪽은 **주기 선택자**라 시간 커서가 없다. 어떤 주기를 넣든 응답은 항상 최신
# 102행이고(목록 밖 값 — 예: "1000" — 은 0행), 그래서 요청 날짜 범위를 넓혀도 과거는
# 채워지지 않는다.
#
# 그 상한이 고정이라, 표시 버킷보다 잔 주기를 요청하면 커버 구간이 정확히 그 배수만큼
# 짧아진다: 30분봉을 600초 소스로 받으면 102개 10분봉 → 34개 30분봉이지만, 1800초로
# 받으면 102개 30분봉이 그대로 온다(실측: 600 → 3거래일 전, 1800 → 6거래일 전부터).
# 표시 버킷과 같은 주기를 요청하는 것이 항상 최대 커버리지다.
_KIS_INDEX_MINUTE_SOURCE_UNITS = (60, 180, 300, 600, 900, 1800)


def _kis_index_minute_unit_seconds(bucket_seconds: int) -> int:
    """표시 버킷을 그대로 담는 KIS 소스 주기.

    목록 밖 버킷은 OHLC 경계를 보존하는 가장 큰 약수로 내려간다(그 경우에만
    `_aggregate_index_minute_candles` 가 접는다). 약수가 없으면 60초.
    """
    if bucket_seconds in _KIS_INDEX_MINUTE_SOURCE_UNITS:
        return bucket_seconds
    divisors = [u for u in _KIS_INDEX_MINUTE_SOURCE_UNITS if bucket_seconds % u == 0]
    return max(divisors) if divisors else 60


def _parse_market_investor_daily_row(row: dict[str, Any]) -> InvestorNetPoint:
    date_str = str(_row_value(row, "stck_bsop_date", "bsop_date"))
    if len(date_str) != 8:  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
        raise ValueError("stck_bsop_date missing or wrong length")
    foreign = _parse_optional_int(_row_value(row, "frgn_ntby_qty"))
    institution = _parse_optional_int(_row_value(row, "orgn_ntby_qty"))
    if foreign is None or institution is None:
        raise ValueError("frgn_ntby_qty/orgn_ntby_qty missing or malformed")
    return InvestorNetPoint(
        t_ms=_daily_anchor_t_ms(date_str),
        foreign_net=foreign,
        institution_net=institution,
    )


def _market_investor_codes(index: RepresentativeIndex) -> tuple[str, str]:
    if index.id == "KOSPI":
        return "KSP", index.kis_index_code or "0001"
    if index.id == "KOSDAQ":
        return "KSQ", index.kis_index_code or "1001"
    raise KisApiError(
        msg_cd="UNSUPPORTED_INDEX_INVESTOR",
        msg1=f"{index.id} does not support market investor net",
    )


def _prev_day_yyyymmdd(yyyymmdd: str) -> str:
    """YYYYMMDD of the calendar day before *yyyymmdd*. The one piece the two
    daily KIS walk-backs (``fetch_past_daily_candles`` / ``fetch_investor_net``)
    genuinely share — both step the cursor to (page oldest − 1 day). Their loop
    skeletons otherwise differ (cursor param slot, anchor semantics, termination)
    enough that a unified driver would be leaky — see ADR-0060."""
    d = datetime(
        int(yyyymmdd[:4]), int(yyyymmdd[4:6]), int(yyyymmdd[6:8]), tzinfo=KST,
    )
    return (d - timedelta(days=1)).strftime("%Y%m%d")


def _next_day_yyyymmdd(yyyymmdd: str) -> str:
    d = datetime(
        int(yyyymmdd[:4]), int(yyyymmdd[4:6]), int(yyyymmdd[6:8]), tzinfo=KST,
    )
    return (d + timedelta(days=1)).strftime("%Y%m%d")


def _parse_optional_int(value: object) -> int | None:
    if value is None:
        return None
    text = str(value).strip().replace(",", "")
    if text == "":
        return None
    try:
        return int(text)
    except ValueError:
        return None


class KisEndpointsMixin:
    # 페이지 앵커 간격(분). 페이지당 최대 120행(=120분)이므로 100분 간격이면
    # 인접 앵커 사이 바 수가 항상 캡 미만 — 전 구간 커버가 보장된다(겹침은
    # seen_t_ms dedup). 120으로 두면 "정확히 120행 + 전 분 존재" 경계에서
    # 1행이 빠질 수 있어 여유를 둔다.
    _MINUTE_PAGE_ANCHOR_STEP_MIN = 100
