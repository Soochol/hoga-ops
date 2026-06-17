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
kis_access.fetch_for_role(...)
        |
        v
KisClient.fetch_past_daily_candles(...)
```

The queue is a coordinator, not a replacement for `KisClient`. Existing account
routing remains in `hoga.live.kis_access`.

## Priority Policy

There are two lanes:

- `foreground`: user-visible chart requests.
- `background`: screener EOD, startup recovery, and manual screener update.

Rules:

- Foreground requests always run before queued background requests.
- Background requests do not start while any foreground request is waiting.
- Already-running background requests are allowed to finish.
- Initial foreground concurrency should be small, around `3`.
- Initial background concurrency should be conservative, around `2`.

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

Preferred implementation direction:

- Route queue-owned daily fetches through a path where `KisClient` does not
  perform independent per-request rate-limit retries.
- Let the queue own retry timing for daily candles.

If that is too invasive for the first patch, keep the existing client retry and
add queue-level cooldown as a follow-up. The final target should still be one
daily-TR retry owner.

## Screener Behavior

Screener update should submit one background job per code.

A single code failure should not kill the entire screener batch. The queue
integration should change the screener collection path to keep successful
symbols and record failed symbols separately.

Startup recovery should not aggressively compete with initial frontend load.
It should either:

- start after a short delay, or
- submit background jobs immediately but let the queue naturally yield to
  foreground requests.

The queue-first behavior is required; startup delay is optional extra safety.

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

Integration tests should cover:

- `/api/live/past-daily-candles` uses foreground queue lane
- `screener.trigger_update` uses background queue lane
- startup recovery can be scheduled without blocking FastAPI startup

## Migration Plan

1. Add `DailyKisFetchQueue` with foreground/background lanes and conservative
   defaults.
2. Route `/api/live/past-daily-candles` through foreground.
3. Route `screener.trigger_update` through background.
4. Make screener batch tolerant of per-code failures.
5. Move daily TR retry ownership from `KisClient` to the queue, or add queue
   cooldown first and remove duplicate retry behavior in a follow-up.
6. Add observability for queue state and screener progress.

## Success Criteria

- Opening the frontend while screener recovery is running does not cause a wall
  of KIS `EGW00201` retry logs.
- User-visible daily chart requests complete before queued screener work.
- Screener recovery still eventually catches up when KIS permits traffic.
- Operators can tell whether delay is due to queued work, cooldown, or upstream
  rate-limit.
