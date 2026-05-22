# Day Boundary — Dotted Style + Token-Driven Color Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the Day Boundary overlay from a barely-visible hardcoded solid line to a token-driven dotted line, so multi-day chart users can perceive segment boundaries at a glance.

**Architecture:** Single-file CSS-only change in `frontend/src/chart/DayBoundaryOverlay.tsx`. Reuse the existing `resolveTokens` helper that other panes use to read `--border-strong` (DESIGN.md sanctioned). Replace the `background: rgba(255,255,255,0.18)` line with a `repeating-linear-gradient` for cross-browser-consistent dot rendering. No new files, no new props, no new tests — verification is visual via the `browse` skill against `/replay` with a multi-day range.

**Tech Stack:** React (functional component, existing), TypeScript, Tailwind CSS for layout (existing `absolute inset-0 pointer-events-none`/`absolute top-0 bottom-0 w-px`), `frontend/src/util/tokens.ts::resolveTokens` for token reads, `lightweight-charts` `timeToCoordinate` (existing).

**Spec:** `docs/superpowers/specs/2026-05-23-day-boundary-dotted-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `frontend/src/chart/DayBoundaryOverlay.tsx` | Modify | Switch hardcoded `background` rgba to `backgroundImage` repeating-linear-gradient driven by `--border-strong` token. |

No new files. No companion test changes — the existing test (if any) asserts boundary count, not visual style.

---

## Task 1: Token wiring + dotted gradient on DayBoundaryOverlay

**Files:**
- Modify: `frontend/src/chart/DayBoundaryOverlay.tsx` (whole file rewrite — fewer than 80 lines, touching imports, top-of-file const, and the single inline `style` object)

### Step 1: Read the current file

Before editing, confirm the current shape of the file. Open `frontend/src/chart/DayBoundaryOverlay.tsx` with the `Read` tool. You should see:

- Imports from `react`, `lightweight-charts`, `../util/virtualAxis`.
- A `fmtMD` helper.
- A default export `DayBoundaryOverlay({ chart, axis })` that subscribes to `subscribeVisibleLogicalRangeChange` + `ResizeObserver`, then renders `axis.dayBoundaries.map(...)` as positioned `<div>` elements with `transform: translateX(...)` and `background: 'rgba(255,255,255,0.18)'`.

If the file no longer matches this shape, STOP and re-read this plan against the new structure before editing — the spec and step bodies below assume that shape.

- [ ] **Step 1 complete:** file matches expected shape.

### Step 2: Add `resolveTokens` import and `TOKEN_SPEC`

Add the import line alongside the existing imports:

```tsx
import { resolveTokens } from '../util/tokens';
```

Add a top-of-file constant under the imports (mirrors `CandlePane.tsx`, `VolumePane.tsx`, `FillStrengthPane.tsx`, `RatioPane.tsx` — the same pattern is already in use across the chart panes; do NOT invent a new pattern):

```tsx
const TOKEN_SPEC = { borderStrong: ['--border-strong', '#2A2A38'] } as const;
```

The hex fallback `#2A2A38` mirrors DESIGN.md line 78. It only fires before `tokens.generated.ts` boots — production reads the live CSS variable.

- [ ] **Step 2 complete:** import added, `TOKEN_SPEC` declared.

### Step 3: Resolve the token at render time

The boundary lines are rendered as part of the component's return — `dayBoundaries.map(...)`. Resolve the token OUTSIDE the map so we don't call `resolveTokens` once per boundary:

```tsx
if (axis.segments.length < 2) return null;

const { borderStrong } = resolveTokens(TOKEN_SPEC);

const ts = chart.timeScale();
const boundaries = axis.dayBoundaries.map((b) => {
  const x = ts.timeToCoordinate((b.virtualStart / 1000) as UTCTimestamp);
  return { date: b.date, x };
});
```

The `resolveTokens` call must sit AFTER the early-return-on-empty (no point resolving tokens for an empty axis) and BEFORE the boundaries `.map(...)`. Inline reading is fine — the component re-renders cheaply via the `force` ref pattern already in place.

- [ ] **Step 3 complete:** `borderStrong` resolved once per render, used by all boundaries.

### Step 4: Swap `background` for `backgroundImage` dotted gradient

In the `boundaries.map((b) => ...)` JSX, the boundary `<div>` currently uses:

```tsx
style={{
  transform: `translateX(${b.x as number}px)`,
  background: 'rgba(255,255,255,0.18)',
}}
```

Replace with:

```tsx
style={{
  transform: `translateX(${b.x as number}px)`,
  backgroundImage: `repeating-linear-gradient(to bottom, ${borderStrong} 0 3px, transparent 3px 6px)`,
}}
```

Key choices encoded:
- `to bottom` — the line is 1px wide and `top-0 bottom-0`, so the gradient repeats down the vertical axis.
- `0 3px` (dot) + `3px 6px` (gap) — 3px dot, 3px gap = 6px cycle. ≈50% duty cycle, reads as dotted at every realistic zoom.
- `backgroundImage` (NOT `background`) — leaves any future `background-color` slot free and clearly signals the intent is a generated pattern.
- Token value `${borderStrong}` (NOT a hardcoded hex) — DESIGN.md mandate.

Do NOT add a fallback `background:` shorthand alongside — `backgroundImage` alone is supported by every browser that runs lightweight-charts and avoids "which one wins" ambiguity.

- [ ] **Step 4 complete:** `style` object swapped, file compiles in IDE.

### Step 4b: Lift the overlay above the lightweight-charts canvases

Discovered during execution: `lightweight-charts` paints its pane canvases at `z-index: 2` (verified in DevTools — `<canvas style="z-index:2">` inside the chart container). The `DayBoundaryOverlay` is a SIBLING of the chart container, and the chart container has `z-index: auto`, so the chart's inner canvases leak into the parent stacking context and sit ABOVE the boundary div. The boundary then only peeks through transparent gaps in the canvases, defeating the visibility goal.

Fix: add Tailwind `z-10` to the boundary overlay's outer container (matches the convention used by `Tab.tsx`, `SymbolSearch.tsx`, `DateRangePicker.tsx` for in-chrome overlays). The outer container already has `absolute inset-0 pointer-events-none`; the new className becomes:

```tsx
<div ref={containerRef} className="absolute inset-0 pointer-events-none z-10">
```

- [ ] **Step 4b complete:** `z-10` added; boundary now paints above the chart canvases.

### Step 5: Type-check the project

Run from `frontend/`:

```bash
npx tsc -b
```

Expected: no output (clean pass). If there's a type error, the most likely cause is a missing import or a typo in `TOKEN_SPEC` (it must be `as const` so the tuple narrows to a literal).

- [ ] **Step 5 complete:** `tsc -b` exits 0 with no output.

### Step 6: Run the affected unit tests

Even though we add no new tests, run the existing ones that touch DayBoundaryOverlay or its dependencies to confirm no regression:

```bash
npx vitest run src/chart/ src/util/virtualAxis.test.ts
```

Expected: all tests pass. The chart pane test suite (`CandlePane.test.tsx`, etc.) and `virtualAxis.test.ts` should be green. If `DayBoundaryOverlay` has a `.test.tsx` (check with `ls frontend/src/chart/DayBoundaryOverlay.test.tsx` first), it MUST still pass — that test asserts boundary count, not background CSS.

- [ ] **Step 6 complete:** all related vitest suites green.

---

## Task 2: Visual verification via `browse`

**Files:** none modified — observational only.

The spec mandates visual verification because the change is purely a CSS property. The `browse` skill provides a persistent headless Chromium (`~/.claude/skills/gstack/browse/dist/browse`).

### Step 1: Confirm the dev server is reachable

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/replay
```

Expected: `200`. If `000` or `Connection refused`, start the dev server with `(cd frontend && npm run dev &)` and re-curl. The dev server runs HMR — your edits in Task 1 take effect without a manual restart.

- [ ] **Step 1 complete:** dev server returns 200.

### Step 2: Load a 2-day range and screenshot

```bash
B="$HOME/.claude/skills/gstack/browse/dist/browse"
$B goto "http://localhost:5173/replay?tabs=003490:20260519:20260520:1m&active=0"
sleep 3
$B screenshot /tmp/day-boundary-dotted-2day.png
```

`003490` (대한항공) has 9 captured dates; `20260519:20260520` is the smallest multi-day case (one boundary at 05/20). The `?tabs=...` URL is exactly the format the production load button produces — confirmed in the prior multi-day-fix browse session.

- [ ] **Step 2 complete:** screenshot saved.

### Step 3: Verify the boundary count and DOM presence

```bash
B="$HOME/.claude/skills/gstack/browse/dist/browse"
$B js "Array.from(document.querySelectorAll('[data-day-boundary]')).map(e => e.getAttribute('data-day-boundary'))"
```

Expected output: `["20260520"]` — exactly one boundary for the 2-day range.

```bash
$B js "getComputedStyle(document.querySelector('[data-day-boundary]')).backgroundImage"
```

Expected output contains `repeating-linear-gradient(` and `42, 42, 56` (RGB of `#2A2A38`). If the value is `none` or returns `rgba(255, 255, 255, 0.18)`, Task 1 didn't take effect — re-check the file and rerun.

- [ ] **Step 3 complete:** one boundary present, computed style shows the gradient.

### Step 4: Visually confirm the screenshot

Read the screenshot via the `Read` tool on `/tmp/day-boundary-dotted-2day.png`. Confirm:

1. A faint vertical dotted line is visible somewhere in the chart area — its x-position depends on data density but should be in the right half for a 2-day range.
2. The dots do not visually obstruct any candles, volume bars, or ratio line.
3. The `05/20` MM/DD chip is anchored to the line (top-left of the boundary).

If the line is invisible at default zoom, that's still acceptable per the spec — `--border-strong` is intentionally subtle. The `getComputedStyle` check in Step 3 is the authoritative "is the change live" assertion.

- [ ] **Step 4 complete:** screenshot shows dotted boundary, chip present, candles unobstructed.

### Step 5: Sanity-check a 4-day range

```bash
B="$HOME/.claude/skills/gstack/browse/dist/browse"
$B goto "http://localhost:5173/replay?tabs=003490:20260519:20260522:1m&active=0"
sleep 4
$B js "Array.from(document.querySelectorAll('[data-day-boundary]')).map(e => e.getAttribute('data-day-boundary'))"
$B screenshot /tmp/day-boundary-dotted-4day.png
```

Expected output of the `js` call: `["20260520", "20260521", "20260522"]` — three boundaries. Read the screenshot and confirm three dotted lines + three MM/DD chips, evenly spaced.

- [ ] **Step 5 complete:** 4-day range shows three boundaries, screenshot looks right.

---

## Task 3: Commit

**Files:** the single modified file plus the plan/spec already in HEAD (those are already committed — only the source change goes into this commit).

### Step 1: Stage only the modified component

```bash
git status -s
```

Expected: at least `M frontend/src/chart/DayBoundaryOverlay.tsx`. There may also be unrelated modifications in the working tree from prior work — DO NOT stage them. Use a targeted `git add`:

```bash
git add frontend/src/chart/DayBoundaryOverlay.tsx
```

- [ ] **Step 1 complete:** only `DayBoundaryOverlay.tsx` staged.

### Step 2: Verify the staged diff

```bash
git diff --cached -- frontend/src/chart/DayBoundaryOverlay.tsx
```

Expected: shows the import line addition, the `TOKEN_SPEC` constant, the `resolveTokens` call, and the `background` → `backgroundImage` swap. Nothing else.

- [ ] **Step 2 complete:** diff matches the spec.

### Step 3: Commit

```bash
git -c commit.gpgsign=false commit -m "$(cat <<'EOF'
feat(chart/DayBoundaryOverlay): dotted line driven by --border-strong

Replace the hardcoded rgba(255,255,255,0.18) solid background with a
repeating-linear-gradient using the --border-strong design token, giving
multi-day boundaries a visible-but-subtle dotted style consistent across
browsers (avoids the Chrome-vs-Firefox `border-style: dotted` drift).

See docs/superpowers/specs/2026-05-23-day-boundary-dotted-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Verify the commit landed cleanly:

```bash
git show --stat HEAD
```

Expected: one file changed (`frontend/src/chart/DayBoundaryOverlay.tsx`). If more than one file appears, you accidentally staged something — `git reset --soft HEAD~1`, `git restore --staged <unwanted>`, recommit.

- [ ] **Step 3 complete:** single-file commit landed.

---

## Out of Scope (do NOT add to this plan)

- Adding a `--day-boundary` token to DESIGN.md — the spec explicitly reuses `--border-strong`.
- Animating the boundary on first paint.
- Per-day color (weekend vs holiday).
- A user-facing visibility toggle.

If the user requests any of these during execution, STOP and brainstorm a new spec — do not extend this plan.
