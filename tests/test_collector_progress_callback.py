"""on_progress callback fires once per Page, carrying the same fields _progress.json holds."""
from __future__ import annotations

from pathlib import Path

import pytest

from hoga.collector.orchestrator import (
    CancelToken,
    CaptureCancelled,
    ProgressEvent,
    collect_stock_date,
)


class _FakeClient:
    """Returns 3 tiny Pages then an empty Page, so the controller terminates."""
    def __init__(self) -> None:
        self.first_calls = 0

    def fetch_info(self, code: str, date: str) -> str:
        del code, date
        return "info_field\tvalue\n"

    def fetch_first(self, code: str, date: str, time_ms: int) -> str:
        del code, date, time_ms
        self.first_calls += 1
        if self.first_calls > 3:
            return ""
        seq_base = self.first_calls * 1000
        t_base = 90000000 + (self.first_calls - 1) * 60000  # 09:00:00 + N min
        return "\n".join(
            f"1\t1\t0\t{seq_base + i}\t{t_base + i}\t000\t1000" for i in range(5)
        ) + "\n"

    def fetch_chart(
        self, code: str, date: str, time_ms: int, bong: int = 1, gap: int = 60000
    ) -> str:
        del code, date, time_ms, bong, gap
        return ""


def test_on_progress_called_per_page(tmp_path: Path) -> None:
    events: list[ProgressEvent] = []
    client = _FakeClient()

    collect_stock_date(
        client=client,
        code="005930",
        date="20260520",
        data_dir=tmp_path,
        rate_limit_s=0.0,
        on_progress=events.append,
    )

    assert len(events) >= 3, f"expected >=3 progress events, got {len(events)}"
    for e in events:
        assert e.code == "005930"
        assert e.date == "20260520"
        assert e.pages_done >= 1
        assert e.events_seen >= 0
        assert e.frontier >= 84000000  # >= DATA_WINDOW_START_MS


def test_no_callback_keeps_cli_behavior(tmp_path: Path) -> None:
    """on_progress=None must not change collector output or raise."""
    client = _FakeClient()
    result = collect_stock_date(
        client=client,
        code="005930",
        date="20260520",
        data_dir=tmp_path,
        rate_limit_s=0.0,
        on_progress=None,
    )
    assert result.pages_written >= 1


def test_cancel_token_stops_loop(tmp_path: Path) -> None:
    token = CancelToken()
    seen: list[ProgressEvent] = []

    def on_progress(e: ProgressEvent) -> None:
        seen.append(e)
        if len(seen) == 2:
            token.cancel()

    client = _FakeClient()
    with pytest.raises(CaptureCancelled):
        collect_stock_date(
            client=client,
            code="005930",
            date="20260520",
            data_dir=tmp_path,
            rate_limit_s=0.0,
            on_progress=on_progress,
            cancel_token=token,
        )

    # Raw pages written before cancel are preserved.
    raw_dir = tmp_path / "raw" / "20260520" / "005930"
    written = sorted(raw_dir.glob("first_*.tsv"))
    assert len(written) >= 1


def test_on_progress_carries_http_telemetry(tmp_path: Path) -> None:
    """Every progress event after the first fetch carries the rolling http p50
    and a zero throttle count when no 429 occurred (upstream-health telemetry,
    2026-07-09 slow-hogaplay investigation)."""
    events: list[ProgressEvent] = []
    client = _FakeClient()

    collect_stock_date(
        client=client,
        code="005930",
        date="20260520",
        data_dir=tmp_path,
        rate_limit_s=0.0,
        on_progress=events.append,
    )

    assert events, "expected progress events"
    for e in events:
        assert e.recent_http_p50_ms is not None
        assert e.recent_http_p50_ms >= 0
        assert e.throttled_pages == 0


def test_on_progress_counts_throttled_pages(tmp_path: Path) -> None:
    """A 429 increments throttled_pages on subsequent progress events, so the
    UI can distinguish 'we are backing off' from 'hogaplay is slow'."""
    from hoga.collector.client import HogaplayHTTPError

    class _ThrottleOnce(_FakeClient):
        def __init__(self) -> None:
            super().__init__()
            self._throttled = False

        def fetch_first(self, code: str, date: str, time_ms: int) -> str:
            # Throttle exactly once, on the second fetch attempt.
            if self.first_calls == 1 and not self._throttled:
                self._throttled = True
                raise HogaplayHTTPError("throttled", status_code=429)
            return super().fetch_first(code, date, time_ms)

    events: list[ProgressEvent] = []
    collect_stock_date(
        client=_ThrottleOnce(),
        code="005930",
        date="20260520",
        data_dir=tmp_path,
        rate_limit_s=0.0,
        on_progress=events.append,
    )

    assert events, "expected progress events"
    assert events[-1].throttled_pages == 1
    # Events emitted after the throttle carry the cumulative count.
    assert all(e.throttled_pages in (0, 1) for e in events)
