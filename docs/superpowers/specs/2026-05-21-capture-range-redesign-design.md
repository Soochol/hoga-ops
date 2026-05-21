# Capture UI Redesign — Symbol Search · Date Range · Multi-Item Queue

**Status:** Draft (awaiting user review)
**Date:** 2026-05-21
**Spec owner:** blessp@naver.com
**Supersedes:** parts of `docs/superpowers/specs/2026-05-21-capture-ui-design.md` (the single-item capture flow; the data plumbing, SSE bus, single-worker assert, and timestamp encoding rules all carry forward unchanged).

**Related:**
- `CONTEXT.md` — domain language (**Stock-Date**, **Data Window**, **Page**, **Full Capture**, **Capture Frontier**).
- `DESIGN.md` — design system tokens. **Source of truth for any visual question this spec does not answer.**
- `docs/adr/0003-api-time-encoding.md` — API timestamps are Unix epoch ms (UTC).
- `docs/adr/0004-wire-models.md` — Wire Model = consumer shape, verbatim.
- `hoga/collector/orchestrator.py` — `collect_stock_date()` reused; gains a `finished:true` marker in `_progress.json` on natural termination.
- `hoga/api/sse.py` — existing SSE bus extended with new `capture_*` event topics.
- `hoga/api/captures.py` — singleton model (`_latest`) replaced by queue (`_queue`) + worker pool (N=3 default).
- Mockups under `.superpowers/brainstorm/575692-1779340819/content/`: `layout.html`, `calendar.html`, `search.html`.

**Authority order if these disagree:** This spec (WHAT and WHY) → `DESIGN.md` (visual tokens) → mockups (pixel reference). If a mockup contradicts `DESIGN.md`, the mockup is stale.

---

## 1. Goal & Scope

### 1.1 Goal

Replace the single (Code, Stock-Date) capture form with a **(Symbol, Date-Range) queue model**. The user picks one symbol (by Korean name as the primary affordance, or by Code), picks a date range on a calendar that shows existing capture state, and the system enqueues N (symbol, trading-day) items. A worker pool drives up to **3** captures in parallel, automatically:

- **skips** dates that are already complete on disk,
- **skips** dates that are source-side incomplete (hogaplay didn't have full data — retry would give the same result),
- **resumes** dates whose raw is on disk but parse never finished,
- **fresh-captures** dates that have no data yet.

The form is *additive*: pressing **Start Capture** appends items to the running queue. Multiple symbols can coexist in one queue.

### 1.2 In scope (v1+2)

1. **Symbol search** — single input matching by Korean name (primary) or 6-digit Code, dropdown showing market (KOSPI/KOSDAQ) and per-symbol capture count.
2. **Symbol master** — `pykrx`-backed cache with 24h lazy TTL refresh + manual refresh button.
3. **Date range picker** — calendar with status markers (✓/⚠/✕), trading-day filter, today-locked-before-18:00-KST rule.
4. **Multi-item queue** — `_queue` list + `_active` dict + workers up to `_max_concurrent=3`. Items accumulate; symbols may differ within one queue.
5. **Completeness model** — two bits on `meta.json`: `collection_complete` (collector reached natural termination) and `is_partial` (Data Window not fully covered).
6. **Auto-decision matrix** at item start (deciding phase): complete → skip (always; `force_retry` does NOT override — Dismiss Done + manual fresh capture is the path), source-partial → skip unless `force_retry`, client-incomplete → resume, none → fresh.
7. **Cancel UX** — "Cancel All" + per-row cancel; queued cancel = remove from queue, active cancel = collector cancel token (raw preserved).
8. **Cookie-expired pause** — first 401 freezes all workers and pauses queue; user refreshes cookie and clicks Resume.
9. **429 backoff** — exponential per-item backoff (5/10/30s) before failing.
10. **LeftNav pill** rewritten as queue summary ("3 capturing · 5 queued").
11. **Single capture flow removed** — single-day capture is expressed as `start_date == end_date` in the new flow.

### 1.3 Non-goals

- **Multi-symbol multi-select in one form submission.** A single Start = one (symbol, range). Multi-symbol queues are achieved by pressing Start again after picking another symbol. Bulk-import UI is a separate workflow and is out of scope.
- **Queue persistence across server restarts.** `_queue` and `_active` live in memory. On restart, queue is lost; raw files on disk remain, and re-submitting the range picks up `client_incomplete` items via Resume.
- **Cookie editing UI.** Still `.cookie` file / `HOGAPLAY_COOKIE` env. Paused queue surfaces the requirement; user updates cookie out-of-band.
- **Scheduled / cron capture.** Out of scope.
- **Calendar overlay of multiple symbols' markers.** One symbol at a time.
- **Light mode.** Handled at design system level.

---

## 2. Decisions Log

Recorded for traceability into the implementation plan; details elaborated in subsequent sections. Q14–Q21 (post-`/grill-with-docs`) live in §11 with full deltas.

| # | Question | Decision |
|---|---|---|
| Q1 | Symbol master data source | **pykrx fetch + local cache**. TTL 24h lazy refresh + manual refresh button. |
| Q2 | What defines "complete"? | `meta.json` has `collection_complete=True` AND `is_partial=False`. Two bits, written by parser. |
| Q3 | Parallelism level | **N=3** workers, default. Backed by user's observation that 3 concurrent hogaplay tabs run safely. |
| Q4 | Date range iteration filters | (a) non-trading days auto-skip; (b) future dates disabled; (c) today disabled until 18:00 KST. |
| Q5 | Two kinds of "incomplete" | **Source-side** (collector exhausted but Data Window has gaps) → skip on retry. **Client-side** (collector died) → resume. Toggle "⚠ force re-capture source-partial" overrides. |
| Q6 | Progress UI | Per-date queue table (rows: date, code, name, status, pages, events, mini-bar). |
| Q7 | Coexist with single-capture flow? | **Replace.** Single day = `start_date == end_date`. |
| Q8 | Cancel semantics | "Cancel All" header button + per-row cancel. |
| Q9 | pykrx cache refresh | **TTL 24h lazy + manual refresh button.** |
| Q10 | Page layout | **Left column = controls (search + calendar + options); right column = queue table.** |
| Q11 | Calendar marker style | **Corner badge (✓/⚠/✕)** — top-right of each cell. |
| Q12 | Search dropdown row style | **Rich row** — name, code, market chip, capture count. |
| Q13 | Multi-symbol queueing | **Incremental accumulation.** Start = append to queue. Form auto-resets. |
| Q14 | 18:00 today-lock scope | **Backend-enforced**, not UI-only; `allow_partial` option removed. See §11.Q14. |
| Q15 | Duplicate (code, date) protection | **Enqueue dedupe + per-(code, date) inflight lock** (two layers). See §11.Q15. |
| Q16 | `force_retry` lifecycle | **Snapshot at Start**; row `⚠ force` chip; no retroactive change in v1+2. See §11.Q16. |
| Q17 | Module split for shared disk-state logic | **Extract `hoga/api/disk_state.py`**; **ADR-0007** amends ADR-0006. See §11.Q17. |
| Q18 | `captured_count` semantics | **Complete-only** in dropdown; full breakdown in tooltip. See §11.Q18. |
| Q19 | pykrx cold-start UX | **3-tier**: lifespan prefetch + GET dedupe via Future + stale/unavailable fallback. See §11.Q19. |
| Q20 | `Cancel All` while paused | **Resets everything** (queue + active + paused flag + pause_origin downgrade). See §11.Q20. |
| Q21 | Calendar SSE vs GET race | **`as_of_ms` + client-side reconciliation.** Inventory storm dedupe = follow-up. See §11.Q21. |

---

## 3. Backend Architecture

### 3.1 Module changes

```
hoga/api/captures.py             — _latest singleton → _queue + worker pool (N=3 default)
hoga/api/symbols.py    [new]     — pykrx symbol master cache + search
hoga/api/calendar.py   [new]     — per-symbol month status map endpoint
hoga/api/models.py               — QueueItem, SymbolHit, CalendarCell + new SSE event models
hoga/collector/orchestrator.py   — write `finished: true` to _progress.json on natural termination
hoga/parser/...                  — compute and write meta["collection_complete"], meta["is_partial"]
hoga/api/queries.py              — list_stock_dates() surfaces the two completeness bits
```

The single-worker import-time assert in `hoga/api/captures.py` (refuses `WEB_CONCURRENCY > 1`) is preserved unchanged. N=3 parallelism lives **inside one process** as asyncio tasks; multi-process uvicorn still has incompatible singleton state.

### 3.2 Queue / worker pool

```python
# hoga/api/captures.py — state singletons
_queue:   collections.deque[QueueItem]
_active:  dict[item_id, QueueItem]         # |_active| ≤ _max_concurrent
_done:    list[QueueItem]                  # terminal items; cleared by Dismiss Done
_lock:    asyncio.Lock                     # protects queue/active/done mutations
_queue_paused: bool = False                # set when cookie expires across the pool
_max_concurrent: int = int(os.environ.get("HOGA_MAX_CONCURRENT", "3"))
```

- **Worker scheduler:** N coroutines (one per concurrent slot). Each loops: acquire lock → pop from `_queue` if not paused → release lock → run item → on terminal, emit `capture_finished` → loop. Backpressure via an `asyncio.Event` (`_wakeup`) that `POST /items` sets when adding to an empty queue.
- **Adding items** while `_active` is non-empty is allowed (the singleton constraint of the prior spec is lifted).
- **`_max_concurrent` is env-var configurable** but no UI knob; default 3 matches observed safe limit.

### 3.3 Routes

| Route | Purpose |
|---|---|
| `GET /api/symbols?q={query}&limit=20` | Search symbols by Korean name (substring) or Code (prefix). Returns `[{code, name, market, captured_count}]` sorted by match quality. Backed by in-memory cache. |
| `POST /api/symbols/refresh` | Force-refresh the pykrx cache synchronously. Returns `{fetched_at_ms, count}`. |
| `GET /api/symbols/all` | Bulk dump of the cached list (≈6,000 rows, ~300KB). Frontend uses this for client-side filtering after one initial fetch. |
| `GET /api/inventory/calendar?code={code}&year={yyyy}&month={mm}` | Status map for one symbol's one month: `[{date: "YYYYMMDD", status: "complete"|"source_partial"|"client_incomplete"|"none"|"weekend"|"holiday"|"future"|"today_locked", captured_at_ms?: number}]`. |
| `POST /api/captures/items` | Enqueue. Body: `{code, start_date, end_date, force_retry: bool}` OR `{code, dates: ["YYYYMMDD", ...]}`. Returns the array of newly enqueued items with assigned `item_id`s. |
| `GET /api/captures/queue` | Full queue snapshot: `{active: [...], queued: [...], done: [...], paused: bool, max_concurrent: int}`. |
| `POST /api/captures/items/{item_id}/cancel` | Row-level cancel. queued → remove; active → signal cancel_token; terminal → 409. |
| `POST /api/captures/cancel-all` | Signal cancel on all active + drain queue. |
| `POST /api/captures/queue/resume` | After cookie pause: unset `_queue_paused`, re-queue any items that were cancelled by the pause (those with `pause_origin=True`). |
| `DELETE /api/captures/done` | Clear all terminal items from `_done`. |

**Backward compatibility:** the prior spec's `POST /api/captures`, `GET /api/captures/latest`, `POST /api/captures/latest/cancel`, `DELETE /api/captures/latest` are removed (the single-capture UI they served no longer exists). No deprecation period — this is a hard cut. If the implementer wants a one-week shim, it can wrap `POST /api/captures` to call `POST /api/captures/items` with `start_date == end_date == date`; not required by this spec.

### 3.4 SSE events (extends `hoga/api/sse.py` bus)

All payloads carry `item_id`, `code`, `date` for client-side filtering.

| Event name | When emitted | Payload (additional fields) |
|---|---|---|
| `capture_queued` | `POST /api/captures/items` resolves | `{items: [QueueItem, ...]}` — full snapshot of newly added items |
| `capture_phase` | item transitions: deciding → capturing → parsing | `{phase, decided_action?: "skip_complete"|"skip_source_partial"|"resume"|"fresh"}` |
| `capture_progress` | every `_write_progress` inside collector | `{phase, pages_done, events_seen, frontier_ms, estimate_pct, elapsed_ms}` |
| `capture_finished` | terminal: done/failed/cancelled/skipped | `{phase, result?: CaptureResult, error?: CaptureError, skip_reason?: "already_complete"|"source_partial"}` |
| `capture_queue_paused` | cookie expired, queue auto-paused | `{reason: "cookie_expired", message}` |
| `capture_queue_resumed` | `POST /queue/resume` succeeded | `{}` |
| `capture_queue_drained` | `len(_active)==0` and `len(_queue)==0` (and not paused) | `{total_done, total_failed, total_cancelled, total_skipped}` |

**No event throttling** in v1+2 (carried from prior spec rationale). Bus queue capacity is 64; even N=3 workers emitting at ~5 events/sec each is 15/sec, well within budget.

### 3.5 Completeness — two bits on meta.json

```python
# hoga/parser/... (sketch)
def write_meta(...):
    # collection_complete: did the collector exit via natural termination?
    # Source: _progress.json["finished"] written by orchestrator on the path
    # where Page Step loop hits `t >= DATA_WINDOW_END_MS + N empty pages`.
    collection_complete = progress_json.get("finished", False)

    # is_partial: does the captured data actually cover the full Data Window?
    last_event_ms = max(snapshots_max_ts, trades_max_ts)
    has_gap = _has_meaningful_gaps(snapshots_df)  # ≥1 minute consecutive empty
    is_partial = (last_event_ms < CHART_FINAL_TIME_MS) or has_gap

    meta["collection_complete"] = collection_complete
    meta["is_partial"] = is_partial
```

**Status derivation table** (consumed by calendar endpoint and worker `deciding` phase):

| `meta.json` present? | `collection_complete` | `is_partial` | Status |
|---|---|---|---|
| Yes | True  | False | `complete` |
| Yes | True  | True  | `source_partial` |
| Yes | False | any   | `client_incomplete` (rare drift case) |
| No, but `data/raw/{date}/{code}/` exists with files | — | — | `client_incomplete` |
| No raw, no parquet | — | — | `none` |

### 3.6 `has_meaningful_gaps` (initial heuristic)

```python
def _has_meaningful_gaps(snapshots_df) -> bool:
    """≥1 minute consecutive empty in continuous-trading hours.

    Excludes the Auction Window (15:20-15:30) where trade absence is normal;
    snapshots are still emitted continuously through auction so the heuristic
    only triggers on real outages."""
    in_session = snapshots_df[(snapshots_df.ts_ms >= SESSION_OPEN_MS) &
                              (snapshots_df.ts_ms <= CHART_FINAL_TIME_MS)]
    gaps_ms = in_session.ts_ms.diff().dropna()
    return (gaps_ms >= 60_000).any()
```

Initial cut intentionally crude; refined after observing real data in v1+3.

### 3.7 Cookie-expired pool pause

When a worker raises `CookieExpiredError` (covers 401/403 — both have the same recovery action):

```python
async def _handle_cookie_expired(item):
    async with _lock:
        if _queue_paused: return                      # idempotent
        _queue_paused = True
        for other in list(_active.values()):
            if other.id == item.id: continue
            other.pause_origin = True
            other.cancel_token.cancel()
    publish(CaptureQueuePausedEvent(reason="cookie_expired", message=...))

# POST /queue/resume:
async def _resume_queue():
    async with _lock:
        _queue_paused = False
        # Items cancelled BY the pause go back to the front of the queue.
        for it in _done:
            if it.pause_origin and it.phase == "cancelled":
                it.phase = "queued"; it.pause_origin = False
                _queue.appendleft(it)
        _done = [it for it in _done if not it.pause_origin]
    publish(CaptureQueueResumedEvent())
```

### 3.8 429 backoff per item

```python
async def _capture_with_backoff(item):
    delays = [5.0, 10.0, 30.0]
    for attempt, delay in enumerate(delays + [None]):  # last try, no delay reset
        try:
            return await _run_collector(item)
        except RateLimited429:
            if delay is None: raise                    # 4th attempt → propagate
            await asyncio.sleep(delay)
            continue
```

3 retries with exponential backoff (~45s total). Beyond that the item is `failed`; the queue continues with the next item (rate limit is per-request not per-cookie, so other items may succeed).

### 3.9 Data migration

Existing `meta.json` files (effectively none in current state) without the two new fields default safely:

```python
# hoga/api/queries.py (additions)
collection_complete = bool(meta.get("collection_complete", False))
is_partial = bool(meta.get("is_partial", True))   # conservative: assume partial if unknown
```

The conservative defaults mean legacy meta is shown as `client_incomplete` in the calendar — visually distinct from `complete`/`source_partial`/`none`, and the worker's `deciding` phase will run a Resume to upgrade it. No batch migration tool ships in this PR; a CLI helper `hoga reparse --all` is captured as a follow-up.

---

## 4. Frontend Architecture

### 4.1 File layout

```
frontend/src/
  pages/Capture.tsx                       # layout: split (controls left | queue right)
  capture/
    CaptureForm.tsx          [rewritten]  # SymbolSearch + DateRangePicker + options + Start
    SymbolSearch.tsx         [new]        # input + rich dropdown
    DateRangePicker.tsx      [new]        # 2-month grid + corner-badge markers + range select
    CalendarCell.tsx         [new]        # single date cell with status badge
    CaptureQueue.tsx         [new]        # table with header summary + Cancel All + Dismiss Done
    CaptureQueueRow.tsx      [new]        # single row + expand-for-detail
    CaptureRowDetail.tsx     [new]        # last 5 log lines + full metadata
    useSymbols.ts            [new]        # 1-time bulk fetch + client-side filter
    useCalendar.ts           [new]        # per-(code, year, month) markers
    useCaptureQueue.ts       [rewritten]  # queue snapshot + SSE multiplex + mutations
  nav/
    CaptureStatusPill.tsx    [rewritten]  # queue summary ("3 capturing · 5 queued · ~3m")
  api/
    symbols.ts               [new]        # GET /api/symbols/all, GET /api/symbols, POST /refresh
    calendar.ts              [new]        # GET /api/inventory/calendar
    captures.ts              [rewritten]  # queue endpoints
    sse.ts                   [extended]   # subscribeToCaptureEvents extended for new event types
    types.ts                 [extended]   # QueueItem, SymbolHit, CalendarCell, new SSE event union
```

### 4.2 Component responsibilities

**`SymbolSearch`** — controlled input. Detection rule: `^\d+$` → Code prefix match; else → Korean/English name substring match. Results pulled from `useSymbols()` cache, filtered with `useMemo`, sorted by (prefix > substring) then by name length. Each row renders name (with matched fragment highlighted in `--accent` tint), code (Geist Mono), market chip (KOSPI/KOSDAQ in `--fg-dim` 8.5px), and capture count (`--accent` if > 0, else `--fg-dim`). Keyboard: ↑↓ navigate, Enter select, Esc close, Tab from input → first row.

**`DateRangePicker`** — renders 2 months side by side (current + next). Range selection: click 1 = `start_anchor`, click 2 = `end_anchor` (swap if reversed); subsequent clicks reset to new start. Disabled states (cursor: not-allowed, color: `--fg-dimmer`): weekends, holidays (from calendar endpoint), future dates, today-before-18:00-KST. Marker badges (top-right corner of cell): ✓ `--up`, ⚠ `--warn`, ✕ `--down`. Hover tooltip: for `complete`/`source_partial` shows `{date} · {code} · {status} · captured {relative_time}`; for `client_incomplete` adds `({pages} raw pages on disk)`; for `weekend`/`holiday`/`future`/`today_locked` shows just the reason.

**`CaptureForm`** — composes Search + Picker + options panel (force_retry toggle) + Start button. Validation: symbol selected AND start ≤ end AND range non-empty after filtering. On Start success: form resets (symbol cleared, range cleared). Form remains interactive during running queue — Start always allowed when valid.

**`CaptureQueue`** — header summary line + Cancel All + Dismiss Done + table. Default sort: in-progress first (deciding/capturing/parsing), then queued, then terminal (done/skipped/cancelled/failed). For queue length > 200, wrap rows in `@tanstack/react-virtual` (new dep, ~10KB).

**`CaptureQueueRow`** — single row: status icon, date, code, name, phase chip, pages, events, mini progress bar (estimate_pct width). Right-side action: queued shows ✕ (remove from queue), active shows cancel button, failed shows ↻ (retry — re-enqueues with same params), done/skipped show nothing. Clicking the row toggles `CaptureRowDetail` underneath.

**`CaptureRowDetail`** — last 5 log lines (from a ref buffer per item) + full item metadata (started_at_ms, frontier_ms, error message verbatim if any).

### 4.3 Hooks

```ts
// useSymbols.ts — 1 fetch per session, 24h client staleTime aligned with server TTL
function useSymbols() {
  return useQuery({
    queryKey: ['symbols', 'all'],
    queryFn: () => api.getAllSymbols(),
    staleTime: 24 * 60 * 60 * 1000,
  });
}
function useSymbolSearch(query: string): SymbolHit[] {
  const { data } = useSymbols();
  return useMemo(() => filterSymbols(data ?? [], query, 20), [data, query]);
}

// useCalendar.ts — per (code, year, month) marker map
function useCalendar(code: string | null, year: number, month: number) {
  return useQuery({
    queryKey: ['calendar', code, year, month],
    queryFn: () => api.getCalendar(code!, year, month),
    enabled: code !== null,
    staleTime: 60_000,
  });
}
// SSE capture_finished patches this cache for the matching (code, date)
// rather than refetching whole month.

// useCaptureQueue.ts — full queue snapshot + SSE multiplex
function useCaptureQueue() {
  const qc = useQueryClient();
  const queue = useQuery({
    queryKey: ['capture', 'queue'],
    queryFn: () => api.getQueue(),
    staleTime: 0,
  });
  useEffect(() => subscribeToCaptureEvents((e) => {
    if (e.type === 'capture_progress') {
      qc.setQueryData(['capture', 'queue'], patchItem(e.item_id, { progress: e.progress, phase: e.phase }));
    } else if (e.type === 'capture_phase') {
      qc.setQueryData(['capture', 'queue'], patchItem(e.item_id, { phase: e.phase }));
    } else if (e.type === 'capture_finished') {
      qc.invalidateQueries({ queryKey: ['capture', 'queue'] });
      // also patch the calendar cell for (e.code, e.date) without refetching
      qc.setQueryData(['calendar', e.code, year(e.date), month(e.date)], patchCell(e.date, e.phase, e.skip_reason));
    } else if (e.type === 'capture_queued' || e.type === 'capture_queue_paused' || e.type === 'capture_queue_resumed') {
      qc.invalidateQueries({ queryKey: ['capture', 'queue'] });
    }
  }), [qc]);

  const addItems = useMutation({ mutationFn: api.addItems, onSuccess: () => qc.invalidateQueries(['capture', 'queue']) });
  const cancelItem = useMutation({ mutationFn: api.cancelItem });
  const cancelAll = useMutation({ mutationFn: api.cancelAll });
  const dismissDone = useMutation({ mutationFn: api.dismissDone });
  const resumeQueue = useMutation({ mutationFn: api.resumeQueue });
  return { queue: queue.data, addItems, cancelItem, cancelAll, dismissDone, resumeQueue };
}
```

**Why `invalidateQueries` (not `setQueryData`) on `addItems` success:** an SSE `capture_queued` event can arrive between the POST response landing and `onSuccess` running. Setting the response payload would race with the SSE-driven cache. Invalidating triggers a fresh `GET /queue` that reads the same in-memory state the SSE is publishing from — no regression possible. Same pattern as the prior single-capture spec.

### 4.4 Layout (per Q10 = A)

```
┌───────────────────────────────────────────────────────────────────────┐
│  /capture                                                              │
├─────────────────────────────────┬─────────────────────────────────────┤
│  CONTROLS (left, 38%)            │  QUEUE (right, 62%)                  │
│                                  │                                      │
│  ┌ Symbol ─────────────────────┐ │  Header: "12 of 25 done · 2 failed   │
│  │ [SymbolSearch input]        │ │           · 3 capturing · ~5m"        │
│  └─────────────────────────────┘ │  [Cancel All] [Dismiss Done]         │
│                                  │  [progress bar — overall fraction]   │
│  ┌ Date Range ────────────────┐ │                                      │
│  │ [DateRangePicker 2-mo grid]│ │  Table (per-date rows):              │
│  └────────────────────────────┘ │   status | date | code | name |       │
│                                  │   phase | pages | events | bar | ✕   │
│  ┌ Options ───────────────────┐ │                                      │
│  │ ☐ ⚠ Force re-capture       │ │  (expanded row shows detail panel)   │
│  │     source-partial         │ │                                      │
│  └────────────────────────────┘ │                                      │
│                                  │                                      │
│  [▶ Start Capture (N dates)]     │                                      │
│                                  │                                      │
│  Calendar legend:                │                                      │
│   ✓ complete  ⚠ partial          │                                      │
│   ✕ broken    🔒 today<18:00      │                                      │
└─────────────────────────────────┴─────────────────────────────────────┘
```

### 4.5 LeftNav pill

Replaces the single-job pill from the prior spec. Renders `null` when `len(_active) == 0 AND len(_queue) == 0` (terminal-only states only visible on `/capture`).

While anything is active or queued:
- Pulsing teal dot (`--accent`, 1.5s ease-in-out opacity 1↔0.4) — already in `global.css`.
- Label `CAPTURING` (uppercase, 9.5px, `--accent`, letter-spacing 0.08em).
- Stats line: `{active_count} capturing · {queued_count} queued · ~{eta}m` (Geist Mono, 10px, `--fg-dim`, `tabular-nums`).
- Whole pill is a `<Link to="/capture">`.
- When `_queue_paused`, replace the pulsing dot with a static amber dot (`--warn`) and label `PAUSED`. Stats line: `Cookie expired — click to resume`.

### 4.6 URL state

`/capture` does not participate in URL state. Form is ephemeral; queue is server-memory. Reloading mid-capture re-fetches the queue and continues showing live progress. No shareable URL (capture is a workflow trigger; shareable artifacts are `/replay` URLs after completion).

---

## 5. State Machine & Data Flow

### 5.1 QueueItem state machine

```
                  ┌──────────┐
   POST add ─────►│  queued  │
                  └────┬─────┘
       worker pulls    │  (or POST /items/{id}/cancel → cancelled)
                       ▼
                  ┌──────────┐    skip (already_complete | source_partial)
                  │ deciding ├────────────────────────────────────────► skipped
                  └────┬─────┘
                       │ fresh | resume
                       ▼
                  ┌──────────┐
                  │capturing │  ─── 429 → backoff → retry
                  └────┬─────┘  ─── CaptureCancelled → cancelled
                       │             (raw preserved on disk)
                       │ collector OK
                       ▼
                  ┌──────────┐
                  │ parsing  │  ─── parser error → failed
                  └────┬─────┘
                       │ parse OK
                       ▼
                  ┌──────────┐
                  │   done   │
                  └──────────┘

Terminal:    done · skipped · cancelled · failed
Pre-terminal: queued · deciding · capturing · parsing
```

### 5.2 Worker algorithm (one of N=3 coroutines)

```python
async def _worker_loop():
    while not _shutdown:
        async with _lock:
            if _queue_paused or len(_active) >= _max_concurrent or not _queue:
                await _wakeup.wait(); _wakeup.clear(); continue
            item = _queue.popleft()
            item.phase = "deciding"
            _active[item.id] = item
        publish(CapturePhaseEvent(item, phase="deciding"))

        try:
            state = _check_disk_state(item.code, item.date)
            if state in (COMPLETE, SOURCE_PARTIAL):
                if state == SOURCE_PARTIAL and item.force_retry:
                    pass  # fall through to fresh capture
                else:
                    item.phase = "skipped"
                    item.skip_reason = "already_complete" if state == COMPLETE else "source_partial"
                    publish(CaptureFinishedEvent(item))
                    continue

            resume_flag = (state == CLIENT_INCOMPLETE)
            item.phase = "capturing"; publish(CapturePhaseEvent(item, phase="capturing"))
            await _capture_with_backoff(item, resume=resume_flag)

            item.phase = "parsing"; publish(CapturePhaseEvent(item, phase="parsing"))
            await _parse(item)
            item.phase = "done"
        except CookieExpiredError as exc:
            item.phase = "failed"; item.error = _map_error(exc)
            await _handle_cookie_expired(item)
        except CaptureCancelled:
            item.phase = "cancelled"
        except Exception as exc:  # noqa: BLE001 — terminal failure path
            item.phase = "failed"; item.error = _map_error(exc)
        finally:
            publish(CaptureFinishedEvent(item))
            async with _lock:
                _active.pop(item.id, None)
                _done.append(item)
                if not _queue and not _active and not _queue_paused:
                    publish(CaptureQueueDrainedEvent(...))
                _wakeup.set()
```

### 5.3 Calendar marker computation

`GET /api/inventory/calendar?code=…&year=…&month=…` iterates the trading-day list for that month (pykrx), computes a status for each date:

```python
def _date_status(code, date, now_kst):
    if date > today(now_kst):                                return "future"
    if date == today(now_kst) and now_kst.hour < 18:         return "today_locked"
    if date not in trading_days_for(year(date), month(date)): return "weekend" if is_weekend(date) else "holiday"
    return _disk_state_to_status(_check_disk_state(code, date))
```

The endpoint also includes `captured_at_ms` for `complete`/`source_partial`/`client_incomplete` so the hover tooltip can show recency.

### 5.4 End-to-end data flow

```
  Browser                                FastAPI
    │  GET /api/symbols/all (one-time)      │
    │ ◄── [≈6000 SymbolHit, 300KB] ─────────│
    │  GET /api/inventory/calendar?…        │
    │ ◄── [date→status map for one month] ──│
    │                                       │
    │  POST /api/captures/items {range}     │
    │ ────[expand to trading days,         ─►
    │      append to _queue]               ─│
    │ ◄── SSE capture_queued (N items) ─────│
    │                                       │
    │       workers (≤N=3) tick:            │
    │ ◄── SSE capture_phase (deciding) ─────│
    │ ◄── SSE capture_phase (capturing) ────│
    │ ◄── SSE capture_progress × many ──────│
    │ ◄── SSE capture_phase (parsing) ──────│
    │ ◄── SSE capture_finished (done) ──────│
    │ ◄── SSE inventory_added (existing) ───│
    │                                       │
    │  (form interactive throughout)        │
    │  POST /api/captures/items {another}   │
    │ ────[append to _queue]───────────────►│
    │ ◄── SSE capture_queued ────────────────│
    │                                       │
    │  POST /items/{id}/cancel (row cancel) │
    │ ────[cancel_token.cancel()]──────────►│
    │ ◄── SSE capture_finished (cancelled) ─│
```

---

## 6. Design System Conformance

All visual choices map to `DESIGN.md` tokens. No new tokens introduced.

**Calendar cell.**
- Base: 32×32px square, `border-radius: 4px`, `font: 500 12px Geist Mono`, `tabular-nums`.
- Idle: `color: --fg`. Weekend/holiday: `color: --fg-dimmer`, `cursor: not-allowed`. Future: same as weekend. Today-locked: `color: --fg-dim` + 🔒 in top-right.
- Hover (enabled cells): `background: --bg-input-hover`.
- Range mid: `background: rgba(20,184,166,0.18)`. Range endpoints: `background: --accent`, `color: --bg`.
- Status badge (top-right, 9px, line-height 1): `complete` ✓ `--up`, `source_partial` ⚠ `--warn`, `client_incomplete` ✕ `--down`.

**Symbol search row.**
- Padding 8×10px. Hover/selected: `background: rgba(20,184,166,0.10)`.
- Name: `Geist Sans 13px --fg`. Matched fragment: `background: rgba(20,184,166,0.20)`, `color: --accent`.
- Code: `Geist Mono 500 11px --fg-dim tabular-nums`.
- Market chip: 1px border `--border-strong`, 0×4px padding, `Geist Sans 600 8.5px`, letter-spacing 0.06em, `color: --fg-dim`.
- Capture count: `Geist Mono 500 10px`. `--accent` if > 0, else `--fg-dimmer`.

**Queue row.**
- 36px row height, alternating no background (rely on `--border` separator).
- Status icons match calendar: ✓ ⚠ ✕ ○ ● (● = active capturing, pulsing).
- Phase chip: same color rules as prior spec (capturing/parsing teal tint, done up tint, failed down tint, skipped/cancelled fg-dim tint).
- Mini progress bar: 2px height, `--bg-input` track, `--accent` fill width = `estimate_pct`.

**Header summary.** `Geist Mono 11px`. Numbers in `tabular-nums`. Overall progress bar 4px height, `--bg-input` track, `--accent` fill = (done + skipped) / total.

**Color discipline** (per `DESIGN.md`): teal for UI state, up/down for data semantics. Calendar markers use up/down/warn for *data states* (complete = up, broken = down, partial = warn), so they conform; the cell selection highlight is teal because that's a UI state. The two systems don't mix on a single visual axis.

---

## 7. Testing Strategy

### 7.1 Backend (`pytest`)

`tests/test_api_symbols.py`
- `test_symbols_cache_lazy_refresh` — TTL expired → next GET returns stale + triggers background refresh
- `test_symbols_search_by_name` — `q=삼성` → expected ranked matches
- `test_symbols_search_by_code` — `q=00593` → 005930 prefix
- `test_symbols_manual_refresh` — POST /refresh → synchronous fetch + new data on next GET
- `test_symbols_pykrx_failure_keeps_stale` — pykrx raises → cache unchanged + 200 response

`tests/test_api_calendar.py`
- `test_calendar_returns_status_per_date`
- `test_calendar_marks_weekends_and_holidays` (pykrx trading-day list integration)
- `test_calendar_future_dates_marked`
- `test_calendar_today_locked_before_18_kst` (mocked clock at 16 KST → today_locked; at 18:01 → normal status)

`tests/test_api_captures_queue.py`
- `test_add_items_expands_date_range` — trading-day-only expansion
- `test_add_items_to_running_queue` — singleton constraint absent; queue continues
- `test_worker_concurrency_capped_at_max`
- `test_deciding_skips_complete`
- `test_deciding_skips_source_partial`
- `test_deciding_resumes_client_incomplete`
- `test_force_retry_overrides_source_partial_skip`
- `test_429_backoff_then_failed` — 4× 429 → failed; 3× 429 then success → done
- `test_cookie_expired_pauses_queue` — first 401 → all active cancelled + queue paused
- `test_resume_queue_reenqueues_pause_cancelled` — items cancelled by pause go to front of queue
- `test_cancel_item_queued` / `..._capturing` / `..._terminal_409`
- `test_cancel_all` — drains queue + cancels active
- `test_dismiss_done` — only terminals removed; active untouched
- `test_queue_drained_event_after_all_terminal`

`tests/test_parser_completeness.py`
- `test_meta_has_collection_complete_field` (natural-termination fixture)
- `test_meta_has_is_partial_field` (last-event-before-CHART_FINAL_TIME_MS fixture)
- `test_is_partial_detects_meaningful_gaps`
- `test_missing_progress_finished_defaults_to_false`

`tests/test_collector_progress_finished.py`
- `test_finished_true_on_natural_termination`
- `test_finished_false_on_cancel`
- `test_finished_false_on_exception`

### 7.2 Frontend (`vitest` + Testing Library)

`SymbolSearch.test.tsx` — input detection (numeric vs Hangul), dropdown rendering, keyboard nav, callback shape.

`DateRangePicker.test.tsx` — range select with swap, disabled cells unclickable, markers render per status, `useCalendar` invalidation on symbol change.

`CaptureForm.test.tsx` — validation, form reset on success, "Start" always allowed during running queue.

`CaptureQueue.test.tsx` — header summary computation, Cancel All / Dismiss Done dispatch, virtualization activates for >200 items.

`CaptureQueueRow.test.tsx` — per-phase icon/chip, row expand toggles detail, per-action button matches phase (✕ vs cancel vs ↻).

`useCaptureQueue.test.ts` — SSE `capture_progress` patches item; `capture_finished` invalidates queue + patches calendar cell; pause/resume events update UI; `capture_queued` invalidates.

`useSymbols.test.ts` — single GET on mount, useSymbolSearch returns filtered list.

### 7.3 E2E (Playwright)

Production `POST /api/captures/items` is the entry point; `FakeHogaplayClient` is swapped in via DI under `HOGA_ENABLE_TEST_ENDPOINTS=1` (pattern carried from prior spec).

`frontend/tests/e2e/range-capture.spec.ts`
1. `/capture` → SymbolSearch "삼성" → click "삼성전자 005930"
2. Calendar → click two cells (3 trading days)
3. Start → 3 rows in queue, `capture_queued` SSE arrives
4. Watch phase transitions (deciding → capturing → parsing → done) via `data-testid="capture-phase"`
5. Queue header "3 of 3 done"
6. SymbolSearch a second symbol → pick range → Start → 3 more rows appended (multi-symbol queue)
7. Cancel All → all rows transition to cancelled / removed appropriately
8. Dismiss Done → terminal rows cleared, form-only state

`frontend/tests/e2e/calendar-markers.spec.ts`
1. Fixture sets up `data/parquet/20260501/005930/` (complete), `20260502/.../` (source_partial), `data/raw/20260503/005930/` (client_incomplete)
2. `/capture` → search → 005930
3. Calendar shows ✓ on 1, ⚠ on 2, ✕ on 3; weekends dimmed; today before 18 KST shows 🔒
4. Click complete date → Start → row immediately reaches `skipped/already_complete` (no collector call)
5. Toggle "force re-capture" → Start on source_partial date → fresh capture runs

`frontend/tests/e2e/cookie-pause.spec.ts`
1. Fake client configured to raise `CookieExpiredError` on the 3rd request
2. Start a 5-day range → first 2 succeed → 3rd triggers pause
3. UI shows pause banner + paused pill in LeftNav
4. Fake client switched to success mode → click Resume → remaining 3 items run to completion

### 7.4 Manual verification

- Real hogaplay with N=3 — confirm no 429s under normal use (matches user's observed 3-tab safe pattern)
- Cookie rotation mid-queue — pause/resume UX feels right end-to-end
- Queue of 100+ items — virtualization stays smooth; header eta is plausible

---

## 8. User-Visible Behavior Catalog

- **Form is always interactive.** During a running queue, you can still pick another symbol, another range, and press Start — those items append.
- **Calendar reflects on-disk truth.** Markers come from the same code path that backs the deciding phase; what you see in the calendar is exactly what the worker will decide.
- **Today is locked before 18:00 KST.** This is independent of the Data Window close at 16:00 — the 2-hour buffer accounts for hogaplay's aggregation delay.
- **Non-trading days are invisible to the queue.** A 20-calendar-day range typically yields ~14 queue items.
- **Complete dates are skipped silently.** They appear in the queue as `skipped/already_complete` and the worker moves on. Recapture them with the "force re-capture" toggle if needed.
- **Server restart loses queue.** Raw on disk survives; re-submitting the range resumes incomplete items.
- **Reload survives.** Browser reload re-fetches `GET /queue` and continues live progress.
- **Cookie expiry pauses everything.** A single 401 freezes all workers. Banner + LeftNav pill amber-pulse "PAUSED". Refresh `.cookie` on disk, click Resume.
- **Cross-page survival.** LeftNav pill stays visible on `/inventory` and `/replay` while the queue is running.
- **Inventory auto-update.** Existing `inventory_added` SSE event still fires after each item's parse — Inventory page list refreshes per item.

---

## 9. Risks · Out-of-Scope · Follow-ups

### 9.1 Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| pykrx fetch breaks (KRX endpoint change, IP block) | Low–Med | Search degrades | Keep stale cache; banner after 7 days stale; graceful degrade to code-only search |
| N=3 against same cookie triggers 429 | Low (user-observed safe at 3) | Brief stalls | Exponential backoff (5/10/30s) per item; queue continues |
| Cookie expiry mid-queue | Medium | All active fail | Single 401 triggers pool pause; user Resume after `.cookie` refresh |
| Queue explosion (1 year × 50 symbols ≈ 12,000 items) | Low (intentional) | UI/memory pressure | Virtualization for table; ETA shown in header (`Queue size: 12000 — ~5h`) |
| Worker task leak on cancel | Low | Zombie active slot | `finally` always pops `_active`; watchdog checks `last_progress_at > 30s` stale |
| Calendar fetch every page entry → stat fs all month | Med | Server overhead | `useQuery` staleTime 60s; SSE `capture_finished` patches the affected cell only |
| Legacy meta.json without new fields → marked broken | Low (disk empty now) | One force-retry per legacy date | Conservative defaults make legacy data show as `client_incomplete`; Resume corrects it on next capture |
| `finished:true` marker change breaks CLI flows | Low | CLI regression | Collector signature unchanged; new field on `_write_progress` is additive; CLI behavior asserted by snapshot test |
| Multi-worker uvicorn breaks queue state | Low | Silent corruption | Existing import-time assert refuses boot when `WEB_CONCURRENCY > 1` (carried from prior spec) |

### 9.2 Out of scope

- Multi-symbol multi-select in one form (use Start-append pattern instead)
- Cookie editing UI (still file/env based)
- Scheduled/cron captures
- Multi-symbol overlay on the calendar
- Queue persistence across server restarts
- Light mode
- "Recently used" personalization in symbol search beyond the simple sort

### 9.3 Open follow-ups

- Refine `_has_meaningful_gaps` after observing real data
- `hoga reparse --all` CLI helper for batch meta regeneration on legacy raw
- Desktop notification (Notifications API) on `capture_queue_drained`
- Queue export to CSV
- Performance pass on calendar marker fetch if profiling shows file-stat dominance

---

## 10. Implementation order (preview, full plan to follow in writing-plans skill)

1. **Backend completeness bits** — collector `finished:true` marker; parser computes `collection_complete` + `is_partial`; queries surface both.
2. **Symbol cache + endpoints** — pykrx integration, `/api/symbols/all`, `/api/symbols`, `/api/symbols/refresh`.
3. **Calendar endpoint** — `/api/inventory/calendar` with trading-day + status logic.
4. **Queue + worker pool** — replace `_latest` singleton; implement `_queue`, `_active`, scheduler, deciding phase, 429 backoff, cookie pause.
5. **New SSE event topics** — extend bus + frontend `subscribeToCaptureEvents`.
6. **Frontend hooks** — `useSymbols`, `useCalendar`, `useCaptureQueue`.
7. **Frontend components** — `SymbolSearch`, `DateRangePicker`, `CaptureForm` (rewrite), `CaptureQueue`, `CaptureQueueRow`, `CaptureRowDetail`.
8. **LeftNav pill rewrite.**
9. **Remove old single-capture endpoints + tests; add range tests.**
10. **E2E + manual verification on real hogaplay.**

---

## 11. Grilling Outcomes (2026-05-21, post-`/grill-with-docs`)

Eight follow-up clarifications that supersede or extend the corresponding sections above. The Decisions Log (§2) is appended with Q14–Q21 below; sections 1, 3, 4, 5, 7, 9, 10 are amended as noted.

### Q14. 18:00 KST today-lock is backend-enforced, not UI-only — `allow_partial` removed

**Decision.** The 18:00 KST today-eligibility cutoff is a single backend-enforced rule, mirrored in the UI. `allow_partial` is removed from the form, from the request body, and from the deciding-phase code path. Rationale: the only legitimate use case for `allow_partial` (capture today before Data Window close) is now covered by the 18:00 rule (no capture before 18 KST), and keeping the option creates a UI/backend asymmetry.

**Amendments:**

- **§1.2 In scope** — strike "`allow_partial` option" from the bullet 7 ("Single capture flow removed…"). Add bullet: "Remove `allow_partial` from the form, the request body, and the deciding-phase code path. Superseded by the 18:00 KST rule."
- **`hoga/collector/orchestrator.py`** — keep `_DATA_WINDOW_CLOSE_HOUR = 16` (semantic meaning: when Data Window closes, separate concept). Remove the `allow_partial` parameter from `collect_stock_date` and `PartialCaptureRefused`. The rename to `_DATA_WINDOW_CLOSE_HOUR` already happened in the predecessor spec.
- **§3.3 Routes — `POST /api/captures/items`** — backend rejects with `400` `code="today_too_early"` if any date in the requested range equals today and `now_kst.hour < 18`. The body lists the offending date(s).
- **§3.2 Worker pool** — deciding phase additionally checks `_today_too_early(item.date)` and immediately marks `failed` with `code="today_too_early"`. This is defense-in-depth — the route guard should normally prevent this, but a date that was 17:59 at enqueue and 18:00 at deciding still needs the guard (race window exists).
- **Frontend** — `DateRangePicker` disables today's cell visually (🔒) before 18 KST; `useEffect` re-evaluates every 60s so the cell unlocks live without a reload.

### Q15. Enqueue dedupe + per-(code, date) inflight lock — two layers

**Decision.** Two layered protections against duplicate (code, date) processing:

- **Layer 1 — enqueue-time dedupe.** `POST /api/captures/items` examines the union of `_queue`, `_active`, and `_inflight_paths`; (code, date) pairs already present are dropped from the request. Response body includes `{enqueued: [...], deduped: [{code, date, reason: "already_in_queue" | "already_running"}]}`.
- **Layer 2 — per-(code, date) inflight lock.** New singleton `_inflight_paths: set[tuple[code, date]]`. Worker enters `deciding` phase under `_lock`, adds (code, date) to `_inflight_paths`; if already present, the worker requeues the item to the back of `_queue` and exits the slot. Removed in the worker's `finally`.

**Amendments:**

- **§3.2 Queue / worker pool — state singletons** — add `_inflight_paths: set[tuple[str, str]]  # (code, date) pairs currently in deciding/capturing/parsing`.
- **§3.3 Routes — `POST /api/captures/items`** — response shape updated to include `deduped: [...]`.
- **§5.2 Worker algorithm** — at the top of the deciding block, under `_lock`: `if (item.code, item.date) in _inflight_paths: _queue.append(item); _active.pop(item.id); continue` else add to `_inflight_paths`. In `finally`, remove from `_inflight_paths`.
- **§7.1 Backend tests** — add: `test_enqueue_dedupes_duplicates_in_queue`, `test_enqueue_dedupes_active`, `test_worker_defers_when_inflight_collision`.

### Q16. `force_retry` is a Start-time snapshot, frozen into items

**Decision.** The `force_retry` toggle's value at the moment of `POST /api/captures/items` is captured into each newly enqueued `QueueItem` as a boolean field. Once enqueued, items do not respond to subsequent toggle changes. Per-row retroactive change is not supported in v1+2. Retry (↻) on a failed row re-enqueues with the **original** `force_retry` value; users wanting a different behavior cancel + re-Start with a different toggle.

**Amendments:**

- **§3.2 / models** — `QueueItem` gains `force_retry: bool` (frozen at enqueue).
- **§4.2 — `CaptureQueueRow`** — when `item.force_retry == true`, render a small `⚠ force` chip next to the row's status icon (style: same as the partial badge, smaller, no animation). Makes the "why is this source-partial date running" visually obvious.
- **§4.2 — `CaptureQueueRow` retry action** — `↻` re-enqueues using the row's existing `force_retry`; no inline override.
- **§7.2 Frontend tests** — add: `CaptureQueueRow.test.tsx::shows_force_chip_when_set`, `..::retry_preserves_force_retry`.

### Q17. `disk_state.py` extracted as horizontal seam; ADR-0007 supersedes ADR-0006's growth budget

**Decision.** A new module `hoga/api/disk_state.py` hosts:
- `class DiskState(Enum): NONE, CLIENT_INCOMPLETE, SOURCE_PARTIAL, COMPLETE`
- `def check_disk_state(data_dir, code, date) -> DiskState`
- `def has_meaningful_gaps(snapshots_df) -> bool`

Consumers: (a) worker deciding phase in `captures.py`, (b) `GET /api/inventory/calendar` in `calendar.py`, (c) parser when writing `meta.json`. The two-adapters rule from ADR-0006 is met: a second call site (calendar) appears that needs the same logic, and inlining it as `captures.py` private would mislead future readers about its scope.

`ADR-0007 — Capture module grows to queue + workers; disk_state extracted as horizontal seam` will be authored as the first task of the implementation plan, explicitly amending ADR-0006's growth-budget clause. The remainder of `captures.py` stays single-module per ADR-0006's spirit (queue state + workers + routes + cookie pause remain co-located).

**Amendments:**

- **§3.1 Module changes** — add row: `hoga/api/disk_state.py [new] — DiskState enum + check_disk_state + has_meaningful_gaps; shared by captures, calendar, parser`.
- **§3.5 Completeness** — note that the status derivation table is implemented in `disk_state.check_disk_state` (single source of truth).
- **§3.6 `has_meaningful_gaps`** — function moves from "in parser" to `disk_state.has_meaningful_gaps`; parser imports.
- **§5.3 Calendar marker computation** — `_disk_state_to_status` becomes a thin wrapper over `disk_state.check_disk_state` (plus the trading-day / future / today_locked overlays that are calendar-specific).
- **§10 Implementation order** — insert as step 0: "Author ADR-0007 amending ADR-0006; extract `disk_state.py` with stub `check_disk_state`."

### Q18. `captured_count` shows complete-only in the dropdown; full breakdown in tooltip

**Decision.** The `SymbolHit` wire model carries both a primary count and a breakdown:
```python
class SymbolHit(BaseModel):
    code: str
    name: str
    market: Literal["KOSPI", "KOSDAQ"]
    captured_count: int                  # complete only — the headline number
    captured_breakdown: dict[str, int]   # {"complete": N, "source_partial": M, "client_incomplete": K}
```

Dropdown row: `{N} complete` (e.g., "14 complete", "no complete data" if 0). Hover tooltip on the row: `Complete 14 · Partial 3 · Incomplete 2`.

**Amendments:**

- **§3.3 Routes — `GET /api/symbols`** — response items now carry `captured_count` (complete) and `captured_breakdown` (object).
- **§4.2 — `SymbolSearch`** — display rule updated: dropdown row primary = complete count; hover tooltip = breakdown.
- **§7.1 — `test_api_symbols.py`** — assert breakdown values match the four-state classification.

### Q19. pykrx cold start — 3-tier policy with status indicator

**Decision.** A three-tier cache policy:

- **Tier 1 — fire-and-forget prefetch at lifespan startup.** `hoga/api/app.py::lifespan` schedules `asyncio.create_task(symbols.ensure_cache_warm())` without awaiting. Boot stays fast.
- **Tier 2 — GET-time dedupe via Future.** `GET /api/symbols/all` checks cache freshness; on miss, takes a module-level `asyncio.Lock` and either starts a new fetch task or awaits the in-flight one (per-process Future dedupe). N concurrent GETs trigger exactly one pykrx call.
- **Tier 3 — fallback on fetch failure.** Last-known cache is served with `status="stale"` (or `"unavailable"` if no cache ever existed). UI degrades to code-only input mode when status is `unavailable`.

`GET /api/symbols/all` response envelope:
```python
class SymbolsAllResponse(BaseModel):
    symbols: list[SymbolHit]
    status: Literal["fresh", "loading", "stale", "unavailable"]
    fetched_at_ms: int | None
```

UI: small status indicator next to the `SymbolSearch` input — `loading dot` (loading), `green ●` (fresh), `amber ⏱` (stale + refreshing), `red !` (unavailable).

**Amendments:**

- **§3.1 Module changes** — note that `hoga/api/symbols.py` owns the prefetch task lifecycle and the GET-time Future dedupe.
- **§3.3 Routes — `GET /api/symbols/all`** — response shape updated to the envelope.
- **§4.2 — `SymbolSearch`** — render the status indicator; when `status == "unavailable"`, switch to code-only input with banner "종목 목록 미가용 — 6자리 코드로 직접 입력하세요."
- **§7.1 — `test_api_symbols.py`** — add: `test_concurrent_gets_dedupe_to_one_fetch`, `test_status_field_reflects_cache_state`, `test_lifespan_prefetch_schedules_task`.

### Q20. Cancel All in paused state resets everything

**Decision.** `POST /api/captures/cancel-all` is defined as "reset to idle" regardless of prior state. In paused state, it (a) drains the queue (all queued → cancelled), (b) cancels any active (already cancelled if pause happened; idempotent), (c) downgrades all `pause_origin=True` cancelled items in `_done` to plain `cancelled` (so Resume would no longer re-enqueue them), and (d) sets `_queue_paused = False`. Emits `CaptureQueueResumedEvent(reason="cancel_all")` if it was paused, followed by `CaptureFinishedEvent` per item cancelled.

**Amendments:**

- **§3.7 Cookie-expired pool pause** — the `_resume_queue` description retains pause-origin re-enqueue semantics. Add new paragraph documenting `cancel_all` behavior in paused state (per above).
- **§4.4 Layout** — the paused banner gains an explicit `Cancel All` button: `Cookie expired · [Refresh & Resume] [Cancel All]`.
- **§7.1 — `test_api_captures_queue.py`** — add: `test_cancel_all_in_paused_resets_queue_and_pause_flag`, `test_cancel_all_in_paused_downgrades_pause_origin_cancelled`.

### Q21. Calendar GET response carries `as_of_ms`; client reconciles with SSE patches

**Decision.** `GET /api/inventory/calendar?code&year&month` response gains a top-level `as_of_ms: int` (server wall-clock at the moment the cells were read). Client-side, the calendar query cache holds per-cell `patched_at_ms` populated by SSE handlers. When a new GET response arrives, the reconciler keeps any cell where `prev.patched_at_ms > incoming.as_of_ms` — i.e., SSE patches that landed after the response was generated are preserved.

**Amendments:**

- **§3.3 Routes — `GET /api/inventory/calendar`** — response shape gains `as_of_ms`.
- **§4.3 — `useCalendar`** — implement `setQueryData`-time reconciliation per Grill #8 sketch. SSE patch handler stamps `patched_at_ms = Date.now()` on the patched cell.
- **§7.2 Frontend tests** — add: `useCalendar.test.ts::reconciles_sse_patch_against_get_response`, `..::ignores_older_patch`.
- **§9.3 Open follow-ups** — add: "Inventory SSE storm dedupe — N=3 workers finishing in close succession cause N invalidations on `STOCK_DATES_QUERY_KEY`. Apply the same `as_of_ms` reconciliation pattern or debounce(invalidate, 300ms)."

---

### Summary patch index

| Q | Touches |
|---|---|
| Q14 | §1.2, §3.2, §3.3, §3.8, §4.2, §7.1, orchestrator.py (param removal) |
| Q15 | §3.2 (`_inflight_paths`), §3.3 (response shape), §5.2 (worker), §7.1 |
| Q16 | models (`QueueItem.force_retry`), §4.2 (chip), §7.2 |
| Q17 | §3.1 (new module), §3.5/§3.6/§5.3 (consumers), §10 (ADR-0007 first), ADR-0007 file |
| Q18 | §3.3 (`SymbolHit` shape), §4.2 (dropdown), §7.1 |
| Q19 | §3.1, §3.3 (envelope), §4.2 (indicator), §7.1, lifespan |
| Q20 | §3.7, §4.4 (banner button), §7.1 |
| Q21 | §3.3 (as_of_ms), §4.3 (reconciliation), §7.2, §9.3 |
