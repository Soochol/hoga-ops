"""Disk-only scrollback inventory, including wholly empty months."""
import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from hoga.api.bundle import build_range_bundle
from hoga.api.queries import QueryEngine
from hoga.tables import candles


def _partition(root: Path, date: str, *, empty: bool = False) -> Path:
    path = root / "parquet" / date / "034020" / "hogaplay"
    path.mkdir(parents=True)
    (path / "meta.json").write_text(json.dumps({
        "collection_complete": True, "is_partial": False,
        "regular_session_open_ms": 90_000_000, "regular_session_close_ms": 153_000_000,
        "pages_collected": 100, "total_unique_events": 80,
    }))
    # On-disk timestamps are linear milliseconds from KST midnight.
    rows = [] if empty else [candles.Candle(32_400_000, 100, 101, 102, 99, 10, 20)]
    candles.write_parquet(rows, path / "candles.parquet")
    return path


def test_empty_month_keeps_global_floor_and_calendar_without_synthetic_candles(tmp_path: Path) -> None:
    _partition(tmp_path, "20250324")
    _partition(tmp_path, "20251001")
    engine = QueryEngine(tmp_path)
    try:
        result = build_range_bundle(
            engine, code="034020", from_date="20250901", to_date="20250930",
            bucket_ms=60_000, mode="candles",
        )
        assert result.candles == []
        assert result.segments == []
        assert result.earliest_captured_date == "20250324"
        wire = result.model_dump(mode="json")
        history = wire["local_candle_history"]
        assert history["available_dates"] == ["20250324", "20251001"]
        assert "20250901" in history["trading_dates"]
        assert "20250906" not in history["trading_dates"]  # Saturday
        older = build_range_bundle(
            engine, code="034020", from_date="20250324", to_date="20250930",
            bucket_ms=180_000, mode="candles",
        )
        assert len(older.candles) == 1
        assert older.candles[0].close == 101
        assert [s.date for s in older.segments] == ["20250324"]
        assert len(older.local_candle_history.trading_dates) > 100
    finally:
        engine.close()


def test_inventory_excludes_empty_corrupt_and_wrong_venue_and_refreshes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _partition(tmp_path, "20250324", empty=True)
    broken = _partition(tmp_path, "20250325")
    (broken / "candles.parquet").write_bytes(b"broken")
    wrong_schema = _partition(tmp_path, "20250327")
    pq.write_table(pa.table({"unrelated": [1]}), wrong_schema / "candles.parquet")
    _partition(tmp_path, "20251001")
    engine = QueryEngine(tmp_path)
    clock = [1.0]
    monkeypatch.setattr("hoga.api.queries.time.monotonic", lambda: clock[0])
    try:
        assert engine.local_candle_dates(code="034020") == ["20251001"]
        assert engine.local_candle_dates(code="034020", venue="NXT") == []
        _partition(tmp_path, "20250326")
        assert engine.local_candle_dates(code="034020") == ["20251001"]
        clock[0] += 31
        assert engine.local_candle_dates(code="034020") == ["20250326", "20251001"]
    finally:
        engine.close()


def test_inventory_reads_only_footers_not_prices(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _partition(tmp_path, "20251001")
    engine = QueryEngine(tmp_path)
    monkeypatch.setattr(pq, "read_table", lambda *_a, **_kw: pytest.fail("candle body loaded"))
    try:
        assert engine.local_candle_dates(code="034020") == ["20251001"]
        # A footer with zero rows is distinguishable from a missing file.
        assert pq.read_metadata(tmp_path / "parquet/20251001/034020/hogaplay/candles.parquet").num_rows == 1
    finally:
        engine.close()


@pytest.mark.parametrize("date,clock", [("20250324", 57540000), ("20260914", 71940000), ("20260914", 72000000)])
@pytest.mark.parametrize("bucket_ms", [60000, 3600000, 7200000, 14400000])
def test_disk_evening_bounds_and_badge_filter_preserve_storage(tmp_path, date, clock, bucket_ms):
    from hoga.util.timeenc import hhmmssms_to_unix_ms

    folder = _partition(tmp_path, date)
    candles.write_parquet([
        candles.Candle(36000000, 100, 101, 102, 99, 10, 20),
        candles.Candle(clock, 200, 201, 202, 199, 100, 200),
    ], folder / "candles.parquet")
    before = {p.name: p.read_bytes() for p in folder.iterdir()}
    engine = QueryEngine(tmp_path)
    try:
        for regular in [False, True, False]:
            result = build_range_bundle(engine, code="034020", from_date=date, to_date=date,
                bucket_ms=bucket_ms, mode="candles", regular_session_only=regular)
            assert sum(c.vol_a + c.vol_b for c in result.candles) == (30 if regular else 330)
            midnight = hhmmssms_to_unix_ms(date, 0)
            if regular:
                assert max(c.high for c in result.candles) == 102
                assert result.segments[0].session_close_ms == midnight + 55800000
            else:
                assert max(c.high for c in result.candles) == 202
                assert result.segments[0].session_close_ms >= midnight + clock
        assert {p.name: p.read_bytes() for p in folder.iterdir()} == before
    finally:
        engine.close()
