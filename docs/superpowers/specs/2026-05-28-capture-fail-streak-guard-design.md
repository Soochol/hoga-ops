# Capture Fail-Streak Guard

**Date:** 2026-05-28
**Status:** Design approved, ready for implementation plan
**Scope:** both — backend (`hoga/api/captures.py`, `hoga/api/models.py`) and frontend (`frontend/src/inventory/`, `frontend/src/capture/CaptureForm.tsx`).

## Problem

Today `/inventory` and `/capture` allow the same `(code, date)` to be enqueued without bound. If hogaplay (or any other upstream) is broken for a particular symbol/date — or if the data simply does not exist on that date — a user can re-trigger the capture forever by:

1. Submitting `CaptureForm` repeatedly with the same code+date.
2. Clicking **Re-capture** on the same inventory row (`force_retry=true` re-enqueues `_done` entries with no upper bound — see [hoga/api/captures.py:1242-1262](hoga/api/captures.py#L1242-L1262)).

Each retry costs an external API call. With nothing to stop the loop, a misbehaving symbol becomes a polite DoS against the upstream and a noise source against our own throughput.

This spec introduces a per-`(code, date)` **fail-streak guard**: after 5 consecutive failures (with no successful capture in between), enqueue is rejected with HTTP 409 until the user explicitly unblocks the row from inventory.

## Goal

- Define `fail_streak(code, date)` as the number of `_done` fail entries since the last success or unblock marker for that pair.
- Reject `enqueue_items` for any `(code, date)` whose `fail_streak >= 5`. Treat such pairs as `blocked`.
- Surface `fail_streak` and `blocked` on the inventory API response.
- Render a "차단됨 (5/5)" badge inline on blocked inventory rows; replace the Re-capture button with a **잠금 해제** button that resets the counter to 0 (without auto-retrying).
- Make all behaviour derivable from the existing `_done` history — no new storage table or cache.

## Non-Goals

- Time-based auto-unblock (e.g. "expires after 24h"). The user must explicitly unblock.
- Bulk unblock UI. Per-row only; blocking is expected to be rare.
- Notifications (Slack/email/webhook) on block. Inventory's visual treatment is enough.
- Counting at enqueue-request granularity (clicks). We count `_done(fail)` entries — i.e. actual worker outcomes, not user button presses.
- A separate storage table or cache field for `fail_streak`. The value is derived from `_done`.

## Domain terminology

These terms are used consistently across backend code, frontend code, API field names, and documentation.

| Term | Meaning |
|------|---------|
| `fail_streak(code, date)` | Count of `_done` entries with `kind="fail"` (or equivalent failure stage marker) since — and not including — the most recent entry that is either `kind="success"` or `kind="unblock"`. If no such anchor exists, count from the start of history. |
| `attempt_cap` | Constant `5`. The exclusive upper bound on `fail_streak` for enqueue acceptance. `fail_streak >= attempt_cap` ⇒ blocked. Concretely: 5 consecutive failures are allowed (each was a real attempt against the upstream); the **6th** enqueue is rejected. The user's phrasing "5회를 초과해서 capture하는 것을 막는다" maps to this — *exceeding* 5 is what is blocked. |
| `blocked(code, date)` | Boolean derived from `fail_streak >= attempt_cap`. |
| `unblock marker` | A sentinel `_done` entry with `kind="unblock"`. Has no capture payload; its only purpose is to anchor `fail_streak` calculation back to 0. Recorded by the unblock endpoint. |

These terms will be cross-checked against `CONTEXT.md` during the grill-with-docs stage; if `CONTEXT.md` already names a similar concept differently, this spec yields to existing usage.

## Architecture

### Backend

```
                     ┌────────────────────────────────────┐
                     │  _done (existing, captures.py)     │
                     │  per-(code, date) entries:         │
                     │    success | fail | … | unblock    │
                     └────────────────────────────────────┘
                              ▲                ▲
                              │ read           │ append
                              │                │
              ┌───────────────┴──┐   ┌─────────┴─────────────────┐
              │ compute_         │   │ unblock endpoint           │
              │   fail_streak()  │   │ POST /api/captures/items/  │
              │                  │   │      {code}/{date}/unblock │
              └────────┬─────────┘   └────────────────────────────┘
                       │
        ┌──────────────┼──────────────────────┐
        │              │                      │
        ▼              ▼                      ▼
  enqueue_items   inventory list         (future readers)
  _core           response builder
  (reject if      (annotates each row
   >= 5)          with fail_streak +
                  blocked)
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
                              │        (only if DESIGN.md tokens support it)
                              │
                              └─ default: existing Re-capture button

  POST /api/captures/items response
        ├─ enqueued: [...]
        ├─ deduped:  [...]  (existing)
        └─ blocked:  [...]  (new) → CaptureForm shows targeted error
```

## Detailed design

### 1. `compute_fail_streak(code, date) -> int`

Pure function. Reads `_done` history for the pair, walks entries newest-first, and returns the count of `fail` entries encountered before hitting the first `success` or `unblock` (or end of history).

Time complexity is O(k) where k is the number of entries for that `(code, date)`. In normal operation k is small (single digits) because a successful capture is the common case; even pathological histories with hundreds of fails would be cheap to scan.

If `_done` is stored in a form that makes per-pair lookup non-trivial, the lookup helper is part of this work — but the public interface is the function above.

### 2. `enqueue_items_core` guard

Insert a new guard immediately after date expansion, before existing dedupe:

1. For each expanded `(code, date)`, call `compute_fail_streak`.
2. If result `>= attempt_cap`, append the pair to a `blocked` list with `reason="fail_streak_exceeded"` and exclude it from further processing.
3. Continue with existing Q14/Q15 logic on the remaining pairs.

The HTTP response shape is extended: `EnqueueResponse` ([hoga/api/models.py:318-320](hoga/api/models.py#L318-L320)) gains a `blocked: list[BlockedItem]` field where `BlockedItem` carries `code`, `date`, `fail_streak`, and `reason`.

Status-code policy:
- If every requested pair is blocked → **HTTP 409**.
- If some are blocked and others succeed → **HTTP 201** (existing partial-success behaviour for dedupe is preserved; clients inspect `enqueued`/`deduped`/`blocked` arrays).

This matches the existing dedupe behaviour: dedupe is reported in the body rather than as a non-2xx status. The all-blocked case warrants 409 because the request itself was wholly rejected.

`force_retry=true` does **not** bypass the guard. Re-capture from inventory still goes through `enqueue_items_core` and is subject to the same fail_streak check; this is the whole point.

### 3. `POST /api/captures/items/{code}/{date}/unblock`

New endpoint. Behaviour:

1. Validate `code` (6-digit) and `date` (ISO).
2. Compute current `fail_streak`. If already `0`, return `200 OK` with `{code, date, fail_streak: 0, action: "noop"}`.
3. Otherwise append `{kind: "unblock", at: <now>}` to the `_done` history for that pair (atomic write, same pattern as `.queue.json` writes — see [hoga/api/captures_persistence.py:19-24](hoga/api/captures_persistence.py#L19-L24)).
4. Return `200 OK` with `{code, date, fail_streak: 0, action: "unblocked"}`.

The endpoint is idempotent: repeated calls when already unblocked are no-ops. There is no separate "block" endpoint — blocking happens implicitly from the 5th fail.

### 4. Inventory list response

The inventory endpoint's row shape gains two derived fields:

- `fail_streak: int`
- `blocked: bool`

Both are computed in one server-side pass over `_done` keyed by `(code, date)` to avoid N+1.

### 5. Frontend

**`useInventoryUnblock`** — new hook, mirrors [useInventoryRecapture.ts:40-50](frontend/src/inventory/useInventoryRecapture.ts#L40-L50):
- `unblock.mutateAsync({ code, date })` → POST the unblock endpoint
- Invalidates the inventory query on success

**Inventory row component** — branches on `blocked` / `fail_streak`:
- `blocked === true` → red/warning-tinted row with "차단됨 (5/5)" badge and "잠금 해제" button (in the slot where Re-capture currently lives).
- `blocked === false && fail_streak > 0` → existing Re-capture button plus a small "재시도 N/5" indicator (subdued, neutral tone). Only added if `DESIGN.md` provides a suitable scale/token; otherwise omit.
- Otherwise → unchanged.

All colours, badge styles, and typography come from `DESIGN.md`. No hardcoded hex/spacing.

**`CaptureForm` error rendering** — when `blocked` array is non-empty in the response:
- Show an inline error block listing the blocked `(code, date)` pairs.
- Message: "다음 항목은 5회 연속 실패로 차단되었습니다. 인벤토리에서 잠금을 해제하세요."
- Do not suppress the success/dedupe summary for non-blocked items in the same request.

## Error handling

- `compute_fail_streak` on a `(code, date)` with no `_done` entries → returns `0`. Never raises.
- Unblock endpoint with malformed code/date → `400` with the standard FastAPI validation error.
- Unblock endpoint when `_done` write fails → `500` with `{error: "unblock_persistence_failed"}`; no marker is written, fail_streak remains unchanged.
- Enqueue path failure inside the new guard → bubbles up; existing top-level handler catches.

## Testing

### Backend (`tests/unit/live/`)

- **`compute_fail_streak`** unit tests covering: empty history, fails only, success-then-fails, multi-success with interleaved fails, history ending in unblock marker, marker in the middle of the history, marker immediately followed by fails.
- **`enqueue_items_core`** integration tests: pair at `fail_streak == 4` accepted, pair at `fail_streak == 5` rejected, mixed request (3 accepted, 1 blocked, 1 deduped), `force_retry=true` still respects the guard.
- **Unblock endpoint** tests: idempotent on already-unblocked, sets fail_streak to 0, subsequent enqueue accepted; concurrent unblock+enqueue (atomicity of `_done` write).

### Frontend (`frontend/src/inventory/`, `frontend/src/capture/`)

- `useInventoryUnblock` calls correct URL and invalidates the inventory query.
- Inventory row renders correctly in three states (blocked, retrying, normal).
- `CaptureForm` shows the blocked error block when the response carries `blocked` items.

### E2E (optional, via `/browse`)

- Force 6 fails on a stub `(code, date)` (test-mode FakeHogaplayClient configured to fail), confirm 6th returns 409 in `blocked` body, confirm inventory shows "차단됨", click "잠금 해제", confirm Re-capture button returns and a successful flow proceeds.

## Migration / compatibility

- `_done` schema changes by adding a new `kind` value (`"unblock"`). Existing entries are untouched and continue to parse.
- `EnqueueResponse` gains a new optional field (`blocked`); existing clients ignore unknown fields.
- Inventory response gains `fail_streak` and `blocked`; old frontend builds ignore them harmlessly.

No data migration is required. The first time an unblock marker is written, fail_streak calculation already handles its absence (returns 0 / falls through).

## Open questions for grill-with-docs

- Does `CONTEXT.md` define a term that overlaps with `fail_streak` / `blocked` / `unblock marker`? If yes, this spec yields.
- Are there ADRs (under `docs/adr/`) that constrain how `_done` is persisted or extended? In particular, ADR-0033/0035 patterns must be respected when adding the `unblock` kind.
- Inventory currently exposes which fields, and is there a published external consumer? If not, adding `fail_streak`/`blocked` is safe.

## Out of scope (explicit YAGNI)

- Configurable `attempt_cap`. Constant `5` for v1; lift to settings later only if a real need appears.
- Per-symbol or per-source-of-failure granularity (e.g. count network errors separately from empty-body errors). All `_done(fail)` entries count equally.
- Historical migration of pre-existing fail-heavy `(code, date)` pairs. They will become `blocked` retroactively the first time someone tries to enqueue them; that is desired behaviour.
