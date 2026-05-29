# Capture Fail-Streak Guard

**Date:** 2026-05-28
**Status:** Design approved, refined by grill-with-docs against ADR-0019/0021/0031/0033/0035. Anchored by ADR-0042. Ready for implementation plan.
**Scope:** both — backend (`hoga/api/captures.py`, `hoga/api/captures_persistence.py`, `hoga/api/models.py`) and frontend (`frontend/src/inventory/`, `frontend/src/capture/CaptureForm.tsx`).

## Problem

Today `/inventory` and `/capture` allow the same (Code, **Stock-Date**) to be enqueued without bound. If hogaplay (or any other upstream) is broken for a particular **Stock-Date** — or if the data simply does not exist on that date (the `no_upstream_data` case from ADR-0021) — a user can re-trigger the capture forever by:

1. Submitting `CaptureForm` repeatedly with the same code+date.
2. Clicking **Re-capture** on the same inventory row (`force_retry=true` re-enqueues `_done` entries with no upper bound — see [hoga/api/captures.py:1242-1262](hoga/api/captures.py#L1242-L1262)).

Each retry costs an external API call. With nothing to stop the loop, a misbehaving (Code, Stock-Date) becomes a polite DoS against the upstream and a noise source against our own throughput. The `no_upstream_data` case is particularly easy to fall into: hogaplay returns HTTP 200 + empty body for every retry, the worker correctly classifies as `skipped/no_upstream_data` (ADR-0021), and the user can keep clicking Re-capture indefinitely with no learning signal.

This spec introduces a per-(Code, Stock-Date) **fail-streak guard**: after 5 consecutive `failed` or `skipped` terminal results (with no `done` in between), enqueue is rejected with HTTP 409 until the user explicitly unblocks the row from inventory.

The decision record is **ADR-0042** (added by grill-with-docs in this session); this spec is the design behind it.

## Goal

- Define **fail_streak**(Code, Stock-Date) as the count of consecutive `phase ∈ {failed, skipped}` terminal results since — and not including — the most recent `done` or unblock action.
- Reject `enqueue_items` for any (Code, Stock-Date) whose `fail_streak >= attempt_cap` (`= 5`). Treat such pairs as `blocked`. `force_retry=true` does not bypass the guard.
- Persist `fail_streak` in the **Capture Queue** manifest (`.queue.json`, ADR-0019 pattern) so the policy survives uvicorn restart.
- Surface `fail_streak` and `blocked` on the inventory API response and on `EnqueueResponse`.
- Render a `차단됨 (5/5)` badge inline on blocked inventory rows; replace the Re-capture button with a **잠금 해제** button that resets the counter to 0 (without auto-retrying).

## Non-Goals

- Time-based auto-unblock (e.g. "expires after 24h"). The user must explicitly unblock.
- Bulk unblock UI. Per-row only; blocking is expected to be rare.
- Notifications (Slack/email/webhook) on block. Inventory's visual treatment is enough.
- Counting at enqueue-request granularity (clicks). We count `_done` terminal results — i.e. actual worker outcomes, not user button presses.
- Counting `cancelled`. User-initiated cancellation is excluded by ADR-0042; external-call status is unknown and "5 cancels = blocked" has no operational meaning.
- Configurable `attempt_cap`. Constant `5` for v1; lifting to Settings deferred per ADR-0042 "When to revisit".
- A new SSE event for unblock. The frontend uses query invalidation on the inventory list after a successful unblock POST.
- Bypassing the guard with `force_retry=true`. `force_retry` controls disk-cache bypass (sentinel/source_partial/complete per ADR-0021/0033/0035); the fail-streak guard is a user-intent gate and is orthogonal.

## Domain terminology

These terms are added to CONTEXT.md (in this session) and used consistently across backend code, frontend code, API field names, and documentation.

| Term | Meaning |
|------|---------|
| **fail_streak**(Code, Stock-Date) | Count of consecutive `phase ∈ {failed, skipped}` terminal results in the **Capture Queue** for that (Code, Stock-Date) since — and not including — the most recent `phase == done` result or unblock action. `phase == cancelled` does not change the counter. Persisted in `.queue.json`. |
| **attempt_cap** | Constant `5`. Exclusive upper bound on `fail_streak` for enqueue acceptance. `fail_streak >= attempt_cap` ⇒ blocked. Concretely: 5 consecutive failed/skipped results are allowed (each was a real worker outcome); the **6th** enqueue is rejected. The user's phrasing "5회를 초과해서 capture하는 것을 막는다" maps to this — *exceeding* 5 is what is blocked. |
| **blocked**(Code, Stock-Date) | Boolean derived from `fail_streak >= attempt_cap`. |
| **unblock** | The action of zeroing a (Code, Stock-Date)'s `fail_streak`. Triggered by `POST /api/captures/items/{code}/{date}/unblock`. Manifest write only — no `_done` mutation, no SSE event, no auto-retry. |

Distinct from `attempt` (ADR-0031): `attempt` is per-queue-item and accumulates across every Retry regardless of outcome (`×N` badge, never resets on success); `fail_streak` is per-(Code, Stock-Date), counts only `failed`+`skipped`, and resets to 0 on success or unblock. Both coexist.

Domain casing follows CONTEXT.md throughout: **Code**, **Stock-Date**, **Capture Queue**, **Retry**, **No Upstream Data**.

## Architecture

### Backend

```
                  ┌─────────────────────────────────────────────┐
                  │  .queue.json  (ADR-0019 atomic write)       │
                  │    queued/active/inflight: existing          │
                  │    fail_streaks: dict["{code}|{date}", int]  │  ← new
                  └─────────────────────────────────────────────┘
                          ▲                    ▲
            read on       │                    │  atomic write on
            enqueue/      │                    │  worker terminal +
            inventory     │                    │  on unblock
                          │                    │
              ┌───────────┴─────────┐   ┌──────┴──────────────────┐
              │ read_fail_streak()  │   │ persist_fail_streak()    │
              │ + is_blocked()      │   │ + apply_terminal()       │
              │ helpers             │   │ + clear_for_unblock()    │
              └────────┬────────────┘   └─────────────────────────┘
                       │                       ▲
       ┌───────────────┼────────────────────┐  │
       │               │                    │  │
       ▼               ▼                    │  │
  enqueue_items   inventory list        worker (existing _done
  _core           response builder      writer): after appending to
  (reject if >=   (annotates each       _done with terminal phase,
   attempt_cap,   row with fail_streak  call apply_terminal(code,
   BEFORE         + blocked)            date, phase) to update
   dedupe)                              fail_streak in manifest
```

### Frontend

```
  GET /api/inventory ─► InventoryRow { …existing, fail_streak, blocked }
                              │
                              ├─ blocked === true
                              │     ├─ "차단됨 (5/5)" badge
                              │     └─ "잠금 해제" button → useInventoryUnblock
                              │
                              ├─ blocked === false && fail_streak > 0
                              │     └─ subtle "재시도 N/5" indicator
                              │        (only if DESIGN.md provides a token
                              │         for this; otherwise omit in v1)
                              │
                              └─ default: existing Re-capture button

  POST /api/captures/items response shape:
        ├─ enqueued: [...]
        ├─ deduped:  [...]   (ADR-0033/0035 reasons)
        └─ blocked:  [...]   ← new; reason="fail_streak_exceeded"
        Status: 409 if every requested pair is blocked, else 201.
```

## Detailed design

### 1. Manifest schema extension

`.queue.json` ([hoga/api/captures_persistence.py:19-24](hoga/api/captures_persistence.py#L19-L24)) gains one new top-level key:

```json
{
  "queued": [...],
  "active": [...],
  "inflight_paths": [...],
  "fail_streaks": { "005930|20260520": 3, "003490|20260319": 5 }
}
```

Key format is `"{code}|{date}"` (date as the existing ISO-or-YYYYMMDD string already used in queue rows). Loader treats missing `fail_streaks` key as empty dict — forward-compat with old manifests on disk, no migration script needed.

### 2. Helpers (`captures.py` or a new sibling)

```python
def read_fail_streak(code: str, date: str) -> int: ...
def is_blocked(code: str, date: str) -> bool: ...    # equivalent to read >= ATTEMPT_CAP
def apply_terminal(code: str, date: str, phase: str) -> None:
    # phase == "done"             → set 0
    # phase in {"failed","skipped"} → += 1
    # phase == "cancelled"        → no change
    # then atomic_write_manifest()
def clear_for_unblock(code: str, date: str) -> bool:
    # set 0 (delete key) + atomic_write_manifest()
    # returns True if a change was made, False if already 0 (idempotent noop)
```

All four are pure-Python over the in-memory manifest mirror plus the existing atomic write helper. No I/O outside the manifest write.

### 3. `enqueue_items_core` guard placement

Insert a new guard immediately after date expansion, **before** any dedupe logic (so ADR-0033's Implicit Retry table never gets the chance to auto re-enqueue a blocked (Code, Stock-Date)):

1. For each expanded (Code, Stock-Date), call `is_blocked`.
2. If true, append to a `blocked` list with `{code, date, fail_streak, reason: "fail_streak_exceeded"}` and exclude from further processing.
3. Continue with existing Q14/Q15/ADR-0033 dedupe on the remaining pairs.

`force_retry=true` does **not** bypass the guard. This is the whole point: previously the user could keep clicking Re-capture with `force_retry=true` indefinitely.

HTTP response shape:
- `EnqueueResponse` ([hoga/api/models.py:318-320](hoga/api/models.py#L318-L320)) gains `blocked: list[BlockedItem]`.
- `BlockedItem` carries `code`, `date`, `fail_streak`, `reason="fail_streak_exceeded"`. `reason` is a Literal in case future ADRs add other block reasons.
- All blocked → HTTP **409**. Mixed (some accepted, some blocked, some deduped) → HTTP **201** with the relevant arrays populated (ADR-0033 partial-success pattern).

### 4. Worker terminal hook

Wherever the worker currently writes a terminal entry into `_done` (the place that writes `phase ∈ {done, failed, cancelled, skipped}`), call `apply_terminal(code, date, phase)` immediately after the `_done` append. This is the only mutation point for the counter on the failure side.

If multiple workers terminate concurrently for the same (Code, Stock-Date) (rare: same item can't be active twice, but the same Code can be active on adjacent dates), the manifest's existing single-lock-around-write pattern serializes them. Worst case the second write retries — no `fail_streak` is dropped.

### 5. Unblock endpoint

`POST /api/captures/items/{code}/{date}/unblock`

Behaviour:
1. Validate `code` (6-digit) and `date` (ISO or YYYYMMDD per existing path conventions).
2. Call `clear_for_unblock(code, date)`.
3. Return `200 OK` with `{code, date, fail_streak: 0, action: "unblocked" | "noop"}`. Idempotent.

No SSE event. The frontend invalidates the inventory query on success.

### 6. Inventory list response

Each row gains:
- `fail_streak: int`
- `blocked: bool`

Computed in one server-side pass by reading the manifest's `fail_streaks` dict once and joining with the row list — O(rows + dict size). N+1 impossible by construction.

### 7. Frontend

**`useInventoryUnblock`** — new hook mirroring [useInventoryRecapture.ts:40-50](frontend/src/inventory/useInventoryRecapture.ts#L40-L50):
- `unblock.mutateAsync({ code, date })` → POST the unblock endpoint
- Invalidates the inventory query on success
- Treat 200 with `action: "noop"` the same as `"unblocked"` for UI purposes

**Inventory row component** — branches on `blocked` / `fail_streak`:
- `blocked === true` → row picks up the DESIGN.md warning tint, shows a `차단됨 (5/5)` badge, and the Re-capture button slot becomes the `잠금 해제` button.
- `blocked === false && fail_streak > 0` → existing Re-capture button plus a small `재시도 N/5` indicator (subdued, neutral tone). Only added if `DESIGN.md` provides a suitable scale/token; otherwise omit and revisit when the badge token is added.
- Otherwise → unchanged.

All colours, badge styles, and typography come from `DESIGN.md`. No hardcoded hex/spacing.

**`CaptureForm` error rendering** — when `blocked` array is non-empty in the response:
- Show an inline error block listing the blocked (Code, Stock-Date) pairs.
- Korean message: "다음 항목은 5회 연속 실패로 차단되었습니다. 인벤토리에서 잠금을 해제하세요."
- Do not suppress the success/dedupe summary for non-blocked items in the same request.

## Error handling

- `read_fail_streak` for an unknown (Code, Stock-Date) → returns `0`. Never raises.
- `apply_terminal` for unknown phase → raises (programmer error; phase enum is closed).
- Unblock endpoint with malformed `code`/`date` → `400` with the standard FastAPI validation error.
- Unblock endpoint when manifest write fails → `500` with `{error: "unblock_persistence_failed"}`; counter is **not** modified.
- Enqueue path failure inside the new guard → bubbles up; the existing top-level handler catches.

## Testing

### Backend (`tests/unit/live/`)

- **`apply_terminal`** unit tests: `done` resets, `failed`/`skipped` increment, `cancelled` no-op, unknown phase raises, persistence writes the new manifest atomically.
- **`read_fail_streak` / `is_blocked`**: empty dict, missing key, key present with various values, threshold boundary (`4` not blocked, `5` blocked, `6` blocked).
- **`enqueue_items_core`** integration tests: pair at `fail_streak == 4` accepted, pair at `fail_streak == 5` rejected, mixed request (some accepted, some blocked, some deduped), `force_retry=true` still respects the guard, the guard runs *before* ADR-0033 dedupe.
- **Unblock endpoint**: idempotent on already-unblocked (`action: "noop"`), sets fail_streak to 0, subsequent enqueue accepted, manifest write failure surfaces as 500.
- **Manifest forward-compat**: loader handles `.queue.json` with no `fail_streaks` key (treats as empty); restart with non-empty `fail_streaks` restores the dict.

### Frontend (`frontend/src/inventory/`, `frontend/src/capture/`)

- `useInventoryUnblock` calls correct URL and invalidates the inventory query on both `unblocked` and `noop` responses.
- Inventory row renders correctly in three states (blocked, retrying with `fail_streak > 0`, normal).
- `CaptureForm` shows the blocked error block when the response carries `blocked` items, and does not hide the enqueued/deduped summaries.

### E2E (optional, via `/browse`)

- Force 6 fails on a stub (Code, Stock-Date) (test-mode `FakeHogaplayClient` configured to fail/skip), confirm the 6th request returns 409 with the pair in the `blocked` body, confirm inventory shows `차단됨`, click `잠금 해제`, confirm the Re-capture button returns and a successful flow proceeds and resets the counter.

## Migration / compatibility

- `.queue.json` schema gains `fail_streaks`. Loader treats missing key as empty dict — old manifests on disk load cleanly. No migration script.
- `EnqueueResponse` gains optional `blocked: list[BlockedItem]`; existing clients ignore unknown fields.
- Inventory response gains `fail_streak`, `blocked`; old frontend builds ignore them harmlessly.
- No `_done` schema changes (the design no longer writes an "unblock marker" into `_done` — the manifest dict is the source of truth).

The first time a `_done` terminal entry is written after this lands, `apply_terminal` will be called for that (Code, Stock-Date). (Code, Stock-Date) pairs that already accumulated multiple `failed`/`skipped` results *before* this lands start fresh at `fail_streak = 0` — historical results are not back-counted. This is intentional: introducing a regressive block on existing data is more disruptive than starting the counter from now.

## Out of scope (explicit YAGNI)

- Configurable `attempt_cap` (Settings UI). Constant 5 for v1.
- Per-symbol or per-source granularity (e.g. count `failed` separately from `skipped`).
- Historical back-counting of pre-existing (Code, Stock-Date) failures. Counter starts at 0 for everything not in the new `fail_streaks` dict.
- Bulk unblock UI.
- New SSE topic for unblock events.
- Honoring `force_retry=true` as a guard override. (Considered, rejected — undermines the whole point.)
