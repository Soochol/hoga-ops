"""hoga validate — read-only sweep of all Stock-Date meta.json."""
from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from hoga.cli import app


def _seed(data_dir: Path, date: str, code: str, meta: dict) -> None:
    d = data_dir / "parquet" / date / code
    d.mkdir(parents=True, exist_ok=True)
    (d / "meta.json").write_text(json.dumps(meta), encoding="utf-8")


def _healthy() -> dict:
    return {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_000_000,
        "collection_complete": True,
        "is_partial": False,
        "pages_collected": 100,
        "total_unique_events": 80,
    }


def test_validate_reports_violations(tmp_path, monkeypatch):
    """Walks parquet/, reports invariant violations to stdout."""
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    _seed(tmp_path, "20260518", "003490", _healthy() | {"regular_session_close_ms": 0})
    _seed(tmp_path, "20260520", "005930", _healthy())

    result = CliRunner().invoke(app, ["validate"])
    assert result.exit_code == 0
    assert "20260518" in result.stdout
    assert "003490" in result.stdout
    assert "meta.close_after_open" in result.stdout
    assert "005930" not in result.stdout


def test_validate_filters_by_code(tmp_path, monkeypatch):
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    _seed(tmp_path, "20260518", "003490", _healthy() | {"regular_session_close_ms": 0})
    _seed(tmp_path, "20260518", "005930", _healthy() | {"regular_session_close_ms": 0})

    result = CliRunner().invoke(app, ["validate", "--code", "003490"])
    assert result.exit_code == 0
    assert "003490" in result.stdout
    assert "005930" not in result.stdout


def test_validate_severity_warn_includes_warns(tmp_path, monkeypatch):
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    # warn-only: low unique_events_ratio (4132 pages, 1553 events = real 5/18 case)
    _seed(tmp_path, "20260520", "005930",
          _healthy() | {"pages_collected": 4132, "total_unique_events": 1553})

    result_err = CliRunner().invoke(app, ["validate", "--severity", "error"])
    assert "005930" not in result_err.stdout

    result_warn = CliRunner().invoke(app, ["validate", "--severity", "warn"])
    assert "005930" in result_warn.stdout
    assert "collection.unique_events_ratio" in result_warn.stdout


def test_validate_fix_writes_archival_field(tmp_path, monkeypatch):
    """--fix rewrites the invariant_violations archival field. Data untouched."""
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    meta = _healthy() | {"regular_session_close_ms": 0}
    _seed(tmp_path, "20260518", "003490", meta)

    before = json.loads((tmp_path / "parquet" / "20260518" / "003490" / "meta.json").read_text())
    assert "invariant_violations" not in before

    result = CliRunner().invoke(app, ["validate", "--fix"])
    assert result.exit_code == 0

    after = json.loads((tmp_path / "parquet" / "20260518" / "003490" / "meta.json").read_text())
    assert "invariant_violations" in after
    ids = {v["invariant_id"] for v in after["invariant_violations"]}
    assert "meta.close_after_open" in ids
    # Original fields preserved.
    assert after["regular_session_open_ms"] == meta["regular_session_open_ms"]


def test_validate_fix_is_idempotent(tmp_path, monkeypatch):
    """Running --fix twice produces the same file content."""
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    _seed(tmp_path, "20260518", "003490", _healthy() | {"regular_session_close_ms": 0})

    CliRunner().invoke(app, ["validate", "--fix"])
    snap1 = (tmp_path / "parquet" / "20260518" / "003490" / "meta.json").read_text()
    CliRunner().invoke(app, ["validate", "--fix"])
    snap2 = (tmp_path / "parquet" / "20260518" / "003490" / "meta.json").read_text()
    assert snap1 == snap2
