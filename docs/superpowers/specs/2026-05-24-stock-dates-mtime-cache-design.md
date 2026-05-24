# `list_stock_dates` — Cursor Isolation & mtime Cache

**Date**: 2026-05-24
**Status**: Draft
**Type**: backend perf + correctness
**Scope**: [hoga/api/queries.py](../../hoga/api/queries.py) — `QueryEngine.list_stock_dates` only.

**Related:**
- [hoga/api/queries.py:35-45](../../hoga/api/queries.py#L35-L45) — `QueryEngine.conn` property docstring documenting the "30 concurrent /api/trades requests killed the server" incident on 2026-05-23 and the per-call `cursor()` discipline required to avoid it.
- [hoga/api/sse.py:59-65](../../hoga/api/sse.py#L59-L65) — `_InventoryHandler` only emits on directory create/delete (not file modify). Drives the choice to make the cache self-validating via per-call `stat()` instead of relying on a watchdog invalidation hook.
- [frontend/src/api/stock-dates.ts:12](../../frontend/src/api/stock-dates.ts#L12) — TanStack Query uses `staleTime: Infinity`, so re-fetches happen *only* via SSE-driven invalidation. Combined with [frontend/src/api/sse.ts:78-90](../../frontend/src/api/sse.ts#L78-L90), every `inventory_added` event causes a fresh `/api/stock-dates` call.

## Problem

`GET /api/stock-dates` powers three pages — Inventory, Capture (date range picker), and Replay (stock combobox) — by listing every captured Stock-Date in the parquet store with derived stats (price range, total volume, captured-at, completeness bits).

Two issues, observed on 2026-05-24 in a worktree with 251 Stock-Date directories (95 dates × ~2.6 codes avg, 607 MB parquet):

1. **Cold-start latency.** First call after server start takes >5 seconds (curl timeout); warm calls (OS page cache hot) take ~500 ms. Profiling not done, but the dominant cost is structurally clear: [list_stock_dates](../../hoga/api/queries.py#L53-L149) iterates every `(date, code)` directory and per directory: parses `meta.json`, runs `query_time_bounds` on `snapshots.parquet`, and runs a `SELECT MIN(low), MAX(high), SUM(vol_a+vol_b) FROM read_parquet(candles.parquet)` — 251 × parquet reads, all in one synchronous sweep.

2. **Concurrency hazard.** The same function calls `self._conn.execute(...)` directly on the shared DuckDB connection ([queries.py:87](../../hoga/api/queries.py#L87)), bypassing the per-call `cursor()` discipline that `QueryEngine.conn` was introduced to enforce after a documented 2026-05-23 incident where 30 concurrent `/api/trades` requests crashed the server.

The two issues compound under load. The frontend uses `staleTime: Infinity` and invalidates the query on every `inventory_added` SSE event — i.e. once per completed capture. With "3 capturing · 86 queued" observed in this session, that's up to 86 sequential cold-cost refetches over the queue's lifetime, and bursts of near-simultaneous capture completions can produce the very concurrency pattern that crashed the trades endpoint.

## Goals

1. Eliminate the `self._conn.execute` concurrency hazard in `list_stock_dates`.
2. Reduce warm-call cost from O(n_dirs × parquet read) to O(n_dirs × stat) — sub-100 ms for the current corpus, scaling on cheap syscalls instead of DuckDB scans.
3. Keep changes contained to one file (`queries.py`). No watchdog rewiring, no SSE schema changes, no frontend changes.

## Non-goals

- **Eliminating backend calls per capture completion.** A potential follow-up is to upgrade `capture_finished` SSE events to carry the new `StockDate` row and have the frontend do `queryClient.setQueryData(...)` instead of `invalidateQueries(...)`. This would also fix a latent bug where `inventory_added` (which fires on *dir create*, before `meta.json` is written) can trigger a refetch that doesn't see the new row yet. Deferred because: (a) cache alone brings refetch cost below user-perception threshold; (b) frontend SSE merge plus payload schema changes touch 4–5 files vs. this spec's 1; (c) the latent timing bug has not been reported as user-visible. Recorded in [Follow-up: SSE Delta Patch](#follow-up-sse-delta-patch).
- **Cold-start speedup beyond cursor isolation.** First-ever call after server start still pays full cost (~5 s for current corpus). Materializing an inventory index would help but is over-engineering until the dir count grows another order of magnitude.
- **`list_stock_dates_in_range` changes.** That function ([queries.py:155-177](../../hoga/api/queries.py#L155-L177)) only does `meta.json` existence checks — no DuckDB calls, no parsing — and is fast enough.

## Design

### Cache shape

A private dict on `QueryEngine`, keyed by the natural `(date, code)` identity of a Stock-Date:

```python
# Cached value pairs an mtime fingerprint with the fully-built StockDate row.
@dataclass(frozen=True, slots=True)
class _CachedStockDate:
    meta_mtime_ns: int   # st_mtime_ns of <code_dir>/meta.json at compute time
    value: StockDate     # the row to return

class QueryEngine:
    def __init__(self, data_dir: Path) -> None:
        ...
        self._stock_date_cache: dict[tuple[str, str], _CachedStockDate] = {}
```

### Validation strategy

The cache is **self-validating via per-call stat()**. No watchdog hook, no invalidation events. The filesystem is the source of truth; the cache merely skips the expensive recompute when the source hasn't changed.

For each `(date, code)` directory encountered in the iteration:

1. `stat(meta.json)` → if the file is missing, `continue` (matches current behavior: incomplete captures don't appear).
2. Look up the cache with a **single `cache.get((date, code))` call** holding the returned reference locally — the lookup must be one dict op, not `if k in cache: x = cache[k]` (two ops). If the returned entry is non-`None` and its `meta_mtime_ns` matches the stat result, append the cached `StockDate` and continue.
3. Otherwise, run the existing compute path (parse `meta.json`, query `snapshots.parquet` for bounds, query `candles.parquet` for price/volume aggregates, compute `captured_at` and `file_size_bytes` from the dir's files), then store the result in the cache with the fresh mtime, and append it.

After the iteration, prune cache entries whose `(date, code)` no longer exists on disk (dir was deleted between calls). This keeps the cache from leaking memory when Stock-Dates are removed.

### Cursor isolation

Every DuckDB call inside `list_stock_dates` uses `self.conn` (the `cursor()` property), never `self._conn` directly. The one offending site is the `candles.parquet` aggregate at [queries.py:87](../../hoga/api/queries.py#L87); the existing `query_time_bounds` call at [queries.py:71](../../hoga/api/queries.py#L71) already takes a connection argument and should be passed `self.conn` for consistency.

### Why mtime, why not size or content hash

- `meta.json` is rewritten as a whole at capture completion (and partial-state save points); its mtime monotonically advances on every meaningful state change.
- Snapshots/candles parquet files are written *before* meta.json finalization (within the same capture run), so meta.json's mtime is the latest fingerprint of the directory's overall state.
- Size alone is insufficient: a re-capture (same code/date, different content) could happen to produce the same byte count.
- Content hash would require reading the file, defeating the purpose.

`st_mtime_ns` (nanosecond resolution) is used instead of `st_mtime` (float seconds) to avoid float-precision ambiguity on filesystems with sub-second resolution.

### Concurrency

The cache itself is a plain Python `dict`. Concurrent `list_stock_dates` calls from FastAPI's sync-route threadpool may interleave reads and writes. This is safe in CPython because:

- Single-key reads (`cache.get((date, code))`) and assignments (`cache[k] = v`) are atomic under the GIL.
- A racing write that produces the *same* `StockDate` for the *same* mtime is idempotent — last-writer-wins yields an identical value.
- Prune phase uses snapshot iteration (`for k in list(cache.keys()): ...`) so concurrent inserts during pruning are not a structural hazard.

No `threading.Lock` is introduced. If profiling later shows contention from the prune phase walking large caches, the prune can be moved to an async-safe periodic task. Not anticipated at current scale.

### Error handling

- `meta.json` disappears between `iterdir` and `stat` → `FileNotFoundError` caught locally; `continue` (treat as not present).
- `meta.json` parses but is malformed (missing required keys) → existing `KeyError` propagates (current behavior, no silent fallback added).
- DuckDB query failure on `candles.parquet` → existing error path unchanged.
- Cache lookup never raises; on any mismatch it falls through to the compute path.

### Memory footprint

Each cached `StockDate` is ~200 bytes (small ints + two short strings). 251 entries ≈ 50 KB. 10x growth still trivial.

## Testing

Three new test scenarios in `tests/test_api_stock_dates.py` (or a sibling `test_api_stock_dates_cache.py` if the existing file's structure resists clean addition):

1. **Cache hit reuses computed row.** Build a fixture with one stock-date, call `list_stock_dates` twice, assert the second call does not touch DuckDB (parametrize via a spy on `self.conn` or by counting `read_parquet` invocations on a sentinel connection wrapper).
2. **mtime change triggers recompute.** Build a fixture, call once, `os.utime(meta_path, ns=(new_mtime, new_mtime))`, call again, assert recompute happened (spy as above) and the new row reflects updated state.
3. **Disappeared dir is pruned from cache.** Build two stock-dates, call once (both cached), `shutil.rmtree` one dir, call again, assert returned list has one entry and cache size is 1.

One new test in `tests/test_api.py` (or sibling concurrent test file):

4. **Concurrent calls don't crash.** Spawn 30 `list_stock_dates` calls in a `ThreadPoolExecutor` against a fixture with **≥10 Stock-Dates** (small fixtures don't exercise cursor contention — the DuckDB calls must actually overlap). Assert all 30 results are identical and no exception is raised. This is the regression test for the cursor isolation fix.

Existing tests in [tests/test_api_stock_dates.py](../../tests/test_api_stock_dates.py), [tests/test_api_stock_dates_completeness.py](../../tests/test_api_stock_dates_completeness.py), [tests/test_api.py](../../tests/test_api.py) must continue to pass without modification — the function's external contract (input, output shape, ordering) is unchanged.

## Out of scope (recorded for future)

### Follow-up: SSE Delta Patch

Currently every completed capture invalidates the `STOCK_DATES_QUERY_KEY` on the frontend, causing a full `/api/stock-dates` refetch. After this spec lands, those refetches are cache-fast (sub-100 ms), so the per-capture chatter is acceptable.

A follow-up could:

1. Upgrade the `capture_finished` SSE event payload to include the full `StockDate` row for the newly completed `(date, code)`.
2. Change the frontend's `capture_finished` handler to call `queryClient.setQueryData(STOCK_DATES_QUERY_KEY, prev => [...prev, newRow])` and stop using `inventory_added` as a refetch trigger for this query.
3. Side benefit: fixes the latent timing issue where `inventory_added` fires on directory creation (start of capture), before `meta.json` is written, causing a refetch that doesn't see the new row until the *next* unrelated invalidation arrives.

Estimated scope: `hoga/api/captures.py` (event payload), `hoga/api/queries.py` (expose `get_stock_date(date, code)` helper), `hoga/api/sse.py` (mirror payload for external `inventory_added`), `frontend/src/api/sse.ts` (handler rewrite), `frontend/src/api/types.ts` (event schema). ~4–5 files, 3–4 new tests. Defer until cache-only proves insufficient or the timing bug is reported user-visible.

### Inventory materialization

If the corpus grows beyond ~5,000 Stock-Date dirs, even `O(n_dirs × stat)` becomes noticeable (~100 ms+ on every call). At that point, write an `inventory.parquet` at the `data_dir/parquet/` root, updated incrementally by the capture worker on completion. `list_stock_dates` becomes a single `SELECT * FROM read_parquet(inventory.parquet)`. Out of scope at current scale.

## Risks

- **mtime resolution edge case.** On extremely fast back-to-back rewrites of the same `meta.json` (sub-microsecond), `st_mtime_ns` could theoretically be unchanged. Not a realistic scenario for capture workflows (which involve network I/O), and existing tests don't exercise it.
- **Prune phase O(n) per call.** Iterating `list(cache.keys())` walks the entire cache on every call. At 251 entries, negligible. At 50,000+ entries, reconsider.
- **Cache survives across server restarts only via OS page cache.** First call after `--reload` triggers full cold cost. This is unchanged from today and out of scope.
- **`meta.json` non-atomic write race.** If `meta.json` is rewritten non-atomically and our `stat` lands mid-write, we cache a row computed from partial content; subsequent stats see a newer mtime and self-correct on the next call. This race is **pre-existing** — the current code already reads `meta.json` without a write-time lock. This spec does not enlarge the race surface and does not attempt to close it (atomic-rename writes in the capture worker would be the proper fix, out of scope here).
