# 0096 — 통합(UN) venue 하이브리드: KRX 정규장엔 KRX 체결 실시간, 나머지는 통합 REST

**Status:** accepted (2026-07-09)

**Amended (2026-07-10 — ADR-0101):** 본문의 "슬롯 여유 계정당 ~16"과 venue 스왑 사이징 전제는 정정됐다 — 연결당 등록 상한은 실측 41이고, 스왑(register-before-unregister)은 찰나 종목당 5 TR을 점유해 10종목도 50>41로 초과한다. ADR-0101이 스왑을 unregister-before-register로 고치고 슬롯을 계정당 13종목(39등록)으로 올렸다.

**Related:**
- `frontend/src/live/liveVenuePolicy.ts` — `liveVenueAllowsKrxTradeOverlay` (게이트 단일 구현점)
- `frontend/src/live/useLiveBundle.ts` — `overlayLiveTradesOnCandles` (WS 체결 → forming 캔들 병합)
- `frontend/src/live/deriveCurrentPriceLine.ts` — `freshLiveTradePrice` (현재가 라인 fresh 체결가)
- PR #491 — /live 캔들 소스 이분법 (venue 개념 도입 맥락)

## Context

/live 캔들 venue가 통합(UN)일 때 forming 캔들·현재가 라인이 실시간으로 움직이지
않았다(라인 = quote 10초 폴, 캔들 = 통합 REST 60초 재조회). 원인은 의도된 차단:
백엔드 KIS WS는 KRX 체결(H0STCNT0)만 구독하는데, KRX 단독 체결을 KRX+NXT 합산
기준인 통합 캔들에 실시간으로 섞으면 가격·거래량이 통합 정본과 어긋날 수 있어
`liveVenueAllowsKrxTradeOverlay`가 KRX venue 외 전부를 차단했다.

사용자 요구를 분해하면 통합 venue의 목적은 **NXT 전용 시간대(08:00~09:00,
15:30~20:00)의 캔들 가시성**이고, KRX 정규장(09:00~15:30) 중에는 KRX 기준
실시간이면 충분하다. 그런데 기존 차단은 venue 단위 전면 차단이라, 정규장
시간대까지 실시간을 잃는 과잉 차단이었다.

## Decision

통합(UN) venue를 시간대 하이브리드로 정의한다:

- **KRX 정규장(09:00~15:30 KST) 체결** → KRX WS 체결을 forming 캔들 병합과
  현재가 라인의 실시간 정본으로 허용.
- **그 외 시간대(NXT 전용 창) 체결** → 차단 유지. 캔들·라인은 통합 REST
  폴링(분봉 60초 재조회, quote 10초)이 정본 — 이 창의 통합 데이터는 사실상
  NXT 체결만 반영한다.
- **NXT venue** → 변경 없음(전면 차단). NXT 단독 캔들에 KRX 체결은 다른 시장이다.

판정은 `liveVenueAllowsKrxTradeOverlay(venue, tMs)` 한 곳에서 **체결 시각
단위**로 내린다(기존 시그니처가 이미 `tMs`를 받고 있었다). 캔들 병합과 현재가
라인이 같은 함수를 쓰므로 "라인 = 캔들 close" invariant는 유지된다.

## Rationale

- **정규장 중 KRX ≈ 통합 가격**: 동일 종목 양시장은 SOR·차익거래로 사실상 붙어
  움직인다. 오차는 주로 거래량(NXT 체결분 미반영)인데, 60초 통합 REST 재조회가
  forming 캔들을 정본으로 계속 덮어써 1분 내 자가 수정된다.
- **NXT 전용 시간대에는 KRX 정규장 체결이 존재하지 않는다**: 시간대 게이트만으로
  "잘못 섞일 데이터" 자체가 없다. (KRX 시간외단일가 15:40~16:00 체결이 WS로
  흘러도 게이트가 15:30 초과를 걸러 통합 캔들 오염이 없다.)
- **백엔드·캡처 무영향**: 구독 변경/슬롯 소모/저장 데이터 변경 없음. 순수 프론트
  표시 정책.

## Alternatives rejected

- **통합 체결(H0UNCNT0) 추가 구독**: 전 시간대 틱 실시간이 되는 정공법. 백엔드
  TR 파싱 추가·표시 전용 라우팅(저장 경로 격리)·view-driven 구독 관리가 필요한
  중규모 작업이라 보류. 본 하이브리드와 충돌하지 않으므로 NXT 시간대 실시간이
  필요해지면 그때 얹는다. (슬롯 여유는 계정당 ~16개로 확인됨.)
- **KRX↔통합 구독 스왑**: KRX 체결 캡처(매물대·POC·체결강도의 원천, 로컬 유일
  사본)에 영구 구멍을 내므로 거부.
- **venue 전면 허용(시간대 무관)**: NXT 전용 시간대에… KRX 체결이 없어 실익이
  없고, KRX 시간외단일가 체결이 통합 캔들을 오염시키는 벡터만 열린다.

## Consequences

- 통합 venue 정규장: 캔들·라인 ≤150ms 실시간(KRX venue와 동일 체감).
- 통합 venue NXT 시간대: 현행 유지(캔들 60초, 라인 10초) — 가시성이 목적인 창.
- forming 캔들 거래량은 정규장 중 KRX분만 실시간 가산되고 재조회 때 통합으로
  보정된다(최대 60초 창의 과소 표시). 가격(고저·종가)은 체감 차이 없음.
