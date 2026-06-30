# Minimal Top Menu — Design

**Date**: 2026-06-30
**Status**: Approved for implementation
**Scope**: `frontend/src/App.tsx`, `frontend/src/nav/*`, `frontend/src/styles/design-tokens.ts`, `frontend/src/styles/tokens.css`, `frontend/src/styles/tokens.generated.ts`, `DESIGN.md`, frontend shell tests

## Problem

The current app shell reserves a fixed left navigation column (`--nav-w`, rendered as 262.5px at default density). On `/live`, that width is more valuable as chart and content space than as persistent navigation. The user wants the left-side menu moved to a top menu specifically to recover horizontal room for chart analysis.

The final approved direction is a minimal top menu inspired by the attached reference:

- 40px top bar.
- Logo plus `hoga-ops` only; remove the `orderbook replay` subtitle.
- Text-first navigation, not button-like navigation.
- Active route is emphasized by text color and weight only. No underline, active bar, pill background, or icon placeholder.
- Right rail and right-side drawers remain unchanged.

## Invariants

- **Right rail fixed column**: The global right rail remains a fixed `--rail-w` column on every route; opening a right-rail panel adds exactly one panel column between main content and the rail. 근거: [frontend/src/App.tsx](../../../frontend/src/App.tsx), [DESIGN.md](../../../DESIGN.md).
- **Panel exclusivity**: Only one right-rail panel can be open at a time through `activePanel`. 근거: [frontend/src/state/rightRail.ts](../../../frontend/src/state/rightRail.ts).
- **Live document title ownership**: `/live` keeps its own title writer; static shell title writing applies to non-`/live` routes. 근거: [frontend/src/App.tsx](../../../frontend/src/App.tsx), [frontend/src/App.test.tsx](../../../frontend/src/App.test.tsx).
- **Route order**: Workspace navigation remains `Live`, `Study`, `Heatmap`, `Screener`, `Inventory`, `Capture`; system navigation remains `Settings`. 근거: [frontend/src/nav/LeftNav.tsx](../../../frontend/src/nav/LeftNav.tsx), [frontend/src/nav/LeftNav.test.tsx](../../../frontend/src/nav/LeftNav.test.tsx).
- **No duplicate route title**: Feature pages continue to avoid repeating their own title in the page body; the active top menu item remains the shell-level route label. 근거: [DESIGN.md](../../../DESIGN.md).

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| Right rail fixed column | preserves | App shell columns become `1fr + optional panel + rail`; the removed `--nav-w` column is not replaced on the left. |
| Panel exclusivity | preserves | This change does not alter `rightRail` state or drawer ownership. |
| Live document title ownership | preserves | `STATIC_ROUTE_TITLES` can continue to derive from the same nav item arrays; only component presentation changes. |
| Route order | preserves | Keep the current item arrays and render them horizontally. |
| No duplicate route title | preserves | Update design wording from "left nav is the page label" to "top menu active item is the page label." |

## Goals

- Recover the full left navigation width for `/live` and other main content areas.
- Keep the app shell visually quiet and terminal-like.
- Make the top menu feel close to the reference: brand, simple text links, muted inactive items, active item by text emphasis only.
- Preserve all existing routes, document-title behavior, right rail behavior, and drawer behavior.
- Clean up vertical-nav-only code instead of leaving unused shell components behind.
- Keep the implementation narrow enough to verify with focused component tests plus a shell-level visual/manual pass.

## Non-Goals

- No redesign of the right rail or right-rail drawers.
- No redesign of `/live` toolbar, tabs, price strip, chart panes, or chart logic.
- No mobile hamburger or responsive overflow menu in this pass.
- No route renaming or navigation hierarchy changes.
- No new icon system for nav items.

## Design

### App shell layout

Replace the current left-nav grid with a two-row app shell:

- Row 1: `var(--top-nav-h)` minimal top menu.
- Row 2: main content grid.

The content grid keeps the existing right-side behavior:

- No panel: `1fr var(--rail-w)`.
- Panel open: `1fr var(--watchlist-panel-w) var(--rail-w)`.

The root must still use `h-screen w-screen overflow-hidden`, and both the row and column grids must use `minmax(0, 1fr)` / `min-w-0` where needed so panel content cannot inflate chart height or width.

### Top menu component

Introduce a top-oriented nav component named `TopNav`, and retire `LeftNav` from `App`. To reduce churn, keep the nav item constants:

- `WORKSPACE_NAV_ITEMS`
- `SYSTEM_NAV_ITEMS`

`TopNav` renders:

- Brand: small abstract `H` mark plus `hoga-ops`.
- Workspace links: `Live`, `Study`, `Heatmap`, `Screener`, `Inventory`, `Capture`.
- Right utilities: compact capture status when capture is active/paused, `Settings`, and `StatusDot`.

The brand must not include the old `orderbook replay` subtitle.

### Existing code cleanup

Move shared navigation data out of the retiring `LeftNav` module before deleting or replacing it:

- Create `frontend/src/nav/items.ts`, exporting `WORKSPACE_NAV_ITEMS` and `SYSTEM_NAV_ITEMS`.
- Update `App` and `TopNav` to import route labels from that module.
- Remove `LeftNav.tsx` once `App` no longer renders it and no tests import it.
- Remove `NavItem.tsx` if it is only used by `LeftNav` after the migration.
- Replace `CaptureStatusPill.tsx` with `CaptureInlineStatus.tsx`; if queue/status derivation would otherwise be duplicated, extract only that derivation into a small helper and keep presentation top-nav-specific.
- Rename or replace both `LeftNav.test.tsx` files with `TopNav` tests. Do not keep stale left-nav tests that assert vertical active bars, icon placeholders, or section labels.
- Update comments that name `LeftNav` only because of the old shell, including token comments and right-rail comments. Keep comments that still describe right-rail behavior.

This cleanup is intentionally limited to code made obsolete by moving the global navigation to the top. It must not become a broad shell refactor or a `/live` workspace refactor.

### Nav item styling

Top nav links are plain text links:

- Inactive: muted foreground using `text-fg-dim`.
- Active: foreground text, heavier weight.
- Hover: foreground text only.
- No active underline.
- No active left bar.
- No tint-selection background.
- No border.
- No fixed icon placeholder.

This intentionally differs from `NavItem`, which was optimized for vertical left navigation. Implement a separate `TopNavItem` component; do not force the old vertical classes into the new layout.

### Capture status

The current `CaptureStatusPill` is a card-like vertical pill that fit the left nav. In the top menu it should be replaced by an inline component named `CaptureInlineStatus`:

- If idle and unpaused, render nothing.
- If paused, show a small warning dot/text and link to `/capture`.
- If capturing or queued, show a small accent dot/text and link to `/capture`.

The status must not look like a primary nav item or a card.

### Tokens and design docs

Add a top-nav height token:

- `--top-nav-h`: 2rem token, 32px base intent / 40px rendered at default density.

Update generated token artifacts through `npm run gen:tokens` if token source changes.

Update `DESIGN.md`:

- App shell now uses a top menu row and no left nav column.
- Replace "left nav is the page label" with "active top menu item is the page label."
- Mark `--nav-w` as retired if no remaining code consumes it, or remove it from `SIZE_TOKENS` if that is safe after checking references.
- Update older comments that say active rail state "matches LeftNav"; the new comparison should be to the app-shell active state or removed if unnecessary.

### Error handling

No new data-fetching errors are introduced. Capture status should preserve the current behavior where missing queue data does not break the nav; it should render no inline status until queue data exists.

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| Top nav route order | Render top nav under `MemoryRouter` | Links appear as `Live`, `Study`, `Heatmap`, `Screener`, `Inventory`, `Capture`, `Settings`. |
| Text-only active state | Render top nav at `/live` | `Live` has active text classes; it has no underline, left bar, border, or tint background classes. |
| Brand subtitle removed | Render top nav | `hoga-ops` is present and `orderbook replay` is absent. |
| Retired vertical nav removed | Search/import check after migration | `App` no longer imports `LeftNav`; no production code imports `NavItem` unless it has been deliberately repurposed. |
| Left nav tests replaced | Test tree after migration | `LeftNav` tests are removed or renamed to `TopNav` tests; no expectations mention vertical active bars. |
| App shell grid without panel | Render `App` with no active panel | Root has two shell rows; content grid columns are `1fr var(--rail-w)`. |
| App shell grid with panel | Set `activePanel` to `watchlist` | Content grid includes `var(--watchlist-panel-w)` before `var(--rail-w)`. |
| Document title behavior | Existing App title tests | `/live` still leaves title ownership to LivePage; non-live routes still use nav labels. |

**Invariant 회귀 테스트**: preserve existing right-rail and document-title tests, updating expectations from left-nav labels/classes to top-nav labels/classes.

### Manual verification

- Open `/live` and confirm the chart starts at the left viewport edge below the 40px top menu, with no 262.5px left gutter.
- Open and close right rail panels; confirm main content width changes only on the right.
- Navigate through `Live`, `Study`, `Heatmap`, `Screener`, `Inventory`, `Capture`, and `Settings`; confirm active text emphasis follows the route.
- Confirm `orderbook replay` is not visible anywhere in the top menu.
- Confirm the top menu does not visually compete with `/live` toolbar or price strip.

## Risks / Open questions

- If viewport width is narrow, seven text links plus utilities may crowd. This pass does not add responsive overflow; if crowding appears in manual QA, reduce gaps before adding a menu system.
- `CaptureStatusPill` currently couples status display to a card layout. It may need a small presentational split so left-nav-specific chrome does not leak into top nav.
- `--nav-w` may still be referenced in generated tokens or docs. Implementation should remove or retire it only after reference search.
- Deleting `LeftNav` and `NavItem` will touch tests and comments across the frontend; the implementation should keep those edits mechanical and avoid unrelated shell polish.

## Out of Scope (Backlog)

- Responsive collapsed top menu.
- Keyboard shortcut hints in the menu.
- New brand/logo artwork beyond the simple existing-style mark.
- Moving right rail items into top navigation.
