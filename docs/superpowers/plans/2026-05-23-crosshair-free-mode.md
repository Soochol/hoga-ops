# Crosshair — Free Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the Replay Viewer chart's crosshair from `lightweight-charts`' default `Magnet` mode (horizontal line snaps to candle close) to `Normal` mode (horizontal AND vertical lines track the actual mouse position).

**Architecture:** Add a `CHART_CROSSHAIR_OPTIONS` export to `frontend/src/util/chartScale.ts` (the existing chart-options center) carrying `{ mode: CrosshairMode.Normal }`. Wire it into the single `createChart(...)` call in `frontend/src/chart/ChartStage.tsx` next to the existing `layout` / `grid` / `timeScale` / `rightPriceScale` options. No new state, no new effect, no prop changes.

**Tech Stack:** TypeScript, React (existing functional component), `lightweight-charts` v5.2 (`CrosshairMode` enum + `CrosshairOptions` type), `browse` skill for visual verification.

**Spec:** `docs/superpowers/specs/2026-05-23-crosshair-free-mode-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `frontend/src/util/chartScale.ts` | Modify | Add `CrosshairMode` import + `CHART_CROSSHAIR_OPTIONS` const export. |
| `frontend/src/chart/ChartStage.tsx` | Modify | Import `CHART_CROSSHAIR_OPTIONS` and pass it into `createChart(..., { crosshair: ... })`. |

No new files, no test files (see spec § Testing — there is nothing meaningful to assert at the unit level).

---

## Task 1: Add `CHART_CROSSHAIR_OPTIONS` to `chartScale.ts`

**Files:**
- Modify: `frontend/src/util/chartScale.ts`

### Step 1: Read the current file

Read `frontend/src/util/chartScale.ts` to confirm its shape:
- Imports `DeepPartial`, `LayoutOptions`, `TimeScaleOptions` (type-only) from `lightweight-charts`.
- Exports `CHART_LAYOUT_OPTIONS`, `CHART_TIMESCALE_OPTIONS`, `CHART_CROSSHAIR_LINE_WIDTH`.

If the file no longer matches this shape, STOP and reconcile against the plan before editing.

- [ ] **Step 1 complete:** file matches expected shape.

### Step 2: Add the `CrosshairMode` value import + `CrosshairOptions` type import

`CrosshairMode` is an enum (a VALUE) so it cannot live under `import type`. `CrosshairOptions` is a TYPE. Two separate imports needed.

Adjust the existing imports so the file's top reads exactly:

```ts
import { CrosshairMode } from 'lightweight-charts';
import type {
  CrosshairOptions,
  DeepPartial,
  LayoutOptions,
  TimeScaleOptions,
} from 'lightweight-charts';
```

Why two import lines: the project uses `verbatimModuleSyntax` style — type-only and value imports are kept separate to avoid bundling the type names into runtime code. The neighbouring chart panes (`CandlePane`, `VolumePane`, etc.) follow the same convention; copy that pattern.

- [ ] **Step 2 complete:** both imports present, no IDE error on the imports.

### Step 3: Add the `CHART_CROSSHAIR_OPTIONS` export

Append this block to the end of `chartScale.ts`, after the existing `CHART_CROSSHAIR_LINE_WIDTH` declaration:

```ts
/**
 * Crosshair behavior. `Normal` (= 0) lets the crosshair track the actual
 * mouse position; the library default (`Magnet` = 1) snaps the horizontal
 * line to the close of the candle under the cursor, which makes off-candle
 * price readouts feel wrong. We want exact mouse tracking — the price-axis
 * label then reflects the cursor's Y, not a snapped close.
 *
 * `CHART_CROSSHAIR_LINE_WIDTH` above stays a separate constant; line width
 * lives under `crosshair.vertLine` / `crosshair.horzLine` subfields and is
 * not part of this `mode`-only override.
 */
export const CHART_CROSSHAIR_OPTIONS: DeepPartial<CrosshairOptions> = {
  mode: CrosshairMode.Normal,
};
```

The const is intentionally minimal — only `mode` is set. Any future crosshair tuning (e.g., color, label colors) can be added here without touching `ChartStage.tsx` again.

- [ ] **Step 3 complete:** export added, file saves with no IDE errors.

### Step 4: Type-check

From the `frontend/` directory:

```bash
npx tsc -b
```

Expected: exits 0 with no output. If you see `TS2305: Module ... has no exported member 'CrosshairMode'` or similar, double-check that `lightweight-charts` is the v5.2.0 the project pinned (`grep '"lightweight-charts"' frontend/package.json`).

- [ ] **Step 4 complete:** `tsc -b` clean.

---

## Task 2: Wire the options into `ChartStage.tsx`

**Files:**
- Modify: `frontend/src/chart/ChartStage.tsx`

### Step 1: Locate the imports and the `createChart` call

Open `frontend/src/chart/ChartStage.tsx`. The relevant import line (around line 6) currently reads:

```ts
import { CHART_LAYOUT_OPTIONS, CHART_TIMESCALE_OPTIONS } from '../util/chartScale';
```

The `createChart(...)` call lives in the once-mounted `useEffect` near the top of the component body and currently has option keys `layout`, `grid`, `timeScale`, `rightPriceScale`, `autoSize`. There is NO `crosshair` key today.

- [ ] **Step 1 complete:** import line + `createChart` location identified.

### Step 2: Extend the import

Change the import to:

```ts
import {
  CHART_CROSSHAIR_OPTIONS,
  CHART_LAYOUT_OPTIONS,
  CHART_TIMESCALE_OPTIONS,
} from '../util/chartScale';
```

(Alphabetical ordering matches the project's existing import style — verify by glancing at e.g. `CandlePane.tsx`.)

- [ ] **Step 2 complete:** import expanded.

### Step 3: Add the `crosshair` option

Inside `createChart(containerRef.current, { ... })`, add `crosshair: CHART_CROSSHAIR_OPTIONS` as a sibling to the existing top-level options. Best placement is right after `grid:` (so the option order mirrors the visual stacking: background → grid → crosshair → axes). The new options object should look like:

```ts
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
  crosshair: CHART_CROSSHAIR_OPTIONS,
  timeScale: {
    /* ...existing... */
  },
  rightPriceScale: { borderColor: tokens.border },
  autoSize: true,
});
```

Do NOT alter the `timeScale` block contents or any other option — only insert the `crosshair:` line.

- [ ] **Step 3 complete:** `crosshair: CHART_CROSSHAIR_OPTIONS` slotted between `grid:` and `timeScale:`.

### Step 4: Type-check + run the chart test suite

From the `frontend/` directory:

```bash
npx tsc -b
npx vitest run src/chart/
```

Expected: `tsc -b` exits 0 with no output. Vitest reports all chart-suite tests passing (the suite includes `CandlePane.test.tsx`, `ChartErrorBoundary.test.tsx`, etc.). None of those tests assert on `crosshair.mode`, so they should be untouched.

- [ ] **Step 4 complete:** types green, chart tests green.

---

## Task 3: Visual verification via `browse`

**Files:** none modified — observational.

The change is a config flip with no testable side effects at the unit level; visual verification is the authoritative check.

### Step 1: Confirm the dev server is up

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/replay
```

Expected: `200`. Start the dev server with `(cd frontend && npm run dev &)` if needed.

- [ ] **Step 1 complete:** dev server responds 200.

### Step 2: Load a populated chart

```bash
B="$HOME/.claude/skills/gstack/browse/dist/browse"
$B goto "http://localhost:5173/replay?tabs=003490:20260519:20260520:1m&active=0"
sleep 3
```

`003490` (대한항공) is the test stock with multi-day data — the same URL used by the prior plans for visual verification.

- [ ] **Step 2 complete:** page loaded.

### Step 3: Confirm `crosshair.mode = 0` by reading the chart options

`lightweight-charts` doesn't expose the live options on a public DOM attribute, but we can read the value back via the IChartApi if it's reachable. A more pragmatic test: simulate a mouse move to a position clearly OFF a candle's close, then read the rendered crosshair line's Y position from the DOM.

```bash
B="$HOME/.claude/skills/gstack/browse/dist/browse"
# The chart container is the first <div> with the lightweight-charts canvas stack.
# Hover near the middle of the candle pane.
$B js "(() => {
  const canvas = document.querySelectorAll('canvas')[0];
  const r = canvas.getBoundingClientRect();
  return JSON.stringify({x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height});
})()"
```

Note the returned `(x, y)`. Then move the cursor there:

```bash
$B hover @e1   # @e1 from a fresh `$B snapshot` may not be the chart; use absolute coordinates instead via the `js` route below if needed.
```

The lightweight-charts crosshair only paints on real pointer movement. The simplest, most reliable check is the next step's screenshot diff.

- [ ] **Step 3 complete:** cursor positioned over the candle pane.

### Step 4: Screenshot at two distinct cursor Y positions and visually compare

```bash
B="$HOME/.claude/skills/gstack/browse/dist/browse"

# Position cursor near the TOP of the candle pane (well above any candle close).
$B js "(() => {
  const canvas = document.querySelectorAll('canvas')[0];
  const r = canvas.getBoundingClientRect();
  // Dispatch a synthetic pointermove well above the candle close band.
  const e = new PointerEvent('pointermove', {
    clientX: r.left + r.width * 0.6,
    clientY: r.top + r.height * 0.15,
    bubbles: true,
  });
  canvas.dispatchEvent(e);
  return 'sent-top';
})()"
sleep 0.2
$B screenshot /tmp/crosshair-top.png

# Position cursor near the BOTTOM of the candle pane.
$B js "(() => {
  const canvas = document.querySelectorAll('canvas')[0];
  const r = canvas.getBoundingClientRect();
  const e = new PointerEvent('pointermove', {
    clientX: r.left + r.width * 0.6,
    clientY: r.top + r.height * 0.85,
    bubbles: true,
  });
  canvas.dispatchEvent(e);
  return 'sent-bottom';
})()"
sleep 0.2
$B screenshot /tmp/crosshair-bottom.png
```

Read both screenshots with the `Read` tool. The pass criterion:

- In `crosshair-top.png` the horizontal crosshair line sits NEAR THE TOP of the candle pane (close to the cursor Y at 15% of pane height).
- In `crosshair-bottom.png` the horizontal crosshair line sits NEAR THE BOTTOM of the candle pane (close to the cursor Y at 85%).
- The right price-axis crosshair label (e.g., a teal-bordered chip) shows TWO DIFFERENT prices in the two screenshots.

If the horizontal line is in the same place in both screenshots, the change DID NOT take effect — re-check the `crosshair: CHART_CROSSHAIR_OPTIONS` line was actually added, and reload the browser.

Synthetic `PointerEvent` may or may not trigger lightweight-charts' crosshair (the library subscribes to native pointer events on its own canvas elements). If the synthetic-event path doesn't paint a crosshair, fall back to recording a screenshot after a real user moves the mouse — but for the autonomous run, the synthetic events typically work because lightweight-charts uses standard `pointermove` listeners.

- [ ] **Step 4 complete:** two screenshots show the crosshair at DIFFERENT Y positions tracking the cursor.

---

## Task 4: Commit

**Files:** `frontend/src/util/chartScale.ts`, `frontend/src/chart/ChartStage.tsx`.

### Step 1: Inspect the staged diff

```bash
git status -s
git add frontend/src/util/chartScale.ts frontend/src/chart/ChartStage.tsx
git diff --cached --stat
git diff --cached -- frontend/src/util/chartScale.ts frontend/src/chart/ChartStage.tsx
```

Expected diff content:
- `chartScale.ts`: two import additions (`CrosshairMode` value import, `CrosshairOptions` type), one new `CHART_CROSSHAIR_OPTIONS` export with its docstring.
- `ChartStage.tsx`: one import expanded, one `crosshair: CHART_CROSSHAIR_OPTIONS` line added inside the `createChart(...)` options object.

If any OTHER file appears in the staged diff (e.g., unrelated edits in the working tree), unstage it with `git restore --staged <path>` before committing.

- [ ] **Step 1 complete:** staged diff matches the spec exactly.

### Step 2: Commit

```bash
git -c commit.gpgsign=false commit -m "$(cat <<'EOF'
feat(chart): crosshair free mode — disable close-price snap

lightweight-charts v5.2 defaults crosshair.mode to Magnet (1), which
snaps the horizontal line to the candle close under the cursor. Reading
off-candle price levels (e.g. against grid lines or the volume profile)
felt wrong because the price-axis label showed the snapped close, not
the mouse-pointed price. Set CrosshairMode.Normal so both lines track
the actual cursor exactly.

Configuration lives in chartScale.ts alongside the existing
CHART_CROSSHAIR_LINE_WIDTH; ChartStage imports and applies via the
createChart options object — no state, no effect, no props changed.

See docs/superpowers/specs/2026-05-23-crosshair-free-mode-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 2 complete:** commit lands cleanly.

### Step 3: Verify

```bash
git show --stat HEAD
```

Expected: exactly two files changed (`frontend/src/util/chartScale.ts`, `frontend/src/chart/ChartStage.tsx`). If more, see Task 4 Step 1 — `git reset --soft HEAD~1`, unstage unrelated files, recommit.

- [ ] **Step 3 complete:** commit contains only the intended two files.

---

## Out of Scope (do NOT extend this plan)

- A user-facing toggle for Magnet ↔ Normal.
- Color or dash styling of the crosshair lines.
- `MagnetOHLC` mode.
- Custom crosshair label background or font.

If the user requests any of the above during execution, STOP and brainstorm a new spec.
