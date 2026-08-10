# 0143 — 실패 진단은 한 곳, 표시 채널은 성격별로

**Status:** proposed (2026-08-10) — 초안. 승인 전이며 코드 변경은 아직 없다.

**Extends:**
- **ADR-0137**(에러 처리 전략) — `error_policy` 가 소유하는 `kind`·`permanent` 를
  **wire 까지 밀어** 프론트가 역추론하지 않게 한다. 정책 테이블의 위치는 그대로다.
- **ADR-0004**(BE↔FE 손 미러) — 미러 표면이 하나 늘지만, 역추론 표 6벌이 사라진다.

**Unchanged:** ADR-0053(liveness 임계 순서) · ADR-0067(수집 상태 도트) ·
ADR-0020(invariant 경고는 표시하되 렌더).

**근거 문서:** [사유 전수 인벤토리](../superpowers/plans/2026-08-10-failure-reason-inventory.md)

---

## Context

같은 백엔드 사유 문자열을 프론트 **6개 모듈이 각자 분류**한다(인벤토리 §1 표 참조).
`hoga/live/error_policy.py` 의 `LiveErrorPolicy` 는 `kind`(7종)·`permanent`·
`retry_after_s`·`degraded` 를 이미 계산하지만, wire 로는 `{date, reason, msg}` 만 나간다.
프론트 6곳은 그 버려진 사실을 `reason` 문자열로부터 역추론한다:

| 프론트가 재구성하는 것 | 백엔드가 이미 아는 것 |
|---|---|
| `candleEmptyState` 의 "행동을 제안할까" | `permanent` |
| `restBypassMode` 의 transport/congestion | `kind` |
| `livePastCandles` 의 blocking 여부 | 재시도 가능성 |
| `intradayDegradation` 의 `hint` 유무 | `permanent` |

#1251 은 이 여섯 중 하나가 갈린 사고였다(전송 실패가 non-blocking 으로 분류돼 재시도·
박제·재발행 가드를 동시에 통과). 값 드리프트는 양쪽이 문자열 집합이라 **타입이 원리적으로
못 잡는다.**

## Decision

### 1. 세 층으로 나눈다

| 층 | 개수 | 소유 |
|---|---|---|
| **진단** | **1** | `reason → {kind, permanent, 실패인가}`. 도메인 사실이며 표시 관심사가 아니다 |
| **정책** | **1** | 심각도·어휘·행동 제안·동시 발생 우선순위 |
| **렌더** | **N** | 성격별 채널. 합치지 않는다 |

### 2. 진단은 백엔드가 소유하고 wire 로 내린다

`data_warnings` 항목에 `kind`·`permanent` 를 **additive-optional** 로 싣는다. 프론트는
읽어서 쓰고, 부재 시 기존 `reason` 분기로 폴백한다. 이로써 배포가 원자적일 필요가 없다.

### 3. `kind` 는 "실패 아님" 을 표현할 수 있어야 한다

`data_warnings` 는 실패 전용 채널이 아니다. 인벤토리 §3 이 밝힌 대로 4종
(`rest_bypassed` · `minute_fallback_to_krx` · `daily_fallback_to_krx` ·
`index_minute_depth_limited`)은 모드 안내이거나 **대체 성공**이거나 벤더 보유의 사실이다.

근거는 이미 코드에 있다 — `frontend/src/live/candleEmptyState.ts:72` 가 `rest_bypassed` 를
벤더 실패 허용목록에서 일부러 빼면서 "이 목록에 새는 순간 그 아래 우회 안내 분기가
도달 불가가 된다" 고 적었다. 실패 kind 에 욱여넣으면 그 구분이 죽는다.

### 4. 렌더 채널은 성격이 정한다

| 성격 | 채널 | 소멸 |
|---|---|---|
| 지속 상태 ("지금 실시간이 아니다") | 도트 · 배너 · pill | 상태 파생 — 회복 시 자동 |
| 전이 ("방금 실패했다") | 토스트 | TTL 또는 회복 |
| 국소 결손 ("이 구간이 비었다") | 그 자리의 빈 상태 | 데이터 도착 시 자동 |

**토스트는 전이를 알리고, 지속 상태는 상태 표시가 소유한다.** #1251 버그가 정확히 이
경계 위반이었다 — REST 토스트가 지속 상태 행세를 하며 회복 후에도 남았다.

### 5. 어휘는 통일하되 계층을 지운다는 뜻이 아니다

현재 "재연결 중"(WS 도트) · "재시도 중"(REST 토스트) · "연결 재시도 중"(aria) 이
무엇이 다른지 화면이 말하지 않는다. 통일은 **같은 말로 뭉개기가 아니라 구분을 드러내기**다
— "실시간 재연결 중" / "과거 조회 재시도 중".

## 비대상 — 같은 필드명, 다른 축

이 셋은 `reason` 이라는 필드명을 공유할 뿐 다른 축이다. **진단층에 넣지 않는다.**

| 축 | 값 | 왜 다른가 |
|---|---|---|
| `capture_reason` | `offline` · `closed` · `registration_incomplete` · `healthy` | 에러가 아니라 **수집 상태**. 섞으면 밤·주말의 정상 정지가 장애로 표시된다 (`liveStatusProjection.ts:93` 의 근거) |
| 이벤트 버스 `reason` | `cancelled` · `error` | 스크리너 작업 종료 사유 (`hoga/api/screener.py:252,258`) |
| WS close `reason` | `cross_origin_blocked` | 연결 거부 코드 1008 (`hoga/api/origin_guard.py:141`) |

임계 3종(`LIVE_STALE_MS` 35s / `WATCHDOG_TIMEOUT_MS` 45s / `STATUS_STALE_MS` 60s)도
비대상이다 — ADR-0053 의 순서 불변식이 있다.

## Consequences

**얻는 것**

- 역추론 표 6벌 → wire 미러 1벌. #1251 부류의 사고 표면이 6→1
- `intraday_*` 매핑표가 대부분 소멸한다 — `f"intraday_{reason}"` 동적 생성이므로
  접두를 벗기면 같은 8종이다(현재 `REASON_COPY` 6행 중 5행이 그 중복)
- "실패 아님" 4종이 실패로 표시되던 여지가 구조적으로 닫힌다

**치르는 것**

- wire 필드 2개 추가 → `response_model` 스트립 위험. 생산자·모델·FE 미러를 같은 PR 에
  두고 실서버 응답으로 검증해야 한다(CLAUDE.md "API wire 계약")
- 새 kind 2종(`deferred` · `data_quality`) + `informational` 이 필요하다. 기존 7종에
  욱여넣으면 코드가 **이미 구별하고 있는 것**을 잃는다
- `capacity_overloaded` 의 이중 생성 경로(정책 테이블 + 별도 생성기)를 정리하지 않으면
  wire 확장 시 한쪽만 고치는 사고가 난다

**되돌림**

`kind` 를 optional 로 두므로 프론트가 읽지 않아도 무해하다. 프론트 이관은 표 단위라
N개만 하고 멈춰도 나머지는 기존 표로 동작한다.

## 결정 (사용자 확정 2026-08-10)

1. **`is_failure` 는 별개 축**이다. `informational` 이라는 kind 를 만들지 않는다 —
   정보성끼리의 구별은 `reason` 이 이미 하고, kind 는 **실패의 처방 부류**를 묶는
   축이라 실패에만 붙인다. 결과: `LiveErrorKind` 확장은 `deferred`·`data_quality`
   2개로 끝나고, "kind 가 있는데 `is_failure=False`" 라는 모순 상태가 타입상 생기지
   않는다.
2. **`capacity_overloaded` 이중 경로 통합을 포함한다.** 별도 생성기를 지우는 것이
   아니라(호출부 2곳은 예외 객체가 없는 자리다) 생성기가 정책 산출에서 reason·msg 를
   뽑게 한다. 이로써 "정책 테이블이 유일 출처" 가 **문구까지** 성립한다.
3. `intraday_` 접두는 **Phase 2 로 미룬다.** wire 에 kind·is_failure 가 실리면
   `f"intraday_{reason}"` 경고도 같은 정책에서 값을 받으므로 접두와 무관하다.
   벗기는 위치는 프론트 이관 시 결정한다.

## Phase 2 진행 (2026-08-10)

프론트 6표를 이 진단층으로 이관한다. 표 하나당 1 PR — 각각 **기존 테스트가 동등성
그물**이다. 진입점은 `frontend/src/api/dataWarnings.ts`(wire shape + `warningKind` ·
`isWarningFailure`).

| # | 표 | 상태 |
|---|---|---|
| 1 | `liveDataWarnings.ts` (`RATE_LIMIT_REASONS`) | **완료** — `isRateLimitWarning` |
| 2 | `restBypassMode.ts` (`classifyRestWarning`) | 대기 |
| 3 | `intradayDegradation.ts` (`REASON_COPY`) | 대기 (접두 처리 결정 포함) |
| 4 | `candleEmptyState.ts` (벤더실패·유예 2집합) | 대기 |
| 5 | `liveStatusProjection.ts` (`CAPTURE_REASON_VIEW`) | **비대상** — `capture_reason` 축 |
| 6 | `livePastCandles.ts` (`BLOCKING_WARNING_REASONS`) | 대기 (**마지막** · 동등성 기준은 캐시 동작) |

**첫 이관이 Phase 1 의 분류 오류를 하나 드러냈다** — `capacity_overloaded`. 정책값을
그대로 옮겼는데, `policy.kind`(처방 축)와 wire kind(표시 축)를 구분하지 않은 것이었다.
`deferred` 로 정정했고 유일한 의도적 비대칭으로 테스트에 고정했다. **표마다 이런 검토
지점이 있을 수 있으므로 이관은 계속 표 단위로 한다.**

## Phase 1 구현 결과 (2026-08-10)

`hoga/live/data_warnings.py` 가 분류 단일 출처이고 **모든 생성기가 `make_data_warning`
을 지난다**(5개 파일 · 22곳). 가드는 `tests/unit/live/test_data_warnings.py`.

**남은 것 — `data_warnings` 모델화는 이번 범위 밖이다.** 현재 wire 타입은 여전히
`list[dict]` 라(`hoga/live/api.py`) shape 계약이 없다. `LiveDataWarning(BaseModel)` +
`extra="allow"` 로 계약 표면을 만드는 것은 성격이 다른 변경이고(스트립 위험 검증에
실서버 프로브가 필요하다) 되돌림 경계도 다르므로 분리한다.
