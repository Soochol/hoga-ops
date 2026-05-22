# Day Boundary — Dotted Style + Token-Driven Color

**Date**: 2026-05-23
**Status**: Approved
**Scope**: `frontend/src/chart/DayBoundaryOverlay.tsx`

## Problem

The Replay Viewer already paints a vertical line at every **Day Boundary** (CONTEXT.md), but the current style is a **1px solid line** at `rgba(255,255,255,0.18)` — almost invisible against the dark chart background. The user reports they want a date separator and asked for a dotted style. The existing line is also a code-smell on two axes:

1. **Off-token color**: `rgba(255,255,255,0.18)` is hardcoded. DESIGN.md (CLAUDE.md mandate) flags hardcoded colors — the project uses CSS-variable design tokens routed through `resolveTokens()`.
2. **Solid line conflicts with grid**: the chart already has `--grid` (#1A1A26) horizontal/vertical grid lines. A solid 1px Day Boundary risks blending into the grid; a dotted pattern visually distinguishes "session break" from "regular grid tick".

## Goals

- Day Boundary is **clearly perceptible** at default zoom without dominating the candles/volume below.
- Style is **consistent across browsers** — no Chrome-vs-Firefox dotted rendering drift.
- Color comes from a **DESIGN.md design token**, not a hardcoded hex/rgba.
- **Behavior unchanged** — N segments still produce N-1 boundary lines, MM/DD chip stays, positions still come from `axis.dayBoundaries[i].virtualStart` via `timeScale.timeToCoordinate()`.

## Non-Goals

- No new pane, no new prop, no new state.
- No animation, no hover interaction.
- No change to where the boundary lands (still at `virtualStart` of segment `i+1`).
- No change to the MM/DD chip styling.
- No DESIGN.md token addition — reuse `--border-strong`.

## Design

### Visual Spec

| Property | Value | Rationale |
|---|---|---|
| Color | `--border-strong` (#2A2A38) | DESIGN.md (line 78) — "Active borders, vertical dividers". Subtle but distinct from `--grid` (#1A1A26). |
| Pattern | 3px dot, 3px gap | ≈50% duty cycle. Reads as dotted at every realistic zoom level without competing with candles. |
| Width | 1px | DESIGN.md (line 28) — chart chrome stays in px to protect anti-aliasing. |
| Position | Unchanged — `translateX(virtualStart)` | GPU compositor path stays untouched. |
| Chip | Unchanged | MM/DD label retained for date orientation. |

### Implementation Approach: `repeating-linear-gradient`

Three alternatives considered:

1. **CSS `border-left: 1px dotted <color>`** — simple but Chrome renders square dots, Firefox renders round dots. Visual inconsistency.
2. **SVG `<line>` with `stroke-dasharray`** — pixel-perfect but adds a different rendering layer and requires recomputing on resize. Overkill for one-pixel divs.
3. **`repeating-linear-gradient` background on a 1px-wide div** ✓ — pixel-consistent across browsers, no new DOM nodes, no JS recomputation, sits in the existing GPU-composited overlay.

Approach 3 is chosen. The boundary `<div>` keeps its `w-px absolute top-0 bottom-0`; only the `background` property changes:

```tsx
backgroundImage: `repeating-linear-gradient(
  to bottom,
  ${borderStrong} 0 3px,
  transparent 3px 6px
)`,
```

### Token Wiring

Reuse the codebase's `resolveTokens` helper (same call shape as `CandlePane`, `VolumePane`, `RatioPane`, `FillStrengthPane`, `IntensityPane`):

```tsx
const TOKEN_SPEC = { borderStrong: ['--border-strong', '#2A2A38'] } as const;
// ...inside the component, before mapping boundaries:
const { borderStrong } = resolveTokens(TOKEN_SPEC);
```

The fallback hex matches DESIGN.md so the line renders correctly even before `tokens.generated.ts` boot.

### Performance

The boundary count is `N - 1` for N segments. N is bounded by the number of trading days in a **Stock-Date Range** (single-digit to low-tens in practice). The existing `subscribeVisibleLogicalRangeChange` + `requestAnimationFrame` coalescing path (DayBoundaryOverlay.tsx:26-43) is preserved verbatim. `backgroundImage` is paint-only and stays inside the GPU compositor path — no layout thrash, identical perf to the current solid background.

## Testing

- **Unit**: no new tests. The existing render-N-1-boundaries assertions remain valid (no behavioral change). Adding a "background is dotted" test would be a brittle CSS-string assertion offering negative value.
- **Visual (`browse` skill)**: navigate to `/replay`, load a 2+ day range for 003490 (`/replay?tabs=003490:20260519:20260522:1m&active=0`), screenshot. Confirm:
  - Three dotted vertical lines visible at 05/20, 05/21, 05/22 boundaries.
  - Candles and volume bars beneath remain fully readable.
  - MM/DD chips still anchored to each boundary.

## Risks

- **Browsers may anti-alias the 3px dots into a near-solid bar at fractional `translateX` values.** Mitigation: `translateX` already uses `timeToCoordinate` output which can be sub-pixel; if dots smear, add `Math.round(b.x)` at the existing call site. Defer this fix until verified visually — not all sub-pixel positions cause smearing.
- **`--border-strong` value changes in DESIGN.md.** Acceptable — the token system is exactly the indirection that lets that change propagate without code edits.

## Out of Scope (Backlog)

- Animating the boundary (fade in on first paint).
- Per-day color (e.g., red dot for weekend gaps vs blue for holidays). Today's data has none of these distinctions.
- A user-facing toggle for boundary visibility — premature; revisit if a real user request comes in.
