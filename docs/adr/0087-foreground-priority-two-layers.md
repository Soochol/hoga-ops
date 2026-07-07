# 0087 — Foreground 우선순위는 두 계층이 나눠 소유한다 (스케줄러 rank + 토큰버킷 lane)

**Status:** accepted (2026-07-07)

**Related:**
- ADR-0050 — KIS rate-limit retry는 `KisClient._get`에 내장(토큰버킷 소유)
- ADR-0082 — `KisCapacityScheduler` + `KisAccountPool`이 계좌 인지형 REST 스케줄링
- ADR-0086 — rate-limit 소진 시 계좌 failover

## Context

"사용자 가시 작업(차트 클릭)을 background 폴링보다 우선한다"는 정책이 코드의 **두
곳**에 존재한다:

1. **스케줄러 rank** (`KisCapacityScheduler`, 2026-06-27, ADR-0082) —
   `user_visible` 요청은 rank 0, `background`는 rank 10으로 우선순위 큐에 들어간다.
   워커가 background 요청을 집을 때 `_has_queued_user_visible()`이면 그 background를
   다시 큐 뒤로 미룬다(디스패치 지연).

2. **토큰버킷 foreground lane** (`_TokenBucket.acquire(foreground=)`,
   `kis_client.py`, 2026-06-09, ADR-0050 영역) — 한 계좌의 15/s 버킷에서
   `foreground=True` 획득자가 대기 중이면 background 획득자는 사용 가능한 토큰을
   양보하고 `_FG_YIELD_S`마다 재확인한다(기아 방지 백스톱 `_BG_MAX_YIELD_S`).

리팩터링 리뷰에서 "같은 정책이 두 곳에 있으니 중복 아닌가 — 하나로 합치거나 삭제할
수 있지 않나"라는 질문이 제기되었다. 조사 결과 **중복이 아니라 서로 다른 계층을
덮는 보완재**임이 확인되어, 미래 리뷰어가 한쪽을 중복으로 오인해 삭제하지 않도록
소유권을 명시한다.

## Decision

두 장치를 **모두 유지**하고, 각자의 소유 범위를 다음과 같이 확정한다:

- **스케줄러 rank = 디스패치 순서.** 요청이 워커 슬롯과 계좌 lease를 **획득하기
  전**의 순서를 정한다. 한 번 디스패치되어 `request.call(client)`에 들어가면
  스케줄러는 그 요청의 진행에 더는 관여하지 않는다.

- **토큰버킷 foreground lane = 토큰 획득 순서.** 이미 디스패치되어 **동시에
  실행 중인** 요청들이 같은 계좌의 단일 버킷에서 토큰을 다툴 때의 순서를 정한다.

이 둘은 시간축의 다른 구간(dispatch-time vs in-flight token-grant-time)을 덮으므로
어느 하나가 다른 하나를 대체할 수 없다.

## Why 중복이 아닌가 — 결정적 시나리오

**단일 계좌 구성**(KIS 키 1개 — 대다수 사용자)에서:

- `KisAccountPool.reserved_background_capacity_available`는 `eligible_accounts <= 1`일
  때 항상 `True`를 반환한다 → 예약 게이트가 no-op. 모든 foreground/background가
  account 0의 **단일 버킷을 공유**한다.
- `max_workers = clamp(1*8, 4, 64) = 8`이므로 최대 8개 요청이 account 0에서 동시
  실행된다. 예: background walkback 페이지 7개가 in-flight인 상태에서 사용자가
  차트를 클릭해 foreground past-candles 요청이 도착.
- 스케줄러 rank는 **아직 큐에 있는** background만 미룰 수 있다
  (`_has_queued_user_visible`). 이미 실행 중인 7개 background의 토큰 획득 순서는
  스케줄러의 관할 밖이다.
- 이때 **버킷 lane이 유일한 우선순위 장치**다: foreground의 토큰 획득이 7개
  background 앞으로 점프한다. lane을 삭제하면 단일 계좌 사용자는 실행 중 경합에서
  foreground 우선순위를 통째로 잃는다.

즉 스케줄러 rank가 있어도 버킷 lane은 삭제 불가다. 반대로 다계좌에서는 스케줄러의
예약 게이트가 foreground용 계좌를 비워둬 경합 자체를 줄이지만, 버스트로 foreground와
background가 같은 계좌에 collocate되는 경우까지 없애지는 못한다 — 그 잔여 경합을
버킷 lane이 덮는다.

## Consequences

- `foreground=` kwarg가 `KisClient`의 여러 fetch 메서드 시그니처를 관통하는 것은
  버킷 lane에 도달하기 위한 필수 배선이며, 제거 대상이 아니다.
- 우선순위 튜닝 파라미터가 두 계층에 나뉘어 있다(`rank`/deferral vs
  `_FG_YIELD_S`/`_BG_MAX_YIELD_S`). 이는 두 계층이 서로 다른 것을 튜닝하기 때문이며
  (디스패치 공정성 vs 토큰 양보 간격), 통합 대상이 아니다.
- 미래에 "우선순위 버그"를 조사할 때는 **어느 계층의 문제인지 먼저 판별**한다:
  요청이 아예 늦게 시작되면 스케줄러 rank, 시작은 됐는데 토큰을 늦게 받으면 버킷
  lane.

## Alternatives Considered

1. **버킷 lane 삭제, 스케줄러 rank만 유지.** 단일 계좌에서 실행 중 경합의
   foreground 우선순위가 사라진다(위 시나리오). 기각.

2. **스케줄러 rank 삭제, 버킷 lane만 유지.** 디스패치 단계에서 background가
   foreground보다 먼저 워커/계좌를 점유하는 것을 못 막는다 — 특히 background가
   pending 한도를 채우면 foreground가 큐에 갇힌다. 기각.

3. **두 계층을 하나의 우선순위 추상으로 통합.** 디스패치 순서와 토큰 획득 순서는
   서로 다른 자원(워커 슬롯 vs rate 토큰)에 대한 것이라, 하나의 추상으로 묶으면
   각 계층의 계약이 흐려지고 오히려 인터페이스가 커진다. 현 분리가 각 계층을 얇게
   유지한다. 기각.
