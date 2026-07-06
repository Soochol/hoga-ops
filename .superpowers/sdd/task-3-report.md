# Task 3 Report: Quote Row Missing-Pct Presentation

## Status

Completed.

## Changes

- Updated `frontend/src/rightrail/QuoteRow.tsx` so when `price` exists:
  - `pct === null`: render `"<price>원"` only.
  - `pct != null`: render `"<price>원 (<pct>)"` as before.
- Left `formatPct()` unchanged.
- Added/updated tests in `frontend/src/rightrail/QuoteRow.test.tsx`:
  - Added required test: `omits the parenthesized dash when price exists but pct is missing`.
  - Kept coverage for no-price fallback with a new/updated expectation (`—` when `price` is `null`).

## TDD Evidence

- Red (pre-fix behavior / old rendering):  
  `cd frontend && npm test -- QuoteRow.test.tsx --run` (or `--runInBand` from brief)  
  → `2 failed` (the new missing-pct expectation and missing-price expectation both fail with old `가격 (—)` output).
- Green (post-fix behavior):  
  `cd frontend && npm test -- QuoteRow.test.tsx --run`  
  → `19 passed`.

## Note

- `vitest` in this repo does not accept `--runInBand` (it errors with `Unknown option --runInBand`), so `--run` was used for focused execution as the equivalent supported command.
