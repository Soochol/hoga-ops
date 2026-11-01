"""Ranking predicates preserve market ranks through scopes, OR, saves and HTTP."""
import datetime as dt
import json
from dataclasses import replace

import httpx
import polars as pl
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from hoga.api import (
    screener_rankings as ranking,
    screener_runner,
    screener_series_store as store,
    symbols,
    trading_days,
)
from hoga.api.models import ScanRequest, ScreenerExclusionWrite
from hoga.api.screener import build_router
from hoga.api.screener_series_execution import validate_archivable
from hoga.live import kiwoom_rankings, kiwoom_rest_runtime, ranking_history, ranking_session
from hoga.live.kiwoom_rankings import KiwoomRankingsError, KiwoomRankingsFetcher, RankingRow, RankingSnapshot
from hoga.util.timeenc import KST

NOW = dt.datetime(2026, 10, 30, 10, tzinfo=KST)
STAMP = int(NOW.timestamp() * 1000)


def request(top_n=200, rank_type="trade_value_rank", **extra):
    return ScanRequest.model_validate({
        "basis": "eod", "conditions": [{"id": "rank", "type": rank_type, "params": {"top_n": top_n}}],
        "universe": {"exclude_etf": False}, **extra,
    })


def snapshot(**changes):
    return replace(RankingSnapshot(
        kind="value", market="all", direction="up", market_open=True, fetched_at_ms=STAMP,
        rows=tuple(RankingRow(
            rank=i, provider_rank=rank, code=f"{i:06d}", name=str(i), price=100 * i,
            change_pct=1.0, trade_value_won=1_000_000_000 // i,
        ) for i, rank in enumerate((1, 199, 201), 1)),
    ), **changes)


def change_snapshot(**changes):
    snap = snapshot()
    result = replace(snap, kind="change", rows=tuple(
        replace(row, rank=row.provider_rank, provider_rank=None, change_pct=12.34 - i)
        for i, row in enumerate(snap.rows)))
    return replace(result, **changes)


@pytest.fixture
def corpus(tmp_path, monkeypatch):
    monkeypatch.setattr(symbols, "all_etf_etn_codes", lambda: None)
    sd = tmp_path / "screener"
    sd.mkdir()
    codes = ["000001", "000002", "000003"]
    monkeypatch.setattr(trading_days, "trading_days", lambda *_: ["20261029", "20261030"])
    pl.DataFrame({"code": codes, "name": codes, "market": ["KOSPI"] * 3,
                  "is_etf": [True, False, False], "is_halted": [False] * 3}).write_parquet(sd / "stocks.parquet")
    rows = [dict(code=code, date=dt.date(2026, 10, day), open=float(i * 100), high=float(i * 100),
                 low=float(i * 100), close=float(i * 100), volume=10)
            for i, code in enumerate(codes, 1) for day in (29, 30)]
    pl.DataFrame(rows).write_parquet(sd / "daily_adjusted.parquet")
    pl.DataFrame(rows).write_parquet(sd / "daily_unadjusted.parquet")
    (sd / "status.json").write_text(json.dumps(dict(
        last_raw_date="20261030", last_built_ms=1, universe_size=3, derive_ms=0)))
    for code in codes:
        observations = [{**r, "date": r["date"].isoformat()} for r in rows if r["code"] == code]
        store.publish_pair(tmp_path, code, observations, observations, adjusted_as_of="2026-10-30",
                           observed_at=NOW.isoformat(), price_events=[])
    monkeypatch.setattr(trading_days, "is_trading_day", lambda *_: True)
    monkeypatch.setattr(trading_days, "trading_days", lambda *_: ["20261029", "20261030"])
    monkeypatch.setattr(screener_runner, "now_kst", lambda: NOW)

    async def fetch(market, venue, limit):
        return snapshot(market=market, venue=venue)

    async def fetch_change(market, venue, limit):
        return change_snapshot(market=market, venue=venue)

    monkeypatch.setattr(ranking, "_fetch", fetch)
    monkeypatch.setattr(ranking, "_fetch_change", fetch_change)
    return tmp_path


@pytest.mark.parametrize("policy", ["legacy_v1", "separate_bases_v2"])
@pytest.mark.parametrize("rank_type", ["trade_value_rank", "change_pct_rank"])
async def test_rank_200_survives_etf_filter_without_promoting_201(corpus, policy, rank_type):
    result = await screener_runner.run_screener_scan(data_dir=corpus, now=NOW, req=request(
        rank_type=rank_type, calculation_policy=policy, universe={"exclude_etf": True}))
    assert [row.code for row in result.rows] == ["000002"]
    match = getattr(result.rows[0].occurrences[0], f"{rank_type}_match")
    assert match.rank == 199 and match.fetched_at_ms == STAMP
    if rank_type == "trade_value_rank":
        assert match.trade_value_won == 500_000_000
    else:
        assert match.change_pct == 11.34
    assert result.rows[0].occurrences[0].date == "2026-10-30"
    assert result.basis_at_ms == STAMP


@pytest.mark.parametrize("policy", ["legacy_v1", "separate_bases_v2"])
@pytest.mark.parametrize("expression,expected", [("A OR B", ["000001", "000002", "000003"]), ("A AND B", [])])
@pytest.mark.parametrize("rank_type", ["trade_value_rank", "change_pct_rank"])
async def test_rank_is_a_leaf_in_the_expression(corpus, policy, expression, expected, rank_type):
    req = request(rank_type=rank_type, calculation_policy=policy)
    req = ScanRequest.model_validate({**req.model_dump(), "expression": expression, "conditions": [
        req.conditions[0].model_dump(), {"id": "price", "type": "price_range", "params": {"min": 250}},
    ]})
    result = await screener_runner.run_screener_scan(data_dir=corpus, now=NOW, req=req)
    assert sorted(row.code for row in result.rows) == expected, result.model_dump()


@pytest.mark.parametrize("rank_type", ["trade_value_rank", "change_pct_rank"])
async def test_unreferenced_rank_does_not_call_provider(corpus, monkeypatch, rank_type):
    async def fail(*_):
        raise AssertionError("Unreferenced ranking must not fetch")
    monkeypatch.setattr(ranking, "_fetch", fail)
    monkeypatch.setattr(ranking, "_fetch_change", fail)
    req = request(rank_type=rank_type).model_dump()
    req["conditions"].append({"id": "price", "type": "price_range", "params": {"min": 250}})
    req["expression"] = "B"
    result = await screener_runner.run_screener_scan(data_dir=corpus, now=NOW, req=ScanRequest.model_validate(req))
    assert [row.code for row in result.rows] == ["000003"]


async def test_multiple_limits_share_largest_market_request(corpus, monkeypatch):
    calls = []
    async def fetch(*args):
        calls.append(args)
        return snapshot(market="kosdaq", venue="UN")
    monkeypatch.setattr(ranking, "_fetch", fetch)
    req = request(100, venue="UN", universe={"markets": ["KOSDAQ"]}).model_dump()
    req["conditions"].append({"id": "rank2", "type": "trade_value_rank", "params": {"top_n": 200}})
    result = (await ranking.evaluate(corpus, ScanRequest.model_validate(req), NOW, ["000002"])).events
    assert calls == [("kosdaq", "UN", 200)]
    assert result["rank"] == [] and result["rank2"][0][0] == "000002"
    assert result["rank2"][0][1].trade_value_rank_match.rank == 199


@pytest.mark.parametrize("changes", [
    {"fetched_at_ms": STAMP - 86_400_000}, {"fetched_at_ms": STAMP - 31_000}, {"venue": "NXT"},
    {"rows": (RankingRow(rank=1, code="000001", name="test", price=1, change_pct=0),)},
])
async def test_unverified_snapshot_is_an_error(corpus, monkeypatch, changes):
    async def fetch(*_):
        return snapshot(**changes)
    monkeypatch.setattr(ranking, "_fetch", fetch)
    with pytest.raises(HTTPException) as error:
        await ranking.evaluate(corpus, request(), NOW, ["000001"])
    assert error.value.status_code == 502


async def test_undated_panel_rows_are_rejected_even_with_a_current_receipt_time(corpus, monkeypatch):
    async def fetch(*_):
        return snapshot(basis=ranking_session.RankingBasis(session="holiday", source="provider"))
    monkeypatch.setattr(ranking, "_fetch", fetch)
    with pytest.raises(HTTPException) as error:
        await ranking.evaluate(corpus, request(), NOW, ["000001"])
    assert error.value.status_code == 502
    assert error.value.detail["code"] == "screener_rank_snapshot_unverified"


@pytest.mark.parametrize("trading,hour", [(False, 10), (None, 10), (True, 8)])
async def test_closed_or_unknown_day_never_uses_old_ranks(corpus, monkeypatch, trading, hour):
    monkeypatch.setattr(trading_days, "is_trading_day", lambda *_: trading)
    with pytest.raises(HTTPException) as error:
        await ranking.evaluate(corpus, request(), NOW.replace(hour=hour), [])
    assert error.value.status_code == (503 if hour == 8 else 409)


def test_http_scan_and_save_preserve_rank_evidence(corpus):
    app = FastAPI()
    app.include_router(build_router(data_dir=corpus))
    client = TestClient(app)
    req = request().model_dump(mode="json")
    saved = client.post("/api/screener/saves", json={"name": "대금 200위", "conditions": req["conditions"]})
    assert saved.status_code == 201
    assert saved.json()["conditions"][0]["params"] == {"top_n": 200}
    assert client.get(f'/api/screener/saves/{saved.json()["id"]}').json()["conditions"] == req["conditions"]
    response = client.post("/api/screener/scan", json=req)
    assert response.status_code == 200
    evidence = response.json()["rows"][0]["occurrences"][0]["trade_value_rank_match"]
    assert evidence == dict(rank=199, trade_value_won=500_000_000, market="all", venue="KRX",
                            fetched_at_ms=STAMP, basis=None)


def test_provider_failure_is_http_error_instead_of_empty_success(corpus, monkeypatch):
    async def fail(*_):
        raise KiwoomRankingsError("upstream failed")
    monkeypatch.setattr(ranking, "_fetch", fail)
    app = FastAPI()
    app.include_router(build_router(data_dir=corpus))
    response = TestClient(app).post("/api/screener/scan", json=request().model_dump(mode="json"))
    assert response.status_code == 502 and "실패" in response.json()["detail"]["message"]


@pytest.mark.parametrize("value", [0, 5001, 1.5, "200", True])
@pytest.mark.parametrize("rank_type", ["trade_value_rank", "change_pct_rank"])
def test_rank_limit_is_a_bounded_integer(value, rank_type):
    with pytest.raises(ValidationError):
        request(value, rank_type=rank_type)


def test_snapshots_and_replay_do_not_silently_fetch_today():
    with pytest.raises(ValidationError, match="과거 스냅샷"):
        request(calculation_policy="separate_bases_v2", snapshot_id="a" * 64)
    with pytest.raises(ValueError, match="확정"):
        validate_archivable(request(calculation_policy="separate_bases_v2"))


async def test_rank_occurrence_uses_shared_exclusion_store(corpus):
    req = request()
    condition = req.conditions[0]
    # Use the public exclusion store and the real SQL exclusion predicate.
    from hoga.api import screener_exclusions
    await screener_exclusions.put_exclusion(corpus, ScreenerExclusionWrite(
        condition=condition, code="000002", date=NOW.date(), stock_name="test"))
    result = await screener_runner.run_screener_scan(data_dir=corpus, now=NOW, req=req)
    assert [row.code for row in result.rows] == ["000001"]


async def test_200_fetches_two_pages_through_governor(corpus, monkeypatch):
    calls, scheduled = [], []
    class Token:
        def get_token(self):
            return "fake-token"
    class Scheduler:
        async def submit(self, **kwargs):
            scheduled.append(kwargs["api_id"])
            return await kwargs["call"](None)
    scheduler = Scheduler()
    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_scheduler", lambda *_: scheduler)
    monkeypatch.setattr(kiwoom_rankings, "is_trading_day", lambda *_: True)
    monkeypatch.setattr(kiwoom_rankings.time, "time", lambda: NOW.timestamp())
    def handle(req):
        start = int(req.headers["next-key"] or "1")
        calls.append(start)
        return httpx.Response(200, headers={"cont-yn": "Y", "next-key": str(start + 100)}, json={
            "return_code": 0, "trde_prica_upper": [
                {"stk_cd": f"{i:06d}", "stk_nm": str(i), "now_rank": str(i), "trde_prica": "1000"}
                for i in range(start, start + 100)]})
    fetcher = KiwoomRankingsFetcher(Token(), _transport=httpx.MockTransport(handle), _now=lambda: NOW)
    async def fetch(market, venue, limit):
        return await fetcher.get("value", market, "up", venue, limit=limit)
    monkeypatch.setattr(ranking, "_fetch", fetch)
    try:
        result = (await ranking.evaluate(corpus, request(), NOW, ["000150", "000200", "000201"])).events
        assert [code for code, _ in result["rank"]] == ["000150", "000200"]
        assert calls == [1, 101] and scheduled == ["ka10032", "ka10032"]
        await ranking.evaluate(corpus, request(), NOW, ["000150"])
        assert calls == [1, 101]  # shared eight-second snapshot
    finally:
        fetcher.close()


@pytest.mark.parametrize("policy", ["legacy_v1", "separate_bases_v2"])
async def test_two_rank_kinds_share_limits_and_keep_both_observation_times(corpus, monkeypatch, policy):
    calls = []
    async def value(market, venue, limit):
        calls.append(("value", limit))
        return snapshot()
    async def change(market, venue, limit):
        calls.append(("change", limit))
        return change_snapshot(fetched_at_ms=STAMP - 1000)
    async def unexpected_overlay(**_):
        raise AssertionError("Pure rank predicates do not require a full-market OHLCV overlay")
    monkeypatch.setattr(ranking, "_fetch", value)
    monkeypatch.setattr(ranking, "_fetch_change", change)
    monkeypatch.setattr(screener_runner.screener_intraday, "build_intraday_overlay", unexpected_overlay)
    req = request(calculation_policy=policy, basis="auto").model_dump()
    req["conditions"] += [
        {"id": "change", "type": "change_pct_rank", "params": {"top_n": 200}},
        {"id": "change2", "type": "change_pct_rank", "params": {"top_n": 100}},
    ]
    req["expression"] = "A OR B OR C"
    result = await screener_runner.run_screener_scan(data_dir=corpus, now=NOW, req=ScanRequest.model_validate(req))
    assert sorted(calls) == [("change", 200), ("value", 200)]
    assert {row.code for row in result.rows} == {"000001", "000002"}
    assert result.basis_at_ms == STAMP and result.fallback_basis_at_ms == STAMP - 1000
    second = next(row for row in result.rows if row.code == "000002")
    assert len(second.occurrences) == 2
    assert {event.condition_id for event in second.occurrences} == {"rank", "change"}


def test_change_rank_http_save_and_evidence(corpus):
    app = FastAPI()
    app.include_router(build_router(data_dir=corpus))
    client = TestClient(app)
    req = request(rank_type="change_pct_rank", venue="UN", universe={"exclude_etf": True}).model_dump(mode="json")
    saved = client.post("/api/screener/saves", json={"name": "등락률 200위", "conditions": req["conditions"]})
    assert saved.status_code == 201 and saved.json()["conditions"] == req["conditions"]
    response = client.post("/api/screener/scan", json=req)
    assert response.status_code == 200
    assert [row["code"] for row in response.json()["rows"]] == ["000002"]
    assert response.json()["rows"][0]["occurrences"][0]["change_pct_rank_match"] == dict(
        rank=199, change_pct=11.34, market="all", venue="UN", fetched_at_ms=STAMP, direction="up", basis=None)


@pytest.mark.parametrize("change", [None, float("nan"), float("inf")])
async def test_change_rank_missing_percentage_is_an_error(corpus, monkeypatch, change):
    async def invalid(*_):
        return change_snapshot(rows=(RankingRow(rank=1, code="000001", name="test", price=1, change_pct=change),))
    monkeypatch.setattr(ranking, "_fetch_change", invalid)
    with pytest.raises(HTTPException) as error:
        await ranking.evaluate(corpus, request(rank_type="change_pct_rank"), NOW, ["000001"])
    assert error.value.status_code == 502


@pytest.mark.parametrize("limit,expected_pages", [(200, 1), (300, 2)])
async def test_change_rank_uses_200_row_pages_and_unfiltered_positions(corpus, monkeypatch, limit, expected_pages):
    calls, scheduled = [], []
    class Token:
        def get_token(self):
            return "fake-token"
    class Scheduler:
        async def submit(self, **kwargs):
            scheduled.append(kwargs["api_id"])
            return await kwargs["call"](None)
    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_scheduler", lambda *_: Scheduler())
    monkeypatch.setattr(kiwoom_rankings, "is_trading_day", lambda *_: True)
    monkeypatch.setattr(kiwoom_rankings.time, "time", lambda: NOW.timestamp())
    def handle(req):
        start = int(req.headers["next-key"] or "1")
        calls.append((start, json.loads(req.content)))
        return httpx.Response(200, headers={"cont-yn": "Y", "next-key": str(start + 200)}, json={
            "return_code": 0, "pred_pre_flu_rt_upper": [
                {"stk_cd": f"{i:06d}_AL", "stk_nm": str(i), "flu_rt": str(30 - i / 20)}
                for i in range(start, start + 200)]})
    fetcher = KiwoomRankingsFetcher(Token(), _transport=httpx.MockTransport(handle), _now=lambda: NOW)
    async def fetch(market, venue, limit):
        return await fetcher.get("change", market, "up", venue, limit=limit)
    monkeypatch.setattr(ranking, "_fetch_change", fetch)
    try:
        result = await ranking.evaluate(corpus, request(limit, rank_type="change_pct_rank", venue="UN"),
                                        NOW, ["000200", "000300", "000301"])
        assert [code for code, _ in result.events["rank"]] == (["000200"] if limit == 200 else ["000200", "000300"])
        assert len(calls) == expected_pages and scheduled == ["ka10027"] * expected_pages
        assert all(body["sort_tp"] == "1" and body["stex_tp"] == "3" for _, body in calls)
        assert result.events["rank"][-1][1].change_pct_rank_match.rank == limit
    finally:
        fetcher.close()


def archive_rank(corpus, kind="change", when=None):
    when = when or NOW.replace(hour=21)
    stamp = int(when.timestamp() * 1000)
    result = change_snapshot() if kind == "change" else snapshot()
    result = replace(result, fetched_at_ms=stamp, market_open=False, queried_count=3, has_more=False,
        basis=ranking_session.RankingBasis(session="closed", source="live",
            trading_date=when.date().isoformat(), observed_at_ms=stamp))
    ranking_history.save(corpus, result, 200)
    return stamp


@pytest.mark.parametrize("policy", ["legacy_v1", "separate_bases_v2"])
@pytest.mark.parametrize("rank_type", ["change_pct_rank", "trade_value_rank"])
async def test_holiday_restores_rank_before_daily_or_minute_work(corpus, monkeypatch, policy, rank_type):
    stamp = archive_rank(corpus, "change" if rank_type == "change_pct_rank" else "value")
    async def forbidden(*args, **kwargs):
        raise AssertionError("Historical rank scans do not request today's undated ranks or quotes")
    monkeypatch.setattr(ranking, "_fetch", forbidden)
    monkeypatch.setattr(ranking, "_fetch_change", forbidden)
    monkeypatch.setattr(screener_runner.screener_intraday, "build_intraday_overlay", forbidden)
    req = request(rank_type=rank_type, calculation_policy=policy, basis="auto")
    result = await screener_runner.run_screener_scan(data_dir=corpus,
        now=NOW.replace(month=11, day=1), req=req)
    assert {row.code for row in result.rows} == {"000001", "000002"}
    assert result.rank_basis.source == "stored" and result.rank_basis.trading_date == "2026-10-30"
    assert result.basis_at_ms == result.rank_basis.observed_at_ms == stamp
    assert {event.date for row in result.rows for event in row.occurrences} == {"2026-10-30"}


@pytest.mark.parametrize("policy", ["legacy_v1", "separate_bases_v2"])
async def test_holiday_minute_and_rank_use_same_cutoff_and_only_rank_candidates(corpus, monkeypatch, policy):
    from hoga.api import screener_bar_volume as bars
    at = NOW.replace(hour=16)
    archive_rank(corpus, when=at)
    seen = []
    async def fetch(data_dir, code, timeframe, needed, lower, as_of):
        seen.append((code, as_of))
        return bars.MinuteSnapshot([
            bars.VolumeBar(int(at.replace(hour=15, minute=24).timestamp() * 1000), 10 if code == "000001" else 20),
            bars.VolumeBar(int(at.replace(hour=15, minute=27).timestamp() * 1000), 20 if code == "000001" else 10),
        ], int(at.timestamp() * 1000))
    monkeypatch.setattr(bars, "_fetch_minutes", fetch)
    req = request(rank_type="change_pct_rank", calculation_policy=policy, basis="auto").model_dump()
    req["conditions"].append({"id": "minute", "type": "new_high_vol", "params": {
        "timeframe": "3m", "period": 2, "lookback": 1,
        "volume_basis": "raw" if policy == "separate_bases_v2" else None}})
    req["expression"] = "A AND B"
    result = await screener_runner.run_screener_scan(data_dir=corpus,
        now=NOW.replace(month=11, day=1), req=ScanRequest.model_validate(req))
    assert [row.code for row in result.rows] == ["000001"]
    assert {code for code, _ in seen} == {"000001", "000002"}
    assert all(clock == at for _, clock in seen)
    assert result.bar_coverage.complete == 2
    assert {event.date for event in result.rows[0].occurrences} == {"2026-10-30"}


def test_missing_history_and_credentials_is_http_error_not_a_successful_zero(corpus, monkeypatch):
    monkeypatch.setattr(ranking, "rankings_fetcher", lambda: None)
    monkeypatch.setattr(screener_runner, "now_kst", lambda: NOW.replace(month=11, day=1))
    app = FastAPI()
    app.include_router(build_router(data_dir=corpus))
    result = TestClient(app).post("/api/screener/scan", json=request(
        calculation_policy="separate_bases_v2", rank_type="change_pct_rank").model_dump(mode="json"))
    assert result.status_code == 503
    assert result.json()["detail"]["code"] == "screener_rank_not_wired"
    assert "키움 API" in result.json()["detail"]["message"]


async def test_unknown_weekday_is_distinct_from_missing_holiday_history(corpus, monkeypatch):
    monkeypatch.setattr(trading_days, "is_trading_day", lambda *_: None)
    with pytest.raises(HTTPException) as error:
        await ranking.evaluate(corpus, request(), NOW, [])
    assert error.value.detail["code"] == "screener_rank_calendar_unavailable"


async def test_saved_intraday_rank_never_combines_with_final_daily_values(corpus):
    archive_rank(corpus, when=NOW.replace(hour=14))
    req = request(rank_type="change_pct_rank").model_dump()
    req["conditions"].append({"id": "daily", "type": "price_range", "params": {"min": 100}})
    with pytest.raises(HTTPException) as error:
        await screener_runner.run_screener_scan(data_dir=corpus, now=NOW.replace(month=11, day=1),
                                               req=ScanRequest.model_validate(req))
    assert error.value.detail["code"] == "screener_rank_daily_history_unavailable"


async def test_missing_history_in_or_branch_is_unknown_not_false(corpus):
    req = request().model_dump()
    req["conditions"].append({"id": "daily", "type": "price_range", "params": {"min": 100}})
    req["expression"] = "A OR B"
    with pytest.raises(HTTPException) as error:
        await screener_runner.run_screener_scan(data_dir=corpus, now=NOW.replace(month=11, day=1),
                                               req=ScanRequest.model_validate(req))
    assert error.value.detail["code"] == "screener_rank_not_wired"


async def test_two_saved_rank_types_report_the_earliest_common_cutoff(corpus):
    first = archive_rank(corpus, "change", NOW.replace(hour=21))
    archive_rank(corpus, "value", NOW.replace(hour=21, minute=1))
    req = request(rank_type="change_pct_rank").model_dump()
    req["conditions"].append({"id": "value", "type": "trade_value_rank", "params": {"top_n": 200}})
    result = await screener_runner.run_screener_scan(data_dir=corpus, now=NOW.replace(month=11, day=1),
        req=ScanRequest.model_validate(req))
    assert result.basis_at_ms == result.rank_basis.observed_at_ms == first


@pytest.mark.parametrize("hour,allowed", [(21, False), (22, True)])
async def test_saved_daily_combinations_wait_for_provider_full_session_finalization(corpus, hour, allowed):
    archive_rank(corpus, when=NOW.replace(hour=hour))
    req = request(rank_type="change_pct_rank").model_dump()
    req["conditions"].append({"id": "daily", "type": "price_range", "params": {"min": 100}})
    scan = ScanRequest.model_validate(req)
    if allowed:
        result = await screener_runner.run_screener_scan(data_dir=corpus, now=NOW.replace(month=11, day=1), req=scan)
        assert result.rows
    else:
        with pytest.raises(HTTPException) as error:
            await screener_runner.run_screener_scan(data_dir=corpus, now=NOW.replace(month=11, day=1), req=scan)
        assert error.value.detail["code"] == "screener_rank_daily_history_unavailable"


NEW_RANKS = [
    ('volume_surge_rank', 'surge'), ('volume_rank', 'volume'), ('program_net_buy_rank', 'program'),
    ('institution_net_buy_rank', 'institution'), ('foreign_net_buy_rank', 'foreign'),
]


def new_rank_snapshot(kind, venue='UN', **changes):
    rows = tuple(RankingRow(rank=rank, code=f'{i:06d}', name=str(i), price=100 * i, change_pct=-i,
        volume=1000 - i, volume_surge_pct=200.5 - i,
        program_net_buy_won=10_000_000_000 - i, investor_net_buy_won=5_000_000_000 - i)
        for i, rank in enumerate((1, 99, 101), 1))
    return replace(RankingSnapshot(kind=kind, market='all', direction='up', rows=rows,
        market_open=True, fetched_at_ms=STAMP, venue=None if kind in {'institution', 'foreign'} else venue,
        quote_venue=venue if kind in {'institution', 'foreign'} else None,
        queried_count=3, has_more=False), **changes)


@pytest.mark.parametrize('rank_type,kind', NEW_RANKS)
@pytest.mark.parametrize('policy', ['legacy_v1', 'separate_bases_v2'])
async def test_all_new_rank_sources_keep_market_position_and_evidence(corpus, monkeypatch, rank_type, kind, policy):
    calls = []
    async def fetch(source, market, venue, limit, direction='up'):
        calls.append((source, market, venue, limit, direction))
        return new_rank_snapshot(source, venue)
    monkeypatch.setattr(ranking, '_fetch_kind', fetch)
    req = request(100, rank_type=rank_type, calculation_policy=policy, venue='UN', universe={'exclude_etf': True})
    result = await screener_runner.run_screener_scan(data_dir=corpus, now=NOW, req=req)
    assert calls == [(kind, 'all', 'UN', 100, 'up')]
    assert [row.code for row in result.rows] == ['000002']
    evidence = result.rows[0].occurrences[0].market_rank_match
    assert evidence.rank == 99 and evidence.kind == kind and evidence.fetched_at_ms == STAMP
    assert evidence.venue == (None if kind in {'institution', 'foreign'} else 'UN')
    assert evidence.quote_venue == ('UN' if kind in {'institution', 'foreign'} else None)
    assert evidence.volume == (998 if kind == 'volume' else None)
    assert evidence.volume_surge_pct == (198.5 if kind == 'surge' else None)
    assert evidence.net_buy_won == (9_999_999_998 if kind == 'program' else 4_999_999_998
                                  if kind in {'institution', 'foreign'} else None)


@pytest.mark.parametrize('rank_type,kind', NEW_RANKS)
@pytest.mark.parametrize('policy', ['legacy_v1', 'separate_bases_v2'])
@pytest.mark.parametrize('expression,expected', [('A AND B', []), ('A OR B', ['000001', '000002', '000003'])])
async def test_new_ranks_are_independent_expression_leaves(
    corpus, monkeypatch, rank_type, kind, policy, expression, expected,
):
    async def fetch(*_):
        return new_rank_snapshot(kind)
    monkeypatch.setattr(ranking, '_fetch_kind', fetch)
    req = request(100, rank_type=rank_type, calculation_policy=policy, venue='UN').model_dump()
    req['conditions'].append({'id': 'price', 'type': 'price_range', 'params': {'min': 250}})
    req['expression'] = expression
    result = await screener_runner.run_screener_scan(data_dir=corpus, now=NOW, req=ScanRequest.model_validate(req))
    assert sorted(row.code for row in result.rows) == expected


@pytest.mark.parametrize('rank_type,kind', NEW_RANKS)
def test_new_rank_http_save_and_actual_wire_evidence(corpus, monkeypatch, rank_type, kind):
    async def fetch(*_):
        return new_rank_snapshot(kind)
    monkeypatch.setattr(ranking, '_fetch_kind', fetch)
    app = FastAPI()
    app.include_router(build_router(data_dir=corpus))
    client = TestClient(app)
    req = request(100, rank_type=rank_type, venue='UN').model_dump(mode='json')
    saved = client.post('/api/screener/saves', json={'name': rank_type, 'conditions': req['conditions']})
    assert saved.status_code == 201
    assert client.get(f'/api/screener/saves/{saved.json()["id"]}').json()['conditions'] == req['conditions']
    result = client.post('/api/screener/scan', json=req)
    assert result.status_code == 200
    match = result.json()['rows'][0]['occurrences'][0]['market_rank_match']
    assert set(match) == {'kind', 'rank', 'market', 'venue', 'quote_venue', 'fetched_at_ms',
                          'volume', 'volume_surge_pct', 'net_buy_won', 'basis'}
    assert match['kind'] == kind


@pytest.mark.parametrize('rank_type,kind', NEW_RANKS)
async def test_new_ranks_restore_dated_holiday_records_without_vendor(corpus, monkeypatch, rank_type, kind):
    snap = new_rank_snapshot(kind)
    snap = replace(snap, basis=ranking_session.RankingBasis(session='open', source='live',
        trading_date=NOW.date().isoformat(), observed_at_ms=STAMP))
    ranking_history.save(corpus, snap, 100)
    async def forbidden(*args, **kwargs):
        raise AssertionError('holiday scans must use stored observations')
    monkeypatch.setattr(ranking, '_fetch_kind', forbidden)
    req = request(100, rank_type=rank_type, venue='UN')
    result = await screener_runner.run_screener_scan(data_dir=corpus, now=NOW.replace(month=11, day=1), req=req)
    assert {row.code for row in result.rows} == {'000001', '000002'}
    assert result.rank_basis.source == 'stored' and result.basis_at_ms == STAMP


@pytest.mark.parametrize('rank_type,kind', NEW_RANKS)
async def test_invalid_or_missing_new_rank_metric_is_an_error(corpus, monkeypatch, rank_type, kind):
    row = RankingRow(rank=1, code='000001', name='bad', price=100, change_pct=0)
    async def fetch(*_):
        return new_rank_snapshot(kind, rows=(row,))
    monkeypatch.setattr(ranking, '_fetch_kind', fetch)
    with pytest.raises(HTTPException) as error:
        await ranking.evaluate(corpus, request(100, rank_type=rank_type, venue='UN'), NOW, None)
    assert error.value.detail['code'] == 'screener_rank_invalid_rank'


@pytest.mark.parametrize('rank_type,_kind', NEW_RANKS)
def test_new_rank_limits_are_strict_and_snapshots_remain_forbidden(rank_type, _kind):
    maximum = 100 if rank_type in {'institution_net_buy_rank', 'foreign_net_buy_rank'} else 5000
    for value in (0, maximum + 1, 1.5, True, '50'):
        with pytest.raises(ValidationError):
            request(value, rank_type=rank_type)
    assert request(maximum, rank_type=rank_type).conditions[0].params.top_n == maximum
    with pytest.raises(ValidationError, match='과거 스냅샷'):
        request(50, rank_type=rank_type, calculation_policy='separate_bases_v2', snapshot_id='a' * 64)
    with pytest.raises(ValueError):
        validate_archivable(request(50, rank_type=rank_type, calculation_policy='separate_bases_v2'))


async def test_up_and_down_requests_are_separate_and_shared_limits_do_not_mix(corpus, monkeypatch):
    calls = []
    async def up(market, venue, limit):
        calls.append(('up', limit))
        return change_snapshot()
    async def down(kind, market, venue, limit, direction):
        calls.append((direction, limit))
        return change_snapshot(direction=direction, rows=(RankingRow(
            rank=1, code='000003', name='down', price=300, change_pct=-29.5),))
    monkeypatch.setattr(ranking, '_fetch_change', up)
    monkeypatch.setattr(ranking, '_fetch_kind', down)
    req = request(rank_type='change_pct_rank').model_dump()
    req['conditions'] += [
        {'id': 'down', 'type': 'change_pct_rank', 'params': {'top_n': 100, 'direction': 'down'}},
        {'id': 'up50', 'type': 'change_pct_rank', 'params': {'top_n': 50}},
    ]
    req['expression'] = 'A OR B OR C'
    result = await screener_runner.run_screener_scan(data_dir=corpus, now=NOW, req=ScanRequest.model_validate(req))
    assert sorted(calls) == [('down', 100), ('up', 200)]
    assert {row.code for row in result.rows} == {'000001', '000002', '000003'}
    down_event = next(row for row in result.rows if row.code == '000003').occurrences[0]
    assert down_event.change_pct_rank_match.direction == 'down'
    assert down_event.change_pct_rank_match.change_pct == -29.5


def test_old_upward_rank_exclusion_identity_and_new_direction_are_distinct():
    import hashlib

    from hoga.api.screener_exclusions import condition_key
    old = request(rank_type='change_pct_rank').conditions[0]
    expected = hashlib.sha256(b'{"params":{"top_n":200},"type":"change_pct_rank"}').hexdigest()
    assert condition_key(old) == expected
    down = old.model_copy(update={'params': old.params.model_copy(update={'direction': 'down'})})
    assert condition_key(down) != expected


SUNDAY = NOW.replace(month=11, day=1)
FRIDAY_END = NOW.replace(hour=23, minute=59, second=59, microsecond=999000)
ALL_RANKS = [("trade_value_rank", "value"), ("change_pct_rank", "change"), *NEW_RANKS]


@pytest.fixture
def last_provider(corpus, monkeypatch):
    fetcher = KiwoomRankingsFetcher(object(), data_dir=corpus, _now=lambda: SUNDAY)
    calls = []

    def rows(kind):
        return (snapshot() if kind == "value" else change_snapshot() if kind == "change"
                else new_rank_snapshot(kind)).rows

    async def general(kind, market, direction, venue, limit):
        calls.append((kind, market, direction, venue, limit))
        return rows(kind), 3, False

    async def program(market, venue, limit):
        calls.append(("program", market, "up", venue, limit))
        return rows("program"), False

    async def investor(kind, market, venue):
        calls.append((kind, market, "up", venue, 100))
        return rows(kind)

    monkeypatch.setattr(fetcher, "_fetch_rankings", general)
    monkeypatch.setattr(fetcher, "_fetch_program", program)
    monkeypatch.setattr(fetcher, "_fetch_investor", investor)
    monkeypatch.setattr(ranking, "rankings_fetcher", lambda: fetcher)
    return fetcher, calls


@pytest.mark.parametrize("rank_type,kind", ALL_RANKS)
@pytest.mark.parametrize("policy", ["legacy_v1", "separate_bases_v2"])
@pytest.mark.parametrize("venue", ["KRX", "NXT", "UN"])
async def test_holiday_without_history_uses_last_ranks_and_keeps_receipt_separate_from_cutoff(
    corpus, last_provider, monkeypatch, rank_type, kind, policy, venue,
):
    async def forbidden(**_):
        raise AssertionError("Holiday predicates must not request current daily quotes")
    monkeypatch.setattr(screener_runner.screener_intraday, "build_intraday_overlay", forbidden)
    limit = 100 if (rank_type, kind) in NEW_RANKS else 200
    req = request(limit, rank_type=rank_type, calculation_policy=policy, venue=venue, basis="auto")
    result = await screener_runner.run_screener_scan(data_dir=corpus, now=SUNDAY, req=req)
    assert {row.code for row in result.rows} == {"000001", "000002"}
    assert {row.price_date for row in result.rows} == {"2026-10-30"}
    assert result.rank_basis.source == "provider" and result.rank_basis.trading_date is None
    assert result.rank_basis.observed_at_ms is None
    assert "2026-10-30 완료 데이터" in result.rank_basis.message
    assert result.basis_at_ms == int(FRIDAY_END.timestamp() * 1000)
    for row in result.rows:
        event = row.occurrences[0]
        evidence = event.trade_value_rank_match or event.change_pct_rank_match or event.market_rank_match
        assert event.date == "2026-10-30"
        assert evidence.basis.source == "provider" and evidence.basis.trading_date is None
        assert evidence.fetched_at_ms == int(SUNDAY.timestamp() * 1000)
    assert len(last_provider[1]) == 1
    assert not (corpus / "rankings").exists()


@pytest.mark.parametrize("policy", ["legacy_v1", "separate_bases_v2"])
@pytest.mark.parametrize("expression,expected", [("A AND B", {"000002"}), ("A OR B", {"000001", "000002", "000003"})])
async def test_provider_rank_and_daily_condition_use_completed_friday_for_and_and_or(
    corpus, last_provider, policy, expression, expected,
):
    req = request(rank_type="change_pct_rank", calculation_policy=policy, basis="auto").model_dump()
    req["conditions"].append({"id": "price", "type": "price_range", "params": {"min": 200}})
    req["expression"] = expression
    result = await screener_runner.run_screener_scan(data_dir=corpus, now=SUNDAY, req=ScanRequest.model_validate(req))
    assert {row.code for row in result.rows} == expected
    assert {row.price_date for row in result.rows} == {"2026-10-30"}


@pytest.mark.parametrize("policy", ["legacy_v1", "separate_bases_v2"])
@pytest.mark.parametrize("missing", [False, True])
async def test_provider_rank_and_minutes_use_completed_friday_and_report_missing_date(
    corpus, last_provider, monkeypatch, policy, missing,
):
    from hoga.api import screener_bar_volume as bars

    seen = []
    async def fetch(data_dir, code, timeframe, needed, lower, as_of):
        seen.append((code, as_of))
        day = NOW - dt.timedelta(days=missing)
        return bars.MinuteSnapshot([
            bars.VolumeBar(int(day.replace(hour=15, minute=24).timestamp() * 1000), 10),
            bars.VolumeBar(int(day.replace(hour=15, minute=27).timestamp() * 1000),
                           20 if code == "000001" else 5),
        ], int(SUNDAY.timestamp() * 1000))
    monkeypatch.setattr(bars, "_fetch_minutes", fetch)
    req = request(rank_type="change_pct_rank", calculation_policy=policy, basis="auto").model_dump()
    req["conditions"].append({"id": "minute", "type": "new_high_vol", "params": {
        "timeframe": "3m", "period": 2, "lookback": 1,
        "volume_basis": "raw" if policy == "separate_bases_v2" else None}})
    result = await screener_runner.run_screener_scan(data_dir=corpus, now=SUNDAY, req=ScanRequest.model_validate(req))
    assert {code for code, _ in seen} == {"000001", "000002"}
    assert all(clock == FRIDAY_END for _, clock in seen)
    assert [row.code for row in result.rows] == ([] if missing else ["000001"])
    assert result.bar_coverage.complete == (0 if missing else 2)
    if missing:
        assert {item.reason for item in result.bar_coverage.incomplete} == {"minute_date_mismatch"}


async def test_mixed_stored_and_provider_ranks_keep_each_source_and_use_day_end_for_other_conditions(
    corpus, last_provider,
):
    archive_rank(corpus, "change", NOW.replace(hour=14))
    req = request(rank_type="change_pct_rank", calculation_policy="separate_bases_v2").model_dump()
    req["conditions"] += [{"id": "value", "type": "trade_value_rank", "params": {"top_n": 200}},
                          {"id": "price", "type": "price_range", "params": {"min": 100}}]
    result = await screener_runner.run_screener_scan(data_dir=corpus, now=SUNDAY, req=ScanRequest.model_validate(req))
    assert result.rank_basis.source == "provider" and result.basis_at_ms == int(FRIDAY_END.timestamp() * 1000)
    assert {row.code for row in result.rows} == {"000001", "000002"}
    for row in result.rows:
        evidence = {event.condition_id: event for event in row.occurrences}
        assert evidence["rank"].change_pct_rank_match.basis.source == "stored"
        assert evidence["value"].trade_value_rank_match.basis.source == "provider"
    assert last_provider[1] == [("value", "all", "up", "KRX", 200)]


def test_holiday_provider_rank_http_preserves_evidence_and_day_end(corpus, last_provider, monkeypatch):
    monkeypatch.setattr(screener_runner, "now_kst", lambda: SUNDAY)
    app = FastAPI()
    app.include_router(build_router(data_dir=corpus))
    response = TestClient(app).post("/api/screener/scan", json=request(
        rank_type="change_pct_rank", calculation_policy="separate_bases_v2").model_dump(mode="json"))
    assert response.status_code == 200
    payload = response.json()
    assert payload["rank_basis"]["source"] == "provider" and payload["rank_basis"]["trading_date"] is None
    assert payload["basis_at_ms"] == int(FRIDAY_END.timestamp() * 1000)
    evidence = payload["rows"][0]["occurrences"][0]["change_pct_rank_match"]
    assert evidence["basis"]["source"] == "provider" and evidence["basis"]["observed_at_ms"] is None


async def test_holiday_provider_failure_and_rest_bypass_are_errors_not_empty_results(
    corpus, last_provider, monkeypatch,
):
    async def fail(*args):
        raise KiwoomRankingsError("temporary provider failure")
    monkeypatch.setattr(last_provider[0], "_fetch_rankings", fail)
    with pytest.raises(HTTPException) as error:
        await ranking.evaluate(corpus, request(), SUNDAY, None)
    assert error.value.status_code == 502 and error.value.detail["code"] == "screener_rank_upstream_failed"
    monkeypatch.setattr(ranking.settings, "rest_bypass_enabled", lambda *_: True)
    with pytest.raises(HTTPException) as error:
        await ranking.evaluate(corpus, request(), SUNDAY, None)
    assert error.value.detail["code"] == "screener_rank_rest_bypassed"
    archive_rank(corpus, "value")
    assert (await ranking.evaluate(corpus, request(), SUNDAY, None)).stored


async def test_preopen_provider_rank_uses_previous_day_and_downward_direction(corpus, last_provider):
    now = NOW.replace(hour=8)
    last_provider[0]._now = lambda: now
    req = request(rank_type="change_pct_rank").model_dump()
    req["conditions"][0]["params"]["direction"] = "down"
    result = await ranking.evaluate(corpus, ScanRequest.model_validate(req), now, None)
    assert result.cutoff.date().isoformat() == "2026-10-29" and result.historical
    assert result.basis.source == "provider" and result.basis.session == "preopen"
    assert last_provider[1][0][2] == "down"


@pytest.mark.parametrize("policy", ["legacy_v1", "separate_bases_v2"])
async def test_provider_rank_does_not_substitute_thursday_for_missing_friday_daily_data(
    corpus, last_provider, policy,
):
    import shutil

    for filename in ("daily_adjusted.parquet", "daily_unadjusted.parquet"):
        path = corpus / "screener" / filename
        frame = pl.read_parquet(path).filter(~((pl.col("code") == "000001") & (pl.col("date") == NOW.date())))
        frame.write_parquet(path)
    # Start the fixture without Friday, rather than publishing a partial update
    # that correctly retains the previously verified Friday observation.
    shutil.rmtree(store.root(corpus))
    for code in ("000001", "000002", "000003"):
        remaining = [{**row, "date": row["date"].isoformat()}
                     for row in frame.filter(pl.col("code") == code).drop("code").to_dicts()]
        store.publish_pair(corpus, code, remaining, remaining, adjusted_as_of="2026-10-30",
                           observed_at=SUNDAY.isoformat(), price_events=[])
    req = request(rank_type="change_pct_rank", calculation_policy=policy).model_dump()
    req["conditions"].append({"id": "price", "type": "price_range", "params": {"min": 100}})
    result = await screener_runner.run_screener_scan(data_dir=corpus, now=SUNDAY, req=ScanRequest.model_validate(req))
    assert [row.code for row in result.rows] == ["000002"]
    coverage = result.daily_coverage if policy == "legacy_v1" else result.bar_coverage
    assert coverage.complete < coverage.total
    assert any(item.code == "000001" and item.condition_id == "price" for item in coverage.incomplete)


@pytest.mark.parametrize("changes", [
    {"fetched_at_ms": int(SUNDAY.timestamp() * 1000) - 91_000},
    {"market": "kosdaq"}, {"venue": "UN"}, {"direction": "down"},
    {"basis": ranking_session.RankingBasis(session="holiday", source="provider", trading_date="2026-10-30")},
    {"basis": ranking_session.RankingBasis(session="preopen", source="provider")},
])
async def test_invalid_provider_scope_or_receipt_is_not_accepted(corpus, last_provider, monkeypatch, changes):
    snap = await last_provider[0].get("value", "all", "up", limit=200, allow_last_available=True)
    async def bad(*args, **kwargs):
        return replace(snap, **changes)
    monkeypatch.setattr(ranking, "_fetch_kind", bad)
    with pytest.raises(HTTPException) as error:
        await ranking.evaluate(corpus, request(), SUNDAY, None)
    assert error.value.detail["code"] == "screener_rank_snapshot_unverified"


async def test_unknown_weekday_cannot_fetch_last_provider_rows(corpus, last_provider, monkeypatch):
    monkeypatch.setattr(trading_days, "is_trading_day", lambda *_: None)
    with pytest.raises(HTTPException) as error:
        await ranking.evaluate(corpus, request(), SUNDAY + dt.timedelta(days=1), None)
    assert error.value.detail["code"] == "screener_rank_calendar_unavailable" and last_provider[1] == []


async def test_valid_empty_provider_ranking_is_distinct_from_a_failed_fetch(corpus, last_provider, monkeypatch):
    async def empty(*args):
        return (), 0, False
    monkeypatch.setattr(last_provider[0], "_fetch_rankings", empty)
    result = await screener_runner.run_screener_scan(data_dir=corpus, now=SUNDAY, req=request())
    assert result.status == "ok" and result.rows == [] and result.rank_basis.source == "provider"
