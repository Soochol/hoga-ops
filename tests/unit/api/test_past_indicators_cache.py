"""PastIndicatorsCache — disk cache of 1m quote_ratio / fill_strength rows."""
from __future__ import annotations

import json
from pathlib import Path

from hoga.api.past_indicators_cache import PastIndicatorsCache
from hoga.tables.snapshots import QuoteRatioRow
from hoga.tables.trades import FillStrengthRow

CODE = "005930"
DATE = "20260529"
SRC = "kis_live"

RATIO = [QuoteRatioRow(bucket_intra_ms=0, bid_total=10, ask_total=20),
         QuoteRatioRow(bucket_intra_ms=60_000, bid_total=0, ask_total=0)]
FILL = [FillStrengthRow(bucket_intra_ms=0, buy_qty=5, sell_qty=3)]


def test_ratio_roundtrip_in_memory(tmp_path: Path) -> None:
    c = PastIndicatorsCache(tmp_path)
    assert c.get_ratio(CODE, DATE, SRC) is None
    c.store_ratio(CODE, DATE, SRC, RATIO)
    assert c.get_ratio(CODE, DATE, SRC) == RATIO


def test_fill_roundtrip_in_memory(tmp_path: Path) -> None:
    c = PastIndicatorsCache(tmp_path)
    assert c.get_fill(CODE, DATE, SRC) is None
    c.store_fill(CODE, DATE, SRC, FILL)
    assert c.get_fill(CODE, DATE, SRC) == FILL


def test_persists_to_disk_across_instances(tmp_path: Path) -> None:
    PastIndicatorsCache(tmp_path).store_ratio(CODE, DATE, SRC, RATIO)
    PastIndicatorsCache(tmp_path).store_fill(CODE, DATE, SRC, FILL)
    # A FRESH instance (cold memory) must reconstruct identical rows from disk.
    fresh = PastIndicatorsCache(tmp_path)
    assert fresh.get_ratio(CODE, DATE, SRC) == RATIO
    assert fresh.get_fill(CODE, DATE, SRC) == FILL


def test_path_layout_is_code_source_date_kind(tmp_path: Path) -> None:
    PastIndicatorsCache(tmp_path).store_ratio(CODE, DATE, SRC, RATIO)
    assert (tmp_path / "kis-past-indicators" / CODE / SRC / f"{DATE}.ratio.json").exists()


def test_source_is_part_of_the_key(tmp_path: Path) -> None:
    # Same (code, date), different source → independent entries (no silent swap).
    c = PastIndicatorsCache(tmp_path)
    c.store_ratio(CODE, DATE, "kis_live", RATIO)
    assert c.get_ratio(CODE, DATE, "hogaplay") is None


def test_corrupt_file_is_a_miss(tmp_path: Path) -> None:
    c = PastIndicatorsCache(tmp_path)
    c.store_ratio(CODE, DATE, SRC, RATIO)
    p = tmp_path / "kis-past-indicators" / CODE / SRC / f"{DATE}.ratio.json"
    p.write_text("{ not json", encoding="utf-8")
    PastIndicatorsCache(tmp_path)  # cold instance bypasses memory
    assert PastIndicatorsCache(tmp_path).get_ratio(CODE, DATE, SRC) is None


def test_version_mismatch_is_a_miss(tmp_path: Path) -> None:
    c = PastIndicatorsCache(tmp_path)
    c.store_ratio(CODE, DATE, SRC, RATIO)
    p = tmp_path / "kis-past-indicators" / CODE / SRC / f"{DATE}.ratio.json"
    body = json.loads(p.read_text())
    body["version"] = 999
    p.write_text(json.dumps(body), encoding="utf-8")
    assert PastIndicatorsCache(tmp_path).get_ratio(CODE, DATE, SRC) is None


def test_empty_rows_roundtrip(tmp_path: Path) -> None:
    # A no-data day legitimately caches an empty list (distinct from a miss=None).
    c = PastIndicatorsCache(tmp_path)
    c.store_ratio(CODE, DATE, SRC, [])
    assert PastIndicatorsCache(tmp_path).get_ratio(CODE, DATE, SRC) == []
