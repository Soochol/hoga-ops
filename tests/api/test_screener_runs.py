"""Click-to-result preparation uses real snapshots, scans, and HTTP serialization."""

import asyncio
import datetime as dt
import hashlib
import json

import httpx
import polars as pl
import pytest
from fastapi import FastAPI

from hoga.api import screener_daily_confirmation as confirmation, screener_series_store as store, symbols, trading_days
from hoga.api.models import ScanRequest, ScreenerRun
from hoga.api.screener_preparation import DailyPreparation, PreparationDeferred
from hoga.api.screener_runs import ScreenerRuns, build_router
from hoga.api.screener_store import _DAILY_PL_SCHEMA
from hoga.util.timeenc import KST

NOW = dt.datetime(2026, 11, 1, 18, tzinfo=KST)
DAYS = [dt.date(2026, 10, day) for day in (28, 29, 30)]
CODES = ["000020", "005930"]


def row(code, day):
    return dict(code=code, date=day.isoformat(), open=100., high=110., low=90., close=105., volume=100, complete=True)


def candidate(target, anchor, now=NOW):
    rows = [row(target.code, day) for day in DAYS if target.first <= day <= target.last]
    fields = dict(unadjusted=rows, adjusted=rows, price_events=[], violations=[],
                  provider_rows={"unadjusted": [], "adjusted": []})
    first = confirmation.DailySample(started_at=now - dt.timedelta(seconds=4),
                                     finished_at=now - dt.timedelta(seconds=3), **fields)
    second = confirmation.DailySample(started_at=now, finished_at=now + dt.timedelta(seconds=1), **fields)
    return dict(code=target.code, adjusted_as_of=anchor.isoformat(), observed_at=second.finished_at.isoformat(),
                **fields, confirmation=confirmation.DailyConfirmation(
                    first=first, second=second).model_dump(mode="json"))


def request(kind="new_high_today", **changes):
    return ScanRequest.model_validate(dict(calculation_policy="separate_bases_v2", basis="eod",
                                          conditions=[dict(id="condition", type=kind, params=dict(period=3))],
                                          **changes))


@pytest.fixture
def corpus(tmp_path, monkeypatch):
    monkeypatch.setattr(trading_days, "trading_days", lambda _: [day.strftime("%Y%m%d") for day in DAYS])
    monkeypatch.setattr(symbols, "all_etf_etn_codes", lambda: None)
    sd = tmp_path / "screener"
    sd.mkdir()
    rows = [{**row(code, day), "date": day} for code in CODES for day in DAYS]
    frame = pl.DataFrame(rows).select(list(_DAILY_PL_SCHEMA)).cast(_DAILY_PL_SCHEMA)
    for name in ("daily_unadjusted.parquet", "daily_adjusted.parquet"):
        frame.write_parquet(sd / name)
    pl.DataFrame(dict(code=CODES, name=CODES, market=["KOSPI"] * len(CODES), is_etf=[False] * len(CODES),
                      is_halted=[False] * len(CODES))).write_parquet(sd / "stocks.parquet")
    pl.DataFrame(dict(code=CODES, seg_start=[DAYS[0]] * len(CODES), factor=[1.] * len(CODES))).write_parquet(
        sd / "factors.parquet")
    (sd / "status.json").write_text(json.dumps(dict(schema_version=1, last_raw_date="20261030",
                                                   last_built_ms=1, universe_size=len(CODES), derive_ms=0)))
    return tmp_path


def make_owner(corpus, fetch):
    prep = DailyPreparation(corpus, fetch=fetch, clock=lambda: NOW)
    return ScreenerRuns(corpus, preparation=prep, clock=lambda: NOW)


async def finish(owner, run):
    task = owner.tasks.get(run.id)
    if task:
        await asyncio.wait_for(asyncio.shield(task), 5)
    return owner.read(run.id)


def protected(corpus):
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (corpus / "screener").glob("*.parquet")}


async def test_http_click_collects_once_two_callers_join_and_warm_scan_reuses(corpus):
    calls = []

    async def fetch(target, anchor, check):
        calls.append(target.code)
        await asyncio.sleep(0)
        check()
        return candidate(target, anchor)

    before = protected(corpus)
    owner = make_owner(corpus, fetch)
    app = FastAPI()
    app.include_router(build_router(owner))
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
            one, two = await asyncio.gather(*(client.post('/runs', json=request().model_dump(mode="json"))
                                             for _ in range(2)))
            assert one.status_code == two.status_code == 200
            assert one.json()['id'] == two.json()['id']
            done = await finish(owner, ScreenerRun.model_validate(one.json()))
            assert done.status == "complete", done.errors
            assert done.evaluated == done.total == len(CODES)
            assert {r.code for r in done.result.rows} == set(CODES)
            assert sorted(calls) == CODES
            response = await client.get(f'/runs/{done.id}')
            assert response.json() == done.model_dump(mode="json")
            unchanged = await client.get(f'/runs/{done.id}?after_revision={done.result_revision}')
            assert unchanged.json()['result'] is None
            warm = await finish(owner, await owner.start(request()))
            assert warm.status == "complete"
            assert sorted(calls) == CODES
            assert protected(corpus) == before
    finally:
        await owner.close()


async def test_different_conditions_share_collection_and_quantity_unknown_does_not_refetch(corpus):
    calls = []

    async def fetch(target, anchor, check):
        calls.append(target.code)
        await asyncio.sleep(0)
        return candidate(target, anchor)

    owner = make_owner(corpus, fetch)
    try:
        price, volume = await asyncio.gather(owner.start(request()), owner.start(request("new_high_vol_today")))
        price, volume = await asyncio.gather(finish(owner, price), finish(owner, volume))
        assert price.status == "complete", price.errors
        assert volume.status == "partial"
        assert volume.waiting == len(CODES) and volume.failed == 0
        assert {x.reason for x in volume.result.bar_coverage.incomplete} == {"share_evidence_unavailable"}
        assert sorted(calls) == CODES
        again = await finish(owner, await owner.start(request("new_high_vol_today")))
        assert again.waiting == len(CODES)
        assert sorted(calls) == CODES
    finally:
        await owner.close()


async def test_partial_results_are_published_while_another_code_is_still_collecting(corpus):
    release = asyncio.Event()

    async def fetch(target, anchor, check):
        if target.code == CODES[-1]:
            await release.wait()
        return candidate(target, anchor)

    owner = make_owner(corpus, fetch)
    try:
        run = await owner.start(request())

        async def partial():
            while True:
                value = owner.read(run.id)
                if value.result and value.result.rows:
                    return value
                await asyncio.sleep(0)

        value = await asyncio.wait_for(partial(), 5)
        assert value.preparing == 1 and value.evaluated == 1
        assert [r.code for r in value.result.rows] == CODES[:1]
        release.set()
        done = await finish(owner, run)
        assert done.status == "complete"
    finally:
        release.set()
        await owner.close()


async def test_publication_failure_resumes_staged_payloads_without_new_network(corpus, monkeypatch):
    calls = []

    async def fetch(target, anchor, check):
        calls.append(target.code)
        return candidate(target, anchor)

    publish = store.publish_pairs

    def disk_failure(root, payloads, **kwargs):
        if payloads:
            raise OSError("injected disk failure")
        return publish(root, payloads, **kwargs)

    owner = make_owner(corpus, fetch)
    monkeypatch.setattr(store, "publish_pairs", disk_failure)
    first = await finish(owner, await owner.start(request()))
    assert first.failed == len(CODES)
    await owner.close()
    monkeypatch.setattr(store, "publish_pairs", publish)
    resumed = make_owner(corpus, fetch)
    try:
        done = await finish(resumed, await resumed.start(request()))
        assert done.status == "complete", done.errors
        assert sorted(calls) == CODES
    finally:
        await resumed.close()


async def test_provider_failure_has_a_durable_retry_budget(corpus):
    calls = []

    async def fetch(target, anchor, check):
        calls.append(target.code)
        raise RuntimeError("temporary vendor failure")

    owner = make_owner(corpus, fetch)
    await finish(owner, await owner.start(request()))
    await owner.close()
    restarted = make_owner(corpus, fetch)
    try:
        again = await finish(restarted, await restarted.start(request()))
        assert again.status == "partial"
        assert again.waiting == len(CODES) and again.failed == 0
        assert sorted(calls) == CODES
    finally:
        await restarted.close()


async def test_snapshot_read_is_not_automatically_prepared(corpus):
    async def fetch(target, anchor, check):
        return candidate(target, anchor)

    owner = make_owner(corpus, fetch)
    done = await finish(owner, await owner.start(request()))
    snapshot = done.result.calculation.snapshot_id

    async def forbidden(*_):
        raise AssertionError("a pinned snapshot must be read without collection")

    owner.preparation.fetch = forbidden
    try:
        pinned = await finish(owner, await owner.start(request(snapshot_id=snapshot)))
        assert pinned.result.calculation.snapshot_id == snapshot
        assert pinned.status == "complete"
    finally:
        await owner.close()


async def test_input_changes_interrupt_instead_of_mixing_search_populations(corpus):
    release = asyncio.Event()
    started = asyncio.Event()

    async def fetch(target, anchor, check):
        started.set()
        await release.wait()
        return candidate(target, anchor)

    owner = make_owner(corpus, fetch)
    try:
        run = await owner.start(request())
        # Wait for admission to reach provider collection before changing the roster.
        await asyncio.wait_for(started.wait(), 5)
        path = corpus / "screener/stocks.parquet"
        pl.read_parquet(path).filter(pl.col("code") == CODES[0]).write_parquet(path)
        release.set()
        done = await finish(owner, run)
        assert done.status == "interrupted"
        assert "종목 범위" in done.errors["run"]
    finally:
        release.set()
        await owner.close()


async def test_disconnect_does_not_cancel_shared_provider_work(corpus):
    release = asyncio.Event()
    started = asyncio.Event()
    calls = []

    async def fetch(target, anchor, check):
        calls.append(target.code)
        started.set()
        await release.wait()
        return candidate(target, anchor)

    prep = DailyPreparation(corpus, fetch=fetch, clock=lambda: NOW)
    try:
        first = asyncio.create_task(prep.prepare(CODES[0], DAYS[0], DAYS[-1], NOW.date()))
        second = asyncio.create_task(prep.prepare(CODES[0], DAYS[0], DAYS[-1], NOW.date()))
        await started.wait()
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        release.set()
        await second
        assert calls == CODES[:1]
    finally:
        release.set()
        await prep.close()


async def test_cold_quantity_only_search_does_not_download_prices_that_cannot_resolve_its_missing_evidence(corpus):
    async def forbidden(*_):
        raise AssertionError("quantity evidence cannot be manufactured by downloading daily prices")

    owner = make_owner(corpus, forbidden)
    try:
        done = await finish(owner, await owner.start(request("new_high_vol_today")))
        assert done.status == "partial"
        assert done.waiting == len(CODES) and done.failed == 0
        assert {item.reason for item in done.result.bar_coverage.incomplete} == {"share_evidence_unavailable"}
        assert owner.preparation.tasks == {}
    finally:
        await owner.close()


async def test_legacy_history_search_uses_the_existing_publisher_and_preserves_its_policy(corpus, monkeypatch):
    from hoga.api import screener_history_jobs

    for name in ("daily_unadjusted.parquet", "daily_adjusted.parquet"):
        path = corpus / "screener" / name
        pl.read_parquet(path).filter(pl.col("date") != DAYS[0]).write_parquet(path)
    calls = []

    async def fetch(root, code, first, last, **kwargs):
        calls.append(code)
        frame = pl.DataFrame([{**row(code, day), "date": day} for day in DAYS]).select(
            list(_DAILY_PL_SCHEMA)).cast(_DAILY_PL_SCHEMA)
        return frame, frame

    monkeypatch.setattr(screener_history_jobs, "fetch_pair", fetch)
    owner = make_owner(corpus, None)
    req = ScanRequest.model_validate(dict(conditions=[dict(id="amount", type="trade_value_period", params=dict(
        mode="date_range", start_date=DAYS[0].isoformat(), end_date=DAYS[-1].isoformat(), min_eok=0))]))
    try:
        done = await finish(owner, await owner.start(req))
        assert done.status == "complete", done.errors
        assert done.result.history_coverage.complete == len(CODES)
        assert sorted(calls) == CODES
        assert not store.root(corpus).joinpath('current.json').exists()
    finally:
        await owner.close()


async def test_incremental_results_evaluate_new_codes_once_and_keep_global_limit_order(corpus, monkeypatch):
    from hoga.api import screener_series_runner

    release = asyncio.Event()
    evaluations = []
    original = screener_series_runner.calendar_evaluate

    def evaluate(root, req, pinned, codes, *args, **kwargs):
        evaluations.extend(codes)
        return original(root, req, pinned, codes, *args, **kwargs)

    monkeypatch.setattr(screener_series_runner, "calendar_evaluate", evaluate)

    async def fetch(target, anchor, check):
        if target.code == CODES[0]:
            await release.wait()
        return candidate(target, anchor)

    owner = make_owner(corpus, fetch)
    req = request(limit=1)
    try:
        run = await owner.start(req)

        async def first_result():
            while True:
                state = owner.read(run.id)
                if state.result and state.result.rows:
                    return state
                await asyncio.sleep(0)

        first = await asyncio.wait_for(first_result(), 5)
        assert [row.code for row in first.result.rows] == CODES[-1:]
        release.set()
        done = await finish(owner, run)
        assert evaluations.count(CODES[0]) == evaluations.count(CODES[1]) == 1
        assert [row.code for row in done.result.rows] == CODES[:1]
        assert done.result.has_more
        full = await screener_series_runner.run_scan(data_dir=corpus, req=req, now=NOW)
        assert done.result.rows == full.rows and done.result.has_more == full.has_more
        assert done.result.bar_coverage == full.bar_coverage
        assert done.result.calculation == full.calculation
    finally:
        release.set()
        await owner.close()


async def test_incremental_cache_invalidates_removed_matches_and_refills_previously_truncated_rows(corpus):
    from hoga.api.screener_recovery import RecoveryTarget
    from hoga.api.screener_run_results import RunResults
    from hoga.api.screener_series_runner import run_scan

    payloads = [candidate(RecoveryTarget(code=code, first=DAYS[0], last=DAYS[-1], reason="test"), NOW.date())
                for code in CODES]
    store.publish_pairs(corpus, payloads, adjusted_as_of=NOW.date().isoformat())
    req = request(limit=1)
    cache = RunResults(corpus, None)
    first = await cache.evaluate(req, CODES, set(), NOW, store.load_snapshot(corpus), [])
    assert [row.code for row in first.rows] == CODES[:1] and first.has_more
    changed = json.loads(json.dumps(payloads[0]))
    for rows in [changed['adjusted'], changed['confirmation']['first']['adjusted'],
                 changed['confirmation']['second']['adjusted']]:
        rows[-1].update(high=100., close=100.)
    store.publish_pair(corpus, **changed)
    second = await cache.evaluate(req, CODES, set(), NOW, store.load_snapshot(corpus), [])
    full = await run_scan(data_dir=corpus, req=req, now=NOW)
    assert [row.code for row in second.rows] == CODES[-1:] and not second.has_more
    assert second.rows == full.rows and second.bar_coverage == full.bar_coverage


@pytest.mark.parametrize('expression,expected', [('A OR B', CODES), ('A AND B', [])])
async def test_blocked_quantity_leaf_does_not_change_price_or_expression_semantics(corpus, expression, expected):
    async def fetch(target, anchor, check):
        return candidate(target, anchor)

    req = ScanRequest.model_validate(dict(calculation_policy="separate_bases_v2", basis="eod", expression=expression,
        conditions=[dict(id="price", type="new_high_today", params=dict(period=3)),
                    dict(id="volume", type="new_high_vol_today", params=dict(period=3))]))
    owner = make_owner(corpus, fetch)
    try:
        done = await finish(owner, await owner.start(req))
        assert sorted(row.code for row in done.result.rows) == expected
        assert done.waiting == len(CODES) and done.failed == 0
    finally:
        await owner.close()


async def test_midnight_batches_do_not_reject_new_basis_work_because_old_basis_work_is_queued(corpus):
    from hoga.api.screener_recovery import RecoveryTarget

    tomorrow = NOW + dt.timedelta(days=1)
    prep = DailyPreparation(corpus, clock=lambda: tomorrow)
    futures = []
    for code, clock in [(CODES[0], NOW), (CODES[0], tomorrow), (CODES[1], NOW), (CODES[1], tomorrow)]:
        target = RecoveryTarget(code=code, first=DAYS[0], last=DAYS[-1], reason="test")
        done = asyncio.get_running_loop().create_future()
        futures.append(done)
        await prep.queue.put((candidate(target, clock.date(), clock), done))
    await prep._write_batches()
    results = await asyncio.gather(*futures, return_exceptions=True)
    assert isinstance(results[0], PreparationDeferred) and isinstance(results[2], PreparationDeferred)
    assert isinstance(results[1], str) and isinstance(results[3], str)
    manifest = store.load_snapshot(corpus)[1]
    assert manifest["adjusted_as_of"] == tomorrow.date().isoformat()
    assert set(manifest["observations"]) == set(CODES)


async def test_partial_preparation_keeps_ranking_population_global(corpus, monkeypatch):
    from hoga.api import screener_rankings
    from hoga.api.models import ScreenerOccurrence, TradeValueRankMatch

    populations = []

    async def ranking(root, req, clock, codes):
        populations.append(codes)
        event = ScreenerOccurrence(condition_id="rank", condition_key="rank", date=NOW.date().isoformat(),
            trade_value_rank_match=TradeValueRankMatch(rank=1, trade_value_won=1000000000, market="all", venue="KRX",
                                                       fetched_at_ms=int(NOW.timestamp() * 1000)))
        return screener_rankings.RankEvaluation({"rank": [(CODES[-1], event)]}, int(NOW.timestamp() * 1000))

    monkeypatch.setattr(screener_rankings, "evaluate", ranking)

    async def fetch(target, anchor, check):
        return candidate(target, anchor)

    owner = make_owner(corpus, fetch)
    req = ScanRequest.model_validate(dict(calculation_policy="separate_bases_v2", basis="eod", conditions=[
        dict(id="price", type="new_high_today", params=dict(period=3)),
        dict(id="rank", type="trade_value_rank", params=dict(top_n=1))]))
    try:
        done = await finish(owner, await owner.start(req))
        assert [row.code for row in done.result.rows] == CODES[-1:]
        assert populations and all(population is None for population in populations)
    finally:
        await owner.close()


async def test_transient_transport_failure_retries_automatically_without_occupying_other_collection_slots(corpus):
    clock = [NOW]
    calls = {code: 0 for code in CODES}
    waited = []

    async def pause(seconds):
        waited.append(seconds)
        clock[0] += dt.timedelta(seconds=seconds)
        await asyncio.sleep(0)

    async def fetch(target, anchor, check):
        calls[target.code] += 1
        if target.code == CODES[0] and calls[target.code] == 1:
            raise httpx.ConnectError("temporary transport outage")
        return candidate(target, anchor, clock[0])

    prep = DailyPreparation(corpus, fetch=fetch, clock=lambda: clock[0])
    owner = ScreenerRuns(corpus, preparation=prep, clock=lambda: clock[0], pause=pause)
    try:
        done = await finish(owner, await owner.start(request()))
        assert done.status == "complete", done.errors
        assert calls == {CODES[0]: 2, CODES[1]: 1}
        assert sum(waited) >= 1800
        assert done.errors == {} and done.next_retry_at_ms is None
    finally:
        await owner.close()


async def test_restart_resumes_the_original_id_and_clock_but_completed_runs_get_new_ids(corpus):
    entered = asyncio.Event()

    async def blocked(target, anchor, check):
        entered.set()
        await asyncio.Event().wait()

    owner = make_owner(corpus, blocked)
    first = await owner.start(request())
    await asyncio.wait_for(entered.wait(), 5)
    await owner.close()
    assert owner.read(first.id).status == "interrupted"
    clock = [NOW + dt.timedelta(seconds=30)]

    async def pause(seconds):
        clock[0] += dt.timedelta(seconds=seconds)
        await asyncio.sleep(0)

    async def fetch(target, anchor, check):
        return candidate(target, anchor, clock[0])

    resumed = ScreenerRuns(corpus, preparation=DailyPreparation(corpus, fetch=fetch, clock=lambda: clock[0]),
                          clock=lambda: clock[0], pause=pause)
    try:
        again = await resumed.start(request())
        assert again.id == first.id and again.started_at_ms == first.started_at_ms
        done = await finish(resumed, again)
        assert done.status == "complete", done.errors
        newer = await finish(resumed, await resumed.start(request()))
        assert newer.id != done.id and newer.status == "complete"
        assert resumed.read(done.id).started_at_ms == first.started_at_ms
    finally:
        await resumed.close()


async def test_automatic_transient_retries_stop_after_the_daily_budget(corpus):
    clock = [NOW]
    calls = []

    async def pause(seconds):
        clock[0] += dt.timedelta(seconds=seconds)
        await asyncio.sleep(0)

    async def fetch(target, anchor, check):
        calls.append(target.code)
        raise httpx.ConnectError("still unavailable")

    owner = ScreenerRuns(corpus, preparation=DailyPreparation(corpus, fetch=fetch, clock=lambda: clock[0]),
                         clock=lambda: clock[0], pause=pause)
    try:
        done = await finish(owner, await owner.start(request()))
        assert done.status == "partial" and done.failed == len(CODES)
        assert calls.count(CODES[0]) == calls.count(CODES[1]) == 2
        again = await finish(owner, await owner.start(request()))
        assert again.waiting == len(CODES) and again.next_retry_at_ms is None
        assert calls.count(CODES[0]) == calls.count(CODES[1]) == 2
    finally:
        await owner.close()


async def test_missing_stored_rank_fails_before_any_daily_collection_or_publication(corpus, monkeypatch):
    from fastapi import HTTPException

    from hoga.api import screener_rankings

    async def unavailable(*args):
        raise HTTPException(409, "최근 거래일의 저장된 순위가 없습니다")

    monkeypatch.setattr(screener_rankings, "evaluate", unavailable)
    calls = []

    async def fetch(target, anchor, check):
        calls.append(target.code)
        return candidate(target, anchor)

    owner = make_owner(corpus, fetch)
    req = request().model_copy(update={"conditions": [*request().conditions,
        ScanRequest.model_validate(dict(conditions=[dict(id="rank", type="volume_rank", params=dict(top_n=1))]))
        .conditions[0]]})
    try:
        done = await finish(owner, await owner.start(req))
        assert done.status == "failed"
        assert "저장된 순위" in done.errors["run"]
        assert calls == []
        assert store.load_snapshot(corpus) is None
    finally:
        await owner.close()


@pytest.mark.parametrize("source", ["stored", "provider"])
async def test_historical_rank_prepares_only_its_candidates_and_never_reads_later_daily_rows(
    corpus, monkeypatch, source,
):
    from hoga.api import screener_rankings
    from hoga.api.models import ScreenerOccurrence, TradeValueRankMatch
    from hoga.live.ranking_session import RankingBasis

    cutoff = dt.datetime.combine(DAYS[0], dt.time(22) if source == "stored" else dt.time(23, 59, 59, 999000), KST)
    observed = int(cutoff.timestamp() * 1000)
    fetched = observed if source == "stored" else int(NOW.timestamp() * 1000)

    async def ranking(root, req, clock, codes):
        event = ScreenerOccurrence(condition_id="rank", condition_key="rank", date=DAYS[0].isoformat(),
            trade_value_rank_match=TradeValueRankMatch(rank=1, trade_value_won=1000000000, market="all", venue="KRX",
                                                       fetched_at_ms=fetched))
        return screener_rankings.RankEvaluation({"rank": [(CODES[-1], event)]}, fetched,
            basis=RankingBasis(session="holiday", source=source,
                               trading_date=DAYS[0].isoformat() if source == "stored" else None,
                               observed_at_ms=observed if source == "stored" else None),
            evaluation_at_ms=observed if source == "provider" else None)

    monkeypatch.setattr(screener_rankings, "evaluate", ranking)
    calls = []

    async def fetch(target, anchor, check):
        calls.append((target.code, target.first, target.last, anchor))
        return candidate(target, anchor)

    owner = make_owner(corpus, fetch)
    req = ScanRequest.model_validate(dict(calculation_policy="separate_bases_v2", basis="eod", conditions=[
        dict(id="price", type="new_high_today", params=dict(period=1)),
        dict(id="rank", type="trade_value_rank", params=dict(top_n=1))]))
    try:
        done = await finish(owner, await owner.start(req))
        assert done.status == "complete"
        assert calls == [(CODES[-1], DAYS[0], DAYS[0], NOW.date())]
        assert [row.price_date for row in done.result.rows] == [DAYS[0].isoformat()]
        assert done.result.rank_basis.source == source
        assert done.result.basis_at_ms == observed
    finally:
        await owner.close()


async def test_new_day_rebases_complete_prices_before_the_next_warm_reuse(corpus):
    now = [NOW - dt.timedelta(days=1)]
    calls = []

    async def fetch(target, anchor, check):
        calls.append((target.code, anchor))
        return candidate(target, anchor, now=now[0])

    async def search():
        owner = ScreenerRuns(corpus, preparation=DailyPreparation(corpus, fetch=fetch, clock=lambda: now[0]),
                             clock=lambda: now[0])
        try:
            return await finish(owner, await owner.start(request()))
        finally:
            await owner.close()

    first = await search()
    assert first.status == "complete"
    assert len(calls) == len(CODES)
    warm = await search()
    assert warm.status == "complete"
    assert len(calls) == len(CODES)
    now[0] += dt.timedelta(days=1)
    changed = await search()
    assert changed.status == "complete"
    assert len(calls) == len(CODES) * 2
    assert changed.result.calculation.adjusted_as_of == NOW.date().isoformat()
    await search()
    assert len(calls) == len(CODES) * 2
