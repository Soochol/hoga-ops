# 0031 — Retry는 `/items`와 분리된 전용 엔드포인트 (`POST /api/captures/items/retry`)

**Status:** accepted (2026-05-25)

**Related:**
- ADR-0006 — captures는 단일 모듈로 유지
- ADR-0019 — Capture Queue 매니페스트 영속화 (attempt 필드의 backward-compat 근거)
- `docs/superpowers/specs/2026-05-25-retry-failed-bulk-design.md` — 본 ADR이 근거를 보존하는 spec

## Decision

`Capture Queue`의 failed 아이템을 다시 돌리는 동작(**Retry**, CONTEXT.md 용어)은 **새 전용 엔드포인트** `POST /api/captures/items/retry`로 분리한다. 기존 `POST /api/captures/items`는 *신규 enqueue 전용*으로 의미를 좁힌다.

Retry 엔드포인트는:

1. `item_ids: list[str]` 를 받아 각 `item_id`를 `_done`에서 lookup한다.
2. `phase != "failed"` 인 항목은 `skipped` 응답으로 분류 (not_found / not_failed / already_in_queue / already_running).
3. 매칭된 항목을 `_done`에서 제거 → 새 `QueueItemState(attempt = prior + 1, force_retry = prior.force_retry)` 로 enqueue.
4. 결과로 `CaptureDismissedEvent(item_ids=...)` + `CaptureQueuedEvent(items=...)` 두 이벤트를 발행해 프런트가 (a) 기존 failed 행을 즉시 제거하고 (b) 새 행을 표시하도록 한다.

단일 행 ↻와 헤더 "Retry Failed" 버튼은 **같은 엔드포인트**를 호출한다 — 차이는 `item_ids` 길이뿐.

## Why

세 가지 동작이 한 와이어에서 갈라진다:

- `/items` (신규 enqueue): `(code, dates[])` 입력 + KRX 캘린더 확장 + Q14 today-too-early 가드 + `_queue ∪ _active ∪ _inflight_paths` dedupe.
- Retry: `item_ids[]` 입력 + `_done` lookup + phase 검증 + attempt arithmetic + `_done`에서 제거 + 새 항목 enqueue.

이 둘을 한 엔드포인트의 mode flag(예: `mode: "new" | "retry"`)로 합치는 안과 비교해서:

1. **Request 스키마가 양립 불가.** `/items`는 `(code, dates)` 또는 `(code, start_date+end_date)` 를 받고, Retry는 cross-code `item_ids[]`를 받는다. mode flag 안에서는 사실상 서로를 무시하는 두 union 멤버가 한 모델에 공존하게 됨 — pydantic discriminated union으로 강제할 수 있지만 그러면 *결국 두 엔드포인트와 같은 비용을 한 endpoint에 응축*한 셈.

2. **응답 스키마도 다르다.** `/items`는 `EnqueueResponse(enqueued, deduped)`; Retry는 `RetryResponse(enqueued, skipped)`. skip 사유 집합이 다르고(`already_running` 같은 공유 사유 + `not_found`/`not_failed` 같은 Retry-only 사유), 클라이언트가 분기 처리해야 하는 형태가 본질적으로 다름.

3. **권한·감사·rate-limit 경계가 다를 수 있음.** 미래에 단일 사용자 가정이 풀려 권한 모델이 들어오면 "신규 작업 만들기"와 "기존 실패 재시도"는 다른 권한일 가능성이 높다. 단일 엔드포인트에 mode flag로 합치면 그 시점에 분리 비용을 다시 치러야 함.

4. **메소드 시그니처 명확성.** `/items/retry`는 와이어를 보는 사람에게 "이건 retry path" 라는 사실을 즉시 전달. mode flag는 한 단계 더 읽어야 함. CONTEXT.md의 **Retry** 용어와 1:1 매칭.

## Alternatives considered

### A. `POST /api/captures/items` 에 `mode: "new" | "retry"` flag 추가

같은 엔드포인트, request body discriminated union으로 분기.

Rejected: 위 "Why" §1–4. 요약 — 합쳤을 때 절약되는 코드는 `router.post()` 데코레이터 한 줄뿐이고, 비용은 (1) request/response 모델이 union으로 복잡해짐 (2) 핸들러 내부 분기가 두 거의 무관한 코드 경로를 한 함수에 압축 (3) 미래 변경 시 두 경로 모두 영향받지 않는지 확인하는 부담.

### B. Retry를 `POST /api/captures/items/{item_id}/retry` 로 per-item 엔드포인트화

각 행마다 별도 HTTP 호출. 백엔드 핸들러 시그니처가 가장 단순.

Rejected:

- "Retry Failed" 일괄 동작이 N개의 동시 HTTP 호출이 되어 race + ordering 문제. 100개를 순차로 보내면 사용자 체감 지연이 큼.
- 백엔드 입장에서 한 lock 안에서 N개를 처리하는 게 더 atomic — 중간에 cookie-expired pause가 끼어들지 않도록.
- SSE 이벤트도 N번 발행되어 프런트 reconciliation 비용 증가.

### C. 아예 엔드포인트 추가 없이 `addItems`로 재호출 (현재 ↻ 동작)

신규 endpoint 없음. 사용자가 retry할 때 기존 `addItems` 가 호출되어 새 `QueueItemState`가 생성됨. 기존 failed 행은 그대로 `_done`에 남음.

Rejected: 이게 바로 spec이 풀려는 문제. 같은 (code, date)가 active와 done에 동시에 나타나는 중복 행 문제 + attempt 카운팅 부재 + bulk 동작 부재. 본 ADR과 spec이 **이 안의 결과를 명시적으로 거부**.

### D. `POST /api/captures/items/retry-all-failed` 같은 의미 전용 엔드포인트

bulk 동작만을 위한 별도 엔드포인트, 단일 행은 여전히 `addItems`.

Rejected: 단일 retry와 bulk retry의 의미가 동일(같은 `_done → _queue` 재배치 + attempt+1)인데 두 코드 경로로 갈라 놓을 이유 없음. `item_ids: list[str]` 한 형태가 1개부터 N개까지 자연스럽게 처리.

## Consequences worth flagging for future readers

- **`_done`의 권위 강화.** 본 결정으로 `_done`이 retry 결정의 근거가 된다. 이제 dismissDone 시점 / 빈도가 사용자 retry UX에 영향을 줌 — dismiss하면 retry 불가. ADR-0019의 "done은 휘발성" 결정과 정합 (pause_origin 항목 제외).

- **attempt 필드는 manifest schema_version을 bump하지 않는다.** 순수 additive + pydantic default(`1`)로 backward compatible. ADR-0019의 quarantine 메커니즘이 막으려던 형태(파괴적 변경)와 다름. 향후 manifest 변경이 backward-incompatible할 때만 schema_version=2로 올림.

- **CaptureDismissedEvent의 두 번째 호출자.** 현재 spec은 Retry 경로에서만 발행. `dismissDone` 핸들러도 같은 이벤트를 발행하도록 전환하는 후속 작업이 자연스럽게 따라옴 — 코드 경로 단일화 + 프런트 invalidate backstop 제거 가능. 별도 ADR 없이 적용 가능한 cosmetic refactor.

- **`addItems`는 여전히 `_done`을 dedupe 검사하지 않는다.** 사용자가 date range로 재투입할 때 failed 행과 중복 발생 가능. 본 ADR은 *Retry*의 길을 닦았을 뿐 *신규 enqueue*가 stale failed와 충돌하는 더 넓은 문제는 풀지 않음. "Retry가 정공법"이라는 정책으로 회피 — 사용자가 같은 (code, date)를 재투입하고 싶으면 dismissDone 또는 Retry를 사용.

- **단일 사용자 가정.** 동시에 두 사용자가 같은 item_id에 Retry를 호출하는 시나리오는 고려하지 않음. `_lock` 안에서 second caller는 `not_found`로 응답받음 — 안전하지만 우아하지 않음. ADR-0019의 single-worker 가정과 동일 경계.

## When to revisit

- 다중 사용자 또는 다중 워커 시나리오가 등장 — retry 동시 호출 시 응답 의미 (`not_found` vs "이미 다른 사용자가 retry함") 구분 필요.
- attempt 카운트에 정책(예: 최대 3회, exponential backoff)이 추가될 때 — 본 ADR의 "no cap" 입장이 깨짐. 별도 ADR로 정책 결정.
- `skipped` 항목 일괄 force-retry UX가 추가될 때 — Retry 엔드포인트를 확장할지(`force_retry_override` 파라미터?) 별도 엔드포인트로 갈지 결정 필요.
- `dismissDone`이 `CaptureDismissedEvent`로 통합될 때 — 본 ADR의 "두 번째 호출자" 노트 해소.
