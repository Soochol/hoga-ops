# 일봉 이동평균선 보조지표 — Design

**Date**: 2026-06-13
**Status**: Draft
**Scope**: frontend/src/chart/projectors/dailyMovingAverage.ts (신규), frontend/src/live/indicators/DailyMovingAverageOverlay.tsx (신규), frontend/src/live/indicators/DailyMovingAverageConfig.tsx (신규), frontend/src/chart/projectors/movingAverage.ts (selectSource 시그니처 확장), frontend/src/state/liveIndicatorsPersistence.ts, frontend/src/state/livePage.ts, frontend/src/live/indicators/IndicatorPanel.tsx, frontend/src/live/LiveChartRoot.tsx

## Problem

기존 이동평균선 보조지표(`MovingAverageOverlay`)는 **현재 표시 중인 봉**을 기준으로 SMA를 계산한다. 즉 5분봉에서 `period=20`이면 "20 × 5분 = 100분" 이동평균이지, **일봉 20이평선이 아니다**. 사용자는 분봉 차트를 보면서 "일봉상의 20이평선"이 어디에 위치하는지를 보고 싶어 한다.

사용자 표현:
> "이동평균선인데 일봉 20이평선을 분봉에서 환산해서 일봉상의 20이평선을 표현해주고 싶어. 사용자가 분봉 1,3,5.. 이걸 변경해도 자동으로 일봉의 20이평선을 그려줘야해. 보조지표 ui에 있는 이동평균선 페이지를 모방하면 돼."

핵심 요구: (1) 일봉 종가 기준 SMA(기본 20기간)를, (2) 분봉 차트 시간축에 투영하고, (3) 분봉(1/3/5/10/15/30분)을 바꿔도 동일한 일봉 MA가 자동 유지되며, (4) 기존 이동평균선 페이지를 모방한 별도 UI를 갖는다.

## Invariants

이 spec이 건드리거나 인접하는 시스템이 **현재 보존하고 있는** 속성들:

- **MA series identity 안정성 (ADR-0046)**: 이동평균 슬롯은 array index가 아니라 안정 `id`로 series를 reconcile한다 — mid-list 삭제가 다른 슬롯의 series identity를 churn하지 않고, period/source 변경은 `setData`만 호출(series 재생성 없음). 근거: `MovingAverageOverlay.tsx:27-60`.
- **Indicator-prefs 단일 출처 (ADR-0046)**: 모든 indicator 영속 필드는 `PersistedIndicators` 한 타입에 정의되고, 각 setter는 `snapshotIndicators(get)`로 **전체** 슬라이스를 직렬화해 한 토글 쓰기가 다른 indicator prefs를 덮어쓰지 않는다. 근거: `livePage.ts:158-177`, `liveIndicatorsPersistence.ts`.
- **번들 prepend atomicity**: 좌측 팬(historical extension) 시 candle/hoga 두 past 소스가 별도 commit으로 도착해도 `extending` 게이트가 마지막 settled 번들을 잡아 **한 commit**으로 prepend한다 → 뷰포트 이동이 한 프레임에 끝나고 2-paint 깜빡임이 없다. 근거: `useLiveBundle.ts:278-292`.
- **Virtual axis 거래일 매핑**: 각 캔들 `ts_ms`는 `axis.findByReal()`로 소속 거래일 segment에 매핑되고 `segment.date`는 YYYYMMDD KST 거래일이다. 근거: `virtualAxis.ts:168-184`, `time.ts:15-17`.
- **chartBundle(cb) SSE-tick 안정성 (2026-06-09 bundle-split)**: 캔들 경로 번들 `cb`는 SSE 호가 틱에 ref가 바뀌지 않고, 캔들 갱신 시에만 새 ref가 된다 → 캔들 오버레이가 틱마다 재투영하지 않는다. 근거: `useLiveBundle.ts:178-224`, `LiveChartRoot.tsx:759`.
- **호가 indicator opt-in 규약**: 신규 indicator 토글은 `=== true`일 때만 ON(누락·legacy 포함 기본 OFF), 단 `volumeEnabled`/`movingAverageEnabled` 류는 `=== false`만 OFF. 근거: `liveIndicatorsPersistence.ts:136-148`.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| MA series identity 안정성 | preserves | 신규 오버레이가 동일 id-reconcile 패턴을 그대로 미러링 |
| Indicator-prefs 단일 출처 | preserves | `dailyMovingAverages`/토글을 `PersistedIndicators`에 추가, `snapshotIndicators`에 편입 |
| 번들 prepend atomicity | preserves | 신규 일봉 fetch는 번들 게이트 **밖**(read-only)이라 게이트 미침투. lookback `from`을 `today`+`PAST_CANDLES_MAX_DAYS`에 고정 → react-query 키가 **좌측 팬에 불변** → 팬 시 재fetch 없이 드러난 거래일 MA가 이미 캐시에 = **구조적 lockstep**(확률적 추정 아님). 비-lockstep 창은 최초 fetch뿐(cold-load 1-fetch 지연, Risk 참조). 근거 ADR-0073 (아래 §데이터 흐름) |
| Virtual axis 거래일 매핑 | preserves | 읽기만 함 (`segment.date`로 일봉 MA값 조회) |
| chartBundle(cb) 안정성 | preserves | 신규 오버레이도 `cb`를 받고 `memo`로 감싸 SSE 틱에 미재렌더 |
| 호가 indicator opt-in 규약 | preserves | `dailyMovingAverageEnabled` 기본 false(opt-in), `=== true`만 ON |

*intentionally breaks 항목 없음.*

## Goals

- 일봉 종가 기준 SMA(기본 20기간)를 분봉 차트(1/3/5/10/15/30분) 시간축에 투영해 그린다.
- 분봉 타임프레임을 바꿔도 동일한 일봉 MA가 유지된다 (값이 일봉 단위라 분봉과 무관).
- 기존 이동평균선 페이지를 모방한 **별도** 「지표」 모달 페이지에서 슬롯(기간/색/두께/소스) 추가·삭제·편집한다.
- 렌더는 **계단식 + 당일 실시간**: 과거 거래일은 그 날 확정 일봉MA로 평평, 오늘 구간은 현재가를 오늘 종가로 가정해 실시간 갱신.

## Non-Goals

- **D/W/M 타임프레임 렌더** (v1: 분봉 전용). D는 기존 이동평균선 페이지가 동일 선을 native로 제공하고, W/M은 일↔주/월 매핑이 모호하므로 숨긴다.
- **Pane Legend / 커서 값 읽기**: v1은 선 렌더까지. 레전드 행 노출(`maSeriesRegistry`/`legendRows`)은 후속.
- **EMA·기타 MA 종류**: SMA만. (기존 MA도 SMA 전용.)
- **백엔드 변경**: `/api/live/past-daily-candles`를 그대로 재사용. 신규 엔드포인트 없음.
- **기존 현재봉 MA 동작 변경**: `MovingAverageOverlay`/`movingAverages` 슬라이스는 불변.

## Design

### 용어

**일봉 이동평균선 (Daily MA)** — 일봉 종가 시계열로 계산한 SMA를, 활성 분봉 차트의 시간축에 거래일 단위로 **계단 투영**한 가격선 오버레이. 기존 "이동평균선"(현재봉 기준, ADR-0046)·Screener `이동평균(ma)` 조건과 구분되는 별도 지표. CONTEXT.md "일봉 이동평균선 (Daily MA)" 항목 등재(3개 MA 개념 구분 + `거래일 계단` 용어). 분봉↔calendar 데이터경로 split을 가로지르는 근거는 **ADR-0073**.

### 분봉 투영의 정당성 — 단위 보존 원리 (ADR-0073, grill Q2 적대검증)

지금까지 모든 일봉 파생 지표(투자자 순매수 ADR-0055)는 **D-only**였다. Daily MA는 이 경계를 처음 가로지른다. 적대검증(D-only 변호 ↔ 투영 변호 ↔ 독립 eng 판정) 결과 **투영 채택**, 원리:

> **단위 보존**: y값이 그 자체로 의미를 보존하는 **가격/비율 시계열**은 x축 granularity(일봉↔분봉)를 바꿔도 왜곡되지 않아 **분봉 투영 가능**. y가 "그 날 집계 수량"인 **막대 히스토그램**(거래량·투자자 순매수)은 하루를 수백 분봉으로 펼치면 의미가 무너져 **D-only**.

ADR-0055의 D-only는 "W/M 집계 시 일별 점 정렬 탈락"이라는 mechanism-specific 근거 — Daily MA는 per-candle `findByReal→segment.date` 매핑이라 그 실패가 구조적으로 불가. **Cap**: 신규 일봉 지표는 기본 D-only, 분봉 투영은 이 원리로 개별 정당화 필요(지표 홍수 방지). 데이터경로 split(ADR-0040/0041/0048)이 규율하는 건 번들에 실리는 wire-bucketed intraday 지표지 self-contained 가격선 오버레이가 아니다.

### 확정된 사실 (실데이터 검증, 2026-06-13)

`/api/live/past-daily-candles?code=005930&from=20260520&to=20260613` 응답으로 검증:
- **일봉 `t_ms`는 09:00 KST(=00:00 UTC, segment의 sessionOpenMs)에 앵커**. 따라서 `unixMsToKSTDate(t_ms)` === 해당 거래일 `segment.date` (예: `1779235200000` → `20260520`). → 거래일 키 매핑 무결성 확정 (마커 off-by-one 류 리스크 해소).
- 16 거래일이 ~24 캘린더일에 분포 → **캘린더 ≈ 1.5× 거래일**. lookback 캘린더일 환산 계수 근거.
- 응답은 거래일만 포함(주말·휴장 skip), `from <= to` 가드, `data_warnings` 배열 제공.

### 아키텍처 — 기존 MA 시스템 미러링 + 컴포넌트 재사용

**신규 파일 3개**

1. `chart/projectors/dailyMovingAverage.ts` — 순수함수.
   ```ts
   import { computeSMA, selectSource, type MASource } from './movingAverage';
   import { unixMsToKSTDate } from '../../util/time';
   import type { LivePastDailyCandle } from '../../api/livePastDailyCandles';

   /** 거래일(YYYYMMDD) → 일봉 SMA값 맵.
    *  - daily는 방어적으로 오름차순 정렬 후 계산.
    *  - todayLiveClose != null 이고 todayDate가 daily 마지막 행과 같으면 그 행의
    *    source값을 todayLiveClose로 override; daily에 todayDate가 없는데
    *    todayLiveClose가 주어지면 합성 행을 append (오늘 in-progress 봉).
    *  - period 미달 구간은 맵에 없음(null) → 라인 미표시(기존 MA와 동일). */
   export function computeDailyMaByDate(
     daily: readonly LivePastDailyCandle[],
     period: number,
     source: MASource,
     todayDate: string,
     todayLiveClose: number | null,
   ): Map<string, number>;
   ```
   **`selectSource` 재사용 (어댑터 불필요, 검증 확정)**: `selectSource`(movingAverage.ts:8)는 실제로 `open/high/low/close`만 읽고 `ts_ms`/`vol_a`는 쓰지 않는다. `LivePastDailyCandle`의 OHLC 필드명은 `Candle`과 **동일**(`t_ms`/`volume`만 다름). 따라서 per-row 어댑터·인라인 대신 **`selectSource`의 파라미터 타입을 `Pick<Candle,'open'|'high'|'low'|'close'>`(또는 export된 `OHLC` 별칭)로 확장**한다 — `Candle`은 그대로 assignable이라 기존 호출부 무수정(backward-compatible), `LivePastDailyCandle`도 zero-cost로 통과. → 수정 파일 §8 참조. source 선택 단일 출처 유지(ADR-0046 정신).

2. `live/indicators/DailyMovingAverageOverlay.tsx` — `MovingAverageOverlay`를 미러링.
   - Props: `{ chart, bundle, axis, code, timeframe, todayKst }`. (`todayKst`는 오늘 거래일 판별·현재가 프록시에 필수 — `LiveChartRoot`에서 이미 `LiveAskPeakSegments`에 넘기는 in-scope 변수, 검증 확정.)
   - **오늘 판별 + `todayLiveClose` 도출**: `bundle.candles`는 ts_ms 오름차순. `last = bundle.candles[bundle.candles.length-1]`; `todayLiveClose = (last && unixMsToKSTDate(last.ts_ms) === todayKst) ? last.close : null`. → 오늘 segment에 분봉 캔들이 있을 때만 현재가 프록시 활성(주말·장전엔 null로 clean degrade). `computeDailyMaByDate(daily, cfg.period, cfg.source, todayKst, todayLiveClose)` 호출.
   - 내부에서 일봉 fetch 훅 호출(아래 §데이터 흐름) → `computeDailyMaByDate` → per-candle 투영 → `LineSeries`(paneIndex 0).
   - series lifecycle: `dailyMovingAverages` 슬롯 id 기준 add/remove/applyOptions reconcile (MovingAverageOverlay와 동일 구조).
   - master(`dailyMovingAverageEnabled`)·눈(`dailyMovingAverageHidden`) 토글 동일 의미.
   - 분봉 전용 게이트: `isMinuteTimeframe(timeframe)`가 false면 전 슬롯 `setData([])` + `visible:false`.
   - `export default memo(...)`.

3. `live/indicators/DailyMovingAverageConfig.tsx` — `MovingAverageConfig` 미러링.
   - **`MovingAverageRow`·`MAStylePicker`·`MASourceSelect` 그대로 재사용** (전부 prop-driven 확인: Row는 `index`+`config`+`canRemove`+`onChange`+`onRemove` 5개 prop을 받고 내부 스토어 결합 없음 — daily 셀렉터/세터를 그대로 주입).
   - 헤더 "일봉 이동평균선", 설명 "일봉 종가 기준 이평선을 분봉 차트에 투영", 안내 "분봉 차트에서만 표시됩니다".
   - daily 스토어 셀렉터/세터 사용, 나머지는 MovingAverageConfig와 동형.

**수정 파일 5개**

4. `state/liveIndicatorsPersistence.ts`
   - `PersistedIndicators`에 추가:
     ```ts
     dailyMovingAverages: LiveMAConfig[];       // LiveMAConfig 타입 재사용
     dailyMovingAverageEnabled: boolean;        // 기본 false (opt-in)
     dailyMovingAverageHidden: boolean;         // 기본 false
     ```
   - `DEFAULT_DAILY_MAS = [{ id:'dma-1', enabled:true, period:20, color:'#EAB308', lineWidth:2, source:'close' }]`. 색 `#EAB308`(tokens.css `--ma-7`, yellow)은 기존 현재봉 기본 슬롯(ma-1 #EC4899/ma-2 #F97316/ma-3 #22C55E/ma-4 #F8FAFC)과 색역이 구분됨(MA_PALETTE와 일치, off-token 아님).
   - `isValidEntry` 재사용(동일 LiveMAConfig 형). `mergeLiveIndicatorPrefs`의 `build()`·분기에 daily 필드 추가(현재봉 MA와 동일한 검증·cap·기본값 전략, enabled는 opt-in 규약 `=== true`만 ON).
   - id 접두사는 `dma-`로 분리(현재봉 `ma-`와 충돌 없음; `nextSlotId`는 daily용 별도 또는 접두사 파라미터화).

5. `state/livePage.ts`
   - `Store`에 세터 5종: `setDailyMovingAverage(id, patch)`, `addDailyMovingAverage()`, `removeDailyMovingAverage(id)`, `setDailyMovingAverageEnabled(b)`, `setDailyMovingAverageHidden(b)` — 현재봉 세터들을 미러링(clamp/nextSlotId/nextSlotColor 재사용, daily 배열 대상).
   - `snapshotIndicators`에 3개 신규 필드 편입(단일 출처 invariant 유지).
   - `MA_SLOT_LIMIT`/`MA_PERIOD_MIN/MAX` 상수 공유.

6. `live/indicators/IndicatorPanel.tsx`
   - `CategoryId`에 `'daily-moving-average'` 추가.
   - `CATEGORIES`에 `{ id:'daily-moving-average', label:'일봉 이동평균선', group:'top' }` — `'moving-average'` 바로 다음 위치.
   - `checkedFor`/`toggleFor`에 분기 추가, 우측 detail 분기에 `<DailyMovingAverageConfig />`.
   - **그룹 헤더 (의도된 동작)**: 일봉 MA는 기존 `'top'`('상단 지표') 그룹의 2번째 항목 → `showHeader`(=`i===0 || CATEGORIES[i-1].group !== c.group`)가 false → **새 그룹 헤더 없음**. 사용자가 고른 "별도 페이지"는 좌측 nav 항목 + 우측 detail pane(`selected==='daily-moving-average'`)을 뜻하며, 새 그룹 박스가 아님. (현재봉 MA 바로 아래 형제 항목으로 노출.)
   - `IndicatorPanel.test.tsx`의 카테고리 개수 expect(8 → 9) 갱신.

7. `live/LiveChartRoot.tsx`
   - `MovingAverageOverlay` 마운트 옆(`:759`)에 추가(`DailyMovingAverageOverlay` import 포함):
     ```tsx
     <DailyMovingAverageOverlay chart={chart} bundle={cb} axis={axis} code={code} timeframe={timeframe} todayKst={todayKst} />
     ```
   - 동일한 `chart && cb && axis.segments.length > 0` 가드 안. `code`/`timeframe`/`cb`/`axis`/`todayKst` 모두 마운트 지점 scope 내 존재(검증 확정 — `todayKst`는 `:767` `LiveAskPeakSegments`가 이미 사용).

8. `chart/projectors/movingAverage.ts`
   - `selectSource`의 파라미터 타입을 `c: Candle` → `c: Pick<Candle,'open'|'high'|'low'|'close'>`(또는 export `OHLC` 별칭)로 **확장만** 한다. 본문 무변경, 기존 호출부(`MovingAverageOverlay` 등) 무수정(backward-compatible). 목적: 일봉 projector가 동일 `selectSource`를 어댑터 없이 재사용.

### 데이터 흐름 — 일봉 fetch를 분봉에서도 활성화 (번들 비침투)

현재 `useLiveBundle`은 `enableDaily = !isMinute`라 분봉에선 일봉을 안 받는다. 신규 오버레이가 **독립적으로** `useLivePastDailyCandles(code, from, to)`를 호출(`useLiveBundle` 수정 없음 → 기존 atomicity 게이트 비침투):

- **enabled 조건**: `dailyMovingAverageEnabled && isMinuteTimeframe(timeframe) && code != null`. (조건부 hook 금지 규칙상 항상 호출하되 비활성 시 `code=null` 전달 → 훅 내부 `enabled=false`.)
- **`to`** = `todayKst` (오버레이 prop).
- **`from`** = `subtractDaysKst(todayKst, lookbackCalendarDays)` — **`today` 기준 고정** (segments[0] 기준 ❌).
  - `lookbackCalendarDays = PAST_CANDLES_MAX_DAYS + ceil(maxEnabledPeriod / TRADING_DAYS_PER_CALENDAR_DAYS) + margin` (grill Q3, eng-review 렌즈).
    - **`PAST_CANDLES_MAX_DAYS`(=250, `liveDateTime.ts`)** = 분봉 좌측 팬의 **문서화된 클램프 하한** — 분봉 차트는 `earliestAllowedMinuteDate`(오늘−249) 이전으로 못 간다(useLiveBundle 250일 클램프 + ADR-0059 점진 팬이 공유하는 상수). 매직넘버(`minuteBackfillSpanDays`) 대신 이 단일 출처에 고정 → 클램프 변경 시 자동 추종, drift 없음.
    - **`ceil(maxEnabledPeriod / TRADING_DAYS_PER_CALENDAR_DAYS)`**(=period 거래일→캘린더일, ×7/5; 상수도 `liveDateTime.ts`) = 분봉 최저 가시일 이전에도 period개 일봉 종가 확보. `margin`(~15) = 휴장일 슬랙. `maxEnabledPeriod` = 활성 daily 슬롯 최대 period.
  - 효과: `from ≤ (분봉 최저 가시일 − period거래일)`. 일봉 endpoint는 cap 없음(ADR-0048)이라 ~265~460행 받아도 무비용 → **분봉 가시 전 범위를 반드시 덮는 pre-cached superset** → candle prepend와 **진짜 lockstep**(추측 아님, 클램프로 상한 보증). 2-paint 깜빡임 회피.

### 투영 알고리즘 (오버레이)

```
dailyMaByDate = computeDailyMaByDate(daily, cfg.period, cfg.source, todayDate, todayLiveClose)
inSession = bundle.candles.filter(c => axis.contains(c.ts_ms))
data = inSession.map(c => {
  const segIdx = axis.findByReal(c.ts_ms)
  const date   = axis.segments[segIdx]?.date
  const v      = date ? dailyMaByDate.get(date) : undefined
  const time   = (axis.toVirtual(c.ts_ms) / 1000) as Time
  return v == null ? { time } : { time, value: v }
})
series.setData(data)
```
- 하루 내 모든 분봉이 같은 값 → **평평**. 거래일 경계는 가상축에서 ~1초로 압축 → LineSeries가 사실상 **수직 계단**으로 렌더(커스텀 primitive 불필요).
- per-candle 투영은 현재봉 MA와 동일 패턴(일관성·커서 정합). 비용은 캔들당 binary search O(log n).

### 렌더링 — 계단식 + 당일 실시간 (확정 선택)

- **과거 거래일**: `computeSMA(dailyCloses, period)` 확정값.
- **오늘**: 오늘 segment에 분봉 캔들이 **실재할 때만**(`unixMsToKSTDate(마지막 캔들 ts_ms) === todayKst`) `todayLiveClose` = 그 마지막 분봉 close로 오늘 일봉 close를 override → 오늘 MA가 현재가 따라 갱신. (주말·장전·휴장엔 오늘 캔들 없음 → override 비활성, 마지막 거래일 확정값으로 clean degrade.)
  - 갱신 cadence: 오버레이가 `cb` 변경 시 재투영. `cb`의 분봉 캔들은 `useLivePastCandles`가 장중 **약 1분(60초) 주기 refetch**(`livePastCandles.ts`)로 advance → 오늘 MA도 ~60초 주기 갱신. 20일 평균은 장중 거의 안 움직이므로 충분.
- **스타일**: 기본 색 `#EAB308`(`tokens.css` `--ma-7`, yellow — 기존 현재봉 기본 슬롯과 구분, off-token 아님). 두께 기본 2. 사용자가 `MAStylePicker` 32색·4두께로 변경 가능.

## Testing

### Unit tests

**`dailyMovingAverage.test.ts` (projector 순수함수)**

| Case | Setup | Expected |
|------|-------|----------|
| 기본 SMA 맵 | 일봉 25행, period 20, source close | 20번째 거래일부터 맵에 값, 그 전 거래일 키 없음 |
| t_ms 키 정합 | 실데이터형 t_ms(09:00 KST 앵커) | 맵 키가 정확히 그 거래일 YYYYMMDD (회귀 방지: t_ms 시맨틱 변경 시 실패) |
| 오늘 override(존재) | daily 마지막 행 date==todayDate, todayLiveClose 지정 | 그 날 MA가 override된 close 반영 |
| 오늘 append(부재) | daily에 todayDate 없음, todayLiveClose 지정 | todayDate 키 추가, 직전 (period-1)행 + live close 평균 |
| 오늘 override 비활성 | todayLiveClose=null | daily 원본 close만 사용 |
| 비정렬 입력 | daily 내림차순 | 오름차순 정렬 후 동일 결과(방어) |
| period > 행수 | 일봉 5행, period 20 | 빈 맵 |
| source 변형 | source hl2/ohlc4 | 가중 평균 반영 |

**`DailyMovingAverageOverlay.test.tsx` (MovingAverageOverlay.test 미러링)**

전제: 오버레이가 내부에서 `useLivePastDailyCandles`를 호출하므로 `vi.mock('../../api/livePastDailyCandles')`로 일봉 응답을 제어한다(성공/빈 응답/로딩). mock chart/bundle/axis는 MovingAverageOverlay.test 패턴 재사용, `todayKst` prop 주입.

| Case | Expected |
|------|----------|
| 슬롯 add/remove reconcile | series add/removeSeries 호출, mid-list 삭제가 타 슬롯 series 유지 |
| 계단 투영 | 한 거래일 모든 분봉에 동일 값, 거래일 경계서 값 점프 |
| 오늘 판별·실시간 | 마지막 캔들 date===todayKst일 때 오늘 close override 반영; date≠todayKst(주말)면 override 비활성 |
| master off | 전 슬롯 setData([]) + visible:false |
| 눈 hidden | visible:false, data 유지 |
| 분봉 게이트 | timeframe D/W/M → setData([]) (미렌더) |
| 일봉 fetch 빈 응답 | daily=[] → 라인 미표시(throw 없음) |
| chart 재생성 | 새 chart에 series 재생성 + 재투영 |

**`liveIndicatorsPersistence.test.ts` (daily 슬라이스)**

| Case | Expected |
|------|----------|
| 기본값 | `dailyMovingAverages` = period 20 1슬롯, `dailyMovingAverageEnabled` false |
| 손상 항목 필터 | 잘못된 daily 슬롯 제거, 전부 무효면 기본값 |
| opt-in 규약 | `dailyMovingAverageEnabled`는 `=== true`만 ON |
| 단일 출처 | daily 토글 쓰기가 현재봉 MA/호가 prefs를 안 덮어씀 |

**`DailyMovingAverageConfig.test.tsx`**: 행 렌더, 기간 추가/삭제, MA_SLOT_LIMIT cap.

**`IndicatorPanel.test.tsx`**: `일봉 이동평균선` 카테고리 존재, 클릭 시 DailyMovingAverageConfig 노출, 체크박스 토글.

**Invariant 회귀 테스트**:
- MA series identity: mid-list 삭제 후 잔존 슬롯 series 객체 동일성 유지(overlay 테스트에 포함).
- 단일 출처: daily setter 호출 후 `localStorage`에 현재봉 MA 필드 보존(persistence 테스트에 포함).

### Manual verification (`/live`, 사용자 확인)

1. 「지표」 모달 → "일봉 이동평균선" 체크 → 분봉 차트에 계단식 일봉20 라인.
2. 분봉 1→3→5→10분 전환 → 동일 일봉20 라인 유지(값 불변, x정렬만 변화).
3. 좌측 팬으로 과거 거래일 진입 → 라인 끊김/깜빡임 없이 lockstep 연장.
4. 장중(평일 09:00~15:30) 오늘 구간이 현재가 따라 갱신, 과거 거래일은 평평.
5. D/W/M 전환 시 일봉 라인 숨김(현재봉 MA 페이지는 정상).
6. 슬롯 기간 20→60 변경, 색/두께 변경, 추가/삭제 동작.

## Risks / Open questions

- **t_ms 시맨틱 회귀**: 검증 완료(09:00 KST 앵커)이나 백엔드가 t_ms 앵커를 바꾸면 키 매핑이 깨진다 → projector 단위테스트에 실데이터형 t_ms를 박아 회귀 검출.
- ~~**lookback 상수 튜닝**~~ → **해소(grill Q3)**: lookback을 `PAST_CANDLES_MAX_DAYS`(분봉 클램프 하한)에 고정해 분봉 가시 전 범위를 항상 덮음. 분봉이 그보다 과거로 못 가므로 미커버 거래일이 구조적으로 불가 — 튜닝 대상 아님.
- **cold-load / enable-while-panned 1-fetch 지연**: 일봉 fetch가 번들 게이트 밖 독립 commit이라, 지표를 **처음 켜는 순간**(또는 cold-load)엔 일봉 응답이 candle보다 한 fetch 늦게 도착 → 일봉 라인이 한 박자 뒤 나타날 수 있다(깜빡임 아님, 단순 지연 등장). lockstep 보장은 superset이 캐시된 **이후의 팬**에 적용. 1회성·무해 → v1 수용.
- **오늘 override 소스**: 오늘 segment 마지막 분봉 close를 현재가 프록시로 사용 → SSE 실시간 현재가선과 미세 lag 가능(분 단위). 20일 평균엔 무시 가능.

## Out of Scope (Backlog)

- Pane Legend / 커서 일봉MA 값 읽기 (`maSeriesRegistry`/`legendRows` 연동).
- D 타임프레임에도 일봉 MA 노출(현재봉 MA와 중복이나 일관성 위해 옵션화 가능).
- 일봉 MA의 점선(lineStyle) 기본 스타일로 현재봉 MA와 시각 구분.
- EMA / 가중 MA 종류 추가(현재봉 MA와 공통 과제).
- 백엔드 일봉 MA 감지·알림 피드.
