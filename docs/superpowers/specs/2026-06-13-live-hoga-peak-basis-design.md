# 호가 지표 분봉 대표값 — 종가(close) ↔ 고점(peak) 기준 옵션 — Design

> 용어:
> - **분봉 대표값(bar representative)**: 1분봉 하나가 갖는 단일 호가 지표값. 현재는 **종가(close)**
>   = 그 분 마지막 *연속거래* 스냅샷의 값. 이 spec이 **고점(peak)** = 그 분 내 최댓값 기준을 옵션으로 추가한다.
> - **고점(peak) 기준**: 분봉 내 모든 연속거래 스냅샷 중 최댓값. 캔들의 종가↔고가 관계와 같은 직관.
>   _Avoid_: "총잔량 급증(Quote Totals Surge)"(그건 당일 running peak 초과 *이벤트* 마커 — 별개 realm,
>   근거는 `detectSurges.ts` + 스펙 `2026-06-12-chongjanryang-breakout-live-marker-design.md`, **ADR 아님**),
>   "고저 극값(High/Low extreme)"(그건 가시범위 캔들 가격 라벨 — 또 다른 realm, `highLowLabelsEnabled`).
> - **호가비 부호 규약**(`util/imbalance.ts`): `quoteImbalance(bid,ask) = ask/bid−1`(ask≥bid) 또는
>   `−(bid/ask−1)`(bid>ask), 단 bid≤0 또는 ask≤0이면 0. **비제한적(unbounded), 양수=매도 우위(sell-heavy),
>   음수=매수 우위(buy-heavy).** ((bid−ask)/(bid+ask) 형태 **아님**.)
> - 코드 식별자 명명 제안(plan에서 확정): pref 토글 `quoteTotalsPeakBasis` / `ratioPeakBasis` /
>   `askPeakIntraMax`(셋째는 `…PeakPeak` 중복 회피).

**Date**: 2026-06-13
**Status**: Draft
**Scope**:
- 백엔드: `hoga/tables/snapshots.py`(`query_bucketed_ratio`에 버킷별 MAX 및 imbalance-극값 행 추출 추가, `query_day_ask_peak`에 틱-max 변종 추가), `hoga/api/models.py`(`QuoteRatioPoint`·`AskPeak` 필드 **가산**), `hoga/api/bundle.py`(증강 필드 배선; `build_ask_peak_slice`·QuoteRatioPoint 변환부)
- 프론트 타입/집계: `frontend/src/api/types.ts`(미러), `frontend/src/live/bucketHogaSeries.ts`(SSE 경로 고점 추적), `frontend/src/util/imbalance.ts`(프론트 극값 계산 재활용)
- 프론트 렌더/설정: `frontend/src/chart/projectors/quoteTotals.ts`·`ratio.ts`(렌더 스위치 + ctx 키), `frontend/src/state/chartPrefs.ts`(토글 3종 등록), `frontend/src/live/indicators/QuoteTotalsConfig.tsx`·`RatioConfig.tsx`·`AskPeakConfig.tsx`(설정 행)
- ask-peak 소비자(평탄-가산 마이그레이션 영향): `frontend/src/live/LiveAskPeakSegments.tsx`(렌더 — close/peak triple 선택), `frontend/src/live/computeDayAskPeak.ts`·`useDayAskPeaks.ts`(오늘 ratchet — 변경 최소)
- 자동/검증: `frontend/src/state/chartPrefsPersistence.ts`(CHART_TOGGLES 순회 자동 영속 — 추가 등록 불요, 확인용), `tests/unit/live/test_adr_invariants.py`(ADR-0038 회귀)

## Problem

사용자(트레이더) 표현 그대로:

> "사용자는 분봉 단위로 보니까 분봉의 마지막 데이터를 기준으로 하고 있는데, 예를 들어 1분봉으로 보고
> 있다고 하면, 1분 내에서 가장 큰 peak 가격이 있었더라도 종가 기준으로 peak를 계산하니까 그 부분이
> 조금 아쉬워. 종가 데이터 외에, peak 데이터로 변경할 수 있는 옵션이 있으면 좋겠어."

「지표」 모달 **호가 지표 그룹**의 상태형 지표(총잔량·호가비·당일 매도 최대벽)는 1분봉마다 "그 분 마지막
연속거래 스냅샷(≈종가)" 하나만 대표값으로 잡는다. 그래서 분봉 내 어느 순간 잔량/불균형/매도벽이 더 크게
치솟았어도 그 분이 평범하게 마감하면 화면엔 그 봉우리가 사라진다. 캔들은 고가(high)를 wick으로 남기는데
호가 지표는 그렇지 못해, 분봉 단위로 보는 사용자가 "그 분의 봉우리"를 놓친다.

### 적용 범위 (확정)

| 지표 | 현재 분봉 대표값 | peak 기준 의미 | 포함? |
|---|---|---|---|
| **총잔량(quote-totals)** | 종가 스냅샷의 매수/매도 총잔량 | 분봉 내 각 변(side) 최댓값(독립 시점 허용) | ✅ |
| **호가비(ratio)** | 종가 스냅샷 총잔량의 불균형(±) | 분봉 내 \|불균형\|이 최대였던 스냅샷값(부호 유지) | ✅ |
| **당일 매도 최대벽(ask-peak)** | 버킷 종가 스냅샷의 매도벽 중 당일 최댓값 | 버킷 내 전 연속스냅샷 틱-max로 대표값 교체 후 당일 최댓값 | ✅ |
| **체결강도(fill-strength)** | 그 분 체결량 **합산**(flow, 종가 아님) | — 이미 분봉 전체 합산이라 'peak' 개념이 적용되지 않음 | ❌ |

핵심 해석:

- **표시 방식 = 교체(replace) 토글.** peak ON이면 대표값이 종가→고점으로 *바뀐다*. 라인 개수·색은 불변
  (오버레이/밴드 아님). 사용자 표현 "변경할 수 있는 옵션"에 직접 대응.
- **호가비 고점은 총잔량 고점에서 유도 불가** — `imbalance(max bid, max ask) ≠ max imbalance over snapshots`.
  실제 수식(`ask/bid−1` 형태)으로도 부호가 뒤집힐 수 있다. 예 (한 분봉 안 두 스냅샷):
  - 스냅샷 A: bid=100, ask=2 → `−(100/2−1)` = **−49** (매수 우위, 매우 강함)
  - 스냅샷 B: bid=10, ask=300 → `300/10−1` = **+29** (매도 우위)
  - 분봉 내 \|불균형\| 극값 = A의 **−49**(매수 우위).
  - 그런데 max(bid)=100, max(ask)=300 조합 → `300/100−1` = **+2**(매도 우위) — **부호 반대!**
  → 호가비 고점은 **버킷팅 단계에서 스냅샷별로** 계산해 별도 필드로 실어야 한다. "최강 압력 순간(부호 유지)"
  정의 채택.
- **전 기간(과거 Parquet + 오늘 라이브)** 적용. 과거로 팬해도 일관(아래 ask-peak 오늘-토글 예외 참조).
- **연속거래 호가창만 집계.** 마감 동시호가·VI 단일가 구간은 종가 경로와 **동일하게** 배제(ADR-0029/0062).

## Invariants

이 spec이 건드리는 분기가 **현재 보존하고 있는** 속성:

- **Split Cache 등가(#74 1-min split)**: `/live` 호가 지표는 `projectXPoints(과거 고정 슬라이스) ++
  projectXPoints(오늘 슬라이스) === projectXPoints(전체)`. 유일한 cross-point 상태(maskOutgoingConnector의
  1-point lookback)가 거래일 경계를 넘지 않기에 성립. 근거:
  [pastCachedProjector.test.ts:48-87](../../../frontend/src/chart/projectors/pastCachedProjector.test.ts),
  [ratio.ts:64-72](../../../frontend/src/chart/projectors/ratio.ts),
  [auctionHide.ts:78-81](../../../frontend/src/chart/util/auctionHide.ts).
- **단일가 구간 표시 억제(ADR-0029/0062)**: 호가 지표는 마감 동시호가·VI 단일가 누적을 신호에서
  제외한다(구조적 판정, 시계 아님). 백엔드 `_DEEP_BOOK_SQL`(`snapshots.py:367` SSOT), 클라
  `isContinuousBook`/`lastContinuousMs` **공유 정의**. 근거:
  [snapshots.py:324-413](../../../hoga/tables/snapshots.py),
  [bucketHogaSeries.ts:35-94](../../../frontend/src/live/bucketHogaSeries.ts),
  [docs/adr/0062-structural-auction-boundary.md](../../adr/0062-structural-auction-boundary.md).
- **총잔량 급증 트리거 안정성**: `detectSurgeSide`는 당일 총잔량 **종가** 시퀀스의 running peak를 추적해
  근접(95%)·재무장(85%)으로 발사한다. 입력 시퀀스가 바뀌면 트리거가 틀어진다. **결정적 사실**: 감지기는
  필드명을 하드코딩한다 — `const FIELD = {ask:'ask_total', bid:'bid_total'}`. 근거:
  [detectSurges.ts:19,61](../../../frontend/src/chart/surge/detectSurges.ts). (ADR 없음; 설계 근거는 이 코드와
  스펙 `2026-06-12-chongjanryang-breakout-live-marker-design.md`.)
- **ADR-0038 hot-path 순수성**: tick 경로(`buffer`·`live_session`·`stream`)는 `pyarrow`/`polars`를
  import하지 않는다. parquet 집계는 cold-path. 근거:
  [tests/unit/live/test_adr_invariants.py](../../../tests/unit/live/test_adr_invariants.py).
- **ADR-0001 번들 코디네이터 분리**: snapshots 스키마 지식(per-level 컬럼·bucketing SQL)은
  `snapshots.py`에 살고 `bundle.py`는 조립만 한다. 근거:
  [bundle.py:47,435](../../../hoga/api/bundle.py).
- **행동 pref 등록 단일 SSOT 패턴**: 지표 행동 토글은 `chartPrefs.CHART_TOGGLES`에 **5필드 엔트리**
  (`{key, label, description, default, category}`) 1개로 등록하면 `ChartToggleKey` union·`ChartViewPrefs`·기본값
  맵·영속·UI 렌더가 전부 파생된다. `category:'indicator-modal'`이라야 「지표」 모달에 뜨고(없으면 ⚙️ 설정
  모달행). 근거: [chartPrefs.ts:12-75](../../../frontend/src/state/chartPrefs.ts)(예: `ratioOutlierFilterEnabled`
  20-26), [IndicatorPrefRows.tsx](../../../frontend/src/live/settings/IndicatorPrefRows.tsx),
  [chartPrefsPersistence.ts:12-14](../../../frontend/src/state/chartPrefsPersistence.ts)(CHART_TOGGLES 순회 자동 영속).
- **ask-peak 버킷 종가 대표(#96)**: `query_day_ask_peak`는 raw 틱 max가 아니라 **버킷 대표(마지막
  연속거래 스냅샷)** 의 매도벽에서 당일 최댓값을 찾는다 — "사용자가 분봉 호가창에서 실제로 보는 값"과
  일치시키려는 #96의 *의도적* 결정. 근거: [snapshots.py:466-525](../../../hoga/tables/snapshots.py)
  `query_day_ask_peak`(`rep` CTE rn=1), commit d2d7c69(#96).
- **ask-peak 마커 x-스냅(#97)**: peak 발생시점 점이 버킷 캔들 경계에 스냅된다(`snapPeakMsToCandle`). 근거:
  [LiveAskPeakSegments.tsx:14-57](../../../frontend/src/live/LiveAskPeakSegments.tsx), commit 6eedb49(#97).
- **거래일 self-reset(KST 자정)**: 당일 누적/ratchet 상태는 KST 거래일 경계에서 리셋. 근거:
  [tradingDay.ts:6-9](../../../frontend/src/util/tradingDay.ts) `tradingDayOf`,
  [computeDayAskPeak.ts](../../../frontend/src/live/computeDayAskPeak.ts).
- **ask-peak 오늘 ratchet = 전-스냅샷 running max(peak)**: 오늘 라이브 매도 최대벽은 모든 스냅샷의 매도
  단계 qty running max다 — close 변종을 라이브로 따로 추적하지 않는다. 근거:
  [computeDayAskPeak.ts:36-39](../../../frontend/src/live/computeDayAskPeak.ts) `foldAskPeak`.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| Split Cache 등가(#74) | **preserves** | 고점 필드는 종가 필드와 **함께 캐시**된다(같은 `QuoteRatioPoint`). 토글은 어느 필드를 그릴지 고르는 **순수 렌더 스위치** — 캐시 데이터·청크 분할 불변. mode= 쿼리 파라미터 도입 안 함(캐시 2배 회피). |
| 단일가 구간 표시 억제 | **preserves** | 고점 계산도 종가와 **동일한** 연속거래 필터(`is_pre`/`lastContinuousMs`) 안에서만. 동시호가 스냅샷은 고점 후보에서도 배제. |
| 총잔량 급증 트리거 안정성 | **preserves (사실상 공짜)** | `detectSurgeSide`가 `ask_total`/`bid_total` 필드명을 **하드코딩**하므로, 렌더 스위치를 `projectBidPoints`/`projectAskPoints`의 값 선택(`*_total`↔`*_peak`)에만 넣으면 감지기는 새 `*_peak` 필드를 건드리지 않는다. 별도 분리 리팩터 불요 — `FIELD` 맵에 peak를 추가하지 않는 것이 전부. |
| ADR-0038 hot-path 순수성 | **preserves** | 신규 집계는 cold-path(`query_*`)에만. tick 경로 미접촉. |
| ADR-0001 번들 코디네이터 분리 | **preserves** | 집계는 `snapshots.py`, `bundle.py`는 배선만. |
| 행동 pref 등록 SSOT 패턴 | **preserves** | 토글 3종을 `CHART_TOGGLES`에 5필드로 추가, `default:false`·`category:'indicator-modal'`. 영속 자동(추가 등록 불요). |
| ask-peak 버킷 종가 대표(#96) | **intentionally breaks (peak 모드 한정, opt-in)** | 아래 정당화 참조. |
| ask-peak 마커 x-스냅(#97) | **preserves (회귀 검증 필수)** | 고점 값으로도 점이 `snapPeakMsToCandle`로 버킷 캔들에 스냅 — peak 값 경로로 회귀 테스트. |
| 거래일 self-reset | **preserves** | 오늘 ratchet 근사는 기존 KST 리셋 그대로. |
| ask-peak 오늘 ratchet=running max | **preserves (토글 의미 제약)** | 오늘은 close 변종 라이브 추적을 추가하지 않는다(Non-Goal). 결과: **오늘 봉에선 ask-peak 토글이 시각적으로 무효**(ON/OFF 모두 ratchet running max). 토글은 **과거 거래일**에서만 close↔peak를 가른다. 사용자 동의된 "오늘=근사". |

**"intentionally breaks" 정당화 — ask-peak #96 재개**: #96은 "raw 틱 max는 분봉 호가창에 안 나타날 수
있으니 사용자가 실제로 보는 버킷 종가 대표값을 쓴다"고 정했다. 이 spec의 peak 모드는 그 결정을 **되돌려**
raw 틱 max를 허용한다 — 단 **기본값은 종가 유지, peak는 opt-in 토글**. 정당화: 사용자가 명시적으로 "분봉
내 봉우리를 보고 싶다"고 요청했고, 토글을 켠 사용자는 "표시 호가창엔 안 보였을 수도 있는 순간 최댓값"을
보겠다는 의도를 선택한 것이다. 종가 기본값이 #96의 직관을 보존하므로 회귀 위험은 opt-in 경로(그것도 과거
거래일)에 한정된다.

**새로 도입하는 invariant**

- **총잔량 고점 ≥ 종가 상계**: 같은 분봉에서 `bid_peak ≥ bid_total(종가)`, `ask_peak ≥ ask_total(종가)`,
  ask-peak `peak_qty ≥ qty(종가)`. (연속거래 스냅샷 집합의 max ≥ 그 집합의 마지막 원소.) 토글 ON 시
  총잔량/매도벽 라인은 종가 라인보다 아래로 내려가지 않는다 — 회귀 테스트로 고정.
- **호가비 고점 = 매그니튜드 상계(부호는 가변)**: `|imbalance(imb_peak)| ≥ |imbalance(종가)|`(종가 스냅샷도
  후보에 포함되므로). 단 **부호 방향은 종가와 다를 수 있다**(위 예시). 따라서 0-중심 baseline에서 라인은
  "0에서 더 멀어지거나 같다"이며, 같은 쪽이라는 보장은 없다.
- **오늘=근사, 과거=정밀(today→past 정밀화 계약)**: 오늘 봉 고점은 라이브 SSE 버퍼가 본 스냅샷 기준
  근사값이다(ask-peak는 위 ratchet=running max). 봉이 과거로 굳어 Parquet 경로로 서빙되면 백엔드가
  종가/고점 정밀값을 확정한다. SSE 버퍼가 Parquet보다 스냅샷을 적게 본 경우 과거화 시 고점값이 **상향**
  정밀화될 수 있다(종가는 결정적이라 면역). 사용자 동의된 트레이드오프.

## Goals

- 총잔량·호가비·당일 매도 최대벽 각각에 **per-indicator "고점(peak) 기준" 토글**을 추가(기본 off=종가 유지).
- peak ON 시 분봉 대표값이 고점으로 교체:
  - 총잔량: 분봉 내 매수 총잔량 max, 매도 총잔량 max(서로 다른 시점 허용).
  - 호가비: 분봉 내 \|불균형\| 최대 스냅샷의 (bid,ask) → 그 불균형값(부호 유지).
  - ask-peak: 버킷 대표를 틱-max로 바꾼 뒤 당일 최댓값(과거 거래일에 한해; 오늘은 ratchet 근사).
- **전 기간** 동작(오늘 ask-peak 토글 무효 예외 명시).
- 토글은 **즉시 반영**되는 클라이언트 렌더 스위치 — 재요청·깜빡임 없음. 고점 필드는 항상 페이로드에 포함.
- **총잔량 급증 마커는 peak 토글과 무관하게 종가 기준 유지.**
- Config UI(각 지표 상세 pane)에 토글 1줄씩 추가.

## Non-Goals

- **체결강도 peak** — 이미 분봉 합산(flow)이라 'peak' 개념이 다름. 제외.
- **매수 최대벽(bid peak wall)** — ask-peak의 매수 대칭. 별개 Non-Goal.
- **오버레이/밴드 표시** — 종가·고점 동시 표시 안 함(교체 토글로 확정).
- **오늘 봉의 라이브 close/peak 이중 추적** — 오늘은 근사 허용(ratchet running max). 라이브 경로에 close용
  두 번째 running 값을 두지 않는다 → 오늘 봉 ask-peak 토글은 시각적으로 무효(과거 거래일에서만 유효).
- **mode= 쿼리 파라미터** — 캐시 2배·재요청 깜빡임 회피 위해 안 함.

## Design

### 1. 데이터 모델 — "항상 함께 싣되, 평탄-가산으로"

백엔드와 SSE 버킷터가 종가 필드 옆에 고점 필드를 **항상** 실어 보낸다. 토글은 클라이언트 렌더 시점에만
작동하므로 캐시·분할이 모드와 무관(Split Cache 등가 보존). 기존 필드는 그대로 두고 **필드를 가산**하여
기존 소비자(`.bid_total`, `.price` 등) 접근점이 깨지지 않게 한다.

**총잔량 / 호가비** — `QuoteRatioPoint` 가산 (`hoga/api/models.py:105` + `frontend/src/api/types.ts:31` 미러):

```
QuoteRatioPoint = {
  t, bid_total, ask_total,        // 기존(종가 대표 스냅샷) — 불변
  bid_peak, ask_peak,             // 총잔량 고점: 버킷 내 각 변 독립 최댓값
  imb_peak_bid, imb_peak_ask,     // 호가비 고점: |imbalance| 최대 스냅샷의 (bid,ask) 쌍
}
```

- 호가비 고점을 **스칼라가 아니라 (bid,ask) 쌍**으로 싣는 이유: projector가 기존 `quoteImbalance(bid,ask)`
  경로를 그대로 태워 부호·outlier 클램프·포맷터가 종가와 **완전히 동일**하게 동작.
- 동시호가/센티넬 버킷(종가 0): `bid_peak=ask_peak=0`, `imb_peak_*`는 종가와 동일(불균형 0).

**당일 매도 최대벽** — `AskPeak` 가산 (`hoga/api/models.py:94` + `types.ts:439` 미러). 중첩 대신 **평탄-가산**
으로 기존 `.price/.qty/.t_ms` 접근점(렌더·ratchet·bundle)을 보존:

```
AskPeak = {
  date, price, qty, t_ms,                 // 기존(버킷 종가 대표의 당일 max) — 불변
  peak_price, peak_qty, peak_t_ms,        // 신규(버킷 틱-max의 당일 max)
}
```

`LiveAskPeakSegments`가 토글에 따라 `(price,qty,t_ms)` ↔ `(peak_price,peak_qty,peak_t_ms)` triple을 고른다.
(오늘 거래일 entry는 ratchet running max라 두 triple이 동일 — 토글 무효, 위 invariant.)

### 2. 집계 로직 (과거·오늘 양 경로)

**백엔드 `hoga/tables/snapshots.py`** (cold-path):

- `query_bucketed_ratio()`: 기존 버킷 대표(rn=1, is_pre DESC·ts DESC) **외에**
  - 버킷별 `MAX(ask_total) AS ask_peak`, `MAX(bid_total) AS bid_peak` (is_pre 필터 안).
  - 호가비 고점: per-snapshot 행에 2차 `ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY <imb_mag> DESC)`,
    `<imb_mag>` = `CASE WHEN bid_total>0 AND ask_total>0 THEN GREATEST(ask_total,bid_total)*1.0/LEAST(ask_total,bid_total) ELSE 1 END`
    (= \|imbalance\|+1 의 단조 대용; degenerate=1=극값0). rn=1 행의 `(bid_total, ask_total)`를
    `(imb_peak_bid, imb_peak_ask)`로. **imbalance는 현재 Python(`bundle.py`)에서 계산**되므로(스냅샷 행이
    rn=1 선택 후 사라짐) 이 랭킹은 **SQL 단계**에서 해야 한다.
- `query_day_ask_peak()`: 기존 close 변종(버킷 대표의 당일 max) **외에** peak 변종 병렬 계산 — 버킷 대표
  단계를 건너뛰고 연속거래 스냅샷 전체에서 단일 매도단계 max qty를 버킷별로 구한 뒤 당일 max. 동률 시
  기존과 동일(가장 먼저 도달). `peak_price/peak_qty/peak_t_ms`로 emit.
- 모든 신규 집계는 기존 `_DEEP_BOOK_SQL`/`is_pre` 연속거래 필터 안에서만.

**프론트 `frontend/src/live/bucketHogaSeries.ts`** (오늘 라이브, SSE seam):

- 버킷 순회 시 종가(last-continuous)와 **함께** `bid_peak/ask_peak`(연속 스냅샷 max)와 호가비 고점
  (스냅샷별 `quoteImbalance` 절댓값 최대의 (bid,ask) 쌍)을 추적. 동시호가 버킷은 0 센티넬 동일.
- ask-peak 오늘 ratchet(`computeDayAskPeak`/`useDayAskPeaks`): **현재 running max(=peak)만 추적, 변경 없음.**
  오늘 entry는 `price/qty/t_ms`와 `peak_price/peak_qty/peak_t_ms`를 **동일한 ratchet 값**으로 채운다(close
  변종 라이브 미추적 — Non-Goal). 정밀 close/peak는 과거화 시 백엔드가 확정.

### 3. 렌더 스위치 · pref · Config UI

- **pref 등록** `frontend/src/state/chartPrefs.ts`: `CHART_TOGGLES`에 **5필드 엔트리** 3개 추가(예시 명명):
  `{ key:'quoteTotalsPeakBasis', label:'…고점 기준', description:'…', default:false, category:'indicator-modal' }`,
  `ratioPeakBasis`, `askPeakIntraMax` 동형. `category:'indicator-modal'` 누락 시 ⚙️ 설정 모달에 잘못 노출됨
  (`categoryOf` 기본 'chart', chartPrefs.ts:71-75). `ChartToggleKey`·`ChartViewPrefs`·기본값·영속 전부 자동 파생.
- **렌더 스위치** `quoteTotals.ts`·`ratio.ts`: `useActivePrefs`로 토글을 읽어 projector가
  `p.bid_total ↔ p.bid_peak`, `quoteImbalance(bid_total,ask_total) ↔ quoteImbalance(imb_peak_bid,imb_peak_ask)`
  중 선택. **라인 개수·색·시리즈 옵션 불변.** `useShallow` ctx(quoteTotals.ts:111-120, ratio.ts:114-121)에
  토글 키를 추가해 `makePastCachedProjector`의 ctx-identity 캐시(`entry.ctx !== ctx`, pastCachedProjector.ts:68)가
  토글 전환을 무효화하도록 한다.
- **ask-peak 렌더** `LiveAskPeakSegments.tsx`: 토글에 따라 close/peak triple 선택. 마커 x-스냅
  (`snapPeakMsToCandle`)·k/M 라벨 동일.
- **Config UI**: `QuoteTotalsConfig`·`RatioConfig`는 이미 `IndicatorPrefRows` 사용(각 :17) → `toggleKeys`에
  키 추가. **`AskPeakConfig`는 현재 `useLivePageStore` 직접 사용·`IndicatorPrefRows` 미사용** → import 후
  `<IndicatorPrefRows toggleKeys={['askPeakIntraMax']} />` 1줄 추가(다른 둘과 패턴이 다름에 유의). 라벨 예:
  "분봉 내 최댓값(고점) 기준".

### 4. 총잔량 급증(Surge) 격리 — 사실상 공짜

`detectSurgeSide`는 `FIELD={ask:'ask_total', bid:'bid_total'}`로 필드명을 하드코딩한다(detectSurges.ts:19,61).
신규 `*_peak` 필드를 이 맵에 **추가하지 않는** 한, 감지기는 토글과 무관하게 종가 총잔량만 읽는다. 렌더
스위치는 `projectBidPoints`/`projectAskPoints`의 값 선택에만 들어간다. surge와 render가 같은
`b.quote_ratio.points` 배열을 공유하지만(quoteTotals.ts:148-149) **서로 다른 필드**를 읽으므로 분리 리팩터가
불필요. 회귀 테스트로 "토글 ON/OFF에도 마커 위치 불변"을 고정.

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| 총잔량 고점 독립 시점 | 한 버킷에 bid max@t1, ask max@t2 (t1≠t2) | `bid_peak=max(bid)`, `ask_peak=max(ask)` 각 독립 |
| 호가비 고점 부호 뒤집힘 | A(bid100,ask2→−49), B(bid10,ask300→+29) 한 버킷 | imb_peak=(bid100,ask2) → quoteImbalance=**−49**(매수우위). max끼리 (bid100,ask300)→+2 가 **아님** |
| 총잔량 고점 ≥ 종가 상계 | 임의 버킷 | `bid_peak≥bid_total`, `ask_peak≥ask_total`, askPeak `peak_qty≥qty` |
| 호가비 매그니튜드 상계 | 임의 버킷 | `\|quoteImbalance(imb_peak)\| ≥ \|quoteImbalance(종가)\|`; 부호는 다를 수 있음 |
| degenerate 호가비 | 버킷에 bid=0 또는 ask=0 스냅샷 포함 | 그 스냅샷 \|imbalance\|=0 으로 극값 후보에서 밀림(랭킹 ratio=1) |
| 동시호가 배제(고점) | 버킷에 연속+동시호가 혼재 | 고점 후보는 연속거래만; 완전 동시호가 버킷 0 센티넬 |
| ask-peak peak vs close (과거일) | 분봉 내 순간 큰 벽이 종가엔 사라짐 | `peak_*`는 그 순간 벽 포착, `price/qty/t_ms`는 #96대로 종가 벽 |
| ask-peak 오늘 토글 무효 | 오늘 거래일 entry | close/peak triple 동일(둘 다 ratchet running max) |
| Surge 격리 | peak 토글 ON/OFF | `detectSurgeSide` 출력·마커 위치 동일(`*_total` 고정) |
| 렌더 스위치 구조 불변 | 토글 ON/OFF | 라인 수·색·시리즈 옵션 동일, value만 변경 |

**Invariant 회귀 테스트**: (1) Split Cache 등가 — peak 필드 포함 상태로 `past++today === all`(양 토글 상태).
(2) Surge 트리거 — peak 토글과 무관하게 마커 위치 동일. (3) 총잔량 고점 ≥ 종가 상계 + 호가비 매그니튜드
상계. (4) ask-peak #97 마커 x-스냅 — peak 값 경로로도 버킷 캔들 스냅 유지.

### Manual verification

`/live`에서: (a) 총잔량·당일 매도 최대벽(과거일) 토글 ON 시 라인/선이 종가 대비 위로(또는 동일) 이동,
(b) 호가비 토글 ON 시 라인이 0에서 **더 멀어지거나 같게**(부호는 종가와 다를 수 있음) 이동, (c) 토글 즉시
반영(재요청 깜빡임 없음), (d) 과거로 팬해도 일관, (e) 오늘 봉 ask-peak는 토글 무관 동일, (f) 총잔량 급증
마커 위치가 토글에 흔들리지 않음. 헤드리스로는 crosshair/시각 확인 한계 → **사용자 육안 검증** 필요.

## Risks / Open questions

- **today→past 고점 상향 정밀화 점프**: 오늘 근사 < 과거 정밀일 때 봉이 굳으며 값이 올라가는 점프 가능.
  사용자 동의됨. SSE 버퍼 vs Parquet 스냅샷 밀도 패리티를 plan에서 측정·문서화.
- **호가비 고점 SQL 랭킹**: imbalance가 현재 Python 계산이라 랭킹을 SQL로 내려야 함. `GREATEST/LEAST`
  ratio 대용 단조성·degenerate(0 분모) 가드·DuckDB 함수 가용성을 plan에서 확인.
- **AskPeak 평탄-가산 마이그레이션**: 중첩 대신 가산이라 기존 `.price/.qty/.t_ms` 접근점 불변. 단
  `peak_*` 3필드를 models.py·types.ts·bundle.py(`build_ask_peak_slice`)·LiveAskPeakSegments(triple 선택)·
  computeDayAskPeak/useDayAskPeaks(오늘 동일값 채움)에 배선해야 함.
- **명명 최종화**: `askPeakIntraMax` 등 — plan에서 일관 family로 확정.

## Out of Scope (Backlog)

- 매수 최대벽(bid peak wall) 및 그 peak 변종.
- 종가·고점 동시 표시(오버레이/밴드).
- 체결강도의 분봉 내 순간 강도 peak 재해석.
- 오늘 봉 ask-peak의 라이브 정밀 close/peak 이중 추적(현재는 토글 무효 수용).
