# 오늘자 지표 short-TTL 캐시 (ADR-0043 보완, ADR-0090) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 오늘자(promote 중) 호가비·체결강도·peak-wall 계산 결과를 짧은 TTL(기본 15초) 동안 프로세스 내 재사용해, 관심종목 순차 전환·다중 클라이언트의 반복 재계산을 접는다.

**Architecture:** ADR-0043은 "오늘은 캐시하지 않는다"로 staleness를 없앴고, ADR-0085의 single-flight는 *동시* 중복만 접는다 — *순차* 반복(관심종목을 오가는 전환 버스트, 5분 refetch 주기가 어긋난 다중 클라이언트)은 매번 peak-wall 최악 4.3초/0.72GB를 다시 문다. 새 모듈 `TodayTtlCache`(monotonic clock 주입 가능, env `HOGA_TODAY_INDICATOR_TTL_MS`, 0이면 완전 비활성=ADR-0043 원 동작)를 bundle의 오늘 경로 3곳(quote_ratio·fill_strength·peak dual)에 끼운다. 과거일은 기존 `PastIndicatorsCache`가 이미 커버하므로 건드리지 않는다. **정책 변경이므로 ADR-0090을 먼저 쓴다.**

**Staleness 상한 논거:** /live의 오늘 범위 refetch는 5분 주기(`TODAY_RANGE_REFETCH_MS`, frontend/src/api/range.ts:37)다. 15초 TTL은 그 1/20로, 사용자 체감 최신성엔 영향이 없고 전환 버스트만 접는다.

**Tech Stack:** Python 3 / threading / pytest (`uv run --extra dev pytest`)

---

### Task 1: ADR-0090 작성

**Files:**
- Create: `docs/adr/0090-today-indicator-short-ttl-cache.md`

- [ ] **Step 1: ADR 작성**

```markdown
# 0090. 오늘자 지표 short-TTL 캐시 (ADR-0043 보완)

날짜: 2026-07-07
상태: 승인

## 맥락

ADR-0043은 오늘(promote 중) Stock-Date의 지표를 캐시하지 않는다 — 폴링 간 stale
데이터를 구조적으로 배제하기 위해서다. ADR-0085의 single-flight + 세마포어는 *동시*
중복 계산만 접는다. 남은 구멍은 *순차* 반복이다: 관심종목을 오가는 심볼 전환 버스트,
refetch 주기가 어긋난 다중 클라이언트가 같은 (code, 오늘) peak-wall(최악 4.3s/0.72GB)·
호가비·체결강도를 초 단위 간격으로 다시 계산시킨다.

## 결정

오늘자 지표 계산 결과에 프로세스 내 short-TTL 캐시(기본 15,000ms,
`HOGA_TODAY_INDICATOR_TTL_MS`, 0=비활성)를 둔다.

- 적용 지점: bundle의 오늘 경로 3곳 — build_quote_ratio_slice, build_fill_strength_slice,
  build_ask_bid_peak_slices(dual). 과거일은 PastIndicatorsCache 그대로.
- 키에 date가 포함되므로 자정 경계에서 자연 무효화된다. 만료 항목은 put 시 정리.
- staleness 상한 = TTL(15s) ≪ /live 오늘 refetch 주기(5분). ADR-0043의 목적(폴링이
  낡은 스냅샷에 갇히는 것 방지)은 유지된다 — 갇힘이 아니라 최대 15초 지연이다.

## 결과

- 전환 버스트에서 지표 재계산이 TTL당 1회로 접힌다.
- 새 운영 노브 1개(HOGA_TODAY_INDICATOR_TTL_MS). 0으로 내리면 원 동작 복귀.
- 캐시는 프로세스 로컬 — 멀티 워커 배포에서는 워커당 독립(허용).
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/0090-today-indicator-short-ttl-cache.md
git commit -m "docs(adr): 0090 오늘자 지표 short-TTL 캐시 (ADR-0043 보완)"
```

---

### Task 2: `TodayTtlCache` 모듈 (TDD)

**Files:**
- Create: `hoga/api/today_ttl_cache.py`
- Test: `tests/unit/api/test_today_ttl_cache.py`

- [ ] **Step 1: 실패하는 테스트 작성**

```python
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
```

- [ ] **Step 2: red 확인**

Run: `uv run --extra dev pytest tests/unit/api/test_today_ttl_cache.py -v`
Expected: FAIL — `ModuleNotFoundError: hoga.api.today_ttl_cache`

- [ ] **Step 3: 구현**

`hoga/api/today_ttl_cache.py`:

```python
"""오늘자(promote 중) 지표의 short-TTL 프로세스 캐시 (ADR-0090, ADR-0043 보완).

single-flight(peak_slice_guard)는 *동시* 중복만 접고 *순차* 반복(관심종목 전환
버스트, 어긋난 다중 클라이언트 폴링)은 못 접는다. 이 캐시는 TTL(기본 15s) 동안만
오늘자 계산 결과를 재사용한다 — /live의 오늘 범위 refetch 주기(5분)에 비해 무시할
staleness. TTL=0이면 완전 비활성(ADR-0043 원 동작). 키에 date가 들어가므로 자정
경계는 자연 무효화된다.
"""
from __future__ import annotations

import os
import threading
import time
from collections.abc import Callable, Hashable
from typing import Any

DEFAULT_TTL_MS = 15_000


def _resolve_ttl_ms() -> int:
    raw = os.environ.get("HOGA_TODAY_INDICATOR_TTL_MS")
    if raw is None:
        return DEFAULT_TTL_MS
    try:
        return max(0, int(raw))
    except ValueError:
        return DEFAULT_TTL_MS


class TodayTtlCache:
    """(hit, value) 튜플을 돌려주는 이유: peak 행처럼 값 자체가 None인 결과를
    캐시 미스와 구분해야 한다."""

    def __init__(
        self,
        ttl_ms: int | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._ttl_s = (ttl_ms if ttl_ms is not None else _resolve_ttl_ms()) / 1000.0
        self._clock = clock
        self._lock = threading.Lock()
        self._entries: dict[Hashable, tuple[float, Any]] = {}

    def lookup(self, key: Hashable) -> tuple[bool, Any]:
        if self._ttl_s <= 0:
            return (False, None)
        with self._lock:
            entry = self._entries.get(key)
            if entry is None or entry[0] < self._clock():
                return (False, None)
            return (True, entry[1])

    def put(self, key: Hashable, value: Any) -> None:
        if self._ttl_s <= 0:
            return
        now = self._clock()
        with self._lock:
            # 만료 정리 — 키는 (kind, code, 오늘) 스코프라 개수가 작고, put 빈도도
            # TTL당 1회 수준이라 선형 스캔으로 충분하다.
            expired = [k for k, (dl, _) in self._entries.items() if dl < now]
            for k in expired:
                del self._entries[k]
            self._entries[key] = (now + self._ttl_s, value)


# 프로세스 전역 인스턴스. 테스트 격리는 tests/conftest.py의 autouse 픽스처가
# 매 테스트 새 인스턴스로 갈아끼운다(교차 오염 방지 — 같은 code/date 픽스처 재사용).
TODAY_TTL = TodayTtlCache()
```

- [ ] **Step 4: green 확인**

Run: `uv run --extra dev pytest tests/unit/api/test_today_ttl_cache.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hoga/api/today_ttl_cache.py tests/unit/api/test_today_ttl_cache.py
git commit -m "feat(api): TodayTtlCache — 오늘자 지표 short-TTL 캐시 모듈 (ADR-0090)"
```

---

### Task 3: 테스트 교차 오염 방지 픽스처

**Files:**
- Modify: `tests/conftest.py`

- [ ] **Step 1: autouse 픽스처 추가**

테스트들은 같은 code("005930" 등)·date 픽스처를 재사용하므로, 전역 TODAY_TTL이 테스트 간에 살아남으면 앞 테스트의 결과가 뒤 테스트에 hit된다. `tests/conftest.py`에 추가 (기존 conftest 스코프 규약은 ADR-0089 참조 — 최상위 conftest에 두는 것이 맞다):

```python
@pytest.fixture(autouse=True)
def _fresh_today_ttl(monkeypatch):
    """ADR-0090 TodayTtlCache 테스트 간 격리 — 전역 인스턴스를 매 테스트 교체."""
    import hoga.api.bundle as bundle_mod
    from hoga.api.today_ttl_cache import TodayTtlCache

    fresh = TodayTtlCache()
    monkeypatch.setattr("hoga.api.today_ttl_cache.TODAY_TTL", fresh)
    # bundle이 `from ... import TODAY_TTL`로 바인딩하므로 그 참조도 갈아끼운다.
    if hasattr(bundle_mod, "TODAY_TTL"):
        monkeypatch.setattr(bundle_mod, "TODAY_TTL", fresh)
```

- [ ] **Step 2: 기존 스위트가 여전히 green인지 확인**

Run: `uv run --extra dev pytest tests/unit/api -q`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/conftest.py
git commit -m "test: TodayTtlCache 테스트 간 격리 autouse 픽스처"
```

---

### Task 4: bundle 오늘 경로 3곳 배선 (TDD)

**Files:**
- Modify: `hoga/api/bundle.py` — import 구역, `build_quote_ratio_slice`(:304-307 else 분기), `build_fill_strength_slice`(:569-574 else 분기), `build_ask_bid_peak_slices`(:874-884 GUARD.run 주변)
- Test: `tests/unit/api/test_today_ttl_integration.py`

- [ ] **Step 1: 실패하는 테스트 작성**

```python
"""오늘자 경로가 TTL 내 재호출에서 쿼리를 다시 치지 않음을 잠근다 (ADR-0090)."""
from unittest.mock import patch

import duckdb
import pytest

import hoga.api.bundle as bundle_mod


@pytest.fixture
def ratio_fixture(tmp_path):
    """snapshots.parquet 1개짜리 최소 engine.

    주의: 실제 스냅샷 컬럼명은 snapshots.py 상단의 _ASK_Q_SUM/_BID_Q_SUM 상수가
    참조하는 이름으로 맞출 것. 기존 tests/unit/api/test_range_indicator_cache_
    integration.py 에 동등한 픽스처 빌더가 이미 있으면 그것을 import 해 쓰고
    이 픽스처는 만들지 않는다.
    """
    code, date, source = "005930", "20260707", "kis_live"
    d = tmp_path / date / code / source
    d.mkdir(parents=True)
    con = duckdb.connect()
    cols = ", ".join(
        f"{q} AS ask_q{i}" if s == "a" else f"{q} AS bid_q{i}"
        for i in range(1, 11)
        for s, q in (("a", 100 + i), ("b", 200 + i))
    )
    con.execute(
        f"COPY (SELECT 90000000 AS ts_ms, {cols}) TO '{d / 'snapshots.parquet'}' (FORMAT PARQUET)"
    )

    class FakeEngine:
        conn = con

        def parquet_dir(self, dd, cc, ss):
            return tmp_path / dd / cc / ss

    return FakeEngine(), code, date, source


def test_today_ratio_second_call_within_ttl_skips_query(ratio_fixture):
    engine, code, date, source = ratio_fixture
    with patch.object(
        bundle_mod.snapshots_tbl, "query_bucketed_ratio",
        wraps=bundle_mod.snapshots_tbl.query_bucketed_ratio,
    ) as spy:
        kw = dict(code=code, date=date, source=source, bucket_ms=60_000,
                  cache=None, today_kst=date)  # date == today → 오늘 경로
        r1 = bundle_mod.build_quote_ratio_slice(engine, **kw)
        r2 = bundle_mod.build_quote_ratio_slice(engine, **kw)
    assert spy.call_count == 1
    assert r1 == r2


def test_past_day_does_not_use_ttl(ratio_fixture):
    engine, code, date, source = ratio_fixture
    with patch.object(
        bundle_mod.snapshots_tbl, "query_bucketed_ratio",
        wraps=bundle_mod.snapshots_tbl.query_bucketed_ratio,
    ) as spy:
        kw = dict(code=code, date=date, source=source, bucket_ms=1_000,  # sub-minute → 1m 캐시 불가
                  cache=None, today_kst="29991231")  # date < today → 과거 경로
        bundle_mod.build_quote_ratio_slice(engine, **kw)
        bundle_mod.build_quote_ratio_slice(engine, **kw)
    assert spy.call_count == 2  # 과거일은 TTL 미적용 (PastIndicatorsCache 관할)
```

peak dual과 fill_strength도 같은 모양으로 각 1케이스씩 추가한다(`query_day_ask_bid_peak_dual` / `_query_fill_rows` spy, today 2회 호출 → 1회 실행).

- [ ] **Step 2: red 확인**

Run: `uv run --extra dev pytest tests/unit/api/test_today_ttl_integration.py -v`
Expected: FAIL — `spy.call_count == 2`

- [ ] **Step 3: 배선 구현**

`hoga/api/bundle.py` import 구역에 추가:

```python
from hoga.api.today_ttl_cache import TODAY_TTL
```

`build_quote_ratio_slice`의 else 분기(:304-307)를 교체:

```python
    else:
        is_today = today_kst is not None and date == today_kst
        ttl_key = ("ratio", code, date, source, bucket_ms, session_close_ms)
        hit, cached = TODAY_TTL.lookup(ttl_key) if is_today else (False, None)
        if hit:
            rows = cached
        else:
            rows = snapshots_tbl.query_bucketed_ratio(
                engine.conn, path=path_obj, bucket_ms=bucket_ms, session_close_ms=session_close_ms
            )
            if is_today:
                TODAY_TTL.put(ttl_key, rows)
```

`build_fill_strength_slice`의 else 분기(:569-574)를 교체 — None(파일 부재)은 캐시하지 않는다(장 시작 직후 파일이 15초 내 생길 수 있음):

```python
    else:
        is_today = today_kst is not None and date == today_kst
        ttl_key = ("fill", code, date, source, bucket_ms)
        hit, cached = TODAY_TTL.lookup(ttl_key) if is_today else (False, None)
        if hit:
            rows = cached
        else:
            direct = _query_fill_rows(engine, code_dir, bucket_ms)
            if direct is None:
                # ADR-0043: neither fills nor trades parquet — valid "no trades" state.
                return FillStrength(bucket_ms=bucket_ms, points=[])
            rows = direct
            if is_today:
                TODAY_TTL.put(ttl_key, rows)
```

`build_ask_bid_peak_slices`의 GUARD.run(:874-884)을 감싼다:

```python
    is_today = today_kst is not None and date == today_kst
    ttl_key = ("peak_dual", code, date, source, bucket_ms, session_open_ms, session_close_ms)
    hit, cached_rows = TODAY_TTL.lookup(ttl_key) if is_today else (False, None)
    if hit:
        ask_row, bid_row = cached_rows
    else:
        ask_row, bid_row = PEAK_SLICE_GUARD.run(
            (code, date, source, bucket_ms),
            lambda: snapshots_tbl.query_day_ask_bid_peak_dual(
                engine.conn,
                path=path_obj,
                trades_path=trades_path,
                bucket_ms=bucket_ms,
                session_open_ms=session_open_ms,
                session_close_ms=session_close_ms,
            ),
        )
        if is_today:
            TODAY_TTL.put(ttl_key, (ask_row, bid_row))
```

- [ ] **Step 4: green + 회귀 확인**

Run: `uv run --extra dev pytest tests/unit/api/test_today_ttl_integration.py tests/unit/api/test_range_indicator_cache_integration.py tests/test_api_range.py tests/hoga/api/test_bundle.py -v`
Expected: PASS — 특히 기존 ADR-0043 계약 테스트("오늘 무캐시")가 있다면, TTL 픽스처(Task 3)가 매 테스트 새 인스턴스를 깔아도 **같은 테스트 안에서 2회 호출하며 재계산을 단언하는** 케이스는 red가 된다. 그 테스트는 ADR-0090 반영으로 기대값을 갱신한다(단언을 "TTL 내 1회"로).

- [ ] **Step 5: Commit**

```bash
git add hoga/api/bundle.py tests/unit/api/test_today_ttl_integration.py
git commit -m "feat(api): 오늘자 호가비·체결강도·peak-wall에 short-TTL 캐시 배선 (ADR-0090)"
```

---

### Task 5: 전체 회귀 + 문서

- [ ] **Step 1: 전체 백엔드 테스트**

Run: `uv run --extra dev pytest -q`
Expected: 신규 실패 0 (pre-existing 실패 목록과 비교)

- [ ] **Step 2: `.env.example`에 노브 문서화**

`.env.example` 말미에 추가:

```bash
# 오늘자 지표 short-TTL 캐시 (ms). 0 = 비활성(ADR-0043 원 동작). ADR-0090.
# HOGA_TODAY_INDICATOR_TTL_MS=15000
```

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs: HOGA_TODAY_INDICATOR_TTL_MS 노브 문서화"
```
