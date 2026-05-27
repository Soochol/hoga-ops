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

from .buffer import LiveBuffer
from .lifecycle import LiveStatus

if TYPE_CHECKING:
    from .kis_client import KisClient

ControlAction = Literal["start", "stop", "pause"]

_PAST_MAX_DAYS = 60
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
                    bars = cache.get_today(code)
                    if bars is None:
                        raw = await kis.fetch_past_minute_candles(code, date_s)
                        bars = [_candle_to_dict(c) for c in raw]
                        cache.store_today(code, bars)  # memory only — no OSError path
                        fresh_dates.append(date_s)
                    else:
                        cached_dates.append(date_s)
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

    return router
