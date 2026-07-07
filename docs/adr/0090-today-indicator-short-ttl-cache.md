# 0090 — 오늘자 지표 short-TTL 캐시 (ADR-0043 보완)

**Status:** accepted (2026-07-07). ADR-0043 "오늘 무캐시" 계약을 보완하는 정책 변경으로,
사용자 승인(PR #444 main 머지 지시)을 받아 accepted 전환.

**Related:**
- ADR-0043 — Today indicators recompute live, never persisted (이 ADR이 보완하는 계약)
- ADR-0085 — DuckDB resource bounds + peak-query concurrency guard (single-flight 도입, 이 ADR이 메우는 순차-반복 구멍)
- ADR-0084 — Event-based peak wall classification (재계산 비용이 큰 대상 쿼리)

## Context

ADR-0043은 오늘(promote 중) Stock-Date의 지표를 **캐시하지 않는다** — 폴링 간 stale
스냅샷에 갇히는 것을 구조적으로 배제하기 위해서다. ADR-0085의 single-flight + 세마포어는
**동시** 중복 계산만 접는다(같은 key의 in-flight 컴퓨트 1회로 병합).

남은 구멍은 **순차** 반복이다:

- 관심종목을 오가는 심볼 전환 버스트 — 같은 `(code, 오늘)`을 초 단위 간격으로 다시 계산.
- refetch 주기가 어긋난 다중 클라이언트 — 각자 다른 시점에 같은 오늘자 슬라이스를 재계산.

이때 peak-wall dual(ADR-0084/0085, 최악 4.3s/0.72GB), 호가비, 체결강도가 매번 재계산된다.
single-flight는 "지금 이 순간 동시에 도는 동일 컴퓨트"만 잡으므로, 시간차를 둔 반복은
통과시킨다.

## Decision

오늘자 지표 계산 결과에 **프로세스 내 short-TTL 캐시**(기본 15,000ms,
`HOGA_TODAY_INDICATOR_TTL_MS`, `0`=완전 비활성=ADR-0043 원 동작)를 둔다.

- **적용 지점**: bundle의 오늘 경로 3곳 — `build_quote_ratio_slice`,
  `build_fill_strength_slice`, `build_ask_bid_peak_slices`(dual). 과거일은 기존
  `PastIndicatorsCache`가 그대로 관할(이 캐시 미적용).
- **키에 date 포함** → 자정 경계에서 자연 무효화. 만료 항목은 put 시 선형 스캔으로 정리
  (키 스코프가 `(kind, code, 오늘, …)`이라 개수가 작고 put 빈도도 TTL당 1회 수준).
- **staleness 상한 = TTL(15s) ≪ /live 오늘 범위 refetch 주기(5분,
  `TODAY_RANGE_REFETCH_MS`)**. ADR-0043의 목적(폴링이 낡은 스냅샷에 **갇히는** 것 방지)은
  유지된다 — 갇힘이 아니라 최대 15초 지연이며, 다음 refetch 주기(5분)의 1/20이다.

## Consequences

- 심볼 전환·다중 클라이언트 버스트에서 오늘자 지표 재계산이 **TTL당 1회로 접힌다**
  (peak-wall 4.3s 재계산 반복 제거가 가장 큰 이득).
- 새 운영 노브 1개(`HOGA_TODAY_INDICATOR_TTL_MS`). `0`으로 내리면 ADR-0043 원 동작 즉시 복귀.
- 캐시는 **프로세스 로컬** — 멀티 워커 배포에서는 워커당 독립(허용; 워커 간 공유는 비목표).
- ADR-0043은 폐기되지 않고 **보완**된다: "영속화하지 않는다"는 그대로, "메모리에서도 절대
  재사용하지 않는다"만 "최대 15초 재사용"으로 완화.

## Alternatives considered

- **기본 TTL=0(비활성)으로 머지 후 env로 활성화**: 코드 랜딩과 정책 활성화를 분리하나,
  "승인 = 머지"라는 단순 게이트를 흐린다(추가 ops 액션 필요). 기본 15s + proposed 상태로
  두어 "정책 승인 → accepted 전환 + 머지"가 유일한 남은 단계가 되게 했다.
- **single-flight의 in-flight 윈도우 연장**: 순차 반복을 못 접는 근본 한계는 그대로.
