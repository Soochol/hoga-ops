"""Preservation and behavioral differences using the real legacy/v2 runners."""

import datetime as dt
import hashlib
import json
from fractions import Fraction

import polars as pl
import pytest
from pydantic import ValidationError

from hoga.api import (
    screener_exclusions,
    screener_runner,
    screener_saves,
    screener_series_store as store,
    screener_series_values as values,
    trading_days,
)
from hoga.api.models import ScanRequest, ScreenerSaveWriteRequest
from hoga.api.screener_store import _DAILY_PL_SCHEMA
from hoga.util.timeenc import KST

DAYS = [dt.date(2018, 5, day) for day in (2, 3, 4)]
NOW = dt.datetime(2018, 5, 4, 16, tzinfo=KST)


@pytest.fixture
def corpus(tmp_path, monkeypatch):
    sdir = tmp_path / "screener"
    sdir.mkdir()
    rows = [
        dict(code="005930", date=day, open=100.0, high=100.0, low=100.0, close=100.0, volume=volume)
        for day, volume in zip(DAYS, [100, 90, 400], strict=True)
    ]
    frame = pl.DataFrame(rows, schema=_DAILY_PL_SCHEMA)
    for name in ("daily_unadjusted.parquet", "daily_adjusted.parquet"):
        frame.write_parquet(sdir / name)
    pl.DataFrame(
        dict(code=["005930"], name=["테스트 종목"], market=["KOSPI"], is_etf=[False], is_halted=[False])
    ).write_parquet(sdir / "stocks.parquet")
    pl.DataFrame(dict(code=["005930"], seg_start=[DAYS[0]], factor=[1.0])).write_parquet(sdir / "factors.parquet")
    (sdir / "status.json").write_text(
        json.dumps(dict(schema_version=1, last_raw_date="20180504", last_built_ms=1, universe_size=1, derive_ms=0))
    )
    (sdir / "saves.json").write_text('{"schema_version":1,"saves":[]}')
    monkeypatch.setattr(trading_days, "trading_days", lambda _: [day.strftime("%Y%m%d") for day in DAYS])
    rows_json = [{**row, "date": row["date"].isoformat()} for row in rows]
    store.publish_pair(
        tmp_path,
        "005930",
        rows_json,
        rows_json,
        adjusted_as_of="2018-05-04",
        observed_at=NOW.isoformat(),
        price_events=[],
    )
    return tmp_path


def request(basis=None, policy="separate_bases_v2", **params):
    return ScanRequest.model_validate(
        dict(
            calculation_policy=policy,
            basis="eod",
            conditions=[
                dict(
                    id="v",
                    type="new_high_vol_today",
                    params=dict(period=3, **params, **({"volume_basis": basis} if basis else {})),
                )
            ],
            universe={"exclude_etf": False},
        )
    )


def evidence(root, events=None, **changes):
    return store.publish_share_evidence(
        root,
        store.ShareEvidence.model_validate(
            dict(
                code="005930",
                instrument_id="stock:005930",
                verified_from="2018-05-02",
                verified_to="2018-05-04",
                observed_at=NOW.isoformat(),
                source="verified:test-fixture",
                events=events
                if events is not None
                else [
                    dict(
                        effective_date="2018-05-04",
                        kind="split",
                        numerator=5,
                        denominator=1,
                        source="verified:test-split",
                    )
                ],
                **changes,
            )
        ),
    )


def hashes(root):
    return {
        p.name: hashlib.sha256(p.read_bytes()).hexdigest()
        for p in (root / "screener").iterdir()
        if p.is_file() and not p.name.startswith(".")
    }


@pytest.mark.asyncio
async def test_real_old_new_comparison_and_preservation(corpus):
    before = hashes(corpus)
    old_req = request(policy="legacy_v1")
    old = await screener_runner.run_screener_scan(data_dir=corpus, req=old_req, now=NOW)
    evidence(corpus)
    raw = await screener_runner.run_screener_scan(data_dir=corpus, req=request("raw"), now=NOW)
    new = await screener_runner.run_screener_scan(data_dir=corpus, req=request("share_adjusted"), now=NOW)
    assert [row.code for row in old.rows] == ["005930"]
    assert [row.code for row in raw.rows] == ["005930"]
    assert new.rows == [] and new.bar_coverage.complete == 1
    assert raw.rows[0].trade_value_method == "ohlcv_estimate"
    assert raw.rows[0].occurrences[0].volume_evidence.compared_volume == "400"
    assert hashes(corpus) == before
    repeated = await screener_runner.run_screener_scan(data_dir=corpus, req=old_req, now=NOW)
    assert [row.model_dump() for row in old.rows] == [row.model_dump() for row in repeated.rows]


@pytest.mark.asyncio
async def test_missing_quantity_evidence_is_unknown_not_raw_fallback(corpus):
    result = await screener_runner.run_screener_scan(data_dir=corpus, req=request(), now=NOW)
    assert result.rows == []
    assert result.bar_coverage.complete == 0
    assert {item.reason for item in result.bar_coverage.incomplete} == {"share_evidence_unavailable"}


@pytest.mark.asyncio
async def test_cash_does_not_adjust_share_volume_and_future_event_does_not_leak(corpus):
    evidence(corpus, events=[dict(effective_date="2018-05-04", kind="cash", source="test:cash")])
    result = await screener_runner.run_screener_scan(data_dir=corpus, req=request(), now=NOW)
    assert len(result.rows) == 1
    pinned = store.load_snapshot(corpus)
    series = values.load_series(corpus, pinned[1], ["005930"])["005930"]
    assert series.quantity(DAYS[0], DAYS[-1], "share_adjusted") == 100


def test_fractional_quantity_and_no_invented_event_free_coverage(corpus):
    evidence(
        corpus,
        events=[
            dict(
                effective_date="2018-05-04",
                kind="consolidation",
                numerator=1,
                denominator=3,
                source="test:consolidation",
            )
        ],
    )
    _, manifest = store.load_snapshot(corpus)
    series = values.load_series(corpus, manifest, ["005930"])["005930"]
    assert series.quantity(DAYS[0], DAYS[-1], "share_adjusted") == Fraction(100, 3)
    assert series.quantity(DAYS[0], DAYS[1], "share_adjusted") == 100
    assert series.quantity(DAYS[0] - dt.timedelta(days=1), DAYS[-1], "share_adjusted") is None


def test_snapshot_immutable_and_bad_rows_do_not_poison_unrelated_days(corpus):
    pinned, manifest = store.load_snapshot(corpus)
    original = store.read_object(corpus, manifest["observations"]["005930"])
    changed = [dict(row, close=101.0, high=101.0) for row in original["adjusted"]]
    store.publish_pair(
        corpus,
        "005930",
        original["unadjusted"],
        changed,
        adjusted_as_of="2018-05-04",
        observed_at=NOW.isoformat(),
        price_events=[],
    )
    assert store.load_snapshot(corpus)[0] != pinned
    assert store.load_snapshot(corpus, pinned)[1] == manifest
    old = values.load_series(corpus, manifest, ["005930"])["005930"]
    assert old.prices[DAYS[0]]["close"] == 100


@pytest.mark.asyncio
async def test_new_saves_never_rewrite_old_file_and_cannot_overwrite_policy(corpus):
    path = corpus / "screener/saves.json"
    before = path.read_bytes()
    new = await screener_saves.create_save(
        corpus,
        req=ScreenerSaveWriteRequest(
            name="new", calculation_policy="separate_bases_v2", conditions=request().conditions
        ),
        id="new",
        now_ms=1,
    )
    assert path.read_bytes() == before
    assert screener_saves.load_saves(corpus).saves == [new]
    with pytest.raises(ValueError, match="복사"):
        await screener_saves.update_save(corpus, id="new", req=ScreenerSaveWriteRequest(name="old"), now_ms=2)


def test_legacy_exclusion_key_unchanged_and_new_bases_are_distinct():
    leaf = request(policy="legacy_v1").conditions[0]
    params = leaf.params.model_dump(mode="json")
    params.pop("volume_basis")
    params.pop("timeframe")
    params.pop("include_open_bar")
    expected = hashlib.sha256(
        json.dumps({"type": leaf.type, "params": params}, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    assert screener_exclusions.condition_key(leaf) == expected
    assert screener_exclusions.condition_key(
        request("raw").conditions[0], calculation_policy="separate_bases_v2"
    ) != screener_exclusions.condition_key(request().conditions[0], calculation_policy="separate_bases_v2")


def test_no_implicit_policy_change_and_no_adjusted_minute_volume():
    with pytest.raises(ValidationError):
        request("raw", policy="legacy_v1")
    with pytest.raises(ValidationError):
        request("share_adjusted", timeframe="1m")
    with pytest.raises(ValidationError):
        store.ShareEvent(effective_date=DAYS[0], kind="cash", numerator=2, source="test")


def test_concurrent_observations_keep_all_chunks(corpus):
    original = store.read_object(corpus, store.load_snapshot(corpus)[1]["observations"]["005930"])
    from concurrent.futures import ThreadPoolExecutor

    def publish(index):
        row = {**original["unadjusted"][0], "date": f"2018-04-{index:02}"}
        return store.publish_pair(
            corpus, "005930", [row], [row], adjusted_as_of="2018-05-04", observed_at=NOW.isoformat(), price_events=[]
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(publish, [26, 27]))
    latest = store.read_object(corpus, store.load_snapshot(corpus)[1]["observations"]["005930"])
    assert {"2018-04-26", "2018-04-27"} <= {row["date"] for row in latest["unadjusted"]}


async def test_archived_eod_replays_pinned_inputs_after_new_sources_and_exclusions(corpus):
    from hoga.api.screener_series_execution import replay_execution, saved_response
    from hoga.api.screener_series_runner import run_scan

    result = await run_scan(data_dir=corpus, req=request("raw"), now=NOW, record=True)
    identity = result.calculation.execution_id
    assert identity and result.calculation.replayable
    snapshot = result.calculation.snapshot_id
    evidence(corpus)
    leaf = request("raw").conditions[0]
    from hoga.api.models import ScreenerExclusionWrite

    await screener_exclusions.put_exclusion(
        corpus,
        ScreenerExclusionWrite(
            calculation_policy="separate_bases_v2", condition=leaf, code="005930", date=DAYS[-1], stock_name="test"
        ),
    )
    repeated = await replay_execution(corpus, identity)
    assert repeated.rows == result.rows
    assert repeated.calculation.snapshot_id == snapshot != store.load_snapshot(corpus)[0]
    assert saved_response(corpus, identity).rows == result.rows


async def test_archived_result_survives_code_change_but_exact_replay_refuses(corpus, monkeypatch):
    from hoga.api import screener_series_execution as execution
    from hoga.api.screener_series_runner import run_scan

    result = await run_scan(data_dir=corpus, req=request("raw"), now=NOW, record=True)
    identity = result.calculation.execution_id
    monkeypatch.setattr(execution, "code_revision", lambda: "different")
    with pytest.raises(ValueError, match="버전"):
        await execution.replay_execution(corpus, identity)
    assert execution.saved_response(corpus, identity).rows == result.rows


def test_daily_conversion_before_weekly_and_monthly_sum():
    from hoga.api.screener_series_eval import evaluate_leaf

    days = [dt.date(2026, 4, 1) + dt.timedelta(days=i) for i in range(36)]
    days = [day for day in days if day.weekday() < 5]
    original = {
        day: dict(open=100, high=100, low=100, close=100, volume=20 if day < dt.date(2026, 5, 4) else 60)
        for day in days
    }
    verified = store.ShareEvidence(
        code="005930",
        instrument_id="stock:005930",
        verified_from=days[0],
        verified_to=days[-1],
        observed_at=NOW,
        source="test",
        events=[store.ShareEvent(effective_date=dt.date(2026, 5, 5), kind="split", numerator=50, source="test")],
    )
    series = values.Series(original, original, verified, set())
    for timeframe in ("W", "M"):
        clock = dt.datetime.combine(days[-1], dt.time(16), KST)
        leaf = request("raw", timeframe=timeframe).conditions[0]
        leaf.params.period = 2
        raw, absent = evaluate_leaf(leaf, "005930", series, days, clock)
        assert not absent
        # Monthly raw volume is lower than April; use an explicit one-bar window
        # to verify the exact daily-before-aggregation conversion in both timeframes.
        leaf.params.period = 1
        adjusted_leaf = leaf.model_copy(
            update={"params": leaf.params.model_copy(update={"volume_basis": "share_adjusted"})}
        )
        adjusted, absent = evaluate_leaf(adjusted_leaf, "005930", series, days, clock)
        assert not absent and adjusted[0].volume_evidence.compared_volume == ("3120" if timeframe == "W" else "4120")
        if timeframe == "W":
            assert raw
            adjusted_leaf.params.period = 2
            changed, absent = evaluate_leaf(adjusted_leaf, "005930", series, days, clock)
            assert not absent and not changed


def test_original_conflict_and_quarantine_are_local_to_required_dates(corpus):
    identity, manifest = store.load_snapshot(corpus)
    observation = store.read_object(corpus, manifest["observations"]["005930"])
    changed = [{**observation["unadjusted"][0], "volume": 101}]
    store.publish_pair(
        corpus,
        "005930",
        changed,
        observation["adjusted"],
        adjusted_as_of="2018-05-04",
        observed_at=NOW.isoformat(),
        price_events=[],
        violations=[
            dict(date_yyyymmdd="19960918", reason="ohlc_inconsistent", detail="old bad row", basis="unadjusted")
        ],
    )
    _, new = store.load_snapshot(corpus)
    series = values.load_series(corpus, new, ["005930"])["005930"]
    assert series.original[DAYS[0]]["volume"] == 100
    assert series.quantity(DAYS[0], DAYS[-1], "raw") is None
    assert series.quantity(DAYS[-1], DAYS[-1], "raw") == 400
    assert store.load_snapshot(corpus, identity)[1] == manifest


def test_disk_failure_does_not_publish_partial_snapshot(corpus, monkeypatch):
    before = store.load_snapshot(corpus)
    write = store.atomic_write_json

    def fail(path, value):
        if path.name == "current.json":
            raise OSError("disk full")
        write(path, value)

    monkeypatch.setattr(store, "atomic_write_json", fail)
    with pytest.raises(OSError, match="disk full"):
        evidence(corpus)
    assert store.load_snapshot(corpus) == before


async def test_turnover_uses_original_prices_and_actual_amount_when_present(corpus):
    from hoga.api.screener_series_eval import evaluate_leaf

    _, manifest = store.load_snapshot(corpus)
    series = values.load_series(corpus, manifest, ["005930"])["005930"]
    series.prices[DAYS[-1]] = {**series.prices[DAYS[-1]], "close": 50, "open": 50, "high": 50, "low": 50}
    leaf = ScanRequest(conditions=[dict(id="amount", type="trade_value", params={"min_eok": 0})]).conditions[0]
    found, absent = evaluate_leaf(leaf, "005930", series, DAYS, NOW)
    assert not absent and found[0].amount_evidence.trade_value_won == 40000
    assert found[0].amount_evidence.method == "ohlcv_estimate"
    series.original[DAYS[-1]] = {**series.original[DAYS[-1]], "trade_value_won": 12345}
    found, absent = evaluate_leaf(leaf, "005930", series, DAYS, NOW)
    assert not absent and found[0].amount_evidence.trade_value_won == 12345
    assert found[0].amount_evidence.method == "provider_actual"


def test_http_policy_copy_validation_and_execution_wire(corpus, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from hoga.api import screener
    from hoga.api.screener_series_execution import build_router

    monkeypatch.setattr(screener, "now_kst", lambda: NOW)
    monkeypatch.setattr(screener_runner, "now_kst", lambda: NOW)
    app = FastAPI()
    app.include_router(screener.build_router(data_dir=corpus))
    client = TestClient(app)
    legacy = (corpus / "screener/saves.json").read_bytes()
    body = dict(name="new", **request("raw").model_dump(mode="json", exclude={"basis", "snapshot_id", "limit"}))
    saved = client.post("/api/screener/saves", json=body)
    assert saved.status_code == 201 and saved.json()["calculation_policy"] == "separate_bases_v2"
    assert (corpus / "screener/saves.json").read_bytes() == legacy
    invalid = {**body, "calculation_policy": "legacy_v1"}
    assert client.post("/api/screener/saves", json=invalid).status_code == 422
    result = client.post("/api/screener/scan", json=request("raw").model_dump(mode="json"))
    assert result.status_code == 200
    assert result.json()["calculation"]["snapshot_id"]
    assert result.json()["rows"][0]["occurrences"][0]["volume_evidence"]["basis"] == "raw"
    # Execution endpoints use the same response model; direct typed serialization
    # also covers null/partial evidence fields on legacy rows.
    assert "amount_evidence" in result.json()["rows"][0]["occurrences"][0]
    app2 = FastAPI()
    app2.include_router(build_router(corpus))
    assert (
        TestClient(app2).post("/executions", json=request(policy="legacy_v1").model_dump(mode="json")).status_code
        == 422
    )

    executions = TestClient(app2)
    created = executions.post("/executions", json=request("raw").model_dump(mode="json"))
    assert created.status_code == 201
    identity = created.json()["calculation"]["execution_id"]
    assert identity and created.json()["calculation"]["replayable"]
    loaded = executions.get(f"/executions/{identity}")
    repeated = executions.post(f"/executions/{identity}/replay")
    assert loaded.status_code == repeated.status_code == 200
    assert loaded.json()["rows"] == repeated.json()["rows"] == created.json()["rows"]


async def test_new_preparation_counts_only_missing_original_rows_and_preserves_legacy(corpus, monkeypatch):
    from hoga.api import screener_history_jobs as jobs, screener_series_jobs as series_jobs
    from hoga.api.models import HistoryJob
    from hoga.api.screener_series_runner import run_scan

    before = hashes(corpus)
    pinned = store.load_snapshot(corpus)
    observation = store.read_object(corpus, pinned[1]["observations"]["005930"])
    monkeypatch.setattr(series_jobs, "plans", lambda *_: (DAYS[0], DAYS[-1]))

    async def fetch(data_dir, code, first, last, **kwargs):
        assert kwargs["calculation_policy"] == "separate_bases_v2"
        store.publish_pair(
            data_dir,
            code,
            observation["unadjusted"],
            observation["adjusted"],
            adjusted_as_of="2018-05-04",
            observed_at=NOW.isoformat(),
            price_events=[],
        )
        rows = [{**row, "date": dt.date.fromisoformat(row["date"])} for row in observation["unadjusted"]]
        return pl.DataFrame(rows), pl.DataFrame(rows)

    monkeypatch.setattr(jobs, "fetch_pair", fetch)
    # Exercise the first-preparation branch with a baseline but no current pointer.
    (store.root(corpus) / "current.json").unlink()
    job = HistoryJob(
        id="prepare",
        status="queued",
        request=request("raw"),
        codes=["005930"],
        total=0,
        done=0,
        written_rows=0,
        errors={},
        started_at_ms=1,
    )
    await series_jobs.run_job(corpus, job)
    assert job.written_rows == 0 and job.done == 1
    assert hashes(corpus) == {**before, "history_job.json": hashes(corpus)["history_job.json"]}
    result = await run_scan(data_dir=corpus, req=request("raw"), now=NOW)
    assert len(result.rows) == 1


def test_baseline_inventory_hash_and_copy_failure(corpus, monkeypatch):
    baseline = json.loads((store.root(corpus) / "baseline.json").read_text())["id"]
    folder = store.root(corpus) / "legacy" / baseline
    metadata = json.loads((folder / "manifest.json").read_text())
    assert metadata["inventory"]["daily_unadjusted.parquet"] == dict(
        rows=3, codes=1, first="2018-05-02", last="2018-05-04"
    )
    assert "calendar.json" in metadata["files"]
    before = hashes(corpus)
    (store.root(corpus) / "baseline.json").unlink()

    def fail(*args):
        raise OSError("copy failed")

    monkeypatch.setattr(store.shutil, "copyfile", fail)
    with pytest.raises(OSError, match="copy failed"):
        store.ensure_baseline(corpus)
    assert not (store.root(corpus) / "baseline.json").exists()
    assert hashes(corpus) == before


async def test_intraday_failure_falls_back_to_actual_pinned_eod_cutoff(corpus, monkeypatch):
    from types import SimpleNamespace

    from hoga.api import screener_intraday

    tomorrow = NOW + dt.timedelta(days=3)

    async def unavailable(**kwargs):
        return SimpleNamespace(
            rows=pl.DataFrame(),
            warnings=["intraday_unavailable"],
            fetched_at_ms=None,
            failure={"reason": "test_provider_failure"},
        )

    monkeypatch.setattr(screener_intraday, "build_intraday_overlay", unavailable)
    monkeypatch.setattr(screener_intraday, "intraday_overlay_bypassed", lambda _: False)
    req = request("raw").model_copy(update={"basis": "intraday"})
    result = await screener_runner.run_screener_scan(data_dir=corpus, req=req, now=tomorrow)
    assert [row.code for row in result.rows] == ["005930"]
    assert "intraday_fallback_eod" in result.warnings
    assert result.intraday_failure == {"reason": "test_provider_failure"}
    assert result.basis_at_ms == int(NOW.replace(hour=15, minute=30).timestamp() * 1000)


def test_adjusted_quarantine_cannot_fall_back_to_an_older_valid_observation(corpus):
    observation = store.read_object(corpus, store.load_snapshot(corpus)[1]["observations"]["005930"])
    store.publish_pair(
        corpus,
        "005930",
        observation["unadjusted"],
        [],
        adjusted_as_of="2018-05-04",
        observed_at=NOW.isoformat(),
        price_events=[],
        violations=[
            dict(date_yyyymmdd="20180504", reason="ohlc_inconsistent", detail="bad replacement", basis="adjusted")
        ],
    )
    series = values.load_series(corpus, store.load_snapshot(corpus)[1], ["005930"])["005930"]
    assert DAYS[-1] not in series.prices
    assert series.quantity(DAYS[-1], DAYS[-1], "raw") == 400
    assert DAYS[0] in series.prices


def test_snapshot_input_cannot_be_silently_ignored_by_legacy_or_intraday():
    for updates in ({"calculation_policy": "legacy_v1"}, {"basis": "intraday"}):
        data = request().model_dump(mode="json")
        data.update(snapshot_id="a" * 64, **updates)
        with pytest.raises(ValidationError, match="스냅샷"):
            ScanRequest.model_validate(data)


@pytest.mark.parametrize("price_factor,rate", [(0.9995, "-0.05"), (0.9976, "-0.24")])
async def test_small_price_events_keep_vendor_prices_and_do_not_reprice_quantity(corpus, price_factor, rate):
    observation = store.read_object(corpus, store.load_snapshot(corpus)[1]["observations"]["005930"])
    adjusted = [
        {**row, **{key: row[key] * price_factor for key in ("open", "high", "low", "close")}, "volume": 12345}
        if row["date"] != DAYS[-1].isoformat()
        else row
        for row in observation["adjusted"]
    ]
    store.publish_pair(
        corpus,
        "005930",
        observation["unadjusted"],
        adjusted,
        adjusted_as_of="2018-05-04",
        observed_at=NOW.isoformat(),
        price_events=[dict(effective_date="20180504", provider_kind="4", rate=rate)],
    )
    evidence(corpus, events=[dict(effective_date="2018-05-04", kind="cash", source="test:verified-cash")])
    series = values.load_series(corpus, store.load_snapshot(corpus)[1], ["005930"])["005930"]
    assert series.prices[DAYS[0]]["close"] == 100 * price_factor
    assert series.prices[DAYS[0]]["volume"] == 12345  # retained as a diagnostic provider observation
    assert series.quantity(DAYS[0], DAYS[-1], "share_adjusted") == 100
    result = await screener_runner.run_screener_scan(data_dir=corpus, req=request(), now=NOW)
    assert len(result.rows) == 1 and result.rows[0].occurrences[0].volume_evidence.compared_volume == "400"
