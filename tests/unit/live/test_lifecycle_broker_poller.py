"""BrokerRestPoller ↔ lifecycle 통합 테스트 (ADR-0111).

검증:
- start 시 BrokerRestPoller가 생성·start()되고 타깃이 live_set으로 동기화된다.
- stop 시 broker_poller.stop()이 호출된다.
- refresh 시 타깃이 갱신된 live_set으로 재동기화된다.
- KIS 자격증명이 없으면 폴러도 생성되지 않는다(오프라인 안전).

test_lifecycle_rest_poller.py의 fake-poller 패턴을 미러한다.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import pytest


class _FakeBrokerPoller:
    def __init__(self, *args, **kwargs) -> None:
        self.started = False
        self.stopped = False
        self.targets: set[str] = set()
        self._task = None

    def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.stopped = True

    def set_targets(self, codes: set[str]) -> None:
        self.targets = set(codes)

    @property
    def alive(self) -> bool:
        return self.started and not self.stopped

    def status(self) -> _FakeBrokerStatus:
        return _FakeBrokerStatus(running=self.alive, target_count=len(self.targets))


@dataclass(frozen=True)
class _FakeBrokerStatus:
    running: bool = True
    target_count: int = 0
    targets: tuple[str, ...] = ()
    last_cycle_ms: int | None = 1770000000000
    last_cycle_duration_ms: int | None = 5
    last_error: str | None = None
    last_error_kind: str | None = None
    last_error_code: str | None = None
    last_error_count: int = 0
    degraded: bool = False
    backoff_remaining: int = 0
    rate_limit_bounces: int | None = None


def _write_watchlist(tmp_path: Path, codes: list[str]) -> None:
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "version": 1,
        "entries": [
            {"code": c, "name": c,
             "registered_at_kst_date": "20260101", "last_success_date": None}
            for c in codes
        ],
    }))


def _patch_pollers(monkeypatch) -> list[_FakeBrokerPoller]:
    """rest_poller와 broker_poller 둘 다 fake로 교체(둘 다 start에서 생성됨)."""
    from tests.unit.live.test_lifecycle_rest_poller import _FakePoller

    monkeypatch.setattr(
        "hoga.live.rest_poller.LiveRestPoller",
        lambda *a, **k: _FakePoller(*a, **k),
    )
    created: list[_FakeBrokerPoller] = []

    def _fake_cls(*args, **kwargs):
        p = _FakeBrokerPoller(*args, **kwargs)
        created.append(p)
        return p

    monkeypatch.setattr("hoga.live.broker_rest_poller.BrokerRestPoller", _fake_cls)
    return created


@pytest.mark.asyncio
async def test_start_creates_broker_poller_with_live_set_targets(
    monkeypatch, tmp_path
) -> None:
    from hoga.live import lifecycle, session_gate

    lifecycle.reset_for_tests()
    monkeypatch.setenv("KIS_APP_KEY", "K")
    monkeypatch.setenv("KIS_APP_SECRET", "S")
    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)
    created = _patch_pollers(monkeypatch)

    _write_watchlist(tmp_path, ["005930", "000660"])
    try:
        ok = await lifecycle.start_live_stream(data_dir=tmp_path)
        assert ok is True
        assert len(created) == 1, "BrokerRestPoller가 정확히 한 번 생성되어야 함"
        assert created[0].started, "start()가 호출되어야 함"
        assert lifecycle._state.broker_poller is created[0]
        # 타깃이 live_set과 동기화되어야 함.
        assert created[0].targets == set(lifecycle._state.live_set)
    finally:
        await lifecycle.stop_live_stream()


@pytest.mark.asyncio
async def test_stop_calls_broker_poller_stop(monkeypatch, tmp_path) -> None:
    from hoga.live import lifecycle, session_gate

    lifecycle.reset_for_tests()
    monkeypatch.setenv("KIS_APP_KEY", "K")
    monkeypatch.setenv("KIS_APP_SECRET", "S")
    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)
    created = _patch_pollers(monkeypatch)

    _write_watchlist(tmp_path, ["005930"])
    await lifecycle.start_live_stream(data_dir=tmp_path)
    poller = created[0]
    assert not poller.stopped

    await lifecycle.stop_live_stream()
    assert poller.stopped, "stop()이 호출되어야 함"


@pytest.mark.asyncio
async def test_no_creds_no_broker_poller(monkeypatch, tmp_path) -> None:
    """자격증명 없으면 start가 오프라인으로 실패하고 폴러도 생성되지 않는다."""
    from hoga.live import lifecycle, session_gate

    lifecycle.reset_for_tests()
    monkeypatch.delenv("KIS_APP_KEY", raising=False)
    monkeypatch.delenv("KIS_APP_SECRET", raising=False)
    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)
    created = _patch_pollers(monkeypatch)

    _write_watchlist(tmp_path, ["005930"])
    ok = await lifecycle.start_live_stream(data_dir=tmp_path)
    assert ok is False
    assert created == [], "creds 없으면 BrokerRestPoller 미생성"
    assert lifecycle._state.broker_poller is None


@pytest.mark.asyncio
async def test_refresh_bypass_stops_existing_broker_poller(
    monkeypatch, tmp_path
) -> None:
    """kis_rest_bypass_enabled면 refresh가 broker_poller를 정지·해제한다
    (rest_poller와 동일 정책 — 거래원 폴러도 REST 기반이라 bypass 대상)."""
    from hoga.api.models import LiveSettingsResponse
    from hoga.live import lifecycle
    from hoga.live.settings import save_live_settings

    lifecycle.reset_for_tests()
    fake_poller = _FakeBrokerPoller()
    fake_poller.start()
    lifecycle._state.broker_poller = fake_poller
    save_live_settings(tmp_path, LiveSettingsResponse(kis_rest_bypass_enabled=True))

    await lifecycle.refresh_live_stream(data_dir=tmp_path)

    assert fake_poller.stopped is True
    assert lifecycle._state.broker_poller is None


def test_captured_watchlist_after_cutover_sources_from_kiwoom_targets() -> None:
    """PR-E 재소싱: 거래원 폴러 타깃 = 캡처된 관심종목(capture_candidates ∩ 저장셋).
    컷오버 후 관심종목은 kiwoom_targets에 있으므로 ws_targets 빈값이어도 안 빈다 —
    session.live_set(=ws_targets)에서만 소싱하면 거래원 데이터가 조용히 끊긴다."""
    from hoga.live.lifecycle import _captured_watchlist
    from hoga.live.storage_runtime import StorageRuntimeSnapshot

    snap = StorageRuntimeSnapshot(
        ws_targets=(),                                   # 컷오버 후 빈값
        capture_candidates=("A", "B"),
        kiwoom_targets=("A", "B", "H1", "H2"),
    )
    assert _captured_watchlist(snap) == ("A", "B")       # 관심종목만(히트맵 제외)


def test_captured_watchlist_kiwoom_off_equals_ws_targets() -> None:
    """kiwoom off 폴백: captured_watchlist == 저장된 관심종목(=ws_targets) — 기존 거래원
    타깃 동작 무회귀. 슬롯 밖 관심종목(C)은 미저장이라 제외."""
    from hoga.live.lifecycle import _captured_watchlist
    from hoga.live.storage_runtime import StorageRuntimeSnapshot

    snap = StorageRuntimeSnapshot(
        ws_targets=("A", "B"),
        capture_candidates=("A", "B", "C"),  # C는 KIS 슬롯 밖(미저장)
        kiwoom_targets=(),
    )
    assert _captured_watchlist(snap) == ("A", "B")


@pytest.mark.asyncio
async def test_get_kiwoom_capture_codes_includes_watchlist_after_cutover() -> None:
    """PR-E E2E 링크: 컷오버 후 키움 active_codes(=저장셋)에 관심종목이 포함돼, 승격
    루프(promote_kiwoom_today)가 관심종목을 kiwoom_live로 자동 승격한다(별도 배선 불요)."""
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State

    lifecycle.reset_for_tests()

    class _FakeKiwoom:
        def active_codes(self):
            return ["005930", "000660", "H1"]  # 관심종목 + 히트맵(컷오버 저장셋)

    lifecycle._state = _State(kiwoom_session=_FakeKiwoom())
    codes = lifecycle.get_kiwoom_capture_codes()
    assert "005930" in codes and "000660" in codes  # 관심종목 포함 → kiwoom_live 승격 대상


def test_storage_set_is_dedup_union_of_ws_and_kiwoom() -> None:
    """PR-E: rest_poller 배제·버퍼 링 보존용 저장셋 = ws ∪ kiwoom(dedup)."""
    from hoga.live.lifecycle import _storage_set
    from hoga.live.storage_runtime import StorageRuntimeSnapshot

    snap = StorageRuntimeSnapshot(
        ws_targets=(), capture_candidates=("A", "B"),
        kiwoom_targets=("A", "B", "H1"),
    )
    assert set(_storage_set(snap)) == {"A", "B", "H1"}


@pytest.mark.asyncio
async def test_dispatch_broker_tick_broadcasts_to_kiwoom_streams() -> None:
    """PR-D: 거래원 합성 틱이 KIS(_state.session.streams)가 아닌 키움 매니저 스트림에
    브로드캐스트된다(착지 위치 kiwoom_live 통일, ADR-0118 §3). 각 스트림 활성집합 필터가
    멤버십 흡수 → 소유 스트림 1개만 실수집."""
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State
    from hoga.live.snapshot import SnapshotKind
    from hoga.live.ticks import WsTick

    lifecycle.reset_for_tests()

    class _RecStream:
        def __init__(self) -> None:
            self.ticks: list = []

        async def on_tick(self, tick) -> None:
            self.ticks.append(tick)

    s0, s1 = _RecStream(), _RecStream()

    class _FakeKiwoom:
        def broker_dispatch_streams(self):
            return [s0, s1]

    lifecycle._state = _State(kiwoom_session=_FakeKiwoom())
    tick = WsTick(code="005930", t_ms=1, kind=SnapshotKind.BROKER, payload={})
    await lifecycle._dispatch_broker_tick(tick)
    assert s0.ticks == [tick]
    assert s1.ticks == [tick]  # 전 키움 스트림에 브로드캐스트


@pytest.mark.asyncio
async def test_dispatch_broker_tick_noop_when_kiwoom_off() -> None:
    """키움 미배선(off)이면 거래원 디스패치는 no-op(폴백 없음 — 예외 없이)."""
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State
    from hoga.live.snapshot import SnapshotKind
    from hoga.live.ticks import WsTick

    lifecycle.reset_for_tests()
    lifecycle._state = _State()  # kiwoom_session None
    await lifecycle._dispatch_broker_tick(
        WsTick(code="005930", t_ms=1, kind=SnapshotKind.BROKER, payload={})
    )  # 예외 없음


@pytest.mark.asyncio
async def test_refresh_resyncs_broker_poller_targets(monkeypatch, tmp_path) -> None:
    """watchlist 변경 후 refresh가 타깃을 갱신된 live_set으로 재동기화한다."""
    from hoga.live import lifecycle, session_gate

    lifecycle.reset_for_tests()
    monkeypatch.setenv("KIS_APP_KEY", "K")
    monkeypatch.setenv("KIS_APP_SECRET", "S")
    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)
    created = _patch_pollers(monkeypatch)

    _write_watchlist(tmp_path, ["005930"])
    try:
        await lifecycle.start_live_stream(data_dir=tmp_path)
        assert created[0].targets == {"005930"}

        _write_watchlist(tmp_path, ["005930", "000660"])
        await lifecycle.refresh_live_stream(data_dir=tmp_path)
        assert created[0].targets == set(lifecycle._state.live_set)
        assert "000660" in created[0].targets
    finally:
        await lifecycle.stop_live_stream()
