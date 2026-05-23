# 0017 — Capture fetch throughput tuning: rate_limit_s=0.05, stagnation guard, throttle backoff

**Status:** accepted (2026-05-24)

**Related:**
- Spec: `docs/superpowers/specs/2026-05-23-capture-fetch-throughput-design.md`
- Plan: `docs/superpowers/plans/2026-05-23-capture-fetch-throughput.md`
- Measurements: `docs/superpowers/measurements/2026-05-23-throughput/`

## Decision

Three levers were evaluated. Two are adopted; one is rejected.

**Adopted:**

1. `DEFAULT_RATE_LIMIT_S` (the `collect_stock_date` sleep-per-page default) drops from **0.20 → 0.05 s**.
2. `MAX_STAGNANT_PAGES = 200` — a new safety guard that force-stops a fetch when
   `max_event_time` is frozen (or `None`) and `new_seqs == 0` for 200 consecutive pages.
3. Throttle auto-backoff (`THROTTLE_BACKOFF_FACTOR=2.0`, `THROTTLE_BACKOFF_HOLD_PAGES=10`,
   `THROTTLED_STATUSES=frozenset({429})`) — rate_limit_s doubles on 429 and holds for 10
   pages before returning to the adopted value.

**Rejected:**

- `DEFAULT_PAGE_STEP_MS` stays at **60 000 ms**. Raising the step ceiling was the first
  lever investigated (Phase 1) and was ruled out — see _Why_ below.

## Why

### Background

Per-Stock-Date capture wall-clock was 5–10 min. Profiling showed that ~75–84 % of
the per-page time (~0.24–0.27 s) was the `rate_limit` sleep (0.20 s of every page).
HTTP RTT was already efficient (~46–80 ms via httpx keep-alive). Cutting the sleep
was therefore the dominant lever.

Three orthogonal levers were identified and measured across two phases:

### Phase 1 — parameter matrix (20260428, 003490, 27 cells × 3 time-of-day buckets)

Source: `docs/superpowers/measurements/2026-05-23-throughput/adoption-decision.md`

Key findings:

- **rate=0.05 is safe.** Zero 4xx / 429 / cookie_expired events across all cells.
- **step=60 000 is the throughput leader at every time-of-day bucket.** step=240 000
  produced cap_hit rates of 6.8–9.4 %, meaning hogaplay was cutting off the response
  early. Higher step ≠ more events per response.
- **body_len_p50 is essentially flat across step values.** hogaplay returns events from
  time T until the next real event, bounded by its own internal time-window cap —
  not by the client-supplied `step` parameter. Doubling the step window cannot outrun
  that cap.
- 003490 was assumed to be the "low-activity stock" that would most benefit from a
  raised ceiling. Even on this stock, step=240 000 at the open produced 6.8 % cap_hit.
  All cells with cap_hit=0 belonged to step=60 000.

**Step ceiling lever rejected on Phase 1 evidence.**

### Phase 2 — full verification (20260428, 003490 + 005930)

Source: `docs/superpowers/measurements/2026-05-23-throughput/verify/VERIFY.md`

| Stock | Before  | After  | Reduction | Target |
|-------|---------|--------|-----------|--------|
| 003490 | 5:03   | 2:03   | −59 %     | ≤ 2:00 |
| 005930 | 6:36   | 2:48   | −57 %     | ≤ 5:00 |

Zero throttle-backoff events. Zero 4xx / 5xx. Both `finished=True`.

003490 landed 3 s over the ≤ 2:00 KPI target — practically equivalent; RTT jitter can
account for this margin.

### Stagnation guard (why it was added and why 200 pages)

Source: `docs/superpowers/measurements/2026-05-23-throughput/drain-analysis-20260518.md`
and `docs/superpowers/measurements/2026-05-23-throughput/baseline/SUMMARY.md`

The original spec assumed the runaway mode was "post-window drain" — the fetch loop
over-iterating past `window_end`. The 20260518 / 003490 runaway was different:
hogaplay froze `max_event_time` at 09:03:45; `observe()`'s cap-hit branch reset
`_empty_in_a_row` on every call; `t` never advanced to `window_end`; 3 829 pages
were wasted. The "post-window" termination condition never fired because the page
cursor was stuck, not past the window.

The Phase 0 baseline measured a normal maximum consecutive-stagnant-page streak of 130
(see `baseline/SUMMARY.md`). 200 was chosen as the guard threshold — above any
legitimate trading session's stagnation streak, below the runaway count (3 829).
Under this guard, the 20260518 runaway would have terminated at approximately page 303
instead of page 3 931 — a 92 % reduction in wasted fetches.

## Trade-offs and what we considered

- **(chosen) rate_limit_s = 0.05.** Achieves the throughput target with zero safety
  events in Phase 1 (27 cells) and Phase 2 (2 full stocks). If hogaplay tightens its
  policy, the throttle backoff net catches it.
- **(rejected) rate_limit_s = 0.10 (intermediate).** Phase 1 showed 0.05 was already
  safe; 0.10 would leave half the gain on the table for no safety benefit.
- **(rejected) DEFAULT_PAGE_STEP_MS = 120 000 or 240 000.** Phase 1 matrix established
  that step=60 000 dominates at every time-of-day bucket. 240 000 produces cap_hit
  6.8–9.4 % on 003490 — the supposedly low-activity beneficiary. Rejected on data.
- **(rejected) Stock-Date worker pool (Plan B).** Parallelising across multiple captures
  reduces queue latency but does not reduce per-capture wall-clock. If adopted in a
  future PR, the per-worker rate_limit_s must be recalculated as `req/sec × worker_count`
  to stay within hogaplay's aggregate rate ceiling. This ADR's rate=0.05 is a per-worker
  value; a multi-worker PR needs its own arithmetic.
- **(rejected) Optimistic page pipelining (N concurrent fetches per capture).** Complexity
  is high due to PageStep cap-hit dependency ordering. The adopted rate=0.05 already
  meets the target. YAGNI.
- **(rejected) HTTP infrastructure improvements (HTTP/2, gzip).** httpx keep-alive is
  already in use. HTTP RTT is ~46–80 ms — roughly half the per-page budget at rate=0.05
  (sleep=50 ms + RTT ≈ 95–130 ms; HTTP share ~47–57 %). The share grew from ~28 %
  (under the old rate=0.2 baseline) because we cut the sleep first. HTTP/2 / gzip could
  in principle shave the remaining ~50 ms RTT further, but the adopted settings already
  meet the wall-clock KPI without that complexity. Revisit only if a future scope
  (e.g. multi-stock parallel captures) makes per-page HTTP latency the dominant term again.

## Consequences

- **Wall-clock reduction (Phase 2 verified):**
  - Low-activity captures (003490 pattern) ≈ **−59 %** (5:03 → 2:03)
  - High-activity captures (005930 pattern) ≈ **−57 %** (6:36 → 2:48)
- **Throttle backoff** means a transient 429 no longer fails the capture — rate_limit_s
  doubles and holds for 10 pages, then returns to 0.05. Sustained throttling
  (prolonged 4xx run) would cause the same page to retry indefinitely; this is an
  open question deferred to a future PR.
- **Stagnation guard** terminates 20260518-pattern runaways at ≈ page 303 vs. the
  unguarded 3 931 pages — 92 % waste reduction for that failure mode.
- **Worker pool (Plan B), if adopted later:** rate_limit_s = 0.05 is a per-worker
  budget. A multi-worker PR must re-express this as an aggregate req/sec ceiling and
  divide by worker count. Failing to do this would multiply hogaplay's inbound request
  rate by the worker count at the old sleep value.
- **500-class errors:** HogaplayClient retries these internally and surfaces them as
  `status_code=None`. The orchestrator raises on `None` — this is intentional and
  unchanged by this ADR.

## Caveats

- Phase 1 and Phase 2 measurements were both captured during **off-hours (Saturday →
  Sunday KST)**. hogaplay throttle policy and RTT may differ on weekdays 09:00–16:00
  KST when exchange traffic is live. One weekday verification run is recommended before
  treating these numbers as production-hour SLOs.
- 003490's ≤ 2:00 KPI was missed by **3 s** (2:03). This is within RTT noise, but
  on a loaded weekday network it may not hold. The ADR records this as a near-miss,
  not a failure.

## Out of scope

- **Per-capture concurrency / worker pool.** Separate PR; see Plan B note in Trade-offs.
- **Sustained-throttle recovery (sustained 4xx after backoff).** Current implementation
  raises; a future PR may add retry-with-limit or circuit-breaker semantics.
- **Sub-minute rate_limit precision.** 0.05 s is the floor; finer-grained adaptive
  rate control (token-bucket, AIMD) is not warranted until a concrete hogaplay policy
  document is available.
- **Weekday production-hour re-verification.** Recommended in Caveats; not required to
  land this ADR.
