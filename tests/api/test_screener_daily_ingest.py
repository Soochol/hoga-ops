"""Daily collection must never freeze an early value or silently adopt a later revision."""

import copy
import datetime as dt
import hashlib

import polars as pl
import pytest

from hoga.api import screener_daily_ingest as ingest, screener_series_store as series
from hoga.api.screener_daily_ingest import RawSample
from hoga.api.screener_store import _DAILY_PL_SCHEMA
from hoga.util.timeenc import KST

CODE = "005930"
D0, D1, D2 = (dt.date(2026, 10, d) for d in (22, 23, 24))


def row(day, volume=100):
    return dict(code=CODE, date=day.isoformat(), open=100.0, high=100.0, low=100.0, close=100.0, volume=volume)


def sample(day, rows, *, hour=22, seconds=0, violations=None):
    now = dt.datetime.combine(day, dt.time(hour), KST) + dt.timedelta(seconds=seconds)
    raw = [
        dict(
            dt=r["date"].replace("-", ""),
            open_pric=str(r["open"]),
            high_pric=str(r["high"]),
            low_pric=str(r["low"]),
            cur_prc=str(r["close"]),
            trde_qty=str(r["volume"]),
        )
        for r in rows
    ]
    return RawSample(CODE, now, now, rows, raw, violations or [])


@pytest.fixture
def corpus(tmp_path):
    sd = tmp_path / "screener"
    sd.mkdir()
    base = pl.DataFrame([{**row(D0), "date": D0}], schema=_DAILY_PL_SCHEMA)
    for name in ["daily_unadjusted.parquet", "daily_adjusted.parquet"]:
        base.write_parquet(sd / name)
    pl.DataFrame(dict(code=[CODE], seg_start=[D0], factor=[1.0])).write_parquet(sd / "factors.parquet")
    pl.DataFrame(
        dict(code=[CODE], name=["삼성전자"], market=["KOSPI"], is_etf=[False], is_halted=[False])
    ).write_parquet(sd / "stocks.parquet")
    (sd / "saves.json").write_text('{"schema_version":1,"saves":[]}')
    return tmp_path


def hashes(root):
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (root / "screener").glob("*.parquet")}


async def perform(root, day, rows, *, hour=22, calls=None):
    async def fetch(code, first, last, round_index):
        if calls is not None:
            calls.append((code, first, last, round_index))
        return sample(day, copy.deepcopy(rows), hour=hour, seconds=round_index * 3)

    return await ingest.run(
        root,
        codes=[CODE],
        days=[D0.isoformat(), D1.isoformat()],
        fetch=fetch,
        now=dt.datetime.combine(day, dt.time(hour), KST),
        pause=lambda _: _nothing(),
    )


async def _nothing():
    pass


async def test_current_day_is_provisional_and_next_day_confirms_with_one_request(corpus):
    before = hashes(corpus)
    calls = []
    assert await perform(corpus, D1, [row(D0), row(D1, 200)], calls=calls) == 0
    assert hashes(corpus) == before
    assert ingest.load(corpus)["entries"][f"{CODE}:{D1}"]["status"] == "provisional"
    assert len(calls) == 1
    calls.clear()
    assert await perform(corpus, D2, [row(D0), row(D1, 200)], calls=calls) == 1
    assert len(calls) == 1
    state = ingest.load(corpus)
    assert state["entries"][f"{CODE}:{D1}"]["status"] == "confirmed"
    assert state["confirmed_through"][CODE] == D1.isoformat()
    base = pl.read_parquet(corpus / "screener/daily_unadjusted.parquet")
    assert base.filter(pl.col("date") == D0)["volume"].item() == 100
    assert base.filter(pl.col("date") == D1)["volume"].item() == 200


async def test_early_value_can_settle_without_overwriting_or_false_confirmation(corpus):
    await perform(corpus, D1, [row(D0), row(D1, 1)], hour=16)
    assert not ingest.load(corpus)["entries"][f"{CODE}:{D1}"].get("eligible_sample")
    calls = []
    assert await perform(corpus, D2, [row(D0), row(D1, 200)], calls=calls) == 1
    assert len(calls) == 2
    assert ingest.load(corpus)["entries"][f"{CODE}:{D1}"]["candidate"]["volume"] == 200


async def test_changed_closed_sample_is_sticky_and_does_not_overwrite(corpus):
    before = hashes(corpus)
    await perform(corpus, D1, [row(D0), row(D1, 200)])
    await perform(corpus, D2, [row(D0), row(D1, 201)])
    state = ingest.load(corpus)
    entry = state["entries"][f"{CODE}:{D1}"]
    assert entry["status"] == "quarantined" and entry["reason"] == "closed_observation_changed"
    assert hashes(corpus) == before
    await perform(corpus, D2 + dt.timedelta(days=1), [row(D0), row(D1, 201)])
    assert ingest.load(corpus)["entries"][f"{CODE}:{D1}"]["status"] == "quarantined"
    assert hashes(corpus) == before


async def test_stored_row_revision_is_quarantined_even_for_one_share(corpus):
    before = hashes(corpus)
    await perform(corpus, D1, [row(D0, 101), row(D1)])
    entry = ingest.load(corpus)["entries"][f"{CODE}:{D0}"]
    assert entry["status"] == "quarantined" and entry["preserved"]["volume"] == 100
    assert hashes(corpus) == before


async def test_resume_reuses_original_timestamps_and_independent_evidence(corpus, monkeypatch):
    publish = ingest._publish

    publications = 0

    def interrupted(*args):
        nonlocal publications
        publications += 1
        if publications == 2:
            raise OSError("interrupted before publication")
        return publish(*args)

    monkeypatch.setattr(ingest, "_publish", interrupted)
    calls = []
    with pytest.raises(OSError):
        await perform(corpus, D1, [row(D0), row(D1)], calls=calls)
    assert len(calls) == 1
    monkeypatch.setattr(ingest, "_publish", publish)
    calls.clear()
    await perform(corpus, D1, [row(D0), row(D1)], calls=calls)
    assert calls == []
    assert ingest.load(corpus)["entries"][f"{CODE}:{D1}"]["status"] == "provisional"


async def test_missing_row_remains_pending_and_retry_is_bounded(corpus):
    await perform(corpus, D1, [row(D0)])
    state = ingest.load(corpus)
    assert state["entries"][f"{CODE}:{D1}"]["status"] == "provisional"
    clock = dt.datetime.combine(D1, dt.time(22), KST)
    assert not ingest.due(corpus, clock + dt.timedelta(minutes=1), "20261023")
    assert ingest.due(corpus, clock + dt.timedelta(minutes=31), "20261023")
    await perform(corpus, D1, [row(D0)])
    assert not ingest.due(corpus, clock + dt.timedelta(minutes=59), "20261023")


@pytest.mark.parametrize("code", ["005930", "00088K", "0000D0"])
async def test_registered_alphanumeric_code_keeps_identity_and_original_rows(corpus, code):
    sd = corpus / "screener"
    for name in ("daily_unadjusted.parquet", "daily_adjusted.parquet"):
        frame = pl.read_parquet(sd / name).with_columns(pl.lit(code).alias("code"))
        frame.write_parquet(sd / name)
    before = hashes(corpus)

    async def fetch(requested, first, last, index):
        assert requested == code
        result = sample(D2, [{**row(D0), "code": code}])
        result.code = code
        return result

    assert await ingest.run(corpus, codes=[code], days=[str(D0)], fetch=fetch,
                            now=dt.datetime.combine(D2, dt.time(22), KST)) == 0
    state = ingest.load(corpus)
    assert state["entries"][f"{code}:{D0}"]["status"] == "legacy"
    assert state["summary"]["failed_codes"] == 0
    assert hashes(corpus) == before


@pytest.mark.parametrize("code", ["00088k", "０００８８K", "0008_K", "00088K\n", "00088", "00088KK"])
def test_daily_code_rejects_malformed_or_noncanonical_identity(corpus, code):
    result = sample(D2, [])
    result.code = code
    with pytest.raises(ValueError, match="Invalid daily code"):
        ingest._sample(corpus, result)


def scope_fact(corpus, **dates):
    import json

    path = corpus / "screener/history_evidence.json"
    path.write_text(json.dumps({"schema_version": 1, "records": {CODE: {
        "checked_at": "2026-10-24T22:00:00+09:00", "sources": ["test:official_lifecycle"], **dates,
    }}}))
    return path.read_bytes()


async def test_prelisting_dates_are_excluded_but_missing_listed_dates_remain_unavailable(corpus):
    before = hashes(corpus)
    evidence = scope_fact(corpus, listing_date=str(D1))
    await perform(corpus, D2, [])
    state = ingest.load(corpus)
    assert state["summary"]["failed_codes"] == 0
    assert state["summary"]["excluded_dates"] == 1
    assert state["summary"]["unavailable_codes"] == 1
    assert state["missing_dates"][CODE]["dates"] == {
        str(D0): "pre_listing_history", str(D1): "missing_daily_history",
    }
    assert state["missing_dates"][CODE]["sources"] == ["test:official_lifecycle"]
    assert (corpus / "screener/history_evidence.json").read_bytes() == evidence
    assert hashes(corpus) == before


async def test_sourced_delisting_is_settled_without_deleting_stored_data(corpus):
    before = hashes(corpus)
    scope_fact(corpus, delisting_date=str(D0))
    await perform(corpus, D2, [])
    state = ingest.load(corpus)
    assert state["summary"]["excluded_dates"] == 2
    assert state["summary"]["excluded_codes"] == 1
    assert state["summary"]["failed_codes"] == state["summary"]["unavailable_codes"] == 0
    clock = dt.datetime.combine(D2, dt.time(22, 31), KST)
    assert not ingest.due(corpus, clock, "20261023")
    assert ingest.checked_recently(corpus, clock)
    assert hashes(corpus) == before


async def test_missing_provider_history_retries_without_reusing_the_empty_checkpoint(corpus):
    calls = []
    await perform(corpus, D1, [row(D0)], calls=calls)
    state = ingest.load(corpus)
    assert state["summary"]["failed_codes"] == 0 and state["summary"]["unavailable_codes"] == 1
    clock = dt.datetime.combine(D1, dt.time(22), KST)
    assert not ingest.checked_recently(corpus, clock + dt.timedelta(minutes=31))
    calls.clear()
    await perform(corpus, D1, [row(D0), row(D1, 200)], calls=calls)
    assert len(calls) == 1
    assert ingest.load(corpus)["summary"]["unavailable_codes"] == 0


def lifecycle_review(corpus, closed_from, *, reason="matured", checked_at=None):
    import gzip

    from hoga.api.screener_daily_lifecycle import LifecycleReview

    raw = f"{CODE} final closure {closed_from}".encode()
    digest = hashlib.sha256(raw).hexdigest()
    sources = corpus / "review-sources"
    sources.mkdir(exist_ok=True)
    (sources / f"{digest}.gz").write_bytes(gzip.compress(raw))
    review = LifecycleReview.model_validate({"records": {CODE: {
        "code": CODE, "name": "test", "reason": reason, "closed_from": str(closed_from),
        "checked_at": checked_at or "2026-10-24T22:00:00+09:00",
        "sources": [{"url": "https://kind.krx.co.kr/test-final-closure", "sha256": digest}],
    }}})
    return review, sources


async def test_lifecycle_reclassification_preserves_budget_samples_and_missing_old_dates(corpus):
    from hoga.api import screener_daily_lifecycle as lifecycle

    before = hashes(corpus)
    calls = []
    await perform(corpus, D2, [], calls=calls)
    await perform(corpus, D2, [], calls=calls)
    old = ingest.load(corpus)
    assert old["summary"]["unavailable_codes"] == 1
    review, sources = lifecycle_review(corpus, D2)
    identity = lifecycle.register(corpus, review, sources)
    now = dt.datetime.combine(D2 + dt.timedelta(days=1), dt.time(22), KST)
    summary = lifecycle.reclassify(corpus, now)
    new = ingest.load(corpus)
    assert new["attempts"] == old["attempts"]
    assert new["entries"] == old["entries"]
    assert new["missing_dates"][CODE]["sample_id"] == old["missing_dates"][CODE]["sample_id"]
    assert summary["last_attempt_at"] == old["summary"]["last_attempt_at"]
    assert summary["unavailable_codes"] == 1 and summary["retryable_unavailable_codes"] == 0
    assert summary["unavailable"][CODE] == "retired_history_unavailable"
    assert new["lifecycle_revision"] == identity
    assert not ingest.due(corpus, now, "20261023")
    assert hashes(corpus) == before


async def test_terminal_code_is_not_requested_but_active_unknown_code_still_retries(corpus):
    from hoga.api import screener_daily_lifecycle as lifecycle

    review, sources = lifecycle_review(corpus, D1)
    lifecycle.register(corpus, review, sources)
    calls = []
    await perform(corpus, D2, [], calls=calls)
    assert calls == []
    summary = ingest.load(corpus)["summary"]
    assert summary["skipped_codes"] == 1 and summary["provider_pages"] == 0
    assert summary["excluded_dates"] == 1
    assert summary["unavailable_codes"] == 1 and summary["retryable_unavailable_codes"] == 0
    # Removing a reviewed suppression explicitly re-enables the unchanged collection policy.
    lifecycle.register(corpus, lifecycle.LifecycleReview(records={}), sources)
    await perform(corpus, D2 + dt.timedelta(days=1), [], calls=calls)
    assert len(calls) == 1
    assert ingest.load(corpus)["summary"]["retryable_unavailable_codes"] == 1


async def test_future_closure_or_unobserved_review_does_not_suppress_active_collection(corpus):
    from hoga.api import screener_daily_lifecycle as lifecycle

    review, sources = lifecycle_review(corpus, D2 + dt.timedelta(days=2))
    lifecycle.register(corpus, review, sources)
    calls = []
    await perform(corpus, D2, [], calls=calls)
    assert len(calls) == 1
    assert ingest.load(corpus)["summary"]["retired_codes"] == 0


async def test_review_observed_in_the_future_is_not_used_for_suppression(corpus):
    from hoga.api import screener_daily_lifecycle as lifecycle

    review, sources = lifecycle_review(corpus, D0, checked_at="2026-10-25T22:00:00+09:00")
    lifecycle.register(corpus, review, sources)
    calls = []
    await perform(corpus, D2, [], calls=calls)
    assert len(calls) == 1
    assert ingest.load(corpus)["summary"]["retired_codes"] == 0


def test_lifecycle_review_object_cannot_be_edited_to_suppress_another_code(corpus):
    import json

    from hoga.api import screener_daily_lifecycle as lifecycle

    review, sources = lifecycle_review(corpus, D0)
    identity = lifecycle.register(corpus, review, sources)
    path = lifecycle.root(corpus) / "objects" / f"{identity}.json"
    payload = json.loads(path.read_text())
    payload["records"][CODE]["reason"] = "delisted"
    path.write_text(json.dumps(payload))
    with pytest.raises(ValueError, match="checksum mismatch"):
        lifecycle.reviewed(corpus)


def test_lifecycle_source_tampering_and_conflicting_dates_fail_closed(corpus):
    from hoga.api import screener_daily_lifecycle as lifecycle

    review, sources = lifecycle_review(corpus, D1)
    path = next(sources.glob("*.gz"))
    original = path.read_bytes()
    path.write_bytes(original + b"broken")
    with pytest.raises((ValueError, OSError)):
        lifecycle.register(corpus, review, sources)
    path.write_bytes(original)
    lifecycle.register(corpus, review, sources)
    scope_fact(corpus, delisting_date=str(D0))
    with pytest.raises(ValueError, match="Conflicting sourced lifecycle"):
        lifecycle.scope(corpus, dt.datetime.combine(D2, dt.time(22), KST))


async def test_retirement_does_not_clear_sticky_price_or_volume_disputes(corpus):
    from hoga.api import screener_daily_lifecycle as lifecycle

    await perform(corpus, D2, [row(D0, 101), row(D1)])
    before = ingest.load(corpus)["entries"][f"{CODE}:{D0}"]
    review, sources = lifecycle_review(corpus, D2)
    lifecycle.register(corpus, review, sources)
    lifecycle.reclassify(corpus, dt.datetime.combine(D2, dt.time(22, 30), KST))
    assert ingest.load(corpus)["entries"][f"{CODE}:{D0}"] == before


async def test_guard_publication_preserves_v2_observations_and_previous_snapshot(corpus):
    series.publish_pair(
        corpus,
        CODE,
        [row(D0)],
        [row(D0)],
        adjusted_as_of=D1.isoformat(),
        observed_at=dt.datetime.combine(D1, dt.time(22), KST).isoformat(),
        price_events=[],
    )
    old = series.load_snapshot(corpus)
    await perform(corpus, D1, [row(D0, 101), row(D1)])
    current = series.load_snapshot(corpus)
    assert current[1]["observations"] == old[1]["observations"]
    assert current[1]["quantity"] == old[1]["quantity"]
    assert series.load_snapshot(corpus, old[0]) == old
    assert "daily_ingest" not in old[1] and "daily_ingest" in current[1]


async def test_mass_zero_day_is_not_confirmed_or_saved(corpus):
    before = hashes(corpus)
    await perform(corpus, D2, [row(D0), row(D1, 0)])
    state = ingest.load(corpus)
    assert state["entries"][f"{CODE}:{D1}"]["status"] == "provisional"
    assert state["entries"][f"{CODE}:{D1}"]["reason"] == "mass_zero_volume_day"
    assert hashes(corpus) == before


@pytest.mark.parametrize("kind", ["code", "source_volume", "source_price", "duplicate", "future"])
async def test_malformed_observations_fail_closed(corpus, kind):
    before = hashes(corpus)

    async def fetch(code, first, last, index):
        value = sample(D2, [row(D1)])
        if kind == "code":
            value.code = "000660"
        elif kind == "source_volume":
            value.provider_rows[0]["trde_qty"] = ""
        elif kind == "source_price":
            value.provider_rows[0]["cur_prc"] = "101"
        elif kind == "duplicate":
            value.rows *= 2
        else:
            value.rows[0]["date"] = "2099-01-01"
        return value

    await ingest.run(corpus, codes=[CODE], days=[str(D1)], fetch=fetch, now=dt.datetime.combine(D2, dt.time(22), KST))
    assert hashes(corpus) == before
    assert ingest.load(corpus)["summary"]["failed_codes"] == 1
    assert ingest.load(corpus)["summary"]["confirmed"] == 0


async def test_commit_failure_remains_blocked_then_resumes_without_network(corpus, monkeypatch):
    from hoga.api.screener_daily_quality import current_guard, reason

    original = ingest.append_confirmed

    def failure(data_dir, state):
        assert reason(current_guard(data_dir), CODE, D1) == "daily_observation_unconfirmed"
        raise OSError("disk full")

    monkeypatch.setattr(ingest, "append_confirmed", failure)
    with pytest.raises(OSError, match="disk full"):
        await perform(corpus, D2, [row(D0), row(D1)])
    assert ingest.load(corpus)["summary"]["commit_pending"]
    monkeypatch.setattr(ingest, "append_confirmed", original)
    calls = []
    assert await perform(corpus, D2, [row(D0), row(D1)], calls=calls) == 1
    assert calls == []
    assert reason(current_guard(corpus), CODE, D1) is None


async def test_concurrent_stored_change_is_quarantined(corpus, monkeypatch):
    original = ingest.append_confirmed

    def competing_writer(data_dir, state):
        path = corpus / "screener/daily_unadjusted.parquet"
        base = pl.read_parquet(path)
        if base.height == 1:
            pl.concat([base, pl.DataFrame([{**row(D1, 101), "date": D1}], schema=_DAILY_PL_SCHEMA)]).write_parquet(path)
        return original(data_dir, state)

    monkeypatch.setattr(ingest, "append_confirmed", competing_writer)
    assert await perform(corpus, D2, [row(D0), row(D1)]) == 0
    assert ingest.load(corpus)["entries"][f"{CODE}:{D1}"]["status"] == "quarantined"
    assert (
        pl.read_parquet(corpus / "screener/daily_unadjusted.parquet").filter(pl.col("date") == D1)["volume"].item()
        == 101
    )


async def test_concurrency_is_three_and_retry_reuses_successes(corpus):
    import asyncio

    codes = [f"{i:06d}" for i in range(8)]
    active = peak = 0
    calls = []

    async def fetch(code, first, last, index):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        calls.append(code)
        await asyncio.sleep(0)
        active -= 1
        if code == codes[-1]:
            raise RuntimeError("temporary unavailable")
        value = sample(D1, [{**row(D1), "code": code}])
        value.code = code
        return value

    for _ in range(2):
        await ingest.run(
            corpus, codes=codes, days=[str(D1)], fetch=fetch, now=dt.datetime.combine(D1, dt.time(22), KST)
        )
    assert peak == 3
    assert len(calls) == len(codes) + 1
    assert ingest.load(corpus)["summary"]["reused_samples"] == 7
    assert ingest.load(corpus)["summary"]["provider_pages"] == 0  # the failed fake returns no page


def test_recent_window_has_bounded_catchup():
    state = {"entries": {"old": {"status": "provisional", "date": "2000-01-01"}}}
    first, last, days = ingest._bounds(state, [str(D0), str(D1)])
    assert (last - first).days <= ingest.MAX_CATCHUP_CALENDAR_DAYS
    assert days == [str(D0), str(D1)]


async def test_quarantine_applies_only_to_required_dates_and_preserves_live_current_day(corpus, monkeypatch):
    from hoga.api.models import ChangePctLeaf, PriceRangeLeaf
    from hoga.api.screener_daily_quality import legacy_coverage

    monkeypatch.setattr("hoga.api.trading_days.trading_days", lambda _: ["20261022", "20261023"])
    await perform(corpus, D1, [{**row(D0), "close": 101.0, "high": 101.0}, row(D1)])
    clock = dt.datetime.combine(D1, dt.time(22), KST)
    price = PriceRangeLeaf(id="p", type="price_range", params={"min": 1})
    change = ChangePctLeaf(id="c", type="change_pct", params={"op": "gte", "pct": 0, "timeframe": "D"})
    assert legacy_coverage(corpus, [price], [CODE], clock)[1] == {CODE}
    assert not legacy_coverage(corpus, [price], [CODE], clock, intraday=True)[1]
    assert legacy_coverage(corpus, [change], [CODE], clock, intraday=True)[1] == {CODE}


async def test_provider_has_fixed_page_budget_and_background_priority(monkeypatch):
    from types import SimpleNamespace

    from hoga.api.screener_daily_ingest_provider import collector

    calls = []

    async def capacity(scheduler, **kwargs):
        calls.append(kwargs)

    async def daily(client, code, first, last, *, run_page, **kwargs):
        for i in range(ingest.MAX_PAGES + 1):
            await run_page(None, i)
        return SimpleNamespace()

    monkeypatch.setattr("hoga.live.kiwoom_access.run_with_capacity", capacity)
    monkeypatch.setattr("hoga.live.kiwoom_daily_candles.fetch_daily_candles", daily)
    with pytest.raises(RuntimeError, match="page_budget"):
        await collector(object(), object())(CODE, D0, D1, 0)
    assert len(calls) == ingest.MAX_PAGES
    assert all(c["priority"] == "background" for c in calls)


def test_quarantined_leaf_does_not_change_or_expression_semantics(corpus):
    from hoga.api.models import PriceRangeLeaf, ScreenerUniverse
    from hoga.api.screener_scan import run_scan

    leaves = [PriceRangeLeaf(id=identity, type="price_range", params={"min": 1}) for identity in ("blocked", "valid")]
    kwargs = dict(
        conditions=leaves, universe=ScreenerUniverse(exclude_etf=False), daily_unavailable={"blocked": {CODE}}
    )
    sd = corpus / "screener"
    rows = run_scan(sd / "daily_adjusted.parquet", sd / "stocks.parquet", expression="A OR B", **kwargs)
    assert [r.code for r in rows] == [CODE]
    assert all(o.condition_id == "valid" for o in rows[0].occurrences)
    assert not run_scan(sd / "daily_adjusted.parquet", sd / "stocks.parquet", expression="A AND B", **kwargs)


async def test_weekend_scheduler_confirms_without_changing_trading_day_gate(corpus, monkeypatch):
    import asyncio

    from hoga.api import scheduler

    calls = []

    async def finished(_):
        return True

    async def trigger(_):
        calls.append("reconcile")
        return 0

    async def stop(_):
        raise asyncio.CancelledError

    monkeypatch.setattr(scheduler, "now_kst", lambda: dt.datetime.combine(D2, dt.time(22), KST))
    monkeypatch.setattr(scheduler, "_daily_run", finished)
    monkeypatch.setattr("hoga.api.screener.trigger_update", trigger)
    monkeypatch.setattr(scheduler.asyncio, "sleep", stop)
    with pytest.raises(asyncio.CancelledError):
        await scheduler._daily_loop(corpus)
    assert calls == ["reconcile"]


async def test_invalid_vendor_day_without_a_parsed_bar_is_quarantined(corpus):
    async def fetch(code, first, last, index):
        return sample(D2, [], violations=[{"date_yyyymmdd": "20261022", "reason": "ohlc_inconsistent"}])

    before = hashes(corpus)
    await ingest.run(corpus, codes=[CODE], days=[str(D0)], fetch=fetch, now=dt.datetime.combine(D2, dt.time(22), KST))
    assert ingest.load(corpus)["entries"][f"{CODE}:{D0}"]["status"] == "quarantined"
    assert hashes(corpus) == before


def test_raw_dispute_does_not_invalidate_independently_confirmed_v2_prices():
    from hoga.api.models import PriceRangeLeaf
    from hoga.api.screener_series_eval import evaluate_leaf
    from hoga.api.screener_series_values import Series

    bars = Series({D0: row(D0)}, {D0: row(D0)}, None, set(), daily_quality={D0: "daily_observation_conflict"})
    price = PriceRangeLeaf(id="p", type="price_range", params={"min": 1})
    events, incomplete = evaluate_leaf(price, CODE, bars, [D0], dt.datetime.combine(D0, dt.time(22), KST))
    assert len(events) == 1 and not incomplete
    assert bars.quantity(D0, D0, "raw") is None


async def test_early_same_day_attempt_cannot_suppress_the_closed_sweep(corpus):
    await perform(corpus, D1, [row(D0), row(D1, 1)], hour=16)
    now = dt.datetime.combine(D1, dt.time(22), KST)
    assert ingest.due(corpus, now, "20261023")
    assert not ingest.checked_recently(corpus, now)
    calls = []
    await perform(corpus, D1, [row(D0), row(D1, 200)], calls=calls)
    assert len(calls) == 1
    entry = ingest.load(corpus)["entries"][f"{CODE}:{D1}"]
    assert entry["status"] == "provisional" and entry["eligible_sample"]["row"]["volume"] == 200


async def test_http_status_and_scan_keep_quarantine_fields(corpus, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from hoga.api import screener
    from hoga.api.models import ScreenerResponse
    from hoga.api.screener_store import write_status

    await perform(corpus, D1, [row(D0, 101), row(D1)])
    write_status(corpus / "screener/status.json", last_raw_date="20261022", universe_size=1, derive_ms=0, now_ms=1)
    monkeypatch.setattr(screener, "now_kst", lambda: dt.datetime.combine(D1, dt.time(22), KST))
    monkeypatch.setattr("hoga.api.trading_days.trading_days", lambda _: ["20261022", "20261023"])
    app = FastAPI()
    app.include_router(screener.build_router(data_dir=corpus, bus=None))
    with TestClient(app) as client:
        status = client.get("/api/screener/status")
        assert status.status_code == 200
        assert status.json()["daily_ingest"]["quarantined"] == 1
        response = client.post(
            "/api/screener/scan",
            json={
                "basis": "eod",
                "conditions": [
                    {
                        "id": "amount",
                        "type": "trade_value_period",
                        "params": {
                            "mode": "date_range",
                            "start_date": str(D0),
                            "end_date": str(D0),
                            "min_eok": 0,
                            "timeframe": "D",
                            "include_open_bar": False,
                        },
                    }
                ],
                "universe": {"exclude_etf": False},
            },
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert ScreenerResponse.model_validate(body).model_dump(mode="json") == body
        assert body["rows"] == []
        assert body["daily_coverage"]["incomplete"][0]["reason"] == "daily_observation_conflict"
