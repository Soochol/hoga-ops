"""account_health — REST 토큰 latch (계정 분리 2026-06-10; ADR-0118 PR-G에서 WS probe 제거)."""
import logging

import pytest

import hoga.live.account_health as account_health


@pytest.fixture(autouse=True)
def _reset():
    account_health.reset_for_tests()           # REST latch 초기화
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


def test_no_latch_is_empty():
    """latch 미설정(부팅 극초기) → 빈 집합(보수적 — 라우팅 안 막음)."""
    assert account_health.degraded_account_ids() == set()
    assert account_health.is_degraded(1) is False


def test_reset_clears_latch():
    """reset_for_tests는 REST latch를 초기화한다."""
    account_health.mark_rest_auth_degraded(2)
    assert account_health.is_degraded(2) is True
    account_health.reset_for_tests()
    assert account_health.is_degraded(2) is False  # REST latch 비워짐
