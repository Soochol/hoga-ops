# Task 5 Report: Index Sector Ranking Pane Component

Implemented `frontend/src/live/IndexSectorRankingPane.tsx` and `frontend/src/live/IndexSectorRankingPane.test.tsx` only, keeping the work inside the requested scope and leaving `LiveWorkarea` untouched.

## What changed

- Added the pane component with the required public props and behavior.
- Wired sector hover preview and click-to-pin behavior through `indexSectorRankingState`.
- Rendered the requested header state from `basisDate` and `basisMode`, including the pinned-date clear action.
- Added loading, error, unavailable, and empty states.
- Rendered the active sector's stocks and forwarded stock clicks to `onOpenStock(code, name)`.

## Test coverage

- Basis date and default rank-1 rendering.
- Hover preview switching between sectors.
- Click pin and unpin behavior.
- Stock navigation callback.
- Unavailable daily corpus state.

## Verification

Focused tests passed:

```bash
cd frontend && npx vitest run src/live/IndexSectorRankingPane.test.tsx src/live/indexSectorRankingState.test.ts
```

Result: 2 files passed, 11 tests passed.

## Notes

- I removed the forced preview clear from the sector unpin click path. The pane now leaves the current preview alone on unpin and lets the existing hover/focus leave handlers decide when to fall back to rank 1.

## Review Fix

The `IndexSectorRankingPane` unpin handler no longer dispatches `preview_sector(null)`. That keeps the active sector preview stable while the cursor or keyboard focus is still on the same button, and it only returns to rank 1 after hover/focus leaves.

Verification:

```bash
cd frontend && npx vitest run src/live/IndexSectorRankingPane.test.tsx src/live/indexSectorRankingState.test.ts
```

Result: 2 files passed, 11 tests passed.

## Null-folder Fix

The sector UI state now tracks an internal sector key instead of storing raw `folder_id` values directly. Regular sectors use `folder:<id>`, uncategorized sectors use `__uncat__`, and `null` remains the sentinel for "no preview" / "no pin".

That lets the backend's valid null-folder `미분류` sector participate in hover preview and click-to-pin without colliding with the empty state. The pane now encodes sector identity before dispatching preview/pin actions, and the reducer resolves those keys back to the matching ranking sector.

Added regression coverage for:

- reducer preview/pin handling for `__uncat__`
- pane hover preview and pinned state for a `folder_id: null` sector

Verification:

```bash
cd frontend && npx vitest run src/live/IndexSectorRankingPane.test.tsx src/live/indexSectorRankingState.test.ts
```

Result: 2 files passed, 13 tests passed.
