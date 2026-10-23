"""Parser writes collection_complete + is_partial bits into meta.json."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from hoga.parser import parse_stock_date


def _stage_raw(tmp_path: Path, fixture_name: str, code: str, date: str, *, finished: bool) -> Path:
    """Copy a tiny tsv fixture into a raw dir and stamp _progress.json with `finished`."""
    src = Path(__file__).parent / "fixtures" / fixture_name
    dst = tmp_path / "raw" / date / code
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, dst)
    (dst / "_progress.json").write_text(
        json.dumps({
            "last_time_ms": 153100000,
            "pages_done": 3,
            "global_seqs_seen": 15,
            "started_at": "2026-05-20T09:00:00+09:00",
            "finished_at": "2026-05-20T15:31:00+09:00" if finished else None,
            "finished": finished,
        }),
        encoding="utf-8",
    )
    return dst


def test_meta_has_collection_complete_true_when_progress_finished(tmp_path: Path) -> None:
    _stage_raw(tmp_path, "tiny_tsv", "005930", "20260520", finished=True)
    parse_stock_date(code="005930", date="20260520", data_dir=tmp_path, lenient=True)
    meta_path = tmp_path / "parquet" / "20260520" / "005930" / "hogaplay" / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    assert meta["collection_complete"] is True


def test_meta_has_collection_complete_false_when_progress_not_finished(tmp_path: Path) -> None:
    _stage_raw(tmp_path, "tiny_tsv", "005930", "20260520", finished=False)
    parse_stock_date(code="005930", date="20260520", data_dir=tmp_path, lenient=True)
    meta_path = tmp_path / "parquet" / "20260520" / "005930" / "hogaplay" / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    assert meta["collection_complete"] is False


@pytest.mark.parametrize("aftermarket_eligible", [True, False, None])
def test_frozen_upstream_close_zero_is_archived_as_invalid(tmp_path: Path, monkeypatch, aftermarket_eligible) -> None:
    from hoga.api import symbols
    from hoga.api.disk_state import DiskState, check_disk_state

    monkeypatch.setattr(symbols, "krx_aftermarket_eligibility", lambda _: aftermarket_eligible)
    raw = _stage_raw(tmp_path, "tiny_tsv", "005930", "20261023", finished=False)
    info_path = raw / "info.tsv"
    fields = info_path.read_text().strip().split("\t")
    fields[5] = "0"  # 2026-10-23 frozen info.php response; preserve the evidence.
    raw_info = "\t".join(fields)
    info_path.write_text(raw_info, encoding="utf-8")

    out = parse_stock_date(code="005930", date="20261023", data_dir=tmp_path, lenient=True)
    meta = json.loads((out / "meta.json").read_text())

    assert meta["regular_session_close_ms"] == 0
    assert meta["raw_info_tsv"] == raw_info
    assert meta["collection_complete"] is False
    assert meta["is_partial"] is True
    assert {"meta.close_after_open", "meta.close_in_kst_range", "collection.finished"} <= {
        v["invariant_id"] for v in meta["invariant_violations"]
    }
    assert all(0 <= g["start_ms"] < g["end_ms"] for g in meta["gap_ranges"])
    assert check_disk_state(tmp_path, "005930", "20261023", source="hogaplay").state == DiskState.INVALID


def test_meta_collection_complete_false_when_progress_missing(tmp_path: Path) -> None:
    raw = _stage_raw(tmp_path, "tiny_tsv", "005930", "20260520", finished=True)
    (raw / "_progress.json").unlink()
    parse_stock_date(code="005930", date="20260520", data_dir=tmp_path, lenient=True)
    meta_path = tmp_path / "parquet" / "20260520" / "005930" / "hogaplay" / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    assert meta["collection_complete"] is False


def test_meta_is_partial_field_present(tmp_path: Path) -> None:
    """is_partial may be True or False depending on the fixture's coverage — what
    matters here is that the field exists and is boolean."""
    _stage_raw(tmp_path, "tiny_tsv", "005930", "20260520", finished=True)
    parse_stock_date(code="005930", date="20260520", data_dir=tmp_path, lenient=True)
    meta_path = tmp_path / "parquet" / "20260520" / "005930" / "hogaplay" / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    assert isinstance(meta.get("is_partial"), bool)


def test_meta_records_gap_ranges_field(tmp_path: Path) -> None:
    """WS1: the parser writes a gap_ranges list of {start_ms, end_ms} dicts.

    The tiny_tsv fixture is sparse (few snapshots), so is_partial is True but
    the discrete ranges may be empty (the count rule drives is_partial). What's
    asserted here is the field's presence and shape — the boundary values are
    exercised by analyze_gaps unit tests."""
    _stage_raw(tmp_path, "tiny_tsv", "005930", "20260520", finished=True)
    parse_stock_date(code="005930", date="20260520", data_dir=tmp_path, lenient=True)
    meta_path = tmp_path / "parquet" / "20260520" / "005930" / "hogaplay" / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    assert isinstance(meta.get("gap_ranges"), list)
    for g in meta["gap_ranges"]:
        assert set(g.keys()) == {"start_ms", "end_ms"}
        assert isinstance(g["start_ms"], int) and isinstance(g["end_ms"], int)


# --- ADR-0093: identical_capture_count ---


def test_identical_capture_count_starts_at_one(tmp_path: Path) -> None:
    _stage_raw(tmp_path, "tiny_tsv", "005930", "20260520", finished=True)
    parse_stock_date(code="005930", date="20260520", data_dir=tmp_path, lenient=True)
    meta_path = tmp_path / "parquet" / "20260520" / "005930" / "hogaplay" / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    assert meta["identical_capture_count"] == 1


def test_identical_capture_count_increments_on_reparse_of_same_raw(tmp_path: Path) -> None:
    """Re-parsing the identical raw data yields the identical fingerprint →
    the counter climbs (1 → 2). This is the confirmed-upstream-gap signal."""
    _stage_raw(tmp_path, "tiny_tsv", "005930", "20260520", finished=True)
    parse_stock_date(code="005930", date="20260520", data_dir=tmp_path, lenient=True)
    parse_stock_date(code="005930", date="20260520", data_dir=tmp_path, lenient=True)
    meta_path = tmp_path / "parquet" / "20260520" / "005930" / "hogaplay" / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    assert meta["identical_capture_count"] == 2


def test_identical_capture_count_helper_logic() -> None:
    """Unit-test the pure helper across the branches ADR-0093 defines."""
    from hoga.parser import _identical_capture_count

    base = {
        "collection_complete": True,
        "total_unique_events": 100, "pages_collected": 10,
        "gap_ranges": [{"start_ms": 135000000, "end_ms": 141000000}],
    }
    # No prior → 1
    assert _identical_capture_count(None, base) == 1
    # Prior identical (legacy, no counter) → 2
    assert _identical_capture_count(dict(base), base) == 2
    # Prior identical with counter=2 → 3
    assert _identical_capture_count({**base, "identical_capture_count": 2}, base) == 3
    # Prior differs (fewer events → upstream healed) → reset to 1
    assert _identical_capture_count({**base, "total_unique_events": 90}, base) == 1
    # Different gap window, same event count → still "changed" → 1
    assert _identical_capture_count(
        {**base, "gap_ranges": [{"start_ms": 100000000, "end_ms": 101000000}]}, base,
    ) == 1
    # Prior not complete → 1 (a failed prior attempt isn't a reproducible result)
    assert _identical_capture_count({**base, "collection_complete": False}, base) == 1
    # Current not complete → 1
    assert _identical_capture_count(base, {**base, "collection_complete": False}) == 1


# --- ADR-0020: archival hook ---


def test_meta_omits_meta_level_violations_when_healthy(tmp_path: Path) -> None:
    """Healthy meta (tiny_tsv: open=90M, close=153M, finished=True) does not
    fire any meta-level invariants. (The tiny_tsv fixture is intentionally
    minimal — 2 snapshots, hand-built candles — so series-level invariants
    can still fire against it; that path is covered by the parser archival
    test below. Here we lock the meta-level surface.)"""
    _stage_raw(tmp_path, "tiny_tsv", "005930", "20260520", finished=True)
    parse_stock_date(code="005930", date="20260520", data_dir=tmp_path, lenient=True)
    meta_path = tmp_path / "parquet" / "20260520" / "005930" / "hogaplay" / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta_level_ids = {
        v["invariant_id"] for v in meta.get("invariant_violations", [])
        if v["invariant_id"].startswith("meta.") or v["invariant_id"].startswith("collection.")
    }
    assert meta_level_ids == set()


def test_meta_archives_series_violations_for_tiny_tsv_fixture(tmp_path: Path) -> None:
    """Series-level invariants surface in the archival even when meta is clean.

    tiny_tsv has hand-built candles whose ts_ms aren't sorted and only 2
    snapshots — both legit series invariant breaches. Locks the integration
    between parser write-time and SERIES_INVARIANTS for this PR.
    """
    _stage_raw(tmp_path, "tiny_tsv", "005930", "20260520", finished=True)
    parse_stock_date(code="005930", date="20260520", data_dir=tmp_path, lenient=True)
    meta_path = tmp_path / "parquet" / "20260520" / "005930" / "hogaplay" / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    series_ids = {
        v["invariant_id"] for v in meta.get("invariant_violations", [])
        if v["invariant_id"].startswith("series.")
    }
    # tiny_tsv fixture trips at least one of the series invariants.
    assert len(series_ids) >= 1
    assert all(_id.startswith("series.") for _id in series_ids)


def test_meta_records_invariant_violations_when_incomplete(tmp_path: Path) -> None:
    """Unfinished capture (finished=False) trips collection.finished (warn).
    The archival hook records that violation in the meta.json for diagnostics."""
    _stage_raw(tmp_path, "tiny_tsv", "005930", "20260520", finished=False)
    parse_stock_date(code="005930", date="20260520", data_dir=tmp_path, lenient=True)
    meta_path = tmp_path / "parquet" / "20260520" / "005930" / "hogaplay" / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    assert "invariant_violations" in meta
    ids = {v["invariant_id"] for v in meta["invariant_violations"]}
    assert "collection.finished" in ids
    # The fixture has healthy session bounds so range invariants don't fire.
    assert "meta.close_after_open" not in ids
