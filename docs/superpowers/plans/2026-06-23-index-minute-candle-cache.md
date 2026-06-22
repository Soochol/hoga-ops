# Index Minute Candle Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make index minute candles repeatable and scrollback-friendly by first measuring KIS index minute fetch depth, then adding a cache only for ranges the API can actually serve.

**Architecture:** Do not copy the stock minute cache blindly. Stock minute candles are date-addressable through `/past-candles`; index minute candles currently call KIS `inquire-time-indexchartprice` without sending `from/to` as upstream parameters, then locally filter returned rows. The plan therefore separates fetch-depth characterization from caching: cache helps repeated requests, but it cannot create older candles if KIS only returns the latest page for a given unit.

**Tech Stack:** Python 3.14, FastAPI, pytest, Node 20+ measurement script, existing `KisClient.fetch_index_minute_candles`, existing `/api/live/index-candles` response shape.

## Global Constraints

- Use TDD: write failing tests before implementation.
- Preserve existing `/api/live/index-candles` response shape: `index_id`, `from`, `to`, `timeframe`, `candles`, `data_warnings`.
- Cache exact repeated index minute requests only; do not claim the cache can synthesize older rows that KIS did not return.
- Cache key must include `index_id`, display `timeframe`, and `bucket_seconds`; source-unit selection is owned by `KisClient.fetch_index_minute_candles`.
- Treat “repeat request faster” and “older scrollback produces more candles” as separate acceptance criteria.
- Do not cache malformed rows or KIS API/rate-limit failures.

---

## Current Findings

Local API measurements against `http://127.0.0.1:8000` showed:

```text
KOSPI 1m today: 100 candles, all 20260622
KOSPI 1m wide 20260601..20260622: 100 candles, all 20260622
KOSPI 10m today: 40 candles, all 20260622, plus out_of_range warnings for older returned rows
KOSPI 10m wide 20260601..20260622: 96 candles across 20260618, 20260619, 20260622
```

Implication:

- Index 1m currently looks like a latest-page endpoint. A cache would make repeat calls faster but would still return only the latest 100 rows.
- Index 10m can include multiple recent trading days from the latest server-side 10m source, so caching can help repeat loads and may help limited scrollback.
- The warning stream is noisy because rows outside the requested range are reported as `invariant_violation`; range-filtered non-selected rows should not be treated like data-quality errors for minute endpoints.

---

## File Structure

- Create `scripts/measure_index_minute_fetch_depth.mjs`
  - Measures candle counts, date distribution, warning reasons, and repeat timings for 1m/3m/5m/10m/15m/30m index requests.
- Modify `hoga/live/kis_client.py`
  - Optionally adjust index minute warning behavior so out-of-request-range rows are silently filtered for minute endpoints.
  - Optionally expose metadata needed to determine source coverage, without changing API response shape unless a later task proves it is needed.
- Create `hoga/live/index_minute_candles_cache.py`
  - Owns memory-only index minute cache for served ranges.
- Modify `hoga/live/api.py`
  - Routes index minute candles through exact-request cache hits for repeated `(index_id, timeframe, bucket_seconds, from, to)` requests.
- Create `tests/unit/live/test_index_minute_candles_cache.py`
  - Unit tests for cache hit, range miss, timeframe/source-unit separation, and no-cache-on-partial-coverage.
- Modify `tests/unit/live/test_kis_client.py`
  - Tests that out-of-range index minute rows are filtered without user-facing invariant warnings if that change is implemented.
- Modify `tests/api/test_live_indices_routes.py`
  - API tests proving identical index minute requests hit cache and broader unsupported ranges do not falsely claim coverage.

---

### Task 1: Measure Index Minute Fetch Depth

**Files:**
- Create: `scripts/measure_index_minute_fetch_depth.mjs`

**Interfaces:**
- Consumes: running backend at `http://127.0.0.1:8000`
- Produces: reproducible timing and date-distribution output for index minute timeframes

- [ ] **Step 1: Create the measurement script**

Create `scripts/measure_index_minute_fetch_depth.mjs`:

```javascript
const BASE = process.env.HOGA_API_BASE ?? 'http://127.0.0.1:8000';
const INDEX = process.env.HOGA_INDEX ?? 'KOSPI';
const TO = process.env.HOGA_TO ?? '20260622';
const FROM = process.env.HOGA_FROM ?? '20260601';
const TIMEFRAMES = (process.env.HOGA_TIMEFRAMES ?? '1m,3m,5m,10m,15m,30m')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const kstParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function kstDay(tsMs) {
  const parts = kstParts.formatToParts(new Date(tsMs));
  return [
    parts.find((p) => p.type === 'year').value,
    parts.find((p) => p.type === 'month').value,
    parts.find((p) => p.type === 'day').value,
  ].join('');
}

async function measure(name, timeframe, from, to) {
  const url = `${BASE}/api/live/index-candles?index_id=${INDEX}&timeframe=${timeframe}&from=${from}&to=${to}`;
  const t0 = performance.now();
  const res = await fetch(url, { cache: 'no-store' });
  const body = await res.json();
  const candles = Array.isArray(body.candles) ? body.candles : [];
  const byDay = {};
  for (const candle of candles) byDay[kstDay(candle.t_ms)] = (byDay[kstDay(candle.t_ms)] ?? 0) + 1;
  const reasons = {};
  for (const warning of body.data_warnings ?? []) reasons[warning.msg] = (reasons[warning.msg] ?? 0) + 1;
  return {
    name,
    timeframe,
    status: res.status,
    ms: Math.round(performance.now() - t0),
    candles: candles.length,
    days: byDay,
    warning_count: body.data_warnings?.length ?? 0,
    warning_samples: (body.data_warnings ?? []).slice(0, 5),
  };
}

const rows = [];
for (const timeframe of TIMEFRAMES) {
  rows.push(await measure(`${timeframe}:today:1`, timeframe, TO, TO));
  rows.push(await measure(`${timeframe}:today:2`, timeframe, TO, TO));
  rows.push(await measure(`${timeframe}:wide`, timeframe, FROM, TO));
}

console.log(JSON.stringify({ index: INDEX, from: FROM, to: TO, rows }, null, 2));
console.table(rows.map((row) => ({
  name: row.name,
  ms: row.ms,
  candles: row.candles,
  days: Object.keys(row.days).join(','),
  warning_count: row.warning_count,
})));
```

- [ ] **Step 2: Run measurement**

Run:

```bash
node scripts/measure_index_minute_fetch_depth.mjs
```

Expected: output shows whether each timeframe can return older dates before any cache is added. If `1m:wide` still returns only `TO`, do not promise 1m scrollback from caching.

- [ ] **Step 3: Record the decision**

Add the measured table to the PR notes under:

```markdown
## Index Minute Fetch Depth

- 1m:
- 3m:
- 5m:
- 10m:
- 15m:
- 30m:
```

Do not commit generated timing output.

---

### Task 2: Quiet Expected Out-Of-Range Minute Rows

**Files:**
- Modify: `hoga/live/kis_client.py`
- Modify: `tests/unit/live/test_kis_client.py`

**Interfaces:**
- Consumes: existing `fetch_index_minute_candles`
- Produces: index minute fetches that silently filter rows outside requested date range instead of surfacing them as invariant warnings

- [ ] **Step 1: Write failing test**

Append to `tests/unit/live/test_kis_client.py`:

```python
@pytest.mark.asyncio
async def test_fetch_index_minute_candles_filters_out_of_range_rows_without_warning() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "rt_cd": "0",
                "msg_cd": "0",
                "msg1": "OK",
                "output2": [
                    {
                        "stck_bsop_date": "20260619",
                        "stck_cntg_hour": "093000",
                        "bstp_nmix_oprc": "2850.10",
                        "bstp_nmix_hgpr": "2852.34",
                        "bstp_nmix_lwpr": "2849.87",
                        "bstp_nmix_prpr": "2851.67",
                        "cntg_vol": "123456",
                    },
                    {
                        "stck_bsop_date": "20260622",
                        "stck_cntg_hour": "093000",
                        "bstp_nmix_oprc": "2860.10",
                        "bstp_nmix_hgpr": "2862.34",
                        "bstp_nmix_lwpr": "2859.87",
                        "bstp_nmix_prpr": "2861.67",
                        "cntg_vol": "123456",
                    },
                ],
            },
        )

    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    try:
        result = await client.fetch_index_minute_candles(
            get_representative_index("KOSPI"),
            "20260622",
            "20260622",
            bucket_seconds=600,
            foreground=True,
        )
    finally:
        await client.aclose()

    assert [c.close for c in result.candles] == [2861.67]
    assert result.violations == []
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
uv run pytest tests/unit/live/test_kis_client.py -q -k "filters_out_of_range_rows_without_warning"
```

Expected: fail because current code appends an `out_of_range` violation.

- [ ] **Step 3: Implement minimal filter change**

In `hoga/live/kis_client.py`, change the out-of-range block inside `fetch_index_minute_candles`:

```python
            if date_str < from_yyyymmdd or date_str > to_yyyymmdd:
                continue
```

Do not change daily index behavior; only the minute endpoint has this latest-page filtering characteristic.

- [ ] **Step 4: Run test to verify GREEN**

Run:

```bash
uv run pytest tests/unit/live/test_kis_client.py -q -k "index_minute"
```

Expected: all index minute tests pass.

---

### Task 3: Add Memory Cache For Coverable Index Minute Ranges

**Files:**
- Create: `hoga/live/index_minute_candles_cache.py`
- Create: `tests/unit/live/test_index_minute_candles_cache.py`

**Interfaces:**
- Produces:
  - `IndexMinuteCandlesCache`
  - `IndexMinuteCacheKey = tuple[str, str, int]`
  - `collect_index_minute_candles_with_cache(cache, key, from_s, to_s, fetch_batch)`

- [ ] **Step 1: Write failing cache tests**

Create `tests/unit/live/test_index_minute_candles_cache.py`:

```python
from __future__ import annotations

from datetime import date

import pytest

from hoga.live.index_minute_candles_cache import (
    IndexMinuteCandlesCache,
    collect_index_minute_candles_with_cache,
)
from hoga.live.kis_client import IndexCandleFetchResult
from hoga.live.kis_models import IndexCandlePoint


def point(t_ms: int, close: float) -> IndexCandlePoint:
    return IndexCandlePoint(t_ms=t_ms, open=close, high=close, low=close, close=close, volume=1)


@pytest.mark.asyncio
async def test_repeated_exact_minute_request_uses_cache() -> None:
    cache = IndexMinuteCandlesCache()
    calls: list[tuple[str, str]] = []

    async def fetch_batch(from_s: str, to_s: str) -> IndexCandleFetchResult:
        calls.append((from_s, to_s))
        return IndexCandleFetchResult(candles=[point(1, 1.0)])

    first = await collect_index_minute_candles_with_cache(cache, ("KOSPI", "1m", 60), "20260622", "20260622", fetch_batch)
    second = await collect_index_minute_candles_with_cache(cache, ("KOSPI", "1m", 60), "20260622", "20260622", fetch_batch)

    assert [c.close for c in first.candles] == [1.0]
    assert [c.close for c in second.candles] == [1.0]
    assert calls == [("20260622", "20260622")]


@pytest.mark.asyncio
async def test_broader_range_does_not_claim_cache_hit_when_cached_rows_do_not_cover_it() -> None:
    cache = IndexMinuteCandlesCache()
    calls: list[tuple[str, str]] = []

    async def fetch_batch(from_s: str, to_s: str) -> IndexCandleFetchResult:
        calls.append((from_s, to_s))
        return IndexCandleFetchResult(candles=[point(len(calls), float(len(calls)))])

    await collect_index_minute_candles_with_cache(cache, ("KOSPI", "1m", 60), "20260622", "20260622", fetch_batch)
    broader = await collect_index_minute_candles_with_cache(cache, ("KOSPI", "1m", 60), "20260601", "20260622", fetch_batch)

    assert calls == [("20260622", "20260622"), ("20260601", "20260622")]
    assert [c.close for c in broader.candles] == [2.0]
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
uv run pytest tests/unit/live/test_index_minute_candles_cache.py -q
```

Expected: fail with `ModuleNotFoundError`.

- [ ] **Step 3: Implement exact-range memory cache**

Create `hoga/live/index_minute_candles_cache.py`:

```python
from __future__ import annotations

from typing import Awaitable, Callable, TypeAlias

from hoga.live.kis_client import IndexCandleFetchResult

IndexMinuteCacheKey: TypeAlias = tuple[str, str, int]


class IndexMinuteCandlesCache:
    def __init__(self) -> None:
        self._exact: dict[tuple[IndexMinuteCacheKey, str, str], IndexCandleFetchResult] = {}

    def get_exact(self, key: IndexMinuteCacheKey, from_s: str, to_s: str) -> IndexCandleFetchResult | None:
        return self._exact.get((key, from_s, to_s))

    def store_exact(self, key: IndexMinuteCacheKey, from_s: str, to_s: str, result: IndexCandleFetchResult) -> None:
        if result.violations:
            return
        self._exact[(key, from_s, to_s)] = IndexCandleFetchResult(
            candles=list(result.candles),
            violations=[],
        )


async def collect_index_minute_candles_with_cache(
    cache: IndexMinuteCandlesCache,
    key: IndexMinuteCacheKey,
    from_s: str,
    to_s: str,
    fetch_batch: Callable[[str, str], Awaitable[IndexCandleFetchResult]],
) -> IndexCandleFetchResult:
    hit = cache.get_exact(key, from_s, to_s)
    if hit is not None:
        return IndexCandleFetchResult(candles=list(hit.candles), violations=[])
    result = await fetch_batch(from_s, to_s)
    cache.store_exact(key, from_s, to_s, result)
    return result
```

This is intentionally exact-range first. Do not add range merging for 1m until KIS fetch-depth measurement proves older 1m ranges are independently fetchable.

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
uv run pytest tests/unit/live/test_index_minute_candles_cache.py -q
```

Expected: `2 passed`.

---

### Task 4: Wire Minute Cache Into `/api/live/index-candles`

**Files:**
- Modify: `hoga/live/api.py`
- Modify: `tests/api/test_live_indices_routes.py`

**Interfaces:**
- Consumes: `IndexMinuteCandlesCache`, `collect_index_minute_candles_with_cache`
- Produces: repeated index minute requests reuse memory cache

- [ ] **Step 1: Write failing API cache test**

Append to `tests/api/test_live_indices_routes.py`:

```python
def test_index_minute_candles_repeated_request_uses_cache(tmp_path, monkeypatch) -> None:
    calls = 0

    class FakeKis:
        async def fetch_index_minute_candles(self, index, from_s, to_s, *, bucket_seconds=60, foreground=False):
            nonlocal calls
            calls += 1
            return IndexCandleFetchResult(
                candles=[
                    IndexCandlePoint(
                        t_ms=1782103980000,
                        open=1.0,
                        high=1.0,
                        low=1.0,
                        close=float(calls),
                        volume=1,
                    )
                ],
                violations=[],
            )

    monkeypatch.setattr(live_api.kis_access, "kis_for_role", lambda role, data_dir: FakeKis())
    monkeypatch.setattr(live_api, "index_minute_candles_cache_instance", None)
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    client = TestClient(app)

    r1 = client.get("/api/live/index-candles?index_id=KOSPI&timeframe=1m&from=20260622&to=20260622")
    r2 = client.get("/api/live/index-candles?index_id=KOSPI&timeframe=1m&from=20260622&to=20260622")

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert calls == 1
    assert r2.json()["candles"][0]["close"] == 1.0
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
uv run pytest tests/api/test_live_indices_routes.py -q -k "index_minute_candles_repeated_request_uses_cache"
```

Expected: fail because repeated requests call `FakeKis` twice.

- [ ] **Step 3: Wire cache in `hoga/live/api.py`**

Add imports:

```python
from hoga.live.index_minute_candles_cache import (
    IndexMinuteCandlesCache,
    collect_index_minute_candles_with_cache,
)
```

Add module-level cache:

```python
index_minute_candles_cache_instance: IndexMinuteCandlesCache | None = None
```

Initialize inside `build_router`:

```python
    global index_minute_candles_cache_instance
    if data_dir is not None and index_minute_candles_cache_instance is None:
        index_minute_candles_cache_instance = IndexMinuteCandlesCache()
```

Change the minute branch:

```python
            if index_minute_candles_cache_instance is None:
                raise HTTPException(503, "index-minute-candles cache not wired (data_dir missing)")

            async def fetch_batch(from_s: str, to_s: str) -> IndexCandleFetchResult:
                return await kis.fetch_index_minute_candles(
                    index,
                    from_s,
                    to_s,
                    bucket_seconds=bucket_seconds,
                    foreground=True,
                )

            result = await collect_index_minute_candles_with_cache(
                index_minute_candles_cache_instance,
                (index.id, timeframe, bucket_seconds),
                from_,
                to,
                fetch_batch,
            )
```

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
uv run pytest tests/api/test_live_indices_routes.py tests/unit/live/test_index_minute_candles_cache.py -q
```

Expected: all tests pass.

---

### Task 5: Browser And Timing Verification

**Files:**
- No production files expected.

**Interfaces:**
- Consumes: index minute cache from Task 4
- Produces: verification evidence for repeated request speed and honest scrollback behavior

- [ ] **Step 1: Run targeted backend tests**

Run:

```bash
uv run pytest tests/unit/live/test_kis_client.py tests/api/test_live_indices_routes.py tests/unit/live/test_index_minute_candles_cache.py -q -k "index_minute or index_candles"
```

Expected: all selected tests pass.

- [ ] **Step 2: Run frontend tests that touch index minute deep links**

Run:

```bash
cd frontend
npx vitest run src/live/LivePage.test.tsx src/api/liveIndices.test.tsx
```

Expected: all tests pass.

- [ ] **Step 3: Re-run fetch-depth measurement**

Run:

```bash
node scripts/measure_index_minute_fetch_depth.mjs
```

Expected:

```text
second exact request for the same timeframe/range is faster
1m wide still does not claim older candles unless KIS actually returns them
10m/30m behavior is documented by date distribution
warnings no longer include expected out_of_range rows if Task 2 was implemented
```

- [ ] **Step 4: Browser smoke test**

Open `http://localhost:5173/live`, select `KOSPI`, switch through `1분`, `10분`, `30분`, pan left once on each.

Expected:

```text
chart renders non-empty candles for supported returned rows
repeat timeframe switch does not re-call KIS for exact same range within the process
older pan does not falsely show invented candles when KIS did not return older minute rows
```

---

## Self-Review

**Spec coverage:** The plan covers index minute cache feasibility, local measurement, exact-range repeat cache, warning cleanup, API wiring, and browser verification. It does not promise full 1m historical scrollback because current measurement shows the upstream fetch returns only latest rows for 1m.

**Placeholder scan:** No `TBD`, `TODO`, or undefined implementation steps remain.

**Type consistency:** `IndexMinuteCandlesCache`, `IndexMinuteCacheKey`, and `collect_index_minute_candles_with_cache` are defined before use and referenced consistently.

## Verified KIS Index Minute Limitation

2026-06-23 live probes confirmed that domestic index minute endpoint
`/uapi/domestic-stock/v1/quotations/inquire-time-indexchartprice`
does not behave like stock `inquire-time-dailychartprice`.

- Stock minute supports `FID_INPUT_DATE_1` plus `FID_INPUT_HOUR_1=HHMMSS` cursor.
- Index minute uses `FID_INPUT_HOUR_1` as a source unit such as `30`, `60`, `300`, `600`, `3600`.
- Adding `FID_INPUT_DATE_1` to index minute requests is ignored by KIS.
- Forcing `tr_cont=N` or `tr_cont=M` returns the same page, not an older page.
- Therefore cache improves repeated requests, and better source-unit selection improves 5m/15m depth, but KIS REST cannot create stock-like 1-year index minute scrollback.
