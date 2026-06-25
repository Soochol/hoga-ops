# Sidebar Continuous Trade Volume Distribution — Design

**Date**: 2026-06-25
**Status**: Approved, hardened by grill-with-docs + plan-eng-review
**Canonical term**: 연속체결 매물대 분포 (Continuous Trade Volume Distribution)
**Scope**: `CONTEXT.md`, `hoga/api/routes.py`, `hoga/api/bundle.py`, `hoga/api/models.py`, `hoga/tables/trades.py`, `frontend/src/api/range.ts`, `frontend/src/api/types.ts`, `frontend/src/sidebar/*`, `frontend/src/live/*`, `frontend/src/state/livePage.ts`, `frontend/src/state/liveIndicatorsPersistence.ts`, `frontend/src/live/indicators/IndicatorPanel.tsx`, `frontend/src/studyViews/*`, `frontend/src/util/sessionTime.ts`

## Problem

When the user hovers a candle, the sidebar already shows the orderbook and broker trajectory for that cursor context. What is missing is a compact view of the hovered Stock-Date's traded volume distribution by price range.

The requested behavior:

- On candle hover, show the hovered day's distribution below the `10호가` table and above `거래원`.
- Use tick/trade data, not candle volume approximation.
- Support today and past days.
- Divide the hovered day's low-high price range into configurable ranges, default 10.
- Render one horizontal bar per price range.
- Highlight the day's maximum-volume range with a separate color.
- Show the hover time as a vertical dotted cursor line, like the broker trajectory indicator.
- Expose range count, bar color, and max bar color in the indicator settings modal.

## Domain Decision

Do not call this a "regular-session volume profile" in code or docs. `CONTEXT.md` defines **Regular Session** as continuous trading plus the closing auction band, and existing `VolumeProfile` queries intentionally include Auction Cross rows (`side=0`). This feature is narrower:

- It counts only continuous-trading trade ticks: `side IN (1, -1)`.
- It excludes Auction Cross / single-price rows: `side = 0`.
- It uses the Stock-Date candle low-high grid for price ranges.
- Hover date selects the full-day profile; hover time is only a visual marker.

## Invariants

- **Sidebar orderbook-broker context**: `CursorSidebar` is the shared shell for live and study detail sidebars, and its children must remain cursor-contextual. The order becomes `10호가 -> 연속체결 매물대 분포 -> 거래원`.
- **No per-hover network fetch**: the distribution is precomputed in the range bundle or recomputed from live buffers. Moving the mouse inside the same day moves only the marker.
- **Tick-based distribution**: quantities come from `trades.parquet` continuous trades (`side=±1`), not from candle volume and not from existing all-side `volume_profile_by_day`.
- **Session-time source of truth**: frontend marker visibility and tests use per-segment session bounds and `frontend/src/util/sessionTime.ts`; no fixed 09:00/15:30 assumptions.
- **Study snapshot reproducibility**: saved study pages must carry the profiles and settings needed to restore the sidebar without live SSE or cursor parquet fetches.

## Goals

- Add a dedicated sidebar card between `10호가` and `거래원`.
- Compute distribution from continuous trade ticks only (`side=±1`) inside each Stock-Date's regular session bounds.
- Use the day's candle low-high price range as the price grid source.
- Support configurable range count from 5 to 30, default 10 in the indicator settings.
- Render horizontal bars with normal and max-range colors from indicator settings.
- Keep hover behavior simple: date selects the profile; time selects only the vertical dotted marker position.
- Support `/live` latest/spot behavior and `/study` saved snapshot behavior.
- Keep implementation aligned with existing volume-profile expansion and broker cursor marker patterns while preserving their current semantics.

## Non-Goals

- Do not add a new lightweight-charts pane.
- Do not make bars cumulative up to the hover time.
- Do not include opening/closing auction or single-price crossing trades (`side=0`).
- Do not add a separate hover-time network request.
- Do not redesign the orderbook table or broker trajectory table.
- Do not change existing `volume_profile_by_day` semantics.

## Existing Code Constraints

- `hoga/tables/trades.py::query_volume_profile` and `query_volume_profile_range` have no `side` filter and include `side=0`; do not reuse them directly for this feature.
- `hoga/tables/trades.py::query_trade_volume_poc` already demonstrates the correct continuous-trade filter shape: `side IN (1, -1)`, `qty > 0`, `price > 0`, session bounds.
- `frontend/src/sidebar/BrokerTrajectoryTable.tsx` already has the vertical dotted marker visual language (`data-testid="cursor-marker"`, accent stroke, dotted pattern).
- `frontend/src/api/range.ts::useRange` query key and URL must include any new response-shaping parameter.
- Study snapshot restore goes through `StudySnapshotBundle`, `buildStudySnapshotRequest`, and `studySnapshotBundleToRangeBundle`; all three must round-trip the new field.

## Data Flow

```text
settings(rangeCount, enabled)
        |
        v
useRange(..., volume_distribution_bins?) -----> /api/range
        |                                          |
        |                                          v
        |                              build_range_bundle
        |                                          |
        |                              dedicated continuous-trade query
        |                                          |
        v                                          v
RangeBundle.volume_distributions          DayVolumeDistribution[]
        |
        +--> LiveSidebar / StudyDetailPanel
                |
                v
        VolumeDistributionCard
                |
                +--> bars = full hovered Stock-Date
                +--> marker = hovered time within that Stock-Date
```

## Data Model

Add a day-level wire model for the sidebar distribution. It is separate from the existing 24-bin `volume_profile_by_day` because this indicator has user-configurable bin count and strict continuous-trade filtering.

```ts
type VolumeDistributionBin = {
  price_low: number;
  price_high: number;
  qty: number;
};

type DayVolumeDistribution = {
  date: string;
  range_count: number;
  price_min: number;
  price_max: number;
  session_open_ms: number;
  session_close_ms: number;
  bins: VolumeDistributionBin[];
};
```

Python mirrors this with Pydantic models in `hoga/api/models.py`.

`RangeBundle` adds:

```ts
volume_distributions: DayVolumeDistribution[];
```

Default is `[]` so existing clients are unaffected.

## Range API Contract

`/api/range` accepts a new optional `volume_distribution_bins` query parameter.

- Absent: skip this computation and return `volume_distributions: []`.
- Present: validate integer in `[5, 30]`; build profiles at that range count.
- Invalid: HTTP 400/422 following existing route validation style.

This keeps the new indicator from adding trade scans to callers that do not display the sidebar card. The frontend passes the setting only when `volumeDistributionEnabled` is true, with default value 10.

Any range-bundle cache key that includes the response payload must include this parameter. In practice, update `frontend/src/api/range.ts::useRange` query key and URL so changing 10 -> 20 triggers a refetch and does not reuse stale 10-row profiles.

## Backend Computation

Add a dedicated table helper, not a change to existing volume-profile helpers:

```text
query_continuous_trade_volume_distribution(
  path,
  price_lo,
  price_hi,
  range_count,
  session_open_ms,
  session_close_ms
)
```

Rules per included Stock-Date:

1. Resolve source and normalized session bounds the same way `build_range_bundle` resolves `RangeSegment`.
2. Read candle low/high for the day to establish `price_min` and `price_max`.
3. If candles or `trades.parquet` are missing, return no profile for that date.
4. Query trades where:
   - decoded intra-day time is `>= session_open_ms` and `< session_close_ms`,
   - `side IN (1, -1)`,
   - `qty > 0`,
   - `price > 0`,
   - price is inside `[price_min, price_max]`.
5. Divide `[price_min, price_max]` into `range_count` bins.
6. Fold the top edge into the final bin so a trade exactly at the candle high is never dropped.
7. Return dense bins, including zero-qty bins, so the UI always renders exactly `range_count` rows.

For a zero-width day (`price_min == price_max`), floor `bin_width` to 1.0 like existing volume-profile code; all matching volume lands in the first/top matching range while the remaining rows stay zero. This is rare but avoids divide-by-zero failures on limit-lock days.

## Today Live Recompute

Today combines:

- persisted past range bundle profiles, including any promoted today profile,
- live SSE trade-buffer recomputation when today's live trades are newer than the bundle seed.

Add a pure frontend helper that mirrors backend binning:

```text
computeContinuousTradeVolumeDistribution(candlesForDate, liveTrades, rangeCount, segment)
```

Important constraints:

- Price grid for today comes from the displayed KIS/live-overlaid candles for that Stock-Date, so the card matches what the user sees on the chart.
- Quantity comes from continuous live trades only (`side=±1`, `qty>0`), matching backend semantics.
- Recompute dependencies are live trade buffer, displayed candles/segments, and range count. Do not recompute on `cursorMs` changes.
- If live data is missing, use the persisted bundle profile.

## Sidebar Rendering

`CursorSidebar` accepts a new `volumeDistribution?: ReactNode` prop and renders:

1. `10호가`
2. `연속체결 매물대 분포`
3. `거래원`

Layout must avoid hiding the broker card below the fold. The orderbook keeps its table and `TotalQtyBar`; the new card gets a compact fixed/minmax row; broker trajectory remains visible and scrollable if needed. Add a layout test or Playwright check for the three-card order and no overlap at desktop and narrow sidebar widths.

`VolumeDistributionCard` states:

- `undefined`: loading, matching existing sidebar loading copy tone.
- `null` or empty `bins`: `매물대 분포 없음`.
- populated profile: render 5-30 rows, high price at the top and low price at the bottom.

Each row:

- price range label,
- horizontal bar normalized by max bin qty,
- quantity label,
- max bin uses max color,
- non-max bins use normal color.

The marker is an absolutely positioned vertical dotted line over the bar region using the same accent visual language as `BrokerTrajectoryTable`. It does not affect bar quantities.

## Hover Selection And Marker

The chart already publishes `cursorMs` through `useLiveCursorStore`.

The distribution card derives:

- active date: `cursorMs` converted to KST Stock-Date when hovering, otherwise latest available day,
- active time: `cursorMs`,
- profile: `DayVolumeDistribution.date === active date`.

Bars always represent the full active day profile.

Marker position:

```ts
cursorX = (cursorMs - session_open_ms) / (session_close_ms - session_open_ms);
```

Render the marker only when:

- `cursorMs` belongs to the selected Stock-Date/segment,
- `session_open_ms <= cursorMs <= session_close_ms`,
- the segment exists.

Use per-profile/per-segment bounds and `sessionTime` helpers for tests. Do not hard-code full-day close times; half-day sessions must work if the segment says close is earlier.

## Settings

Add `연속체결 매물대 분포` under the indicator modal's hoga/sidebar indicator group.

Persisted settings:

- `volumeDistributionEnabled`: boolean, default `true`.
- `volumeDistributionRangeCount`: integer, default `10`, min `5`, max `30`.
- `volumeDistributionColor`: hex, default `#64748B`.
- `volumeDistributionMaxColor`: hex, default `#EAB308`.

The settings UI uses existing setting row patterns:

- master checkbox in `IndicatorPanel`,
- numeric row or stepper for range count,
- color pickers consistent with existing indicator config rows.

When disabled, `useRange` should omit `volume_distribution_bins` so the backend returns `volume_distributions: []`.

Study snapshots preserve these settings in `indicator_state`.

## Saved Study Views

Study snapshots include `volume_distributions` for the saved window, filtered to the snapshot's segments just like `trade_volume_pocs`.

Required model/adapter touchpoints:

- Python `StudyIndicatorState`: add the four persisted settings.
- Python `StudySnapshotBundle`: add `volume_distributions: list[DayVolumeDistribution] = []`.
- TypeScript study-view API types: mirror both fields.
- `buildStudySnapshotRequest`: filter `args.bundle.volume_distributions` by saved segment dates.
- `studySnapshotBundleToRangeBundle`: restore `volume_distributions` onto the reconstructed `RangeBundle`.
- `StudyDetailPanel`: select the profile by active bucket/segment date and pass active time to the card.

This keeps study pages deterministic and avoids calling live cursor hooks.

## Test Plan

### Backend

| Case | Expected |
|------|----------|
| Dedicated query filters rows with `side=-1`, `side=1`, `side=0`, outside-session rows | only `side=±1` inside session contribute to qty |
| Existing `query_volume_profile` remains unchanged | old volume-profile tests still include `side=0` where applicable |
| Trade exactly at candle high | qty lands in final bin |
| Candle range differs from trade min/max | bins span candle low/high, not trade min/max |
| `price_min == price_max` | no divide-by-zero; dense rows returned |
| `/api/range` omits parameter | response has `volume_distributions: []` and does not call the new query |
| `/api/range?volume_distribution_bins=10` | profiles are returned with `range_count=10` |
| `/api/range?volume_distribution_bins=4/31/bad` | validation rejects the request |

### Frontend Unit

| Case | Expected |
|------|----------|
| Range count changes from 10 to 20 | `useRange` query key and URL change |
| Indicator disabled | `useRange` omits `volume_distribution_bins` |
| `CursorSidebar` renders all three props | order is `card-orderbook`, `card-volume-distribution`, `card-brokers` |
| Card marker inside/outside session | marker appears only inside profile session bounds |
| Half-day segment close | marker math uses segment close, not fixed 15:30 |
| Max bin | exactly that bar uses max color |
| Empty bins | card shows `매물대 분포 없음` |
| Today live recompute | displayed today profile reflects live continuous trades and ignores cursor-only movement |
| Study snapshot restore | restored range bundle includes profile and settings without live fetch |

### Manual Verification

- `/live` minute timeframe:
  - Hover a past candle and confirm the sidebar card switches to that day's distribution.
  - Move within the same day and confirm bars remain stable while the vertical marker moves.
  - Hover outside a valid bar/right-offset whitespace and confirm latest/default behavior is consistent with the existing sidebar.
- `/live` today:
  - During live data, confirm today's profile updates as live trades arrive.
  - Confirm `side=0` auction bursts do not dominate the profile.
- `/study` saved view:
  - Open a saved view with orderbook and broker details.
  - Hover candles across days and confirm the profile changes by date.
  - Confirm the marker aligns with the hovered bucket/time.
- Indicator modal:
  - Toggle the card off/on.
  - Change range count and colors.
  - Save/reopen a study view and confirm settings persist.

## Risks And Mitigations

- **Extra backend scan cost**: make `volume_distribution_bins` opt-in. Only the enabled sidebar asks for it.
- **Semantic collision with existing VolumeProfile**: use a new field and a dedicated continuous-trade query.
- **Mousemove performance**: memoize by live trades, candles, segment, and range count; cursor changes only move the marker.
- **Sidebar crowding**: use a compact row allocation and verify `10호가`, distribution, and broker card all remain reachable.
- **Study drift**: update all Python and TypeScript snapshot contracts in the same implementation.

## Grill / Eng Review Questions Applied

| Question | Decision applied |
|----------|------------------|
| Does "정규장체결" conflict with `Regular Session` docs? | Yes. Canonical term is `연속체결 매물대 분포`; count only `side=±1`, exclude `side=0`. |
| Can existing `volume_profile_by_day` be reused? | No. It includes auction crosses by design; add a dedicated query and wire field. |
| Should `/api/range` compute this by default? | No. Query parameter is opt-in to avoid hidden cost for other callers. |
| How does today choose low/high? | Use displayed today candles for the price grid, live continuous trades for quantity. |
| How should marker timing handle half-days? | Use segment/profile session bounds and `sessionTime` helpers, never fixed times. |
| What must study snapshots preserve? | Settings plus `volume_distributions` round-trip through Python and TypeScript snapshot models. |

## Out Of Scope (Backlog)

- Buy/sell split bars per price range.
- Cumulative-to-cursor volume distribution.
- Tooltip details per distribution bin.
- Exporting the profile as CSV.
- Color presets beyond the existing indicator style picker pattern.

## GSTACK REVIEW REPORT

| Run | Status | Findings |
|-----|--------|----------|
| grill-with-docs | Applied | Resolved terminology conflict with `Regular Session` and added a domain term. |
| plan-eng-review: Architecture | Applied | Split new continuous-trade distribution from existing all-side volume profile; made range API opt-in. |
| plan-eng-review: Code Quality | Applied | Named exact model, route, query, settings, and snapshot seams to avoid partial implementation drift. |
| plan-eng-review: Tests | Applied | Added backend, frontend, half-day marker, live recompute, and study round-trip tests. |
| plan-eng-review: Performance | Applied | Avoided default backend scans and required cursor-independent memoization. |

VERDICT: READY FOR IMPLEMENTATION

NO UNRESOLVED DECISIONS
