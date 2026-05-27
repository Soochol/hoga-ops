# 0036 — 로컬 전용 배포: retry/enqueue 상한 미설정

**Status:** accepted (2026-05-27)

**Related:**
- ADR-0031 — POST /api/captures/items/retry (Explicit Retry endpoint)
- ADR-0033 — `addItems` phase-aware `_done` dedupe
- ADR-0035 — `done + force_retry` Implicit Retry
- `~/.gstack/projects/.../2026-05-27-review-audit.md` — 본 ADR이 응답하는 review finding

## Decision

`hoga-ops`는 **로컬 단일 사용자 배포 전용**이며, 다음 두 자원 제한을 의도적으로 두지 않는다:

1. **`_retry_items`의 MAX_ATTEMPTS** — `attempt` 카운터는 retry 시마다 증가하지만 상한 없음. ADR-0035의 Implicit Retry(done+force_retry → 자동 재큐)와 결합되어도 무한 루프 가드를 backend에 두지 않는다.
2. **`enqueue_items_core`의 batch size cap** — `req.dates` 또는 `start_date..end_date` 확장 결과의 길이에 상한 없음. `19000101..20991231` 같은 입력은 ~30k QueueItem을 생성할 수 있다.

대신 다음 외부 layer가 사실상의 cap 역할을 한다:

- **프론트엔드 UI**: retry/enqueue trigger는 모두 사용자 명시적 클릭 (Per-row ↻, "지금 전체 수집", inventory Re-capture all). UI가 무한 루프 트리거를 만들지 않는다.
- **KRX upstream rate limit**: 호스트 자체가 과한 요청을 거절. `KrxUnavailableError`로 노출되어 retry 큐가 자연 정체.
- **사용자 가시성**: ×N attempt 배지(ADR-0031)가 모든 row에 노출되어 비정상 retry는 즉시 보임.

## Why

리뷰(`/review` 2026-05-27)에서 두 finding이 CRITICAL로 보고됨:
- *"_retry_items has NO upper bound on attempt"* (confidence 8)
- *"enqueue_items_core does not bound candidate_dates length"* (confidence 8)

각각 별도 정책 결정 후 **현 상태 유지 + ADR 명문화**로 마감.

### MAX_ATTEMPTS를 두지 않는 이유

1. **자동 트리거 부재**: retry를 발화하는 코드 경로 3개(`/api/captures/items/retry` 라우트, `addItems` 자동 재큐, ADR-0035 Implicit Retry)는 모두 사용자 명시적 액션이 시작점. 백엔드 자체가 retry를 polling하지 않는다.
2. **MAX_ATTEMPTS=N 도입 시 새 silent-failure 가능성**: `attempt >= N`이면 `skip_reason='max_attempts_exceeded'`로 분기해야 하는데, 사용자는 "왜 ↻ 버튼이 무반응이지?"라는 UX 함정에 빠짐. 명확한 메시지 표시 UI 추가 작업이 정책 채택 비용을 압도.
3. **로컬 환경의 rate-limit 자연 동작**: 5번 연속 실패하는 시나리오는 거의 항상 KRX 자격증명 만료 / 네트워크 단절 — 둘 다 `KrxUnavailableError`로 사용자가 즉시 인지.

### batch size cap을 두지 않는 이유

1. **악의적 입력 불가**: 단일 사용자 로컬 배포에서 누가 19000101..20991231을 입력하겠는가? 실수로 그랬다면 즉시 Ctrl+C로 취소 가능.
2. **메모리 폭주 임계**: 30k QueueItem = ~30MB (각 ~1KB) — 현대 머신에서 무의미한 부하. SSE 폭주는 frontend가 invalidate로 흡수.
3. **413 Payload Too Large 도입 시 비용**: 정당한 backfill(~5년치 ≈ 1250) 요청이 거절될 위험. 사용자에게 cap을 알려주는 UI 가이드 필요. 정책 채택 비용 > 위험.

## Trigger Conditions (cap을 도입할 미래 시그널)

다음 중 하나라도 만족 시 본 ADR을 supersede하고 cap을 도입해야 한다:

- **Multi-user 배포 검토**: 한 사용자의 무제한 retry가 다른 사용자의 KRX quota를 갉아먹는 시나리오 등장 시.
- **백엔드 자동 retry loop 추가**: 사용자 액션 없이 백엔드 자체가 retry를 발화하는 경로가 생기면 (e.g., scheduled retry on transient errors) MAX_ATTEMPTS 필수.
- **재현 가능한 메모리 / SSE 폭주 사고**: 단일 enqueue가 시스템 응답성을 죽인 incident가 발생하면 batch cap 도입.

## Code references (no changes)

- `hoga/api/captures.py:_retry_items` — `attempt=target.attempt + 1`, 상한 없음.
- `hoga/api/captures.py:enqueue_items_core` — `candidate_dates` 길이 제한 없음.

본 ADR은 코드 변경 없이 정책 결정만 기록한다.
