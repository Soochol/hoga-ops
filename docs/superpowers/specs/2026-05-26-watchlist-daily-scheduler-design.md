# Watchlist + Daily Scheduler — Design

**Date:** 2026-05-26
**Status:** Draft (pending user approval before plan)

## Problem

The user wants to designate a set of stocks as "always keep up to date" and
have hoga-ops capture them every trading day at 18:00 KST without manual
enqueue. A laptop that was asleep at 18:00 should still backfill missed
trading days the next time the server starts.

Today every capture is initiated manually through the Inventory / Capture
UI. There is no notion of an ongoing watchlist or any time-based trigger.

## Goals

- Let the user maintain a list of Codes ("Watchlist") through the existing
  frontend, persisted across server restarts.
- At KST 18:00 each day, automatically enqueue each Watchlist entry as
  `(code, today)`.
- On server startup, automatically enqueue any trading day that was missed
  for each Watchlist entry since its last successful capture.
- Reuse the existing Capture Queue's dedupe, 18:00 guard (Q14), and retry
  logic — do not duplicate them.

## Non-Goals (YAGNI)

- Per-symbol custom schedules — every entry uses KST 18:00.
- Slack / email / push notifications — single-user local tool.
- A manual "Run Now" button — the existing Inventory UI already enqueues
  ad hoc, and the startup catch-up covers the "I just turned on the
  machine" case.
- Watchlist-level pause/resume — the Capture Queue's existing
  cookie-expired pause already covers the only realistic failure mode.
- Filling history older than the Watchlist entry's registration date —
  past data, if wanted, can be enqueued manually through Inventory.

## Domain Vocabulary (additions to `CONTEXT.md`)

**Watchlist**
The single set of Codes the user has marked for automatic daily capture.
There is one Watchlist per data directory; no per-user multiplexing.
Persisted to `<data_dir>/watchlist.json`.
_Avoid_: "subscription", "auto-list", "follow list".

**WatchlistEntry**
One row in the Watchlist: `{code, name, registered_at_kst_date,
last_success_date}`. `name` is captured at registration time from the
symbol master cache so the UI does not have to resolve it on every render.
`last_success_date` is the most recent KST-date Stock-Date for which this
Code reached `phase=done` (null until the first success).

**Daily Scheduler**
The asyncio task that sleeps until the next KST 18:00, then enqueues
`(entry.code, today_kst)` for every WatchlistEntry, then sleeps again for
24 h. Runs in the same uvicorn process as the Capture Queue. Skips
non-trading days. Errors per entry are logged and do not abort the run.

**Catch-up Run**
A one-shot async task that fires at server startup. For each
WatchlistEntry it computes the trading days between
`next_day(last_success_date or registered_at_kst_date)` and `today_kst`,
and enqueues them via the same `enqueue_items()` path the REST API uses.
The eligibility layer's `today_too_early` check still excludes
today-before-18:00 — Catch-up does not bypass Q14.

## Architecture

Two new asyncio coroutines bolted onto the existing FastAPI lifespan:

```
uvicorn process
├── existing capture workers (start_capture_pool)
└── NEW:
    ├── _catchup_run()      one-shot at startup
    └── _daily_loop()       perpetual; wakes at next KST 18:00
```

The crucial property: **the Scheduler is a client of the Capture Queue,
not a peer**. It calls the same enqueue routine the REST handler does, so
it inherits for free:

- ADR-0033 phase-aware `_done` dedupe
- ADR-0019 queue manifest persistence
- ADR-0031 explicit / implicit retry policy
- cookie-expired auto-pause

The 18:00 `today_too_early` guard (Q14) is the one piece the Scheduler
*cannot* inherit blindly — `enqueue_items` raises HTTP 400 on it,
rejecting the whole request, which would abort a multi-day catch-up when
today happens to be too early. The Scheduler instead calls
`eligibility.find_ineligible_dates` directly to pre-trim today before
enqueue (see "Refactor required" below).

### Refactor required: extract `enqueue_items_core`

`enqueue_items` today lives as an inner function inside
`captures.build_router` (hoga/api/captures.py:970), so it cannot be
imported. The fix is mechanical:

- Move the body into a module-level `async def enqueue_items_core(req:
  EnqueueRequest, *, data_dir: Path, now: datetime) -> EnqueueResponse`.
- Leave the route handler as a 3-line wrapper that injects `data_dir`
  and `now=_now_kst()`.
- All existing tests continue to drive the route; new tests drive
  `enqueue_items_core` directly.

This refactor is part of the implementation plan, not a separate ticket.

## File Layout

```
hoga/api/
  watchlist.py            # WatchlistEntry, load/save, bump_last_success
  scheduler.py            # _daily_loop, _catchup_run, start_scheduler
  watchlist_routes.py     # FastAPI router for /api/watchlist
```

Modified:

```
hoga/api/app.py           # mount scheduler in lifespan; mount router
hoga/api/captures.py      # _finalize_item: notify watchlist on done
```

Frontend:

```
frontend/src/watchlist/
  WatchlistPanel.tsx      # main panel
  WatchlistRow.tsx        # one row
  useWatchlist.ts         # data hook
  api.ts                  # REST client
frontend/src/nav/         # add "Watchlist" tab
```

## Data: `watchlist.json`

```json
{
  "version": 1,
  "entries": [
    {
      "code": "003490",
      "name": "대한항공",
      "registered_at_kst_date": "20260526",
      "last_success_date": null
    }
  ]
}
```

- File lives at `<data_dir>/watchlist.json`.
- Written via the existing `_atomic_write.py` helper used by the queue
  manifest (write to `.tmp`, fsync, rename).
- `version=1` for future migrations.
- Missing file = empty Watchlist (no error).
- Order of `entries` is preserved (insertion order = display order).

## API

All endpoints return JSON. Times are Unix-ms (ADR-0003). Codes are
6-digit zero-padded strings.

### `GET /api/watchlist`

```json
{
  "entries": [
    {
      "code": "003490",
      "name": "대한항공",
      "registered_at_kst_date": "20260526",
      "last_success_date": "20260524"
    }
  ],
  "next_run_at_ms": 1716714000000
}
```

`next_run_at_ms` = Unix-ms of the next KST 18:00 boundary (today's 18:00
if `now < 18:00`, otherwise tomorrow's). Used by the UI countdown.

### `POST /api/watchlist`

Request: `{"code": "003490"}`

- Validates the Code against `symbols.py`'s symbol-master cache.
- If not found in symbol master → `400 unknown_code`.
- If already in Watchlist → `409 already_in_watchlist`.
- Otherwise appends `{code, name, registered_at_kst_date=today_kst,
  last_success_date=null}` and returns the new entry.

### `DELETE /api/watchlist/{code}`

- `404 not_in_watchlist` if absent.
- `204` on success.
- Does not cancel any in-flight Capture Queue items for that Code — those
  finish normally. (The user can cancel them through the existing queue
  UI if they want.)

## Scheduler Behavior

### Startup sequence

1. uvicorn lifespan opens.
2. `start_capture_pool(data_dir)` starts as today (unchanged).
3. `start_scheduler(data_dir)` spawns two tasks:
   - `asyncio.create_task(_catchup_run(data_dir))` — fires immediately.
   - `asyncio.create_task(_daily_loop(data_dir))` — sleeps until next 18:00.
4. Both tasks are tracked so shutdown cancels them cleanly.

### `_catchup_run(data_dir)`

```
now = now_kst()
today = now.strftime("%Y%m%d")
for entry in load_watchlist(data_dir).entries:
    start = next_kst_day(entry.last_success_date
                         or entry.registered_at_kst_date)
    if start > today:
        continue
    try:
        candidate_dates = trading_days_in_range(start, today)
    except KrxUnavailableError:
        log.warning("catch-up skipped for %s: KRX unavailable", entry.code)
        continue
    # Pre-trim today if it would fail Q14 — see find_ineligible_dates.
    too_early = set(find_ineligible_dates(
        candidate_dates=candidate_dates, now=now,
    ))
    candidate_dates = [d for d in candidate_dates if d not in too_early]
    if not candidate_dates:
        continue
    try:
        await enqueue_items_core(
            EnqueueRequest(code=entry.code, dates=candidate_dates),
            data_dir=data_dir,
            now=now,
        )
    except HTTPException as e:
        # Only expected here is krx_credentials_missing (Q14 already trimmed).
        log.warning("catch-up for %s: %s", entry.code, e.detail)
```

The pre-trim avoids the `today_too_early` 400 entirely so a multi-day
catch-up that happens to include today before 18:00 still enqueues the
prior days successfully.

### `_daily_loop(data_dir)`

```
while True:
    await asyncio.sleep(seconds_until_next_18_kst(_now_kst()))
    try:
        await _daily_run(data_dir)
    except Exception:
        log.exception("daily run crashed")
        # Loop continues; never let one bad day kill the schedule.
```

### `_daily_run(data_dir)`

```
now = now_kst()
today = now.strftime("%Y%m%d")
trading_days = trading_days_in_range(today, today)
if not trading_days:  # weekend / holiday
    log.info("daily run: %s is not a trading day, skipping", today)
    return
for entry in load_watchlist(data_dir).entries:
    try:
        await enqueue_items_core(
            EnqueueRequest(code=entry.code, dates=[today]),
            data_dir=data_dir,
            now=now,
        )
    except HTTPException as e:
        log.warning("daily enqueue for %s/%s: %s", entry.code, today, e.detail)
```

### KST time helpers

```python
from hoga.collector.orchestrator import now_kst  # canonical Clock owner

def seconds_until_next_18_kst(n: datetime) -> float:
    today_18 = n.replace(hour=18, minute=0, second=0, microsecond=0)
    target = today_18 if n < today_18 else today_18 + timedelta(days=1)
    return (target - n).total_seconds()
```

`hoga.collector.orchestrator.now_kst` is the canonical Clock owner;
`captures.py` already re-imports it, and the Scheduler does the same.
No new time helper module is introduced.

## last_success_date Update Hook

`captures.py::_finalize_item` runs when a queue item reaches a terminal
phase. Add a single call near the end, after `done`/`failed` is published:

```python
if state.phase == "done":
    await watchlist.bump_last_success(_data_dir, state.code, state.date)
```

`watchlist.bump_last_success`:

- Acquires the module-scope `_watchlist_lock: asyncio.Lock` to serialize
  concurrent updates (two watched Codes can complete in the same tick).
- Loads the file.
- Returns silently if the Code is not in the Watchlist (capture was ad
  hoc).
- Returns silently if the new date is not greater than the existing
  `last_success_date` (out-of-order completions cannot regress the
  marker).
- Otherwise updates the field and atomically rewrites the file.

This is the only write to `watchlist.json` outside the API surface. The
API mutations (`POST` / `DELETE`) acquire the same lock.

### Corrupted `watchlist.json` recovery

`load_watchlist` wraps parsing in try/except. On any parse failure
(invalid JSON, Pydantic validation, missing required field) it:

1. Renames the bad file to `watchlist.json.corrupt-YYYYMMDDTHHMMSS`.
2. Logs `warning` with the path of the backup.
3. Returns an empty Watchlist.

A subsequent `POST` writes a fresh valid file. The user retains the
backup if they want to recover by hand.

## Frontend

### Navigation

A new top-level tab "Watchlist" beside the existing Inventory / Replay
tabs. Single panel — no sub-routes.

### `WatchlistPanel.tsx`

Layout (vertical, per Variant 3 mockup confirmed 2026-05-26):

```
┌──────────────────────────────────────────────────────────┐
│  Watchlist                                       3종목   │  ← count badge
│  다음 자동 수집까지  03:12:47  (오늘 KST 18:00 · 거래일)  │
├──────────────────────────────────────────────────────────┤
│  ✓ 대한항공 (003490) 추가됨. 내일 18:00부터 자동 수집…    │  ← success banner
├──────────────────────────────────────────────────────────┤
│  [ 종목명 또는 6자리 코드 검색…             ] [+ 추가]   │  ← SymbolSearch
├──────────────────────────────────────────────────────────┤
│  Code   종목명         등록      마지막 성공            │  ← column header
│  003490  대한항공       05/20     05/24             🗑  │  ← teal tint if
│  005930  삼성전자       05/18     05/24             🗑  │     just-added
│  ...                                                     │
└──────────────────────────────────────────────────────────┘
```

- **Search input reuses `frontend/src/capture/SymbolSearch.tsx`** —
  the same `{value, onChange}` interface Inventory and Capture use.
  No new autocomplete code is written; the component handles the
  symbol-master query, the dropdown UI, and the keyboard navigation.
- **Header `N종목` badge** — `bg-input` chip with mono-tabular count.
- **Countdown** re-derives each second from `next_run_at_ms`; no extra
  polls. Wrapped in a teal-tinted chip (`--selection-tint`).
- **Sublabel after countdown** distinguishes three states: "(오늘 KST
  18:00 · 거래일)" on weekdays, "(오늘 KST 18:00 · 추가된 종목 없음)"
  on empty, and "(내일 KST 18:00 · 비거래일)" on weekends/holidays.
- **Success banner** (`addM.isSuccess`) shows "✓ {name} ({code}) 추가됨.
  내일 18:00부터 자동 수집됩니다." using the `--success` tint pattern
  (alpha-tinted background, success-colored text). Auto-dismisses after
  5 seconds via `setTimeout`.
- **Just-added row highlight** — the `WatchlistPanel` tracks the most
  recently added Code in local state for 5 seconds and applies a
  `--selection-tint` background to its row. Same 5-second timer as the
  banner — both clear together.
- **Empty `last_success_date`** cell renders "아직 없음" in
  `--fg-dimmer` italic instead of a date.
- **Error banner** (`addM.error` / `removeM.error`) uses the
  `--error` tint pattern. Persists until the next successful mutation.
- Add (`POST`) and delete (`DELETE`) invalidate the `['watchlist']`
  query so the next refetch reflects state.

### Empty state

> 자동 수집할 종목이 아직 없습니다. 위에서 검색해서 추가하면 매일
> 18:00 KST에 자동으로 캡쳐됩니다.

### Visual system

All colors, spacing, fonts via the DESIGN.md tokens — nothing hardcoded.
The countdown uses the same monospace numeric style as the existing
chart cursor readouts.

## Error Handling

| Surface | Behavior |
|---|---|
| `POST /api/watchlist` invalid Code | 400 `unknown_code` — UI shows inline error. |
| `POST /api/watchlist` duplicate | 409 `already_in_watchlist` — UI shows toast. |
| `watchlist.json` write fails | 500 — UI shows toast, list re-fetches and shows pre-write state. |
| Scheduler `enqueue_items` raises `HTTPException` | Logged, loop continues. |
| Scheduler raises any other exception inside `_daily_run` | `_daily_loop` catches, logs, sleeps to next 18:00. The loop never dies. |
| `KrxUnavailableError` during catch-up | Whole catch-up skipped with a warning log. The 18:00 daily run will retry. |
| Scheduler cannot find `watchlist.json` | Treated as empty — no-op. |

The Scheduler is intentionally quiet at the UI layer (only logs).
User-visible errors are confined to the explicit Watchlist API surface.

## Testing

### Unit

- `seconds_until_next_18_kst`: now=17:59 → ~60s; now=18:01 → ~24h-60s;
  now=00:00 → 18h.
- `_catchup_run` date math:
  - new entry registered today, never captured → empty candidate list.
  - entry registered 5 trading days ago, last_success_date=null → 4
    days (today excluded if before 18:00).
  - entry with `last_success_date == today` → empty.
- Watchlist persistence round-trip (load → mutate → save → load equal).
- `bump_last_success` ignores Codes not in the Watchlist; ignores regress.

### Integration (extending `test_routes.py` patterns)

- `POST /api/watchlist` for unknown Code → 400.
- `POST` then `GET` → entry present.
- `DELETE` then `GET` → entry absent.
- Fake-clock `_daily_run` with one Watchlist entry on a trading day:
  asserts `enqueue_items` called with `[today]`.
- Fake-clock `_daily_run` on Sunday: no enqueue.
- `_finalize_item` with `phase=done` for a watched Code: file's
  `last_success_date` advances.
- `_finalize_item` with `phase=done` for an unwatched Code: file
  unchanged.

### Manual smoke

- Add 대한항공 to the Watchlist around 17:59 KST, watch the queue
  populate at 18:00.
- Kill the server, advance the clock a day, restart, observe the
  catch-up enqueue yesterday's date.

## Open Questions

None — all the dimensions surfaced during brainstorming have a decision.

## ADRs

Two ADRs land alongside this spec (see `docs/adr/`):

- **ADR-0034** — Scheduler-as-queue-client invariant. Documents why the
  Scheduler is forbidden from touching `_queue` / `_active` / `_done`
  directly and must always go through `enqueue_items_core`, including the
  one carve-out (`find_ineligible_dates` pre-trim for Q14).
- The `enqueue_items_core` extraction is mechanical and does not need
  its own ADR — it's a structural refactor whose only purpose is to make
  ADR-0034 enforceable.
