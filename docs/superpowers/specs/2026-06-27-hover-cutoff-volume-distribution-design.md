# Hover-Cutoff Volume Distribution — Design

**Date**: 2026-06-27
**Status**: Approved
**Canonical term**: 호버 시점 누적 매물대 (Hover-Cutoff Volume Distribution)
**Scope**: `hoga/api/routes.py`, `hoga/api/bundle.py`, `hoga/tables/trades.py`, `frontend/src/api/rangeRequest.ts`, `frontend/src/api/types.ts`, `frontend/src/state/livePage.ts`, `frontend/src/live/indicators/IndicatorPanel.tsx`, `frontend/src/live/continuousTradeVolumeDistribution.ts`, `frontend/src/live/LiveSidebar.tsx`, `frontend/src/studyViews/StudyReferenceDetailPanel.tsx`, `frontend/src/sidebar/VolumeDistributionCard.tsx`, related tests

## Problem

The 연속체결 매물대 분포 card currently renders the final full-day bar distribution for the selected Stock-Date. The candle chart hover time is shown only as a vertical marker on top of that final distribution.

The requested behavior is:

- Keep the close-price line graph unchanged.
- Keep the vertical hover marker.
- Add an indicator option toggle.
- When the toggle is off, keep the existing final full-day distribution behavior.
- When the toggle is on, render the bar distribution using only continuous trades up to the currently hovered candle time.
- Moving the mouse to another candle updates the bars to that candle's cumulative cutoff.
- Hovering the final candle of the day shows the same final distribution users see today.
- Apply the same behavior to `/live` and v2 `/study` **복기뷰** pages.

## Decision

Use a backend cutoff-aware sidecar query for exact historical and study behavior.

The final persisted `DayVolumeDistribution` only contains final bins and `last_trade_ms`; it does not contain the time at which each bin's volume accumulated. A frontend-only derivation from final bins would be approximate and can be wrong. Exact `/study` behavior requires re-binning from raw continuous trades with a cursor cutoff.

Terminology decision from grill-with-docs + plan-eng-review:

- **연속체결 매물대 분포** remains the parent indicator.
- **호버 시점 누적 매물대** names the optional mode where bars count only trades up to the cursor.
- Toggle off means final Stock-Date distribution.
- Toggle on means hover-cutoff cumulative distribution.

## Non-Goals

- Do not change the close graph data or trim the close line to the cursor.
- Do not change candle chart rendering.
- Do not include auction-cross trades. The distribution remains continuous-trade only: `side IN (1, -1)`.
- Do not change the existing default behavior when the new toggle is off.
- Do not add a new chart pane.
- Do not retrofit legacy **스냅샷 학습뷰** artifacts. They keep their saved/final distribution behavior because the glossary explicitly says `/study` should not repair missing legacy detail arrays from parquet during load.

## User-Facing Behavior

Add a toggle in the existing 연속체결 매물대 분포 indicator settings:

- Off: label can be concise, e.g. `호버 시점 누적` off. The card uses the existing selected-date final profile from `bundle.volume_distributions`.
- On: the card uses the current candle hover timestamp as a cutoff. Bars show only trades where `session_open <= trade_time <= hover_time`, still bounded by the Stock-Date session and price grid.

If the cursor is inactive, missing, outside a minute timeframe, or no cutoff profile is available yet, fall back to the final profile rather than blanking the card. This keeps latest-mode `/live` and initial `/study` loads useful.

## Price Grid Decision

`호버 시점 누적 매물대` cuts off counted trade quantity, not the displayed price grid. The grid remains the selected Stock-Date candle low-high range, matching the default distribution and the unchanged close graph.

Reason: changing the price grid on every cursor move would make the same price jump between rows as later highs/lows enter the cutoff. Stable rows make the visual answer legible: only bar lengths change while the user moves through time.

## API Contract

Extend `/api/range` with an optional query parameter:

```text
volume_distribution_cutoff_ms=<unix epoch ms>
```

Rules:

- The parameter only affects `volume_distributions`.
- It is ignored when `volume_distribution_bins` is absent.
- It is valid only when `from` and `to` are the same Stock-Date. A cutoff has one cursor date; applying it to a multi-day range would be ambiguous.
- It is valid in `full` and `sidecar` modes, but frontend uses it through a single-date sidecar request.
- The route validates that the value is non-negative.
- Existing callers that omit it receive the same final full-day profiles as today.

The frontend range request query key and URL must include this value so cutoff profiles do not reuse final-profile cache entries.

## Backend Data Flow

`build_volume_distribution_slice` gains an optional `cutoff_ms` argument.

The helper converts `cutoff_ms` to the same intra-day time scale used by `query_continuous_trade_volume_distribution`. The price range remains the selected Stock-Date candle low-high range. The effective trade upper bound becomes:

```text
min(session_close_ms, cutoff_intra_ms + 1)
```

Using an inclusive hover cutoff matches the user's wording: "마우스 호버 시점까지". The existing final profile still uses `< session_close_ms`.

For a hovered candle timestamp, include trades whose decoded trade time is at or before that timestamp. This means an exact trade at the hovered candle timestamp is counted, while any later trade is not. If the hovered timestamp is after the last continuous trade of the day, the cutoff profile equals the final profile.

`hoga/tables/trades.py::query_continuous_trade_volume_distribution` gains an optional cutoff or explicit upper-bound argument and continues to filter:

- `side IN (1, -1)`
- `price > 0`
- `qty > 0`
- `session_open <= intra_ms`
- `intra_ms < effective_upper_bound`
- `price BETWEEN price_min AND price_max`

The returned `last_trade_ms` reflects the last included trade, so the card can still place its x-axis endpoint consistently.

## Frontend Data Flow

Keep the existing final range bundle as the baseline.

When the new toggle is on and a minute-timeframe cursor is active:

1. Determine the active distribution date from `cursorMs`.
2. Build a sidecar range request for that single date with:
   - current stock code
   - current timeframe bucket
   - current source preference
   - current `volumeDistributionRangeCount`
   - current live day price range if needed
   - `volume_distribution_cutoff_ms=cursorMs`
   - `mode=sidecar`
3. Select the returned profile for the cursor date.
4. Pass that cutoff profile to `VolumeDistributionCard`.
5. Continue passing full-day `closePoints` for the selected date.

Do not merge cutoff profiles into the main range bundle. They are cursor-specific read models and should stay local to the detail panel selection path. The main bundle remains the final-profile baseline used when the toggle is off or the cutoff query is not ready.

For `/live` today, the same sidecar path provides exact behavior for promoted/parquet trades. To keep the live edge exact before the next promotion, merge the SSE trade tail into the cutoff profile using the existing bin grid. Include only continuous trades where `profile.last_trade_ms < trade.t_ms <= cursorMs`. The existing live SSE recompute remains a fallback for today's latest/final behavior when the cutoff toggle is off or the sidecar has not returned yet.

For v2 `/study` **복기뷰**, `StudyReferenceDetailPanel` uses the same cutoff sidecar query keyed by the saved view's code/timeframe/source inputs and the active cursor. Legacy **스냅샷 학습뷰** remains out of scope and falls back to its saved/final distribution payload.

## Rendering

`VolumeDistributionCard` does not need a new visual mode. It receives either:

- the final profile when the toggle is off, or
- the cutoff profile when the toggle is on and available.

The marker logic remains unchanged. The close graph remains full-day by continuing to use `volumeDistributionClosePoints` for the selected date, not the cutoff profile.

## Performance

Mouse movement can emit many cursor updates, so the cutoff sidecar request should be gated:

- Only request on minute timeframes.
- Only request when the toggle is on.
- Use the candle timestamp, not raw pixel position, as the query key. Existing cursor publication already snaps to candle times.
- Keep the previous cutoff profile for the same Stock-Date visible while the next cutoff query is loading. If none exists yet, show the final profile.
- Do not add a debounce until tests or manual QA show real request pressure. Debounce can make the bars feel late; candle-keyed caching is the first line of defense.

Do not precompute all cutoff distributions in the main bundle. That would make normal range loads too heavy and would spend payload on a mode that defaults off.

## Testing

Backend tests:

- `/api/range` final distribution is unchanged when `volume_distribution_cutoff_ms` is absent.
- `/api/range` rejects `volume_distribution_cutoff_ms` when `from != to`.
- A trade exactly at `volume_distribution_cutoff_ms` is included.
- A cutoff before later trades excludes those trades from bins.
- A cutoff at the final trade includes the final trade and matches the full-day profile.
- Auction-cross `side=0` rows remain excluded.

Frontend tests:

- The indicator settings store persists the new toggle.
- `buildRangeBundleRequest` includes `volume_distribution_cutoff_ms` in URL and query key.
- `/live` with toggle off passes the final profile.
- `/live` with toggle on and cursor active prefers the cutoff sidecar profile.
- v2 `/study` 복기뷰 with toggle on and cursor active prefers the cutoff sidecar profile.
- Legacy 스냅샷 학습뷰 does not issue cutoff sidecar requests.
- The close graph still receives full selected-date close points in both modes.

## Rollout Notes

Default the toggle to off so existing users see identical behavior until they opt in. This also reduces extra sidecar traffic for users who do not need the cumulative hover view.
