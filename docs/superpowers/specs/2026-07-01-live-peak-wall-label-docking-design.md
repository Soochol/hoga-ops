# Live Peak Wall Label Docking — Design

**Date**: 2026-07-01
**Status**: Draft (design approved; pending written-spec review)
**Scope**: `frontend/src/chart/AskPeakSegmentsPrimitive.ts`, `frontend/src/live/LiveAskPeakSegments.tsx`, `frontend/src/live/LiveBidPeakSegments.tsx`, `frontend/src/live/LiveChartRoot.tsx`

## Problem

The intraday "당일 매도 최대벽" labels are drawn at the right edge of the live segment, which is also the latest candle area during the session. When multiple ask-wall labels, moving averages, current price, and candles sit near the same price band, the labels cover the candles and become unreadable. The same issue applies to "당일 매수 최대벽" when it is enabled.

The user approved a visual companion direction: keep historical chart behavior unchanged, but dock **today's live ask and bid peak-wall labels** into a right-side label lane next to the price axis. This lane is not the actual y-axis price scale; it is a chart-pane label lane whose vertical position still follows each wall's price coordinate.

## Invariants

- **Per-day wall geometry**: Each peak wall remains a horizontal segment for its trading day only, from session open to session close for historical days and to the live candle edge for today. 근거: [LiveAskPeakSegments.tsx](../../../frontend/src/live/LiveAskPeakSegments.tsx), [LiveBidPeakSegments.tsx](../../../frontend/src/live/LiveBidPeakSegments.tsx).
- **Peak-dot timing**: The dot continues to mark the snapped candle bucket of the peak timestamp, with interpolation fallback when the timestamp is outside loaded candle coordinates. 근거: [AskPeakSegmentsPrimitive.ts](../../../frontend/src/chart/AskPeakSegmentsPrimitive.ts).
- **Historical inline labels**: Non-live peak-wall labels keep the current inline placement at the segment right edge. 근거: user decision in this brainstorming session.
- **Label payload**: A visible peak-wall label continues to show rounded price plus compact quantity, e.g. `23,500, 17.2k`. 근거: `formatAskPeakLabel` / `formatBidPeakLabel`.
- **Price-axis ownership**: The lightweight-charts price scale, tick labels, crosshair price label, and current-price line label are not modified by this feature. The docked labels are drawn in the pane, not registered as y-axis labels.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| Per-day wall geometry | preserves | Only label placement changes; segment x/y geometry remains unchanged. |
| Peak-dot timing | preserves | Live labels move, but dots remain on the peak timestamp coordinate. |
| Historical inline labels | preserves | Only `segment.live === true` labels are docked; historical labels stay inline. |
| Label payload | preserves | Same price/qty formatting, only different x placement for live labels. |
| Price-axis ownership | preserves | Docked labels render in a right-side pane lane, not in the chart price axis. |

## Goals

- Dock both **today's live ask peak-wall labels** and **today's live bid peak-wall labels** to a shared right-side label lane.
- Leave historical ask/bid peak-wall labels visually unchanged.
- Keep peak-wall lines and dots at their current price/time coordinates.
- Avoid ask/bid live-label overlap by laying them out together, not in two independent primitives.
- Preserve the existing ask-wall visible-max styling and rank-limit behavior.

## Non-Goals

- No change to backend peak-wall data or ratchet logic.
- No grouping/hover-detail mode for nearby labels in this iteration.
- No migration of labels into the actual lightweight-charts price axis.
- No change to moving average labels, current price line labels, or trade-volume POC labels.
- No broad chart padding or time-scale behavior change unless existing right padding proves insufficient during implementation QA.

## Design

### Rendering split

Keep the existing ask and bid segment renderers responsible for lines, dots, and historical inline labels. Add a small live-label docking path that is shared across ask and bid:

1. `LiveAskPeakSegments` and `LiveBidPeakSegments` continue to build and render their segments.
2. For live segments only, those components suppress the inline `label` so the label does not also appear over the latest candles.
3. A new shared live-label overlay, mounted once from `LiveChartRoot`, receives the same ask and bid segment data and extracts labels where `segment.live === true`.
4. The shared overlay sends all live ask/bid labels into one layout pass, so close price bands stack cleanly.

This avoids a larger rewrite of the line/dot rendering while solving the cross-side label collision that two independent primitives cannot see.

### Right-side label lane

The docked labels render inside the candle pane near the right edge of the pane, just left of the price scale area. Their y coordinate comes from `series.priceToCoordinate(segment.price)`, so they remain vertically tied to the wall price. Their x coordinate is fixed to the right-side label lane rather than `timeScale.timeToCoordinate(segment.time1)`.

The lane is deliberately not the real price axis. It should not affect price ticks, current price labels, crosshair labels, or chart autoscale.

### Label collision handling

Live ask and bid labels share one candidate list:

- Candidate y: `series.priceToCoordinate(segment.price) - LABEL_GAP_PX`.
- Candidate x-right: pane width minus a small edge padding.
- Candidate width: measured text width.
- Layout: reuse the existing `layoutAskPeakLabels` stacking behavior so nearby labels move vertically enough to remain readable.

Historical inline labels continue through the existing candidate and layout path in `AskPeakSegmentsPrimitive`.

### Data shape

The existing `AskPeakSegment` type is already generic enough for both ask and bid peak walls. Add the minimum needed metadata only if implementation needs it:

- `labelPlacement?: 'inline' | 'rightDock'` if the primitive owns both inline and docked drawing.
- Or no type change if a new docked-label primitive receives a smaller derived `{ price, label, color }` shape.

Prefer the smaller derived shape unless the implementation becomes simpler by keeping one primitive.

### Failure and edge cases

- If `priceToCoordinate` returns `null`, skip that docked label, matching current primitive behavior.
- If labels cannot all fit vertically, clamp the stacked group inside the pane as the current inline layout already does.
- If the chart has almost no right padding, the labels may still sit close to candles. Treat that as a QA finding; do not change chart padding unless the docked lane cannot meet the visibility goal without it.
- If only ask or only bid peak walls are enabled, the same shared overlay still works with a single side.

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| Live labels are separated from inline labels | Mixed historical and `live: true` segments | Historical labels remain inline candidates; live labels are routed to the docked-label path. |
| Ask and bid live labels share layout | Two live labels from different sides with close y coordinates | Baselines are separated by at least the configured row height. |
| Historical behavior is preserved | Non-live segment list matching current tests | Existing inline label layout output is unchanged. |
| Docked labels clamp to pane | Several live labels near pane bottom | Labels remain inside min/max baseline bounds. |

**Invariant 회귀 테스트**:

- Per-day wall geometry: existing segment builder tests should continue to assert `time0`, `time1`, `peakTime`, and `price` are unchanged by label docking.
- Historical inline labels: add or extend a primitive layout test that non-live candidates still use their segment `xRight`.
- Price-axis ownership: component-level behavior can be covered by asserting no `createPriceLine` or price-scale option changes are introduced for docked labels.

### Manual verification

- `/live` minute chart, ask peak enabled during the current trading day: today's ask labels appear in the right-side lane, not over the latest candles.
- `/live` minute chart, bid peak enabled during the current trading day: today's bid labels also appear in the same right-side lane.
- Ask and bid peak walls enabled together: close-price labels stack rather than overlapping.
- Multi-day range with past days visible: historical day labels stay at their existing inline segment endpoints.
- Toggle `미체결 포함 최대벽`, rank limits, and visible-max styling: line colors and label colors remain consistent with current settings.

## Risks / Open questions

- The available right-side lane depends on existing chart right padding. If the pane has too little padding in some viewport/timeframe combinations, implementation may need a small targeted padding adjustment.
- Keeping line/dot rendering separate from docked-label rendering duplicates segment construction unless the implementation introduces a shared builder hook. That duplication should be kept local and tested.

## Out of Scope (Backlog)

- A grouped "representative label + hover details" mode for dense price bands.
- User preference for label placement mode.
- Docked labels for historical segments.
- Generalized label-lane infrastructure for all chart overlays.
