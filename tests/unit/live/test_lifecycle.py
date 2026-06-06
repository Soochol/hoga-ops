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


# ── Live Set + display_ordered_codes 테스트 (Task 11 Step 1) ──────────────────

def _make_doc(folders: list[dict], entries: list[dict]) -> "object":
    """WatchlistDocument fixture 헬퍼."""
    from hoga.api.models import WatchlistDocument, WatchlistEntry, WatchlistFolder
    return WatchlistDocument(
        folders=[WatchlistFolder(**f) for f in folders],
        entries=[WatchlistEntry(**e) for e in entries],
    )

def _entry(code: str, order: int, folder_id: str | None = None) -> dict:
    return {
        "code": code, "name": code,
        "registered_at_kst_date": "20260101",
        "last_success_date": None,
        "folder_id": folder_id,
        "order": order,
    }

def _folder(fid: str, order: int, name: str = "F") -> dict:
    return {"id": fid, "order": order, "name": name}


def test_live_set_is_watchlist_order_prefix() -> None:
    """Live Set = 패널 표시 순서 상위 LIVE_SET_MAX_CODES 코드.

    Step 0 확인: grouping.ts:28-43 + WatchlistDrawer.tsx:222,228
    폴더들은 .order 오름차순, 미분류는 **마지막** — 백엔드 평탄화가 미러.

    Fixture: 2개 폴더 + 미분류, entry order가 flat-array 삽입 순서와 어긋나게
    구성 → 표시 순서 평탄화가 정확한지 + 13 절단이 맞는지 검증.
    """
    from hoga.live.lifecycle import LIVE_SET_MAX_CODES, live_set_codes, display_ordered_codes

    assert LIVE_SET_MAX_CODES == 13  # 41 // 3 (spec §4·§5.1)

    # 폴더 2개 (order=1이 앞, order=0이 뒤 — 삽입 순서와 반대)
    # 실제 렌더 순서: folder_b(order=0) → folder_a(order=1) → 미분류
    folders = [
        _folder("f_aabbccdd", order=1, name="A"),   # 렌더 순서 2위
        _folder("f_11223344", order=0, name="B"),   # 렌더 순서 1위
    ]
    # folder_b(order=0) 안 entries: order=1,2 → 코드 "000001","000002"
    # folder_a(order=1) 안 entries: order=0,1 → 코드 "000010","000011"
    # 미분류: order=0,1,...  → 코드 "000020","000021",...
    entries = [
        # folder_a entries (삽입 순서 앞이지만 렌더에선 뒤)
        _entry("000010", order=0, folder_id="f_aabbccdd"),
        _entry("000011", order=1, folder_id="f_aabbccdd"),
        # folder_b entries
        _entry("000001", order=1, folder_id="f_11223344"),
        _entry("000002", order=0, folder_id="f_11223344"),
        # 미분류 entries (마지막)
        _entry("000020", order=0, folder_id=None),
        _entry("000021", order=1, folder_id=None),
    ]
    doc = _make_doc(folders, entries)

    # display_ordered_codes: folder_b(order=0) 먼저 → entry order 기준
    # → folder_b: [000002(order=0), 000001(order=1)]
    # → folder_a: [000010(order=0), 000011(order=1)]
    # → 미분류: [000020(order=0), 000021(order=1)]
    ordered = display_ordered_codes(doc)
    assert ordered == ["000002", "000001", "000010", "000011", "000020", "000021"]

    # live_set_codes: 상위 13 절단 — 6개뿐이므로 전부
    assert live_set_codes(doc) == ordered


def test_live_set_truncates_to_13() -> None:
    """20개 항목이 있을 때 Live Set은 정확히 13개로 절단된다."""
    from hoga.live.lifecycle import LIVE_SET_MAX_CODES, live_set_codes

    # 폴더 없이 미분류 20개
    entries = [_entry(f"{i:06d}", order=i) for i in range(20)]
    doc = _make_doc([], entries)

    result = live_set_codes(doc)
    assert len(result) == LIVE_SET_MAX_CODES  # == 13
    # 표시 순서(order 오름차순) 앞 13개
    assert result == [f"{i:06d}" for i in range(13)]


def test_live_set_fewer_than_13_returns_all() -> None:
    """5개짜리 watchlist는 전부 반환 (절단 없음)."""
    from hoga.live.lifecycle import live_set_codes

    entries = [_entry(f"{i:06d}", order=i) for i in range(5)]
    doc = _make_doc([], entries)
    assert live_set_codes(doc) == [f"{i:06d}" for i in range(5)]


def test_display_ordered_codes_uncategorized_last() -> None:
    """미분류(folder_id=None) 그룹은 실폴더 뒤에 온다 (grouping.ts 미러)."""
    from hoga.live.lifecycle import display_ordered_codes

    folders = [_folder("f_aabbccdd", order=0, name="F")]
    entries = [
        _entry("000099", order=0, folder_id=None),      # 미분류 — 뒤로
        _entry("000001", order=0, folder_id="f_aabbccdd"),  # 폴더 — 앞으로
    ]
    doc = _make_doc(folders, entries)
    ordered = display_ordered_codes(doc)
    assert ordered.index("000001") < ordered.index("000099")


def test_display_ordered_codes_empty_doc() -> None:
    """빈 문서는 빈 리스트를 반환한다."""
    from hoga.live.lifecycle import display_ordered_codes
    doc = _make_doc([], [])
    assert display_ordered_codes(doc) == []


# ── WS watchdog 테스트 ─────────────────────────────────────────────────────────

@pytest.fixture
def _spy_start_stream(monkeypatch):
    """Replace start_live_stream with a spy that records calls (no real start)."""
    from hoga.live import lifecycle
    calls: list = []

    async def _spy(*, data_dir):
        calls.append(data_dir)
        return True

    monkeypatch.setattr(lifecycle, "start_live_stream", _spy)
    return calls


def _install_stream_state(monkeypatch, *, started_at_ms, ws_task, stream_task,
                          last_tick_ms=None, last_flush_ms=None,
                          last_recv_ms=None):
    """Helper: inject a fake stream _State for watchdog tests.

    last_recv_ms가 watchdog의 stale 신호(리뷰 Important 1) — last_tick_ms는
    데이터 프레임 전용(표시), last_flush_ms는 틱 0건이어도 갱신되므로 watchdog이
    더 이상 읽지 않는다.
    """
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State

    class _FakeWs:
        def __init__(self, tick_ms, recv_ms):
            self.last_tick_ms = tick_ms
            self.last_recv_ms = recv_ms
            self.connected = recv_ms is not None

    class _FakeStream:
        def __init__(self, tick_ms, flush_ms, recv_ms):
            self.ws = _FakeWs(tick_ms, recv_ms)
            self.last_flush_ms = flush_ms

    lifecycle._state = _State(
        started_at_ms=started_at_ms,
        watchlist_codes=("005930",),
        ws_task=ws_task,
        stream_task=stream_task,
        stream_obj=_FakeStream(last_tick_ms, last_flush_ms, last_recv_ms),
        live_set=("005930",),
    )


@pytest.mark.asyncio
async def test_ws_watchdog_restarts_dead_stream_during_capture_window(
    monkeypatch, _spy_start_stream, tmp_path
) -> None:
    """WS watchdog: dead ws_task 중 캡처 윈도 → 재시작."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    # ws_capture_window를 True로 패치 (캡처 윈도 내)
    monkeypatch.setattr("hoga.live.session_gate.should_run_now", lambda t: True)
    monkeypatch.setattr("hoga.live.session_gate.market_phase", lambda t: "regular")

    async def _done() -> None:
        return
    ws_task = asyncio.create_task(_done())
    await ws_task  # done()

    async def _forever() -> None:
        await asyncio.sleep(60)
    stream_task = asyncio.create_task(_forever())

    try:
        _install_stream_state(
            monkeypatch, started_at_ms=1_000, ws_task=ws_task,
            stream_task=stream_task, last_tick_ms=None,
        )
        restarted = await lifecycle._ws_watchdog_check(
            data_dir=tmp_path, now_ms=10_000_000, stale_after_ms=120_000
        )
        assert restarted is True
        assert _spy_start_stream == [tmp_path]
    finally:
        stream_task.cancel()
        try:
            await stream_task
        except asyncio.CancelledError:
            pass


@pytest.mark.asyncio
async def test_ws_watchdog_noop_outside_capture_window(
    monkeypatch, _spy_start_stream, tmp_path
) -> None:
    """WS watchdog: 캡처 윈도 밖(15:30 이후 등) → 재시작 안 함."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    # ws_capture_window를 False로 패치
    monkeypatch.setattr("hoga.live.session_gate.should_run_now", lambda t: False)

    async def _done() -> None:
        return
    ws_task = asyncio.create_task(_done())
    await ws_task

    async def _forever() -> None:
        await asyncio.sleep(60)
    stream_task = asyncio.create_task(_forever())
    try:
        _install_stream_state(
            monkeypatch, started_at_ms=1_000, ws_task=ws_task,
            stream_task=stream_task,
        )
        restarted = await lifecycle._ws_watchdog_check(
            data_dir=tmp_path, now_ms=10_000_000, stale_after_ms=120_000
        )
        assert restarted is False
        assert _spy_start_stream == []
    finally:
        stream_task.cancel()
        try:
            await stream_task
        except asyncio.CancelledError:
            pass


@pytest.mark.asyncio
async def test_ws_watchdog_noop_when_healthy(
    monkeypatch, _spy_start_stream, tmp_path
) -> None:
    """WS watchdog: 두 task 모두 alive + 최근 수신(last_recv_ms) → 재시작 안 함."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    monkeypatch.setattr("hoga.live.session_gate.should_run_now", lambda t: True)
    monkeypatch.setattr("hoga.live.session_gate.market_phase", lambda t: "regular")

    async def _forever() -> None:
        await asyncio.sleep(60)

    ws_task = asyncio.create_task(_forever())
    stream_task = asyncio.create_task(_forever())
    try:
        _install_stream_state(
            monkeypatch, started_at_ms=1_000, ws_task=ws_task,
            stream_task=stream_task, last_tick_ms=9_950_000,
            last_recv_ms=9_950_000,
        )
        restarted = await lifecycle._ws_watchdog_check(
            data_dir=tmp_path, now_ms=10_000_000, stale_after_ms=120_000
        )
        assert restarted is False
        assert _spy_start_stream == []
    finally:
        for t in (ws_task, stream_task):
            t.cancel()
            try:
                await t
            except asyncio.CancelledError:
                pass


@pytest.mark.asyncio
async def test_ws_watchdog_restarts_on_silent_stall(
    monkeypatch, _spy_start_stream, tmp_path
) -> None:
    """리뷰 Important 1 — half-open TCP silent stall 감지.

    두 task 모두 alive(예외를 전부 잡아 cancel 외엔 done() 안 됨) +
    last_flush_ms 신선(flush 루프는 틱 0건이어도 10초마다 갱신) 상황에서
    last_recv_ms가 stale threshold를 넘기면 → restart. ping_interval=None이라
    half-open 소켓의 recv()는 영구 블록 — 정확히 ADR-0064가 막을 시나리오.
    """
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    monkeypatch.setattr("hoga.live.session_gate.should_run_now", lambda t: True)
    monkeypatch.setattr("hoga.live.session_gate.market_phase", lambda t: "regular")

    async def _forever() -> None:
        await asyncio.sleep(60)

    ws_task = asyncio.create_task(_forever())
    stream_task = asyncio.create_task(_forever())
    try:
        # last_recv 10분 전(>2분 threshold), flush는 5초 전(신선) — flush
        # 신선도가 stall을 가리지 못함을 고정.
        _install_stream_state(
            monkeypatch, started_at_ms=1_000, ws_task=ws_task,
            stream_task=stream_task, last_recv_ms=9_400_000,
            last_flush_ms=9_995_000,
        )
        restarted = await lifecycle._ws_watchdog_check(
            data_dir=tmp_path, now_ms=10_000_000, stale_after_ms=120_000
        )
        assert restarted is True
        assert _spy_start_stream == [tmp_path]
    finally:
        for t in (ws_task, stream_task):
            t.cancel()
            try:
                await t
            except asyncio.CancelledError:
                pass


# ── refresh_live_stream 테스트 (리뷰 Important 2) ──────────────────────────────

@pytest.mark.asyncio
async def test_refresh_live_stream_updates_ws_and_buffer(
    monkeypatch, tmp_path
) -> None:
    """정상 경로: update_codes/set_active_codes/drop_codes_except 3종이
    표시 순서 상위 13 코드로 호출되고 _state.live_set이 갱신된다."""
    import json

    from hoga.api import symbols
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State

    lifecycle.reset_for_tests()
    monkeypatch.setattr(symbols, "_cache", [])  # cold cache → 무필터 폴백

    # v1 watchlist 15개 — display order = 삽입 순서(order=index 시드)
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "version": 1,
        "entries": [
            {"code": f"{i:06d}", "name": f"{i:06d}",
             "registered_at_kst_date": "20260101", "last_success_date": None}
            for i in range(15)
        ],
    }))

    calls: dict = {}

    class _FakeWs:
        async def update_codes(self, codes):
            calls["update_codes"] = list(codes)

    class _FakeStream:
        def __init__(self):
            self.ws = _FakeWs()

        def set_active_codes(self, codes):
            calls["set_active_codes"] = set(codes)

    drop_calls: list = []

    async def _fake_drop(keep):
        drop_calls.append(set(keep))

    monkeypatch.setattr(lifecycle._buffer, "drop_codes_except", _fake_drop)
    lifecycle._state = _State(
        started_at_ms=1, watchlist_codes=("999999",),
        stream_obj=_FakeStream(), live_set=("999999",),
    )

    await lifecycle.refresh_live_stream(data_dir=tmp_path)

    expected = [f"{i:06d}" for i in range(13)]  # 15 → 상위 13 절단
    assert calls["update_codes"] == expected
    assert calls["set_active_codes"] == set(expected)
    assert drop_calls == [set(expected)]
    assert lifecycle._state.live_set == tuple(expected)
    assert lifecycle._state.watchlist_codes == tuple(expected)


@pytest.mark.asyncio
async def test_refresh_live_stream_early_returns_without_stream(tmp_path) -> None:
    """stream 또는 ws가 None이면 예외 없이 early-return (상태 불변)."""
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State

    lifecycle.reset_for_tests()
    # ① stream_obj 자체가 None (기동 전)
    await lifecycle.refresh_live_stream(data_dir=tmp_path)
    assert lifecycle._state.live_set == ()

    # ② stream은 있으나 ws가 None (조립 중간 상태)
    class _WsLess:
        ws = None

    lifecycle._state = _State(stream_obj=_WsLess(), live_set=("005930",))
    await lifecycle.refresh_live_stream(data_dir=tmp_path)
    assert lifecycle._state.live_set == ("005930",)  # 변경 없음


# ── 상수 drift 가드 ─────────────────────────────────────────────────────────────

def test_trs_per_code_matches_ws_client_subscriptions() -> None:
    """TRS_PER_CODE(Live Set 13 산정의 분모)가 ws_client의 실제 구독 TR 수와
    동기 — TR 추가/삭제 시 41-등록 한도 산식이 조용히 틀어지는 것을 차단."""
    from hoga.live import lifecycle, ws_client

    assert len(ws_client._TRS) == lifecycle.TRS_PER_CODE


# ── get_status WS 키 테스트 ────────────────────────────────────────────────────

def test_get_status_includes_ws_transport_keys() -> None:
    """LiveStatus에 transport/ws_connected/live_set 키가 포함된다."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    status = lifecycle.get_status()
    assert status.transport == "ws"
    assert isinstance(status.ws_connected, bool)
    assert isinstance(status.live_set, list)
