"""FastAPI router for Live Capture endpoints (spec §6)."""
from __future__ import annotations

import asyncio
import json as _json
import re
from collections.abc import Awaitable
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from hoga.live.kis_client import KisApiError, KisRateLimitError
from hoga.live.past_candles_cache import PastCandlesCache
from hoga.live.past_daily_candles_cache import PastDailyCandlesCache

from .buffer import LiveBuffer
from .lifecycle import LiveStatus

if TYPE_CHECKING:
    from .kis_client import KisClient

ControlAction = Literal["start", "stop", "pause"]

_PAST_MAX_DAYS = 250
_CODE_RE = re.compile(r"^\d{6}$")
_KST = timezone(timedelta(hours=9))


def _today_kst_date() -> date:
    return datetime.now(_KST).date()


def _parse_yyyymmdd(s: str) -> date | None:
    try:
        return datetime.strptime(s, "%Y%m%d").date()
    except ValueError:
        return None


def _date_iter(frm: date, to: date):
    cur = frm
    while cur <= to:
        yield cur.strftime("%Y%m%d")
        cur = cur + timedelta(days=1)


def _candle_to_dict(c) -> dict:
    return {
        "t_ms": c.t_ms, "open": c.open, "high": c.high, "low": c.low,
        "close": c.close, "volume": c.volume,
    }


def _validate_past_request(code: str, from_: str, to: str) -> tuple[date, date, date]:
    """Validate past-candles request params, returning parsed (frm, too, today).

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
    span_days = (too - frm).days + 1
    if span_days > _PAST_MAX_DAYS:
        raise HTTPException(
            422,
            {"code": "date_range_too_large", "msg": f"max {_PAST_MAX_DAYS} days", "max_days": _PAST_MAX_DAYS},
        )
    return frm, too, today_d


def _validate_daily_past_request(
    code: str, from_: str, to: str
) -> tuple[date, date, date]:
    """Validate daily past-candles request, returning parsed (frm, too, today).

    Unlike `_validate_past_request` (250-day cap on minute path), the daily
    path is uncapped — KIS retention (~20-30 years) is the natural ceiling
    and rate-limit handling surfaces partial responses via data_warnings.

    Raises HTTPException(422) on invalid code / date / order / future date.
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
    return frm, too, today_d


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


class ControlRequest(BaseModel):
    action: ControlAction


def build_router(
    get_status: Callable[[], LiveStatus],
    get_buffer: Callable[[], LiveBuffer] | None = None,
    on_control: Callable[[str], Awaitable[None]] | None = None,
    get_kis_client: "Callable[[], KisClient | None] | None" = None,
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
    """
    router = APIRouter(prefix="/api/live")

    @router.get("/status", response_model=LiveStatus)
    async def _get_status() -> LiveStatus:
        return get_status()

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
        }

    @router.get("/stream")
    async def _get_stream(code: str) -> EventSourceResponse:
        if get_buffer is None:
            raise HTTPException(503, "live buffer not wired")
        buf = get_buffer()
        q = buf.subscribe(code)

        async def stream():
            try:
                while True:
                    try:
                        entry = await asyncio.wait_for(q.get(), timeout=30.0)
                        yield {"event": "live_snapshot", "data": _json.dumps(entry)}
                    except asyncio.TimeoutError:
                        yield {"event": "heartbeat", "data": ""}
            finally:
                buf.unsubscribe(code, q)

        return EventSourceResponse(stream())

    cache_instance: PastCandlesCache | None = (
        PastCandlesCache(data_dir=data_dir) if data_dir is not None else None
    )
    daily_cache_instance: PastDailyCandlesCache | None = (
        PastDailyCandlesCache() if data_dir is not None else None
    )

    @router.get("/past-candles")
    async def _get_past_candles(
        code: str = Query(...),
        from_: str = Query(..., alias="from"),
        to: str = Query(...),
    ) -> dict:
        frm, too, today_d = _validate_past_request(code, from_, to)
        today_s = today_d.strftime("%Y%m%d")
        if get_kis_client is None:
            raise HTTPException(503, "KIS client not wired")
        kis = get_kis_client()
        if kis is None:
            raise HTTPException(503, "KIS client not initialized")
        if cache_instance is None:
            raise HTTPException(503, "past-candles cache not wired (data_dir missing)")
        cache = cache_instance

        candles_all: list[dict] = []
        cached_dates: list[str] = []
        fresh_dates: list[str] = []
        warnings: list[dict] = []
        aborted = False

        for date_s in _date_iter(frm, too):
            if aborted:
                warnings.append({"date": date_s, "reason": "rate_limit_aborted", "msg": "previous date hit rate limit"})
                continue
            try:
                if date_s < today_s:
                    bars = cache.get_past(code, date_s)
                    if bars is None:
                        raw = await kis.fetch_past_minute_candles(code, date_s)
                        bars = [_candle_to_dict(c) for c in raw]
                        try:
                            cache.store_past(code, date_s, bars)
                        except OSError as e:
                            # Disk write failure (full disk, permission, etc.):
                            # serve the bars in-memory but surface as warning.
                            warnings.append({
                                "date": date_s,
                                "reason": "cache_write_failed",
                                "msg": str(e),
                            })
                        fresh_dates.append(date_s)
                    else:
                        cached_dates.append(date_s)
                else:  # date_s == today_s
                    state, today_bars = cache.get_today_tri(code)
                    if state == "hit":
                        # tri-state invariant: "hit" implies today_bars is not None
                        assert today_bars is not None
                        bars = today_bars
                        cached_dates.append(date_s)
                    elif state == "negative":
                        # Known non-trading day; skip KIS, no row to add.
                        bars = []
                    else:  # miss
                        raw = await kis.fetch_past_minute_candles(code, date_s)
                        bars = [_candle_to_dict(c) for c in raw]
                        if bars:
                            cache.store_today(code, bars)
                            fresh_dates.append(date_s)
                        else:
                            # Negative cache: known non-trading day for today.
                            # Skip KIS for the TTL window.
                            cache.store_today(code, None)
                candles_all.extend(bars)
            except KisRateLimitError as e:
                warnings.append({"date": date_s, "reason": "kis_rate_limit", "msg": str(e)})
                aborted = True
            except KisApiError as e:
                warnings.append({"date": date_s, "reason": "kis_api_error", "msg": e.msg_cd})

        return {
            "code": code,
            "from": from_,
            "to": to,
            "candles": candles_all,
            "cached_dates": cached_dates,
            "fresh_dates": fresh_dates,
            "data_warnings": warnings,
        }

    @router.get("/past-daily-candles")
    async def _get_past_daily_candles(
        code: str = Query(...),
        from_: str = Query(..., alias="from"),
        to: str = Query(...),
    ) -> dict:
        frm, too, today_d = _validate_daily_past_request(code, from_, to)
        today_s = today_d.strftime("%Y%m%d")
        from_s = frm.strftime("%Y%m%d")
        to_s = too.strftime("%Y%m%d")

        if get_kis_client is None:
            raise HTTPException(503, "KIS client not wired")
        kis = get_kis_client()
        if kis is None:
            raise HTTPException(503, "KIS client not initialized")
        if daily_cache_instance is None:
            raise HTTPException(503, "past-daily-candles cache not wired (data_dir missing)")
        cache = daily_cache_instance

        warnings: list[dict] = []
        cached_batches: list[str] = []
        fresh_batches: list[str] = []
        loaded_bars: list[dict] = []

        # 1+2. Read existing batches, filter to those intersecting request.
        existing_all = cache.list_batches(code)
        existing_relevant: list[tuple[date, date]] = []
        for b_from, b_to, b_bars in existing_all:
            if b_to < frm or b_from > too:
                continue
            existing_relevant.append((b_from, b_to))
            loaded_bars.extend(b_bars)
            cached_batches.append(
                f"{b_from.strftime('%Y%m%d')}__{b_to.strftime('%Y%m%d')}"
            )

        # 3. Compute gaps (past-only — today handled separately).
        req_to_past = min(too, today_d - timedelta(days=1))
        if frm <= req_to_past:
            gaps = _compute_daily_gaps(frm, req_to_past, existing_relevant)
            for gap_from, gap_to in gaps:
                gap_from_s = gap_from.strftime("%Y%m%d")
                gap_to_s = gap_to.strftime("%Y%m%d")
                label = f"{gap_from_s}__{gap_to_s}"
                try:
                    result = await kis.fetch_past_daily_candles(
                        code, gap_from_s, gap_to_s,
                    )
                except KisRateLimitError as e:
                    warnings.append(_kis_error_to_warning("kis_rate_limit", str(e), label))
                    break
                except KisApiError as e:
                    warnings.append(_kis_error_to_warning("kis_api_error", e.msg_cd, label))
                    continue
                bars_dicts = [_candle_to_dict(c) for c in result.candles]
                cache.append_batch(code, gap_from, gap_to, bars_dicts)
                loaded_bars.extend(bars_dicts)
                fresh_batches.append(label)
                for v in result.violations:
                    warnings.append(_violation_to_warning(v, label))

        # 5. Today handling (separate from past — memory only, tri-state).
        if too >= today_d:
            state, today_bar = cache.get_today(code)
            if state == "hit":
                loaded_bars.append(today_bar)  # type: ignore[arg-type]
                cached_batches.append(f"{today_s}__{today_s}")
            elif state == "negative":
                pass  # known non-trading day; skip KIS, no row
            else:  # miss
                today_label = f"{today_s}__{today_s}"
                try:
                    result = await kis.fetch_past_daily_candles(code, today_s, today_s)
                    if result.candles:
                        today_bar = _candle_to_dict(result.candles[0])
                        cache.store_today(code, today_bar)
                        loaded_bars.append(today_bar)
                        fresh_batches.append(today_label)
                    else:
                        # Non-trading day — negative cache, still record the
                        # fetch in fresh_batches for parity with gap-branch
                        # (B3b: operator visibility for KIS round-trip).
                        cache.store_today(code, None)
                        fresh_batches.append(today_label)
                    for v in result.violations:
                        warnings.append(_violation_to_warning(v, today_label))
                except KisRateLimitError as e:
                    warnings.append(_kis_error_to_warning("kis_rate_limit", str(e), today_label))
                except KisApiError as e:
                    warnings.append(_kis_error_to_warning("kis_api_error", e.msg_cd, today_label))

        # 6. Dedupe by t_ms, sort, filter to [frm, too].
        from datetime import time as _time
        frm_ms = int(datetime.combine(frm, _time(0, 0), tzinfo=_KST).timestamp() * 1000)
        too_ms = int(datetime.combine(too, _time(23, 59, 59), tzinfo=_KST).timestamp() * 1000)
        by_ts: dict[int, dict] = {}
        for bar in loaded_bars:
            ts = bar.get("t_ms")
            if isinstance(ts, int):
                by_ts[ts] = bar
        candles_all = sorted(
            (b for ts, b in by_ts.items() if frm_ms <= ts <= too_ms),
            key=lambda b: b["t_ms"],
        )

        return {
            "code": code,
            "from": from_s,
            "to": to_s,
            "candles": candles_all,
            "cached_batches": cached_batches,
            "fresh_batches": fresh_batches,
            "data_warnings": warnings,
        }

    return router
