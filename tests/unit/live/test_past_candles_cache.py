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
    assert cache.get_past("KRX", "005930", "20260520", "1") is None

    bars = _bars_for("20260520", n=3)
    cache.store_past("KRX", "005930", "20260520", bars, "1")

    assert cache.get_past("KRX", "005930", "20260520", "1") == bars
    assert not (tmp_path / "kis-past-candles").exists()


def test_past_cache_does_not_read_legacy_json_files(tmp_path: Path) -> None:
    p = tmp_path / "kis-past-candles" / "005930" / "20260520.json"
    p.parent.mkdir(parents=True)
    payload = json.dumps({"candles": _bars_for("20260520", n=1)}, ensure_ascii=False)
    p.write_text(payload, encoding="utf-8")

    cache = PastCandlesCache(data_dir=tmp_path)

    assert cache.get_past("KRX", "005930", "20260520", "1") is None
    assert p.exists()


def test_past_cache_separates_venue_namespaces(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path)
    krx_bars = _bars_for("20260520", n=1)
    nxt_bars = _bars_for("20260520", n=2)

    cache.store_past("KRX", "005930", "20260520", krx_bars, "1")
    cache.store_past("NXT", "005930", "20260520", nxt_bars, "1")

    assert cache.get_past("KRX", "005930", "20260520", "1") == krx_bars
    assert cache.get_past("NXT", "005930", "20260520", "1") == nxt_bars


def test_past_cache_separates_tic_scope_namespaces(tmp_path: Path) -> None:
    """같은 (venue, code, date) 라도 스코프가 다르면 다른 봉이다.

    키에서 스코프가 빠지면 10분 요청이 1분 엔트리를 히트해 **조용히 틀린 해상도**를
    서빙한다 — 봉 개수만 달라지고 에러는 안 난다. venue 분리와 같은 이유의 계약이다.
    """
    cache = PastCandlesCache(data_dir=tmp_path)
    one_min = _bars_for("20260520", n=1)
    ten_min = _bars_for("20260520", n=2)

    cache.store_past("KRX", "005930", "20260520", one_min, "1")
    cache.store_past("KRX", "005930", "20260520", ten_min, "10")

    assert cache.get_past("KRX", "005930", "20260520", "1") == one_min
    assert cache.get_past("KRX", "005930", "20260520", "10") == ten_min
    # 저장 안 한 스코프는 히트하지 않는다 — 인접 스코프로 흘러가면 안 된다.
    assert cache.get_past("KRX", "005930", "20260520", "5") is None


def test_delete_past_only_drops_its_own_scope(tmp_path: Path) -> None:
    """폴백 무효화(비-KRX → KRX)가 다른 tf 의 캐시를 쓸어가면 안 된다."""
    cache = PastCandlesCache(data_dir=tmp_path)
    cache.store_past("KRX", "005930", "20260520", _bars_for("20260520", n=1), "1")
    cache.store_past("KRX", "005930", "20260520", _bars_for("20260520", n=2), "10")

    cache.delete_past("KRX", "005930", "20260520", "1")

    assert cache.get_past("KRX", "005930", "20260520", "1") is None
    assert cache.get_past("KRX", "005930", "20260520", "10") is not None


def test_delete_past_removes_entry(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path)
    cache.store_past("KRX", "005930", "20260520", _bars_for("20260520", n=1), "1")
    cache.delete_past("KRX", "005930", "20260520", "1")
    assert cache.get_past("KRX", "005930", "20260520", "1") is None
    assert cache.past_entry_count() == 0


def test_stale_bars_purged_on_read(tmp_path: Path) -> None:
    """t_ms가 요청 날짜와 다른 bars는 읽기 시 제거 (_bars_match_date 가드 유지)."""
    cache = PastCandlesCache(data_dir=tmp_path)
    cache.store_past("KRX", "005930", "20260521", _bars_for("20260520", n=1), "1")
    assert cache.get_past("KRX", "005930", "20260521", "1") is None
    assert cache.past_entry_count() == 0


# ----- 코드-지역성 2단 LRU -----
#
# 아래 축출 테스트들은 전부 `_bars_for(..., n=1)`(1봉)을 쓴다. 예산 단위가 봉 수라
# 무게가 엔트리당 1 이 되어 "개수 = 봉 수" 가 성립하므로, 크기 비례 예산으로 바뀐
# 뒤에도 이 시나리오들의 의미가 그대로 보존된다. 크기가 실제로 갈리는 경우는
# 아래 "크기 비례 예산" 절에서 따로 검증한다.


def test_per_code_date_quota_evicts_own_oldest(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path, max_past_bars_per_code=3)
    for date_s in ("20260518", "20260519", "20260520", "20260521"):
        cache.store_past("KRX", "005930", date_s, _bars_for(date_s, n=1), "1")

    assert cache.get_past("KRX", "005930", "20260518", "1") is None
    for date_s in ("20260519", "20260520", "20260521"):
        assert cache.get_past("KRX", "005930", date_s, "1") is not None
    assert cache.past_entry_count() == 3


def test_global_budget_evicts_lru_code_first(tmp_path: Path) -> None:
    """전역 예산 초과 시 LRU '코드'의 날짜부터 축출 — 활성 코드 창 보호.

    512-엔트리 단일 LRU에서는 관심종목 순환이 딥스크롤 중인 코드의
    날짜들을 밀어내 같은 날짜를 세션 중 수십 회 재fetch했다(실측 39회).
    """
    cache = PastCandlesCache(data_dir=tmp_path, max_past_mem_bars=10)
    # 딥스크롤 코드 A: 8개 날짜.
    a_dates = [f"2026052{i}" for i in range(8)]  # 20260520..20260527
    for date_s in a_dates:
        cache.store_past("KRX", "AAAAAA", date_s, _bars_for(date_s, n=1), "1")
    # 코드 B 2개 → 총 10 (예산 딱 참).
    cache.store_past("KRX", "BBBBBB", "20260520", _bars_for("20260520", n=1), "1")
    cache.store_past("KRX", "BBBBBB", "20260521", _bars_for("20260521", n=1), "1")
    # A를 다시 만짐 → A가 MRU 코드.
    assert cache.get_past("KRX", "AAAAAA", "20260520", "1") is not None
    # 코드 C 저장 → 예산 초과분은 LRU 코드 B에서 축출돼야 한다.
    cache.store_past("KRX", "CCCCCC", "20260520", _bars_for("20260520", n=1), "1")

    for date_s in a_dates:
        assert cache.get_past("KRX", "AAAAAA", date_s, "1") is not None, date_s
    assert cache.get_past("KRX", "BBBBBB", "20260520", "1") is None  # B의 oldest 축출
    assert cache.get_past("KRX", "BBBBBB", "20260521", "1") is not None
    assert cache.get_past("KRX", "CCCCCC", "20260520", "1") is not None
    assert cache.past_entry_count() == 10


def test_global_budget_single_code_evicts_own_oldest(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path, max_past_mem_bars=2)

    cache.store_past("KRX", "005930", "20260520", _bars_for("20260520", n=1), "1")
    cache.store_past("KRX", "005930", "20260521", _bars_for("20260521", n=1), "1")
    assert cache.get_past("KRX", "005930", "20260520", "1") is not None  # 20 touch
    cache.store_past("KRX", "005930", "20260522", _bars_for("20260522", n=1), "1")

    assert cache.get_past("KRX", "005930", "20260521", "1") is None
    assert cache.get_past("KRX", "005930", "20260520", "1") is not None
    assert cache.get_past("KRX", "005930", "20260522", "1") is not None


def test_emptied_lru_code_is_dropped_then_next_code_evicted(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path, max_past_mem_bars=2)
    cache.store_past("KRX", "AAAAAA", "20260520", _bars_for("20260520", n=1), "1")
    cache.store_past("KRX", "BBBBBB", "20260520", _bars_for("20260520", n=1), "1")
    # C 저장 → A(LRU, 1개)가 비워지고 드롭. 총 2 유지.
    cache.store_past("KRX", "CCCCCC", "20260520", _bars_for("20260520", n=1), "1")
    assert cache.get_past("KRX", "AAAAAA", "20260520", "1") is None
    assert cache.get_past("KRX", "BBBBBB", "20260520", "1") is not None
    assert cache.get_past("KRX", "CCCCCC", "20260520", "1") is not None
    assert cache.past_entry_count() == 2


# ----- 크기 비례 예산 -----


def test_cheaper_scope_fits_more_dates_in_the_same_budget(tmp_path: Path) -> None:
    """상위 tf 는 봉이 적으므로 **같은 예산에 더 깊게** 담긴다.

    이것이 예산을 개수 대신 봉 수로 세는 이유다. 날짜 개수로 쿼터를 걸면 10분봉이
    1분봉과 똑같은 자리를 먹어, 여러 tf 를 오갈 때 각 tf 의 유효 깊이가 `1/N` 로
    깎이고 read-ahead 클램프(243일)를 못 채운다.
    """
    # 1분봉 10봉/일 vs 10분봉 1봉/일 — 예산 20봉.
    cache = PastCandlesCache(data_dir=tmp_path, max_past_bars_per_code=20)
    for i in range(5):
        date_s = f"2026052{i}"
        cache.store_past("KRX", "AAAAAA", date_s, _bars_for(date_s, n=10), "1")
    # 비싼 1분봉은 2일치(20봉)만 남는다.
    assert cache.past_bar_count() == 20
    assert cache.get_past("KRX", "AAAAAA", "20260522", "1") is None
    assert cache.get_past("KRX", "AAAAAA", "20260524", "1") is not None

    cache2 = PastCandlesCache(data_dir=tmp_path, max_past_bars_per_code=20)
    for i in range(5):
        date_s = f"2026052{i}"
        cache2.store_past("KRX", "AAAAAA", date_s, _bars_for(date_s, n=1), "10")
    # 싼 10분봉은 5일치가 전부 살아 있다 — 같은 예산, 더 긴 히스토리.
    assert cache2.past_bar_count() == 5
    for i in range(5):
        assert cache2.get_past("KRX", "AAAAAA", f"2026052{i}", "10") is not None


def test_per_code_quota_holds_across_scopes(tmp_path: Path) -> None:
    """한 종목이 여러 tf 를 써도 **종목당** 상한이 유지된다(격리).

    스코프가 바깥 키에 있으면 쿼터가 "종목×스코프"당이 되어 상한이 스코프 수만큼
    곱해진다 — 2단 구조가 막으려던 독식이 그대로 돌아온다.
    """
    cache = PastCandlesCache(data_dir=tmp_path, max_past_bars_per_code=4)
    for scope in ("1", "5", "10", "30"):
        for date_s in ("20260520", "20260521"):
            cache.store_past("KRX", "005930", date_s, _bars_for(date_s, n=1), scope)

    # 스코프가 4개여도 종목 전체가 4봉을 넘지 않는다.
    assert cache.past_bar_count() == 4
    # 가장 오래 안 쓴 스코프부터 밀렸다 — 최신 스코프는 살아 있다.
    assert cache.get_past("KRX", "005930", "20260520", "1") is None
    assert cache.get_past("KRX", "005930", "20260521", "30") is not None


def test_empty_entries_still_consume_budget(tmp_path: Path) -> None:
    """비거래일 빈 배열도 자리를 차지한다.

    봉 수로만 세면 무게가 0 이라 예산을 전혀 소비하지 않고 무한 증식한다 —
    243일 창에서 주말·공휴일이 ~70일이라 무시할 비중이 아니다.
    """
    cache = PastCandlesCache(data_dir=tmp_path, max_past_bars_per_code=2)
    for date_s in ("20260520", "20260521", "20260522"):
        cache.store_past("KRX", "005930", date_s, [], "1")

    assert cache.past_bar_count() == 2
    assert cache.past_entry_count() == 2
    assert cache.get_past("KRX", "005930", "20260520", "1") is None


def test_overwrite_replaces_weight_instead_of_adding(tmp_path: Path) -> None:
    """같은 슬롯 재저장은 무게를 **교체**한다 — 누적되면 예산이 새어 조기 축출된다."""
    cache = PastCandlesCache(data_dir=tmp_path)
    cache.store_past("KRX", "005930", "20260520", _bars_for("20260520", n=5), "1")
    assert cache.past_bar_count() == 5

    cache.store_past("KRX", "005930", "20260520", _bars_for("20260520", n=2), "1")
    assert cache.past_bar_count() == 2
    assert cache.past_entry_count() == 1


def test_dropping_stale_entry_releases_its_weight(tmp_path: Path) -> None:
    """읽기 시 stale 제거·delete 도 무게를 되돌려준다(누수 방지)."""
    cache = PastCandlesCache(data_dir=tmp_path)
    # 요청 날짜와 다른 t_ms → 읽을 때 제거된다.
    cache.store_past("KRX", "005930", "20260521", _bars_for("20260520", n=4), "1")
    assert cache.past_bar_count() == 4
    assert cache.get_past("KRX", "005930", "20260521", "1") is None
    assert cache.past_bar_count() == 0

    cache.store_past("KRX", "005930", "20260520", _bars_for("20260520", n=3), "1")
    cache.delete_past("KRX", "005930", "20260520", "1")
    assert cache.past_bar_count() == 0


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
            cache.store_past("KRX", code, date_s, _capacity_bar(date_s), "1")
    for code in ("112040", "000270", "015760", "241560"):
        for date_s in dates[-60:]:
            cache.store_past("KRX", code, date_s, _capacity_bar(date_s), "1")

    # 두 종목 250일 전량 + 워밍 4종목 60일 전량 생존
    assert all(
        cache.get_past("KRX", code, date_s, "1") is not None
        for code in ("005930", "000660") for date_s in dates
    )
    assert all(
        cache.get_past("KRX", code, date_s, "1") is not None
        for code in ("112040", "000270", "015760", "241560") for date_s in dates[-60:]
    )
