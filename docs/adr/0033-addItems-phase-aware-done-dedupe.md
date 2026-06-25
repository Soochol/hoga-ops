# 0033 — `addItems`가 `_done`을 phase별로 dedupe (Implicit Retry path)

**Status:** accepted (2026-05-25) — force-gated dedupe table superseded by ADR-0081

**Related:**
- ADR-0019 — Capture Queue 매니페스트 영속화 (pause_origin carve-out 맥락)
- ADR-0031 — Retry는 `/items`와 분리된 전용 엔드포인트 (Explicit Retry 도입)
- `docs/superpowers/specs/2026-05-25-addItems-done-dedupe-design.md` — 본 ADR이 근거를 보존하는 spec

## Decision

`POST /api/captures/items`(`enqueue_items`)의 dedupe 루프를 `_queue ∪ _active ∪ _inflight_paths` 외에 **`_done`까지 확장**한다. 매칭은 `(code, date)` 키. `old._done.phase`와 `request.force_retry`에 따라 행동이 갈린다:

| `old.phase` | `force_retry=false` | `force_retry=true` |
|---|---|---|
| `failed`    | auto re-enqueue (attempt+1) | auto re-enqueue (attempt+1) |
| `cancelled` | auto re-enqueue (attempt+1) | auto re-enqueue (attempt+1) |
| `done`      | dedupe `already_complete`   | dedupe `already_complete` (always) |
| `skipped`   | dedupe `already_skipped`    | auto re-enqueue (attempt+1) |

auto re-enqueue 시 backend:
1. `_done`에서 old row 제거(루프 종료 후 일괄 삭제).
2. 새 `QueueItemState`를 `attempt = old.attempt + 1`, `force_retry = request.force_retry`(old의 것이 아님)로 `_queue`에 append.
3. lock 해제 후 `CaptureDismissedEvent` → `CaptureQueuedEvent` 순서로 발행.

`EnqueueDedupedRow.reason` Literal에 `"already_complete"`, `"already_skipped"` 추가.

CONTEXT.md **Retry** 용어는 이 동작을 "Implicit Retry path"로 포함하도록 갱신.

## Why

ADR-0031의 Explicit Retry는 사용자가 ↻ 버튼을 누른 경우만 처리한다. 그러나 실제 사용 패턴에서는 **사용자가 date range를 의도적으로/실수로 재제출**하는 케이스가 흔하다 — 예: "원래 18-25를 캡처하다 일부 실패. 며칠 후 15-30으로 범위 확장하려고 입력". 현재 dedupe는 `_done`을 보지 않아 18-25의 failed 행이 그대로 남고 새 row가 추가되어 동일 (code, date) 두 행이 공존.

이 ADR은 "addItems도 implicit retry를 한다"는 선택. 핵심 근거:

1. **사용자 의도 추론.** 사용자가 (code, date)를 명시적으로 다시 요청하면, 거의 항상 "기존 failed/cancelled 행은 다시 시도해 줘"가 의도. 무시하고 dedupe만 하면 2-스텝(`dismissDone` + `addItems`) 강요.
2. **`done`만은 보수적.** 성공한 캡처는 디스크 데이터가 가치 있는 자원. 실수로 덮어쓸 가능성을 차단하기 위해 force_retry와 무관하게 `already_complete`로 dedupe. 진짜 재캡처하려면 별도 mechanism(현재 없음; future ADR로 force_retry 의미 확장 가능).
3. **`skipped`는 force_retry 의미와 정렬.** `no_upstream_data` / `source_partial` skip은 `decide_capture`에서 `force_retry=true`로 의미 있게 우회됨. 따라서 force_retry 켜진 재제출은 실제로 다른 결과 가능 → auto re-enqueue. force_retry 꺼진 재제출은 같은 sentinel로 다시 skipped → dedupe.
4. **`failed`/`cancelled`는 무조건 retry.** 이전 시도가 데이터를 안 남겼으므로 force_retry와 무관하게 다시 시도하는 게 항상 옳음.

## Alternatives considered

### A. 변경 없음 — 프런트엔드에서 확인 다이얼로그

사용자가 `addItems` 제출 시 클라이언트가 `_queue.done`을 검사해서 겹치는 (code, date) 있으면 confirm modal 표시.

Rejected:

- 사용자가 Confirm 누르면 backend에서 여전히 중복 행 생성 → 근본 해결 X.
- UI 복잡성 증가(modal, batch 분기 처리).
- "거기 있다는 사실"이 backend dedupe로 자연스럽게 노출되지 않음 — 응답 body의 `deduped` 리스트라는 기존 메커니즘을 우회.

### B. `_done` 전체를 항상 dedupe (force_retry 무시, phase 무관)

가장 단순한 룰. 모든 `_done` 매칭은 `already_in_done` 같은 단일 사유로 dedupe.

Rejected:

- "fail됐는데 다시 돌려줘"라는 가장 흔한 사용자 의도를 막음. dismissDone + addItems 2-스텝 강요.
- "내 의도는 force_retry로 sentinel 무효화"라는 명시적 의도도 막음.
- 보수적이지만 UX 친화도 낮음.

### C. `_done` 전체를 항상 auto re-enqueue (phase 무관)

모든 `_done` 매칭 = old 행 제거 + 새 enqueue.

Rejected:

- `done` 행(성공한 캡처)을 무심코 덮어쓰는 위험. 사용자가 단순 range 재제출만 했는데도 모든 done 행이 재캡처 → 의도하지 않은 결과.
- 현재 `decide_capture`는 COMPLETE 상태에서 force_retry를 무시하므로 실제로는 새 행이 즉시 skipped로 끝남 → SSE 노이즈만 발생 (실질 재캡처 안 일어남). 사용자에게 "재캡처됐다"는 잘못된 인상.

### D. force_retry 의미를 확장해서 `decide_capture`에서도 COMPLETE 우회

`done + force_retry=true` 케이스를 honest 재캡처로 만들려면 `decide_capture`가 COMPLETE 상태에서도 force_retry를 honor하도록 변경 + 디스크 정리(parquet 삭제, raw 페이지 정리) 추가.

Rejected (out of scope, deferred):

- 별도 ADR이 필요한 큰 변경. 데이터 손실 리스크, idempotency, 부분-write 처리 등 별도 설계 필요.
- 본 ADR에서 다루지 않고 spec에 "future ADR" 노트로 남김. `done` 행은 보수적으로 dedupe.

## Consequences worth flagging for future readers

- **두 endpoint가 Retry를 트리거한다.** `/items/retry`(explicit)와 `/items`(implicit). 둘 다 같은 SSE 이벤트(`CaptureDismissedEvent` + `CaptureQueuedEvent`)와 attempt 증가 동작. 디버깅 시 어느 endpoint에서 왔는지 구분이 필요하면 SSE 페이로드만으로는 알 수 없음 — 로그를 봐야 함.

- **`EnqueueDedupedRow.reason` Literal 확장은 와이어 호환성 변화.** 기존 클라이언트가 unknown reason을 만나면 에러 처리할 수 있음. 본 repo의 frontend는 동시에 업데이트하므로 문제 없음.

- **`force_retry` 의미는 confused.** Request의 `force_retry`는 (a) `decide_capture`에서 sentinel/SOURCE_PARTIAL 우회 (b) 본 ADR의 `_done.skipped` 재시도 트리거 두 곳에서 쓰임. 하지만 `done` 케이스에선 무시됨. CONTEXT.md `force_retry` 정의를 정확히 따른 것 — sentinel/partial artifact 삭제. COMPLETE 데이터 덮어쓰기는 별개 기능.

- **`pause_origin` 항목은 cancelled 룰로 자연 흡수.** 별도 carve-out 없음. resume_queue는 addItems가 건드리지 않은 다른 pause_origin 항목들에 대해 여전히 작동.

- **attempt 카운터는 trigger-agnostic.** 사용자가 addItems로 재시도하든 ↻로 재시도하든 ×N 배지에 누적. "이 (code, date)가 N번째 시도"라는 의미가 일관됨.

- **`addItems` 응답의 `enqueued` 리스트는 이제 fresh + retried 혼재.** 둘을 구분하려면 `attempt` 필드 확인(>1이면 retried). 기존 클라이언트가 모든 enqueued를 "새 작업"으로 가정했다면 동작은 안 깨지지만 텍스트가 미묘하게 부정확할 수 있음. 본 repo의 frontend는 attempt 배지로 자연스럽게 표현.

## When to revisit

- COMPLETE 데이터의 honest 재캡처 기능이 필요해질 때 — `decide_capture` 의미 확장 + 디스크 정리 + 새 ADR.
- 두 호출자가 `EnqueueDedupedRow.reason`의 신규 값을 다르게 처리해야 할 때 — 와이어 contract 한 번 더 분기 고려.
- 다중 사용자 / 다중 워커 시나리오 — `_done` mutation 동시성 가정이 깨짐. ADR-0019/0031의 single-worker 가정과 동일 경계.
- attempt 카운터에 정책(최대 N회, backoff)이 추가될 때 — addItems와 explicit Retry 둘 다 정책 적용 시점 결정 필요.
