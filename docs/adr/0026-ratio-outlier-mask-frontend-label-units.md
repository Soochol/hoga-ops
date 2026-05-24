# 0026 — Ratio Outlier Mask is frontend-side, label-unit, user-tunable

**Status:** accepted (2026-05-24)

## Decision

The `RatioPane`'s extreme-value suppression — the new **Outlier Mask** — is implemented in `projectRatio` (`frontend/src/chart/projectors/ratio.ts`), gated by two per-tab **ChartViewPrefs** fields:

- `ratioOutlierFilterEnabled: boolean` (default `true`)
- `ratioOutlierThreshold: number` (default `100`, range `[2, 10000]`, integer)

A point is masked to `value = 0` iff `enabled && (1 + |raw imbalance|) >= threshold`. The threshold is expressed in the chart's Y-axis label unit (`max(ask/bid, bid/ask)`) — what the user actually sees — not in the underlying `quoteImbalance` units (`ratio - 1`).

The Outlier Mask runs in addition to (logical OR with) the **Auction Mask**; the two have independent triggers and intents.

## Why

Three orthogonal decisions, taken together:

**1. Frontend projector, not backend pre-filter.** Backend `build_quote_ratio_slice` would have to either drop the outlier point (loses time-axis continuity in the wire) or store a "masked" flag (couples the data layer to a visual presentation rule). The projector layer already owns auction-window masking with the same pattern — adding outlier masking here keeps the policy single-sourced. Raw `bid_total`/`ask_total` stay intact on disk and on the wire, so future analysis and a user toggling the filter off see real data.

**2. Label units, not raw units, for the user-facing threshold.** `quoteImbalance` returns `ratio - 1` so that 0 is centered, but the `RatioPane`'s `priceFormat.formatter` renders `1 + |v|` on the Y axis. The user picks the threshold by looking at the chart. A threshold expressed in label units (`100` = "mask when the chart line crosses 100") matches what they see. Expressing it in raw units (`99` for the same effect) would be a translation step that has to be re-derived every time someone reads the code. The internal comparison `1 + |raw| >= threshold` accepts the mental-model alignment at the cost of one constant on each side of the equation.

**3. User-tunable, not a hard-coded constant.** The right threshold depends on the **Code** (저유동성 종목 vs 대형주) and the analyst's question. A blue-chip's natural ratio rarely crosses 5x, so a 100x outlier dominates autoscale. A 동전주 with a thin orderbook can sit at 30x routinely; masking everything above 100 still suppresses real signal there. Per-tab state lets the same user view two **Codes** with two different thresholds simultaneously.

The default `100` was chosen from observation: in the validation runs for this feature, ratios below 100x compressed visibly under any outlier; ratios above 100x were always extreme accumulation moments (often within seconds of trading halts or 上限/下限 stops). 100 is the round number that worked across the codes inspected; the range `[2, 10000]` lets users tune without leaving the chart.

## Consequences

- `RatioPane`'s `PaneSpec.useContext` returns a `RatioPaneContext` object (three fields) rather than a single boolean. The PaneSpec type is generic over context type so this is a typed widening, not a breaking change to other panes.
- `mergePrefs` in `tabsPersistence.ts` validates `ratioOutlierThreshold` and falls back to default on any non-finite, out-of-range, or non-number value — defending against corrupt localStorage rather than clamping silently (which would mask the corruption).
- The `setRatioOutlierThreshold` setter clamps at the store boundary as defense-in-depth; UI input also enforces the range.
- A future "show masked outliers as separate markers" feature can be layered on top without changing this mask's contract — the projector still emits one series, and the marker overlay would consume the same `(threshold, enabled)` prefs.

## Alternatives considered

**Backend filter (drop or flag outliers in `build_quote_ratio_slice`).** Rejected. Loses raw data for future re-analysis and couples the data layer to a UI presentation rule. Re-enabling on a user-by-user basis becomes a wire-protocol question.

**Raw-unit threshold (compare `|raw|` to a stored raw threshold).** Rejected. The user sees label units on the chart axis; a threshold input that doesn't match the axis is a friction every time they adjust it. The internal `1 + ...` translation is cheap.

**Repurpose `auctionWindowMask` to include outliers.** Rejected for the same reason ADR-0018 rejected coupling candle muting to it: two distinct intents, two distinct UI affordances. A user wanting to see closing-auction ratios may still want outlier masking, and vice versa.

**Hard-coded threshold (no user setting).** Rejected. Validated as wrong during the first pass (the immediately preceding commit set `> 100` hard-coded); per-code threshold variation is large enough that a single global value either over-masks or under-masks for most users.

**Hide masked points (drop them from the series) instead of `value = 0`.** Rejected. lightweight-charts' `setData` invariants (strictly ascending unique timestamps per ADR-0010) make dropping points safe in this case, but the resulting visual is a discontinuous series with phantom breaks; `value = 0` produces a baseline-touching segment that the BaselineSeries's existing 0-crossing styling handles cleanly. Same choice the **Auction Mask** made for the same reason.
