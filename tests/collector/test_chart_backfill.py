from __future__ import annotations

import json
from pathlib import Path

import pytest

from hoga.collector import chart_backfill
from hoga.tables import candles
from tests.collector.test_chart_pagination import row


def stage(root: Path, *, raw_exists: bool = True):
    source = root / "parquet" / "20261022" / "005930" / "hogaplay"
    source.mkdir(parents=True)
    body = row(900) + row(899)
    candles.write_parquet([candles.parse_row(line) for line in body.splitlines()], source / "candles.parquet")
    meta = {"collection_complete": False, "is_partial": True, "full_capture_count": 4,
            "identical_capture_count": 2,
            "invariant_violations": [{"invariant_id": "series.snapshots_no_gaps", "severity": "warn"}]}
    (source / "meta.json").write_text(json.dumps(meta))
    (source / "trades.parquet").write_bytes(b"protected trades")
    raw = root / "raw" / "20261022" / "005930" / "chart.tsv"
    if raw_exists:
        raw.parent.mkdir(parents=True)
        raw.write_text(body)
    return source, raw, meta


@pytest.mark.parametrize("raw_exists", [True, False])
def test_backfill_preserves_existing_candles_and_capture_state(tmp_path, raw_exists):
    source, raw, meta = stage(tmp_path, raw_exists=raw_exists)
    old = candles.read_parquet(source / "candles.parquet")
    body = row(900) + row(899) + row(600) + row(540)
    options = dict(code="005930", date="20261022", chart_body=body, backup_dir=tmp_path / "backup")
    result = chart_backfill.repair_chart(tmp_path, **options)
    assert result.added == 2
    assert result.before_count == 2 and result.after_count == 4
    assert candles.read_parquet(source / "candles.parquet")[-2:] == old
    saved = json.loads((source / "meta.json").read_text())
    for key, value in meta.items():
        assert saved[key] == value
    assert (source / "trades.parquet").read_bytes() == b"protected trades"
    assert raw.read_text() == body
    before = {p: p.read_bytes() for p in [raw, source / "meta.json", source / "candles.parquet"]}
    assert chart_backfill.repair_chart(tmp_path, **options).added == 0
    assert all(p.read_bytes() == value for p, value in before.items())


def test_changed_upstream_with_pruned_raw_is_rejected_without_writes(tmp_path):
    source, raw, _ = stage(tmp_path, raw_exists=False)
    body = row(900, price=999) + row(899) + row(540)
    with pytest.raises(ValueError, match="cannot reproduce"):
        chart_backfill.repair_chart(tmp_path, code="005930", date="20261022", chart_body=body,
                                    backup_dir=tmp_path / "backup")
    assert not raw.exists()
    assert len(candles.read_parquet(source / "candles.parquet")) == 2


@pytest.mark.parametrize("raw_exists", [True, False])
def test_publication_failure_restores_all_original_files(tmp_path, monkeypatch, raw_exists):
    source, raw, _ = stage(tmp_path, raw_exists=raw_exists)
    paths = [raw, source / "candles.parquet", source / "meta.json"]
    before = {p: p.read_bytes() if p.exists() else None for p in paths}
    real_write = chart_backfill.atomic_write_json

    def fail_meta(path, payload):
        if path == source / "meta.json":
            raise OSError("injected publication failure")
        return real_write(path, payload)

    monkeypatch.setattr(chart_backfill, "atomic_write_json", fail_meta)
    with pytest.raises(OSError, match="injected"):
        chart_backfill.repair_chart(tmp_path, code="005930", date="20261022",
                                    chart_body=row(900) + row(899) + row(540), backup_dir=tmp_path / "backup")
    assert {p: p.read_bytes() if p.exists() else None for p in paths} == before
