# Final Review Fix Report

- Status: done
- Commit: `fix(live): preserve saved detail layout across viewport changes`

## Fixed

- `LiveWorkarea` now treats viewport-fit clamping as render-only behavior. The persisted `rightPanelWidthPx` survives narrow mounts, live window resizes, and representative index views that hide the detail panel. Explicit splitter drag commit on pointer-up still persists the user's chosen width.
- The right-panel clamp now optionally accounts for the 6px vertical splitter when preserving the chart minimum width.
- `LiveDetailPanel` now exposes vertical scrolling for short workareas, with `LiveSidebar`/`LiveWorkarea` allowing that overflow path instead of clipping the lower cards.

## Tests

- `cd frontend && npx vitest run src/state/liveLayout.test.ts src/live/LiveDetailPanel.test.tsx src/live/LiveSidebar.test.tsx src/live/LiveWorkarea.test.tsx src/live/LivePage.test.tsx`
- `cd frontend && npx tsc --noEmit`

## Concerns

- No open concerns after the requested test and typecheck pass.

---

## 2026-06-28 Final Whole-Branch Review Fixes

- Status: done
- Commit: `fix(study): flatten detail rail review fixes`

### Changed Files

- `frontend/src/studyViews/StudyReferenceDetailPanel.tsx`
- `frontend/src/studyViews/StudyPage.test.tsx`
- `frontend/src/screener/SavedScreenerList.tsx`
- `frontend/src/screener/SavedScreenerList.test.tsx`
- `frontend/src/ui/DataSurface.tsx`
- `frontend/src/ui/DataSurface.test.tsx`
- `frontend/src/capture/CalendarCell.tsx`
- `frontend/src/capture/CalendarCell.test.tsx`
- `frontend/src/capture/phase.ts`
- `frontend/src/capture/phase.test.ts`
- `DESIGN.md`

### Fixed

- Flattened the study reference detail rail sections into divider-based sections inside a single `bg-bg-card` surface and removed nested section card chrome (`rounded`, `border`, `bg-bg-card`).
- Added regression coverage in `StudyPage.test.tsx` asserting the study detail sections stay flat.
- Replaced legacy teal UI-state tint literals with token-backed selection tint usage in saved screener rows, inline accent state, capture calendar in-range cells, and capture phase chips.
- Updated `DESIGN.md` so `--accent-fg` documents `#07100f`, matching `frontend/src/styles/tokens.css`.

### Verification

- Focused tests run (no `StudyReferenceDetailPanel.test.tsx` exists, so the closest relevant test `StudyPage.test.tsx` was run instead):
  - `cd frontend && npm test -- StudyPage.test.tsx SavedScreenerList.test.tsx DataSurface.test.tsx CalendarCell.test.tsx phase.test.ts --run`
- Build run:
  - `cd frontend && npm run build`

### Concerns

- No open concerns after the focused tests and production build pass.

---

## 2026-06-28 Token Hygiene Follow-up

- Replaced the remaining `CheckIcon` `--accent-fg` fallback with `#07100f`.
- Updated a screener regression assertion to check the token class instead of retaining the old teal literal in test source.
