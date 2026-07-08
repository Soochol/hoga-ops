from hoga.util.cache_stats import CacheStats


def test_starts_empty():
    snap = CacheStats().snapshot()
    assert snap["hits"] == 0
    assert snap["misses"] == 0
    assert snap["lookups"] == 0
    assert snap["hit_rate"] is None  # no lookups yet → undefined, not 0.0
    assert snap["size"] is None


def test_hit_miss_negative_are_all_lookups():
    s = CacheStats()
    s.record_hit()
    s.record_hit()
    s.record_miss()
    s.record_negative()
    snap = s.snapshot()
    assert snap["hits"] == 2
    assert snap["misses"] == 1
    assert snap["negatives"] == 1
    assert snap["lookups"] == 4
    # hit_rate counts only real-data hits, but negatives still divide the total.
    assert snap["hit_rate"] == 0.5


def test_disk_hit_counts_as_hit_and_disk_hit():
    s = CacheStats()
    s.record_hit()  # memory tier
    s.record_disk_hit()  # memory miss, disk found
    snap = s.snapshot()
    assert snap["hits"] == 2  # disk hit is still a hit (value served)
    assert snap["disk_hits"] == 1
    assert snap["misses"] == 0
    assert snap["lookups"] == 2
    assert snap["hit_rate"] == 1.0


def test_store_and_eviction_are_separate_from_lookups():
    s = CacheStats()
    s.record_store()
    s.record_eviction()
    s.record_eviction(3)
    snap = s.snapshot()
    assert snap["stores"] == 1
    assert snap["evictions"] == 4
    assert snap["lookups"] == 0  # stores/evictions are not lookups


def test_eviction_ignores_nonpositive():
    s = CacheStats()
    s.record_eviction(0)
    s.record_eviction(-2)
    assert s.evictions == 0


def test_snapshot_size_passthrough():
    assert CacheStats().snapshot(size=42)["size"] == 42
