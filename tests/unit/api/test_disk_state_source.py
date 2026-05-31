"""Stage 6A — source-aware disk_state helpers.

`classify_stock_date` returns a per-source dict; `aggregate_disk_state`
picks the best state across sources.
"""
import json
from pathlib import Path

import pytest

from hoga.api.disk_state import (
    DiskState,
    aggregate_disk_state,
    classify_stock_date,
)


def _write_meta(path: Path, meta: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(meta))


def test_classify_stock_date_returns_per_source_states(tmp_path: Path) -> None:
    """Two sources side-by-side → returns both keys."""
    sd_dir = tmp_path / "parquet" / "20260527" / "005930"
    _write_meta(
        sd_dir / "hogaplay" / "meta.json",
        {
            "collection_complete": True,
            "is_partial": False,
            "regular_session_open_ms": 90000000,
            "regular_session_close_ms": 153000000,
        },
    )
    _write_meta(
        sd_dir / "kis_live" / "meta.json",
        {
            "source": "kis_live",
            "row_counts": {"snapshots": 100},
            # kis_live meta doesn't carry the hogaplay collection_complete /
            # is_partial fields; classify_from_meta should treat absence as
            # the conservative CLIENT_INCOMPLETE default.
        },
    )

    states = {k: v.state for k, v in classify_stock_date(sd_dir).items()}
    assert set(states.keys()) == {"hogaplay", "kis_live"}
    assert states["hogaplay"] == DiskState.COMPLETE


def test_classify_stock_date_handles_only_one_source(tmp_path: Path) -> None:
    sd_dir = tmp_path / "parquet" / "20260527" / "005930"
    _write_meta(
        sd_dir / "hogaplay" / "meta.json",
        {
            "collection_complete": True, "is_partial": False,
            "regular_session_open_ms": 90000000,
            "regular_session_close_ms": 153000000,
        },
    )
    states = {k: v.state for k, v in classify_stock_date(sd_dir).items()}
    assert set(states.keys()) == {"hogaplay"}


def test_classify_stock_date_skips_non_dir_entries(tmp_path: Path) -> None:
    """Stray files (not source dirs) under the Stock-Date dir are ignored."""
    sd_dir = tmp_path / "parquet" / "20260527" / "005930"
    sd_dir.mkdir(parents=True)
    (sd_dir / "stray.txt").write_text("ignored")
    _write_meta(
        sd_dir / "hogaplay" / "meta.json",
        {
            "collection_complete": True, "is_partial": False,
            "regular_session_open_ms": 90000000,
            "regular_session_close_ms": 153000000,
        },
    )
    states = {k: v.state for k, v in classify_stock_date(sd_dir).items()}
    assert set(states.keys()) == {"hogaplay"}


def test_classify_stock_date_missing_dir_returns_empty(tmp_path: Path) -> None:
    states = classify_stock_date(tmp_path / "nope")
    assert states == {}  # empty dict regardless of value type


def test_classify_stock_date_invalid_json_yields_INVALID(tmp_path: Path) -> None:
    sd_dir = tmp_path / "parquet" / "20260527" / "005930"
    (sd_dir / "hogaplay").mkdir(parents=True)
    (sd_dir / "hogaplay" / "meta.json").write_text("not-json-{")
    states = {k: v.state for k, v in classify_stock_date(sd_dir).items()}
    assert states == {"hogaplay": DiskState.INVALID}


def test_aggregate_takes_best_of_sources() -> None:
    assert aggregate_disk_state(
        {"hogaplay": DiskState.COMPLETE, "kis_live": DiskState.NONE}
    ) == DiskState.COMPLETE
    assert aggregate_disk_state(
        {"hogaplay": DiskState.INVALID, "kis_live": DiskState.COMPLETE}
    ) == DiskState.COMPLETE
    assert aggregate_disk_state({"hogaplay": DiskState.SOURCE_PARTIAL}) == DiskState.SOURCE_PARTIAL


def test_aggregate_empty_returns_NONE() -> None:
    assert aggregate_disk_state({}) == DiskState.NONE
