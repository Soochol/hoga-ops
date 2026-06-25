Status: done

Commits:
- `test(live): cover workarea splitter interactions`

Tests:
- `cd frontend && npx vitest run src/state/liveLayout.test.ts src/live/LiveDetailPanel.test.tsx src/live/LiveWorkarea.test.tsx`
- Result: passed (`3` files, `28` tests)

Concerns:
- None at the task scope. Vertical and horizontal splitter drags now verify live store updates during drag, persisted state on release, separator labels, and body text-selection cleanup.
