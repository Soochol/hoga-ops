# 0041 — `/live` calendar timeframes mount candle + volume only

Date: 2026-05-28
Status: Accepted

## Context

The `/live` page's **LiveTimeframe** selector exposes a superset of
the wire-bucketed **Timeframe**: 1m / 3m / 5m / 10m / 15m / 30m plus
D / W / M. The minute subset round-trips to `/api/range` and gets
the full five-pane chart (candle + volume + **호가비** + **Quote Totals**
+ **FillStrength**). The calendar subset (D/W/M) is frontend-only —
`/api/live/past-candles` returns 1-minute bars and the page
client-aggregates them via `aggregateCalendar`; no `/api/range` call
is made, so the three hoga-derived series have no data.

Before this decision, all five pane specs were mounted regardless of
timeframe. On D/W/M that left ratio / quote-totals / fill-strength
visible as empty stripes — visual noise that also squeezed the candle
pane vertically, which (combined with `fitContent`) made each daily
bar look unnaturally wide. Users surfaced the issue as "캔들 간격이
벌어져 있다."

## Decision

On `/live`, when the active LiveTimeframe is D, W, or M, mount only
`CANDLE_SPEC` and `VOLUME_SPEC`. The three hoga panes (`RATIO_SPEC`,
`QUOTE_TOTALS_SPEC`, `FILL_STRENGTH_SPEC`) are conditionally absent
from the rendered list.

Implementation: `LiveChartRoot` picks its pane list via a small
`paneSpecsForTimeframe(tf)` helper that returns the full `PANE_SPECS`
for minute timeframes and `[CANDLE_SPEC, VOLUME_SPEC]` for D/W/M.
React keys remain `spec.name` so timeframe toggles unmount only the
panes that actually leave the set.

`/replay` is unaffected — it has no LiveTimeframe and always mounts
the full five panes.

## Alternatives considered

- **Show empty hoga panes anyway**: keeps the layout stable across
  timeframe toggles, but the empty stripes carry no information and
  compressed the candle pane enough that users misread candle width.
  Rejected — visual noise dominates the layout-stability win.

- **Add backend D/W/M hoga aggregation**: would let the same five
  panes hold across all timeframes. Rejected for now because hoga
  semantics at calendar resolutions (e.g. "weekly average bid_total")
  are not a clear analyst question — there's no reader who would
  consume a D-aggregated 호가비. If a use case emerges later, this
  ADR can be revisited.

- **Disable the hoga pane toggles in chart prefs for D/W/M**: addresses
  the visibility question without changing mount behavior. Rejected
  because the panes themselves carry no series — disabling toggles
  on empty panes is a confusing UX layer over an underlying "no data"
  state.

## Consequences

- The pane *list* on `/live` is timeframe-dependent. Drawings bound
  to `ratio` / `quote-totals` / `fill-strength` panes (per ADR-0028's
  PaneId persistence) silently skip render on D/W/M and reappear on
  the next minute-timeframe selection. Acceptable — drawings on
  hoga panes are minute-timeframe artifacts by nature.
- `InvariantOutcomesBanner` continues to render only when
  `excluded_dates` or `data_warnings` are non-empty, which on D/W/M
  is never (no `/api/range` call). No banner-specific gate needed.
- The `useLiveBundle.ts` `enableRange = isMinute` gate becomes
  internally consistent with this decision: "hoga panes are mounted
  iff hoga data is fetched."

## References

- Spec: `docs/superpowers/specs/2026-05-28-live-daily-pane-policy-design.md`
- CONTEXT.md: **LiveTimeframe**
- ADR-0040: Live Candle Backfill (separate cache from promoted Parquet)
- ADR-0028: Drawing-pane binding by stable PaneId
