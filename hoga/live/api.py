"""FastAPI router for Live Capture endpoints (spec §6)."""
from __future__ import annotations

import logging
import re
from collections.abc import Awaitable
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from hoga.api.params import CODE_PATTERN
from hoga.live.kis_client import KisApiError, KisRateLimitError
from hoga.live.past_candles_cache import PastCandlesCache
from hoga.live.past_daily_candles_cache import PastDailyCandlesCache

from . import kis_runtime
from . import lifecycle
from .buffer import LiveBuffer
from .lifecycle import LiveStatus

if TYPE_CHECKING:
    from .kis_client import KisClient

ControlAction = Literal["start", "stop", "pause"]

log = logging.getLogger(__name__)

_PAST_MAX_DAYS = 250
_CODE_RE = re.compile(CODE_PATTERN)
_KST = timezone(timedelta(hours=9))

# Rate-limit retry policy lives in ``KisClient._get`` (ADR-0050). Handlers
# here just call ``kis.fetch_*`` directly; a ``KisRateLimitError`` that
# reaches the handler's ``except`` block means the client has already
# exhausted its retries — the right move is then to mark the range
# blocked and surface the warning to the wire.


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


class LiveQuotesResponse(BaseModel):
    phase: Literal["pre_open", "open"]
    quotes: list[LiveQuote]


def _quote_phase(now: datetime) -> Literal["pre_open", "open"]:
    """/quotes 오버레이의 등락률 표시 게이트: 장전(09:00 이전)=숨김, 09:00 이후=표시.
    경계 하나로 충분(반장도 오픈 09:00 동일; 주말 이른 아침은 잠깐 숨김 — 무해).
    poller._market_phase(16:00-aware 3-way 세션 phase)와 계약이 달라 이름을 분리한다."""
    return "pre_open" if now.time() < time(9, 0) else "open"


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

    @router.get("/quotes", response_model=LiveQuotesResponse)
    async def _get_quotes(codes: str = Query(...)) -> LiveQuotesResponse:
        phase = _quote_phase(datetime.now(_KST))
        code_list = [c for c in codes.split(",") if _CODE_RE.match(c)]
        if not code_list:
            return LiveQuotesResponse(phase=phase, quotes=[])
        kis = get_kis_client() if get_kis_client is not None else None
        if kis is None and data_dir is not None:
            # 싱글턴이 아직 없으면(빈 관심목록 + 무갭일 등 흔한 상태) env-creds 로
            # 지연 생성한다 — poller/EOD 업데이트와 같은 단일 리졸버를 공유하므로
            # 15/s 버킷이 1개로 유지된다. creds 없으면 None → graceful empty.
            kis = kis_runtime.ensure_kis_client_from_env(data_dir)
        if kis is None:
            return LiveQuotesResponse(phase=phase, quotes=[])
        try:
            quotes = await kis.fetch_multi_price(code_list)
        except Exception as e:  # noqa: BLE001 — 10초 폴링 오버레이는 절대 500 금지;
            # KIS rate-limit/api-error/네트워크 타임아웃 등 무엇이든 빈 결과로 graceful
            # (프론트는 '—' 표시). retry-exhausted 신호는 warning 으로만 남긴다.
            log.warning("live quotes fetch failed (%d codes): %s", len(code_list), e)
            return LiveQuotesResponse(phase=phase, quotes=[])
        pre = phase == "pre_open"
        return LiveQuotesResponse(phase=phase, quotes=[
            LiveQuote(code=q.code, price=q.price,
                      change_pct=(None if pre else q.change_pct),
                      change_won=(None if pre else q.change_won))
            for q in quotes
        ])

    cache_instance: PastCandlesCache | None = (
        PastCandlesCache(data_dir=data_dir) if data_dir is not None else None
    )
    daily_cache_instance: PastDailyCandlesCache | None = (
        PastDailyCandlesCache() if data_dir is not None else None
    )
    # Investor net-buy reuses the daily candle cache (ADR-0055): same date-cursor
    # walk-back + batch/gap memory cache shape, just storing point dicts.
    investor_cache_instance: PastDailyCandlesCache | None = (
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
        # When KIS rate-limits, stop calling KIS for the rest of the range to
        # avoid hammering the remote — but keep serving cache hits. Skipping
        # cached dates broke the frontend's chart: `past.data.segments`
        # (hogaplay parquet, independent of KIS) kept full coverage while
        # `kisCandles` shrank, leaving the candle pane empty over a wide axis.
        kis_blocked = False

        for date_s in _date_iter(frm, too):
            try:
                if date_s < today_s:
                    bars = cache.get_past(code, date_s)
                    if bars is None:
                        if kis_blocked:
                            warnings.append({"date": date_s, "reason": "rate_limit_aborted", "msg": "previous date hit rate limit"})
                            continue
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
                        if kis_blocked:
                            warnings.append({"date": date_s, "reason": "rate_limit_aborted", "msg": "previous date hit rate limit"})
                            continue
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
                kis_blocked = True
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
        frm, too, today_d = _validate_past_request(code, from_, to, max_days=None)
        if get_kis_client is None:
            raise HTTPException(503, "KIS client not wired")
        kis = get_kis_client()
        if kis is None:
            raise HTTPException(503, "KIS client not initialized")
        if daily_cache_instance is None:
            raise HTTPException(503, "past-daily-candles cache not wired (data_dir missing)")

        async def fetch_batch(code_: str, from_s: str, to_s: str):
            result = await kis.fetch_past_daily_candles(code_, from_s, to_s)
            return [_candle_to_dict(c) for c in result.candles], result.violations

        return await batched_daily_walkback(
            cache=daily_cache_instance, fetch_batch=fetch_batch, output_key="candles",
            code=code, frm=frm, too=too, today_d=today_d,
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
        if get_kis_client is None:
            raise HTTPException(503, "KIS client not wired")
        kis = get_kis_client()
        if kis is None:
            raise HTTPException(503, "KIS client not initialized")
        if investor_cache_instance is None:
            raise HTTPException(503, "past-investor-net cache not wired (data_dir missing)")

        async def fetch_batch(code_: str, from_s: str, to_s: str):
            result = await kis.fetch_investor_net(code_, from_s, to_s)
            return [_investor_point_to_dict(p) for p in result.points], result.violations

        return await batched_daily_walkback(
            cache=investor_cache_instance, fetch_batch=fetch_batch, output_key="points",
            code=code, frm=frm, too=too, today_d=today_d,
        )

    return router
