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
