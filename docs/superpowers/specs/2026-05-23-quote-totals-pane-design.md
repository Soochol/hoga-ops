# Quote Totals Pane Design

**Date**: 2026-05-23
**Topic**: Replace the IntensityPane heatmap with a two-line pane showing
the 매수 1–10호가 / 매도 1–10호가 quantity totals over time.

## Context

The replay viewer's pane 3 currently hosts `IntensityPane` — a canvas
heatmap of depth_intensity (bid/ask liquidity by price bin × time). After
recent stabilization work, the user has decided the heatmap is harder to
read at a glance than a simple line chart, and wants pane 3 swapped for a
two-line view of the **total bid quantity** (sum of bid 1–10호가) and
**total ask quantity** (sum of ask 1–10호가).

The chart already carries this exact data: `build_quote_ratio_slice` in
`hoga/api/bundle.py` SUMs `bid_q1 + bid_q2 + … + bid_q10` and
`ask_q1 + … + ask_q10` per bucket and exposes them as
`quote_ratio.points[*].bid_total / ask_total`. Today only `RatioPane`
consumes these (to compute the signed imbalance ratio). The new pane
reuses the same payload — no backend additions required.

`IntensityPane` and its backend feeder (`build_depth_intensity_slice`,
`depth_intensity_by_day` field) are removed entirely in the same change,
not kept as dead code.

## Goals

- Replace pane 3 contents with two `LineSeries` (bid totals green, ask
  totals red), sourced from `bundle.quote_ratio.points`.
- Remove `IntensityPane.tsx`, its test, and the unused
  `depth_intensity_by_day` field from both backend (`RangeBundle`,
  `build_depth_intensity_slice`) and frontend (`api/types.ts`).
- Keep payload shape and slot ordering otherwise stable so the rest of
  ChartStage, the virtual-axis stitching, and the day-boundary overlay
  continue to work unchanged.

## Non-goals

- Backend data source changes (no new field, no orderbook re-derivation).
  The 1–10호가 합산은 이미 SQL에서 진행 중.
- Volume-profile, ratio, fill-strength, candle panes — untouched.
- Mobile / responsive layout adjustments — same lightweight-charts
  multi-pane stretch model.
- Animated transitions, theming, or interaction beyond what the existing
  RatioPane offers.

## Architecture

ChartStage mounts five pane components in `paneIndex` order. After the
swap:

```
Pane 0  CandlePane           stretch 1.4   candles + VolumeProfileOverlay
Pane 1  VolumePane           stretch 0.3   volume histogram
Pane 2  RatioPane            stretch 0.4   signed bid/ask imbalance line
Pane 3  QuoteTotalsPane      stretch 0.4   bid_total (green) + ask_total (red) lines   ← NEW
Pane 4  FillStrengthPane     stretch 0.4   buy/sell fill-strength mirror histogram
```

`PANE_STRETCH` becomes `[1.4, 0.3, 0.4, 0.4, 0.4]` (sum 2.9, down from
3.3). CandlePane's proportional share rises from ≈42 % to ≈48 %, which is
a side-effect the user accepted; pane 3 itself shrinks from 24 % to 14 %
because two lines do not need the vertical space a heatmap did.

Render order in `ChartStage.tsx` continues to follow `paneIndex` order
(the constraint fixed in the previous session: lightweight-charts v5 does
not auto-create intermediate panes, so a higher-paneIndex component
mounted earlier can steal the lower slot). `QuoteTotalsPane` (paneIndex
3) must render strictly before `FillStrengthPane` (paneIndex 4).

## Component: `QuoteTotalsPane.tsx`

Mirrors `RatioPane.tsx`'s shape: one `useEffect`, no JSX, no anchor
series. Two `LineSeries` are added on the same `paneIndex`, which makes
them share the right price scale automatically — bid and ask read on the
same Y axis.

```tsx
import { useEffect } from 'react';
import { LineSeries, type IChartApi } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import { type VirtualAxis } from '../util/virtualAxis';
import { resolveTokens } from '../util/tokens';

const TOKEN_SPEC = {
  up: ['--up', '#22C55E'],
  down: ['--down', '#F43F5E'],
} as const;

type Props = {
  chart: IChartApi;
  bundle: RangeBundle;
  axis: VirtualAxis;
  paneIndex?: number;
};

export default function QuoteTotalsPane({
  chart,
  bundle,
  axis,
  paneIndex = 0,
}: Props) {
  useEffect(() => {
    const { up, down } = resolveTokens(TOKEN_SPEC);
    const priceFormat = {
      type: 'custom' as const,
      formatter: (v: number) => Math.round(v).toLocaleString('ko-KR'),
      minMove: 1,
    };

    const bidSeries = chart.addSeries(
      LineSeries,
      { color: up, lineWidth: 1, priceFormat } as any,
      paneIndex,
    );
    const askSeries = chart.addSeries(
      LineSeries,
      { color: down, lineWidth: 1, priceFormat } as any,
      paneIndex,
    );

    // Reuse the imbalance feed's raw totals — see hoga/api/bundle.py
    // build_quote_ratio_slice for the 1–10호가 SUM. Drop pre-open auction
    // points using axis.contains, matching RatioPane / FillStrengthPane.
    const inSession = bundle.quote_ratio.points.filter((p) =>
      axis.contains(p.t),
    );
    bidSeries.setData(
      inSession.map((p) => ({
        time: (axis.toVirtual(p.t) / 1000) as any,
        value: p.bid_total,
      })),
    );
    askSeries.setData(
      inSession.map((p) => ({
        time: (axis.toVirtual(p.t) / 1000) as any,
        value: p.ask_total,
      })),
    );

    return () => {
      try {
        chart.removeSeries(bidSeries);
      } catch {
        /* chart torn down */
      }
      try {
        chart.removeSeries(askSeries);
      } catch {
        /* chart torn down */
      }
    };
  }, [chart, bundle, axis, paneIndex]);

  return null;
}
```

Notes:

- **Y-axis**: auto (lightweight-charts default). No 0 baseline because the
  totals are always positive and rarely approach zero; auto-fit
  emphasizes the variation, which is the signal users care about.
- **Tooltip / crosshair**: lightweight-charts shows each series'
  last/cursor value in the right-price-scale label. Both labels appear
  side by side in the same pane — exactly the "두 잔량 비교" UX goal.
- **No mixBlendMode, no canvas, no portal.** Pure lightweight-charts
  series. The portal-z-index class of bugs that hit IntensityPane does
  not apply here.

## Data flow

```
build_quote_ratio_slice (SQL, hoga/api/bundle.py)
    SUMs bid_q1..bid_q10  →  bid_total
    SUMs ask_q1..ask_q10  →  ask_total
        │
        ▼
QuoteRatioPoint { t, bid_total, ask_total }
        │
        ▼
RangeBundle.quote_ratio.points : QuoteRatioPoint[]
        │
        ├──→ RatioPane         (existing) computes signed imbalance line
        └──→ QuoteTotalsPane   (new)      plots bid_total + ask_total as two lines
```

Same source, two derived views. No new fetch path, no new SSE channel,
no schema bump beyond the depth_intensity removal.

## Removals

Cleanup is part of the same change to avoid leaving dead code or unused
payload.

| File | Action |
|---|---|
| `frontend/src/chart/IntensityPane.tsx` | Delete file |
| `frontend/src/chart/IntensityPane.test.tsx` | Delete file |
| `frontend/src/chart/ChartStage.tsx` | Drop `IntensityPane` import; replace pane-3 `<div data-pane="intensity">` block with `<div data-pane="quote-totals">` mounting `QuoteTotalsPane paneIndex={3}`; update `PANE_STRETCH` and the jsdoc block listing pane contents |
| `frontend/src/api/types.ts` | Remove `DepthIntensity` type and `RangeBundle.depth_intensity_by_day` field |
| `hoga/api/models.py` | Remove `class DepthIntensity` and the `depth_intensity_by_day` field on `RangeBundle` |
| `hoga/api/bundle.py` | Remove `build_depth_intensity_slice` function; drop its call inside `build_range_bundle`'s per-day loop and the assembly key in the final `RangeBundle(...)` literal |
| Any tests referencing `depth_intensity_by_day` (backend or fixture) | Update or delete in tandem |

A repo-wide grep before commit confirms no other consumer remains; today
the field is read only by `IntensityPane.tsx`.

## Testing

- **`QuoteTotalsPane.test.tsx`** mirrors `RatioPane.test.tsx` (if
  present) or follows the existing pane-test pattern: mock `chart.addSeries`
  to return spy series objects, pass a small fixture `bundle` with two or
  three `quote_ratio.points`, assert each series received `setData` with
  the expected `(time, value)` array and that `removeSeries` is called
  for both on unmount.
- **Existing backend tests** for `build_quote_ratio_slice` are
  load-bearing — they're now the only checked path for the new pane's
  data source. Run the existing test suite unchanged.
- **Depth-intensity tests**: any unit/integration tests covering
  `build_depth_intensity_slice` or asserting `depth_intensity_by_day`
  shape are deleted alongside the function.
- **Manual dogfood**: load `003490` over 2026-05-19 → 2026-05-20 at 1 m;
  verify all five panes render, bid (green) and ask (red) lines flow
  per-minute, day boundary dotted line still crosses pane 3, crosshair
  reads both values simultaneously, and no console errors.

## Risks and mitigations

- **Naming dissonance.** The `quote_ratio` field carries raw totals as
  well as the ratio that's derived from them. Calling the new pane
  `QuoteTotalsPane` and keeping the `data-pane="quote-totals"` selector
  makes the *intent* explicit; an inline comment at the data-read site
  ("Reuse the imbalance feed's raw totals") tells future readers why a
  totals chart pulls from a field named "ratio".
- **Breaking payload shape.** Removing `depth_intensity_by_day` is a
  consumer-visible schema change. Grep confirms only `IntensityPane.tsx`
  reads it inside this repo; if any out-of-tree consumer (a script, an
  external analysis notebook, or a stale captured payload) relies on the
  field, that consumer breaks. The user explicitly chose the full-delete
  option with this trade-off in view.
- **Pane stretch shift.** Total stretch drops 3.3 → 2.9; CandlePane's
  share rises from ≈42 % to ≈48 %. This is a deliberate side effect —
  the heatmap's 0.8 budget is no longer needed.

## Verification checklist

After implementation, before declaring done:

1. `pnpm exec tsc -b` exits 0 (frontend type-check).
2. Backend tests pass (the same command the project uses today).
3. `/replay` for `003490` between 2026-05-19 and 2026-05-20 at 1 m
   renders five panes, with QuoteTotalsPane in slot 3 showing two clean
   lines and no console errors.
4. `git grep -n "depth_intensity\|IntensityPane\|DepthIntensity"` returns
   zero hits in `frontend/` and `hoga/`.
5. Crosshair hover shows both bid and ask totals in the right-price-scale
   labels for pane 3, both formatted with thousands separators.
