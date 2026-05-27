"""Tests for hoga.live.past_candles_cache."""
from __future__ import annotations

import json
import time
from pathlib import Path

from hoga.live.past_candles_cache import PastCandlesCache


def _bars(t_ms_list: list[int]) -> list[dict]:
    return [
        {"t_ms": t, "open": 100, "high": 110, "low": 95, "close": 105, "volume": 10}
        for t in t_ms_list
    ]


def test_past_disk_miss_then_store_then_hit(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path)
    res = cache.get_past("005930", "20260520")
    assert res is None
    cache.store_past("005930", "20260520", _bars([1, 2, 3]))
    res2 = cache.get_past("005930", "20260520")
    assert res2 is not None
    assert [b["t_ms"] for b in res2] == [1, 2, 3]
    # File exists on disk:
    p = tmp_path / "kis-past-candles" / "005930" / "20260520.json"
    assert p.exists()
    body = json.loads(p.read_text())
    assert "candles" in body
    assert body["candles"][0]["t_ms"] == 1


def test_today_memory_miss_then_store_then_hit(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path, today_ttl_seconds=60)
    assert cache.get_today("005930") is None
    cache.store_today("005930", _bars([100]))
    assert cache.get_today("005930") == _bars([100])


def test_today_memory_expires_after_ttl(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path, today_ttl_seconds=0.01)
    cache.store_today("005930", _bars([1]))
    time.sleep(0.02)
    assert cache.get_today("005930") is None


def test_today_does_not_touch_disk(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path)
    cache.store_today("005930", _bars([1, 2]))
    # No file should be created for today storage.
    today_dir = tmp_path / "kis-past-candles" / "005930"
    assert not today_dir.exists() or not any(today_dir.iterdir())


def test_past_mem_side_cache_avoids_disk_reread(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path)
    cache.store_past("005930", "20260520", _bars([1]))
    # Delete the file under cache's feet; in-memory side cache should still serve.
    (tmp_path / "kis-past-candles" / "005930" / "20260520.json").unlink()
    assert cache.get_past("005930", "20260520") == _bars([1])


def test_past_corrupt_cache_treated_as_miss_and_heals_on_store(
    tmp_path: Path, caplog
) -> None:
    """A corrupt JSON file in the cache must be treated as miss (return None),
    log a warning, and be overwritten cleanly by the next store_past."""
    cache = PastCandlesCache(data_dir=tmp_path)
    p = tmp_path / "kis-past-candles" / "005930" / "20260521.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("{not valid json", encoding="utf-8")

    import logging
    with caplog.at_level(logging.WARNING, logger="hoga.live.past_candles_cache"):
        assert cache.get_past("005930", "20260521") is None
    assert any("corrupt_or_unreadable" in r.message for r in caplog.records)

    # Next store heals the file.
    cache.store_past("005930", "20260521", _bars([42]))
    # Force a fresh cache so the disk path is read.
    cache2 = PastCandlesCache(data_dir=tmp_path)
    assert cache2.get_past("005930", "20260521") == _bars([42])
