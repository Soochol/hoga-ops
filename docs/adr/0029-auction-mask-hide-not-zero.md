# 0029 — Auction Mask hides chart-pane indicators (replaces mask-to-0)

**Status:** accepted (2026-05-25)

## Decision

When the per-tab `auctionWindowMask` toggle is on (default), chart-pane projectors for indicators **derived from order book or trade data** — RatioPane (호가비), QuoteTotalsPane, and FillStrength (both histograms and Cumulative Net Fill) — **keep the in-window data points on the time axis but paint them invisible** during the closing Auction Window (15:20–15:30 KST on full-day sessions; last 10 minutes on half-day sessions). The rendering action differs by series type:

- **LineSeries / BaselineSeries** (호가비, 호가총합 ×2, 누적): emit `value = 0` with the per-point `color` (LineSeries) or `topLineColor`/`topFillColor{1,2}`/`bottomLineColor`/`bottomFillColor{1,2}` (BaselineSeries) set to `rgba(0,0,0,0)`. lightweight-charts paints the outgoing segment from each point in that point's color, so transparent there yields an invisible segment without breaking the bar-index time scale.
- **HistogramSeries** (체결 매수/매도 막대): emit `WhitespaceData` (no `value` field). Histograms genuinely skip drawing bars at whitespace, so the per-point-color trick isn't needed there.

The single predicate + per-series-type color sentinels live in `chart/util/auctionHide.ts`. Each projector inlines a 3-line check; no per-projector duplication.

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

**Why this isn't a re-litigation of ADR-0026.** ADR-0026's rejection of "drop the point" was a pure-drop: leave the in-window data out of the wire entirely. That breaks **two** things at once with lightweight-charts v5:

1. **Bar-index time scale shrinks** to the surviving data. `AuctionWindowOverlay`'s `timeToCoordinate(auctionStart)` / `timeToCoordinate(sessionClose)` return null past the data range, so the highlight band silently disappears.
2. **Line series interpolate across the gap.** LineSeries and BaselineSeries do not break at missing time slots — they draw a single segment from the last value-bearing point to the next. Multi-day data turns day-N's last in-session value into a diagonal straight to day-(N+1)'s first value, crossing the (hidden) auction window AND the inter-segment gap as one continuous slope.

The fix in this ADR keeps every in-window minute on the wire as a real data point with transparent per-point color. Every in-window timestamp remains a valid bar position so the overlay band renders at full width, and the outgoing segment from each transparent point is itself transparent so no diagonal crosses the band. The Outlier Mask doesn't need this treatment because outlier points are scattered throughout the timeline rather than clustered in a known-boundaries window.

This decision was reached after **three** implementation passes — kept for future readers so they don't repeat the same dead ends:

1. **Drop in-window points + insert one boundary `WhitespaceData`** at the auction-start virtual time. Unit-tested cleanly. Failed in browser: with in-window minutes absent, the time scale shrunk past 15:20 and the overlay band disappeared.
2. **Emit `WhitespaceData` at every in-window minute** (drop the value, keep the timestamp). Restored the overlay band, but empirical browser testing revealed that LineSeries / BaselineSeries v5 silently interpolate across whitespace — multi-day charts still drew the day-N → day-(N+1) diagonal across the band. **This was a wrong assumption about the library.** A minimal `setData([value, ws, value])` test confirmed it directly.
3. **Per-point transparent color** (current decision). Solves both problems: timestamps are real data points (overlay works), per-point `color` on each in-window point makes its outgoing segment invisible (no diagonal).

### Why not "filter at source" (the cleaner mental model that doesn't work)

A natural proposal is: filter the in-window points at the wire layer (or as a pre-projection transform) and let all derived indicators go empty automatically. This would be a single point of control, projectors would stay ignorant of auction semantics, and adding a new derived indicator would need no per-projector mask code.

It fails for the same two reasons as approach #1 above. Dropping in-window points from the wire is the same data shape as dropping them at the projector — the chart can't tell the difference. The two lightweight-charts behaviours (bar-index shrink, line interpolation across gaps) make "no data" visually mean "draw a diagonal through this region with no band". The user's mental model — "no data ⇒ no indicator" — is correct in the abstract but doesn't survive contact with this specific library.

The per-point-transparent-color approach achieves the user-visible result of "filter at source" while accommodating the library. The shared `chart/util/auctionHide.ts` helper keeps the projector code as close to the "filter at source" feel as possible: each projector calls `isAuctionHidden(axis, mask, t)` and spreads the appropriate hidden-colors sentinel.

A future migration back to "filter at source" becomes viable if lightweight-charts ever (a) keeps the time scale extent independent of data presence and (b) treats `WhitespaceData` as a true line break. Until then, the helper is the single edit point if the technique changes.

## Why CandlePane and VolumePane are excluded

**Candle**: per ADR-0018. Candle data during the Auction Window is structurally legitimate (price formation), not misleading; a hole in the price history is more disorienting than the muted color it currently uses. The mute-color rule is always-on and not gated by `auctionWindowMask`.

**Volume**: bucketed total transacted shares per timeframe. During the Auction Window the wire data is naturally zero (no continuous-trade volume; the cross is excluded), and the 15:30 cross's volume is real shares that traded. Volume answers "how much changed hands" — the answer is the answer regardless of which matching mechanism produced it. Hiding it would lose the cross-bar from the totals.

The carve-out rule is mechanical: **a pane is hidden during the Auction Window iff its values are dominated by order-book-state accumulation that doesn't represent continuous price discovery**. Ratio, QuoteTotals, and FillStrength all derive from accumulation patterns that the auction mechanism makes one-sided by construction. Candle and Volume describe what happened (matched), not what was queued.

## Consequences

- `chart/util/auctionHide.ts` owns the predicate (`isAuctionHidden`) and the per-series-type hidden-color sentinels (`LINE_HIDDEN_COLOR`, `BASELINE_HIDDEN_COLORS`). The rgba string lives in exactly one place; the predicate's toggle-short-circuit is shared.
- `chart/projectors/ratio.ts`, `quoteTotals.ts`, and `fillStrength.ts` each call the helper inline: `if (isAuctionHidden(axis, mask, p.t)) { out.push({ time, value: 0, ...HIDDEN }); continue; }`. RatioPane spreads `BASELINE_HIDDEN_COLORS` (6 fields). The line projectors spread `LINE_HIDDEN_COLOR` (1 field). Histograms (fillStrength buy/sell) call the predicate but push `WhitespaceData` instead of a transparent-color marker — HistogramSeries actually skips the bar at whitespace, so no color override is needed.
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

**Drop in-window points and insert a single boundary `WhitespaceData`.** Tried in pass 1. Cleanly breaks the line in unit tests, but the time scale shrinks past the missing data and `AuctionWindowOverlay`'s `timeToCoordinate` returns null, hiding the highlight band.

**Push a trailing whitespace at `session_close_ms` per segment to extend the visible range.** Rejected. Extends the range, but `timeToCoordinate(auctionStart)` still returns null because no data point lives at that intermediate timestamp (lightweight-charts maps bar indices, not arbitrary times). Would need dense intermediate anchors anyway.

**Emit `WhitespaceData` at every in-window minute.** Tried in pass 2. Time scale and overlay band work, but LineSeries / BaselineSeries v5 silently interpolate across whitespace — multi-day charts still draw a diagonal from day-N close to day-(N+1) open through the hidden band. Confirmed empirically with a minimal `setData([{time:100,value:1},{time:200,value:2},{time:300}/*ws*/,{time:400,value:5}])` test; the line passed straight through time=300. WhitespaceData has no documented contract for line-breaking in this library's v5 line/baseline series.

**Filter at source (drop in-window points from the wire or pre-projection).** Rejected for the same two reasons as the single-boundary approach above. Single point of control is conceptually attractive, but the user-visible result is identical to "drop the point": no overlay band, diagonal across the gap. See the dedicated subsection in the **Why** section.

**Per-point transparent color** (current decision). Bar slot stays present (overlay works), outgoing segment from each in-window point is invisible (no diagonal). Histograms still use `WhitespaceData` because HistogramSeries genuinely skips bars at whitespace.

**Split each affected indicator into multiple LineSeries — one per visible chunk between auction windows.** Rejected as overengineering. Different series don't connect visually, so it would solve the line problem cleanly. But it requires dynamic series lifecycle in `RangeSeriesPane` (currently "one PaneSpec → fixed N series at mount"), per-segment priceScale coordination, and risks regressions in drawing pane-binding (ADR-0028 binds drawings to a series reference). Not worth the complexity for the gain. Re-evaluate if a future feature needs dynamic series counts anyway.
