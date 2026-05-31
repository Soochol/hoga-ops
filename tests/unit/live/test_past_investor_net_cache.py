"""Tests for PastInvestorNetCache (per-code flat-TTL memory cache)."""
from __future__ import annotations

from hoga.live.past_investor_net_cache import PastInvestorNetCache

_PT = {"t_ms": 1_700_000_000_000, "foreign_net": 100, "institution_net": -50}


def test_get_miss_on_empty_cache() -> None:
    cache = PastInvestorNetCache()
    assert cache.get("005930") == ("miss", None)


def test_store_then_hit_returns_points() -> None:
    cache = PastInvestorNetCache()
    cache.store("005930", [_PT])
    state, points = cache.get("005930")
    assert state == "hit"
    assert points == [_PT]


def test_empty_points_still_hit() -> None:
    # No-data code: an empty list is cached so we don't re-hit KIS within TTL.
    cache = PastInvestorNetCache()
    cache.store("005930", [])
    assert cache.get("005930") == ("hit", [])


def test_miss_after_ttl_expiry() -> None:
    cache = PastInvestorNetCache(ttl_seconds=0.0)
    cache.store("005930", [_PT])
    state, _ = cache.get("005930")
    assert state == "miss"


def test_per_code_isolation() -> None:
    cache = PastInvestorNetCache()
    cache.store("005930", [_PT])
    assert cache.get("000660") == ("miss", None)
