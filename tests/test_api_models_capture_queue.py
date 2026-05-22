"""Wire shape tests for Plan B model additions. Pure pydantic round-trip
checks — no business logic. Catches accidental field renames at the boundary."""
from __future__ import annotations

import json

from hoga.api.models import (
    CalendarCell,
    CalendarResponse,
    CaptureFinishedEvent,
    CaptureProgressEvent,
    CaptureQueueDrainedEvent,
    CaptureQueuedEvent,
    CaptureQueuePausedEvent,
    CaptureQueueResumedEvent,
    QueueItem,
    SymbolHit,
    SymbolsAllResponse,
)


def test_queue_item_roundtrip():
    item = QueueItem(
        item_id="20260522T103000-005930-20260520",
        code="005930",
        date="20260520",
        phase="queued",
        force_retry=False,
        pause_origin=False,
        enqueued_at_ms=1_700_000_000_000,
    )
    payload = json.loads(item.model_dump_json())
    assert payload["item_id"].endswith("-20260520")
    assert payload["phase"] == "queued"
    assert payload["force_retry"] is False
    assert payload["pause_origin"] is False


def test_symbol_hit_includes_complete_count_and_breakdown():
    hit = SymbolHit(
        code="005930",
        name="삼성전자",
        market="KOSPI",
        captured_count=14,
        captured_breakdown={"complete": 14, "source_partial": 3, "client_incomplete": 2},
    )
    payload = json.loads(hit.model_dump_json())
    assert payload["captured_count"] == 14  # complete only, the headline
    assert payload["captured_breakdown"]["source_partial"] == 3
    assert payload["captured_breakdown"]["client_incomplete"] == 2


def test_symbols_all_response_envelope():
    resp = SymbolsAllResponse(symbols=[], status="loading", fetched_at_ms=None)
    payload = json.loads(resp.model_dump_json())
    assert payload["status"] == "loading"
    assert payload["fetched_at_ms"] is None


def test_calendar_cell_shape():
    cell = CalendarCell(date="20260520", status="complete", captured_at_ms=1_700_000_000_000)
    payload = json.loads(cell.model_dump_json())
    assert payload["status"] == "complete"
    assert payload["captured_at_ms"] == 1_700_000_000_000


def test_calendar_response_carries_as_of_ms():
    resp = CalendarResponse(cells=[], as_of_ms=1_700_000_000_500)
    payload = json.loads(resp.model_dump_json())
    assert payload["as_of_ms"] == 1_700_000_000_500


def test_progress_event_uses_item_id_not_job_id():
    """spec §3.4: all payloads carry item_id (renamed from job_id)."""
    from hoga.api.models import CaptureProgress
    evt = CaptureProgressEvent(
        item_id="x",
        code="005930",
        date="20260520",
        phase="capturing",
        progress=CaptureProgress(pages_done=1, events_seen=10, frontier_ms=0, estimate_pct=5, elapsed_ms=100),
    )
    payload = json.loads(evt.model_dump_json())
    assert "item_id" in payload and "job_id" not in payload
    assert payload["type"] == "capture_progress"


def test_finished_event_carries_skip_reason():
    evt = CaptureFinishedEvent(
        item_id="x", code="005930", date="20260520", phase="skipped",
        skip_reason="already_complete",
    )
    payload = json.loads(evt.model_dump_json())
    assert payload["skip_reason"] == "already_complete"


def test_queued_event_carries_items_array():
    items = [QueueItem(
        item_id=f"x-{i}", code="005930", date=f"2026052{i}", phase="queued",
        force_retry=False, pause_origin=False, enqueued_at_ms=0,
    ) for i in range(3)]
    evt = CaptureQueuedEvent(items=items)
    payload = json.loads(evt.model_dump_json())
    assert payload["type"] == "capture_queued"
    assert len(payload["items"]) == 3


def test_queue_paused_resumed_drained_event_types():
    paused = CaptureQueuePausedEvent(reason="cookie_expired", message="cookie expired")
    resumed = CaptureQueueResumedEvent()
    drained = CaptureQueueDrainedEvent(total_done=5, total_failed=1, total_cancelled=2, total_skipped=3)
    assert json.loads(paused.model_dump_json())["type"] == "capture_queue_paused"
    assert json.loads(resumed.model_dump_json())["type"] == "capture_queue_resumed"
    assert json.loads(drained.model_dump_json())["type"] == "capture_queue_drained"
    assert json.loads(drained.model_dump_json())["total_done"] == 5
