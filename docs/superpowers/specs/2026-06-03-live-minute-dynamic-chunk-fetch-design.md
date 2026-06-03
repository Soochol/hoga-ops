# Live 분봉 과거 데이터 동적 청크 fetch + 백그라운드 prefetch — Design

**Date**: 2026-06-03
**Status**: Draft
**Scope**: `frontend/src/live/liveDateTime.ts`, `frontend/src/live/LiveChartRoot.tsx`, `frontend/src/live/useLiveBundle.ts`, `frontend/src/api/livePastCandles.ts`

## Problem

`/live` 페이지에서 분봉 차트를 **왼쪽으로 드래그**해 과거 데이터를 불러올 때
오래 걸린다. 사용자 표현:

> "분봉에서 과거데이터를 불러올때 … 사용자가 현재 보고있는 캔들 차트에서
> 그려야할 영역 + 마진으로 불러오면 될것 같은데 그 로직이 없어서 오래걸리는것 같아서"

**측정으로 원인을 분리했다.** 직접 API 라운드트립(`/api/live/past-candles`,
today 미포함 42일 구간)으로 cold/warm을 비교:

| 시나리오 | 시간 | candles | fresh_dates | cached_dates |
|---|---|---|---|---|
| **COLD** (105560, 캐시 없음 → 실제 KIS 호출) | **32.18초** | 10,989 | 42 | 0 |
| **WARM** (재요청, 디스크 캐시됨) | **0.01초** | 10,989 | 0 | 42 |

한 번의 좌측 팬 요청에 **두 비용**이 섞여 있다:

- **Cost A — 이미 가진 `[prevFrom, today]` 재전송.** warm 디스크 캐시라
  **0.01초**. 무시할 수준.
- **Cost B — 새로 드러난 청크의 cold KIS fetch.** `fetch_past_minute_candles`
  가 하루를 시간 역진으로 4~5회 호출(120행/호출), 한 청크가 **42 캘린더일
  (≈28 거래일 × 4~5호출 ÷ 15호출/초) = 32초**. 이게 체감 지연의 전부다.

진짜 병목은 Cost B다. 그리고 청크 크기가 **고정 11,700봉(≈42일)** 인데
(`prefetchChunkCandlesFor`, `liveDateTime.ts:115`), 1분봉 화면에 실제 보이는
건 수백 봉이다 — 사용자가 "보이는 것보다 훨씬 많이 불러온다"고 느낀 그대로,
줌 레벨과 무관하게 항상 42일치를 cold로 긁는다.

## Invariants

이 spec이 건드리는 좌측 팬(historical backfill) 경로가 현재 보존하는 속성들:

- **Monotonic historical extension**: `extendHistoricalRange(date)`는 `date`가
  현재 `historicalFromDate`보다 **엄격히 과거일 때만** 갱신한다(단조 감소).
  근거: [livePage.ts:293-298](../../../frontend/src/state/livePage.ts).
- **No-freeze backfill (cur-base)**: 한 청크가 거래일 0개(주말/연휴)를 반환해
  axis가 안 움직여도, 다음 트리거는 `historicalFromDate − chunkDays`로 **또
  과거로** 내려가 동결되지 않는다(axis-base가 아니라 cur-base).
  근거: [liveDateTime.ts:152-162 `nextHistoricalFrom`](../../../frontend/src/live/liveDateTime.ts).
- **Atomic prepend (single commit)**: 좌측 팬은 candles(`/api/live/past-candles`)
  와 hoga(`/api/range`) 두 소스를 **한 commit에** prepend해 viewport shift가
  한 번에 일어난다(깜빡임/잘못된 inserted-index 방지). 근거:
  [useLiveBundle.ts:209-219 `extending` gate](../../../frontend/src/live/useLiveBundle.ts).
- **Viewport position preservation on prepend**: prepend 후 사용자가 보던 봉이
  같은 화면 위치·스케일에 머무른다(측정된 union-delta 만큼 logical range를
  동기 shift). 근거: [LiveChartRoot.tsx:424-448 `viewportShiftRef`](../../../frontend/src/live/LiveChartRoot.tsx).
- **250-day minute clamp**: 분봉 scroll-back 깊이는 250 캘린더일로 제한된다
  (일/주/월봉 경로엔 없음). 근거: [useLiveBundle.ts:24,73](../../../frontend/src/live/useLiveBundle.ts).

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| Monotonic historical extension | **preserves** | `nextFrom = cur − chunkDays`, `chunkDays ≥ 1`(3거래일 하한)이라 항상 `cur`보다 과거 → 가드 통과 |
| No-freeze backfill (cur-base) | **preserves** | cur-base 식 자체를 안 건드림. 3거래일 하한이 빈 청크 빈도까지 낮춰 오히려 강화 |
| Atomic prepend (single commit) | **preserves** | `extending` 게이트 미변경. 청크가 작아져도 prepend 단위만 작아질 뿐 한 commit 보장 유지 |
| Viewport position preservation | **preserves** | union-delta 기반 shift라 청크 크기와 무관. `viewportShiftRef` 로직 미변경 |
| 250-day minute clamp | **preserves** | clamp는 `useLiveBundle`에 그대로. 동적 청크는 clamp **이내**에서만 작게 자름 |

이 spec은 어떤 invariant도 깨지 않는다 — 청크 **크기 산출 입력**만 고정값에서
viewport 기반으로 교체하고, 그 위에 캐시 워밍(prefetch)을 얹는다.

## Goals

- 보통 줌(1분봉, 화면 수백 봉)에서 한 청크 cold fetch **32초 → ~3.4초**
  (3거래일 하한, 측정 1.14초/거래일 기준).
- 백그라운드 prefetch로 **연속 드래그 시 체감 대기 ~0** (다음 청크가 미리
  warm → 0.01초).
- 줌 레벨에 비례하는 청크 크기 — 줌인하면 적게, 줌아웃하면 많이(250일 clamp
  이내).

## Non-Goals

- **백엔드 KIS 호출 최적화**(주말/휴일 사전 스킵, `FID_PW_DATA_INCU_YN=Y`
  연속 walk-back) — cold 절대시간을 32→~19초로 줄이는 별도 레버. 후속 작업.
- **Windowing(새 청크만 전송, 이미 가진 범위 제외)** — Cost A가 0.01초로
  측정돼 체감 이득이 없음. 하지 않는다. `[from, today]` 전체 재요청 구조 유지.
- **today 폴링·WebSocket 실시간 경로** — 무관. 미변경.
- **일/주/월봉 fetch 구조** — 분봉이 대상. 단 동적 청크 산출은 모든
  LiveTimeframe에 자연 적용 가능(Design에서 명시).

## Design

핵심은 **한 곳의 입력 교체**다 — `prefetchChunkCandlesFor`가 반환하는 고정
"봉 목표치"를, 좌측 팬 시점의 **viewport 폭 기반 동적 값**으로 바꾼다. 환산
(`candleTargetToCalendarDays`), 트리거(`from < 0`), prepend, clamp는 전부 기존
코드 재사용.

### 1. 동적 청크 크기

좌측 팬 트리거 핸들러([LiveChartRoot.tsx:412-458](../../../frontend/src/live/LiveChartRoot.tsx))는
이미 `ts.getVisibleLogicalRange()`를 호출한다(viewportShift 캡처용). 거기서
청크 봉 수를 산출한다:

```text
slotsInView = visibleLogicalRange.to − visibleLogicalRange.from   // 화면 폭(줌 레벨)
target      = max(slotsInView, MIN_TRADING_DAYS_CANDLES(tf))      // 보정① 마진 X, 보정② emptyLeft 추가 X
```

- `slotsInView`는 빈 영역(whitespace) 포함 화면 폭이라 캔들이 절반만 보여도
  안정적으로 "화면 한 폭"을 준다. 마진·빈영역 가산은 하지 않는다(사용자 결정:
  "보정1,2 안하고 최소로").
- `MIN_TRADING_DAYS = 3`. 3거래일을 담는 봉 수가 하한. 주말 1회를 항상 커버해
  빈 청크로 인한 재드래그를 막는다. (1분봉 3거래일 = 1,170봉 ≈ 5 캘린더일.)
- 이 `target`을 기존 `candleTargetToCalendarDays(target, tf)`에 넣어 캘린더일로
  환산 → `chunkDays`.

`nextHistoricalFrom`을 **chunkDays 주입형**으로 바꾼다(pure 유지, table-test
가능):

```text
// 현재: chunkDays를 내부에서 prefetchChunkDaysFor(tf)로 고정 계산
nextHistoricalFrom(axisEarliestMs, historicalFromDate, tf)

// 변경: 호출부에서 동적 chunkDays를 넘김
nextHistoricalFrom(axisEarliestMs, historicalFromDate, chunkDays)
```

`prefetchChunkCandlesFor` / `prefetchChunkDaysFor`(고정 42일)는 동적 산출의
**하한 계산 헬퍼**(`MIN_TRADING_DAYS → 봉/일`)로 역할이 바뀌거나, 새 헬퍼
`viewportChunkDays(slotsInView, tf)`로 대체한다(plan에서 확정).

### 2. 백그라운드 prefetch

현재 청크가 settle되면 **다음 과거 청크 한 개**를 미리 워밍한다. react-query의
`queryClient.prefetchQuery`로 `useLivePastCandles`와 **동일한 queryKey**
(`['live','past-candles', code, nextFrom, today]`)를 호출 → 백엔드가 그 범위를
디스크 캐시에 채워둔다. 사용자가 실제로 그만큼 드래그하면 캐시 히트(warm).

- **다음 from 계산**: `nextHistoricalFrom(axisEarliest, 현재_historicalFromDate,
  chunkDays)` 를 한 번 더 적용(현재 청크 기준 한 칸 더 과거).
- **트리거 위치**: `useLiveBundle`(또는 전용 훅)에서 `pastCandlesQuery`가
  `isSuccess && !isFetching`일 때 effect로 1회. 코드/타임프레임 전환 시(=
  `historicalFromDate` null 리셋) prefetch 상태도 리셋.
- **prefetch 청크 크기**: 직전 사용자 청크의 `chunkDays`를 재사용(보통 줌이
  바뀌지 않으므로). viewport 부재 시 3거래일 하한.
- **상한**: `nextFrom < earliestAllowedMinute`(250일 clamp)면 prefetch 생략.
- hoga(`/api/range`)는 prefetch 대상에서 제외(분봉 candle cold 비용이 지배적이고,
  `/api/range`는 90일 cap + 별 캐시 특성이 달라 1차 범위 밖). 필요 시 후속.

### 3. 데이터 흐름 (변경 후)

```text
좌측 팬(from<0)
  └─ slotsInView = getVisibleLogicalRange().to − from
     target      = max(slotsInView, 3거래일분)
     chunkDays   = candleTargetToCalendarDays(target, tf)
     nextFrom    = nextHistoricalFrom(axisEarliest, cur, chunkDays)   // monotonic
  └─ (150ms debounce) extendHistoricalRange(nextFrom)
        └─ useLiveBundle: minutePastFrom=nextFrom → useLivePastCandles 재키
              └─ 백엔드: [nextFrom..prevFrom) 새 거래일만 cold(~3.4초),
                        [prevFrom..today]는 디스크 캐시 warm(0.01초)
              └─ extending 게이트로 candles+hoga 한 commit prepend
              └─ viewportShiftRef restore — 보던 봉 위치 유지
  └─ settle 후: prefetchQuery(nextFrom 한 칸 더 과거) — 백그라운드 워밍
```

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| 동적 청크 — 보통 줌 | slotsInView=800 (1m) | target=max(800, 1170)=1170 → chunkDays=5 |
| 동적 청크 — 줌아웃 | slotsInView=6000 (1m) | target=6000 → chunkDays=22 |
| 동적 청크 — 줌인/하한 | slotsInView=167 (1m) | 하한 적용 target=1170 → chunkDays=5 |
| 동적 청크 — viewport 부재 | logicalRange=null | 3거래일 하한 fallback → chunkDays=5 |
| `nextHistoricalFrom` monotonic | cur='20260410', chunkDays=5 | 결과 `<` cur (단조 감소) |
| `nextHistoricalFrom` 빈 청크 연속 | axis 고정, cur 갱신 2회 | 매번 cur−chunkDays로 더 과거(동결 없음) |
| prefetch 250일 clamp | nextFrom < earliestAllowedMinute | prefetch 생략 |

**Invariant 회귀 테스트**:
- Monotonic: 동적 chunkDays(1~250)에 대해 `nextHistoricalFrom(...) < cur` 항상 참.
- No-freeze: 동일 axis로 연속 호출 시 결과가 단조 감소(기존 table-test에 동적
  chunkDays 케이스 추가).
- 250-day clamp: 줌아웃 큰 청크여도 `minutePastFrom ≥ earliestAllowedMinute`
  (기존 clamp 회귀 유지).

### Manual verification

`/live`에서 (CORS상 직접 API 라운드트립 병행):
1. 캐시 없는 종목으로 1분봉 좌측 팬 1회 → 응답 timing이 **~3~4초**(기존 ~32초
   대비), `fresh_dates` 길이가 ~5(3거래일 하한)인지.
2. 같은 방향으로 한 번 더 팬 → 직전 prefetch 덕에 **즉시(warm)** 그려지는지
   (`cached_dates`로 응답).
3. 줌아웃 후 팬 → 청크가 자연히 커지는지(`fresh_dates` 증가).
4. 보던 봉이 prepend 후 같은 화면 위치에 머무는지(viewport preservation 회귀).
5. 연휴 구간(예 설/추석)을 가로질러 팬 → 동결 없이 계속 과거로 가는지.

## Risks / Open questions

- **prefetch 중복/경쟁**: 사용자가 빠르게 연속 팬하면 prefetch 대상과 실제
  요청이 같은 키로 겹칠 수 있음 — react-query dedup이 처리하지만, prefetch
  effect의 재실행 가드(직전 nextFrom 기억) 필요.
- **slotsInView 단위 확인**: `getVisibleLogicalRange().to − from`이 화면 폭
  봉 슬롯 수와 일치하는지 실측 1회 확인(라이브러리 버전 의존). 어긋나면
  `timeScale().width() / barSpacing` fallback.
- **prefetch 1칸으로 충분한가**: 매우 빠른 연속 드래그는 1칸 prefetch를
  추월할 수 있음. 2칸 또는 "idle 동안 clamp까지 점진 워밍"은 후속에서 평가.

## Out of Scope (Backlog)

- 백엔드 KIS 호출 최적화: 주말/휴일 사전 스킵(거래일 캘린더 연계) +
  `FID_PW_DATA_INCU_YN=Y` 연속 walk-back으로 per-day 루프 제거(cold 32→~19초).
- hoga(`/api/range`) 경로 prefetch 워밍.
- 일/주/월봉 청크의 viewport 동적화(현재도 동작하나 분봉만큼 cold 비용이
  크지 않음).
