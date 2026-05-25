# 0029 — Auction Mask hides chart-pane indicators (replaces mask-to-0)

**Status:** accepted (2026-05-25)

## Decision

When the per-tab `auctionWindowMask` toggle is on (default), chart-pane projectors for indicators **derived from order book or trade data** — RatioPane (호가비), QuoteTotalsPane, and FillStrength (both histograms and Cumulative Net Fill) — **emit each in-window data point as `WhitespaceData`** (no `value` field) during the closing Auction Window (15:20–15:30 KST on full-day sessions; last 10 minutes on half-day sessions). Line/baseline series break naturally at the first whitespace and remain blank through the window; histograms render no bar where a whitespace point lives.

CandlePane and VolumePane are deliberately excluded — their data during the Auction Window is structurally meaningful (price formation, total transacted volume) and hiding them would create disorienting holes in the price/volume history.

Spot views (sidebar `TotalQtyBar`) continue to consult the same Auction Mask predicate but render an "Auction" inline label instead of the bar fill — they were already in this shape pre-change and are not affected.

## Why

The pre-2026-05-25 implementation:
- RatioPane and QuoteTotalsPane emitted `value = 0` during the Auction Window when the toggle was on.
- FillStrength was never gated by the toggle; the natural empty-window gap was considered sufficient.
- ADR-0026 explicitly rejected "drop the point" for the Outlier Mask, citing "discontinuous series with phantom breaks", and noted "Same choice the Auction Mask made for the same reason."

Two problems surfaced from actual use:

**1. Value-0 plateaus read as real data.** A flat-zero baseline-touch for 10 minutes before close looks like a measurement, not a "the system declined to render this." Users who didn't know about the toggle interpreted the plateau as "ratio = 0 = balanced order book" — the opposite of the truth (one-sided accumulation is what triggered the mask). The visual lied about the underlying state.

**2. Quote Totals accumulation read as misleading signal too.** The earlier Auction Window glossary entry argued "the accumulating levels are themselves the signal" and rendered Quote Totals raw across the window. But the levels accumulate one-sidedly into the cross — the visual is a hockey-stick on one side and a flatline on the other, which analysts pattern-match to "imminent breakout" even though it's mechanically guaranteed by the auction structure. Showing the raw lines made the chart noisier without adding information that wasn't already telegraphed by the 15:20 timestamp.

The unified treatment — all chart panes other than Candle/Volume hide together at 15:20 — communicates "this 10-minute slice is auction-formed, treat as discontinuous" with a single visual rule.

**Why this isn't a re-litigation of ADR-0026.** ADR-0026's rejection of "drop the point" was a pure-drop: leave the in-window data out of the wire entirely. That breaks **two** things at once — the line interpolates across the gap (the phantom-break artifact ADR-0026 names) AND lightweight-charts' bar-index time scale shrinks to fit the surviving data, which silently hides `AuctionWindowOverlay` (its `timeToCoordinate(auctionStart)` / `timeToCoordinate(sessionClose)` return null past the data range). The fix-in-this-ADR keeps every in-window minute on the wire as `WhitespaceData` — the line breaks at the first whitespace (no interpolation), and every in-window timestamp remains a valid bar position so the overlay band renders at full width. The Outlier Mask doesn't get this treatment because outlier points are scattered throughout the timeline rather than clustered in a known-boundaries window — a per-outlier whitespace would shred the line.

The initial implementation used a single boundary `WhitespaceData` at 1ms before the first dropped point (with the in-window points themselves filtered out). That broke the line cleanly in unit tests but failed in the browser: with the in-window minutes absent from the data, `chart.timeScale().timeToCoordinate(...)` returned null for the auction band's corners, so `AuctionWindowOverlay` rendered as zero children. Replacing "drop + one boundary" with "every in-window point becomes whitespace" was the smaller change that restored the overlay, and it deleted the `auctionMaskGap.ts` state-machine helper along with it.

## Why CandlePane and VolumePane are excluded

**Candle**: per ADR-0018. Candle data during the Auction Window is structurally legitimate (price formation), not misleading; a hole in the price history is more disorienting than the muted color it currently uses. The mute-color rule is always-on and not gated by `auctionWindowMask`.

**Volume**: bucketed total transacted shares per timeframe. During the Auction Window the wire data is naturally zero (no continuous-trade volume; the cross is excluded), and the 15:30 cross's volume is real shares that traded. Volume answers "how much changed hands" — the answer is the answer regardless of which matching mechanism produced it. Hiding it would lose the cross-bar from the totals.

The carve-out rule is mechanical: **a pane is hidden during the Auction Window iff its values are dominated by order-book-state accumulation that doesn't represent continuous price discovery**. Ratio, QuoteTotals, and FillStrength all derive from accumulation patterns that the auction mechanism makes one-sided by construction. Candle and Volume describe what happened (matched), not what was queued.

## Consequences

- `chart/projectors/ratio.ts`, `quoteTotals.ts`, and `fillStrength.ts` each contain the same inline 2-line check `if (mask && axis.inClosingAuctionWindow(p.t)) { out.push({ time }); continue; }` before emitting a value-bearing data point. No shared helper module: the abstraction's contract would be longer than the inline check.
- `FillStrengthPaneContext` gains `auctionWindowMask: boolean`. RatioPaneContext already carries it. QuoteTotalsPane's `useContext` switches from a bare boolean to the same toggle (no shape change).
- Cumulative Net Fill: `runningSum` continues to accumulate through the window (defensive — there are no in-window points in practice, but the invariant "hide is a rendering decision, not a data decision" stays clean). Emission is suppressed.
- The `auctionWindowMask` toggle's label/description in `state/chartPrefs.ts` is updated to "동시호가 구간 지표 숨김" / "15:20–15:30 KST 동시호가 구간에서 호가비·호가총합·체결강도를 표시하지 않습니다. (캔들/거래량 제외)".
- `auctionWindowMask` key is preserved in `CHART_TOGGLES` and `ChartViewPrefs` — no localStorage migration. Existing user preferences (`true`/`false`) apply to the new semantics naturally.
- `AuctionWindowOverlay` (the subtle background band at 15:20–15:30) is unchanged. It now reads as "this is the hidden zone" rather than "this is the mask-to-0 zone" — same band, accurate-er meaning.
- CONTEXT.md's "Auction Window", "Auction Mask", "호가비", "Outlier Mask", "FillStrength", and "Cumulative Net Fill" entries are updated in the same change.
- ADR-0018 (candle muting is not Auction Mask) and ADR-0026 (outlier mask is value=0) remain accepted and consistent — this decision sits alongside them, narrowing the Auction Mask's rendering action to "drop + break" specifically for the time-window mask, without disturbing the Outlier Mask's value-0 treatment or the candle muting's always-on independence.

## Alternatives considered

**Keep mask-to-0 for Ratio/QuoteTotals, extend it to FillStrength.** Rejected on the same grounds as problem (1) above — the issue is the plateau, not the missing panes. Extending value-0 to FillStrength would create a 10-minute zero-bar plateau that's just as misleading.

**Add a second toggle "auctionHideIndicators" alongside `auctionWindowMask`.** Rejected. Two toggles for one mental model ("during the closing auction, treat indicator visuals as suspect") is a settings-modal expansion that solves no user problem. The semantic shift from "mask to 0" to "hide" is a refinement, not a new feature.

**Hide the entire panes during 15:20–15:30 (collapse pane height).** Rejected. The pane stretch ratios are part of the workarea layout; collapsing and re-expanding mid-day would jank the chart layout and break drawings whose Y-coordinates are pane-bound (ADR-0028). Visual emptiness inside a stable pane is the lesser cost.

**Backend filter (omit in-auction points from `quote_ratio.points` and `fill_strength.points`).** Rejected. Loses raw data for users who want to flip the toggle off, couples the wire to a presentation rule, and ADR-0013's "RangeBundle is the single read-path Wire Model" intent prefers presentation rules at the projector layer.

**Drop the point without inserting a boundary `WhitespaceData`.** Rejected — this is the exact failure mode ADR-0026 cited. lightweight-charts interpolates a straight line between the last pre-window point and the first post-window (or next-day) point, producing a "phantom break" that crosses the empty band diagonally.

**Drop in-window points and insert a single boundary `WhitespaceData`.** Tried during the first implementation pass, then reverted. Cleanly breaks the line in isolation, but the time scale shrinks past the missing data and `AuctionWindowOverlay`'s `timeToCoordinate(auctionStart)` / `timeToCoordinate(sessionClose)` return null, hiding the highlight band entirely. The current decision (whitespace at every in-window minute) keeps each minute as a valid bar position so the overlay renders at full width.

**Push a trailing whitespace at `session_close_ms` per segment to extend the visible range.** Rejected. Extends the range, but `timeToCoordinate(auctionStart)` still returns null because no data point lives at that intermediate timestamp (lightweight-charts maps bar indices, not arbitrary times). Would need dense intermediate anchors anyway — the per-minute-whitespace approach already provides them naturally.
