# `list_stock_dates` — Cursor Isolation & mtime Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the documented DuckDB-cursor concurrency crash in `list_stock_dates` and add a per-call `stat()`-validated mtime cache so SSE-driven refetches finish in sub-100 ms instead of 5+ seconds cold.

**Architecture:** Single-file change to [hoga/api/queries.py](../../hoga/api/queries.py). Two surgical fixes inside `list_stock_dates`: (1) route every DuckDB call through the existing `QueryEngine.conn` cursor-isolation property, and (2) add a `dict[(date, code), (mtime_ns, StockDate)]` cache that the per-call directory scan validates against `meta.json`'s `st_mtime_ns`. Filesystem stays the source of truth — no watchdog hooks, no SSE schema changes, no invalidation messages.

**Tech Stack:** Python 3.11, FastAPI, DuckDB (in-memory, per-call cursor), pytest with `tmp_path` + the existing `parse_stock_date` fixture builder.

**Spec:** [docs/superpowers/specs/2026-05-24-stock-dates-mtime-cache-design.md](../specs/2026-05-24-stock-dates-mtime-cache-design.md)

---

## File Structure

**Modified (single source change):**
- `hoga/api/queries.py` — refactor `QueryEngine.list_stock_dates`; add `_CachedStockDate` dataclass; add `_stock_date_cache` instance dict; extract per-`(date, code)` compute into `_compute_stock_date` helper.

**Created (new test file):**
- `tests/test_api_stock_dates_cache.py` — owns the four spec-mandated tests (concurrency regression, cache hit, mtime recompute, prune). Kept separate from the existing `test_api_stock_dates.py` (which targets HTTP-shape contract) so the cache-internal tests can use `QueryEngine` directly without spinning a `TestClient`.

**Unchanged:**
- `hoga/api/sse.py`, `hoga/api/routes.py`, anything in `frontend/`, watchdog observer wiring.

---

## Pre-flight

Before Task 1, run the full existing suite once to capture the green baseline:

```bash
uv run pytest -q
```

Expected: all pass. If anything is already failing, stop and surface to the user — that's a pre-existing issue this plan should not absorb.

---

## Task 1: Cursor Isolation — Regression Test + Fix

**Files:**
- Create: `tests/test_api_stock_dates_cache.py`
- Modify: `hoga/api/queries.py` (lines 71 and 87 only)

**Rationale:** The spec's primary correctness goal. The fix is two character-level edits (`self._conn` → `self.conn`); the test is what proves the bug is real before the fix and stays fixed after. Per the documented incident in [queries.py:35-45](../../hoga/api/queries.py#L35-L45), 30 concurrent calls on the shared connection crash the process.

- [ ] **Step 1: Write a fixture helper that builds N Stock-Dates from `tiny_tsv`**

Create `tests/test_api_stock_dates_cache.py` with this content:

```python
"""Cache + cursor-isolation tests for QueryEngine.list_stock_dates.

These exercise the QueryEngine directly (not via TestClient) so the
in-memory cache state and cursor() call counts can be observed.
"""
from __future__ import annotations

import shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

import pytest

from hoga.api.queries import QueryEngine
from hoga.parser import parse_stock_date

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "tiny_tsv"

# 10 Stock-Dates is the floor mandated by the spec for the concurrency
# test — small fixtures don't make DuckDB calls overlap meaningfully.
_DATES = [
    "20260504", "20260505", "20260506", "20260507", "20260508",
    "20260511", "20260512", "20260513", "20260514", "20260515",
]


def _build_engine_with_stock_dates(tmp_path: Path, dates: list[str]) -> QueryEngine:
    """Parse the tiny_tsv fixture under each date so each becomes a Stock-Date.

    Code is fixed at 003490 (the code embedded in tiny_tsv). One code × N dates
    gives N Stock-Date dirs, enough to exercise the per-(date, code) loop.
    """
    data_dir = tmp_path / "data"
    for date in dates:
        raw = data_dir / "raw" / date / "003490"
        raw.mkdir(parents=True)
        for name in ("info.tsv", "first_001.tsv", "chart.tsv"):
            shutil.copy(FIXTURE_DIR / name, raw / name)
        parse_stock_date(code="003490", date=date, data_dir=data_dir)
    return QueryEngine(data_dir)
```

- [ ] **Step 2: Add the concurrency regression test to the same file**

Append to `tests/test_api_stock_dates_cache.py`:

```python
def test_concurrent_calls_dont_crash(tmp_path: Path) -> None:
    """30 concurrent list_stock_dates calls must all return identically with no exception.

    Regression for the documented 2026-05-23 incident where shared
    DuckDB connection state crashed the server under modest load.
    """
    engine = _build_engine_with_stock_dates(tmp_path, _DATES)
    try:
        with ThreadPoolExecutor(max_workers=30) as pool:
            futures = [pool.submit(engine.list_stock_dates) for _ in range(30)]
            results = [f.result(timeout=30) for f in futures]
        baseline = results[0]
        assert len(baseline) == len(_DATES)
        for r in results:
            assert r == baseline
    finally:
        engine.close()
```

- [ ] **Step 3: Run the test — expect FAIL (or flaky crash)**

```bash
uv run pytest tests/test_api_stock_dates_cache.py::test_concurrent_calls_dont_crash -v
```

Expected: failure or crash (DuckDB segfault / "connection in use" / silent data corruption). If it accidentally passes on a quiet system, do **not** ship the fix without first verifying the test actually catches the race — increase `max_workers` or repeat the test loop until it fails. The race is documented; the test must reproduce it before we fix it.

- [ ] **Step 4: Apply the cursor isolation fix**

Edit [hoga/api/queries.py:71](../../hoga/api/queries.py#L71) — change:

```python
                bounds = (
                    snapshots.query_time_bounds(self._conn, path=snap_path)
                    if snap_path.exists()
                    else None
                )
```

to:

```python
                bounds = (
                    snapshots.query_time_bounds(self.conn, path=snap_path)
                    if snap_path.exists()
                    else None
                )
```

Edit [hoga/api/queries.py:87-92](../../hoga/api/queries.py#L87-L92) — change:

```python
                    row = self._conn.execute(
                        "SELECT MIN(low), MAX(high), "
                        "COALESCE(SUM(CAST(vol_a AS BIGINT) + CAST(vol_b AS BIGINT)), 0) "
                        "FROM read_parquet(?)",
                        [str(candles_path)],
                    ).fetchone()
```

to:

```python
                    row = self.conn.execute(
                        "SELECT MIN(low), MAX(high), "
                        "COALESCE(SUM(CAST(vol_a AS BIGINT) + CAST(vol_b AS BIGINT)), 0) "
                        "FROM read_parquet(?)",
                        [str(candles_path)],
                    ).fetchone()
```

- [ ] **Step 5: Run the test — expect PASS**

```bash
uv run pytest tests/test_api_stock_dates_cache.py::test_concurrent_calls_dont_crash -v
```

Expected: PASS. Run it 3 times in a row to confirm stability:

```bash
for i in 1 2 3; do uv run pytest tests/test_api_stock_dates_cache.py::test_concurrent_calls_dont_crash -v || break; done
```

- [ ] **Step 6: Run the full suite to verify no regressions**

```bash
uv run pytest -q
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add hoga/api/queries.py tests/test_api_stock_dates_cache.py
git commit -m "fix(queries): isolate cursors in list_stock_dates to prevent concurrent crash

The shared self._conn was bypassed by direct .execute() calls inside
list_stock_dates, undoing the per-call cursor() discipline that
QueryEngine.conn was introduced to enforce. The 2026-05-23 trades
incident applies here verbatim — frontend SSE invalidation triggers
near-simultaneous /api/stock-dates calls on capture completion bursts.

Adds a 30-worker concurrency regression test."
```

---

## Task 2: Extract `_compute_stock_date` Helper (Pure Refactor)

**Files:**
- Modify: `hoga/api/queries.py` — `list_stock_dates` body shrinks; new private `_compute_stock_date` method holds the per-dir compute that's currently inlined in the loop.

**Rationale:** The compute block is ~50 lines today; the cache changes in Task 3 will wrap it with a 6-line lookup/store. Extracting first keeps each diff focused — Task 2 is a pure refactor with no behavior change, and Task 3 is purely additive caching logic.

- [ ] **Step 1: Extract the per-`(date, code)` compute block into a helper**

Replace [hoga/api/queries.py:53-149](../../hoga/api/queries.py#L53-L149) (the current `list_stock_dates`) with:

```python
    def list_stock_dates(self) -> list[StockDate]:
        base = self.data_dir / "parquet"
        if not base.exists():
            return []
        out: list[StockDate] = []
        for date_dir in sorted(base.iterdir()):
            if not date_dir.is_dir():
                continue
            date = date_dir.name
            for code_dir in sorted(date_dir.iterdir()):
                meta_path = code_dir / "meta.json"
                if not meta_path.exists():
                    continue
                out.append(self._compute_stock_date(date, code_dir.name, code_dir))
        return out

    def _compute_stock_date(
        self, date: str, code: str, code_dir: Path
    ) -> StockDate:
        """Build a StockDate row from on-disk parquet for one (date, code).

        Caller has already verified that code_dir/meta.json exists.
        Reads meta.json + snapshots.parquet bounds + candles.parquet
        price/volume aggregates + dir stat() for captured_at and total size.
        """
        meta = json.loads((code_dir / "meta.json").read_text(encoding="utf-8"))
        _state = classify_from_meta(meta).state
        snap_path = code_dir / "snapshots.parquet"
        # snapshots.ts_ms is stored as HHMMSSmmm (per existing tests
        # asserting e.g. ts_ms == 90010435). Convert to Unix ms here.
        bounds = (
            snapshots.query_time_bounds(self.conn, path=snap_path)
            if snap_path.exists()
            else None
        )
        open_ms = hhmmssms_to_unix_ms(date, meta["regular_session_open_ms"])
        close_ms = hhmmssms_to_unix_ms(date, meta["regular_session_close_ms"])
        if bounds is not None:
            first_ms = hhmmssms_to_unix_ms(date, bounds[0])
            last_ms = hhmmssms_to_unix_ms(date, bounds[1])
        else:
            first_ms = open_ms
            last_ms = close_ms

        # Price range + total volume from candles.parquet.
        candles_path = code_dir / "candles.parquet"
        if candles_path.exists():
            row = self.conn.execute(
                "SELECT MIN(low), MAX(high), "
                "COALESCE(SUM(CAST(vol_a AS BIGINT) + CAST(vol_b AS BIGINT)), 0) "
                "FROM read_parquet(?)",
                [str(candles_path)],
            ).fetchone()
            if row is None or row[0] is None:
                price_min = 0
                price_max = 0
                total_volume = 0
            else:
                price_min = int(row[0])
                price_max = int(row[1])
                total_volume = int(row[2])
        else:
            price_min = 0
            price_max = 0
            total_volume = 0

        # Stock-Date dirs are flat by construction (parse_stock_date emits
        # only top-level parquet/meta files), so non-recursive iteration is
        # sufficient and intentional here.
        files = [p for p in code_dir.iterdir() if p.is_file()]
        captured_at = (
            int(max(p.stat().st_mtime for p in files) * 1000) if files else 0
        )
        file_size_bytes = sum(p.stat().st_size for p in files)

        return StockDate(
            date=date,
            code=code,
            name=meta["name"],
            regular_session_open_ms=open_ms,
            regular_session_close_ms=close_ms,
            data_window_first_ms=first_ms,
            data_window_last_ms=last_ms,
            price_min=price_min,
            price_max=price_max,
            captured_at=captured_at,
            total_volume=total_volume,
            pages_collected=int(meta["pages_collected"]),
            file_size_bytes=file_size_bytes,
            today_open=int(meta["today_open"]),
            today_high=int(meta["today_high"]),
            today_low=int(meta["today_low"]),
            today_close=int(meta["today_close"]),
            # Single source of truth for meta → completeness bits.
            # The DiskState enum normalizes the rule "if collection
            # didn't finish, is_partial is True regardless of what
            # meta says" — see classify_from_meta docstring.
            collection_complete=_state in (
                DiskState.COMPLETE, DiskState.SOURCE_PARTIAL,
            ),
            is_partial=_state in (
                DiskState.SOURCE_PARTIAL, DiskState.CLIENT_INCOMPLETE,
            ),
            # ADR-0020: surface the full enum so consumers can
            # see INVALID — the boolean pair above flattens it.
            disk_state=_state.value,
        )
```

- [ ] **Step 2: Run full suite to verify pure refactor**

```bash
uv run pytest -q
```

Expected: all pass. `test_api_stock_dates.py` and `test_api_stock_dates_completeness.py` are the critical regression surface here — they verify the StockDate row shape and completeness fields that this helper produces.

- [ ] **Step 3: Commit**

```bash
git add hoga/api/queries.py
git commit -m "refactor(queries): extract per-(date, code) compute into _compute_stock_date

Pure refactor — no behavior change. Splits the ~80-line loop body out
of list_stock_dates so the upcoming cache lookup/store wraps a single
function call instead of inlining around dense parquet logic."
```

---

## Task 3: Add `_CachedStockDate` + Cache Hit Path

**Files:**
- Modify: `hoga/api/queries.py` — add `_CachedStockDate` dataclass; initialize `self._stock_date_cache` in `__init__`; wrap the `_compute_stock_date` call with mtime-validated cache lookup.
- Modify: `tests/test_api_stock_dates_cache.py` — add the cache-hit test.

**Rationale:** Locks in the warm-path speedup. Test asserts the cache hit truly bypasses DuckDB by counting `cursor()` calls.

- [ ] **Step 1: Add the cache-hit test**

Append to `tests/test_api_stock_dates_cache.py`:

```python
def test_cache_hit_skips_duckdb(tmp_path: Path) -> None:
    """Second list_stock_dates call with no FS changes must not touch DuckDB.

    Wraps engine._conn.cursor with a spy and asserts call_count is 0
    on the second invocation.
    """
    engine = _build_engine_with_stock_dates(tmp_path, _DATES[:3])
    try:
        # First call: cold — populates cache.
        first = engine.list_stock_dates()
        assert len(first) == 3

        # Spy on cursor() for the second call only.
        with mock.patch.object(
            engine._conn, "cursor", wraps=engine._conn.cursor
        ) as cursor_spy:
            second = engine.list_stock_dates()
        assert cursor_spy.call_count == 0, (
            "Cache hit must not allocate a cursor — every cache miss "
            "calls self.conn which calls _conn.cursor()."
        )
        assert second == first
    finally:
        engine.close()
```

- [ ] **Step 2: Run the test — expect FAIL**

```bash
uv run pytest tests/test_api_stock_dates_cache.py::test_cache_hit_skips_duckdb -v
```

Expected: FAIL with `cursor_spy.call_count > 0` (current code recomputes every call).

- [ ] **Step 3: Add the dataclass and cache initialization**

In `hoga/api/queries.py`, add the dataclass import to the top imports if not present, then add the dataclass after the imports and before `class StockDateNotFound`:

```python
from dataclasses import dataclass
```

```python
@dataclass(frozen=True, slots=True)
class _CachedStockDate:
    """Cache entry pairing a meta.json mtime fingerprint with the built StockDate.

    Keyed in QueryEngine._stock_date_cache by (date, code). Validity is
    checked by re-stat()ing meta.json on every list_stock_dates call —
    the filesystem is the source of truth; this struct just avoids the
    DuckDB + JSON parse work when nothing on disk has changed.
    """
    meta_mtime_ns: int
    value: StockDate
```

Then in `QueryEngine.__init__`, add the cache dict:

```python
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self._conn = duckdb.connect(database=":memory:", read_only=False)
        # Per-call mtime-validated cache for list_stock_dates. See
        # _CachedStockDate docstring; keyed by (date, code).
        self._stock_date_cache: dict[tuple[str, str], _CachedStockDate] = {}
```

- [ ] **Step 4: Wrap the compute call with cache lookup**

Replace the body of `list_stock_dates` (currently the refactored version from Task 2) with:

```python
    def list_stock_dates(self) -> list[StockDate]:
        base = self.data_dir / "parquet"
        if not base.exists():
            return []
        out: list[StockDate] = []
        for date_dir in sorted(base.iterdir()):
            if not date_dir.is_dir():
                continue
            date = date_dir.name
            for code_dir in sorted(date_dir.iterdir()):
                code = code_dir.name
                meta_path = code_dir / "meta.json"
                try:
                    mtime_ns = meta_path.stat().st_mtime_ns
                except FileNotFoundError:
                    # Dir without meta.json — incomplete capture or race
                    # with deletion; matches the pre-cache behavior of
                    # silently skipping these entries.
                    continue
                key = (date, code)
                # Single .get() — must not be replaced by `key in cache`
                # then `cache[key]` (two ops). The spec mandates a single
                # atomic dict op so a racing prune cannot null the entry
                # between the check and the read.
                cached = self._stock_date_cache.get(key)
                if cached is not None and cached.meta_mtime_ns == mtime_ns:
                    out.append(cached.value)
                    continue
                sd = self._compute_stock_date(date, code, code_dir)
                self._stock_date_cache[key] = _CachedStockDate(
                    meta_mtime_ns=mtime_ns, value=sd
                )
                out.append(sd)
        return out
```

- [ ] **Step 5: Run the cache-hit test — expect PASS**

```bash
uv run pytest tests/test_api_stock_dates_cache.py::test_cache_hit_skips_duckdb -v
```

Expected: PASS.

- [ ] **Step 6: Run full suite for regressions**

```bash
uv run pytest -q
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add hoga/api/queries.py tests/test_api_stock_dates_cache.py
git commit -m "feat(queries): add mtime-validated cache to list_stock_dates

Per-(date, code) cache keyed on meta.json st_mtime_ns. Lookup is a
single dict.get() to avoid race-window between membership check and
read. Filesystem stays source of truth — no watchdog hook, no
invalidation events. Warm calls skip DuckDB + JSON parse entirely.

Cold call (cache empty) cost is unchanged; warm refetch on SSE
inventory_added drops from O(n × parquet read) to O(n × dict.get)."
```

---

## Task 4: mtime-Change Recompute Test

**Files:**
- Modify: `tests/test_api_stock_dates_cache.py` — add the recompute test.

**Rationale:** Locks in the cache's invalidation contract. No production code change expected (the cache impl already keys on mtime), but the test prevents future "optimizations" from dropping the mtime check.

- [ ] **Step 1: Add the recompute test**

Append to `tests/test_api_stock_dates_cache.py`:

```python
import os


def test_mtime_change_triggers_recompute(tmp_path: Path) -> None:
    """When meta.json's mtime advances, the cached row must be recomputed."""
    engine = _build_engine_with_stock_dates(tmp_path, _DATES[:2])
    try:
        first = engine.list_stock_dates()
        assert len(first) == 2

        # Bump mtime on one of the meta.json files by 5 seconds.
        meta_path = engine.data_dir / "parquet" / _DATES[0] / "003490" / "meta.json"
        original = meta_path.stat()
        new_ns = original.st_mtime_ns + 5_000_000_000
        os.utime(meta_path, ns=(new_ns, new_ns))

        # Spy on cursor() for the second call.
        with mock.patch.object(
            engine._conn, "cursor", wraps=engine._conn.cursor
        ) as cursor_spy:
            second = engine.list_stock_dates()
        # The changed entry recomputes (>=1 cursor call); the unchanged
        # entry stays cached (0 additional cursor calls). Conservative
        # lower bound: at least 1, strictly less than the cold-call count.
        assert cursor_spy.call_count >= 1
        # Both calls should yield the same rows (content didn't change,
        # only mtime did). Equality holds because StockDate is a dataclass.
        assert second == first
    finally:
        engine.close()
```

- [ ] **Step 2: Run the test — expect PASS (cache already keys on mtime)**

```bash
uv run pytest tests/test_api_stock_dates_cache.py::test_mtime_change_triggers_recompute -v
```

Expected: PASS. If it fails, the cache lookup in Task 3 is not actually checking mtime — fix Task 3's lookup before continuing.

- [ ] **Step 3: Commit**

```bash
git add tests/test_api_stock_dates_cache.py
git commit -m "test(queries): mtime advance forces list_stock_dates cache recompute"
```

---

## Task 5: Prune Disappeared Stock-Dates

**Files:**
- Modify: `hoga/api/queries.py` — add prune phase at end of `list_stock_dates`.
- Modify: `tests/test_api_stock_dates_cache.py` — add the prune test.

**Rationale:** Without this, deleted Stock-Date dirs leak into the cache forever. At current scale (251 dirs) this is harmless, but the spec mandates it and it costs ~3 lines.

- [ ] **Step 1: Add the prune test**

Append to `tests/test_api_stock_dates_cache.py`:

```python
def test_disappeared_dir_pruned_from_cache(tmp_path: Path) -> None:
    """When a Stock-Date dir is deleted, its cache entry must be evicted."""
    engine = _build_engine_with_stock_dates(tmp_path, _DATES[:2])
    try:
        first = engine.list_stock_dates()
        assert len(first) == 2
        assert len(engine._stock_date_cache) == 2

        # Delete one Stock-Date dir entirely.
        victim = engine.data_dir / "parquet" / _DATES[0] / "003490"
        shutil.rmtree(victim)
        # Also remove the empty date_dir so iterdir doesn't visit it.
        victim.parent.rmdir()

        second = engine.list_stock_dates()
        assert len(second) == 1
        assert len(engine._stock_date_cache) == 1
        assert (_DATES[0], "003490") not in engine._stock_date_cache
    finally:
        engine.close()
```

- [ ] **Step 2: Run the test — expect FAIL on `len(engine._stock_date_cache) == 1`**

```bash
uv run pytest tests/test_api_stock_dates_cache.py::test_disappeared_dir_pruned_from_cache -v
```

Expected: FAIL with `assert 2 == 1` on the cache-size check (returned list shrinks but cache leaks).

- [ ] **Step 3: Add the prune phase**

In `hoga/api/queries.py`, modify `list_stock_dates` to track seen keys and prune at the end:

```python
    def list_stock_dates(self) -> list[StockDate]:
        base = self.data_dir / "parquet"
        if not base.exists():
            # Disk gone entirely — drop the whole cache rather than
            # quietly hoarding stale entries until the next call sees
            # the same empty result.
            self._stock_date_cache.clear()
            return []
        out: list[StockDate] = []
        seen_keys: set[tuple[str, str]] = set()
        for date_dir in sorted(base.iterdir()):
            if not date_dir.is_dir():
                continue
            date = date_dir.name
            for code_dir in sorted(date_dir.iterdir()):
                code = code_dir.name
                meta_path = code_dir / "meta.json"
                try:
                    mtime_ns = meta_path.stat().st_mtime_ns
                except FileNotFoundError:
                    continue
                key = (date, code)
                seen_keys.add(key)
                cached = self._stock_date_cache.get(key)
                if cached is not None and cached.meta_mtime_ns == mtime_ns:
                    out.append(cached.value)
                    continue
                sd = self._compute_stock_date(date, code, code_dir)
                self._stock_date_cache[key] = _CachedStockDate(
                    meta_mtime_ns=mtime_ns, value=sd
                )
                out.append(sd)
        # Snapshot iteration via list() — safe against concurrent inserts
        # from another threadpool worker. del on a missing key would raise,
        # so check membership of seen_keys (the set we just built).
        for k in list(self._stock_date_cache.keys()):
            if k not in seen_keys:
                del self._stock_date_cache[k]
        return out
```

- [ ] **Step 4: Run the prune test — expect PASS**

```bash
uv run pytest tests/test_api_stock_dates_cache.py::test_disappeared_dir_pruned_from_cache -v
```

Expected: PASS.

- [ ] **Step 5: Run full suite for regressions**

```bash
uv run pytest -q
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add hoga/api/queries.py tests/test_api_stock_dates_cache.py
git commit -m "feat(queries): prune list_stock_dates cache when dirs disappear

Tracks per-call seen_keys; deletes cache entries absent from disk
after the iteration completes. Also clears the entire cache when the
parquet root is gone (catches data_dir-wipe scenarios).

Prevents unbounded memory growth across long-lived processes that
see Stock-Dates come and go (e.g., manual cleanup, re-imports)."
```

---

## Task 6: Final Verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

```bash
uv run pytest -q
```

Expected: all pass.

- [ ] **Step 2: Run the four new tests in a focused pass to confirm they're stable**

```bash
for i in 1 2 3; do
  uv run pytest tests/test_api_stock_dates_cache.py -v || break
done
```

Expected: all four tests pass in all three runs. If `test_concurrent_calls_dont_crash` ever flakes here, the cursor isolation is incomplete — re-inspect any `self._conn.execute` left over in `_compute_stock_date`.

- [ ] **Step 3: Manual smoke test against a live server**

In one terminal:

```bash
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga
```

In another terminal:

```bash
# Cold call — first time after restart, expect slow (5s+ on the full corpus).
time curl -s http://127.0.0.1:8000/api/stock-dates -o /dev/null

# Warm call — cache populated, expect sub-100ms.
time curl -s http://127.0.0.1:8000/api/stock-dates -o /dev/null

# Run a quick burst — should not crash, all 200s.
seq 1 30 | xargs -n1 -P30 -I{} curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/api/stock-dates | sort | uniq -c
```

Expected: first call slow, second sub-100ms, burst shows `30 200`. If any non-200 codes appear, stop and investigate before closing the task.

- [ ] **Step 4: Stop here if anything red**

If the burst test shows non-200 codes, or the warm call isn't sub-100ms, do not declare done. Likely causes:
- Lingering `self._conn.execute` somewhere (check `grep -n "self._conn\." hoga/api/queries.py` — should only appear in `__init__`, `close`, and the `conn` property).
- Cache not initialized on `__init__` (NameError on first call).
- Prune deleting in-flight entries from a concurrent worker.

---

## Self-Review

**Spec coverage:**
- Goal 1 (eliminate concurrency hazard) → Task 1 + Task 6 burst smoke. ✓
- Goal 2 (warm sub-100ms via O(n × stat)) → Task 3 + Task 6 timing smoke. ✓
- Goal 3 (one-file scope) → all production edits in `queries.py`. ✓
- Spec testing #1 (cache hit) → Task 3 test. ✓
- Spec testing #2 (mtime recompute) → Task 4 test. ✓
- Spec testing #3 (prune) → Task 5 test. ✓
- Spec testing #4 (30 concurrent) → Task 1 test, fixture ≥10 dates per spec mandate. ✓
- Spec design "single cache.get()" pattern → enforced in Task 3 Step 4 code + inline comment. ✓
- Spec design `frozen=True, slots=True` dataclass → Task 3 Step 3. ✓
- Spec design `st_mtime_ns` (not float) → used throughout. ✓

**Placeholder scan:** none.

**Type consistency:**
- `_CachedStockDate` field `meta_mtime_ns: int`, used consistently in Task 3, 4, 5 code. ✓
- `_stock_date_cache: dict[tuple[str, str], _CachedStockDate]` — key tuple shape matches `(date, code)` order in all tasks. ✓
- `_compute_stock_date(self, date, code, code_dir)` signature is identical across Task 2 definition and Task 3 / Task 5 callers. ✓

---

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks. The user pre-selected this in the chain (`/subagent-driven-development` is the next step in their request).
2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans`.

Auto-decision per user instruction: **proceed with subagent-driven-development**.
