"""Current market ranks are external predicates, independent of the scan universe."""
from __future__ import annotations

import asyncio
import datetime as dt
import math
from dataclasses import dataclass

import httpx
from fastapi import HTTPException

from hoga.api import trading_days
from hoga.api.models import ChangePctRankMatch, ScreenerOccurrence, TradeValueRankMatch
from hoga.api.screener_bar_policy import RANK_TYPES
from hoga.api.screener_exclusions import condition_key
from hoga.api.screener_expression import active_conditions
from hoga.live import settings
from hoga.live.kiwoom_rankings import KiwoomRankingsError
from hoga.util.timeenc import KST

MAX_AGE_MS = 30_000


@dataclass(frozen=True)
class RankEvaluation:
    events: dict[str, list[tuple[str, ScreenerOccurrence]]]
    fetched_at_ms: int
    earliest_at_ms: int | None = None


def _error(status, code, message):
    return HTTPException(status, {"code": f"screener_rank_{code}", "message": message})


def leaves(req):
    return [leaf for leaf in active_conditions(req.conditions, req.expression) if leaf.type in RANK_TYPES]


async def _fetch(market, venue, limit):
    return await _fetch_kind("value", market, venue, limit)


async def _fetch_change(market, venue, limit):
    return await _fetch_kind("change", market, venue, limit)


async def _fetch_kind(kind, market, venue, limit):
    # The ranking drawer owns this process singleton; reuse its cache and governor.
    from hoga.live import api  # noqa: PLC0415 — avoid API/router import cycle

    fetcher = api.kiwoom_rankings_fetcher_instance
    if fetcher is None:
        raise _error(503, "not_wired", "시장 순위 조회에 필요한 키움 API가 설정되지 않았습니다")
    return await fetcher.get(kind, market, "up", venue, limit=limit)


async def evaluate(data_dir, req, now, codes):
    selected = leaves(req)
    if not selected:
        return None
    now = now.astimezone(KST) if now.tzinfo else now.replace(tzinfo=KST)
    trading = trading_days.is_trading_day(now.strftime("%Y%m%d"), data_dir)
    opening = dt.time(9) if req.venue == "KRX" else dt.time(8)
    if trading is not True or now.time() < opening:
        raise _error(409, "session_unavailable", "당일 시장 순위는 거래일 개장 이후에 조회할 수 있습니다")
    if settings.rest_bypass_enabled(data_dir):
        raise _error(409, "rest_bypassed", "REST 조회가 중지되어 당일 시장 순위를 확인할 수 없습니다")
    markets = set(req.universe.markets)
    market = "kospi" if markets == {"KOSPI"} else "kosdaq" if markets == {"KOSDAQ"} else "all"
    groups = [[leaf for leaf in selected if leaf.type == kind] for kind in sorted(RANK_TYPES)]
    results = await asyncio.gather(*(
        _evaluate_kind(req, now, codes, market, opening, group) for group in groups if group
    ))
    return RankEvaluation(
        {identity: events for result in results for identity, events in result.events.items()},
        max(result.fetched_at_ms for result in results), min(result.fetched_at_ms for result in results),
    )


async def _evaluate_kind(req, now, codes, market, opening, selected):
    is_value = selected[0].type == "trade_value_rank"
    label, kind = ("거래대금", "value") if is_value else ("등락률", "change")
    try:
        fetch = _fetch if is_value else _fetch_change
        snapshot = await fetch(market, req.venue, max(leaf.params.top_n for leaf in selected))
    except (KiwoomRankingsError, httpx.HTTPError) as exc:
        raise _error(502, "upstream_failed", f"키움 {label} 순위 조회에 실패했습니다. 다시 조회해 주세요") from exc
    fetched = dt.datetime.fromtimestamp(snapshot.fetched_at_ms / 1000, KST)
    age = int(now.timestamp() * 1000) - snapshot.fetched_at_ms
    if (snapshot.kind != kind or snapshot.direction != "up" or snapshot.market != market
            or snapshot.venue != req.venue or fetched.date() != now.date()
            or fetched.time() < opening or not -MAX_AGE_MS <= age <= MAX_AGE_MS):
        raise _error(502, "snapshot_unverified",
                     f"당일 {label} 순위의 기준 시각·시장을 확인할 수 없습니다. 다시 조회해 주세요")
    if is_value and any(row.provider_rank is None or row.provider_rank < 1 for row in snapshot.rows):
        raise _error(502, "invalid_rank", "키움 거래대금 순위 응답에 현재순위가 없습니다")
    if not is_value and any(row.rank < 1 or row.change_pct is None or not math.isfinite(row.change_pct)
                            for row in snapshot.rows):
        raise _error(502, "invalid_rank", "키움 등락률 순위 응답에 유효한 순위·등락률이 없습니다")
    universe = set(codes)
    events = {
        leaf.id: [
            (row.code, ScreenerOccurrence(
                condition_id=leaf.id, condition_key=condition_key(leaf, calculation_policy=req.calculation_policy),
                date=now.date().isoformat(),
                **_evidence(row, is_value, snapshot),
            ))
            for row in snapshot.rows if row.code in universe
            and (row.provider_rank if is_value else row.rank) <= leaf.params.top_n
        ]
        for leaf in selected
    }
    return RankEvaluation(events, snapshot.fetched_at_ms)


def _evidence(row, is_value, snapshot):
    common = dict(market=snapshot.market, venue=snapshot.venue, fetched_at_ms=snapshot.fetched_at_ms)
    if is_value:
        return {"trade_value_rank_match": TradeValueRankMatch(
            rank=row.provider_rank, trade_value_won=row.trade_value_won, **common)}
    # ka10027 has no rank field. Keep its response position BEFORE any scope/ETF filtering.
    return {"change_pct_rank_match": ChangePctRankMatch(rank=row.rank, change_pct=row.change_pct, **common)}


def with_basis(response, req, evaluation):
    if evaluation is None:
        return response
    timestamps = [evaluation.fetched_at_ms, evaluation.earliest_at_ms or evaluation.fetched_at_ms]
    if len(leaves(req)) != len(active_conditions(req.conditions, req.expression)):
        timestamps.extend(value for value in (response.basis_at_ms, response.fallback_basis_at_ms) if value is not None)
    response.basis_at_ms = max(timestamps)
    response.fallback_basis_at_ms = min(timestamps) if min(timestamps) < max(timestamps) else None
    return response
