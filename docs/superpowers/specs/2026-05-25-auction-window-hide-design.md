# Auction Window — Hide Indicator Panes (15:20–15:30 KST)

**Date**: 2026-05-25
**Status**: Spec — pending implementation plan
**Scope**: Replay viewer (`/replay`) chart panes

## Problem

During the **Closing Auction Window** (15:20–15:30 KST on full-day sessions; the last 10 minutes on half-day sessions), order book state is dominated by one-sided accumulation. Analysts have asked: for indicator panes derived from the order book — Ratio (호가비), QuoteTotals (호가 총합), and FillStrength (체결강도) — **don't render anything** during this window. The Candle and Volume panes should continue rendering as-is.

The current behaviour partially addresses this: an `auctionWindowMask` toggle (default ON) **masks values to 0** in Ratio and QuoteTotals only. FillStrength is untouched. A "flat 0" line is misleading — it looks like real data hugging the baseline. The request is to replace masking-to-0 with full visual suppression, extended to FillStrength.

## Decision

Replace the meaning of the existing `auctionWindowMask` toggle: **hide data points entirely** in Ratio, QuoteTotals, and FillStrength during the closing auction window. Keep the toggle key for localStorage compatibility; update the user-visible label and description. Candle, Volume, and the Moving Average overlay on the candle pane are not affected.

## Scope

### In scope

- `chart/projectors/ratio.ts` — exclude auction-window points; break line at boundary
- `chart/projectors/quoteTotals.ts` — exclude auction-window points (both bid and ask line series); break lines at boundary
- `chart/projectors/fillStrength.ts`:
  - histograms (buy/sell): exclude auction-window points (no break needed)
  - cumulative line: exclude emission inside auction window but **continue accumulating** `runningSum`; break line at boundary
- `state/chartPrefs.ts` — update `auctionWindowMask` toggle label/description
- New helper `chart/util/auctionMaskGap.ts` — encapsulates the "emit a whitespace at the boundary" state machine shared by the three line series
- Tests updated/added for each touched module

### Out of scope

- Candle, Volume, MovingAverage (per user requirement — candle/volume excluded; MA overlays candle)
- Pre-market auction (장개시 동시호가, 08:30–09:00) — request was specifically about 15:20
- Backend changes (`build_quote_ratio_slice`, FillStrength bucketing) — visual suppression only
- AuctionWindowOverlay band — kept unchanged; now reads as "this is the hidden zone" rather than "this is the masked-to-0 zone"
- `auctionWindowMask` localStorage migration — key unchanged, no migration needed

## Design

### Toggle (chartPrefs.ts)

Update the first entry of `CHART_TOGGLES`:

```ts
{
  key: 'auctionWindowMask',           // unchanged — preserves persisted user prefs
  label: '동시호가 구간 지표 숨김',
  description: '15:20–15:30 KST 동시호가 구간에서 호가비·호가총합·체결강도를 표시하지 않습니다. (캔들/거래량 제외)',
  default: true,
}
```

### Per-pane behaviour

| Pane | Series | Behaviour during 15:20–15:30 |
|---|---|---|
| Candle (paneIndex 0) | Candle + MA overlay | unchanged |
| Volume (paneIndex 1) | Histogram | unchanged |
| Ratio (paneIndex 2) | BaselineSeries | points filtered out + WhitespaceData inserted at auction start to break the baseline |
| QuoteTotals (paneIndex 3) | LineSeries × 2 | points filtered out + WhitespaceData inserted at auction start on each series |
| FillStrength (paneIndex 4) | Histogram × 2 (buy/sell) | points filtered out (no break needed for histograms) |
| FillStrength | LineSeries (cumulative) | emission skipped during auction; `runningSum` continues to accumulate; WhitespaceData inserted at auction start |

**Cumulative net fill nuance**: `runningSum` keeps accumulating through 15:20–15:30 so that *if* there were any post-auction points in the same trading day, the cumulative would resume at the correct value. In practice the trading day ends at 15:30, so this is a no-op visually but preserves "hide is a rendering decision, not a data decision."

### Predicate reuse

The single source of truth for "is this time inside the closing auction window?" stays at `util/virtualAxis.ts::inClosingAuctionWindow(realMs)`. Projectors call `isAuctionMaskActive(toggle, axis, t)` from `util/auctionMask.ts` — the predicate is unchanged; only the action taken on `true` changes (was: emit 0; now: skip + maybe break).

This means half-day sessions are handled correctly without per-projector code (the predicate already anchors to `sessionCloseMs - 10min`).

### Helper module — `chart/util/auctionMaskGap.ts` (new)

The three line series (ratio, quoteTotals bid, quoteTotals ask, fillStrength cumulative) all need the same control flow:

> While iterating points: if this is the first point *inside* the auction window, push a `WhitespaceData` at `axis.toVirtual(t) - 1ms` to break the line. Then skip the point. When re-entering non-auction time within the same series scan, reset the "we already broke" flag so day-gap-then-auction-again works on multi-day bundles.

A small state-machine helper exposes:

```ts
export type AuctionGap = {
  // Call before processing each point. Returns a WhitespaceData to push
  // before emitting the current point (line break), or null.
  breakBefore(t: number): WhitespaceData<Time> | null;
  // True if this point falls inside the auction window and should be skipped.
  isHidden(t: number): boolean;
  // Reset internal state at segment boundaries (when caller iterates segments).
  reset(): void;
};

export function makeAuctionMaskGap(
  axis: Pick<VirtualAxis, 'inClosingAuctionWindow' | 'toVirtual'>,
  enabled: boolean,
): AuctionGap;
```

Internal state: a single `wasInAuction: boolean` flag. On first transition `false → true`, emit the break. Subsequent points keep returning `null` for `breakBefore` (one break per entry). When the caller sees `false` again (no longer in auction), reset the flag so a future re-entry within the same iteration would break again — defensive against unusual data shapes.

When `enabled === false`, both methods return `null` / `false` so projectors can call them unconditionally.

### Projector changes

**ratio.ts** — `projectRatio()`:

```ts
const gap = makeAuctionMaskGap(axis, ctx.auctionWindowMask);
const out: (BaselineData<Time> | WhitespaceData<Time>)[] = [];
for (const p of bundle.quote_ratio.points) {
  if (!axis.contains(p.t)) continue;
  const br = gap.breakBefore(p.t);
  if (br) out.push(br);
  if (gap.isHidden(p.t)) continue;
  const raw = quoteImbalance(p.bid_total, p.ask_total);
  const isExtreme = ctx.outlierFilterEnabled && 1 + Math.abs(raw) >= ctx.outlierThreshold;
  out.push({
    time: (axis.toVirtual(p.t) / 1000) as UTCTimestamp,
    value: isExtreme ? 0 : raw,        // outlier filter unchanged: still emits 0
  });
}
return out;
```

The outlier filter (`ratioOutlierFilterEnabled`) keeps its "mask to 0" semantics — that toggle is independent and serves a different purpose (clamping autoscale-dominating spikes). Only the auction-window logic changes.

**quoteTotals.ts** — `projectBid()` and `projectAsk()`: same shape, two parallel passes. Could share a single iterator that emits both arrays but the duplication is small — keep the existing two-function structure with `makeAuctionMaskGap` called per pass (two independent state machines, one per series).

**fillStrength.ts**:

- `projectBuy()`, `projectSell()`: just `if (gap.isHidden(p.t)) continue;` — no break needed because histograms have no continuity.
- `projectCumulativeNetFill()`: thread `gap.breakBefore` / `gap.isHidden` into the existing per-segment loop. `runningSum += p.buy_qty - p.sell_qty` runs **before** the hidden check, so accumulation continues. The existing day-boundary whitespace break (line 115) and zero-anchor (line 118) compose naturally with the new auction break.
- `FillStrengthPaneContext` gains `auctionWindowMask: boolean`. `useFillStrengthContext` adds one line to the useShallow selector.

**Critical interaction in fillStrength.ts**: the cumulative function iterates segments outermost, points innermost. `gap.reset()` is called at the top of each segment iteration so the "we already broke" flag doesn't leak across day boundaries. The day-boundary whitespace at line 115 still fires; if the auction break happens to fall right after, both whitespace points coexist without harm (lightweight-charts dedupes by time, and they're at different times).

### Tests

- `chart/util/auctionMaskGap.test.ts` (new) — state machine: enabled/disabled, entry break, no double-break, reset behaviour.
- `chart/projectors/ratio.test.ts` — replace existing "values 0 during auction" assertion with "points absent + whitespace at boundary"; keep outlier-filter-emits-0 assertion intact.
- `chart/projectors/quoteTotals.test.ts` — same shape as ratio.
- `chart/projectors/fillStrength.test.ts` — new test cases: histograms exclude auction points; cumulative line skips emission inside auction; cumulative `runningSum` continues to accumulate auction-window deltas — asserted directly by calling `projectCumulativeNetFill` with a synthetic bundle whose session_close_ms is artificially extended past 15:30, then checking that the first emitted post-15:30 point reflects the in-auction deltas; whitespace appears at boundary.
- `util/auctionMask.test.ts` — unchanged (predicate semantics unchanged).
- `replay/SettingsModal.test.tsx` — if label string is asserted, update.

### Persistence

`auctionWindowMask` key is preserved in `CHART_TOGGLES` and `ChartViewPrefs`. Existing localStorage values (`true`/`false`) apply to the new semantics naturally. No migration code.

## Open questions

None — all scope and behaviour decisions confirmed during brainstorming and grilling.

## Related decisions

- **ADR-0029** (this change) — Auction Mask hides chart-pane indicators (replaces mask-to-0). Captures the reversal of ADR-0026's "same choice the Auction Mask made" note and explains why phantom-break concerns from ADR-0026 don't apply when an explicit `WhitespaceData` boundary marker is inserted.
- **ADR-0018** — CandlePane muting is not Auction Mask. Confirms candle/volume carve-out is intentional and pre-existing.
- **ADR-0026** — Ratio Outlier Mask remains value-0; only the Auction Mask switches to drop-and-break.
- **CONTEXT.md** entries updated in lock-step: Auction Window, Auction Mask, 호가비, Outlier Mask, FillStrength, Cumulative Net Fill.

## Risks

- **lightweight-charts whitespace + BaselineSeries**: confirmed in v5 docs that `BaselineSeries.setData()` accepts `(BaselineData | WhitespaceData)[]`. If a runtime issue surfaces (e.g. gradient computation choking on whitespace), fallback is to set the value at the boundary point to `0` and rely on the visual gap from the missing in-auction points — degraded but functional.
- **Cumulative line re-entry**: if a future market-rule change adds post-15:30 same-day data, the cumulative would resume at the accumulated value — which is the correct behaviour per the decision but worth flagging.
- **Outlier filter coexistence in ratio**: the outlier filter still emits `0` for extreme values. If an extreme value lands exactly at 15:19:59.999 and the next point is 15:20:00, the visual is "spike to 0, then line break, then nothing" — accurate but visually busy. Acceptable; both signals are real.
