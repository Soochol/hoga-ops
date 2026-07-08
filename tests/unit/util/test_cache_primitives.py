from hoga.util.cache_primitives import DualHorizonCache, LruDict, TtlTriStateCache
from hoga.util.cache_stats import CacheStats

# ── LruDict ────────────────────────────────────────────────────────────────

def test_lrudict_trim_evicts_oldest_and_counts():
    stats = CacheStats()
    d: LruDict[str, int] = LruDict(2, stats=stats)
    for k, v in (("a", 1), ("b", 2), ("c", 3)):
        d._d[k] = v  # type: ignore[attr-defined]  # direct insert for a focused trim test
    d.trim()
    assert "a" not in d and "b" in d and "c" in d
    assert len(d) == 2
    assert stats.evictions == 1


def test_lrudict_move_to_end_changes_eviction_order():
    d: LruDict[str, int] = LruDict(2)
    d.setdefault("a", lambda: 1)
    d.setdefault("b", lambda: 2)
    d.move_to_end("a")  # a is now newest → b evicts first
    d.setdefault("c", lambda: 3)
    d.trim()
    assert "b" not in d and "a" in d and "c" in d


def test_lrudict_setdefault_returns_existing_and_inserts_once():
    d: LruDict[str, list[int]] = LruDict(4)
    first = d.setdefault("k", list)
    first.append(1)
    again = d.setdefault("k", list)  # factory NOT called again
    again.append(2)
    assert d.get("k") == [1, 2]


def test_lrudict_max_zero_evicts_everything_on_trim():
    d: LruDict[str, int] = LruDict(0)
    d.setdefault("a", lambda: 1)
    d.trim()
    assert len(d) == 0


# ── TtlTriStateCache ─────────────────────────────────────────────────────────

def _clock(box):
    return lambda: box[0]


def test_ttl_hit_miss_negative():
    box = [1000.0]
    stats = CacheStats()
    c: TtlTriStateCache[str, int] = TtlTriStateCache(10.0, 8, clock=_clock(box), stats=stats)
    assert c.get("k") == ("miss", None)
    c.store("k", 42)
    assert c.get("k") == ("hit", 42)
    c.store("neg", None)
    assert c.get("neg") == ("negative", None)
    assert stats.hits == 1 and stats.negatives == 1 and stats.misses == 1


def test_ttl_expiry_is_inclusive_boundary():
    box = [1000.0]
    c: TtlTriStateCache[str, int] = TtlTriStateCache(10.0, 8, clock=_clock(box))
    c.store("k", 1)
    box[0] = 1000.0 + 9.999
    assert c.get("k") == ("hit", 1)
    box[0] = 1000.0 + 10.0  # elapsed >= ttl → expired
    assert c.get("k") == ("miss", None)
    assert "k" not in c  # expired entry is dropped


def test_ttl_lru_eviction_counts():
    box = [1000.0]
    stats = CacheStats()
    c: TtlTriStateCache[str, int] = TtlTriStateCache(10.0, 2, clock=_clock(box), stats=stats)
    c.store("a", 1)
    c.store("b", 2)
    c.store("c", 3)  # over cap → evict oldest (a)
    assert "a" not in c and "b" in c and "c" in c
    assert stats.evictions == 1


# ── DualHorizonCache ─────────────────────────────────────────────────────────

def test_dual_horizon_holds_past_and_today():
    past: LruDict[str, int] = LruDict(4)
    today: TtlTriStateCache[str, int] = TtlTriStateCache(10.0, 4, clock=lambda: 0.0)
    dh: DualHorizonCache[LruDict[str, int], int] = DualHorizonCache(past=past, today=today)
    dh.past.setdefault("k", lambda: 1)
    dh.today.store("k", 2)
    assert dh.past.get("k") == 1
    assert dh.today.get("k") == ("hit", 2)
