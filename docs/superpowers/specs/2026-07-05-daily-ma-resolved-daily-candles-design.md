# Daily MA Resolved Daily Candles Design

## Problem

`일봉 이동평균선 (Daily MA)` is a self-contained price-line overlay that projects daily close SMA values onto minute charts. It currently reads only `GET /api/live/past-daily-candles` through `useLivePastDailyCandles`.

When `KIS API 우회` is ON, the backend intentionally skips KIS REST calls and serves `/past-daily-candles` from the in-memory Live Candle Backfill cache only. If that memory cache is cold or does not cover the Daily MA lookback window, the endpoint returns an empty or partial `candles` array with `kis_rest_bypassed` warnings. The chart body can still render stored candles through existing `/api/range` or screener daily fallback paths, but Daily MA has no equivalent fallback, so the line disappears on both `/live` and `/study` minute charts.

The issue is not the Daily MA enabled toggle and not the hidden flag fixed in PR #412. The remaining failure is a data-resolution mismatch: chart candles and Daily MA daily candles use different recovery policies under KIS REST bypass.

## Goals

- Keep Daily MA visible on minute charts during KIS REST bypass whenever stored daily data exists.
- Preserve ADR-0073: Daily MA remains a self-contained overlay outside `useLiveBundle`.
- Preserve ADR-0048: `/api/live/past-daily-candles` remains the KIS daily Live Candle Backfill wire, with memory-only cache semantics.
- Apply the same behavior to `/live` and `/study` through their shared `LiveChartRoot -> DailyMovingAverageOverlay` path.
- Concentrate fallback policy in one deep Module so future Daily MA bugs are not split across overlay, live bundle, and study bundle callers.

## Non-Goals

- Do not move Daily MA into `useLiveBundle`.
- Do not change `/api/live/past-daily-candles` to silently mix screener daily rows into its response.
- Do not persist Live Candle Backfill daily cache to disk.
- Do not add per-study-view saved Daily MA settings.
- Do not change current Timeframe moving averages or screener `ma` scan semantics.

## Recommended Architecture

Add a frontend Module named `useResolvedDailyCandles`.

Suggested path:

```text
frontend/src/live/indicators/useResolvedDailyCandles.ts
```

Its Interface should be small and specific:

```ts
type UseResolvedDailyCandlesInput = {
  code: string | null;
  from: string | null;
  to: string | null;
  venue: LiveVenueOption;
  enabled: boolean;
};

type ResolvedDailyCandleSource = 'kis_daily' | 'screener_daily';

type ResolvedDailyWarning =
  | LivePastDailyCandlesWarning
  | { batch: string; reason: string; msg: string };

type UseResolvedDailyCandlesResult = {
  candles: LivePastDailyCandle[];
  dataWarnings: ResolvedDailyWarning[];
  isLoading: boolean;
  error: unknown;
  sourceByDate: Map<string, ResolvedDailyCandleSource>;
};
```

The Module has two internal adapters:

- KIS daily adapter: `useLivePastDailyCandles`
- Stored daily adapter: `useScreenerDailyCandles`

The external seam is the resolved daily candle sequence. Callers should not need to know whether KIS REST was bypassed, whether the memory cache was cold, or whether the stored screener corpus filled a gap.

## Resolution Policy

`useResolvedDailyCandles` always requests the KIS daily adapter when enabled. It also requests the screener daily adapter when enabled because Daily MA needs a stable fallback path, and screener daily data is small.

Merge by KST trading date:

1. Start with screener daily candles for the requested `[from, to]`.
2. Overlay KIS daily candles by date when present.
3. Sort by `t_ms` ascending.
4. Return `sourceByDate` so tests and future diagnostics can prove which adapter supplied each date.

This makes KIS daily the preferred source when available and makes stored daily data the fallback when KIS daily is absent due to bypass, rate limit, API failure, or cold memory cache.

The Module should not infer `todayLiveClose`. That remains in `DailyMovingAverageOverlay`, because the override depends on the currently rendered minute bundle. The resolved daily candles are the historical daily base series; the overlay still owns the today-in-progress close proxy.

## Data Flow

Current:

```text
DailyMovingAverageOverlay
  -> useLivePastDailyCandles
  -> /api/live/past-daily-candles
  -> memory cache only during KIS REST bypass
```

Proposed:

```text
DailyMovingAverageOverlay
  -> useResolvedDailyCandles
       -> useLivePastDailyCandles
       -> useScreenerDailyCandles
       -> date-keyed merge
  -> computeDailyMaByDate
  -> minute-axis projection
```

`/live` and `/study` both use `LiveChartRoot`, and both mount `DailyMovingAverageOverlay` with the same `code`, `timeframe`, `venue`, and `todayKst` shape. No route-specific overlay fork is needed.

## Why Frontend Resolution, Not Backend Mixing

Backend mixing would make `/api/live/past-daily-candles` look complete even when it did not come from Live Candle Backfill. That weakens ADR-0048's Interface: callers could no longer interpret `cached_batches`, `fresh_batches`, and `data_warnings` as KIS daily backfill metadata.

Frontend resolution keeps the seams honest:

- `/past-daily-candles` remains the KIS daily backfill Module.
- `/screener-daily-candles` remains the stored daily corpus Module.
- `useResolvedDailyCandles` becomes the consumer-level Module that chooses the best daily price series for Daily MA.

This has better locality. Daily MA fallback behavior is changed and tested in one place without changing backend endpoint semantics or the live bundle orchestration.

## Error Handling

- If KIS daily fails but screener daily succeeds, return screener daily candles and include KIS warnings/error state in the result.
- If screener daily fails but KIS daily succeeds, return KIS daily candles.
- If both fail, return no candles and expose the first meaningful error.
- If both succeed but one source has partial gaps, date-keyed merge should still return all available dates.
- If neither source covers enough rows for the configured Daily MA period, `computeDailyMaByDate` naturally omits values until the SMA window fills.

The overlay should continue to avoid throwing on empty data. Empty data is a visible degrade, not a render crash.

## Loading Behavior

Daily MA should not wait for both adapters before showing a line if one adapter already has enough data. The hook can derive:

```ts
isLoading = kisQuery.isLoading && screenerQuery.isLoading
```

or expose adapter-specific loading later if the UI needs diagnostics. For v1, the overlay does not show a loading surface; it updates the line as soon as `candles` changes.

## Testing Plan

Add focused tests for the new Module:

- KIS daily rows are returned when present.
- Screener daily rows fill the result when KIS daily is empty with `kis_rest_bypassed`.
- KIS daily wins for the same date when both adapters return a row.
- Mixed coverage returns sorted rows from both sources.
- Disabled or missing input disables both adapters and returns empty candles.

Extend `DailyMovingAverageOverlay` tests:

- Mock `useResolvedDailyCandles` instead of `useLivePastDailyCandles`.
- Regression: with KIS daily empty and screener fallback rows present, Daily MA projects values onto minute candles.
- Existing venue threading coverage moves to the hook test, since the overlay no longer calls the KIS adapter directly.

Run at minimum:

```bash
npm test -- --run \
  src/live/indicators/useResolvedDailyCandles.test.tsx \
  src/live/indicators/DailyMovingAverageOverlay.test.tsx \
  src/live/indicators/DailyMovingAverageConfig.test.tsx \
  src/state/livePage.dailyMa.test.ts
npm run build
```

## Architecture Assessment

Current friction:

- `DailyMovingAverageOverlay` is shallow around data resolution: its Interface looks like rendering props, but its Implementation also owns source selection and KIS daily query details.
- `/live` and `/study` already solved candle fallback in separate modules, but Daily MA cannot reuse that policy without depending on large bundle shapes.
- Backend cache-only semantics during bypass are correct, but the overlay treats cache miss as "no daily price series exists" rather than "try stored daily adapter."

Deepening opportunity:

- `useResolvedDailyCandles` hides two adapters behind a small Interface.
- The deletion test passes: if this Module is deleted, the date merge, bypass fallback, warning propagation, and source priority logic reappears in `DailyMovingAverageOverlay` or gets duplicated between live/study paths.
- The Interface is the test surface. Tests can verify source resolution without constructing a chart, virtual axis, or RangeBundle.

## Rollout

1. Add `useResolvedDailyCandles` and tests.
2. Rewire `DailyMovingAverageOverlay` to consume the resolved candles.
3. Keep PR #412 behavior: enabling Daily MA still clears stale hidden state.
4. Verify live/study behavior through shared overlay tests and existing route-level tests.
5. Document in PR body that KIS REST bypass ON now degrades Daily MA to screener daily fallback when KIS daily memory cache is cold.

## Open Follow-Ups

- If users need to inspect why a Daily MA line comes from stored data, add a small diagnostic in the existing status/legend layer later. It is not needed for the fix.
- If multiple daily price-line indicators appear, promote `useResolvedDailyCandles` out of `indicators/` into a shared live daily data directory. For one caller, keep it local.
