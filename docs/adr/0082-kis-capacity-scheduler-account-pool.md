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

## Amendment (2026-07-07): 레거시 role 경로 제거

**배경.** 원 결정은 `kis_for_role()` / `fetch_for_role()`를 "legacy compatibility
and emergency fallback adapters only"로 남기고, `run_with_capacity`가
`scheduler=None`일 때 그 경로로 폴백하도록 했다. 이전 조사(2026-07-07)로 확인:
프로덕션 16개 호출자가 **모두** 실제 스케줄러를 주입하고
(`ensure_kis_capacity_scheduler`는 절대 None을 반환하지 않음),
`kis_for_role`의 유일한 비테스트 호출자는 `scripts/probe_investor_trend_estimate.py`
한 곳뿐이었다. `run_with_capacity(role=...)`의 `role` 인자는 `scheduler=None`
분기에서만 소비되므로, 스케줄러가 항상 존재하는 프로덕션에서는 죽은 인자였고
항상 `priority`와 짝지어 다니는 중복이었다.

**결정.**

1. **`run_with_capacity`는 스케줄러를 필수(non-Optional)로 받고 `role` 인자와
   `scheduler=None` 폴백 분기를 제거한다.** 의도 신호는 `priority`
   (`user_visible` / `background`) 하나로 통일한다. 16개 호출자에서 `role=` 인자를
   제거했다.

2. **`kis_for_role` / `fetch_for_role` / `KisLegacyRole` / `_bg_round_robin`을
   삭제한다.** probe 스크립트는 `kis_runtime.ensure_kis_client_from_env`(account 0
   bare client)로 마이그레이션 — 스케줄러의 워커 lifecycle(`aclose`)을 일회성
   진단 스크립트에 끌어들이지 않기 위함이다.

3. **FM5 auth-fallback 회귀 없음.** `fetch_for_role`의 `KisAuthError` 재해결은
   `scheduler=None` 경로에서만 돌던 것이고 프로덕션은 그 경로를 타지 않았다.
   스케줄러 경로는 이미 풀 레벨에서 REST-degraded 계좌를 `eligible_accounts()`로
   제외하므로(account_health.is_rest_degraded), auth-degraded 계좌 회피 동작은
   구조적으로 보존된다 — 재시도가 아니라 lease 후보 제외로 이동했을 뿐이다.

4. **불변식 가드 정리.** `test_adr_invariants.py`의 AST 가드 2개
   (`kis_for_role("background")` 직접 호출 금지 / `run_with_capacity(None)` 금지)는
   해당 심볼·인자가 인터페이스에서 사라져 grep 대상이 없어졌으므로 삭제했다.
   (정밀히: 이 프로젝트는 Pyright로 게이트하지 않으므로 non-Optional 시그니처가
   정적으로 강제되진 않는다 — 실질 backstop은 `scheduler=None` 전달 시
   `None.submit` AttributeError로 런타임에서 즉시 실패하는 것이다. silent 레거시
   경로가 아니라 loud failure다.) 라우팅 커버리지(degraded 제외/least-loaded/예약)는
   `test_kis_account_pool.py`가, rate-limit failover는
   `test_kis_capacity_scheduler.py`가 이미 소유한다.

**Preserved Invariant 갱신.** 원 "Preserved Invariants"의 세 번째 항목
("Existing `kis_for_role()` / `fetch_for_role()` remain as legacy compatibility")은
본 amendment로 폐기된다. 새 불변식: **모든 KIS REST 데이터 fetch는
`run_with_capacity(scheduler, ...)`를 통과하며, 스케줄러 없는 경로는 존재하지
않는다.**
