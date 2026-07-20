"""Live Capture lifecycle singleton — status + today-promote + peak accessors.

ADR-0118 PR-G: KIS WebSocket 계층(streams·watchdog·dynamic-N·capture_health)은 삭제됐다.
실시간 캡처=키움 전담이므로 status는 kiwoom_session.status()에서 유도되고, 오늘 피크
스냅샷은 키움 세션의 스트림에서 조회한다. WS watchdog/재구독/venue 스왑/build_conn 테스트는
제거됐다(키움 세션 매니저·test_lifecycle_kiwoom로 이관).
"""

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


def test_reset_for_tests_is_idempotent() -> None:
    """Helper for test isolation must be safe to call multiple times."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    lifecycle.reset_for_tests()
    assert lifecycle.get_status().running is False


# ── 오늘 피크 스냅샷 (키움 스트림 소싱, ADR-0118 PR-G) ──────────────────────────

def test_get_today_ask_peak_returns_matching_stream_snapshot() -> None:
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State

    lifecycle.reset_for_tests()

    class _FakeStream:
        def ask_peak_snapshot(self, code: str) -> dict | None:
            return {"date": "20260616", "code": code, "all_qty": 9000}

    class _FakeKiwoom:
        def broker_dispatch_streams(self):
            return [_FakeStream()]

    lifecycle._state = _State(kiwoom_session=_FakeKiwoom())

    assert lifecycle.get_today_ask_peak("005930") == {
        "date": "20260616",
        "code": "005930",
        "all_qty": 9000,
    }


def test_get_today_ask_peak_skips_non_matching_or_legacy_streams() -> None:
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State

    lifecycle.reset_for_tests()

    class _OwningStream:
        def __init__(self, owned: set[str]) -> None:
            self._owned = owned

        def ask_peak_snapshot(self, code: str) -> dict | None:
            if code not in self._owned:
                return None  # 코드-disjoint: 비소유 코드는 None
            return {"date": "20260616", "code": code, "all_qty": 9000}

    class _FakeKiwoom:
        def broker_dispatch_streams(self):
            # object()는 ask_peak_snapshot 없음(레거시/미지원 스트림 — getattr None → skip)
            return [object(), _OwningStream({"000660"})]

    lifecycle._state = _State(kiwoom_session=_FakeKiwoom())

    assert lifecycle.get_today_ask_peak("005930") is None
    assert lifecycle.get_today_ask_peak("000660") == {
        "date": "20260616",
        "code": "000660",
        "all_qty": 9000,
    }
    assert lifecycle.get_today_ask_peak("373220") is None


def test_get_today_ask_peak_none_when_kiwoom_off() -> None:
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State

    lifecycle.reset_for_tests()
    lifecycle._state = _State()  # kiwoom_session None
    assert lifecycle.get_today_ask_peak("005930") is None


def test_get_today_bid_peak_returns_matching_stream_snapshot() -> None:
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State

    lifecycle.reset_for_tests()

    class _FakeStream:
        def bid_peak_snapshot(self, code: str) -> dict | None:
            return {"date": "20260619", "code": code, "all_qty": 12_000}

    class _FakeKiwoom:
        def broker_dispatch_streams(self):
            return [_FakeStream()]

    lifecycle._state = _State(kiwoom_session=_FakeKiwoom())

    assert lifecycle.get_today_bid_peak("005930") == {
        "date": "20260619",
        "code": "005930",
        "all_qty": 12_000,
    }


# ── Today Promotion 접근자 (ADR-0043) ───────────────────────────────────────────

def test_record_today_promote_success_persists_per_code() -> None:
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


# ── get_status WS 키 ────────────────────────────────────────────────────────────

def test_get_status_includes_ws_transport_keys() -> None:
    """LiveStatus에 transport/ws_connected/live_set 키가 포함된다."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    status = lifecycle.get_status()
    assert status.transport == "ws"
    assert isinstance(status.ws_connected, bool)
    assert isinstance(status.live_set, list)


# ── refresh 가드 ─────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_refresh_live_stream_early_returns_when_never_started(tmp_path) -> None:
    """started_at_ms None(기동 전) + KIS creds 없음이면 start 폴백이 창구 가드로 no-op."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    await lifecycle.refresh_live_stream(data_dir=tmp_path)
    assert lifecycle._state.started_at_ms is None
    assert lifecycle.get_status().running is False
