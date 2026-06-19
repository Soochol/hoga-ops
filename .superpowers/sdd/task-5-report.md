# Task 5 Report: Frontend State, Types, And Live Bid Peak Hook

## Status

Completed in `/home/dev/.codex/worktrees/6c61/hoga-ops`.

## What Changed

### Frontend API and live types

- Added `BidPeak` as the frontend mirror of `AskPeak` in `frontend/src/api/types.ts`.
- Added optional `RangeBundle.bid_peaks`.
- Added `LiveTodayBidPeak` as the mirror of `LiveTodayAskPeak` in `frontend/src/api/liveSeries.ts`.
- Added required `LiveSeriesResponse.bid_peak_today`.
- Updated type-only fixtures/mocks to include the new required live field.

### Persisted indicator prefs and live page store

- Added bid peak persistence defaults in `frontend/src/state/liveIndicatorsPersistence.ts`:
  - `BID_PEAK_DEFAULT_COLOR = '#DC2626'`
  - `BID_PEAK_DEFAULT_WIDTH = 2`
  - `BID_PEAK_ALL_PRICE_DEFAULT_COLOR = '#F97316'`
  - `BID_PEAK_ALL_PRICE_DEFAULT_WIDTH = 1`
- Extended `PersistedIndicators`, merge validation, and persistence snapshot/build paths for:
  - `bidPeakEnabled`
  - `bidPeakColor`
  - `bidPeakLineWidth`
  - `bidPeakAllPriceColor`
  - `bidPeakAllPriceLineWidth`
- Added matching Zustand setters in `frontend/src/state/livePage.ts`:
  - `setBidPeakEnabled`
  - `setBidPeakStyle`
  - `setBidPeakAllPriceStyle`

### Chart prefs

- Added bid peak toggles to `frontend/src/state/chartPrefs.ts`:
  - `bidPeakIntraMax`
  - `bidPeakShowAllPrices`
- Set both toggles to `category: 'indicator-modal'` per brief.

### Live bundle pass-through

- Updated `frontend/src/live/buildLiveBundle.ts` to pass through:
  - `bid_peaks: pastBundle?.bid_peaks ?? []`

### Live bid peak reducer and hook

- Created `frontend/src/live/computeDayBidPeak.ts` as the bid-side mirror of the ask reducer.
- Created `frontend/src/live/useDayBidPeaks.ts` with the bid-side mirrored helpers:
  - `buildTodayTradedBidPeak`
  - `buildTodayAllPriceBidPeak`
  - `buildTodayCandleRangeBidPeak`
  - `observeBidPricePeaks`
  - `bestTradedObservedPeak`
  - `useDayBidPeaks`
  - `useTodayAllPriceBidPeak`
- The reducer folds `ob.bids`.
- The candle-range eligibility predicate remains `price >= candle.low && price <= candle.high`.

## TDD Notes

1. Added the requested failing tests first in:
   - `frontend/src/state/liveIndicatorsPersistence.test.ts`
   - `frontend/src/state/chartPrefs.test.ts`
2. Verified RED with:
   - missing `bidPeak*` persistence fields
   - missing `bidPeak*` chart toggles
3. Implemented the minimum production changes to satisfy the brief.
4. Re-ran the focused checks to GREEN.

## Tests Run

### RED

```bash
cd frontend && npx vitest run src/state/liveIndicatorsPersistence.test.ts src/state/chartPrefs.test.ts
```

Observed expected failures for missing bid peak prefs/toggles after installing missing frontend dependencies in this worktree with `npm ci`.

### GREEN

```bash
cd frontend && npx vitest run src/state/liveIndicatorsPersistence.test.ts src/state/chartPrefs.test.ts src/live/buildLiveBundle.test.ts
cd frontend && npx tsc --noEmit
```

All passed.

## Files Changed

- `frontend/src/api/liveSeries.test-d.ts`
- `frontend/src/api/liveSeries.ts`
- `frontend/src/api/types.ts`
- `frontend/src/live/LivePage.test.tsx`
- `frontend/src/live/buildLiveBundle.test.ts`
- `frontend/src/live/buildLiveBundle.ts`
- `frontend/src/live/computeDayBidPeak.ts`
- `frontend/src/live/useDayBidPeaks.ts`
- `frontend/src/live/useLiveBundle.test.tsx`
- `frontend/src/state/chartPrefs.test.ts`
- `frontend/src/state/chartPrefs.ts`
- `frontend/src/state/liveIndicatorsPersistence.test.ts`
- `frontend/src/state/liveIndicatorsPersistence.ts`
- `frontend/src/state/livePage.ts`

## Concerns / Follow-up

- This task intentionally does not wire overlay rendering or indicator-modal UI for bid peaks; later tasks own that surface.
- The new bid reducer/hook compiles and mirrors the ask implementation, but the brief’s focused verification did not require dedicated bid hook unit tests.

---

## Review Fix: Dedicated Bid Peak Tests

Added direct bid-side tests for the behavior-owning modules the review called out:

- `frontend/src/live/computeDayBidPeak.test.ts`
  - pre-open exclusion for deep books before 09:00 KST
  - trading-day reset with seed reapplication
- `frontend/src/live/useDayBidPeaks.test.tsx`
  - traded-price eligibility over a larger untraded bid wall
  - REST all-price promotion via today's candle range
  - retroactive promotion of a previously observed bid wall after a later trade

No production changes were needed; the new coverage passed against the existing Task 5 bid implementation.

### Verification

```bash
cd frontend && npx vitest run src/live/computeDayBidPeak.test.ts src/live/useDayBidPeaks.test.tsx src/live/computeDayAskPeak.test.ts src/live/useDayAskPeaks.test.tsx
```

Output:

```text
RUN  v4.1.7 /home/dev/.codex/worktrees/6c61/hoga-ops/frontend

Test Files  4 passed (4)
Tests  34 passed (34)
Start at  23:15:26
Duration  792ms (transform 269ms, setup 200ms, import 401ms, tests 46ms, environment 1.89s)
```
