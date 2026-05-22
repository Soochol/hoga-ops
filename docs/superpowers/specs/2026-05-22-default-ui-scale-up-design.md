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

- **Single dial for CSS.** Future density modes (`data-density="compact"`
  etc.) are a one-line `font-size` change on the CSS side. Without rem
  conversion, every density change would require editing every spacing
  and layout token.
- **Faithful to browser zoom semantics.** Browser zoom scales everything
  proportionally — fonts, spacing, fixed widths, line heights. Our
  rem-based system replicates this at the token layer.
- **Truthful documentation.** DESIGN.md can declare a "base intent" and a
  "rendered at default density" in parallel, so future density modes just
  add columns rather than rewriting numbers.

### Scope of the single dial — CSS only, chart updated alongside

The single-dial property applies to CSS-rendered chrome. The
`lightweight-charts` canvas remains a separate concern: its options
(`layout.fontSize`, `barSpacing`, etc.) are static integer constants
in `frontend/src/util/chartScale.ts`. If a future density mode is added,
**both `:root font-size` and `chartScale.ts` must be updated together.**
The cost of integrating chart values into the CSS dial (e.g., via a
`--chart-font-size` CSS variable read by `resolveTokens`) was considered
and deferred — see Risks below.

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
| `--combobox-min-w` | 220px | 275px | `13.75rem` | `StockCombobox min-w-[240px]` (code had 240; design intent is 220 — normalized as drift) |
| `--dropdown-min-w` | 320px | 400px | `20rem` | `StockCombobox min-w-[320px]` |
| `--row-tab-h` | 32px | 40px | `2rem` | `Tab` main tab height |
| `--row-tab-secondary-h` | 30px | 37.5px | `1.875rem` | `TabStrip` "+ 새 분석" button (intentionally 2px shorter than main tab — secondary action) |
| `--row-toolbar-h` | 60px | 75px | `3.75rem` | `Toolbar h-[60px]` |
| `--row-pricestrip-h` | 52px | 65px | `3.25rem` | `PriceStrip h-[52px]` |
| `--row-orderbook-h` | 22px | 27.5px | `1.375rem` | OrderbookTable row height |
| `--row-capture-h` | 36px | 45px | `2.25rem` | `CaptureQueueRow height: 36` |

Off-grid hardcoded values are classified during migration as either
**intentional design difference** (preserved via a dedicated token, e.g.,
`TabStrip` 30px button → new `--row-tab-secondary-h`) or **drift**
(normalized to the design-system value, e.g., `StockCombobox` 240px →
220px design intent). The classification is made case-by-case based on
code intent and git history; ambiguous cases default to drift.

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

**Current state:** `ChartStage.tsx`'s `createChart(...)` call passes only
color tokens and `attributionLogo: false` — no `layout.fontSize`, no
`barSpacing`, no `rightOffset`. Chart text therefore renders at the
library's default font size (currently 12 in lightweight-charts v5).

**New module** `frontend/src/util/chartScale.ts` exports explicit option
values that all chart components apply:

| Option | Currently | New value | Notes |
|---|---|---|---|
| `layout.fontSize` | unset (library default 12) | **add as 15** | Axis labels, crosshair price |
| `timeScale.fontSize` (if exposed) | unset | **add as 15** | Time axis labels |
| `priceScale` label size | unset | **add as 15** | Price axis labels |
| `crosshair.vertLine.width` | 1 | 1 (kept) | Stays at 1px for sharpness |
| `crosshair.horzLine.width` | 1 | 1 (kept) | Stays at 1px for sharpness |
| `rightOffset`, `barSpacing` | library default | × 1.25 of library defaults | Pane spacing |

All seven chart components (`CandlePane`, `VolumePane`, `RatioPane`,
`IntensityPane`, `FillStrengthPane`, `VolumeProfileOverlay`, plus
`ChartStage`) consume `chartScale.ts` rather than hardcoding their own
font sizes. This mirrors the existing `util/tokens.ts` pattern that already
resolves CSS variables into canvas-compatible color strings.

**Important:** `chartScale.ts` values are static constants. They are NOT
reactive to `:root font-size` changes. If a future density mode is added,
`chartScale.ts` must be updated alongside the CSS dial (see "Scope of the
single dial" above).

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
   shorthand → `text-*` + `font-*` + `font-mono`/`font-sans` classes).
   Font weights map to Tailwind weight utilities (`font-normal`,
   `font-medium`, `font-semibold`, `font-bold`).
3. Classify off-token hardcodes as intentional design difference or drift
   case-by-case. Drift normalizes to design value; intentional differences
   get a dedicated token (see `--row-tab-secondary-h`).
4. Chart options consolidated in `chartScale.ts`, never inlined per-component.
5. Tailwind preset spacing (`p-2`, `gap-2`, `mb-px` etc.) is **not migrated**
   to design tokens unless the value is also a design-system spacing point.
   Tailwind's default scale is rem-based (`p-2 = 0.5rem`) so it auto-scales
   with `:root font-size`. Where existing usage happens to match a design
   token (e.g., `gap-2` = `0.5rem` = `--space-sm`), migration is optional.
6. Component inventory — these files contain hardcoded values to migrate:
   shell (`App.tsx`, `LeftNav.tsx`, `NavItem.tsx`, `CaptureStatusPill.tsx`,
   `StatusDot.tsx`), replay (`TabStrip.tsx`, `Tab.tsx`, `PriceStrip.tsx`,
   `Toolbar.tsx`, `StockCombobox.tsx`, `DateRangePicker.tsx`,
   `OnboardingCard.tsx`), sidebar (`CursorSidebar.tsx`, `OrderbookTable.tsx`,
   `BrokerNetTable.tsx`, `FillTape.tsx`), capture (`CaptureQueueRow.tsx`,
   `SymbolSearch.tsx`). Chart files are migrated as part of step 7.

## Documentation Updates

This spec also defines updates to existing documentation. They are part
of the implementation, not separate work.

### ADR-0008 (new) — Default UI density is 1.25× base intent

Single ADR capturing **the decision and its rationale only**:
- Why the default density shifts (lived-experience preference, density
  feedback indicates the original 1.0× was too dense for the analyst
  workflow).
- Why one decision instead of "let users toggle" — single-user tool,
  shipping a sensible default is more valuable than density chrome.
- Why the chart is excluded from the single dial (B-answer trade-off:
  static `chartScale.ts` is simpler today; density toggle UI is non-goal).

Implementation details (rem conversion mechanics, 2-column DESIGN.md
structure, chartScale.ts pattern) live in DESIGN.md, not the ADR. The
ADR cross-references DESIGN.md's "Scale Factor" section.

### DESIGN.md — New "Scale Factor" section + 2-column tables + Components disclaimer

A new top-level section "Scale Factor" is added near the top of DESIGN.md
(after "Product Context", before "Aesthetic Direction"). It defines:
- Base intent (1.0×) — the original pixel target captured in token rems
  against a 16px root.
- Default density (1.25×) — what 100% browser zoom currently renders,
  via `:root { font-size: 20px }`.
- The CSS single-dial mechanism and its scope (CSS only, chart updated
  alongside).
- Future density modes deferred to a backlog issue; this section is the
  hook point.

`## Typography` and `## Spacing` token tables adopt 2-column structure
(`Base intent (1.0×)` + `Rendered @ default (1.25×)`).

`## Components` section receives a single disclaimer line at the top:
> All px values in this section are **1.0× base intent**. Default rendering
> = × 1.25. See Scale Factor section.

Existing component px values stay as-is — the disclaimer reframes them.

### Approved mockup HTML — label-only update

`docs/superpowers/designs/2026-05-20-replay-viewer.html` is the approved
visual reference per CLAUDE.md and DESIGN.md. It is rendered at 1.0× base
intent. After this spec lands, it no longer matches the live default
density.

The HTML file gets a comment block at the top:

```html
<!--
  Visual reference for hoga-ops design system.
  This file is rendered at BASE INTENT (1.0× scale factor).
  The current default density is 1.25× — see DESIGN.md "Scale Factor".
  Do not edit the rem/px values to match the new default; this file is
  the canonical 1.0× artifact.
-->
```

The DESIGN.md reference to this file gets parallel clarification:
"approved mockup at 1.0× base intent".

## Implementation Sequence

```
1. chore(frontend): add layout tokens to tailwind config       ← infrastructure
2. feat(frontend/tokens): scale base font + spacing to 1.25x   ← visual change
3. refactor(frontend/shell): migrate App + LeftNav + Nav
4. refactor(frontend/replay): migrate replay viewer components
5. refactor(frontend/sidebar): migrate sidebar tables
6. refactor(frontend/capture): migrate capture page components
7. feat(frontend/chart): scale lightweight-charts via chartScale.ts
8. docs: DESIGN.md Scale Factor section + 2-column tables +
   Components disclaimer + mockup HTML label + ADR-0008
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
- [ ] DESIGN.md `## Typography` and `## Spacing` tables use 2-column "Base intent / Rendered @ default" structure
- [ ] DESIGN.md gains new `## Scale Factor` section explaining the dial mechanism, scope (CSS only), and density-mode hook
- [ ] DESIGN.md `## Components` section has 1-line disclaimer reframing existing px values as 1.0× base intent
- [ ] DESIGN.md reference to approved mockup mentions "at 1.0× base intent"
- [ ] `docs/superpowers/designs/2026-05-20-replay-viewer.html` gains a top-level comment block labeling it as 1.0× base intent reference
- [ ] `docs/adr/0008-default-ui-density.md` written — decision + Why + Consequences only; cross-references DESIGN.md Scale Factor for implementation

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
- `frontend/src/styles/tokens.css` — token redefinition + `:root { font-size: 20px }`
- `frontend/tailwind.config.ts` — new layout token registration (including `--row-tab-secondary-h`)
- `frontend/src/util/chartScale.ts` — new module, chart option constants
- `frontend/src/**/*.tsx` — ~15-20 components migrated off hardcoded px (TabStrip preserves intentional secondary height via dedicated token)
- `DESIGN.md` — new `## Scale Factor` section + 2-column Typography/Spacing tables + Components disclaimer + approved-mockup label
- `docs/superpowers/designs/2026-05-20-replay-viewer.html` — top-level HTML comment block labeling as 1.0× base intent reference
- `docs/adr/0008-default-ui-density.md` — new ADR (decision + Why + Consequences)

## Out of Scope (Backlog Issues)

These should be tracked as separate GitHub issues, not done here:
- User-facing density toggle UI (Compact / Comfortable / Cozy selector)
- Chart color tokenization
- Light mode
- Automated visual regression infrastructure (Percy / Chromatic)
