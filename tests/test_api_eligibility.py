"""Capture eligibility — a single home for "is this Stock-Date capturable?"

Composes disk_state.check_disk_state with the today_too_early Clock policy.
Replaces the previously-split logic between captures.enqueue_items (Q14 guard)
and captures._run_item (Q15/Q16 disk-state branching).
"""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

from hoga.api import eligibility
from hoga.api.eligibility import CaptureDecision

KST = dt.timezone(dt.timedelta(hours=9))


def _write_meta(path: Path, *, collection_complete: bool, is_partial: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "collection_complete": collection_complete,
        "is_partial": is_partial,
        "regular_session_open_ms": 90_000_000,     # 09:00 HHMMSSmmm
        "regular_session_close_ms": 153_100_000,   # 15:31 HHMMSSmmm
    }))


def test_decide_capture_complete_skips_with_already_complete_reason(tmp_path: Path) -> None:
    _write_meta(tmp_path / "parquet" / "20260518" / "005930" / "meta.json",
                collection_complete=True, is_partial=False)
    decision = eligibility.decide_capture(
        data_dir=tmp_path, code="005930", date="20260518", force_retry=False,
    )
    assert decision == CaptureDecision(skip_reason="already_complete", resume=False)


def test_decide_capture_complete_skips_even_with_force_retry_per_adr_0035(tmp_path: Path) -> None:
    """ADR-0035 relaxes the enqueue dedupe to let done+force_retry through.
    decide_capture must remain the last gate against accidental overwrite of
    a COMPLETE Stock-Date — without this gate, the relaxed enqueue branch
    would destroy good data.
    """
    _write_meta(tmp_path / "parquet" / "20260518" / "005930" / "meta.json",
                collection_complete=True, is_partial=False)
    decision = eligibility.decide_capture(
        data_dir=tmp_path, code="005930", date="20260518", force_retry=True,
    )
    assert decision == CaptureDecision(skip_reason="already_complete", resume=False)


def test_decide_capture_source_partial_retries_without_force_concept(tmp_path: Path) -> None:
    _write_meta(tmp_path / "parquet" / "20260518" / "005930" / "meta.json",
                collection_complete=True, is_partial=True)
    decision = eligibility.decide_capture(
        data_dir=tmp_path, code="005930", date="20260518", force_retry=False,
    )
    assert decision == CaptureDecision(skip_reason=None, resume=False)


def test_decide_capture_client_incomplete_resumes(tmp_path: Path) -> None:
    # Raw pages present but no meta — disk_state returns CLIENT_INCOMPLETE.
    raw = tmp_path / "raw" / "20260518" / "005930"
    raw.mkdir(parents=True)
    (raw / "first_0001.tsv").write_text("")
    decision = eligibility.decide_capture(
        data_dir=tmp_path, code="005930", date="20260518", force_retry=False,
    )
    assert decision == CaptureDecision(skip_reason=None, resume=True)


def test_decide_capture_none_fresh(tmp_path: Path) -> None:
    decision = eligibility.decide_capture(
        data_dir=tmp_path, code="005930", date="20260518", force_retry=False,
    )
    assert decision == CaptureDecision(skip_reason=None, resume=False)


def test_find_ineligible_dates_flags_today_before_17_kst() -> None:
    now = dt.datetime(2026, 5, 22, 16, 59, 0, tzinfo=KST)
    rejected = eligibility.find_ineligible_dates(
        candidate_dates=["20260520", "20260522"], now=now,
    )
    assert rejected == ["20260522"]


def test_find_ineligible_dates_empty_when_no_match() -> None:
    now = dt.datetime(2026, 5, 22, 16, 59, 0, tzinfo=KST)
    rejected = eligibility.find_ineligible_dates(
        candidate_dates=["20260518", "20260519", "20260520"], now=now,
    )
    assert rejected == []


def test_find_ineligible_dates_today_at_17_passes() -> None:
    """17:00 KST is the boundary — at-or-after-17 is admissible."""
    now = dt.datetime(2026, 5, 22, 17, 0, 0, tzinfo=KST)
    rejected = eligibility.find_ineligible_dates(
        candidate_dates=["20260522"], now=now,
    )
    assert rejected == []


def test_decide_capture_invalid_proceeds_as_fresh(tmp_path: Path) -> None:
    """INVALID disk state → fresh capture (no resume from corrupt artifacts)."""
    from hoga.api.disk_state import DiskState
    from hoga.api.eligibility import decide_capture

    # Build a meta.json that classify_from_meta will rate as INVALID:
    # collection_complete=True so it passes the CLIENT_INCOMPLETE gate,
    # but close_ms=0 trips meta.close_after_open (error).
    pq_dir = tmp_path / "parquet" / "20260518" / "003490"
    pq_dir.mkdir(parents=True)
    meta = {
        "regular_session_open_ms": 90_000_000,    # 09:00 HHMMSSmmm
        "regular_session_close_ms": 0,            # invariant breach
        "collection_complete": True,
        "is_partial": False,
    }
    (pq_dir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")

    decision = decide_capture(data_dir=tmp_path, code="003490", date="20260518", force_retry=False)

    # Sanity: precondition holds (classify is INVALID)
    from hoga.api.disk_state import check_disk_state
    assert check_disk_state(tmp_path, "003490", "20260518").state == DiskState.INVALID

    # Proceeds (no skip), resume=False (fresh capture, don't trust corrupt artifacts)
    assert decision.skip_reason is None
    assert decision.resume is False


def test_decide_capture_no_upstream_data_retries_without_force_concept(tmp_path: Path) -> None:
    """A sentinel-only directory should be retried on the next user request.

    The old force_retry distinction is gone: the sentinel is just the previous
    outcome marker, not a permanent skip gate.
    """
    from hoga.api.eligibility import decide_capture

    raw_dir = tmp_path / "raw" / "20260319" / "003490"
    raw_dir.mkdir(parents=True)
    sentinel = raw_dir / ".no_upstream_data"
    sentinel.touch()

    decision = decide_capture(
        data_dir=tmp_path, code="003490", date="20260319", force_retry=False
    )
    assert decision.skip_reason is None
    assert decision.resume is False
    assert not sentinel.exists()


def test_decide_capture_no_sentinel_no_change_in_existing_paths(tmp_path: Path) -> None:
    """A fresh (NONE) Stock-Date is unaffected by the new branches."""
    from hoga.api.eligibility import decide_capture

    decision = decide_capture(
        data_dir=tmp_path, code="003490", date="20260319", force_retry=False
    )
    assert decision.skip_reason is None
    assert decision.resume is False


def test_skip_reason_wire_type_includes_no_upstream_data() -> None:
    """models.py SkipReason and eligibility.py SkipReason must agree on the
    full value set — the worker writes the eligibility value into
    state.skip_reason which pydantic then serialises through the models.py
    Literal. Set equality catches the full class of divergence (e.g., a
    future PR adds a value to one module but forgets the other), which a
    presence check would silently miss."""
    from hoga.api import eligibility as elig_module
    from hoga.api import models as models_module
    from typing import get_args
    assert set(get_args(elig_module.SkipReason)) == set(get_args(models_module.SkipReason))
    assert "no_upstream_data" in get_args(elig_module.SkipReason)
