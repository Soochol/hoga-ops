# ADR-0025: hline price label rendered on the overlay canvas, not via `createPriceLine`

**Status:** Accepted
**Date:** 2026-05-24
**Spec:** docs/superpowers/specs/2026-05-24-drawing-ux-improvements-design.md

## Context

The Replay Viewer's horizontal-line **Drawing** primitive (`hline`) sits in the
`Drawing[]` store keyed per **Code** and renders on the **Drawing Overlay**
canvas alongside `trendline` and `pencil`. A trader needs to see the *price* a
horizontal line marks at a glance; the line alone forces them to read the
crosshair tooltip every time.

`lightweight-charts` ships `ISeriesApi.createPriceLine(options)` which natively
paints a horizontal line *and* a label inside the price-axis gutter, perfectly
aligned with crosshair tooltips. It is the visually-ideal way to surface a
price level.

We chose not to use it. This ADR records why.

## Decision

Render the price label as part of the existing canvas overlay path: extend
`renderHline` in `frontend/src/chart/drawing/render.ts` to paint a coloured
rounded-rect badge at the right edge of the overlay canvas (inset 8px),
showing `price.toLocaleString('ko-KR')` with white/black text chosen by W3C
relative-luminance contrast against the line colour.

The line itself remains a canvas stroke; `createPriceLine` is not used for any
`Drawing` primitive.

## Consequences

**Single rendering path for all `Drawing` primitives.** `hline`, `trendline`,
and `pencil` continue to share one render pass, one hit-test pixel space, one
selection-halo implementation, one drag-and-translate machinery, and one
DPR-scaled canvas. The deep module in `chart/drawing/` stays the single owner
of drawing behaviour.

**Lifecycle stays trivial.** `Drawing[]` mutation → render-effect dep change →
single rAF redraw. No chart-native object lifecycle to keep in sync with store
mutations (create / update / remove across mount, code switch, persistence
load, undo).

**Label is not in the price-axis gutter.** It sits inside the overlay area,
near the right edge — visually adjacent to the price axis but not part of it.
The crosshair price label still owns the gutter exclusively. Analysts tested
internally find this acceptable.

**Future-extension cost.** Adding axis-gutter labels later would mean either
(a) introducing `createPriceLine` alongside the canvas line and double-rendering
selectively, or (b) migrating `hline` to chart-native and reproducing
hit-test/halo/drag for it. Both are non-trivial. We accept the cost if and
when the visual gap proves to matter.

## Alternatives considered

- **`createPriceLine` as the sole hline renderer.** Rejected for this
  iteration. The lifecycle, hit-test, halo, and drag re-wiring is a deep
  divergence for one of three drawing kinds. The cost/benefit asymmetric
  against three other shipping features in the same spec.

- **`createPriceLine` *in addition to* the canvas line.** Rejected as a
  visual duplication that risks subtle desync (line z-order, anti-aliasing
  differences, two click targets for the same logical drawing).

- **DOM-positioned label.** Rejected: the absolute positioning would need to
  be re-computed on every visible-range / resize event, and React-driven DOM
  positioning at 60Hz competes badly with the canvas redraw it must align to.

## See also

- CONTEXT.md: **Drawing**, **Drawing Overlay**, **Drawing Tool**
- ADR-0024: Drawing persistence uses real Unix-ms (the deeper reason `Drawing`
  is a store-owned, canvas-rendered primitive in the first place)
