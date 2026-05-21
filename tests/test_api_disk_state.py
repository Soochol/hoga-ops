"""disk_state.check_disk_state classifies a (code, date) directory into one of four states."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from hoga.api.disk_state import DiskState, check_disk_state


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
