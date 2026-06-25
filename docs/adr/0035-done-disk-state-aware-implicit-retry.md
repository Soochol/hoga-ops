# 0035 — `phase=done + force_retry=true` Implicit Retry 허용 (인벤토리 재캡처 트리거)

**Status:** accepted (2026-05-26) — superseded by ADR-0081

**Related:**
- ADR-0033 — `addItems`의 phase별 `_done` dedupe (본 ADR이 확장)
- ADR-0031 — Retry endpoint 분리 (Explicit Retry는 `failed`-only로 유지)
- ADR-0019 — Capture Queue 매니페스트 영속화 (`_done` 휘발성)
- ADR-0007 — `disk_state` 모듈 분리
- `docs/superpowers/specs/2026-05-26-inventory-recapture-design.md` — 본 ADR의 트리거가 된 인벤토리 UX

## Decision

`POST /api/captures/items`의 `_done` dedupe 분기 (ADR-0033의 step 3b)에서 `old.phase == "done"`이고 `req.force_retry=True`이면 **`already_complete`로 dedupe하지 않고 auto re-enqueue**한다 (attempt+1, 기존 `failed`/`cancelled`/`skipped+force_retry` 분기와 동일 메커니즘). `force_retry=False`인 경우는 ADR-0033대로 `already_complete`로 dedupe (기존 동작 유지).

`captures.py:1112-1141`의 조건만 한 줄 추가:

```python
if (old.phase in ("failed", "cancelled")
        or (old.phase == "skipped" and req.force_retry)
        or (old.phase == "done" and req.force_retry)):  # ADR-0035
    # auto re-enqueue (attempt+1)
```

`EnqueueDedupedRow.reason`에는 변화 없음 (`already_complete` 라벨은 `force_retry=False`일 때만 도달).

CONTEXT.md `Retry` 항목의 Implicit Retry 표를 갱신해 `done + force_retry` 케이스를 명시한다.

## Why

ADR-0033은 두 가지 암묵적 가정 위에 세워졌다:

1. **"phase=done = 디스크 데이터가 complete"** — 그래서 `done` 행은 보호 대상으로 항상 dedupe.
2. **"사용자가 force_retry=true를 보내는 의도는 sentinel / source_partial 우회"** — COMPLETE 우회는 아님.

가정 #1은 거짓이다. `decide_capture`는 다음 비-COMPLETE 디스크 상태에 대해 worker를 `phase=done`으로 종결시킨다 (`eligibility.py:74-89`):

- `DiskState.CLIENT_INCOMPLETE` → resume=True로 진행, worker가 끝까지 도달하면 `done` (디스크는 여전히 client_incomplete일 수 있음).
- `DiskState.INVALID` → fresh로 진행, worker가 끝까지 도달하면 `done` (디스크는 여전히 invalid일 수 있음).
- `DiskState.SOURCE_PARTIAL + force_retry` → fresh로 진행, worker가 partial로 끝나면 `done` + disk=source_partial.

즉 **`phase=done`인 `_done` 엔트리의 `disk_state`는 `complete`가 아닐 수 있다.** 사용자가 그런 행을 인벤토리에서 발견하고 재캡처를 명령할 때, ADR-0033은 silent하게 `already_complete`로 막는다 — 가장 나쁜 종류의 사일런트 버그.

가정 #2도 인벤토리 컨텍스트에서는 옳지 않다. 인벤토리 UI는 **"이 디스크 행은 정상이 아니다, 다시 해라"**는 명시적·맥락적 사용자 의도. `force_retry=true`를 이 의도의 와이어 표현으로 사용하는 것이 자연스럽다.

ADR-0033의 보호 목적("성공한 캡처를 무심코 덮어쓰지 않기")은 **`decide_capture` 레이어에서 여전히 작동**한다:

- `disk_state == COMPLETE + force_retry=True` → worker가 `decide_capture`를 거치면서 `skipped/already_complete`로 즉시 종료 (`eligibility.py:76-77`). 데이터 손실 없음.
- 즉 ADR-0035는 `decide_capture`라는 정밀한 게이트에 의존해 enqueue 레이어의 거친 게이트를 완화. 데이터 안전성은 보존되고, 사일런트 no-op만 제거.

비용: COMPLETE 디스크 행을 잘못 보낸 경우 큐 한 사이클의 SSE noise (queued → deciding → skipped). 프런트엔드는 `EnqueueResponse.enqueued`가 비어있지 않은 응답을 받고, 잠시 후 `capture_finished{phase=skipped, skip_reason=already_complete}` SSE를 받는다. 인벤토리 UI는 complete 행에 체크박스를 노출하지 않으므로 실제로 이 케이스에 도달하기 어렵지만, race 조건(SSE로 complete가 된 직후 사용자가 선택 상태로 submit)을 견딘다.

## Alternatives considered

### A. 새 endpoint `POST /api/inventory/recapture`

인벤토리 재캡처를 별개의 도메인 작업으로 분리, `_done` dedupe를 우회하고 디스크의 `meta.json`을 SSOT로 사용해 fresh 캡처 트리거.

Rejected:

- ADR-0033의 Implicit Retry 의미와 동형인 작업을 다른 이름으로 두 번 구현 → 분기 폭발.
- CONTEXT.md `Retry` 정의가 두 endpoint를 이미 묶고 있는데, 셋째 endpoint를 추가하면 도메인 어휘가 흐려짐.
- attempt 카운팅 / SSE 이벤트 / dedupe 규칙을 별도로 유지 → ADR-0033의 모든 후속 변경을 두 곳에 적용해야 함.

### B. 프런트엔드에서 `dismissDone(item_ids)` + `addItems` 2-스텝

인벤토리에서 매칭되는 `_done` 엔트리를 먼저 dismiss하고 fresh enqueue.

Rejected:

- 현재 `DELETE /api/captures/done`은 전체 done 버킷을 쓸어버림 — item_id 단위 dismiss 엔드포인트가 없음. 새 엔드포인트 추가 비용 + race 윈도우.
- "프런트엔드가 두 호출의 원자성을 책임진다" → 백엔드의 single-lock 보장(ADR-0033)에서 후퇴.
- 새 엔드포인트가 결국 백엔드 변경이라면, 본 ADR의 한 줄 추가가 훨씬 작은 변화.

### C. ADR-0033 dedupe에서 `disk_state` 실시간 조회

step 3b에서 `phase=done` 분기 시 `check_disk_state(code, date)`를 호출해 actual disk_state를 보고 분기.

Rejected:

- 단일 enqueue 호출에 N건이 들어오면 N번 디스크 stat — `_lock` 안에서 I/O하는 패턴은 ADR-0017 throughput 결정과 충돌.
- `decide_capture`는 이미 worker에서 disk_state를 본다. enqueue에서 두 번 보는 것은 책임 중복.
- 본 ADR의 단순 분기 + `decide_capture` gate가 같은 의미를 더 적은 비용으로 달성.

### D. `decide_capture`가 COMPLETE 우회를 honor하도록 확장 (ADR-0033 "When to revisit"의 시나리오)

`force_retry=true`이면 worker가 COMPLETE 디스크라도 fresh 캡처. 디스크 정리(parquet 삭제, raw 페이지 정리) 추가.

Rejected (out of scope):

- ADR-0033 본문에서 별도 ADR로 미뤄둔 시나리오. 데이터 손실 리스크, idempotency, 부분-write 처리 등 별도 설계.
- 인벤토리 재캡처는 non-complete 디스크만 다루므로 이 확장이 불필요. 별도 트리거(예: 사용자가 명시적 force-overwrite를 누름)가 생기면 그때 재검토.

## Consequences worth flagging for future readers

- **ADR-0033의 dedupe 표가 한 줄 진화.** 향후 변경자는 ADR-0033 + 0035를 함께 읽어야 정확한 분기를 얻음. CONTEXT.md `Retry` 항목이 통합 표 SSOT.
- **`decide_capture` 게이트의 책임 증가.** 인벤토리에서 잘못 보낸 COMPLETE 행을 막는 마지막 방벽이 `decide_capture`. eligibility.py:76-77이 회귀하면 데이터 손실 가능. 테스트로 못박는다.
- **SSE noise 가능성.** complete 행이 큐를 한 사이클 통과. 프런트엔드는 `attempt > 1 + result == None + phase == skipped` 조합을 정상 종료로 표시하면 사용자 혼란 없음.
- **`pause_origin`은 영향 없음.** `done` 행은 `pause_origin`을 가지지 않으므로 ADR-0019/0033의 pause 흐름과 직교.
- **attempt 누적 일관성.** 인벤토리 트리거든 captures form 재제출이든 attempt+1이 동일하게 적용 — ADR-0033의 trigger-agnostic 원칙 유지.

## When to revisit

- COMPLETE 데이터의 honest 재캡처 기능이 필요해질 때 — Alternative D 재검토.
- 사용자가 `_done` 버킷의 보호 의도를 명시적으로 우회하는 별도 트리거를 원할 때 — `force_retry`의 의미가 한 번 더 분기될 수 있음.
- 인벤토리 재캡처 외에 `phase=done + non-complete disk`를 다루는 새 use-case가 생길 때.
