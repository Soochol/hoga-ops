"""Live Capture lifecycle singleton — status + today-promote accessors."""

import asyncio
import contextlib

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
    called. A finished/crashed stream task → running=False.

    The old `started_at_ms is not None` proxy reported running=true even after
    the task had silently died, masking a dead live-capture loop.
    """
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State

    lifecycle.reset_for_tests()

    async def _done_immediately() -> None:
        return

    task = asyncio.create_task(_done_immediately())
    await task  # task.done() is now True (simulates a stream task that exited)

    lifecycle._state = _State(
        started_at_ms=123,
        watchlist_codes=("005930",),
        stream_task=task,
    )
    assert lifecycle.get_status().running is False


@pytest.mark.asyncio
async def test_get_status_running_true_when_task_alive() -> None:
    """A live (not-done) stream task with started_at_ms set → running=True."""
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State

    lifecycle.reset_for_tests()

    async def _forever() -> None:
        await asyncio.sleep(60)

    task = asyncio.create_task(_forever())
    lifecycle._state = _State(
        started_at_ms=123,
        watchlist_codes=("005930",),
        stream_task=task,
    )
    try:
        assert lifecycle.get_status().running is True
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


def test_get_active_codes_empty_when_stream_not_started() -> None:
    from hoga.live import lifecycle
    lifecycle.reset_for_tests()
    assert lifecycle.get_active_codes() == []


def test_get_active_codes_returns_watchlist_codes_after_start() -> None:
    """start_live_stream이 watchlist_codes로 채운 후 accessor가 그걸 반환."""
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State

    lifecycle.reset_for_tests()
    lifecycle._state = _State(
        started_at_ms=1,
        watchlist_codes=("003490", "058610"),
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
            self.sub_expected = 3      # 헬스 술어용 기본값(확인 완료 상태)
            self.sub_acked = 3

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
async def test_ws_watchdog_gate_runs_off_event_loop(
    monkeypatch, _spy_start_stream, tmp_path
) -> None:
    """watchdog의 ws_capture_window 평가는 이벤트 루프 스레드 밖에서 —
    캘린더 게이트가 콜드/네거티브 캐시에서 동기 KIS HTTP를 부르므로 루프에서
    직접 부르면 30초마다 전체 백엔드가 동결될 수 있다(리뷰 #2)."""
    import threading

    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    seen: list[bool] = []

    def fake_gate(now_ms: int) -> bool:
        seen.append(threading.current_thread() is threading.main_thread())
        return False

    monkeypatch.setattr("hoga.live.session_gate.ws_capture_window", fake_gate)
    restarted = await lifecycle._ws_watchdog_check(
        data_dir=tmp_path, now_ms=10_000_000, stale_after_ms=120_000
    )
    assert restarted is False
    assert seen, "게이트가 한 번도 평가되지 않음"
    assert not any(seen), "watchdog 게이트가 이벤트 루프(메인 스레드)에서 실행됨"


@pytest.mark.asyncio
async def test_ws_watchdog_noop_when_healthy(
    monkeypatch, _spy_start_stream, tmp_path
) -> None:
    """WS watchdog: 두 task 모두 alive + 최근 수신(last_recv_ms) → 재시작 안 함.

    last_tick_ms=None(데이터 틱 0건 — 한산 종목 13개의 PINGPONG-only 장중)을
    명시해, watchdog이 데이터 틱이 아니라 last_recv_ms만으로 건강 판정함을
    직접 pin한다(Task 11 재리뷰 Minor — 재시작 폭풍 방지)."""
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
            stream_task=stream_task, last_tick_ms=None,
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
async def test_refresh_live_stream_durable_state_survives_ws_failure(
    monkeypatch, tmp_path
) -> None:
    """spec 2026-06-08 P2 #13: ws.update_codes(또는 drop_codes_except)가 raise해도
    durable 상태(_state.watchlist_codes — today-promoter가 읽는 권위)와
    set_active_codes(downsampler carry 정리)는 새 codes로 확정돼야 한다. 현재는
    _state 갱신이 마지막 줄이라 ws send 실패 시 stale로 남아 promote가 옛 Live
    Set을 계속 승격한다(failure-domain 순서 재배치)."""
    import json

    from hoga.api import symbols
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State

    lifecycle.reset_for_tests()
    monkeypatch.setattr(symbols, "_cache", [])

    (tmp_path / "watchlist.json").write_text(json.dumps({
        "version": 1,
        "entries": [
            {"code": f"{i:06d}", "name": f"{i:06d}",
             "registered_at_kst_date": "20260101", "last_success_date": None}
            for i in range(3)
        ],
    }))

    set_active: dict = {}

    class _FailingWs:
        async def update_codes(self, codes):
            raise ConnectionError("ws send failed mid-refresh")

    class _FakeStream:
        def __init__(self):
            self.ws = _FailingWs()

        def set_active_codes(self, codes):
            set_active["codes"] = set(codes)

    async def _fake_drop(keep):
        return None

    monkeypatch.setattr(lifecycle._buffer, "drop_codes_except", _fake_drop)
    lifecycle._state = _State(
        started_at_ms=1, watchlist_codes=("999999",),
        stream_obj=_FakeStream(), live_set=("999999",),
    )

    # ws send가 실패해도 refresh는 예외를 던지지 않고 durable 상태를 확정한다.
    await lifecycle.refresh_live_stream(data_dir=tmp_path)

    expected = tuple(f"{i:06d}" for i in range(3))
    assert lifecycle._state.watchlist_codes == expected  # promote 권위 — 확정됨
    assert lifecycle._state.live_set == expected
    assert set_active["codes"] == set(expected)           # carry 정리 — 적용됨


@pytest.mark.asyncio
async def test_refresh_durable_state_survives_drop_failure(
    monkeypatch, tmp_path
) -> None:
    """spec P2 #13: drop_codes_except가 raise해도 durable 상태가 확정된다 —
    _state/set_active_codes가 drop보다 *먼저*임을 핀(미래 리팩터가 _state를
    drop 아래로 옮기면 이 테스트가 잡는다). update_codes는 정상."""
    import json

    from hoga.api import symbols
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State

    lifecycle.reset_for_tests()
    monkeypatch.setattr(symbols, "_cache", [])
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "version": 1,
        "entries": [{"code": "000001", "name": "000001",
                     "registered_at_kst_date": "20260101", "last_success_date": None}],
    }))

    class _FakeWs:
        async def update_codes(self, codes):
            return None

    class _FakeStream:
        def __init__(self):
            self.ws = _FakeWs()
        def set_active_codes(self, codes):
            pass

    async def _failing_drop(keep):
        raise RuntimeError("ring purge failed")

    monkeypatch.setattr(lifecycle._buffer, "drop_codes_except", _failing_drop)
    lifecycle._state = _State(
        started_at_ms=1, watchlist_codes=("999999",),
        stream_obj=_FakeStream(), live_set=("999999",),
    )

    await lifecycle.refresh_live_stream(data_dir=tmp_path)   # drop raise해도 무예외

    assert lifecycle._state.watchlist_codes == ("000001",)   # drop 실패와 무관하게 확정


@pytest.mark.asyncio
async def test_refresh_live_stream_early_returns_without_stream(tmp_path) -> None:
    """stream/ws가 None이면 기동 폴백(_start_live_stream_locked)으로 위임 —
    그 가드(빈 watchlist → False)가 막으면 예외 없이 no-op (상태 불변).
    여기선 watchlist.json이 없어 codes=[]이므로 기동이 거부된다(리뷰 #1)."""
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


@pytest.mark.asyncio
async def test_refresh_live_stream_starts_never_started_stream(
    monkeypatch, tmp_path
) -> None:
    """빈 watchlist 부팅(기동 실패) 후 첫 종목 추가 → refresh가 스트림을 기동
    한다(리뷰 #1 — 구 refresh_live_poller의 auto-start 승계). 폴백이 없으면
    watchdog도 no-op(started_at_ms None)이고 프런트엔드에 /api/live/control
    start 호출 경로가 없어, 재시작 전까지 캡처가 조용히 죽어 있게 된다."""
    import json

    from hoga.api import symbols
    from hoga.live import lifecycle, session_gate

    lifecycle.reset_for_tests()
    monkeypatch.setenv("KIS_APP_KEY", "K")
    monkeypatch.setenv("KIS_APP_SECRET", "S")
    # 게이트 폐쇄 고정 — KisWsClient.run이 네트워크 없이 sleep만 하게
    # (test_lifespan_starts_and_stops_stream_gracefully와 동일 기법).
    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)
    monkeypatch.setattr(symbols, "_cache", [])  # cold cache → 무필터 폴백

    (tmp_path / "watchlist.json").write_text(
        json.dumps({"version": 1, "entries": []})
    )
    assert not await lifecycle.start_live_stream(data_dir=tmp_path)  # 빈 부팅
    assert lifecycle.get_status().running is False

    (tmp_path / "watchlist.json").write_text(json.dumps({
        "version": 1,
        "entries": [{"code": "005930", "name": "삼성전자",
                     "registered_at_kst_date": "20260101",
                     "last_success_date": None}],
    }))
    try:
        await lifecycle.refresh_live_stream(data_dir=tmp_path)  # 첫 종목 추가 훅
        assert lifecycle.get_status().running is True
        assert lifecycle._state.live_set == ("005930",)
        # 기동 시 활성 집합 배선(리뷰 #6) — on_tick 필터가 t0부터 동작해야
        # 퇴출 코드의 in-flight 프레임 부활을 막는다.
        assert lifecycle._state.stream_obj._active_codes == {"005930"}
    finally:
        await lifecycle.stop_live_stream()


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


@pytest.mark.asyncio
async def test_ws_watchdog_no_restart_at_open_with_yesterday_recv(
    monkeypatch, _spy_start_stream, tmp_path
) -> None:
    """ADR-0064 boundary(포팅): 어제부터 살아있는 서버의 last_recv가 어제 마감
    무렵이어도, 오늘 개장 직후(grace 내)엔 stale로 찍지 않는다 — grace를
    start가 아닌 오늘 세션 open 기준으로 재므로 개장 사이클 파괴 없음."""
    from datetime import datetime

    from hoga.live import lifecycle
    from hoga.live.kis_client import KIS_KST

    lifecycle.reset_for_tests()
    monkeypatch.setattr("hoga.live.session_gate.should_run_now", lambda t: True)
    monkeypatch.setattr("hoga.live.session_gate.market_phase", lambda t: "regular")

    def _ms(*a):
        return int(datetime(*a, tzinfo=KIS_KST).timestamp() * 1000)

    started = _ms(2026, 6, 4, 8, 57)
    last_recv = _ms(2026, 6, 4, 15, 29)     # 어제 마감 무렵 수신
    now = _ms(2026, 6, 5, 9, 1)             # 오늘 개장 +1분 (grace 내)

    async def _forever() -> None:
        await asyncio.sleep(60)
    ws_task = asyncio.create_task(_forever())
    stream_task = asyncio.create_task(_forever())
    try:
        _install_stream_state(monkeypatch, started_at_ms=started, ws_task=ws_task,
                              stream_task=stream_task, last_recv_ms=last_recv)
        restarted = await lifecycle._ws_watchdog_check(
            data_dir=tmp_path, now_ms=now, stale_after_ms=120_000
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
async def test_ws_watchdog_restarts_when_no_recv_since_open_past_grace(
    monkeypatch, _spy_start_stream, tmp_path
) -> None:
    """같은 경계, grace를 한참 지나도 개장 이후 수신 0 → 진짜 stall → 재시작."""
    from datetime import datetime

    from hoga.live import lifecycle
    from hoga.live.kis_client import KIS_KST

    lifecycle.reset_for_tests()
    monkeypatch.setattr("hoga.live.session_gate.should_run_now", lambda t: True)
    monkeypatch.setattr("hoga.live.session_gate.market_phase", lambda t: "regular")

    def _ms(*a):
        return int(datetime(*a, tzinfo=KIS_KST).timestamp() * 1000)

    started = _ms(2026, 6, 4, 8, 57)
    last_recv = _ms(2026, 6, 4, 15, 29)     # 여전히 어제 — 개장 후 수신 없음
    now = _ms(2026, 6, 5, 9, 10)            # 개장 +10분 (grace 2분 초과)

    async def _forever() -> None:
        await asyncio.sleep(60)
    ws_task = asyncio.create_task(_forever())
    stream_task = asyncio.create_task(_forever())
    try:
        _install_stream_state(monkeypatch, started_at_ms=started, ws_task=ws_task,
                              stream_task=stream_task, last_recv_ms=last_recv)
        restarted = await lifecycle._ws_watchdog_check(
            data_dir=tmp_path, now_ms=now, stale_after_ms=120_000
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


@pytest.mark.asyncio
async def test_ws_watchdog_grace_no_restart_right_after_start(
    monkeypatch, _spy_start_stream, tmp_path
) -> None:
    """방금 시작 + 수신 0 + grace 내 → 조기 재시작 금지."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    monkeypatch.setattr("hoga.live.session_gate.should_run_now", lambda t: True)
    monkeypatch.setattr("hoga.live.session_gate.market_phase", lambda t: "regular")

    async def _forever() -> None:
        await asyncio.sleep(60)
    ws_task = asyncio.create_task(_forever())
    stream_task = asyncio.create_task(_forever())
    try:
        _install_stream_state(monkeypatch, started_at_ms=9_999_000, ws_task=ws_task,
                              stream_task=stream_task, last_recv_ms=None)
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
async def test_stop_locked_propagates_outer_cancellation() -> None:
    """M4 pin: _stop_live_stream_locked가 자식 task 취소만 삼키고, *자기 자신*의
    취소는 전파해야 한다 — 삼키면 lifespan shutdown이 hang(무증상 재유입 방지)."""
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State

    lifecycle.reset_for_tests()

    async def _stubborn() -> None:
        # cancel을 한 번 흡수해 stop의 await task를 오래 붙잡는 자식 흉내
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            await asyncio.sleep(60)  # 두 번째 cancel까지 버팀

    child = asyncio.create_task(_stubborn())
    await asyncio.sleep(0)
    lifecycle._state = _State(started_at_ms=1, stream_task=child)

    async def _runner() -> None:
        await lifecycle._stop_live_stream_locked()

    outer = asyncio.create_task(_runner())
    await asyncio.sleep(0.01)        # stop이 child await에 진입할 시간
    outer.cancel()                   # 외부 취소 — 삼켜지면 안 됨
    with pytest.raises(asyncio.CancelledError):
        await outer
    child.cancel()
    try:
        await child
    except asyncio.CancelledError:
        pass


def test_capture_health_branches():
    """spec 2026-06-08 §2.2: 단일 헬스 술어 7상태. recv 체크가 sub보다 먼저 —
    sub 미확인+recv stale은 dead socket→'stale'(재시작), recv 신선+sub 미확인은
    'sub_failed'(거부류, 가시화만)로 갈린다(advisor B)."""
    from types import SimpleNamespace
    from hoga.live.lifecycle import _capture_health
    GRACE = 120_000
    NOW = 10_000_000
    REF = NOW - 200_000
    def ws(connected, expected, acked, last_recv):
        return SimpleNamespace(connected=connected, sub_expected=expected,
                               sub_acked=acked, last_recv_ms=last_recv)
    assert _capture_health(running=False, ws=None, now_ms=NOW, ref_ms=REF,
                           stale_after_ms=GRACE, market_closed=False) == (False, "offline")
    assert _capture_health(running=True, ws=ws(False, 39, 0, None), now_ms=NOW,
                           ref_ms=REF, stale_after_ms=GRACE, market_closed=True) == (False, "closed")
    assert _capture_health(running=True, ws=ws(False, 39, 0, None), now_ms=NOW,
                           ref_ms=REF, stale_after_ms=GRACE, market_closed=False) == (False, "reconnecting")
    assert _capture_health(running=True, ws=ws(True, 39, 10, NOW - 1000),
                           now_ms=NOW, ref_ms=NOW - 1000, stale_after_ms=GRACE,
                           market_closed=False) == (False, "subscribing")
    assert _capture_health(running=True, ws=ws(True, 39, 10, NOW - 1000),
                           now_ms=NOW, ref_ms=REF, stale_after_ms=GRACE,
                           market_closed=False) == (False, "sub_failed")
    assert _capture_health(running=True, ws=ws(True, 39, 10, NOW - 200_000),
                           now_ms=NOW, ref_ms=REF, stale_after_ms=GRACE,
                           market_closed=False) == (False, "stale")
    assert _capture_health(running=True, ws=ws(True, 39, 39, NOW - 1000),
                           now_ms=NOW, ref_ms=REF, stale_after_ms=GRACE,
                           market_closed=False) == (True, "healthy")


@pytest.mark.asyncio
async def test_get_status_exposes_capture_health(monkeypatch, tmp_path) -> None:
    """get_status가 capture_healthy/capture_reason를 노출 — 정상 ws."""
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State
    lifecycle.reset_for_tests()
    class _FakeWs:
        connected = True
        sub_expected = 3
        sub_acked = 3
        last_tick_ms = None
        last_recv_ms = lifecycle._now_ms()
    class _FakeStream:
        ws = _FakeWs()
    async def _forever():
        await asyncio.sleep(60)
    task = asyncio.create_task(_forever())
    try:
        lifecycle._state = _State(
            started_at_ms=lifecycle._now_ms() - 200_000,
            watchlist_codes=("005930",), stream_task=task,
            stream_obj=_FakeStream(), live_set=("005930",),
        )
        monkeypatch.setattr(lifecycle, "_market_clock_closed_for_capture",
                            lambda _now: False)
        st = lifecycle.get_status()
        assert st.capture_healthy is True
        assert st.capture_reason == "healthy"
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


@pytest.mark.asyncio
async def test_watchdog_does_not_restart_on_sub_failed_when_recv_fresh(
    monkeypatch, _spy_start_stream, tmp_path
) -> None:
    """spec §2.3: 구독 미확인이지만 수신 신선(appkey 거부류 — PINGPONG은 흐름)
    → 재시작 안 함(재연결 불응, 가시화만)."""
    from hoga.live import lifecycle
    lifecycle.reset_for_tests()
    monkeypatch.setattr("hoga.live.session_gate.ws_capture_window", lambda _t: True)
    async def _forever():
        await asyncio.sleep(60)
    ws_task = asyncio.create_task(_forever())
    stream_task = asyncio.create_task(_forever())
    try:
        _install_stream_state(
            monkeypatch, started_at_ms=1_000, ws_task=ws_task,
            stream_task=stream_task, last_tick_ms=None, last_recv_ms=9_950_000,
        )
        lifecycle._state.stream_obj.ws.sub_expected = 39
        lifecycle._state.stream_obj.ws.sub_acked = 10   # 미확인
        restarted = await lifecycle._ws_watchdog_check(
            data_dir=tmp_path, now_ms=10_000_000, stale_after_ms=120_000
        )
        assert restarted is False
        assert _spy_start_stream == []
    finally:
        for t in (ws_task, stream_task):
            t.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await t


@pytest.mark.asyncio
async def test_watchdog_restarts_when_sub_unacked_and_recv_stale(
    monkeypatch, _spy_start_stream, tmp_path
) -> None:
    """spec §2.3 + advisor: 구독 미확인 AND 수신 끊김 = dead socket → 재시작.
    recv 체크가 sub보다 먼저라 'stale'로 분류(old 순차 코드와 동일하게 재시작)."""
    from hoga.live import lifecycle
    lifecycle.reset_for_tests()
    monkeypatch.setattr("hoga.live.session_gate.ws_capture_window", lambda _t: True)
    async def _forever():
        await asyncio.sleep(60)
    ws_task = asyncio.create_task(_forever())
    stream_task = asyncio.create_task(_forever())
    try:
        _install_stream_state(
            monkeypatch, started_at_ms=1_000, ws_task=ws_task,
            stream_task=stream_task, last_tick_ms=None, last_recv_ms=9_000_000,
        )
        lifecycle._state.stream_obj.ws.sub_expected = 39
        lifecycle._state.stream_obj.ws.sub_acked = 10
        restarted = await lifecycle._ws_watchdog_check(
            data_dir=tmp_path, now_ms=10_000_000, stale_after_ms=120_000
        )
        assert restarted is True
        assert _spy_start_stream == [tmp_path]
    finally:
        for t in (ws_task, stream_task):
            t.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await t
