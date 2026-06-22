"""dynamic-N 프리미티브 + start/refresh/watchdog (스펙 §5)."""
import asyncio
from pathlib import Path

import pytest

from hoga.api.models import LiveStoragePolicy
import hoga.live.kis_runtime as kis_runtime
import hoga.live.lifecycle as lifecycle
import hoga.live.live_session as live_session_module


@pytest.fixture(autouse=True)
def _reset():
    lifecycle.reset_for_tests()
    yield
    lifecycle.reset_for_tests()


class _FakeKis:
    """get_approval_key만 쓰는 _build_conn용 가짜 KIS client."""
    def __init__(self, account_id: int) -> None:
        self._creds = type("C", (), {"app_key": f"k{account_id}"})()
        self.aclose_calls = 0

    async def get_approval_key(self) -> str:
        return "APPROVAL"

    async def aclose(self) -> None:
        self.aclose_calls += 1


_DEFAULT_STORAGE_POLICY: LiveStoragePolicy = "ws_plus_rest"


@pytest.mark.asyncio
async def test_build_conn_creates_tasks_and_teardown_keeps_client(tmp_path, monkeypatch):
    # _build_conn은 account의 KisClient를 ensure_kis_client_for_account로 얻는다.
    fake = _FakeKis(1)
    monkeypatch.setattr(
        kis_runtime, "ensure_kis_client_for_account",
        lambda account_id, data_dir: fake,
    )
    # WS가 실제 네트워크를 치지 않도록 게이트를 닫아 run()이 sleep하게 한다.
    from hoga.live import session_gate
    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)

    conn = lifecycle._build_conn(1, ["005930"], tmp_path)
    assert conn.account_id == 1
    assert conn.codes == ("005930",)
    assert not conn.ws_task.done() and not conn.flush_task.done()

    await lifecycle._teardown_conn(conn)
    assert conn.ws_task.done() and conn.flush_task.done()
    # R1: teardown는 KisClient를 닫지 않는다.
    assert fake.aclose_calls == 0


@pytest.mark.asyncio
async def test_teardown_conn_idempotent(tmp_path, monkeypatch):
    fake = _FakeKis(0)
    monkeypatch.setattr(
        kis_runtime, "ensure_kis_client_for_account",
        lambda account_id, data_dir: fake,
    )
    from hoga.live import session_gate
    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)
    conn = lifecycle._build_conn(0, ["005930"], tmp_path)
    await lifecycle._teardown_conn(conn)
    await lifecycle._teardown_conn(conn)  # 두 번째도 무해(done task cancel = no-op)


# ── refresh dynamic-N create/teardown (Task 8) ─────────────────────────────────

async def _start_two_accounts(tmp_path, monkeypatch, codes):
    """헬퍼: 2계좌 환경 + 가짜 client로 start (WS는 게이트 닫힘이라 무네트워크)."""
    from hoga.live import session_gate
    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)
    monkeypatch.setenv("KIS_APP_KEY", "k0")
    monkeypatch.setenv("KIS_APP_SECRET", "s0")
    monkeypatch.setenv("KIS_APP_KEY_2", "k1")
    monkeypatch.setenv("KIS_APP_SECRET_2", "s1")
    monkeypatch.setattr(
        kis_runtime, "ensure_kis_client_for_account",
        lambda account_id, data_dir: _FakeKis(account_id),
    )
    monkeypatch.setattr(
        kis_runtime, "ensure_kis_client_from_env",
        lambda data_dir: _FakeKis(0),
    )
    from tests.unit.live.test_lifecycle_start import _write_watchlist
    _write_watchlist(tmp_path, codes)
    # symbol-master 필터 무력화(모든 코드 통과)
    from hoga.api import symbols
    monkeypatch.setattr(symbols, "search", lambda q, limit=10_000: [])
    assert await lifecycle.start_live_stream(data_dir=tmp_path) is True


@pytest.mark.asyncio
async def test_refresh_builds_second_conn_when_crossing_per_account_max(tmp_path, monkeypatch):
    # 경계 = lifecycle._PER_ACCOUNT_MAX (계좌당 종목 한도). W종목이면 1계좌(conn0)에 꽉 참.
    W = lifecycle._PER_ACCOUNT_MAX
    codes_w = [f"{i:06d}" for i in range(W)]
    await _start_two_accounts(tmp_path, monkeypatch, codes_w)
    assert set(lifecycle._state.streams.keys()) == {0}   # conn-1 아직 없음

    # W+1번째 추가 → 경계 초과 → conn-1 신규 생성(연결 생성 분기)
    overflow = f"{W:06d}"
    from tests.unit.live.test_lifecycle_start import _write_watchlist
    _write_watchlist(tmp_path, codes_w + [overflow])
    await lifecycle.refresh_live_stream(data_dir=tmp_path)
    assert set(lifecycle._state.streams.keys()) == {0, 1}
    assert lifecycle._state.streams[1].codes == (overflow,)
    await lifecycle.stop_live_stream()


@pytest.mark.asyncio
async def test_refresh_tears_down_second_conn_when_dropping_to_per_account_max(tmp_path, monkeypatch):
    W = lifecycle._PER_ACCOUNT_MAX
    codes_w1 = [f"{i:06d}" for i in range(W + 1)]   # W+1종목 → 2계좌
    await _start_two_accounts(tmp_path, monkeypatch, codes_w1)
    assert set(lifecycle._state.streams.keys()) == {0, 1}

    from tests.unit.live.test_lifecycle_start import _write_watchlist
    _write_watchlist(tmp_path, codes_w1[:W])   # 경계로 복귀 → conn-1 불필요
    await lifecycle.refresh_live_stream(data_dir=tmp_path)
    assert set(lifecycle._state.streams.keys()) == {0}   # conn-1 해체(빈 소켓 안 남김)
    await lifecycle.stop_live_stream()


# ── watchdog 연결별 격리 복구 (Task 9) ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_watchdog_restarts_only_dead_conn(tmp_path, monkeypatch):
    codes26 = [f"{i:06d}" for i in range(26)]
    await _start_two_accounts(tmp_path, monkeypatch, codes26)
    s = lifecycle._state.streams
    assert set(s.keys()) == {0, 1}
    conn0_ws_task, conn1 = s[0].ws_task, s[1]

    # conn-1의 ws_task만 죽인다(dead)
    s[1].ws_task.cancel()
    try:
        await s[1].ws_task
    except asyncio.CancelledError:
        pass
    assert s[1].ws_task.done()

    # 게이트를 열어 watchdog가 재시작 판정하도록 + start_live_stream 전체 재시작 금지 확인
    monkeypatch.setattr(lifecycle, "_now_ms", lambda: 0)
    import hoga.live.session_gate as sg
    monkeypatch.setattr(sg, "ws_capture_window", lambda _t: True)

    restarted = await lifecycle._ws_watchdog_check(
        data_dir=tmp_path, now_ms=0, stale_after_ms=120_000,
    )
    assert restarted is True
    # conn-0는 그대로(같은 ws_task 객체), conn-1만 새 task
    assert lifecycle._state.streams[0].ws_task is conn0_ws_task
    assert lifecycle._state.streams[1].ws_task is not conn1.ws_task
    await lifecycle.stop_live_stream()


@pytest.mark.asyncio
async def test_restart_passes_ws_plus_rest_storage_policy(tmp_path, monkeypatch):
    session = lifecycle.LiveSession()
    session.n_configured = 2
    overflow_code = f"{lifecycle._PER_ACCOUNT_MAX:06d}"

    class _Conn:
        def __init__(self) -> None:
            self.account_id = 1
            self.stream_obj = object()
            self.ws_task = asyncio.create_task(asyncio.sleep(0))
            self.flush_task = asyncio.create_task(asyncio.sleep(0))
            self.codes = ("OLD",)

    conn = _Conn()
    session.streams = {1: conn}

    seen: dict[str, object] = {}

    def fake_compute_ws_targets(
        data_dir: Path,
        n_configured: int = 1,
        storage_policy: LiveStoragePolicy = "ws_plus_rest",
    ) -> list[str]:
        seen["data_dir"] = data_dir
        seen["n_configured"] = n_configured
        seen["storage_policy"] = storage_policy
        return [f"{i:06d}" for i in range(lifecycle._PER_ACCOUNT_MAX)] + [overflow_code]

    def fake_build_conn(account_id: int, codes: list[str], data_dir: Path):
        seen["build_account_id"] = account_id
        seen["build_codes"] = tuple(codes)
        seen["build_data_dir"] = data_dir
        return _Conn()

    async def fake_teardown_conn(_conn) -> None:
        seen["torn_down"] = True

    monkeypatch.setattr(live_session_module, "_compute_ws_targets", fake_compute_ws_targets)

    await session.restart(
        1,
        data_dir=tmp_path,
        storage_policy=_DEFAULT_STORAGE_POLICY,
        build_conn=fake_build_conn,
        teardown_conn=fake_teardown_conn,
    )

    assert seen["data_dir"] == tmp_path
    assert seen["n_configured"] == 2
    assert seen["storage_policy"] == "ws_plus_rest"
    assert seen["torn_down"] is True
    assert seen["build_account_id"] == 1
    assert seen["build_codes"] == (overflow_code,)
    assert seen["build_data_dir"] == tmp_path


# ── get_status 집계 + degraded_accounts (Task 10) ──────────────────────────────

@pytest.mark.asyncio
async def test_status_degraded_accounts_lists_unhealthy(tmp_path, monkeypatch):
    codes26 = [f"{i:06d}" for i in range(26)]
    await _start_two_accounts(tmp_path, monkeypatch, codes26)

    # conn-1의 ws를 not-connected로(가짜) → capture_health "reconnecting"
    class _DeadWs:
        connected = False
        sub_expected = 39
        sub_acked = 0
        sub_rejected = 0
        last_recv_ms = None
        last_tick_ms = None
    lifecycle._state.streams[1].stream_obj.ws = _DeadWs()        # type: ignore[union-attr]
    # conn-0는 connected
    class _LiveWs(_DeadWs):
        connected = True
        sub_acked = 39
    lifecycle._state.streams[0].stream_obj.ws = _LiveWs()        # type: ignore[union-attr]

    # 장중 + grace 경과 가정
    monkeypatch.setattr(lifecycle, "_market_clock_closed_for_capture", lambda _n: False)
    st = lifecycle.get_status()
    assert st.capture_healthy is False
    assert st.degraded_accounts == [1]
    assert ":" not in st.capture_reason       # Q10: 값 재포맷 금지(prefix 없음)
    await lifecycle.stop_live_stream()


@pytest.mark.asyncio
async def test_status_market_closed_is_not_per_account_degraded(tmp_path, monkeypatch):
    """야간/주말(market_closed)은 전역 상태 — 계좌별 degraded로 잡지 않는다
    (advisor 버그 회귀: _capture_health의 closed 단락이 모든 conn을 degraded로
    만들면 안 됨)."""
    codes26 = [f"{i:06d}" for i in range(26)]
    await _start_two_accounts(tmp_path, monkeypatch, codes26)
    monkeypatch.setattr(lifecycle, "_market_clock_closed_for_capture", lambda _n: True)
    st = lifecycle.get_status()
    assert st.capture_reason == "closed"
    assert st.degraded_accounts == []
    assert st.capture_healthy is False
    await lifecycle.stop_live_stream()


@pytest.mark.asyncio
async def test_status_idle_when_poller_only(tmp_path, monkeypatch):
    from hoga.live import session_gate
    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)
    monkeypatch.setenv("KIS_APP_KEY", "K")
    monkeypatch.setenv("KIS_APP_SECRET", "S")
    monkeypatch.setattr(kis_runtime, "ensure_kis_client_from_env", lambda d: _FakeKis(0))
    from tests.unit.live.test_lifecycle_start import _write_watchlist
    _write_watchlist(tmp_path, [])
    await lifecycle.start_live_stream(data_dir=tmp_path)
    st = lifecycle.get_status()
    assert st.running is True              # poller alive
    assert st.capture_healthy is True
    assert st.capture_reason == "idle"
    assert st.degraded_accounts == []
    await lifecycle.stop_live_stream()


@pytest.mark.asyncio
async def test_refresh_cross_boundary_move_single_active(tmp_path, monkeypatch):
    """cross-boundary 이동(per-account-max 경계 넘는 재정렬): 이동 코드가 정확히 한
    conn에만 active/구독되어야 한다 — 두 conn 동시-write(혼합 JSONL) 방지(리뷰 fix, 2-pass).
    W+1종목에서 마지막(moved, conn1)을 맨 앞으로 재정렬 → moved→conn0, displaced(W-1)→conn1.
    """
    W = lifecycle._PER_ACCOUNT_MAX
    moved = f"{W:06d}"          # 초기 conn1의 유일 코드(index W, 경계 직후)
    displaced = f"{W - 1:06d}"  # 재정렬 후 conn0에서 밀려나는 코드(index W-1, 경계 직전)
    codes_w1 = [f"{i:06d}" for i in range(W + 1)]
    await _start_two_accounts(tmp_path, monkeypatch, codes_w1)
    assert lifecycle._state.streams[1].codes == (moved,)   # 시작: conn1 = [moved]

    reordered = [moved] + codes_w1[:W]   # moved를 맨 앞으로 → 경계 넘어 conn0로 이동
    from tests.unit.live.test_lifecycle_start import _write_watchlist
    _write_watchlist(tmp_path, reordered)
    await lifecycle.refresh_live_stream(data_dir=tmp_path)

    conn0_active = lifecycle._state.streams[0].stream_obj._active_codes  # type: ignore[union-attr]
    conn1_active = lifecycle._state.streams[1].stream_obj._active_codes  # type: ignore[union-attr]
    # moved는 conn0에만(이동 완료), conn1엔 없음 — 정확히 한 conn
    assert moved in conn0_active and moved not in conn1_active
    # displaced는 conn1로 밀려남 — 정확히 한 conn
    assert displaced in conn1_active and displaced not in conn0_active
    # codes 튜플 일관
    assert moved in lifecycle._state.streams[0].codes
    assert lifecycle._state.streams[1].codes == (displaced,)
    await lifecycle.stop_live_stream()
