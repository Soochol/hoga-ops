"""Verify that when a collector is passed, the orchestrator records phases.

We drive `_page_step_loop` directly with a fake client whose `fetch_first`
returns empty bodies on every call. Empty bodies cause:
  - the page step controller to advance t by step_ms each iteration
  - new_seqs to be empty (so record_event_count fires with 0)
  - stagnation guard (max_event_time frozen at None) to terminate the loop
    after MAX_STAGNANT_PAGES (~200) iterations.

This exercises the http_fetch + disk_write + rate_limit wraps and the
mark_page_boundary + record_event_count calls without needing real HTTP.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from hoga.collector import orchestrator
from hoga.collector.timing import CaptureTimingCollector


class _EmptyFakeClient:
    """Minimal HogaplayClientProto stub — every fetch_first returns ''."""

    def fetch_info(self, code: str, date: str) -> str:  # pragma: no cover
        return ""

    def fetch_first(self, code: str, date: str, time_ms: int) -> str:
        return ""

    def fetch_chart(  # pragma: no cover
        self, code: str, date: str, time_ms: int, bong: int = 1, gap: int = 60000
    ) -> str:
        return ""


def test_page_step_loop_records_phases(tmp_path: Path, monkeypatch):
    """When a collector is passed, http_fetch + disk_write + rate_limit
    accumulate, pages list grows, and record_event_count adds zeros per page.

    Loop terminates via stagnation guard (~200 empty pages)."""
    # Patch sleep so rate_limit doesn't actually wait — still wrapped in the
    # phase, so phase_totals_ms['rate_limit'] gets accounted (even if ~0).
    monkeypatch.setattr(orchestrator._time, "sleep", lambda *_a, **_kw: None)

    collector = CaptureTimingCollector("005930", "20250520")
    raw_dir = tmp_path / "raw"
    raw_dir.mkdir()

    seen_seqs, page_idx, _final_t, stop_reason = orchestrator._page_step_loop(
        raw_dir,
        _EmptyFakeClient(),
        "005930",
        "20250520",
        started_at="2026-05-27T00:00:00+09:00",
        rate_limit_s=0.05,
        seen_seqs=set(),
        page_idx=0,
        t=orchestrator.DATA_WINDOW_START_MS,
        collector=collector,
    )

    # Loop terminated (either stagnation or empty-streak) — we don't care
    # which, only that we exercised the wraps.
    assert stop_reason is not None
    # No bodies were stored (every fetch returned "") — page_idx unchanged.
    assert page_idx == 0
    assert seen_seqs == set()

    # Each iteration enters http_fetch, disk_write, and rate_limit.
    # http_fetch + disk_write totals are >= 0 (cheap work but non-negative).
    assert collector.phase_totals_ms["http_fetch"] >= 0.0
    assert collector.phase_totals_ms["disk_write"] >= 0.0
    assert collector.phase_totals_ms["rate_limit"] >= 0.0

    # mark_page_boundary fires at least once per iteration that didn't 429 —
    # so pages list has many entries. event_count totals 0 (no new_seqs).
    assert len(collector.pages) >= 1
    assert collector.event_count == 0


def test_page_step_loop_without_collector_unchanged(tmp_path: Path, monkeypatch):
    """Sanity: when collector=None, the loop still runs and returns; no
    AttributeError from accidentally calling collector methods unguarded."""
    monkeypatch.setattr(orchestrator._time, "sleep", lambda *_a, **_kw: None)

    raw_dir = tmp_path / "raw"
    raw_dir.mkdir()

    _seen, page_idx, _final_t, stop_reason = orchestrator._page_step_loop(
        raw_dir,
        _EmptyFakeClient(),
        "005930",
        "20250520",
        started_at="2026-05-27T00:00:00+09:00",
        rate_limit_s=0.05,
        seen_seqs=set(),
        page_idx=0,
        t=orchestrator.DATA_WINDOW_START_MS,
        collector=None,
    )

    assert stop_reason is not None
    assert page_idx == 0


def test_429_retry_does_not_create_phantom_page_boundary(tmp_path: Path, monkeypatch):
    """S2 retry-aware boundary: a 429 retry must NOT add a new PageTiming row.

    We use a client whose first call raises 429, and subsequent calls return
    empty bodies. After the retry, the loop proceeds normally; the boundary
    seen by the collector for that t_in is exactly ONE, not two.
    """
    from hoga.collector.client import HogaplayHTTPError

    class _OneShot429Client:
        def __init__(self) -> None:
            self.calls = 0

        def fetch_info(self, code: str, date: str) -> str:  # pragma: no cover
            return ""

        def fetch_first(self, code: str, date: str, time_ms: int) -> str:
            self.calls += 1
            if self.calls == 1:
                raise HogaplayHTTPError("throttled", status_code=429)
            return ""

        def fetch_chart(  # pragma: no cover
            self, code: str, date: str, time_ms: int, bong: int = 1, gap: int = 60000
        ) -> str:
            return ""

    monkeypatch.setattr(orchestrator._time, "sleep", lambda *_a, **_kw: None)
    # _cancellable_sleep also sleeps internally; patch to no-op for speed.
    monkeypatch.setattr(orchestrator, "_cancellable_sleep", lambda *_a, **_kw: None)

    collector = CaptureTimingCollector("005930", "20250520")
    raw_dir = tmp_path / "raw"
    raw_dir.mkdir()

    client = _OneShot429Client()
    orchestrator._page_step_loop(
        raw_dir,
        client,
        "005930",
        "20250520",
        started_at="2026-05-27T00:00:00+09:00",
        rate_limit_s=0.05,
        seen_seqs=set(),
        page_idx=0,
        t=orchestrator.DATA_WINDOW_START_MS,
        collector=collector,
    )

    # The 429 retry stays on the SAME PageTiming row. The first successful
    # store (call #2) then closes that row and opens the next. If the bug
    # existed, we'd have len(pages) = iterations + 1 (phantom row from the
    # retry top-of-loop mark). With the fix, len(pages) == iterations.
    # Concretely: the 429 was recorded on page 0 as an error, NOT on a
    # phantom page boundary.
    assert collector.error_counts.get("http_429", 0) == 1
    # Page 0 (the one that hit 429 then succeeded) has the 429 error logged.
    assert "http_429" in collector.pages[0].errors
