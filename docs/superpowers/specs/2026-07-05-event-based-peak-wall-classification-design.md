# Event-Based Peak Wall Classification — Design

**Date**: 2026-07-05
**Status**: Draft
**Scope**: `hoga/tables/snapshots.py`, `hoga/live/ask_peak_state.py`, `hoga/api/models.py`, `hoga/api/bundle.py`, `frontend/src/api/types.ts`, `frontend/src/state/chartPrefs.ts`, `frontend/src/live/indicators/AskPeakConfig.tsx`, `frontend/src/live/indicators/BidPeakConfig.tsx`, `frontend/src/live/useDayAskPeaks.ts`, `frontend/src/live/useDayBidPeaks.ts`, `frontend/src/live/LiveAskPeakSegments.tsx`, `frontend/src/live/LiveBidPeakSegments.tsx`, related tests

## Problem

The `당일 매도 최대벽` and `당일 매수 최대벽` indicators currently classify a wall by whether its price has traded during the day. That price-level rule cannot distinguish repeated walls at the same price.

User example:

```text
10:00  50,000원 매도벽 100,000주 발생
10:05  50,000원 체결
=> this wall should be classified as traded

10:20  50,000원 매도벽 200,000주 발생
after 10:20, 50,000원 is never touched again
=> this wall should be classified as untraded
```

The current price-level rule treats the second wall as traded because `50,000원` traded earlier in the day. The desired behavior is event-level classification: a wall is traded only if tick trades touch or cross that wall after the wall appears.

The UI also needs separate rank limits for traded and untraded walls. Today, traded walls can be shown as rank 1-3, while untraded walls are effectively limited to one extra line. The desired UI is rank 1-3 for both traded and untraded walls, for both ask and bid indicators.

## Invariants

- **Peak wall indicators are minute/hoga indicators**: Ask/bid peak wall overlays are driven by orderbook snapshots and trade ticks, not calendar candles alone. 근거: `frontend/src/live/LiveAskPeakSegments.tsx`, `frontend/src/live/LiveBidPeakSegments.tsx`.
- **Ask and bid behavior is symmetric but side-aware**: Ask walls trade when later ticks touch/cross upward; bid walls trade when later ticks touch/cross downward. 근거: existing separate ask/bid peak modules and user-confirmed requirement.
- **Same-price wall events remain distinguishable by time**: Two wall candidates with the same side and price but different `t_ms` can have different traded/untraded classifications. 근거: user example.
- **No order identity is inferred**: The system cannot prove that the exact visible order quantity was filled; it can only infer that later ticks reached the wall price. 근거: trade tick/orderbook data lacks order IDs.
- **Default rank limits preserve current visual density**: Existing users should continue to see one traded line and one optional untraded line unless they opt into more ranks. 근거: existing `askPeakAllPriceRankLimit` and `bidPeakAllPriceRankLimit` defaults.
- **Untraded lines are still comparative signal lines**: Untraded walls should render only when their quantity is larger than the relevant traded baseline for the same side/date/ranking context. 근거: existing `askPeakShowAllPrices`/`bidPeakShowAllPrices` behavior and UI copy.
- **Visible-time cutoff remains candidate-time based**: If `보이는 최신 봉 기준` is enabled, candidates after the rightmost visible candle must not affect either traded or untraded rank selection. 근거: `2026-07-04-peak-wall-visible-time-cutoff-design.md`.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| Peak wall indicators are minute/hoga indicators | preserves | The new classifier still uses orderbook candidates plus trade ticks. |
| Ask and bid behavior is symmetric but side-aware | preserves | Ask uses later `trade.price >= wall.price`; bid uses later `trade.price <= wall.price`. |
| Same-price wall events remain distinguishable by time | intentionally changes current behavior | This is the core requested behavior change: same price no longer implies same classification. |
| No order identity is inferred | preserves | Labels and docs should describe "touched after wall appeared", not exact order fill. |
| Default rank limits preserve current visual density | preserves | New untraded rank prefs default to `1`; existing traded rank prefs keep default `1`. |
| Untraded lines are still comparative signal lines | preserves | Untraded rank candidates are filtered/compared before rendering, rather than always adding all untraded ranks. |
| Visible-time cutoff remains candidate-time based | preserves | Cutoff filtering occurs before event classification/ranking output for the cutoff date. |

The same-price behavior is intentionally changed because the old price-level rule contradicts the user's trading interpretation. The new event-level rule matches the user's mental model while staying honest about what tick data can prove.

## Goals

- Classify ask/bid peak wall candidates by event time, not by whole-day price membership.
- Use tick trade data to decide whether a wall was later touched or crossed.
- Distinguish repeated walls at the same price when they occur at different times.
- Apply the rule to both historical `/api/range` peak calculations and today's live peak state.
- Apply the rule symmetrically to `당일 매도 최대벽` and `당일 매수 최대벽`.
- Add UI controls so traded walls and untraded walls can each display rank 1, 2, or 3.
- Preserve defaults: traded rank limit `1`, untraded rank limit `1`.
- Keep existing style controls: traded and untraded lines still use their current separate colors/widths.
- Preserve `/live` and `/study` shared behavior through existing `LiveChartRoot`/indicator paths.

## Non-Goals

- Do not infer exact order fill identity or partial fill quantity.
- Do not add a new backend request that recalculates peak walls on every viewport change.
- Do not change the meaning of orderbook continuity/session filtering.
- Do not change candle OHLC calculation.
- Do not change the current line colors or default line widths.
- Do not make untraded walls render when their quantity is not larger than the traded baseline.
- Do not add rank limits above 3.

## Design

### Event Definition

A wall candidate is an event:

```text
side: ask | bid
price: number
qty: number
t_ms: number
source: close-representative | intra-bar-max
```

For historical close-representative mode, candidates come from the last continuous orderbook snapshot in each bucket. For intra-bar max mode, candidates come from continuous snapshots inside the bucket. Existing auction/VI/collapsed-book/session predicates still apply.

Candidates are not collapsed by price before classification. The same price can produce multiple candidates at different times:

```text
50,000원 / 100,000주 / 10:00
50,000원 / 200,000주 / 10:20
```

Those two candidates are classified independently.

### Tick Touch Rule

Use trade ticks after the wall appears:

```text
Ask wall at price P, time T:
  traded if any later trade tick has trade.price >= P and trade.t_ms >= T

Bid wall at price P, time T:
  traded if any later trade tick has trade.price <= P and trade.t_ms >= T
```

The comparison is inclusive on price and time. Inclusive time handles feeds where an orderbook update and trade tick share the same millisecond. If exact ordering within the same millisecond is unavailable, this is the least surprising rule: a tick at the same timestamp and crossing price means the wall was touched during that instant.

All candidates that fail the side-specific touch rule are untraded candidates.

The word "traded" in the UI means "touched or crossed by later tick trades", not "the exact order quantity was fully filled".

### Historical Calculation

Historical peak queries should stop using `price IN traded_prices` and `price > day_high` / `price < day_low` as the primary classifier. Instead:

1. Build eligible orderbook wall events for ask and bid.
2. Build a tick-derived future-touch index from the day's trade ticks.
3. Classify each event as traded or untraded using the side-specific touch rule.
4. Rank traded candidates by `qty DESC, t_ms ASC, price ASC`.
5. Rank untraded candidates by `qty DESC, t_ms ASC, price ASC`.
6. Return enough candidates for rendering rank 1-3 for both close-representative and intra-bar max modes.

For performance, avoid scanning all future ticks per candidate. Use a time-indexed suffix structure:

```text
For ask:
  suffix maximum trade price from each tick index onward
  event is traded if suffixMaxAfter(event.t_ms) >= event.price

For bid:
  suffix minimum trade price from each tick index onward
  event is traded if suffixMinAfter(event.t_ms) <= event.price
```

In SQL/DuckDB, this can be expressed with window functions over trade ticks or with a precomputed tick table joined by time bucket/index. The implementation plan should choose the simplest query that remains fast on captured day files.

### Today Live Calculation

Today live state should mirror the historical semantics:

1. Ingest trade ticks in time order.
2. Ingest eligible orderbook snapshots in time order.
3. Store wall events by side, price, qty, and `t_ms`; do not replace an older same-price event merely because a later same-price event appears.
4. Classify candidates using trade ticks at or after each event time.
5. Publish ranked traded and untraded candidate arrays for ask and bid.

The live path may update a candidate's classification when a later tick arrives. Example:

```text
10:20 ask wall 50,000원 / 200,000주 appears
10:21 no touch yet -> untraded candidate
10:25 tick trades 50,000원 -> same event moves to traded candidates
```

This dynamic movement is expected and should be reflected in `/live`.

### API and Wire Shape

The frontend already has candidate arrays:

```text
traded_peaks
traded_max_peaks
all_peaks
all_max_peaks
untraded_* single fields
```

The desired shape should support ranked untraded candidates directly. Add arrays rather than overloading single `untraded_*` fields:

```text
untraded_peaks: AskPeakCandidate[]
untraded_max_peaks: AskPeakCandidate[]
```

Apply the same shape to `BidPeak`.

Keep existing single `untraded_*` fields as compatibility fields populated from rank 1. This preserves older frontend paths and cache payloads while allowing the new renderer to use arrays.

### UI

Update indicator detail panes for both sides.

Ask config:

```text
체결된 벽 표시 개수: 1 / 2 / 3
미체결된 벽 표시 개수: 1 / 2 / 3
```

Bid config:

```text
체결된 벽 표시 개수: 1 / 2 / 3
미체결된 벽 표시 개수: 1 / 2 / 3
```

Preference model:

```text
askPeakAllPriceRankLimit       existing, relabel to "체결된 벽 표시 개수"
bidPeakAllPriceRankLimit       existing, relabel to "체결된 벽 표시 개수"
askPeakUntradedRankLimit       new, default 1, min 1, max 3
bidPeakUntradedRankLimit       new, default 1, min 1, max 3
```

The existing key name `AllPriceRankLimit` can remain for migration simplicity even though the UI label becomes clearer. A later cleanup can rename persisted keys, but this spec should avoid unnecessary preference migration.

### Rendering

For each side/date:

1. Expand traded candidates up to the traded rank limit.
2. Expand untraded candidates up to the untraded rank limit.
3. Remove duplicate prices within each candidate family after sorting, preserving the highest ranked event for that price.
4. Render traded candidates with the existing traded style.
5. Render untraded candidates with the existing untraded style only when each untraded candidate's selected quantity is greater than the relevant traded baseline quantity.

The comparison baseline should be the lowest displayed traded threshold for that date/side, not always rank 1, so that `미체결 2위/3위` can be useful when the user also displays multiple traded ranks. If only one traded rank is displayed, this preserves the current behavior.

If there is no traded candidate for a date/side, do not render untraded candidates alone. This preserves the existing "untraded is an additional comparison line" behavior.

### Visible-Time Cutoff

If visible-time cutoff is enabled:

- Candidate events after the cutoff are excluded before classification/ranking for the cutoff date.
- Trade ticks after the cutoff are excluded from the future-touch index for the cutoff date.
- Earlier dates keep full-day values.
- Later dates are omitted.

This means a wall that appears before the cutoff but is touched only after the cutoff remains untraded in cutoff mode. That matches "as of the latest visible candle".

### Cache and Compatibility

Past-indicator cache entries may lack `untraded_peaks` arrays. The loader should treat missing arrays as legacy data:

- Continue to read single `untraded_*` fields.
- Prefer new arrays when present.
- Store new arrays on newly computed cache entries.

This keeps older cache files readable while allowing refreshed data to support rank 1-3 untraded rendering.

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| Ask same-price repeated walls split | 10:00 ask wall at 50,000 touched at 10:05; 10:20 larger ask wall at 50,000 never touched | first event appears in traded candidates, second in untraded candidates |
| Bid same-price repeated walls split | 10:00 bid wall touched later downward; 10:20 larger same-price bid wall never touched | first event traded, second untraded |
| Ask later higher tick crosses wall | ask wall at 50,000, later tick at 50,100 | candidate is traded |
| Bid later lower tick crosses wall | bid wall at 50,000, later tick at 49,900 | candidate is traded |
| Earlier tick does not classify later wall | tick at 50,000 before ask wall appears, no later touch | candidate remains untraded |
| Same millisecond inclusive touch | wall and crossing tick share `t_ms` | candidate is traded |
| Historical traded rank limit | traded candidates have 3 distinct ranked events | UI/render output can show ranks 1-3 |
| Historical untraded rank limit | untraded candidates have 3 distinct ranked events larger than baseline | UI/render output can show ranks 1-3 |
| No untraded alone | untraded candidates exist but traded candidates are empty | no untraded line is rendered |
| Untraded comparison threshold | untraded candidate qty is not larger than relevant displayed traded baseline | untraded candidate is not rendered |
| Visible cutoff excludes future touch | wall appears before cutoff, touch tick occurs after cutoff | wall remains untraded in cutoff mode |
| Visible cutoff excludes future wall | larger wall appears after cutoff | wall is absent from cutoff output |
| Legacy payload compatibility | `untraded_peaks` missing but single `untraded_*` present | rank 1 untraded still renders |
| Ask UI rank controls | open `당일 매도 최대벽` config | traded and untraded 1/2/3 controls are visible |
| Bid UI rank controls | open `당일 매수 최대벽` config | traded and untraded 1/2/3 controls are visible |
| Preference defaults | merge default prefs | traded rank defaults to 1; untraded rank defaults to 1; limits above 3 are rejected |

**Invariant regression tests**:

- Same-price events with different times can classify differently.
- Ask and bid use opposite crossing inequalities.
- Existing default rendering remains one traded line plus at most one untraded line.
- Existing style controls continue to affect the same line families.
- Visible-time cutoff still filters by event/tick time before ranking.

### Manual verification

1. Open `/live` on a stock with active hoga/trade data.
2. Enable `당일 매도 최대벽`.
3. Set `체결된 벽 표시 개수` to `3` and `미체결된 벽 표시 개수` to `3`.
4. Confirm up to three traded ask walls and up to three untraded ask walls can render with distinct styles.
5. Repeat for `당일 매수 최대벽`.
6. In a replayable or captured day where the same price gets reloaded with a later bigger wall, verify the earlier touched event and later untouched event split into different line families.
7. Enable `보이는 최신 봉 기준`; scroll before the later touch and confirm that touch does not classify the earlier wall yet.
8. Open the same saved view in `/study` and confirm rank controls and classification behavior match `/live`.

## Risks / Open questions

- Historical SQL may become heavier if it joins every orderbook level event against trade ticks naively. The implementation should use suffix max/min or equivalent windowed precomputation.
- Live state memory can grow if every observed level event is retained. The implementation should keep ranked candidates and enough event history for rank 1-3 rather than unbounded raw history where possible.
- The phrase "체결된 벽" is user-friendly but still an inference. UX copy should avoid implying order-ID-level certainty.
- The exact comparison baseline for untraded rank 2/3 may need tuning after visual QA. This spec chooses the lowest displayed traded threshold to keep multi-rank display useful.

## Out of Scope (Backlog)

- Persisted preference key migration from `AllPriceRankLimit` to a more precise `TradedRankLimit` name.
- More than three ranks.
- Tooltips explaining order-ID limitations in detail.
- A separate table/list view of all traded and untraded wall events.
