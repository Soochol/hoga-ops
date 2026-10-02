"""TodayTtlCache — 오늘자 지표 short-TTL 캐시 (ADR-0090)."""
from hoga.api.today_ttl_cache import TodayTtlCache


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_hit_within_ttl_miss_after():
    clock = FakeClock()
    c = TodayTtlCache(ttl_ms=15_000, clock=clock)
    c.put(("ratio", "005930"), [1, 2, 3])
    assert c.lookup(("ratio", "005930")) == (True, [1, 2, 3])
    clock.now += 14.9
    assert c.lookup(("ratio", "005930")) == (True, [1, 2, 3])
    clock.now += 0.2  # 15.1s 경과
    assert c.lookup(("ratio", "005930")) == (False, None)


def test_ttl_zero_disables():
    c = TodayTtlCache(ttl_ms=0, clock=FakeClock())
    c.put(("k",), "v")
    assert c.lookup(("k",)) == (False, None)


def test_none_value_is_a_hit():
    """peak 행은 정당하게 None일 수 있다 — (hit, value) 튜플이라 구분된다."""
    clock = FakeClock()
    c = TodayTtlCache(ttl_ms=15_000, clock=clock)
    c.put(("peak",), None)
    assert c.lookup(("peak",)) == (True, None)


def test_put_prunes_expired():
    clock = FakeClock()
    c = TodayTtlCache(ttl_ms=1_000, clock=clock)
    c.put(("a",), 1)
    clock.now += 2.0
    c.put(("b",), 2)
    assert ("a",) not in c._entries  # 만료 항목은 다음 put에서 정리


def test_env_default(monkeypatch):
    monkeypatch.setenv("HOGA_TODAY_INDICATOR_TTL_MS", "junk")
    assert TodayTtlCache()._ttl_s == 15.0  # 파싱 실패 → 기본 15,000ms


def test_entry_and_byte_budget_with_lru_and_oversized_replacement():
    c = TodayTtlCache(max_entries=2, max_bytes=1000)
    c.put("a", "one")
    c.put("b", "two")
    assert c.lookup("a")[0]
    c.put("c", "three")
    assert not c.lookup("b")[0]
    c.put("a", "x" * 2000)
    assert not c.lookup("a")[0]  # oversized replacement must not serve the old value
    assert c.lookup("c") == (True, "three")
    assert c.stats_snapshot()["estimated_bytes"] <= 1000


def test_expired_lookup_releases_value_and_byte_accounting():
    clock = FakeClock()
    c = TodayTtlCache(ttl_ms=1000, clock=clock)
    c.put("a", [1, 2, 3])
    clock.now += 2
    assert not c.lookup("a")[0]
    assert c.stats_snapshot()["size"] == c.stats_snapshot()["estimated_bytes"] == 0
