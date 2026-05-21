"""disk_state.check_disk_state classifies a (code, date) directory into one of four states."""
from __future__ import annotations

import json
from pathlib import Path

from hoga.api.disk_state import DiskState, check_disk_state, has_meaningful_gaps


def test_disk_state_enum_has_four_members() -> None:
    assert set(DiskState) == {
        DiskState.NONE,
        DiskState.CLIENT_INCOMPLETE,
        DiskState.SOURCE_PARTIAL,
        DiskState.COMPLETE,
    }


def test_none_when_no_directory_exists(tmp_path: Path) -> None:
    assert check_disk_state(tmp_path, "005930", "20260520") == DiskState.NONE


def test_client_incomplete_when_only_raw_exists(tmp_path: Path) -> None:
    raw_dir = tmp_path / "raw" / "20260520" / "005930"
    raw_dir.mkdir(parents=True)
    (raw_dir / "first_001.tsv").write_text("dummy\n", encoding="utf-8")
    assert check_disk_state(tmp_path, "005930", "20260520") == DiskState.CLIENT_INCOMPLETE


def test_client_incomplete_only_if_first_pages_exist(tmp_path: Path) -> None:
    """Empty raw dir or one with only info.tsv shouldn't be classified as in-progress."""
    raw_dir = tmp_path / "raw" / "20260520" / "005930"
    raw_dir.mkdir(parents=True)
    (raw_dir / "info.tsv").write_text("info\n", encoding="utf-8")
    # No first_*.tsv files yet — collector died before storing any page.
    assert check_disk_state(tmp_path, "005930", "20260520") == DiskState.NONE


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
    assert check_disk_state(tmp_path, "005930", "20260520") == DiskState.COMPLETE


def test_source_partial_when_meta_says_complete_but_partial(tmp_path: Path) -> None:
    _write_meta(tmp_path, "005930", "20260520", collection_complete=True, is_partial=True)
    assert check_disk_state(tmp_path, "005930", "20260520") == DiskState.SOURCE_PARTIAL


def test_client_incomplete_when_meta_says_not_complete(tmp_path: Path) -> None:
    _write_meta(tmp_path, "005930", "20260520", collection_complete=False, is_partial=True)
    assert check_disk_state(tmp_path, "005930", "20260520") == DiskState.CLIENT_INCOMPLETE


def test_legacy_meta_without_bits_defaults_to_client_incomplete(tmp_path: Path) -> None:
    """Pre-foundation meta.json has no completeness fields. Conservative default:
    treat as client_incomplete so the worker tries to resume and upgrade the meta."""
    _write_meta(tmp_path, "005930", "20260520")  # neither field
    assert check_disk_state(tmp_path, "005930", "20260520") == DiskState.CLIENT_INCOMPLETE


# CHART_FINAL_TIME_MS = 153100000 (15:31:00.000 in HHMMSSmmm)
# Regular session open ≈ 90000000 (09:00:00.000)


def test_no_gaps_when_snapshots_dense() -> None:
    # One snapshot per second from 09:00:00 to 09:00:30 — no gap exceeds 1s.
    ts = [90000000 + i * 1000 for i in range(31)]
    assert has_meaningful_gaps(ts) is False


def test_gap_detected_when_60s_empty() -> None:
    # 09:00:00 then jump to 09:01:30 (90 seconds later) — gap exceeds threshold.
    assert has_meaningful_gaps([90000000, 90130000]) is True


def test_gap_outside_continuous_session_ignored() -> None:
    """A gap that crosses the pre-session/session boundary must not count.
    Three dense in-session events prove there is no gap WITHIN the session;
    the pre-session sample at 08:40 is filtered out before gap analysis."""
    ts = [84000000, 90000000, 90001000, 90002000]
    # in_session = [90000000, 90001000, 90002000] — three points, 1s apart, no 60s gap.
    assert has_meaningful_gaps(ts) is False


def test_empty_list_returns_true() -> None:
    """Empty input → True (conservative: caller can't prove completeness)."""
    assert has_meaningful_gaps([]) is True


def test_single_in_session_event_returns_true() -> None:
    """One in-session datapoint isn't enough to compute gap presence; conservative True."""
    assert has_meaningful_gaps([90000000]) is True
