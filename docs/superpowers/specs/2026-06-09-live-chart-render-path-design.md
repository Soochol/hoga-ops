# /live 차트 렌더 경로 최적화 (프론트 전용) — Design

**Date**: 2026-06-09
**Status**: Draft
**Scope**: `frontend/src/chart/projectors/candle.ts`, `frontend/src/util/sessionTime.ts`, `frontend/src/util/virtualAxis.ts`, `frontend/src/api/livePastCandles.ts`, `frontend/src/api/range.ts`, `frontend/src/api/livePastDailyCandles.ts`, `frontend/src/api/livePastInvestorNet.ts`, `frontend/src/live/liveDateTime.ts`

> 진단 출처: 두 차례의 조사 워크플로우(KIS 백필 지연 + 주기적 REST 병목)와 본 세션의 코드 직접 검증. 백엔드 cold-fetch 3~5초(별도 세션), 백필 응답 델타화, 폴러 수요 감축/WS 전환은 **이 스펙의 범위 밖**이다.

## Problem

`/live` 차트를 과거로 스크롤하면 가끔 끊김(jank)이 느껴진다. 백엔드 cold-fetch 지연(3~5초)은 별도 세션에서 다루고, 이 스펙은 **백엔드가 빨라져도 남는 프론트엔드 렌더·페치 경로의 낭비** 세 가지를 다룬다. 모두 코드에서 직접 확인했으며, 각 항목의 효과는 **관측 가능한 범위로만** 한정한다.

1. **projectCandle 핫패스의 중복 선형 스캔** — 캔들마다 `axis.contains`와 `axis.inClosingAuctionWindow`가 각각 `sessionPhaseAt`(세그먼트 선형 for-루프)를 호출한다. 즉 **캔들당 동일 선형 스캔 2회** + `toVirtual`의 이진 탐색 1회. 250일 깊이 ≈ 170세그먼트 × ~65k 캔들 × 2 ≈ **22M 비교/커밋/패널**.
2. **드래그 중 버려질 요청의 stale 커밋** — `useLivePastCandles`의 `queryFn`이 react-query가 제공하는 `signal`을 `fetch`에 넘기지 않아, 빠른 드래그로 쿼리 키가 바뀌어도 이전 in-flight 요청이 취소되지 않고 도착 시 UI를 처닝한다.
3. **장외 24시간 전체-윈도 리페치** — `refetchInterval: 60_000`이 장 마감 후에도 `[from, today]` 전체 윈도를 매분 재페치한다. 과거 데이터는 불변이고 장외엔 오늘 봉도 안 변하므로, 네트워크 왕복 + 백엔드 오늘-KIS 호출(닫혀도 1~4콜/리페치)이 순수 낭비다.

## Invariants

이 스펙이 건드리는 시스템이 **현재 보존하는** 속성:

- **Phase classification fidelity**: 모든 `realMs`에 대해 `sessionPhaseAt`가 반환하는 phase(`pre-open`/`regular`/`auction`/`gap`/`pre-axis`/`post-axis`)는 KRX 세션 규칙의 단일 진실이다. 캔들 projector의 `contains`(= regular∨auction)와 `inClosingAuctionWindow`(= auction)가 여기에 위임한다. 근거: `frontend/src/util/sessionTime.ts:81` (`sessionPhaseAt`), `virtualAxis.ts:231,252` (위임).
- **Virtual coordinate mapping**: `toVirtual(realMs)`는 실시간→가상축 좌표 변환의 단일 정의이며 이미 이진 탐색(`findByReal`)이다. 근거: `virtualAxis.ts:190` (`toVirtual`), `:160` (`findByReal`).
- **Code-aware placeholder**: 코드 전환 시 `past-candles` 쿼리가 이전 코드의 캔들 수로 초기 뷰 effect를 오염시키지 않도록 `placeholderData`가 코드 일치 시에만 이전 데이터를 유지한다. 근거: `livePastCandles.ts:46-52`.
- **Segments-identity stabilization**: 내용 동일한 SSE 푸시가 `segments` 배열 참조를 바꾸지 않아 VirtualAxis·lwc 라벨 캐시를 헛되이 무효화하지 않는다. 근거: `useLiveBundle.ts:172-196`.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| Phase classification fidelity | preserves | 항목 2a는 선형 스캔을 이진 탐색으로 바꾸되 **반환 phase는 모든 입력에서 동일**해야 함. 프로퍼티 테스트로 선형 버전과 등가성 증명. |
| Virtual coordinate mapping | preserves | `toVirtual`/`findByReal`는 이미 이진 탐색 — 손대지 않음. 항목 2b 융합은 동일 `findByReal` 결과를 재사용할 뿐 매핑 정의를 바꾸지 않음. |
| Code-aware placeholder | preserves | 항목 3은 `refetchInterval`만 조건화. `placeholderData`·`queryKey`·`staleTime` 무변경. |
| Segments-identity stabilization | preserves | 항목 2·3 모두 `useLiveBundle`의 segments 재사용 로직을 건드리지 않음. |

*의도적으로 깨는 invariant 없음.*

## Goals

- **항목 2**: 깊은 스크롤(≈170세그먼트)에서 projector+setData 커밋의 메인스레드 점유를 **수십 ms → 한 자릿수 ms**로. 측정으로 입증(아래 Testing).
- **항목 3**: 쿼리 키가 in-flight 중 바뀌면 이전 요청이 **취소되어 stale 커밋·UI 처닝이 발생하지 않음**.
- **항목 4**: 장외 시간에 `past-candles`/`range`/`daily`/`investor-net` 리페치가 **멈춰** 무의미한 네트워크 왕복 + 백엔드 오늘-KIS 호출이 0이 됨.

## Non-Goals

- 백엔드 cold-fetch 3~5초 (별도 세션 — `/api/live/past-candles` 직렬 KIS 루프).
- 백필 응답 델타화 (API 응답 구조 변경 → 다른 세션의 REST 작업과 충돌).
- 폴러 수요 감축, promote_today 이벤트루프 동결, quotes 마이크로캐시 (별도 패키지).
- WS 전환 (`live-kis-ws-design` 워크트리).
- **항목 2의 백엔드 3~5초 숫자 개선** — 이 렌더 수정은 그 숫자를 건드리지 않는다.
- **항목 3의 KIS/토큰 절약** — 백엔드는 `is_disconnected`를 체크하지 않아(`api.py`에 부재 확인) 클라 abort에도 KIS 루프를 끝까지 돈다. 프론트 abort는 브라우저 fetch와 react-query 커밋만 막는다.
- **항목 4의 렌더 개선 주장** — react-query v5 기본 structural sharing이 동일 응답의 `past.data` 참조를 보존하면 `useLiveBundle`의 `useMemo`(`:150`, dep=`past.data`)가 재실행되지 않으므로 장외 재렌더는 이미 dedup된다. 항목 4의 이득은 네트워크/KIS에 한정.

## Design

### 항목 2 — projectCandle 핫패스 이진화 + 융합

두 하위 변경으로 나눈다. **2a가 핵심(필수)**, 2b는 추가 절감.

#### 2a. `sessionPhaseAt` 선형 → 이진 (등가 보존)

현재 (`sessionTime.ts:87`): 세그먼트를 앞에서부터 선형 순회하며 owning 세그먼트를 찾는다.

```
for (i): preOpenStart = seg.open - PRE_OPEN_WINDOW
  if realMs < preOpenStart → gap
  if realMs <= seg.close   → classifyWithinSegment(seg, realMs)
→ post-axis
```

세그먼트는 `sessionOpenMs` 오름차순·비중첩이므로 owning 세그먼트는 이진 탐색으로 찾을 수 있다. `preOpenStart ≤ realMs` ⟺ `open ≤ realMs + PRE_OPEN_WINDOW_LENGTH_MS`이므로 `sessionOpenMs` 키 하한(lower-bound) 탐색으로 후보 idx를 얻는다:

```
idx = lowerBoundByOpen(segments, realMs + PRE_OPEN_WINDOW_LENGTH_MS)
  idx < 0 (후보 없음)          → 'pre-axis'
  realMs <= segments[idx].close → classifyWithinSegment(segments[idx], realMs)
  else (realMs > close):
    idx == last               → 'post-axis'
    else                      → 'gap'   // realMs < segments[idx+1].preOpenStart 보장
```

- `lowerBoundByOpen`은 `sessionTime.ts` 내부의 private 헬퍼로 추가한다 (`virtualAxis.findByReal`를 호출하지 않음 — 도메인 레이어가 축 레이어를 역참조하지 않도록).
- `classifyWithinSegment`(O(1))는 무변경.
- **등가성**: 선형 버전과 모든 `realMs`에서 동일 phase를 반환해야 한다. pre-open/gap/auction/half-day 경계를 포함한 랜덤 프로퍼티 테스트로 증명(아래 Testing).

이 변경만으로 `contains`·`inClosingAuctionWindow`의 캔들당 비용이 O(segments) → O(log segments)가 된다.

#### 2b. projectCandle의 캔들당 조회 융합 (3회 → 1회)

현재 `candle.ts:26-43`: 캔들마다 `axis.contains` + `axis.inClosingAuctionWindow` + `axis.toVirtual` = 세 번의 독립 조회(2a 후엔 이진 2회 + 이진 1회).

`virtualAxis`에 단일 메서드를 추가해 한 번의 하한 탐색으로 셋을 도출한다:

```ts
// 반환: 이 캔들이 화면에 그려지는가(contained), 종가단일가 색인가(inAuction),
//       가상축 좌표(virtual). 단 한 번의 segment 조회로 계산.
classifyAndProject(realMs): { contained: boolean; inAuction: boolean; virtual: number }
```

`projectCandle`은 `filter`+`map` 2-패스를 단일 패스로 융합한다:

```ts
const out: CandlestickData<Time>[] = [];
for (const c of bundle.candles) {
  const { contained, inAuction, virtual } = axis.classifyAndProject(c.ts_ms);
  if (!contained) continue;
  const color = inAuction ? muted : c.close >= c.open ? up : down;
  out.push({ time: (virtual / 1000) as UTCTimestamp, open: c.open, close: c.close,
             high: c.high, low: c.low, color, borderColor: color, wickColor: color });
}
return out;
```

- **등가성 주의**: `classifyAndProject`는 *그려지는 캔들*(contained=true)에 대해 기존 3-콜 경로와 **동일한 (contained, inAuction, virtual)**을 내야 한다. 버려지는 캔들(pre-open/gap/pre-axis/post-axis)은 출력에서 빠지므로 virtual 값이 무의미하다. 프로퍼티 테스트는 *kept 캔들의 출력 동등성*을 검증한다.
- 다른 projector(line/area 등)는 이 스펙 범위 밖 — `axis.contains`/`toVirtual` 공개 API는 그대로 유지하고 `classifyAndProject`만 추가한다(기존 호출자 무영향).

### 항목 3 — react-query `signal`로 in-flight 취소

`apiCall(path, init?)`은 이미 `init`을 `fetch(url, init)`에 전달한다(`client.ts:62`). queryFn이 컨텍스트의 `signal`을 받아 넘기기만 하면 된다:

```ts
queryFn: ({ signal }) =>
  apiCall<LivePastCandlesResponse>(
    `/api/live/past-candles?code=${code}&from=${from}&to=${to}`,
    { signal },
  ),
```

- 같은 패턴을 **형제 쿼리 전부**에 적용: `range.ts`, `livePastDailyCandles.ts`, `livePastInvestorNet.ts`. 일관성 유지.
- react-query는 쿼리 키 변경·언마운트 시 이전 쿼리의 AbortController를 자동 abort한다. abort된 fetch는 `AbortError`로 거부되지만 react-query가 이를 **취소**로 처리 → 에러 상태 아님, 전역 `retry:1` 미적용.

### 항목 4 — 60초 리페치를 장중에만 게이트

```ts
refetchInterval: isKrxRegularSessionNow() ? 60_000 : false,
```

- `isKrxRegularSessionNow()`: 현재 KST 시각이 정규장 `[09:00, 15:30]` + 평일인지 판별하는 **프론트 전용** 헬퍼. 기존 `liveDateTime.ts`의 세션 시각 헬퍼로 구성.
- `staleTime: 60_000`은 유지(포커스 복귀·리마운트 시 즉시 재페치 억제). `queryKey`/`placeholderData` 무변경.
- 같은 게이트를 60초 리페치를 쓰는 형제 쿼리에 일관 적용.
- **Caveat (의도적 수용)**: 시각+요일만 보므로 **공휴일을 인식하지 않는다** — 평일 공휴일 낮엔 계속 폴링한다. 휴일 게이팅은 백엔드 캘린더의 책임이며 이 프론트 헬퍼의 범위 밖이다.

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| 2a 등가성 (프로퍼티) | 무작위 세그먼트 셋(정상·half-day 혼합) + 무작위 realMs 10⁴개. 경계값(preOpenStart, open, close-auction, close, gap 중앙) 명시 포함 | 이진 `sessionPhaseAt` == 선형 레퍼런스 구현, **모든 입력에서** |
| 2a 빈 세그먼트 | `segments=[]` | `'pre-axis'` |
| 2a 단일 세그먼트 경계 | realMs = open-PRE_OPEN ± 1, close ± 1 | pre-axis/pre-open/auction/post-axis 정확 분류 |
| 2b kept-캔들 출력 동등성 (프로퍼티) | 무작위 캔들·축. 기존 3-콜 경로 vs `classifyAndProject` 단일 패스 | contained=true 캔들의 `{time, color}` 출력 동일, 순서 동일 |
| 2b 버려지는 캔들 | pre-open/gap 타임스탬프 캔들 | 두 경로 모두 출력에서 제외 |
| 3 in-flight 취소 | 쿼리 키 A로 fetch 시작 → 도착 전 키 B로 변경 | A의 `signal.aborted===true`, A 응답으로 setData 안 됨 |
| 3 취소는 에러 아님 | abort 발생 | 쿼리 에러 상태 아님, retry 미발생 |
| 4 장중 게이트 | 시계 mock = 평일 10:00 KST | `refetchInterval === 60_000` |
| 4 장외 게이트 | 시계 mock = 평일 18:00 KST / 토요일 10:00 | `refetchInterval === false` |

**Invariant 회귀 테스트**: Phase classification fidelity → 2a 등가성 프로퍼티 테스트가 곧 회귀 테스트. Virtual coordinate mapping → 2b kept-캔들 출력 동등성이 `virtual` 값 보존을 검증.

### Manual verification

- **항목 2 측정 (필수)**: `/live`에서 250일 깊이까지 스크롤백 후 projector+setData 둘레에 `performance.now()`를 둘러 **수정 전후 커밋 시간을 ms로 측정**·기록. 렌더를 벽시계로 측정한 적이 없으므로 이 측정이 win의 유일한 증거다. 얕은 깊이(40일)에서는 차이가 sub-ms로 무시 가능함도 함께 확인.
- **항목 3**: `/browse`로 `/live`에서 빠르게 좌측 연속 드래그 → `network` 탭에서 이전 `past-candles` 요청이 `(canceled)`로 끊기는지, 콘솔 에러 없는지 확인.
- **항목 4**: 장외 시간에 `/live` 열어두고 `network`에서 60초 후 `past-candles`/`range`/`daily`/`investor-net` 재요청이 **없음**을 확인. 장중(또는 시계 강제)엔 재요청 발생 확인.

## Risks / Open questions

- **2a/2b 등가성이 최대 리스크**: phase 분류는 MA pre-open 오염·half-day auction 비활성 등 과거 버그의 진원지다(`sessionTime.ts` 헤더 주석). 이진화는 *동작을 1비트도 바꾸지 않아야* 하며, 프로퍼티 테스트가 통과하기 전엔 머지 불가.
- **항목 2 효과의 실재성**: 깊은 스크롤 jank는 분석상 ~22M 비교로 식별됐으나 **벽시계 ms는 미측정**이다. 측정 결과 커밋 시간 지배 요인이 projector가 아니라 lwc 내부 setData였다면, 항목 2의 체감 이득은 측정값만큼만 주장한다(과대 주장 금지).
- **항목 4 structural-sharing 가정**: 장외 재렌더가 이미 dedup된다는 근거는 react-query v5 기본 `structuralSharing:true` + 백엔드의 장외 응답 바이트 동일성이다. 만약 백엔드가 매 응답에 변동 필드(타임스탬프 등)를 넣으면 참조가 바뀌어 장외에도 재렌더가 돌 수 있다 — 그 경우 항목 4는 렌더까지 절감하게 되어 *이득이 더 큼*(주장은 보수적으로 유지).

## Out of Scope (Backlog)

- 점진 렌더(받은 날짜부터 즉시 그리기) — WS 전환 후 어울림.
- 백필 진행 표시 UI("과거 데이터 불러오는 중…") — 구조 무변경 체감 개선.
- 항목 4의 장중 60초 리페치 자체 제거 — WS가 오늘 봉을 공급하게 되면 불필요(다른 세션 의존).
