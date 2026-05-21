"""FakeHogaplayClient — used only when HOGA_ENABLE_TEST_ENDPOINTS=1.

Implements HogaplayClientProto with deterministic in-memory data.
Each fetch_first call returns a small Page; the loop terminates after 5 Pages.
Used by Playwright capture-flow.spec.ts and the SSE integration test.
"""
from __future__ import annotations

import time

# Number of non-empty Pages the fake emits before draining the loop.
_VISIBLE_PAGES = 5


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
        del code, date, time_ms
        self._first_call += 1
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
