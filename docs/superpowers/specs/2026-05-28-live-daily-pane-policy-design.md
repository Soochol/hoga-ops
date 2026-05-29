# Live `/live` D/W/M Pane Policy & Visible-Range Normalization

Date: 2026-05-28
Scope: frontend (`/live` page only — `/replay` unaffected)
Author: brainstorming session 2026-05-28

## Motivation

User-visible problem: on D/W/M timeframes the `/live` chart shows
`candle + volume + three hoga indicator panes (ratio, quote-totals,
fill-strength)`, but the hoga panes are empty (D/W/M never fetches
`/api/range`). The empty panes take vertical space and the
`fitContent()` policy added in the D/W/M shipping series distributes a
small number of bars (e.g. 14 daily bars) across the full chart width.
Both compound: candles look unnaturally wide and the chart wastes
~30% of its vertical real estate on always-empty panes.

User asked for, verbatim:

> 일봉에서는 호가 보조지표 필요 없어. 일봉에서는 캔들, 거래량만 있으면 돼.
> 그럼 일봉 캔들 간격이 정상화해야 해.

Two coupled decisions follow: (1) drop hoga panes for D/W/M, (2)
swap `fitContent()` for a timeframe-tuned `setVisibleLogicalRange`
so D/W/M bars look like a standard trading chart (recent bars on the
right, room to drag back on the left).

## Decisions

### D1 — Pane set by timeframe

Per-timeframe pane list, applied in `LiveChartRoot`:

| Timeframe | Panes mounted                                                  |
|-----------|----------------------------------------------------------------|
| 1m–30m    | `CANDLE_SPEC, VOLUME_SPEC, RATIO_SPEC, QUOTE_TOTALS_SPEC, FILL_STRENGTH_SPEC` (current `PANE_SPECS`) |
| D, W, M   | `CANDLE_SPEC, VOLUME_SPEC` only                                |

Implementation: a small `paneSpecsForTimeframe(tf: LiveTimeframe): BoundPaneSpec[]`
helper. Lives in `LiveChartRoot.tsx` as a module-level const (or alongside
`PANE_SPECS` in `paneSpecs.ts` if it grows). Returns the existing
`PANE_SPECS` array for minute timeframes and `[CANDLE_SPEC, VOLUME_SPEC]`
for D/W/M.

`LiveChartRoot` then iterates that array instead of `PANE_SPECS`:
```tsx
{paneSpecsForTimeframe(timeframe).map((spec, i) => <RangeSeriesPane ... />)}
```

React keys remain `spec.name` (the stable `PaneId` literal) so timeframe
toggles unmount only the panes that actually leave the set (ratio →
quote-totals → fill-strength) and never churn candle/volume.

### D2 — Visible-range policy by timeframe

Keep the existing two branches but re-tune what each handles:

| Timeframe | Initial visible range                                              |
|-----------|--------------------------------------------------------------------|
| 1m–30m    | `setVisibleLogicalRange({from: max(0, totalBars - 300), to: totalBars + 5})` (current) |
| D, W, M   | `chart.timeScale().fitContent()`                                   |

Rationale: removing the three hoga panes (D1) gives the candle pane
back the vertical space it was losing to empty stripes. Candle bodies
become tall enough that the same ~100px-wide horizontal slot reads as
a normal candle instead of a stretched bar. `fitContent` then does the
right thing for sparse D/W/M bundles on its own — no magic per-tf
target table needed.

The current `totalBars < 50 ? fitContent : setVisibleLogicalRange` split
collapses to a clean `isMinute ? setVisibleLogicalRange : fitContent`
branch, parallel to D1's pane-set branch. One concept ("D/W/M is the
long-horizon view") drives both.

Minute timeframes keep `setVisibleLogicalRange` because their bundles
are large (~5000 1m bars over 20 days); fitContent there would
compress every bar to a pixel.

### D3 — InvariantOutcomesBanner stays auto-hidden

No code change. `useLiveBundle` keeps `enableRange = isMinute`, so
D/W/M never gets `excluded_dates` or `data_warnings` populated, and
the banner already early-returns to a placeholder under those
conditions. This keeps a single rule ("hoga data drives the hoga
banner") and avoids a parallel "if D/W/M, hide banner" branch.

### D4 — Out of scope

- `/replay` page (ChartStage): no timeframe toggle, no change.
- Backend D/W/M endpoints: still not added; ADR-0040 stands — KIS
  past-candles is the single candle source, D/W/M aggregate client-side.
- `useLiveBundle.ts:72` `enableRange = isMinute` stays as-is — D/W/M
  panes are gone so the gate is now consistent with "panes that
  consume range data are only mounted when range data is fetched".

## Implementation outline

1. Add `paneSpecsForTimeframe` (in `LiveChartRoot.tsx`):
   ```ts
   import { CANDLE_SPEC } from '../chart/projectors/candle';
   import { VOLUME_SPEC } from '../chart/projectors/volume';
   import { PANE_SPECS, type BoundPaneSpec } from '../chart/paneSpecs';
   const DAILY_PANE_SPECS: BoundPaneSpec[] = [CANDLE_SPEC, VOLUME_SPEC];
   function paneSpecsForTimeframe(tf: LiveTimeframe): BoundPaneSpec[] {
     return tf === 'D' || tf === 'W' || tf === 'M' ? DAILY_PANE_SPECS : PANE_SPECS;
   }
   ```
2. Swap the `.map` source: `paneSpecsForTimeframe(timeframe).map(...)`.
3. Inside the initial-view effect, swap the `totalBars < 50` size-based
   branch for a timeframe-based branch: `isMinute ? setVisibleLogicalRange : fitContent`.
   Use the same `isMinuteTimeframe` helper that already lives in
   `useLiveBundle.ts` (lift it to a shared module if importing across
   the file boundary feels off; otherwise duplicate the 1-line array
   membership check in `LiveChartRoot`).
4. Tests:
   - Unit test for `paneSpecsForTimeframe`: minute timeframes → all 5 specs,
     D/W/M → exactly `[CANDLE_SPEC, VOLUME_SPEC]`.
   - (Optional) e2e screenshot guard if it doesn't add fixture surface:
     skipped — `live-smoke.spec.ts` doesn't assert pane count and adding
     it would require chart DOM probes that pixel-shift on every layout
     tweak.

## Affected files

- `frontend/src/live/LiveChartRoot.tsx` — both decisions land here.
- A new unit test file (e.g. `frontend/src/live/paneSpecsForTimeframe.test.ts`)
  or extend existing `LiveChartRoot.test.tsx` if one exists.

No changes to:
- `frontend/src/chart/paneSpecs.ts` (the canonical 5-pane registry stays
  the source of truth for `/replay` and for the "all panes" path).
- `frontend/src/chart/RangeSeriesPane.tsx` (the existing cleanup useEffect
  already handles dynamic unmount safely).
- `frontend/src/live/useLiveBundle.ts` (D3 — `enableRange` rule unchanged).
- `frontend/src/replay/*`.

## Verification

- `cd frontend && npx vitest run src/live` passes including new unit
  tests for `paneSpecsForTimeframe` and the `TIMEFRAME_TARGET_BARS`
  table.
- `cd frontend && npm run build` succeeds.
- Manual: load `/live`, toggle 1m → 5m (5 panes), → D (2 panes,
  candles right-aligned with empty room on the right), → W → M,
  back to 1m (5 panes again, no chart re-creation visible).

## Risks & mitigations

- **Pane unmount edge case in lightweight-charts**: `RangeSeriesPane`
  already wraps `chart.removeSeries` in try/catch for the
  `ChartErrorBoundary` race; the same guard covers timeframe-toggle
  unmount. No additional safety net needed.
- **Drawing/MA overlays bound to a removed pane**: D/W/M don't show
  MA or drawings in the current product, but if either appears in
  `/live` later, the persistence-by-PaneId model means drawings on
  `ratio`/`quote-totals`/`fill-strength` simply skip render while
  D/W/M is active and reappear on the next minute-timeframe selection.
  Acceptable.
- **User expectation about candle width**: `fitContent` on D/W/M
  assumes that the recovered vertical space (from hoga-pane removal)
  rebalances the candle's apparent width. If after landing the
  candles still feel too wide, the fallback is to introduce the
  per-timeframe `target` table (D=120 / W=52 / M=24 etc.) — pure
  config, no architectural change beyond D2.

## Open questions

None. Both clarifications (gap interpretation, banner behavior) were
resolved during brainstorming.

## Related decisions

- ADR-0041 — `/live` calendar timeframes mount candle + volume only
  (codifies D1).
- CONTEXT.md — **LiveTimeframe** term, distinguishing the `/live` 9-value
  selector from the wire-bucketed 6-value **Timeframe**.
