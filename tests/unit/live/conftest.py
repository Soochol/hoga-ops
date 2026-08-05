"""Shared isolation for tests/unit/live.

`lifecycle.reset_for_tests()` is the comprehensive singleton reset: it cancels
in-flight WS/flush/recorder/collector tasks, resets `_state`/`_buffer`, clears
`_today_promote_last_ms`, and cascades into `kis_runtime.reset_for_tests()`
(which in turn resets `account_health`). Running it autouse before AND after
every live test guarantees baseline isolation so a future test can't leak
singleton state into its neighbours by forgetting to reset (the class of bug
that made per-file `_reset` fixtures proliferate).

This does NOT replace test-specific fixtures: env hermeticity
(`_hermetic_kis_env`), domain cache clears (`_ranking_cache`), or the
`account_health._ws_probe` monkeypatch are per-file setup, not reset
boilerplate, and stay where they are. `kis_capacity_runtime._schedulers` is
cleaned by its own autouse fixture in test_kis_capacity_runtime.py.
"""
from __future__ import annotations

import pytest

from hoga.live import lifecycle


@pytest.fixture(autouse=True)
def _reset_live_singletons():
    lifecycle.reset_for_tests()
    yield
    lifecycle.reset_for_tests()  # teardown runs even if the test body raises


class _UniformNxtMap(dict):
    """모든 코드에 같은 답을 주는 마스터 대역 — `nxt_enabled_by_code()` 의 계약을 흉내낸다.

    `subscription_venues` 가 `nxt_map.get(code)` 로 묻는데, `defaultdict` 는 `.get` 에
    `__missing__` 을 태우지 않아 없는 키에 **None(모름)** 을 돌려준다. 그러면 fail-open
    으로 3 venue 가 되어 고정이 안 된다. 그래서 `.get` 을 직접 덮는다.
    """

    def __init__(self, answer: bool | None) -> None:
        super().__init__()
        self._answer = answer

    def get(self, key, default=None):
        return self._answer


@pytest.fixture
def krx_only_master(monkeypatch):
    """마스터를 **전 종목 NXT 미상장**으로 고정 — wire = bare code 1개.

    파티션·킥 복구·표시 장부처럼 **venue 파생이 주제가 아닌** 테스트가 쓴다. 고정하지
    않으면 심볼 캐시가 빈 테스트 환경에서 `nxt_enabled_by_code()` 가 None 을 돌려주고,
    `subscription_venues` 의 fail-open 이 종목당 wire 를 3개로 만들어 모든 기대값이
    흔들린다(그 fail-open 자체는 의도된 설계다 — ADR-0140 §2).

    venue 파생·슬롯 가중 자체는 `test_venue_subscription_plan.py` 가 전담한다.
    """
    from hoga.api import symbols

    monkeypatch.setattr(symbols, "nxt_enabled_by_code", lambda: _UniformNxtMap(False))


@pytest.fixture
def nxt_listed_master(monkeypatch):
    """마스터를 **전 종목 NXT 상장**으로 고정 — wire = {bare, _NX, _AL} 3개."""
    from hoga.api import symbols

    monkeypatch.setattr(symbols, "nxt_enabled_by_code", lambda: _UniformNxtMap(True))
