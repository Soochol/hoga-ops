"""슬롯 부족 알림은 슬롯 배정이 아닌 요청한 venue 전체의 등록 ACK로 해제한다."""
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from hoga.live import lifecycle


@pytest.mark.parametrize("registered,ready", [
    ([], set()),
    (["005930"], {"krx"}),
    (["005930", "005930_NX"], {"krx", "nxt"}),
    (["005930", "005930_NX", "005930_AL"], {"krx", "nxt", "all"}),
])
def test_readiness_requires_all_requested_registrations(monkeypatch, registered, ready):
    # 같은 wire code를 요청 종류별로 확인한다.
    monkeypatch.setattr(lifecycle._state, "kiwoom_session", SimpleNamespace(
        status=lambda: {"ready_registrations": registered, "subscribed_codes": ["005930"]},
    ))
    requests = {"005930": {"KRX"}, "000660": {"KRX"}}
    assert lifecycle.ready_view_subscription_codes(requests) == ({"005930"} if "krx" in ready else set())
    for key, venues in [("nxt", {"NXT"}), ("all", {"KRX", "NXT", "UN"})]:
        assert lifecycle.ready_view_subscription_codes({"005930": venues}) == (
            {"005930"} if key in ready else set()
        )


def test_default_venues_follow_master_and_require_nxt_and_un_ack(monkeypatch):
    from hoga.live import kiwoom_session

    master = Mock(return_value={"005930": True, "000660": False})
    monkeypatch.setattr(kiwoom_session, "_nxt_map", master)
    registered = ["005930", "000660"]
    monkeypatch.setattr(lifecycle._state, "kiwoom_session", SimpleNamespace(
        status=lambda: {"ready_registrations": registered},
    ))
    requests = {"005930": None, "000660": None}
    assert lifecycle.ready_view_subscription_codes(requests) == {"000660"}
    master.assert_called_once()  # 여러 대기 종목도 마스터 전체 순회는 확인 패스당 한 번이다.
    registered.extend(["005930_NX", "005930_AL"])
    assert lifecycle.ready_view_subscription_codes(requests) == set(requests)


def test_no_session_or_missing_registration_snapshot_does_not_claim_recovery(monkeypatch):
    monkeypatch.setattr(lifecycle._state, "kiwoom_session", None)
    assert lifecycle.ready_view_subscription_codes({"005930": {"KRX"}}) == set()
    monkeypatch.setattr(lifecycle._state, "kiwoom_session", SimpleNamespace(
        status=lambda: {"subscribed_codes": ["005930"]},
    ))
    assert lifecycle.ready_view_subscription_codes({"005930": {"KRX"}}) == set()
