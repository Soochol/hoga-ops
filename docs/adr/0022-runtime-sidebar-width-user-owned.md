# 0022 — Cursor Sidebar width: token-as-default, user state as runtime-of-record

**Status:** proposed (2026-05-24) — pending implementation of `docs/superpowers/specs/2026-05-24-replay-sidebar-splitter-design.md`

**Related:**
- ADR-0011 — Default UI density (the density dial that scales rem tokens). This ADR's "token as default" position layers cleanly on the dial.
- ADR-0012 — Design tokens as single source of truth for visual constants. The present ADR carves out a narrow exception (one token, one user-state owner) and explains why the exception does not erode ADR-0012's principle.
- `docs/superpowers/specs/2026-05-24-replay-sidebar-splitter-design.md` — the spec whose decisions this ADR preserves the reasoning for.

## Decision

The **Cursor Sidebar**'s width on `/replay` is, at runtime, owned by the `state/replayLayout.ts` zustand store (px, persisted to localStorage under `replay.layout`). The design token `--sidebar-w` (`frontend/src/styles/tokens.css`) is retained as the **default seed value** that the store falls back to when localStorage is empty or unreadable, and as the **reset target** for the splitter's double-click / keyboard-Enter reset gesture.

The same applies to the Cursor Sidebar's **collapsed** state (`sidebarCollapsed: boolean`). The store owns runtime truth; no design token encodes "default collapse" because the default is `false`.

Consumers (Workarea grid template, Toolbar toggle button, CollapsedSidebarHandle) read from the store, never from the token. The token is consulted exactly once, at store-init time, to seed `SIDEBAR_PX_DEFAULT`.

## Context

Before this change, the Cursor Sidebar's width was wholly token-owned: `frontend/src/replay/Workarea.tsx` set `grid-cols-[1fr_var(--sidebar-w)]` and that was the entire model. The token (`--sidebar-w: 20rem` at the default density dial) was the single source of truth in the spirit of ADR-0012.

The 2026-05-24 Replay Sidebar Splitter spec introduces two new requirements that the token alone cannot serve:

1. **Per-user adjustment**: the user drags a vertical splitter to set the sidebar width. The new value must persist across reloads and apply only to this user / machine — not to all consumers of the token.
2. **Collapsed state**: the user hides the sidebar entirely. There is no width to encode; the consumer needs a boolean.

Both requirements demand a runtime, user-scoped owner. The question is what happens to the token.

## Alternatives considered

### A. Retire `--sidebar-w` entirely; encode the default directly in `state/replayLayout.ts`

Delete the token. `SIDEBAR_PX_DEFAULT = 320` becomes a TypeScript constant in `replayLayout.ts`. The token's other consumer (`frontend/src/styles/tokens.generated.ts` exports a `sidebar` width key under `width`) is removed.

**Rejected**: the token is part of the documented design system in `DESIGN.md` and surfaces in the tokens-generated TypeScript export that other Tailwind utilities (`w-sidebar`) consume. Removing it forces a cascading rename across the design system to recover a value that has not actually changed. We are not changing the *default*; we are adding a *runtime override*.

### B. Keep `--sidebar-w` as runtime truth; have the splitter rewrite the CSS variable on `document.documentElement`

`useReplayLayoutStore` subscribes and sets `document.documentElement.style.setProperty('--sidebar-w', ${px}px)`. Consumers continue to read the CSS variable.

**Rejected**: this leaks `/replay`-scoped state into a global CSS variable visible to every other page and to non-replay components (`w-sidebar` Tailwind class). If `/inventory` or `/capture` ever uses `--sidebar-w` for a logically independent sidebar, they would inherit `/replay`'s state. The token's contract — "the canonical sidebar width in the design system" — would now be "the most recent value `/replay` happened to set."

It also makes testing harder: store-state changes have side effects on `document.documentElement`, requiring DOM cleanup between tests.

### C. Two parallel sources — token for static contexts, store for `/replay` (chosen)

Token remains. Store owns runtime for `/replay`. Token is read once during store init to seed the default; afterwards the two are independent.

**Chosen**: keeps ADR-0012's principle intact for every existing token consumer. The token is still *the* single source of truth for the design-system value. The store does not replace the token; it tracks a *user override* of that value, scoped to `/replay`. Other pages that might reference `--sidebar-w` (currently none beyond the now-removed `w-sidebar` class on the `<aside>`) are unaffected.

The cost is conceptual: a future reader must understand that the token is the *default*, not the *truth at any given moment on `/replay`*. This ADR is exactly that reader's note.

## Consequences

**Positive:**
- Existing tokens-as-single-source discipline (ADR-0012) is preserved for every consumer that has not opted into user-overridable widths.
- The token is the obvious place to change the *default* — e.g., a future density mode (ADR-0011 backlog) that ships a new `--sidebar-w` automatically reseeds new users via `SIDEBAR_PX_DEFAULT = computedTokenValue()`.
- The store is a clean place to add sibling layout state later (chart pane heights, footer visibility) without polluting the token system.

**Negative:**
- Two sources of truth that a future reader must reconcile. Mitigated by (a) this ADR, (b) the `Cursor Sidebar` glossary entry in `CONTEXT.md`, and (c) the spec.
- The reset gesture (splitter double-click) must read the token at reset time, not bake the default into source code, to stay consistent if the token is ever changed. The store implementation must therefore compute `SIDEBAR_PX_DEFAULT` from the rendered token value or accept that the constant drifts on density changes. **Implementation note**: read the computed value from `getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')` at store-init time, with a hard-coded fallback (320) for SSR / test environments.

**Neutral:**
- No automatic migration. localStorage starts empty for existing users, and the first store read seeds from the token, yielding the same visual state as before. The first time the user drags the splitter, the override kicks in.

## Scope boundary

This ADR applies to the **Cursor Sidebar on `/replay`**. It does **not** generalize to "any UI dimension may be user-overridable through a parallel store." Other widths and heights remain token-owned unless a follow-up ADR carves them out individually with the same level of justification.

This ADR also does not authorize a global "layout preferences" system. `state/replayLayout.ts` is `/replay`-scoped by module name and store name. If `/inventory` or `/capture` ever needs persistent layout state, each should have its own store; cross-page generalization is a separate decision.
