"""Integration: enqueue -> worker -> orchestrator -> timing JSON + SSE event.

End-to-end coverage for the timing instrumentation (plan §14):
- Enqueue an item, spin up the worker pool, drive it via the in-memory
  FakeHogaplayClient to termination, then verify that
  (a) `<data_dir>/timing/<date>/<code>.json` is written, and
  (b) exactly one `CaptureTimingEvent` was published.
- With `HOGA_CAPTURE_TIMING=0`, neither artifact appears.

The fake client + module-attribute DI seam (`captures._data_dir`,
`captures._client_factory`) is the same pattern used by
`test_api_captures_queue.py` (see `_run_capture_inner` in
hoga/api/captures.py:577 — `_require_client_factory()()` calls into the
patched factory).
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from hoga.api import captures
from hoga.api.captures_fake import FakeHogaplayClient
from hoga.api.models import CaptureTimingEvent, EnqueueRequest


@pytest.fixture(autouse=True)
def _reset():
    """Per-test reset of captures module singletons (matches the pattern in
    test_api_captures_queue.py)."""
    captures.reset_state_for_tests()
    yield
    captures.reset_state_for_tests()


@pytest.fixture(autouse=True)
def _skip_production_rate_limit(monkeypatch):
    """`_run_capture_inner` checks HOGA_ENABLE_TEST_ENDPOINTS=1 to zero out the
    300ms-per-page rate-limit sleep (captures.py:594). Without this the
    FakeHogaplayClient's 5-page loop would burn 1.5s of real time per test."""
    monkeypatch.setenv("HOGA_ENABLE_TEST_ENDPOINTS", "1")


@pytest.fixture
def captured_events(monkeypatch):
    """Capture every `_publish_event` call from captures.py.

    The production path serializes via `model_dump` and hops to the event
    loop via `call_soon_threadsafe` — both irrelevant to this test, which
    cares only about WHICH typed events fired. Patching at the module
    boundary captures the typed objects directly.
    """
    events: list[Any] = []

    def _capture(event):
        events.append(event)

    monkeypatch.setattr(captures, "_publish_event", _capture)
    return events


@pytest.fixture
def fake_client(monkeypatch, tmp_path):
    """Wire the captures module to the in-memory fake client + a per-test
    data_dir. `_data_dir` and `_client_factory` are the documented DI seams
    (see captures.py:220-224)."""
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setattr(captures, "_client_factory", FakeHogaplayClient)
    return FakeHogaplayClient


async def _enqueue_and_drain(tmp_path: Path, code: str, date: str) -> None:
    """Helper: enqueue one item, run the worker pool to drain, stop workers."""
    req = EnqueueRequest(code=code, dates=[date], force_retry=False)
    resp = await captures.enqueue_items_core(
        req, data_dir=tmp_path, now=captures._now_kst(),
    )
    assert len(resp.enqueued) == 1, "expected exactly one item enqueued"

    workers = captures.start_workers(n=1)
    try:
        await asyncio.wait_for(captures.wait_drained(), timeout=10.0)
    finally:
        await captures.stop_workers(workers)


@pytest.mark.asyncio
async def test_capture_timing_json_and_sse_emitted(
    tmp_path: Path, captured_events, fake_client, monkeypatch,
):
    """Default-ON (HOGA_CAPTURE_TIMING unset): one timing JSON + one
    CaptureTimingEvent SSE per capture."""
    monkeypatch.delenv("HOGA_CAPTURE_TIMING", raising=False)

    code, date = "005930", "20260520"
    await _enqueue_and_drain(tmp_path, code, date)

    # JSON written by the finally block (collector.to_report + write_timing_report).
    json_path = tmp_path / "timing" / date / f"{code}.json"
    assert json_path.exists(), f"timing JSON missing at {json_path}"

    data = json.loads(json_path.read_text())
    summary = data["summary"]

    # Structural sanity — not exact ms values (clock-dependent).
    assert summary["code"] == code
    assert summary["date"] == date
    assert summary["page_count"] >= 1
    assert summary["total_ms"] > 0
    # Phases sum cannot exceed total wall time (modulo float noise).
    assert sum(summary["phase_totals_ms"].values()) <= summary["total_ms"] + 1.0
    # Percentages + unaccounted normalize to ~100 (within rounding). Wall-clock
    # time outside any `phase(...)` wrap shows up as unaccounted_ms, so the
    # phase percentages alone can be well below 100 — only the SUM is the
    # invariant. See test_summary_phase_percentages_sum_to_100 for the
    # phase-only case (no unaccounted gap).
    total_ms = summary["total_ms"]
    unaccounted_pct = (summary["unaccounted_ms"] / total_ms) * 100.0 if total_ms > 0 else 0.0
    assert abs(sum(summary["phase_percentages"].values()) + unaccounted_pct - 100.0) < 0.5

    # SSE event published exactly once.
    timing_events = [e for e in captured_events if isinstance(e, CaptureTimingEvent)]
    assert len(timing_events) == 1, (
        f"expected 1 CaptureTimingEvent, got {len(timing_events)}"
    )
    assert timing_events[0].id == f"{code}:{date}"


@pytest.mark.asyncio
async def test_capture_timing_disabled_skips_emit(
    tmp_path: Path, captured_events, fake_client, monkeypatch,
):
    """HOGA_CAPTURE_TIMING=0 -> no JSON file, no CaptureTimingEvent SSE.

    The disable path lives in `_run_item`: it constructs `collector = None`,
    so the finally block's `if collector is not None` branch is skipped
    entirely. Other SSE events (phase, progress, finished) still fire."""
    monkeypatch.setenv("HOGA_CAPTURE_TIMING", "0")

    code, date = "005930", "20260520"
    await _enqueue_and_drain(tmp_path, code, date)

    # No timing directory should ever appear.
    assert not (tmp_path / "timing").exists(), (
        "timing directory was created despite HOGA_CAPTURE_TIMING=0"
    )

    timing_events = [e for e in captured_events if isinstance(e, CaptureTimingEvent)]
    assert timing_events == [], (
        f"expected 0 CaptureTimingEvent with timing disabled, got {len(timing_events)}"
    )
