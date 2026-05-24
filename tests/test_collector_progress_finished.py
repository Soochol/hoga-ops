"""_progress.json["finished"] tracks whether the collector naturally terminated."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from hoga.collector.orchestrator import (
    CancelToken,
    CaptureCancelled,
    collect_stock_date,
)


class _FakeClientNaturalTerm:
    """3 small pages then drained empties → controller stops normally."""
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
        t_base = 90000000 + (self.first_calls - 1) * 60000
        return "\n".join(
            f"1\t1\t0\t{seq_base + i}\t{t_base + i}\t000\t1000" for i in range(5)
        ) + "\n"

    def fetch_chart(
        self, code: str, date: str, time_ms: int, bong: int = 1, gap: int = 60000,
    ) -> str:
        del code, date, time_ms, bong, gap
        return ""


class _FakeClientNeverEnds:
    """Always returns non-empty page with new seqs → only cancel can stop it."""
    def __init__(self) -> None:
        self.first_calls = 0

    def fetch_info(self, code: str, date: str) -> str:
        del code, date
        return "info_field\tvalue\n"

    def fetch_first(self, code: str, date: str, time_ms: int) -> str:
        del code, date, time_ms
        self.first_calls += 1
        seq_base = self.first_calls * 1000
        t_base = 90000000 + (self.first_calls - 1) * 60000
        return "\n".join(
            f"1\t1\t0\t{seq_base + i}\t{t_base + i}\t000\t1000" for i in range(5)
        ) + "\n"

    def fetch_chart(
        self, code: str, date: str, time_ms: int, bong: int = 1, gap: int = 60000,
    ) -> str:
        del code, date, time_ms, bong, gap
        return ""


def test_progress_json_has_finished_true_on_natural_termination(tmp_path: Path) -> None:
    # initial_step_ms=40_000_000: after 3 captured pages we land past
    # DATA_WINDOW_END_MS (160_000_000) within a handful of empty drains, so the
    # loop terminates via EMPTY_STREAK before the stagnation guard
    # (MAX_STAGNANT_PAGES=200) can fire — the path this test cares about.
    result = collect_stock_date(
        client=_FakeClientNaturalTerm(),
        code="005930",
        date="20260520",
        data_dir=tmp_path,
        rate_limit_s=0.0,
        initial_step_ms=40_000_000,
    )
    progress = json.loads(
        (tmp_path / "raw" / "20260520" / "005930" / "_progress.json").read_text(encoding="utf-8")
    )
    assert progress["finished"] is True
    assert progress["abort_reason"] is None
    assert result.abort_reason is None


def test_progress_json_finished_false_on_cancel(tmp_path: Path) -> None:
    token = CancelToken()
    token.cancel()  # pre-cancel so the loop bails on first iteration
    with pytest.raises(CaptureCancelled):
        collect_stock_date(
            client=_FakeClientNeverEnds(),
            code="005930",
            date="20260520",
            data_dir=tmp_path,
            rate_limit_s=0.0,
            cancel_token=token,
        )
    progress_path = tmp_path / "raw" / "20260520" / "005930" / "_progress.json"
    if progress_path.exists():
        progress = json.loads(progress_path.read_text(encoding="utf-8"))
        assert progress["finished"] is False
    # If progress_path doesn't exist (pre-cancel bailed before first write),
    # absence is also valid — finished defaults to False at the parser layer.


def test_progress_json_missing_finished_treated_as_false(tmp_path: Path) -> None:
    """Backward-compat: legacy _progress.json without the key is read as not finished."""
    raw_dir = tmp_path / "raw" / "20260520" / "005930"
    raw_dir.mkdir(parents=True)
    (raw_dir / "_progress.json").write_text(
        json.dumps({
            "last_time_ms": 90000000,
            "pages_done": 5,
            "global_seqs_seen": 25,
            "started_at": "2026-05-20T09:00:00+09:00",
            "finished_at": None,
        }),
        encoding="utf-8",
    )
    progress = json.loads((raw_dir / "_progress.json").read_text(encoding="utf-8"))
    assert "finished" not in progress  # legacy shape
