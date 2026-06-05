"""Live Capture lifecycle singleton — status + today-promote accessors."""

import asyncio

import pytest


def test_get_status_returns_not_running_initially() -> None:
    """Before start() is called, status reports running=False with defaults."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    status = lifecycle.get_status()
    assert status.running is False
    assert status.started_at_ms is None
    assert status.last_tick_ms is None
    assert status.cycle_lag_ms == 0
    assert status.watchlist_count == 0
    assert status.kis_calls_today == 0
    assert status.kis_rate_limit_remaining is None


@pytest.mark.asyncio
async def test_get_status_running_false_when_task_finished() -> None:
    """ADR-0064: running must reflect TASK LIVENESS, not just that start was
    called. A finished/crashed poller task → running=False.

    The old `started_at_ms is not None` proxy reported running=true even after
    the poller task had silently died, masking a dead live-capture loop.
    """
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State

    lifecycle.reset_for_tests()

    async def _done_immediately() -> None:
        return

    task = asyncio.create_task(_done_immediately())
    await task  # task.done() is now True (simulates a poller task that exited)

    lifecycle._state = _State(
        started_at_ms=123,
        watchlist_codes=("005930",),
        poller_task=task,
        poller_obj=None,
    )
    assert lifecycle.get_status().running is False


@pytest.mark.asyncio
async def test_get_status_running_true_when_task_alive() -> None:
    """A live (not-done) poller task with started_at_ms set → running=True."""
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State

    lifecycle.reset_for_tests()

    async def _forever() -> None:
        await asyncio.sleep(60)

    task = asyncio.create_task(_forever())
    lifecycle._state = _State(
        started_at_ms=123,
        watchlist_codes=("005930",),
        poller_task=task,
        poller_obj=None,
    )
    try:
        assert lifecycle.get_status().running is True
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


class _FakePoller:
    def __init__(self, last_tick_ms):
        self.last_tick_ms = last_tick_ms
        self.last_cycle_lag_ms = 0
        self.kis_calls_today = 0


def _install_state(monkeypatch, *, started_at_ms, task, last_tick_ms):
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State
    lifecycle._state = _State(
        started_at_ms=started_at_ms,
        watchlist_codes=("005930",),
        poller_task=task,
        poller_obj=_FakePoller(last_tick_ms),
    )


@pytest.fixture
def _spy_start(monkeypatch):
    """Replace start_live_poller with a spy that records calls (no real start)."""
    from hoga.live import lifecycle
    calls: list = []

    async def _spy(*, data_dir):
        calls.append(data_dir)
        return True

    monkeypatch.setattr(lifecycle, "start_live_poller", _spy)
    # Market hours by default; tests that need off-hours override this.
    monkeypatch.setattr("hoga.live.poller._should_poll_now", lambda t: True)
    return calls


@pytest.mark.asyncio
async def test_watchdog_restarts_dead_poller_during_market_hours(
    monkeypatch, _spy_start, tmp_path
) -> None:
    """ADR-0064: a finished/crashed poller task during market hours → restart."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()

    async def _done() -> None:
        return
    task = asyncio.create_task(_done())
    await task  # done()

    _install_state(monkeypatch, started_at_ms=1_000, task=task, last_tick_ms=None)
    restarted = await lifecycle._live_watchdog_check(
        data_dir=tmp_path, now_ms=10_000_000, stale_after_ms=120_000
    )
    assert restarted is True
    assert _spy_start == [tmp_path]


@pytest.mark.asyncio
async def test_watchdog_noop_off_hours(monkeypatch, _spy_start, tmp_path) -> None:
    """Off-hours/weekend/holiday → watchdog never restarts, even if task dead."""
    from hoga.live import lifecycle
    monkeypatch.setattr("hoga.live.poller._should_poll_now", lambda t: False)

    lifecycle.reset_for_tests()

    async def _done() -> None:
        return
    task = asyncio.create_task(_done())
    await task

    _install_state(monkeypatch, started_at_ms=1_000, task=task, last_tick_ms=None)
    restarted = await lifecycle._live_watchdog_check(
        data_dir=tmp_path, now_ms=10_000_000, stale_after_ms=120_000
    )
    assert restarted is False
    assert _spy_start == []


@pytest.mark.asyncio
async def test_watchdog_noop_when_healthy(monkeypatch, _spy_start, tmp_path) -> None:
    """Alive task with a recent tick → no restart."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()

    async def _forever() -> None:
        await asyncio.sleep(60)
    task = asyncio.create_task(_forever())
    try:
        _install_state(
            monkeypatch, started_at_ms=1_000, task=task, last_tick_ms=9_950_000
        )
        restarted = await lifecycle._live_watchdog_check(
            data_dir=tmp_path, now_ms=10_000_000, stale_after_ms=120_000
        )
        assert restarted is False
        assert _spy_start == []
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


@pytest.mark.asyncio
async def test_watchdog_restarts_stale_poller(monkeypatch, _spy_start, tmp_path) -> None:
    """Alive task but last_tick is far older than the stale threshold (and past
    the startup grace) → restart."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()

    async def _forever() -> None:
        await asyncio.sleep(60)
    task = asyncio.create_task(_forever())
    try:
        # started long ago (past grace); last tick 10 min old; threshold 2 min.
        _install_state(
            monkeypatch, started_at_ms=1_000, task=task, last_tick_ms=9_400_000
        )
        restarted = await lifecycle._live_watchdog_check(
            data_dir=tmp_path, now_ms=10_000_000, stale_after_ms=120_000
        )
        assert restarted is True
        assert _spy_start == [tmp_path]
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


@pytest.mark.asyncio
async def test_watchdog_no_restart_at_open_with_yesterday_last_tick(
    monkeypatch, _spy_start, tmp_path
) -> None:
    """ADR-0064 boundary: a server up since before 09:00 carries yesterday's
    last_tick across the close. Just after this morning's open (within grace),
    the watchdog must NOT flag it stale — measuring grace from poller-start
    (instead of today's session open) would restart the poller mid-opening
    cycle and destroy the opening data fix ① protects."""
    from datetime import datetime

    from hoga.live import lifecycle
    from hoga.live.kis_client import KIS_KST

    lifecycle.reset_for_tests()

    def _ms(*a):
        return int(datetime(*a, tzinfo=KIS_KST).timestamp() * 1000)

    started = _ms(2026, 6, 4, 8, 57)        # yesterday, before this morning open
    last_tick = _ms(2026, 6, 4, 15, 59)     # yesterday's close tick
    now = _ms(2026, 6, 5, 9, 1)             # 1 min after today's 09:00 open

    async def _forever() -> None:
        await asyncio.sleep(60)
    task = asyncio.create_task(_forever())
    try:
        _install_state(monkeypatch, started_at_ms=started, task=task,
                       last_tick_ms=last_tick)
        restarted = await lifecycle._live_watchdog_check(
            data_dir=tmp_path, now_ms=now, stale_after_ms=120_000
        )
        assert restarted is False  # grace runs from session open, not start
        assert _spy_start == []
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


@pytest.mark.asyncio
async def test_watchdog_restarts_when_no_tick_since_open_past_grace(
    monkeypatch, _spy_start, tmp_path
) -> None:
    """Same boundary, but well past the grace window with still no tick since
    open → a genuine stall → restart."""
    from datetime import datetime

    from hoga.live import lifecycle
    from hoga.live.kis_client import KIS_KST

    lifecycle.reset_for_tests()

    def _ms(*a):
        return int(datetime(*a, tzinfo=KIS_KST).timestamp() * 1000)

    started = _ms(2026, 6, 4, 8, 57)
    last_tick = _ms(2026, 6, 4, 15, 59)     # still yesterday — nothing since open
    now = _ms(2026, 6, 5, 9, 10)            # 10 min after open, past 2-min grace

    async def _forever() -> None:
        await asyncio.sleep(60)
    task = asyncio.create_task(_forever())
    try:
        _install_state(monkeypatch, started_at_ms=started, task=task,
                       last_tick_ms=last_tick)
        restarted = await lifecycle._live_watchdog_check(
            data_dir=tmp_path, now_ms=now, stale_after_ms=120_000
        )
        assert restarted is True
        assert _spy_start == [tmp_path]
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


@pytest.mark.asyncio
async def test_watchdog_grace_no_restart_right_after_start(
    monkeypatch, _spy_start, tmp_path
) -> None:
    """Just-started poller with no tick yet (within grace) → no premature restart."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()

    async def _forever() -> None:
        await asyncio.sleep(60)
    task = asyncio.create_task(_forever())
    try:
        # started 1s ago relative to now; grace is 120s → not stale yet.
        _install_state(
            monkeypatch, started_at_ms=9_999_000, task=task, last_tick_ms=None
        )
        restarted = await lifecycle._live_watchdog_check(
            data_dir=tmp_path, now_ms=10_000_000, stale_after_ms=120_000
        )
        assert restarted is False
        assert _spy_start == []
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


def test_reset_for_tests_is_idempotent() -> None:
    """Helper for test isolation must be safe to call multiple times."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    lifecycle.reset_for_tests()
    assert lifecycle.get_status().running is False


def test_get_active_codes_empty_when_poller_not_started() -> None:
    from hoga.live import lifecycle
    lifecycle.reset_for_tests()
    assert lifecycle.get_active_codes() == []


def test_get_active_codes_returns_watchlist_codes_after_start() -> None:
    """start_live_poller가 watchlist_codes로 채운 후 accessor가 그걸 반환."""
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State

    lifecycle.reset_for_tests()
    lifecycle._state = _State(
        started_at_ms=1,
        watchlist_codes=("003490", "058610"),
        poller_task=None,
        poller_obj=None,
    )
    assert lifecycle.get_active_codes() == ["003490", "058610"]


def test_record_today_promote_success_persists_per_code() -> None:
    """ADR-0043 — record_today_promote_success가 dict에 timestamp 보관."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    lifecycle.record_today_promote_success("003490", 1779800000000)
    lifecycle.record_today_promote_success("058610", 1779800010000)
    assert lifecycle.get_today_promote_last_ms() == {
        "003490": 1779800000000,
        "058610": 1779800010000,
    }


def test_record_today_promote_success_surfaces_in_status() -> None:
    """LiveStatus.today_promote_last_ms이 record 호출 후 채워짐."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    lifecycle.record_today_promote_success("003490", 1779800000000)
    status = lifecycle.get_status()
    assert status.today_promote_last_ms == {"003490": 1779800000000}


def test_reset_for_tests_clears_today_promote_dict() -> None:
    from hoga.live import lifecycle

    lifecycle.record_today_promote_success("003490", 1779800000000)
    lifecycle.reset_for_tests()
    assert lifecycle.get_today_promote_last_ms() == {}
