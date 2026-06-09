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
import json
from pathlib import Path

import pytest


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

    @property
    def alive(self) -> bool:
        return self.started and not self.stopped


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
    """refresh 후 rest_poller.set_excluded_codes가 새 live_set으로 갱신된다."""
    import json as _json

    from hoga.api import symbols
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State

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

    lifecycle._state = _State(
        started_at_ms=1,
        watchlist_codes=("999999",),
        stream_obj=_FakeStream(),
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

    await lifecycle.refresh_live_stream(data_dir=tmp_path)

    expected = {f"{i:06d}" for i in range(5)}
    assert fake_poller.excluded == expected, (
        "refresh 후 set_excluded_codes(new_live_set)이 호출되어야 함(배타 갱신)"
    )


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

    lifecycle.on_view_subscribe("005930")

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

    lifecycle.on_view_unsubscribe("005930")

    assert "005930" in fake_poller.unsubscribed


def test_on_view_subscribe_noop_when_no_poller() -> None:
    """rest_poller가 없을 때(오프라인/start 전) 예외 없이 no-op."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    # 폴러 없이도 예외가 나면 안 된다
    lifecycle.on_view_subscribe("005930")


def test_on_view_unsubscribe_noop_when_no_poller() -> None:
    """rest_poller가 없을 때 예외 없이 no-op."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    lifecycle.on_view_unsubscribe("005930")


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


# ── _sync_and_live_set 헬퍼 단위 테스트 (ADR-0067 배타 단일화) ──────────────────


def test_sync_and_live_set_calls_set_excluded_and_returns_tuple() -> None:
    """_sync_and_live_set(codes, poller)가 set_excluded_codes(set(codes))를 호출하고
    tuple(codes)를 반환한다."""
    from hoga.live.lifecycle import _sync_and_live_set

    poller = _FakePoller()
    codes = ["005930", "000660"]
    result = _sync_and_live_set(codes, poller)

    assert result == tuple(codes), "_sync_and_live_set은 tuple(codes)를 반환해야 함"
    assert poller.excluded == set(codes), (
        "_sync_and_live_set은 set_excluded_codes(set(codes))를 호출해야 함"
    )


def test_sync_and_live_set_no_poller_returns_tuple() -> None:
    """_sync_and_live_set(codes, None)은 예외 없이 tuple(codes)를 반환한다(오프라인 폴백)."""
    from hoga.live.lifecycle import _sync_and_live_set

    codes = ["005930", "000660"]
    result = _sync_and_live_set(codes, None)

    assert result == tuple(codes), "rest_poller 없이도 tuple(codes)를 반환해야 함"
