# 0034 — Scheduler는 Capture Queue의 클라이언트다 (peer가 아니다)

**Status:** accepted (2026-05-26)

**Related:**
- ADR-0005 — Capture state on event loop (단일 프로세스 asyncio 패턴)
- ADR-0006 — captures.py는 단일 모듈 유지
- ADR-0019 — Capture Queue 매니페스트 영속화
- ADR-0031 — Retry 엔드포인트 분리 (Explicit Retry)
- ADR-0033 — addItems가 `_done`을 phase별로 dedupe (Implicit Retry)
- `docs/superpowers/specs/2026-05-26-watchlist-daily-scheduler-design.md`

## Decision

**Daily Scheduler**와 **Catch-up Run**(이하 통칭 *Scheduler*)은 **Capture Queue**의 내부 컬렉션(`_queue` / `_active` / `_done` / `_inflight_paths`)을 직접 만지지 않는다. enqueue는 **반드시** `captures.enqueue_items_core(req, *, data_dir, now)`를 호출한다. `bump_last_success` 같은 watchlist 상태 갱신만이 Scheduler가 captures 모듈로부터 받는 콜백이며, 그 외에는 모두 단방향(Scheduler → enqueue_items_core).

이를 가능하게 하려면 현재 `captures.build_router` 내부 클로저인 `enqueue_items` 핸들러를 모듈 레벨 `async def enqueue_items_core(req: EnqueueRequest, *, data_dir: Path, now: datetime) -> EnqueueResponse`로 추출하고, 라우터 핸들러는 `data_dir = _require_data_dir()`, `now = _now_kst()`만 주입하는 3줄 wrapper로 남긴다.

Scheduler가 ADR-0033의 Implicit Retry 시맨틱과 Q14 가드(`today_too_early`)를 *공유*하되 *우회*하지 않는다는 게 핵심 invariant다. 단 하나의 의도된 carve-out: Scheduler는 `enqueue_items_core` 호출 *전에* `eligibility.find_ineligible_dates`를 직접 호출해 Q14에 걸릴 today를 *사전에 trim*한다. 이는 `enqueue_items_core`가 Q14 위반 시 전체 요청을 HTTP 400으로 reject하는 동작이 multi-day catch-up에 부적합하기 때문이다.

## Why

세 가지 대안을 검토했다.

**A. Scheduler가 self-HTTP request로 `POST /api/captures/items` 호출.**
같은 프로세스 안에서 자기 자신에게 HTTP를 쏘는 안티패턴. uvicorn 단일 워커 환경에서는 동작하지만 ASGI overhead, JSON 직렬화, error code parsing이 추가되고, 무엇보다 *함수 호출이면 충분한 것을 네트워크로 만든다*는 점에서 보수해야 할 표면이 늘어난다. 채택 안 함.

**B. Scheduler가 `_queue`에 직접 append + `_persist_queue_locked()` 호출.**
가장 직접적이지만 ADR-0033의 phase-aware dedupe, Q14 가드, attempt+1 카운팅, Implicit Retry 이벤트 발행(`CaptureDismissedEvent` → `CaptureQueuedEvent`) 전부를 Scheduler 측에서 재구현해야 한다. 미래 ADR이 enqueue 정책을 바꿀 때마다 두 군데를 동기화해야 하는 영구 부채. 채택 안 함.

**C. `enqueue_items_core` 추출 후 Scheduler가 직접 호출.** ← 채택.
함수 추출은 mechanical하고 1회성 비용이다. 그 비용을 한 번 치르고 나면 Scheduler는 "REST API의 in-process 호출자"가 되어 모든 enqueue 정책을 무조건 상속받는다. Q14 carve-out 하나만 Scheduler 책임으로 남으며, 그 carve-out은 `find_ineligible_dates`가 이미 순수 함수로 제공하고 있다 — 즉 새 코드 0줄로 처리.

## Why not split the carve-out?

`find_ineligible_dates`를 `enqueue_items_core` 내부에서 trim 모드로 동작하게 만들어 carve-out 자체를 없애는 것도 고려했다. 거부 이유:

- REST API 호출자는 *명시적 거부 신호*가 필요하다. 사용자가 "오늘 17시 데이터 받고 싶어"라고 18시 전에 요청했을 때 silent하게 today를 빼고 처리하면 잘못된 mental model이 형성된다. 400으로 거부해 "18시 이후 다시 시도하세요"라는 메시지를 띄우는 게 옳다.
- Scheduler는 *기계적 반복* 호출자다. multi-day catch-up이 today를 포함했다고 해서 전체를 거부하는 건 의미가 없다 — Scheduler는 "가능한 만큼" 처리하면 된다.

따라서 같은 정책을 호출자마다 다르게 해석하는 게 옳다. enqueue_items_core는 strict(reject), Scheduler는 lenient(trim).

## Invariant

이 ADR이 도입하는 invariant:

> `hoga/api/scheduler.py` 및 그 transitive import에서는 `_queue`, `_active`, `_done`, `_inflight_paths` 식별자가 등장하지 않는다. enqueue 경로의 유일한 진입점은 `captures.enqueue_items_core`다.

위반 시: scheduler가 우회한 enqueue가 ADR-0033 dedupe / ADR-0019 persist / ADR-0031 retry policy의 한 가지 이상을 silent하게 깨뜨린다. 디버깅이 어렵고 회귀 테스트가 잡지 못한다 — invariant를 ADR로 못 박는 이유.

## Consequences

**좋은 쪽:**
- `enqueue_items_core`가 module-level이 되면서 단위 테스트가 라우터 layer를 거치지 않고 직접 가능해진다(현재는 fastapi TestClient 필요).
- 향후 enqueue 정책이 진화해도 (예: ADR-0035에서 우선순위 도입) Scheduler가 자동으로 따라간다.

**나쁜 쪽 / 비용:**
- 라우터 inner function 한 곳이 module-level + thin wrapper 두 곳으로 분리. 호출자 모두 검증 필요 (테스트 및 기존 호출자는 라우터뿐이므로 작음).
- Scheduler가 `find_ineligible_dates`를 호출하는 코드와 `enqueue_items_core` 내부가 호출하는 코드가 *각각 한 번씩* 도는 중복이 생긴다. Scheduler에서 trim된 후 core에서 다시 검사. 비용은 O(dates) 순회 한 번, 무시 가능.

**위험:**
- 미래 contributor가 "Scheduler가 직접 큐 만지는 게 간단해 보이는데"라고 생각해 invariant를 깰 수 있다. 본 ADR이 그 유혹의 명시적 답변이다. PR 리뷰 시 scheduler.py에서 `_queue`/`_active`/`_done` import / 참조가 등장하면 reject.

## Alternatives rejected

- A: self-HTTP request (위 참조)
- B: 큐 직접 조작 (위 참조)
- D: 별도 uvicorn worker / subprocess — single-user 로컬 툴 환경에서 inter-process 통신 비용이 모든 이득을 상쇄.
