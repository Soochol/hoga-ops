"""PR-1 observability: each instrumented cache's CacheStats counters.

Kept separate from the caches' behavioural golden suites so those stay
byte-for-byte unmodified (PR-4 relies on that for the daily cache)."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from hoga.api.models import AskPeak
from hoga.api.past_indicators_cache import PastIndicatorsCache
from hoga.api.today_ttl_cache import TodayTtlCache
from hoga.live.index_candles_cache import IndexCandlesCache
from hoga.live.index_minute_candles_cache import IndexMinuteCandlesCache
from hoga.live.kis_client import IndexCandleFetchResult
from hoga.live.past_candles_cache import PastCandlesCache
from hoga.live.past_daily_candles_cache import PastDailyCandlesCache
from hoga.tables.snapshots import QuoteRatioRow

_KST = timezone(timedelta(hours=9))


def _ts(yyyymmdd: str) -> int:
    dt = datetime(int(yyyymmdd[:4]), int(yyyymmdd[4:6]), int(yyyymmdd[6:8]), 9, 0, tzinfo=_KST)
    return int(dt.timestamp() * 1000)


def test_past_candles_past_hit_miss_and_eviction(tmp_path):
    c = PastCandlesCache(tmp_path, max_past_mem_entries=2, max_past_dates_per_code=10)
    c.store_past("KRX", "AAA", "20260102", [{"t_ms": _ts("20260102")}])
    assert c.get_past("KRX", "AAA", "20260102") is not None  # hit
    assert c.get_past("KRX", "AAA", "19990101") is None  # miss (unknown date)
    assert c.get_past("KRX", "ZZZ", "20260102") is None  # miss (unknown code)
    past = c.stats_snapshot()["past"]
    assert past["hits"] == 1
    assert past["misses"] == 2
    assert past["stores"] == 1

    # Global budget = 2. Store two more dates across a second code → LRU code's
    # oldest evicted.
    c.store_past("KRX", "AAA", "20260103", [{"t_ms": _ts("20260103")}])  # total 2
    c.store_past("KRX", "BBB", "20260104", [{"t_ms": _ts("20260104")}])  # total 3 → evict 1
    assert c.stats_snapshot()["past"]["evictions"] == 1


def test_past_candles_today_tri_state(tmp_path):
    c = PastCandlesCache(tmp_path)
    assert c.get_today_tri("KRX", "AAA")[0] == "miss"
    c.store_today("KRX", "AAA", [{"t_ms": 1}])
    assert c.get_today_tri("KRX", "AAA")[0] == "hit"
    c.store_today("KRX", "BBB", None)
    assert c.get_today_tri("KRX", "BBB")[0] == "negative"
    today = c.stats_snapshot()["today"]
    assert today["hits"] == 1
    assert today["misses"] == 1
    assert today["negatives"] == 1


def test_indicators_mem_vs_disk_hit(tmp_path):
    rows = [QuoteRatioRow(
        bucket_intra_ms=0, bid_total=1, ask_total=1, bid_max=1, ask_max=1,
        imb_max_bid=0, imb_max_ask=0,
    )]
    writer = PastIndicatorsCache(tmp_path)
    writer.store_ratio("AAA", "20260102", "kis_live", rows)
    assert writer.get_ratio("AAA", "20260102", "kis_live") is not None  # mem hit
    wsnap = writer.stats_snapshot()["ratio"]
    assert wsnap["hits"] == 1 and wsnap["disk_hits"] == 0 and wsnap["stores"] == 1

    # Fresh instance over the same dir → served from disk, not memory.
    reader = PastIndicatorsCache(tmp_path)
    assert reader.get_ratio("AAA", "20260102", "kis_live") is not None
    assert reader.get_ratio("AAA", "19990101", "kis_live") is None  # true miss
    rsnap = reader.stats_snapshot()["ratio"]
    assert rsnap["hits"] == 1 and rsnap["disk_hits"] == 1 and rsnap["misses"] == 1


def test_indicators_peak_accounted_on_has_not_get(tmp_path):
    c = PastIndicatorsCache(tmp_path)
    tms = _ts("20260102")
    peak = AskPeak(
        date="20260102", price=100, qty=5, t_ms=tms,
        max_price=100, max_qty=5, max_t_ms=tms,
    )
    c.store_ask_peak("AAA", "20260102", "kis_live", 60_000, peak)
    # has_ (real lookup) then get_ (mem re-read) — the bundle.py pattern.
    assert c.has_ask_peak("AAA", "20260102", "kis_live", 60_000) is True
    _ = c.get_ask_peak("AAA", "20260102", "kis_live", 60_000)
    assert c.has_ask_peak("AAA", "20260102", "kis_live", 30_000) is False  # miss
    snap = c.stats_snapshot()["ask_peak"]
    # get_ must NOT add a lookup: exactly 2 lookups from the two has_ calls.
    assert snap["lookups"] == 2
    assert snap["hits"] == 1 and snap["misses"] == 1


def test_index_minute_hit_miss_eviction():
    c = IndexMinuteCandlesCache(max_exact_entries=1)
    empty = IndexCandleFetchResult(candles=[], violations=[])
    assert c.get_exact(("KOSPI", "M", 1), "a", "b") is None  # miss
    c.store_exact(("KOSPI", "M", 1), "a", "b", empty)
    assert c.get_exact(("KOSPI", "M", 1), "a", "b") is not None  # hit
    c.store_exact(("KOSPI", "M", 1), "c", "d", empty)  # over cap → evict
    snap = c.stats_snapshot()
    assert snap["hits"] == 1 and snap["misses"] == 1 and snap["evictions"] == 1


def test_index_candles_covered_counts_lookup_once():
    c = IndexCandlesCache()
    key = ("KOSPI", "D")
    assert c.covered(key, date(2026, 1, 2), date(2026, 1, 2)) is None  # miss
    c.append_batch(key, date(2026, 1, 2), date(2026, 1, 2), [])
    # The post-fetch re-assembly call passes count=False and must not be counted.
    assert c.covered(key, date(2026, 1, 2), date(2026, 1, 2), count=False) is not None
    snap = c.stats_snapshot()
    assert snap["misses"] == 1 and snap["hits"] == 0  # only the count=True miss


def test_daily_batch_and_today_stats():
    c = PastDailyCandlesCache()
    assert c.list_batches("KRX", "AAA") == []  # batch miss
    c.append_batch("KRX", "AAA", date(2026, 1, 2), date(2026, 1, 2), [])
    assert c.list_batches("KRX", "AAA")  # batch hit
    assert c.get_today("KRX", "AAA")[0] == "miss"
    snap = c.stats_snapshot()
    assert snap["batches"]["hits"] == 1 and snap["batches"]["misses"] == 1
    assert snap["today"]["misses"] == 1


def test_today_ttl_hit_miss_counted_in_lock():
    clock = [1000.0]
    c = TodayTtlCache(ttl_ms=15_000, clock=lambda: clock[0])
    assert c.lookup(("k",)) == (False, None)  # miss
    c.put(("k",), "v")
    assert c.lookup(("k",)) == (True, "v")  # hit
    snap = c.stats_snapshot()
    assert snap["hits"] == 1 and snap["misses"] == 1 and snap["stores"] == 1


def test_today_ttl_disabled_not_counted():
    c = TodayTtlCache(ttl_ms=0)
    assert c.lookup(("k",)) == (False, None)
    c.put(("k",), "v")
    snap = c.stats_snapshot()
    assert snap["lookups"] == 0  # disabled cache is not a lookup
