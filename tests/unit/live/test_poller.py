"""Stage 4 — Poller tests. Audit overrides Δ1-Δ6 integrated."""
import asyncio
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import pytest

from hoga.live.kis_client import KIS_KST, KisRateLimitError
from hoga.live.kis_models import (
    KisBrokerEntry,
    KisBrokers,
    KisOrderbook,
    KisTrade,
    OrderbookLevel,
)
from hoga.live.poller import (
    LivePoller, LivePollerConfig, _market_phase, _should_poll_now,
)
from hoga.live.snapshot import SnapshotKind
from hoga.live.writer import LiveWriter


def _ob(code: str, t_ms: int = 1) -> KisOrderbook:
    return KisOrderbook(
        code=code, t_ms=t_ms,
        asks=[OrderbookLevel(price=i, qty=i) for i in range(1, 11)],
        bids=[OrderbookLevel(price=i, qty=i) for i in range(1, 11)],
        total_ask_qty=55, total_bid_qty=55,
    )


def _brokers(code: str, t_ms: int = 1) -> KisBrokers:
    return KisBrokers(
        code=code, t_ms=t_ms,
        buy_top=[KisBrokerEntry(name=f"b{i}", qty=i) for i in range(1, 6)],
        sell_top=[KisBrokerEntry(name=f"s{i}", qty=i) for i in range(1, 6)],
    )


def _mk_kis(*, trades: list[KisTrade] | None = None) -> Any:
    kis = AsyncMock()
    kis.fetch_orderbook.side_effect = lambda code: _ob(code)
    kis.fetch_overtime_orderbook.side_effect = lambda code: _ob(code)
    kis.fetch_trades.return_value = trades or []
    kis.fetch_overtime_trades.return_value = trades or []
    kis.fetch_brokers.side_effect = lambda code: _brokers(code)
    return kis


@pytest.mark.asyncio
async def test_one_cycle_writes_3_snapshots_per_code(tmp_path: Path, monkeypatch) -> None:
    regular_ms = int(datetime(2026, 5, 27, 10, 0, 0, tzinfo=KIS_KST).timestamp() * 1000)
    monkeypatch.setattr("hoga.live.poller._now_ms", lambda: regular_ms)
    kis = _mk_kis(trades=[KisTrade(t_ms=1, price=100, qty=1, side=1, side_source="inferred")])
    writer = LiveWriter(tmp_path / "live")
    poller = LivePoller(kis, writer, LivePollerConfig(
        codes_fn=lambda: ["005930"], date_fn=lambda: "20260527",
    ))
    await poller.run_one_cycle()

    lines = (tmp_path / "live" / "20260527" / "005930.jsonl").read_text().splitlines()
    assert len(lines) == 3  # ob + trade(batch) + broker

    import json
    parsed = [json.loads(line) for line in lines]
    kinds = [p["kind"] for p in parsed]
    assert kinds == ["ob", "trade", "broker"]
    # all three share t_ms
    assert parsed[0]["t_ms"] == parsed[1]["t_ms"] == parsed[2]["t_ms"]
    # phase tag present
    assert parsed[0]["payload"]["phase"] == "regular"
    assert parsed[1]["payload"]["phase"] == "regular"
    assert parsed[2]["payload"]["phase"] == "regular"


@pytest.mark.asyncio
async def test_cycle_increments_kis_calls(tmp_path: Path, monkeypatch) -> None:
    regular_ms = int(datetime(2026, 5, 27, 10, 0, 0, tzinfo=KIS_KST).timestamp() * 1000)
    monkeypatch.setattr("hoga.live.poller._now_ms", lambda: regular_ms)
    kis = _mk_kis()
    writer = LiveWriter(tmp_path / "live")
    poller = LivePoller(kis, writer, LivePollerConfig(
        codes_fn=lambda: ["005930", "000660"], date_fn=lambda: "20260527",
    ))
    await poller.run_one_cycle()
    # 2 codes × 3 calls each = 6
    assert poller.kis_calls_today == 6


@pytest.mark.asyncio
async def test_empty_trades_still_emits_snapshot(tmp_path: Path, monkeypatch) -> None:
    regular_ms = int(datetime(2026, 5, 27, 10, 0, 0, tzinfo=KIS_KST).timestamp() * 1000)
    monkeypatch.setattr("hoga.live.poller._now_ms", lambda: regular_ms)
    kis = _mk_kis(trades=[])
    writer = LiveWriter(tmp_path / "live")
    poller = LivePoller(kis, writer, LivePollerConfig(
        codes_fn=lambda: ["005930"], date_fn=lambda: "20260527",
    ))
    await poller.run_one_cycle()
    import json
    lines = (tmp_path / "live" / "20260527" / "005930.jsonl").read_text().splitlines()
    trade = json.loads(lines[1])
    assert trade["kind"] == "trade"
    assert trade["payload"]["trades"] == []


@pytest.mark.asyncio
async def test_rate_limit_skips_code_and_moves_on(tmp_path: Path, monkeypatch) -> None:
    """Post-ADR-0049: retry lives in KisClient._get, not the poller. When the
    AsyncMock raises ``KisRateLimitError`` the poller treats that as
    "client already exhausted retries" — it logs a giveup warning, skips
    this code, and proceeds to the next one. From the poller's view there
    is exactly ONE call per fetch method (the inner retries are an
    implementation detail of the client and invisible to this mock).
    """
    regular_ms = int(datetime(2026, 5, 27, 10, 0, 0, tzinfo=KIS_KST).timestamp() * 1000)
    monkeypatch.setattr("hoga.live.poller._now_ms", lambda: regular_ms)

    kis = AsyncMock()
    kis.fetch_orderbook.side_effect = KisRateLimitError("rate limited")
    kis.fetch_trades.return_value = []
    kis.fetch_brokers.return_value = _brokers("005930")
    writer = LiveWriter(tmp_path / "live")
    poller = LivePoller(kis, writer, LivePollerConfig(
        codes_fn=lambda: ["005930"], date_fn=lambda: "20260527",
    ))
    await poller.run_one_cycle()

    # Poller called fetch_orderbook exactly once — no inner retry. (Client's
    # retry, if any, was opaque to this AsyncMock.)
    assert kis.fetch_orderbook.await_count == 1
    # No JSONL written for this code — the cycle skipped it.
    assert not (tmp_path / "live" / "20260527" / "005930.jsonl").exists()
    # Code does NOT advance _last_success_cycle on a giveup.
    assert "005930" not in poller._last_success_cycle


@pytest.mark.asyncio
async def test_starvation_guard_orders_unsuccessful_codes_first(tmp_path: Path, monkeypatch) -> None:
    """Eng C6: codes that haven't succeeded recently come first."""
    regular_ms = int(datetime(2026, 5, 27, 10, 0, 0, tzinfo=KIS_KST).timestamp() * 1000)
    monkeypatch.setattr("hoga.live.poller._now_ms", lambda: regular_ms)

    succeeded: list[str] = []

    async def ob_for(code):
        succeeded.append(code)
        return _ob(code)

    kis = AsyncMock()
    kis.fetch_orderbook.side_effect = ob_for
    kis.fetch_trades.return_value = []
    kis.fetch_brokers.side_effect = lambda code: _brokers(code)
    writer = LiveWriter(tmp_path / "live")
    poller = LivePoller(kis, writer, LivePollerConfig(
        codes_fn=lambda: ["005930", "000660", "035720"], date_fn=lambda: "20260527",
    ))

    # cycle 1: marks all three as successful with cycle counter 1
    await poller.run_one_cycle()
    cycle1_order = list(succeeded)
    succeeded.clear()

    # Manually set 005930's last_success to a long-ago cycle so it's "starved"
    poller._last_success_cycle["005930"] = -10
    # 000660 and 035720 keep cycle 1

    await poller.run_one_cycle()
    # 005930 should now come first since it has the lowest last_success_cycle
    assert succeeded[0] == "005930"


def test_market_phase_helper() -> None:
    """09:00-15:30 = regular, 15:30-16:00 = after_hours_closing, else closed."""
    def t(h, m):
        d = datetime(2026, 5, 27, h, m, 0, tzinfo=KIS_KST)
        return int(d.timestamp() * 1000)

    assert _market_phase(t(9, 0)) == "regular"
    assert _market_phase(t(15, 29)) == "regular"
    assert _market_phase(t(15, 30)) == "after_hours_closing"
    assert _market_phase(t(15, 59)) == "after_hours_closing"
    assert _market_phase(t(16, 0)) == "closed"
    assert _market_phase(t(8, 0)) == "closed"


def test_should_poll_now_false_outside_market_hours(monkeypatch) -> None:
    """Off-hours → no polling regardless of calendar availability."""
    from hoga.api import calendar as cal
    # Stub calendar to "trading session" so the only thing left is the clock.
    monkeypatch.setattr(cal, "is_trading_session_today", lambda d: True)
    midnight_ms = int(datetime(2026, 5, 27, 2, 0, 0, tzinfo=KIS_KST).timestamp() * 1000)
    assert _should_poll_now(midnight_ms) is False


def test_should_poll_now_false_on_weekend_without_krx_fetch(monkeypatch) -> None:
    """Weekend → no polling via a clock/weekday short-circuit that never touches
    KRX. A weekend must stay closed even if KRX is unreachable (which would
    otherwise read as None → lenient-poll)."""
    from hoga.api import calendar as cal

    def _boom(_d):
        raise AssertionError("calendar must not be consulted on a weekend")
    monkeypatch.setattr(cal, "is_trading_session_today", _boom)
    # 2026-05-30 is a Saturday, 10:00 KST (in market clock hours).
    sat_ms = int(datetime(2026, 5, 30, 10, 0, 0, tzinfo=KIS_KST).timestamp() * 1000)
    assert _should_poll_now(sat_ms) is False


def test_should_poll_now_false_on_weekday_holiday(monkeypatch) -> None:
    """In-hours weekday but the calendar says it's not a session → no polling."""
    from hoga.api import calendar as cal
    monkeypatch.setattr(cal, "is_trading_session_today", lambda d: False)
    # 2026-05-27 is a Wednesday.
    in_hours_ms = int(datetime(2026, 5, 27, 10, 0, 0, tzinfo=KIS_KST).timestamp() * 1000)
    assert _should_poll_now(in_hours_ms) is False


def test_should_poll_now_lenient_when_calendar_unavailable(monkeypatch) -> None:
    """Calendar returns None (creds missing, KRX flaked) → fall back to clock alone.

    Losing capture for a transient KRX outage is worse than a brief bout of
    HTTP_500s on a stale day. See _should_poll_now docstring.
    """
    from hoga.api import calendar as cal
    monkeypatch.setattr(cal, "is_trading_session_today", lambda d: None)
    in_hours_ms = int(datetime(2026, 5, 27, 10, 0, 0, tzinfo=KIS_KST).timestamp() * 1000)
    assert _should_poll_now(in_hours_ms) is True


def test_should_poll_now_true_on_trading_day_in_hours(monkeypatch) -> None:
    from hoga.api import calendar as cal
    monkeypatch.setattr(cal, "is_trading_session_today", lambda d: True)
    in_hours_ms = int(datetime(2026, 5, 27, 10, 0, 0, tzinfo=KIS_KST).timestamp() * 1000)
    assert _should_poll_now(in_hours_ms) is True


def test_should_poll_now_polls_when_ohlcv_lags_today(monkeypatch) -> None:
    """ADR-0064 regression: the gate must NOT depend on is_trading_day (the
    daily-OHLCV proxy). Early in the session today's bar is unpublished, so
    is_trading_day returns False for a live trading day — the trigger that
    silently halted capture all day. The gate now consults the lag-free
    is_trading_session_today instead, so it polls."""
    from hoga.api import calendar as cal
    # OHLCV proxy says "not a trading day" (today's bar missing intraday)...
    monkeypatch.setattr(cal, "is_trading_day", lambda d: False)
    # ...but the business-day calendar correctly says today IS a session.
    monkeypatch.setattr(cal, "is_trading_session_today", lambda d: True)
    in_hours_ms = int(datetime(2026, 5, 27, 10, 0, 0, tzinfo=KIS_KST).timestamp() * 1000)
    assert _should_poll_now(in_hours_ms) is True


@pytest.mark.asyncio
async def test_after_hours_calls_overtime_fetchers(tmp_path: Path, monkeypatch) -> None:
    """Δ1: between 15:30 and 16:00, use overtime fetchers."""
    kis = _mk_kis()

    # Pin the cycle's t_ms to 15:45 KST via the orderbook stub's return
    after_hours_kst = datetime(2026, 5, 27, 15, 45, 0, tzinfo=KIS_KST)
    after_hours_ms = int(after_hours_kst.timestamp() * 1000)

    async def overtime_ob(code):
        ob = _ob(code, t_ms=after_hours_ms)
        return ob

    async def regular_ob(code):
        # Should not be called during after-hours phase
        return _ob(code, t_ms=after_hours_ms)

    kis.fetch_orderbook.side_effect = regular_ob
    kis.fetch_overtime_orderbook.side_effect = overtime_ob

    # Override _now_ms so the cycle is anchored to 15:45 KST
    monkeypatch.setattr("hoga.live.poller._now_ms", lambda: after_hours_ms)

    writer = LiveWriter(tmp_path / "live")
    poller = LivePoller(kis, writer, LivePollerConfig(
        codes_fn=lambda: ["005930"], date_fn=lambda: "20260527",
    ))
    await poller.run_one_cycle()

    kis.fetch_overtime_orderbook.assert_called()
    kis.fetch_orderbook.assert_not_called()

    import json
    lines = (tmp_path / "live" / "20260527" / "005930.jsonl").read_text().splitlines()
    payloads = [json.loads(line)["payload"] for line in lines]
    assert all(p["phase"] == "after_hours_closing" for p in payloads)


@pytest.mark.asyncio
async def test_poller_publishes_to_buffer_when_provided(tmp_path: Path, monkeypatch) -> None:
    """When given a LiveBuffer, run_one_cycle publishes after writing."""
    import time
    from hoga.live.buffer import LiveBuffer
    # Use a t_ms close to the actual wall clock so time-based eviction keeps the entry.
    snap_ms = int(time.time() * 1000)
    monkeypatch.setattr("hoga.live.poller._now_ms", lambda: snap_ms)
    buf = LiveBuffer()
    kis = _mk_kis(trades=[KisTrade(t_ms=snap_ms, price=100, qty=1, side=1, side_source="inferred")])
    kis.fetch_orderbook.side_effect = lambda code: _ob(code, t_ms=snap_ms)
    kis.fetch_overtime_orderbook.side_effect = lambda code: _ob(code, t_ms=snap_ms)
    kis.fetch_brokers.side_effect = lambda code: _brokers(code, t_ms=snap_ms)
    writer = LiveWriter(tmp_path / "live")
    poller = LivePoller(
        kis, writer,
        LivePollerConfig(codes_fn=lambda: ["005930"], date_fn=lambda: "20260527"),
        buffer=buf,
    )
    await poller.run_one_cycle()

    latest = await buf.get_latest("005930")
    assert latest is not None
    assert latest["code"] == "005930"
    assert latest["orderbook"] is not None
    assert len(latest["recent_trades"]) == 1


@pytest.mark.asyncio
async def test_poller_without_buffer_still_works(tmp_path: Path) -> None:
    """Backward compat: cycles work with buffer=None (default)."""
    kis = _mk_kis()
    writer = LiveWriter(tmp_path / "live")
    poller = LivePoller(
        kis, writer,
        LivePollerConfig(codes_fn=lambda: ["005930"], date_fn=lambda: "20260527"),
    )
    await poller.run_one_cycle()  # no exception


@pytest.mark.asyncio
async def test_run_forever_skips_cycle_when_market_closed(
    tmp_path: Path, monkeypatch
) -> None:
    """When the calendar gate says no, run_one_cycle is never invoked.

    Self-inflicted HTTP_500 storms (holiday/off-hours polling) — the whole
    point of the gate — would silently survive without this assertion.
    """
    from hoga.api import calendar as cal

    midnight_ms = int(datetime(2026, 5, 27, 2, 0, 0, tzinfo=KIS_KST).timestamp() * 1000)
    monkeypatch.setattr("hoga.live.poller._now_ms", lambda: midnight_ms)
    # Stub: today is a trading day, but it's 2 AM — the clock alone closes the gate.
    monkeypatch.setattr(cal, "is_trading_day", lambda d: True)

    kis = _mk_kis()
    writer = LiveWriter(tmp_path / "live")
    poller = LivePoller(kis, writer, LivePollerConfig(
        codes_fn=lambda: ["005930"], date_fn=lambda: "20260527",
        cycle_seconds=0.01,
    ))
    task = asyncio.create_task(poller.run_forever())
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    # No KIS call ever happened.
    kis.fetch_orderbook.assert_not_called()
    kis.fetch_brokers.assert_not_called()
    # No JSONL was written either.
    assert not (tmp_path / "live" / "20260527" / "005930.jsonl").exists()


@pytest.mark.asyncio
async def test_run_forever_until_cancel(tmp_path: Path, monkeypatch) -> None:
    regular_ms = int(datetime(2026, 5, 27, 10, 0, 0, tzinfo=KIS_KST).timestamp() * 1000)
    monkeypatch.setattr("hoga.live.poller._now_ms", lambda: regular_ms)
    kis = _mk_kis()
    writer = LiveWriter(tmp_path / "live")
    poller = LivePoller(kis, writer, LivePollerConfig(
        codes_fn=lambda: ["005930"], date_fn=lambda: "20260527",
        cycle_seconds=0.01,
    ))
    task = asyncio.create_task(poller.run_forever())
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    lines = (tmp_path / "live" / "20260527" / "005930.jsonl").read_text().splitlines()
    assert len(lines) >= 3  # at least one full cycle


@pytest.mark.asyncio
async def test_run_forever_survives_cycle_exception(tmp_path: Path, monkeypatch) -> None:
    """ADR-0064: a raising cycle (or gate) must NOT kill the poller task.

    An unguarded raise in run_forever silently halted live capture for the
    whole process while /api/live/status still reported running=true. The loop
    must log and continue to the next cycle instead.
    """
    regular_ms = int(datetime(2026, 5, 27, 10, 0, 0, tzinfo=KIS_KST).timestamp() * 1000)
    monkeypatch.setattr("hoga.live.poller._now_ms", lambda: regular_ms)
    monkeypatch.setattr("hoga.live.poller._should_poll_now", lambda t: True)

    kis = _mk_kis()
    writer = LiveWriter(tmp_path / "live")
    poller = LivePoller(kis, writer, LivePollerConfig(
        codes_fn=lambda: ["005930"], date_fn=lambda: "20260527",
        cycle_seconds=0.001,
    ))

    calls = {"n": 0}

    async def flaky_cycle() -> None:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("boom on first cycle")
        # subsequent cycles succeed (no-op)

    monkeypatch.setattr(poller, "run_one_cycle", flaky_cycle)

    task = asyncio.create_task(poller.run_forever())
    await asyncio.sleep(0.05)

    assert not task.done()      # survived the exception (would be done() if it propagated)
    assert calls["n"] >= 2      # kept ticking after the raise

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_consecutive_fails_streak_increments_then_resets(
    tmp_path: Path, monkeypatch
) -> None:
    """Diagnostic counter informs whether step-5 quarantine is warranted.

    KisApiError increments the streak; one successful cycle resets it.
    Rate-limit and unexpected-exception paths intentionally don't touch
    the counter — those are system-wide signals, not per-code defects.
    """
    from hoga.live.kis_client import KisApiError

    regular_ms = int(datetime(2026, 5, 27, 10, 0, 0, tzinfo=KIS_KST).timestamp() * 1000)
    monkeypatch.setattr("hoga.live.poller._now_ms", lambda: regular_ms)

    call_count = {"n": 0}

    async def flaky_orderbook(code):
        call_count["n"] += 1
        if call_count["n"] <= 2:
            raise KisApiError(msg_cd="HTTP_500/EGW00121", msg1="장시간이 아닙니다")
        return _ob(code)

    kis = AsyncMock()
    kis.fetch_orderbook.side_effect = flaky_orderbook
    kis.fetch_trades.return_value = []
    kis.fetch_brokers.side_effect = lambda c: _brokers(c)
    writer = LiveWriter(tmp_path / "live")
    poller = LivePoller(kis, writer, LivePollerConfig(
        codes_fn=lambda: ["005930"], date_fn=lambda: "20260527",
    ))

    # Two failing cycles → streak should be 2.
    await poller.run_one_cycle()
    assert poller._consecutive_fails["005930"] == 1
    await poller.run_one_cycle()
    assert poller._consecutive_fails["005930"] == 2

    # Third cycle succeeds → streak entry should be cleared.
    await poller.run_one_cycle()
    assert "005930" not in poller._consecutive_fails
