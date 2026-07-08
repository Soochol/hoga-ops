"""KIS endpoint fetch methods (KisEndpointsMixin) + their parsers/dataclasses.

Split from kis_client.py (Stage 4, 2026-07-08) so the transport core stays
independently readable. ``KisClient`` composes ``KisEndpointsMixin``; the method
bodies are verbatim and reference ``self._get`` (resolved via the KisClient MRO)
plus this module's own helpers only — no state beyond the injected getter.
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Literal

from hoga.live.index_registry import RepresentativeIndex
from hoga.live.kis_errors import KisApiError
from hoga.live.kis_models import (
    IndexCandlePoint,
    InvestorNetPoint,
    InvestorTrendEstimateRow,
    KisBrokerEntry,
    KisBrokers,
    KisCandle,
    KisOrderbook,
    KisTrade,
    OrderbookLevel,
    ProgramTradeByStockRow,
)
from hoga.live.kis_venue import (
    KIS_KST,
    KisVenue,
    kis_venue_div,
    previous_empty_page_anchor_hhmmss,
    session_window_hhmmss,
)

# Default KIS Venue for backwards-compatible callers. New /live candle routes
# pass an explicit venue value and include it in cache/query keys.
_DEFAULT_KIS_VENUE: KisVenue = "KRX"
_STOCK_MRKT_DIV = kis_venue_div(_DEFAULT_KIS_VENUE)

def classify_side(
    t_ms: int, prpr: int, askp: int, bidp: int
) -> tuple[Literal[-1, 0, 1, 2], Literal["inferred", "auction"]]:
    """Lee-Ready trade direction inference + auction window guard.

    Returns (side, side_source). See Deep Sample Audit §B (Audit-2) and §H (Audit-5).
    side: -1=sell, 0=mid, 1=buy, 2=auction
    side_source: "inferred" | "auction"
    """
    kst = datetime.fromtimestamp(t_ms / 1000, tz=KIS_KST)
    h, m = kst.hour, kst.minute
    in_open_auction = (h == 8 and m >= 50) or (h == 9 and m == 0)
    in_close_auction = h == 15 and 20 <= m < 30
    if in_open_auction or in_close_auction:
        return 2, "auction"
    if prpr >= askp:
        return 1, "inferred"
    if prpr <= bidp:
        return -1, "inferred"
    return 0, "inferred"


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
        per call (about 2 hours of 1-minute bars). A full regular-session day
        (09:00-15:30 KST = 390 minutes) needs ~4 paginated calls — we anchor
        from 15:30 KST and walk the anchor backwards by the earliest received
        candle's HHMMSS until we cover 09:00 or stop receiving new bars.

        KIS retains roughly 1 year of historical minute candles per the
        portal docs (https://apiportal.koreainvestment.com/).
        """
        path = "/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice"
        tr_id = "FHKST03010230"
        session_open_hhmmss, session_close_hhmmss = session_window_hhmmss(venue)
        anchor_hhmmss = session_close_hhmmss
        venue_div = kis_venue_div(venue)
        seen_t_ms: set[int] = set()
        all_candles: list[KisCandle] = []
        # Hard cap so a misbehaving KIS response never spirals into infinite
        # pages. NXT/UN can span 12h, so they legitimately need more calls.
        for _ in range(8 if venue == "KRX" else 16):
            params = {
                "FID_COND_MRKT_DIV_CODE": venue_div,
                "FID_INPUT_ISCD": code,
                "FID_INPUT_HOUR_1": anchor_hhmmss,
                "FID_INPUT_DATE_1": date_yyyymmdd,
                "FID_PW_DATA_INCU_YN": "N",
                "FID_FAKE_TICK_INCU_YN": "",
            }
            body = await self._get(path=path, tr_id=tr_id, params=params, foreground=foreground)
            rows = body.get("output2") or []
            if not rows:
                next_anchor = previous_empty_page_anchor_hhmmss(
                    venue,
                    date_yyyymmdd,
                    anchor_hhmmss,
                )
                if next_anchor is None:
                    break
                anchor_hhmmss = next_anchor
                continue
            page_candles: list[KisCandle] = []
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
                seen_t_ms.add(t_ms)
                page_candles.append(KisCandle(
                    t_ms=t_ms,
                    open=int(row["stck_oprc"]),
                    high=int(row["stck_hgpr"]),
                    low=int(row["stck_lwpr"]),
                    close=int(row["stck_prpr"]),
                    volume=int(row["cntg_vol"]),
                ))
            if not page_candles:
                break
            all_candles.extend(page_candles)
            # Next anchor = HHMMSS of the earliest bar minus 1 minute. KIS
            # responses come newest-first; the earliest bar's hour drives the
            # next page's anchor.
            earliest_t_ms = min(c.t_ms for c in page_candles)
            earliest_dt = datetime.fromtimestamp(earliest_t_ms / 1000, tz=KIS_KST)
            # If we already covered the session open, stop.
            session_open_hour = int(session_open_hhmmss[:2])
            session_open_minute = int(session_open_hhmmss[2:4])
            if (
                earliest_dt.hour < session_open_hour
                or (
                    earliest_dt.hour == session_open_hour
                    and earliest_dt.minute <= session_open_minute
                )
            ):
                break
            # Step the anchor back by 1 minute from the earliest bar.
            next_anchor_dt = earliest_dt - timedelta(minutes=1)
            anchor_hhmmss = (
                f"{next_anchor_dt.hour:02d}{next_anchor_dt.minute:02d}{next_anchor_dt.second:02d}"
            )
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

    async def fetch_program_trade_by_stock(self, code: str) -> list[ProgramTradeByStockRow]:
        """Fetch stock-level program-trade cumulative net-buy rows.

        KIS TR_ID: FHPPG04650101 (program-trade-by-stock). The endpoint returns
        a rolling latest window, so callers must persist rows during the session
        if they need historical intraday flow.
        """
        body = await self._get(
            path="/uapi/domestic-stock/v1/quotations/program-trade-by-stock",
            tr_id="FHPPG04650101",
            params={
                "FID_COND_MRKT_DIV_CODE": _STOCK_MRKT_DIV,
                "FID_INPUT_ISCD": code,
            },
        )
        raw_rows = body.get("output")
        if not isinstance(raw_rows, list):
            return []

        rows: list[ProgramTradeByStockRow] = []
        for raw in raw_rows:
            if not isinstance(raw, dict):
                continue
            bsop_hour = str(raw.get("bsop_hour") or "").strip()
            if len(bsop_hour) != 6 or not bsop_hour.isdigit():
                continue
            rows.append(
                ProgramTradeByStockRow(
                    code=code,
                    bsop_hour=bsop_hour,
                    t_ms=0,
                    price=_parse_optional_int(raw.get("stck_prpr")),
                    net_qty=_parse_optional_int(raw.get("whol_smtn_ntby_qty")),
                    net_amount=_parse_optional_int(raw.get("whol_smtn_ntby_tr_pbmn")),
                    buy_qty=_parse_optional_int(raw.get("whol_buy_qty")),
                    sell_qty=_parse_optional_int(raw.get("whol_seln_qty")),
                    buy_amount=_parse_optional_int(raw.get("whol_buy_tr_pbmn")),
                    sell_amount=_parse_optional_int(raw.get("whol_seln_tr_pbmn")),
                    delta_qty=_parse_optional_int(raw.get("whol_ntby_vol_icdc")),
                    delta_amount=_parse_optional_int(raw.get("whol_ntby_tr_pbmn_icdc")),
                )
            )
        rows.sort(key=lambda row: row.bsop_hour)
        return rows

    # ------------------------------------------------------------------
    # fetch_orderbook (FHKST01010200, inquire-asking-price-exp-ccn)
    # ------------------------------------------------------------------

    async def fetch_orderbook(self, code: str) -> KisOrderbook:
        """Fetch 10-level real-time orderbook for *code* (e.g. '005930').

        ADR-0067 보는종목 표시폴러용. _get_with_rate_retry·토큰버킷 재사용.
        """
        body = await self._get(
            path="/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn",
            tr_id="FHKST01010200",
            params={
                "fid_cond_mrkt_div_code": _STOCK_MRKT_DIV,
                "fid_input_iscd": code,
            },
        )
        out1 = body["output1"]
        asks = [
            OrderbookLevel(price=int(out1[f"askp{i}"]), qty=int(out1[f"askp_rsqn{i}"]))
            for i in range(1, 11)
        ]
        bids = [
            OrderbookLevel(price=int(out1[f"bidp{i}"]), qty=int(out1[f"bidp_rsqn{i}"]))
            for i in range(1, 11)
        ]
        return KisOrderbook(
            code=code,
            asks=asks,
            bids=bids,
            total_ask_qty=int(out1["total_askp_rsqn"]),
            total_bid_qty=int(out1["total_bidp_rsqn"]),
            t_ms=int(datetime.now(KIS_KST).timestamp() * 1000),
        )

    # ------------------------------------------------------------------
    # fetch_trades (FHPST01060000, inquire-time-itemconclusion)
    # ------------------------------------------------------------------

    async def fetch_trades(self, code: str) -> list[KisTrade]:
        """Fetch per-trade history via inquire-time-itemconclusion (FHPST01060000).

        ADR-0067 보는종목 표시폴러용. Lee-Ready side 분류 적용.
        Auction window trades get side=2.
        """
        body = await self._get(
            path="/uapi/domestic-stock/v1/quotations/inquire-time-itemconclusion",
            tr_id="FHPST01060000",
            params={
                "fid_cond_mrkt_div_code": _STOCK_MRKT_DIV,
                "fid_input_iscd": code,
                "fid_input_hour_1": "153000",
            },
        )
        today_kst = datetime.now(KIS_KST).date()
        trades: list[KisTrade] = []
        for row in body["output2"]:
            hhmmss = row["stck_cntg_hour"]
            hh = int(hhmmss[:2])
            mm = int(hhmmss[2:4])
            ss = int(hhmmss[4:6])
            dt = datetime(
                today_kst.year, today_kst.month, today_kst.day,
                hh, mm, ss, tzinfo=KIS_KST
            )
            t_ms = int(dt.timestamp() * 1000)
            prpr = int(row["stck_prpr"])
            askp = int(row.get("askp", "0") or "0")
            bidp = int(row.get("bidp", "0") or "0")
            side, side_source = classify_side(t_ms, prpr, askp, bidp)
            trades.append(KisTrade(
                price=prpr,
                qty=int(row["cnqn"]),
                side=side,
                side_source=side_source,
                t_ms=t_ms,
            ))
        return trades

    # ------------------------------------------------------------------
    # fetch_brokers (FHKST01010600, inquire-member)
    # ------------------------------------------------------------------

    async def fetch_brokers(self, code: str) -> KisBrokers:
        """Fetch top-5 buy/sell broker breakdown for *code*.

        ADR-0067 보는종목 표시폴러용. Broker names are canonicalized at the
        boundary so downstream sees the same canonical KRX member-firm name
        (see ``hoga.broker_names`` and CONTEXT.md).
        """
        from hoga.broker_names import canonical

        body = await self._get(
            path="/uapi/domestic-stock/v1/quotations/inquire-member",
            tr_id="FHKST01010600",
            params={
                "fid_cond_mrkt_div_code": _STOCK_MRKT_DIV,
                "fid_input_iscd": code,
            },
        )
        out = body["output"][0]  # KIS returns a 1-element list (Audit-3)
        buy_top = [
            KisBrokerEntry(
                name=canonical(out[f"shnu_mbcr_name{i}"]),
                qty=int(out[f"total_shnu_qty{i}"]),
            )
            for i in range(1, 6)
        ]
        sell_top = [
            KisBrokerEntry(
                name=canonical(out[f"seln_mbcr_name{i}"]),
                qty=int(out[f"total_seln_qty{i}"]),
            )
            for i in range(1, 6)
        ]
        return KisBrokers(code=code, buy_top=buy_top, sell_top=sell_top)


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
