# 0143 — 실패 진단은 한 곳, 표시 채널은 성격별로

**Status:** accepted (2026-08-10)

| 단계 | 내용 | PR |
|---|---|---|
| Phase 1 | 진단 단일 출처 + wire `kind`·`is_failure` | #1253 |
| Phase 2 | 프론트 6표 이관 (5 이관 + 1 비대상) | #1254 · #1256 · #1257 · #1258 · #1260 |
| Phase 3-A/B | 어휘 — 같은 것을 같게 · 다른 것을 다르게 | #1262 · #1263 |
| Phase 3-D | 동시 발생 조율 → **보류 판정** | #1265 |
| Phase 3-C | 심각도 축 → **불필요 판정**(실측: 이미 일관) | (이 문서 §7) |
| Phase 4 | 렌더 채널 규약 — §4 가 이미 표로 갖는다 | (이 문서 §4) |

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

**두 갈래를 구분한다.**

**(A) 같은 것을 같게** — 같은 kind 를 표면마다 다른 이름으로 부르던 것. 판단이 필요
없는 우발적 불일치라 사전 하나로 모은다(`frontend/src/api/warningCopy.ts`).
사전이 갖는 것은 **원인 명사구 하나**이고, 조립(제목+본문+상태 / 한 줄 / 한 줄+행동)은
표면이 한다 — 같은 사실을 다른 길이로 말하는 것은 정상이고 다른 이름으로 부르는 것이
문제였다.

**(B) 다른 것을 다르게 보이게** — "재연결 중"(WS 도트) · "재시도 중"(REST 토스트) ·
"연결 재시도 중"(aria)이 무엇이 다른지 화면이 말하지 않는다. 여기서 통일은 **같은
말로 뭉개기가 아니라 구분을 드러내기**다 — "실시간 재연결 중" / "과거 조회 재시도 중".
문구가 길어지므로 좁은 자리(도트 라벨·칩)의 실물 확인이 선행돼야 한다.

**진행 상태**: A 완료. `transport` 는 "연결 실패" → "연결 불가"(ADR-0137 어휘),
`rate_limit` 은 "시세 서버 혼잡"(상태) → **"호출 한도 초과"(원인)** 로 통일했다
(사용자 확정 2026-08-10). 후자의 판정 근거: 이 사전이 갖는 것이 애초에 **원인
명사구**이고 "혼잡" 은 무엇이 몰렸는지 말하지 않는다. 토스트 본문이 이미 상태를
서술하므로("요청이 몰려…") 제목까지 상태일 이유가 없다.

**B 도 적용했다** — "재연결 중" → "실시간 재연결 중", "재시도 중" → "과거 조회 재시도 중".

**좁은 자리 처리가 이 결정의 핵심이다.** 관심종목 드로어 행(280px)에 라벨을 넣어
실측했더니 트레일링 슬롯이 20 → 59px 로 벌어지며 **종목명이 52 → 13px 로 짜부러졌고**,
접두어를 붙이면 **0px** 이 됐다(2026-08-10). 그 행에서 종목명은 라벨보다 중요하다 —
어느 종목인지 모르면 상태를 알아도 쓸모가 없다.

그래서 `CollectionDot.showLabel` 로 **글자만 끄고 문구는 `title`·`aria-label` 이
그대로 전달**한다. 같은 파일이 이미 `realtime` 점을 숨겨 "정상=무표시 예외-기반
신호" 를 만든 것과 같은 원칙의 연장이다. 라벨과 aria 문구를 일치시킨 이유가 여기 있다 —
글자가 생략돼도 의미가 온전해야 이 옵션이 성립한다.

**덤으로 기존 결함이 하나 닫혔다**: 접두어 이전에도 39px 라벨이 종목명을 13px 로
뭉개고 있었다. `disconnected` 는 WS 가 끊겨야 나오는 상태라 개발 중 마주칠 일이
드물어 무증상이었다.

### 6. 동시 발생 조율 — **보류** (사용자 확정 2026-08-10)

한 원인이 WS 와 REST 를 동시에 때리면 표시가 서로를 참조하지 않고 여러 개 뜬다.
네 안을 비교해 **현행 유지**로 판정했다 —
[설계안 비교](../superpowers/plans/2026-08-10-concurrent-failure-display.md).

근거 둘:

- **원래 불편의 절반은 §5 가 이미 고쳤다.** 문제의 실측 사건(2026-08-10 07:46 DNS
  단절)을 지금 어휘로 다시 보면 "실시간 재연결 중" 과 "과거 조회 재시도 중" 이 서로
  다른 계층임이 읽힌다. 남은 것은 개수이고, 개수 자체가 문제라는 증거는 아직 한 건뿐이다.
- **판정축은 "부분 장애에서 거짓 억제가 없는가" 다.** 한쪽만 죽는 경우가 실재한다 —
  #1088 에서 **WS 는 살고 REST 만 조용히 죽었다**. 그 상황에서 토스트를 억제하면
  유일한 신호가 사라진다. 가장 싼 안(원인 무관 억제)이 여기서 탈락하고, **기각**이다.

프론트가 WS 끊김의 **원인을 모르는 것**(이벤트 무수신만 안다)이 이 판정의 구조적
배경이다. 조율이 정말 필요해지면 백엔드가 양쪽을 연결해 알려주는 안이 정답이지만,
그건 관측이 쌓인 뒤의 일이다.

### 7. 심각도 축 — **불필요 판정** (실측 2026-08-10)

이 ADR 을 열게 한 최초 검토가 "같은 '네트워크에 닿지 못함' 이 표면마다 다른 색
(pill 은 ok/error 2단, 도트·토스트는 warn)" 을 불일치로 지적했다. **그 지적이
틀렸다** — 실패 축과 수집 상태 축을 같은 평면에서 비교한 축 혼동이었다.

실측하면 **실패 축은 이미 일관되다**:

| 표시면 | 심각도 |
|---|---|
| REST 토스트 (`RestUnavailableToastHost`) | `warn` |
| 종목 수집 도트 (`disconnected`) | `var(--warn)` |
| 스크리너 강등 배너·칩 | `var(--warn)` |
| `LiveStateBanner` (`realtime_unavailable`) | `warn` |
| `candleEmptyState` | 색 없음(빈 상태 문구) |

pill 의 `ok/error` 는 `capture_reason` 축이고 **§비대상에서 이미 그었다** —
`offline` 을 `ok` 로 두는 것은 "밤·주말의 정상 정지를 장애로 표시하지 않는다" 는
의도된 판정이다. `ViolationWire.severity`(`error`/`warn`)도 다른 축이다 — ADR-0020 의
invariant 자체 등급이지 실패 표시가 아니다.

**타입이 4벌인 것은 사실이지만 값이 일관되므로 통합은 UX 개선이 아니라 리팩터링이다.
하지 않는다.**

**재검토 트리거**: 실패 축에 `warn` 이 아닌 심각도가 필요한 kind 가 생길 때 — 예컨대
`unexpected` 를 `error` 로 올리자는 요구가 실제로 나오면, 그때 kind → severity 매핑을
진단층 연장으로 두는 것이 자연스럽다.

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
3. **`intraday_` 접두는 백엔드에서 벗긴다** (사용자 확정 2026-08-10 · Phase 2-3 구현).

   단순 접두 제거가 **아니다.** 상태 태그 배열(`warnings`)은 depth·ETF 경고와 한
   평면이라 접두를 그냥 떼면 이름이 충돌한다 — 접두는 그 충돌을 막던 네임스페이스였다.
   그래서 **실패를 `intraday_failure` 라는 자체 필드로 분리**하고, 그 안에서는 접두 없이
   `reason`·`kind`·`is_failure` 를 싣는다. 필드가 곧 네임스페이스이므로 접두가 필요 없다.

## Phase 2 진행 (2026-08-10)

프론트 6표를 이 진단층으로 이관한다. 표 하나당 1 PR — 각각 **기존 테스트가 동등성
그물**이다. 진입점은 `frontend/src/api/dataWarnings.ts`(wire shape + `warningKind` ·
`isWarningFailure`).

| # | 표 | 상태 |
|---|---|---|
| 1 | `liveDataWarnings.ts` (`RATE_LIMIT_REASONS`) | **완료** — `isRateLimitWarning` |
| 2 | `restBypassMode.ts` (`classifyRestWarning`) | **완료** — kind → transport/congestion |
| 3 | `intradayDegradation.ts` (`REASON_COPY`) | **완료** — 접두는 **백엔드가** 벗겼다(`intraday_failure` 필드 분리) |
| 4 | `candleEmptyState.ts` (벤더실패·유예 2집합) | **완료** — kind 집합 2개로 1:1 대응 |
| 5 | `liveStatusProjection.ts` (`CAPTURE_REASON_VIEW`) | **비대상** — `capture_reason` 축 |
| 6 | `livePastCandles.ts` (`BLOCKING_WARNING_REASONS`) | **완료** — kind 집합(7종) · 호출부 3곳 무변경 |

**Phase 2 완료 — 6표 중 5 이관 + 1 비대상.** 역추론 표가 전부 사라졌고, 프론트는
`frontend/src/api/dataWarnings.ts` 한 곳으로만 진단 축을 읽는다.

**이관이 Phase 1 의 분류 오류를 둘 드러냈다** — `capacity_overloaded`(`rate_limit` →
`deferred`, #1254)와 `screener_daily_missing`(`data_quality` → `not_wired`, #1257).
전자는 `policy.kind`(처방 축)와 wire kind(표시 축)를 구분하지 않은 것이었고, 후자는
"받긴 받았다" 를 함의하는 kind 를 파일 부재에 붙인 것이었다. **둘 다 실제 소비처에
붙여 봐야 드러나는 종류였다** — 표 단위 이관의 값이 여기 있다.

표 6 은 성격이 달랐다. 앞선 넷은 **문구**를 갈랐지만 이건 **데이터 동작**(자가 회복
refetch · 델타 기준 박제 · canonical 재발행)을 가른다. `hasBlockingWarnings` 시그니처를
유지해 호출부 3곳은 손대지 않았고, 판정 질문은 **"그 날짜를 받았는가"** 다 —
`is_failure` 만으로는 가를 수 없다(`invariant_violation` 은 실패지만 데이터는 받았다).

## Phase 1 구현 결과 (2026-08-10)

`hoga/live/data_warnings.py` 가 분류 단일 출처이고 **모든 생성기가 `make_data_warning`
을 지난다**(5개 파일 · 22곳). 가드는 `tests/unit/live/test_data_warnings.py`.

**`data_warnings` 모델화 완료**(별건으로 분리했다가 이어서 처리). 응답 모델 6개의
`list[dict]` → `list[LiveDataWarning]` 이고, `extra="allow"` 가 스트립을 막는다.
덤으로 `kind` 가 wire enum 미러 감사에 올라갔다(`LiveErrorKind` ↔ FE `LiveWarningKind` —
이름이 달라 자동 발견이 못 보는 부류라 손으로 등록).
