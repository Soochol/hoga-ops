# Ratio Pane Baseline Colors + Hide Last-Value Lines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the Replay Viewer's bid/ask Ratio pane to a 0-baseline color split (blue above 0 for ask-heavy, red below 0 for bid-heavy), and suppress the redundant last-value horizontal line on both Ratio and Volume panes.

**Architecture:** Add one new design token `--ratio-ask` (#3B82F6) to `tokens.css` + DESIGN.md. Replace `RatioPane.tsx`'s `LineSeries` with `BaselineSeries` configured with the new blue token above 0 and the existing `--down` token below 0; add `priceLineVisible: false` to suppress the library-default last-value line; recolor the explicit 0-baseline `createPriceLine` to neutral `--fg-dimmer`. Add `priceLineVisible: false` to `VolumePane.tsx`'s `HistogramSeries`.

**Tech Stack:** TypeScript, React functional components, `lightweight-charts` v5.2 (`BaselineSeries`, `HistogramSeries`), CSS custom properties, the project's `resolveTokens` helper, the `browse` skill for visual verification.

**Spec:** `docs/superpowers/specs/2026-05-23-ratio-pane-baseline-colors-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `frontend/src/styles/tokens.css` | Modify | Add `--ratio-ask: #3B82F6;` in the Chart & Heatmap section. |
| `DESIGN.md` | Modify | Add the `--ratio-ask` row to the color token table. |
| `frontend/src/chart/RatioPane.tsx` | Modify | Replace `LineSeries` with `BaselineSeries`. Add `rgba` helper. Update `TOKEN_SPEC` to `ratioAsk`/`ratioBid`. Disable last-value line. Recolor the 0-baseline `createPriceLine` to `--fg-dimmer`. |
| `frontend/src/chart/VolumePane.tsx` | Modify | Add `priceLineVisible: false` to the `HistogramSeries` options. |

No new files, no test files (see spec § Testing — neither change has a meaningful unit-level assertion beyond tautology).

---

## Task 1: Add the `--ratio-ask` design token

**Files:**
- Modify: `frontend/src/styles/tokens.css`
- Modify: `DESIGN.md`

### Step 1: Add the CSS variable

Open `frontend/src/styles/tokens.css`. Locate the `Color · Chart & Heatmap` section (around lines 41-44):

```css
  /* ───── Color · Chart & Heatmap ───── */
  --grid: #1A1A26;
  --heat-lo: #0E1A1A;
  --heat-hi: #14B8A6;
```

Append one line after `--heat-hi`:

```css
  /* ───── Color · Chart & Heatmap ───── */
  --grid: #1A1A26;
  --heat-lo: #0E1A1A;
  --heat-hi: #14B8A6;
  --ratio-ask: #3B82F6;  /* Bid/ask ratio — ask-heavy (above 0), KRX-style sell blue */
```

- [ ] **Step 1 complete:** `--ratio-ask` declared in tokens.css.

### Step 2: Add the DESIGN.md row

Open `DESIGN.md`. Locate the color token table (around lines 80-87). Add one row after `--heat-hi`:

```markdown
  | `--heat-hi` | `#14B8A6` | Heatmap high intensity (teal ramp) |
  | `--ratio-ask` | `#3B82F6` | Ratio pane — ask-heavy fill/line (above 0 baseline). Distinct from `--down` which encodes price direction; this encodes order-book pressure (KRX convention). |
```

The pipe-table column count must match the header (3 columns). Verify by reading lines 73-88 after the edit — every row should have exactly 4 pipes.

- [ ] **Step 2 complete:** DESIGN.md token table updated.

### Step 3: Commit Task 1

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
git add frontend/src/styles/tokens.css DESIGN.md
git diff --cached --stat
```

Expected staged stat: two files, ~2 insertions total.

```bash
git -c commit.gpgsign=false commit -m "$(cat <<'EOF'
feat(design): --ratio-ask token for bid/ask ratio pane

Adds #3B82F6 (Tailwind blue-500) as the ask-heavy color above the
0-baseline in the Replay Viewer's Ratio pane. KRX-convention sell blue;
intentionally distinct from --down (price-direction red).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3 complete:** Token added, commit lands.

---

## Task 2: RatioPane — BaselineSeries with split colors

**Files:**
- Modify: `frontend/src/chart/RatioPane.tsx`

### Step 1: Read the current file

Read `frontend/src/chart/RatioPane.tsx` end-to-end (it's ~85 lines). Confirm it:
- Imports `LineSeries` from `lightweight-charts`.
- Declares `TOKEN_SPEC = { accent: ['--accent', '#14B8A6'] }`.
- Calls `chart.addSeries(LineSeries, { color: accent, lineWidth: 1.4, priceFormat: {...} }, paneIndex)`.
- Calls `series.createPriceLine({ price: 0, color: accent, ... })` after `setData`.
- Returns null.

If the file no longer matches, STOP and reconcile against this plan before editing.

- [ ] **Step 1 complete:** file matches expected shape.

### Step 2: Update the import line

Change the lightweight-charts import:

```ts
// before
import { LineSeries, type IChartApi } from 'lightweight-charts';

// after
import { BaselineSeries, type IChartApi } from 'lightweight-charts';
```

- [ ] **Step 2 complete:** import swapped.

### Step 3: Replace `TOKEN_SPEC`

Change:

```ts
const TOKEN_SPEC = { accent: ['--accent', '#14B8A6'] } as const;
```

to:

```ts
const TOKEN_SPEC = {
  ratioAsk: ['--ratio-ask', '#3B82F6'],
  // Reused: same hex as price-direction --down, but here it encodes
  // bid-heavy order-book pressure (below 0). Inline comment marks the
  // semantic distinction so future maintainers don't refactor it away.
  ratioBid: ['--down', '#F43F5E'],
  baseline: ['--fg-dimmer', '#64748B'],
} as const;
```

- [ ] **Step 3 complete:** TOKEN_SPEC carries the three needed tokens.

### Step 4: Add the `rgba` helper

Just below the `Props` type declaration (so it sits above the component), insert:

```ts
/**
 * Convert a `#RRGGBB` hex string to `rgba(R, G, B, a)`. Used to derive
 * the soft gradient fill colors for `BaselineSeries`' top/bottom areas
 * from the solid token colors.
 */
function rgba(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
```

- [ ] **Step 4 complete:** helper present.

### Step 5: Replace the `addSeries` call

Change the body of the `useEffect` from:

```ts
const { accent } = resolveTokens(TOKEN_SPEC);
const series = chart.addSeries(
  LineSeries,
  {
    color: accent,
    lineWidth: 1.4 as any,
    priceFormat: {
      type: 'custom',
      formatter: (v: number) => {
        if (Math.abs(v) < 0.005) return '0';
        const r = (1 + Math.abs(v)).toFixed(1);
        return v >= 0 ? `${r}× S` : `${r}× B`;
      },
      minMove: 0.01,
    },
  },
  paneIndex,
);
```

to:

```ts
const { ratioAsk, ratioBid, baseline } = resolveTokens(TOKEN_SPEC);
const series = chart.addSeries(
  BaselineSeries,
  {
    baseValue: { type: 'price', price: 0 },
    topLineColor: ratioAsk,
    topFillColor1: rgba(ratioAsk, 0.28),
    topFillColor2: rgba(ratioAsk, 0.05),
    bottomLineColor: ratioBid,
    bottomFillColor1: rgba(ratioBid, 0.05),
    bottomFillColor2: rgba(ratioBid, 0.28),
    lineWidth: 1.4 as any,
    // Suppress the library-default horizontal line at the latest value.
    // The right-axis chip still shows the latest value via lastValueVisible.
    priceLineVisible: false,
    priceFormat: {
      type: 'custom',
      formatter: (v: number) => {
        if (Math.abs(v) < 0.005) return '0';
        const r = (1 + Math.abs(v)).toFixed(1);
        return v >= 0 ? `${r}× S` : `${r}× B`;
      },
      minMove: 0.01,
    },
  },
  paneIndex,
);
```

Key changes:
- `addSeries(LineSeries, ...)` → `addSeries(BaselineSeries, ...)`.
- `color: accent` removed (BaselineSeries uses split top/bottom colors instead).
- `baseValue: { type: 'price', price: 0 }` added (the split happens at value=0).
- Six new color fields: `topLineColor`, `topFillColor{1,2}`, `bottomLineColor`, `bottomFillColor{1,2}`. Alpha values 0.28/0.05 mirror lightweight-charts' default BaselineSeries saturation pattern.
- `priceLineVisible: false` added.
- `priceFormat` block is unchanged.

- [ ] **Step 5 complete:** series creation block rewritten.

### Step 6: Recolor the 0-baseline `createPriceLine`

Locate this block (currently uses `color: accent`):

```ts
series.createPriceLine({
  price: 0,
  color: accent,
  lineWidth: 1,
  lineStyle: 1,
  axisLabelVisible: false,
  title: '',
} as any);
```

Replace with:

```ts
// 0-baseline reference line. Drawn explicitly because BaselineSeries
// switches color at baseValue but does not paint a visible line there.
// Color is --fg-dimmer (neutral) so it reads as a reference, not data.
series.createPriceLine({
  price: 0,
  color: baseline,
  lineWidth: 1,
  lineStyle: 1,
  axisLabelVisible: false,
  title: '',
} as any);
```

- [ ] **Step 6 complete:** 0-baseline uses neutral gray.

### Step 7: Type-check

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3/frontend
npx tsc -b
```

Expected: exits 0 with no output. If you see `TS2305: '"lightweight-charts"' has no exported member named 'BaselineSeries'`, the version-pin verification step in the spec is wrong — `grep '"lightweight-charts"' package.json` should print `"lightweight-charts": "^5.2.0"`; v5 is when `BaselineSeries` became a top-level value export.

- [ ] **Step 7 complete:** tsc clean.

### Step 8: Run RatioPane-relevant tests

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3/frontend
npx vitest run src/chart/
```

Expected: all chart-pane tests pass. If a test file named `RatioPane.test.tsx` exists, it asserts on `setData` calls and series mounting, not on series-type or color options — your changes should not break it. If it does break (e.g., the test inspected the `addSeries` first-arg type), STOP and report.

- [ ] **Step 8 complete:** chart-suite tests green.

---

## Task 3: VolumePane — suppress last-value line

**Files:**
- Modify: `frontend/src/chart/VolumePane.tsx`

### Step 1: Read the current file

Read `frontend/src/chart/VolumePane.tsx`. Confirm the `chart.addSeries(HistogramSeries, { ... }, paneIndex)` block has these options:
- `priceFormat: { type: 'custom', formatter: ..., minMove: 1 }`
- `priceScaleId: 'right'`

If the file diverges, reconcile before editing.

- [ ] **Step 1 complete:** file matches expected shape.

### Step 2: Add `priceLineVisible: false`

Locate the `addSeries` options object and add one line after `priceScaleId: 'right'`:

```ts
// before
const series = chart.addSeries(
  HistogramSeries,
  {
    priceFormat: {
      type: 'custom',
      formatter: (v: number) => Math.round(v).toLocaleString('ko-KR'),
      minMove: 1,
    },
    priceScaleId: 'right',
  },
  paneIndex,
);

// after
const series = chart.addSeries(
  HistogramSeries,
  {
    priceFormat: {
      type: 'custom',
      formatter: (v: number) => Math.round(v).toLocaleString('ko-KR'),
      minMove: 1,
    },
    priceScaleId: 'right',
    // Suppress the library-default horizontal line at the latest bar.
    // The right-axis chip still shows the latest total volume.
    priceLineVisible: false,
  },
  paneIndex,
);
```

- [ ] **Step 2 complete:** `priceLineVisible: false` added.

### Step 3: Type-check

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3/frontend
npx tsc -b
```

Expected: exits 0 with no output.

- [ ] **Step 3 complete:** tsc clean.

---

## Task 4: Visual verification via `browse`

**Files:** none modified — observational.

The spec mandates a `browse` pass because both changes are visual-only.

### Step 1: Confirm the dev server is up

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/replay
```

Expected: `200`. Start the dev server with `(cd frontend && npm run dev &)` if needed. Vite HMR reloads CSS and component changes automatically.

- [ ] **Step 1 complete:** dev server returns 200.

### Step 2: Load a populated chart

```bash
B="$HOME/.claude/skills/gstack/browse/dist/browse"
$B goto "http://localhost:5173/replay?tabs=003490:20260519:20260520:1m&active=0"
sleep 3
$B screenshot /tmp/ratio-pane.png
```

`003490` (대한항공) over 2 days gives enough imbalance variation to see the color split.

- [ ] **Step 2 complete:** screenshot taken.

### Step 3: Verify the BaselineSeries colors in the DOM-rendered chart

Read `/tmp/ratio-pane.png` with the `Read` tool. The Ratio pane is the THIRD pane from the top (after Candle and Volume; the order is Candle / Volume / Ratio / Intensity / FillStrength per `ChartStage.tsx` PANE_STRETCH). Confirm:

1. Where the ratio line is above 0, the line and the area beneath it are BLUE (`#3B82F6` looks like a vivid Tailwind blue).
2. Where the ratio line is below 0, the line and the area above it are RED (`#F43F5E`).
3. The line color flips at the 0 crossing.
4. A thin gray (`--fg-dimmer` = `#64748B`) horizontal line runs across the pane at y=0.
5. NO horizontal line is drawn at the latest data point's value on either the Ratio or Volume pane.
6. The right-axis chip still reads `Nx S` (positive) or `Nx B` (negative) for the latest ratio value, and an integer like `9,187` for the latest volume.

- [ ] **Step 3 complete:** all six visual conditions confirmed.

### Step 4: Cross-check the lightweight-charts series options

Synthetic event verification is unreliable for lightweight-charts (see the prior crosshair plan's note). Use a DOM-side check instead — confirm no `<canvas>` paints a fixed-Y horizontal indicator chip at the rightmost data point.

```bash
B="$HOME/.claude/skills/gstack/browse/dist/browse"
$B js "(() => {
  // The right-axis chip uses a small canvas/label overlay. Count visible
  // right-side chips on the ratio pane: should be exactly the lastValue
  // chip (e.g., '2.0× S'), not also a separate priceLine chip.
  const chips = Array.from(document.querySelectorAll('canvas')).filter(c => {
    const r = c.getBoundingClientRect();
    return r.width < 60 && r.height > 0;
  });
  return JSON.stringify({chipCount: chips.length});
})()"
```

This is a soft signal — count is informational, not pass/fail. The authoritative check is Step 3's visual reading.

- [ ] **Step 4 complete:** soft check logged.

---

## Task 5: Commit Tasks 2 + 3

**Files:** `frontend/src/chart/RatioPane.tsx`, `frontend/src/chart/VolumePane.tsx`.

### Step 1: Inspect the staged diff

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
git status -s
git add frontend/src/chart/RatioPane.tsx frontend/src/chart/VolumePane.tsx
git diff --cached --stat
git diff --cached -- frontend/src/chart/RatioPane.tsx frontend/src/chart/VolumePane.tsx
```

Expected diff content:
- `RatioPane.tsx`: `LineSeries` → `BaselineSeries` import swap; new `TOKEN_SPEC` keys (`ratioAsk`, `ratioBid`, `baseline`); new `rgba` helper; new color options on `addSeries`; `priceLineVisible: false` added; `createPriceLine` color changed from `accent` to `baseline`.
- `VolumePane.tsx`: single new line `priceLineVisible: false` in the `HistogramSeries` options.

If any unrelated file is staged, unstage with `git restore --staged <path>` before continuing.

- [ ] **Step 1 complete:** staged diff is exactly the spec.

### Step 2: Commit

```bash
git -c commit.gpgsign=false commit -m "$(cat <<'EOF'
feat(chart/RatioPane,VolumePane): 0-baseline color split + hide last-value lines

RatioPane:
  * LineSeries → BaselineSeries with split top/bottom around 0
  * Above 0 (ask-heavy): blue (--ratio-ask, #3B82F6)
  * Below 0 (bid-heavy): red (--down hex reused, distinct semantic)
  * Soft fill gradient (alpha 0.28 near edge, 0.05 near baseline)
  * priceLineVisible: false to drop the redundant last-value line
  * 0-baseline createPriceLine recolored to --fg-dimmer (neutral)
VolumePane:
  * priceLineVisible: false to drop the redundant last-value line

Right-axis chips (Nx S / Nx B / volume totals) are untouched.

See docs/superpowers/specs/2026-05-23-ratio-pane-baseline-colors-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 2 complete:** commit lands cleanly.

### Step 3: Verify

```bash
git show --stat HEAD
```

Expected: exactly two files (`frontend/src/chart/RatioPane.tsx`, `frontend/src/chart/VolumePane.tsx`). If more, see Step 1 — `git reset --soft HEAD~1`, unstage unrelated, recommit.

- [ ] **Step 3 complete:** commit contains only the intended two files.

---

## Out of Scope (do NOT extend this plan)

- A separate `--ratio-bid` token (reuse `--down` is sufficient).
- A `--ratio-down` rename of `--down` to disambiguate the semantic overload.
- A user toggle between BaselineSeries and the prior LineSeries view.
- Hiding the right-axis `lastValueVisible` chip (user asked only about the LINE).
- Animating the color transition at the 0 crossing.

If the user requests any of these during execution, STOP and brainstorm a new spec.
