"""get_status가 kiwoom 세션 관측을 노출하는지 (ADR-0116, PR-4)."""
from hoga.live import lifecycle
from hoga.live.lifecycle import _State


class _FakeKiwoomSession:
    def status(self):
        return {"enabled": True, "connected_accounts": 2, "subscribed_count": 350}


def test_get_status_kiwoom_none_when_no_session():
    lifecycle.reset_for_tests()
    lifecycle._state = _State()
    assert lifecycle.get_status().kiwoom is None


def test_get_status_exposes_kiwoom_session_status():
    lifecycle.reset_for_tests()
    lifecycle._state = _State(kiwoom_session=_FakeKiwoomSession())
    kiwoom = lifecycle.get_status().kiwoom
    assert kiwoom == {"enabled": True, "connected_accounts": 2, "subscribed_count": 350}
