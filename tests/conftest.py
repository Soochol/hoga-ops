from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture
def tmp_data_dir(tmp_path: Path) -> Path:
    """A fresh per-test data directory."""
    d = tmp_path / "data"
    d.mkdir()
    return d
