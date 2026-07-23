# ADR-0125 — 키움 실시간 WS 캔들 합성 (ADR-0040/0043 불변식 개정)

- 상태: Accepted (2026-07-23)
- 개정 대상: **ADR-0040/0043**("실시간 WS 승격본은 candles.parquet을 절대 쓰지
  않는다")
- 관련: ADR-0109(kis_api 분봉 복구본), ADR-0118(키움 WS 전담), ADR-0121(캔들 차원
  소스 사다리 분리), ADR-0124(완결성 우선 소스 정책), ADR-0038(hot-path polars 금지)

## 맥락

캔들 차원에는 **실시간 자체 수집 소스가 없었다**. hogaplay는 사후 replay 캡처(업스트림
~18h 보유라 오전을 영구 소실할 수 있음), kis_api는 저장뷰 저장 시에만 KIS REST로
받아오는 반응형 복구본(KIS 1년 보존 시한). 장중에 디스크로 실시간 저장되는 유일한
소스는 키움 WS(kiwoom_live)인데, ADR-0040/0043의 불변식 때문에 캔들을 만들지 않고
호가·체결만 저장했다.

키움 WS 0B(주식체결)는 per-tick 가격(FID 10)·시각(FID 20)·수량(FID 15)·누적거래량
(FID 13)을 이미 파싱해 흘려보낸다(`kiwoom_frames.py`). 다운샘플되기 전 `on_tick`
단계에서 이를 받으면 정확한 1분봉을 합성할 수 있다.

## 결정

**kiwoom_live에 한해 실시간 WS 틱에서 합성한 캔들을 허용한다.** ADR-0040/0043의
불변식을 "실시간 승격본은 캔들을 쓰지 않는다"에서 **"kis_live 실시간 승격본은 캔들을
쓰지 않는다; 틱에서 합성한 캔들은 예외적으로 허용한다"**로 개정한다.

- **합성기** `hoga/live/minute_candle_agg.py` — `TickDownsampler`와 대칭인 sync
  집계기(`MinuteCandleAggregator`). `on_tick`의 저장 게이트 안에서 raw 체결 틱을 받아
  per-code·per-minute OHLCV 버킷을 갱신하고, 분 경계에 완성 봉을 flush한다. KRX·정규장
  게이트를 다운샘플러와 동일하게 상속(NXT·장외 제외).
- **거래량 = 봉 자기완결적 cum_volume delta**: ``volume = last_cum − first_cum +
  first_qty``. 봉 하나만 보고 구간 거래량이 나와 봉 간 baseline 상태가 불필요하다
  (flush/commit durability 단순). cum_volume 미수신 시 per-tick ``qty_sum`` 폴백.
  두 경로 모두 다운샘플러의 side==0(동시호가) 누락을 겪지 않는다 — 방식 (b)(저장된
  10초 trades 재집계)가 거래량 언더카운트로 기각된 이유가 여기서 해소된다.
- **저장**: `SnapshotKind.CANDLE` JSONL → `promote`가 `kiwoom_live/candles.parquet`
  으로 승격. **빈 캔들은 파일을 쓰지 않는다** — resolve_candle_source(ADR-0121)가
  파일 *존재*로 승자를 판정하므로, 빈 파일은 캔들 0개인 kiwoom_live가 hogaplay를
  가리는 거짓 승자가 된다.
- **소스 사다리**: `CANDLE_BEARING_SOURCES`에 kiwoom_live 추가. 정책별 캔들 순서는
  기존 사다리 필터가 자동 산출한다 — hogaplay 우선 → `hogaplay → kiwoom_live →
  kis_api`(고화질 hogaplay 틱봉 우선, 실시간 합성봉이 사후 복구본보다 앞), 실시간 WS
  우선 → `kiwoom_live → kis_api → hogaplay`. 완결성 우선(ADR-0124)은 캔들에서
  `_CANDLE_POLICY_ALIAS`로 hogaplay 우선을 유지.

## 경계 (무엇을 안 바꾸나)

- **kis_live는 여전히 캔들 미보유** — 이번 예외는 kiwoom_live 한정. kis_live의 캔들은
  Live Candle Backfill(KIS REST)이 계속 담당한다.
- **NXT·장외 캔들 없음** — 저장 경로 KRX 성역 격리(ADR-0118)를 그대로 상속.
- **일봉을 따로 저장하지 않는다** — 1분봉만 저장하고 일/주/월봉은 집계로 만든다
  (hogaplay와 동일). D/W/M 저장뷰의 권위 있는 일봉 소스는 여전히 스크리너 일봉이다.
- **커버리지는 키움 구독 종목만**(히트맵 800 + 관심). 그 밖은 hogaplay/kis_api 폴백.

## 결과

- 캔들 공백(특히 hogaplay가 오전을 영구 소실한 날)을 **1년 만료·저장뷰 트리거 없이
  영구히** 메운다. /study 저장뷰가 실시간 자체수집 캔들로 갭을 채운다.
- 캔들에도 "실시간 WS 우선"·"완결성 우선"이 실제로 성립한다(ADR-0124).
- 화질: 1분 합성이라 hogaplay tick 캔들보다 미세하지 않으나 OHLCV 자체는 정확
  (cum_volume delta로 거래량 정합). hogaplay가 있으면 hogaplay가 계속 이긴다.
- 재시작: 완성 봉만 저장하므로 최대 진행 중 1분만 유실(표시 /live는 KIS REST 분봉 +
  WS 오버레이가 계속 담당하므로 화면 영향 없음).

## 기각한 대안

- **방식 (b) 사후 집계** — 저장된 10초 `trades.parquet`을 분봉으로 재집계. 다운샘플러가
  side==0(동시호가) 물량을 버려 거래량 언더카운트 + 10초 라벨이라 시가/종가 순서 ±10초
  소실. 복기 분석에 틀린 값을 주는 건 정직한 공백보다 나쁘다. 기각.
- **별도 네임스페이스**(kiwoom_live_candles/) — 불변식은 무손상이나 "호가는 kiwoom_live,
  캔들은 다른 폴더" 이질성을 낳고 리더·사다리 배선은 마찬가지. 불변식 개정이 더 정직.
- **kis_live도 캔들 합성** — kis 실시간 수집은 관심종목 소수뿐이고 Live Candle Backfill이
  이미 담당. Rule of Three 전까지 kiwoom 한정 예외로 좁힌다.
