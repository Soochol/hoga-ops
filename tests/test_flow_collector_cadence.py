"""Collector cadence contracts with an injected monotonic clock; no real sleeps."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from hoga.live import deriv_flow_collector, investor_flow_collector


@pytest.mark.asyncio
@pytest.mark.parametrize("module", [investor_flow_collector, deriv_flow_collector])
@pytest.mark.parametrize("work_seconds, expected_sleep", [(2.0, 7.5), (12.0, 0.1)])
async def test_ten_second_cycles_include_work_and_receipt_io(
    tmp_path, monkeypatch, module, work_seconds, expected_sleep,
):
    clock = [100.0]
    starts = []
    sleeps = []
    durations = []

    async def fetch(*_args):
        return None

    kwargs = {"fetch_market_fn" if module is investor_flow_collector else "fetch_fn": fetch}
    collector_type = (
        investor_flow_collector.InvestorFlowCollector
        if module is investor_flow_collector else deriv_flow_collector.DerivFlowCollector
    )
    collector = collector_type(
        data_dir=tmp_path, date_fn=lambda: "20260910", now_ms_fn=lambda: 1_000, **kwargs,
    )

    async def cycle():
        starts.append(clock[0])
        clock[0] += work_seconds

    def receipt_completed(_now_ms, duration_ms):
        durations.append(duration_ms)
        clock[0] += 0.5

    async def in_thread(fn, *args):
        return fn(*args)

    async def sleep(delay):
        sleeps.append(delay)
        clock[0] += delay
        if len(sleeps) == 2:
            raise asyncio.CancelledError

    monkeypatch.setattr(collector, "run_once", cycle)
    monkeypatch.setattr(collector.receipts, "cycle_completed", receipt_completed)
    # Replace only this module's asyncio binding, never the test runner's clock.
    monkeypatch.setattr(module, "asyncio", SimpleNamespace(
        get_running_loop=lambda: SimpleNamespace(time=lambda: clock[0]),
        to_thread=in_thread, sleep=sleep,
    ))
    with pytest.raises(asyncio.CancelledError):
        await collector._loop()

    assert sleeps == pytest.approx([expected_sleep, expected_sleep])
    assert starts[1] - starts[0] == pytest.approx(work_seconds + 0.5 + expected_sleep)
    assert durations == [round(work_seconds * 1000)] * 2
