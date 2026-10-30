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

from hoga.api import screener_rankings as ranking, screener_runner, screener_series_store as store, trading_days
from hoga.api.models import ScanRequest, ScreenerExclusionWrite
from hoga.api.screener import build_router
from hoga.api.screener_series_execution import validate_archivable
from hoga.live import kiwoom_rankings, kiwoom_rest_runtime
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


@pytest.mark.parametrize("trading,hour", [(False, 10), (None, 10), (True, 8)])
async def test_closed_or_unknown_day_never_uses_old_ranks(corpus, monkeypatch, trading, hour):
    monkeypatch.setattr(trading_days, "is_trading_day", lambda *_: trading)
    with pytest.raises(HTTPException) as error:
        await ranking.evaluate(corpus, request(), NOW.replace(hour=hour), [])
    assert error.value.status_code == 409


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
    assert evidence == dict(rank=199, trade_value_won=500_000_000, market="all", venue="KRX", fetched_at_ms=STAMP)


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
        rank=199, change_pct=11.34, market="all", venue="UN", fetched_at_ms=STAMP)


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
