# 0052 — Global Right Rail chrome state lives in a dedicated store

**Status:** accepted (2026-05-30)

**Related:**
- ADR-0022 (Cursor Sidebar width: token-as-default, user state as runtime-of-record) — superseded by the `/replay` removal; its **Scope boundary** explicitly deferred cross-page layout state to "a separate decision." This ADR is that decision.
- ADR-0012 (Design tokens single source) — the rail's *widths* (`--rail-w`, `--rail-handle-w`) are tokens authored in `design-tokens.ts`; only the runtime *open/collapse* state lives in the store.
- `docs/superpowers/specs/2026-05-30-right-rail-watchlist-design.md` — the spec this ADR records reasoning for.

## Decision

The **Right Rail**'s runtime UI state — `panelOpen` (Watchlist Panel shown) and `railCollapsed` (rail collapsed to a handle) — is owned by a dedicated zustand store `frontend/src/state/rightRail.ts`, persisted to localStorage under its own key `rightRail.layout`. It is **not** stored in any page-scoped store (notably not `livePage`).

The store enforces the spec's **Panel-open ⟹ rail-expanded** invariant bidirectionally in its mutators: opening the panel expands the rail; collapsing the rail closes the panel.

`activeCode` — which **Code** the `/live` chart shows — stays in `livePage`. It is live-page view state, not rail chrome state, and is read (not owned) by the **Watchlist Panel**.

## Context

The Right Rail is mounted in the **App shell** and appears on every route. Its open/collapse state is therefore logically global, independent of any single page's lifecycle.

The `/live` watchlist drawer that the Right Rail replaces previously kept its open flag in `livePage` (`watchlistPanelOpen`). Lifting that flag to a global rail means it can no longer live in a page-scoped store without inverting the dependency — a global App-shell widget whose state is owned by one page's store.

ADR-0022 established a "user-state store seeded by a token" pattern for the Replay sidebar but scoped it explicitly to `/replay`, and its Scope boundary stated that cross-page generalization "is a separate decision." That store (`replayLayout.ts`) was since removed with `/replay`. So there is no existing global layout-state store to extend; this ADR creates the first one.

## Alternatives considered

### A. Keep the flag in `livePage`, mount the panel globally from App shell

Smallest diff — reuse `watchlistPanelOpen`. **Rejected**: a global App-shell widget reading/writing a page store inverts the shell→page dependency. Every route would import `livePage` purely for chrome state, and the boundary rot compounds the moment a second global chrome element is added.

### B. Dedicated `state/rightRail.ts` store (chosen)

A small persisted store owns exactly the rail's two booleans. App shell and `RightRail` read it; no page coupling. Mirrors the established per-concern store convention (`livePage`, the former `replayLayout`) but at App-shell scope. Cost: one more localStorage key and a hydration-order note.

### C. Encode open/collapse in a design token or CSS only

**Rejected**: these are user-toggled, persisted, stateful booleans — not visual constants. ADR-0012 keeps tokens for sizing; runtime user state belongs in a store (the same split ADR-0022 drew between `--sidebar-w` and `replayLayout`).

## Consequences

**Positive:**
- App-shell chrome state has a clean, page-independent home. A future global chrome element (e.g., a global search rail, an alerts panel) follows this precedent instead of re-deciding.
- The Panel-open ⟹ rail-expanded invariant is enforced in one place (the store mutators) and is testable without rendering.

**Negative / watch:**
- A second persisted layout store means two localStorage keys (`livePage`, `rightRail.layout`). Hydration order matters — `rightRail` must be restored before the first route paints to avoid a flash of the default (closed) state.
- Two right-edge concepts now coexist on `/live` (Right Rail chrome + **Cursor Sidebar** data panel). The `CONTEXT.md` glossary entries (**Right Rail**, **Cursor Sidebar**) keep them distinct.

## Scope boundary

This authorizes one global chrome store for the Right Rail. It does not retroactively move other page layout state into it, nor create a general "layout preferences" service. Additional *global chrome* state may join `rightRail` (it is the App-shell chrome store), but page-scoped layout stays in its page store.
