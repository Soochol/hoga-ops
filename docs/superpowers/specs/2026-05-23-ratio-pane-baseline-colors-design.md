# Ratio Pane Baseline Colors + Hide Last-Value Lines

**Date**: 2026-05-23
**Status**: Approved
**Scope**: `frontend/src/chart/RatioPane.tsx`, `frontend/src/chart/VolumePane.tsx`, `frontend/src/styles/tokens.css`, `DESIGN.md`

## Problem

Three related polish items on the Replay Viewer's secondary panes:

1. **Ratio pane (호가비 / bid-ask imbalance) shows no direction at a glance.** The current LineSeries paints in a single accent (teal) color regardless of whether the imbalance is ask-heavy (positive, sell pressure) or bid-heavy (negative, buy pressure). The viewer has to read the right-axis chip ("2.0× S" / "1.5× B") to know which side dominates. A glanceable color split at the 0 baseline would carry the same information visually.
2. **Both Ratio and Volume panes draw a redundant horizontal line at the last data point's value.** This is `lightweight-charts`' default `priceLineVisible: true` behavior on the series. The right-axis last-value chip already carries the latest number; the additional horizontal line is visual noise that competes with the 0-baseline reference line (Ratio) and the histogram bars (Volume).
3. **A blue token does not exist in the project palette.** DESIGN.md defines `--up` (green) and `--down` (red) as US-convention price-direction colors. The ratio pane wants a KRX-convention sell-pressure blue, which is semantically distinct from "price down" and deserves its own token.

## Goals

- Ratio pane area renders **blue above the 0 line** (ask-heavy, sell pressure) and **red below the 0 line** (bid-heavy, buy pressure), with a soft fill gradient that mirrors `lightweight-charts`' standard `BaselineSeries` aesthetic.
- The Ratio pane's 0-baseline reference line stays visible, so flat data still shows a horizontal at y=0.
- The last-value horizontal line on the Ratio and Volume panes is suppressed; the right-axis chip remains the source of truth for the latest value.
- One new design token, `--ratio-ask` (#3B82F6), enters the palette. Below-0 reuses `--down` (#F43F5E) — same hex, semantically distinct, documented with an inline comment.

## Non-Goals

- No change to Candle / FillStrength / Intensity panes.
- No change to the bid/ask imbalance computation in `frontend/src/util/imbalance.ts`.
- No change to the right-axis price-format chip ("2.0× S" / "1.5× B").
- No animation, no hover behavior, no theme switching beyond the static token addition.
- No new `--ratio-bid` token — `--down` reuse is sufficient for the single below-0 case.

## Design

### Series replacement: `LineSeries` → `BaselineSeries`

`lightweight-charts` v5.2's `BaselineSeries` natively supports split top/bottom colors around a baseline. Configure with:

```ts
chart.addSeries(BaselineSeries, {
  baseValue: { type: 'price', price: 0 },
  topLineColor:    ratioAsk,                 // solid line above 0
  topFillColor1:   rgba(ratioAsk, 0.28),     // upper fill (saturated near top)
  topFillColor2:   rgba(ratioAsk, 0.05),     // upper fill (faint near baseline)
  bottomLineColor: ratioBid,                 // solid line below 0
  bottomFillColor1: rgba(ratioBid, 0.05),    // lower fill (faint near baseline)
  bottomFillColor2: rgba(ratioBid, 0.28),    // lower fill (saturated near bottom)
  lineWidth: 1.4 as any,                     // matches the prior LineSeries width
  priceLineVisible: false,                   // disables the default last-value line
  priceFormat: { /* unchanged */ },
}, paneIndex);
```

Alpha values (0.28 / 0.05) mirror `lightweight-charts`' default `BaselineSeries` saturation pattern and produce a soft gradient that does not compete with the candle pane above.

`relativeGradient` is left at its default `false` — gradient runs from the chart's top edge down to the bottom, not from baseline outward. This keeps the visual weight where data sits.

### Token addition

Add to `frontend/src/styles/tokens.css` inside the `Color · Chart & Heatmap` section:

```css
--ratio-ask: #3B82F6;  /* Bid/ask ratio — ask-heavy (above 0), KRX-style sell blue */
```

Add a matching row to DESIGN.md's color token table, placed alphabetically near `--grid`. Description: `Ratio pane — ask-heavy fill/line (above 0 baseline)`.

`--ratio-bid` is NOT added. The below-0 colors source from `--down` (#F43F5E) via `resolveTokens({ ratioBid: ['--down', '#F43F5E'] })`, with an inline comment on the TOKEN_SPEC declaration explaining that the value is reused for a distinct semantic (bid pressure ≠ down candle).

### Helper: `rgba(hex, a)`

Both fills need rgba-with-alpha forms of the token hex. Add a small inline helper inside `RatioPane.tsx`:

```ts
function rgba(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
```

Pure function, no DOM/CSSOM dependency, returns the alpha-applied rgba string that `BaselineSeries` accepts for its fill fields. Kept local to `RatioPane.tsx` — promoting to `util/` is premature until a second caller appears.

### Retain the explicit 0-baseline `createPriceLine`

`BaselineSeries` switches color at `baseValue` but does not draw a visible line at that height by default. The existing `series.createPriceLine({ price: 0, ... })` stays, drawing a thin solid horizontal at y=0 so the reference is visible even when both top and bottom fills are sparse. Color is updated from `accent` (teal) to `--fg-dimmer` so it reads as a neutral reference, not as data.

### VolumePane: suppress last-value line

Add `priceLineVisible: false` to the `HistogramSeries` options object. No other change to that pane.

## Implementation surface

| File | Change |
|---|---|
| `frontend/src/styles/tokens.css` | Add `--ratio-ask: #3B82F6;` in Chart & Heatmap section. |
| `DESIGN.md` | Add `--ratio-ask` row in the color table. |
| `frontend/src/chart/RatioPane.tsx` | Replace `LineSeries` import + addSeries with `BaselineSeries`. Add `hexToRgba` helper. Update TOKEN_SPEC to `ratioAsk`/`ratioBid`. Set `priceLineVisible: false`. Recolor the 0-baseline `createPriceLine` to `--fg-dimmer`. |
| `frontend/src/chart/VolumePane.tsx` | Add `priceLineVisible: false` to the `HistogramSeries` options. |

No new files. No test files.

## Testing

- **Unit**: none. Both changes flip lightweight-charts option toggles or replace one series type with another. An assertion of the form "the options object contains key X with value Y" is a tautology of the source. The existing `RatioPane.test.tsx` and `VolumePane.test.tsx` (if any — to be verified during implementation) should still pass without modification because they assert on `setData` shape, not on series-type or color options.

- **Visual (`browse` skill)**: load `/replay` for `003490` over a 2+ day range and confirm:
  1. Ratio pane shows blue above the 0 line wherever imbalance is positive (ask-heavy), red below the 0 line wherever negative (bid-heavy). The line color flips precisely at the 0 crossing.
  2. The 0-baseline horizontal line is visible across the pane width.
  3. The right-axis chip still reads "Nx S" / "Nx B" and tracks the latest value.
  4. No horizontal line is drawn at the latest data point's value in either Ratio or Volume panes.
  5. The right-axis chip in the Volume pane is unchanged (still shows the latest total volume).

## Risks

- **`BaselineSeries` defaults for `lineWidth` are `3`; we override to `1.4`.** Confirmed via the typings.d.ts read during design — `lineWidth: LineWidth` is overridable and our prior LineSeries used 1.4 successfully.
- **Token-reuse comment may be skipped on review.** Mitigation: the inline comment on the `ratioBid` line in `TOKEN_SPEC` is the canonical place. Anyone editing the file sees it; it documents the deviation from DESIGN.md's price-direction semantics.
- **`--ratio-ask` value (#3B82F6) may look too vivid against the dark `--bg-card`.** Tailwind blue-500 is a standard choice; if the user dislikes the brightness during visual verification, dial to blue-400 (#60A5FA) or blue-600 (#2563EB) by editing a single hex in `tokens.css`.

## Out of Scope (Backlog)

- A `--ratio-bid` token distinct from `--down`. Adds vocabulary without changing pixels today.
- A user toggle to revert to the single-color line view.
- A KRX-convention global theme override (Red=buy, Blue=sell) for Candle / Volume panes. Not requested; would require user sign-off on DESIGN.md restructure.
- Suppressing `lastValueVisible` (the right-axis chip itself). User asked only about the line.
