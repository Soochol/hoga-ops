"""disk_state.check_disk_state classifies a (code, date) directory into one of four states."""
from __future__ import annotations

import json
from pathlib import Path

from hoga.api.disk_state import (
    DiskState,
    check_disk_state,
    classify_from_meta,
    has_meaningful_gaps,
)
from hoga.api.timeenc import HogaMs


def test_disk_state_enum_has_five_members() -> None:
    assert set(DiskState) == {
        DiskState.NONE,
        DiskState.CLIENT_INCOMPLETE,
        DiskState.SOURCE_PARTIAL,
        DiskState.INVALID,
        DiskState.COMPLETE,
    }


def test_none_when_no_directory_exists(tmp_path: Path) -> None:
    assert check_disk_state(tmp_path, "005930", "20260520").state == DiskState.NONE


def test_client_incomplete_when_only_raw_exists(tmp_path: Path) -> None:
    raw_dir = tmp_path / "raw" / "20260520" / "005930"
    raw_dir.mkdir(parents=True)
    (raw_dir / "first_001.tsv").write_text("dummy\n", encoding="utf-8")
    assert check_disk_state(tmp_path, "005930", "20260520").state == DiskState.CLIENT_INCOMPLETE


def test_client_incomplete_only_if_first_pages_exist(tmp_path: Path) -> None:
    """Empty raw dir or one with only info.tsv shouldn't be classified as in-progress."""
    raw_dir = tmp_path / "raw" / "20260520" / "005930"
    raw_dir.mkdir(parents=True)
    (raw_dir / "info.tsv").write_text("info\n", encoding="utf-8")
    # No first_*.tsv files yet — collector died before storing any page.
    assert check_disk_state(tmp_path, "005930", "20260520").state == DiskState.NONE


def _write_meta(tmp_path: Path, code: str, date: str, **fields: object) -> None:
    parquet_dir = tmp_path / "parquet" / date / code
    parquet_dir.mkdir(parents=True)
    (parquet_dir / "meta.json").write_text(
        json.dumps({
            "code": code,
            "name": "삼성전자",
            "regular_session_open_ms": 90000000,
            "regular_session_close_ms": 153000000,
            "prev_close": 50000,
            "upper_limit": 65000,
            "lower_limit": 35000,
            "today_open": 50500,
            "today_high": 51000,
            "today_low": 50000,
            "today_close": 50800,
            "pages_collected": 47,
            **fields,
        }, ensure_ascii=False),
        encoding="utf-8",
    )


def test_complete_when_meta_says_complete_and_not_partial(tmp_path: Path) -> None:
    _write_meta(tmp_path, "005930", "20260520", collection_complete=True, is_partial=False)
    assert check_disk_state(tmp_path, "005930", "20260520").state == DiskState.COMPLETE


def test_source_partial_when_meta_says_complete_but_partial(tmp_path: Path) -> None:
    _write_meta(tmp_path, "005930", "20260520", collection_complete=True, is_partial=True)
    assert check_disk_state(tmp_path, "005930", "20260520").state == DiskState.SOURCE_PARTIAL


def test_client_incomplete_when_meta_says_not_complete(tmp_path: Path) -> None:
    _write_meta(tmp_path, "005930", "20260520", collection_complete=False, is_partial=True)
    assert check_disk_state(tmp_path, "005930", "20260520").state == DiskState.CLIENT_INCOMPLETE


def test_legacy_meta_without_bits_defaults_to_client_incomplete(tmp_path: Path) -> None:
    """Pre-foundation meta.json has no completeness fields. Conservative default:
    treat as client_incomplete so the worker tries to resume and upgrade the meta."""
    _write_meta(tmp_path, "005930", "20260520")  # neither field
    assert check_disk_state(tmp_path, "005930", "20260520").state == DiskState.CLIENT_INCOMPLETE


def test_classify_from_meta_complete() -> None:
    meta = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_000_000,
        "collection_complete": True,
        "is_partial": False,
    }
    assert classify_from_meta(meta).state == DiskState.COMPLETE


def test_classify_from_meta_source_partial() -> None:
    meta = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_000_000,
        "collection_complete": True,
        "is_partial": True,
    }
    assert classify_from_meta(meta).state == DiskState.SOURCE_PARTIAL


def test_classify_from_meta_client_incomplete_when_not_complete() -> None:
    # If collection didn't finish, the value of is_partial is irrelevant —
    # CLIENT_INCOMPLETE wins. This is the "normalize ambiguity" guarantee
    # callers rely on.
    assert classify_from_meta(
        {"collection_complete": False, "is_partial": False},
    ).state == DiskState.CLIENT_INCOMPLETE
    assert classify_from_meta(
        {"collection_complete": False, "is_partial": True},
    ).state == DiskState.CLIENT_INCOMPLETE


def test_classify_from_meta_legacy_empty_dict() -> None:
    """Pre-foundation meta with neither field → CLIENT_INCOMPLETE (conservative)."""
    assert classify_from_meta({}).state == DiskState.CLIENT_INCOMPLETE


def test_malformed_meta_json_returns_client_incomplete(tmp_path: Path) -> None:
    """Truncated / corrupt meta.json must not crash callers — conservative fallback."""
    parquet_dir = tmp_path / "parquet" / "20260520" / "005930"
    parquet_dir.mkdir(parents=True)
    (parquet_dir / "meta.json").write_text("{not valid json", encoding="utf-8")
    assert check_disk_state(tmp_path, "005930", "20260520").state == DiskState.CLIENT_INCOMPLETE


# HogaMs is HHMMSSmmm packed-decimal (non-linear — see timeenc.py:54).
# Regular session open = 90000000 (09:00:00.000), close = 153000000 (15:30:00.000).
# Closing Auction Window spans the last 10 minutes (15:20–15:30 on a regular day).
_REGULAR_CLOSE = HogaMs(153000000)


def test_no_gaps_when_snapshots_dense() -> None:
    # One snapshot per second from 09:00:00 to 09:00:30 — no gap exceeds 1s.
    ts = [HogaMs(90000000 + i * 1000) for i in range(31)]
    assert has_meaningful_gaps(ts, session_close_ms=_REGULAR_CLOSE) is False


def test_gap_detected_when_60s_empty() -> None:
    # 09:00:00 then jump to 09:01:30 (90 seconds later) — gap exceeds threshold.
    assert has_meaningful_gaps(
        [HogaMs(90000000), HogaMs(90130000)], session_close_ms=_REGULAR_CLOSE,
    ) is True


def test_gap_outside_continuous_session_ignored() -> None:
    """A gap that crosses the pre-session/session boundary must not count.
    Three dense in-session events prove there is no gap WITHIN the session;
    the pre-session sample at 08:40 is filtered out before gap analysis."""
    ts = [HogaMs(84000000), HogaMs(90000000), HogaMs(90001000), HogaMs(90002000)]
    # in_session = [90000000, 90001000, 90002000] — three points, 1s apart, no 60s gap.
    assert has_meaningful_gaps(ts, session_close_ms=_REGULAR_CLOSE) is False


def test_empty_list_returns_true() -> None:
    """Empty input → True (conservative: caller can't prove completeness)."""
    assert has_meaningful_gaps([], session_close_ms=_REGULAR_CLOSE) is True


def test_single_in_session_event_returns_true() -> None:
    """One in-session datapoint isn't enough to compute gap presence; conservative True."""
    assert has_meaningful_gaps([HogaMs(90000000)], session_close_ms=_REGULAR_CLOSE) is True


def test_gap_across_minute_boundary_is_real_duration() -> None:
    """Regression: HHMMSSmmm is non-linear (timeenc.py:54). A real 30-second
    pause spanning 09:00:45 → 09:01:15 must NOT be flagged. Raw HogaMs
    subtraction gives 70,000 (looks like 70 sec) but real elapsed is 30 sec."""
    ts = [HogaMs(90045000), HogaMs(90115000)]
    assert has_meaningful_gaps(ts, session_close_ms=_REGULAR_CLOSE) is False


def test_gap_across_hour_boundary_is_real_duration() -> None:
    """Hour boundary is the worst encoding-bug case: 09:59:45 → 10:00:15 is
    30 sec real, but raw subtraction gives 4,000,030 ms — would falsely flag
    every multi-hour stream as partial. This is the dominant prod false-positive."""
    ts = [HogaMs(95945000), HogaMs(100015000)]
    assert has_meaningful_gaps(ts, session_close_ms=_REGULAR_CLOSE) is False


def test_real_gap_above_threshold_still_detected() -> None:
    """Sanity: real 90-second pause within the hour is still True after the fix."""
    ts = [HogaMs(100000000), HogaMs(100130000)]  # 10:00:00 → 10:01:30
    assert has_meaningful_gaps(ts, session_close_ms=_REGULAR_CLOSE) is True


def test_auction_window_snapshots_excluded_from_gap_analysis() -> None:
    """Snapshots inside the closing Auction Window (last 10 min of Regular
    Session) are excluded: no continuous matching happens there, so absence
    of churn is normal market behavior, not a data gap. With ONLY Auction-
    Window snapshots → empty in-session set → conservative True."""
    # 10 dense snapshots at 15:25:00..15:25:09 (inside the 15:20–15:30 window).
    ts = [HogaMs(152500000 + i * 1000) for i in range(10)]
    assert has_meaningful_gaps(ts, session_close_ms=_REGULAR_CLOSE) is True


# --- ADR-0020 / Invariants ---

def test_disk_state_enum_includes_invalid() -> None:
    """INVALID is the fifth member, added by ADR-0020."""
    assert DiskState.INVALID in set(DiskState)
    assert len(set(DiskState)) == 5


def test_classification_carries_violations_so_callers_avoid_redoing_work() -> None:
    """Deepening regression: classify_from_meta must return both the state
    and the violations that drove it, so downstream surfacing callers
    (build_range_bundle) don't re-run hoga.api.invariants.check() to recover
    them. The .errors / .warnings property helpers must partition by severity."""
    from hoga.api.disk_state import Classification
    from hoga.api.invariants import Severity

    # Healthy bounds, complete, but low unique-event ratio → warn only.
    c = classify_from_meta({
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_000_000,
        "collection_complete": True,
        "is_partial": False,
        "pages_collected": 4132,
        "total_unique_events": 1553,
    })
    assert isinstance(c, Classification)
    assert c.state == DiskState.COMPLETE
    assert c.errors == []                                              # no error
    assert {v.invariant_id for v in c.warnings} == {                   # warn surfaced
        "collection.unique_events_ratio",
    }

    # Broken bounds → INVALID + the error violation carried through.
    c2 = classify_from_meta({
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 0,
        "collection_complete": True,
        "is_partial": False,
    })
    assert c2.state == DiskState.INVALID
    error_ids = {v.invariant_id for v in c2.errors}
    assert "meta.close_after_open" in error_ids
    assert all(v.severity == Severity.error for v in c2.errors)


def test_check_disk_state_empty_path_returns_no_violations() -> None:
    """Classification.violations is empty for NONE / raw-only CLIENT_INCOMPLETE
    paths — those branches don't have a meta dict to evaluate."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        c = check_disk_state(Path(td), "005930", "20260520")
    assert c.state == DiskState.NONE
    assert c.violations == []


def test_classify_returns_invalid_when_meta_has_error_violation() -> None:
    """A complete, non-partial capture that fails an error invariant → INVALID."""
    meta = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 0,    # error: close_after_open
        "collection_complete": True,       # gets past CLIENT_INCOMPLETE branch
        "is_partial": False,
    }
    assert classify_from_meta(meta).state == DiskState.INVALID


def test_classify_prefers_invalid_over_client_incomplete() -> None:
    """If both apply, INVALID wins — broken data shape is more serious than
    mere incompleteness. The real 5/18/003490 case (collection_complete=False
    AND close_ms=0) must classify INVALID, not CLIENT_INCOMPLETE — otherwise
    build_range_bundle's INVALID filter misses it and the chart still crashes.
    Eligibility also routes INVALID to fresh-capture (resume=False), which is
    the correct recovery for upstream-corrupted artifacts."""
    meta = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 0,    # error: close_after_open + close_in_kst_range
        "collection_complete": False,      # would be CLIENT_INCOMPLETE under old priority
        "is_partial": True,
    }
    assert classify_from_meta(meta).state == DiskState.INVALID


def test_classify_client_incomplete_when_only_completeness_bit_false() -> None:
    """Healthy bounds but capture aborted early → CLIENT_INCOMPLETE (resume
    path). This is the case the original priority was protecting."""
    meta = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_000_000,
        "collection_complete": False,
        "is_partial": True,
    }
    assert classify_from_meta(meta).state == DiskState.CLIENT_INCOMPLETE


def test_classify_warn_only_does_not_promote_to_invalid() -> None:
    """warn-severity violations don't change DiskState (surfaced separately)."""
    meta = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_000_000,
        "collection_complete": True,
        "is_partial": False,
        "pages_collected": 100,
        "total_unique_events": 30,         # warn: unique_events_ratio
    }
    # warn-only → still COMPLETE
    assert classify_from_meta(meta).state == DiskState.COMPLETE
