"""get_status가 kiwoom 세션 관측을 노출하는지 (ADR-0116 PR-4 · ADR-0118 PR-G).

PR-G 이후 get_status의 running/ws_connected/live_set/last_tick/degraded/capture_*는
모두 kiwoom_session.status()에서 유도된다."""
from hoga.live import lifecycle
from hoga.live.lifecycle import _State


def _kiwoom_status(**overrides):
    """KiwoomSessionManager.status()의 전체 shape(get_status가 읽는 키를 모두 포함)."""
    base = {
        "enabled": True,
        "accounts_configured": 2,
        "connected_accounts": 2,
        "subscribed_count": 2,
        "subscribed_codes": ["005930", "000660"],
        "last_tick_ms": 1_770_000_000_000,
        "warmup_incomplete": False,
        "accounts": [
            {"account_id": 0, "connected": True, "sub_expected": 2,
             "sub_acked": 2, "kicked_by_peer": False, "last_tick_ms": 1_770_000_000_000},
            {"account_id": 1, "connected": True, "sub_expected": 0,
             "sub_acked": 0, "kicked_by_peer": False, "last_tick_ms": None},
        ],
    }
    base.update(overrides)
    return base


class _FakeKiwoomSession:
    def __init__(self, **overrides):
        self._status = _kiwoom_status(**overrides)

    def status(self):
        return self._status


def test_get_status_kiwoom_none_when_no_session():
    lifecycle.reset_for_tests()
    lifecycle._state = _State()
    st = lifecycle.get_status()
    assert st.kiwoom is None
    assert st.running is False
    assert st.ws_connected is False
    assert st.live_set == []


def test_get_status_exposes_kiwoom_session_status():
    lifecycle.reset_for_tests()
    session = _FakeKiwoomSession()
    lifecycle._state = _State(kiwoom_session=session)
    st = lifecycle.get_status()
    # kiwoom 필드는 raw passthrough.
    assert st.kiwoom == session.status()
    # 파생 필드가 kiwoom status에서 나온다(ADR-0118 PR-G).
    assert st.running is True
    assert st.ws_connected is True
    assert st.live_set == ["005930", "000660"]
    assert st.watchlist_count == 2
    assert st.last_tick_ms == 1_770_000_000_000
    assert st.capture_healthy is True
    assert st.capture_reason == "healthy"


def test_get_status_degraded_accounts_from_kicked_peers():
    lifecycle.reset_for_tests()
    status = _kiwoom_status()
    status["accounts"][1]["kicked_by_peer"] = True
    lifecycle._state = _State(kiwoom_session=_FakeKiwoomSession(**status))
    st = lifecycle.get_status()
    assert st.degraded_accounts == [1]


def test_get_status_warmup_incomplete_reason():
    lifecycle.reset_for_tests()
    lifecycle._state = _State(
        kiwoom_session=_FakeKiwoomSession(warmup_incomplete=True)
    )
    st = lifecycle.get_status()
    assert st.capture_healthy is False
    assert st.capture_reason == "warmup_incomplete"
