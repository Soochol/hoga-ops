"""FakeHogaplayClient — used only when HOGA_ENABLE_TEST_ENDPOINTS=1.

Implements HogaplayClientProto with deterministic in-memory data.
Each fetch_first call returns a small Page; the loop terminates after 5 Pages.
Used by Playwright capture-flow.spec.ts and the SSE integration test.
"""
from __future__ import annotations

import time

from hoga.collector.client import CookieExpiredError

# Number of non-empty Pages the fake emits before draining the loop.
_VISIBLE_PAGES = 5

# Cross-instance counter and trigger for cookie-expiry injection.
# Used by /api/test/cookie_expire_at so a Playwright spec can deterministically
# exercise the cookie-pause path. None disables injection.
_global_first_calls = 0
_raise_on_request_index: int | None = None


def configure_fake_to_raise_on(request_index: int | None) -> None:
    """Cause the fake to raise CookieExpiredError on its Nth global
    fetch_first call. Pass None (or a negative value) to disable.
    """
    global _raise_on_request_index, _global_first_calls
    _raise_on_request_index = request_index if (request_index is not None and request_index > 0) else None
    _global_first_calls = 0


class FakeHogaplayClient:
    """In-memory hogaplay stub. Single-instance reuse fine."""

    def __init__(self) -> None:
        self._first_call = 0

    def fetch_info(self, code: str, date: str) -> str:
        del date
        return (
            f"code\t{code}\nname\tFakeCorp\n"
            "session_open\t90000000\nsession_close\t153000000\n"
        )

    def fetch_first(self, code: str, date: str, time_ms: int) -> str:
        global _global_first_calls
        del code, date, time_ms
        self._first_call += 1
        _global_first_calls += 1
        if _raise_on_request_index is not None and _global_first_calls == _raise_on_request_index:
            raise CookieExpiredError("fake cookie expiry (test injection)")
        if self._first_call > _VISIBLE_PAGES:
            # Empty page → collector's drain loop. The orchestrator now skips
            # on_progress when frontier is unchanged, so the drain no longer
            # publishes a flood of SSE events and the prior 3ms throttle is
            # unnecessary.
            return ""
        # 150ms throttle on the first 5 pages so the visible progress is paced.
        time.sleep(0.15)
        seq_base = self._first_call * 100
        t_base = 90000000 + (self._first_call - 1) * 60000  # 09:00 + N min
        rows = [
            f"1\t1\t0\t{seq_base + i}\t{t_base + i * 100}\t000\t1000"
            for i in range(20)
        ]
        return "\n".join(rows) + "\n"

    def fetch_chart(
        self,
        code: str,
        date: str,
        time_ms: int,
        bong: int = 1,
        gap: int = 60000,
    ) -> str:
        del code, time_ms, bong, gap
        return f"chart\t{date}\n"
