"""Current market ranks are external predicates, independent of the scan universe."""
from __future__ import annotations

import asyncio
import datetime as dt
import math
from dataclasses import dataclass

import httpx
from fastapi import HTTPException

from hoga.api.models import ChangePctRankMatch, ScreenerOccurrence, TradeValueRankMatch
from hoga.api.screener_bar_policy import RANK_TYPES
from hoga.api.screener_daily_confirmation import FINALIZATION_HOUR
from hoga.api.screener_exclusions import condition_key
from hoga.api.screener_expression import active_conditions, parse_expression
from hoga.live import settings
from hoga.live.kiwoom_rankings import KiwoomRankingsError
from hoga.live.ranking_session import RankingBasis, resolve as ranking_session
from hoga.util.timeenc import KST

MAX_AGE_MS = 30_000


@dataclass(frozen=True)
class RankEvaluation:
    events: dict[str, list[tuple[str, ScreenerOccurrence]]]
    fetched_at_ms: int
    earliest_at_ms: int | None = None
    basis: RankingBasis | None = None

    @property
    def cutoff(self):
        return dt.datetime.fromtimestamp((self.earliest_at_ms or self.fetched_at_ms) / 1000, KST)

    @property
    def stored(self):
        return self.basis is not None and self.basis.source == "stored"


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
    session = ranking_session(now, req.venue, data_dir)
    opening = dt.time(9) if req.venue == "KRX" else dt.time(8)
    if session.date is None:
        raise _error(409, "calendar_unavailable", "거래일 달력을 확인할 수 없습니다. 달력 갱신이 필요합니다.")
    if session.can_fetch and settings.rest_bypass_enabled(data_dir):
        raise _error(409, "rest_bypassed", "REST 조회가 중지되어 당일 시장 순위를 확인할 수 없습니다")
    markets = set(req.universe.markets)
    market = "kospi" if markets == {"KOSPI"} else "kosdaq" if markets == {"KOSDAQ"} else "all"
    groups = [[leaf for leaf in selected if leaf.type == kind] for kind in sorted(RANK_TYPES)]
    results = await asyncio.gather(*(
        _evaluate_kind(data_dir, req, now, codes, market, opening, group, session) for group in groups if group
    ))
    return RankEvaluation(
        {identity: events for result in results for identity, events in result.events.items()},
        max(result.fetched_at_ms for result in results), min(result.fetched_at_ms for result in results),
        min(results, key=lambda result: result.fetched_at_ms).basis,
    )


async def _evaluate_kind(data_dir, req, now, codes, market, opening, selected, session):
    is_value = selected[0].type == "trade_value_rank"
    label, kind = ("거래대금", "value") if is_value else ("등락률", "change")
    try:
        limit = max(leaf.params.top_n for leaf in selected)
        if session.can_fetch:
            fetch = _fetch if is_value else _fetch_change
            snapshot = await fetch(market, req.venue, limit)
        else:
            from hoga.live import ranking_history  # noqa: PLC0415 — dataclass module imports API calendar

            snapshot = await asyncio.to_thread(
                ranking_history.load, data_dir, session, kind, market, "up", req.venue, limit)
            if snapshot is None:
                raise _error(409, "history_unavailable",
                             "최근 거래일의 저장된 순위가 없습니다. 거래일에 순위를 조회한 뒤 다시 검색하세요.")
    except (KiwoomRankingsError, httpx.HTTPError) as exc:
        raise _error(502, "upstream_failed", f"키움 {label} 순위 조회에 실패했습니다. 다시 조회해 주세요") from exc
    fetched = dt.datetime.fromtimestamp(snapshot.fetched_at_ms / 1000, KST)
    age = int(now.timestamp() * 1000) - snapshot.fetched_at_ms
    basis = snapshot.basis
    if basis is not None and basis.source == "unavailable":
        raise _error(409, "history_unavailable", basis.message or "최근 거래일의 저장된 순위가 없습니다.")
    stored = basis is not None and basis.source == "stored"
    if (snapshot.kind != kind or snapshot.direction != "up" or snapshot.market != market
            or snapshot.venue != req.venue or fetched.date() != session.date
            or fetched.time() < opening or (not stored and not -MAX_AGE_MS <= age <= MAX_AGE_MS)
            or (stored and (session.can_fetch or basis.trading_date != session.date.isoformat()
                            or basis.observed_at_ms != snapshot.fetched_at_ms))
            or (not session.can_fetch and not stored)):
        raise _error(502, "snapshot_unverified",
                     f"당일 {label} 순위의 기준 시각·시장을 확인할 수 없습니다. 다시 조회해 주세요")
    if is_value and any(row.provider_rank is None or row.provider_rank < 1 for row in snapshot.rows):
        raise _error(502, "invalid_rank", "키움 거래대금 순위 응답에 현재순위가 없습니다")
    if not is_value and any(row.rank < 1 or row.change_pct is None or not math.isfinite(row.change_pct)
                            for row in snapshot.rows):
        raise _error(502, "invalid_rank", "키움 등락률 순위 응답에 유효한 순위·등락률이 없습니다")
    universe = set(codes or [])
    events = {
        leaf.id: [
            (row.code, ScreenerOccurrence(
                condition_id=leaf.id, condition_key=condition_key(leaf, calculation_policy=req.calculation_policy),
                date=session.date.isoformat(),
                **_evidence(row, is_value, snapshot),
            ))
            for row in snapshot.rows if (codes is None or row.code in universe)
            and (row.provider_rank if is_value else row.rank) <= leaf.params.top_n
        ]
        for leaf in selected
    }
    return RankEvaluation(events, snapshot.fetched_at_ms, basis=basis)


def candidate_codes(req, codes, evaluation):
    """Ranks can narrow an AND branch; unknown predicates remain the full universe."""
    if evaluation is None:
        return codes
    universe, stack = set(codes), []
    for token in parse_expression(req.expression, len(req.conditions)):
        if isinstance(token, int):
            leaf = req.conditions[token]
            stack.append({code for code, _ in evaluation.events[leaf.id]} & universe
                         if leaf.id in evaluation.events else universe)
        else:
            right, left = stack.pop(), stack.pop()
            stack.append(left & right if token == "AND" else left | right)
    return [code for code in codes if code in stack[0]] if stack else codes


def validate_stored_conditions(req, evaluation):
    if evaluation is None or not evaluation.stored:
        return
    selected = active_conditions(req.conditions, req.expression)
    if any(getattr(leaf.params, "end_date", "") > evaluation.cutoff.date().isoformat() for leaf in selected):
        raise _error(409, "history_range_after_basis",
                     "조건의 종료일이 저장된 순위 기준일보다 늦어 평가할 수 없습니다.")
    if any(leaf.type not in RANK_TYPES and not getattr(leaf.params, "timeframe", "D").endswith("m")
           for leaf in selected):
        if evaluation.cutoff.time() < dt.time(FINALIZATION_HOUR):
            raise _error(409, "daily_history_unavailable",
                         "저장된 순위가 일봉 확정 전 관측입니다. 같은 시각의 일봉·호가 자료가 없어 평가할 수 없습니다.")
        if any("depth" in leaf.type for leaf in selected):
            raise _error(409, "depth_history_unavailable",
                         "저장된 순위와 같은 기준일의 호가 조건 조회는 지원하지 않습니다.")


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
    response.rank_basis = evaluation.basis
    if evaluation.stored:
        response.basis_at_ms = evaluation.earliest_at_ms or evaluation.fetched_at_ms
        response.fallback_basis_at_ms = None
        return response
    response.basis_at_ms = max(timestamps)
    response.fallback_basis_at_ms = min(timestamps) if min(timestamps) < max(timestamps) else None
    return response
