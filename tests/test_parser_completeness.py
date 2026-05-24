"""Parser writes collection_complete + is_partial bits into meta.json."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

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
    meta_path = tmp_path / "parquet" / "20260520" / "005930" / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    assert meta["collection_complete"] is True


def test_meta_has_collection_complete_false_when_progress_not_finished(tmp_path: Path) -> None:
    _stage_raw(tmp_path, "tiny_tsv", "005930", "20260520", finished=False)
    parse_stock_date(code="005930", date="20260520", data_dir=tmp_path, lenient=True)
    meta_path = tmp_path / "parquet" / "20260520" / "005930" / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    assert meta["collection_complete"] is False


def test_meta_collection_complete_false_when_progress_missing(tmp_path: Path) -> None:
    raw = _stage_raw(tmp_path, "tiny_tsv", "005930", "20260520", finished=True)
    (raw / "_progress.json").unlink()
    parse_stock_date(code="005930", date="20260520", data_dir=tmp_path, lenient=True)
    meta_path = tmp_path / "parquet" / "20260520" / "005930" / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    assert meta["collection_complete"] is False


def test_meta_is_partial_field_present(tmp_path: Path) -> None:
    """is_partial may be True or False depending on the fixture's coverage — what
    matters here is that the field exists and is boolean."""
    _stage_raw(tmp_path, "tiny_tsv", "005930", "20260520", finished=True)
    parse_stock_date(code="005930", date="20260520", data_dir=tmp_path, lenient=True)
    meta_path = tmp_path / "parquet" / "20260520" / "005930" / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    assert isinstance(meta.get("is_partial"), bool)


# --- ADR-0020: archival hook ---


def test_meta_omits_invariant_violations_field_when_healthy(tmp_path: Path) -> None:
    """Healthy capture (tiny_tsv has open=90M, close=153M, finished=True)
    should NOT carry an invariant_violations key — clean meta stays clean."""
    _stage_raw(tmp_path, "tiny_tsv", "005930", "20260520", finished=True)
    parse_stock_date(code="005930", date="20260520", data_dir=tmp_path, lenient=True)
    meta_path = tmp_path / "parquet" / "20260520" / "005930" / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    assert "invariant_violations" not in meta


def test_meta_records_invariant_violations_when_incomplete(tmp_path: Path) -> None:
    """Unfinished capture (finished=False) trips collection.finished (warn).
    The archival hook records that violation in the meta.json for diagnostics."""
    _stage_raw(tmp_path, "tiny_tsv", "005930", "20260520", finished=False)
    parse_stock_date(code="005930", date="20260520", data_dir=tmp_path, lenient=True)
    meta_path = tmp_path / "parquet" / "20260520" / "005930" / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    assert "invariant_violations" in meta
    ids = {v["invariant_id"] for v in meta["invariant_violations"]}
    assert "collection.finished" in ids
    # The fixture has healthy session bounds so range invariants don't fire.
    assert "meta.close_after_open" not in ids
