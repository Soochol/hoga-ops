# Default UI Scale Up — Design Spec

**Date:** 2026-05-22
**Status:** Approved — ready for implementation plan
**Authors:** blessp@naver.com (via brainstorming session)

## Problem

Frontend feels visually correct at browser zoom 125%, which means the default
(100%) is too dense. The current `DESIGN.md` declares a "comfortable-tight"
density with body text at 13px and `--space-md` at 12px. The lived experience
suggests the system should ship at the 1.25× point as its default density,
not at the original 1.0× point.

The fix is not to recommend users zoom their browser — it is to move the
default density to match the user's observed preference and to do so in a
way that keeps the design system internally consistent.

## Goals

1. Default rendering at browser zoom 100% should be visually equivalent to
   the current rendering at browser zoom 125%.
2. Establish a single scale dial so future density modes (Compact, Cozy)
   become trivial additions.
3. Keep DESIGN.md as the single source of truth — no drift between the
   declared design and the rendered result.
4. Clean up token bypasses (hardcoded px in components) as part of the same
   change so the new scale actually applies uniformly.

## Non-Goals

- User-facing density toggle UI (Compact / Cozy menu). Infrastructure is
  laid down, but the menu is deferred to a follow-up issue.
- Light mode. DESIGN.md v1 explicitly excludes it.
- Chart color tokenization. The current chart colors work; not part of this scope.
- Automated visual regression (Percy, Chromatic). ROI does not justify the
  setup cost for a single-user tool.

## Approach — Single Scale Dial via `:root font-size`

The design system's scaling origin moves to a single CSS property:
`:root { font-size: 20px }` (up from the implicit browser default of 16px).
All rem-based tokens scale from this dial.

```
:root { font-size: 20px }       ← single scale origin (1.0× = 16px, 1.25× = 20px)
   │
   ├── --text-* (already rem)   ← scales automatically
   ├── --space-* (px → rem)     ← converted, redefined at new pixel intent
   ├── layout tokens (NEW)      ← --nav-w, --sidebar-w, row heights
   ├── border-radius (px kept)  ← anti-aliasing protection
   └── 1px borders (kept)       ← hairline protection
```

The principle: any value that should grow with text density becomes `rem`.
Any value whose pixel-perfect rendering matters (1px borders, small radii,
chart canvas internal coordinates) stays in `px`.

### Why this approach over alternatives

- **Single dial.** Future density modes (`data-density="compact"` etc.) are a
  one-line `font-size` change. Without rem conversion, every density change
  would require editing every spacing/layout token.
- **Faithful to browser zoom semantics.** Browser zoom scales everything
  proportionally — fonts, spacing, fixed widths, line heights. Our
  rem-based system replicates this at the token layer.
- **Truthful documentation.** DESIGN.md can declare a "base intent" and a
  "rendered at default density" in parallel, so future density modes just
  add columns rather than rewriting numbers.

## Token Values

### Font sizes — rem values unchanged, root font-size lifts them to 1.25×

**Key property:** the existing `--text-*` rem values already encode the
1.0× pixel intent against a 16px root. Lifting the root to 20px gives
exactly 1.25× rendered pixels with **no change** to the `--text-*`
declarations themselves. The table below shows existing values, which
stay as-is.

| Token | rem value (unchanged) | Base intent (@ 16px root) | Rendered @ default (@ 20px root) |
|---|---|---|---|
| `--text-xs` | `0.65625rem` | 10.5px | 13.125px |
| `--text-sm` | `0.71875rem` | 11.5px | 14.375px |
| `--text-base` | `0.8125rem` | 13px | 16.25px |
| `--text-md` | `0.875rem` | 14px | 17.5px |
| `--text-lg` | `1rem` | 16px | 20px |
| `--text-xl` | `1.375rem` | 22px | 27.5px |
| `--text-2xl` | `2rem` | 32px | 40px |

### Spacing — px → rem, redefined at 1.25× pixel intent

| Token | Base intent (1.0×) | Rendered @ default (1.25×) | rem value |
|---|---|---|---|
| `--space-2xs` | 2px | 2.5px | `0.125rem` |
| `--space-xs` | 4px | 5px | `0.25rem` |
| `--space-sm` | 8px | 10px | `0.5rem` |
| `--space-md` | 12px | 15px | `0.75rem` |
| `--space-lg` | 16px | 20px | `1rem` |
| `--space-xl` | 24px | 30px | `1.5rem` |
| `--space-2xl` | 32px | 40px | `2rem` |
| `--space-3xl` | 48px | 60px | `3rem` |

### Layout tokens — NEW, replacing inline px hardcodes

rem values are calibrated for 20px root, so `Xrem × 20 = rendered px`.

| Token (new) | Base intent (1.0×) | Rendered @ default (1.25×) | rem value | Replaces |
|---|---|---|---|---|
| `--nav-w` | 210px | 262.5px | `13.125rem` | `App.tsx grid-cols-[210px_...]` |
| `--sidebar-w` | 320px | 400px | `20rem` | `CursorSidebar w-[320px]` |
| `--combobox-min-w` | 220px | 275px | `13.75rem` | `StockCombobox min-w-[240px]` (code had 240; design intent is 220) |
| `--dropdown-min-w` | 320px | 400px | `20rem` | `StockCombobox min-w-[320px]` |
| `--row-tab-h` | 32px | 40px | `2rem` | `TabStrip h-[30px]` (code had 30; design intent is 32) |
| `--row-toolbar-h` | 60px | 75px | `3.75rem` | `Toolbar h-[60px]` |
| `--row-pricestrip-h` | 52px | 65px | `3.25rem` | `PriceStrip h-[52px]` |
| `--row-orderbook-h` | 22px | 27.5px | `1.375rem` | OrderbookTable row height |
| `--row-capture-h` | 36px | 45px | `2.25rem` | `CaptureQueueRow height: 36` |

Off-grid hardcoded values (e.g., `h-[30px]` where the design called for 32px,
`min-w-[240px]` where 220px was the design value) are normalized to the
design-system value during migration.

### Stays in px (intentionally)

| Token / pattern | Reason |
|---|---|
| `--radius-sm/md/lg` (2/4/6px) | Small radii don't visibly benefit from scaling; anti-aliasing cleaner at integer px |
| 1px borders, hairlines | Sub-pixel borders blur on standard displays |
| Chart canvas internal coords (lightweight-charts) | Library renders to pixel grid; sub-pixel coords blur |
| `box-shadow` offset/blur (e.g., `0 8px 24px`) | Manual review; small offsets unlikely to need scaling |

## Chart Scaling

`lightweight-charts` renders to `<canvas>` and does not inherit CSS sizing
for its internal text. Scaling is applied through library options.

A new module `frontend/src/util/chartScale.ts` centralizes the scaled values:

| Option | Library default | New value | Notes |
|---|---|---|---|
| `layout.fontSize` | 12 | 15 | Axis labels, crosshair price |
| `timeScale.fontSize` (if exposed) | 12 | 15 | Time axis labels |
| `priceScale` label size | 12 | 15 | Price axis labels |
| `crosshair.vertLine.width` | 1 | 1 (kept) | Stays at 1px for sharpness |
| `crosshair.horzLine.width` | 1 | 1 (kept) | Stays at 1px for sharpness |
| `rightOffset`, `barSpacing` | library default | × 1.25 | Pane spacing |

All seven chart components (`CandlePane`, `VolumePane`, `RatioPane`,
`IntensityPane`, `FillStrengthPane`, `VolumeProfileOverlay`, plus
`ChartStage`) consume `chartScale.ts` rather than hardcoding their own
font sizes. This mirrors the existing `util/tokens.ts` pattern that already
resolves CSS variables into canvas-compatible color strings.

## Code Migration

Three categories of code violations need cleanup, all in one PR to keep the
visual change atomic.

### Category 1 — Tailwind arbitrary values

Pattern: `w-[320px]`, `h-[52px]`, `min-w-[240px]`, `grid-cols-[210px_1fr]`.

Found in: `App.tsx`, `CursorSidebar.tsx`, `PriceStrip.tsx`, `Toolbar.tsx`,
`TabStrip.tsx`, `StockCombobox.tsx`.

Fix: register new layout tokens in `tailwind.config.ts`, replace arbitrary
values with token-based classes.

```tsx
// before
<aside className="grid grid-rows-[2fr_1fr_1fr] gap-2 p-2 bg-bg w-[320px] h-full">

// after
<aside className="grid grid-rows-[2fr_1fr_1fr] gap-sm p-sm bg-bg w-sidebar h-full">
```

### Category 2 — Inline style with px strings

Pattern: `style={{ font: '400 12px "Geist Sans", sans-serif', padding: '8px 12px' }}`.

Found in: `CaptureQueueRow.tsx`, `CaptureStatusPill.tsx`, `SymbolSearch.tsx`,
parts of `LeftNav.tsx`.

Fix: decompose composite style props into Tailwind classes or token-referencing
CSS variables.

```tsx
// before
<span style={{ font: '400 12px "Geist Sans", sans-serif', color: 'var(--fg-dim)' }}>

// after
<span className="font-sans text-sm font-normal text-fg-dim">
```

### Category 3 — Off-token text sizes

Pattern: `text-[9.5px]`, `text-[10.5px]`.

Found in: `LeftNav.tsx` (three locations).

Fix: normalize to nearest design token (`text-xs` = `--text-xs`). The 9.5px
values are violations of DESIGN.md's smallest defined size (10.5px) and are
not preserved during migration.

### Migration principles

1. One PR, not one-per-component — token changes must be atomic to avoid
   partial scaling artifacts.
2. Preserve semantic meaning when decomposing composite styles (`font:`
   shorthand → `text-*` + `font-*` + `text-*` classes).
3. Normalize off-token hardcodes to the nearest design-system value during
   migration; do not preserve violations.
4. Chart options consolidated in `chartScale.ts`, never inlined per-component.

## Implementation Sequence

```
1. chore(frontend): add layout tokens to tailwind config       ← infrastructure
2. feat(frontend/tokens): scale base font + spacing to 1.25x   ← visual change
3. refactor(frontend/shell): migrate App + LeftNav + Nav
4. refactor(frontend/replay): migrate replay viewer components
5. refactor(frontend/sidebar): migrate sidebar tables
6. refactor(frontend/capture): migrate capture page components
7. feat(frontend/chart): scale lightweight-charts via chartScale.ts
8. docs: update DESIGN.md to 2-column scale, add density ADR
```

The order is intentional: infrastructure first so the compiler can flag
missing tokens during component migration; visible change concentrated at
step 2 so regressions are easy to bisect; chart scaling isolated at step 7
so its imperative/canvas world is debugged separately from the CSS world.

## Risks and Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Inline px remnants make some components look broken after token shift | Medium | Single PR bundling token + migration; visual regression on 8 screens |
| Normalizing `text-[9.5px]` loses intended visual effect | Low | Visual regression on LeftNav; adjust `--text-xs` if needed |
| `lightweight-charts` option 1.25× breaks chart layout | Medium | Chart scaling isolated to step 7; debug independently of CSS |
| User OS font preference + `:root font-size: 20px` produces too-large text | Low | `:root font-size: 20px` is an absolute value, independent of OS settings — by design |
| Snapshot tests depending on hardcoded px | Low | `frontend/tests/` reviewed — no px-dependent snapshots. Playwright tests are behavioral, not pixel-based |
| Future Compact mode reveals an un-tokenized layout value | Low | Migration removes all hardcoded layout px; future leakage is grep-detectable |

## Rollback

Single-PR migration means `git revert <merge-commit>` is the rollback.
Per-step commits inside the PR allow partial rollback (e.g., revert chart
scaling only if chart layout breaks but CSS is fine).

## Definition of Done

**Functional**
- [ ] `:root font-size: 20px` set; browser zoom 100% renders equivalent to previous zoom 125%
- [ ] All `--space-*`, `--text-*`, and new layout tokens defined at correct 1.25× values
- [ ] Zero hardcoded px in `frontend/src/` (excluding 1px borders, small radii, chart canvas coords)
- [ ] All seven `lightweight-charts` components use `chartScale.ts`
- [ ] Eight core screens render without breakage

**Documentation**
- [ ] DESIGN.md token tables use 2-column "Base intent / Rendered @ default" structure
- [ ] DESIGN.md introduces "Scale factor" concept with future density mode pathway
- [ ] `docs/adr/NNNN-default-ui-density.md` written, capturing rationale and infrastructure for future modes

**Verification**
- [ ] `grep -rE "text-\[|w-\[[0-9]|h-\[[0-9]|style=\{\{" frontend/src/` returns zero results (excluding legitimate remnants: 1px borders, color-only inline styles)
- [ ] `frontend/` existing unit tests pass
- [ ] `frontend/` Playwright tests pass
- [ ] Eight-screen manual visual regression documented in PR description with before/after screenshots:
  1. LeftNav (Capture page)
  2. LeftNav (Replay page)
  3. Replay Viewer full layout
  4. Capture Queue (pending / in-progress / complete rows)
  5. Stock Combobox (closed / open)
  6. DateRangePicker (open)
  7. SymbolSearch dropdown
  8. Four-pane chart stage (verify lightweight-charts text sizes)

## Deliverables

**This spec produces (now)**
- `docs/superpowers/specs/2026-05-22-default-ui-scale-up-design.md` — this file

**Implementation produces (via writing-plans → executing-plans)**
- `frontend/src/styles/tokens.css` — token redefinition
- `frontend/tailwind.config.ts` — new layout token registration
- `frontend/src/util/chartScale.ts` — new module, chart option constants
- `frontend/src/**/*.tsx` — ~15-20 components migrated off hardcoded px
- `DESIGN.md` — 2-column scale, updated token tables
- `docs/adr/NNNN-default-ui-density.md` — new ADR

## Out of Scope (Backlog Issues)

These should be tracked as separate GitHub issues, not done here:
- User-facing density toggle UI (Compact / Comfortable / Cozy selector)
- Chart color tokenization
- Light mode
- Automated visual regression infrastructure (Percy / Chromatic)
