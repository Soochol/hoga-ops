# Daily KIS Fetch Queue Design

## Context

The backend currently lets multiple features call the same KIS daily candle TR
directly:

- `/api/live/past-daily-candles` fetches daily candles for the chart.
- `screener.trigger_update` fetches daily candles for the full screener
  universe during EOD catch-up and startup recovery.

When the server starts with `screener.days_behind > 0`, startup recovery can
begin fetching thousands of screener symbols while the frontend is also loading
live daily chart data. Both paths hit KIS `inquire-daily-itemchartprice`, and
the observed result is repeated `EGW00201` rate-limit retries.

The design problem is that KIS daily candles are a shared upstream resource, but
the code does not model them as one.

## Goal

Introduce a central `DailyKisFetchQueue` so every KIS daily candle request goes
through one priority-aware coordinator.

The queue must protect user-visible chart requests first. Screener work is
allowed to slow down.

## Non-Goals

- Do not redesign all KIS REST calls.
- Do not replace account routing in `kis_access`.
- Do not move screener into a separate worker process.
- Do not make startup recovery mandatory to finish before the API is usable.

## Architecture

Add a new backend module, likely `hoga/live/daily_fetch_queue.py`.

All KIS daily candle fetches should go through this module:

```text
/api/live/past-daily-candles
screener EOD update
screener startup recovery
manual screener update
        |
        v
DailyKisFetchQueue
        |
        v
kis_access account lease
        |
        v
KisClient.fetch_past_daily_candles(...)
```

The queue is a coordinator, not a replacement for `KisClient`. Existing account
routing remains in `hoga.live.kis_access`, but the queue must be account-aware
when deciding whether background work is allowed to start.

## Account-Aware Scheduling

The queue must preserve the current role split:

- `foreground` uses account 0.
- `background` uses account 1..N through existing background routing.
- background may fall back to account 0 only when no background account is
  available or usable.

Account ownership remains outside the queue:

```text
foreground request
  -> DailyKisFetchQueue lane=foreground
  -> kis_access account lease for foreground
  -> account 0

background request
  -> DailyKisFetchQueue lane=background
  -> kis_access account lease for background
  -> account 1..N round-robin, account 0 fallback only when explicitly allowed
```

The queue's job is to decide when work may start. `kis_access` still decides
which concrete `KisClient` to use.

The existing `kis_access.fetch_for_role("background", ...)` interface is not
sufficient for the queue path because it may fall back to account 0 internally.
The queue needs a more explicit account-lease interface:

```python
lease = kis_access.acquire_account_for_role(
    "background",
    data_dir,
    allow_account0_fallback=False,
)
```

The exact shape can differ, but it must expose the selected `account_id` and
`KisClient` before the KIS request starts. The queue must be able to say
"background accounts only" for normal background work, and separately allow
account 0 fallback only when foreground is idle.

Account 0 is the user-latency account. Background fallback to account 0 must be
strictly limited:

- do not start background fallback on account 0 while any foreground request is
  queued or active;
- allow at most one background fallback on account 0 at a time;
- continue to classify that work as background, even though it uses account 0.

Accounts 1..N are background capacity. The queue should scale background
throughput with the number of configured non-degraded background accounts, but
only under the global daily TR governor.

Recommended initial limits:

- account 0 foreground concurrency: `3`
- background concurrency per background account: `1`
- account 0 background fallback concurrency: `1`, only when foreground is idle
- global daily TR rate: start conservatively around `5-8` requests per second

These are starting points, not permanent product constants.

## Global Daily TR Governor

Account splitting alone is not sufficient because the real KIS limit may be
account-scoped, app-scoped, TR-scoped, IP-scoped, or a combination. The queue
therefore needs both:

- per-account execution slots;
- one global governor for the KIS daily candle TR.

The global governor applies to every daily candle request, regardless of lane or
account. It controls:

- global request start rate;
- shared cooldown after `EGW00201`;
- foreground-first resume after cooldown.

The implementation should record `account_id`, lane, and TR on rate-limit
events where practical. The first implementation can use a global daily TR
cooldown for safety. Later, if logs show limits are truly account-local, the
queue can add per-account cooldowns without changing the caller contract.

## Priority Policy

There are two lanes:

- `foreground`: user-visible chart requests.
- `background`: screener EOD, startup recovery, and manual screener update.

Rules:

- Foreground requests always run before queued background requests.
- Background requests do not start while any foreground request is waiting.
- Already-running background requests are allowed to finish.
- Initial foreground concurrency should be small, around `3`.
- Initial background concurrency should be conservative: one active job per
  available background account, with a small global cap.

These values should be constants or configuration points so production behavior
can be tuned from observed KIS limits.

## Rate-Limit Policy

`EGW00201` must be handled as a shared daily-TR signal, not as isolated request
noise.

When the queue observes a daily TR rate-limit failure:

- Set a shared cooldown for the daily candle queue.
- Pause starting new foreground and background daily requests until cooldown
  expires.
- Resume with foreground first.
- Use exponential cooldown with jitter, starting around `1s`, then `2s`, `4s`,
  and capping around `8s`.
- If rate-limits are isolated to one account, future implementations may cool
  down only that account lane. The initial behavior should prefer global daily
  TR cooldown because it is safer under uncertain KIS quota semantics.

Preferred implementation direction:

- Route queue-owned daily fetches through a path where `KisClient` does not
  perform independent per-request rate-limit retries.
- Let the queue own retry timing for daily candles.

This is a deliberate daily-candle exception to ADR-0050's default rule that
`KisClient._get` owns `EGW00201` retry. Non-daily KIS data fetches should keep
the ADR-0050 default. Daily queue callers should use an opt-out path such as
`fetch_past_daily_candles(..., retry=False)` once that argument exists, so the
queue is the only daily-TR retry owner.

If that is too invasive for the first patch, keep the existing client retry and
add queue-level cooldown as a temporary compatibility step. The final target is
still one daily-TR retry owner, and the compatibility step should be tracked as
temporary.

## Screener Behavior

Screener update should process one background job per code, but it should not
create thousands of concurrently waiting tasks. The integration should use a
bounded producer/worker shape whose worker count follows the queue's background
capacity. The queue is the concurrency boundary; `screener_store.run_update`
should not keep its independent `_FETCH_CONCURRENCY = 8` behavior for daily KIS
fetches once routed through the queue.

A single code failure should not kill the entire screener batch. The queue
integration should change the screener collection path to keep successful
symbols and record failed symbols separately.

Startup recovery should not aggressively compete with initial frontend load.
It should either:

- start after a short delay, or
- submit background jobs immediately but let the queue naturally yield to
  foreground requests.

The queue-first behavior is required; startup delay is optional extra safety.

Foreground HTTP requests should be cancellable and should not wait forever
behind a KIS penalty window. If a foreground daily request exhausts the queue's
retry/cooldown policy, the existing route should degrade through its
`data_warnings` path rather than hang indefinitely.

## Observability

Expose enough state to explain delays:

- queued foreground count
- queued background count
- active foreground count
- active background count
- daily TR cooldown remaining
- daily TR rate-limit count
- screener update progress: total, done, failed

This can be logged first and later surfaced through `/api/screener/status` or a
small internal status endpoint.

## Testing

Unit tests should cover:

- foreground jobs run before background jobs
- background does not start while foreground is waiting
- background resumes after foreground drains
- `EGW00201` creates a shared cooldown
- cooldown resumes foreground before background
- one screener code failure does not fail the entire batch
- screener does not create one waiting asyncio task per universe Code
- foreground queue wait is cancellable or degrades through route warnings

Integration tests should cover:

- `/api/live/past-daily-candles` uses foreground queue lane
- `screener.trigger_update` uses background queue lane
- startup recovery can be scheduled without blocking FastAPI startup

## Migration Plan

1. Add `DailyKisFetchQueue` with foreground/background lanes and conservative
   defaults.
2. Route `/api/live/past-daily-candles` through foreground.
3. Route `screener.trigger_update` through background.
4. Replace screener's independent fetch concurrency with bounded queue workers.
5. Make screener batch tolerant of per-code failures.
6. Move daily TR retry ownership from `KisClient` to the queue, or add queue
   cooldown first and remove duplicate retry behavior in a follow-up.
7. Add observability for queue state and screener progress.

## Success Criteria

- Opening the frontend while screener recovery is running does not cause a wall
  of KIS `EGW00201` retry logs.
- User-visible daily chart requests complete before queued screener work.
- Background work does not consume account 0 while foreground daily chart work
  is waiting.
- Screener recovery still eventually catches up when KIS permits traffic.
- Operators can tell whether delay is due to queued work, cooldown, or upstream
  rate-limit.
