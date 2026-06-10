"""account_health — REST 토큰 latch + WS probe 통합 신호 (계정 분리 2026-06-10)."""
import logging

import pytest

import hoga.live.account_health as account_health


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    account_health.reset_for_tests()           # REST latch 초기화
    monkeypatch.setattr(account_health, "_ws_probe", None)  # 각 테스트 probe 미등록 시작(auto-revert)
    yield
    account_health.reset_for_tests()


def test_mark_rest_auth_degraded_latches_account1():
    assert account_health.is_degraded(1) is False
    account_health.mark_rest_auth_degraded(1)
    assert account_health.is_degraded(1) is True
    assert account_health.degraded_account_ids() == {1}


def test_mark_rest_auth_degraded_noops_for_account0():
    """account 0은 폴백 대상 자체 → 마킹해도 degraded 아님."""
    account_health.mark_rest_auth_degraded(0)
    assert account_health.is_degraded(0) is False
    assert account_health.degraded_account_ids() == set()


def test_mark_logs_once_only(caplog):
    """latch 전환(미latch→latch) 시 1회만 WARNING — 멱등 재마킹은 무로그(silent
    capacity degradation 방지하되 로그 벽 안 만듦)."""
    with caplog.at_level(logging.WARNING, logger="hoga.live.account_health"):
        account_health.mark_rest_auth_degraded(1)
        account_health.mark_rest_auth_degraded(1)
        account_health.mark_rest_auth_degraded(1)
    warnings = [r for r in caplog.records if "REST-degraded" in r.message]
    assert len(warnings) == 1


def test_ws_probe_signal(monkeypatch):
    """등록된 WS probe의 저하 집합이 is_degraded/degraded_account_ids에 반영된다."""
    monkeypatch.setattr(account_health, "_ws_probe", lambda: {1})
    assert account_health.is_degraded(1) is True
    assert account_health.is_degraded(0) is False
    assert account_health.degraded_account_ids() == {1}


def test_union_of_rest_latch_and_ws_probe(monkeypatch):
    """통합 신호 = REST 토큰 latch ∪ WS 저하."""
    account_health.mark_rest_auth_degraded(1)
    monkeypatch.setattr(account_health, "_ws_probe", lambda: {2})
    assert account_health.degraded_account_ids() == {1, 2}
    assert account_health.is_degraded(1) is True
    assert account_health.is_degraded(2) is True


def test_unregistered_probe_is_empty():
    """probe 미등록(부팅 극초기) → WS 저하 빈 집합(보수적 — 라우팅 안 막음)."""
    assert account_health.degraded_account_ids() == set()
    assert account_health.is_degraded(1) is False


def test_is_degraded_swallows_probe_errors(monkeypatch):
    """probe 조회 실패 → 보수적으로 빈 집합(라우팅을 막지 않는다)."""
    def boom():
        raise RuntimeError("probe not ready")
    monkeypatch.setattr(account_health, "_ws_probe", boom)
    assert account_health.is_degraded(1) is False
    assert account_health.degraded_account_ids() == set()


def test_register_ws_probe_replaces():
    account_health.register_ws_probe(lambda: {3})
    assert account_health.is_degraded(3) is True


def test_reset_clears_latch_not_probe(monkeypatch):
    """reset_for_tests는 REST latch만 초기화(WS probe는 lifecycle 등록분 유지 — stateless,
    _state 비우면 자연히 빈 집합)."""
    monkeypatch.setattr(account_health, "_ws_probe", lambda: {1})
    account_health.mark_rest_auth_degraded(2)
    account_health.reset_for_tests()
    assert account_health.is_degraded(2) is False  # REST latch 비워짐
    assert account_health.is_degraded(1) is True   # WS probe는 유지
