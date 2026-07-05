# Event-Based Peak Wall Classification — Design

**Date**: 2026-07-05
**Status**: Draft
**Scope**: `hoga/tables/snapshots.py`, `hoga/live/ask_peak_state.py`, `hoga/api/models.py`, `hoga/api/bundle.py`, `frontend/src/api/types.ts`, `frontend/src/state/chartPrefs.ts`, `frontend/src/live/indicators/AskPeakConfig.tsx`, `frontend/src/live/indicators/BidPeakConfig.tsx`, `frontend/src/live/useDayAskPeaks.ts`, `frontend/src/live/useDayBidPeaks.ts`, `frontend/src/live/LiveAskPeakSegments.tsx`, `frontend/src/live/LiveBidPeakSegments.tsx`, related tests

**Related**: ADR-0084

## Problem

The `당일 매도 최대벽` and `당일 매수 최대벽` indicators currently classify a wall by whether its price has traded during the day. That price-level rule cannot distinguish repeated walls at the same price.

User example:

```text
10:00  50,000원 매도벽 100,000주 발생
10:05  50,000원 체결
=> this wall should be classified as post-touch

10:20  50,000원 매도벽 200,000주 발생
after 10:20, 50,000원 is never touched again
=> this wall should be classified as post-untouched
```

The current price-level rule treats the second wall as traded because `50,000원` traded earlier in the day. The desired behavior is event-level classification: a wall is **사후터치 (post-touch)** only if tick trades touch or cross that wall after the wall appears.

The UI also needs separate rank limits for post-touch and **사후미터치 (post-untouched)** walls. Today, post-touch walls can be shown as rank 1-3, while post-untouched walls are effectively limited to one extra line. The desired UI is rank 1-3 for both post-touch and post-untouched walls, for both ask and bid indicators.

## Invariants

- **Peak wall indicators are minute/hoga indicators**: Ask/bid peak wall overlays are driven by orderbook snapshots and trade ticks, not calendar candles alone. 근거: `frontend/src/live/LiveAskPeakSegments.tsx`, `frontend/src/live/LiveBidPeakSegments.tsx`.
- **Ask and bid behavior is symmetric but side-aware**: Ask walls trade when later ticks touch/cross upward; bid walls trade when later ticks touch/cross downward. 근거: existing separate ask/bid peak modules and user-confirmed requirement.
- **Same-price wall events remain distinguishable by time**: Two wall candidates with the same side and price but different `t_ms` can have different post-touch/post-untouched classifications. 근거: user example.
- **No order identity is inferred**: The system cannot prove that the exact visible order quantity was filled; it can only infer that later ticks reached the wall price. 근거: trade tick/orderbook data lacks order IDs.
- **Touch ticks are continuous-trading ticks**: Auction Cross / single-price rows (`side = 0`) do not classify a wall as post-touch. 근거: `CONTEXT.md` excludes Auction Cross rows from hoga-derived continuous-trading readouts.
- **Default rank limits preserve bounded visual density**: Existing users should start with rank 1 for post-touch and rank 1 for post-untouched unless they opt into more ranks. 근거: existing rank defaults plus new post-untouched rank defaults.
- **Post-touch and post-untouched ranks are independent categories**: A post-untouched wall does not need to be larger than a post-touch wall to appear; the user's requested "각각 1-3순위" means each classification family ranks its own candidates. 근거: user-confirmed UI requirement.
- **Visible-time cutoff remains candidate-time based**: If `보이는 최신 봉 기준` is enabled, candidates after the rightmost visible candle must not affect either post-touch or post-untouched rank selection. 근거: `2026-07-04-peak-wall-visible-time-cutoff-design.md`.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| Peak wall indicators are minute/hoga indicators | preserves | The new classifier still uses orderbook candidates plus trade ticks. |
| Ask and bid behavior is symmetric but side-aware | preserves | Ask uses later `trade.price >= wall.price`; bid uses later `trade.price <= wall.price`. |
| Same-price wall events remain distinguishable by time | intentionally changes current behavior | This is the core requested behavior change: same price no longer implies same classification. |
| No order identity is inferred | preserves | Labels and docs should describe "touched after wall appeared", not exact order fill. |
| Touch ticks are continuous-trading ticks | preserves | The touch index filters to `side IN (1, -1)` and excludes `side = 0` auction rows. |
| Default rank limits preserve bounded visual density | preserves | New post-untouched rank prefs default to `1`; existing post-touch rank prefs keep default `1`. |
| Post-touch and post-untouched ranks are independent categories | intentionally changes current behavior | The old "only if larger than baseline" rule made sense for a single comparison line; it conflicts with separate 1-3 rankings. |
| Visible-time cutoff remains candidate-time based | preserves | Cutoff filtering occurs before event classification/ranking output for the cutoff date. |

The same-price behavior is intentionally changed because the old price-level rule contradicts the user's trading interpretation. The new event-level rule matches the user's mental model while staying honest about what tick data can prove.

## Goals

- Classify ask/bid peak wall candidates by event time, not by whole-day price membership.
- Use tick trade data to decide whether a wall was later touched or crossed.
- Distinguish repeated walls at the same price when they occur at different times.
- Apply the rule to both historical `/api/range` peak calculations and today's live peak state.
- Apply the rule symmetrically to `당일 매도 최대벽` and `당일 매수 최대벽`.
- Add UI controls so post-touch walls and post-untouched walls can each display rank 1, 2, or 3.
- Preserve defaults: post-touch rank limit `1`, post-untouched rank limit `1`.
- Keep existing style controls: post-touch and post-untouched lines still use their current separate colors/widths.
- Preserve `/live` and `/study` shared behavior through existing `LiveChartRoot`/indicator paths.

## Non-Goals

- Do not infer exact order fill identity or partial fill quantity.
- Do not add a new backend request that recalculates peak walls on every viewport change.
- Do not change the meaning of orderbook continuity/session filtering.
- Do not change candle OHLC calculation.
- Do not change the current line colors or default line widths.
- Do not compare post-touch and post-untouched ranks as if one is only an annotation of the other.
- Do not add rank limits above 3.

## Design

### Event Definition

A wall candidate is an event:

```text
side: ask | bid
price: number
qty: number
t_ms: number
seq: number | null
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

Use continuous-trading trade ticks (`side IN (1, -1)`) after the wall appears:

```text
Ask wall at price P, time T:
  post-touch if any later trade tick has trade.price >= P and trade.t_ms >= T

Bid wall at price P, time T:
  post-touch if any later trade tick has trade.price <= P and trade.t_ms >= T
```

The comparison is inclusive on price. Time ordering should use the most precise event order available:

```text
Historical parquet:
  tick is later when (trade.ts_ms, trade.seq) >= (wall.ts_ms, wall.seq)

Live buffer:
  if both sides expose seq, use (t_ms, seq)
  otherwise fall back to trade.t_ms >= wall.t_ms
```

The fallback is intentionally inclusive on `t_ms` because live buffers may not expose source sequence numbers at the frontend seam. Historical captured data has `seq` on both orderbook and trade rows, so same-millisecond rows should not be treated as simultaneous when `seq` can distinguish their order.

Auction Cross / single-price rows (`side = 0`) never classify a wall as post-touch, even if their price crosses the wall. This keeps the indicator aligned with other hoga-derived continuous-trading readouts.

All candidates that fail the side-specific touch rule are post-untouched candidates.

The UI may say "체결된 벽" for readability, but the canonical domain term is **사후터치 최대벽**: touched or crossed by later tick trades, not exact order fill. Likewise, "미체결된 벽" maps to **사후미터치 최대벽**.

### Historical Calculation

Historical peak queries should stop using `price IN traded_prices` and `price > day_high` / `price < day_low` as the primary classifier. Instead:

1. Build eligible orderbook wall events for ask and bid.
2. Build a tick-derived future-touch index from the day's trade ticks.
3. Classify each event as post-touch or post-untouched using the side-specific touch rule.
4. Rank post-touch candidates by `qty DESC, t_ms ASC, seq ASC, price ASC`.
5. Rank post-untouched candidates by `qty DESC, t_ms ASC, seq ASC, price ASC`.
6. Return enough candidates for rendering rank 1-3 for both close-representative and intra-bar max modes.

For performance, avoid scanning all future ticks per candidate. Use a time-indexed suffix structure:

```text
For ask:
  suffix maximum trade price from each tick index onward
  event is post-touch if suffixMaxAfter(event.t_ms, event.seq) >= event.price

For bid:
  suffix minimum trade price from each tick index onward
  event is post-touch if suffixMinAfter(event.t_ms, event.seq) <= event.price
```

In SQL/DuckDB, this can be expressed with window functions over trade ticks or with a precomputed tick table joined by time bucket/index. The implementation plan should choose the simplest query that remains fast on captured day files.

### Today Live Calculation

Today live state should mirror the historical semantics:

1. Ingest trade ticks in time order.
2. Ingest eligible orderbook snapshots in time order.
3. Store wall events by side, price, qty, and `t_ms`; do not replace an older same-price event merely because a later same-price event appears.
4. Classify candidates using trade ticks at or after each event time.
5. Publish ranked post-touch and post-untouched candidate arrays for ask and bid.

The live path may update a candidate's classification when a later tick arrives. Example:

```text
10:20 ask wall 50,000원 / 200,000주 appears
10:21 no touch yet -> post-untouched candidate
10:25 tick trades 50,000원 -> same event moves to post-touch candidates
```

This dynamic movement is expected and should be reflected in `/live`.

### API and Wire Shape

Keep existing wire field names for compatibility even though the canonical domain terms change:

```text
traded_*    legacy wire name for post-touch candidates
untraded_*  legacy wire name for post-untouched candidates
all_*       legacy all-candidate support field
```

Do not rename existing persisted fields in this change. API models, past-indicator cache files, frontend types, and tests already depend on these names. Implementation comments should say "legacy wire name; domain term is post-touch/post-untouched" at the model boundary.

The frontend already has candidate arrays:

```text
traded_peaks
traded_max_peaks
all_peaks
all_max_peaks
untraded_* single fields
```

The desired shape should support ranked post-untouched candidates directly. Add arrays rather than overloading single legacy `untraded_*` fields:

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
askPeakAllPriceRankLimit       existing, relabel to "체결된 벽 표시 개수" (domain: post-touch)
bidPeakAllPriceRankLimit       existing, relabel to "체결된 벽 표시 개수" (domain: post-touch)
askPeakUntradedRankLimit       new, default 1, min 1, max 3
bidPeakUntradedRankLimit       new, default 1, min 1, max 3
```

The existing key name `AllPriceRankLimit` can remain for migration simplicity even though the UI label becomes clearer. A later cleanup can rename persisted keys, but this spec should avoid unnecessary preference migration.

### Rendering

For each side/date:

1. Expand post-touch candidates up to the post-touch rank limit.
2. Expand post-untouched candidates up to the post-untouched rank limit.
3. Remove duplicate prices within each candidate family after sorting, preserving the highest ranked event for that price.
4. Render post-touch candidates with the existing baseline style.
5. Render post-untouched candidates with the existing secondary style.

The two families rank independently. A post-untouched rank 1 line can render even when its quantity is smaller than post-touch rank 1, because the user is asking two different questions: "which walls were later touched?" and "which walls remained untouched after appearing?"

If there is no post-touch candidate for a date/side, post-untouched candidates may still render. This is expected in early-day or cutoff views where no wall has been touched yet.

### Visible-Time Cutoff

If visible-time cutoff is enabled:

- Candidate events after the cutoff are excluded before classification/ranking for the cutoff date.
- Trade ticks after the cutoff are excluded from the future-touch index for the cutoff date.
- Earlier dates keep full-day values.
- Later dates are omitted.

This means a wall that appears before the cutoff but is touched only after the cutoff remains post-untouched in cutoff mode. That matches "as of the latest visible candle".

### Cache and Compatibility

Past-indicator cache entries may lack `untraded_peaks` arrays. The loader should treat missing arrays as legacy data:

- Continue to read single `untraded_*` fields.
- Prefer new arrays when present.
- Store new arrays on newly computed cache entries.

This keeps older cache files readable while allowing refreshed data to support rank 1-3 post-untouched rendering.

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| Ask same-price repeated walls split | 10:00 ask wall at 50,000 touched at 10:05; 10:20 larger ask wall at 50,000 never touched | first event appears in post-touch candidates, second in post-untouched candidates |
| Bid same-price repeated walls split | 10:00 bid wall touched later downward; 10:20 larger same-price bid wall never touched | first event is post-touch, second is post-untouched |
| Ask later higher tick crosses wall | ask wall at 50,000, later tick at 50,100 | candidate is post-touch |
| Bid later lower tick crosses wall | bid wall at 50,000, later tick at 49,900 | candidate is post-touch |
| Earlier tick does not classify later wall | tick at 50,000 before ask wall appears, no later touch | candidate remains post-untouched |
| Same millisecond seq ordering | wall and crossing tick share `t_ms`, tick has later/equal `seq` | candidate is post-touch |
| Same millisecond earlier tick | wall and crossing tick share `t_ms`, tick has lower `seq` | candidate remains post-untouched |
| Auction cross does not touch | wall appears before a `side = 0` crossing row, no later continuous tick crosses | candidate remains post-untouched |
| Historical post-touch rank limit | post-touch candidates have 3 distinct ranked events | UI/render output can show ranks 1-3 |
| Historical post-untouched rank limit | post-untouched candidates have 3 distinct ranked events | UI/render output can show ranks 1-3 |
| Post-untouched without post-touch | post-untouched candidates exist but post-touch candidates are empty | post-untouched ranks still render |
| Smaller post-untouched rank | post-untouched candidate qty is smaller than post-touch rank 1 | post-untouched candidate still renders if within its rank limit |
| Visible cutoff excludes future touch | wall appears before cutoff, touch tick occurs after cutoff | wall remains post-untouched in cutoff mode |
| Visible cutoff excludes future wall | larger wall appears after cutoff | wall is absent from cutoff output |
| Legacy payload compatibility | `untraded_peaks` missing but single `untraded_*` present | rank 1 post-untouched still renders |
| Ask UI rank controls | open `당일 매도 최대벽` config | post-touch and post-untouched 1/2/3 controls are visible |
| Bid UI rank controls | open `당일 매수 최대벽` config | post-touch and post-untouched 1/2/3 controls are visible |
| Preference defaults | merge default prefs | post-touch rank defaults to 1; post-untouched rank defaults to 1; limits above 3 are rejected |

**Invariant regression tests**:

- Same-price events with different times can classify differently.
- Ask and bid use opposite crossing inequalities.
- Existing default rendering remains bounded to one post-touch line plus one post-untouched line per side/date.
- Existing style controls continue to affect the same line families.
- Visible-time cutoff still filters by event/tick time before ranking.
- Auction Cross / single-price ticks do not classify post-touch candidates.

### Manual verification

1. Open `/live` on a stock with active hoga/trade data.
2. Enable `당일 매도 최대벽`.
3. Set `체결된 벽 표시 개수` to `3` and `미체결된 벽 표시 개수` to `3`.
4. Confirm up to three post-touch ask walls and up to three post-untouched ask walls can render with distinct styles.
5. Repeat for `당일 매수 최대벽`.
6. In a replayable or captured day where the same price gets reloaded with a later bigger wall, verify the earlier touched event and later untouched event split into different line families.
7. Enable `보이는 최신 봉 기준`; scroll before the later touch and confirm that touch does not classify the earlier wall yet.
8. Open the same saved view in `/study` and confirm rank controls and classification behavior match `/live`.

## Risks / Open questions

- Historical SQL may become heavier if it joins every orderbook level event against trade ticks naively. The implementation should use suffix max/min or equivalent windowed precomputation.
- Live state memory can grow if every observed level event is retained. The implementation should keep ranked candidates and enough event history for rank 1-3 rather than unbounded raw history where possible.
- The phrase "체결된 벽" is user-friendly but still an inference. UX copy should avoid implying order-ID-level certainty and specs/docs should prefer "사후터치".
- Showing post-untouched ranks independently may add more secondary lines than the old comparison-only rule. The rank limit defaults keep this bounded, and users can disable the post-untouched family with the existing show toggle.

## Out of Scope (Backlog)

- Persisted preference key migration from `AllPriceRankLimit` to a more precise `TradedRankLimit` name.
- More than three ranks.
- Tooltips explaining order-ID limitations in detail.
- A separate table/list view of all post-touch and post-untouched wall events.
