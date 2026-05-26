# Watchlist Manual Catch-up — Design

**Date:** 2026-05-27
**Status:** Draft (pending user approval before plan)
**Related:** `2026-05-26-watchlist-daily-scheduler-design.md`, ADR-0034

## Problem

The startup-only Catch-up Run leaves two gaps:

1. **"I added a code and want yesterday's data right now."** The user has to wait until the next server restart (or the 18:00 daily run) for catch-up to fire. Inventory's per-`(code, date)` enqueue exists but requires the user to manually figure out the date range.
2. **"It's 17:30 and I want today's data right after market close."** Today the user must wait until 18:00 for the Daily Scheduler to fire.

The user has explicitly asked for both per-row and panel-level "update now" affordances on `/watchlist`.

## Goals

- Per-row `↻` button: backfill *that one entry* on demand, exactly the same semantics as Catch-up Run does for it at startup.
- Header `↻ 지금 전체 수집` button: same thing for *every* Watchlist entry at once.
- Both share the existing Q14 18:00 guard (today auto-trims; the user doesn't get a 400).
- Both reuse the existing success-banner + row-highlight pattern.

## Non-Goals (YAGNI)

- A "force redo all already-complete dates" mode — the existing Inventory recapture flow handles that case (per ADR-0035 `done + force_retry=true` → Implicit Retry).
- Per-row progress streaming. The Capture Queue already emits SSE events; the Watchlist page does not need a parallel stream.
- A "cancel my catch-up" button. The Capture Queue's existing per-row cancel covers it.
- Custom date-range selection. `last_success_date` is the floor by design — the value of this feature is that the user *doesn't* have to specify dates.

## Domain Vocabulary

The **Catch-up Run** definition in `CONTEXT.md` widens — it now has three triggers, not one:

| Trigger | When | What it covers |
|---|---|---|
| **Startup** | Server bootup, one-shot per process | All Watchlist entries |
| **Per-row manual** | User clicks the `↻` icon on one row | That one entry |
| **All-rows manual** | User clicks the header `↻ 지금 전체 수집` button | All entries |

The semantics are identical across triggers: disk-state reconcile of `last_success_date`, compute `trading_days_in_range(next_kst_day(last_success), today_kst)`, Q14 pre-trim, enqueue via `enqueue_items_core`. Dedupe + retry policies fall through to the queue layer as before (ADR-0033, ADR-0034).

## Architecture

### Refactor: extract `catchup_one_entry`

The current `_catchup_run` in `hoga/api/scheduler.py` interleaves two concerns:

1. Iterating `load_watchlist(data_dir)`.
2. Per-entry: disk reconcile, date math, Q14 trim, enqueue.

Extract concern 2 into a module-level coroutine so both the route handlers and the existing `_catchup_run` call into the same code path:

```python
async def catchup_one_entry(
    entry: WatchlistEntry,
    *,
    data_dir: Path,
    now: dt.datetime,
) -> EnqueueResponse:
    """Backfill one Watchlist entry. Used by:
    - _catchup_run (startup, all entries)
    - POST /api/watchlist/{code}/catchup (per-row)
    - POST /api/watchlist/catchup (all entries, manual)

    Behavior matches _catchup_run's per-iteration body verbatim:
    1. Disk-state reconcile of last_success_date (advance marker if disk
       shows a newer COMPLETE date).
    2. Compute candidates = trading_days_in_range(next_kst_day(floor), today).
    3. Q14 pre-trim via find_ineligible_dates.
    4. Return EnqueueResponse from enqueue_items_core, or an empty
       EnqueueResponse(enqueued=[], deduped=[]) when there is no work.
    """
```

`_catchup_run` becomes:

```python
async def _catchup_run(data_dir: Path) -> None:
    now = now_kst()
    for entry in load_watchlist(data_dir):
        try:
            await catchup_one_entry(entry, data_dir=data_dir, now=now)
        except Exception:
            log.exception("catch-up failed for %s", entry.code)
```

The route handlers wrap the same call with their own error mapping.

### New endpoints

```
POST /api/watchlist/{code}/catchup
  body: (none)
  → 404 not_in_watchlist
  → 503 krx_credentials_missing  (passed through from enqueue_items_core)
  → 200 EnqueueResponse  {enqueued: QueueItem[], deduped: EnqueueDedupedRow[]}

POST /api/watchlist/catchup
  body: (none)
  → 200 ManualCatchupAllResponse  {
      results: [
        {code, name, enqueued_count: int, deduped_count: int, error?: str},
        ...
      ]
    }
```

The all-entries endpoint never 500s for a per-entry failure — those land in `results[i].error` and the rest of the loop continues, mirroring the startup-time behavior. The endpoint itself returns 200 unless something catastrophic happens (e.g. corrupt `watchlist.json`).

`EnqueueResponse` for the single-entry endpoint reuses the existing wire shape from `POST /api/captures/items`. The all-entries endpoint introduces a new aggregate response shape (`ManualCatchupAllResponse`) because per-entry rows need to carry their `code`/`name` for the banner.

## Frontend

### `WatchlistRow.tsx`

Add a `↻` icon button before `🗑`. Grid column layout widens from 5 columns to 6:

```
Code | Name | Registered | Last success | ↻ | 🗑
```

Props gain `onCatchup(code)` callback and `catchingUp: boolean` prop. While catching up:
- icon flips to a spinning state (CSS rotate)
- button is `disabled`
- `aria-label="Update {name}"`

### `WatchlistPanel.tsx`

Header layout grows a single new button next to the count badge:

```
 Watchlist                  [3종목] [↻ 지금 전체 수집]
 다음 자동 수집까지 03:12:47 ...
```

The button:
- Same `↻` icon as the row buttons (consistency)
- Tooltip: "모든 종목을 지금 수집"
- Disabled while any per-row or all-rows mutation is in flight
- Spinner while pending

### State generalization

The existing `justAdded: { code, name } | null` state becomes `recentAction`:

```typescript
type RecentAction =
  | { kind: 'added';            code: string; name: string }
  | { kind: 'caught_up_one';    code: string; name: string;
                                enqueued: number; deduped: number;
                                error?: string }
  | { kind: 'caught_up_all';    summary: {
                                  entry_count: number;
                                  enqueued_total: number;
                                  deduped_total: number;
                                  failed: { code: string; error: string }[];
                                }};
```

A single 5-second `setTimeout` clears `recentAction`. The Panel reads `recentAction.kind` to pick the banner template and the set of rows to highlight (one for `added`/`caught_up_one`, all for `caught_up_all`).

### Banner messages

| Case | Korean | English |
|---|---|---|
| `added` | `✓ {name} ({code}) 추가됨. 내일 18:00부터 자동 수집됩니다.` | Unchanged from current panel |
| `caught_up_one` with `enqueued > 0` | `✓ {name} ({code}) 수집 대기 중 — {enqueued}건 추가{deduped > 0 ? `, ${deduped}건 이미 완료` : ''}` | – |
| `caught_up_one` with `enqueued == 0 && deduped > 0` | `✓ {name} ({code}) 이미 모두 수집됨 ({deduped}건)` | – |
| `caught_up_one` with `enqueued == 0 && deduped == 0` | `{name} ({code}) 수집할 거래일 없음` | – |
| `caught_up_one` with `error` | `{name} ({code}) 수집 실패: {error}` (error tint) | – |
| `caught_up_all` | `✓ 전체 catch-up: {entry_count}종목, {enqueued_total}건 추가, {deduped_total}건 이미 완료{failed.length > 0 ? `, ${failed.length}종목 실패` : ''}` | – |

For `caught_up_all` with a non-empty `failed` list, the banner expands a small list below the headline showing each failed `code: error` (one line per failure).

### Row highlight

`caught_up_one` → highlight the matching row (same `data-just-added="true"` attribute reused; consider renaming to `data-recent-action` if the test/CSS coupling allows, otherwise keep the existing attribute name to avoid churn).

`caught_up_all` → highlight *all* rows. With the 5-second auto-clear, this reads as "everything just got refreshed" without being noisy.

### react-query

Both mutations call `invalidateQueries({queryKey: ['watchlist']})` on success — the watchlist GET response carries `entries[*].last_success_date`, which advances as the Capture Queue lands its completions. The user sees the "마지막 성공" cell update naturally as the queue drains.

## Error handling

| Surface | Behavior |
|---|---|
| `POST /api/watchlist/{code}/catchup` for code not in watchlist | 404 `not_in_watchlist` (matches DELETE semantics) |
| `enqueue_items_core` raises 503 `krx_credentials_missing` | Bubbles up as 503 for single-entry; lands in `results[i].error` for all-entries |
| Network failure on the all-entries endpoint | Whole request fails; the panel shows the standard error banner ("불러오기 실패: ...") |
| Disk reconcile fails inside `catchup_one_entry` (very rare — `latest_complete_date` doesn't raise on its own) | Logged + treated as "no marker advance"; the catch-up proceeds with the existing marker |
| `watchlist.json` corrupted | `load_watchlist` already returns `[]` with a backup-and-warn; `/api/watchlist/catchup` returns an empty `results` list |

## Testing

### Backend

- `catchup_one_entry`: 4 unit tests
  - Reconcile-only path (disk shows newer, but next_kst_day(latest_complete) > today → empty)
  - Standard backfill (last_success a few days behind today)
  - Q14 today-trim path (now < 18:00, today excluded from dates)
  - Empty range path (last_success ≥ today)
- `POST /api/watchlist/{code}/catchup`: 3 route tests (404, 200 with enqueued, 200 with deduped)
- `POST /api/watchlist/catchup`: 2 route tests
  - All entries succeed (aggregated `results` shape)
  - One entry raises HTTPException → error captured in `results[i].error`, others continue
- `_catchup_run` regression: still works after the refactor (existing tests must pass unchanged)

### Frontend

- `catchupNow(code)` REST client unit test
- `catchupAll()` REST client unit test
- `WatchlistPanel`: 4 new component tests
  - `↻` click on a row → banner with enqueued/deduped count
  - `↻` click when error → error banner with code+message
  - Header `↻ 지금 전체 수집` click → all-rows summary banner + all rows highlighted
  - Both mutations cause `invalidateQueries(['watchlist'])`

## Implementation Order

The refactor (`catchup_one_entry` extraction) lands first as a behavior-preserving change. Then the two route handlers, then the REST client + hooks, then the UI. Each step has its own commit.

## Spec self-review

- No "TBD" or placeholder.
- Banner Korean text is concrete (5 templates), no ambiguity.
- The per-entry error shape on `ManualCatchupAllResponse` matches what the banner template needs.
- Scope is contained to one feature; the refactor is in-scope because it's the seam both new endpoints share.
- The `data-recent-action` rename is flagged as optional, not load-bearing — avoids over-promising frontend changes.
