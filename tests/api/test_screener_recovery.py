"""Recovery boundaries: immutable inputs, restart, quarantine and actual runner comparison."""

import datetime as dt
import json

import polars as pl
import pytest
from pydantic import ValidationError

from hoga.api import screener_recovery as recovery, screener_series_store as store, trading_days
from hoga.api.models import ScanRequest
from hoga.api.screener_store import _DAILY_PL_SCHEMA
from hoga.util.timeenc import KST

DAYS = [dt.date(2018, 5, day) for day in (2, 3, 4)]
NOW = dt.datetime(2018, 5, 5, 16, tzinfo=KST)
CODES = ["005930", "000660"]


@pytest.fixture
def corpus(tmp_path, monkeypatch):
    sdir = tmp_path / "screener"
    sdir.mkdir()
    (sdir / ".writer.lock").touch()
    frame = pl.DataFrame([
        dict(code=code, date=day, open=100., high=100., low=100., close=100., volume=volume)
        for code in CODES for day, volume in zip(DAYS[1:], [90, 400], strict=True)
    ], schema=_DAILY_PL_SCHEMA)
    for name in ("daily_unadjusted.parquet", "daily_adjusted.parquet"):
        frame.write_parquet(sdir / name)
    pl.DataFrame(dict(code=CODES, name=["삼성전자", "SK하이닉스"], market=["KOSPI"]*2,
                      is_etf=[False]*2, is_halted=[False]*2)).write_parquet(sdir / "stocks.parquet")
    pl.DataFrame(dict(code=CODES, seg_start=[DAYS[0]]*2, factor=[1., 1.])).write_parquet(sdir / "factors.parquet")
    (sdir / "status.json").write_text(json.dumps(dict(
        schema_version=1, last_raw_date="20180504", last_built_ms=1, universe_size=2, derive_ms=0,
    )))
    (sdir / "saves.json").write_text('{"schema_version":1,"saves":[]}')
    monkeypatch.setattr(trading_days, "trading_days", lambda _: {day.strftime("%Y%m%d") for day in DAYS})
    return tmp_path


def request():
    return ScanRequest.model_validate(dict(conditions=[dict(type="new_high_vol_today", id="v", params={"period":3})],
                                         universe={"exclude_etf": False}))


def spec(codes=None):
    return recovery.RecoverySpec(adjusted_as_of=NOW.date(), clock=NOW,
                                 confirmation_policy="legacy_unverified",
                                 targets=[recovery.RecoveryTarget(code=code, first=DAYS[0], last=DAYS[-1],
                                                                 reason="test") for code in (codes or CODES)],
                                 comparisons=[request()])


def observation(target, anchor):
    rows = [dict(code=target.code, date=day.isoformat(), open=100., high=100., low=100., close=100.,
                 volume=volume, complete=True) for day, volume in zip(DAYS, [100,90,400],strict=True)]
    return dict(code=target.code, unadjusted=rows, adjusted=rows, adjusted_as_of=anchor.isoformat(),
                observed_at=NOW.isoformat(), price_events=[], provider_rows={}, violations=[])


async def fetch(target, anchor, check):
    check()
    return observation(target, anchor)


async def execute(root, identity, **kwargs):
    return await recovery.run(root, identity, fetch=kwargs.pop("fetch", fetch), now=lambda:NOW, **kwargs)


async def test_adds_only_v2_and_keeps_existing_files_and_share_unknown(corpus):
    before = recovery.protected_hashes(corpus)
    identity = recovery.create_plan(corpus, spec())
    job = await execute(corpus, identity)
    assert job.status == "complete" and job.preserved
    assert all(item.added_original_days == 1 and item.status == "observed" for item in job.items.values())
    assert all(not item.share_evidence_ready for item in job.items.values())
    assert recovery.protected_hashes(corpus) == before
    assert recovery.load_job(corpus, identity) == job
    repeated = await execute(corpus, identity, fetch=lambda *_:pytest.fail("must not refetch"))
    assert repeated == job


async def test_actual_old_new_results_archived_replay_and_preservation(corpus, tmp_path_factory):
    from hoga.api.screener_recovery_compare import compare

    identity = recovery.create_plan(corpus, spec())
    await execute(corpus, identity)
    result = await compare(corpus, identity, tmp_path_factory.mktemp("outside") / "comparison")
    assert result["production_preserved"]
    row = result["results"][0]
    assert row["legacy_equal"] and row["legacy_before"]["rows"] == []
    assert {r["code"] for r in row["variants"]["raw"]["rows"]} == set(CODES)
    assert row["variants"]["share_adjusted"]["rows"] == []
    assert all(r["replay_equal"] for r in row["executions"].values())
    assert row["codes"]["share_adjusted"]["005930"]["unavailable_reasons"] == ["share_evidence_unavailable"]


async def test_conflict_is_quarantined_per_symbol_not_overwritten(corpus):
    async def conflict(target, anchor, check):
        payload = observation(target, anchor)
        if target.code == "005930":
            payload["unadjusted"] = [dict(r, volume=901) if r["date"] == DAYS[1].isoformat() else r
                                     for r in payload["unadjusted"]]
        return payload
    identity = recovery.create_plan(corpus, spec())
    job = await execute(corpus, identity, fetch=conflict)
    assert job.status == "partial" and job.preserved
    assert job.items["005930"].conflict_dates == [DAYS[1]]
    assert job.items["005930"].status == "quarantined"
    assert job.items["000660"].status == "observed"
    # Quarantine is a completed observation, not an invitation to refetch forever.
    resumed = await execute(corpus, identity, fetch=lambda *_:pytest.fail("must not refetch"), resume=True)
    assert resumed == job


async def test_failed_symbol_is_retryable_without_repeating_success(corpus):
    calls = []
    async def one_failure(target, anchor, check):
        calls.append(target.code)
        if target.code == "005930":
            raise ValueError("malformed provider response")
        return observation(target, anchor)
    identity = recovery.create_plan(corpus, spec())
    job = await execute(corpus, identity, fetch=one_failure)
    assert job.status == "partial" and job.items["000660"].status == "observed"
    async def retry(target, anchor, check):
        assert target.code == "005930"
        return observation(target, anchor)
    job = await execute(corpus, identity, fetch=retry, resume=True)
    assert job.status == "complete" and calls == CODES


async def test_staged_response_survives_publish_interruption(corpus, monkeypatch):
    identity = recovery.create_plan(corpus, spec(["005930"]))
    publish = store.publish_pair
    def stopped(*args, **kwargs):
        raise recovery.RecoveryStop("injected_interrupt")
    monkeypatch.setattr(store, "publish_pair", stopped)
    first = await execute(corpus, identity)
    assert first.status == "interrupted" and first.items["005930"].candidate_id
    monkeypatch.setattr(store, "publish_pair", publish)
    second = await execute(corpus, identity, resume=True, fetch=lambda *_:pytest.fail("staged response must be reused"))
    assert second.status == "complete" and second.items["005930"].added_original_days == 1


async def test_page_cancellation_and_explicit_resume(corpus):
    identity = recovery.create_plan(corpus, spec())
    async def stop(target, anchor, check):
        recovery.cancel(corpus, identity)
        check()
        pytest.fail("cancel must stop before another page")
    job = await execute(corpus, identity, fetch=stop)
    assert job.status == "interrupted" and job.error == "cancel_requested"
    with pytest.raises(recovery.RecoveryStop, match="explicit_resume"):
        await execute(corpus, identity)
    assert (await execute(corpus, identity, resume=True)).status == "complete"


async def test_anchor_rollover_stops_before_fetch(corpus):
    identity = recovery.create_plan(corpus, spec())
    job = await recovery.run(corpus, identity, fetch=lambda *_:pytest.fail("must not fetch"),
                             now=lambda:NOW+dt.timedelta(days=1))
    assert job.status == "interrupted" and job.error == "adjusted_as_of_changed"


async def test_wrong_collector_anchor_never_publishes(corpus):
    identity = recovery.create_plan(corpus, spec())
    async def wrong(target, anchor, check):
        return observation(target, anchor-dt.timedelta(days=1))
    job = await execute(corpus, identity, fetch=wrong)
    assert job.status == "interrupted" and job.error == "collector_identity_or_anchor_mismatch"
    assert store.load_snapshot(corpus) is None


async def test_modified_inputs_stop_the_batch_and_report_not_preserved(corpus):
    identity = recovery.create_plan(corpus, spec())
    async def changed(target, anchor, check):
        (corpus / "screener/saves.json").write_text("changed by another writer")
        check()
    job = await execute(corpus, identity, fetch=changed)
    assert job.status == "failed" and not job.preserved
    assert store.load_snapshot(corpus) is None


def test_no_recovery_of_pending_legacy_journal(corpus):
    marker = corpus / "screener/history_publish.json"
    marker.write_text('{"files":[]}')
    with pytest.raises(recovery.RecoveryStop, match="pending_legacy"):
        recovery.create_plan(corpus, spec())
    assert marker.exists()


async def test_owner_conflict_and_changed_code_refuse_network(corpus, monkeypatch):
    identity = recovery.create_plan(corpus, spec())
    with recovery.owner(corpus), pytest.raises(recovery.RecoveryStop, match="already_running"):
        await execute(corpus, identity)
    monkeypatch.setattr(recovery, "code_revision", lambda:"different")
    with pytest.raises(recovery.RecoveryStop, match="code_or_runtime"):
        await execute(corpus, identity)


@pytest.mark.parametrize("violation_date,quarantined", [("19960918",False),("20180503",True),("invalid",True)])
async def test_bad_dates_only_block_relevant_windows(corpus, violation_date, quarantined):
    identity = recovery.create_plan(corpus, spec(["005930"]))
    async def invalid(target, anchor, check):
        payload = observation(target, anchor)
        payload["violations"] = [dict(date_yyyymmdd=violation_date, reason="ohlc_inconsistent", basis="unadjusted")]
        return payload
    job = await execute(corpus, identity, fetch=invalid)
    assert (job.items["005930"].status == "quarantined") is quarantined


def test_rejects_duplicate_targets_future_rows_and_uncovered_calendar(corpus):
    with pytest.raises(ValidationError, match="중복"):
        spec(["005930","005930"])
    payload = spec().model_dump()
    payload["targets"][0]["last"] = NOW.date()
    with pytest.raises(ValidationError, match="완료된"):
        recovery.RecoverySpec.model_validate(payload)
    request_spec = spec()
    request_spec.targets[0].first = dt.date(1990,1,1)
    with pytest.raises(ValueError, match="달력"):
        recovery.create_plan(corpus, request_spec)


def test_cached_token_does_not_issue_invalidate_or_copy_credentials(tmp_path):
    from hoga.api.screener_recovery_cli import CachedToken

    path = tmp_path / "token.json"
    original = json.dumps(dict(access_token="fake-existing", environment="real",
                               expires_at=(dt.datetime.now(KST)+dt.timedelta(hours=1)).isoformat()))
    path.write_text(original)
    provider = CachedToken(path)
    assert provider.get_token() == "fake-existing"
    provider.invalidate()
    with pytest.raises(recovery.RecoveryStop):
        provider.get_token()
    assert path.read_text() == original


async def test_standalone_refuses_worktree_before_reading_token(corpus, monkeypatch):
    from hoga.api import screener_recovery_cli as cli

    checkout = corpus / "worktree"
    checkout.mkdir()
    (checkout / ".git").write_text("gitdir: elsewhere")
    monkeypatch.setattr(cli, "__file__", str(checkout / "hoga/api/screener_recovery_cli.py"))
    with pytest.raises(recovery.RecoveryStop, match="primary_checkout"):
        await cli.standalone(corpus, "unused", resume=False, server_port=0)


def test_standalone_refuses_an_active_server():
    import socket

    from hoga.api.screener_recovery_cli import server_stopped

    with socket.socket() as server:
        server.bind(("127.0.0.1",0))
        server.listen()
        with pytest.raises(recovery.RecoveryStop, match="server_is_running"):
            server_stopped(server.getsockname()[1])


async def test_newly_created_saved_v2_file_stops_recovery(corpus):
    identity = recovery.create_plan(corpus, spec())
    (corpus / "screener/saves.v2.json").write_text("{}")
    with pytest.raises(recovery.RecoveryStop, match="legacy_inputs_changed"):
        await execute(corpus, identity)


async def test_provider_rows_outside_fixed_plan_are_never_published(corpus):
    identity = recovery.create_plan(corpus, spec())
    async def wrong(target, anchor, check):
        result = observation(target, anchor)
        result["unadjusted"][0]["code"] = "INVALID"
        return result
    job = await execute(corpus, identity, fetch=wrong)
    assert job.status == "interrupted" and job.error == "collector_rows_outside_plan"
    assert store.load_snapshot(corpus) is None


def test_tampered_plan_is_rejected(corpus):
    identity = recovery.create_plan(corpus,spec())
    path = recovery._path(corpus,identity,"plan")
    payload = json.loads(path.read_text())
    payload["targets"][0]["reason"] = "tampered"
    path.write_text(json.dumps(payload))
    with pytest.raises(ValueError,match="지문"):
        recovery.load_plan(corpus,identity)


async def test_collector_pins_anchor_and_uses_page_governor(corpus, monkeypatch):
    from hoga.api.screener_recovery_provider import collector
    from hoga.live import kiwoom_access, kiwoom_daily_candles
    from hoga.live.candle_models import LiveCandle
    from hoga.live.kiwoom_rest import Page

    calls, governed = [], []
    async def capacity(*args, **kwargs):
        governed.append((kwargs["api_id"],kwargs["priority"]))
        return Page(rows=[],cont=False,next_key="")
    async def daily(client, code, first, last, **kwargs):
        calls.append((first,last,kwargs["adjusted_as_of"]))
        await kwargs["run_page"](lambda _:None,0)
        from hoga.live.kiwoom_daily_candles import DailyCandleFetchResult
        candles = [LiveCandle(t_ms=int(dt.datetime.combine(day,dt.time(9),KST).timestamp()*1000),
                             open=100.,high=100.,low=100.,close=100.,volume=10) for day in DAYS]
        return DailyCandleFetchResult(candles=candles,violations=[],adjustment_events=[],source_rows=[])
    monkeypatch.setattr(kiwoom_access,"run_with_capacity",capacity)
    monkeypatch.setattr(kiwoom_daily_candles,"fetch_daily_candles",daily)
    clock = [NOW]
    async def pause(seconds):
        clock[0] += dt.timedelta(seconds=seconds)
    payload = await collector(corpus,client=object(),scheduler=object(),clock=lambda:clock[0],pause=pause)(
        spec().targets[0],NOW.date(),lambda:None,
    )
    assert calls == [("20180502","20180504",None),("20180502","20180504","20180505")]*2
    assert governed == [("ka10081","background")]*4
    assert all(row["complete"] for row in payload["unadjusted"])
    assert payload["confirmation"]["session_scope"] == "provider_daily_all_sessions"
