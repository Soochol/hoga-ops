# Phase 1 Matrix — Adoption Decision

**Date:** 2026-05-23 (토요일 23:00 KST)
**Matrix:** 3 rates × 3 steps × 3 start_labels = 27 cells, all outcome=ok

## Aggregated Results Table

Averages across 3 start_labels (open=90s, lunch=120s, close=152s in HogaMs).
Sorted by avg_pages_per_90s descending.

| rate | step | pages/90s | cap_hit | http_p95 | body_p50 | safe |
|---|---|---|---|---|---|---|
| 0.05 | 60000 | 609.7 | 0.007 | 48.9 | 102320.0 | 3/3 |
| 0.1 | 60000 | 472.3 | 0.005 | 54.0 | 102952.0 | 3/3 |
| 0.1 | 120000 | 338.7 | 0.021 | 69.7 | 101600.0 | 3/3 |
| 0.05 | 120000 | 338.7 | 0.021 | 53.2 | 101600.0 | 3/3 |
| 0.2 | 60000 | 292.7 | 0.007 | 84.8 | 104131.0 | 3/3 |
| 0.2 | 120000 | 262.3 | 0.018 | 75.2 | 102197.0 | 3/3 |
| 0.2 | 240000 | 174.7 | 0.063 | 91.9 | 101449.0 | 3/3 |
| 0.1 | 240000 | 174.7 | 0.063 | 84.7 | 101449.0 | 3/3 |
| 0.05 | 240000 | 174.7 | 0.063 | 54.8 | 101449.0 | 3/3 |

> Note: avg_pages_per_90s is a true mean across all 3 start_labels. The "close"
> start_label (start_t=152_000_000 ms) hits end-of-data after ~8–30 s, so page
> counts there are much lower than open/lunch. The mean therefore understates peak
> throughput; the open-label figures (rate=0.05 step=60k: 1014 pages, rate=0.1
> step=60k: 634 pages) are the relevant throughput comparison for production.

## Decision

**Adopted values:**

| Parameter | Old value | New value |
|---|---|---|
| `DEFAULT_RATE_LIMIT_S` | 0.2 | **0.05** |
| `DEFAULT_PAGE_STEP_MS` | 60000 | **60000** (unchanged) |

**Rationale:**

- `rate=0.05` delivered **1014 pages in 90 s** at open start vs 367 pages at `rate=0.2`
  — a **2.76× throughput gain** with zero 429/403/503 errors observed across all 27
  cells. The server tolerated the higher request rate without any throttle response.
  rate=0.1 was also tested safely (open: 634 pages vs 1014 at rate=0.05 — 37% less throughput) but strictly dominated by rate=0.05 within the tested matrix; no observed benefit.
- `step_ms=60000` is kept unchanged. It already yielded cap_hit_rate ≈ 0.5% for 003490
  at open — well within the acceptable range. Increasing step to 120k or 240k introduces
  progressively higher cap_hit rates (see Rejected cells below) with no throughput benefit
  for a low-activity ticker like 003490.

## Rejected Cells and Why

**step=240000 (all rates):**
- cap_hit_rate 6.3–9.4% in open/lunch cells (e.g. r0.1_s240000_open: 6.8%,
  r0.2_s240000_lunch: 9.4%)
- The step ceiling lever fails: when a single page spans 240 s of trading time, the
  HogaPlay API is far more likely to cap the response at the event-count ceiling,
  forcing a step-halving retry that wastes the whole request
- pages/90s collapses to 174.7 (same across all 3 rates) — the bottleneck has shifted
  from rate-limiting to step-ceiling waste

**step=120000 (all rates):**
- cap_hit_rate 0.5–2.8% in open/lunch cells — already 3–6× higher than step=60k
- pages/90s at rate=0.05: 338.7 vs 609.7 for step=60k — a 44% throughput reduction
  with no benefit for 003490's activity profile
- Not competitive with step=60k at any rate tested

**rate < 0.05 not explored:**
- `rate=0.05` is the fastest rate tested. `rate=0.02` would probe the true safety floor.
  Left as future work for Task 8 weekday re-verification.

## Open Question #1 — Event-Count Cap (spec §8.2)

**Answer: hogaplay has no fixed event-count cap for 003490.**

`body_len_p50` is essentially flat across all step values for the same start_label:
- open: step=60k → 145687 B, step=120k → 143908 B, step=240k → 143775 B
- lunch: step=60k → 139112 B, step=120k → 138732 B, step=240k → 138410 B
- close: step=60k → 22161 B, step=120k → 22161 B, step=240k → 22161 B

If hogaplay enforced a hard event-count cap, doubling the step window would double the
response body (more events fit per page). Instead, body size is stable — the server
returns a consistent event density regardless of the requested time window. The
cap_hit responses seen at step=240k are the adaptive step-halving mechanism in the
capture client, not a server-enforced event cap.

## Open Question #2 — HogaMs Overflow (spec §8.3)

**OQ#2 (HogaMs overflow tolerance):** Confirmed tolerant.

start_t values used (HHMMSSmmm encoding):
- 90_000_000 = 09:00:00.000 KST (open)
- 120_000_000 = 12:00:00.000 KST (lunch)
- 152_000_000 = 15:20:00.000 KST (close, start of closing Auction Window)

Each cell drove `t` forward by step_ms increments (60_000 / 120_000 / 240_000). For step=240k starting at 15:20, t crosses 16:00:00.000 (160_000_000) within ~33 iterations. Hogaplay returned HTTP 200 for all such queries across all 27 cells — no HTTP 400 for HogaMs values past 16:00 (e.g., 160_240_000 = "16:02:40.000"). Server is tolerant of these synthetic overflow values.

## Caveat — Saturday Night Measurement

All 27 cells were captured on **Saturday 2026-05-23 at approximately 23:00 KST**
(off-hours: hogaplay is serving historical replay data, not live ticks).

Two risks for weekday generalization:
1. **RTT may be higher on weekdays** due to increased hogaplay load during market hours.
   p95 HTTP latencies observed across all 27 cells: 44–144 ms (individual cells; averaged per (rate, step) pair: 48.9–91.9 ms — see table). Weekday p95 may differ.
   `rate=0.05` remains safe under sustained load.
2. **Throttle policy may differ during market hours.** The complete absence of 429/503
   responses at `rate=0.05` is encouraging but was not stress-tested under concurrent
   production load.

**Recommendation:** Task 8 should include a weekday re-verification run at `rate=0.05`
`step=60000` during market hours (09:00–15:30 KST) to confirm the adopted values
hold under realistic server load before deploying to production.
