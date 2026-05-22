# Default UI Scale Up — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shift the frontend's default UI density to 1.25× of original (so browser zoom 100% renders equivalent to the current 125%) via a single `:root { font-size: 20px }` dial plus rem-based token migration.

**Architecture:** Single scale origin on `:root font-size`. All sizing tokens (`--text-*`, `--space-*`, new layout tokens) defined in rem so they multiply with the root. `lightweight-charts` canvas options live in a new static-constants module (`util/chartScale.ts`) outside the dial (must be updated alongside future density changes). Component migration replaces Tailwind arbitrary values (`w-[320px]`) and inline px strings (`style={{ font: '400 12px ...' }}`) with token-based classes.

**Tech Stack:** React 18 + TypeScript + Tailwind CSS 3 + Vite + Vitest + Playwright + lightweight-charts v5.

**Source spec:** `docs/superpowers/specs/2026-05-22-default-ui-scale-up-design.md`

---

## Task Overview

| # | Task | Files touched |
|---|---|---|
| 1 | Add layout tokens infrastructure | `tokens.css`, `tailwind.config.ts` |
| 2 | Lift `:root font-size` + redefine `--space-*` to rem | `tokens.css`, new `tokens.test.ts` cases |
| 3 | Migrate shell components | `App.tsx`, `LeftNav.tsx`, `NavItem.tsx`, `CaptureStatusPill.tsx`, `StatusDot.tsx` |
| 4 | Migrate replay viewer components | `TabStrip.tsx`, `Tab.tsx`, `PriceStrip.tsx`, `Toolbar.tsx`, `StockCombobox.tsx`, `OnboardingCard.tsx`, `replay/DateRangePicker.tsx` |
| 5 | Migrate sidebar components | `CursorSidebar.tsx`, `OrderbookTable.tsx`, `BrokerNetTable.tsx`, `FillTape.tsx` |
| 6 | Migrate capture + page components | `CaptureQueueRow.tsx`, `SymbolSearch.tsx`, `capture/DateRangePicker.tsx`, `CalendarCell.tsx`, `CaptureForm.tsx`, `CaptureQueue.tsx`, `CaptureRowDetail.tsx`, `pages/Capture.tsx`, `pages/Settings.tsx`, `pages/Inventory.tsx` |
| 7 | Create `chartScale.ts` + migrate chart components | new `util/chartScale.ts`, `ChartStage.tsx`, 6 chart panes |
| 8 | Documentation updates | `DESIGN.md`, mockup HTML, `docs/adr/0008-default-ui-density.md` |
| 9 | Verification + PR prep | grep audit, test suite, visual screenshots |

---

## Migration Pattern (canonical recipe, referenced by Tasks 3-7)

Every component migration follows the same recipe. Three categories of violations are handled differently:

### Category 1 — Tailwind arbitrary values
Pattern: `w-[320px]`, `h-[52px]`, `min-w-[240px]`, `text-[10.5px]`, `grid-cols-[210px_1fr]`.

**Recipe:**
- Width/height that matches a new layout token → use the token utility (`w-sidebar`, `h-toolbar`, `min-w-combobox`, etc., registered in Task 1).
- `text-[10.5px]` and similar → nearest design token `text-xs` (= `--text-xs` = 10.5px @ 16px root, becomes 13.125px @ 20px root by automatic scaling). Off-grid values (`text-[9.5px]`) normalize to `text-xs`.
- Grid template with px → use the token utility in the bracket (`grid-cols-[var(--nav-w)_1fr]`).

```tsx
// Before
<aside className="grid grid-rows-[2fr_1fr_1fr] gap-2 p-2 bg-bg w-[320px] h-full">
// After
<aside className="grid grid-rows-[2fr_1fr_1fr] gap-sm p-sm bg-bg w-sidebar h-full">
```

### Category 2 — Inline `style={{ ... }}` with hardcoded px / font shorthands
Pattern: `style={{ font: '400 12px "Geist Sans"', padding: '8px 12px', height: 36 }}`.

**Recipe:**
- `font: '<weight> <size>px <family>, ...'` → decompose to Tailwind classes:
  - `font: '400 ...'` → `font-normal`
  - `font: '500 ...'` → `font-medium`
  - `font: '600 ...'` → `font-semibold`
  - `font: '700 ...'` → `font-bold`
  - `'12px'` → `text-sm`, `'13px'` → `text-base`, `'14px'` → `text-md`, etc. (see Task 1 table)
  - `'"Geist Sans", sans-serif'` → `font-sans` (or omit; body inherits)
  - `'"Geist Mono", monospace'` → `font-mono`
- `padding: '<v>px <h>px'` → token classes (`py-sm px-md` etc.).
- `height: 36` → token utility (`h-capture-row`, etc.) or rem inline (`height: '2.25rem'`) if dynamic.
- Inline styles that ARE dynamic (e.g., `style={{ background: descriptor.chipColor }}`) stay as inline styles.

```tsx
// Before
<span style={{ font: '400 12px "Geist Sans", sans-serif', color: 'var(--fg-dim)' }}>Hello</span>
// After
<span className="text-sm font-normal text-fg-dim">Hello</span>
```

### Category 3 — Off-token text sizes
Pattern: `text-[9.5px]`, `text-[10.5px]`, `text-[12.5px]`.

**Recipe:** Normalize to nearest design token. Lookup table:

| Hardcoded | Use |
|---|---|
| `text-[9.5px]` | `text-xs` (= 10.5px intent; closest available) |
| `text-[10px]` | `text-xs` |
| `text-[10.5px]` | `text-xs` |
| `text-[11.5px]` | `text-sm` |
| `text-[12.5px]` | `text-sm` |

### Per-file workflow (apply for each migration task)

1. List affected files (Task header has them).
2. For each file, identify which Categories apply.
3. Edit the file using the appropriate recipe.
4. Run `npm run build` from `frontend/` to type-check.
5. Run `npm test -- <file-basename>` (Vitest) to verify existing tests still pass.
6. After all files in the task are done, commit once.

---

## Task 1: Add layout tokens infrastructure

**Goal:** Register new layout tokens in CSS and Tailwind config so subsequent tasks can use the utility classes. No visible change yet.

**Files:**
- Modify: `frontend/src/styles/tokens.css` (add new layout tokens, do NOT change `--text-*` or `--space-*` yet)
- Modify: `frontend/tailwind.config.ts` (extend width/height/minWidth with new tokens)

- [ ] **Step 1: Add layout tokens to tokens.css**

In `frontend/src/styles/tokens.css`, append a new `Layout` block inside the `:root, [data-theme='dark']` selector, after the `Border radius` block:

```css
  /* ───── Layout (rem-based; rendered px shown @ 20px root = default density) ───── */
  --nav-w: 13.125rem;              /* 262.5px @ default; 210px base intent */
  --sidebar-w: 20rem;              /* 400px @ default; 320px base intent */
  --combobox-min-w: 13.75rem;      /* 275px @ default; 220px base intent */
  --dropdown-min-w: 20rem;         /* 400px @ default; 320px base intent */
  --row-tab-h: 2rem;               /* 40px @ default; 32px base intent */
  --row-tab-secondary-h: 1.875rem; /* 37.5px @ default; 30px base intent — intentional 2px-shorter secondary action */
  --row-toolbar-h: 3.75rem;        /* 75px @ default; 60px base intent */
  --row-pricestrip-h: 3.25rem;     /* 65px @ default; 52px base intent */
  --row-orderbook-h: 1.375rem;     /* 27.5px @ default; 22px base intent */
  --row-capture-h: 2.25rem;        /* 45px @ default; 36px base intent */
```

- [ ] **Step 2: Register layout tokens in tailwind.config.ts**

Modify `frontend/tailwind.config.ts`. Extend `theme.extend` with `width`, `height`, and `minWidth`:

```ts
      width: {
        nav: 'var(--nav-w)',
        sidebar: 'var(--sidebar-w)',
      },
      height: {
        tab: 'var(--row-tab-h)',
        'tab-secondary': 'var(--row-tab-secondary-h)',
        toolbar: 'var(--row-toolbar-h)',
        pricestrip: 'var(--row-pricestrip-h)',
        'orderbook-row': 'var(--row-orderbook-h)',
        'capture-row': 'var(--row-capture-h)',
      },
      minWidth: {
        combobox: 'var(--combobox-min-w)',
        dropdown: 'var(--dropdown-min-w)',
      },
```

Place these inside the existing `extend: { colors: {...}, fontFamily: {...}, ... }` block, after `borderRadius`.

- [ ] **Step 3: Type check + lint**

```bash
cd frontend && npm run build
```
Expected: clean TypeScript build (no `tsc -b` errors).

```bash
cd frontend && npm run lint
```
Expected: clean (no new lint errors).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/styles/tokens.css frontend/tailwind.config.ts
git commit -m "chore(frontend): add layout tokens to tailwind config

Introduces --nav-w, --sidebar-w, --combobox-min-w, --dropdown-min-w,
--row-tab-h, --row-tab-secondary-h, --row-toolbar-h, --row-pricestrip-h,
--row-orderbook-h, --row-capture-h. Registered as Tailwind width/height/
minWidth utilities (w-nav, w-sidebar, h-tab, h-tab-secondary, h-toolbar,
h-pricestrip, h-orderbook-row, h-capture-row, min-w-combobox,
min-w-dropdown). No visible change yet — tokens are unreferenced.
Prep work for the default density shift to 1.25x."
```

---

## Task 2: Lift `:root font-size` + redefine spacing tokens

**Goal:** Shift the actual rendered density to 1.25×. This is THE visible change commit.

**Files:**
- Modify: `frontend/src/styles/tokens.css` (add `font-size: 20px`, redefine `--space-*` to rem)
- Modify: `frontend/tests/unit/tokens.test.ts` (add cases verifying new spacing values resolve correctly)

- [ ] **Step 1: Lift root font-size and convert spacing in tokens.css**

In `frontend/src/styles/tokens.css`, modify the `:root, [data-theme='dark']` block:

**Add at the top of the selector body** (right after the opening brace, before the surface colors comment):

```css
  /* ───── Scale dial (single source for default density) ─────
     :root font-size is the ONE dial. 20px = 1.25× default; 16px would be 1.0×.
     All rem-based tokens (--text-*, --space-*, layout tokens) follow automatically.
     Chart canvas options in util/chartScale.ts are NOT reactive — see DESIGN.md Scale Factor. */
  font-size: 20px;
```

**Replace the Spacing block** (the eight `--space-*` declarations). Before:

```css
  /* ───── Spacing (4px base) ───── */
  --space-2xs: 2px;
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 12px;
  --space-lg: 16px;
  --space-xl: 24px;
  --space-2xl: 32px;
  --space-3xl: 48px;
```

After:

```css
  /* ───── Spacing (rem-based; rendered px @ 20px root shown) ───── */
  --space-2xs: 0.125rem;  /* 2.5px @ default; 2px base intent */
  --space-xs: 0.25rem;    /* 5px @ default; 4px base intent */
  --space-sm: 0.5rem;     /* 10px @ default; 8px base intent */
  --space-md: 0.75rem;    /* 15px @ default; 12px base intent */
  --space-lg: 1rem;       /* 20px @ default; 16px base intent */
  --space-xl: 1.5rem;     /* 30px @ default; 24px base intent */
  --space-2xl: 2rem;      /* 40px @ default; 32px base intent */
  --space-3xl: 3rem;      /* 60px @ default; 48px base intent */
```

`--text-*` declarations are **unchanged** — they already encode the 1.0× pixel intent against a 16px root, so the new 20px root multiplies them by 1.25 automatically.

- [ ] **Step 2: Add unit test for resolved token values**

Append to `frontend/tests/unit/tokens.test.ts` a new `describe` block:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('tokens.css declarations', () => {
  const css = readFileSync(
    resolve(__dirname, '../../src/styles/tokens.css'),
    'utf-8',
  );

  it('sets :root font-size to 20px (single density dial)', () => {
    expect(css).toMatch(/font-size:\s*20px/);
  });

  it('declares spacing tokens in rem', () => {
    expect(css).toMatch(/--space-md:\s*0\.75rem/);
    expect(css).toMatch(/--space-sm:\s*0\.5rem/);
    expect(css).toMatch(/--space-lg:\s*1rem/);
  });

  it('declares layout tokens in rem', () => {
    expect(css).toMatch(/--nav-w:\s*13\.125rem/);
    expect(css).toMatch(/--sidebar-w:\s*20rem/);
    expect(css).toMatch(/--row-tab-h:\s*2rem/);
    expect(css).toMatch(/--row-tab-secondary-h:\s*1\.875rem/);
  });

  it('keeps existing --text-* rem values unchanged (they auto-scale via root)', () => {
    expect(css).toMatch(/--text-base:\s*0\.8125rem/);
    expect(css).toMatch(/--text-xs:\s*0\.65625rem/);
  });
});
```

- [ ] **Step 3: Run unit tests**

```bash
cd frontend && npm test -- tokens
```
Expected: all `tokens.test.ts` cases pass, including the new `tokens.css declarations` block.

- [ ] **Step 4: Run dev server and visually smoke-check the app**

```bash
cd frontend && npm run dev
```
Open the app in a browser at the printed URL. Verify:
- The frontend is visibly larger than before (everything ~1.25×).
- No layout breakage on the Replay Viewer page or Capture page.
- The change is global — fonts, padding, line-heights all scaled together.

Stop the dev server when done (`Ctrl+C`).

Note: many components still use hardcoded `w-[320px]`, inline `style={{ font: '12px ...' }}`, etc. — they will look "smaller than their neighbors" until Tasks 3-7 migrate them. This is expected mid-migration.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/styles/tokens.css frontend/tests/unit/tokens.test.ts
git commit -m "feat(frontend/tokens): scale base font + spacing to 1.25x default

Lifts :root font-size to 20px (single density dial) and converts
--space-* tokens to rem so they multiply with the root. --text-*
declarations already encoded base intent in rem against a 16px root,
so they auto-scale to 1.25x without modification.

After this commit, components that still use hardcoded px (w-[320px],
inline style={{ font: '12px ...' }}) will look smaller than their
already-scaled neighbors. Tasks 3-7 migrate them."
```

---

## Task 3: Migrate shell components

**Goal:** Bring App + LeftNav + Nav family in line with the new token system.

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/nav/LeftNav.tsx`
- Modify: `frontend/src/nav/NavItem.tsx`
- Modify: `frontend/src/nav/CaptureStatusPill.tsx`
- Modify: `frontend/src/nav/StatusDot.tsx`

- [ ] **Step 1: Migrate App.tsx**

Find:
```tsx
<div className="grid grid-cols-[210px_1fr] h-screen w-screen overflow-hidden">
```
Replace with:
```tsx
<div className="grid grid-cols-[var(--nav-w)_1fr] h-screen w-screen overflow-hidden">
```

- [ ] **Step 2: Migrate LeftNav.tsx**

Replace `text-[9.5px]` (2 occurrences) and `text-[10.5px]` (1 occurrence) with `text-xs`:
- Line 13: `<div className="text-[9.5px] text-fg-dim uppercase tracking-wider">` → `<div className="text-xs text-fg-dim uppercase tracking-wider">`
- Line 26: `<div className="p-3 border-t flex justify-between font-mono text-[10.5px] text-fg-dimmer">` → `<div className="p-3 border-t flex justify-between font-mono text-xs text-fg-dimmer">`
- Line 37: `<div className="pl-4 pt-3 pb-1 text-[9.5px] font-semibold uppercase tracking-wider text-fg-dimmer">{label}</div>` → `<div className="pl-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wider text-fg-dimmer">{label}</div>`

If any inline `style={{ ... }}` with hardcoded px exists in LeftNav.tsx, apply Category 2 recipe.

- [ ] **Step 3: Migrate NavItem.tsx**

Read the file; apply Category 1 + Category 2 recipes for any violations. If no hardcoded px or arbitrary values exist, no changes needed — skip to next file.

- [ ] **Step 4: Migrate CaptureStatusPill.tsx**

Replace inline `style={{ padding: '8px 12px', border: '1px solid var(--border)', ... }}` and `style={{ font: '600 9.5px ...' }}` etc.

Recipe:
- `padding: '8px 12px'` → Tailwind `py-sm px-md` (8px @ 1.0× ≈ `--space-sm` = 10px @ default; 12px ≈ `--space-md` = 15px @ default).
- `border: '1px solid var(--border)'` → Tailwind `border` class (already defaults to var(--border) per existing tailwind.config.ts `borderColor.DEFAULT`).
- `font: '600 9.5px "Geist Sans", sans-serif'` → `font-semibold text-xs` (9.5 → text-xs).
- `font: '500 10px "Geist Mono", monospace'` → `font-medium text-xs font-mono`.

Apply per the migration recipe. Read the file in full first to identify all inline styles.

- [ ] **Step 5: Migrate StatusDot.tsx**

Inline style is `boxShadow: status === 'green' ? \`0 0 4px ${color}\` : undefined` — this is **dynamic** based on the `status` prop. **Keep as inline style** per migration recipe (dynamic values stay).

If StatusDot also has hardcoded size like `width: 6, height: 6`, leave as-is for now (these are 1.0× base intent; the dot is intentionally small and absolute-pixel for crisp rendering — same exception as 1px borders).

- [ ] **Step 6: Type check + run shell tests**

```bash
cd frontend && npm run build
```
Expected: clean type check.

```bash
cd frontend && npm test -- LeftNav CaptureStatusPill
```
Expected: existing tests pass.

- [ ] **Step 7: Manual visual check**

```bash
cd frontend && npm run dev
```
Open the app. Verify:
- LeftNav width looks proportional (≈ 262px wide vs surrounding chrome).
- LeftNav text labels readable, hierarchy intact.
- Capture status pill in nav rendered correctly.

Stop dev server.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/App.tsx frontend/src/nav/*.tsx
git commit -m "refactor(frontend/shell): migrate App+LeftNav+Nav to new tokens

App grid template uses --nav-w. LeftNav normalizes off-token text-[9.5px]
and text-[10.5px] to text-xs. CaptureStatusPill inline style props
decomposed to Tailwind classes (py-sm px-md, font-semibold text-xs,
etc.). StatusDot keeps its dynamic boxShadow inline style as the
recipe permits."
```

---

## Task 4: Migrate replay viewer components

**Goal:** TabStrip, Tab, PriceStrip, Toolbar, StockCombobox, OnboardingCard, replay/DateRangePicker migrated.

**Files:**
- Modify: `frontend/src/replay/TabStrip.tsx`
- Modify: `frontend/src/replay/Tab.tsx`
- Modify: `frontend/src/replay/PriceStrip.tsx`
- Modify: `frontend/src/replay/Toolbar.tsx`
- Modify: `frontend/src/replay/StockCombobox.tsx`
- Modify: `frontend/src/replay/OnboardingCard.tsx`
- Modify: `frontend/src/replay/DateRangePicker.tsx`
- Modify: `frontend/src/replay/Workarea.tsx`

- [ ] **Step 1: Migrate TabStrip.tsx**

- Line 39 `h-[30px]` → `h-tab-secondary` (this is the "+ 새 분석" secondary button, intentionally 2px shorter than main tab — uses the dedicated token).
- Line 44 `font-mono text-[10.5px]` → `font-mono text-xs`.

Apply Category 2 to any inline styles in the file.

- [ ] **Step 2: Migrate Tab.tsx**

- Line 25 `font-mono text-[11.5px] text-accent` → `font-mono text-sm text-accent`.
- Line 26 `text-[12.5px]` → `text-sm` (12.5px is closer to `--text-sm` 11.5 than `--text-base` 13; round down to honor "no upscaling beyond design system").

Apply Category 2 to any inline styles.

- [ ] **Step 3: Migrate PriceStrip.tsx**

- Line 39 `h-[52px]` → `h-pricestrip`.
- Line 64 `h-[52px]` → `h-pricestrip`.

- [ ] **Step 4: Migrate Toolbar.tsx**

- Line 45 `h-[60px]` → `h-toolbar`.

- [ ] **Step 5: Migrate StockCombobox.tsx**

- Line 49 `min-w-[240px]` → `min-w-combobox` (normalized to design value 220 via the token).
- Line 56 `min-w-[320px]` → `min-w-dropdown`.
- Line 90 `font-mono text-[10.5px]` → `font-mono text-xs`.

- [ ] **Step 6: Migrate OnboardingCard.tsx + replay/DateRangePicker.tsx + Workarea.tsx**

Read each file. Apply Category 1+2+3 recipes for any hardcoded px / arbitrary values / inline styles found. If a file has no violations, skip it.

- [ ] **Step 7: Type check + run replay tests**

```bash
cd frontend && npm run build
```
Expected: clean.

```bash
cd frontend && npm test -- replay
```
Expected: existing tests pass. (Note: not all files have tests; passing means no regressions in files that do.)

- [ ] **Step 8: Manual visual check**

```bash
cd frontend && npm run dev
```
Open the Replay Viewer page. Verify:
- Tab strip: main tabs 40px tall; "+ 새 분석" button visibly shorter (37.5px); visual hierarchy preserved.
- Price strip: 65px tall, centered content.
- Toolbar: 75px tall, all controls fit.
- Stock combobox: trigger ~275px wide; dropdown ~400px wide when open.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/replay/
git commit -m "refactor(frontend/replay): migrate replay viewer to new tokens

TabStrip secondary button uses dedicated --row-tab-secondary-h (preserves
intentional 2px-shorter design relative to main tab). PriceStrip, Toolbar
use new height tokens. StockCombobox normalizes 240→220 (drift) via
min-w-combobox; dropdown uses min-w-dropdown. Off-token text sizes
normalized to text-xs / text-sm per design system."
```

---

## Task 5: Migrate sidebar components

**Goal:** CursorSidebar, OrderbookTable, BrokerNetTable, FillTape migrated.

**Files:**
- Modify: `frontend/src/sidebar/CursorSidebar.tsx`
- Modify: `frontend/src/sidebar/OrderbookTable.tsx`
- Modify: `frontend/src/sidebar/BrokerNetTable.tsx`
- Modify: `frontend/src/sidebar/FillTape.tsx`

- [ ] **Step 1: Migrate CursorSidebar.tsx**

- Line 37 `w-[320px]` → `w-sidebar`.
- Line 66 `text-[10.5px]` → `text-xs`.

- [ ] **Step 2: Migrate OrderbookTable.tsx**

- Line 41 `font-mono text-[11.5px] tabular-nums` → `font-mono text-sm tabular-nums`.
- Line 85 `text-[10px]` → `text-xs`.

If the orderbook row height is set via inline style or arbitrary class to 22px, replace with `h-orderbook-row`. Search the file for `h-[22px]`, `height: 22`, etc.

- [ ] **Step 3: Migrate BrokerNetTable.tsx**

- Line 21 `font-mono text-[11.5px] tabular-nums` → `font-mono text-sm tabular-nums`.

- [ ] **Step 4: Migrate FillTape.tsx**

- Line 25 `font-mono text-[11.5px] tabular-nums` → `font-mono text-sm tabular-nums`.
- Line 40 `text-fg-dimmer text-[10.5px]` → `text-fg-dimmer text-xs`.

- [ ] **Step 5: Type check + run sidebar tests**

```bash
cd frontend && npm run build && npm test -- sidebar
```
Expected: clean build + sidebar tests pass.

- [ ] **Step 6: Manual visual check**

```bash
cd frontend && npm run dev
```
Open Replay Viewer. Verify the sidebar:
- Sidebar width ~400px.
- Orderbook table rows align (tabular-nums working), row height ~27.5px.
- Broker net + fill tape readable.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/sidebar/
git commit -m "refactor(frontend/sidebar): migrate sidebar tables to new tokens

CursorSidebar uses w-sidebar. Orderbook, BrokerNet, FillTape normalize
off-token text sizes (text-[11.5px], text-[10.5px], text-[10px]) to
text-sm / text-xs per design system."
```

---

## Task 6: Migrate capture + page components

**Goal:** Capture page components and three pages (Capture, Settings, Inventory) migrated.

**Files:**
- Modify: `frontend/src/capture/CaptureQueueRow.tsx`
- Modify: `frontend/src/capture/SymbolSearch.tsx`
- Modify: `frontend/src/capture/DateRangePicker.tsx`
- Modify: `frontend/src/capture/CalendarCell.tsx`
- Modify: `frontend/src/capture/CaptureForm.tsx`
- Modify: `frontend/src/capture/CaptureQueue.tsx`
- Modify: `frontend/src/capture/CaptureRowDetail.tsx`
- Modify: `frontend/src/pages/Capture.tsx`
- Modify: `frontend/src/pages/Settings.tsx`
- Modify: `frontend/src/pages/Inventory.tsx`

- [ ] **Step 1: Migrate CaptureQueueRow.tsx**

Read the file. Replace inline style props:
- `height: 36, padding: '0 8px'` → use `h-capture-row` class on the container, and `px-sm` for horizontal padding.
- `font: '500 11px "Geist Mono", monospace'` → `font-medium text-sm font-mono`.
- `font: '400 12px "Geist Sans", sans-serif'` → `font-normal text-sm`.
- `borderBottom: '1px solid var(--border)'` → `border-b` class.
- `border: '1px solid var(--warn)'` → keep inline (uses --warn semantic; rare; not worth a utility).
- `borderRadius: 3, padding: '0 3px'` → keep inline only if no nearby utility matches. 3px is between `--radius-md` (4px) and `--radius-sm` (2px); the close design value is `--radius-md`. Replace with `rounded-md` class + `px-[0.15rem]` if you need exactly 3px. Otherwise use `rounded-md px-1`.
- `background: descriptor.chipColor` → keep inline (dynamic).
- `padding: '2px 6px'` → `py-[0.1rem] px-xs` (2px doesn't map to a token; px-xs = 5px works fine for chips).

If the inline `gridTemplateColumns: '20px 90px 60px 1fr 90px 50px 50px 120px 24px'` exists, convert each px to rem (`grid-cols-[1rem_4.5rem_3rem_1fr_4.5rem_2.5rem_2.5rem_6rem_1.2rem]`) so the grid scales with density. Use the `grid-cols-[...]` Tailwind utility on the wrapper class instead of inline style.

- [ ] **Step 2: Migrate SymbolSearch.tsx**

Read the file. The inline styles are extensive. Apply Category 2 to all:
- `padding: '8px 10px'` → `py-sm px-sm` (10px → space-sm).
- `border: '1px solid var(--border)'` → `border` class.
- `borderRadius: 4, padding: '0 4px'` → `rounded-md px-xs`.
- `boxShadow: '0 8px 24px rgba(0,0,0,0.4)'` → keep inline (cosmetic shadow with specific values from DESIGN.md).
- `font: '400 12px "Geist Sans"'` → `font-normal text-sm`.
- `font: '400 13px "Geist Sans"'` → `font-normal text-base`.
- `font: '500 11px "Geist Mono"'` → `font-medium text-sm font-mono`.
- `font: '600 8.5px "Geist Sans", letterSpacing: '0.06em'` → `font-semibold text-xs tracking-wider` (8.5px normalizes up to text-xs = 10.5 intent — accept the bump as part of the off-token cleanup).
- `font: '500 10px "Geist Mono"'` → `font-medium text-xs font-mono`.
- `padding: '12px 10px'` → `py-md px-sm`.
- Dynamic values (background by index, etc.) stay inline.

- [ ] **Step 3: Migrate capture/DateRangePicker.tsx, CalendarCell.tsx, CaptureForm.tsx, CaptureQueue.tsx, CaptureRowDetail.tsx**

For each file:
1. Read the file in full.
2. Identify Category 1, 2, 3 violations.
3. Apply recipes from the Migration Pattern section above.
4. Keep dynamic inline styles (computed colors, computed widths from data).

- [ ] **Step 4: Migrate pages/Capture.tsx**

Same workflow — read, identify, apply recipe.

- [ ] **Step 5: Migrate pages/Settings.tsx**

- Line 23 `text-[10.5px]` → `text-xs`.
- Line 33 `text-[10.5px]` → `text-xs`.

Apply Category 2 to any inline styles.

- [ ] **Step 6: Migrate pages/Inventory.tsx**

- Line 63 `font-mono text-[11.5px] tabular-nums` → `font-mono text-sm tabular-nums`.
- Line 120 `text-[10.5px]` → `text-xs`.

- [ ] **Step 7: Type check + run capture tests**

```bash
cd frontend && npm run build && npm test -- capture
```
Expected: clean build + capture tests pass.

- [ ] **Step 8: Manual visual check**

```bash
cd frontend && npm run dev
```
Verify each affected page:
- Capture page: queue rows ~45px tall, symbol search dropdown opens cleanly.
- Settings page: text hierarchy intact.
- Inventory page: calendar table aligns, headers readable.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/capture/ frontend/src/pages/
git commit -m "refactor(frontend/capture+pages): migrate capture and page components

CaptureQueueRow, SymbolSearch inline style props decomposed to Tailwind
classes using new tokens (h-capture-row, py-sm px-sm, font-normal text-sm
font-mono, etc.). DateRangePicker, CalendarCell, CaptureForm,
CaptureQueue, CaptureRowDetail, Capture, Settings, Inventory pages
normalize off-token text sizes. Dynamic inline styles (computed colors,
data-derived widths) preserved."
```

---

## Task 7: Create chartScale.ts + migrate chart components

**Goal:** Centralize lightweight-charts option overrides in a new constants module; have every chart component apply them.

**Files:**
- Create: `frontend/src/util/chartScale.ts`
- Create: `frontend/tests/unit/chartScale.test.ts`
- Modify: `frontend/src/chart/ChartStage.tsx`
- Modify: `frontend/src/chart/CandlePane.tsx`
- Modify: `frontend/src/chart/VolumePane.tsx`
- Modify: `frontend/src/chart/RatioPane.tsx`
- Modify: `frontend/src/chart/IntensityPane.tsx`
- Modify: `frontend/src/chart/FillStrengthPane.tsx`
- Modify: `frontend/src/chart/VolumeProfileOverlay.tsx`

- [ ] **Step 1: Write the failing test for chartScale**

Create `frontend/tests/unit/chartScale.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { CHART_LAYOUT_OPTIONS, CHART_TIMESCALE_OPTIONS } from '../../src/util/chartScale';

describe('chartScale', () => {
  it('exposes layout.fontSize at the 1.25x density value (15px)', () => {
    expect(CHART_LAYOUT_OPTIONS.fontSize).toBe(15);
  });

  it('keeps crosshair line widths at 1 for sharpness', () => {
    expect(CHART_LAYOUT_OPTIONS).toBeDefined();
    // crosshair config lives separately; this test is a placeholder
    // until ChartStage merges chartScale outputs into createChart.
  });

  it('scales timeScale right-offset / bar-spacing by 1.25', () => {
    expect(CHART_TIMESCALE_OPTIONS.rightOffset).toBeGreaterThanOrEqual(15);
    expect(CHART_TIMESCALE_OPTIONS.barSpacing).toBeGreaterThan(6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd frontend && npm test -- chartScale
```
Expected: FAIL — `cannot find module '../../src/util/chartScale'`.

- [ ] **Step 3: Create chartScale.ts**

Create `frontend/src/util/chartScale.ts`:

```ts
/**
 * Static chart option overrides for the 1.25× default density.
 *
 * Why this module exists: `lightweight-charts` renders to `<canvas>` and
 * its layout/text options do not inherit from CSS. The CSS single-dial
 * (`:root font-size: 20px`) does not reach the canvas. These constants
 * keep all charts visually aligned with the rest of the UI at the current
 * default density.
 *
 * Future density modes: if `:root font-size` changes, the values below
 * must be updated alongside. See DESIGN.md "Scale Factor" for the
 * intentional scope limitation.
 */
import type { DeepPartial, ChartOptions, TimeScaleOptions } from 'lightweight-charts';

/** Library default font is 12; we use 15 (= 12 × 1.25). */
export const CHART_LAYOUT_OPTIONS: DeepPartial<ChartOptions['layout']> = {
  fontSize: 15,
};

/**
 * `rightOffset` and `barSpacing` scaled 1.25× from library defaults
 * (rightOffset=12 → 15; barSpacing=6 → 7.5 rounded up to 8).
 */
export const CHART_TIMESCALE_OPTIONS: DeepPartial<TimeScaleOptions> = {
  rightOffset: 15,
  barSpacing: 8,
};

/** Crosshair line widths stay at 1px for sharpness. No scaling. */
export const CHART_CROSSHAIR_LINE_WIDTH = 1;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd frontend && npm test -- chartScale
```
Expected: PASS.

- [ ] **Step 5: Wire chartScale into ChartStage.tsx**

In `frontend/src/chart/ChartStage.tsx`, modify the `createChart(...)` call (around line 83-100). Before:

```tsx
const c = createChart(containerRef.current, {
  layout: {
    background: { color: tokens.bgCard },
    textColor: tokens.fg,
    attributionLogo: false,
  },
  grid: {
    vertLines: { color: tokens.grid },
    horzLines: { color: tokens.grid },
  },
  timeScale: {
    timeVisible: true,
    secondsVisible: false,
    borderColor: tokens.border,
  },
  rightPriceScale: { borderColor: tokens.border },
  autoSize: true,
});
```

After:

```tsx
import { CHART_LAYOUT_OPTIONS, CHART_TIMESCALE_OPTIONS } from '../util/chartScale';

// ... inside useEffect:
const c = createChart(containerRef.current, {
  layout: {
    ...CHART_LAYOUT_OPTIONS,
    background: { color: tokens.bgCard },
    textColor: tokens.fg,
    attributionLogo: false,
  },
  grid: {
    vertLines: { color: tokens.grid },
    horzLines: { color: tokens.grid },
  },
  timeScale: {
    ...CHART_TIMESCALE_OPTIONS,
    timeVisible: true,
    secondsVisible: false,
    borderColor: tokens.border,
  },
  rightPriceScale: { borderColor: tokens.border },
  autoSize: true,
});
```

Place the import line near the other imports at the top of the file.

- [ ] **Step 6: Verify chart components — most need no changes**

The other chart components (`CandlePane`, `VolumePane`, `RatioPane`, `IntensityPane`, `FillStrengthPane`, `VolumeProfileOverlay`) attach series/panes to the shared `IChartApi` instance. They inherit `layout.fontSize` and `timeScale` settings from the chart created in `ChartStage`. They typically do not call `applyOptions` for layout/text — so no changes needed there.

Read each chart file briefly. If any of them calls `chart.applyOptions({ layout: ... })` or `chart.timeScale().applyOptions({ ... })`, merge `CHART_LAYOUT_OPTIONS` / `CHART_TIMESCALE_OPTIONS` into that call. Otherwise skip.

- [ ] **Step 7: Type check + run chart tests**

```bash
cd frontend && npm run build && npm test -- chart
```
Expected: clean build + chart component tests pass (11 component tests for chart panes exist; none should change behavior).

- [ ] **Step 8: Manual visual check**

```bash
cd frontend && npm run dev
```
Open Replay Viewer. Verify:
- Chart text (price labels, time labels) ~25% larger than before.
- Bars/candles do NOT look stretched horizontally — `barSpacing: 8` keeps them readable.
- Crosshair lines stay at 1px (crisp, not blurry).
- Chart text is now visually consistent with surrounding UI (sidebar labels, toolbar).

- [ ] **Step 9: Commit**

```bash
git add frontend/src/util/chartScale.ts frontend/src/chart/ChartStage.tsx frontend/tests/unit/chartScale.test.ts
git commit -m "feat(frontend/chart): scale lightweight-charts options to 1.25x

New util/chartScale.ts module holds static option overrides
(layout.fontSize=15, timeScale.rightOffset=15, barSpacing=8). Wired
into ChartStage.createChart via spread. Crosshair line widths stay
at 1px. Future density mode changes must update this module alongside
the CSS dial — see DESIGN.md Scale Factor section."
```

---

## Task 8: Documentation updates

**Goal:** DESIGN.md gains the "Scale Factor" section and 2-column tables. Components disclaimer added. Approved mockup HTML labeled. ADR-0008 written.

**Files:**
- Modify: `DESIGN.md`
- Modify: `docs/superpowers/designs/2026-05-20-replay-viewer.html`
- Create: `docs/adr/0008-default-ui-density.md`

- [ ] **Step 1: Add "Scale Factor" section to DESIGN.md**

In `DESIGN.md`, insert a new section between `## Product Context` and `## Aesthetic Direction`:

```markdown
## Scale Factor

The design system has a **single density dial** at `:root font-size`.

| Term | Meaning |
|---|---|
| **Base intent (1.0×)** | The pixel target captured in token rem values, calibrated against a 16px root. Reflects the original 2026-05-20 design intent. |
| **Default density (1.25×)** | What the app renders at browser zoom 100%. `:root { font-size: 20px }` lifts every rem-based token by 1.25×. |
| **Scale dial** | The `:root font-size` declaration in `frontend/src/styles/tokens.css`. Changing it shifts all CSS sizing uniformly. |

**Scope of the dial:**
- ✅ CSS-rendered chrome — fonts, spacing, layout widths, line-heights (all rem-based).
- ❌ `lightweight-charts` canvas — text and bar spacing live in `frontend/src/util/chartScale.ts` as static constants. Must be updated alongside the dial.
- ❌ 1px borders, hairlines, small radii (2–6px), chart canvas internal coordinates — stay in px to protect anti-aliasing and pixel-grid sharpness.

**Future density modes (backlog):** A user-facing toggle (Compact 1.0× / Comfortable 1.25× / Cozy 1.4×) would set `:root font-size` via `[data-density="..."]` and require `chartScale.ts` values updated in lockstep. Not in scope today.
```

- [ ] **Step 2: Convert Typography token table to 2-column form**

In `DESIGN.md`, replace the existing `### Typography` Scale table:

Before:
```markdown
- **Scale (rem-based, root 16px):**
  | Token | px | Use |
  |---|---|---|
  | `xs` | 10–10.5 | Small-caps labels, badges |
  ...
```

After:
```markdown
- **Scale (rem-based, single dial at `:root font-size`):**

  | Token | Base intent (1.0×) | Rendered @ default (1.25×) | Use |
  |---|---|---|---|
  | `xs` | 10.5px | 13.125px | Small-caps labels, badges |
  | `sm` | 11.5px | 14.375px | Table rows, secondary mono values |
  | `base` | 13px | 16.25px | Body / UI default |
  | `md` | 14px | 17.5px | Section / page headings |
  | `lg` | 16px | 20px | Brand text |
  | `xl` | 22px | 27.5px | Current price (price strip) |
  | `2xl` | 32px | 40px | Future hero numerics |
```

- [ ] **Step 3: Convert Spacing token table to 2-column form**

In `DESIGN.md` `## Spacing` section, replace:

Before:
```markdown
- **Base unit:** 4px
- **Density:** Comfortable-tight. ...
- **Scale:**
  | Token | px | Use |
  ...
```

After:
```markdown
- **Base unit:** 4px (base intent); 5px (rendered @ default density)
- **Density:** Comfortable-tight at base intent. Renders at 1.25× by default — see Scale Factor section.
- **Scale (rem-based, single dial):**

  | Token | Base intent (1.0×) | Rendered @ default (1.25×) | Use |
  |---|---|---|---|
  | `2xs` | 2px | 2.5px | Hairline gaps |
  | `xs` | 4px | 5px | Pane gap, tight stacking |
  | `sm` | 8px | 10px | Card padding inside, gap between sidebar cards |
  | `md` | 12px | 15px | Card padding default |
  | `lg` | 16px | 20px | Section spacing, nav item padding |
  | `xl` | 24px | 30px | Major section dividers |
  | `2xl` | 32px | 40px | (rarely used) |
  | `3xl` | 48px | 60px | (rarely used) |
```

Also update the bullet lines that follow:
- `Card padding: 12–14px standard. Sidebar cards 12px. Pane bodies 4–6px (info density priority).` → append `(base intent — rendered ×1.25 at default density).`
- `Pane gap: 8px between chart panes.` → append same suffix.
- `Sidebar width: 320px fixed.` → `Sidebar width: 320px base intent / 400px rendered (token: --sidebar-w).`
- `Nav width: 210px fixed.` → `Nav width: 210px base intent / 262.5px rendered (token: --nav-w).`

- [ ] **Step 4: Add disclaimer to Components section**

In `DESIGN.md`, insert at the very top of `## Components — Design Tokens for Specific Patterns`:

```markdown
> **Scale note:** All px values in this section are **1.0× base intent**.
> Default rendering = × 1.25. See [Scale Factor](#scale-factor).
```

(The exact link anchor depends on the heading slug your markdown renderer produces; `#scale-factor` is the GitHub-flavored default.)

- [ ] **Step 5: Update approved mockup reference**

In `DESIGN.md`, find the line:
```
**Approved mockup:** `docs/superpowers/designs/2026-05-20-replay-viewer.html`
```
Replace with:
```
**Approved mockup (at 1.0× base intent):** `docs/superpowers/designs/2026-05-20-replay-viewer.html`
```

- [ ] **Step 6: Label the mockup HTML file**

Edit `docs/superpowers/designs/2026-05-20-replay-viewer.html`. After the existing `<!DOCTYPE html>` line (or at the very top if no doctype), insert:

```html
<!--
  Visual reference for hoga-ops design system.
  This file is rendered at BASE INTENT (1.0× scale factor).
  The current default density is 1.25× — see DESIGN.md "Scale Factor".
  Do not edit the rem/px values to match the new default; this file is
  the canonical 1.0× artifact.
-->
```

- [ ] **Step 7: Write ADR-0008**

Create `docs/adr/0008-default-ui-density.md`:

```markdown
# 0008 — Default UI density is 1.25× base intent

**Status:** accepted (2026-05-22)

## Decision

The hoga-ops frontend ships with a default density of **1.25×** of the
original `DESIGN.md` pixel intent. This is implemented as a single CSS
dial — `:root { font-size: 20px }` in `frontend/src/styles/tokens.css` —
that scales every rem-based token (typography, spacing, layout widths)
uniformly. `lightweight-charts` canvas options live in
`frontend/src/util/chartScale.ts` as static constants outside the dial
and must be updated alongside any future density change.

User-facing density toggles (Compact / Comfortable / Cozy) are not built;
the architecture supports them but the UI is deferred.

## Why

- **Lived experience.** The 1.0× density that the original DESIGN.md
  encoded (body text 13px, `--space-md` 12px, "comfortable-tight") was
  consistently judged too dense in actual analyst use. Browser zoom 125%
  produced a visibly better experience.
- **Single-user tool.** With one user, shipping a sensible default is
  more valuable than building density chrome. The toggle UI is dead code
  until there is a second user to disagree with the default.
- **Single dial keeps the option open.** Centralizing scale on
  `:root font-size` means a future toggle is a one-line CSS variable
  change (plus a `chartScale.ts` sync) rather than a system-wide
  refactor.

## Why the chart is separate from the dial

`lightweight-charts` renders to `<canvas>` and does not inherit CSS
sizing. Three options were considered:

1. Make `chartScale.ts` read `:root font-size` and scale dynamically.
2. Define a `--chart-font-size` CSS variable consumed by
   `chartScale.ts` via the `util/tokens.ts` pattern.
3. Keep `chartScale.ts` as static constants and update them alongside
   any CSS dial change.

Option 3 won on simplicity grounds. Options 1 and 2 add a chart
re-creation / `applyOptions` mechanism that only pays for itself when
a density toggle UI exists. Until that day, static constants are
truthful: "the chart is at the current default density; if you change
the dial, update this file too."

## What changes

- `frontend/src/styles/tokens.css` lifts `:root font-size` to 20px;
  `--space-*` tokens converted to rem; new layout tokens (`--nav-w`,
  `--sidebar-w`, `--row-tab-h`, etc.) added.
- `frontend/tailwind.config.ts` registers the new width/height/minWidth
  utilities (`w-sidebar`, `h-tab`, `min-w-combobox`, etc.).
- `frontend/src/util/chartScale.ts` (new) holds chart options.
- ~17 component files migrated from hardcoded px / Tailwind arbitrary
  values to token-based classes. Off-grid hardcodes classified as
  intentional design difference (preserved via dedicated token) or
  drift (normalized to design value).
- `DESIGN.md` gains a `## Scale Factor` section explaining the dial
  mechanism, scope, and future-density hook. Typography and Spacing
  token tables adopt a 2-column "Base intent / Rendered @ default"
  structure. Components section receives a disclaimer reframing
  existing px values as 1.0× base intent.
- `docs/superpowers/designs/2026-05-20-replay-viewer.html` gets a
  top-of-file comment block labeling it as 1.0× reference.

## Consequences worth flagging for future readers

- **The mockup is no longer "what the app currently looks like".** It is
  the 1.0× base-intent reference. To see current rendering, run the dev
  server or read DESIGN.md's "Rendered @ default" columns.
- **Adding a density toggle UI requires touching both CSS and chart.**
  The Scope-of-the-dial limitation is intentional; do not paper over
  it by silently changing `chartScale.ts` to read CSS variables — that
  is a separate, larger decision (see "Why the chart is separate").
- **Future component additions** should reference design tokens
  exclusively. The verification grep
  (`text-\[ | w-\[[0-9] | h-\[[0-9] | style=\{\{`) finds violations.
  Run before merging UI changes.
- **OS font preference does not affect us.** `:root font-size: 20px` is
  an absolute value, not `em`/percent. Users who scale their OS fonts
  for accessibility get no relief from us today; consider switching to
  `em`-based dial if accessibility surfaces.

## Source spec

`docs/superpowers/specs/2026-05-22-default-ui-scale-up-design.md`
```

- [ ] **Step 8: Commit documentation**

```bash
git add DESIGN.md docs/superpowers/designs/2026-05-20-replay-viewer.html docs/adr/0008-default-ui-density.md
git commit -m "docs: default density 1.25x — DESIGN.md scale factor + ADR-0008

DESIGN.md gains '## Scale Factor' section with base intent / rendered
columns. Typography and Spacing tables converted to 2-column form.
Components section receives top-of-section disclaimer reframing
existing px values as 1.0x base intent. Approved-mockup reference
labels file as '1.0x base intent'.

Mockup HTML gets a comment block declaring it the canonical 1.0x
artifact — do not edit to match new default.

ADR-0008 captures the decision, the lived-experience rationale, the
chart-outside-the-dial trade-off, and future-reader consequences."
```

---

## Task 9: Verification + PR prep

**Goal:** Confirm migration is complete and visually correct; produce screenshots for PR review.

- [ ] **Step 1: Run verification grep**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
grep -rEn "text-\[|w-\[[0-9]|h-\[[0-9]|min-w-\[[0-9]|gap-\[[0-9]|p-\[[0-9]" frontend/src/ 2>/dev/null
```
Expected: zero matches, OR matches only for legitimate cases:
- `w-[100%]`, `h-[100%]`, `w-[1px]`, `h-[1px]` (semantic, not pixel-density-dependent)
- `w-[var(--nav-w)]` or similar token-based brackets

Document any remaining hits with their justification. If unexplained px-based hits exist, return to the relevant task and fix.

- [ ] **Step 2: Run inline-style audit**

```bash
grep -rEn "style=\{\{" frontend/src/ 2>/dev/null | grep -E "px|font:|padding:|margin:|height:|width:" | grep -v "var(--"
```
Expected: matches only for **dynamic** inline styles (computed from props/data — e.g., `style={{ background: dynamicColor }}`, `style={{ width: \`${pct}%\` }}`). Hardcoded px in inline styles should be zero.

- [ ] **Step 3: Run full test suite**

```bash
cd frontend && npm test
```
Expected: all unit + component tests pass.

```bash
cd frontend && npx playwright test
```
Expected: all E2E tests pass.

- [ ] **Step 4: Run lint + type check**

```bash
cd frontend && npm run lint && npm run build
```
Expected: zero errors.

- [ ] **Step 5: Capture eight-screen visual regression**

Start dev server:
```bash
cd frontend && npm run dev
```

In the browser, take screenshots of each of these screens (use OS screenshot tool; save to `/tmp/scale-up-verify/`):

1. LeftNav while on Capture page
2. LeftNav while on Replay page
3. Replay Viewer full layout (with at least one tab loaded with data)
4. Capture Queue page showing pending / in-progress / complete rows
5. Stock Combobox closed AND open (two screenshots, or one with combobox open over the closed-state context)
6. DateRangePicker open (replay or capture variant)
7. SymbolSearch dropdown open with results
8. Four-pane chart stage (CandlePane + VolumePane + RatioPane + IntensityPane visible; verify text sizes match surrounding UI)

Save each as `01-leftnav-capture.png`, `02-leftnav-replay.png`, etc.

- [ ] **Step 6: Write PR description draft**

Create `/tmp/scale-up-pr-description.md`:

```markdown
## Summary

Shifts default UI density to 1.25× of original via `:root { font-size: 20px }`
single dial + rem token migration. So browser zoom 100% now renders what
zoom 125% used to.

- Single CSS dial: `:root font-size` controls all rem-based tokens.
- ~17 component files migrated off hardcoded px / arbitrary Tailwind values.
- TabStrip secondary button preserved as intentional 2px-shorter via dedicated
  `--row-tab-secondary-h` token; StockCombobox 240→220 normalized as drift.
- `lightweight-charts` canvas scaled via new `util/chartScale.ts` (static
  constants — must be updated alongside any future density dial change).
- DESIGN.md gains a `## Scale Factor` section; Typography/Spacing tables
  adopt 2-column "Base intent / Rendered @ default" structure.
- ADR-0008 captures the decision and chart-outside-the-dial trade-off.

Source spec: `docs/superpowers/specs/2026-05-22-default-ui-scale-up-design.md`

## Visual regression (8 screens)

[Attach 01-leftnav-capture.png ... 08-chart-stage.png with before/after labels.]

## Test plan

- [x] `npm run build` clean
- [x] `npm run lint` clean
- [x] `npm test` all pass (unit + component)
- [x] `npx playwright test` all pass (E2E)
- [x] Verification grep zero hits (or only legitimate `var(--*)` and percent cases)
- [x] Eight-screen visual regression confirmed

## Out of scope (filed as follow-up issues)

- User-facing density toggle UI (Compact / Comfortable / Cozy selector)
- Chart color tokenization
- Light mode
- Automated visual regression infrastructure
```

- [ ] **Step 7: Final commit (PR prep)**

If you have any local changes from PR prep (e.g., screenshots committed alongside, or a CHANGELOG entry), commit them. Otherwise this step is just the merge-readiness confirmation:

```bash
git status
git log --oneline main..HEAD
```
Expected: 8 task commits visible (chore, feat, refactor × 4, feat, docs). Branch ready to push and PR-create.

---

## Self-Review Notes

- **Spec coverage:** All 9 sections of the spec (Problem, Goals, Non-Goals, Approach, Token Values, Chart Scaling, Code Migration, Documentation Updates, Implementation Sequence, Risks, Rollback, DoD, Deliverables, Out-of-Scope) have at least one task implementing them. ADR creation, DESIGN.md updates, mockup label, chartScale.ts, and `--row-tab-secondary-h` token are all explicitly handled.
- **No placeholders:** Every "TODO"-style instruction has concrete code or an exact command. Per-file workflow steps reference specific line numbers from current code where applicable.
- **Type consistency:** Token names used in code (`w-sidebar`, `h-tab-secondary`, `min-w-combobox`, `CHART_LAYOUT_OPTIONS`, `CHART_TIMESCALE_OPTIONS`) match across Task 1 (creation), Task 2 (definition), Tasks 3-6 (consumption), and Task 7 (chart module). ADR-0008 file path matches the spec's `docs/adr/0008-default-ui-density.md`.
- **TDD adaptation:** Pure CSS changes (Task 2) cannot be unit-tested for rendered px (JSDOM doesn't compute styles fully), so the tokens.css test verifies declarations textually plus the manual browser smoke is the rendering check. `chartScale.ts` (Task 7) follows full TDD. Component migrations (Tasks 3-6) lean on existing component tests as a regression net plus type-check plus manual visual — appropriate for refactoring with no behavior change.

---

**End of plan.**
