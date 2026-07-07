# 0086 — Rate-limit 소진 시 KisCapacityScheduler가 계좌 failover 한다

**Status:** accepted (2026-07-07)

**Related:**
- ADR-0050 — KIS rate-limit retry는 `KisClient._get`에 내장 (계좌 내 backoff)
- ADR-0082 — `KisCapacityScheduler` + `KisAccountPool`이 계좌 인지형 REST 스케줄링 소유
- ADR-0083 — KIS REST Bypass는 데이터 요청에 대한 백엔드 정책

## Context

ADR-0082가 계좌 풀을 도입하면서 "healthy 계좌를 추가하면 REST 용량이 대략
선형으로 늘어난다(`healthy_accounts * per-account KIS rate limit`)"를 약속했다.
그러나 그 약속은 **성공 경로에만** 적용되고 있었다.

한 요청이 `EGW00201`(초당 거래건수 초과)을 만나면 이렇게 흘렀다:

1. `KisClient._get`이 계좌 내 backoff `(1, 2, 4)`초를 소진(ADR-0050) — 그동안
   워커 슬롯과 계좌 lease를 점유한 채.
2. backoff가 소진되면 `KisRateLimitError`가 워커로 올라온다.
3. 워커는 그 계좌에 cooldown을 마킹하고 **요청 future를 그대로 실패시켰다** —
   옆에 놀고 있는 healthy 계좌가 있어도 재시도하지 않았다.

즉 계좌를 여러 개 두는 이유(용량 합산)가 정작 rate limit에 부딪히는 순간,
그러니까 그 용량이 가장 필요한 순간에 작동하지 않았다. 사용자 관점에서는
차트 백필 중 `data_warnings` 경고나 빈 캔들 구간, 또는 최악 7초 멈칫 후 실패로
드러났다(재클릭 유발). 2026-05-29의 "신뢰도 낮은 날짜 46건 벽" 사고와 같은
증상 계열이다.

## Decision

`KisCapacityScheduler._worker`의 실행 지점을 `_run_with_account_failover`로 감싼다.
한 요청은 `KisRateLimitError`를 만나면 그 계좌에 cooldown을 마킹한 뒤 **다음
eligible 계좌로 re-lease 하여 재실행**한다. 시도 상한은
`len(account_pool.configured_accounts())` — cooldown 배제가 후보를 자연히 줄여
모든 계좌가 소진되면 루프가 수렴한다.

```
_worker
  └─ _run_with_account_failover(request)          ★신규: 계좌 간 failover
       for attempt in range(len(configured_accounts)):
         lease = pool.lease(cooldown_key, reserve_one=rank>0)
         try:    return await request.call(lease.client)   # KisClient 내부
         except KisRateLimitError:                          # backoff 소진 후
             pool.mark_cooldown(account, cooldown_key, cooldown_s)
             last = exc   # 다음 계좌로
         finally: pool.release(account)
       raise last
```

세 가지 세부 결정:

1. **ADR-0050 무충돌 (계좌 내 backoff 불변).** `KisClient._get`의 `(1,2,4)`초
   EGW00201 backoff는 그대로 둔다. failover는 그 backoff가 **소진된 뒤에만**
   발동한다. 계좌 내 재시도(같은 계좌가 잠깐 쉬면 풀리는 짧은 초과)와 계좌 간
   failover(그 계좌가 지속적으로 막힌 경우)는 서로 다른 실패 모드를 덮으므로
   중첩이 아니라 계층이다. 계좌 내 최악 7초 핀을 줄이는 것은 본 ADR 범위 밖의
   후속 과제로 분리한다(스케줄러 경유 요청에 대해 backoff opt-out을 도입할지는
   실측 후 결정).

2. **풀 소진 시 원래 rate-limit 에러를 raise.** failover 도중 `lease`가
   `KisNoAccountAvailable`(모든 계좌 cooldown)이나 `KisAccountReservationDeferred`
   (예약 용량 게이트)를 던지면, **이미 rate-limit을 한 번이라도 겪은 요청**은
   그 원래 `KisRateLimitError`를 raise 한다. deferral을 그대로 올려 요청을
   재큐잉하지 않는다 — 이미 실행이 시작된(started) 요청은 caller가 degrade 판단에
   쓸 원인 에러를 봐야지, "나중에 다시 시도"로 삼키면 안 되기 때문이다. 첫 lease
   부터 실패한(아직 rate-limit을 안 겪은) 요청은 종전대로 deferral/no-account를
   그대로 전파한다.

3. **`rate_limit_failovers` 카운터.** 두 번째 이후 시도를 카운트해 `snapshot()`
   (→ `/api/live/status`)에 노출한다. failover가 실제로 얼마나 발생하는지가
   "계좌를 더 늘려야 하는가" 판단의 관측 신호가 된다.

## Preserved Invariants

- KIS HTTP는 여전히 `KisClient`를 통과한다(ADR-0050 Invariant-50.1, 0082 불변).
- 계좌 내 EGW00201 backoff는 `KisClient._get` 소유로 불변(ADR-0050).
- 각 시도는 `pool.lease` → `request.call` → `pool.release`의 짝을 지킨다 —
  failover 루프의 각 반복마다 `finally`가 lease를 반드시 반납한다.
- `reserve_one`(예약 용량 게이트, ADR-0082)은 failover 재시도에도 그대로 적용 —
  background failover가 사용자용 예약 계좌를 잠식하지 않는다.

## Consequences

- rate limit에 부딪힌 user_visible 요청의 최악 결과가 "7초 대기 후 실패"에서
  "계좌 A backoff 소진 → 즉시 계좌 B에서 성공"으로 바뀐다(계좌가 2개 이상일 때).
- ADR-0082의 용량 선형성 약속이 성공 경로뿐 아니라 **실패 경로에도** 적용된다.
- 단일 계좌 구성에서는 `max_attempts == 1`이라 동작이 종전과 동일 —
  failover는 no-op이고 rate-limit 에러가 그대로 전파된다(회귀 0).
- 계좌 lease 회계(inflight 카운트)가 failover 시도마다 증감하므로, 풀의
  inflight 정확성이 더 중요한 production 책임이 된다 — 단위 테스트로 lock-in.

## Alternatives Considered

1. **계좌 내 backoff를 스케줄러 경유 시 opt-out 하고 즉시 failover.**
   최악 7초 핀을 없애는 더 공격적인 안. 그러나 ADR-0050을 정면으로 개정해야 하고
   ("짧은 초과는 같은 계좌 재시도가 최선"이라는 근거를 뒤집음), 계좌 내 재시도로
   흡수되던 순간적 초과가 불필요하게 다른 계좌를 소모하게 만든다. 본 ADR은 계좌 내
   backoff를 보존하는 보수적 선택을 하고, 핀 단축은 실측 후 별도 결정으로 미룬다.

2. **failover 없이 요청을 재큐잉(deferral처럼).** 이미 시작된 요청을 다시 큐 뒤로
   보내면 caller의 `await`가 늘어지고 원인 에러가 가려진다. degrade 경로가 원인을
   못 보므로 기각.

3. **시도 상한을 고정 N회로.** 계좌 수와 무관한 상수는 계좌 추가 시 재튜닝이
   필요하고, cooldown 배제가 이미 자연 상한을 주므로 불필요. `len(configured)`가
   정확한 상한이다.
