# 0055 — /live 투자자 순매수(외국인/기관) 일봉 보조지표: 별도 endpoint + D-only + 장기 walk-back

**Status:** accepted (2026-05-31)

**Related:**
- ADR-0003 (t_ms Unix-ms)
- ADR-0013 (RangeBundle single read-path)
- ADR-0040 (Live Candle Backfill 별도 cache + 별도 wire)
- ADR-0048 (D-direct daily backfill — 인프라 직접 재사용)
- ADR-0050 (KIS rate-limit retry in client)

## Decision

`/live` 일봉(D) 차트에 외국인/기관 **순매수 수량**을 보조지표로 추가한다. KIS
`investor-trade-by-stock-daily` (TR_ID `FHPTJ04160001`, HTS [0416] 종목별 일별동향) 연동:

1. **별도 endpoint** `GET /api/live/past-investor-net?code=&from=&to=`. 응답은
   일봉(`past-daily-candles`)과 동형: `{code, from, to, points:[{t_ms, foreign_net,
   institution_net}], cached_batches, fresh_batches, data_warnings}`.
2. **장기 date-cursor walk-back**. KIS는 `FID_INPUT_DATE_1`(기준일) + ~30영업일을
   `output2`로 주고, 우리는 기준일을 (page oldest − 1)로 옮기며 `from`까지 페이징한다
   — 일봉 `fetch_past_daily_candles`(FHKST03010100)의 cursor walk-back과 동일.
   (라이브 dogfooding: code=005930, 2025-01~2026-05 → 341 영업일.)
3. **일봉 인프라 재사용**: `_compute_daily_gaps`, `PastDailyCandlesCache`(batch +
   today tri-state), from/to 엔드포인트 패턴을 그대로. 투자자 전용 캐시는 두지 않는다
   (`PastDailyCandlesCache`는 dict batch를 저장하는 제네릭 캐시).
4. **D(일봉) 전용**. 투자자 점은 일별 09:00 KST 앵커(`_daily_anchor_t_ms`, 일봉과
   공유). W/M은 캔들을 주/월 segment로 집계하므로 일별 점이 정렬되지 않는다
   (`axis.contains` 탈락). 따라서 fetch와 pane 모두 `timeframe === 'D'` 에서만.
5. **부호색 막대**. 순매수(net≥0) = `--price-up`(빨강), 순매도(net<0) =
   `--price-down`(파랑). 거래량 막대와 동일. 외국인/기관 각각 별도 히스토그램 pane.

## Why

- **FHPTJ04160001 (inquire-investor 거부)**: 초안은 `inquire-investor`(FHKST01010900)를
  썼으나, 그것은 날짜/연속조회 파라미터가 없어 **최근 ~30영업일 고정**이다(5개 독립
  출처 + 라이브 확인; 연속조회 `tr_cont`/`ctx_area` 미지원). `FHPTJ04160001`은
  `FID_INPUT_DATE_1` re-anchor로 임의 장기를 준다. 필드명(`frgn/orgn_ntby_qty`)은
  동일하고 같은 날짜의 값도 일치 — silent 변경 없이 장기로 확장.
- **일봉 인프라 재사용**: 투자자도 일봉과 같은 "from/to + 무한 backfill + 확정 일별"
  특성이라, 별도 batch 캐시·gap 로직을 새로 만들지 않고 일봉 것을 그대로 쓴다.
- **별도 endpoint**: 응답 스키마가 일봉과 동형이지만 *별도 KIS TR + 별도 cache 키
  네임스페이스*라 한 endpoint로 합치지 않는다(분봉/일봉이 별도인 ADR-0040/0048과 동형).
- **별도 배열 `investorPoints[]` (Candle 확장 거부)**: 분봉/일봉이 공유하는 `Candle`에
  투자자 필드를 넣으면 분봉이 평생 의미 없는 null을 보유한다. 기존
  `FillStrengthPoint`/`QuoteRatioPoint` 관례(비-OHLC 시계열은 별도 배열) 답습.
- **D 전용 / 부호색**: (W/M 집계와 일별 앵커 불일치 회피 / 외국인·기관은 pane으로
  이미 구분되므로 색은 매수·매도 흐름에 — DESIGN.md 토큰.)

## Trade-offs

- **(채택) walk-back 호출 비용.** 장기 조회는 ~30일/page라 N년 ≈ N×12 KIS 호출.
  batch/gap 캐시가 재조회를 막고, rate-limit은 ADR-0050 retry + partial+`data_warnings`로
  처리. 일봉과 동일 특성.
- **(주의) 당일 행은 가집계.** FHPTJ04160001은 당일분을 ~15:40 이후 가집계 산출 →
  today 행은 잠정(일봉 today tri-state로 처리). 과거 행은 확정.
- **(채택) output2 고정 + envelope 라이브 검증.** `output2`가 일별 배열(`output1`은
  현재가 요약 dict). 추측이 아니라 라이브 probe(code=005930, 2026-05)로 확정.
- **(채택) optional overlay / opt-in.** 투자자 fetch는 `useLiveBundle`의
  isLoading/error에서 제외 — 실패해도 캔들 차트는 정상 렌더. opt-in(기본 off),
  localStorage `live.indicators.v1`에 additive merge(legacy 스토어는 미설정 → false).
- **(폐기) inquire-investor 30일 단발 + `PastInvestorNetCache`(flat-TTL).** API 교체로
  제거; 일봉 batch 캐시로 통합.

## Consequences

- CONTEXT.md "Live Investor Net" 용어 (Live Candle Backfill sibling) — FHPTJ04160001
  기준으로 기재.
- `RangeBundle.investorPoints[]` 추가 — `buildLiveBundle`은 `[]` 기본,
  `useLiveBundle`이 D에서 override. 프론트 hook은 from/to를 받는다(일봉 hook과 동형).
- `PaneId`에 `investor-foreign`/`investor-institution` 추가 (drawing 참여 가능,
  ADR-0028).
- `paneSpecsForTimeframe(tf, investor)` — 토글을 인자로 받아 D에서 조건부 pane을
  canonical 순서로 append. lightweight-charts v5의 paneIndex 클램프 + 빈 pane
  자동 제거에 의존해 토글이 자가치유.

## Trigger Conditions

(미래에 본 ADR을 supersede할 조건)

- W/M에서도 투자자를 보여야 함 → 일별 net을 주/월 합산하는 집계 경로 추가.
- 투자자 *금액*(`_ntby_tr_pbmn`)이나 개인/세부기관(투신·연기금·보험 등)이 필요 →
  와이어 모델 확장(output2는 이미 그 컬럼들을 담고 있음).
- walk-back 호출량이 rate-limit 비용으로 커지면 → 디스크 영속 캐시 검토(ADR-0048 참조).
