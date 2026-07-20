"""KIS endpoint fetch methods (KisEndpointsMixin) + their parsers/dataclasses.

Split from kis_client.py (Stage 4, 2026-07-08) so the transport core stays
independently readable. ``KisClient`` composes ``KisEndpointsMixin``; the method
bodies are verbatim and reference ``self._get`` (resolved via the KisClient MRO)
plus this module's own helpers only — no state beyond the injected getter.
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Literal

from hoga.live.index_registry import RepresentativeIndex
from hoga.live.kis_errors import KisApiError
from hoga.live.kis_models import (
    IndexCandlePoint,
    InvestorNetPoint,
    InvestorTrendEstimateRow,
    KisCandle,
    ProgramTradeByStockRow,
)
from hoga.live.kis_venue import (
    KIS_KST,
    KisVenue,
    kis_venue_div,
    session_window_hhmmss,
)

log = logging.getLogger(__name__)

# Default KIS Venue for backwards-compatible callers. New /live candle routes
# pass an explicit venue value and include it in cache/query keys.
_DEFAULT_KIS_VENUE: KisVenue = "KRX"
_STOCK_MRKT_DIV = kis_venue_div(_DEFAULT_KIS_VENUE)

@dataclass(frozen=True)
class DailyInvariantViolation:
    """A row dropped by fetch_past_daily_candles boundary defense.

    Surfaced to the handler so wire data_warnings can tell operators which
    dates were silently lost — ADR-0040's defensive-parse policy made explicit
    (grill Q3 decision in 2026-05-28 daily backfill spec).
    """
    date_yyyymmdd: str
    reason: Literal[
        "close_nonpositive", "ohlc_inconsistent", "malformed_row", "out_of_range"
    ]
    detail: str


@dataclass(frozen=True)
class DailyCandleFetchResult:
    """Return value of fetch_past_daily_candles.

    `candles` is the cleaned, ASC-sorted result; `violations` is the per-row
    drop log so the caller can surface them to data_warnings.
    """
    candles: list["KisCandle"]
    violations: list[DailyInvariantViolation] = field(default_factory=list)


@dataclass(frozen=True)
class IndexCandleFetchResult:
    candles: list["IndexCandlePoint"]
    violations: list[DailyInvariantViolation] = field(default_factory=list)


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
    points: list["InvestorNetPoint"]
    violations: list[InvestorNetInvariantViolation] = field(default_factory=list)


def _daily_anchor_t_ms(date_yyyymmdd: str) -> int:
    """Epoch-ms anchor for a daily datum: 09:00:00 KST of the trading day.

    Single source of truth shared by daily candles and investor-net so the
    frontend pins both series to the same x-coordinate. Callers must pass a
    validated 8-char YYYYMMDD (boundary defense lives in the caller).
    """
    dt = datetime(
        int(date_yyyymmdd[:4]), int(date_yyyymmdd[4:6]), int(date_yyyymmdd[6:8]),
        9, 0, tzinfo=KIS_KST,
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
    if len(date_str) != 8:
        raise ValueError("stck_bsop_date missing or wrong length")
    return IndexCandlePoint(
        t_ms=_daily_anchor_t_ms(date_str),
        open=float(_row_value(row, "bstp_nmix_oprc", "oprc")),
        high=float(_row_value(row, "bstp_nmix_hgpr", "hgpr")),
        low=float(_row_value(row, "bstp_nmix_lwpr", "lwpr")),
        close=float(_row_value(row, "bstp_nmix_prpr", "prpr")),
        volume=int(float(_row_value(row, "acml_vol", "cntg_vol", "volume"))),
    )


def _parse_index_minute_row(row: dict[str, Any]) -> IndexCandlePoint:
    date_str = str(_row_value(row, "stck_bsop_date", "bsop_date"))
    hour_str = str(_row_value(row, "stck_cntg_hour", "bsop_hour"))
    if len(date_str) != 8:
        raise ValueError("stck_bsop_date missing or wrong length")
    if len(hour_str) < 6:
        raise ValueError("stck_cntg_hour missing or wrong length")
    hour_str = hour_str[:6]
    dt = datetime(
        int(date_str[:4]), int(date_str[4:6]), int(date_str[6:8]),
        int(hour_str[:2]), int(hour_str[2:4]), int(hour_str[4:6]),
        tzinfo=KIS_KST,
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
) -> list[IndexCandlePoint]:
    if bucket_seconds <= 60:
        return sorted(candles, key=lambda c: c.t_ms)
    bucket_ms = bucket_seconds * 1000
    buckets: dict[int, list[IndexCandlePoint]] = {}
    for candle in sorted(candles, key=lambda c: c.t_ms):
        dt = datetime.fromtimestamp(candle.t_ms / 1000, KIS_KST)
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


def _kis_index_minute_unit_seconds(bucket_seconds: int) -> int:
    if bucket_seconds in {600, 1800}:
        return 600
    if bucket_seconds in {300, 900}:
        return 300
    return 60


def _parse_market_investor_daily_row(row: dict[str, Any]) -> InvestorNetPoint:
    date_str = str(_row_value(row, "stck_bsop_date", "bsop_date"))
    if len(date_str) != 8:
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
        int(yyyymmdd[:4]), int(yyyymmdd[4:6]), int(yyyymmdd[6:8]), tzinfo=KIS_KST,
    )
    return (d - timedelta(days=1)).strftime("%Y%m%d")


def _next_day_yyyymmdd(yyyymmdd: str) -> str:
    d = datetime(
        int(yyyymmdd[:4]), int(yyyymmdd[4:6]), int(yyyymmdd[6:8]), tzinfo=KIS_KST,
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

    @staticmethod
    def _minute_page_anchors(venue: KisVenue, now_hhmmss: str | None = None) -> list[str]:
        """세션 창을 덮는 사전 계산 앵커들 (내림차순, 세션 마감부터).

        구 구현은 "다음 앵커 = 응답의 최이른 바 − 1분"인 순차 커서 워크라
        페이지들이 직렬화됐다(KRX 4페이지, UN 6~9페이지 — UN 콜드 하루
        1.5~4s의 원흉, 2026-07-11 실측). 앵커는 API가 시간 주소화를 지원하는
        덕에 사전 계산 가능하고, 그러면 전 페이지를 병렬로 쏠 수 있다.

        커버리지 논증: 임의의 세션 내 분 m에 대해 m 이상의 최소 앵커 a는
        m과 100분 이내다. a 페이지는 a 이하 최신 120행을 주므로 (m, a] 구간
        바 수 ≤ 100 < 120 → m 포함. 성긴 날은 바가 더 적어 자명하게 포함.
        마지막 앵커는 세션 개장 후 첫 100분 창을 덮도록 개장+step 아래에서
        멈춘다.
        """
        session_open_hhmmss, session_close_hhmmss = session_window_hhmmss(venue)
        open_min = int(session_open_hhmmss[:2]) * 60 + int(session_open_hhmmss[2:4])
        close_min = int(session_close_hhmmss[:2]) * 60 + int(session_close_hhmmss[2:4])
        step = KisEndpointsMixin._MINUTE_PAGE_ANCHOR_STEP_MIN
        anchors: list[str] = []
        cur = close_min
        while True:
            anchors.append(f"{cur // 60:02d}{cur % 60:02d}00")
            if cur - open_min <= step:
                break
            cur -= step
        if now_hhmmss is not None:
            # 오늘(장중) 조회: 창 (a−step, a]가 경과 세션과 겹치는 앵커만 유지 —
            # 미래 앵커들은 전부 "지금까지의 최신 120행"이라는 같은 창을 돌려주므로
            # 병렬로 다 쏘면 60초 폴마다 중복 호출만 늘린다(레이트 예산 낭비).
            # 가장 이른 겹침 앵커 하나는 남겨 커버리지를 보존한다.
            now_min = int(now_hhmmss[:2]) * 60 + int(now_hhmmss[2:4])
            kept = [a for a in anchors if (int(a[:2]) * 60 + int(a[2:4])) - step < now_min]
            anchors = kept if kept else anchors[-1:]
        return anchors

    async def fetch_past_minute_candles(
        self,
        code: str,
        date_yyyymmdd: str,
        *,
        venue: KisVenue = _DEFAULT_KIS_VENUE,
        foreground: bool = False,
    ) -> list[KisCandle]:
        """Fetch 1-minute candles for *code* on *date_yyyymmdd* (KST).

        KIS endpoint `inquire-time-dailychartprice` returns at most 120 rows
        per call, addressed by an end-time anchor (`FID_INPUT_HOUR_1`). 앵커가
        시간 주소라 사전 계산이 가능하므로 세션 창을 덮는 앵커들(KRX 4,
        NXT/UN 8)을 **병렬로** 조회한다 — 구 순차 커서 워크(다음 앵커가 직전
        응답에 의존)의 페이지 직렬화를 제거해 하루 wall이 페이지 수 × RTT에서
        ~1 RTT로 줄어든다. 겹침은 t_ms dedup, 빈 창(휴장 밴드)은 자연히 무시.
        출력은 종전과 동일하게 t_ms 오름차순(같은 바 집합 ⇒ 동일 출력).

        KIS retains roughly 1 year of historical minute candles per the
        portal docs (https://apiportal.koreainvestment.com/).
        """
        path = "/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice"
        tr_id = "FHKST03010230"
        venue_div = kis_venue_div(venue)

        async def one_page(anchor_hhmmss: str) -> list[dict]:
            params = {
                "FID_COND_MRKT_DIV_CODE": venue_div,
                "FID_INPUT_ISCD": code,
                "FID_INPUT_HOUR_1": anchor_hhmmss,
                "FID_INPUT_DATE_1": date_yyyymmdd,
                "FID_PW_DATA_INCU_YN": "N",
                "FID_FAKE_TICK_INCU_YN": "",
            }
            body = await self._get(path=path, tr_id=tr_id, params=params, foreground=foreground)
            return body.get("output2") or []

        now_kst = datetime.now(KIS_KST)
        now_hhmmss = now_kst.strftime("%H%M%S") if now_kst.strftime("%Y%m%d") == date_yyyymmdd else None
        anchors = self._minute_page_anchors(venue, now_hhmmss)
        pages = await asyncio.gather(*(one_page(a) for a in anchors))

        seen_t_ms: set[int] = set()
        all_candles: list[KisCandle] = []
        # 처리 순서는 앵커 내림차순(리스트 순) — dedup 승자 선택이 결정적이다.
        for rows in pages:
            for row in rows:
                date_str = row.get("stck_bsop_date") or ""
                hhmmss = row.get("stck_cntg_hour") or ""
                if len(date_str) != 8 or len(hhmmss) != 6:
                    # Defensive: malformed row, skip rather than crash the page.
                    continue
                if date_str != date_yyyymmdd:
                    # KIS quirk: queries against a non-trading-day (Sat/Sun/
                    # holiday) return the PRIOR trading day's bars instead of an
                    # empty list. Without this guard the caller's per-date loop
                    # accumulates the same bars under multiple dates, breaking
                    # lightweight-charts' monotonic-time invariant downstream.
                    # Discovered via /investigate 2026-05-28 against /live.
                    continue
                dt = datetime(
                    int(date_str[:4]), int(date_str[4:6]), int(date_str[6:8]),
                    int(hhmmss[:2]), int(hhmmss[2:4]), int(hhmmss[4:6]),
                    tzinfo=KIS_KST,
                )
                t_ms = int(dt.timestamp() * 1000)
                if t_ms in seen_t_ms:
                    continue
                try:
                    candle = KisCandle(
                        t_ms=t_ms,
                        open=int(row["stck_oprc"]),
                        high=int(row["stck_hgpr"]),
                        low=int(row["stck_lwpr"]),
                        close=int(row["stck_prpr"]),
                        volume=int(row["cntg_vol"]),
                    )
                except (KeyError, ValueError, TypeError):
                    # Defensive: a malformed OHLCV field skips this row rather
                    # than crashing the whole fetch — symmetric with the date-
                    # field guard above (2026-07-08 KIS audit Fix B).
                    log.debug("kis minute candle row skipped (malformed): %s", row)
                    continue
                seen_t_ms.add(t_ms)
                all_candles.append(candle)
        # Return in ascending order by t_ms — frontend / aggregator expects ASC.
        all_candles.sort(key=lambda c: c.t_ms)
        return all_candles

    # ------------------------------------------------------------------
    # fetch_past_daily_candles (FHKST03010100, inquire-daily-itemchartprice)
    # ------------------------------------------------------------------

    async def fetch_past_daily_candles(
        self,
        code: str,
        from_yyyymmdd: str,
        to_yyyymmdd: str,
        *,
        venue: KisVenue = _DEFAULT_KIS_VENUE,
        adjust: bool = True,
        foreground: bool = False,
    ) -> DailyCandleFetchResult:
        """Fetch daily OHLCV for *code* across [from, to] (KST).

        KIS TR_ID: FHKST03010100 (inquire-daily-itemchartprice), period='D'.
        KIS retains roughly 20-30 years of daily candles per the portal docs.

        Returns DailyCandleFetchResult with:
        - candles: ASC by t_ms; t_ms anchors at regular_session_open (KST 09:00:00)
          of each trading day. Non-trading days are absent (KIS doesn't emit them).
        - violations: per-row drop reasons (close<=0, OHLC inconsistent, malformed,
          out of requested range). Surfaced to caller for data_warnings.
        """
        path = "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice"
        tr_id = "FHKST03010100"
        venue_div = kis_venue_div(venue)
        cursor_from = from_yyyymmdd
        cursor_to = to_yyyymmdd
        # Tracks every row we've already processed (valid or violation) so that
        # paginated re-reads — or mock-server tests that replay the same payload
        # for every cursor — don't double-count violations or candles. Keys are
        # the YYYYMMDD date; for malformed rows missing a date we fall back to
        # a stable hash of the row content.
        seen_keys: set[str] = set()
        all_candles: list[KisCandle] = []
        violations: list[DailyInvariantViolation] = []

        for _ in range(60):
            params = {
                "FID_COND_MRKT_DIV_CODE": venue_div,
                "FID_INPUT_ISCD": code,
                "FID_INPUT_DATE_1": cursor_from,
                "FID_INPUT_DATE_2": cursor_to,
                "FID_PERIOD_DIV_CODE": "D",
                # 0=수정주가(/live 기본·ADR-0048), 1=원주가(스크리너)
                "FID_ORG_ADJ_PRC": "0" if adjust else "1",
            }
            body = await self._get(path=path, tr_id=tr_id, params=params, foreground=foreground)
            rows = body.get("output2") or []
            page_candles: list[KisCandle] = []
            page_earliest: str | None = None
            page_latest: str | None = None
            page_progress = False

            for row in rows:
                date_str = row.get("stck_bsop_date") or ""
                if len(date_str) != 8:
                    row_key = "malformed:" + json.dumps(row, sort_keys=True)
                    if row_key in seen_keys:
                        continue
                    seen_keys.add(row_key)
                    violations.append(DailyInvariantViolation(
                        date_yyyymmdd=date_str or "(empty)",
                        reason="malformed_row",
                        detail="stck_bsop_date missing or wrong length",
                    ))
                    page_progress = True
                    continue
                if date_str in seen_keys:
                    continue
                # Lexicographic comparison of YYYYMMDD is equivalent to chronological.
                if date_str < from_yyyymmdd or date_str > to_yyyymmdd:
                    seen_keys.add(date_str)
                    violations.append(DailyInvariantViolation(
                        date_yyyymmdd=date_str,
                        reason="out_of_range",
                        detail=f"row date outside [{from_yyyymmdd}, {to_yyyymmdd}]",
                    ))
                    page_progress = True
                    continue
                try:
                    o = int(row["stck_oprc"])
                    h = int(row["stck_hgpr"])
                    l_ = int(row["stck_lwpr"])
                    c = int(row.get("stck_clpr") or row.get("stck_prpr") or "0")
                    v = int(row.get("acml_vol") or row.get("cntg_vol") or "0")
                except (KeyError, ValueError, TypeError) as e:
                    seen_keys.add(date_str)
                    violations.append(DailyInvariantViolation(
                        date_yyyymmdd=date_str,
                        reason="malformed_row",
                        detail=f"OHLCV parse: {e}",
                    ))
                    page_progress = True
                    continue
                if c <= 0:
                    seen_keys.add(date_str)
                    violations.append(DailyInvariantViolation(
                        date_yyyymmdd=date_str, reason="close_nonpositive",
                        detail=f"close={c}",
                    ))
                    page_progress = True
                    continue
                if h < max(o, c) or l_ > min(o, c) or h < l_:
                    seen_keys.add(date_str)
                    violations.append(DailyInvariantViolation(
                        date_yyyymmdd=date_str, reason="ohlc_inconsistent",
                        detail=f"o={o} h={h} l={l_} c={c}",
                    ))
                    page_progress = True
                    continue

                t_ms = _daily_anchor_t_ms(date_str)
                seen_keys.add(date_str)
                page_progress = True
                if page_earliest is None or date_str < page_earliest:
                    page_earliest = date_str
                if page_latest is None or date_str > page_latest:
                    page_latest = date_str
                page_candles.append(KisCandle(
                    t_ms=t_ms, open=o, high=h, low=l_, close=c, volume=v,
                ))

            all_candles.extend(page_candles)
            # Stop when KIS returns an empty page or this iteration produced no
            # new rows (e.g. test fixture replays the same payload on every call).
            if not rows or not page_progress:
                break
            if page_earliest is None or page_latest is None:
                # No new valid candle to anchor cursor walk-back; rely on the
                # next iteration's empty/no-progress check to terminate.
                continue
            if page_earliest <= from_yyyymmdd and page_latest >= to_yyyymmdd:
                # Full requested interval covered in one inclusive page.
                break
            if page_latest < cursor_to and page_earliest <= cursor_from:
                # Some KIS venue divisions (notably non-KRX daily bars) can
                # return the lower side of [DATE_1, DATE_2]. Advance DATE_1 so
                # the newest tail is not silently truncated.
                cursor_from = _next_day_yyyymmdd(page_latest)
                if cursor_from > cursor_to:
                    break
                continue
            if page_earliest > cursor_from:
                # Usual KRX behavior: the page is anchored at DATE_2 and walks
                # backward. Move the upper cursor below the oldest page row.
                cursor_to = _prev_day_yyyymmdd(page_earliest)
                continue
            break

        all_candles.sort(key=lambda c: c.t_ms)
        return DailyCandleFetchResult(candles=all_candles, violations=violations)

    async def fetch_index_daily_candles(
        self,
        index: RepresentativeIndex,
        from_yyyymmdd: str,
        to_yyyymmdd: str,
        *,
        period: Literal["D", "W", "M"] = "D",
        foreground: bool = False,
    ) -> IndexCandleFetchResult:
        """Fetch domestic representative index OHLCV candles.

        KIS TR_ID: FHKUP03500100 (inquire-daily-indexchartprice). The endpoint
        returns at most 50 rows, so this walks the end cursor backwards until it
        covers the requested start date.
        """
        if index.kis_index_code is None:
            raise KisApiError(msg_cd="UNSUPPORTED_INDEX", msg1=f"{index.id} has no KIS index code")
        path = "/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice"
        tr_id = "FHKUP03500100"
        cursor_to = to_yyyymmdd
        seen_dates: set[str] = set()
        candles: list[IndexCandlePoint] = []
        violations: list[DailyInvariantViolation] = []

        for _ in range(80):
            params = {
                "FID_COND_MRKT_DIV_CODE": "U",
                "FID_INPUT_ISCD": index.kis_index_code,
                "FID_INPUT_DATE_1": from_yyyymmdd,
                "FID_INPUT_DATE_2": cursor_to,
                "FID_PERIOD_DIV_CODE": period,
            }
            body = await self._get(path=path, tr_id=tr_id, params=params, foreground=foreground)
            rows = body.get("output2") or body.get("output") or []
            page_dates: list[str] = []
            page_progress = False
            for row in rows:
                date_str = str(row.get("stck_bsop_date") or row.get("bsop_date") or "")
                if len(date_str) != 8:
                    violations.append(DailyInvariantViolation(
                        date_yyyymmdd=date_str or "(empty)",
                        reason="malformed_row",
                        detail="stck_bsop_date missing or wrong length",
                    ))
                    page_progress = True
                    continue
                if date_str in seen_dates:
                    continue
                seen_dates.add(date_str)
                page_dates.append(date_str)
                if date_str < from_yyyymmdd or date_str > to_yyyymmdd:
                    violations.append(DailyInvariantViolation(
                        date_yyyymmdd=date_str,
                        reason="out_of_range",
                        detail=f"outside requested range {from_yyyymmdd}..{to_yyyymmdd}",
                    ))
                    page_progress = True
                    continue
                try:
                    point = _parse_index_daily_row(row)
                except (KeyError, TypeError, ValueError) as e:
                    violations.append(DailyInvariantViolation(
                        date_yyyymmdd=date_str,
                        reason="malformed_row",
                        detail=str(e),
                    ))
                    page_progress = True
                    continue
                if point.close <= 0:
                    violations.append(DailyInvariantViolation(
                        date_yyyymmdd=date_str,
                        reason="close_nonpositive",
                        detail=f"close={point.close}",
                    ))
                    page_progress = True
                    continue
                if point.high < max(point.open, point.close) or point.low > min(point.open, point.close) or point.high < point.low:
                    violations.append(DailyInvariantViolation(
                        date_yyyymmdd=date_str,
                        reason="ohlc_inconsistent",
                        detail=(
                            f"open={point.open} high={point.high} "
                            f"low={point.low} close={point.close}"
                        ),
                    ))
                    page_progress = True
                    continue
                candles.append(point)
                page_progress = True

            if not rows or not page_progress or not page_dates:
                break
            earliest = min(page_dates)
            if earliest <= from_yyyymmdd:
                break
            cursor_to = _prev_day_yyyymmdd(earliest)

        candles.sort(key=lambda c: c.t_ms)
        return IndexCandleFetchResult(candles=candles, violations=violations)

    async def fetch_index_price(
        self,
        index: RepresentativeIndex,
        *,
        foreground: bool = False,
    ) -> IndexQuoteSnapshot:
        """국내업종 현재지수 1건 (TR FHPUP02100000, inquire-index-price).

        output 필드는 공식 레포 COLUMN_MAPPING 기준: bstp_nmix_prpr(현재지수)·
        bstp_nmix_prdy_vrss(전일대비)·prdy_vrss_sign(1상한/2상승/3보합/4하한/5하락)·
        bstp_nmix_prdy_ctrt(등락률). 전일대비/등락률은 TR에 따라 부호가 이미 실려
        오기도 하므로, 부호 코드가 하락(4/5)일 때만 음수로 강제하고 보합(3)은 0으로
        정규화한다 — 이중 부호 적용을 피하는 방어.
        """
        if index.kis_index_code is None:
            raise KisApiError(msg_cd="UNSUPPORTED_INDEX", msg1=f"{index.id} has no KIS index code")
        body = await self._get(
            path="/uapi/domestic-stock/v1/quotations/inquire-index-price",
            tr_id="FHPUP02100000",
            params={
                "FID_COND_MRKT_DIV_CODE": "U",
                "FID_INPUT_ISCD": index.kis_index_code,
            },
            foreground=foreground,
        )
        output = body.get("output") or {}
        value = float(_row_value(output, "bstp_nmix_prpr", "prpr"))
        change = float(_row_value(output, "bstp_nmix_prdy_vrss", "prdy_vrss"))
        change_rate = float(_row_value(output, "bstp_nmix_prdy_ctrt", "prdy_ctrt"))
        sign = str(output.get("prdy_vrss_sign") or "")
        if sign in ("4", "5"):
            change = -abs(change)
            change_rate = -abs(change_rate)
        elif sign == "3":
            change = 0.0
            change_rate = 0.0
        return IndexQuoteSnapshot(
            index_id=index.id,
            value=value,
            change=change,
            change_rate=change_rate,
            t_ms=int(datetime.now(KIS_KST).timestamp() * 1000),
        )

    async def fetch_index_minute_candles(
        self,
        index: RepresentativeIndex,
        from_yyyymmdd: str,
        to_yyyymmdd: str,
        *,
        bucket_seconds: int = 60,
        foreground: bool = False,
    ) -> IndexCandleFetchResult:
        """Fetch domestic representative index intraday OHLCV candles.

        KIS TR_ID: FHKUP03500200 (inquire-time-indexchartprice). KIS supports a
        small set of server-side minute units. Request the coarsest exact source
        that preserves the display bucket's OHLC boundaries, then aggregate only
        when the display bucket is a clean multiple of that source.
        """
        if index.kis_index_code is None:
            raise KisApiError(msg_cd="UNSUPPORTED_INDEX", msg1=f"{index.id} has no KIS index code")
        path = "/uapi/domestic-stock/v1/quotations/inquire-time-indexchartprice"
        tr_id = "FHKUP03500200"
        params = {
            "FID_COND_MRKT_DIV_CODE": "U",
            "FID_ETC_CLS_CODE": "0",
            "FID_INPUT_ISCD": index.kis_index_code,
            "FID_INPUT_HOUR_1": str(_kis_index_minute_unit_seconds(bucket_seconds)),
            "FID_PW_DATA_INCU_YN": "Y",
        }
        body = await self._get(path=path, tr_id=tr_id, params=params, foreground=foreground)
        rows = body.get("output2") or body.get("output") or []
        candles: list[IndexCandlePoint] = []
        violations: list[DailyInvariantViolation] = []

        for row in rows:
            date_str = str(row.get("stck_bsop_date") or row.get("bsop_date") or "")
            if len(date_str) != 8:
                violations.append(DailyInvariantViolation(
                    date_yyyymmdd=date_str or "(empty)",
                    reason="malformed_row",
                    detail="stck_bsop_date missing or wrong length",
                ))
                continue
            if date_str < from_yyyymmdd or date_str > to_yyyymmdd:
                continue
            try:
                point = _parse_index_minute_row(row)
            except (KeyError, TypeError, ValueError) as e:
                violations.append(DailyInvariantViolation(
                    date_yyyymmdd=date_str,
                    reason="malformed_row",
                    detail=str(e),
                ))
                continue
            if point.close <= 0:
                violations.append(DailyInvariantViolation(
                    date_yyyymmdd=date_str,
                    reason="close_nonpositive",
                    detail=f"close={point.close}",
                ))
                continue
            if point.high < max(point.open, point.close) or point.low > min(point.open, point.close) or point.high < point.low:
                violations.append(DailyInvariantViolation(
                    date_yyyymmdd=date_str,
                    reason="ohlc_inconsistent",
                    detail=(
                        f"open={point.open} high={point.high} "
                        f"low={point.low} close={point.close}"
                    ),
                ))
                continue
            candles.append(point)

        candles = _aggregate_index_minute_candles(candles, bucket_seconds)
        return IndexCandleFetchResult(candles=candles, violations=violations)

    async def fetch_market_investor_net(
        self,
        index: RepresentativeIndex,
        from_yyyymmdd: str,
        to_yyyymmdd: str,
    ) -> InvestorNetFetchResult:
        """Fetch KOSPI/KOSDAQ market-level foreign/institution net quantities.

        KIS TR_ID: FHPTJ04040000 (inquire-investor-daily-by-market). This API
        is market-scoped, not constituent-index-scoped, so it is only exposed
        for representative market indices whose registry scope is ``market``.
        """
        if index.investor_scope != "market":
            raise KisApiError(
                msg_cd="UNSUPPORTED_INDEX_INVESTOR",
                msg1=f"{index.id} does not support market investor net",
            )
        market_code, sub_code = _market_investor_codes(index)
        path = "/uapi/domestic-stock/v1/quotations/inquire-investor-daily-by-market"
        tr_id = "FHPTJ04040000"
        cursor = datetime(
            int(from_yyyymmdd[:4]),
            int(from_yyyymmdd[4:6]),
            int(from_yyyymmdd[6:8]),
            tzinfo=KIS_KST,
        )
        end = datetime(
            int(to_yyyymmdd[:4]),
            int(to_yyyymmdd[4:6]),
            int(to_yyyymmdd[6:8]),
            tzinfo=KIS_KST,
        )
        points: list[InvestorNetPoint] = []
        violations: list[InvestorNetInvariantViolation] = []
        seen: set[str] = set()

        while cursor <= end:
            date_str = cursor.strftime("%Y%m%d")
            params = {
                "FID_COND_MRKT_DIV_CODE": "J",
                "FID_INPUT_ISCD": sub_code,
                "FID_INPUT_DATE_1": date_str,
                "FID_INPUT_ISCD_1": market_code,
                "FID_INPUT_DATE_2": date_str,
                "FID_INPUT_ISCD_2": sub_code,
            }
            body = await self._get(path=path, tr_id=tr_id, params=params)
            rows = body.get("output")
            if not isinstance(rows, list):
                rows = []
            for row in rows:
                row_date = str(row.get("stck_bsop_date") or row.get("bsop_date") or "")
                if len(row_date) != 8:
                    row_key = "malformed:" + json.dumps(row, sort_keys=True)
                    if row_key in seen:
                        continue
                    seen.add(row_key)
                    violations.append(InvestorNetInvariantViolation(
                        date_yyyymmdd=row_date or "(empty)",
                        reason="malformed_row",
                        detail="stck_bsop_date missing or wrong length",
                    ))
                    continue
                if row_date in seen:
                    continue
                seen.add(row_date)
                if row_date < from_yyyymmdd or row_date > to_yyyymmdd:
                    continue
                try:
                    points.append(_parse_market_investor_daily_row(row))
                except (KeyError, TypeError, ValueError) as e:
                    violations.append(InvestorNetInvariantViolation(
                        date_yyyymmdd=row_date,
                        reason="malformed_row",
                        detail=str(e),
                    ))
            cursor += timedelta(days=1)

        points.sort(key=lambda p: p.t_ms)
        return InvestorNetFetchResult(points=points, violations=violations)

    # ------------------------------------------------------------------
    # fetch_multi_price (FHKST11300006, intstock-multprice)
    # ------------------------------------------------------------------

    async def fetch_multi_price(self, codes: list[str], *, venue: KisVenue = "KRX") -> list[KisQuote]:
        """관심종목/스크리너 결과 코드들의 현재가+등락률 (intstock-multprice)."""
        return await _fetch_multi_price(
            lambda *, path, tr_id, params: self._get(path=path, tr_id=tr_id, params=params),
            codes,
            venue=venue,
        )

    # ------------------------------------------------------------------
    # fetch_investor_net (FHPTJ04160001, investor-trade-by-stock-daily)
    # ------------------------------------------------------------------

    async def fetch_investor_net(
        self, code: str, from_yyyymmdd: str, to_yyyymmdd: str
    ) -> InvestorNetFetchResult:
        """Fetch daily foreign/institution net-buy quantities for *code* across
        [from, to] (KST).

        KIS TR_ID: FHPTJ04160001 (investor-trade-by-stock-daily, 종목별 일별동향).
        Each call returns ``FID_INPUT_DATE_1`` (an anchor day) plus the prior
        ~30 trading days under ``output2``; we re-anchor to (page oldest − 1)
        and walk backward until the requested ``from`` is covered — the same
        cursor walk-back as ``fetch_past_daily_candles``. Net-buy *quantity*
        (frgn/orgn ``_ntby_qty``) is signed: positive = net buy, negative = net
        sell. Won-value siblings (``_ntby_tr_pbmn``) and the individual investor
        (``prsn``) are intentionally ignored.

        Returns InvestorNetFetchResult with:
        - points: ASC by t_ms; t_ms anchors at 09:00 KST of each trading day
          (same anchor as fetch_past_daily_candles via ``_daily_anchor_t_ms``).
        - violations: per-row drop reasons (malformed). Surfaced to data_warnings.

        Note: KIS finalizes the current day only after ~15:40 (가집계);
        historical rows are confirmed.
        """
        path = "/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily"
        tr_id = "FHPTJ04160001"
        cursor_to = to_yyyymmdd  # FID_INPUT_DATE_1 anchor; walks back each page.
        points: list[InvestorNetPoint] = []
        violations: list[InvestorNetInvariantViolation] = []
        seen: set[str] = set()

        for _ in range(60):  # safety cap; ~30 rows/page → ~5 years of history
            params = {
                "FID_COND_MRKT_DIV_CODE": _STOCK_MRKT_DIV,
                "FID_INPUT_ISCD": code,
                "FID_INPUT_DATE_1": cursor_to,
                "FID_ORG_ADJ_PRC": "",
                "FID_ETC_CLS_CODE": "",
            }
            body = await self._get(path=path, tr_id=tr_id, params=params)
            # output2 holds the daily array (output1 is a current-price summary).
            rows = body.get("output2")
            if not isinstance(rows, list):
                rows = []
            page_oldest: str | None = None
            page_progress = False

            for row in rows:
                date_str = row.get("stck_bsop_date") or ""
                if len(date_str) != 8:
                    row_key = "malformed:" + json.dumps(row, sort_keys=True)
                    if row_key in seen:
                        continue
                    seen.add(row_key)
                    violations.append(InvestorNetInvariantViolation(
                        date_yyyymmdd=date_str or "(empty)",
                        reason="malformed_row",
                        detail="stck_bsop_date missing or wrong length",
                    ))
                    page_progress = True
                    continue
                if date_str in seen:
                    continue
                seen.add(date_str)
                page_progress = True
                if page_oldest is None or date_str < page_oldest:
                    page_oldest = date_str
                # Range filter — a page can overshoot the requested window.
                if date_str < from_yyyymmdd or date_str > to_yyyymmdd:
                    continue
                try:
                    frgn = int(row.get("frgn_ntby_qty") or "0")
                    orgn = int(row.get("orgn_ntby_qty") or "0")
                except (ValueError, TypeError) as e:
                    violations.append(InvestorNetInvariantViolation(
                        date_yyyymmdd=date_str,
                        reason="malformed_row",
                        detail=f"net-qty parse: {e}",
                    ))
                    continue
                points.append(InvestorNetPoint(
                    t_ms=_daily_anchor_t_ms(date_str),
                    foreign_net=frgn,
                    institution_net=orgn,
                ))

            # Stop on an empty page, no new rows (fixture replays same payload),
            # or once we've paged back to/past the requested start.
            if not rows or not page_progress:
                break
            if page_oldest is None or page_oldest <= from_yyyymmdd:
                break
            cursor_to = _prev_day_yyyymmdd(page_oldest)

        points.sort(key=lambda p: p.t_ms)
        return InvestorNetFetchResult(points=points, violations=violations)

    async def fetch_investor_trend_estimate(
        self, code: str
    ) -> list[InvestorTrendEstimateRow]:
        """Fetch intraday estimated foreign/institution net-buy quantities.

        KIS TR_ID: HHPTJ04160200 (investor-trend-estimate, 종목별 외인기관 추정가집계).
        Quantities are signed where positive means net buy and negative means
        net sell. Empty or malformed quantity fields become None.
        """
        path = "/uapi/domestic-stock/v1/quotations/investor-trend-estimate"
        body = await self._get(
            path=path,
            tr_id="HHPTJ04160200",
            params={"MKSC_SHRN_ISCD": code},
        )
        raw_rows = body.get("output2")
        if raw_rows is None:
            raw_rows = body.get("output")
        if not isinstance(raw_rows, list):
            return []

        rows: list[InvestorTrendEstimateRow] = []
        for raw in raw_rows:
            if not isinstance(raw, dict):
                continue
            slot = str(raw.get("bsop_hour_gb") or "").strip()
            if not slot:
                continue
            rows.append(
                InvestorTrendEstimateRow(
                    slot=slot,
                    foreign_qty=_parse_optional_int(raw.get("frgn_fake_ntby_qty")),
                    institution_qty=_parse_optional_int(raw.get("orgn_fake_ntby_qty")),
                    sum_qty=_parse_optional_int(raw.get("sum_fake_ntby_qty")),
                )
            )
        return rows

_MULTI_PRICE_CHUNK = 30  # intstock-multprice: 최대 30종목/콜 (FHKST11300006)


def _build_multi_price_params(codes_chunk: list[str], *, venue: KisVenue = "KRX") -> dict[str, str]:
    """FID_COND_MRKT_DIV_CODE_N / FID_INPUT_ISCD_N (N=1..30) 번호 키 빌드."""
    market_div = kis_venue_div(venue)
    params: dict[str, str] = {}
    for n, c in enumerate(codes_chunk, start=1):
        params[f"FID_COND_MRKT_DIV_CODE_{n}"] = market_div
        params[f"FID_INPUT_ISCD_{n}"] = c
    return params


def _parse_ohlc_field(raw: object) -> int | None:
    """당일 OHLC 한 필드 → int|None. price 파서와 달리 0으로 위조하지 않는다
    (0 은 양봉/음봉 판정·[low,high] 스케일 분모를 오염). 빈값/파싱실패/<=0 → None."""
    if raw in (None, ""):
        return None
    try:
        v = int(float(raw))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return v if v > 0 else None


def _parse_optional_int_field(raw: object) -> int | None:
    if raw in (None, ""):
        return None
    try:
        return int(float(raw))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _parse_change(row: dict) -> tuple[float | None, int | None]:
    """(change_pct, change_won). prdy_ctrt 빈값/파싱실패·미인식 부호코드면 (None, None)
    — 절대값 필드라 부호 없으면 양수 위조 금지(#11)."""
    raw_ctrt = row.get("prdy_ctrt")
    if raw_ctrt in (None, ""):
        return None, None
    try:
        mag = abs(float(raw_ctrt))
    except (TypeError, ValueError):
        return None, None
    sign = str(row.get("prdy_vrss_sign", ""))
    mult = {"1": 1.0, "2": 1.0, "4": -1.0, "5": -1.0, "3": 0.0}.get(sign)
    if mult is None:
        return None, None
    change_won = _parse_change_won(row.get("inter2_prdy_vrss") or row.get("prdy_vrss"), mult)
    return mult * mag, change_won


def _parse_quote(row: dict) -> KisQuote | None:
    """multprice output 한 항목 → KisQuote.

    코드는 **행 자신의 `inter_shrn_iscd`** 에서 읽는다 — 요청 순서가 아니라 응답이
    스스로 식별한 종목코드라, KIS 가 무효 코드를 빈 placeholder 행으로 채우거나
    행 순서를 바꿔도 값이 엉뚱한 종목에 붙지 않는다. `inter_shrn_iscd` 가 비면
    (무효/placeholder 행) None 을 돌려 호출부가 건너뛰게 한다.

    price = inter2_prpr. change_pct = prdy_ctrt(절대값), change_won =
    inter2_prdy_vrss(절대값) 에 prdy_vrss_sign 을 공통 적용 (1·2 상한/상승=양수,
    4·5 하한/하락=음수, 3 보합=0). prdy_ctrt 가 빈값/파싱실패거나 부호코드가
    1·2·3·4·5 밖(방향 불명)이면 change_pct·change_won 모두 None — 필드가 절대값이라
    부호를 못 붙이므로 양수로 위조하지 않고 미표시한다.
    """
    code = (row.get("inter_shrn_iscd") or "").strip()
    if not code:
        return None
    try:
        price = int(float(row.get("inter2_prpr") or "0"))
    except (TypeError, ValueError):
        price = 0
    # change 와 OHLC 는 독립 필드군 — 끝에서 한 번만 생성해 어느 쪽 결측에도 다른 쪽 누락 없게.
    change_pct, change_won = _parse_change(row)
    return KisQuote(
        code=code, price=price, change_pct=change_pct, change_won=change_won,
        open=_parse_ohlc_field(row.get("inter2_oprc")),
        high=_parse_ohlc_field(row.get("inter2_hgpr")),
        low=_parse_ohlc_field(row.get("inter2_lwpr")),
        volume=_parse_optional_int_field(row.get("acml_vol")),
        previous_close=_parse_ohlc_field(row.get("inter2_prdy_clpr")),
    )


def _parse_change_won(raw: str | None, mult: float) -> int | None:
    """전일대비 등락액(원). raw 는 절대값(빈값/파싱실패 → None); mult(부호코드 멀티
    플라이어)로 방향을 적용한다 (호출부가 mult!=None 을 보장)."""
    if raw in (None, ""):
        return None
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return None
    return int(mult * abs(v))


async def _fetch_multi_price(get, codes: list[str], *, venue: KisVenue = "KRX") -> list["KisQuote"]:
    """get: async (*, path, tr_id, params)->dict (KisClient._get 와 동일 시그니처).
    30개씩 청크해 intstock-multprice 호출. 청크는 동시 호출(직렬 RTT 제거; 15/s 버킷은
    _get 가 캡). 각 행을 **응답 자신의 inter_shrn_iscd** 로 매핑(위치 의존 X — 누락/
    재정렬·빈 placeholder 행 안전). 빈/무효 행은 건너뛴다."""
    chunks = [codes[i:i + _MULTI_PRICE_CHUNK] for i in range(0, len(codes), _MULTI_PRICE_CHUNK)]
    bodies = await asyncio.gather(*(
        get(
            path="/uapi/domestic-stock/v1/quotations/intstock-multprice",
            tr_id="FHKST11300006",
            params=_build_multi_price_params(chunk, venue=venue),
        )
        for chunk in chunks
    ))
    out: list[KisQuote] = []
    for body in bodies:
        for row in (body.get("output") or []):
            q = _parse_quote(row)
            if q is not None:
                out.append(q)
    return out
