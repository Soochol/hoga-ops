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
    check_disk_state,
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
            # A legacy kis_live meta (pre-ADR-0115) lacks collection_complete /
            # is_partial; classify_from_meta treats absence as the conservative
            # CLIENT_INCOMPLETE default. New promotions DO carry them (see
            # test_check_disk_state_* below and tests/unit/live/test_promote.py).
        },
    )

    states = {k: v.state for k, v in classify_stock_date(sd_dir).items()}
    assert set(states.keys()) == {"hogaplay", "kis_live"}
    assert states["hogaplay"] == DiskState.COMPLETE


def _COMPLETE_META(source: str) -> dict:
    return {
        "source": source,
        "collection_complete": True,
        "is_partial": False,
        "regular_session_open_ms": 90000000,
        "regular_session_close_ms": 153000000,
    }


def test_check_disk_state_source_none_aggregates(tmp_path: Path) -> None:
    """ADR-0115: default (source=None) aggregates — a COMPLETE kis_live promotes
    the Stock-Date to COMPLETE even with no hogaplay artifact."""
    sd_dir = tmp_path / "parquet" / "20260527" / "005930"
    _write_meta(sd_dir / "kis_live" / "meta.json", _COMPLETE_META("kis_live"))
    assert check_disk_state(tmp_path, "005930", "20260527").state == DiskState.COMPLETE


def test_check_disk_state_source_hogaplay_ignores_kis(tmp_path: Path) -> None:
    """ADR-0115: source='hogaplay' ignores a kis_live-only COMPLETE → NONE, so
    the capture pipeline still collects hogaplay for that date."""
    sd_dir = tmp_path / "parquet" / "20260527" / "005930"
    _write_meta(sd_dir / "kis_live" / "meta.json", _COMPLETE_META("kis_live"))
    assert check_disk_state(
        tmp_path, "005930", "20260527", source="hogaplay",
    ).state == DiskState.NONE


def test_check_disk_state_source_hogaplay_sees_hogaplay(tmp_path: Path) -> None:
    """source='hogaplay' still returns a real hogaplay COMPLETE."""
    sd_dir = tmp_path / "parquet" / "20260527" / "005930"
    _write_meta(sd_dir / "hogaplay" / "meta.json", _COMPLETE_META("hogaplay"))
    _write_meta(sd_dir / "kis_live" / "meta.json", _COMPLETE_META("kis_live"))
    assert check_disk_state(
        tmp_path, "005930", "20260527", source="hogaplay",
    ).state == DiskState.COMPLETE


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
