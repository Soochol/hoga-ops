"""on_progress callback fires once per Page, carrying the same fields _progress.json holds."""
from __future__ import annotations

from pathlib import Path

from hoga.collector.orchestrator import (
    ProgressEvent,
    collect_stock_date,
)


class _FakeClient:
    """Returns 3 tiny Pages then an empty Page, so the controller terminates."""
    def __init__(self) -> None:
        self.first_calls = 0

    def fetch_info(self, code: str, date: str) -> str:
        return "info_field\tvalue\n"

    def fetch_first(self, code: str, date: str, time_ms: int) -> str:
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
        allow_partial=True,
        on_progress=events.append,
    )

    assert len(events) >= 3, f"expected >=3 progress events, got {len(events)}"
    for e in events:
        assert e.code == "005930"
        assert e.date == "20260520"
        assert e.pages_done >= 1
        assert e.events_seen >= 0
        assert e.frontier_hhmmss >= 84000000  # >= DATA_WINDOW_START_MS


def test_no_callback_keeps_cli_behavior(tmp_path: Path) -> None:
    """on_progress=None must not change collector output or raise."""
    client = _FakeClient()
    result = collect_stock_date(
        client=client,
        code="005930",
        date="20260520",
        data_dir=tmp_path,
        rate_limit_s=0.0,
        allow_partial=True,
        on_progress=None,
    )
    assert result.pages_written >= 1
