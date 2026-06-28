Status: DONE

Implemented Task 1 within the owned file boundary:
- Promoted the quiet palette into the global dark tokens in `frontend/src/styles/tokens.css`.
- Removed duplicated `/live` quiet-terminal token overrides from `frontend/src/styles/global.css`, keeping the scoped background and structural live-only rules.
- Updated `DESIGN.md` aesthetic naming to `Quiet Trading Terminal` and added the dense-panel guidance sentence under Layout.
- Added the missing class-contract assertions in `frontend/src/ui/RailShell.test.tsx` and `frontend/src/ui/WorkspaceShell.test.tsx`.

Notes:
- `frontend/src/ui/PageShell.test.tsx` already contained the required `bg-bg-card` and `bg-bg-input` assertions.
- `frontend/src/ui/DataSurface.test.tsx` already contained the required `border-b` assertion.

Verification:
- `cd frontend && npm test -- PageShell.test.tsx RailShell.test.tsx WorkspaceShell.test.tsx DataSurface.test.tsx --run`
- `cd frontend && npm run build`

Self-review:
- Scope stayed within the brief’s owned files.
- Price and status tokens were left unchanged.
- `/live` keeps only the background selector-level difference while inheriting the new global palette.
