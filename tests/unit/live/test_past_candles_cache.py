"""Tests for hoga.live.past_candles_cache."""
from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from hoga.live.past_candles_cache import PastCandlesCache

_KST = timezone(timedelta(hours=9))


def _ts_at(yyyymmdd: str, *, minute_offset: int = 0) -> int:
    """KST 09:00 + N minutes for a YYYYMMDD date, in Unix ms."""
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


def test_past_memory_miss_then_store_then_hit_without_disk_write(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path)
    assert cache.get_past("KRX", "005930", "20260520") is None

    bars = _bars_for("20260520", n=3)
    cache.store_past("KRX", "005930", "20260520", bars)

    assert cache.get_past("KRX", "005930", "20260520") == bars
    assert not (tmp_path / "kis-past-candles").exists()


def test_past_cache_does_not_read_legacy_json_files(tmp_path: Path) -> None:
    p = tmp_path / "kis-past-candles" / "005930" / "20260520.json"
    p.parent.mkdir(parents=True)
    payload = json.dumps({"candles": _bars_for("20260520", n=1)}, ensure_ascii=False)
    p.write_text(payload, encoding="utf-8")

    cache = PastCandlesCache(data_dir=tmp_path)

    assert cache.get_past("KRX", "005930", "20260520") is None
    assert p.exists()


def test_past_cache_separates_venue_namespaces(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path)
    krx_bars = _bars_for("20260520", n=1)
    nxt_bars = _bars_for("20260520", n=2)

    cache.store_past("KRX", "005930", "20260520", krx_bars)
    cache.store_past("NXT", "005930", "20260520", nxt_bars)

    assert cache.get_past("KRX", "005930", "20260520") == krx_bars
    assert cache.get_past("NXT", "005930", "20260520") == nxt_bars


def test_delete_past_removes_entry(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path)
    cache.store_past("KRX", "005930", "20260520", _bars_for("20260520", n=1))
    cache.delete_past("KRX", "005930", "20260520")
    assert cache.get_past("KRX", "005930", "20260520") is None
    assert cache.past_entry_count() == 0


def test_stale_bars_purged_on_read(tmp_path: Path) -> None:
    """t_ms가 요청 날짜와 다른 bars는 읽기 시 제거 (_bars_match_date 가드 유지)."""
    cache = PastCandlesCache(data_dir=tmp_path)
    cache.store_past("KRX", "005930", "20260521", _bars_for("20260520", n=1))
    assert cache.get_past("KRX", "005930", "20260521") is None
    assert cache.past_entry_count() == 0


# ----- 코드-지역성 2단 LRU -----


def test_per_code_date_quota_evicts_own_oldest(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path, max_past_dates_per_code=3)
    for date_s in ("20260518", "20260519", "20260520", "20260521"):
        cache.store_past("KRX", "005930", date_s, _bars_for(date_s, n=1))

    assert cache.get_past("KRX", "005930", "20260518") is None
    for date_s in ("20260519", "20260520", "20260521"):
        assert cache.get_past("KRX", "005930", date_s) is not None
    assert cache.past_entry_count() == 3


def test_global_budget_evicts_lru_code_first(tmp_path: Path) -> None:
    """전역 예산 초과 시 LRU '코드'의 날짜부터 축출 — 활성 코드 창 보호.

    512-엔트리 단일 LRU에서는 관심종목 순환이 딥스크롤 중인 코드의
    날짜들을 밀어내 같은 날짜를 세션 중 수십 회 재fetch했다(실측 39회).
    """
    cache = PastCandlesCache(data_dir=tmp_path, max_past_mem_entries=10)
    # 딥스크롤 코드 A: 8개 날짜.
    a_dates = [f"2026052{i}" for i in range(8)]  # 20260520..20260527
    for date_s in a_dates:
        cache.store_past("KRX", "AAAAAA", date_s, _bars_for(date_s, n=1))
    # 코드 B 2개 → 총 10 (예산 딱 참).
    cache.store_past("KRX", "BBBBBB", "20260520", _bars_for("20260520", n=1))
    cache.store_past("KRX", "BBBBBB", "20260521", _bars_for("20260521", n=1))
    # A를 다시 만짐 → A가 MRU 코드.
    assert cache.get_past("KRX", "AAAAAA", "20260520") is not None
    # 코드 C 저장 → 예산 초과분은 LRU 코드 B에서 축출돼야 한다.
    cache.store_past("KRX", "CCCCCC", "20260520", _bars_for("20260520", n=1))

    for date_s in a_dates:
        assert cache.get_past("KRX", "AAAAAA", date_s) is not None, date_s
    assert cache.get_past("KRX", "BBBBBB", "20260520") is None  # B의 oldest 축출
    assert cache.get_past("KRX", "BBBBBB", "20260521") is not None
    assert cache.get_past("KRX", "CCCCCC", "20260520") is not None
    assert cache.past_entry_count() == 10


def test_global_budget_single_code_evicts_own_oldest(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path, max_past_mem_entries=2)

    cache.store_past("KRX", "005930", "20260520", _bars_for("20260520", n=1))
    cache.store_past("KRX", "005930", "20260521", _bars_for("20260521", n=1))
    assert cache.get_past("KRX", "005930", "20260520") is not None  # 20 touch
    cache.store_past("KRX", "005930", "20260522", _bars_for("20260522", n=1))

    assert cache.get_past("KRX", "005930", "20260521") is None
    assert cache.get_past("KRX", "005930", "20260520") is not None
    assert cache.get_past("KRX", "005930", "20260522") is not None


def test_emptied_lru_code_is_dropped_then_next_code_evicted(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path, max_past_mem_entries=2)
    cache.store_past("KRX", "AAAAAA", "20260520", _bars_for("20260520", n=1))
    cache.store_past("KRX", "BBBBBB", "20260520", _bars_for("20260520", n=1))
    # C 저장 → A(LRU, 1개)가 비워지고 드롭. 총 2 유지.
    cache.store_past("KRX", "CCCCCC", "20260520", _bars_for("20260520", n=1))
    assert cache.get_past("KRX", "AAAAAA", "20260520") is None
    assert cache.get_past("KRX", "BBBBBB", "20260520") is not None
    assert cache.get_past("KRX", "CCCCCC", "20260520") is not None
    assert cache.past_entry_count() == 2


# ----- today (기존 계약 유지, venue-명시 시그니처) -----


def test_today_cache_separates_venue_namespaces(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path, today_ttl_seconds=60)
    krx_bars = _bars([100])
    nxt_bars = _bars([200])

    cache.store_today("KRX", "005930", krx_bars)
    cache.store_today("NXT", "005930", nxt_bars)

    assert cache.get_today_tri("KRX", "005930") == ("hit", krx_bars)
    assert cache.get_today_tri("NXT", "005930") == ("hit", nxt_bars)


def test_today_memory_miss_then_store_then_hit(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path, today_ttl_seconds=60)
    state, value = cache.get_today_tri("KRX", "005930")
    assert state == "miss"
    assert value is None
    cache.store_today("KRX", "005930", _bars([100]))
    state, value = cache.get_today_tri("KRX", "005930")
    assert state == "hit"
    assert value == _bars([100])


def test_today_memory_expires_after_ttl(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path, today_ttl_seconds=0.01)
    cache.store_today("KRX", "005930", _bars([1]))
    time.sleep(0.02)
    state, value = cache.get_today_tri("KRX", "005930")
    assert state == "miss"
    assert value is None


def test_today_does_not_touch_disk(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path)
    cache.store_today("KRX", "005930", _bars([1, 2]))
    today_dir = tmp_path / "kis-past-candles" / "005930"
    assert not today_dir.exists() or not any(today_dir.iterdir())


def test_today_memory_cache_evicts_lru_when_bounded(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path, max_today_mem_entries=2)

    cache.store_today("KRX", "005930", _bars([1]))
    cache.store_today("KRX", "000660", _bars([2]))
    assert cache.get_today_tri("KRX", "005930")[0] == "hit"
    cache.store_today("KRX", "035720", _bars([3]))

    assert cache.get_today_tri("KRX", "000660")[0] == "miss"
    assert cache.get_today_tri("KRX", "005930")[0] == "hit"
    assert cache.get_today_tri("KRX", "035720")[0] == "hit"


def test_today_hit_returns_hit_state(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path)
    bars = _bars_for("20260520", n=3)
    cache.store_today("KRX", "005930", bars)
    state, value = cache.get_today_tri("KRX", "005930")
    assert state == "hit"
    assert value == bars


def test_today_miss_returns_miss_state(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path)
    state, value = cache.get_today_tri("KRX", "005930")
    assert state == "miss"
    assert value is None


def test_today_negative_cache(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path)
    cache.store_today("KRX", "005930", None)
    state, value = cache.get_today_tri("KRX", "005930")
    assert state == "negative"
    assert value is None


def test_today_negative_cache_ttl_expiry(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path, today_ttl_seconds=10.0)
    cache.store_today("KRX", "005930", None)
    with patch(
        "hoga.live.past_candles_cache.time.monotonic",
        return_value=time.monotonic() + 11.0,
    ):
        state, _ = cache.get_today_tri("KRX", "005930")
    assert state == "miss"


def _capacity_bar(date_yyyymmdd: str) -> list[dict]:
    y, m, d = int(date_yyyymmdd[:4]), int(date_yyyymmdd[4:6]), int(date_yyyymmdd[6:8])
    ts = datetime(y, m, d, 9, 0, tzinfo=_KST)
    return [{"t_ms": int(ts.timestamp() * 1000), "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1}]


def test_default_capacity_survives_two_symbol_deep_walkback(tmp_path: Path) -> None:
    """250일 워크백(_PAST_MAX_DAYS) × 2종목 + 60일 워밍 × 4종목 ≈ 740키가
    공존해도 최근 날짜가 축출되지 않아야 한다. 512에서는 깊은 walk가 최근
    날짜를 밀어내 60초마다 재fetch churn을 일으켰다(2026-07-07 실측: 같은
    날짜 39회 재fetch)."""
    cache = PastCandlesCache(data_dir=tmp_path)
    start = datetime(2025, 11, 1, tzinfo=_KST)
    dates = [(start + timedelta(days=i)).strftime("%Y%m%d") for i in range(250)]
    for code in ("005930", "000660"):
        for date_s in dates:
            cache.store_past("KRX", code, date_s, _capacity_bar(date_s))
    for code in ("112040", "000270", "015760", "241560"):
        for date_s in dates[-60:]:
            cache.store_past("KRX", code, date_s, _capacity_bar(date_s))

    # 두 종목 250일 전량 + 워밍 4종목 60일 전량 생존
    assert all(
        cache.get_past("KRX", code, date_s) is not None
        for code in ("005930", "000660") for date_s in dates
    )
    assert all(
        cache.get_past("KRX", code, date_s) is not None
        for code in ("112040", "000270", "015760", "241560") for date_s in dates[-60:]
    )
