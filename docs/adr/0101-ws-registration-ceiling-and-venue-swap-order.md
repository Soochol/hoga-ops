# 0101 — WS 연결당 등록 상한 41 실측: venue 스왑 순서 수정 + 슬롯 30→39

**Status:** accepted (2026-07-10)

**Related:**
- ADR-0067 (라이브 커버리지 하이브리드) — "appkey당 41등록, 종목당 3등록 → 1계좌 13종목"을 이미 명시(2026-06-09). 본 ADR이 그 41을 실측 확증하고 코드의 보수적 30(10종목)을 원 설계값 39(13종목)로 올린다.
- ADR-0096 (통합 venue 하이브리드) · #524/#525 (venue 시분할 WS 스왑) — 스왑을 도입한 원본. "슬롯 여유 계정당 ~16" 서술을 정정.
- `docs/superpowers/specs/2026-07-09-un-venue-time-multiplexed-ws-design.md` — 스왑 사이징을 "계정당 30건, 종목당 2 TR, 찰나 2배 점유, 여유 충분"으로 서술(§슬롯 예산·:118). KRX는 3 TR(거래원 포함)이고 register-first 찰나 점유는 5 TR이라 이 산정이 틀렸음을 정정.
- `hoga/live/ws_client.py` `ensure_venue` · `hoga/live/coverage.py` `KIS_WS_MAX_REGISTRATIONS` · `hoga/live/ws_fields.py` `TRS` — 구현점.

## Context

KIS WS 연결당 등록 상한을 실측했다(2026-07-10, kis_ws_ceiling_probe): 단일 연결에 40종목 × 3 KRX TR을
점증 등록 → **41등록까지 성공, 42번째부터 `OPSP0008: MAX SUBSCRIBE OVER` 거부**. 즉 **연결당 하드 상한 = 41**
(연결=approval_key당 독립 — 3연결 총 120등록 성공이 명의-합산 아님을 확증). 이 값은 ADR-0067이 2026-06-09에
이미 적어 둔 "appkey당 41등록"과 정확히 일치하며, 코드 `KIS_WS_MAX_REGISTRATIONS=30`(계정당 10종목)은
그보다 보수적으로 미달 프로비저닝돼 있었다.

**그런데 venue 스왑이 이 상한과 충돌한다.** watchdog(30초)이 순수 시계로 하루 2회(08:50 NXT→KRX,
15:31 KRX→NXT) `ws_client.ensure_venue`를 무조건 구동한다(설정/플래그 없는 기본 동작). 이 스왑은
**register-before-unregister**라 전환 찰나 구 venue와 신 venue를 동시 점유한다 — KRX(3 TR)↔NXT(2 TR)이므로
종목당 **5 TR**, 10종목이면 **50등록 > 41**. 즉 **현재 10종목 구성도 스왑 찰나 41을 초과**해 신 venue 등록
일부가 OPSP0008로 조용히 거부된다(재시도 없음). 특히 08:50 NXT→KRX 스왑에서 KRX 재등록분이 거부되면
정규장 캡처 구멍이 된다. 2026-07-09 스펙은 이 찰나 점유를 "종목당 2 TR, 찰나 2배, 여유 ~16/계정"으로
과소평가했다(KRX 3 TR·거래원 누락, register-first 5 TR 누락).

따라서 슬롯을 13종목(39등록)으로 올리려면 스왑 찰나 점유(65등록)가 상한을 더 크게 넘으므로, **슬롯 상향
전에 스왑 순서를 고쳐야 한다.**

## Decision

1. **venue 스왑을 unregister-before-register로 뒤집는다** (`ensure_venue`). 구 venue를 먼저 해제해 슬롯을
   비운 뒤 신 venue를 등록 → 찰나 점유가 종목당 max(3,2)=3(=39)으로 떨어져 상한 41 안에 든다. 이는 같은
   파일 `update_codes`의 remove-before-add와 동일 패턴이다. register-first가 피하려던 "수신 공백"은 스왑
   시각(08:50·15:31)이 저장창(정규장 09:00–15:30) **밖**이라 캡처 무손실 — 그 찰나 공백은 무해하다.

2. **`KIS_WS_MAX_REGISTRATIONS` 30 → 39** (계정당 13종목 × 3 TR). ADR-0067이 명시한 원 설계값이자
   실측 상한 41 아래 여유 2. 파생값(`_PER_ACCOUNT_MAX=13`, `LIVE_SET_MAX_CODES`, 파티션)은 자동 연동.

3. **OPSP0008 전용 처리는 넣지 않는다.** unregister-first로 정상·스왑 모두 39 ≤ 41이 보장되므로 초과가
   구조적으로 발생하지 않는다. 상한 처리는 불필요한 방어 코드가 된다(발생 조건이 사라짐).

## Consequences

- 계정당 WS 실시간 종목 10 → **13** (30% 증가). 3계정이면 30 → **39종목**. watchlist 상위 절단 경계가
   계정당 +3씩 밀린다.
- **기존 스왑 버그 동시 수정**: 10종목 구성에서 하루 2회 스왑 시 발생하던 OPSP0008 부분 거부(특히 08:50
   KRX 재등록 실패 = 하위 ~3종목 정규장 캡처 구멍)가 사라진다. 이건 슬롯 상향과 무관하게 그 자체로 버그
   수정이다.
- 스왑 시 찰나 공백(구 venue 해제 ~ 신 venue 등록 사이, 종목당 수 ms)이 08:50·15:31에 생기나 저장창
   밖이라 캡처 무손실. 표시 연속성만 그 찰나 흔들리며 장전/장후라 저영향.
- venue 스왑 빈도·점유는 unregister-first라 이제 종목당 3을 넘지 않아, 슬롯을 41까지(13종목) 안전하게 쓸 수
   있다. 그 이상(14종목=42)은 상한 초과라 불가.

## 잔여 / 비범위

- **NXT 시간대 유휴 슬롯**(종목당 2 TR만 구독 → 계정당 26/39 provisioned) 활용은 별도 결정(ADR-0096 보류
   항목). 본 ADR은 사이징을 KRX 3 TR worst-case로 유지.
- 연결당 상한 41의 상단 재확인(41이 하드인지 계정 상태별로 변동인지)은 미탐색 — 39는 여유 2라 견고.
- 계정 수 확장(4번째 앱키)은 자동(configured_account_ids) — 본 ADR 무관.
