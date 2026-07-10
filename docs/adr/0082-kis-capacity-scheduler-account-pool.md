# 0082 - KIS Capacity Scheduler owns account-aware REST request scheduling

Date: 2026-06-27

**Amended (2026-07-10 — ADR-0100):** 본 ADR 말미 2026-07-08 Amendment의 "KIS 한도는 명의 단위 → 전역 15/s 버킷 → 계정 늘려도 REST 처리량 불변"은 재실측(앱키별 독립 ~15/s, 2026-07-07 '명의 단위'는 재현 실패)으로 폐기됐다 — 원 Context의 per-appkey 운영 가정과 계정 수 비례 linear-capacity Consequence가 복원됐다(3계정 실측 3.03x). 계정 풀은 WS 슬롯·failover·워커 동시성에 더해 **REST 콜레이트도 계정 수에 비례 증설**한다.

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

## Amendment (2026-07-08): 명의-단위 한도 반증 + 계좌 계층 존재이유 재정의 + 예약 게이트 제거

**배경 — 운영 가정이 반증됐다.** 원 결정의 Context는 "KIS REST 한도는
계좌/appkey 단위(per account/appkey)"라는 운영 가정을 채택하고, 그 위에서
"configured 계좌를 추가하면 REST 용량이 대략 선형으로 늘어난다
(`healthy_accounts * per-account KIS rate limit`)"를 Consequences로 약속했다.

이 가정은 실측으로 반증됐다. `/investigate 2026-07-07`에서 **한도가 명의(名義)
단위**임이 확인됐다 — 3계좌 × 15/s = 45/s 송신 시 EGW00201 발생률 ~47%.
그래서 프로세스의 모든 `KisClient`가 **하나의 전역 토큰버킷**(`_shared_rate_limiter`,
[kis_runtime.py:39-55](../../hoga/live/kis_runtime.py))에서 토큰을 소비해 합산
송신률을 명의 한도(~20/s) 아래로 묶도록 바뀌었다. 즉 "각 계좌가 자기 토큰버킷을
가진다"는 게 아니라 **모든 계좌가 하나의 전역 버킷을 공유**한다.

**폐기되는 불변식·서술.**

- Preserved Invariants의 "Each configured account keeps its own `KisClient` and
  token bucket" — 각 계좌는 자기 `KisClient`(=토큰 provider·httpx 연결)를 유지하나
  **토큰버킷은 계좌별이 아니라 전역 공유**다. 절반만 유효하므로 정정한다.
- Consequences의 "Adding healthy KIS accounts increases available REST capacity
  approximately linearly" — **폐기**. 명의-전역 버킷 아래에서 계좌를 추가해도
  합산 송신률은 15/s로 고정이라 REST 처리량은 늘지 않는다.

**계좌 계층의 재정의된 존재이유.** 계좌 풀·account_health·`eligible_accounts()`는
여전히 필요하나, 그 이유가 "REST 처리량 스케일링"에서 다음 둘로 바뀐다:

1. **인증 격리.** FM5 REST-auth 저하 계좌를 `eligible_accounts()`가 배제하므로
   (`account_health.is_rest_degraded`), appkey 하나가 revoke/만료돼도 다른 계좌로
   REST가 지속된다. 이건 명의-단위 한도와 무관하게 유효하다.
2. **WS 용량.** KIS WebSocket은 계좌(appkey)별 연결이라, 다계좌는 WS 구독 종목
   수용량을 늘린다(REST 버킷과 직교).

**예약 게이트(`reserve_one`) 제거.** `KisAccountPool.lease(reserve_one=...)` +
`reserved_background_capacity_available` + `KisAccountReservationDeferred` +
스케줄러의 지연-재큐잉/condition-variable 대기 사슬을 **제거**한다(별도 커밋에서
구현). 근거:

- **실측**: 운영 백엔드 `/api/live/status`에서
  `background_deferred_due_to_reserved_capacity=29,962` vs `rate_limit_failovers=0`.
  예약 게이트가 background를 3만 회 지연시키는 동안 그것이 지키려던 rate-limit
  사고는 한 번도 없었다.
- **구조**: `lease()`에는 **계좌별 동시성 상한이 없다** — foreground는 유휴 계좌를
  요구하지 않고 least-loaded 계좌를 그냥 lease한다. 따라서 예약 게이트가 지키는
  자원(완전 유휴 계좌 ≥2)은 foreground가 실제로 소비하는 자원(전역 버킷 토큰)이
  아니다. 명의-전역 버킷 체제에서 이 게이트는 **background만 늦추는 순수
  오버헤드**다. 예약 게이트가 계좌별 미사용 쿼터를 아끼는 의미가 있던 것은
  계좌별-한도 가정 아래에서였고, 그 가정이 반증된 지금은 근거가 사라졌다.
- **우선순위는 그대로 3겹**이 소유한다: ① 스케줄러 큐 rank(user_visible 먼저)
  ② 워커의 background 양보(user_visible 대기 시 재큐잉) ③ 버킷 foreground 레인
  (ADR-0087, 토큰 수준 양보 + 기아 백스톱). 게이트 제거로 우선순위 보장이
  약화되지 않는다.

**`KisRestEndpoint` 라벨의 의미 명문화.** 새 스케줄 호출자가 헷갈리지 않도록:
라벨은 **KIS TR과 1:1이 아니라 "작업 차선(work lane)"**이다 — coalesce 요청키의
구성요소이자 cooldown scope·`/api/live/status` 관측의 단위. 같은 KIS TR을 다른
라벨로 스케줄하는 건 의도된 설계다: `SCREENER_DAILY`와 `PAST_DAILY`는 동일 TR
(`fetch_past_daily_candles`)을 각각 스크리너 배치용/차트 백필용 차선으로 분리해
cooldown·관측을 독립시킨다. 새 호출부는 라벨과 실제 호출이 어긋나지 않도록,
가능하면 `ScheduledLiveRestCaptureClient`
([live_rest_capture_access.py](../../hoga/live/live_rest_capture_access.py))처럼
엔드포인트별 라벨을 메서드에 바인딩한 typed 어댑터를 해당 도메인 모듈에 두는 것을
관례로 한다(21개 호출부를 일괄 재배선하는 통합 레지스트리는 엔드포인트별
검증·페이징 의미 차이 때문에 shallow abstraction이 되므로 채택하지 않는다 —
ADR-0060과 같은 판단 계열).
