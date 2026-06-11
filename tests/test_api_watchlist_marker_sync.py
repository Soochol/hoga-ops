"""Watchlist marker ↔ disk truth synchronization.

Regression test for the /watchlist vs /capture mismatch where finalize
treated phase="done" as proof of COMPLETE, advancing last_success_date
past the actual latest COMPLETE on disk when capture aborted mid-stream
(stagnation_abort, lenient-fallback INVALID, etc.).

The contract under test:
  - captures._finalize_item bumps the marker ONLY when the on-disk
    DiskState classification is COMPLETE.
  - scheduler.catchup_one_entry reconciles the marker to disk truth
    bidirectionally (advance OR regress).
"""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch
from zoneinfo import ZoneInfo

import pytest

KST = ZoneInfo("Asia/Seoul")


def _write_meta(path: Path, *, collection_complete: bool, is_partial: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "collection_complete": collection_complete,
        "is_partial": is_partial,
        "regular_session_open_ms": 90_000_000,    # 09:00 HHMMSSmmm
        "regular_session_close_ms": 153_100_000,  # 15:31 HHMMSSmmm
    }))


def _make_state(code: str, date: str):
    """Build a minimal QueueItemState-like object for _finalize_item."""
    from hoga.api.captures import QueueItemState
    from hoga.api.models import CaptureResult
    state = QueueItemState(
        item_id="test-item",
        code=code,
        date=date,
        force_retry=False,
        enqueued_at_ms=0,
    )
    state.phase = "done"
    state.estimate_pct = 100
    state.result = CaptureResult(
        pages_written=10,
        unique_events=100,
        raw_dir="/tmp/raw",
        parsed=True,
        abort_reason="stagnation_abort",
    )
    return state


@pytest.mark.asyncio
async def test_finalize_does_not_bump_marker_on_client_incomplete(tmp_path: Path):
    """phase='done' with on-disk collection_complete=False must NOT advance
    the marker. This is the exact production scenario: stagnation_abort
    leaves meta.json with collection_complete=False, but state.phase='done'
    because the worker returned cleanly with an abort_reason set."""
    from hoga.api import captures, watchlist

    _fid = (await watchlist.create_folder(tmp_path, name="기본")).id
    await watchlist.add_member(tmp_path, code="098460", name="고영",
                               today_kst_date="20260520", folder_id=_fid)
    await watchlist.bump_last_success(tmp_path, code="098460", date="20260522")

    # 5/26 capture aborted mid-stream → meta.json reflects partial state.
    _write_meta(tmp_path / "parquet" / "20260526" / "098460" / "meta.json",
                collection_complete=False, is_partial=True)

    with patch.object(captures, "_require_data_dir", return_value=tmp_path), \
         patch.object(captures, "_publish_event"), \
         patch.object(captures, "_persist_queue_locked"):
        state = _make_state("098460", "20260526")
        await captures._finalize_item(state)

    [entry] = watchlist.load_watchlist(tmp_path)
    assert entry.last_success_date == "20260522", (
        "Marker advanced past actual latest COMPLETE on disk — "
        "/watchlist will lie to the user while /capture shows ✕."
    )


@pytest.mark.asyncio
async def test_finalize_bumps_marker_on_complete(tmp_path: Path):
    """Control: when meta.json reflects a COMPLETE Stock-Date, the marker
    MUST advance. This guards the fix from being too restrictive."""
    from hoga.api import captures, watchlist

    _fid = (await watchlist.create_folder(tmp_path, name="기본")).id
    await watchlist.add_member(tmp_path, code="098460", name="고영",
                               today_kst_date="20260520", folder_id=_fid)
    await watchlist.bump_last_success(tmp_path, code="098460", date="20260522")

    # Normal finalize: full collection, not partial.
    _write_meta(tmp_path / "parquet" / "20260526" / "098460" / "meta.json",
                collection_complete=True, is_partial=False)

    with patch.object(captures, "_require_data_dir", return_value=tmp_path), \
         patch.object(captures, "_publish_event"), \
         patch.object(captures, "_persist_queue_locked"):
        state = _make_state("098460", "20260526")
        state.result.abort_reason = None  # type: ignore[union-attr]
        await captures._finalize_item(state)

    [entry] = watchlist.load_watchlist(tmp_path)
    assert entry.last_success_date == "20260526"


@pytest.mark.asyncio
async def test_catchup_regresses_stale_marker_to_disk_truth(tmp_path: Path):
    """End-to-end repair: existing users whose markers were bumped past
    actual COMPLETE (before the finalize gate landed) get fixed on the
    next catchup. Disk has 20260522 as latest COMPLETE; the marker says
    20260526 (stale). After catchup_one_entry the marker == 20260522."""
    from hoga.api import scheduler, watchlist
    from hoga.api.models import EnqueueResponse, WatchlistEntry

    # Stage: stale marker (e.g. left over from pre-fix stagnation_abort
    # finalizes that incorrectly bumped to 5/26).
    stale = [WatchlistEntry(
        code="098460", name="고영",
        registered_at_kst_date="20260520",
        last_success_date="20260526",
    )]
    watchlist.save_document(tmp_path, watchlist.WatchlistDocument(entries=stale))

    fake_now = dt.datetime(2026, 5, 27, 11, 0, 0, tzinfo=KST)
    with patch("hoga.api.scheduler.latest_complete_date",
               return_value="20260522"), \
         patch("hoga.api.scheduler.now_kst", return_value=fake_now), \
         patch("hoga.api.scheduler.trading_days_in_range", return_value=[]), \
         patch("hoga.api.scheduler.find_ineligible_dates", return_value=[]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock,
               return_value=EnqueueResponse(enqueued=[], deduped=[])):
        await scheduler.catchup_one_entry(
            stale[0], data_dir=tmp_path, now=fake_now,
        )

    [entry] = watchlist.load_watchlist(tmp_path)
    assert entry.last_success_date == "20260522", (
        "Catchup did not repair the stale marker to disk truth."
    )
