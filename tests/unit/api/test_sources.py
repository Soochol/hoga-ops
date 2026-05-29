"""Tests for resolve_source — promoted from bundle._resolve_source (ADR-0044
boundary, source_pref thread-through to spot endpoints)."""
from __future__ import annotations

from pathlib import Path
from typing import get_args
from unittest.mock import MagicMock

import pytest

from hoga.api.sources import SourceName, resolve_source


def _make_engine(tmp_path: Path) -> MagicMock:
    engine = MagicMock()
    engine.data_dir = tmp_path
    return engine


def _seed_source(tmp_path: Path, date: str, code: str, source: str) -> None:
    sd = tmp_path / "parquet" / date / code / source
    sd.mkdir(parents=True)
    (sd / "meta.json").write_text("{}")


def test_prefers_kis_live_when_both_exist(tmp_path: Path) -> None:
    _seed_source(tmp_path, "20260528", "005930", "hogaplay")
    _seed_source(tmp_path, "20260528", "005930", "kis_live")
    engine = _make_engine(tmp_path)
    assert resolve_source(engine, "20260528", "005930", "kis_live") == "kis_live"


def test_falls_back_to_other_source_when_pref_missing(tmp_path: Path) -> None:
    _seed_source(tmp_path, "20260528", "005930", "hogaplay")
    engine = _make_engine(tmp_path)
    assert resolve_source(engine, "20260528", "005930", "kis_live") == "hogaplay"


def test_returns_pref_when_no_source_exists(tmp_path: Path) -> None:
    engine = _make_engine(tmp_path)
    # Caller-side StockDateNotFound will surface naturally — resolve_source
    # itself does not raise, mirroring the legacy _resolve_source contract.
    assert resolve_source(engine, "20260528", "005930", "kis_live") == "kis_live"


def test_mock_engine_data_dir_returns_pref(tmp_path: Path) -> None:
    # MagicMock data_dir (used in many unit tests) is not a real Path —
    # function must short-circuit to pref rather than blow up on Path ops.
    engine = MagicMock()
    engine.data_dir = MagicMock()  # not a real Path
    assert resolve_source(engine, "20260528", "005930", "hogaplay") == "hogaplay"


@pytest.mark.parametrize("bad", ["", "kis_ws", "HOGAPLAY"])
def test_source_name_literal_excludes_unknown(bad: str) -> None:
    # Static-typing guard. Runtime check is at the FastAPI layer (422).
    known = set(get_args(SourceName))
    assert known == {"hogaplay", "kis_live"}, f"SourceName set changed to {known} — update both this test and downstream consumers"
    assert bad not in known
