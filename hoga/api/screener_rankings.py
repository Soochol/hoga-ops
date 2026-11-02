"""Current market ranks are external predicates, independent of the scan universe."""
from __future__ import annotations

import asyncio
import datetime as dt
import math
import time
from dataclasses import dataclass

import httpx
from fastapi import HTTPException

from hoga.api.models import ChangePctRankMatch, MarketRankMatch, ScreenerOccurrence, TradeValueRankMatch
from hoga.api.read_shutdown import ReadOperation, run_read_sync
from hoga.api.screener_bar_policy import RANK_TYPES
from hoga.api.screener_daily_confirmation import FINALIZATION_HOUR
from hoga.api.screener_exclusions import condition_key
from hoga.api.screener_expression import active_conditions, parse_expression
from hoga.live import settings
from hoga.live.kiwoom_rankings import KiwoomRankingsError
from hoga.live.kiwoom_rankings_access import rankings_fetcher
from hoga.live.ranking_session import RankingBasis, resolve as ranking_session
from hoga.util.timeenc import KST

MAX_AGE_MS = 30_000
PROVIDER_MAX_AGE_MS = 90_000  # Shared last-ranking cache: 60 seconds, plus request allowance.
_SPECS = {
    "trade_value_rank": ("value", "거래대금"),
    "change_pct_rank": ("change", "등락률"),
    "volume_surge_rank": ("surge", "거래량 급증"),
    "volume_rank": ("volume", "거래량"),
    "program_net_buy_rank": ("program", "프로그램 순매수금액"),
    "institution_net_buy_rank": ("institution", "기관 추정 순매수금액"),
    "foreign_net_buy_rank": ("foreign", "외국인 추정 순매수금액"),
}
_INVESTORS = {"institution", "foreign"}


def _direction(leaf):
    return getattr(leaf.params, "direction", "up")


@dataclass(frozen=True)
class RankEvaluation:
    events: dict[str, list[tuple[str, ScreenerOccurrence]]]
    fetched_at_ms: int
    earliest_at_ms: int | None = None
    basis: RankingBasis | None = None
    evaluation_at_ms: int | None = None

    @property
    def cutoff(self):
        return dt.datetime.fromtimestamp(
            (self.evaluation_at_ms or self.earliest_at_ms or self.fetched_at_ms) / 1000, KST)

    @property
    def stored(self):
        return self.basis is not None and self.basis.source == "stored"

    @property
    def historical(self):
        return self.stored or self.evaluation_at_ms is not None


def _error(status, code, message):
    return HTTPException(status, {"code": f"screener_rank_{code}", "message": message})


def leaves(req):
    return [leaf for leaf in active_conditions(req.conditions, req.expression) if leaf.type in RANK_TYPES]


async def _fetch(market, venue, limit):
    return await _fetch_kind("value", market, venue, limit)


async def _fetch_change(market, venue, limit):
    return await _fetch_kind("change", market, venue, limit)


async def _fetch_kind(kind, market, venue, limit, direction="up", *, allow_last_available=False):
    # The live composition root supplies the same singleton used by the drawer.
    fetcher = rankings_fetcher()
    if fetcher is None:
        raise _error(503, "not_wired", "시장 순위 조회에 필요한 키움 API가 설정되지 않았습니다")
    return await fetcher.get(kind, market, direction, venue, limit=limit, allow_last_available=allow_last_available)


async def evaluate(data_dir, req, now, codes, operation: ReadOperation | None = None):
    selected = leaves(req)
    if not selected:
        return None
    now = now.astimezone(KST) if now.tzinfo else now.replace(tzinfo=KST)
    session_venue = "KRX" if all(_SPECS[leaf.type][0] in _INVESTORS for leaf in selected) else req.venue
    session = ranking_session(now, session_venue, data_dir)
    if session.date is None:
        raise _error(409, "calendar_unavailable", "거래일 달력을 확인할 수 없습니다. 달력 갱신이 필요합니다.")
    if session.can_fetch and settings.rest_bypass_enabled(data_dir):
        raise _error(409, "rest_bypassed", "REST 조회가 중지되어 당일 시장 순위를 확인할 수 없습니다")
    markets = set(req.universe.markets)
    market = "kospi" if markets == {"KOSPI"} else "kosdaq" if markets == {"KOSDAQ"} else "all"
    identities = sorted({(leaf.type, _direction(leaf)) for leaf in selected})
    groups = [[leaf for leaf in selected if (leaf.type, _direction(leaf)) == identity] for identity in identities]
    results = await asyncio.gather(*(
        _evaluate_kind(data_dir, req, now, codes, market, group, session,
            operation=operation) for group in groups if group
    ))
    provider = next((result for result in results if result.basis and result.basis.source == "provider"), None)
    # A mixed stored/provider scan has no common observation time. Its other
    # predicates explicitly use the last completed day, independent of receipts.
    return RankEvaluation(
        {identity: events for result in results for identity, events in result.events.items()},
        max(result.fetched_at_ms for result in results), min(result.fetched_at_ms for result in results),
        provider.basis if provider else min(results, key=lambda result: result.fetched_at_ms).basis,
        provider.evaluation_at_ms if provider else None,
    )


async def _read_snapshot(data_dir, req, session, market, selected, operation: ReadOperation | None = None):
    kind, label = _SPECS[selected[0].type]
    direction = _direction(selected[0])
    limit = max(leaf.params.top_n for leaf in selected)
    if not session.can_fetch:
        from hoga.live import ranking_history  # noqa: PLC0415 — avoid dataclass import cycle

        snapshot = await run_read_sync(operation,
            ranking_history.load, data_dir, session, kind, market, direction, req.venue, limit)
        if snapshot is not None:
            return snapshot
        if settings.rest_bypass_enabled(data_dir):
            raise _error(409, "rest_bypassed", "REST 조회가 중지되어 마지막 시장 순위를 확인할 수 없습니다")
    try:
        if not session.can_fetch:
            return await _fetch_kind(kind, market, req.venue, limit, direction, allow_last_available=True)
        if kind == "value":
            return await _fetch(market, req.venue, limit)
        if kind == "change" and direction == "up":
            return await _fetch_change(market, req.venue, limit)
        return await _fetch_kind(kind, market, req.venue, limit, direction)
    except (KiwoomRankingsError, httpx.HTTPError) as exc:
        raise _error(502, "upstream_failed", f"키움 {label} 순위 조회에 실패했습니다. 다시 조회해 주세요") from exc


def _validate_snapshot(snapshot, req, now, market, selected, session):
    kind, label = _SPECS[selected[0].type]
    fetched = dt.datetime.fromtimestamp(snapshot.fetched_at_ms / 1000, KST)
    age = int(now.timestamp() * 1000) - snapshot.fetched_at_ms
    basis = snapshot.basis
    if basis is not None and basis.source == "unavailable":
        raise _error(409, "history_unavailable", basis.message or "최근 거래일의 저장된 순위가 없습니다.")
    stored = basis is not None and basis.source == "stored"
    provider = basis is not None and basis.source == "provider"
    venue_matches = ((snapshot.venue is None and snapshot.quote_venue == req.venue) if kind in _INVESTORS
                     else snapshot.venue == req.venue)
    opening = dt.time(9) if req.venue == "KRX" or kind in _INVESTORS else dt.time(8)
    invalid_time = (session.can_fetch or basis.session != session.state
                    or basis.trading_date is not None or basis.observed_at_ms is not None
                    or fetched.date() != now.date() or not -MAX_AGE_MS <= age <= PROVIDER_MAX_AGE_MS
                   ) if provider else (fetched.date() != session.date or fetched.time() < opening
                                        or (not stored and not -MAX_AGE_MS <= age <= MAX_AGE_MS))
    if (snapshot.kind != kind or snapshot.direction != _direction(selected[0]) or snapshot.market != market
            or not venue_matches or invalid_time
            or (stored and (session.can_fetch or basis.trading_date != session.date.isoformat()
                            or basis.observed_at_ms != snapshot.fetched_at_ms))
            or (not session.can_fetch and not (stored or provider))):
        raise _error(502, "snapshot_unverified", f"{label} 순위의 기준 시각·시장을 확인할 수 없습니다.")
    for row in snapshot.rows:
        rank = row.provider_rank if kind == "value" else row.rank
        metric = {"change": row.change_pct, "surge": row.volume_surge_pct, "volume": row.volume,
                  "program": row.program_net_buy_won, "institution": row.investor_net_buy_won,
                  "foreign": row.investor_net_buy_won}.get(kind)
        if rank is None or rank < 1 or (kind != "value" and (metric is None or not math.isfinite(metric))):
            raise _error(502, "invalid_rank", f"키움 {label} 응답에 유효한 순위·값이 없습니다")
        if kind in {"volume", "program", "institution", "foreign"} and (
            not isinstance(metric, int) or isinstance(metric, bool) or metric < (0 if kind == "volume" else 1)
        ):
            raise _error(502, "invalid_rank", f"키움 {label} 응답의 수량·금액이 올바르지 않습니다")


async def _evaluate_kind(data_dir, req, now, codes, market, selected, session, operation: ReadOperation | None = None):
    kind, _ = _SPECS[selected[0].type]
    if session.can_fetch and kind in _INVESTORS and now.time() < dt.time(9):
        raise _error(409, "session_unavailable", "기관·외국인 추정 순위는 정규장 개장 이후 조회할 수 있습니다.")
    started = time.monotonic()
    snapshot = await _read_snapshot(data_dir, req, session, market, selected, operation=operation)
    _validate_snapshot(snapshot, req, now + dt.timedelta(seconds=time.monotonic() - started), market, selected, session)
    universe = set(codes or [])
    events = {
        leaf.id: [
            (row.code, ScreenerOccurrence(
                condition_id=leaf.id, condition_key=condition_key(leaf, calculation_policy=req.calculation_policy),
                date=session.date.isoformat(), **_evidence(row, kind, snapshot),
            ))
            for row in snapshot.rows if (codes is None or row.code in universe)
            and (row.provider_rank if kind == "value" else row.rank) <= leaf.params.top_n
        ] for leaf in selected
    }
    basis, evaluation_at_ms = snapshot.basis, None
    if basis is not None and basis.source == "provider":
        evaluation_at_ms = int(dt.datetime.combine(session.date, dt.time(23, 59, 59, 999000), KST).timestamp() * 1000)
        basis = basis.model_copy(update={"message":
            f"순위 거래일 미확인 · 다른 조건은 {session.date.isoformat()} 완료 데이터 기준입니다. "
            "순위와 같은 시각의 관측을 뜻하지 않습니다."})
    return RankEvaluation(events, snapshot.fetched_at_ms, basis=basis, evaluation_at_ms=evaluation_at_ms)


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
    if evaluation is None or not evaluation.historical:
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


def _evidence(row, kind, snapshot):
    common = dict(market=snapshot.market, venue=snapshot.venue, fetched_at_ms=snapshot.fetched_at_ms,
                  basis=snapshot.basis)
    if kind == "value":
        return {"trade_value_rank_match": TradeValueRankMatch(
            rank=row.provider_rank, trade_value_won=row.trade_value_won, **common)}
    if kind == "change":
        return {"change_pct_rank_match": ChangePctRankMatch(
            rank=row.rank, change_pct=row.change_pct, direction=snapshot.direction, **common)}
    return {"market_rank_match": MarketRankMatch(
        kind=kind, rank=row.rank, quote_venue=snapshot.quote_venue,
        volume_surge_pct=row.volume_surge_pct if kind == "surge" else None,
        volume=row.volume if kind == "volume" else None,
        net_buy_won=(row.program_net_buy_won if kind == "program" else row.investor_net_buy_won)
        if kind in {"program", "institution", "foreign"} else None, **common)}


def with_basis(response, req, evaluation):
    if evaluation is None:
        return response
    timestamps = [evaluation.fetched_at_ms, evaluation.earliest_at_ms or evaluation.fetched_at_ms]
    if len(leaves(req)) != len(active_conditions(req.conditions, req.expression)):
        timestamps.extend(value for value in (response.basis_at_ms, response.fallback_basis_at_ms) if value is not None)
    response.rank_basis = evaluation.basis
    if evaluation.historical:
        response.basis_at_ms = int(evaluation.cutoff.timestamp() * 1000)
        response.fallback_basis_at_ms = None
        return response
    response.basis_at_ms = max(timestamps)
    response.fallback_basis_at_ms = min(timestamps) if min(timestamps) < max(timestamps) else None
    return response
