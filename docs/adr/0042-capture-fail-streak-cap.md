# 0042 — Capture Fail-Streak Cap (per Stock-Date, 5 consecutive failed+skipped → blocked)

**Status:** accepted (2026-05-28)

**Related:**
- ADR-0019 — Capture Queue 매니페스트 영속화 (`.queue.json` 패턴의 차용 대상)
- ADR-0021 — No-Upstream-Data sentinel (skipped/no_upstream_data가 `failed`로 분류되지 않는 이유)
- ADR-0031 — Retry endpoint 분리 (`attempt` 카운터의 도입처)
- ADR-0033 — `addItems` phase별 `_done` dedupe (본 ADR이 "When to revisit"에 예약해둔 시나리오)
- ADR-0035 — `phase=done + force_retry=true` Implicit Retry 허용
- `docs/superpowers/specs/2026-05-28-capture-fail-streak-guard-design.md` — 본 ADR이 근거를 보존하는 spec

## Decision

**Capture Queue**에 (Code, Stock-Date) 조합당 **연속 실패 카운터** `fail_streak`를 도입한다. 카운터가 `attempt_cap = 5` 에 도달한 (Code, Stock-Date)는 **blocked** 상태가 되며, `POST /api/captures/items`의 `enqueue_items_core`는 해당 조합의 신규 enqueue를 거부한다.

구체:

1. **카운팅 그룹.** Worker가 (Code, Stock-Date) 항목을 `_done`에 기록할 때 `phase ∈ {failed, skipped}` 면 그 (Code, Stock-Date)의 `fail_streak` += 1. `phase == done` 이면 0으로 리셋. `phase == cancelled` 는 카운터 변경 없음 (사용자 의도적 취소이며 외부 호출 유무가 불명).

2. **차단 임계.** `fail_streak >= attempt_cap` (= 5) 인 (Code, Stock-Date)는 blocked. `enqueue_items_core`의 가드는 ADR-0033의 dedupe 분기보다 **앞**에 위치 — 즉 blocked는 dedupe/Implicit Retry보다 먼저 거부된다. `force_retry=true`는 이 가드를 우회하지 **않는다**.

3. **영구화.** `fail_streak`은 ADR-0019의 `.queue.json` 매니페스트 스키마를 확장해 영속화. 새 키 `fail_streaks: dict[str, int]` (key는 `"{code}|{date}"` 형식, value는 카운트). atomic write 헬퍼와 startup-restore 경로는 매니페스트의 기존 메커니즘을 재사용. 매니페스트에 키가 없으면 0으로 간주 (마이그레이션 불필요).

4. **명시적 해제.** 새 엔드포인트 `POST /api/captures/items/{code}/{date}/unblock` — 해당 (Code, Stock-Date)의 `fail_streak`을 0으로 set + 매니페스트 atomic write. 멱등 (이미 0이면 noop 응답). 자동 재시도 동반 안 함.

5. **응답 와이어 컨트랙트.** `EnqueueResponse`에 `blocked: list[BlockedItem]` 필드 추가 — `EnqueueDedupedRow`와 다른 카테고리. `BlockedItem`은 `code`, `date`, `fail_streak`, `reason="fail_streak_exceeded"`. 전체 요청이 모두 blocked면 HTTP 409, 일부면 201 (ADR-0033의 partial-success 패턴과 동일).

6. **Inventory 표면화.** Inventory list 응답의 각 row에 `fail_streak: int` 와 `blocked: bool` 두 필드를 추가 — 한 번의 server-side pass로 매니페스트를 읽어 계산 (N+1 회피).

CONTEXT.md는 **fail_streak**과 **attempt_cap** 용어 정의를 추가하고, **Capture Queue** / **Retry** 항목에 본 ADR 링크를 박는다.

## Why

ADR-0033의 "When to revisit"가 명시했다:
> "**attempt 카운터에 정책(최대 N회, backoff)이 추가될 때** — addItems와 explicit Retry 둘 다 정책 적용 시점 결정 필요."

이번이 그 시점이다. 동기는 두 가지:

**1. 외부 API 보호.** ADR-0021의 발견(`003490/20260319`처럼 hogaplay가 영구적으로 빈 응답을 주는 (Code, Stock-Date) 케이스) 이후, 사용자가 inventory의 Re-capture 버튼을 무한 반복 누르면 외부에 무한 fetch가 발생한다. `force_retry=true`가 sentinel을 우회하므로(ADR-0021) "다음 fetch는 다를 것"이라는 기대도 합리적이지만, 5번 연속 같은 결과면 명시적 사용자 개입을 요구하는 게 옳다.

**2. 사용자 mental model 보호.** 사용자가 "왜 이 종목은 계속 실패하지?"를 깨닫지 못한 채 반복하는 인지 패턴을 끊는다. 5/5에 도달하면 inventory의 시각적 신호 + 명시적 unblock 액션이 "지금 일어나는 일은 정상이 아니다"를 사용자에게 알린다.

### 왜 `failed + skipped`를 함께 카운팅하는가

ADR-0021은 운영 시그널(`total_failed` vs `total_skipped`)을 의도적으로 분리했다. 본 ADR의 `fail_streak`은 그 분리를 **깨지 않는다** — `fail_streak`는 별개 카운터이며 `total_failed` / `total_skipped` 집계와 무관하다.

`failed`만 카운팅하면 동기 #1이 무력화된다. `(003490, 20260319)`는 `phase=skipped`로 끝나기 때문에 `failed`-only 카운터는 영원히 0에 머문다 — Re-capture 버튼은 영원히 hogaplay를 두드릴 수 있다. `failed + skipped`로 카운팅해야 ADR-0021이 만든 "데이터 없음" 케이스도 cap에 걸린다.

`cancelled`는 카운팅 제외: 사용자의 명시적 취소이며, 외부 API 호출이 일어났는지조차 불명. 카운터가 "5회 cancel = 차단"이 되는 의미는 본 ADR 동기와 무관하다.

### 왜 `_done`에서 derive하지 않는가

처음 design은 `_done` history에서 fail_streak를 매번 derive하는 모델이었다. ADR-0019가 "`_done`은 매니페스트에 영속화되지 않음"을 못박았으므로 — uvicorn 재시작 한 번에 모든 fail_streak이 0이 된다. "성공 시에만 리셋"이라는 spec 결정과 정면 충돌. 매니페스트 영속화로 옮긴 이유다.

대안으로 디스크 sentinel 파일(ADR-0021 패턴)도 검토했으나, 5회 실패 중 일부가 raw 디렉토리를 만들기 전에 죽는 케이스(네트워크 5xx, decide_capture 단계 종료)에서는 sentinel 저장 위치가 없다. 매니페스트는 (Code, Stock-Date)에 무관하게 항상 쓸 수 있다.

## Alternatives considered

### A. 변경 없음, 사용자의 자제력에 맡김

Inventory에 Re-capture 회수 hint만 노출(예: "이 row는 4번 실패했습니다") 하고 차단은 안 함.

**Rejected:** 외부 API 보호 목적이 사라짐. 사용자가 hint를 무시할 때 손해를 보는 쪽이 우리 자신이 아니라 외부 서비스 — 정량적으로 통제해야 한다.

### B. `attempt` 카운터에 cap 적용 (별도 fail_streak 도입 안 함)

ADR-0031의 `attempt`가 이미 (Code, Stock-Date)당 누적되므로 `attempt >= 5` 면 차단.

**Rejected:** `attempt`는 성공해도 prior+1로 누적된다(CONTEXT.md L122 "every Retry regardless of trigger"). "5번 성공한 종목은 더 이상 retry 불가"가 되어 운영적으로 비상식적. cap의 의미를 살리려면 "성공 시 리셋"이 필수이고, 그러면 더 이상 `attempt`가 아니라 새 카운터를 만든 셈이다.

### C. 시간 윈도우 기반 rate limit

"24시간에 5회 초과 차단" 같은 sliding window.

**Rejected:** 사용자 결정은 명시적으로 "성공 시 리셋, 시간 무관". 24시간이 지나 quota가 자동 회복되면 사용자가 같은 종목 차단을 다시 만나기 위해 또 5번을 다 써야 함 — UX와 의도 모두 어긋남.

### D. 디스크 sentinel (`raw/{date}/{code}/.fail_streak`)

ADR-0021 패턴을 그대로 차용해 카운터를 디스크 파일로 영속화.

**Rejected:** decide_capture 직후 또는 네트워크 5xx로 죽으면 `raw/{date}/{code}` 디렉토리가 아직 만들어지지 않은 상태일 수 있어 저장 위치가 없다. 매니페스트는 (Code, Stock-Date)와 무관하게 항상 쓸 수 있고, ADR-0019 atomic write 헬퍼를 그대로 재사용 가능.

## Consequences worth flagging for future readers

- **`fail_streak` vs `attempt`는 별개 카운터.** `attempt`는 단일 (Code, Stock-Date)의 retry 누적(성공 후에도 리셋 안 됨, ×N 배지). `fail_streak`은 마지막 성공/unblock 이후의 연속 실패+스킵(성공/unblock 시 0으로 리셋). 둘은 다른 의미를 표현하며 공존한다. CONTEXT.md는 두 항목 사이에 _Distinct from_ 노트를 둔다.

- **매니페스트 스키마가 한 키 늘어남.** `.queue.json` 로더는 `fail_streaks` 키가 없는 구버전 매니페스트를 만나면 빈 dict로 채워야 함 (forward-compat). 마이그레이션 스크립트 불필요.

- **`force_retry=true`는 본 가드를 우회하지 않는다.** ADR-0033/0035의 force_retry 의미는 "디스크 cache (sentinel/source_partial/complete) 우회"였다. 본 ADR의 cap은 **사용자 의도**의 게이트이지 디스크 게이트가 아니므로 force_retry와 직교. `unblock` 액션이 force_retry 패밀리의 일원이 아닌 별개 액션인 이유다.

- **운영 시그널 분리는 보존.** `total_failed`와 `total_skipped`는 변하지 않는다. `fail_streak`는 별개 카운터로서 `failed`/`skipped` 양쪽을 +1 시키지만, 두 운영 지표 자체는 ADR-0021대로 분리 유지.

- **inventory 표면화 비용.** inventory list 응답이 매니페스트의 `fail_streaks` dict를 한 번 통째로 읽어야 함. 매니페스트 크기는 큐 항목 수에 비례하므로 사실상 무시 가능한 비용. N+1 위험은 없음.

- **새 `BlockedItem` vs 기존 `EnqueueDedupedRow`.** 의미상 카테고리가 다르므로 분리. `deduped`는 "이미 처리됐다" / `blocked`는 "임계 초과로 거부됨". 같은 응답 body에 공존할 수 있다 — 한 요청이 5종목을 보낼 때 일부 dedupe + 일부 blocked + 나머지 enqueued.

- **`unblock` 액션의 SSE 의미.** unblock은 매니페스트 한 키만 변경 — capture lifecycle 이벤트는 아니다. SSE 이벤트를 새로 만들지 말고, inventory query invalidate로 frontend가 polling-by-mutation 패턴을 따른다. SSE topic 추가가 필요해지면 future ADR.

## When to revisit

- `attempt_cap`을 사용자 설정으로 열어야 할 때 — 현재는 상수 5. 운영 패턴이 다양해지면 Settings 페이지의 한 항목으로 승격.
- bulk unblock UI가 필요해질 때 — 현재는 row별. 차단된 (Code, Stock-Date)가 운영상 빈번해진다는 신호.
- 시간 윈도우 보조 가드가 필요해질 때 — "1시간에 N회" 같은 추가 차단. 외부 API contract가 더 까다로워질 경우.
- `cancelled`도 카운팅해야 하는 운영 패턴이 발견될 때 — 본 ADR은 의도적으로 제외.
- 다중 사용자/다중 워커로 확장될 때 — ADR-0019/0033과 동일한 single-worker 가정에 의존. 매니페스트 atomic write의 동시성 경계 재검토 필요.
