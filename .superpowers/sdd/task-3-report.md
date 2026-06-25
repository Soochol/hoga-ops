Status: done

Commits:
- `cc757b37` `feat(live): move toolbar into resizable chart panel`

Tests:
- `cd frontend && npx vitest run src/live/LiveWorkarea.test.tsx src/live/LivePage.test.tsx`
- Result: 2 files passed, 39 tests passed

Concerns:
- None blocking. Drag/drop hit testing is now scoped to the chart panel when a chart is present; blank tabs no longer advertise the whole workarea as a drop zone.

Status: done

Commits:
- `fix(live): preserve empty workarea drop target`

Tests:
- `cd frontend && npx vitest run src/live/LiveWorkarea.test.tsx src/live/LivePage.test.tsx`
- Result: 2 files passed, 41 tests passed

Concerns:
- None blocking. Empty tabs now mount the same chart-panel drop target wrapper used by the active workarea, while active hit testing stays bounded to the left chart panel and excludes the splitter/detail side.

Status: done

Commits:
- `HEAD` `fix(live): clamp persisted detail panel width`

Tests:
- `cd frontend && npx vitest run src/live/LiveWorkarea.test.tsx src/live/LivePage.test.tsx src/state/liveLayout.test.ts`
- Result: 3 files passed, 47 tests passed

Concerns:
- None blocking. LiveWorkarea now clamps persisted detail width on mount and during workarea shrink via `ResizeObserver`, with the mount-time `clientWidth` sync covering environments where observer notifications lag or are unavailable.
