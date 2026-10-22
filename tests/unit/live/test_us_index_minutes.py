import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

from hoga.live.us_index_minutes import UsIndexMinuteService, aggregate_minutes, parse_snapshot


def row(clock="143400", day="20261016", close="120.888"):
    return dict(stck_bsop_date=day, stck_cntg_hour=clock, optn_oprc="120", optn_hgpr="125",
                optn_lwpr="119", optn_prpr=close, cntg_vol="0")


def body(rows):
    return {"rt_cd": "0", "output2": rows}


@pytest.mark.parametrize("code", ["COMP", "SPX", "SOX"])
def test_actual_vendor_response_preserves_points_gaps_and_postclose(code):
    evidence = Path(__file__).resolve().parents[3] / "docs/research/2026-10-18-us-index-minute-probe.json"
    probes = json.loads(evidence.read_text())["probes"]
    probe = next(p for p in probes if p["request"]["FID_INPUT_ISCD"] == code)
    bars = parse_snapshot(probe["response"])
    assert len(bars) == 102
    assert len({b.t_ms for b in bars}) == 102
    assert bars[-1].trading_date == "20261016"
    assert bars[-1].close > 1000 and bars[-1].close != int(bars[-1].close)
    for tf in ("3m", "5m", "10m", "15m", "30m", "60m"):
        aggregated = aggregate_minutes(bars, tf)
        assert not aggregated or aggregated[0].t_ms >= bars[0].t_ms
        if code != "SPX" or tf != "60m":
            assert aggregated
        else:
            assert aggregated == []  # every 60m bucket has a missing/cut prefix or internal minute
        assert all(b.low <= b.open <= b.high and b.low <= b.close <= b.high for b in aggregated)


@pytest.mark.parametrize("day,utc_hour", [("20260710", 18), ("20260109", 19)])
def test_real_new_york_instants_handle_dst_and_kst_next_date(day, utc_hour):
    bar = parse_snapshot(body([row(day=day)]))[0]
    actual = datetime.fromtimestamp(bar.t_ms / 1000, UTC)
    assert (actual.hour, actual.minute) == (utc_hour, 34)
    assert bar.trading_date == day and bar.close == 120.888


@pytest.mark.parametrize("field,value", [("stck_cntg_hour", "250000"), ("stck_cntg_hour", "143401"),
                                       ("stck_cntg_hour", "123"), ("stck_bsop_date", ""),
                                       ("optn_prpr", "NaN"), ("optn_hgpr", "1")])
def test_invalid_snapshot_is_not_a_successful_empty_window(field, value):
    with pytest.raises((ValueError, KeyError)):
        parse_snapshot(body([{**row(), field: value}]))


def test_duplicate_and_blank_padding_contract():
    assert len(parse_snapshot(body([row(), row(), {}, {"stck_bsop_date": "00000000"}]))) == 1
    with pytest.raises(ValueError, match="conflicting"):
        parse_snapshot(body([row(), row(close="121")]))


def test_aggregation_omits_cut_prefix_and_gaps_but_retains_last_provisional_bucket():
    minutes = [34, 35, 36, 37, 38, 39, 40, 42, 43, 44, 45, 46]
    bars = parse_snapshot(body([row(f"14{minute:02}00") for minute in minutes]))
    aggregated = aggregate_minutes(bars, "5m")
    assert [datetime.fromtimestamp(b.t_ms / 1000, UTC).minute for b in aggregated] == [35, 45]
    assert aggregate_minutes(bars, "1m") == bars  # never fabricate the missing 14:41


@pytest.mark.asyncio
async def test_shared_snapshot_singleflight_ttl_stale_bypass_and_index_isolation():
    tick = [0.0]
    service = UsIndexMinuteService(clock=lambda: tick[0], wall_clock=lambda: 123.0)
    calls = []
    fail = [False]

    async def fetch(code):
        calls.append(code)
        await asyncio.sleep(0)
        if fail[0]:
            raise ValueError("malformed envelope")
        return body([row("143500"), row("143600")])

    client = SimpleNamespace(get_global_index_minute_snapshot=fetch)
    one, five = await asyncio.gather(service.get("COMP", "1m", client=client),
                                   service.get("COMP", "5m", client=client))
    assert calls == ["COMP"] and len(one[0]) == 2 and len(five[0]) == 1
    assert one[1].last_successful_check_at_ms == 123000
    await service.get("COMP", "1m", client=client)
    await service.get("SOX", "1m", client=client)
    assert calls == ["COMP", "SOX"]
    tick[0] = 61
    fail[0] = True
    stale = await service.get("COMP", "1m", client=client)
    assert stale[0] == one[0] and stale[1].refresh_status == "stale"
    assert stale[1].last_successful_check_at_ms == 123000
    await service.get("COMP", "1m", client=client)
    assert calls == ["COMP", "SOX", "COMP"]
    assert (await service.get("COMP", "1m", bypass=True))[1].refresh_status == "bypass"
    assert (await service.get("SPX", "1m"))[1].refresh_status == "unconfigured"
    assert (await service.get("SPX", "1m", client=client))[1].refresh_status == "error"
    await service.aclose()


@pytest.mark.asyncio
async def test_cancelling_one_waiter_does_not_cancel_shared_refresh_and_shutdown_owns_it():
    service = UsIndexMinuteService()
    entered, release = asyncio.Event(), asyncio.Event()

    async def fetch(_):
        entered.set()
        await release.wait()
        return body([row()])

    client = SimpleNamespace(get_global_index_minute_snapshot=fetch)
    waiter = asyncio.create_task(service.get("COMP", "1m", client=client))
    await entered.wait()
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    assert not service.pending["COMP"].cancelled()
    release.set()
    assert len((await service.get("COMP", "1m", client=client))[0]) == 1
    # A second index's detached refresh is cancelled and awaited at shutdown.
    release.clear()
    waiter = asyncio.create_task(service.get("SPX", "1m", client=client))
    await asyncio.sleep(0)
    await service.aclose()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    assert service.pending == {}


@pytest.mark.asyncio
async def test_manual_retry_bypasses_failed_ttl_but_keeps_singleflight_and_cooldown():
    tick = [0.0]
    service = UsIndexMinuteService(clock=lambda: tick[0])
    calls = []
    fail = [True]

    async def fetch(code):
        calls.append(code)
        await asyncio.sleep(0)
        if fail[0]:
            raise ValueError("offline")
        return body([row()])

    client = SimpleNamespace(get_global_index_minute_snapshot=fetch)
    await service.get("SPX", "1m", client=client)
    service.retry_failed("SPX")
    await service.get("SPX", "1m", client=client)
    service.retry_failed("SPX")
    await service.get("SPX", "1m", client=client)
    assert calls == ["SPX", "SPX"]  # a repeated click cannot hammer the vendor
    tick[0] = 3
    fail[0] = False
    service.retry_failed("SPX")
    first, second = await asyncio.gather(service.get("SPX", "1m", client=client),
                                         service.get("SPX", "1m", client=client))
    assert calls == ["SPX", "SPX", "SPX"]
    assert first[1].refresh_status == second[1].refresh_status == "normal"
    await service.aclose()
