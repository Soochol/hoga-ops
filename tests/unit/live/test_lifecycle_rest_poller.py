"""LiveRestPoller ↔ lifecycle 통합 테스트 (ADR-0067, Task B5 진입점).

검증 대상:
- start 시 LiveRestPoller가 생성·start()된다.
- stop 시 rest_poller.stop()이 호출된다.
- live_set 확정/갱신 지점(start/refresh)마다 set_excluded_codes(live_set)가
  호출된다(배타 — WS 수집 종목은 폴러 skip).
- lifecycle.on_view_subscribe / on_view_unsubscribe가 rest_poller의 대응
  메서드로 위임된다.
- KIS 자격증명 없어 start가 실패하면 폴러도 생성되지 않는다(오프라인 안전).
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import json
from pathlib import Path

import pytest

from hoga.api.models import LiveSettingsResponse
from hoga.live.settings import save_live_settings


# ── Fake poller (LiveRestPoller 인터페이스만 흉내) ─────────────────────────────

class _FakePoller:
    """call tracking — 실제 asyncio task 없이 인터페이스만 검증."""

    def __init__(self, *args, **kwargs):
        self.started = False
        self.stopped = False
        self.excluded: set[str] = set()
        self.subscribed: list[str] = []
        self.unsubscribed: list[str] = []

    def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.stopped = True

    def set_excluded_codes(self, codes: set[str]) -> None:
        self.excluded = set(codes)

    def on_subscribe(self, code: str) -> None:
        self.subscribed.append(code)

    def on_unsubscribe(self, code: str) -> None:
        self.unsubscribed.append(code)

    def status(self) -> _FakePollerStatus:
        return _FakePollerStatus(running=self.alive)

    @property
    def alive(self) -> bool:
        return self.started and not self.stopped


@dataclass(frozen=True)
class _FakePollerStatus:
    running: bool = True
    target_count: int = 1
    targets: tuple[str, ...] = ("247540",)
    last_cycle_ms: int | None = 1770000000000
    last_error: str | None = "KisTransportError: KIS api error TRANSPORT/ConnectError: down"
    last_error_kind: str | None = "transport"
    last_error_code: str | None = "TRANSPORT/ConnectError"
    last_error_count: int = 1
    degraded: bool = True
    backoff_remaining: int = 2


# ── helpers ────────────────────────────────────────────────────────────────────

def _write_watchlist(tmp_path: Path, codes: list[str]) -> None:
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "version": 1,
        "entries": [
            {"code": c, "name": c,
             "registered_at_kst_date": "20260101", "last_success_date": None}
            for c in codes
        ],
    }))


# ── Tests ──────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_start_creates_and_starts_rest_poller(
    monkeypatch, tmp_path
) -> None:
    """start_live_stream이 LiveRestPoller를 생성·start()한다."""
    from hoga.live import lifecycle, session_gate

    lifecycle.reset_for_tests()
    monkeypatch.setenv("KIS_APP_KEY", "K")
    monkeypatch.setenv("KIS_APP_SECRET", "S")
    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)

    created: list[_FakePoller] = []

    def _fake_poller_cls(*args, **kwargs):
        p = _FakePoller(*args, **kwargs)
        created.append(p)
        return p

    monkeypatch.setattr("hoga.live.rest_poller.LiveRestPoller", _fake_poller_cls)

    _write_watchlist(tmp_path, ["005930"])
    try:
        ok = await lifecycle.start_live_stream(data_dir=tmp_path)
        assert ok is True
        assert len(created) == 1, "LiveRestPoller가 정확히 한 번 생성되어야 함"
        assert created[0].started, "start()가 호출되어야 함"
        assert lifecycle._state.rest_poller is created[0]
    finally:
        await lifecycle.stop_live_stream()


@pytest.mark.asyncio
async def test_stop_calls_rest_poller_stop(
    monkeypatch, tmp_path
) -> None:
    """stop_live_stream이 rest_poller.stop()을 호출한다."""
    from hoga.live import lifecycle, session_gate

    lifecycle.reset_for_tests()
    monkeypatch.setenv("KIS_APP_KEY", "K")
    monkeypatch.setenv("KIS_APP_SECRET", "S")
    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)

    created: list[_FakePoller] = []

    def _fake_poller_cls(*args, **kwargs):
        p = _FakePoller(*args, **kwargs)
        created.append(p)
        return p

    monkeypatch.setattr("hoga.live.rest_poller.LiveRestPoller", _fake_poller_cls)

    _write_watchlist(tmp_path, ["005930"])
    await lifecycle.start_live_stream(data_dir=tmp_path)
    poller = created[0]
    assert not poller.stopped

    await lifecycle.stop_live_stream()
    assert poller.stopped, "stop()이 호출되어야 함"


@pytest.mark.asyncio
async def test_start_sets_excluded_codes_to_live_set(
    monkeypatch, tmp_path
) -> None:
    """start 직후 rest_poller.set_excluded_codes(live_set)가 호출된다(배타)."""
    from hoga.live import lifecycle, session_gate

    lifecycle.reset_for_tests()
    monkeypatch.setenv("KIS_APP_KEY", "K")
    monkeypatch.setenv("KIS_APP_SECRET", "S")
    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)

    created: list[_FakePoller] = []

    def _fake_poller_cls(*args, **kwargs):
        p = _FakePoller(*args, **kwargs)
        created.append(p)
        return p

    monkeypatch.setattr("hoga.live.rest_poller.LiveRestPoller", _fake_poller_cls)

    _write_watchlist(tmp_path, ["005930", "000660"])
    try:
        await lifecycle.start_live_stream(data_dir=tmp_path)
        live_set = set(lifecycle._state.live_set)
        assert created[0].excluded == live_set, (
            "start 시 set_excluded_codes(live_set)가 호출되어야 함(배타)"
        )
    finally:
        await lifecycle.stop_live_stream()


@pytest.mark.asyncio
async def test_refresh_updates_excluded_codes(
    monkeypatch, tmp_path
) -> None:
    """refresh 후 rest_poller.set_excluded_codes가 새 live_set으로 갱신된다
    (dynamic-N 단일 conn — diff 경로에서 배제 동기화)."""
    import asyncio
    import json as _json

    from hoga.api import symbols
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State, _StreamConn

    lifecycle.reset_for_tests()
    monkeypatch.setattr(symbols, "_cache", [])  # cold cache → 무필터 폴백

    fake_poller = _FakePoller()

    calls: dict = {}

    class _FakeWs:
        async def update_codes(self, codes):
            calls["update_codes"] = list(codes)

    class _FakeStream:
        def __init__(self):
            self.ws = _FakeWs()

        def set_active_codes(self, codes):
            calls["set_active_codes"] = set(codes)

    async def _fake_drop(keep):
        pass

    monkeypatch.setattr(lifecycle._buffer, "drop_codes_except", _fake_drop)

    async def _forever():
        await asyncio.sleep(60)
    ws_task = asyncio.create_task(_forever())
    flush_task = asyncio.create_task(_forever())
    conn = _StreamConn(
        account_id=0, stream_obj=_FakeStream(),
        ws_task=ws_task, flush_task=flush_task, codes=("999999",),
    )
    lifecycle._state = _State(
        started_at_ms=1,
        n_configured=1,
        watchlist_codes=("999999",),
        streams={0: conn},
        live_set=("999999",),
        rest_poller=fake_poller,
    )

    (tmp_path / "watchlist.json").write_text(_json.dumps({
        "version": 1,
        "entries": [
            {"code": f"{i:06d}", "name": f"{i:06d}",
             "registered_at_kst_date": "20260101", "last_success_date": None}
            for i in range(5)
        ],
    }))

    try:
        await lifecycle.refresh_live_stream(data_dir=tmp_path)

        expected = {f"{i:06d}" for i in range(5)}
        assert fake_poller.excluded == expected, (
            "refresh 후 set_excluded_codes(new_live_set)이 호출되어야 함(배타 갱신)"
        )
    finally:
        for t in (ws_task, flush_task):
            t.cancel()
            try:
                await t
            except asyncio.CancelledError:
                pass


def test_status_exposes_kis_rest_bypass_enabled(tmp_path, monkeypatch):
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    save_live_settings(tmp_path, LiveSettingsResponse(kis_rest_bypass_enabled=True))
    monkeypatch.setattr(lifecycle, "_data_dir", tmp_path, raising=False)
    lifecycle.refresh_status_from_settings(tmp_path)

    status = lifecycle.get_status()

    assert status.kis_rest_bypass_enabled is True


@pytest.mark.asyncio
async def test_refresh_bypass_stops_existing_rest_poller(
    monkeypatch, tmp_path
) -> None:
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    fake_poller = _FakePoller()
    fake_poller.start()
    lifecycle._state.rest_poller = fake_poller
    save_live_settings(tmp_path, LiveSettingsResponse(kis_rest_bypass_enabled=True))

    await lifecycle.refresh_live_stream(data_dir=tmp_path)

    assert fake_poller.stopped is True
    assert lifecycle._state.rest_poller is None


@pytest.mark.asyncio
async def test_on_view_subscribe_delegates_to_rest_poller(
    monkeypatch, tmp_path
) -> None:
    """on_view_subscribe(code)가 rest_poller.on_subscribe(code)로 위임된다."""
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State

    lifecycle.reset_for_tests()
    fake_poller = _FakePoller()
    lifecycle._state = _State(rest_poller=fake_poller)

    await lifecycle.on_view_subscribe("005930")

    assert "005930" in fake_poller.subscribed


@pytest.mark.asyncio
async def test_on_view_unsubscribe_delegates_to_rest_poller(
    monkeypatch, tmp_path
) -> None:
    """on_view_unsubscribe(code)가 rest_poller.on_unsubscribe(code)로 위임된다."""
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State

    lifecycle.reset_for_tests()
    fake_poller = _FakePoller()
    lifecycle._state = _State(rest_poller=fake_poller)

    await lifecycle.on_view_unsubscribe("005930")

    assert "005930" in fake_poller.unsubscribed


@pytest.mark.asyncio
async def test_on_view_subscribe_delegates_to_kiwoom_and_propagates_full_house() -> None:
    """PR-C: on_view_subscribe가 키움 매니저에 (code,venues,ref) 위임하고 만석 bool을
    전파한다(rest_poller 위임과 병존). ws.py가 이 bool로 만석 토스트를 판단."""
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State

    lifecycle.reset_for_tests()

    class _FakeKiwoom:
        def __init__(self):
            self.calls: list = []

        async def on_view_subscribe(self, code, venues, *, ref):
            self.calls.append((code, venues, ref))
            return False  # 만석 모의

        async def on_view_unsubscribe(self, code, venues, *, ref):
            self.calls.append(("un", code, venues, ref))

    fake = _FakeKiwoom()
    lifecycle._state = _State(kiwoom_session=fake)

    accepted = await lifecycle.on_view_subscribe("005930", {"KRX"}, ref="tab1")
    assert accepted is False                              # 키움 만석 bool 전파
    assert fake.calls == [("005930", {"KRX"}, "tab1")]

    await lifecycle.on_view_unsubscribe("005930", {"KRX"}, ref="tab1")
    assert fake.calls[-1] == ("un", "005930", {"KRX"}, "tab1")


@pytest.mark.asyncio
async def test_on_view_subscribe_noop_when_no_poller() -> None:
    """rest_poller·키움 둘 다 없을 때(오프라인/start 전) 예외 없이 no-op(True)."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    # 폴러 없이도 예외가 나면 안 된다(키움 미배선이면 True).
    assert await lifecycle.on_view_subscribe("005930") is True


@pytest.mark.asyncio
async def test_on_view_unsubscribe_noop_when_no_poller() -> None:
    """rest_poller·키움 둘 다 없을 때 예외 없이 no-op."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    await lifecycle.on_view_unsubscribe("005930")


@pytest.mark.asyncio
async def test_start_no_poller_when_creds_missing(
    monkeypatch, tmp_path
) -> None:
    """KIS 자격증명 없으면 start가 False를 반환하고 rest_poller도 None(오프라인 안전)."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    monkeypatch.delenv("KIS_APP_KEY", raising=False)
    monkeypatch.delenv("KIS_APP_SECRET", raising=False)

    _write_watchlist(tmp_path, ["005930"])
    ok = await lifecycle.start_live_stream(data_dir=tmp_path)
    assert ok is False
    assert lifecycle._state.rest_poller is None


# ── _sync_exclusion 헬퍼 단위 테스트 (ADR-0067 배타; 컷오버로 _sync_and_live_set 대체) ──


def test_sync_exclusion_calls_set_excluded() -> None:
    """_sync_exclusion(poller, live_set)이 set_excluded_codes(set(live_set))를 호출한다."""
    from hoga.live.lifecycle import _sync_exclusion

    poller = _FakePoller()
    live_set = ("005930", "000660")
    _sync_exclusion(poller, live_set)

    assert poller.excluded == set(live_set), (
        "_sync_exclusion은 set_excluded_codes(set(live_set))를 호출해야 함"
    )


def test_sync_exclusion_no_poller_noop() -> None:
    """_sync_exclusion(None, live_set)은 예외 없이 no-op(오프라인 폴백)."""
    from hoga.live.lifecycle import _sync_exclusion

    _sync_exclusion(None, ("005930", "000660"))  # 예외 안 남


# ── Task 11: rest_poller 분리 회귀 + C4 보는종목 (스펙 §3·C4) ──────────────────


@pytest.mark.asyncio
async def test_view_subscription_survives_stream_restart(tmp_path, monkeypatch):
    """잠복 버그 회귀(§3): conn(스트림) 재시작이 보는종목 구독을 날리면 안 된다."""
    import hoga.live.kis_runtime as kis_runtime
    import hoga.live.lifecycle as lifecycle
    from hoga.live import session_gate

    lifecycle.reset_for_tests()
    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)
    monkeypatch.setenv("KIS_APP_KEY", "K")
    monkeypatch.setenv("KIS_APP_SECRET", "S")

    class _FakeKis:
        _creds = type("C", (), {"app_key": "k0"})()
        async def get_approval_key(self):
            return "A"
        async def aclose(self):
            pass
        async def fetch_orderbook(self, code):
            raise RuntimeError("offline")
        async def fetch_trades(self, code):
            return []
        async def fetch_brokers(self, code):
            raise RuntimeError("offline")

    monkeypatch.setattr(kis_runtime, "ensure_kis_client_from_env", lambda d: _FakeKis())
    monkeypatch.setattr(kis_runtime, "ensure_kis_client_for_account", lambda a, d: _FakeKis())

    from hoga.api import symbols
    from tests.unit.live.test_lifecycle_start import _write_watchlist
    monkeypatch.setattr(symbols, "search", lambda q, limit=10_000: [])
    _write_watchlist(tmp_path, ["005930"])
    await lifecycle.start_live_stream(data_dir=tmp_path)

    # 보는종목(관심 밖) 구독
    await lifecycle.on_view_subscribe("999999")
    assert "999999" in lifecycle._state.rest_poller._subscribed

    # 전체 재시작(watchdog 전체 재시작 경로와 동일하게 poller 보존)
    await lifecycle.start_live_stream(data_dir=tmp_path)
    assert lifecycle._state.rest_poller is not None
    assert "999999" in lifecycle._state.rest_poller._subscribed  # ★ 구독 보존
    await lifecycle.stop_live_stream()


@pytest.mark.asyncio
async def test_empty_watchlist_view_subscribe_polls(tmp_path, monkeypatch):
    """C4: 빈 watchlist여도 보는종목 on_view_subscribe가 폴링 대상에 들어간다."""
    import hoga.live.kis_runtime as kis_runtime
    import hoga.live.lifecycle as lifecycle
    from hoga.live import session_gate

    lifecycle.reset_for_tests()
    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)
    monkeypatch.setenv("KIS_APP_KEY", "K")
    monkeypatch.setenv("KIS_APP_SECRET", "S")

    from hoga.live.kis_models import KisBrokers, KisOrderbook, OrderbookLevel

    class _FakeKis:
        _creds = type("C", (), {"app_key": "k0"})()
        async def get_approval_key(self):
            return "A"
        async def aclose(self):
            pass
        async def fetch_orderbook(self, code):
            return KisOrderbook(
                code=code,
                asks=[OrderbookLevel(price=101, qty=1)],
                bids=[OrderbookLevel(price=100, qty=1)],
                total_ask_qty=1,
                total_bid_qty=1,
                t_ms=1770000000000,
            )
        async def fetch_trades(self, code):
            return []
        async def fetch_brokers(self, code):
            return KisBrokers(code=code, buy_top=[], sell_top=[])

    monkeypatch.setattr(kis_runtime, "ensure_kis_client_from_env", lambda d: _FakeKis())

    from tests.unit.live.test_lifecycle_start import _write_watchlist
    _write_watchlist(tmp_path, [])
    assert await lifecycle.start_live_stream(data_dir=tmp_path) is True
    assert lifecycle._state.streams == {}                       # WS 연결 0 (C4)
    await lifecycle.on_view_subscribe("005930")
    assert "005930" in lifecycle._state.rest_poller._subscribed  # 폴링 대상(빈 화면 아님)
    await lifecycle.stop_live_stream()


def test_get_status_exposes_rest_poller_fields_without_capture_health_side_effect() -> None:
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State

    lifecycle.reset_for_tests()
    lifecycle._state = _State(rest_poller=_FakePoller())
    lifecycle._state.rest_poller.start()

    st = lifecycle.get_status()

    assert st.rest_poller_degraded is True
    assert st.rest_poller_last_error == (
        "KisTransportError: KIS api error TRANSPORT/ConnectError: down"
    )
    assert st.rest_poller_last_error_kind == "transport"
    assert st.rest_poller_last_error_code == "TRANSPORT/ConnectError"
    assert st.rest_poller_last_error_count == 1
    assert st.rest_poller_backoff_remaining == 2
    assert st.capture_healthy is True
    assert st.capture_reason == "idle"
    assert st.degraded_accounts == []
