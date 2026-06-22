# Index Daily Candle Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make index D/W/M candles feel like stock daily candles by caching repeated scrollback ranges and by reducing the cold-fetch penalty of KIS index daily pagination.

**Architecture:** Keep the change scoped by adding an index-specific in-memory range cache rather than refactoring the stock daily cache first. The `/api/live/index-candles` handler will ask the cache for missing ranges, fetch only uncached gaps from KIS, append successful batches, and return a merged sorted response. Separately, index cold-load performance will be measured and optimized because `fetch_index_daily_candles` walks a KIS endpoint that returns at most 50 rows per request, so cache alone only fixes repeat loads.

**Tech Stack:** Python 3.14, FastAPI, pytest, existing `KisClient.fetch_index_daily_candles`, existing `LiveIndexCandlesResponse` wire shape.

## Global Constraints

- Use TDD: write failing tests before implementation.
- Do not change index minute candle behavior in this plan.
- Keep cache memory-only; process restart is cache invalidation.
- Preserve existing `/api/live/index-candles` response shape: `index_id`, `from`, `to`, `timeframe`, `candles`, `data_warnings`.
- Cache only successful candle rows. Do not cache KIS rate-limit or API-error failures.
- Cache key must include both `index_id` and `timeframe` because KIS serves D/W/M as separate periods.
- Treat repeat-load speed and first cold-load speed as separate acceptance criteria.
- Do not claim index cold fetch is fixed unless measured against a cache-miss stock daily baseline and an index daily baseline.

---

## File Structure

- Create `hoga/live/index_candles_cache.py`
  - Owns the index D/W/M memory range cache.
  - Provides a small async collector that mirrors the stock daily cache behavior without touching stock code.
- Create `hoga/live/index_cold_fetch.py`
  - Owns index cold-fetch range planning and bounded concurrent fetch orchestration for `D`; `W` and `M` keep a single KIS range.
  - Keeps KIS-specific 50-row pagination mitigation out of the API route.
- Modify `hoga/live/api.py`
  - Instantiates the index cache next to `daily_cache_instance`.
  - Routes D/W/M `/index-candles` through the cache collector.
- Create `tests/unit/live/test_index_candles_cache.py`
  - Unit tests for cache hit, gap fetch, key separation by timeframe.
- Create `tests/unit/live/test_index_cold_fetch.py`
  - Unit tests for cold range splitting, bounded concurrency, sorted de-duplication, and fallback to sequential fetch.
- Modify `tests/api/test_live_indices_routes.py`
  - API tests proving second broader D request only fetches missing older range and does not re-fetch already cached rows.
- Create `scripts/measure_index_daily_cold_fetch.mjs`
  - Local-only measurement script comparing cache-miss stock daily fetches with index daily fetches.
  - Produces timing JSON that can be pasted into the PR description.

---

### Task 1: Add Cold Fetch Baseline Measurement

**Files:**
- Create: `scripts/measure_index_daily_cold_fetch.mjs`

**Interfaces:**
- Consumes: running backend at `http://127.0.0.1:8000`
- Produces: reproducible timing output for stock cache-miss daily requests and index daily requests

- [ ] **Step 1: Create the measurement script**

Create `scripts/measure_index_daily_cold_fetch.mjs`:

```javascript
const BASE = process.env.HOGA_API_BASE ?? 'http://127.0.0.1:8000';
const FROM = process.env.HOGA_FROM ?? '20240101';
const TO = process.env.HOGA_TO ?? '20260622';

const STOCKS = (process.env.HOGA_STOCKS ?? '373220,207940,105560,012330,066570')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const INDICES = (process.env.HOGA_INDICES ?? 'KOSPI200,KOSPI,KOSDAQ')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

async function measure(name, url) {
  const t0 = performance.now();
  const res = await fetch(url, { cache: 'no-store' });
  const text = await res.text();
  const ms = Math.round(performance.now() - t0);
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { parse_error: text.slice(0, 160) };
  }
  return {
    name,
    status: res.status,
    ms,
    candles: Array.isArray(body.candles) ? body.candles.length : null,
    cached_batches: Array.isArray(body.cached_batches) ? body.cached_batches.length : null,
    fresh_batches: Array.isArray(body.fresh_batches) ? body.fresh_batches.length : null,
    warnings: Array.isArray(body.data_warnings) ? body.data_warnings.length : null,
  };
}

const rows = [];
for (const code of STOCKS) {
  rows.push(await measure(
    `stock:${code}`,
    `${BASE}/api/live/past-daily-candles?code=${code}&from=${FROM}&to=${TO}&venue=KRX`,
  ));
}
for (const indexId of INDICES) {
  rows.push(await measure(
    `index:${indexId}`,
    `${BASE}/api/live/index-candles?index_id=${indexId}&timeframe=D&from=${FROM}&to=${TO}`,
  ));
}

console.table(rows);
console.log(JSON.stringify({ from: FROM, to: TO, rows }, null, 2));
```

- [ ] **Step 2: Run the baseline against the current branch**

Run:

```bash
node scripts/measure_index_daily_cold_fetch.mjs
```

Expected: stock rows with `fresh_batches=1` should be treated as cache-miss baselines. Index rows have `cached_batches=null` and should show the current cold penalty, commonly around 1.8-2x slower for 600 D candles.

- [ ] **Step 3: Save the baseline numbers in the PR notes**

Copy the JSON output into the PR body under:

```markdown
## Performance Baseline

- Stock cold daily cache-miss samples:
- Index cold daily samples:
- Repeat index daily samples before cache:
```

Do not commit generated timing output.

---

### Task 2: Add Index Cold Fetch Planner

**Files:**
- Create: `hoga/live/index_cold_fetch.py`
- Create: `tests/unit/live/test_index_cold_fetch.py`

**Interfaces:**
- Consumes: `KisClient.fetch_index_daily_candles`-compatible async fetch function
- Produces:
  - `plan_index_cold_fetch_ranges(from_s: str, to_s: str, period: str) -> list[tuple[str, str]]`
  - `fetch_index_daily_candles_windowed(from_s, to_s, period, fetch_batch, max_concurrency=3) -> IndexCandleFetchResult`

- [ ] **Step 1: Write failing planner and orchestration tests**

Create `tests/unit/live/test_index_cold_fetch.py`:

```python
from __future__ import annotations

import asyncio

import pytest

from hoga.live.index_cold_fetch import (
    fetch_index_daily_candles_windowed,
    plan_index_cold_fetch_ranges,
)
from hoga.live.kis_client import IndexCandleFetchResult
from hoga.live.kis_models import IndexCandlePoint


def point(t_ms: int, close: float) -> IndexCandlePoint:
    return IndexCandlePoint(t_ms=t_ms, open=close, high=close, low=close, close=close, volume=1)


def test_daily_planner_splits_long_cold_range_into_quarters() -> None:
    assert plan_index_cold_fetch_ranges("20240101", "20241231", "D") == [
        ("20240101", "20240331"),
        ("20240401", "20240630"),
        ("20240701", "20240930"),
        ("20241001", "20241231"),
    ]


def test_weekly_and_monthly_use_single_range() -> None:
    assert plan_index_cold_fetch_ranges("20240101", "20241231", "W") == [("20240101", "20241231")]
    assert plan_index_cold_fetch_ranges("20240101", "20241231", "M") == [("20240101", "20241231")]


@pytest.mark.asyncio
async def test_windowed_fetch_runs_daily_ranges_with_bounded_concurrency_and_sorts_unique_rows() -> None:
    active = 0
    max_active = 0
    calls: list[tuple[str, str]] = []

    async def fetch_batch(from_s: str, to_s: str) -> IndexCandleFetchResult:
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        calls.append((from_s, to_s))
        await asyncio.sleep(0)
        active -= 1
        close = float(len(calls))
        return IndexCandleFetchResult(candles=[point(len(calls), close), point(1, 99.0)])

    result = await fetch_index_daily_candles_windowed(
        "20240101",
        "20241231",
        "D",
        fetch_batch,
        max_concurrency=2,
    )

    assert calls == [
        ("20240101", "20240331"),
        ("20240401", "20240630"),
        ("20240701", "20240930"),
        ("20241001", "20241231"),
    ]
    assert max_active == 2
    assert [c.t_ms for c in result.candles] == [1, 2, 3, 4]
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
uv run pytest tests/unit/live/test_index_cold_fetch.py -q
```

Expected: fail with `ModuleNotFoundError: No module named 'hoga.live.index_cold_fetch'`.

- [ ] **Step 3: Implement the planner and bounded concurrent fetcher**

Create `hoga/live/index_cold_fetch.py`:

```python
from __future__ import annotations

import asyncio
from calendar import monthrange
from datetime import date
from typing import Awaitable, Callable

from hoga.live.kis_client import IndexCandleFetchResult


def _parse(s: str) -> date:
    return date(int(s[:4]), int(s[4:6]), int(s[6:8]))


def _fmt(d: date) -> str:
    return d.strftime("%Y%m%d")


def _add_months(d: date, months: int) -> date:
    month0 = d.month - 1 + months
    year = d.year + month0 // 12
    month = month0 % 12 + 1
    day = min(d.day, monthrange(year, month)[1])
    return date(year, month, day)


def plan_index_cold_fetch_ranges(from_s: str, to_s: str, period: str) -> list[tuple[str, str]]:
    if period != "D":
        return [(from_s, to_s)]
    start = _parse(from_s)
    end = _parse(to_s)
    ranges: list[tuple[str, str]] = []
    cursor = start
    while cursor <= end:
        next_cursor = _add_months(cursor, 3)
        chunk_end = min(end, next_cursor.replace(day=1) - date.resolution)
        ranges.append((_fmt(cursor), _fmt(chunk_end)))
        cursor = chunk_end + date.resolution
    return ranges


async def fetch_index_daily_candles_windowed(
    from_s: str,
    to_s: str,
    period: str,
    fetch_batch: Callable[[str, str], Awaitable[IndexCandleFetchResult]],
    *,
    max_concurrency: int = 3,
) -> IndexCandleFetchResult:
    ranges = plan_index_cold_fetch_ranges(from_s, to_s, period)
    if len(ranges) == 1:
        return await fetch_batch(*ranges[0])

    sem = asyncio.Semaphore(max_concurrency)

    async def one(pair: tuple[str, str]) -> IndexCandleFetchResult:
        async with sem:
            return await fetch_batch(*pair)

    results = await asyncio.gather(*(one(pair) for pair in ranges))
    by_t_ms = {}
    violations = []
    for result in results:
        violations.extend(result.violations)
        for candle in result.candles:
            by_t_ms[candle.t_ms] = candle
    return IndexCandleFetchResult(
        candles=sorted(by_t_ms.values(), key=lambda c: c.t_ms),
        violations=violations,
    )
```

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
uv run pytest tests/unit/live/test_index_cold_fetch.py -q
```

Expected: `3 passed`.

- [ ] **Step 5: Commit**

```bash
git add hoga/live/index_cold_fetch.py tests/unit/live/test_index_cold_fetch.py
git commit -m "feat: plan bounded index cold fetch ranges"
```

---

### Task 3: Add Index Range Cache Unit

**Files:**
- Create: `hoga/live/index_candles_cache.py`
- Create: `tests/unit/live/test_index_candles_cache.py`

**Interfaces:**
- Consumes: `hoga.live.kis_models.IndexCandlePoint`, `hoga.live.kis_client.IndexCandleFetchResult`, `DailyInvariantViolation`
- Produces:
  - `IndexCandlesCache`
  - `IndexCandleCacheHit`
  - `collect_index_candles_with_cache(cache, key, from_s, to_s, fetch_batch)`

- [ ] **Step 1: Write the failing cache hit/miss tests**

Add `tests/unit/live/test_index_candles_cache.py`:

```python
from __future__ import annotations

from datetime import date

import pytest

from hoga.live.index_candles_cache import (
    IndexCandleCacheHit,
    IndexCandlesCache,
    collect_index_candles_with_cache,
)
from hoga.live.kis_client import IndexCandleFetchResult
from hoga.live.kis_models import IndexCandlePoint


def point(day: str, close: float = 1.0) -> IndexCandlePoint:
    return IndexCandlePoint(
        t_ms=0,
        open=close,
        high=close,
        low=close,
        close=close,
        volume=100,
    )


def test_cache_returns_exact_covered_range_without_fetching() -> None:
    cache = IndexCandlesCache()
    cache.append_batch(("KOSDAQ", "D"), date(2026, 1, 1), date(2026, 1, 31), [point("20260102")])

    hit = cache.covered(("KOSDAQ", "D"), date(2026, 1, 10), date(2026, 1, 20))

    assert hit == IndexCandleCacheHit(candles=[point("20260102")])


@pytest.mark.asyncio
async def test_collector_fetches_only_missing_left_gap_and_merges_cached_rows() -> None:
    cache = IndexCandlesCache()
    cache.append_batch(("KOSDAQ", "D"), date(2026, 1, 1), date(2026, 1, 31), [point("20260115", 15)])
    calls: list[tuple[str, str]] = []

    async def fetch_batch(from_s: str, to_s: str) -> IndexCandleFetchResult:
        calls.append((from_s, to_s))
        return IndexCandleFetchResult(candles=[point("20251215", 12)])

    result = await collect_index_candles_with_cache(
        cache,
        ("KOSDAQ", "D"),
        "20251201",
        "20260131",
        fetch_batch,
    )

    assert calls == [("20251201", "20251231")]
    assert [c.close for c in result.candles] == [12, 15]
    assert result.violations == []


@pytest.mark.asyncio
async def test_cache_key_separates_timeframes() -> None:
    cache = IndexCandlesCache()
    cache.append_batch(("KOSDAQ", "D"), date(2026, 1, 1), date(2026, 1, 31), [point("20260115", 15)])
    calls: list[tuple[str, str]] = []

    async def fetch_batch(from_s: str, to_s: str) -> IndexCandleFetchResult:
        calls.append((from_s, to_s))
        return IndexCandleFetchResult(candles=[point("20260120", 20)])

    result = await collect_index_candles_with_cache(
        cache,
        ("KOSDAQ", "W"),
        "20260101",
        "20260131",
        fetch_batch,
    )

    assert calls == [("20260101", "20260131")]
    assert [c.close for c in result.candles] == [20]
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
uv run pytest tests/unit/live/test_index_candles_cache.py -q
```

Expected: fail with `ModuleNotFoundError: No module named 'hoga.live.index_candles_cache'`.

- [ ] **Step 3: Implement the cache unit**

Create `hoga/live/index_candles_cache.py`:

```python
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Awaitable, Callable, TypeAlias

from hoga.live.kis_client import IndexCandleFetchResult
from hoga.live.kis_models import IndexCandlePoint

IndexCandleCacheKey: TypeAlias = tuple[str, str]


@dataclass(frozen=True)
class IndexCandleCacheHit:
    candles: list[IndexCandlePoint]


class IndexCandlesCache:
    def __init__(self) -> None:
        self._per_key: dict[IndexCandleCacheKey, list[tuple[date, date, list[IndexCandlePoint]]]] = {}

    def append_batch(
        self,
        key: IndexCandleCacheKey,
        frm: date,
        to: date,
        candles: list[IndexCandlePoint],
    ) -> None:
        self._per_key.setdefault(key, []).append((frm, to, list(candles)))

    def list_batches(self, key: IndexCandleCacheKey) -> list[tuple[date, date, list[IndexCandlePoint]]]:
        return list(self._per_key.get(key, []))

    def covered(self, key: IndexCandleCacheKey, frm: date, to: date) -> IndexCandleCacheHit | None:
        batches = self._per_key.get(key, [])
        if not batches:
            return None
        covered_start: date | None = None
        covered_end: date | None = None
        candles: list[IndexCandlePoint] = []
        for batch_from, batch_to, batch_candles in sorted(batches, key=lambda b: b[0]):
            if batch_to < frm or batch_from > to:
                continue
            if covered_start is None:
                covered_start = batch_from
                covered_end = batch_to
            elif covered_end is not None and batch_from <= covered_end + timedelta(days=1):
                covered_end = max(covered_end, batch_to)
            else:
                return None
            candles.extend(batch_candles)
        if covered_start is not None and covered_end is not None and covered_start <= frm and covered_end >= to:
            return IndexCandleCacheHit(candles=sorted(candles, key=lambda c: c.t_ms))
        return None


def _parse_yyyymmdd(s: str) -> date:
    return date(int(s[:4]), int(s[4:6]), int(s[6:8]))


def _fmt(d: date) -> str:
    return d.strftime("%Y%m%d")


async def collect_index_candles_with_cache(
    cache: IndexCandlesCache,
    key: IndexCandleCacheKey,
    from_s: str,
    to_s: str,
    fetch_batch: Callable[[str, str], Awaitable[IndexCandleFetchResult]],
) -> IndexCandleFetchResult:
    frm = _parse_yyyymmdd(from_s)
    to = _parse_yyyymmdd(to_s)
    hit = cache.covered(key, frm, to)
    if hit is not None:
        return IndexCandleFetchResult(candles=hit.candles, violations=[])

    existing = cache.list_batches(key)
    fetch_ranges: list[tuple[date, date]] = []
    if existing:
        earliest = min(batch_from for batch_from, _, _ in existing)
        latest = max(batch_to for _, batch_to, _ in existing)
        if frm < earliest:
            fetch_ranges.append((frm, earliest - timedelta(days=1)))
        if latest < to:
            fetch_ranges.append((latest + timedelta(days=1), to))
    else:
        fetch_ranges.append((frm, to))

    violations = []
    for fetch_from, fetch_to in fetch_ranges:
        if fetch_from > fetch_to:
            continue
        result = await fetch_batch(_fmt(fetch_from), _fmt(fetch_to))
        violations.extend(result.violations)
        cache.append_batch(key, fetch_from, fetch_to, result.candles)

    final_hit = cache.covered(key, frm, to)
    candles = final_hit.candles if final_hit is not None else []
    return IndexCandleFetchResult(candles=candles, violations=violations)
```

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
uv run pytest tests/unit/live/test_index_candles_cache.py -q
```

Expected: `3 passed`.

- [ ] **Step 5: Commit**

```bash
git add hoga/live/index_candles_cache.py tests/unit/live/test_index_candles_cache.py
git commit -m "feat: add index candle range cache"
```

---

### Task 4: Wire Cold Fetch And Cache Into `/api/live/index-candles`

**Files:**
- Modify: `hoga/live/api.py`
- Modify: `tests/api/test_live_indices_routes.py`

**Interfaces:**
- Consumes: `IndexCandlesCache`, `collect_index_candles_with_cache`
- Consumes: `fetch_index_daily_candles_windowed`
- Produces: `/api/live/index-candles` D/W/M responses that use windowed cold fetches for D and reuse cached ranges

- [ ] **Step 1: Write failing API cache test**

Append to `tests/api/test_live_indices_routes.py`:

```python
@pytest.mark.anyio
async def test_index_daily_candles_reuses_cached_newer_range_for_broader_scrollback(monkeypatch, tmp_path):
    from hoga.live import api as live_api
    from hoga.live.kis_client import IndexCandleFetchResult
    from hoga.live.kis_models import IndexCandlePoint

    calls: list[tuple[str, str]] = []

    class FakeKis:
        async def fetch_index_daily_candles(self, index, from_s, to_s, *, period="D", foreground=False):
            calls.append((from_s, to_s))
            close = float(len(calls))
            return IndexCandleFetchResult(candles=[
                IndexCandlePoint(t_ms=len(calls), open=close, high=close, low=close, close=close, volume=1),
            ])

    async def no_windowing(from_s, to_s, period, fetch_batch, *, max_concurrency=3):
        return await fetch_batch(from_s, to_s)

    monkeypatch.setattr(live_api.kis_access, "kis_for_role", lambda role, data_dir: FakeKis())
    monkeypatch.setattr(live_api, "fetch_index_daily_candles_windowed", no_windowing)
    monkeypatch.setattr(live_api, "index_candles_cache_instance", None)
    app = FastAPI()
    app.include_router(live_api.build_router(lambda: _status(), data_dir=tmp_path))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r1 = await ac.get("/api/live/index-candles?index_id=KOSDAQ&timeframe=D&from=20250101&to=20251231")
        assert r1.status_code == 200
        r2 = await ac.get("/api/live/index-candles?index_id=KOSDAQ&timeframe=D&from=20240101&to=20251231")
        assert r2.status_code == 200

    assert calls == [
        ("20250101", "20251231"),
        ("20240101", "20241231"),
    ]
    assert [c["close"] for c in r2.json()["candles"]] == [2.0, 1.0]
```

This test deliberately monkeypatches `fetch_index_daily_candles_windowed` to a pass-through helper so it isolates cache range behavior. Window splitting is covered by `tests/unit/live/test_index_cold_fetch.py`.

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
uv run pytest tests/api/test_live_indices_routes.py -q -k "reuses_cached_newer_range"
```

Expected: fail because calls are `[("20250101", "20251231"), ("20240101", "20251231")]`.

- [ ] **Step 3: Wire cold fetch and cache in `hoga/live/api.py`**

Add imports near existing live cache imports:

```python
from hoga.live.index_candles_cache import IndexCandlesCache, collect_index_candles_with_cache
from hoga.live.index_cold_fetch import fetch_index_daily_candles_windowed
```

Add module-level cache next to `daily_cache_instance`:

```python
index_candles_cache_instance: IndexCandlesCache | None = None
```

Inside `build_router`, initialize it once:

```python
    global index_candles_cache_instance
    if data_dir is not None and index_candles_cache_instance is None:
        index_candles_cache_instance = IndexCandlesCache()
```

Change the D/W/M branch in `_get_index_candles`:

```python
        if timeframe in {"D", "W", "M"}:
            if index_candles_cache_instance is None:
                raise HTTPException(503, "index-candles cache not wired (data_dir missing)")

            async def fetch_batch(from_s: str, to_s: str) -> IndexCandleFetchResult:
                async def direct_fetch(inner_from_s: str, inner_to_s: str) -> IndexCandleFetchResult:
                    return await kis.fetch_index_daily_candles(
                        index,
                        inner_from_s,
                        inner_to_s,
                        period=timeframe,
                        foreground=True,
                    )

                return await fetch_index_daily_candles_windowed(
                    from_s,
                    to_s,
                    timeframe,
                    direct_fetch,
                )

            result = await collect_index_candles_with_cache(
                index_candles_cache_instance,
                (index.id, timeframe),
                from_,
                to,
                fetch_batch,
            )
```

Keep the existing minute branch unchanged.

- [ ] **Step 4: Run API test to verify GREEN**

Run:

```bash
uv run pytest tests/api/test_live_indices_routes.py -q -k "reuses_cached_newer_range"
```

Expected: `1 passed`.

- [ ] **Step 5: Run full index API tests**

Run:

```bash
uv run pytest tests/api/test_live_indices_routes.py tests/unit/live/test_index_candles_cache.py tests/unit/live/test_index_cold_fetch.py -q
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add hoga/live/api.py tests/api/test_live_indices_routes.py
git commit -m "feat: cache and window index daily candles"
```

---

### Task 5: Measure Cold Fetch Improvement And Guard Existing Paths

**Files:**
- No production files expected.

**Interfaces:**
- Consumes: `/api/live/index-candles` cache and cold windowing behavior from Task 4
- Produces: verification evidence that stock routes still work, index repeat loads are cached, and index cold loads improved or have documented KIS limits

- [ ] **Step 1: Run backend regression tests**

Run:

```bash
uv run pytest tests/unit/live/test_kis_client.py tests/unit/live/test_kis_index_parsers.py tests/api/test_live_indices_routes.py tests/unit/live/test_index_candles_cache.py tests/unit/live/test_index_cold_fetch.py -q
```

Expected: all tests pass.

- [ ] **Step 2: Run frontend regression tests**

Run:

```bash
cd frontend
npx vitest run src/live/liveDateTime.test.ts src/live/LiveChartRoot.test.tsx src/live/LivePage.test.tsx src/live/LiveSidebar.test.tsx src/api/liveIndices.test.tsx
```

Expected: all tests pass.

- [ ] **Step 3: Run typecheck**

Run:

```bash
cd frontend
npx tsc -b --pretty false
```

Expected: exit code `0`.

- [ ] **Step 4: Measure cold fetch before/after behavior**

Run:

```bash
node scripts/measure_index_daily_cold_fetch.mjs
```

Expected after Task 4:

```text
stock cold cache-miss D samples still return 600 candles
index cold D samples still return 600 candles
index repeat D requests hit the new cache and avoid KIS re-walk
index cold D median is lower than the baseline, or the PR documents that KIS foreground rate limiting erased the concurrency benefit
```

If index cold D gets slower, set `max_concurrency=1` in the API wiring and keep only the cache improvement.

- [ ] **Step 5: Manual localhost verification**

Start or reuse servers:

```bash
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga
cd frontend && npm run dev -- --host 127.0.0.1
```

Open `http://localhost:5173/live`, select `KOSDAQ`, switch to `일`, and pan left twice.

Expected backend requests after first load:

```text
GET /api/live/index-candles?index_id=KOSDAQ&timeframe=D&from=<initial>&to=<today>
GET /api/live/index-candles?index_id=KOSDAQ&timeframe=D&from=<older>&to=<today>
```

Expected KIS calls internally:

```text
initial full range
for D: bounded quarter windows on cold initial range
only the missing older range on second broader request
```

- [ ] **Step 6: Commit verification-only updates if any**

If no files changed, do not commit.

If test-only snapshots or docs changed:

```bash
git add <changed-files>
git commit -m "test: verify index candle cache"
```

---

## Self-Review

**Spec coverage:** The plan covers index D/W/M range caching, API wiring, TDD, cold cache-miss measurement, cold index daily fetch optimization, and manual speed verification. It intentionally excludes index minute caching because minute behavior has a different KIS source and pagination profile.

**Placeholder scan:** No `TBD`, `TODO`, or undefined implementation steps remain.

**Type consistency:** `IndexCandleCacheKey`, `IndexCandlesCache`, `IndexCandleCacheHit`, and `collect_index_candles_with_cache` are defined before use and referenced consistently.
