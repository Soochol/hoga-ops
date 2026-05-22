"""Capture eligibility — a single home for "is this Stock-Date capturable?"

Composes disk_state.check_disk_state with the today_too_early Clock policy.
Replaces the previously-split logic between captures.enqueue_items (Q14 guard)
and captures._run_item (Q15/Q16 disk-state branching).
"""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import pytest

from hoga.api import eligibility
from hoga.api.eligibility import CaptureDecision

KST = dt.timezone(dt.timedelta(hours=9))


def _write_meta(path: Path, *, collection_complete: bool, is_partial: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"collection_complete": collection_complete, "is_partial": is_partial}))


def test_decide_capture_complete_skips_with_already_complete_reason(tmp_path: Path) -> None:
    _write_meta(tmp_path / "parquet" / "20260518" / "005930" / "meta.json",
                collection_complete=True, is_partial=False)
    decision = eligibility.decide_capture(
        data_dir=tmp_path, code="005930", date="20260518", force_retry=False,
    )
    assert decision == CaptureDecision(skip_reason="already_complete", resume=False)


def test_decide_capture_source_partial_skips_when_not_force_retry(tmp_path: Path) -> None:
    _write_meta(tmp_path / "parquet" / "20260518" / "005930" / "meta.json",
                collection_complete=True, is_partial=True)
    decision = eligibility.decide_capture(
        data_dir=tmp_path, code="005930", date="20260518", force_retry=False,
    )
    assert decision == CaptureDecision(skip_reason="source_partial", resume=False)


def test_decide_capture_source_partial_falls_through_when_force_retry(tmp_path: Path) -> None:
    _write_meta(tmp_path / "parquet" / "20260518" / "005930" / "meta.json",
                collection_complete=True, is_partial=True)
    decision = eligibility.decide_capture(
        data_dir=tmp_path, code="005930", date="20260518", force_retry=True,
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


def test_find_ineligible_dates_flags_today_before_18_kst() -> None:
    now = dt.datetime(2026, 5, 22, 17, 59, 0, tzinfo=KST)
    rejected = eligibility.find_ineligible_dates(
        candidate_dates=["20260520", "20260522"], now=now,
    )
    assert rejected == ["20260522"]


def test_find_ineligible_dates_empty_when_no_match() -> None:
    now = dt.datetime(2026, 5, 22, 17, 59, 0, tzinfo=KST)
    rejected = eligibility.find_ineligible_dates(
        candidate_dates=["20260518", "20260519", "20260520"], now=now,
    )
    assert rejected == []


def test_find_ineligible_dates_today_at_18_passes() -> None:
    """18:00 KST is the boundary — at-or-after-18 is admissible."""
    now = dt.datetime(2026, 5, 22, 18, 0, 0, tzinfo=KST)
    rejected = eligibility.find_ineligible_dates(
        candidate_dates=["20260522"], now=now,
    )
    assert rejected == []
