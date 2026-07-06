"""FastAPI router for Live Capture endpoints (spec §6)."""
from __future__ import annotations

import asyncio
import contextlib
import fcntl
import json
import logging
import re
import time as monotonic_time
from collections.abc import Awaitable, Callable
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, ValidationError

from hoga.api._atomic_write import atomic_write_json
from hoga.api.models import LiveSettingsResponse, LiveSettingsUpdate
from hoga.api.params import CODE_PATTERN
from hoga.live.kis_client import (
    KisApiError,
    KisAuthError,
    KisQuote,
    KisRateLimitError,
    KisTransportError,
)
from hoga.live.kis_capacity_runtime import ensure_kis_capacity_scheduler
from hoga.live.kis_capacity_scheduler import (
    KisCapacityCooldown,
    KisCapacityOverloaded,
)
from hoga.live.kis_models import InvestorTrendEstimateRow
from hoga.live.kis_venue import (
    KisVenue,
    LiveVenuePolicy,
    parse_live_venue_policy,
    quote_venue_for_policy,
)
from hoga.live.live_daily_candle_backfill import LiveDailyCandleBackfill
from hoga.live.live_candle_backfill import LiveMinuteCandleBackfill
from hoga.live.live_index_investor_net import LiveIndexInvestorNetFetcher
from hoga.live.live_index_sector_intraday import LiveIndexSectorIntradayOverlay
from hoga.live.live_investor_net_backfill import LiveInvestorNetBackfill
from hoga.live.index_candles_cache import (
    IndexCandlesCache,
    collect_index_candles_with_cache,
)
from hoga.live.index_cold_fetch import fetch_index_daily_candles_windowed
from hoga.live.index_minute_candles_cache import (
    IndexMinuteCandlesCache,
    collect_index_minute_candles_with_cache,
)
from hoga.live.index_registry import (
    UnknownRepresentativeIndex,
    get_representative_index,
    list_representative_indices,
)
from hoga.live.past_candles_cache import PastCandlesCache
from hoga.live.past_daily_candles_cache import PastDailyCandlesCache
from hoga.live.quote_change_resolver import QuoteChangeResolver
from hoga.live.screener_daily_candles import read_screener_daily_candles

from . import kis_access
from .buffer import LiveBuffer
from .index_sector_rankings import (
    IndexSectorRankingResponse,
    build_index_sector_rankings,
)
from .lifecycle import LiveStatus, refresh_live_stream
from .settings import load_live_settings, update_live_settings

if TYPE_CHECKING:
    from .kis_client import KisClient

ControlAction = Literal["start", "stop", "pause"]

log = logging.getLogger(__name__)

_PAST_MAX_DAYS = 250

# past-candles 미캐시 날짜 병렬 fetch 동시 상한 (spec 2026-06-08 §4.1).
# 산식: RTT ~200ms → 슬롯당 ~5콜/초 → 3슬롯이 token bucket(15콜/초)의
# 자연 포화점. 5슬롯은 평시 처리량 여유가 있었지만 한 날짜가 내부적으로
# 여러 분봉 페이지를 호출하는 구조라 EGW00201 상황에서 동시 retry 폭을 키웠다.
_PAST_CANDLES_CONCURRENCY = 3
_PAST_CANDLES_RATE_LIMIT_COOLDOWN_S = 10.0
_CODE_RE = re.compile(CODE_PATTERN)
_KST = timezone(timedelta(hours=9))
_INVESTOR_ESTIMATE_MAX_CODES_PER_DAY = 256
index_candles_cache_instance: IndexCandlesCache | None = None
index_minute_candles_cache_instance: IndexMinuteCandlesCache | None = None

# Rate-limit retry policy lives in ``KisClient._get`` (ADR-0050). Handlers
# here just call ``kis.fetch_*`` directly; a ``KisRateLimitError`` that
# reaches the handler's ``except`` block means the client has already
# exhausted its retries — the right move is then to mark the range
# blocked and surface the warning to the wire.


def _today_kst_date() -> date:
    return datetime.now(_KST).date()


def _today_kst_yyyymmdd() -> str:
    return _today_kst_date().strftime("%Y%m%d")


def _parse_yyyymmdd(s: str) -> date | None:
    try:
        return datetime.strptime(s, "%Y%m%d").date()
    except ValueError:
        return None


def _candle_to_dict(c) -> dict:
    return {
        "t_ms": c.t_ms, "open": c.open, "high": c.high, "low": c.low,
        "close": c.close, "volume": c.volume,
    }


def _candle_date_yyyymmdd(c) -> str:
    return datetime.fromtimestamp(c.t_ms / 1000, tz=_KST).strftime("%Y%m%d")


def _investor_point_to_dict(p) -> dict:
    return {
        "t_ms": p.t_ms, "foreign_net": p.foreign_net,
        "institution_net": p.institution_net,
    }


def _validate_past_request(
    code: str, from_: str, to: str,
    *, max_days: int | None = _PAST_MAX_DAYS,
) -> tuple[date, date, date]:
    """Validate past-candles request params, returning parsed (frm, too, today).

    `max_days=None` disables the range cap — used by the daily path, which is
    uncapped per ADR-0048 (KIS retention ~20-30 years is the natural ceiling
    and rate-limit handling surfaces partial responses via data_warnings).

    Raises HTTPException(422) for any constraint violation.
    """
    if not _CODE_RE.match(code):
        raise HTTPException(422, {"code": "invalid_code", "msg": "code must be 6 digits"})
    frm = _parse_yyyymmdd(from_)
    too = _parse_yyyymmdd(to)
    if frm is None or too is None:
        raise HTTPException(422, {"code": "invalid_date", "msg": "from/to must be YYYYMMDD"})
    if frm > too:
        raise HTTPException(422, {"code": "from_after_to", "msg": "from must be <= to"})
    today_d = _today_kst_date()
    if too > today_d:
        raise HTTPException(422, {"code": "date_in_future", "msg": "to must be <= today_kst"})
    if max_days is not None:
        span_days = (too - frm).days + 1
        if span_days > max_days:
            raise HTTPException(
                422,
                {"code": "date_range_too_large", "msg": f"max {max_days} days", "max_days": max_days},
            )
    return frm, too, today_d


def _validate_index_range(index_id: str, from_: str, to: str):
    try:
        index = get_representative_index(index_id)
    except UnknownRepresentativeIndex as e:
        raise HTTPException(
            422,
            {"code": "invalid_index_id", "msg": "unknown representative index"},
        ) from e
    if index.kis_index_code is None:
        raise HTTPException(
            422,
            {"code": "unsupported_index", "msg": f"{index.id} is not supported by KIS index routes"},
        )
    frm = _parse_yyyymmdd(from_)
    too = _parse_yyyymmdd(to)
    if frm is None or too is None:
        raise HTTPException(422, {"code": "invalid_date", "msg": "from/to must be YYYYMMDD"})
    if frm > too:
        raise HTTPException(422, {"code": "from_after_to", "msg": "from must be <= to"})
    today_d = _today_kst_date()
    if too > today_d:
        raise HTTPException(422, {"code": "date_in_future", "msg": "to must be <= today_kst"})
    return index


def _violation_to_warning(v, batch_label: str) -> dict:
    """Render a DailyInvariantViolation as the wire dict the
    /past-daily-candles handler emits in `data_warnings`.

    Locality: one source of truth for the `{batch, date, reason, msg}` shape
    so future frontend additions (e.g. `LivePastDailyCandlesWarning`
    interface widening) only need to touch one builder.
    """
    return {
        "batch": batch_label,
        "date": v.date_yyyymmdd,
        "reason": "invariant_violation",
        "msg": f"{v.date_yyyymmdd}: {v.reason} ({v.detail})",
    }


def _kis_error_to_warning(reason: str, msg: str, batch_label: str) -> dict:
    """Render a KIS rate-limit/api-error as the wire dict the handler emits.

    `date` field is intentionally omitted — these errors apply to the whole
    batch range, not a single date (companion to `_violation_to_warning`).
    """
    return {"batch": batch_label, "reason": reason, "msg": msg}


def _compute_daily_gaps(
    frm: date, too: date,
    existing: list[tuple[date, date]],
) -> list[tuple[date, date]]:
    """Compute non-overlapping gap intervals within [frm, too] not covered by
    existing batches.

    Algorithm:
    1. Filter `existing` to entries intersecting [frm, too].
    2. Sort by start.
    3. Merge overlapping/adjacent intervals (touching = same continuous day line).
    4. Walk and emit complement against [frm, too].

    Two existing batches `(a1, a2)` and `(b1, b2)` are *adjacent* when
    `b1 == a2 + 1 day` — in that case no day gap exists between them.
    """
    relevant = [(s, e) for (s, e) in existing if e >= frm and s <= too]
    if not relevant:
        return [(frm, too)]
    relevant.sort()
    merged: list[tuple[date, date]] = [relevant[0]]
    for s, e in relevant[1:]:
        last_s, last_e = merged[-1]
        if s <= last_e + timedelta(days=1):
            merged[-1] = (last_s, max(last_e, e))
        else:
            merged.append((s, e))

    gaps: list[tuple[date, date]] = []
    cursor = frm
    for s, e in merged:
        if s > cursor:
            gap_end = min(s - timedelta(days=1), too)
            if cursor <= gap_end:
                gaps.append((cursor, gap_end))
        cursor = max(cursor, e + timedelta(days=1))
        if cursor > too:
            break
    if cursor <= too:
        gaps.append((cursor, too))
    return gaps


def _kis_rest_bypassed_batch_warning(batch_label: str) -> dict:
    return {
        "batch": batch_label,
        "reason": "kis_rest_bypassed",
        "msg": "KIS REST bypass is enabled; served cache-only data",
    }


def _collect_daily_series_cache_only(
    *,
    cache: PastDailyCandlesCache,
    output_key: str,
    code: str,
    frm: date,
    too: date,
    today_d: date,
    from_label: str,
    to_label: str,
) -> dict:
    loaded: list[dict] = []
    cached_batches: list[str] = []
    covered: list[tuple[date, date]] = []

    for batch_from, batch_to, rows in cache.list_batches(code):
        if batch_to < frm or batch_from > too:
            continue
        covered.append((batch_from, batch_to))
        loaded.extend(rows)
        cached_batches.append(f"{batch_from.strftime('%Y%m%d')}__{batch_to.strftime('%Y%m%d')}")

    if too >= today_d:
        today_s = today_d.strftime("%Y%m%d")
        state, today_row = cache.get_today(code)
        if state == "hit":
            loaded.append(today_row)  # type: ignore[arg-type]
            covered.append((today_d, today_d))
            cached_batches.append(f"{today_s}__{today_s}")
        elif state == "negative":
            covered.append((today_d, today_d))

    data_warnings = [
        _kis_rest_bypassed_batch_warning(
            f"{gap_from.strftime('%Y%m%d')}__{gap_to.strftime('%Y%m%d')}"
        )
        for gap_from, gap_to in _compute_daily_gaps(frm, too, covered)
    ]

    frm_ms = int(datetime.combine(frm, time(0, 0), tzinfo=_KST).timestamp() * 1000)
    too_ms = int(datetime.combine(too, time(23, 59, 59), tzinfo=_KST).timestamp() * 1000)
    by_ts: dict[int, dict] = {}
    for row in loaded:
        ts = row.get("t_ms")
        if isinstance(ts, int) and frm_ms <= ts <= too_ms:
            by_ts[ts] = row

    return {
        "code": code,
        "from": from_label,
        "to": to_label,
        output_key: [by_ts[t_ms] for t_ms in sorted(by_ts)],
        "cached_batches": cached_batches,
        "fresh_batches": [],
        "data_warnings": data_warnings,
    }


def _collect_index_daily_candles_cache_only(
    *,
    cache: IndexCandlesCache,
    key: tuple[str, str],
    index_id: str,
    timeframe: str,
    from_s: str,
    to_s: str,
) -> dict:
    frm = _parse_yyyymmdd(from_s)
    too = _parse_yyyymmdd(to_s)
    assert frm is not None and too is not None
    covered: list[tuple[date, date]] = []
    candles = []
    violations = []
    for batch_from, batch_to, batch_candles, batch_violations in cache.list_batches(key):
        if batch_to < frm or batch_from > too:
            continue
        covered.append((batch_from, batch_to))
        candles.extend(batch_candles)
        violations.extend(batch_violations)

    batch_label = f"{from_s}__{to_s}"
    data_warnings = [
        _violation_to_warning(v, batch_label)
        for v in violations
        if from_s <= v.date_yyyymmdd <= to_s
    ]
    data_warnings.extend(
        _kis_rest_bypassed_batch_warning(
            f"{gap_from.strftime('%Y%m%d')}__{gap_to.strftime('%Y%m%d')}"
        )
        for gap_from, gap_to in _compute_daily_gaps(frm, too, covered)
    )
    by_ts = {
        candle.t_ms: candle
        for candle in candles
        if from_s <= _candle_date_yyyymmdd(candle) <= to_s
    }
    return {
        "index_id": index_id,
        "from": from_s,
        "to": to_s,
        "timeframe": timeframe,
        "candles": [_candle_to_dict(by_ts[t_ms]) for t_ms in sorted(by_ts)],
        "data_warnings": data_warnings,
    }


def _collect_index_minute_candles_cache_only(
    *,
    cache: IndexMinuteCandlesCache,
    key: tuple[str, str, int],
    index_id: str,
    timeframe: str,
    from_s: str,
    to_s: str,
) -> dict:
    batch_label = f"{from_s}__{to_s}"
    result = cache.get_exact(key, from_s, to_s)
    if result is None:
        candles = []
        data_warnings = [_kis_rest_bypassed_batch_warning(batch_label)]
    else:
        candles = result.candles
        data_warnings = [_violation_to_warning(v, batch_label) for v in result.violations]
    return {
        "index_id": index_id,
        "from": from_s,
        "to": to_s,
        "timeframe": timeframe,
        "candles": [_candle_to_dict(c) for c in candles],
        "data_warnings": data_warnings,
    }


async def batched_daily_walkback(
    *,
    cache: PastDailyCandlesCache,
    fetch_batch: Callable[[str, str, str], Awaitable[tuple[list[dict], list]]],
    output_key: str,
    code: str,
    frm: date,
    too: date,
    today_d: date,
) -> dict:
    """Shared gap/cache/today/dedupe walk-back orchestration for the daily KIS
    series endpoints — `/past-daily-candles` (**Live Candle Backfill** 일봉) and
    `/past-investor-net` (**Live Investor Net**), which used to copy-paste this
    body verbatim (the only differences were the cache instance, fetch method,
    row→dict converter, and output key).

    The caller supplies a thin `fetch_batch(code, from_s, to_s)` closure that
    fetches one date range and returns `(rows: list[dict], violations)` — it may
    raise ``KisRateLimitError`` / ``KisApiError`` (this orchestrator catches them
    and turns them into ``data_warnings``, breaking on rate-limit, continuing on
    api-error). Everything else — batch-cache intersect, gap compute, per-gap
    fetch + persist, today tri-state, dedupe-by-``t_ms`` / sort / [frm,too]
    filter — lives here, tested once in ``test_batched_daily_walkback.py``.
    """
    today_s = today_d.strftime("%Y%m%d")
    from_s = frm.strftime("%Y%m%d")
    to_s = too.strftime("%Y%m%d")

    warnings: list[dict] = []
    cached_batches: list[str] = []
    fresh_batches: list[str] = []
    loaded: list[dict] = []

    # 1+2. Read existing batches intersecting the request.
    existing_relevant: list[tuple[date, date]] = []
    for b_from, b_to, b_rows in cache.list_batches(code):
        if b_to < frm or b_from > too:
            continue
        existing_relevant.append((b_from, b_to))
        loaded.extend(b_rows)
        cached_batches.append(f"{b_from.strftime('%Y%m%d')}__{b_to.strftime('%Y%m%d')}")

    # 3. Compute gaps (past-only — today handled separately).
    req_to_past = min(too, today_d - timedelta(days=1))
    if frm <= req_to_past:
        for gap_from, gap_to in _compute_daily_gaps(frm, req_to_past, existing_relevant):
            gap_from_s = gap_from.strftime("%Y%m%d")
            gap_to_s = gap_to.strftime("%Y%m%d")
            label = f"{gap_from_s}__{gap_to_s}"
            try:
                rows, violations = await fetch_batch(code, gap_from_s, gap_to_s)
            except KisRateLimitError as e:
                warnings.append(_kis_error_to_warning("kis_rate_limit", str(e), label))
                break
            except KisTransportError as e:
                # Subtype of KisApiError — must precede the generic arm so a
                # network blip (TCP disconnect) carries its own reason and an
                # operator can tell it apart from a KIS rejection (different
                # remediation). Skip this batch, keep walking back. The client
                # already retried connection-level failures once (ADR-0050).
                warnings.append(_kis_error_to_warning("kis_transport", e.msg_cd, label))
                continue
            except KisApiError as e:
                warnings.append(_kis_error_to_warning("kis_api_error", e.msg_cd, label))
                continue
            cache.append_batch(code, gap_from, gap_to, rows)
            loaded.extend(rows)
            fresh_batches.append(label)
            for v in violations:
                warnings.append(_violation_to_warning(v, label))

    # 5. Today handling (separate from past — memory only, tri-state).
    if too >= today_d:
        state, today_row = cache.get_today(code)
        if state == "hit":
            loaded.append(today_row)  # type: ignore[arg-type]
            cached_batches.append(f"{today_s}__{today_s}")
        elif state == "negative":
            pass  # known non-trading day; skip KIS, no row
        else:  # miss
            today_label = f"{today_s}__{today_s}"
            try:
                rows, violations = await fetch_batch(code, today_s, today_s)
                if rows:
                    today_row = rows[0]
                    cache.store_today(code, today_row)
                    loaded.append(today_row)
                    fresh_batches.append(today_label)
                else:
                    # Non-trading day — negative cache, still record the fetch
                    # in fresh_batches for parity with the gap branch (operator
                    # visibility for the KIS round-trip).
                    cache.store_today(code, None)
                    fresh_batches.append(today_label)
                for v in violations:
                    warnings.append(_violation_to_warning(v, today_label))
            except KisRateLimitError as e:
                warnings.append(_kis_error_to_warning("kis_rate_limit", str(e), today_label))
            except KisTransportError as e:
                warnings.append(_kis_error_to_warning("kis_transport", e.msg_cd, today_label))
            except KisApiError as e:
                warnings.append(_kis_error_to_warning("kis_api_error", e.msg_cd, today_label))

    # 6. Dedupe by t_ms, sort, filter to [frm, too].
    frm_ms = int(datetime.combine(frm, time(0, 0), tzinfo=_KST).timestamp() * 1000)
    too_ms = int(datetime.combine(too, time(23, 59, 59), tzinfo=_KST).timestamp() * 1000)
    by_ts: dict[int, dict] = {}
    for row in loaded:
        ts = row.get("t_ms")
        if isinstance(ts, int):
            by_ts[ts] = row
    rows_out = sorted(
        (r for ts, r in by_ts.items() if frm_ms <= ts <= too_ms),
        key=lambda r: r["t_ms"],
    )

    return {
        "code": code,
        "from": from_s,
        "to": to_s,
        output_key: rows_out,
        "cached_batches": cached_batches,
        "fresh_batches": fresh_batches,
        "data_warnings": warnings,
    }


class LiveQuote(BaseModel):
    code: str
    price: int
    change_pct: float | None
    change_won: int | None
    open: int | None = None
    high: int | None = None
    low: int | None = None
    baseline_price: int | None = None
    baseline_date: str | None = None
    change_pct_source: str | None = None
    warnings: list[str] = Field(default_factory=list)
    stale: bool = False
    stale_reason: str | None = None


class LiveQuotesResponse(BaseModel):
    phase: Literal["pre_open", "open", "closed"]
    quotes: list[LiveQuote]


LiveTabMetricHogaReason = Literal[
    "not_collected",
    "stale",
    "index",
    "pre_open",
    "invalid_book",
]


class LiveTabMetric(BaseModel):
    code: str
    change_pct: float | None
    hoga_ratio_x: float | None
    hoga_available: bool
    hoga_reason: LiveTabMetricHogaReason | None = None
    source: Literal["live", "quote_cache"]


class LiveTabMetricsResponse(BaseModel):
    phase: Literal["pre_open", "open", "closed"]
    metrics: list[LiveTabMetric]


class LiveIndexEntry(BaseModel):
    kind: Literal["index"] = "index"
    id: str
    label: str
    investor_scope: Literal["market", "index", "none"]


class LiveIndicesResponse(BaseModel):
    indices: list[LiveIndexEntry]


InvestorEstimateWarningReason = Literal[
    "kis_credentials_missing",
    "kis_rest_bypassed",
    "kis_rate_limit",
    "kis_api_error",
    "parse_error",
]


class LiveInvestorTrendEstimateWarning(BaseModel):
    reason: InvestorEstimateWarningReason
    msg: str


class LiveInvestorTrendEstimateRow(BaseModel):
    slot: str
    observed_at_ms: int
    foreign_qty: int | None
    institution_qty: int | None
    sum_qty: int | None


class LiveInvestorTrendEstimateResponse(BaseModel):
    code: str
    trading_day: str
    fetched_at_ms: int | None
    rows: list[LiveInvestorTrendEstimateRow]
    latest: LiveInvestorTrendEstimateRow | None
    source: Literal["kis"]
    status: Literal["ok", "empty", "error"]
    data_warning: LiveInvestorTrendEstimateWarning | None


class _InvestorEstimateObservedAtStore:
    """Persist per-slot observed times for the display-only investor estimate card."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock_path = path.with_suffix(path.suffix + ".lock")
        self._state: dict[str, dict[str, dict[str, dict[str, int | None]]]] = {}

    def apply(
        self,
        *,
        trading_day: str,
        code: str,
        rows: list[LiveInvestorTrendEstimateRow],
        fetched_at_ms: int,
        full_history: bool,
    ) -> list[LiveInvestorTrendEstimateRow]:
        with self._locked():
            self._load()
            changed = self._prune_to_day(trading_day)
            code_state = self._state.setdefault(trading_day, {}).setdefault(code, {})
            out: list[LiveInvestorTrendEstimateRow] = []
            seen_slots: set[str] = set()
            for row in rows:
                seen_slots.add(row.slot)
                stored = code_state.get(row.slot)
                if stored is not None and _investor_estimate_same_quantities(stored, row):
                    observed_at_ms = stored.get("observed_at_ms")
                    if isinstance(observed_at_ms, int):
                        out.append(row.model_copy(update={"observed_at_ms": observed_at_ms}))
                        continue
                code_state[row.slot] = {
                    "observed_at_ms": fetched_at_ms,
                    "foreign_qty": row.foreign_qty,
                    "institution_qty": row.institution_qty,
                    "sum_qty": row.sum_qty,
                }
                changed = True
                out.append(row)
            if full_history:
                stale_slots = [slot for slot in code_state if slot not in seen_slots]
                for slot in stale_slots:
                    code_state.pop(slot, None)
                changed = changed or bool(stale_slots)
            changed = self._evict_over_capacity(trading_day) or changed
            if changed:
                self._save()
            return out

    def clear(self, *, trading_day: str, code: str) -> None:
        with self._locked():
            self._load()
            changed = self._prune_to_day(trading_day)
            day_state = self._state.get(trading_day)
            if day_state is None or code not in day_state:
                if changed:
                    self._save()
                return
            day_state.pop(code, None)
            self._save()

    @contextlib.contextmanager
    def _locked(self):
        self._lock_path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock_path.open("a", encoding="utf-8") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

    def _load(self) -> None:
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            self._state = {}
            return
        self._state = self._sanitize(raw)

    def _sanitize(
        self,
        raw: object,
    ) -> dict[str, dict[str, dict[str, dict[str, int | None]]]]:
        if not isinstance(raw, dict):
            return {}
        state: dict[str, dict[str, dict[str, dict[str, int | None]]]] = {}
        for day, day_raw in raw.items():
            if not isinstance(day, str) or not isinstance(day_raw, dict):
                continue
            day_state: dict[str, dict[str, dict[str, int | None]]] = {}
            for code, code_raw in day_raw.items():
                if not isinstance(code, str) or not isinstance(code_raw, dict):
                    continue
                code_state: dict[str, dict[str, int | None]] = {}
                for slot, slot_raw in code_raw.items():
                    if not isinstance(slot, str) or not isinstance(slot_raw, dict):
                        continue
                    observed_at_ms = slot_raw.get("observed_at_ms")
                    if not isinstance(observed_at_ms, int):
                        continue
                    code_state[slot] = {
                        "observed_at_ms": observed_at_ms,
                        "foreign_qty": _optional_int(slot_raw.get("foreign_qty")),
                        "institution_qty": _optional_int(slot_raw.get("institution_qty")),
                        "sum_qty": _optional_int(slot_raw.get("sum_qty")),
                    }
                if code_state:
                    day_state[code] = code_state
            if day_state:
                state[day] = day_state
        return state

    def _prune_to_day(self, trading_day: str) -> bool:
        stale_days = [day for day in self._state if day != trading_day]
        for day in stale_days:
            self._state.pop(day, None)
        return bool(stale_days)

    def _evict_over_capacity(self, trading_day: str) -> bool:
        day_state = self._state.get(trading_day)
        if day_state is None:
            return False
        overflow = len(day_state) - _INVESTOR_ESTIMATE_MAX_CODES_PER_DAY
        if overflow <= 0:
            return False
        oldest = sorted(
            day_state,
            key=lambda code: _max_observed_at(day_state[code]),
        )[:overflow]
        for code in oldest:
            day_state.pop(code, None)
        return True

    def _save(self) -> None:
        try:
            atomic_write_json(self._path, self._state)
        except OSError:
            log.warning("failed to persist investor estimate observed_at store", exc_info=True)


def _quote_phase(now: datetime, venue_policy: LiveVenuePolicy = "KRX") -> Literal["pre_open", "open", "closed"]:
    """/quotes 오버레이의 폴링·표시 게이트(스펙 2026-06-08 ⑧).

    closed: 주말 또는 평일 08:50 이전·16:00 이후 — 프론트가 폴링을 600s로
    줄이고 백엔드는 마지막 시세 캐시로 응답한다('마지막 시세 유지' 결정).
    pre_open: 08:50–09:00 동시호가(KRX 08:50 시작) — 등락률 숨김(기존 계약).
    시계 기반 — 평일 공휴일의 드문 낭비는 수용(캘린더 게이트는 동기 KIS HTTP
    재도입이라 배제). session_gate.market_phase(16:00-aware 3-way 세션
    phase)와 계약이 달라 이름을 분리한다."""
    if now.weekday() >= 5:  # noqa: PLR2004 — 토/일
        return "closed"
    t = now.time()
    if venue_policy in ("NXT", "UN"):
        if t < time(8, 0) or t >= time(20, 0):
            return "closed"
        return "open"
    if t < time(8, 50) or t >= time(16, 0):
        return "closed"
    return "pre_open" if t < time(9, 0) else "open"


class ControlRequest(BaseModel):
    action: ControlAction


class LiveQuoteFetcher:
    """`/quotes` 오버레이의 시세 fetch + 마지막-시세 캐시 + phase 게이팅을 한 곳에 모은
    모듈. 라우트는 phase 계산·코드 파싱·KisClient 획득만 하고 이 모듈을 호출한다 —
    캐시·게이팅·graceful-fallback 의 business logic 이 라우트(infra)에서 분리된다.

    청킹(최대 30종목/콜, FHKST11300006)은 그대로 `kis.fetch_multi_price` 내부에 둔다
    (여기선 캐시·게이팅만 소유). 마지막-시세는 표시 전용·디스크 미영속(ADR-0056),
    단일 워커라 dict 로 충분(ADR-0038). FastAPI 없이 fake kis 로 단독 테스트 가능."""

    def __init__(self, *, change_resolver: QuoteChangeResolver | None = None) -> None:
        # 장중 마지막 quotes — closed 서빙용(스펙 2026-06-08 ⑧ '마지막 시세 유지').
        self._last_quotes: dict[str, KisQuote] = {}
        self._change_resolver = change_resolver or QuoteChangeResolver(adjusted_daily_path=None)

    def _to_live_quote(
        self,
        q: KisQuote,
        *,
        phase: str,
        today: date | None = None,
    ) -> LiveQuote:
        resolved = self._change_resolver.resolve_quote(q, phase=phase, today=today)
        pre = phase == "pre_open"
        return LiveQuote(
            code=q.code,
            price=q.price,
            change_pct=resolved.change_pct,
            change_won=resolved.change_won,
            open=(None if pre else q.open),
            high=(None if pre else q.high),
            low=(None if pre else q.low),
            baseline_price=resolved.baseline_price,
            baseline_date=resolved.baseline_date,
            change_pct_source=resolved.change_pct_source,
            warnings=resolved.warnings,
        )

    async def fetch_and_gate(
        self,
        kis: KisClient,
        code_list: list[str],
        phase: str,
        today: date | None = None,
        *,
        venue: KisVenue = "KRX",
    ) -> list[LiveQuote]:
        """code_list 의 시세를 phase 에 맞춰 반환. closed=마지막 시세(캐시 미스면 1회 채움),
        open=라이브, pre_open=등락률 숨김. KIS 실패는 절대 전파하지 않는다(오버레이는 500 금지)."""
        if phase == "closed":
            # 장외: 마지막 시세 서빙. 캐시 미스(재시작 직후)면 1회만 KIS를 불러
            # 채운다 — KIS는 장외에도 종가를 반환. 프론트는 closed에 600s
            # 하트비트라 이 경로의 KIS 콜은 사실상 드로어 마운트 시 1회뿐.
            missing = [c for c in code_list if c not in self._last_quotes]
            if missing:
                try:
                    for q in await kis.fetch_multi_price(code_list, venue=venue):
                        self._last_quotes[q.code] = q
                except Exception as e:  # noqa: BLE001 — 오버레이는 절대 500 금지
                    log.warning("live quotes cold fetch failed (%d codes): %s",
                                len(code_list), e)
            return [
                self._to_live_quote(q, phase=phase, today=today)
                for c in code_list
                if (q := self._last_quotes.get(c)) is not None
            ]
        try:
            quotes = await kis.fetch_multi_price(code_list, venue=venue)
        except Exception as e:  # noqa: BLE001 — 10초 폴링 오버레이는 절대 500 금지;
            # KIS rate-limit/api-error/네트워크 타임아웃 등 무엇이든 빈 결과로 graceful
            # (프론트는 '—' 표시). retry-exhausted 신호는 warning 으로만 남긴다.
            log.warning("live quotes fetch failed (%d codes): %s", len(code_list), e)
            return self.stale_last_good(
                code_list,
                phase,
                today=today,
                stale_reason="kis_fetch_failed",
            )
        for q in quotes:
            self._last_quotes[q.code] = q
        return [self._to_live_quote(q, phase=phase, today=today) for q in quotes]

    def stale_last_good(
        self,
        code_list: list[str],
        phase: str,
        today: date | None = None,
        *,
        stale_reason: str = "kis_rest_bypassed",
    ) -> list[LiveQuote]:
        rows: list[LiveQuote] = []
        for code in code_list:
            q = self._last_quotes.get(code)
            if q is None:
                continue
            rows.append(
                self._to_live_quote(q, phase=phase, today=today).model_copy(
                    update={
                        "stale": True,
                        "stale_reason": stale_reason,
                    }
                )
            )
        return rows


_TAB_METRIC_HOGA_STALE_MS = 15_000


def _extract_tab_hoga_ratio(
    latest_ob: dict | None,
    *,
    now_ms: int,
    stale_ms: int = _TAB_METRIC_HOGA_STALE_MS,
) -> tuple[float | None, bool, LiveTabMetricHogaReason | None]:
    if latest_ob is None:
        return None, False, "not_collected"
    age_ms = now_ms - int(latest_ob.get("t_ms") or 0)
    if age_ms > stale_ms:
        return None, False, "stale"
    bid_total = int(latest_ob.get("total_bid_qty") or 0)
    ask_total = int(latest_ob.get("total_ask_qty") or 0)
    if bid_total <= 0 or ask_total <= 0:
        return None, False, "invalid_book"
    return max(bid_total, ask_total) / min(bid_total, ask_total), True, None


def _investor_estimate_row_to_wire(
    row: InvestorTrendEstimateRow,
    *,
    observed_at_ms: int,
) -> LiveInvestorTrendEstimateRow:
    return LiveInvestorTrendEstimateRow(
        slot=row.slot,
        observed_at_ms=observed_at_ms,
        foreign_qty=row.foreign_qty,
        institution_qty=row.institution_qty,
        sum_qty=row.sum_qty,
    )


def _investor_estimate_has_quantity(row: LiveInvestorTrendEstimateRow) -> bool:
    return (
        row.foreign_qty is not None
        or row.institution_qty is not None
        or row.sum_qty is not None
    )


def _investor_estimate_same_quantities(
    previous: LiveInvestorTrendEstimateRow | dict[str, int | None],
    current: LiveInvestorTrendEstimateRow,
) -> bool:
    if isinstance(previous, LiveInvestorTrendEstimateRow):
        return (
            previous.foreign_qty == current.foreign_qty
            and previous.institution_qty == current.institution_qty
            and previous.sum_qty == current.sum_qty
        )
    return (
        previous.get("foreign_qty") == current.foreign_qty
        and previous.get("institution_qty") == current.institution_qty
        and previous.get("sum_qty") == current.sum_qty
    )


def _optional_int(value: object) -> int | None:
    return value if isinstance(value, int) else None


def _max_observed_at(rows: dict[str, dict[str, int | None]]) -> int:
    values = [
        observed_at_ms
        for row in rows.values()
        if isinstance((observed_at_ms := row.get("observed_at_ms")), int)
    ]
    return max(values, default=-1)


def _latest_investor_estimate_row(
    rows: list[LiveInvestorTrendEstimateRow],
) -> LiveInvestorTrendEstimateRow | None:
    usable = [r for r in rows if _investor_estimate_has_quantity(r)]
    numeric = [(int(r.slot), r) for r in usable if r.slot.isdecimal()]
    if numeric:
        return max(numeric, key=lambda pair: pair[0])[1]
    return usable[-1] if usable else None


class LiveInvestorEstimateFetcher:
    """Fetch/cache intraday investor trend estimates for one process.

    KIS sometimes returns a full intraday history and sometimes only the
    newest slot. Full-history responses replace same-day state. Latest-only
    responses merge by slot so repeated polling reconstructs the day locally.
    """

    def __init__(
        self,
        *,
        ttl_seconds: float = 60.0,
        today_fn: Callable[[], str] = _today_kst_yyyymmdd,
        observed_at_store_path: Path | None = None,
    ) -> None:
        self._ttl_seconds = ttl_seconds
        self._today_fn = today_fn
        self._observed_at_store = (
            _InvestorEstimateObservedAtStore(observed_at_store_path)
            if observed_at_store_path is not None
            else None
        )
        self._cache: dict[
            tuple[str, str],
            tuple[float, LiveInvestorTrendEstimateResponse],
        ] = {}
        self._accumulator: dict[
            tuple[str, str],
            dict[str, LiveInvestorTrendEstimateRow],
        ] = {}
        self._last_success_fetched_at_ms: dict[tuple[str, str], int] = {}
        self._inflight: dict[
            tuple[str, str],
            asyncio.Task[LiveInvestorTrendEstimateResponse],
        ] = {}

    def credentials_missing(self, code: str) -> LiveInvestorTrendEstimateResponse:
        trading_day = self._today_fn()
        return self._response(
            code=code,
            trading_day=trading_day,
            fetched_at_ms=None,
            rows=[],
            status="error",
            warning=LiveInvestorTrendEstimateWarning(
                reason="kis_credentials_missing",
                msg="KIS credentials are not configured",
            ),
        )

    async def fetch(
        self,
        kis: "KisClient",
        code: str,
    ) -> LiveInvestorTrendEstimateResponse:
        trading_day = self._today_fn()
        key = (trading_day, code)
        now = monotonic_time.monotonic()
        self._evict_stale(now=now, trading_day=trading_day)
        cached = self._cache.get(key)
        if cached is not None:
            expires_at, response = cached
            if now < expires_at:
                return response

        task = self._inflight.get(key)
        if task is None:
            task = asyncio.create_task(self._fetch_uncached(kis, code, trading_day))
            self._inflight[key] = task
            task.add_done_callback(lambda _t, k=key: self._inflight.pop(k, None))
        return await task

    async def _fetch_uncached(
        self,
        kis: "KisClient",
        code: str,
        trading_day: str,
    ) -> LiveInvestorTrendEstimateResponse:
        key = (trading_day, code)
        try:
            raw_rows = await kis.fetch_investor_trend_estimate(code)
            fetched_at_ms = int(monotonic_time.time() * 1000)
            rows = [
                _investor_estimate_row_to_wire(r, observed_at_ms=fetched_at_ms)
                for r in raw_rows
            ]
            if self._observed_at_store is not None:
                rows = self._observed_at_store.apply(
                    trading_day=trading_day,
                    code=code,
                    rows=rows,
                    fetched_at_ms=fetched_at_ms,
                    full_history=len(rows) > 1,
                )
        except KisAuthError:
            log.warning("investor trend estimate auth failed for %s", code, exc_info=True)
            response = self._error_response(
                code,
                trading_day,
                "kis_credentials_missing",
                "KIS authentication failed",
            )
            return self._cache_response(key, response)
        except KisRateLimitError as e:
            response = self._error_response(code, trading_day, "kis_rate_limit", str(e))
            return self._cache_response(key, response)
        except KisTransportError as e:
            response = self._error_response(code, trading_day, "kis_api_error", e.msg_cd)
            return self._cache_response(key, response)
        except KisApiError as e:
            response = self._error_response(code, trading_day, "kis_api_error", e.msg_cd)
            return self._cache_response(key, response)
        except ValidationError as e:
            response = self._error_response(code, trading_day, "parse_error", str(e))
            return self._cache_response(key, response)

        if not rows:
            self._accumulator[key] = {}
            if self._observed_at_store is not None:
                self._observed_at_store.clear(trading_day=trading_day, code=code)
            response = self._response(
                code=code,
                trading_day=trading_day,
                fetched_at_ms=fetched_at_ms,
                rows=[],
                status="empty",
                warning=None,
            )
            return self._cache_response(key, response)

        if len(rows) > 1:
            prior = self._accumulator.get(key, {})
            self._accumulator[key] = {
                row.slot: _preserve_investor_estimate_observed_at(
                    previous=prior.get(row.slot),
                    current=row,
                )
                for row in rows
            }
        else:
            current = self._accumulator.setdefault(key, {})
            for row in rows:
                current[row.slot] = _preserve_investor_estimate_observed_at(
                    previous=current.get(row.slot),
                    current=row,
                )

        merged = list(self._accumulator.get(key, {}).values())
        status: Literal["ok", "empty"] = (
            "ok" if any(_investor_estimate_has_quantity(row) for row in merged) else "empty"
        )
        if status == "ok":
            self._last_success_fetched_at_ms[key] = fetched_at_ms
        response = self._response(
            code=code,
            trading_day=trading_day,
            fetched_at_ms=fetched_at_ms,
            rows=merged,
            status=status,
            warning=None,
        )
        return self._cache_response(key, response)

    def _cache_response(
        self,
        key: tuple[str, str],
        response: LiveInvestorTrendEstimateResponse,
    ) -> LiveInvestorTrendEstimateResponse:
        self._cache[key] = (monotonic_time.monotonic() + self._ttl_seconds, response)
        self._evict_over_capacity(trading_day=key[0])
        return response

    def _evict_stale(self, *, now: float, trading_day: str) -> None:
        for key, (expires_at, _response) in list(self._cache.items()):
            if key[0] != trading_day or now >= expires_at:
                self._cache.pop(key, None)
        for state in (self._accumulator, self._last_success_fetched_at_ms):
            for key in list(state):
                if key[0] != trading_day:
                    state.pop(key, None)

    def _evict_over_capacity(self, *, trading_day: str) -> None:
        day_keys = [
            key
            for key in set(self._cache) | set(self._accumulator) | set(self._last_success_fetched_at_ms)
            if key[0] == trading_day
        ]
        overflow = len(day_keys) - _INVESTOR_ESTIMATE_MAX_CODES_PER_DAY
        if overflow <= 0:
            return
        oldest = sorted(
            day_keys,
            key=lambda key: (
                self._last_success_fetched_at_ms.get(key, -1),
                self._cache.get(key, (0.0, None))[0],
            ),
        )[:overflow]
        for key in oldest:
            self._cache.pop(key, None)
            self._accumulator.pop(key, None)
            self._last_success_fetched_at_ms.pop(key, None)

    def _error_response(
        self,
        code: str,
        trading_day: str,
        reason: InvestorEstimateWarningReason,
        msg: str,
    ) -> LiveInvestorTrendEstimateResponse:
        key = (trading_day, code)
        fetched_at_ms = self._last_success_fetched_at_ms.get(key)
        rows = list(self._accumulator.get(key, {}).values())
        return self._response(
            code=code,
            trading_day=trading_day,
            fetched_at_ms=fetched_at_ms,
            rows=rows,
            status="error",
            warning=LiveInvestorTrendEstimateWarning(reason=reason, msg=msg),
        )

    def _response(
        self,
        *,
        code: str,
        trading_day: str,
        fetched_at_ms: int | None,
        rows: list[LiveInvestorTrendEstimateRow],
        status: Literal["ok", "empty", "error"],
        warning: LiveInvestorTrendEstimateWarning | None,
    ) -> LiveInvestorTrendEstimateResponse:
        return LiveInvestorTrendEstimateResponse(
            code=code,
            trading_day=trading_day,
            fetched_at_ms=fetched_at_ms,
            rows=rows,
            latest=_latest_investor_estimate_row(rows),
            source="kis",
            status=status,
            data_warning=warning,
        )


def _preserve_investor_estimate_observed_at(
    previous: LiveInvestorTrendEstimateRow | None,
    current: LiveInvestorTrendEstimateRow,
) -> LiveInvestorTrendEstimateRow:
    if previous is None:
        return current
    if _investor_estimate_same_quantities(previous, current):
        return current.model_copy(update={"observed_at_ms": previous.observed_at_ms})
    return current


def build_router(
    get_status: Callable[[], LiveStatus],
    get_buffer: Callable[[], LiveBuffer] | None = None,
    on_control: Callable[[str], Awaitable[None]] | None = None,
    get_today_ask_peak: Callable[[str], dict | None] | None = None,
    get_today_bid_peak: Callable[[str], dict | None] | None = None,
    *,
    data_dir: Path | None = None,
) -> APIRouter:
    """Build the /api/live router.

    Args:
        get_status: zero-arg callable returning the current `LiveStatus`.
        get_buffer: optional zero-arg callable returning the `LiveBuffer`
            singleton. None → /snapshot and /series return 503.
        on_control: optional handler invoked with the action string when
            POST /control is called. None → returns 503 for control requests.
        get_today_ask_peak: optional callable returning the current
            ask-peak-today snapshot for a code. None → /series returns null.
        get_today_bid_peak: optional callable returning the current
            bid-peak-today snapshot for a code. None → /series returns null.
    """
    router = APIRouter(prefix="/api/live")
    _kis_scheduler = ensure_kis_capacity_scheduler(data_dir) if data_dir is not None else None

    def _has_kis_capacity_candidate() -> bool:
        if data_dir is None:
            return False
        return kis_access.has_rest_capacity(data_dir)

    @router.get("/status", response_model=LiveStatus)
    async def _get_status() -> LiveStatus:
        status = get_status()
        if _kis_scheduler is None:
            return status
        return status.model_copy(
            update={"kis_capacity_scheduler": _kis_scheduler.snapshot()}
        )

    @router.get("/settings", response_model=LiveSettingsResponse)
    async def _get_settings() -> LiveSettingsResponse:
        if data_dir is None:
            raise HTTPException(503, "live settings not wired")
        return load_live_settings(data_dir)

    @router.patch("/settings", response_model=LiveSettingsResponse)
    async def _patch_settings(req: LiveSettingsUpdate) -> LiveSettingsResponse:
        if data_dir is None:
            raise HTTPException(503, "live settings not wired")
        settings = update_live_settings(
            data_dir,
            storage_policy=req.storage_policy,
            program_trade_storage_enabled=req.program_trade_storage_enabled,
            kis_rest_bypass_enabled=req.kis_rest_bypass_enabled,
        )
        try:
            await refresh_live_stream(data_dir=data_dir)
        except Exception:
            log.exception("live.settings: refresh_live_stream failed")
        return settings

    @router.get("/indices", response_model=LiveIndicesResponse)
    async def _get_indices() -> LiveIndicesResponse:
        return LiveIndicesResponse(
            indices=[
                LiveIndexEntry(
                    id=index.id,
                    label=index.label,
                    investor_scope=index.investor_scope,
                )
                for index in list_representative_indices()
            ],
        )

    @router.get("/index-candles")
    async def _get_index_candles(
        index_id: str = Query(...),
        timeframe: Literal["1m", "3m", "5m", "10m", "15m", "30m", "D", "W", "M"] = Query(...),
        from_: str = Query(..., alias="from"),
        to: str = Query(...),
    ) -> dict:
        index = _validate_index_range(index_id, from_, to)
        if data_dir is None:
            raise HTTPException(503, "KIS client not wired")
        if timeframe in {"D", "W", "M"}:
            if index_candles_cache_instance is None:
                raise HTTPException(503, "index-candles cache not wired (data_dir missing)")
            if kis_access.kis_rest_bypass_enabled(data_dir):
                return _collect_index_daily_candles_cache_only(
                    cache=index_candles_cache_instance,
                    key=(index.id, timeframe),
                    index_id=index.id,
                    timeframe=timeframe,
                    from_s=from_,
                    to_s=to,
                )
            if _kis_scheduler is None:
                raise HTTPException(503, "KIS scheduler not wired")
            if not kis_access.has_rest_capacity(data_dir):
                raise HTTPException(503, "KIS client not initialized")

            async def fetch_batch(from_s: str, to_s: str):
                async def direct_fetch(inner_from_s: str, inner_to_s: str):
                    return await kis_access.run_with_capacity(
                        _kis_scheduler,
                        data_dir=data_dir,
                        role="foreground",
                        key=("index-daily", index.id, timeframe, inner_from_s, inner_to_s),
                        endpoint=kis_access.KisRestEndpoint.INDEX_DAILY,
                        priority="user_visible",
                        cooldown_scope=("index-daily", index.id, timeframe),
                        fetch_fn=lambda kis: kis.fetch_index_daily_candles(
                            index,
                            inner_from_s,
                            inner_to_s,
                            period=timeframe,
                            foreground=True,
                        ),
                    )

                return await fetch_index_daily_candles_windowed(
                    from_s,
                    to_s,
                    timeframe,
                    direct_fetch,
                )

            result = await collect_index_candles_with_cache(
                index_candles_cache_instance,
                (index.id, timeframe),
                from_,
                to,
                fetch_batch,
            )
        else:
            bucket_seconds = {
                "1m": 60,
                "3m": 180,
                "5m": 300,
                "10m": 600,
                "15m": 900,
                "30m": 1800,
            }[timeframe]
            if index_minute_candles_cache_instance is None:
                raise HTTPException(503, "index-minute-candles cache not wired (data_dir missing)")
            if kis_access.kis_rest_bypass_enabled(data_dir):
                return _collect_index_minute_candles_cache_only(
                    cache=index_minute_candles_cache_instance,
                    key=(index.id, timeframe, bucket_seconds),
                    index_id=index.id,
                    timeframe=timeframe,
                    from_s=from_,
                    to_s=to,
                )
            if _kis_scheduler is None:
                raise HTTPException(503, "KIS scheduler not wired")
            if not kis_access.has_rest_capacity(data_dir):
                raise HTTPException(503, "KIS client not initialized")

            async def fetch_batch(from_s: str, to_s: str):
                return await kis_access.run_with_capacity(
                    _kis_scheduler,
                    data_dir=data_dir,
                    role="foreground",
                    key=("index-minute", index.id, timeframe, bucket_seconds, from_s, to_s),
                    endpoint=kis_access.KisRestEndpoint.INDEX_MINUTE,
                    priority="user_visible",
                    cooldown_scope=("index-minute", index.id, timeframe),
                    fetch_fn=lambda kis: kis.fetch_index_minute_candles(
                        index,
                        from_s,
                        to_s,
                        bucket_seconds=bucket_seconds,
                        foreground=True,
                    ),
                )

            result = await collect_index_minute_candles_with_cache(
                index_minute_candles_cache_instance,
                (index.id, timeframe, bucket_seconds),
                from_,
                to,
                fetch_batch,
            )
        batch_label = f"{from_}__{to}"
        data_warnings = [
            _violation_to_warning(v, batch_label) for v in result.violations
        ]
        if timeframe not in {"D", "W", "M"} and result.candles:
            earliest_returned = min(_candle_date_yyyymmdd(c) for c in result.candles)
            if from_ < earliest_returned:
                data_warnings.append({
                    "batch": batch_label,
                    "date": earliest_returned,
                    "reason": "index_minute_depth_limited",
                    "msg": (
                        "KIS index minute REST returned no candles before "
                        f"{earliest_returned} for this source unit"
                    ),
                })
        return {
            "index_id": index.id,
            "from": from_,
            "to": to,
            "timeframe": timeframe,
            "candles": [_candle_to_dict(c) for c in result.candles],
            "data_warnings": data_warnings,
        }

    @router.get("/index-investor-net")
    async def _get_index_investor_net(
        index_id: str = Query(...),
        from_: str = Query(..., alias="from"),
        to: str = Query(...),
    ) -> dict:
        index = _validate_index_range(index_id, from_, to)
        if index.investor_scope != "market":
            raise HTTPException(
                422,
                {
                    "code": "unsupported_index_investor_net",
                    "msg": f"{index.id} does not support market investor net",
                },
            )
        if data_dir is not None and kis_access.kis_rest_bypass_enabled(data_dir):
            return {
                "index_id": index.id,
                "from": from_,
                "to": to,
                "points": [],
                "data_warnings": [
                    _kis_rest_bypassed_batch_warning(f"{from_}__{to}"),
                ],
            }
        if _kis_scheduler is None:
            raise HTTPException(503, "KIS scheduler not wired")
        if not _has_kis_capacity_candidate():
            raise HTTPException(503, "KIS client not initialized")
        if _index_investor_net_fetcher is None:
            raise HTTPException(503, "index-investor-net fetcher not wired")
        return await _index_investor_net_fetcher.fetch(
            index=index,
            from_label=from_,
            to_label=to,
        )

    @router.get("/index-sector-rankings", response_model=IndexSectorRankingResponse)
    async def _get_index_sector_rankings(date: str = Query(...)) -> IndexSectorRankingResponse:
        basis = _parse_yyyymmdd(date)
        if basis is None:
            raise HTTPException(422, {"code": "invalid_date", "msg": "date must be YYYYMMDD"})
        today = _today_kst_yyyymmdd()
        if date > today:
            raise HTTPException(422, {"code": "date_in_future", "msg": "date must be <= today_kst"})
        if data_dir is None:
            raise HTTPException(503, "live data dir not wired")
        intraday_prices: dict[str, int] | None = {} if date == today else None
        if date == today and _index_sector_intraday_overlay is not None:
            intraday_prices = await _index_sector_intraday_overlay.fetch_prices(
                phase=_quote_phase(datetime.now(_KST)),
            )
        return build_index_sector_rankings(
            data_dir,
            date,
            intraday_prices=intraday_prices,
        ).model_dump()

    @router.post("/control")
    async def _post_control(req: ControlRequest) -> dict[str, str]:
        if on_control is None:
            raise HTTPException(503, "live control not wired (Stage 8)")
        await on_control(req.action)
        return {"action": req.action, "ok": "true"}

    @router.get("/snapshot")
    async def _get_snapshot(code: str) -> dict:
        if get_buffer is None:
            raise HTTPException(503, "live buffer not wired")
        buf = get_buffer()
        latest = await buf.get_latest(code)
        if latest is None:
            raise HTTPException(404, f"no live data for {code}")
        return latest

    @router.get("/series")
    async def _get_series(code: str, date: str) -> dict:
        if get_buffer is None:
            raise HTTPException(503, "live buffer not wired")
        buf = get_buffer()
        series = await buf.get_series(code)
        kst = timezone(timedelta(hours=9))
        dt = datetime.strptime(date, "%Y%m%d").replace(tzinfo=kst)
        session_open_ms = int(dt.replace(hour=9, minute=0).timestamp() * 1000)
        return {
            **series,
            "date": date,
            "session_open_ms": session_open_ms,
            "session_close_ms": None,
            "is_open": True,
            "ask_peak_today": (
                get_today_ask_peak(code) if get_today_ask_peak is not None else None
            ),
            "bid_peak_today": (
                get_today_bid_peak(code) if get_today_bid_peak is not None else None
            ),
        }

    # 시세 오버레이 fetch+캐시+게이팅은 LiveQuoteFetcher 가 소유. build_router 호출마다
    # 새 인스턴스라 마지막-시세 캐시 스코프는 종전(per-router 클로저)과 동일.
    quote_change_resolver = QuoteChangeResolver(
        adjusted_daily_path=(
            data_dir / "screener" / "daily_adjusted.parquet"
            if data_dir is not None
            else None
        )
    )
    _quote_fetcher = LiveQuoteFetcher(change_resolver=quote_change_resolver)
    _investor_estimate_fetcher = LiveInvestorEstimateFetcher(
        observed_at_store_path=(
            data_dir / "live" / "investor-trend-estimate-observed-at.json"
            if data_dir is not None
            else None
        )
    )
    _index_investor_net_fetcher: LiveIndexInvestorNetFetcher | None = (
        LiveIndexInvestorNetFetcher(data_dir=data_dir, scheduler=_kis_scheduler)
        if data_dir is not None and _kis_scheduler is not None
        else None
    )
    _index_sector_intraday_overlay: LiveIndexSectorIntradayOverlay | None = (
        LiveIndexSectorIntradayOverlay(
            data_dir=data_dir,
            scheduler=_kis_scheduler,
            quote_fetcher=_quote_fetcher,
        )
        if data_dir is not None and _kis_scheduler is not None
        else None
    )

    @router.get("/quotes", response_model=LiveQuotesResponse)
    async def _get_quotes(
        codes: str = Query(...),
        venue: str | None = Query("KRX"),
    ) -> LiveQuotesResponse:
        now = datetime.now(_KST)
        try:
            venue_policy = parse_live_venue_policy(venue)
        except ValueError as e:
            raise HTTPException(422, {"code": "invalid_venue", "msg": str(e)}) from e
        quote_venue = quote_venue_for_policy(venue_policy, now)
        phase = _quote_phase(now, venue_policy)
        code_list = [c for c in codes.split(",") if _CODE_RE.match(c)]
        if not code_list:
            return LiveQuotesResponse(phase=phase, quotes=[])
        if data_dir is not None and kis_access.kis_rest_bypass_enabled(data_dir):
            return LiveQuotesResponse(
                phase=phase,
                quotes=_quote_fetcher.stale_last_good(
                    code_list,
                    phase,
                    today=now.date(),
                ),
            )
        if _kis_scheduler is None:
            return LiveQuotesResponse(phase=phase, quotes=[])
        try:
            quotes = await asyncio.wait_for(
                asyncio.shield(
                    kis_access.run_with_capacity(
                        _kis_scheduler,
                        data_dir=data_dir,
                        role="background",
                        key=("quotes", quote_venue, tuple(sorted(code_list)), phase),
                        endpoint=kis_access.KisRestEndpoint.QUOTES,
                        priority="background",
                        cooldown_scope=f"quotes:{quote_venue}",
                        fetch_fn=lambda kis: _quote_fetcher.fetch_and_gate(
                            kis,
                            code_list,
                            phase,
                            today=now.date(),
                            venue=quote_venue,
                        ),
                    )
                ),
                timeout=1.0,
            )
        except (asyncio.TimeoutError, KisCapacityCooldown, KisCapacityOverloaded):
            quotes = []
        return LiveQuotesResponse(
            phase=phase,
            quotes=quotes,
        )

    @router.get("/tab-metrics", response_model=LiveTabMetricsResponse)
    async def _get_tab_metrics(
        codes: str = Query(...),
        venue: str | None = Query("KRX"),
    ) -> LiveTabMetricsResponse:
        now = datetime.now(_KST)
        now_ms = int(now.timestamp() * 1000)
        try:
            venue_policy = parse_live_venue_policy(venue)
        except ValueError as e:
            raise HTTPException(422, {"code": "invalid_venue", "msg": str(e)}) from e
        quote_venue = quote_venue_for_policy(venue_policy, now)
        phase = _quote_phase(now, venue_policy)
        code_list = list(dict.fromkeys(c for c in codes.split(",") if _CODE_RE.match(c)))
        if not code_list:
            return LiveTabMetricsResponse(phase=phase, metrics=[])

        quotes: list[LiveQuote] = []
        if data_dir is not None and kis_access.kis_rest_bypass_enabled(data_dir):
            quotes = []
        elif _kis_scheduler is not None:
            try:
                quotes = await asyncio.wait_for(
                    asyncio.shield(
                        kis_access.run_with_capacity(
                            _kis_scheduler,
                            data_dir=data_dir,
                            role="background",
                            key=("tab-metrics-quotes", quote_venue, tuple(sorted(code_list)), phase),
                            endpoint=kis_access.KisRestEndpoint.QUOTES,
                            priority="background",
                            cooldown_scope=f"quotes:{quote_venue}",
                            fetch_fn=lambda kis: _quote_fetcher.fetch_and_gate(
                                kis,
                                code_list,
                                phase,
                                today=now.date(),
                                venue=quote_venue,
                            ),
                        )
                    ),
                    timeout=1.0,
                )
            except (asyncio.TimeoutError, KisCapacityCooldown, KisCapacityOverloaded):
                quotes = []
        quote_by_code = {quote.code: quote for quote in quotes}

        buf = get_buffer() if get_buffer is not None else None
        metrics: list[LiveTabMetric] = []
        for code in code_list:
            quote = quote_by_code.get(code)
            series = await buf.get_series(code) if buf is not None else None
            snapshots = series.get("snapshots", []) if series is not None else []
            latest_ob = snapshots[-1] if snapshots else None
            ratio, hoga_available, hoga_reason = _extract_tab_hoga_ratio(latest_ob, now_ms=now_ms)
            metrics.append(
                LiveTabMetric(
                    code=code,
                    change_pct=quote.change_pct if quote is not None else None,
                    hoga_ratio_x=ratio,
                    hoga_available=hoga_available,
                    hoga_reason=hoga_reason,
                    source="quote_cache" if phase == "closed" else "live",
                )
            )
        return LiveTabMetricsResponse(phase=phase, metrics=metrics)

    @router.get(
        "/investor-trend-estimate",
        response_model=LiveInvestorTrendEstimateResponse,
    )
    async def _get_investor_trend_estimate(
        code: str = Query(...),
    ) -> LiveInvestorTrendEstimateResponse:
        if not _CODE_RE.match(code):
            raise HTTPException(
                422,
                {"code": "invalid_code", "msg": "code must be 6 digits"},
            )
        if data_dir is not None and kis_access.kis_rest_bypass_enabled(data_dir):
            return _investor_estimate_fetcher._error_response(
                code,
                _investor_estimate_fetcher._today_fn(),
                "kis_rest_bypassed",
                "KIS REST bypass is enabled",
            )
        if _kis_scheduler is None:
            return _investor_estimate_fetcher.credentials_missing(code)
        if not _has_kis_capacity_candidate():
            return _investor_estimate_fetcher.credentials_missing(code)
        try:
            return await asyncio.wait_for(
                asyncio.shield(
                    kis_access.run_with_capacity(
                        _kis_scheduler,
                        data_dir=data_dir,
                        role="background",
                        key=("investor-trend-estimate", code),
                        endpoint=kis_access.KisRestEndpoint.INVESTOR_TREND_ESTIMATE,
                        priority="background",
                        cooldown_scope="investor-trend-estimate",
                        fetch_fn=lambda kis: _investor_estimate_fetcher.fetch(kis, code),
                    )
                ),
                timeout=1.5,
            )
        except (asyncio.TimeoutError, KisCapacityCooldown, KisCapacityOverloaded):
            return _investor_estimate_fetcher._error_response(
                code,
                _investor_estimate_fetcher._today_fn(),
                "kis_rate_limit",
                "KIS capacity scheduler unavailable",
            )

    cache_instance: PastCandlesCache | None = (
        PastCandlesCache(data_dir=data_dir) if data_dir is not None else None
    )
    minute_backfill: LiveMinuteCandleBackfill | None = (
        LiveMinuteCandleBackfill(
            data_dir=data_dir,
            cache=cache_instance,
            scheduler=_kis_scheduler,
            concurrency=_PAST_CANDLES_CONCURRENCY,
            rate_limit_cooldown_s=_PAST_CANDLES_RATE_LIMIT_COOLDOWN_S,
        )
        if data_dir is not None and cache_instance is not None and _kis_scheduler is not None
        else None
    )
    daily_cache_instance: PastDailyCandlesCache | None = (
        PastDailyCandlesCache() if data_dir is not None else None
    )
    daily_backfill: LiveDailyCandleBackfill | None = (
        LiveDailyCandleBackfill(
            data_dir=data_dir,
            cache=daily_cache_instance,
            scheduler=_kis_scheduler,
            walkback=batched_daily_walkback,
        )
        if data_dir is not None and daily_cache_instance is not None and _kis_scheduler is not None
        else None
    )
    global index_candles_cache_instance
    if data_dir is not None and index_candles_cache_instance is None:
        index_candles_cache_instance = IndexCandlesCache()
    global index_minute_candles_cache_instance
    if data_dir is not None and index_minute_candles_cache_instance is None:
        index_minute_candles_cache_instance = IndexMinuteCandlesCache()
    # Investor net-buy reuses the daily candle cache (ADR-0055): same date-cursor
    # walk-back + batch/gap memory cache shape, just storing point dicts.
    investor_cache_instance: PastDailyCandlesCache | None = (
        PastDailyCandlesCache() if data_dir is not None else None
    )
    investor_net_backfill: LiveInvestorNetBackfill | None = (
        LiveInvestorNetBackfill(
            data_dir=data_dir,
            cache=investor_cache_instance,
            scheduler=_kis_scheduler,
            walkback=batched_daily_walkback,
        )
        if data_dir is not None and investor_cache_instance is not None and _kis_scheduler is not None
        else None
    )

    @router.get("/past-candles")
    async def _get_past_candles(
        code: str = Query(...),
        from_: str = Query(..., alias="from"),
        to: str = Query(...),
        venue: str | None = Query("KRX"),
    ) -> dict:
        frm, too, today_d = _validate_past_request(code, from_, to)
        try:
            policy = parse_live_venue_policy(venue)
        except ValueError as e:
            raise HTTPException(422, {"code": "invalid_venue", "msg": str(e)}) from e
        if minute_backfill is None:
            raise HTTPException(503, "past-candles cache not wired (data_dir missing)")
        if data_dir is not None and kis_access.kis_rest_bypass_enabled(data_dir):
            out = await minute_backfill.collect_minute_cache_only(
                code=code,
                frm=frm,
                too=too,
                today_d=today_d,
                policy=policy,
            )
            return {"code": code, "from": from_, "to": to, "venue": policy, **out.model_dump()}
        if _kis_scheduler is None:
            raise HTTPException(503, "KIS scheduler not wired")
        if not _has_kis_capacity_candidate():
            raise HTTPException(503, "KIS client not initialized")

        out = await minute_backfill.collect_minute(
            code=code,
            frm=frm,
            too=too,
            today_d=today_d,
            policy=policy,
        )
        return {"code": code, "from": from_, "to": to, "venue": policy, **out.model_dump()}

    @router.get("/past-daily-candles")
    async def _get_past_daily_candles(
        code: str = Query(...),
        from_: str = Query(..., alias="from"),
        to: str = Query(...),
        venue: str | None = Query("KRX"),
    ) -> dict:
        frm, too, today_d = _validate_past_request(code, from_, to, max_days=None)
        try:
            policy = parse_live_venue_policy(venue)
        except ValueError as e:
            raise HTTPException(422, {"code": "invalid_venue", "msg": str(e)}) from e
        if daily_backfill is None:
            raise HTTPException(503, "past-daily-candles cache not wired (data_dir missing)")
        if data_dir is not None and kis_access.kis_rest_bypass_enabled(data_dir):
            return await daily_backfill.collect_daily_cache_only(
                code=code,
                frm=frm,
                too=too,
                today_d=today_d,
                policy=policy,
                from_label=from_,
                to_label=to,
            )
        if _kis_scheduler is None:
            raise HTTPException(503, "KIS scheduler not wired")
        if not _has_kis_capacity_candidate():
            raise HTTPException(503, "KIS client not initialized")
        return await daily_backfill.collect_daily(
            code=code,
            frm=frm,
            too=too,
            today_d=today_d,
            policy=policy,
            from_label=from_,
            to_label=to,
        )

    @router.get("/screener-daily-candles")
    async def _get_screener_daily_candles(
        code: str = Query(...),
        from_: str = Query(..., alias="from"),
        to: str = Query(...),
    ) -> dict:
        frm, too, _today_d = _validate_past_request(code, from_, to, max_days=None)
        if data_dir is None:
            raise HTTPException(503, "screener daily corpus not wired (data_dir missing)")
        return read_screener_daily_candles(
            data_dir,
            code=code,
            frm=frm,
            too=too,
            from_label=from_,
            to_label=to,
        )

    @router.get("/past-investor-net")
    async def _get_past_investor_net(
        code: str = Query(...),
        from_: str = Query(..., alias="from"),
        to: str = Query(...),
    ) -> dict:
        """Daily foreign/institution net-buy quantities across [from, to].

        KIS investor-trade-by-stock-daily (FHPTJ04160001) supports date-cursor
        walk-back (ADR-0055), so this mirrors /past-daily-candles: batch/gap
        memory cache + per-gap walk-back fetch + today tri-state. Net-buy is
        signed (+ buy / − sell). Today's row is provisional until ~15:40 (가집계).
        """
        frm, too, today_d = _validate_past_request(code, from_, to, max_days=None)
        if (
            data_dir is not None
            and investor_cache_instance is not None
            and kis_access.kis_rest_bypass_enabled(data_dir)
        ):
            return _collect_daily_series_cache_only(
                cache=investor_cache_instance,
                output_key="points",
                code=code,
                frm=frm,
                too=too,
                today_d=today_d,
                from_label=from_,
                to_label=to,
            )
        if _kis_scheduler is None:
            raise HTTPException(503, "KIS scheduler not wired")
        if not _has_kis_capacity_candidate():
            raise HTTPException(503, "KIS client not initialized")
        if investor_net_backfill is None:
            raise HTTPException(503, "past-investor-net cache not wired (data_dir missing)")
        return await investor_net_backfill.collect(
            code=code,
            frm=frm,
            too=too,
            today_d=today_d,
        )

    return router
