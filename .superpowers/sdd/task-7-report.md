# Task 7 Report: Live and Study Stored-Data Fallbacks

## Status

- Completed frontend-only Task 7 scope.
- Backend unchanged.

## Changed Files

- `frontend/src/api/liveQuotes.ts`
- `frontend/src/api/liveQuotes.test.tsx`
- `frontend/src/live/useLiveBundle.ts`
- `frontend/src/live/useLiveBundle.test.tsx`
- `frontend/src/studyViews/useStudyReferenceBundle.ts`
- `frontend/src/studyViews/useStudyReferenceBundle.test.tsx`

## What Changed

- Preserved backend `stale` and `stale_reason` flags on `LiveQuote`.
- Kept live KIS minute/daily candle queries enabled while REST bypass is on so cache-only backend responses can still populate charts.
- Kept screener daily fallback queries enabled for live daily/weekly/monthly stock charts under bypass.
- Stopped live candle selection from zeroing KIS data just because bypass is enabled; stored `/api/range?mode=full` and screener fallback paths now remain available.
- Added study fallback wiring so minute study views can use stored full-range candles and stock D/W/M study views can use screener daily candles when KIS candle payloads are empty.
- Left toast/settings ownership alone; no backend or settings semantics changed.

## Tests Run

### Focused Task 7 tests

Command run from `frontend/`:

```bash
npm test -- --run src/api/liveQuotes.test.tsx src/live/useLiveBundle.test.tsx src/studyViews/useStudyReferenceBundle.test.tsx
```

Result:

- PASS
- `Test Files 3 passed (3)`
- `Tests 62 passed (62)`

### Build

Command run from `frontend/`:

```bash
npm run build
```

Result:

- PASS
- `tsc -b && vite build`
- `465 modules transformed`
- build completed successfully

## Commit

- Commit hash: `9e30206f`

## Concerns

- The brief's sample test command uses `frontend/src/...` paths; from the `frontend/` working directory Vitest needed `src/...` paths instead.
- Study fallback uses stored range data for minute views and screener daily for stock calendar views, matching the Task 7 brief; it does not add new backend behavior.

## Fix: Bypass Warning Toast Gate

- Gated the `notifyKisRestFailure()` effect in `frontend/src/live/useLiveBundle.ts` so bypass-enabled cache-only candle warnings do not refresh or repeat the KIS unavailable toast.
- Added a focused regression test in `frontend/src/live/useLiveBundle.test.tsx` proving bypass-time candle warnings leave `notifyFailure` and toast timing untouched, while non-bypass transport warnings still notify.
- Re-ran the required focused tests and frontend build after the fix:
  - `npm test -- --run src/live/useLiveBundle.test.tsx src/api/liveQuotes.test.tsx src/studyViews/useStudyReferenceBundle.test.tsx`
  - `npm run build`
