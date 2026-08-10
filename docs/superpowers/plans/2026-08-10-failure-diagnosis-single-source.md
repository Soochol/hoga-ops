# 실패 진단 단일화 — 진단 1층 + 정책 1층 + 렌더 N채널

- **작성**: 2026-08-10
- **상태**: 제안 (미승인 · 착수 전)
- **계기**: #1251 (`BLOCKING_WARNING_REASONS` 미러 드리프트) 조사 중 드러난 구조 문제

## 1. 문제

같은 백엔드 사유 문자열을 **프론트 6개 모듈이 각자 분류**한다.

| 모듈 | 표 | 사유 수 | 무엇을 가르나 |
|---|---|---|---|
| `frontend/src/api/livePastCandles.ts:92` | `BLOCKING_WARNING_REASONS` | 9 | **데이터 동작** — 재시도·박제·재발행 |
| `frontend/src/live/candleEmptyState.ts:81` | `VENDOR_FAILURE_REASONS` + `DEFERRED_FETCH_REASONS` | 8 | 빈 상태 문구·행동 |
| `frontend/src/screener/intradayDegradation.ts:24` | `REASON_COPY` | 6 | 스크리너 강등 문장 |
| `frontend/src/state/restBypassMode.ts:62` | `classifyRestWarning` | 3 | 토스트 성격 |
| `frontend/src/live/liveStatusProjection.ts:91` | `CAPTURE_REASON_VIEW` | 3 | pill 라벨·등급 |
| `frontend/src/live/liveDataWarnings.ts:32` | `RATE_LIMIT_REASONS` | 2 | 칩 문구 |

**뿌리**: `hoga/live/error_policy.py:56-69` 의 `LiveErrorPolicy` 는 이미
`kind`(7종) · `permanent` · `retry_after_s` · `degraded` 를 계산한다. 그런데 wire 로는
`{date, reason, msg}` 만 나간다(`hoga/live/live_candle_backfill.py:1000`
`_rest_error_warning`). 즉 **백엔드가 계산해서 버린 사실을 프론트 6곳이 `reason`
문자열로부터 각자 역추론**한다.

- `candleEmptyState` 의 "행동을 제안할까" = `permanent` 역추론
- `restBypassMode` 의 transport/congestion = `kind` 역추론
- `livePastCandles` 의 blocking = 재시도 가능성 역추론
- `intradayDegradation` 의 `hint` 유무 = `permanent` 역추론

#1251 은 이 여섯 중 **하나**가 갈린 사고였다. 구조가 그대로면 나머지 다섯이 같은
사고의 표면으로 남는다.

## 2. 목표 구조

1. **진단층 (단일)** — `reason → {kind, permanent, 처방}`. 도메인 사실이지 표시 관심사가 아니다.
2. **정책층 (단일)** — 심각도·어휘·행동 제안·동시 발생 우선순위.
3. **렌더층 (복수 유지)** — 지속 상태 = 상태 파생 표시(도트·배너·pill), 전이 = 토스트,
   국소 결손 = 그 자리 빈 상태.

렌더층을 합치지 않는 것은 비용이 아니라 원칙이다. #1251 버그가 정확히 이 경계 위반
(토스트가 지속 상태 행세)이었다.

## 3. 범위

**대상**

- `error_policy` 산출 사유 8종: `transport_error` · `auth_error` · `api_error` ·
  `rate_limit_upstream` · `batch_limit_exceeded` · `capacity_overloaded` ·
  `internal_processing_error` · `unexpected_error`
- 정책 밖 생성 사유 **8종** — Phase 0 이 확정했다([인벤토리](2026-08-10-failure-reason-inventory.md) §0).
  최초 추정 14종에는 **다른 축**(이벤트 버스 `reason`, WS close `reason`)이 섞여 있었다.
  - **진짜 실패 4종**: `rate_limit_aborted` · `fetch_budget_exhausted` ·
    `invariant_violation` · `screener_daily_missing`
  - **실패 아님 4종**: `rest_bypassed` · `minute_fallback_to_krx` ·
    `daily_fallback_to_krx` · `index_minute_depth_limited` — 모드 안내·대체 성공·보유 한계
- `intraday_*` 접두 사유 — Phase 0 확인: `f"intraday_{reason}"` **동적 생성**이라
  별도 사유 공간이 아니다. 접두를 벗기면 위 8종이다

**비대상 (명시적 제외)**

- `capture_reason` 축 (`offline` · `closed` · `registration_incomplete` · `healthy`) —
  **에러가 아니라 수집 상태**다. 섞으면 밤·주말의 정상 정지가 장애로 표시된다
  (`frontend/src/live/liveStatusProjection.ts:93` 주석의 근거).
- 임계 3종 (`LIVE_STALE_MS` 35s / `WATCHDOG_TIMEOUT_MS` 45s / `STATUS_STALE_MS` 60s) —
  ADR-0053 순서 불변식. `frontend/src/api/liveness.ts:8` 참조.
- `hogaMissingNotice` — 호가 결손은 "그 순간 못 받으면 영원히 없다"라 처방이 정반대다.

## 4. 두 경로

### A. wire 확장 (권고)

백엔드가 이미 가진 `kind`/`permanent` 를 wire 에 실어 프론트가 **읽게** 한다.
역추론 표 6개 → 미러 1개로 드리프트 표면이 줄어든다.

**비용의 실체**: 정책 밖 사유 14종은 `classify_live_error` 를 지나지 않으므로,
이들에게 `kind`/`permanent` 값을 **새로 부여**해야 한다. 이것이 Phase 0 의 진짜 작업량이다.

### B. 프론트 단일 모듈만 (축소 대안)

wire 를 건드리지 않고 프론트에 `reason → {kind, permanent}` 표를 **한 벌만** 둔다.
역추론은 남지만 6벌 → 1벌. 백엔드 변경이 없어 배포가 단순하다.

**한계**: 역추론 표가 백엔드 정책과 갈릴 여지는 그대로다(#1251 과 같은 종류의 사고가
1/6 확률로 남는다). 가드 테스트로 완화할 수 있으나 근본은 아니다.

---

## Phase 0 — 정본 확정

**산출물**

- 사유 전수 표: 20+ 행 × `{reason, kind, permanent, 지속/이벤트, 처방, 표시 채널}`
- ADR: 진단·정책·렌더 3층 규약 + 렌더 채널 선택 규칙

**검증**: 표의 사유 목록이 백엔드 전수와 일치하는지 자동 대조(기존
`tests/unit/live/test_live_candle_backfill.py` 의 미러 가드 패턴 재사용).

**되돌림 경계**: 문서만 — 코드 변경 0. 여기서 중단해도 일관 상태.

## Phase 1 — wire 확장 (경로 A 전용)

**산출물**

- `data_warnings` 항목에 `kind?` · `permanent?` **additive-optional** 추가
- 정책 밖 생성기 14곳에 값 부여
- 프론트 wire 미러 갱신

**필수 주의**

- 생산자 · pydantic 모델 · FE 미러를 **같은 PR** 에. 모델만 빠지면 `response_model` 이
  새 키를 **조용히 스트립**한다(CLAUDE.md "API wire 계약" 절).
- 실서버 응답으로 검증: dev 서버(:8000) GET → `model_validate` → `model_dump` →
  키 집합 재귀 비교. 워크트리 백엔드는 무자격이라 폴백 응답만 나와 스트립을 못 잰다.
- optional 로 두는 이유: Phase 1(백엔드)과 Phase 2(프론트)를 분리 배포할 수 있고,
  프론트는 `kind` 부재 시 기존 `reason` 분기로 폴백한다.

**검증**: wire 계약 테스트 4층 갱신 · 폴백/부분 payload 를 모델에 넣는 테스트 추가

**되돌림 경계**: optional 이라 프론트가 안 읽어도 무해. 여기서 중단해도 일관 상태.

## Phase 2 — 진단층 이관 (표 하나당 1 PR, 6회)

순서는 위험 낮은 것부터:

1. `liveDataWarnings.ts:32` (`RATE_LIMIT_REASONS`, 2개 — 칩 문구만)
2. `restBypassMode.ts:62` (`classifyRestWarning`, 3개 — 토스트 성격)
3. `intradayDegradation.ts:24` (`REASON_COPY`, 6개 — 문장)
4. `candleEmptyState.ts:81` (8개 — 문구 + 행동)
5. `liveStatusProjection.ts:91` (3개 — pill; `capture_reason` 축이라 **경계 재확인**)
6. `livePastCandles.ts:92` (`BLOCKING_WARNING_REASONS`, 9개 — **마지막**)

**6번이 특별한 이유**: 이 표는 문구가 아니라 **데이터 동작**(재시도·박제·재발행)을
가른다. 이관 동등성 기준이 "문구 같음"이 아니라 **"같은 응답에 같은 캐시 동작"** 이다.
#1251 에서 만든 미러 가드는 형태를 바꿔 **살아남아야** 한다(대조 대상이 사유 집합에서
진단층 판정으로 바뀔 뿐).

**검증(각 PR)**: 해당 표의 기존 테스트가 동등성 그물 · red-check 필수
(이관 후 새 경로를 끊어 같은 테스트가 빨개지는지)

**되돌림 경계**: PR 단위. N개만 이관해도 나머지는 기존 표로 동작한다.

## Phase 3 — 정책층

**산출물**

- 어휘 사전 단일화. 계층 구분은 **지우지 말고 드러낸다** —
  "실시간 재연결 중" / "과거 조회 재시도 중"
  (현재: "재연결 중" · "재시도 중" · "연결 재시도 중" 이 무엇이 다른지 화면이 말하지 않는다)
- `transport_error` 표기 통일 (현재 "연결 실패"/"연결 불가" 로 갈림)
- 심각도 매핑 통일 (pill 2단 유지 — 근거는 §3 비대상)
- 동시 발생 우선순위: 한 원인 → 주 표시 하나, 나머지는 파생 표기 또는 억제

**검증**: 문구 스냅샷 테스트 · 동시 발생 시나리오(WS+REST 동시 실패) 컴포넌트 테스트

**되돌림 경계**: 표시 문자열만 — 동작 변경 없음.

## Phase 4 — 렌더층 규약 명문화

**산출물**: 채널 선택 규칙을 ADR 에 (지속=상태 표시 / 전이=토스트 / 국소=빈 상태),
위반 사례 교정

**검증**: 각 표시면이 규칙 중 어디에 속하는지 표로 고정

## 5. 리스크

| 리스크 | 완화 |
|---|---|
| `response_model` 이 새 키를 조용히 스트립 | Phase 1 의 실서버 검증 절차(필수) |
| 이관 중 동작 변화가 테스트를 안 건드림 | 표별 red-check 을 각 PR 수용 기준으로 |
| `capture_reason` 축과 혼입 | §3 비대상 명시 + Phase 2-5 에서 경계 재확인 |
| 정책 밖 14종의 `kind` 부여가 자의적 | Phase 0 표를 **먼저** 리뷰받고 코드 착수 |
| 병행 세션과 파일 충돌 | 표별 1 PR + `gh pr list` 사전 확인 |

## 6. 열린 질문

**Phase 0 완료 (2026-08-10)** — 산출물 둘:
[사유 전수 인벤토리](2026-08-10-failure-reason-inventory.md) · [ADR-0143 초안](../../adr/0143-failure-diagnosis-layers.md).

### 결정된 것

- **경로 A 유지, 근거 강화**. 정책 밖 4종의 `kind`/`permanent` 부여가 **자의적이지
  않았다** — 넷 다 기존 코드의 판정과 일치하거나, 코드가 이미 구별하던 것을 승격하는
  것이었다(창작 0건). 그리고 "실패 아님 4종" 발견이 A 를 더 강화한다: wire
  `kind: 'informational'` 하나로 끝나지만, B 로는 그 구분이 다시 6벌 표 문제가 된다.

### 남은 것 (Phase 1 착수 전)

1. 새 kind(`deferred` · `data_quality` · `informational`)를 `LiveErrorKind` 에 추가할지,
   별개 축(`is_failure` / `severity`)으로 둘지
2. `capacity_overloaded` 이중 생성 경로 통합을 이 작업에 포함할지 별건으로 뺄지
3. `intraday_` 접두를 wire 에서 벗길지 프론트에서 벗길지
4. **Phase 3 어휘 범위** · **Phase 4 포함 여부** — 그 단계에서 결정 (Phase 1~2 와 독립)
