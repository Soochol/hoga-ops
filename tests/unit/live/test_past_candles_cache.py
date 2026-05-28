"""Tests for hoga.live.past_candles_cache."""
from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from hoga.live.past_candles_cache import PastCandlesCache

_KST = timezone(timedelta(hours=9))


def _ts_at(yyyymmdd: str, *, minute_offset: int = 0) -> int:
    """KST 09:00 + N minutes for a YYYYMMDD date, in Unix ms — matches the
    real KIS dailychartprice bar shape so `PastCandlesCache._bars_match_date`
    sees a first-bar timestamp inside the requested KST date."""
    y, m, d = int(yyyymmdd[:4]), int(yyyymmdd[4:6]), int(yyyymmdd[6:8])
    dt = datetime(y, m, d, 9, 0, tzinfo=_KST) + timedelta(minutes=minute_offset)
    return int(dt.timestamp() * 1000)


def _bars(t_ms_list: list[int]) -> list[dict]:
    return [
        {"t_ms": t, "open": 100, "high": 110, "low": 95, "close": 105, "volume": 10}
        for t in t_ms_list
    ]


def _bars_for(date_yyyymmdd: str, n: int = 3) -> list[dict]:
    return _bars([_ts_at(date_yyyymmdd, minute_offset=i) for i in range(n)])


def test_past_disk_miss_then_store_then_hit(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path)
    res = cache.get_past("005930", "20260520")
    assert res is None
    bars = _bars_for("20260520", n=3)
    cache.store_past("005930", "20260520", bars)
    res2 = cache.get_past("005930", "20260520")
    assert res2 is not None
    assert [b["t_ms"] for b in res2] == [b["t_ms"] for b in bars]
    # File exists on disk:
    p = tmp_path / "kis-past-candles" / "005930" / "20260520.json"
    assert p.exists()
    body = json.loads(p.read_text())
    assert "candles" in body
    assert body["candles"][0]["t_ms"] == bars[0]["t_ms"]


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
    bars = _bars_for("20260520", n=1)
    cache.store_past("005930", "20260520", bars)
    # Delete the file under cache's feet; in-memory side cache should still serve.
    (tmp_path / "kis-past-candles" / "005930" / "20260520.json").unlink()
    assert cache.get_past("005930", "20260520") == bars


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
    bars = _bars_for("20260521", n=1)
    cache.store_past("005930", "20260521", bars)
    # Force a fresh cache so the disk path is read.
    cache2 = PastCandlesCache(data_dir=tmp_path)
    assert cache2.get_past("005930", "20260521") == bars


# KST midnight for 2026-05-22 (Friday) = UTC 2026-05-21 15:00 = 1779375600000 ms.
# Used as the "wrong-date" first-bar timestamp for stale-cache tests below.
_TS_20260522_KST_0900 = 1779408000000  # 2026-05-22 09:00 KST


def test_past_stale_cache_with_wrong_date_treated_as_miss_and_evicted(
    tmp_path: Path, caplog
) -> None:
    """Pre-f63ed15 KIS quirk left cache files for non-trading days containing
    the prior trading day's bars (e.g. 20260523.json holding 5/22 bars). Such
    files must be detected (first bar's KST date != requested date), evicted
    from disk, and treated as miss so the (now-fixed) fetcher writes a correct
    result."""
    cache = PastCandlesCache(data_dir=tmp_path)
    # Simulate stale cache: file path is 20260523 (Saturday) but bars start at
    # 2026-05-22 09:00 KST — the classic KIS quirk shape.
    p = tmp_path / "kis-past-candles" / "005930" / "20260523.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        json.dumps({"candles": _bars([_TS_20260522_KST_0900])}),
        encoding="utf-8",
    )
    assert p.exists()

    import logging
    with caplog.at_level(logging.WARNING, logger="hoga.live.past_candles_cache"):
        assert cache.get_past("005930", "20260523") is None
    assert any("stale_disk_evicting" in r.message for r in caplog.records)
    # File was unlinked so the next upstream fetch writes a clean result.
    assert not p.exists()


def test_past_empty_cache_for_non_trading_day_is_valid(tmp_path: Path) -> None:
    """A legitimate non-trading-day cache (empty `candles` list, written after
    f63ed15's filter) must NOT be evicted — empty is the correct shape."""
    cache = PastCandlesCache(data_dir=tmp_path)
    p = tmp_path / "kis-past-candles" / "005930" / "20260523.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"candles": []}), encoding="utf-8")
    assert cache.get_past("005930", "20260523") == []
    assert p.exists()


def test_past_mem_with_wrong_date_evicts_and_falls_through_to_disk(
    tmp_path: Path,
) -> None:
    """In-memory entry whose bars belong to a different date is evicted and the
    disk path is consulted (and may also be evicted/refreshed)."""
    cache = PastCandlesCache(data_dir=tmp_path)
    # Plant valid disk entry for 20260523 (empty = non-trading day).
    cache.store_past("005930", "20260523", [])
    # Manually corrupt in-memory entry with mismatched-date bars.
    cache._past_mem[("005930", "20260523")] = _bars([_TS_20260522_KST_0900])
    # First get: mem hit is rejected (wrong date), disk hit is the valid empty list.
    assert cache.get_past("005930", "20260523") == []
