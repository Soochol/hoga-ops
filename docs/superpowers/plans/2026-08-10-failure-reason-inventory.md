# 사유 전수 인벤토리 (Phase 0 산출물)

- **작성**: 2026-08-10
- **상태**: 초안 — 리뷰 대상. 코드 변경 0
- **상위 계획**: [2026-08-10-failure-diagnosis-single-source.md](2026-08-10-failure-diagnosis-single-source.md)

Phase 0 의 목적은 "`data_warnings` 에 실제로 무엇이 오는가" 를 세는 것이었다. 세어 본
결과가 상위 계획의 추정을 두 군데 정밀화했다 — 아래 §0.

## 0. Phase 0 이 밝힌 것

**(1) "정책 밖 사유 14종" 은 실제로 8종이다.** 상위 계획의 14는 `"reason": "..."` 문자열
grep 결과였는데, 거기에 **다른 축**이 섞여 있었다:

| 탈락 | 실제 정체 | 축 |
|---|---|---|
| `cancelled` · `error` | 스크리너 이벤트 버스 payload (`hoga/api/screener.py:252,258`) | 진행 이벤트 |
| `cross_origin_blocked` | WebSocket close reason 1008 (`hoga/api/origin_guard.py:141`) | 연결 거부 |

같은 필드명(`reason`)을 쓰는 다른 축이다. **이 셋은 이 리팩터링의 비대상이다.**

**(2) `data_warnings` 는 실패와 정보가 섞인 채널이다.** 정책 밖 8종 중 **4종은 실패가
아니다** — 모드 안내이거나 대체 성공이거나 벤더 보유의 사실이다. 이것이 이번 조사의
가장 중요한 설계 발견이고, §3 에서 별도 부류로 뗀다.

## 1. error_policy 산출 (8종) — kind·permanent 이미 존재

`hoga/live/error_policy.py` 가 계산하지만 **wire 로는 `reason`·`msg` 만 나간다.**

| reason | kind | permanent | retry_after_s | 처방 |
|---|---|---|---|---|
| `transport_error` | transport | False | 3.0 (retryable 일 때) | 회선·서버 회복 대기 / 저장 데이터 우회 |
| `rate_limit_upstream` | rate_limit | False | 1.0 | 대기 |
| `capacity_overloaded` | rate_limit | False | 1.0 | 대기 (우리 큐 포화) |
| `api_error` | vendor_api | False | 1.0 또는 None | 재시도 |
| `auth_error` | auth | **True** | — | 벤더 쪽 등록·앱키 (앱 안에 버튼 없음) |
| `batch_limit_exceeded` | batch_limit | **True** | — | 범위 축소 |
| `internal_processing_error` | internal | **True** | — | 결함 신고 |
| `unexpected_error` | unexpected | **True** | — | 결함 신고 |

⚠ **`capacity_overloaded` 는 생성 경로가 둘이다.** `classify_live_error`
(`KiwoomCapacityOverloaded` → `message=str(exc)`) 와 별도 생성기
`hoga/live/live_candle_backfill.py:1038` (`msg` 고정 문자열). 후자의 문구는
`"KIS capacity scheduler pending request limit reached"` 로 **KIS 시대 잔재**다(현재
경로는 키움). wire 확장 시 **한쪽만 고치면 갈린다** — 이런 이중 생성이 드리프트의 씨앗이다.

## 2. 정책 밖 · 진짜 실패 (4종) — kind·permanent 부여 필요

각 행의 근거는 **기존 코드의 어느 판정과 일치하는가**이다. 부여가 자의적이지 않다는 것이
A 경로 판정의 핵심 재료다.

| reason | 생성 | 제안 kind | permanent | 근거 |
|---|---|---|---|---|
| `rate_limit_aborted` | `live_candle_backfill.py:881` | rate_limit | False | `classifyRestWarning` 이 이미 `rate_limit_upstream` 과 **같은 congestion 으로 묶는다**. candleEmptyState 도 "뿌리가 상류라 이쪽" 이라 적었다 — 두 곳의 기존 판정과 일치 |
| `fetch_budget_exhausted` | `live_candle_backfill.py:1046` | **`deferred` (새 kind)** | False | candleEmptyState 가 `DEFERRED_FETCH_REASONS` 로 **일부러 갈라 뒀다** — "벤더는 이 구간을 거절한 적이 없다". 기존 kind 에 욱여넣으면 그 구분이 죽는다 |
| `invariant_violation` | `hoga/live/api.py:275` | `data_quality` (새 kind) | False | 행 단위 검증 실패. 벤더 실패가 아니라 **받은 데이터의 품질**이라 ADR-0020 이 "표시하되 렌더" 로 규정 |
| `screener_daily_missing` | `screener_daily_candles.py:32` | `not_wired` | **True** | 디스크 파일 부재. 파일을 만들기 전엔 재시도가 무의미 — `candleEmptyState` 의 `not_wired` HTTP 코드 처리와 같은 성격 |

**새 kind 2종(`deferred`, `data_quality`)이 필요하다.** 기존 7종에 넣으면 이미 코드가
구별하고 있는 것을 잃는다.

## 3. 정책 밖 · 실패 아님 (4종) — 별도 부류

| reason | 생성 | 실제 의미 | 부류 |
|---|---|---|---|
| `rest_bypassed` | `live_candle_backfill.py:1054` | 우회가 켜져 있어 캐시만 서빙 | **모드 안내** |
| `minute_fallback_to_krx` | `live_candle_backfill.py:1066` | NXT/UN 이 비어 KRX 로 대체 — **성공했다** | **대체 성공** |
| `daily_fallback_to_krx` | `live_daily_candle_backfill.py:363` | 같음(일봉) | **대체 성공** |
| `index_minute_depth_limited` | `hoga/live/api.py:2191` | 벤더 보유가 거기까지 — 사실 진술 | **보유 한계** |

**이 부류를 실패 kind 에 욱여넣으면 안 되는 근거는 이미 코드에 있다.**
`frontend/src/live/candleEmptyState.ts:72` 가 `rest_bypassed` 를 허용목록에서 일부러
빼면서 적었다 — "이 목록에 새는 순간 그 아래 우회 안내 분기가 **도달 불가**가 된다".

→ wire `kind` 는 실패 종류만이 아니라 **"실패 아님"을 표현할 수 있어야 한다**
(`informational` 하나로 족하다).

## 4. `intraday_*` 축 — 별도 공간이 아니다

`hoga/api/screener_intraday.py:177,212` 가 `f"intraday_{policy.reason}"` 로 **동적 생성**한다.
즉 §1 의 8종이 그대로 접두를 단 변형이다. 여기에 상태 표시 4종
(`intraday_fallback_eod` · `intraday_partial` · `intraday_quote_invalid` ·
`intraday_volume_unavailable`)과 `intraday_credentials_missing` 이 더해진다.

**따로 매핑표를 유지할 이유가 없다** — 접두를 벗기면 §1 이다. 현재
`intradayDegradation.ts` 의 `REASON_COPY` 6행 중 5행이 그 중복이다.

## 5. 비대상 (같은 필드명, 다른 축)

- **`capture_reason`** (`offline` · `closed` · `registration_incomplete` · `healthy`) —
  에러가 아니라 수집 상태. 밤·주말의 정상 정지를 장애로 표시하지 않으려는 판정이
  `frontend/src/live/liveStatusProjection.ts:93` 에 근거와 함께 있다.
- **이벤트 버스 `reason`** (`cancelled` · `error`) — 스크리너 작업 종료 사유.
- **WebSocket close `reason`** (`cross_origin_blocked`) — 연결 거부 코드 1008.

## 6. A/B 판정 재료

**표를 실제로 채운 결과 부여는 자연스러웠다** — §2 네 행 모두 기존 코드의 판정과
일치하거나, 코드가 이미 구별하던 것을 kind 로 승격하는 것이었다(자의적 창작 0건).

그리고 **§3 이 A 를 강화한다.** "실패 아님" 을 표현해야 한다는 요구가 새로 생겼는데,
A 는 wire `kind: 'informational'` 하나로 끝난다. B(프론트 역추론)로는 이 구분이
다시 6벌 표 문제로 돌아간다 — 지금 `rest_bypassed` 를 허용목록에서 빼는 처리가
`candleEmptyState` 한 곳에만 있고 나머지 5곳은 각자 알아서 하는 것이 그 증거다.

**권고: A 유지.** Phase 0 결과가 근거를 강화했다.

## 6-b. 구현 중 드러난 것 — 생성기가 17곳이 아니라 22곳이었다

`def _…warning(` · `warnings.append({` 패턴 grep 은 **인라인 생성기 5곳을 놓쳤다**
(`live_candle_backfill.py` 4곳 · `live/api.py` 1곳). 사전 목록으로 범위를 잡으면
누락되고, `"reason":` 잔여 검색으로 **사후 확인**해야 전수가 닫힌다. 다음 이관에서도
같은 순서로 할 것: 목록 → 이관 → **잔여 grep** → 테스트.

## 7. 남은 결정

1. 새 kind 2종(`deferred` · `data_quality`) + `informational` 을 `LiveErrorKind` 에
   추가할지, 아니면 `kind` 와 별개 축(`severity` / `is_failure`)으로 둘지
2. `capacity_overloaded` 이중 생성 경로를 통합할지(별건 정리로 뺄지)
3. `intraday_` 접두를 wire 에서 벗길지, 프론트에서 벗길지
