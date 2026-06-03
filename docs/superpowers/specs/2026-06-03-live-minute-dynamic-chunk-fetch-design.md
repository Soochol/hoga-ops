# Live 분봉 과거 데이터 — 고정 스텝 점진 채우기 (Progressive Step Fill) — Design

**Date**: 2026-06-03
**Status**: Draft
**Scope**: `frontend/src/live/liveDateTime.ts`, `frontend/src/live/LiveChartRoot.tsx`, `frontend/src/live/useLiveBundle.ts`

> **그릴링 이력 (2026-06-03)**: 이 spec은 grill-with-docs 세션을 거쳐
> 원안("viewport 폭 동적 청크 1-shot + 백그라운드 prefetch")에서 크게 바뀌었다.
> 확정 결정: ① 청크를 viewport 폭으로 한 번에 받지 않고 **고정 3거래일 스텝씩
> 점진적으로** 받아 화면이 찰 때까지 반복(latency cap 보장). ② **마진 없음**(유지).
> ③ **백그라운드 prefetch 삭제**. ④ 연휴 처리(백엔드 주말/휴일 스킵)는 **후속**.
> 근거는 각 절에 인라인. 이 결정은 **ADR-0059**가 명문화한다(42일 1-shot 폐기 +
> prefetch 미채택 — 되돌리기 방지).

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
  **0.01초**(네트워크). 무시할 수준.
- **Cost B — 새로 드러난 거래일의 cold KIS fetch.** `fetch_past_minute_candles`
  가 하루를 시간 역진으로 4~5회 호출(120행/호출), 한 번에 **42 캘린더일
  (≈28 거래일 × 4~5호출 ÷ 15호출/초) = 32초**. 이게 체감 지연의 전부다.

진짜 병목은 Cost B다. 그리고 지연의 구조적 원인은 청크 크기가 **고정
11,700봉(≈42일)** 이라는 것(`prefetchChunkCandlesFor`, `liveDateTime.ts:115`).
1분봉 화면에 실제 보이는 건 수백 봉인데 줌 레벨과 무관하게 **항상 42일치를 한
번에 cold로 긁고, 그게 다 올 때까지 아무것도 안 그려진다** — 사용자가 "보이는
것보다 훨씬 많이 불러온다 + 오래 걸린다"고 느낀 그대로다.

**측정으로 cold 비용은 새 거래일 수에 선형**임도 확인했다: 42 캘린더일 ≈ 28
거래일 = 32초 → **약 1.14초/거래일**. 이게 이 spec의 설계 단위다(아래 Design은
"거래일 스텝" 단위로 비용을 자른다).

### 렌더 비용 (별도 축, 측정)

네트워크 외에 **클라이언트 렌더 비용**이 따로 있다. `bundle`이 바뀌면
`RangeSeriesPane`이 모든 시리즈에 **전체 `setData`**를 호출하는데(lwc v5엔
front-insert/prepend API가 없어 전체 교체만 가능), 이 비용은 차트에 들어있는
봉 개수(스크롤백 깊이)에 비례한다. lwc v5.2.0, 오프스크린 3시리즈 실측:

| 깊이 | 봉 수 | `setData` ×3시리즈 |
|---|---|---|
| ~72일 | 20k | **~48ms** |
| ~144일 | 40k | **~105ms** |
| ~250일(clamp 상한) | 70k | **~158ms** |

선형(~2.3ms/1k봉). **보통 깊이(≤72일)는 jank 임계 이하, 250일 극단만 hitch.**
점진 채우기는 한 번의 좌측 팬을 **여러 스텝으로 나눠 매 스텝 `setData`를
트리거**하므로 이 비용을 더 자주 낸다 — 단 매 스텝의 비용은 깊이별 단발
(~48~158ms)이고, **스텝이 그려지는 것 자체가 진행 표시**라 수용 가능하다고
판단했다(사용자 결정: 250일 극단 hitch는 감수, 보통 깊이는 무해).

## Invariants

이 spec이 건드리는 좌측 팬(historical backfill) 경로가 현재 보존하는 속성들.
**점진 채우기는 한 번의 팬에서 prepend를 N회(스텝마다 1회) 수행하므로, 아래
prepend-관련 invariant는 "매 스텝마다" 성립해야 한다.**

- **Monotonic historical extension**: `extendHistoricalRange(date)`는 `date`가
  현재 `historicalFromDate`보다 **엄격히 과거일 때만** 갱신한다(단조 감소).
  근거: [livePage.ts:293-298](../../../frontend/src/state/livePage.ts).
- **No-freeze backfill (cur-base)**: 한 스텝이 거래일 0개(주말/연휴)를 반환해
  axis가 안 움직여도, 다음 스텝은 `historicalFromDate − stepDays`로 **또 과거로**
  내려가 동결되지 않는다(axis-base가 아니라 cur-base). **이것이 작은 스텝이
  연휴에서 안전한 유일한 근거다** — 옛 42일 고정 청크가 "짧은 청크는 비거래일에
  떨어져 동결"을 피하려 컸던 이유를, 이제 cur-base가 대신 처리한다.
  근거: [liveDateTime.ts:152-162 `nextHistoricalFrom`](../../../frontend/src/live/liveDateTime.ts).
- **Atomic prepend (single commit)**: 한 스텝의 좌측 팬은 candles
  (`/api/live/past-candles`)와 hoga(`/api/range`) 두 소스를 **한 commit에**
  prepend해 viewport shift가 한 번에 일어난다(깜빡임/잘못된 inserted-index 방지).
  근거: [useLiveBundle.ts:209-219 `extending` gate](../../../frontend/src/live/useLiveBundle.ts).
- **Viewport position preservation on prepend**: prepend 후 사용자가 보던 봉이
  같은 화면 위치·스케일에 머무른다(측정된 union-delta 만큼 logical range를
  동기 shift). 점진 채우기에선 **매 스텝마다** 이 보존이 성립해 사용자가 보는
  봉은 고정인 채 왼쪽 빈 영역만 채워진다. 근거:
  [LiveChartRoot.tsx:424-448 `viewportShiftRef`](../../../frontend/src/live/LiveChartRoot.tsx).
- **250-day minute clamp**: 분봉 scroll-back 깊이는 250 캘린더일로 제한된다
  (일/주/월봉 경로엔 없음). **점진 루프의 하드 종료 조건**이기도 하다(아래 Design).
  근거: [useLiveBundle.ts:24,73](../../../frontend/src/live/useLiveBundle.ts).

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| Monotonic historical extension | **preserves** | `nextFrom = cur − stepDays`, `stepDays ≥ 1`(3거래일)이라 항상 `cur`보다 과거 → 가드 통과. 루프 매 회 성립 |
| No-freeze backfill (cur-base) | **preserves / 강화** | cur-base 식 미변경. 점진 루프가 연휴 스텝(거래일 0개)에서 자동으로 다음 스텝을 더 과거로 보내 동결 없이 채움 |
| Atomic prepend (single commit) | **preserves** | `extending` 게이트 미변경. **스텝마다** candles+hoga 한 commit prepend. 스텝이 작아도 단위만 작아질 뿐 atomicity 유지 |
| Viewport position preservation | **preserves — 단 스텝 2..N 캡처는 Open Q** | union-delta shift는 스텝 크기와 무관하나, 캡처가 현재 드래그 핸들러에 동기 종속(step 1만 자연 커버). 프로그램적 스텝 2..N 캡처 메커니즘은 Design §2 Open Question(기본 settle-effect 명시 캡처) |
| 250-day minute clamp | **preserves / 종료조건화** | clamp 유지(250일). 점진 루프는 `nextFrom ≤ earliestAllowedMinute`면 종료. worst-case `setData`(~158ms)는 이 상한이 곧 한계 |

이 spec은 어떤 invariant도 깨지 않는다 — 청크 **크기 산출 + 트리거 방식**만
"고정 42일 1-shot"에서 "고정 3거래일 스텝 점진 루프"로 교체한다. prepend·clamp·
viewport-shift 기존 코드는 그대로 재사용하되 **루프 안에서 N회** 돈다.

## Goals

- **헤드라인 (latency cap)**: 어떤 줌/뷰 폭에서도 좌측 팬 시 **첫 그림이 ~3.4초
  안에**(3거래일 스텝, 1.14초/거래일). 보통 줌은 1스텝으로 끝나 기존 32초 →
  ~3.4초. **viewport가 넓어도 32초 한 방 stall이 다시 생기지 않는다** — 이게
  고정 스텝 점진 채우기의 핵심 가치다(사용자가 32초에 데인 트라우마 차단).
- **점진 채우기**: 넓은 구간은 3거래일씩 받아 그릴 때마다 화면이 왼쪽으로
  채워진다(진행 표시). 한 번에 다 받아 한 번에 그리는 긴 stall 없음.
- **viewport 채움까지만**: 빈 영역이 사라지면(visible logical `from ≥ 0`) 루프
  종료 — "보이는 것보다 훨씬 많이"를 구조적으로 차단. 마진·빈영역 가산 없음
  (사용자 결정: "보정1,2 안하고 최소로").
- **warm 재방문은 그대로 빠름**: 한 번 받은 날짜는 디스크 캐시(날짜별 파일)라
  재방문 0.01초. 이건 기존 동작이며 이 spec이 보존한다(삭제한 prefetch와 무관).

## Non-Goals

- **백그라운드 prefetch (원안 §2) — 삭제.** "사용자가 멈춘 사이 다음 청크를 미리
  받기"를 넣지 않는다. 근거(그릴링): 1-ahead는 연속 드래그를 못 따라잡고(스텝
  2부터 뒤처짐), 간헐 팬은 §1만으로 이미 ~3.4초라 prefetch의 추가 이득(2번째
  peek instant)이 배선·KIS 백그라운드 호출·캐시 증가 비용을 정당화하지 못한다.
  모든 KIS 호출은 사용자 드래그로만 발생한다(ADR-0040 캐시 50MB·ADR-0050
  EGW00201 rate-limit 자극 안 함). 연속 드래그 near-zero가 필요하면
  "clamp까지 점진 백그라운드 워밍"이 별도 follow-up(Backlog).
- **차트 render-windowing**(보이는 범위+마진만 `setData`, 스크롤마다 재윈도잉)
  — `setData` 전체 교체 비용(깊이 250일 ~158ms)을 줄일 유일한 길이지만 ask보다
  훨씬 크고 회귀 위험이 높다. 점진 채우기로 스텝당 `setData` 횟수가 늘지만 보통
  깊이(≤72일 ~48ms)는 무해하고 250일 극단 hitch는 감수하기로 결정.
- **백엔드 KIS 호출 최적화 (연휴 처리 포함)** — `_date_iter`(api.py:50)가 `[from,
  today]`의 **모든 캘린더 날짜**를 돌아, 캐시에 없는 주말/휴일도 KIS를 1회씩
  헛호출한다(KIS가 전날 봉 반환 → 백엔드 discard → 빈 결과 캐시). 추석·설 같은
  긴 연휴를 **처음** 가로지르면 휴장일 수만큼(~1~2초) 헛호출. 백엔드가 거래일
  달력으로 주말/휴일을 사전 스킵(+`FID_PW_DATA_INCU_YN=Y` 연속 walk-back)하면
  cold 절대시간 32→~19초 + 연휴 헛호출 제거. **별도 레버, 후속**(그릴링 결정:
  "연휴는 나중에"). §1(프론트 스텝)과 직교 — `_date_iter`는 백엔드 속성이라 프론트
  스텝 크기와 무관하게 캘린더 날짜를 돈다.
- **초기 first-paint cold** — `initialCandleTargetFor(1m)` ≈ 28거래일도 같은
  cold 32초가 든다. 사용자가 "드래그"로 한정한 범위 밖. 별도 작업.
- **SSE tick마다 bundle 전체 rebuild → setData** — `computedBundle`의 deps에
  `live.ob`/`live.trade`가 있어, 깊이 팬한 채 장중이면 tick마다 전체 `setData`가
  발생한다(스텝과 **무관**). 직교하는 선재 문제이자 더 큰 렌더 이슈일 수 있으나
  이번 범위 밖 — 후속.
- **Windowing(네트워크: 새 거래일만 전송)** — Cost A가 0.01초로 측정돼 체감
  이득이 없음. `[from, today]` 전체 재요청 구조 유지(날짜별 캐시 조회의 근거).
- **today 폴링·WebSocket 실시간 경로** — 무관. 미변경.
- **일/주/월봉 fetch 구조** — 분봉이 대상. 스텝 점진 채우기는 모든 LiveTimeframe에
  자연 적용 가능하나(같은 트리거·prepend 경로), 이번 검증은 분봉 한정.

## Design

핵심은 **"한 번에 viewport 폭만큼 1-shot"을 "고정 3거래일 스텝 점진 루프"로
교체**하는 것이다. 환산(`candleTargetToCalendarDays`), 트리거(`from < 0`),
prepend, clamp, viewport-shift는 전부 기존 코드 재사용 — 루프 안에서 N회 돈다.

### 1. 고정 스텝 크기

스텝은 **viewport 폭이 아니라 고정 3거래일**이다(원안의 `slotsInView` 산출·5/7
환산은 사이징에서 빠진다 — 종료 판정에만 viewport를 본다).

```text
STEP_TRADING_DAYS = 3                                 // 튜닝 상수 (latency cap)
stepDays = candleTargetToCalendarDays(                // 거래일 → 캘린더일
             tradingDaysToCandles(STEP_TRADING_DAYS, tf), tf)
         ≈ 5 캘린더일 (1m: 3거래일 = 1,170봉 ≈ 5일)
```

- **왜 3거래일**: 첫 그림 ~3.4초(=헤드라인 32→3.4초). 주말 1회를 한 스텝에 항상
  덮어 빈 결과로 인한 재드래그를 막는다(1분봉 3거래일 = 1,170봉 ≈ 5 캘린더일).
- **튜닝 상수**: `MIN_TRADING_DAYS`/`STEP_TRADING_DAYS` 한 곳. 구현 후 실측으로
  3↔5 조정 가능(latency cap vs 렌더 횟수 trade-off). 데이터를 덜 받는 게 아니라
  "첫 그림 시점 + 렌더 분할 횟수"만 바뀐다.

`nextHistoricalFrom`을 **stepDays 주입형**으로 바꾼다(pure 유지, table-test 가능):

```text
// 현재: chunkDays를 내부에서 prefetchChunkDaysFor(tf)로 고정 42일 계산
nextHistoricalFrom(axisEarliestMs, historicalFromDate, tf)

// 변경: 호출부에서 고정 stepDays(3거래일분)를 넘김
nextHistoricalFrom(axisEarliestMs, historicalFromDate, stepDays)
```

`prefetchChunkCandlesFor`/`prefetchChunkDaysFor`(고정 42일)는 **삭제 또는
3거래일 스텝 계산 헬퍼로 대체**(plan에서 확정). 새 헬퍼
`stepChunkDays(tf)` ≈ `candleTargetToCalendarDays(tradingDaysToCandles(3, tf), tf)`.

### 2. 점진 채우기 루프 (viewport 찰 때까지)

한 번의 좌측 팬을 **여러 스텝으로 자가 전진**한다. 각 스텝 = 1 fetch + 1 commit
+ 1 render. "스텝 settle → viewport 재측정 → 빈영역 남았으면 다음 스텝" 자가
propel 구조:

```text
[스텝 1 트리거]  visibleLogicalRangeChange 에서 from < 0 (사용자 드래그)
                → captureShift() 동기 캡처 → 150ms debounce → extendHistoricalRange(nextFrom₁)

[한 스텝]  extendHistoricalRange(nextFromₙ)
             nextFromₙ = nextHistoricalFrom(axisEarliest, cur, stepDays)   // monotonic
           → useLiveBundle: minutePastFrom=nextFromₙ → 두 past 쿼리 재키
           → extending 게이트로 candles+hoga 한 commit prepend (atomic)
           → RangeSeriesPane 전체 setData + viewportShiftRef 동기 복원

[스텝 n+1 판정]  prepend settle(extending=false) 후 viewport from 재측정:
             • from ≥ 0                          → 종료 (화면 꽉 참) ✓
             • nextFromₙ ≤ earliestAllowedMinute → 종료 (250일 clamp) ✓
             • 새 봉 0 연속 K회 (데이터 끝)        → 종료 (백스톱) ✓
             • 그 외(from < 0)  → captureShift() → extendHistoricalRange(nextFromₙ₊₁)
```

**`captureShift()` = 스텝 2..N의 핵심 Open Question (advisor 지적).** 현재
viewportShiftRef 캡처는 [LiveChartRoot.tsx:435-448]에서 **드래그 핸들러 안
동기**로만 일어난다(`subscribeVisibleLogicalRangeChange`, `from<0` 게이트). 이건
**스텝 1(사용자 드래그)만 자연 커버**하고, 프로그램적으로 dispatch되는 스텝 2..N은
이 캡처 지점을 우회한다 — 그대로면 스텝 2부터 viewport 보존이 깨져 매 스텝
점프/깜빡임. 삭제한 prefetch 트리거(settle effect)가 정확히 이 캡처 없는 형태였다.
해소 둘 (plan에서 lwc 동작 1회 실측 후 확정):

- **(a) 핸들러 자가구동** — prepend의 `setData` + viewport-shift 복원이
  `visibleLogicalRangeChange`를 재발화 → 핸들러 재진입 → `from<0`이면 캡처 +
  다음 스텝 dispatch. 별도 effect 불필요, 루프가 기존 핸들러로 emerge.
  **전제 검증 필요**: lwc가 *프로그램적* `setVisibleLogicalRange`에도 이벤트를
  재발화하는가(라이브러리가 loop 방지로 억제하면 스텝 1 후 정지).
- **(b) settle-effect 명시 캡처 〔기본〕** — `extending`이 false로 떨어질 때
  effect가 viewport from을 재측정하고, `from<0`이면 **드래그 핸들러와 동일한
  `vr.to` 앵커 로직**으로 캡처 후 다음 스텝 dispatch. 이벤트 재발화에 의존하지
  않아 robust. effect 1개 추가.

**기본은 (b)** (lwc 이벤트 재발화 의미에 비의존). 어느 쪽이든 캡처 로직은
핸들러/effect가 공유하는 단일 `captureShift()` 헬퍼로 추출 — 캡처가 두 곳에
중복되지 않게.

- **종료 조건 셋 + 백스톱**: 위 박스 4분기. (a)/(b) 정상 종료, 백스톱(새 봉 0
  연속 K회)은 종목 상장 이전 공백 등 viewport가 영영 안 차는 무한 루프 방지
  (K는 plan에서 확정). **연휴 스텝(거래일 0개)은 종료가 아니다** — cur-base가
  다음 스텝을 더 과거로 보내 자동으로 넘는다.
- **루프 중 재드래그 / in-flight**: 스텝 fetch(~3.4초) 중 사용자가 더 끌면
  핸들러가 같은 `cur`로 같은 nextFrom을 재계산 → store monotonic 가드가 흡수
  (중복 dispatch 무시). settle 후에야 cur 갱신 → 다음 스텝 전진. effect 재실행
  가드(직전 dispatch nextFrom 기억)로 진행 중 스텝 1개만 보장.
- **prepend 단위 = 스텝**: 한 스텝의 prepend는 그 스텝의 새 거래일 + (이미 가진)
  `[prevFrom, today]` 재전송이지만 후자는 warm 0.01초라 무시.

### 3. 데이터 흐름 (변경 후)

```text
좌측 팬(from<0)  ──debounce──┐
                            ▼
        ┌────────────── 스텝 N ──────────────┐
        │ nextFrom = nextHistoricalFrom(axisEarliest, cur, stepDays=3거래일분)
        │ extendHistoricalRange(nextFrom)        // monotonic
        │   └ useLiveBundle: minutePastFrom=nextFrom → useLivePastCandles 재키
        │       └ 백엔드: [nextFrom..prevFrom) 새 거래일만 cold(~3.4초/3거래일),
        │                 [prevFrom..today]는 디스크 캐시 warm(0.01초)
        │       └ extending 게이트로 candles+hoga 한 commit prepend
        │       └ RangeSeriesPane 전체 setData(깊이별 ~48~158ms) + viewportShift 복원
        └──────────────┬──────────────────────┘
                       ▼ settle 후 viewport from 재측정
            from ≥ 0 ? ──예──▶ 종료 (화면 꽉 참)
               │ 아니오
            nextFrom ≤ clamp ? ──예──▶ 종료 (250일)
               │ 아니오
               └──────▶ 스텝 N+1 (cur 갱신)
```

(원안 §2 백그라운드 prefetch 데이터 흐름은 **삭제**.)

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| 스텝 크기 산출 (1m) | `stepChunkDays('1m')` | 3거래일 → ≈5 캘린더일 (`chunkDays=5`) |
| `nextHistoricalFrom` monotonic | cur='20260410', stepDays=5 | 결과 `<` cur (단조 감소) |
| 루프 — 보통 줌 1스텝 | viewport ≈ 2거래일 폭, 빈영역 < 3거래일 | 스텝 1회로 `from ≥ 0` 도달 → dispatch 1회 |
| 루프 — 줌아웃 N스텝 | viewport ≈ 9거래일 폭(빈영역 9거래일) | `from ≥ 0`까지 3스텝(3거래일씩) → dispatch 3회, 단조 감소 |
| 루프 — 250일 clamp 종료 | cur가 clamp 근처, viewport 여전히 빈영역 | `nextFrom ≤ earliestAllowedMinute`면 from<0여도 종료 |
| 루프 — 연휴 스텝 비종료 | 한 스텝이 거래일 0개(설 구간) | 종료 아님; 다음 스텝 cur−stepDays로 더 과거(동결 없음) |
| 루프 — 데이터 끝 백스톱 | 상장 이전 공백, 새 봉 0 연속 K회 | 무한 루프 없이 종료 |

**Invariant 회귀 테스트**:
- Monotonic: 고정 stepDays(3거래일분)에 대해 `nextHistoricalFrom(...) < cur` 항상 참.
- No-freeze: 동일 axis로 연속 호출 시 결과가 단조 감소(table-test에 스텝 케이스 추가).
- 250-day clamp: 루프가 여러 스텝을 돌아도 `minutePastFrom ≥ earliestAllowedMinute`.
- Atomic prepend: **매 스텝** `extending` 게이트가 candles+hoga 한 commit 보장.

### Manual verification

`/live`에서 (CORS상 직접 API 라운드트립 병행):
1. 캐시 없는 종목으로 1분봉(보통 줌) 좌측 팬 1회 → **첫 그림이 ~3~4초**
   (기존 ~32초 대비), `fresh_dates` 길이가 ~3거래일(≈5)인지, 스텝 1회로 끝나는지.
2. **줌아웃 후** 좌측 팬 → 화면이 3거래일씩 **여러 번에 걸쳐 채워지는지**
   (각 스텝 그려질 때마다 왼쪽이 채워짐), 첫 스텝이 ~3.4초 안에 보이는지.
3. 보던 봉이 매 스텝 prepend 후 같은 화면 위치에 머무는지(viewport preservation).
4. 연휴 구간(예 설/추석)을 가로질러 팬 → 동결 없이 계속 과거로 채워지는지
   (첫 통과 시 연휴 헛호출로 약간 지연될 수 있음 — Non-Goal, 후속).
5. 250일 깊이까지 끌어 → clamp에서 루프가 멈추는지(빈영역 남아도 더 안 받음).

## Risks / Open questions

- **viewport 채움 판정 단위**: 루프 종료는 `getVisibleLogicalRange().from ≥ 0`로
  본다(빈 영역이 사라졌는가). lwc 버전 의존 — `from`이 "왼쪽 빈영역 봉슬롯 음수
  인덱스"와 일치하는지 실측 1회 확인. 어긋나면 `timeScale().width()/barSpacing`
  기반 fallback.
- **스텝 2..N viewport 보존 캡처 (load-bearing)**: 기존 `viewportShiftRef` 캡처는
  드래그 핸들러 동기 코드라 프로그램적 스텝을 우회 → 그대로면 스텝 2부터 점프.
  Design §2의 (a)/(b)로 해소(기본 settle-effect 명시 캡처). plan 첫 태스크에서
  lwc 이벤트 재발화 동작을 실측해 (a) 가능 여부 판정. 이게 깨지면 점진 채우기의
  "부드럽게 채워짐"이 "스텝마다 깜빡"으로 퇴화 — 구현 전 반드시 확정.
- **루프 중 재드래그 동시성**: 빠른 연속 팬 시 진행 중 스텝과 새 dispatch가 같은
  키로 겹칠 수 있음 — store monotonic 가드 + react-query dedup이 흡수하되, effect
  재실행 가드(직전 nextFrom 기억)로 스텝 1개만 진행 보장.
- **N 렌더 (스텝당 setData)**: 넓은 구간을 채울 때 스텝마다 전체 `setData`
  (~48~158ms 깊이별). 보통 깊이는 수용(진행 표시), 깊은 스크롤백에선 스텝 사이
  hitch 가능. 줄이는 유일한 길은 render-windowing(Non-Goal).
- **무한 루프 백스톱**: 종목 상장 이전 공백·데이터 종료에서 viewport가 절대 안
  차는 경우 (c) 백스톱(새 봉 0 연속 K회)으로 종료 — K 값 plan에서 확정.
- **연휴 첫 통과 지연**: `_date_iter` 헛호출로 긴 연휴 첫 통과 시 스텝이 ~1~2초
  더 걸릴 수 있음. 백엔드 후속(Non-Goal)이 근본 해결, 이 spec 범위 밖.

## Out of Scope (Backlog)

- **백엔드 KIS 호출 최적화 (연휴 처리)**: `_date_iter`가 거래일 달력으로 주말/
  휴일 사전 스킵 + `FID_PW_DATA_INCU_YN=Y` 연속 walk-back으로 per-day 루프·연휴
  헛호출 제거(cold 32→~19초). §1과 직교.
- **연속 드래그 near-zero**: clamp까지 점진 백그라운드 워밍(삭제한 prefetch의
  자리를 대체하는, 더 공격적인 follow-up — KIS rate-limit 예산·취소·캐시 상한
  설계 동반).
- **SSE tick rebuild → 전체 setData**: `computedBundle` deps의 `live.ob/trade`로
  장중 깊이 팬 시 스텝 무관 연속 `setData`. 직교하나 더 큰 렌더 물고기.
- **초기 first-paint cold 단축**.
- **hoga(`/api/range`) 경로 워밍**.
- **차트 render-windowing**(보이는 범위만 setData)으로 250일 hitch + N렌더 제거.
- **CONTEXT.md**: 구현 착지 시 **Live Candle Backfill** 항목에 "분봉 좌측 팬은
  3거래일 스텝으로 점진 채움(viewport 찰 때까지)" 한 줄 추가(현재는 draft라 미반영).
