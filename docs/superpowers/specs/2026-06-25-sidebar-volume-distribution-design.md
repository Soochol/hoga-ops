# Sidebar Volume Distribution — Design

**Date**: 2026-06-25
**Status**: Approved
**Scope**: `hoga/api/bundle.py`, `hoga/api/models.py`, `hoga/tables/trades.py`, `frontend/src/api/types.ts`, `frontend/src/sidebar/*`, `frontend/src/live/LiveSidebar.tsx`, `frontend/src/studyViews/*`, `frontend/src/state/livePage.ts`, `frontend/src/state/liveIndicatorsPersistence.ts`, `frontend/src/live/indicators/IndicatorPanel.tsx`

## Problem

When the user hovers a candle, the sidebar already shows the orderbook and broker trajectory for that cursor context. What is missing is a compact view of that hovered day’s traded volume distribution by price range.

The requested behavior:

- On candle hover, show the hovered day’s volume distribution below the 10-level orderbook table and above the broker indicator.
- Use tick/trade data, not candle volume approximation, for the distribution.
- Support today and past days.
- Divide the hovered day’s low-high price range into configurable ranges, default 10.
- Render one horizontal bar per price range.
- Highlight the day’s maximum-volume range with a separate color.
- Show the hover time as a vertical dotted cursor line, like the broker trajectory indicator.
- Expose range count, bar color, and max bar color in the indicator settings modal.

## Invariants

- **Sidebar orderbook-broker context**: `CursorSidebar` is the shared shell for live and study detail sidebars, and its children must remain cursor-contextual. 근거: `frontend/src/sidebar/CursorSidebar.tsx`, `frontend/src/live/LiveSidebar.tsx`, `frontend/src/studyViews/StudyDetailPanel.tsx`.
- **Minute spot mode only for live parquet cursor fetches**: `/live` enters spot mode only when `cursorMs !== null` and the timeframe is minute-based; calendar frames publish cursor state for legends but do not fetch per-cursor orderbook/broker parquet. 근거: `frontend/src/live/LiveSidebar.tsx`.
- **Broker cursor marker semantics**: broker sparklines render an accent vertical dotted line only when `cursorMs` is inside the displayed day range. 근거: `frontend/src/sidebar/BrokerTrajectoryTable.tsx`.
- **Tick-based distribution**: existing volume-profile builders use `trades.parquet` for price/qty bins, while candle lows/highs define day price bounds. 근거: `hoga/api/bundle.py::build_volume_profile_slice`, `hoga/tables/trades.py::query_volume_profile`.
- **Study snapshot reproducibility**: study pages render saved detail data without live cursor fetch hooks, so any new sidebar data needed by study views must be carried in the saved snapshot or derivable from saved bundle data. 근거: `frontend/src/studyViews/StudyPage.tsx`, `frontend/src/studyViews/studySnapshotAdapter.ts`.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| Sidebar orderbook-broker context | preserves | The sidebar becomes `10호가 → 매물대 분포 → 거래원`; the new card is cursor-contextual like the adjacent cards. |
| Minute spot mode only for live parquet cursor fetches | preserves | The distribution reads bundle day profiles and live trade buffer data; it does not introduce per-cursor parquet fetches on calendar frames. |
| Broker cursor marker semantics | preserves | The new card reuses the same visible rule: show the accent dotted time marker only inside the selected day’s session/time domain. |
| Tick-based distribution | preserves | Distribution quantities come from trade ticks with `side = ±1`; candle data is used only for the low-high grid. |
| Study snapshot reproducibility | preserves | Study snapshots carry the computed day profiles and indicator settings so saved views restore without fetching live cursor data. |

## Goals

- Add a dedicated sidebar card between `10호가` and `거래원`.
- Compute day volume distribution from regular-session continuous trade ticks only (`side = ±1`).
- Use the day’s low-high price range as the price grid source.
- Support configurable range count from 5 to 30, default 10.
- Render horizontal bars with normal and max-range colors from indicator settings.
- Keep hover behavior simple: date selects the profile; time selects only the vertical dotted marker position.
- Support `/live` latest/spot behavior and `/study` saved snapshot behavior.
- Keep the implementation aligned with the existing volume-profile and broker cursor marker patterns.

## Non-Goals

- Do not add a new lightweight-charts pane.
- Do not make bars cumulative up to the hover time.
- Do not include opening/closing auction or single-price crossing trades (`side = 0`).
- Do not add a separate hover-time network request.
- Do not redesign the orderbook table or broker trajectory table.
- Do not change existing `volume_profile_by_day` semantics; this feature uses a new wire field.

## Design

### Placement

`CursorSidebar` becomes a three-card layout:

1. `10호가`
2. `매물대 분포`
3. `거래원`

The new card is not a chart pane. It lives in the same right-side/detail sidebar as `OrderbookTable`, `TotalQtyBar`, and `BrokerTrajectoryTable`.

To keep live and study parity, `CursorSidebar` should accept a new `volumeDistribution?: ReactNode` prop. `LiveSidebar` and `StudyDetailPanel` pass the new component there.

### Data model

Add a day-level wire model for the sidebar distribution. This should be separate from the existing 24-bin `volume_profile_by_day`, because the new indicator has user-configurable bin count and strict regular-session continuous-trade filtering.

Wire shape:

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
volume_distributions?: DayVolumeDistribution[];
```

Existing clients tolerate the field being absent during migration. New bundle builders populate it for each included segment.

The `/api/range` route accepts a new optional `volume_distribution_bins` query parameter. The backend validates it as an integer in `[5, 30]` and defaults to `10`. The frontend passes the current `volumeDistributionRangeCount` setting into range-bundle fetches, so changing the setting refetches/rebuilds past-day profiles at the requested granularity. Any range-bundle cache key that includes the response payload must include this parameter.

### Computation

Backend computation happens in the bundle path, not on hover. The requested bin count is the validated `volume_distribution_bins` value from the range request.

For each included stock-date:

1. Resolve source and normalized session bounds as `build_range_bundle` already does.
2. Read candle low/high for the day to establish `price_min` and `price_max`.
3. Query `trades.parquet` for rows where:
   - trade time is inside regular continuous session bounds,
   - `side IN (-1, 1)`,
   - `qty > 0`,
   - `price` is finite.
4. Divide `[price_min, price_max]` into `range_count` bins.
5. Sum `qty` by bin.
6. Fold the top-edge price into the final bin so the high price is not dropped.

If candle or trade data is missing, return a structurally valid empty profile for that date with `bins: []`. The UI shows an empty state for that day.

Today combines:

- past range bundle profiles for completed/persisted dates,
- live trade buffer recomputation for today when live SSE trades are newer than the bundle seed.

The frontend can mirror the backend binning function for today’s live buffer, but only over the already-held `live.trade` array. It must not fetch per-hover data.

### Hover selection

The chart already publishes `cursorMs` through `useLiveCursorStore`.

The distribution card derives:

- active date: `cursorMs` converted to KST date when hovering, otherwise latest available day,
- active time: `cursorMs` for the vertical marker,
- profile: matching `DayVolumeDistribution.date`.

The bars always represent the full active day profile. The marker represents only where the cursor time sits within that day.

Marker position:

```ts
cursorX = (cursorMs - session_open_ms) / (session_close_ms - session_open_ms)
```

Clamp only for rendering safety. Show the marker only when `session_open_ms <= cursorMs <= session_close_ms`.

### Rendering

Add `VolumeDistributionCard` under `frontend/src/sidebar/`.

States:

- `undefined`: loading, same copy pattern as orderbook/broker cards.
- `null` or empty `bins`: `매물대 분포 없음`.
- populated profile: render 5-30 rows.

Each row:

- left label: price range, compact Korean formatting.
- bar track: horizontal bar width normalized by max bin qty.
- right label: quantity.
- max bin: uses max bar color.
- non-max bins: use normal bar color.

The marker is an absolutely-positioned vertical dotted line over the bar region, using `var(--accent)` and a visual language matching `BrokerTrajectoryTable` (`strokeDasharray="1,1"` equivalent in CSS/SVG).

### Settings

Add a `매물대 분포` category under the indicator modal’s `호가 지표` group.

Persisted settings:

- `volumeDistributionEnabled`: boolean, default `true`.
- `volumeDistributionRangeCount`: integer, default `10`, min `5`, max `30`.
- `volumeDistributionColor`: hex, default `#334155`.
- `volumeDistributionMaxColor`: hex, default `#EAB308`.

The settings UI uses existing setting row patterns:

- master checkbox in `IndicatorPanel`,
- numeric row or stepper for range count,
- color pickers consistent with existing indicator config rows.

Study snapshots preserve these settings in `indicator_state`.

### Saved Study Views

Study snapshots should include `volume_distributions` for the saved window, filtered to the snapshot’s segments just like `trade_volume_pocs`.

`StudyDetailPanel` selects the profile by the active bucket’s segment date and passes it to `VolumeDistributionCard` with the active bucket/cursor time.

This keeps study pages deterministic and avoids calling live cursor hooks.

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| Backend filters regular continuous trades | trades include `side=-1`, `side=1`, `side=0`, outside-session rows | only `side=±1` inside session contribute to qty |
| Backend folds top-edge price | trade price equals day high | qty lands in final bin |
| Backend uses candle low/high grid | candle range differs from trade min/max | bins span candle low/high, not trade min/max |
| Range count validation | persisted values 4, 10, 31, invalid string | frontend clamps numeric input to 5-30; invalid persisted values fall back to 10; 10 is preserved |
| Range request parameter | `volumeDistributionRangeCount` changes from 10 to 20 | `/api/range` request key/URL changes and returned profiles have `range_count=20` |
| Sidebar order | render `CursorSidebar` with all three props | cards appear `card-orderbook`, `card-volume-distribution`, `card-brokers` |
| Card marker visibility | profile session 09:00-15:20, cursor inside/outside | marker appears only inside session |
| Card max color | one bin has max qty | exactly that bar uses max color |
| Live today recompute | bundle has old today profile, live trade buffer adds rows | displayed today profile reflects live buffer |
| Study snapshot restore | saved snapshot carries profile and settings | study detail renders card without live cursor fetch |

**Invariant 회귀 테스트**:

- Sidebar orderbook-broker context: `CursorSidebar` test locks the three-card order.
- Minute spot mode: `LiveSidebar` tests ensure the new card does not call cursor fetch hooks and respects minute-only spot gates already in place.
- Broker cursor marker semantics: `VolumeDistributionCard` tests mirror broker marker visibility.
- Tick-based distribution: backend table/query tests lock `side=±1` and session filtering.
- Study snapshot reproducibility: snapshot adapter/save tests include `volume_distributions` round-trip.

### Manual verification

- `/live` minute timeframe:
  - Hover a past candle and confirm the sidebar card switches to that day’s distribution.
  - Move within the same day and confirm bars remain stable while the vertical marker moves.
  - Hover outside a valid bar/right-offset whitespace and confirm the card returns to latest/default behavior consistently with the sidebar.
- `/live` today:
  - During live data, confirm today’s profile updates as live trades arrive.
  - Confirm `side=0` auction bursts do not dominate the profile.
- `/study` saved view:
  - Open a saved view with orderbook and broker details.
  - Hover candles across days and confirm the profile changes by date.
  - Confirm the marker aligns with the hovered bucket/time.
- Indicator modal:
  - Toggle the card off/on.
  - Change range count and colors.
  - Save/reopen a study view and confirm settings persist.

## Risks

- Large `range_count` values increase sidebar row density. The cap of 30 is intended to keep the card readable.
- Today live recomputation must avoid work on every mousemove; it should depend on live trade buffer/settings, not cursor position.
- Existing `volume_profile_by_day` uses 24 bins and includes `side=0`; reusing it would violate this feature’s definition, so the new field is deliberately separate.

## Out of Scope (Backlog)

- Buy/sell split bars per price range.
- Cumulative-to-cursor volume distribution.
- Tooltip details per distribution bin.
- Exporting the profile as CSV.
- Color presets beyond the existing indicator style picker pattern.
