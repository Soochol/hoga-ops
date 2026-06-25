Status: verified, ready to land
Commit: HEAD (`fix(live): start splitter drag from rendered width`)

Tests:
- `cd frontend && npx vitest run src/state/liveLayout.test.ts src/live/LiveWorkarea.test.tsx src/live/LivePage.test.tsx`
- `cd frontend && npx tsc --noEmit`

Concerns:
- None in the touched scope. Drag math now starts from the rendered clamped width, and persistence still happens only on pointer-up.
