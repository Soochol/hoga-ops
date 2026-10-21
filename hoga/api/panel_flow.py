"""Batch flow for the two right-rail lists; no vendor calls or new subscriptions.

One series per unique Code is reused by every membership. JSONL reads use the
existing bounded incremental tail cache, and work runs in the wide compute pool.
Unlike the older board glyph, missing buckets keep their position on the axis.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import math
import time
from collections import OrderedDict
from pathlib import Path
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Query
from pydantic import BaseModel

from hoga.api import calendar, compute_jobs, heatmap, symbols, watchlist
from hoga.api.compute_pools import ComputePools
from hoga.api.heatmap_group_flow import BUCKET_MS, _kst_ms, _read_candle_closes
from hoga.live.index_sector_rankings import _load_prev_closes
from hoga.live.stock_sessions import krx_aftermarket_introduced

PanelFlowSource = Literal["watchlist", "heatmap"]
_KST = ZoneInfo("Asia/Seoul")
_CACHE_MS = 30_000
_CACHE_MAX = 32


class PanelStockFlow(BaseModel):
    code: str
    venue: str
    pct: list[float | None]
    last_observed_ms: int | None
    missing_reason: str | None


class PanelGroupFlow(BaseModel):
    folder_id: str
    pct: list[float | None]
    counts: list[int]
    total: int


class PanelFlowResponse(BaseModel):
    date: str
    venue: str
    bucket_ms: int
    t_base_ms: int
    as_of_ms: int
    stocks: list[PanelStockFlow]
    groups: list[PanelGroupFlow]


def _members(data_dir: Path, source: PanelFlowSource) -> dict[str, list[str]]:
    if source == "watchlist":
        doc = watchlist.load_document(data_dir)
        return {f.id: list(dict.fromkeys(f.code_members())) for f in doc.folders}
    doc = heatmap.load_document(data_dir)
    groups: dict[str, list[str]] = {f.id: [] for f in doc.folders}
    for entry in doc.entries:
        if entry.folder_id in groups:
            groups[entry.folder_id].append(entry.code)
    return {key: list(dict.fromkeys(codes)) for key, codes in groups.items()}


def build_panel_flow(
    data_dir: Path, basis: dt.date, now_ms: int, source: PanelFlowSource, venue: str,
    nxt_enabled: dict[str, bool | None] | None,
) -> PanelFlowResponse:
    members = _members(data_dir, source)
    codes = list(dict.fromkeys(code for group in members.values() for code in group))
    domestic = [code for code in codes if not code.startswith("us-stock:")]
    daily = data_dir / "screener" / "daily_adjusted.parquet"
    baselines = _load_prev_closes(daily, domestic, basis) if domestic and daily.exists() else {}
    opening = _kst_ms(basis, dt.time(9 if venue == "KRX" else 8))
    extended = venue != "KRX" or krx_aftermarket_introduced(basis.strftime("%Y%m%d"))
    closing = _kst_ms(basis, dt.time(20) if extended else dt.time(15, 30))
    size = (closing - opening) // BUCKET_MS
    root = data_dir / "live_kiwoom" / basis.strftime("%Y%m%d")
    krx_open = _kst_ms(basis, dt.time(9))
    krx_close = _kst_ms(basis, dt.time(15, 30))
    krx_reopen = _kst_ms(basis, dt.time(16))
    stocks: dict[str, PanelStockFlow] = {}
    for code in codes:
        effective = "KRX" if venue == "UN" and nxt_enabled is not None and nxt_enabled.get(code) is False else venue
        pct: list[float | None] = [None] * size
        baseline = baselines.get(code)
        unsupported = code.startswith("us-stock:")
        if baseline is not None and (not math.isfinite(baseline) or baseline <= 0):
            baseline = None
        closes = [] if unsupported or baseline is None else _read_candle_closes(root / effective / f"{code}.jsonl")
        last = None
        for t_ms, close in closes:
            if not opening <= t_ms <= min(closing, now_ms) or not math.isfinite(close):
                continue
            # No carry across the KRX break, or across an unobserved bucket.
            if effective == "KRX" and (t_ms < krx_open or krx_close < t_ms < krx_reopen):
                continue
            index = min((t_ms - opening) // BUCKET_MS, size - 1)
            pct[index] = round((close / baseline - 1) * 100, 4)
            last = t_ms
        reason = None
        if unsupported:
            reason = "unsupported_market"
        elif baseline is None:
            reason = "no_baseline"
        elif last is None:
            reason = "no_candles"
        stocks[code] = PanelStockFlow(code=code, venue=effective, pct=pct, last_observed_ms=last, missing_reason=reason)
    groups = []
    for folder_id, group_codes in members.items():
        sums = [0.0] * size
        counts = [0] * size
        for code in group_codes:
            for i, value in enumerate(stocks[code].pct):
                if value is not None:
                    sums[i] += value
                    counts[i] += 1
        groups.append(PanelGroupFlow(folder_id=folder_id, total=len(group_codes), counts=counts,
            pct=[round(value / count, 4) if count else None for value, count in zip(sums, counts, strict=True)]))
    return PanelFlowResponse(date=basis.isoformat(), venue=venue, bucket_ms=BUCKET_MS,
        t_base_ms=opening, as_of_ms=now_ms, stocks=list(stocks.values()), groups=groups)


def build_router(*, data_dir: Path, compute: ComputePools) -> APIRouter:
    router = APIRouter(prefix="/api/panel-flow", tags=["panel-flow"])
    # Router-local, bounded cache; document revision prevents stale group averages
    # after local or remote edits, even within the burst-coalescing window.
    cache: OrderedDict[tuple, tuple[int, PanelFlowResponse]] = OrderedDict()
    lock = asyncio.Lock()

    @router.get("", response_model=PanelFlowResponse)
    async def get_panel_flow(
        source: PanelFlowSource,
        venue: str = Query(default="KRX", pattern="^(KRX|NXT|UN)$"),
    ) -> PanelFlowResponse:
        now = dt.datetime.now(_KST)
        basis = now.date()
        for _ in range(14):
            if calendar.is_trading_day(basis.strftime("%Y%m%d")) is not False:
                break
            basis -= dt.timedelta(days=1)
        path = data_dir / f"{source}.json"
        try:
            stat = path.stat()
            revision = (stat.st_ino, stat.st_mtime_ns, stat.st_size)
        except FileNotFoundError:
            revision = None
        nxt = symbols.nxt_enabled_by_code()
        nxt_key = tuple(sorted(nxt.items())) if nxt is not None and venue == "UN" else None
        key = (source, venue, basis, revision, nxt_key)
        async with lock:
            now_ms = int(time.time() * 1000)
            cached = cache.get(key)
            if cached is not None and now_ms - cached[0] < _CACHE_MS:
                cache.move_to_end(key)
                return cached[1]
            response = await compute_jobs.run_job(compute.wide, compute_jobs.panel_flow_job,
                str(data_dir), basis, now_ms, source, venue, nxt)
            cache[key] = (now_ms, response)
            cache.move_to_end(key)
            while len(cache) > _CACHE_MAX:
                cache.popitem(last=False)
            return response

    return router
