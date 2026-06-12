# 당일 매도 최대벽 (Day Ask Peak Wall) 수평선 지표 — Design

> 용어: 신호 = **당일 매도 최대벽(Day Ask Peak)**. CONTEXT.md 등재. 백엔드 타입·필드·프론트 식별자
> 전부 `ask_peak` / `askPeak` 네이밍.
> _Avoid_: "매도총잔량(tot_ask)"(10단계 **합계** = Quote Totals; 이건 **단일 단계** 최대), "총잔량 급증"
> (그건 합계의 당일 peak 초과 이벤트), "오른쪽 벽/Right Wall"(그건 viewport pan 클램프 — 전혀 다른 realm).

**Date**: 2026-06-13
**Status**: Draft
**Scope**: `hoga/tables/snapshots.py`(신규 집계 `query_day_ask_peak` — 기존 `deep_book_sql` 재활용), `hoga/api/bundle.py`(번들 코디네이터 — `ask_peak` 필드 배선, 오늘 slice만), `hoga/api/models.py`(`AskPeak` 응답 타입), `frontend/src/api/types.ts`(`RangeBundle.ask_peak`), `frontend/src/live/LiveAskPeakLine.tsx`(신규 렌더 — 멍청한 컴포넌트), `frontend/src/live/computeDayAskPeak.ts`(신규 순수 fold — 기존 `isContinuousBook` 재활용), `frontend/src/live/useDayAskPeak.ts`(신규 상태 ratchet 훅 — LivePage에서 1회), `frontend/src/live/LivePage.tsx`·`LiveWorkarea.tsx`·`LiveChartRoot.tsx`(`dayAskPeak` prop 배선 + 마운트), `frontend/src/util/formatQtyKo.ts`(신규 만/억 포맷터), `frontend/src/live/indicators/IndicatorPanel.tsx`(사이드메뉴 항목+상세 pane 배선), `frontend/src/live/indicators/AskPeakConfig.tsx`(신규 상세 설정 pane — `MAStylePicker` 재활용), `frontend/src/live/indicators/MAStylePicker.tsx`(aria-label 일반화 — 선택적 `label` prop, 기본 'MA'), `frontend/src/state/livePage.ts`·`liveIndicatorsPersistence.ts`(토글·색·두께 상태·영속)

## Problem

사용자(트레이더) 표현 그대로:

> "당일 기준으로 매도 10호가 중에 가장 큰 물량이 걸렸던 가격과, 그 물량을 표시하고 싶어.
> 캔들 차트에 수평선으로 보이게. 보조지표 ui에 사이드메뉴 추가해서 체크박스로 on off 하도록 해줘."

현재 `/live`는 매도 10호가의 **현재** 잔량을 호가 패널에 표시할 뿐, "오늘 하루 중 어느 순간엔가
단일 매도 호가단계에 **가장 크게 걸렸던 물량**과 그 가격"을 캔들 차트 위에 남겨두는 수단이 없다.
이 값(= 당일 sell-side 유동성 高水位, "최대 매도벽")은 트레이더가 저항/공급 밀집 가격을
가늠하는 데 쓰이는데, 사람이 초당 수 틱씩 흐르는 10호가를 종일 눈으로 좇아 최대치를 기억하는 것은
불가능하다.

### 해석 (확정)

- "가장 큰 물량이 걸렸던" = **당일 중 어느 순간에든** 매도 10호가의 *단일 단계*에 관측된
  **최대 단일 qty**와 그때의 가격. 과거형 "걸렸던"·"당일 기준" 두 어휘 모두 현재 스냅샷이 아니라
  **하루 누적 최댓값(high-water mark)** 을 가리킨다.
- **연속거래 호가창만 집계.** 마감 동시호가(15:20~15:30)·장중 VI 단일가 구간은 호가창이 3-레벨로
  붕괴하며 잔량이 **누적**(Single-Price Book Signature, CONTEXT)되어 "실제 매도벽"이 아닌 아티팩트다 —
  기존 총잔량·호가비·체결강도가 `auctionWindowMask`로 숨기는 것과 동일 이유로 **정의상 배제**한다
  (ADR-0029/0062). 구조적 판정(레벨3 너머 깊이; 백엔드 `deep_book_sql`·클라 `isContinuousBook` **공유 정의**)
  사용, 시계 불필요.
- 신기록 갱신 시 수평선이 그 가격으로 **이동(ratchet)**. 동률이면 **가장 먼저** 그 물량에
  도달한 시점을 채택.
- **매도(ask) 단독.** 매수(bid) 대칭 버전은 Non-Goal(아래).

## Invariants

이 spec이 추가하는 분기가 **보존해야 하는** 기존 시스템 속성:

- **ADR-0038 hot-path 순수성**: tick 경로 모듈(`buffer`·`live_session`·`stream` 등)은
  `pyarrow`/`polars`를 import하지 않는다. 근거: [hoga/live/buffer.py](../../../hoga/live/buffer.py),
  `tests/test_adr_invariants.py`.
- **ADR-0001 번들 코디네이터 분리**: snapshots 스키마 지식(per-level ask/bid 컬럼, bucketing SQL)은
  `snapshots_tbl`에 살고 `bundle.py`는 조립만 한다. 근거: [hoga/api/bundle.py:173-180](../../../hoga/api/bundle.py).
- **캔들 시리즈 옵션 불변(전역 priceLineVisible/lastValueVisible=false)**: 오버레이는 캔들 시리즈에
  price line을 *추가*할 뿐 시리즈 옵션을 건드리지 않는다. 근거:
  [frontend/src/live/LiveCurrentPriceLine.tsx](../../../frontend/src/live/LiveCurrentPriceLine.tsx).
- **거래일 self-reset(KST 자정)**: 당일 누적 상태는 KST 거래일 경계에서 0으로 리셋된다(급증 마커의
  `tradingDayOf`와 동일 규칙). 근거: [frontend/src/chart/surge/detectSurges.ts:25-26](../../../frontend/src/chart/surge/detectSurges.ts).
- **단일가 구간 표시 억제(ADR-0029/0062)**: 호가 보조지표는 마감 동시호가·VI 단일가 누적을
  신호에서 제외한다(구조적 판정 `_ASK_DEEP_SUM`, 시계 아님). 근거:
  [hoga/tables/snapshots.py:276-282](../../../hoga/tables/snapshots.py), CONTEXT "Single-Price Book Signature".
- **지표 토글 opt-in 등록 패턴**: livePage 지표 토글은 `…Enabled` boolean + `set…Enabled` + `PersistedIndicators`
  검증의 3-지점 등록을 따른다(순매수량·거래량). 근거: [frontend/src/state/livePage.ts](../../../frontend/src/state/livePage.ts).
- **단일 `useLiveSeries` 구독(SSE 1연결)**: 활성 종목당 `useLiveSeries`는 **한 번만** 호출된다 — 두 번 부르면
  SSE 연결·버퍼가 둘이 된다(HMR seam 버그). 근거: [frontend/src/live/LivePage.tsx:90-93](../../../frontend/src/live/LivePage.tsx).

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| ADR-0038 hot-path 순수성 | preserves | 신규 parquet 집계는 **cold path**(번들 빌드)에만 둔다. tick 경로 미접촉. |
| ADR-0001 번들 코디네이터 분리 | preserves | `query_day_ask_peak`는 `snapshots.py`에, `bundle.py`는 호출·배선만. |
| 캔들 시리즈 옵션 불변 | preserves | `LiveCurrentPriceLine`과 동일하게 price line만 추가, 옵션 미변경. |
| 거래일 self-reset | preserves | 클라 ratchet이 KST 거래일 변경 시 seed로 재초기화. |
| 단일가 구간 표시 억제 | preserves | 백엔드 `deep_book_sql` 필터 + 클라 `isContinuousBook` 스킵(동일 정의). |
| 지표 토글 opt-in 등록 패턴 | preserves | `askPeakEnabled` 3-지점 등록, 기본 false. |
| 단일 `useLiveSeries` 구독 | preserves | ratchet은 LivePage의 기존 `live.ob` 재사용(`useDayAskPeak`), 신규 구독 없음. |

**새로 도입하는 invariant**

- **한 거래일 = 매도 최대벽 선 1개**: 한 거래일에 대해 `ask_peak`는 단일 `{price, qty, t_ms}` 또는
  `null`이며, 차트에는 수평선 하나만 그려진다. /live는 오늘(당일) 분봉 모드 단일 거래일이 대상이며,
  과거로 스크롤해 여러 날이 보여도 선은 **오늘** 기준 한 개(과거 구간에선 화면 밖).

## Goals

- 당일 매도 10호가 중 단일 단계 최대 물량의 **가격**(Y축 가격태그)과 **물량**(선 라벨, 예: `12.3만주`)을
  캔들 차트에 수평 실선으로 표시.
- **오전 포함 당일 전체** 정확성: 오후에 페이지를 열거나 새로고침해도 09:00부터의 최대벽을 반영.
- **실시간 갱신**: 장중 신기록 매도벽이 뜨면 즉시 선이 그 가격으로 이동하고 라벨 물량이 갱신.
- **선 색상·두께를 지표 설정 pane에서 조절** — 이평선 설정의 `MAStylePicker`(32색 grid + 4두께 카드) 재활용.
  기본 `#1D4ED8`(파랑)·2px.
- 지표 모달(`IndicatorPanel`) 사이드메뉴 체크박스로 on/off, 기본 off(opt-in).

## Non-Goals

- **매수 최대벽(bid)** 대칭 버전 — 요청은 매도 단독. 코드는 side 일반화 여지를 남기되 v1은 ask만.
- **선 라벨에 시각 표기** — v1은 물량만(`12.3만주`). 발생 시각(`… 10:32`)은 Backlog.
- **선 스타일(실선/점선) 변경** — `MAStylePicker`는 색·두께만 다룬다. 실선 고정.
- **백엔드 감지·알림·이벤트 로그** — 이건 표시 전용 지표. 급증 마커류 알림 피드와 무관.
- **차트 범위가 다중 거래일일 때 날짜별 다중 선** — 앵커일 한 선만(위 invariant). 다중 선은 Backlog.
- **단일가(동시호가·VI) 누적을 포함하는 변형** — 연속거래만 집계로 확정(위 해석). `auctionWindowMask`
  토글과 무관하게 항상 연속거래만(토글은 호가비/총합 표시 전용; 이 지표의 정의에 가둔다).

## Design

### 데이터 가용성 (사실)

| 경로 | per-level 매도 단계 | 범위 |
|------|------|------|
| `snapshots.parquet` (`ask_p1..10`, `ask_q1..10`) | 있음 | **하루 전체**(promote 완료분) |
| 클라 `LiveSnapshotBuffer` (ObSnapshot `ask[]`) | 있음 | **최근 15분**(time-based eviction) |
| 차트 번들 `quote_ratio` | 합계(`ask_total`)만 | 하루 전체 |

핵심: per-level 하루 전체 데이터는 **parquet에만** 있고 실시간 버퍼는 15분만 보존
(`DEFAULT_RETENTION_MS = 900_000`, [buffer.py](../../../hoga/live/buffer.py)). 따라서 "당일 전체"는
**백엔드 seed + 클라 ratchet** 합성으로 만든다.

```
[09:00 ───────────────── (마지막 promote, ~수분 전) ───── 15분 버퍼 ───── now]
 └────────────── 백엔드 seed (parquet) ──────────────┘
                                  └────── 클라 ObSnapshot 버퍼 ──────┘   ← 겹침(갭 없음)
```

보존 15분 > 2×promote 불변식(spec §8 봉합 사이징, buffer.py 주석)이라 seed의 우측 끝과 버퍼의
좌측 끝이 **겹쳐** 그 사이 기록도 누락되지 않는다.

### 백엔드 — `query_day_ask_peak` (cold path)

`hoga/tables/snapshots.py`에 신규 집계:

```
query_day_ask_peak(con, *, path) -> AskPeakRow | None   # DuckDB (read_parquet)
  # 당일 snapshots 1패스. 연속거래 호가창만(WITH s AS (… WHERE deep_book_sql)) 대상.
  # 10개 (ask_p{i}, ask_q{i}) 를 UNION ALL → qty>0 → 전역 최대. 동률이면 가장 이른 시각.
  #   intra = hhmmssms_to_intra_ms_sql("ts_ms")   # ★ ts_ms는 HHMMSSmmm 인코딩 — 선형 디코드 필수
  #   SELECT price, qty, intra_ms FROM (UNION ALL …) ORDER BY qty DESC, intra_ms ASC LIMIT 1
  # 반환: AskPeakRow{price, qty, intra_ms} (intra_ms = ms-from-midnight) 또는 None.
```

> **★ 시각 인코딩 함정**: snapshots의 `ts_ms`는 epoch-ms가 아니라 **HHMMSSmmm**이다(분/시 경계 갭).
> quote_ratio처럼 `hhmmssms_to_intra_ms_sql`로 선형 ms-from-midnight으로 디코드해 정렬·반환하고,
> 번들에서 `ms_from_midnight_to_unix_ms(date, intra_ms)`로 unix-ms `t_ms` 변환. raw ts_ms 직접 사용 금지.

- **연속거래 필터 = 기존 술어 재활용(단일진실원)**: `query_bucket_representative`/`query_bucketed_ratio`가 쓰는
  `deep_book_sql = ((_ASK_DEEP_SUM) > 0 OR (_BID_DEEP_SUM) > 0)`(snapshots.py:350, ADR-0062)를 **그대로** 쓴다.
  새 술어를 만들지 않는다 — 클라 `isContinuousBook`(양측 `slice(3).some(qty>0)`)과 **정의가 글자 그대로 일치**
  해야 seed(백엔드)와 ratchet(클라)가 같은 봉을 배제한다(prior learning: 같은 술어를 모든 곳에).
- ADR-0001: 스키마 지식(컬럼 UNPIVOT·DEEP_SUM)은 여기 `snapshots_tbl`에 산다.
- ADR-0038: DuckDB/parquet 의존은 cold path(번들 빌드)뿐. tick 경로 미접촉.

`hoga/api/models.py`에 응답 타입:

```
class AskPeak: price: int; qty: int; t_ms: int
```

### 백엔드 — 번들 배선 (`bundle.py`)

- `build_range_bundle`에 `ask_peak: AskPeak | None` 필드 추가. 번들이 이미 같은
  `snapshots.parquet`를 열어 `quote_ratio`를 만들므로([bundle.py:181](../../../hoga/api/bundle.py))
  추가 비용은 집계 1패스뿐.
- **범위 = 오늘(당일) 전용**: `/replay`는 제거됨(2026-05-29, CONTEXT). 과거일을 앵커로 보는 뷰가 없으므로
  `ask_peak`은 **오늘 날짜 slice의 snapshots.parquet 1개**에서만 계산한다(범위가 과거로 깊어도 오늘 파일만 →
  스크롤 깊이와 무관, 비용 일정). D/W/M(일봉)은 range 번들 자체가 없어 `ask_peak` 부재 → 선 미표시.
- **캐시 불필요**: 오늘 파일 1패스(~2.3k행 × 10단계 UNPIVOT)는 DuckDB에서 미미하고, range가 5분마다
  재fetch될 때 재계산되어 **seed 자동 갱신**을 겸한다(값 단조 증가라 안전). `past_indicators_cache`는
  과거일 소비처가 없어 **이번 범위에서 제외**(과거일 지원 시 추가는 trivial).

### 프론트 — 순수함수 ratchet (`computeDayAskPeak.ts`)

stateless max가 아니라 **단조 ratchet**이어야 한다 — 페이지 연 뒤 신기록이 떴다가 15분 후 버퍼에서
evict되면 stateless 방식은 그 기록을 잊는다(아직 promote 전이라 seed에도 없을 수 있음). 급증 마커
`runningMax`와 동형:

```
type AskPeak = { price: number; qty: number; tMs: number };
type RatchetState = { peak: AskPeak | null; tradingDay: number };

foldAskPeak(prev: RatchetState, seed: AskPeak | null,
            ob: ObSnapshot, tMs: number): RatchetState
  // 0) 연속거래 게이트: isContinuousBook(ob) === false(동시호가/VI 붕괴)면 이 틱 스킵.
  //    ★ 기존 isContinuousBook(bucketHogaSeries.ts) 재활용 — 재구현 금지.
  //    백엔드 deep_book_sql과 글자 그대로 같은 정의(양측 slice(3).some(qty>0)).
  // 1) tradingDayOf(tMs) !== prev.tradingDay → 리셋(peak=null), seed 재반영
  // 2) 후보 = [seed, ...ob.asks(price,qty@tMs)] 중 qty 최대가 prev.peak.qty 초과면 교체
  //    동률은 교체 안 함(= 먼저 도달한 것 유지). ob.asks 없으면(totals-only 프레임) 후보=[seed].
  // 단조: peak.qty 는 거래일 내 감소하지 않는다.
```

- **데이터 소스 = 기존 `live.ob`(추가 SSE 구독 금지!)**: `useLiveSeries(code)`는 SSE 연결+버퍼를 연다 —
  **두 번 부르면 연결이 2개**(LivePage.tsx:90-93 주석의 HMR 버그 이력). 따라서 ratchet은 `live`가 이미 있는
  **LivePage에서** 전용 훅 `useDayAskPeak(live.ob, seed, code)`로 **1회** 계산하고, 결과 `dayAskPeak`를 prop으로
  내려보낸다(LivePage → LiveWorkarea → LiveChartRoot → LiveAskPeakLine). `LiveAskPeakLine`은 `useLiveSeries`를
  **직접 부르지 않는다**.
- **seed**: `seed = (chartBundle ?? bundle)?.ask_peak`(백엔드 당일 집계). `RangeBundle`에 ob 배열은 없다
  (`bundle.snapshots`는 존재하지 않음 — 최초 스펙 가정 오류, 교정). ob 레벨은 raw 엔트리의 `asks`(복수형)를
  `latestOrderbookSnapshot`/`padLevels` 방식으로 읽는다.
- **`useDayAskPeak` 훅(상태)**: useRef 래칫 보유. 마운트 시 `seed` + `live.ob` 현재 버퍼(≤15분) 1회 fold →
  첫 프레임부터 정확. 이후 **증분**(마지막 fold한 `tMs` ref 기억, 그보다 새 엔트리만 fold; 틱당 O(10), 이력 깊이
  무관 — Split Cache 철학). `code` 변경 시 ref 리셋·재시드(remount 비의존). 반환 `dayAskPeak: AskPeak | null`.

### 프론트 — 렌더 (`LiveAskPeakLine.tsx`) — 멍청한 컴포넌트

형제 `LiveCurrentPriceLine.tsx` 패턴 복제. **props = `{ paneSeries, peak: AskPeak|null }`**(ratchet은 안 함 —
peak를 받기만). 색·두께·on/off는 livePage 스토어를 직접 읽는다(prop drilling 불필요 — 스토어니까).

- `paneSeries.get('candle')`에 native `createPriceLine` 하나(lwc는 시리즈당 다중 price line 허용 —
  현재가선과 공존, 충돌 없음).
  - `price` = `peak.price`, `axisLabelVisible` = 가격 Y축 태그(가격 포맷은 차트 priceFormat 따름).
  - `title` = `formatQtyKo(peak.qty)`(`12.3만주`/`1.2억주` 약식 — 신규 순수함수, 기존 만/억 포맷터 없음).
  - `color`·`lineWidth` = livePage 스토어(`askPeakColor`/`askPeakLineWidth`, **사용자 설정**).
    `lineStyle` = **실선 고정**(LineStyle.Solid; 현재가선 점선과 구분). 기본 `#1D4ED8`(파랑, MA 팔레트 내)·2px.
  - `askPeakEnabled === false` 또는 `peak === null`(데이터 없음·D/W/M·장초반 parquet 부재) →
    `lineVisible`/`axisLabelVisible` = false.
- 시리즈 핸들당 1회 생성 + update effect로 price/title/색/두께 갱신(전환 플리커 없음).
- 마운트: `LiveChartRoot.tsx:736`의 `LiveCurrentPriceLine` 형제. `paneSeries` + `dayAskPeak` prop을 받는다
  (`dayAskPeak`는 LivePage→LiveWorkarea→LiveChartRoot 경유 전달; ratchet 계산은 LivePage의 `useDayAskPeak`).

### 프론트 — UI (`IndicatorPanel` 사이드메뉴 + 상세 설정 pane)

이동평균선과 동형: 좌측 체크박스(master on/off) + 우측 상세 설정 pane.

- `CATEGORIES`에 `{ id: 'ask-peak', label: '당일 매도 최대벽', active: true }` 추가.
- `checkedFor`/`toggleFor`에 `'ask-peak'` case 추가(master on/off → `askPeakEnabled`).
- **상세 pane** 신규 `AskPeakConfig.tsx`(형제: `MovingAverageConfig`): 제목/설명 + `MAStylePicker`
  하나를 `askPeakColor`/`askPeakLineWidth`에 바인딩(색·두께 선택). `IndicatorPanel`에
  `selected === 'ask-peak' && <AskPeakConfig />` 한 줄.
- **`MAStylePicker` 재활용**: prop 인터페이스(`color`/`lineWidth`/`onChange`)는 이미 범용. aria-label만
  "MA" 문구가 박혀 있어 선택적 `label` prop(기본 'MA')으로 일반화 — 비파괴, MA 호출부 무변경.
- `livePage` 스토어 추가:
  - `askPeakEnabled: boolean` + `setAskPeakEnabled`.
  - `askPeakColor: string` + `askPeakLineWidth: 1|2|3|4` + `setAskPeakStyle(patch: {color?, lineWidth?})`
    (MAStylePicker onChange 시그니처와 일치).
  - `PersistedIndicators`에 3필드 추가(기본 **false / 파랑(MA 팔레트의 blue) / 2px**),
    `mergeLiveIndicatorPrefs`에서 기존 `HEX_COLOR`·`VALID_LINE_WIDTHS` 검증 재활용.

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| `query_day_ask_peak` 기본 | 여러 행, 명확한 단일 최대 단계 | 그 price·qty·t_ms 반환 |
| `query_day_ask_peak` 동률 | 같은 qty가 두 시각에 | 더 이른 t_ms 채택 |
| `query_day_ask_peak` 단일 행 | 1행 10단계 | 그 행 내 최대 단계 |
| `query_day_ask_peak` 빈 데이터 | 0행 | `None` |
| `query_day_ask_peak` 단일가 배제 | 동시호가/VI 행(ask_q4..10=0)의 누적 qty가 연속행보다 큼 | 연속행 최대 반환(누적 무시) |
| `foldAskPeak` 붕괴호가창 스킵 | `isContinuousBook=false`인 틱(붕괴 호가창) | 이 틱 무시(peak 불변) |
| `foldAskPeak` seed-only | 버퍼 빈·seed 있음 | seed 그대로 |
| `foldAskPeak` 버퍼 우세 | seed < 버퍼 신기록 | 버퍼 값으로 교체 |
| `foldAskPeak` 단조 | 큰 값 뒤 작은 값 | 큰 값 유지(감소 안 함) |
| `foldAskPeak` 동률 비교체 | 같은 qty 다른 가격 | 먼저 것 유지 |
| `foldAskPeak` 거래일 경계 | tMs가 다음 KST일 | 리셋 후 재시드 |
| `foldAskPeak` 증분 | 이미 fold한 tMs 이하 재공급 | 중복 반영 안 함(멱등) |
| **연속거래 술어 일치(회귀)** | 공유 fixture(붕괴 3-레벨 / 완전 호가창) | `isContinuousBook`(클라)와 `deep_book_sql`(백엔드 DuckDB)이 **같은 판정** |
| ratchet code 전환 리셋 | code 변경 effect | ratchet ref 리셋·새 seed 재시드(remount 무관) |
| `useDayAskPeak` 단일 구독 | LivePage가 `live.ob`를 prop으로 공급 | 훅이 `useLiveSeries`를 호출하지 않음(2차 SSE 없음) |
| ask_peak 부재(D/W/M·장초반) | `bundle.ask_peak == null` | 선·태그 미표시(에러 없음) |
| seed 부재 라이브 | 오늘 parquet 없음 + `live.ob` 신기록 | seed=None이라도 ratchet이 live로 표시 |
| `formatQtyKo` | 9_999 / 123_456 / 12_345_678 | `9,999`/`12.3만`/`1234.6만`(또는 억 규칙) |
| IndicatorPanel 토글 | 체크박스 클릭 | `askPeakEnabled` 토글 |
| AskPeakConfig 스타일 | MAStylePicker로 색/두께 변경 | `setAskPeakStyle` 호출·스토어 반영 |
| MAStylePicker label prop | `label="매도벽"` | aria "매도벽 스타일 선택"; **기본 'MA'면 기존 테스트 불변** |
| 렌더 스타일 반영 | 스토어 색/두께 변경 | price line `color`/`lineWidth` 갱신 |
| persistence 머지 | 누락/이상 enabled·color·width | 기본 false/#1D4ED8/2px 폴백(HEX·width 검증) |

**Invariant 회귀**: (a) ADR-0038 — `query_day_ask_peak`가 hot-path 모듈에 import되지 않음을
`test_adr_invariants`로 확인. (b) 거래일 self-reset — `foldAskPeak` 경계 테스트. (c) 단조성 —
fold 단조 테스트. (d) **단일가 배제 일치** — 클라/백엔드 연속거래 술어가 같은 fixture에서 같은 판정(위 표).

### Manual verification

- `/live` 장중: 매도 최대벽 선이 호가창의 최대 매도단계와 일치하는 가격에 그려지는지, 신기록 시 이동·라벨 갱신.
- 오후 새로고침: 오전에 떴던 더 큰 매도벽이 유지되는지(seed 경로).
- 마감 동시호가(15:20~): 누적으로 선이 튀지 **않는지**(연속거래만 집계 검증).
- D/W/M 전환: 선 사라짐(range 번들 없음). 분봉 복귀 시 재표시.
- 토글 off → 선·태그 사라짐. on → 복귀.
- 설정 pane에서 색·두께 변경 → 선에 즉시 반영, 새로고침 후에도 유지(영속).

## Risks / Open questions

- **cadence 불일치(seed 10초 vs live 초당)**: 영속 parquet는 10초 Live Snapshot, `live.ob`는 초당 틱.
  세션 중 ratchet이 초-단위보다 미세한 transient 피크를 잡을 수 있고 리로드 시 10초 표본으로 수렴.
  실호가벽은 ≫10초 지속이라 차이는 미미 — **정의를 10초 Live Snapshot 기준으로 두고** 이 차이를 의도된 것으로
  문서화(버그 아님). 추가 코드 없음.
- **당일 매 빌드 재집계 비용**: 오늘 parquet 1패스(~2.3k행)뿐, DuckDB에서 미미. 종목 폭주 시에만 측정.

## Out of Scope (Backlog)

- 매수 최대벽(bid) 대칭 버전(side 일반화).
- 선 라벨에 발생 시각 표기.
- 날짜별 다중 선(멀티-데이 범위).
- 과거일(특정 날짜) 차트에서의 그날 매도 최대벽 표시 — 현재 그런 뷰 없음(`/replay` 제거됨); `query_day_ask_peak`가
  path 인자라 추가는 trivial하나 소비처 생길 때까지 보류.
- 동시호가 구간 마스킹 옵션.
