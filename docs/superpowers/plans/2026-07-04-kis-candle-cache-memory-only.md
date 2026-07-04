# KIS Candle Cache Memory-Only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make KIS candle cache process-memory-only and ensure KIS REST Bypass prevents all covered KIS REST calls, including background REST capture/quote/candle paths.

**Architecture:** Keep official stored chart data in the existing parquet and screener read paths. Convert `PastCandlesCache` from disk+memory hybrid to bounded in-memory storage for both past and today minute candles, matching the daily cache's volatility. Keep `kis_access.run_with_capacity()` as the central KIS REST gate and make route/runtime callers avoid creating background KIS REST work when bypass is enabled.

**Tech Stack:** Python 3.14, FastAPI, pytest, existing `hoga.live.kis_access`, existing live cache/backfill classes.

## Global Constraints

- KIS Candle Cache is process memory only.
- Do not create a new disk cache namespace.
- Do not put KIS candles under the official parquet source tree.
- Do not make `/api/range` read KIS candle cache.
- Stop writing new `kis-past-candles` JSON files.
- Treat existing `kis-past-candles` files as legacy artifacts, not runtime cache.
- Write failing tests before production code.

---

## File Structure

- Modify `hoga/live/past_candles_cache.py`: remove JSON read/write behavior while preserving the public methods used by `LiveMinuteCandleBackfill`.
- Modify `tests/unit/live/test_past_candles_cache.py`: replace disk-cache assertions with memory-only behavior assertions.
- Modify `tests/unit/live/test_api_kis_rest_bypass_candles.py`: update bypass tests so seeded cache uses the same router cache instance instead of legacy disk files.
- Modify `tests/unit/live/test_lifecycle_rest30_recorder.py`: add a lifecycle/storage-runtime regression test proving bypass prevents REST 30s recorder startup and target assignment.
- Optional docs update after green: mark `docs/adr/0040-live-candle-backfill-separate-cache.md` as amended by the new spec rather than rewriting historical context.

---

### Task 1: Convert Minute Candle Cache to Memory Only

**Files:**
- Modify: `tests/unit/live/test_past_candles_cache.py`
- Modify: `hoga/live/past_candles_cache.py`

**Interfaces:**
- Consumes: existing `PastCandlesCache(data_dir: Path, today_ttl_seconds=..., max_past_mem_entries=..., max_today_mem_entries=...)`.
- Produces: same public methods:
  - `get_past(*args: str) -> list[dict] | None`
  - `store_past(*args) -> None`
  - `delete_past(*args: str) -> None`
  - `get_today_tri(*args: str) -> tuple[TodayState, list[dict] | None]`
  - `store_today(*args) -> None`

- [ ] **Step 1: Write failing memory-only tests**

Replace disk persistence tests in `tests/unit/live/test_past_candles_cache.py` with these behaviors:

```python
def test_past_memory_miss_then_store_then_hit_without_disk_write(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path)
    assert cache.get_past("005930", "20260520") is None

    bars = _bars_for("20260520", n=3)
    cache.store_past("005930", "20260520", bars)

    assert cache.get_past("005930", "20260520") == bars
    assert not (tmp_path / "kis-past-candles").exists()


def test_past_cache_does_not_read_legacy_json_files(tmp_path: Path) -> None:
    p = tmp_path / "kis-past-candles" / "005930" / "20260520.json"
    p.parent.mkdir(parents=True)
    p.write_text(json.dumps({"candles": _bars_for("20260520", n=1)}), encoding="utf-8")

    cache = PastCandlesCache(data_dir=tmp_path)

    assert cache.get_past("005930", "20260520") is None
    assert p.exists()
```

Remove or rewrite these old disk-specific tests because the target behavior rejects them:

```text
test_past_disk_miss_then_store_then_hit
test_past_corrupt_cache_treated_as_miss_and_heals_on_store
test_past_stale_cache_with_wrong_date_treated_as_miss_and_evicted
test_past_empty_cache_for_non_trading_day_is_valid
test_past_mem_with_wrong_date_evicts_and_falls_through_to_disk
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
uv run --extra dev pytest tests/unit/live/test_past_candles_cache.py -q
```

Expected: failure because `store_past()` still writes `kis-past-candles` JSON and `get_past()` still reads legacy JSON.

- [ ] **Step 3: Implement memory-only cache**

In `hoga/live/past_candles_cache.py`:

```python
"""Memory-only cache for KIS minute candle results.

Backs GET /api/live/past-candles. Both past and today's candles live only in
process memory; restart/deploy/eviction is natural invalidation.
"""
```

Remove these imports because disk JSON is no longer used:

```python
import json
import logging
from hoga.api._atomic_write import atomic_write_json
```

Change `get_past()` so it only checks `_past_mem`:

```python
def get_past(self, *args: str) -> list[dict] | None:
    venue, code, date = self._parse_past_args(args)
    key = (venue, code, date)
    bars = self._past_mem.get(key)
    if bars is None:
        return None
    if not self._bars_match_date(bars, date):
        self._past_mem.pop(key, None)
        return None
    self._past_mem.move_to_end(key)
    return bars
```

Change `store_past()` so it only updates `_past_mem`:

```python
def store_past(self, *args) -> None:
    if len(args) == 3:
        venue, code, date = "KRX", args[0], args[1]
        bars = args[2]
    elif len(args) == 4:
        venue, code, date, bars = args
    else:
        raise TypeError("expected (code, date, bars) or (venue, code, date, bars)")
    key = (venue, code, date)
    self._past_mem[key] = bars
    self._past_mem.move_to_end(key)
    self._trim_lru(self._past_mem, self._max_past_mem_entries)
```

Change `delete_past()` so it only evicts memory:

```python
def delete_past(self, *args: str) -> None:
    venue, code, date = self._parse_past_args(args)
    self._past_mem.pop((venue, code, date), None)
```

Keep `_bars_match_date()` because it protects memory entries from mismatched-date KIS quirks.

- [ ] **Step 4: Run test to verify GREEN**

Run:

```bash
uv run --extra dev pytest tests/unit/live/test_past_candles_cache.py -q
```

Expected: all `test_past_candles_cache.py` tests pass.

- [ ] **Step 5: Commit**

```bash
git add hoga/live/past_candles_cache.py tests/unit/live/test_past_candles_cache.py
git commit -m "fix(live): make KIS minute candle cache memory-only"
```

---

### Task 2: Update Bypass Candle Route Tests for Memory Cache

**Files:**
- Modify: `tests/unit/live/test_api_kis_rest_bypass_candles.py`

**Interfaces:**
- Consumes: memory-only `PastCandlesCache`.
- Produces: tests that seed the exact cache instance mounted into `build_router()`.

- [ ] **Step 1: Write failing route test adjustments**

Update `test_past_candles_bypass_uses_cached_krx_fallback_for_non_krx_request` so it mirrors the existing today-cache test pattern:

```python
def test_past_candles_bypass_uses_cached_krx_fallback_for_non_krx_request(
    tmp_path,
    monkeypatch,
) -> None:
    fake = _CountingKis()
    date_s = "20240102"
    cache = PastCandlesCache(tmp_path)
    cache.store_past(
        "KRX",
        "005930",
        date_s,
        [
            {
                "t_ms": _kst_t_ms(date_s),
                "open": 100,
                "high": 110,
                "low": 90,
                "close": 105,
                "volume": 123,
            }
        ],
    )
    monkeypatch.setattr(live_api, "PastCandlesCache", lambda data_dir: cache)
    app = _bypass_app(tmp_path, fake)
    run_with_capacity_calls = 0

    async def fake_run_with_capacity(*_args, **_kwargs):
        nonlocal run_with_capacity_calls
        run_with_capacity_calls += 1
        raise AssertionError("run_with_capacity must not be called during KIS REST bypass")

    monkeypatch.setattr("hoga.live.kis_access.run_with_capacity", fake_run_with_capacity)

    with TestClient(app, raise_server_exceptions=False) as c:
        response = c.get(
            f"/api/live/past-candles?code=005930&from={date_s}&to={date_s}&venue=NXT"
        )

    body = response.json()
    assert response.status_code == 200
    assert body["candles"][0]["close"] == 105
    assert all(warning.get("date") != date_s for warning in body["data_warnings"])
    assert run_with_capacity_calls == 0
    assert fake.minute_fetch_count == 0
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
uv run --extra dev pytest tests/unit/live/test_api_kis_rest_bypass_candles.py -q
```

Expected: if Task 1 changed cache behavior but this file still relies on disk, the old test fails. After the test adjustment it should fail only if route cache wiring is wrong.

- [ ] **Step 3: Implement only if needed**

No production change should be needed if `build_router()` constructs one `PastCandlesCache` and the monkeypatched constructor returns the seeded instance. If a failure shows duplicate cache construction, keep the route behavior unchanged and adjust the test seam to patch before `build_router()`.

- [ ] **Step 4: Run test to verify GREEN**

Run:

```bash
uv run --extra dev pytest tests/unit/live/test_api_kis_rest_bypass_candles.py -q
```

Expected: all bypass candle route tests pass and no KIS call counter increments during bypass.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/live/test_api_kis_rest_bypass_candles.py
git commit -m "test(live): seed KIS candle bypass tests through memory cache"
```

---

### Task 3: Guard Background REST Capture Under Bypass

**Files:**
- Modify: `tests/unit/live/test_lifecycle_rest30_recorder.py`
- Modify if RED requires it: `hoga/live/storage_runtime.py`
- Modify if RED requires it: `hoga/live/lifecycle.py`

**Interfaces:**
- Consumes: persisted live setting `kis_rest_bypass_enabled`.
- Produces: invariant that bypass ON yields no `kis_api_targets` and no running REST 30s recorder.

- [ ] **Step 1: Write failing background-runtime test**

Append this test to `tests/unit/live/test_lifecycle_rest30_recorder.py`:

```python
@pytest.mark.asyncio
async def test_kis_rest_bypass_prevents_api_recorder_start(tmp_path, monkeypatch):
    from hoga.api.models import WatchlistDocument, WatchlistEntry, WatchlistFolder
    from hoga.api.watchlist import save_document
    from hoga.live.settings import LiveSettings, save_live_settings
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    FakeRest30Recorder.created.clear()
    save_live_settings(
        tmp_path,
        LiveSettings(storage_policy="rest_only", kis_rest_bypass_enabled=True),
    )
    save_document(
        tmp_path,
        WatchlistDocument(
            folders=[
                WatchlistFolder(
                    id="f_0000000a",
                    name="스윙",
                    order=0,
                    member_codes=["005930", "000660"],
                    capture_enabled=True,
                )
            ],
            entries=[
                WatchlistEntry(code="005930", name="삼성전자", registered_at_kst_date="20260601"),
                WatchlistEntry(code="000660", name="SK하이닉스", registered_at_kst_date="20260601"),
            ],
        ),
    )

    class Hit:
        def __init__(self, code):
            self.code = code

    monkeypatch.setattr(
        "hoga.api.symbols.search",
        lambda _query, limit=10_000: [Hit("005930"), Hit("000660")],
    )
    monkeypatch.setattr("hoga.live.kis_runtime.configured_account_ids", lambda data_dir: [0])
    monkeypatch.setattr("hoga.live.kis_runtime.ensure_kis_client_from_env", lambda data_dir: object())
    monkeypatch.setattr("hoga.live.rest30_recorder.Rest30sRecorder", FakeRest30Recorder)

    assert await lifecycle.start_live_stream(data_dir=tmp_path) is True

    status = lifecycle.get_status()
    assert status.storage_policy == "rest_only"
    assert status.kis_rest_bypass_enabled is True
    assert status.kis_api_targets == []
    assert status.kis_api_running is False
    assert FakeRest30Recorder.created == []
```

- [ ] **Step 2: Run test to verify RED or characterize existing GREEN**

Run:

```bash
uv run --extra dev pytest tests/unit/live/test_lifecycle_rest30_recorder.py -q
```

Expected: the new test may already pass because `sync_storage_runtime()` zeroes `kis_api_targets` when bypass is enabled. If it passes immediately, keep it as a regression test and do not change production code.

- [ ] **Step 3: Implement minimal production fix only if test fails**

If the test fails because recorder creation happens before target clearing, make `sync_storage_runtime()` return before `_ensure_rest30_recorder()` when `bypass` is true:

```python
if bypass:
    targets = LiveStorageTargets(
        ws_targets=targets.ws_targets,
        kis_api_targets=(),
        capture_candidates=targets.capture_candidates,
    )
```

This block already exists; preserve it and ensure no later branch calls `_ensure_rest30_recorder()` with empty targets.

- [ ] **Step 4: Run focused tests**

Run:

```bash
uv run --extra dev pytest tests/unit/live/test_lifecycle_rest30_recorder.py tests/unit/live/test_lifecycle_rest_poller.py -q
```

Expected: all lifecycle REST bypass tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/live/test_lifecycle_rest30_recorder.py hoga/live/storage_runtime.py hoga/live/lifecycle.py
git commit -m "test(live): cover KIS REST bypass for REST capture runtime"
```

If no production files changed, stage only the test file:

```bash
git add tests/unit/live/test_lifecycle_rest30_recorder.py
git commit -m "test(live): cover KIS REST bypass for REST capture runtime"
```

---

### Task 4: Verify Central KIS REST Gate Coverage

**Files:**
- Modify if needed: `tests/unit/live/test_kis_rest_bypass_access.py`
- Modify if needed: `tests/unit/live/test_api_kis_rest_bypass_quotes.py`
- Modify if needed: `hoga/live/kis_access.py`
- Modify if needed: `hoga/live/api.py`

**Interfaces:**
- Consumes: `kis_access.run_with_capacity()` and `kis_access.KisRestEndpoint`.
- Produces: regression coverage that bypass blocks scheduled and legacy KIS REST calls before scheduler/client resolution.

- [ ] **Step 1: Add endpoint-parametrized central gate test**

Append to `tests/unit/live/test_kis_rest_bypass_access.py`:

```python
@pytest.mark.parametrize(
    "endpoint",
    [
        kis_access.KisRestEndpoint.PAST_MINUTE,
        kis_access.KisRestEndpoint.PAST_DAILY,
        kis_access.KisRestEndpoint.QUOTES,
        kis_access.KisRestEndpoint.LIVE_ORDERBOOK,
        kis_access.KisRestEndpoint.LIVE_TRADES,
        kis_access.KisRestEndpoint.LIVE_BROKERS,
        kis_access.KisRestEndpoint.INVESTOR_NET,
    ],
)
@pytest.mark.asyncio
async def test_run_with_capacity_blocks_representative_endpoints_when_bypass_on(
    tmp_path,
    endpoint,
):
    save_live_settings(tmp_path, LiveSettingsResponse(kis_rest_bypass_enabled=True))
    scheduler = FakeScheduler()

    async def fetch_fn(_kis):
        raise AssertionError("fetch_fn must not run during KIS REST bypass")

    with pytest.raises(kis_access.KisRestBypassedError):
        await kis_access.run_with_capacity(
            scheduler,
            data_dir=tmp_path,
            role="background",
            key=("bypass", endpoint.value),
            endpoint=endpoint,
            priority="background",
            fetch_fn=fetch_fn,
        )

    assert scheduler.calls == 0
```

- [ ] **Step 2: Run test to verify RED or characterize existing GREEN**

Run:

```bash
uv run --extra dev pytest tests/unit/live/test_kis_rest_bypass_access.py -q
```

Expected: likely GREEN because `run_with_capacity()` already calls `_raise_if_bypassed()` before scheduler submission. If GREEN, this is a regression net and no production change is needed.

- [ ] **Step 3: Add no production code unless RED exposes a missing gate**

If RED shows an endpoint-specific bypass gap, fix `hoga/live/kis_access.py` by keeping `_raise_if_bypassed(data_dir)` as the first statement in `run_with_capacity()` and `fetch_for_role()`.

- [ ] **Step 4: Run quote/investor route regression tests**

Run:

```bash
uv run --extra dev pytest tests/unit/live/test_api_kis_rest_bypass_quotes.py tests/unit/live/test_kis_rest_bypass_access.py -q
```

Expected: route-level fallback responses stay graceful and central gate stays strict.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/live/test_kis_rest_bypass_access.py tests/unit/live/test_api_kis_rest_bypass_quotes.py hoga/live/kis_access.py hoga/live/api.py
git commit -m "test(live): broaden KIS REST bypass gate coverage"
```

If no production files changed, stage only the changed tests.

---

### Task 5: Documentation and Final Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-04-kis-candle-cache-consolidation-design.md`
- Modify if appropriate: `docs/adr/0040-live-candle-backfill-separate-cache.md`

**Interfaces:**
- Consumes: green tests from Tasks 1-4.
- Produces: docs that describe implemented behavior without pretending KIS candles are official persisted Source data.

- [ ] **Step 1: Update spec status**

Change the spec header:

```markdown
Status: Implemented
```

Add an implementation note:

```markdown
Implemented by replacing minute KIS candle disk JSON reads/writes with bounded
process memory and retaining KIS REST Bypass as the central scheduled-call gate.
Existing `kis-past-candles` files are legacy artifacts and are not read by the
runtime cache.
```

- [ ] **Step 2: Add ADR amendment note**

Append a short note to `docs/adr/0040-live-candle-backfill-separate-cache.md`:

```markdown
## 2026-07-04 Amendment: cache is memory-only

The separate KIS candle endpoint remains, but its cache is no longer disk
durable. Minute candles now match daily candles as process-memory-only
temporary results. `kis-past-candles` JSON files are legacy artifacts and are
not part of runtime cache behavior.
```

- [ ] **Step 3: Run focused backend test set**

Run:

```bash
uv run --extra dev pytest \
  tests/unit/live/test_past_candles_cache.py \
  tests/unit/live/test_past_daily_candles_cache.py \
  tests/unit/live/test_live_candle_backfill.py \
  tests/unit/live/test_live_daily_candle_backfill.py \
  tests/unit/live/test_api_kis_rest_bypass_candles.py \
  tests/unit/live/test_api_kis_rest_bypass_quotes.py \
  tests/unit/live/test_kis_rest_bypass_access.py \
  tests/unit/live/test_lifecycle_rest30_recorder.py \
  tests/unit/live/test_lifecycle_rest_poller.py \
  -q
```

Expected: all selected tests pass.

- [ ] **Step 4: Check for disk-cache implementation remnants**

Run:

```bash
rg -n "atomic_write_json|json\\.loads|read_text|kis-past-candles|Disk \\+ memory hybrid|disk-backed" hoga/live/past_candles_cache.py tests/unit/live/test_past_candles_cache.py
```

Expected: no disk read/write code remains in `hoga/live/past_candles_cache.py`; references to `kis-past-candles` should exist only in tests/docs that describe legacy artifacts.

- [ ] **Step 5: Commit docs and final test status**

```bash
git add docs/superpowers/specs/2026-07-04-kis-candle-cache-consolidation-design.md docs/adr/0040-live-candle-backfill-separate-cache.md
git commit -m "docs: mark KIS candle memory cache implemented"
```

---

## Self-Review

**Spec coverage:**

- Memory-only minute KIS cache: Task 1.
- Daily cache remains memory-only: Task 5 focused tests include existing daily cache/backfill tests.
- No new disk cache namespace: Task 1 removes writes and Task 5 searches for remnants.
- Existing JSON as legacy artifact: Task 1 test proves runtime ignores legacy JSON; Task 5 docs record it.
- KIS REST Bypass before covered KIS calls: Tasks 2, 3, and 4.
- `/api/range` unchanged: no task touches `hoga/api/bundle.py`, range routes, Source Preference, or parquet readers.

**Placeholder scan:**

- The plan contains concrete file paths, commands, expected outcomes, and code snippets for each code-changing task.

**Type consistency:**

- `PastCandlesCache` public method signatures stay compatible with `LiveMinuteCandleBackfill`.
- `kis_access.run_with_capacity()` test uses existing `FakeScheduler` and existing `KisRestEndpoint` members.
