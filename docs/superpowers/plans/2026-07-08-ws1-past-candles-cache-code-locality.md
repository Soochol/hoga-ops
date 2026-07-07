# WS1: PastCandlesCache 코드-지역성 2단 LRU Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/live` 분봉 캐시의 전역 512-엔트리 날짜-LRU를 (venue, Code) 코드-지역성 2단 LRU로 재구성해, 관심종목 순환 시 딥스크롤 중인 활성 Code의 캐시 창이 축출-churn으로 파괴되는 문제(같은 날짜 수십 회 재fetch → KIS 15/s 예산 낭비 → 팬 지연)를 구조적으로 제거한다.

**Architecture:** `_past_mem`을 `OrderedDict[(venue, code) → OrderedDict[date → bars]]` 2단으로 바꾼다. 축출은 ① per-code 날짜 쿼터(기본 320 — ADR-0090 read-ahead 243캘린더일 클램프 + 여유), ② 전역 예산(기본 1536, 기존 512에서 상향 — ADR-0036 로컬 단일유저 철학과 정합) 초과 시 **LRU 코드의 가장 오래된 날짜부터** 축출. 방금 접근한 코드는 MRU이므로 딥스크롤 창이 보호된다. 탐색에서 확인된 얕은 `*args` 오버로드 시그니처(2-arg 레거시 형태)는 명시적 `(venue, code, date)` 시그니처로 정리한다 — 프로덕션 호출자(live_candle_backfill.py)는 이미 전부 venue-명시 형태라 무변경. 이어서 memory-only 전환(2026-07-04) 후 죽은 코드가 된 OSError/write_err 배관을 live_candle_backfill.py에서 제거한다.

**Tech Stack:** Python OrderedDict, pytest (`uv run --extra dev pytest`).

**변경하지 않는 것:** `collect_minute`의 구간 인터페이스·venue 폴백·warm latest-wins·`_inflight` per-date single-flight (탐색 결과 이미 올바르게 동작 — 탐색 리포트의 "read-ahead 미병합" 주장은 코드 확인 결과 오판), today 계층의 TTL/tri-state 의미론, `_bars_match_date` 가드.

---

### Task 1: PastCandlesCache 2단 LRU + 명시적 시그니처

**Files:**
- Modify: `hoga/live/past_candles_cache.py` (전면 재작성)
- Test: `tests/unit/live/test_past_candles_cache.py` (레거시 arg-형태 갱신 + churn 회귀 테스트 추가)

- [ ] **Step 1: 테스트 파일 갱신 (실패 예상)**

`tests/unit/live/test_past_candles_cache.py`를 다음으로 교체. 기존 계약 테스트는 전부 유지하되 ① 레거시 2-arg/1-arg 호출을 venue-명시 형태로, ② `_past_mem` 내부 형태 단언을 공개 표면(`get_past`/`past_entry_count()`)으로 바꾸고, ③ 코드-지역성 회귀 테스트 4개를 추가:

```python
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
```

- [ ] **Step 2: 실패 확인**

Run: `uv run --extra dev pytest tests/unit/live/test_past_candles_cache.py -x -q`
Expected: FAIL — `TypeError`(시그니처) 또는 `AttributeError: past_entry_count` / `max_past_dates_per_code` 미지원

- [ ] **Step 3: 구현 — past_candles_cache.py 전면 재작성**

```python
"""Memory-only cache for KIS minute candle results.

Backs GET /api/live/past-candles. Both past and today's candles live only in
process memory; restart/deploy/eviction is natural invalidation.

past 계층은 코드-지역성 2단 LRU: (venue, code) 코드-LRU 아래에 date-LRU.
전역 예산 초과 시 LRU '코드'의 가장 오래된 날짜부터 축출한다 — 단일 전역
날짜-LRU에서는 관심종목 순환이 딥스크롤 중인 활성 코드의 창을 밀어내
같은 날짜를 세션 중 수십 회 재fetch하는 churn이 있었다.
"""
from __future__ import annotations

import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

from hoga.live.kis_venue import KisVenue

_KST = timezone(timedelta(hours=9))


def _ts_ms_to_kst_yyyymmdd(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, tz=_KST).strftime("%Y%m%d")


# Default TTL for today's memory cache.
TODAY_TTL_SECONDS = 60.0
# 전역 예산: ADR-0036(로컬 단일유저) 하에서 딥스크롤 코드 수 개 분량.
DEFAULT_PAST_MEM_MAX_ENTRIES = 1536
# per-code 쿼터: ADR-0090 read-ahead 클램프(243캘린더일) + 여유.
DEFAULT_PAST_MAX_DATES_PER_CODE = 320
DEFAULT_TODAY_MEM_MAX_ENTRIES = 256

TodayState = Literal["hit", "miss", "negative"]


class PastCandlesCache:
    """Memory-only cache for KIS minute candles."""

    def __init__(
        self,
        data_dir: Path,
        *,
        today_ttl_seconds: float = TODAY_TTL_SECONDS,
        max_past_mem_entries: int = DEFAULT_PAST_MEM_MAX_ENTRIES,
        max_past_dates_per_code: int = DEFAULT_PAST_MAX_DATES_PER_CODE,
        max_today_mem_entries: int = DEFAULT_TODAY_MEM_MAX_ENTRIES,
    ):
        self._data_dir = data_dir
        self._today_ttl = today_ttl_seconds
        self._max_past_mem_entries = max(0, int(max_past_mem_entries))
        self._max_past_dates_per_code = max(0, int(max_past_dates_per_code))
        self._max_today_mem_entries = max(0, int(max_today_mem_entries))
        self._past_mem: OrderedDict[
            tuple[KisVenue, str], OrderedDict[str, list[dict]]
        ] = OrderedDict()
        self._past_total = 0
        self._today_mem: OrderedDict[
            tuple[KisVenue, str],
            tuple[float, list[dict] | None],
        ] = OrderedDict()

    # --- past ---

    def past_entry_count(self) -> int:
        return self._past_total

    def get_past(self, venue: KisVenue, code: str, date: str) -> list[dict] | None:
        key = (venue, code)
        inner = self._past_mem.get(key)
        if inner is None:
            return None
        bars = inner.get(date)
        if bars is None:
            return None
        if not self._bars_match_date(bars, date):
            self._drop_date(key, inner, date)
            return None
        inner.move_to_end(date)
        self._past_mem.move_to_end(key)
        return bars

    @staticmethod
    def _bars_match_date(bars: list[dict], date_yyyymmdd: str) -> bool:
        """True if `bars` is empty or first bar `t_ms` matches requested date."""
        if not bars:
            return True
        first_ts = bars[0].get("t_ms")
        if not isinstance(first_ts, int):
            return False
        return _ts_ms_to_kst_yyyymmdd(first_ts) == date_yyyymmdd

    def store_past(
        self, venue: KisVenue, code: str, date: str, bars: list[dict]
    ) -> None:
        key = (venue, code)
        inner = self._past_mem.get(key)
        if inner is None:
            inner = OrderedDict()
            self._past_mem[key] = inner
        if date not in inner:
            self._past_total += 1
        inner[date] = bars
        inner.move_to_end(date)
        self._past_mem.move_to_end(key)
        # ① per-code 쿼터: 자기 자신의 oldest부터.
        while len(inner) > self._max_past_dates_per_code:
            inner.popitem(last=False)
            self._past_total -= 1
        if not inner:
            self._past_mem.pop(key, None)
        # ② 전역 예산: LRU 코드의 oldest부터 (방금 저장한 코드는 MRU라 보호).
        while self._past_total > self._max_past_mem_entries and self._past_mem:
            lru_key, lru_inner = next(iter(self._past_mem.items()))
            lru_inner.popitem(last=False)
            self._past_total -= 1
            if not lru_inner:
                del self._past_mem[lru_key]

    def delete_past(self, venue: KisVenue, code: str, date: str) -> None:
        key = (venue, code)
        inner = self._past_mem.get(key)
        if inner is None:
            return
        if date in inner:
            self._drop_date(key, inner, date)

    def _drop_date(
        self, key: tuple[KisVenue, str], inner: OrderedDict, date: str
    ) -> None:
        inner.pop(date, None)
        self._past_total -= 1
        if not inner:
            self._past_mem.pop(key, None)

    # --- today ---

    def get_today_tri(
        self, venue: KisVenue, code: str
    ) -> tuple[TodayState, list[dict] | None]:
        """Tri-state today accessor."""
        entry = self._today_mem.get((venue, code))
        if entry is None:
            return "miss", None
        fetched_at, value = entry
        if time.monotonic() - fetched_at >= self._today_ttl:
            self._today_mem.pop((venue, code), None)
            return "miss", None
        self._today_mem.move_to_end((venue, code))
        if value is None:
            return "negative", None
        return "hit", value

    def store_today(
        self, venue: KisVenue, code: str, bars: list[dict] | None
    ) -> None:
        key = (venue, code)
        self._today_mem[key] = (time.monotonic(), bars)
        self._today_mem.move_to_end(key)
        while len(self._today_mem) > self._max_today_mem_entries:
            self._today_mem.popitem(last=False)
```

- [ ] **Step 4: 통과 확인**

Run: `uv run --extra dev pytest tests/unit/live/test_past_candles_cache.py -q`
Expected: 19 PASS

- [ ] **Step 5: 호출자 회귀 확인 (live 스위트)**

Run: `uv run --extra dev pytest tests/unit/live/ -q`
Expected: 전부 PASS (프로덕션 호출자는 이미 venue-명시 형태 — live_candle_backfill.py:183,295,298,318,338,341,411,418,641 / get_today_tri·store_today 호출부 351-354, 481, 490, 510, 513 모두 venue 첫-인자)

- [ ] **Step 6: 커밋**

```bash
git add hoga/live/past_candles_cache.py tests/unit/live/test_past_candles_cache.py
git commit -m "perf(live): 분봉 캐시 코드-지역성 2단 LRU — 관심종목 순환의 딥스크롤 창 축출 churn 제거 (WS1)"
```

---

### Task 2: 죽은 write_err/OSError 배관 제거 (memory-only 전환 잔재)

**Files:**
- Modify: `hoga/live/live_candle_backfill.py` (`_fetch_past_once`, `_fetch_past_today_once`, `_fetch_past_shared`, `_fetch_past_scheduled`, `_collect_for_venue`, `_warm_run`)

**근거 (삭제 테스트):** `store_past`는 memory-only(2026-07-04 amendment)라 OSError를 던질 수 없다. `write_err`는 항상 `None` → `cache_write_failed` warning은 도달 불가능한 죽은 경로. 테스트/프론트 어디에도 `cache_write_failed` 참조 없음(grep 확인).

- [ ] **Step 1: 반환형 단순화**

`_fetch_past_once` — try/except OSError 제거, `list[dict]` 반환:

```python
    async def _fetch_past_once(
        self,
        kis: KisClient,
        venue: KisVenue,
        code: str,
        date_s: str,
        *,
        foreground: bool = True,
    ) -> list[dict]:
        raw = await kis.fetch_past_minute_candles(
            code,
            date_s,
            venue=venue,
            foreground=foreground,
        )
        bars = [_candle_to_dict(c) for c in raw]
        self._cache.store_past(venue, code, date_s, bars)
        return bars
```

`_fetch_past_today_once` — `list[dict]` 반환:

```python
    async def _fetch_past_today_once(
        self,
        kis: KisClient,
        venue: KisVenue,
        code: str,
        date_s: str,
    ) -> list[dict]:
        raw = await kis.fetch_past_minute_candles(
            code,
            date_s,
            venue=venue,
            foreground=True,
        )
        return [_candle_to_dict(c) for c in raw]
```

`_fetch_past_shared` / `_fetch_past_scheduled` — 반환형 어노테이션을 `list[dict]`로, `_inflight` dict 타입을 `asyncio.Task[list[dict]]`로. `_fetch_past_scheduled`의 perf 로그에서 `cache_write_error=%s` 필드와 `result[1] is not None` 인자 제거, `candles=%d`는 `len(result)`로.

호출부 3곳 언팩 제거:
- `_warm_run` (기존 line 303): `bars, _write_err = await ...` → `await self._fetch_past_shared(venue, code, date_s, priority="background")` (반환값 미사용이므로 할당 자체 제거 가능하나, 이후 `venue != "KRX" and not bars` 분기가 bars를 쓰므로 `bars = await ...` 유지)
- `_collect_for_venue.one` (기존 line 432): `bars, write_err = ...` → `bars = ...`; 직후 `if write_err is not None:` 블록(`cache_write_failed` warning) 삭제
- `_collect_for_venue` today 분기 (기존 line 495): `bars, _write_err = await kis_access.run_with_capacity(...)` → `bars = await ...`

- [ ] **Step 2: live 스위트 + 타입 확인**

Run: `uv run --extra dev pytest tests/unit/live/ -q`
Expected: 전부 PASS

- [ ] **Step 3: 커밋**

```bash
git add hoga/live/live_candle_backfill.py
git commit -m "refactor(live): memory-only 전환 후 도달 불가능한 write_err/cache_write_failed 배관 제거 (WS1)"
```
