# 0052 — Global Right Rail chrome state lives in a dedicated store

**Status:** accepted (2026-05-30)

**Related:**
- ADR-0022 (Cursor Sidebar width: token-as-default, user state as runtime-of-record) — superseded by the `/replay` removal; its **Scope boundary** explicitly deferred cross-page layout state to "a separate decision." This ADR is that decision.
- ADR-0012 (Design tokens single source) — the rail's *width* (`--rail-w`) is a token authored in `design-tokens.ts`; only the runtime *panel open/closed* state lives in the store.
- `docs/superpowers/specs/2026-05-30-right-rail-watchlist-design.md` — the spec this ADR records reasoning for.

## Decision

The **Right Rail**'s runtime UI state — a single `panelOpen` boolean (whether the Watchlist Panel is shown) — is owned by a dedicated zustand store `frontend/src/state/rightRail.ts`, persisted to localStorage under its own key `rightRail.layout`. It is **not** stored in any page-scoped store (notably not `livePage`).

The rail itself is **fixed chrome** (always `--rail-w`); it does not collapse. Both the chevron (`»`/`«`) and the single 관심 item toggle `panelOpen` — there is no separate rail-collapse state. `readStorage` accepts only a real boolean for `panelOpen`, so a corrupt/hand-edited value cannot leak a non-boolean into state.

`activeCode` — which **Code** the `/live` chart shows — stays in `livePage`. It is live-page view state, not rail chrome state, and is read (not owned) by the **Watchlist Panel**.

## Context

The Right Rail is mounted in the **App shell** and appears on every route. Its open/collapse state is therefore logically global, independent of any single page's lifecycle.

The `/live` watchlist drawer that the Right Rail replaces previously kept its open flag in `livePage` (`watchlistPanelOpen`). Lifting that flag to a global rail means it can no longer live in a page-scoped store without inverting the dependency — a global App-shell widget whose state is owned by one page's store.

ADR-0022 established a "user-state store seeded by a token" pattern for the Replay sidebar but scoped it explicitly to `/replay`, and its Scope boundary stated that cross-page generalization "is a separate decision." That store (`replayLayout.ts`) was since removed with `/replay`. So there is no existing global layout-state store to extend; this ADR creates the first one.

## Alternatives considered

### A. Keep the flag in `livePage`, mount the panel globally from App shell

Smallest diff — reuse `watchlistPanelOpen`. **Rejected**: a global App-shell widget reading/writing a page store inverts the shell→page dependency. Every route would import `livePage` purely for chrome state, and the boundary rot compounds the moment a second global chrome element is added.

### B. Dedicated `state/rightRail.ts` store (chosen)

A small persisted store owns exactly the rail's `panelOpen` boolean. App shell and `RightRail` read it; no page coupling. Mirrors the established per-concern store convention (`livePage`, the former `replayLayout`) but at App-shell scope. Cost: one more localStorage key and a hydration-order note.

### C. Encode open/collapse in a design token or CSS only

**Rejected**: these are user-toggled, persisted, stateful booleans — not visual constants. ADR-0012 keeps tokens for sizing; runtime user state belongs in a store (the same split ADR-0022 drew between `--sidebar-w` and `replayLayout`).

## Consequences

**Positive:**
- App-shell chrome state has a clean, page-independent home. A future global chrome element (e.g., a global search rail, an alerts panel) follows this precedent instead of re-deciding.
- A single `panelOpen` boolean keeps the store trivial and testable without rendering; the fixed rail removes a whole class of layout-state coupling (no collapse/expand to coordinate with the panel).

**Negative / watch:**
- A second persisted layout store means two localStorage keys (`livePage`, `rightRail.layout`). Hydration order matters — `rightRail` must be restored before the first route paints to avoid a flash of the default (closed) state.
- Two right-edge concepts now coexist on `/live` (Right Rail chrome + **Cursor Sidebar** data panel). The `CONTEXT.md` glossary entries (**Right Rail**, **Cursor Sidebar**) keep them distinct.

## Scope boundary

This authorizes one global chrome store for the Right Rail. It does not retroactively move other page layout state into it, nor create a general "layout preferences" service. Additional *global chrome* state may join `rightRail` (it is the App-shell chrome store), but page-scoped layout stays in its page store.

## Update (2026-06-01): Screener panel — `panelOpen` boolean → `activePanel` enum

The rail now holds **two items** — 관심 (Watchlist) and 스크리너 (Screener). The chrome
state moved from a single `panelOpen: boolean` to `activePanel: 'watchlist' | 'screener' | null`.
The two panels are **mutually exclusive**: the App grid still has exactly one optional panel
column, so the track-count == child-count invariant (3 closed, 4 open) is preserved by
construction — `activePanel` is a single discriminant, so at most one drawer renders. A
memory-only `lastPanel: RailPanel` drives the chevron's re-open target; the chevron's
`aria-controls` lists both panel ids.

Legacy persisted state under `rightRail.layout` migrates on read: `{ panelOpen: true }` →
`'watchlist'`, `{ panelOpen: false }`/absent → `null`. The strict-validation guard now
whitelists the enum (`'watchlist' | 'screener' | null`); unknown strings (e.g. `'foo'`) and
non-string/non-boolean values fall back to `null`, so a corrupt value still cannot leak into
state. Existing users with an open Watchlist Panel are therefore unaffected.

The Screener panel (`ScreenerDrawer`) is **read-only** with respect to saved screeners — it
lists and selects them and runs a scan; create/rename/overwrite/delete remain on the
`/screener` page. Scan results live in a separate, in-memory `screenerPanel` store
(`selectedSavedId` is persisted; `lastScan` is not), so results survive panel close/reopen and
route changes but are cleared on a full reload (a screener row is a stale-prone price
snapshot). Chart symbol selection still routes solely through `useLivePageStore.setActiveCode`.

See spec `docs/superpowers/specs/2026-06-01-screener-rail-panel-design.md` and plan
`docs/superpowers/plans/2026-06-01-screener-rail-panel.md`. The Negative/watch note above now
reads "two right-edge **panels** (Watchlist, Screener) share one slot" rather than a single
Watchlist panel.
