# Page Shell Unification — Design

**Date:** 2026-05-31
**Status:** Approved (design); pending implementation plan
**Author:** brainstorming session (Claude Code)

## Problem

The four feature pages (`/live`, `/inventory`, `/capture`, `/watchlist`) use
inconsistent layout idioms. Confirmed by source + screenshot audit:

| Page | Container | Page header |
|---|---|---|
| `/live` | full-bleed chart workspace (5-row grid) | none (intentional — symbol shows in StatusBar) |
| `/inventory` | **card** master-detail (2 cards) | none (component sub-headers only) |
| `/capture` | **card** form+queue (2 cards, splitter) | none at all |
| `/watchlist` | **full-bleed table, no card** | `<h1>Watchlist</h1>` |

`/watchlist` is the outlier the user flagged: a data table (structurally a
sibling of Inventory's list) rendered edge-to-edge with no card while its peers
sit in cards. Root cause: `pages/Watchlist.tsx` is just `return <WatchlistPanel/>`,
and `WatchlistPanel` was authored Tailwind-first without a card wrapper. (Note:
`WatchlistPanel` is **only** used by the `/watchlist` route — the Right Rail
panel is a *separate* component, `WatchlistDrawer`. Verified via grep. Editing
`WatchlistPanel` is therefore safe and does not affect the rail.)

DESIGN.md does **not** define a page-shell contract — it specifies *component*
tokens and two *specific* shell grids (`/live`, `/replay`). So the divergence is
drift by omission, not rule-breaking. Nothing is visually broken today; this is
coherence + maintainability work.

## Decision (header philosophy)

**No redundant page titles.** The left nav is the page label; pages do not
repeat their own name. This is consistent with the just-shipped `/live` change
that removed the `<h1>Live</h1>` because it duplicated the nav "Live".

Therefore each non-`/live` page = **token page padding + card-framed content +
a title-less control bar** (search / counts / actions). `/live` keeps its
documented full-bleed chart-workspace exception.

## Approach

**Thin `PageContainer` component + documented convention** (chosen over
"convention only" — which repeats padding everywhere — and "heavy PageShell with
forced header/card slots" — which fights the pages' divergent layouts:
master-detail vs splitter vs single-table).

### 1. `<PageContainer>` (thin)

`frontend/src/layout/PageContainer.tsx`. Sole job: the consistent page outer
frame — token padding (`p-md`) + `h-full min-h-0` sizing. Does **not** impose a
card or a title. Single source of truth for page padding.

```tsx
// approximate shape
export function PageContainer({ children, className }: {
  children: React.ReactNode; className?: string;
}) {
  return <div className={`p-md h-full min-h-0 ${className ?? ''}`}>{children}</div>;
}
```

Pages compose their own grid/splitter/card structure *inside* it.

### 2. Card framing (convention)

A page's primary content sits in `bg-bg-card border rounded-lg` cards.
Inventory and Capture already comply. **Watchlist's body (control bar + table)
becomes a single card** — the same pattern as Inventory's list card (header +
search + list in one card). No nested cards.

### 3. Title-less control bar (convention)

No static page-name text (nav owns the label). Watchlist's `<h1>Watchlist</h1>`
is removed; the 9종목 chip / ↻ 전체 수집 button / countdown stay as the card's top
control bar.

## Per-page change list

**`/watchlist`** (the user's pain point):
- Wrap `WatchlistPanel` content in `PageContainer` + a single
  `bg-bg-card border rounded-lg` card.
- Remove `<h1>Watchlist</h1>`; keep the count chip, 전체 수집 button, and
  countdown in the card's control bar.
- Replace `BANNER_STYLES` inline `rgba()` fills with `bg-tint-success` /
  `bg-tint-error`.
- Banner *borders* (`rgba(...,0.30)`) → new `--tint-*-border` tokens (see §
  DESIGN.md).
- The rail's `WatchlistDrawer` is untouched (separate component).

**`/capture`:**
- Outer `p-4` → `PageContainer` (`p-md`). Keep the 2 cards + `VerticalSplitter`.
- Inline px (`padding:'8px 12px'`, `marginTop:8`) → spacing tokens; ghost button
  `borderRadius:4` → `rounded-md` (value already correct; naming only).
- `CaptureForm` alert `rgba()` → `bg-tint-error`.
- No page title (already none; consistent with the no-title rule).

**`/inventory`:**
- Outer grid wrapper → `PageContainer` (already `p-md`, so near-identical).
- `gridTemplateColumns: '320px 1fr'` → `var(--sidebar-w) 1fr`.
- Blocked-row `bg-[rgba(244,63,94,0.10)]` → `bg-tint-error`.

**`/live`:**
- No structural change — full-bleed is correct and now documented as the
  explicit exception.
- (Optional) Toolbar inline `gap:'4px'` / `padding:'4px 10px'` → tokens; drop
  off-scale 10px.

## DESIGN.md additions

- New **"Page shell"** section documenting the contract: token page padding
  (`p-md`), card-framed content, **no redundant page title (nav is the label)**,
  and full-bleed reserved for the chart workspace (`/live`) only.
- New tokens `--tint-success-border` and `--tint-error-border` (0.30 alpha) so
  banner borders stop being literals. Add to `tokens.css` + the Tailwind
  `bg-tint-*-border` exposure if applicable.

## Token-hygiene scope

Only the **low-risk debt in files this change already touches** is cleaned up
(inline `rgba()` → `bg-tint-*`, inline px → tokens, `320px` → `var(--sidebar-w)`).
Files not otherwise touched are left alone.

## Out of scope

- `useCaptureQueue.ts` refactor (an unrelated concurrent change present in the
  worktree — do not touch or commit it).
- Any business-logic / data-flow changes.
- `/replay` page (not in the four-page set under review).
- A heavy `PageShell` with forced header/card slots.

## Testing & verification

- `tsc --noEmit` clean.
- Per-page vitest passes: `WatchlistPanel`/`Watchlist`, `Capture`, `Inventory`,
  `LivePage` test suites.
- Before/after real-render screenshots of all four pages via the `/browse`
  daemon — especially Watchlist (card framing + title removal) and Capture
  (padding).
- Confirm the Right Rail `WatchlistDrawer` is visually/behaviorally unaffected.

## Risks

- **Concurrent work in this worktree** (`useCaptureQueue.ts`). The Capture area
  overlaps; file-level collision risk is low (layout files vs data hook), but
  commits must stage only this task's files (`git commit --only <paths>`).
- Watchlist card wrapping must preserve the existing banner/empty-state/table
  structure and the `data-testid` hooks the tests rely on.
