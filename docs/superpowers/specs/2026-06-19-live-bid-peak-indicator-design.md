# /live 당일 매수 최대벽 지표

## Context

`/live` already has a "당일 매도 최대벽" indicator that spans backend range bundles, past-day parquet queries, today's live WebSocket ratchet, persisted indicator preferences, the indicator modal, and a candle-pane overlay. The requested feature is the symmetric "당일 매수 최대벽" indicator with the same user-facing structure and toggle behavior.

The feature must preserve existing ask-peak behavior and add bid-peak behavior in parallel. It should avoid broad API rewrites or a generalized orderbook-wall migration that would churn stable ask-peak contracts.

## Goal

Add a maximum bid-wall indicator that mirrors the maximum ask-wall indicator:

- One per trading day on minute charts only.
- Drawn as a horizontal segment across that trading day's session range.
- Uses a baseline "체결가격 기준 최대벽" line.
- Optionally shows a second "미체결 포함 최대벽" line when the untraded bid wall is larger than the baseline.
- Appears in the indicator modal under the hoga indicator group with the same master checkbox and detail-pane structure as ask peak.
- Supports the same style and auxiliary toggle structure: master on/off, line color/width, intra-bar max, and show-untraded toggle.

## Definitions

Baseline bid peak:

- The largest bid level quantity for a day among bid prices that are considered traded/price-range eligible.
- Eligibility mirrors ask peak's traded-price rule, but on bid levels.
- For today's live stream, observed bid levels become baseline candidates when their price is in the live traded-price set or inside today's candle price range.

Untraded bid peak:

- The largest eligible bid level below the day's low.
- It is rendered only when its selected quantity is greater than the baseline bid peak quantity.
- This is the bid-side mirror of ask peak's "above day high" untraded ask rule.

Intra-bar max:

- When `bidPeakIntraMax` is off, the baseline and untraded comparisons use bucket representative values.
- When `bidPeakIntraMax` is on, they use the largest moment within each bucket, matching ask peak's `askPeakIntraMax` behavior.
- Today's live value is always ratcheted from live observations, matching ask peak.

## Backend Design

Add a `BidPeak` API model with the same shape as `AskPeak`:

- `date`, `price`, `qty`, `t_ms`
- `max_price`, `max_qty`, `max_t_ms`
- all-price fields for live/full-day bid observations
- untraded fields for below-low bid candidates

Add `bid_peaks: list[BidPeak]` to `RangeBundle`, defaulting to an empty list for backwards compatibility.

Add bid peak range-bundle computation beside ask peak:

- `build_bid_peak_slice(...)` mirrors `build_ask_peak_slice(...)`.
- Past days are cacheable through `PastIndicatorsCache`, with a separate bid-peak cache key.
- `build_range_bundle(...)` computes and appends one `BidPeak` per included trading day.
- Missing files, invalid stock dates, or empty candidate sets return `None`, matching ask peak's best-effort behavior.

Extend snapshot table queries with bid-side equivalents:

- Query bid levels instead of ask levels.
- Keep the same continuous-book/session filters.
- Keep the same tie policy: first reached maximum wins.
- Use trades parquet when available to split baseline, all-price, and untraded variants.
- Define untraded bids as prices below the day's low.

Extend live stream state:

- Add a bid-side today peak state or generalize the current state internally with a side parameter.
- Track bid `traded_peak`, `all_peak`, `observed_price_peaks`, `traded_prices`, and `coverage`.
- Expose today's bid peak through the live series payload in parallel with `ask_peak_today`.
- Continue to exclude auction/post-close and non-continuous books before ingest.

## Frontend Design

Add persisted indicator preferences:

- `bidPeakEnabled`
- `bidPeakColor`
- `bidPeakLineWidth`
- `bidPeakAllPriceColor`
- `bidPeakAllPriceLineWidth`

Defaults:

- `bidPeakEnabled`: `false`
- baseline color: `#DC2626`, matching the app's KRX buy/up market-data red
- baseline width: `2`
- all-price/untraded color: `#F97316`, matching ask peak's secondary untraded-line color so both indicators use the same visual grammar for the optional second line
- all-price/untraded width: `1`

Add chart preference toggles:

- `bidPeakIntraMax`
  - label: `분봉 내 최댓값 기준`
  - category: `indicator-modal`
  - default: `false`
- `bidPeakShowAllPrices`
  - label: `미체결 최대 매수벽 표시`
  - category: `indicator-modal`
  - default: `true`

Add indicator modal category:

- Group: `호가 지표`
- Label: `당일 매수 최대벽`
- Master checkbox toggles `bidPeakEnabled`.
- Detail pane mirrors `AskPeakConfig`:
  - explanatory copy describes bid levels and the below-low untraded rule
  - style picker for baseline line
  - style picker for untraded/all-price line
  - divider
  - `IndicatorPrefRows` for `bidPeakIntraMax` and `bidPeakShowAllPrices`

Add chart overlay:

- Reuse the existing segment primitive if possible.
- Add bid-specific segment construction that mirrors `buildAskPeakOverlaySegments`.
- Render only on minute timeframes, following ask peak's existing mount policy.
- Use `bid_peaks` from range bundle plus today's live bid peak ratchet.
- Keep ask and bid overlays independent; turning one on/off must not affect the other.

## Data Flow

Past days:

1. `/api/range` loads parquet data.
2. Range bundle computes `bid_peaks` per included day.
3. Frontend stores the received seeds.
4. Overlay maps each seed to that day's session segment.

Today:

1. Live stream publishes bid peak today payload with traded/all-price fields.
2. Frontend hook seeds a today bid ratchet from the backend payload.
3. Live orderbook/trade snapshots advance the ratchet.
4. The returned bid peak replaces any today seed in the per-day list.
5. Overlay extends today's segment to the latest candle, matching ask peak.

## Error Handling

- Legacy payloads without `bid_peaks` or `bid_peak_today` must render no bid-peak lines and not throw.
- Corrupt persisted preferences fall back to defaults through the existing merge/validation pattern.
- Missing style fields fall back to bid peak defaults.
- Empty bid candidates produce no line for that day.
- A missing untraded bid peak never suppresses the baseline line.

## Testing Plan

Backend tests:

- `BidPeak` model accepts baseline, max, all-price, and untraded fields.
- Snapshot query finds the largest bid level.
- Tie policy keeps the earliest occurrence.
- Auction/non-continuous snapshots are excluded.
- Intra-bar max catches a mid-bucket bid spike.
- Untraded bid peak below day low is populated and compared separately.
- Range bundle includes `bid_peaks` per day and defaults to an empty list.
- Past-day bid peak cache is bucket-aware and separate from ask peak cache.
- Live stream today bid state updates from trade and orderbook ticks and ignores malformed/non-regular books.

Frontend tests:

- Indicator persistence merges new bid peak fields and preserves legacy stores.
- `chartPrefs` registers `bidPeakIntraMax` and `bidPeakShowAllPrices` in the indicator modal.
- Indicator panel renders the `당일 매수 최대벽` category and checkbox.
- Detail pane renders style rows and bid-specific toggle rows.
- Overlay segment builder maps bid peaks to day segments and respects intra-max selection.
- Untraded bid line renders only when larger than baseline.
- `LiveChartRoot` mounts bid peak overlay only on minute timeframes and only under the bid master toggle.

## Non-Goals

- Replacing `AskPeak` with a generic wall-peak API.
- Changing ask peak UI copy, defaults, colors, or behavior.
- Rendering bid/ask wall indicators on daily, weekly, or monthly timeframes.
- Adding new numeric sensitivity controls.
- Changing the orderbook sidebar.
