# 0055 — /live 투자자 순매수(외국인/기관) 일봉 보조지표: 별도 endpoint + D-only

**Status:** accepted (2026-05-31)

**Related:**
- ADR-0003 (t_ms Unix-ms)
- ADR-0013 (RangeBundle single read-path)
- ADR-0040 (Live Candle Backfill 별도 cache + 별도 wire)
- ADR-0048 (D-direct daily backfill — 직접 형제)
- ADR-0050 (KIS rate-limit retry in client)

## Decision

`/live` 일봉 차트에 외국인/기관 **순매수 수량**을 보조지표로 추가한다. KIS
`inquire-investor` (TR_ID `FHKST01010900`) 연동:

1. **별도 endpoint** `GET /api/live/past-investor-net?code=`. 응답
   `{code, points:[{t_ms, foreign_net, institution_net}], data_warnings, cached}`.
   일봉 응답(`past-daily-candles`)에 끼워넣지 않는다 — 범위·캐시 수명이 비대칭.
2. **날짜 범위 없음 / 최근 ~30영업일 고정**. KIS API가 from/to를 안 받고 최근 약
   30거래일만 반환. 종목당 KIS 1회 호출.
3. **별도 메모리 cache** `PastInvestorNetCache`: per-code `(fetched_at, points)` +
   flat 60s TTL. 일봉의 batch/gap 머신 재사용 거부 — 30일 단발엔 불필요한 복잡도.
   빈 결과도 캐싱(negative cache)해 no-data 종목의 재호출 차단.
4. **D(일봉) 전용**. 투자자 점은 일별 09:00 KST 앵커(`_daily_anchor_t_ms`, 일봉과
   공유). W/M은 캔들을 주/월 segment로 집계하므로 일별 점이 정렬되지 않는다
   (`axis.contains` 탈락). 따라서 fetch와 pane 모두 `timeframe === 'D'` 에서만.
5. **부호색 막대**. 순매수(net≥0) = `--price-up`(빨강), 순매도(net<0) =
   `--price-down`(파랑). 거래량 막대와 동일. 외국인/기관 각각 별도 히스토그램 pane.

## Why

- **별도 endpoint (옵션 1 거부)**: 일봉은 임의 과거를 무한 backfill하지만 투자자는
  30일 고정창. 한 응답에 합치면 backfill 구간 전체를 null로 채우고 서로 다른 두
  캐시 수명을 한 endpoint에 묶게 된다.
- **별도 배열 `investorPoints[]` (Candle 확장 거부)**: 분봉/일봉이 공유하는 `Candle`에
  투자자 필드를 넣으면 분봉이 평생 의미 없는 null을 보유한다. 기존
  `FillStrengthPoint`/`QuoteRatioPoint` 관례(비-OHLC 시계열은 별도 배열) 답습.
- **D 전용**: 사용자 의도가 "일봉" 보조지표. W/M 집계와 일별 앵커의 불일치를 깔끔히
  회피(거의 빈 pane 대신 pane 없음).
- **부호색 (항목별 색상 picker 거부)**: 외국인/기관이 이미 별도 pane으로 구분되므로
  색은 매수/매도 흐름에 할당하는 게 정보량이 높다. DESIGN.md 토큰 사용.

## Trade-offs

- **(채택) 30일 제약 수용.** KIS API 한계. 일봉을 수개월 봐도 막대는 최근 ~30일
  구간만. 장기 누적(스케줄러 + DB)은 범위 밖 — 미래 spec.
- **(채택) tolerant output 파싱.** `fetch_investor_net`이 `output`/`output1`/`output2`
  중 첫 list를 스캔. 라이브 envelope 키가 문서와 달라도 silent zero-bar(no error →
  negative-cached)를 회피. 라이브 dogfooding(code=005930 → 30 signed points,
  2026-05-31)으로 `output` 키 확인.
- **(채택) optional overlay.** 투자자 fetch는 `useLiveBundle`의 isLoading/error에서
  제외 — 실패해도 캔들 차트는 정상 렌더. opt-in(기본 off), localStorage
  `live.indicators.v1`에 additive merge(legacy 스토어는 미설정 → false).

## Consequences

- CONTEXT.md에 "Live Investor Net" 용어 추가 (Live Candle Backfill sibling).
- `RangeBundle.investorPoints[]` 추가 — `buildLiveBundle`은 `[]` 기본,
  `useLiveBundle`이 D에서 override.
- `PaneId`에 `investor-foreign`/`investor-institution` 추가 (drawing 참여 가능,
  ADR-0028).
- `paneSpecsForTimeframe(tf, investor)` — 토글을 인자로 받아 D에서 조건부 pane을
  canonical 순서로 append. lightweight-charts v5의 paneIndex 클램프 + 빈 pane
  자동 제거에 의존해 토글이 자가치유.

## Trigger Conditions

(미래에 본 ADR을 supersede할 조건)

- 사용자가 30일보다 긴 투자자 추이를 요구 → 일별 수집 스케줄러 + 영속 저장 필요.
- W/M에서도 투자자 데이터를 보여야 함 → 주/월 집계(net 합산) 경로 추가.
- 투자자 *금액*(`_ntby_tr_pbmn`)이나 개인 투자자(`prsn_ntby_qty`)가 필요 → 와이어
  모델 확장.
