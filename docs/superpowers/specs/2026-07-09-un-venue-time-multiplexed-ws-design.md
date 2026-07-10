# 통합(UN) venue 시분할 WS: KRX 정규장=KRX 구독, NXT 시간대=NXT 구독 — Design

**Date**: 2026-07-09
**Status**: Approved (슬롯 사이징 정정 2026-07-10 — ADR-0101)

> **정정 (2026-07-10, ADR-0101):** 본 스펙의 슬롯 예산 서술("계정당 30건, 종목당 TR 2개(호가+체결)", "등록 먼저·해제 나중, 찰나 2배 점유, 여유 ~16/계정")은 틀렸다. KRX는 3 TR(호가+체결+**거래원**)이고, register-before-unregister 스왑은 찰나 종목당 **5 TR**(KRX3+NXT2)을 점유한다. 연결당 실측 상한은 **41**(OPSP0008)이라 10종목 스왑(50)이 이미 초과한다. ADR-0101이 스왑을 **unregister-before-register**로 고치고(찰나 점유 3 TR), 슬롯을 계정당 **13종목(39등록)**으로 올렸다. 아래 본문은 이력으로 보존한다.
**Scope**: hoga/live/session_gate.py, hoga/live/ws_client.py, hoga/live/ws_fields.py, hoga/live/lifecycle.py, hoga/live/stream.py, frontend/src/live/liveVenuePolicy.ts, frontend/src/state/liveVenue.ts, frontend/src/live/useLiveBundle.ts, frontend/src/live/deriveCurrentPriceLine.ts

## Problem

통합(UN) venue의 목적은 "KRX 정규장엔 KRX 기준 실시간, 나머지(NXT 전용
시간대 08:00~09:00·15:30~20:00)엔 NXT 캔들 가시성"이다(사용자 정의,
ADR-0096). ADR-0096(PR #518)이 정규장 실시간을 열었지만 NXT 시간대는 여전히
폴링(캔들 60초·라인 10초)이고, 호가 pane은 그 시간대에 KRX 호가가 박제된 채
침묵한다.

핵심 관찰: WS 캡처 게이트(session_gate.ws_capture_window)는 이미 "거래일 &&
정규장(09:00~15:30)"만 저장한다 — NXT 전용 시간대의 KRX WS 데이터는 원래
버려진다. 따라서 그 시간대에 KRX 구독을 NXT 구독으로 **스왑해도 캡처 손실이
0**이고, 슬롯도 종목당 2개 그대로다. "스왑=캡처 구멍" 반론(ADR-0096의 기각
사유)은 정규장 중 스왑에만 적용된다.

부수 결정: NXT 단독 venue는 사용자 가치가 없어(전부 폴링, 통합이 상위호환)
**제거**한다.

## Invariants

- **캡처 연속성**: KRX 정규장(09:00~15:30) 중 관심종목의 KRX 호가/체결 WS
  캡처는 끊기지 않는다 — 로컬 유일 사본. 근거: [ADR-0093](../../adr/0093-upstream-gap-confirmation-and-skip.md),
  [session_gate.py](../../../hoga/live/session_gate.py) ws_capture_window.
- **저장 게이트 = 정규장**: 디스크 저장(flush)은 거래일 정규장에만 일어난다.
  장후 시간외 캡처 포기는 의도적 회귀(spec §11). 근거: [stream.py](../../../hoga/live/stream.py) 헤더,
  session_gate.ws_capture_window docstring.
- **슬롯 예산**: KIS WS 등록은 계정당 30건, 종목당 TR 2개(호가+체결). 근거:
  [coverage.py](../../../hoga/live/coverage.py) KIS_WS_MAX_REGISTRATIONS.
- **라인=캔들 close**: 현재가 라인과 forming 캔들 close는 같은 체결 판정
  게이트를 공유한다. 근거: [deriveCurrentPriceLine.ts](../../../frontend/src/live/deriveCurrentPriceLine.ts)
  freshLiveTradePrice 주석, ADR-0096.
- **Venue 순도**: 한 venue의 캔들에는 그 venue 기준의 체결만 섞인다(통합
  venue의 정규장 KRX 체결은 ADR-0096이 정당화한 근사). 근거: ADR-0096.
- **마감 동시호가 캡처**: 15:30 마감 단일가 체결은 캡처에 포함된다. 근거:
  ws_capture_window가 15:30 포함 판정(market_phase regular).

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| 캡처 연속성 | preserves | 스왑은 저장 게이트 밖 시간대에서만 발생; KRX 정규장 캡처 경로는 byte-for-byte 불변(성역 격리) |
| 저장 게이트 = 정규장 | preserves | 게이트 분리 후에도 저장 창은 불변; 연결 창만 08:00~20:00으로 확대 |
| 슬롯 예산 | preserves | 스왑이므로 종목당 2 TR 유지 |
| 라인=캔들 close | preserves | 게이트 함수 교체(시간→venue 태그)여도 단일 구현점 유지 |
| Venue 순도 | preserves (강화) | 시간 추론 → 스냅샷 venue 태그 매칭으로 구조적 보장 |
| 마감 동시호가 캡처 | breaks conditionally | KRX→NXT 스왑을 15:30 정각에 하면 마감 체결 유실 가능 → 스왑을 저장 게이트 완전 종료 확인 후(≥15:31, 권장 15:35)로 지연해 회피 |
| **§11 무게이트 표시** | **breaks (coupled)** | 표시 경로(on_tick의 buffer.publish)는 현재 무게이트(§11). 연결 창을 08~20으로 넓히면 장전 KRX 예상체결이 표시로 새어 KRX venue에 유령 forming 캔들을 만든다. → 표시 억제 게이트가 필요하고 그 게이트는 **venue 인지**여야 함(장외 NXT 틱은 표시해야 하므로). 따라서 연결창 확대는 venue 태그 없이는 안전하지 않다. |

마감 동시호가 행: 스왑 시각에 안전 마진을 두는 것으로 검출·회피 가능하므로
설계로 봉인한다(Stage 3 수용 기준에 포함).

## Goals

- 통합 venue에서 NXT 전용 시간대(08:00~09:00, 15:30~20:00)의 캔들·현재가
  라인·호가 pane이 NXT WS 기준 실시간(≤150ms 코얼레싱)으로 움직인다.
- KRX 정규장 캡처·슬롯 사용량·저장 데이터 스키마는 변화 0.
- KRX/NXT 구분이 시간 추론이 아니라 스냅샷 venue 태그로 구조화된다.
- NXT venue 제거로 venue 선택지가 KRX/통합 2개로 단순화된다.

## Non-Goals

- 정규장 중 통합 캔들의 "진짜 합산 실시간"(NXT 체결분 실시간 반영) — KRX
  체결 근사 + 60초 통합 REST 보정(ADR-0096) 유지. 필요 시 H0UNCNT0 별도 검토.
- NXT 시간대 데이터의 디스크 캡처 — 저장 게이트는 불변(스펙 §11 회귀 유지).
- 관심종목 밖 종목(REST 폴러 2s 경로, ADR-0067)의 실시간화.
- KRX 예상체결(08:50~09:00) 표시 — 그 창의 구독이 NXT로 바뀌며 자연 상실
  (현재도 캡처하지 않는 데이터).

## Design

### 시분할 타임라인 (거래일 기준)

```
08:00        09:00                  15:30  ~15:35        20:00
  │ NXT 구독   │ KRX 구독 (캡처 ON)    │ 마진 │ NXT 구독     │ (게이트 밖)
  │ 표시 전용  │ 현행과 완전 동일       │      │ 표시 전용    │ 연결 종료
```

- 스왑 경계는 백엔드 세션 게이트(캘린더 인지)가 판정 — 변칙 세션(수능일 등)
  자동 대응. 프론트 고정시간 판정보다 정확.
- 15:30→NXT 스왑은 저장 게이트가 닫힌 것을 확인한 후(≥15:31, 마감 단일가
  체결 flush 보존 마진) 실행.

### Stage 1 — 게이트 분리: 연결 창 vs 저장 창

현재 `ws_capture_window`가 "새 WS 연결 수립"과 "flush(저장)"를 겸한다.
이를 분리한다:

- `ws_connection_window(now_ms)`: 거래일 && 08:00~20:00 — ws_client의
  gate_fn이 이것을 사용. NXT 시간대에도 연결 유지/재수립.
- `ws_capture_window(now_ms)`: 불변(거래일 && 정규장) — stream의 flush
  게이트 전용.
- 다운샘플러 carry 오염 방지: 저장 게이트 밖에서 수신한 틱이 다음 flush
  윈도로 carry되지 않는지 확인(기존 "게이트 열어두면 유령 스냅샷" 문제의
  역방향). 필요 시 게이트 폐쇄 시점에 downsampler clear.

이 단계만으로는 동작 변화 없음(구독이 여전히 KRX, NXT 시간대엔 KRX 틱이
거의 없음) — 순수 리팩터 + 연결 창 확대.

### Stage 2 — NXT TR 배선 + venue 태그

- ws_fields.py에 NXT TR 상수(H0NXASP0/H0NXCNT0) 추가, 필드 위치를 공식
  open-trading-api 리포와 **실측 대조**(위치 기반 파싱이므로 필수. KRX와
  레이아웃 거의 동일 확인됨 — H0UNCNT0 대조 기준).
- WsTick/LiveSnapshot payload에 `venue: "KRX" | "NXT"` 태그 추가. 기존 KRX
  경로는 "KRX" 태그(스키마 하위호환: 프론트는 태그 부재=KRX 해석).
- SSE/WS publish 경로로 태그 전달. 저장 경로는 태그와 무관(저장 게이트가
  정규장=KRX만 통과시키므로 저장 스키마 불변).

### Stage 3 — 시분할 스케줄러 스왑

- lifecycle에 세션 게이트 구동 스왑 태스크: 경계에서 `tr_type=2`(구TR 해제)
  → `tr_type=1`(신TR 등록). 등록 먼저·해제 나중(찰나 2배 점유, 여유 ~16/계정
  으로 안전)으로 수신 공백 회피.
- ws_client에 TR세트 교체 능력 추가(현재 `_TRS` 고정·종목 단위 add/remove만).
- 상태 표면화: /api/live/status에 현재 구독 venue(`ws_venue: "KRX"|"NXT"`)
  노출 — 진단용(이중 백엔드·스왑 실패 지문).
- 실패 모드: 스왑 실패 시 재시도 + 이전 TR 유지(수신 공백보다 구TR 데이터가
  낫다 — NXT 시간대의 KRX TR은 무해한 침묵).

### Stage 4 — 프론트: venue 태그 게이트 + NXT venue 제거

- `liveVenueAllowsKrxTradeOverlay(venue, tMs)` → 태그 매칭 게이트로 교체:
  "스냅샷 태그가 (캔들 venue가 그 시각에 원하는 시장)과 일치". ADR-0096의
  시간 게이트를 대체(구현 흡수; KRX venue도 태그 매칭 필요 — NXT 시간대에
  도착하는 NXT 태그 체결이 KRX 캔들에 섞이면 안 됨).
- 호가 pane: NXT 시간대에 NXT 호가 표시. 상태바 "호가 KRX" 배지를 시간대별
  "호가 KRX/NXT"로.
- NXT venue 제거: LIVE_VENUE_OPTIONS에서 'NXT' 삭제, 저장된 'NXT' 설정
  마이그레이션(→ 'UN'), liveVenuePolicy·테스트 정리. 백엔드 REST venue=NXT
  지원은 유지(프론트 UI만 제거).

## Risks / Open questions

- **NXT TR 필드 레이아웃**: 공식 리포 대조로 시작하되 실기기 수신 프레임으로
  최종 검증(Stage 2 수용 기준). KIS 필드 검증 원칙: 공식 리포 COLUMN_MAPPING.
- **NXT 시간대 체결 빈도**: 유동성이 낮아 체감 실시간성이 제한적일 수 있음
  (기능 정확성과 무관, 기대치 관리).
- **downsampler carry**: Stage 1에서 게이트 밖 틱의 carry 경로를 테스트로
  봉인해야 NXT 틱이 다음 거래일 첫 flush를 오염시키지 않는다.
- **frontend 태그 하위호환**: Stage 4 이전 백엔드(태그 없음)와 이후 프론트가
  섞이는 배포 창 — 태그 부재=KRX 해석으로 안전.

## Stage 1 스코핑 중 발견 (2026-07-09) — 결합 재구조화

원래 4단계 분할(게이트 분리 → NXT TR+태그 → 스왑 → 프론트)은 백엔드 3단계가
독립 랜딩 가능하다고 가정했으나, 코드 정독 결과 두 가지가 드러났다:

1. **carry 봉인은 이미 완료**: 저장 게이트 밖 틱이 다음 거래일을 오염시키지
   않는 불변식은 `_gate_open` 플래그 + drain-reset로 이미 보장되고
   `test_run_flush_loop_drains_resets_and_reopen_has_no_ghost_carry`가 커버.
   Stage 1의 신규 작업 아님.

2. **연결 창 확대는 단독으로 안전하지 않음**: §11 무게이트 표시 위 참조. 연결을
   08~20으로 넓히면 장전 KRX 예상체결이 표시로 새고, 이를 막는 표시 게이트는
   venue 인지여야 하며 venue 태그(구 Stage 2)에 의존한다. 즉 **연결 창 + NXT TR
   + venue 태그 + venue-인지 표시 게이트 + 스왑은 하나의 결합 유닛**이다.

또한 NXT TR 필드 위치와 15:30 스왑 경계(마감 동시호가 캡처)는 실제 KIS 수신
프레임 + 장중 시간대로만 최종 검증된다 — 헤드리스 합성 프레임은 불충분.

## Stages → Issues (재구조화)

**Stage A — 백엔드 WS 시분할 멀티플렉싱 (1개 결합 유닛, 실장 검증 필수)**

한 PR로 결합 랜딩(부분 랜딩 시 위 회귀·미검증 위험):
- 연결 게이트 분리: `ws_connection_window`(거래일 08~20) vs `ws_capture_window`(정규장 불변)
- NXT TR(H0NXASP0/H0NXCNT0) 파싱 + 스냅샷 `venue` 태그(태그 부재=KRX 하위호환)
- venue-인지 표시 게이트: 정규장 이외엔 KRX 틱 표시 억제, NXT 틱은 표시 허용
- 세션 게이트 구동 KRX↔NXT TR 스왑(등록 먼저·해제 나중, 15:30 마감 마진 ≥15:31)
- `/api/live/status`에 `ws_venue` 표면화
- **성역 격리 계약**: KRX 정규장 캡처(저장) 경로는 byte-for-byte 불변. NXT 파싱이
  틀려도 손실은 NXT 표시(비성역·정정가능)에 국한. 실장 검증 = 실프레임 필드 대조
  + 09:00/15:30 경계 캡처 무손실 확인.

**Stage B — 프론트 (Stage A 랜딩 후)**
- venue 태그 매칭 게이트로 ADR-0096 시간 게이트 대체
- 상태바 호가 배지 시간대화(호가 KRX/NXT)
- NXT venue 제거 + 저장 설정 'NXT'→'UN' 마이그레이션 (스펙상 마지막 순서)

실장 대기: Stage A는 장중(개장 후) 실프레임으로 구현·검증한다. 그때까지 본 스펙과
이슈가 정본.
