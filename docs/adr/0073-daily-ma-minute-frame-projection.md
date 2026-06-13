# 0073 — 일봉 이동평균선(Daily MA)은 분봉 프레임에 거래일-계단으로 투영한다 (가격선 cross-frame 예외)

**Status:** accepted (2026-06-13)

**Related:**
- ADR-0040 (Live Candle Backfill 별도 cache + 별도 wire)
- ADR-0041 (`/live` calendar timeframes = candle + volume only)
- ADR-0046 (`/live` 이동평균선 = 자체 overlay, replay와 분리)
- ADR-0048 (D-direct daily backfill — 별도 endpoint)
- ADR-0055 (투자자 순매수 일봉 보조지표 — **D-only**; 본 ADR이 구분하는 선례)
- Spec: `docs/superpowers/specs/2026-06-13-daily-moving-average-indicator-design.md`

## Decision

**일봉 이동평균선(Daily MA)** 보조지표는 일봉 종가로 계산한 `SMA(close, period)`를
**분봉(minute) 프레임의 차트에 거래일 단위로 계단 투영**한다 — 즉 분봉 차트에서도
일봉 데이터를 fetch해 그린다. 이는 "일봉 파생 지표는 D-only"였던 직전 선례
(ADR-0055 투자자 순매수)에서의 **의도된 이탈**이며, 다음 원리로 경계를 긋는다:

> **단위 보존 원리 (unit-preservation)**: y값이 그 자체로 의미를 보존하는 시계열
> — **가격선/비율선(price- or ratio-domain)** — 은 x축 granularity(일봉↔분봉)를
> 바꿔도 y가 왜곡되지 않으므로 하위 프레임에 **투영 가능**하다. 반면 y가 "그 날의
> 집계 수량"인 **막대 히스토그램(day-scoped magnitude pane)** — 거래량·투자자
> 순매수 — 은 하루를 수백 분봉으로 펼치면 의미가 무너지므로 **D-only**로 둔다.

미래의 신규 일봉 파생 차트 시계열은 이 원리로 분류한다: **가격/비율 시계열 ⇒
분봉 투영 허용, 일별 집계량 pane ⇒ D-only(기본값).** 이 예외는 **명시적으로 cap**
한다 — 새 일봉 지표는 기본 D-only이며, 분봉 투영을 원하면 본 ADR의 원리로 개별
정당화해야 한다("그냥 독립 fetch 하나 더"로 자동 확산 금지).

데이터경로 split(ADR-0040/0041/0048)이 규율하는 것은 **번들에 실리는 wire-bucketed
intraday 지표**(`/api/range`의 호가비·총잔량·체결강도)이지, **self-contained
가격선 오버레이**가 아니다. Daily MA는 `/api/live/past-daily-candles`(ADR-0048,
이미 존재하는 endpoint)를 `useLiveBundle` **밖** 독립 react-query 훅으로 호출하는
격리 오버레이(`DailyMovingAverageOverlay`)로 구현해, split이 보호하는 *목적*
(번들 prepend atomicity, Past/Today Split Cache, invariant 안정성)을 **보존**하면서
split의 *범위*(프레임별 데이터경로)만 가로지른다.

## Why

- **D-only는 사용자 요구를 충족 못 한다.** 사용자는 "분봉을 바꿔도 자동으로 일봉의
  20이평선을 그려줘"라고 명시했다. 기존 `MovingAverageOverlay`(ADR-0046)는 *현재
  봉* 기준이라 5분봉 period=20 = 100분 MA이지 일봉 20MA가 아니다. D-only로 두면
  정작 사용처인 분봉 프레임에서 아무것도 안 보인다.
- **ADR-0055의 D-only 근거는 mechanism-specific이다.** ADR-0055 §4는 "W/M은 캔들을
  주/월 segment로 집계하므로 일별 점이 정렬되지 않는다(`axis.contains` 탈락)"를
  근거로 든다 — 이건 **W/M 집계 정렬 불가** + **막대 단위**의 문제이지, "일봉
  데이터는 분봉에 닿으면 안 된다"는 규칙이 아니다. Daily MA는 각 분봉 캔들을
  `axis.findByReal(ts_ms) → segment.date`로 자기 거래일에 정확히 매핑하므로
  (일봉 `t_ms` = 09:00 KST 앵커, 실데이터 검증 완료) 투자자 순매수가 겪는
  정렬-탈락이 **구조적으로 발생하지 않는다**. 가격선은 하루 내 수평 레벨이라
  수백 분봉에 그대로 펼쳐지지만, 순매수 막대는 "그 날 1개 막대"라 분봉 x축에
  펼칠 자연스러운 형태가 없다 — 이 표현 단위의 차이가 곧 단위 보존 원리다.
- **격리가 split의 목적을 지킨다.** 일봉 fetch가 `useLiveBundle` 밖이라 번들의
  atomicity 게이트·Split Cache(과거 불변 + 당일만 hot)·`seriesDataDiff` 참조
  안정성에 비침투. spec의 Invariant impact 6항목 전부 "preserves".

## Trade-offs

- **(채택) lockstep은 pan에 대해 구조적, cold-load만 1-fetch 지연.** lookback
  `from`을 `todayKst` 기준 `PAST_CANDLES_MAX_DAYS(=250, 분봉 클램프 하한) +
  ceil(maxPeriod × 3/2) + margin`으로 **고정**한다 (거래일→캘린더일 1.5×는 KRX 실측
  ≈1.48보다 보수적이라 최대 period=400까지 커버). 분봉은 이 클램프보다 과거로
  못 가므로(useLiveBundle 250일 클램프 + ADR-0059 점진 팬) 일봉 superset이 분봉
  가시 전 범위를 항상 덮는다. 결정적으로 이 `from/to`는 **좌측 팬에 불변**(today
  앵커) → react-query 키가 안 바뀜 → 팬 시 재fetch 없음 → 드러난 거래일의 MA값이
  이미 캐시에 있음 = **구조적 lockstep**(확률적 추정 아님). 비-lockstep 창은 최초
  fetch(cold-load / 패널 토글 ON / period 변경 re-key)뿐이며, 이는 상태 손상이
  아니라 라인이 한 박자 늦게 *등장*하는 1회성 cosmetic 지연(v1 수용). D-only
  변호인의 "probabilistic/capacity-planning" 비판은 lookback을 segments[0] 앵커로
  잡았을 때만 성립하는데, 본 설계는 today 앵커라 그 경로를 닫았다.
- **(주의) 지표 홍수 위험 — cap으로 봉쇄.** "가격선이 의미 있으니 분봉에 그린다"를
  무한정 허용하면 모든 일봉 지표가 같은 권리를 주장한다. 그래서 (1) 단위 보존
  원리로 *가격/비율 시계열만* 투영 허용, (2) 신규 일봉 지표는 **기본 D-only**,
  분봉 투영은 개별 ADR 정당화 필요, (3) 격리 래퍼(self-contained overlay +
  독립 훅)를 패턴으로 못박는다. 절차적 경계가 침식될 수 있다는 지적은 타당하므로,
  본 ADR을 그 경계의 citable 기준점으로 둔다.
- **(채택) 당일 close 프록시.** 오늘 일봉 종가가 미확정이라, 오늘 segment에 분봉
  캔들이 실재할 때만 마지막 분봉 close를 그날 종가로 override(주말·장전엔 null로
  clean degrade). SSE 실시간 현재가선과 분 단위 미세 lag 가능 — 20일 평균엔 무시.
- **(폐기) D-only(ADR-0055 답습).** 사용자 요구 미충족.
- **(폐기) `useLiveBundle`에 일봉 fetch 편입.** 번들 atomicity·Split Cache에
  일봉 생명주기를 결합 → invariant 위협. 격리 오버레이가 블라스트 반경을 가둔다.
- **(폐기) 분봉 종가로 일봉 MA 근사.** 분봉 데이터 ≠ 일봉 종가(값 부정확·결손).

## Consequences

- CONTEXT.md **일봉 이동평균선 (Daily MA)** 용어 등재 — 3개 MA 개념(① 일봉 투영
  가격선 ② 현재봉 `MovingAverageOverlay` ③ Screener `ma` 조건) 구분 + **거래일
  계단** 용어. 본 ADR을 cross-frame 근거로 참조.
- 단위 보존 원리가 **향후 일봉 파생 차트 시계열의 분류 게이트**가 된다.
- `selectSource`(movingAverage.ts) 파라미터를 `Pick<Candle,'open'|'high'|'low'|'close'>`로
  확장(backward-compatible) — 일봉/분봉 OHLC 필드명 동일성 활용, 어댑터 없이 재사용.
- `dailyMovingAverages` 슬라이스를 `PersistedIndicators`에 추가(opt-in, 기본 false),
  IndicatorPanel '상단 지표' 그룹에 `일봉 이동평균선` 카테고리.

## Trigger Conditions

(미래에 본 ADR을 supersede할 조건)

- 일봉 **막대/집계량** 지표(예: 일별 거래대금 프로파일)를 분봉에 보여야 함 → 단위
  보존 원리상 투영 불가, 별도 메커니즘(예: 일 요약 레인) 필요 → 새 ADR.
- W/M에서도 Daily MA를 보여야 함 → 일봉 MA를 주/월 segment로 투영하는 경로 추가
  (현재 분봉 전용).
- 다수 분봉 동시 시청자의 일봉 fetch RPS가 비용이 되면 → 공유 일봉 캐시/디스크
  영속 검토(ADR-0048 경로).
- Pane Legend에 Daily MA 커서값을 노출하려면 → `maSeriesRegistry`/`legendRows`
  연동(현재 v1 비대상).
