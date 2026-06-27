# 0082 - KIS Capacity Scheduler owns account-aware REST request scheduling

Date: 2026-06-27

## Status

Accepted

## Context

KIS REST calls were previously allocated through `kis_access.kis_for_role()`.
That model split callers into `foreground` and `background` roles and then
picked an account. It helped keep early `/live` work simple, but it could not
share idle account capacity across user-visible chart work, quote overlays, and
background jobs. It also made exhausted `EGW00201` retry behavior local to each
caller, so one hot endpoint could keep retrying while other healthy accounts
were still available.

We are accepting the operating assumption that KIS REST limits are scoped per
account/appkey. Under that assumption, adding configured KIS accounts should
increase REST capacity.

## Decision

Introduce `KisCapacityScheduler` and `KisAccountPool` above `KisClient`, and
make `KIS REST Access` the caller-facing seam for scheduled KIS REST work.

`kis_capacity_runtime` owns one process-local scheduler per `data_dir`. Routes
and background callers submit semantic KIS requests through
`kis_access.run_with_capacity(...)`. That interface requires a typed
`KisRestEndpoint`, priority, request key, cooldown scope, and a callable. The
access module then uses the scheduler when injected, or the legacy role-routed
adapter for callers not yet migrated. The scheduler leases the least-loaded
healthy account, executes the callable with that account's `KisClient`,
coalesces duplicate request keys, prioritizes `user_visible` work over
`background` work, and applies account-scoped cooldown after `KisClient`
exhausts its `EGW00201` retries.

Domain modules own route-specific degradation policy above that seam. For
example, `LiveMinuteCandleBackfill` owns `/api/live/past-candles` minute cache
fanout, AUTO venue merge, and `data_warnings`; the route only validates request
parameters and wraps the wire response. `LiveDailyCandleBackfill` similarly
owns `/api/live/past-daily-candles` venue fallback, AUTO integrated warning,
and scheduled daily KIS request shape while reusing the shared daily walkback
orchestrator. `LiveInvestorNetBackfill` owns `/api/live/past-investor-net`
scheduled request shape and row conversion, also reusing that shared daily
walkback orchestrator. `LiveIndexInvestorNetFetcher` owns
`/api/live/index-investor-net` scheduled request shape and market-level
rate-limit degradation. `/api/live/index-candles` schedules representative-index
daily and minute fetches as user-visible `INDEX_DAILY` / `INDEX_MINUTE`
requests while retaining route-owned cache/windowing policy.
`LiveIndexSectorIntradayOverlay` owns the optional today-only quote overlay for
`/api/live/index-sector-rankings`, scheduling it as a background `QUOTES`
request and degrading to the daily corpus on failure.
`ScheduledLiveRestCaptureClient` is the KisClient-shaped adapter used by
`LiveRestPoller` and `Rest30sRecorder` for scheduled orderbook/trade/broker
capture calls. `ProgramTradeCollector` schedules stock-level program-trade
side-channel fetches as background `PROGRAM_TRADE` requests. Screener EOD gap
catch-up and one-time raw/adjusted daily backfill schedule KIS daily requests as
background `SCREENER_DAILY` work, and Screener intraday overlay schedules its
multi-price fetch as a background `QUOTES` request.

The scheduler worker count scales with configured accounts by default:

```text
clamp(configured_accounts * 8, 4, 64)
```

`HOGA_KIS_CAPACITY_MAX_WORKERS` can override worker count, and
`HOGA_KIS_CAPACITY_MAX_PENDING` bounds unique pending request keys. Workers are
concurrency slots, not rate-limit owners. Account-level KIS rate limiting
remains inside each `KisClient` token bucket.

Configured accounts and worker sizing are evaluated when the scheduler/account
pool is created. Account-count or env changes are not hot-reloaded; restart or
explicit scheduler recreation is required.

FastAPI shutdown closes the scheduler runtime before closing `KisClient`
singletons.

## Preserved Invariants

- KIS HTTP still goes through `KisClient`; direct ad-hoc HTTP calls remain out
  of bounds.
- Each configured account keeps its own `KisClient` and token bucket.
- Existing `kis_access.kis_for_role()` / `fetch_for_role()` remain as legacy
  compatibility and emergency fallback adapters only. Production KIS REST
  callers must pass a real scheduler to `run_with_capacity`; `scheduler=None`
  is not a production path.
- New scheduled KIS REST callers use `KisRestEndpoint` values rather than raw
  endpoint strings, so cooldown keys and status snapshots stay stable.
- Routes without KIS credentials still degrade explicitly instead of hanging on
  an empty scheduler queue.

## Consequences

- User-visible chart work can use any healthy account instead of account 0 only.
- Background work no longer has a fixed account role; it uses the shared pool
  and yields to queued user-visible work.
- Adding healthy KIS accounts increases available REST capacity approximately
  linearly: `healthy_accounts * per-account KIS rate limit`.
- One account's rate-limit cooldown does not block healthy accounts.
- `/api/live/status` exposes scheduler snapshot fields for account counts,
  worker/pending limits, queue/inflight counts, deferrals, overloads, and
  account cooldowns.
- Scheduler worker lifecycle and account lease accounting become production
  responsibilities and must remain covered by unit tests.

## Alternatives Considered

1. Keep `kis_for_role()` as the allocator.
   This preserves the old foreground/background split, but cannot lend idle
   accounts to user-visible work and cannot globally coalesce duplicate
   semantic requests.

2. Put account selection into every route.
   This spreads capacity policy across handlers and makes fairness, cooldown,
   and observability hard to reason about.

3. Move all retry and circuit breaking into `KisClient`.
   This improves one account's behavior, but `KisClient` cannot choose among
   accounts.

4. Hot-reload accounts and worker counts.
   This adds resize complexity around workers, queued requests, and shared
   futures. Explicit restart/recreate is simpler for the current local app.
