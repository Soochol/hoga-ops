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
