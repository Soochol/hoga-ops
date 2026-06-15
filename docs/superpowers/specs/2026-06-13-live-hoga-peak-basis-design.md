# 호가 지표 분봉 대표값 — 종가(close) ↔ 분봉 내 최댓값(Intra-Bar Max) 기준 옵션 — Design

> 용어 (2026-06-13 그릴링 확정 — CONTEXT.md 등재):
> - **분봉 대표값(bar representative)**: 1분봉 하나가 갖는 단일 호가 지표값. 현재는 **종가(close)**
>   = 그 분 마지막 *연속거래* 스냅샷의 값.
> - **분봉 내 최댓값 기준 (Intra-Bar Max)**: 이 spec이 옵션으로 추가하는 대표값 기준 — 그 분 내 연속거래
>   스냅샷의 최댓값. 캔들의 종가↔고가 관계와 같은 직관.
>   _Avoid_: **"peak" / "고점"** — 이미 예약됨(총잔량 급증의 *running peak*, 당일 매도 최대벽 = Day Ask
>   **Peak**). 새 개념엔 쓰지 않는다. "고가"도 High/Low Extreme Labels의 캔들 고가와 충돌(그건 가격, 이건
>   지표값).
> - **호가비 부호 규약**(`util/imbalance.ts:9-12`): `quoteImbalance(bid,ask)` = `ask/bid−1`(ask≥bid) /
>   `−(bid/ask−1)`(bid>ask), 단 bid≤0 또는 ask≤0이면 0. **비제한적(unbounded), 양수=매도 우위(sell-heavy),
>   음수=매수 우위(buy-heavy).** ((bid−ask)/(bid+ask) 형태 **아님**.)
> - 코드 식별자(명명 제안, plan 확정): pref 토글 `quoteTotalsIntraMax` / `ratioIntraMax` / `askPeakIntraMax`;
>   wire 필드 `bid_max`·`ask_max`·`imb_max_bid`·`imb_max_ask`(QuoteRatioPoint), `max_price`·`max_qty`·`max_t_ms`
>   (AskPeak).

**Date**: 2026-06-13
**Status**: Draft
**관련 결정**: ADR-0076 (Intra-Bar Max basis — Day Ask Peak #96 의도적 반전 + 대안/귀결)
**Scope**:
- 백엔드: `hoga/tables/snapshots.py`(`query_bucketed_ratio`에 버킷별 MAX 및 imbalance-극값 행 추출 추가, `query_day_ask_peak`에 틱-max 변종 추가), `hoga/api/models.py`(`QuoteRatioPoint`·`AskPeak` 필드 **가산**), `hoga/api/bundle.py`(증강 필드 배선; `build_ask_peak_slice`·QuoteRatioPoint 변환부)
- 프론트 타입/집계: `frontend/src/api/types.ts`(미러), `frontend/src/live/bucketHogaSeries.ts`(SSE 경로 최댓값 추적), `frontend/src/util/imbalance.ts`(프론트 극값 계산 재활용)
- 프론트 렌더/설정: `frontend/src/chart/projectors/quoteTotals.ts`·`ratio.ts`(렌더 스위치 + ctx 키 + 급증 마커 높이), `frontend/src/state/chartPrefs.ts`(토글 3종 등록), `frontend/src/live/indicators/QuoteTotalsConfig.tsx`·`RatioConfig.tsx`·`AskPeakConfig.tsx`(설정 행)
- ask-peak 소비자(평탄-가산 마이그레이션 영향): `frontend/src/live/LiveAskPeakSegments.tsx`(렌더 — close/max triple 선택), `frontend/src/live/computeDayAskPeak.ts`·`useDayAskPeaks.ts`(오늘 ratchet — 변경 최소)
- 자동/검증: `frontend/src/state/chartPrefsPersistence.ts`(CHART_TOGGLES 순회 자동 영속 — 추가 등록 불요, 확인용), `tests/unit/live/test_adr_invariants.py`(ADR-0038 회귀)

## Problem

사용자(트레이더) 표현 그대로:

> "사용자는 분봉 단위로 보니까 분봉의 마지막 데이터를 기준으로 하고 있는데, 예를 들어 1분봉으로 보고
> 있다고 하면, 1분 내에서 가장 큰 peak 가격이 있었더라도 종가 기준으로 peak를 계산하니까 그 부분이
> 조금 아쉬워. 종가 데이터 외에, peak 데이터로 변경할 수 있는 옵션이 있으면 좋겠어."

「지표」 모달 **호가 지표 그룹**의 상태형 지표(총잔량·호가비·당일 매도 최대벽)는 1분봉마다 "그 분 마지막
연속거래 스냅샷(≈종가)" 하나만 대표값으로 잡는다. 그래서 분봉 내 어느 순간 잔량/불균형/매도벽이 더 크게
치솟았어도 그 분이 평범하게 마감하면 화면엔 그 봉우리가 사라진다. 캔들은 고가(high)를 wick으로 남기는데
호가 지표는 그렇지 못해, 분봉 단위로 보는 사용자가 "그 분의 봉우리"를 놓친다. (사용자가 말한 "peak"는
글로서리 충돌을 피해 **분봉 내 최댓값(Intra-Bar Max)** 으로 명명 — 그릴링 확정.)

### 적용 범위 (확정)

| 지표 | 현재 분봉 대표값 | Intra-Bar Max 의미 | 포함? |
|---|---|---|---|
| **총잔량(quote-totals)** | 종가 스냅샷의 매수/매도 총잔량 | 분봉 내 각 변(side) 최댓값(독립 시점 허용 — 그릴링 Q5) | ✅ |
| **호가비(ratio)** | 종가 스냅샷 총잔량의 불균형(±) | 분봉 내 \|불균형\|이 최대였던 스냅샷값(부호 유지) | ✅ |
| **당일 매도 최대벽(ask-peak)** | 버킷 종가 스냅샷의 매도벽 중 당일 최댓값 | 버킷 내 전 연속스냅샷 틱-max로 대표값 교체 후 당일 최댓값 (#96 반전, ADR-0076) | ✅ |
| **체결강도(fill-strength)** | 그 분 체결량 **합산**(flow, 종가 아님) | — 이미 분봉 전체 합산이라 'max' 개념이 적용되지 않음 | ❌ |

핵심 해석:

- **표시 방식 = 교체(replace) 토글.** ON이면 대표값이 종가→Intra-Bar Max로 *바뀐다*. 라인 개수·색은 불변
  (오버레이/밴드 아님).
- **호가비 Intra-Bar Max는 총잔량 Intra-Bar Max에서 유도 불가** — `imbalance(max bid, max ask) ≠ max imbalance
  over snapshots`. 실제 수식(`ask/bid−1`)으로도 부호가 뒤집힌다. 예 (한 분봉 안 두 스냅샷):
  - 스냅샷 A: bid=100, ask=2 → `−(100/2−1)` = **−49** (매수 우위, 매우 강함)
  - 스냅샷 B: bid=10, ask=300 → `300/10−1` = **+29** (매도 우위)
  - 분봉 내 \|불균형\| 극값 = A의 **−49**(매수 우위).
  - 그런데 max(bid)=100, max(ask)=300 조합 → `300/100−1` = **+2**(매도 우위) — **부호 반대!**
  → 호가비 Intra-Bar Max는 **버킷팅 단계에서 스냅샷별로** 계산해 별도 필드로 실어야 한다. "최강 압력
  순간(부호 유지)" 정의 채택.
- **전 기간(과거 Parquet + 오늘 라이브)** 적용. (ask-peak 오늘-토글 무효 예외는 아래.)
- **연속거래 호가창만 집계.** 마감 동시호가·VI 단일가 구간은 종가 경로와 **동일하게** 배제(ADR-0029/0062).

### 그릴링 확정 사항 (2026-06-13)

- **Q1 — ask-peak 포함**: #96의 "sub-bucket transient는 옳게 건너뜀" 원칙을 의도적으로 반전(opt-in, 기본
  종가). 종가="이 해상도에서 실제 보고 대응할 벽", Intra-Bar Max="찰나라도 가장 컸던 벽(스푸핑성 포함)" —
  서로 다른 질문. ADR-0076로 문서화.
- **Q2 — 호가비 × Outlier Mask = 직교 유지**: Intra-Bar Max 값도 종가와 동일하게 극단값 필터(기본 ON)를
  통과. 스파이크 극값이 임계 초과면 0(종가와 동일 규칙). **기본값에선 호가비 Intra-Bar Max가 스파이크
  지점에서 0으로 보일 수 있음** — 날것을 보려면 같은 호가비 Config의 필터 토글을 끈다. (필터 우회 거부:
  bid=1/ask=9999 한 점이 RatioPane 오토스케일을 망침 — 필터의 존재 이유.)
- **Q3 — 용어 = 「분봉 내 최댓값(Intra-Bar Max)」**, peak/고점 예약(위 용어 절).
- **Q4 — 급증 마커 높이 = 보이는 라인 값**: 총잔량 Intra-Bar Max ON이면 마커 점이 `ask_max`/`bid_max`
  높이(보이는 라인 위)에 앉는다. **감지 시점은 종가 기준 고정**(invariant). `surgeMarkerPoints`가 ctx
  토글을 보고 price 필드만 바꾼다.
- **Q5 — 총잔량 양변 독립 시점**: 매수/매도 최댓값이 분봉 내 서로 다른 순간이어도 각각 표시(캔들 고가가
  시·종가와 무관하듯).

## Invariants

이 spec이 건드리는 분기가 **현재 보존하고 있는** 속성:

- **Split Cache 등가(#74 1-min split)**: `/live` 호가 지표는 `projectXPoints(과거 고정 슬라이스) ++
  projectXPoints(오늘 슬라이스) === projectXPoints(전체)`. 유일한 cross-point 상태(maskOutgoingConnector의
  1-point lookback)가 거래일 경계를 넘지 않기에 성립. 근거:
  [pastCachedProjector.test.ts:48-87](../../../frontend/src/chart/projectors/pastCachedProjector.test.ts),
  [ratio.ts:64-72](../../../frontend/src/chart/projectors/ratio.ts),
  [auctionHide.ts:78-81](../../../frontend/src/chart/util/auctionHide.ts).
- **단일가 구간 표시 억제(ADR-0029/0062)**: 호가 지표는 마감 동시호가·VI 단일가 누적을 신호에서 제외
  (구조적 판정, 시계 아님). 백엔드 `_DEEP_BOOK_SQL`(`snapshots.py:367` SSOT), 클라
  `isContinuousBook`/`lastContinuousMs` **공유 정의**. 근거: [snapshots.py:324-413](../../../hoga/tables/snapshots.py),
  [bucketHogaSeries.ts:35-94](../../../frontend/src/live/bucketHogaSeries.ts),
  [docs/adr/0062-structural-auction-boundary.md](../../adr/0062-structural-auction-boundary.md).
- **총잔량 급증 트리거 안정성**: `detectSurgeSide`는 당일 총잔량 **종가** 시퀀스의 running peak를 추적해
  근접(95%)·재무장(85%)으로 발사. 입력 시퀀스가 바뀌면 트리거가 틀어진다. **결정적 사실**: 감지기는
  필드명을 하드코딩 — `const FIELD = {ask:'ask_total', bid:'bid_total'}`. 근거:
  [detectSurges.ts:19,61](../../../frontend/src/chart/surge/detectSurges.ts), 마커 값 소스
  [quoteTotals.ts:140-149](../../../frontend/src/chart/projectors/quoteTotals.ts). (ADR 없음; 근거는 이 코드 +
  스펙 `2026-06-12-chongjanryang-breakout-live-marker-design.md`.)
- **ADR-0038 hot-path 순수성**: tick 경로(`buffer`·`live_session`·`stream`)는 `pyarrow`/`polars` import 금지.
  parquet 집계는 cold-path. 근거: [tests/unit/live/test_adr_invariants.py](../../../tests/unit/live/test_adr_invariants.py).
- **ADR-0001 번들 코디네이터 분리**: snapshots 스키마 지식은 `snapshots.py`, `bundle.py`는 조립만. 근거:
  [bundle.py:47,435](../../../hoga/api/bundle.py).
- **행동 pref 등록 SSOT 패턴**: 지표 행동 토글은 `chartPrefs.CHART_TOGGLES`에 **5필드 엔트리**
  (`{key, label, description, default, category}`) 1개로 등록하면 `ChartToggleKey` union·`ChartViewPrefs`·기본값
  맵·영속·UI 렌더가 전부 파생. `category:'indicator-modal'`이라야 「지표」 모달에 뜬다(없으면 ⚙️ 설정
  모달행 — `categoryOf` 기본 'chart'). 근거: [chartPrefs.ts:12-75](../../../frontend/src/state/chartPrefs.ts)(예:
  `ratioOutlierFilterEnabled` 20-26), [IndicatorPrefRows.tsx](../../../frontend/src/live/settings/IndicatorPrefRows.tsx),
  [chartPrefsPersistence.ts:12-14](../../../frontend/src/state/chartPrefsPersistence.ts)(CHART_TOGGLES 순회 자동 영속).
- **호가비 Outlier Mask(ADR-0026)**: `ratioOutlierFilterEnabled`(기본 ON)일 때 `1+|imbalance|`가 임계
  (기본 100, label 단위)를 넘으면 그 점을 0으로 마스킹(오토스케일 보호). 근거: CONTEXT "Outlier Mask",
  [ratio.ts](../../../frontend/src/chart/projectors/ratio.ts), [docs/adr/0026](../../adr/).
- **ask-peak 버킷 종가 대표(#96)**: `query_day_ask_peak`는 raw 틱 max가 아니라 **버킷 대표(마지막 연속거래
  스냅샷)** 의 매도벽에서 당일 최댓값을 찾는다 — #96의 *의도적* 결정. 근거:
  [snapshots.py:466-525](../../../hoga/tables/snapshots.py)(`rep` CTE rn=1), commit d2d7c69(#96).
- **ask-peak 마커 x-스냅(#97)**: peak 발생시점 점이 버킷 캔들 경계에 스냅(`snapPeakMsToCandle`). 근거:
  [LiveAskPeakSegments.tsx:14-57](../../../frontend/src/live/LiveAskPeakSegments.tsx), commit 6eedb49(#97).
- **거래일 self-reset(KST 자정)**: 당일 누적/ratchet 상태는 KST 거래일 경계에서 리셋. 근거:
  [tradingDay.ts:6-9](../../../frontend/src/util/tradingDay.ts) `tradingDayOf`,
  [computeDayAskPeak.ts](../../../frontend/src/live/computeDayAskPeak.ts).
- **ask-peak 오늘 ratchet = 전-스냅샷 running max**: 오늘 라이브 매도 최대벽은 모든 스냅샷의 매도 단계 qty
  running max — close 변종을 라이브로 따로 추적하지 않음. 근거:
  [computeDayAskPeak.ts:36-39](../../../frontend/src/live/computeDayAskPeak.ts) `foldAskPeak`.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| Split Cache 등가(#74) | **preserves** | Intra-Bar Max 필드는 종가 필드와 **함께 캐시**(같은 `QuoteRatioPoint`). 토글은 어느 필드를 그릴지 고르는 **순수 렌더 스위치** — 캐시 데이터·청크 분할 불변. `mode=` 쿼리 파라미터 안 씀(캐시 2배 회피). |
| 단일가 구간 표시 억제 | **preserves** | 최댓값 계산도 종가와 **동일한** 연속거래 필터(`is_pre`/`lastContinuousMs`) 안에서만. 동시호가 스냅샷은 최댓값 후보에서도 배제. |
| 총잔량 급증 트리거 안정성 | **preserves (사실상 공짜)** | `detectSurgeSide`가 `ask_total`/`bid_total` 필드명을 **하드코딩**. 렌더 스위치를 `projectBidPoints`/`projectAskPoints`의 값 선택(`*_total`↔`*_max`)에만 넣으면 감지기는 `*_max`를 안 건드림. 마커 *높이*만 보이는 라인 값으로(Q4); 감지 *시점*은 종가 고정. |
| ADR-0038 hot-path 순수성 | **preserves** | 신규 집계는 cold-path(`query_*`)에만. tick 경로 미접촉. |
| ADR-0001 번들 코디네이터 분리 | **preserves** | 집계는 `snapshots.py`, `bundle.py`는 배선만. |
| 행동 pref 등록 SSOT 패턴 | **preserves** | 토글 3종을 `CHART_TOGGLES`에 5필드로 추가, `default:false`·`category:'indicator-modal'`. 영속 자동. |
| 호가비 Outlier Mask | **preserves (직교, Q2)** | Intra-Bar Max 값도 같은 마스크 통과. 스파이크 극값은 0(종가와 동일). 날것은 필터 OFF로. |
| ask-peak 버킷 종가 대표(#96) | **intentionally breaks (Intra-Bar Max 모드 한정, opt-in)** | ADR-0076. 기본 종가 유지, 과거 거래일에서만 유효. |
| ask-peak 마커 x-스냅(#97) | **preserves (회귀 검증 필수)** | 최댓값 값으로도 `snapPeakMsToCandle`로 버킷 캔들 스냅 — max 경로 회귀 테스트. |
| 거래일 self-reset | **preserves** | 오늘 ratchet 근사는 기존 KST 리셋 그대로. |
| ask-peak 오늘 ratchet=running max | **preserves (토글 의미 제약)** | 오늘은 close 변종 라이브 미추적(Non-Goal) → **오늘 봉에선 ask-peak 토글이 시각적으로 무효**(ON/OFF 모두 ratchet). 토글은 **과거 거래일**에서만 close↔Intra-Bar Max를 가른다. 사용자 동의된 "오늘=근사". |

**"intentionally breaks" 정당화 — ask-peak #96 재개**: ADR-0076 참조. 기본 종가가 #96 직관을 보존하므로
회귀 위험은 opt-in 경로(그것도 과거 거래일)에 한정.

**새로 도입하는 invariant**

- **총잔량 최댓값 ≥ 종가 상계**: 같은 분봉에서 `bid_max ≥ bid_total(종가)`, `ask_max ≥ ask_total(종가)`,
  ask-peak `max_qty ≥ qty(종가)`. (연속거래 스냅샷 집합의 max ≥ 그 집합의 마지막 원소.) 토글 ON 시
  총잔량/매도벽 라인은 종가 라인보다 아래로 내려가지 않는다 — 회귀 테스트로 고정.
- **호가비 최댓값 = 매그니튜드 상계(부호는 가변)**: `|imbalance(imb_max)| ≥ |imbalance(종가)|`(종가 스냅샷도
  후보). 단 **부호 방향은 종가와 다를 수 있다**. 0-중심 baseline에서 라인은 "0에서 더 멀어지거나 같다"이며
  같은 쪽 보장은 없다. (Outlier Mask가 임계 초과 점을 0으로 만들 수 있음 — Q2.)
- **오늘=근사, 과거=정밀(today→past 정밀화 계약)**: 오늘 봉 최댓값은 라이브 SSE 버퍼가 본 스냅샷 기준
  근사. 봉이 과거로 굳으면 백엔드가 종가/최댓값 정밀값 확정. SSE 버퍼가 Parquet보다 스냅샷을 적게 본 경우
  과거화 시 최댓값이 **상향** 정밀화될 수 있다(종가는 결정적이라 면역). 사용자 동의됨.

## Goals

- 총잔량·호가비·당일 매도 최대벽 각각에 **per-indicator "분봉 내 최댓값 기준" 토글**(기본 off=종가).
- ON 시 분봉 대표값이 Intra-Bar Max로 교체:
  - 총잔량: 분봉 내 매수 총잔량 max, 매도 총잔량 max(독립 시점).
  - 호가비: 분봉 내 \|불균형\| 최대 스냅샷의 (bid,ask) → 그 불균형값(부호 유지).
  - ask-peak: 버킷 대표를 틱-max로 바꾼 뒤 당일 최댓값(과거 거래일; 오늘은 ratchet 근사).
- **전 기간** 동작(오늘 ask-peak 토글 무효 예외 명시).
- 토글은 **즉시 반영**되는 클라이언트 렌더 스위치 — 재요청·깜빡임 없음. Intra-Bar Max 필드는 항상 페이로드.
- **총잔량 급증 마커는 토글과 무관하게 종가 기준으로 감지**(높이만 보이는 라인에 맞춤).
- Config UI(각 지표 상세 pane)에 토글 1줄씩.

## Non-Goals

- **체결강도 Intra-Bar Max** — 이미 분봉 합산(flow). 제외.
- **매수 최대벽(bid peak wall)** — ask-peak 매수 대칭. 별개.
- **오버레이/밴드 표시** — 종가·최댓값 동시 표시 안 함(교체 토글).
- **오늘 봉의 라이브 close/max 이중 추적** — 오늘은 근사(ratchet). 오늘 봉 ask-peak 토글은 시각적 무효.
- **호가비 Intra-Bar Max의 Outlier Mask 우회** — 직교 유지(Q2).
- **mode= 쿼리 파라미터** — 캐시 2배 회피.

## Design

### 1. 데이터 모델 — "항상 함께 싣되, 평탄-가산으로"

백엔드와 SSE 버킷터가 종가 필드 옆에 Intra-Bar Max 필드를 **항상** 실어 보낸다. 토글은 클라이언트 렌더
시점에만 작동하므로 캐시·분할이 모드와 무관(Split Cache 등가). 기존 필드는 그대로 두고 **필드를 가산**해
기존 소비자(`.bid_total`, `.price` 등) 접근점이 깨지지 않게 한다.

**총잔량 / 호가비** — `QuoteRatioPoint` 가산 (`hoga/api/models.py:105` + `frontend/src/api/types.ts:31` 미러):

```
QuoteRatioPoint = {
  t, bid_total, ask_total,        // 기존(종가 대표 스냅샷) — 불변
  bid_max, ask_max,               // 총잔량 Intra-Bar Max: 버킷 내 각 변 독립 최댓값
  imb_max_bid, imb_max_ask,       // 호가비 Intra-Bar Max: |imbalance| 최대 스냅샷의 (bid,ask) 쌍
}
```

- 호가비를 **스칼라가 아니라 (bid,ask) 쌍**으로 싣는 이유: projector가 기존 `quoteImbalance(bid,ask)` 경로를
  그대로 태워 부호·**Outlier Mask**·포맷터가 종가와 **완전히 동일**하게 동작.
- 동시호가/센티넬 버킷(종가 0): `bid_max=ask_max=0`, `imb_max_*`는 종가와 동일(불균형 0).

**당일 매도 최대벽** — `AskPeak` 가산 (`hoga/api/models.py:94` + `types.ts:439` 미러). 중첩 대신 **평탄-가산**
으로 기존 `.price/.qty/.t_ms` 접근점(렌더·ratchet·bundle)을 보존:

```
AskPeak = {
  date, price, qty, t_ms,            // 기존(버킷 종가 대표의 당일 max) — 불변
  max_price, max_qty, max_t_ms,      // 신규(버킷 틱-max의 당일 max)
}
```

`LiveAskPeakSegments`가 토글에 따라 `(price,qty,t_ms)` ↔ `(max_price,max_qty,max_t_ms)` triple을 고른다.
(오늘 거래일 entry는 ratchet running max라 두 triple이 동일 — 토글 무효.)

### 2. 집계 로직 (과거·오늘 양 경로)

**백엔드 `hoga/tables/snapshots.py`** (cold-path):

- `query_bucketed_ratio()`: 기존 버킷 대표(rn=1, is_pre DESC·ts DESC) **외에**
  - 버킷별 `MAX(ask_total) AS ask_max`, `MAX(bid_total) AS bid_max` (is_pre 필터 안).
  - 호가비: per-snapshot 행에 2차 `ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY <imb_mag> DESC)`,
    `<imb_mag>` = `CASE WHEN bid_total>0 AND ask_total>0 THEN GREATEST(ask_total,bid_total)*1.0/LEAST(ask_total,bid_total) ELSE 1 END`
    (= \|imbalance\|+1 단조 대용; degenerate=1=극값0). rn=1 행의 `(bid_total, ask_total)`를
    `(imb_max_bid, imb_max_ask)`로. **imbalance는 현재 Python(`bundle.py`)에서 계산**되므로(rn=1 선택 후
    스냅샷 행 소실) 이 랭킹은 **SQL 단계**에서 해야 한다.
- `query_day_ask_peak()`: 기존 close 변종(버킷 대표의 당일 max) **외에** 틱-max 변종 — 버킷 대표 단계를
  건너뛰고 연속거래 스냅샷 전체에서 단일 매도단계 max qty를 버킷별로 구한 뒤 당일 max. 동률 시 기존과
  동일(가장 먼저 도달). `max_price/max_qty/max_t_ms`로 emit.
- 모든 신규 집계는 기존 `_DEEP_BOOK_SQL`/`is_pre` 연속거래 필터 안에서만.

**프론트 `frontend/src/live/bucketHogaSeries.ts`** (오늘 라이브, SSE seam):

- 버킷 순회 시 종가(last-continuous)와 **함께** `bid_max/ask_max`(연속 스냅샷 max)와 호가비 Intra-Bar Max
  (스냅샷별 `quoteImbalance` 절댓값 최대의 (bid,ask) 쌍)을 추적. 동시호가 버킷은 0 센티넬 동일.
- ask-peak 오늘 ratchet(`computeDayAskPeak`/`useDayAskPeaks`): **현재 running max만 추적, 변경 없음.** 오늘
  entry는 `price/qty/t_ms`와 `max_price/max_qty/max_t_ms`를 **동일한 ratchet 값**으로 채운다(close 변종
  라이브 미추적 — Non-Goal). 정밀 close/max는 과거화 시 백엔드 확정.

### 3. 렌더 스위치 · pref · Config UI

- **pref 등록** `frontend/src/state/chartPrefs.ts`: `CHART_TOGGLES`에 **5필드 엔트리** 3개 추가:
  `{ key:'quoteTotalsIntraMax', label:'분봉 내 최댓값 기준', description:'…', default:false, category:'indicator-modal' }`,
  `ratioIntraMax`, `askPeakIntraMax` 동형. `category:'indicator-modal'` 누락 시 ⚙️ 설정 모달에 잘못 노출됨
  (`categoryOf` 기본 'chart', chartPrefs.ts:71-75). `ChartToggleKey`·`ChartViewPrefs`·기본값·영속 전부 자동 파생.
- **렌더 스위치** `quoteTotals.ts`·`ratio.ts`: `useActivePrefs`로 토글을 읽어 projector가
  `p.bid_total ↔ p.bid_max`, `quoteImbalance(bid_total,ask_total) ↔ quoteImbalance(imb_max_bid,imb_max_ask)`
  중 선택. **라인 개수·색·시리즈 옵션·Outlier Mask 경로 불변.** `useShallow` ctx(quoteTotals.ts:111-120,
  ratio.ts:114-121)에 토글 키를 추가해 `makePastCachedProjector`의 ctx-identity 캐시(`entry.ctx !== ctx`,
  pastCachedProjector.ts:68)가 토글 전환을 무효화하도록 한다.
- **급증 마커 높이(Q4)** `surgeMarkerPoints`(quoteTotals.ts:140-149): 감지는 종가(`detectSurgeSide`,
  `*_total` 고정), 마커 `price` 필드만 토글에 따라 `m.value`(종가) ↔ 그 버킷의 `ask_max`/`bid_max`로 바꿔
  점이 보이는 라인 위에 앉게 한다.
- **ask-peak 렌더** `LiveAskPeakSegments.tsx`: 토글에 따라 close/max triple 선택. 마커 x-스냅
  (`snapPeakMsToCandle`)·k/M 라벨 동일.
- **Config UI**: `QuoteTotalsConfig`·`RatioConfig`는 이미 `IndicatorPrefRows` 사용(각 :17) → `toggleKeys`에
  키 추가. **`AskPeakConfig`는 현재 `useLivePageStore` 직접 사용·`IndicatorPrefRows` 미사용** → import 후
  `<IndicatorPrefRows toggleKeys={['askPeakIntraMax']} />` 1줄 추가(다른 둘과 패턴 다름에 유의).

### 4. 총잔량 급증(Surge) 격리 — 사실상 공짜

`detectSurgeSide`는 `FIELD={ask:'ask_total', bid:'bid_total'}`로 필드명을 **하드코딩**(detectSurges.ts:19,61).
신규 `*_max` 필드를 이 맵에 **추가하지 않는** 한, 감지기는 토글과 무관하게 종가 총잔량만 읽는다(시점
invariant). 렌더 스위치·마커 높이만 `projectBid/AskPoints`·`surgeMarkerPoints`에 들어간다. surge와 render가
같은 `b.quote_ratio.points` 배열을 공유하지만(quoteTotals.ts:148-149) **서로 다른 필드**를 읽으므로 분리
리팩터 불필요. 회귀 테스트로 "토글 ON/OFF에도 마커 발사 시점 불변"을 고정.

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| 총잔량 최댓값 독립 시점 | 한 버킷에 bid max@t1, ask max@t2 (t1≠t2) | `bid_max=max(bid)`, `ask_max=max(ask)` 각 독립 |
| 호가비 최댓값 부호 뒤집힘 | A(bid100,ask2→−49), B(bid10,ask300→+29) 한 버킷 | imb_max=(bid100,ask2) → quoteImbalance=**−49**. max끼리 (bid100,ask300)→+2 가 **아님** |
| 총잔량 최댓값 ≥ 종가 상계 | 임의 버킷 | `bid_max≥bid_total`, `ask_max≥ask_total`, askPeak `max_qty≥qty` |
| 호가비 매그니튜드 상계 | 임의 버킷 | `\|quoteImbalance(imb_max)\| ≥ \|quoteImbalance(종가)\|`; 부호는 다를 수 있음 |
| 호가비 × Outlier Mask (Q2) | imb_max가 임계 초과 + 필터 ON | 그 점 value=0(종가와 동일 규칙). 필터 OFF면 극값 표시 |
| degenerate 호가비 | 버킷에 bid=0 또는 ask=0 스냅샷 | 그 스냅샷 \|imbalance\|=0 으로 극값 후보에서 밀림(랭킹 ratio=1) |
| 동시호가 배제(최댓값) | 버킷에 연속+동시호가 혼재 | 최댓값 후보는 연속거래만; 완전 동시호가 버킷 0 센티넬 |
| ask-peak max vs close (과거일) | 분봉 내 순간 큰 벽이 종가엔 사라짐 | `max_*`는 그 순간 벽 포착, `price/qty/t_ms`는 #96대로 종가 벽 |
| ask-peak 오늘 토글 무효 | 오늘 거래일 entry | close/max triple 동일(둘 다 ratchet running max) |
| Surge 격리 (Q4) | 토글 ON/OFF | `detectSurgeSide` 발사 시점 동일(`*_total` 고정); 마커 높이만 보이는 라인 따름 |
| 렌더 스위치 구조 불변 | 토글 ON/OFF | 라인 수·색·시리즈 옵션 동일, value만 변경 |

**Invariant 회귀 테스트**: (1) Split Cache 등가 — Intra-Bar Max 필드 포함 상태로 `past++today === all`(양
토글 상태). (2) Surge 트리거 — 토글과 무관하게 발사 시점 동일. (3) 총잔량 최댓값 ≥ 종가 상계 + 호가비
매그니튜드 상계. (4) ask-peak #97 마커 x-스냅 — max 경로로도 버킷 캔들 스냅 유지.

### Manual verification

`/live`에서: (a) 총잔량·당일 매도 최대벽(과거일) 토글 ON 시 라인/선이 종가 대비 위로(또는 동일) 이동,
(b) 호가비 토글 ON 시 라인이 0에서 **더 멀어지거나 같게**(부호는 종가와 다를 수 있음); 필터 ON 기본값에선
스파이크가 0으로 보일 수 있음 → 필터 OFF로 확인, (c) 토글 즉시 반영(재요청 깜빡임 없음), (d) 과거로 팬해도
일관, (e) 오늘 봉 ask-peak는 토글 무관 동일, (f) 총잔량 급증 마커 발사 시점이 토글에 안 흔들리고 점이 보이는
라인 위에 앉음. 헤드리스 한계 → **사용자 육안 검증** 필요.

## Risks / Open questions

- **today→past 최댓값 상향 정밀화 점프**: 오늘 근사 < 과거 정밀일 때 봉이 굳으며 값이 올라가는 점프 가능.
  사용자 동의됨. SSE 버퍼 vs Parquet 스냅샷 밀도 패리티를 plan에서 측정·문서화.
- **호가비 최댓값 SQL 랭킹**: imbalance가 현재 Python 계산이라 랭킹을 SQL로 내려야 함. DuckDB
  `GREATEST/LEAST` ratio 대용 단조성·degenerate(0 분모) 가드·함수 가용성을 plan에서 확인.
- **AskPeak 평탄-가산 마이그레이션**: 중첩 대신 가산이라 기존 `.price/.qty/.t_ms` 접근점 불변. 단
  `max_*` 3필드를 models.py·types.ts·bundle.py(`build_ask_peak_slice`)·LiveAskPeakSegments(triple 선택)·
  computeDayAskPeak/useDayAskPeaks(오늘 동일값 채움)에 배선.
- **명명 최종화**: `askPeakIntraMax`·`*_max` 등 — plan에서 일관 family로 확정(글로서리 peak/고점 예약 준수).

## Out of Scope (Backlog)

- 매수 최대벽(bid peak wall) 및 그 Intra-Bar Max 변종.
- 종가·최댓값 동시 표시(오버레이/밴드).
- 체결강도의 분봉 내 순간 강도 재해석.
- 오늘 봉 ask-peak의 라이브 정밀 close/max 이중 추적(현재는 토글 무효 수용).
