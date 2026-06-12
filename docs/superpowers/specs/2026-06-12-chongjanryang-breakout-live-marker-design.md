# 총잔량 급증(Quote Totals Surge) — /live 총잔량 지표 위 마커 표시 — Design

**Date**: 2026-06-12
**Status**: Draft
**Scope**: `frontend/src/chart/surge/detectSurges.ts`(신규 순수 감지), `frontend/src/chart/projectors/quoteTotals.ts`(총잔량 패널 — 마커 부착), `frontend/src/chart/RangeSeriesPane.tsx`(마커 라이프사이클 seam), `frontend/src/state/chartPrefs.ts`(`surgeMarkerEnabled`·`surgeMargin`), `frontend/src/live/LiveWorkarea.tsx`+신규 좌측 설정 패널(모달 `LiveSettingsModal` 교체)

> 용어: 이 기능의 신호는 **총잔량 급증(Quote Totals Surge)** — CONTEXT.md 등재. "돌파/Breakout"은 Screener
> EOD 신고가 조건 전용이라 재사용하지 않는다(realm 충돌 회피).

> 알고리즘 본체·백엔드 전체 설계는 자매 스펙
> [`2026-06-12-chongjanryang-peak-breakout-design.md`](./2026-06-12-chongjanryang-peak-breakout-design.md).
> **이 스펙은 그 알고리즘을 /live 총잔량 지표 위에 마커로 띄우는 "평가-우선(frontend-computed)" 슬라이스**다.

## Problem

사용자 표현:

> "live page에 총잔량 지표에 표현하도록 … 내가 여러 종목 돌려보면서 평가해볼게."

확정된 급증 알고리즘(아래 §Algorithm)을 **실제 /live 화면의 총잔량 패널 위에 시각적 마커**로 띄워서,
사용자가 종목을 바꿔가며 신호 품질을 **직접 눈으로 평가**할 수 있게 한다. 전용 알림 피드·백엔드
폴러 등 무거운 인프라(자매 스펙 Phase 1/2)는 아직 필요 없다 — 프론트가 이미 총잔량 시계열을
갖고 있으므로 **클라이언트에서 계산해 그 자리에 찍는다**.

## Invariants

- **총잔량 시계열 단일 출처**: /live 총잔량 패널은 `RangeBundle.quote_ratio.points`
  (`QuoteRatioPoint = { t, bid_total, ask_total }`)를 `quoteTotals` 프로젝터로 그린다.
  근거: [quoteTotals.ts](../../../frontend/src/chart/projectors/quoteTotals.ts),
  [api/types.ts:31](../../../frontend/src/api/types.ts).
- **패널 레지스트리 = 단일 진실원**: 차트 패널은 `PANE_SPECS`에 등록된 `BoundPaneSpec`만 렌더된다.
  근거: [paneSpecs.ts:40](../../../frontend/src/chart/paneSpecs.ts).
- **색 규약(KRX)**: 매수=빨강(`--price-up`), 매도=파랑(`--price-down`).
  근거: [quoteTotals.ts:15](../../../frontend/src/chart/projectors/quoteTotals.ts).
- **경매(동시호가) 마스킹**: 총잔량 라인은 `inClosingAuctionWindow`(`isAuctionHidden`)로 **마감** 동시호가
  (15:20–15:30)만 숨긴다(개장 동시호가는 데이터에 없음). 근거: [auctionHide.ts](../../../frontend/src/chart/util/auctionHide.ts), ADR-0029.
- **RangeBundle 멀티데이 concat**: `quote_ratio.points`는 과거 팬 시 여러 **Stock-Date**를 concat하며,
  `segments[*]`가 각 날 `session_open_ms`/`session_close_ms`를 싣는다. 근거: CONTEXT.md `RangeBundle`.
- **Past/Today Split Cache(성능)**: 인디케이터 패널은 매 틱 전체 재투영 금지 — 과거 동결 + 오늘만 재계산
  (byte-identity). 근거: CONTEXT.md `Past/Today Split Cache`(#56 P0).
- **DESIGN.md 토큰**: 모든 색·모양은 디자인 시스템 토큰을 따른다.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| 총잔량 시계열 단일 출처 | preserves | 마커는 패널이 그리는 *바로 그* `quote_ratio.points`에서 계산 → 라인과 항상 정렬 |
| 패널 레지스트리 단일 진실원 | preserves | 새 패널을 추가하지 않음. 기존 `quote-totals` 패널의 시리즈에 마커만 부착 |
| 색 규약(KRX) | preserves | 매도 마커=파랑 계열 시리즈 위, 매수 마커=빨강 계열 시리즈 위 |
| 경매 마스킹 | preserves | 마감 동시호가(15:20–15:30)는 발사·peak갱신에서 항상 제외 — 시각 마스크 토글과 무관(누적은 급증 아님) |
| RangeBundle 멀티데이 concat | preserves | running peak를 `segments` 세션 경계마다 0 리셋 → 날짜별 독립 마커 |
| Past/Today Split Cache(성능) | preserves | 세션별 마커가 그 세션에만 의존 → 과거 동결 + 오늘만 재계산. 전체 재계산 금지 |
| DESIGN.md 토큰 | preserves | 마커 색·텍스트는 토큰 사용, 임의 색 금지 |

## Goals

- /live 총잔량 패널에서, 보고 있는 종목의 **매도/매수총잔량이 직전 고가를 +margin(기본 50%) 초과하는
  순간**에 해당 라인 위 마커를 표시.
- **종목 전환 시 자동 재계산** — 사용자가 /live에서 종목을 바꾸면 그 종목의 `quote_ratio.points`로 즉시
  마커 갱신. (= "여러 종목 돌려보며 평가")
- **실시간** — 라이브 틱이 들어오면 마커도 따라 갱신.
- **평가용 손잡이**: `margin`을 chartPrefs로 노출(기본 0.50)해 사용자가 감도를 바꿔가며 평가 가능.
- 감지 로직은 **순수 함수 + 단위 테스트**(자매 스펙 알고리즘과 동일).

## Non-Goals

- 백엔드 BreakoutDetector·관심종목 전체 폴러·전용 알림 피드·토스트·소리·이벤트 로그 — 자매 스펙 Phase 1/2.
  이 슬라이스는 **보고 있는 단일 종목**의 총잔량 위 마커까지만.
- 멀티데이 peak — 당일 패널 데이터 범위만.
- 총잔량 외 지표(호가비·체결강도) 마커.

## Design

### Algorithm (확정 — 자매 스펙 §Validation에서 도출)

> **v0.7.26.0 변경(사용자 요청)**: 트리거를 "직전 고가 +margin **초과**"(아래 설명)에서 → "직전 고가의
> **근접 문턱(기본 95%) 재도달 + 재무장 문턱(기본 85%) 히스테리시스**"로 바꿨다. 설정도 단일 `surgeMarginPct`
> → `surgeApproachPct`(95)+`surgeRearmPct`(85). 의도: 초과 방식이 놓치던 *완만한 빌드업*을 잡기(벽이
> 자기 고가에 다시 도전하는 순간). 트레이드오프: 마커 대폭 증가 + disarm 후 폭발적 신고가 미발사 가능
> (한 종목 차트엔 적합, 문턱으로 조절). 코어=`detectSurgeSide`(running peak + armed). CHANGELOG 0.7.26.0
> 참조. 아래 "초과" 설명은 0.7.25.0 기준(역사적).

`(side ∈ {ask, bid})` 각각 **독립** 트랙. 순수 함수:

```
detectSurgeSide(points: QuoteRatioPoint[], side, { margin=0.50, isClosingAuction })
  → Marker[]            # side별로 호출(detectSurges는 양 side wrapper)

running_max = 0; cur_day = NaN
for p in points (시간순):
    day = ⌊(p.t + 9h) / 24h⌋            # KST 거래일
    if day != cur_day:                   # ← 거래일(세션) 경계 자기-리셋 (멀티데이 정확성)
        cur_day = day; running_max = 0
    if isClosingAuction(p.t):            # ← 마감 동시호가(15:20–15:30) 항상 제외(토글 무관)
        continue
    v = p[side]
    if running_max > 0 and v > running_max * (1 + margin):
        emit marker(t=p.t, prev=running_max, pct=v/running_max - 1)
    running_max = max(running_max, v)   # 래칫
```

- **거래일 경계 self-reset (필수)**: `quote_ratio.points`는 과거 팬 시 여러 **Stock-Date**를 concat한다
  (RangeBundle). running_max를 **거래일(KST 날짜)마다 0으로 리셋**해 전일의 큰 벽이 오늘 기준이 되는 오염을
  막는다. sessionOpens를 따로 받지 않고 점의 `t`에서 날짜를 도출 → 어느 청크(과거/당일)든 자기-완결적으로
  리셋 → **각 거래일 마커가 그 거래일 점에만 의존** → Past/Today Split Cache의 `cachedPast++today===all`
  불변식 성립(아래 §배선). 마커는 보이는 모든 날에 찍히되 날짜별 독립.
- **워밍업 불필요**: running_max=0에서 시작 → 세션 첫 관측은 비교 대상이 없어(`running_max > 0` 가드) 발사
  불가, 단지 래칫만. 즉 마진 방식이 "첫 관측 가짜 발사"를 구조적으로 막아 별도 warmup 카운터가 필요 없다.
- **마진이 곧 디바운스**: 발사 후 running_max가 v로 올라가 다음 발사는 더 높은 고가를 또 +margin 초과해야 함.
- **무파라미터 일반화**: margin은 비율이라 종목 규모(검증: 3,895~514,127, 130배)에 자동 적응 — 종목별 설정 불필요.
- 검증된 빈도: margin 0.50 → 종목당 ~2건/일, 조용한 날 0건.

### 마커 렌더 (lightweight-charts v5)

- `quote-totals` 패널의 **ask 시리즈(파랑)** 에 매도 급증 마커, **bid 시리즈(빨강)** 에 매수 급증 마커를
  v5 시리즈 마커 API(`createSeriesMarkers(series, markers)`)로 부착.
- 마커 1개: `{ time, position: 'aboveBar', shape: 'arrowDown'|'circle', color: <token>, text: '+{pct}%' }`.
  매도=파랑 라인 위, 매수=빨강 라인 위 — 색·텍스트는 DESIGN.md 토큰.
- 마커 `time`은 패널과 동일한 `VirtualAxis` 투영 좌표를 써서 라인과 정확히 정렬.

### 배선 (seam)

- **신규 순수 모듈** `chart/surge/detectSurges.ts` — 입력 `QuoteRatioPoint[]`+`{margin, isClosingAuction}`,
  출력 마커. `detectSurgeSide(points, side, opts)`(per-side, 거래일 self-reset) + `detectSurges`(양 side wrapper).
  lightweight-charts 비의존(좌표 투영은 호출부). 단위 테스트 대상.
- `RangeSeriesPane`에 선택적 `markers` 프로젝터 seam 추가(lwc v5 `createSeriesMarkers`); `quoteTotals.ts`의
  ask/bid 시리즈가 그 seam에 마커 프로젝터를 단다. 시리즈 라이프사이클(생성/파괴)과 같은 effect에 묶어
  leak·stale 방지(기존 LineSeries 패턴 재사용).
- **실시간 갱신 (Past/Today Split 준수 — 구현 완료)**: 마커 프로젝터를 라인과 **동일한 `makePastCachedProjector`
  seam**에 태운다(per-side). 거래일 self-reset이라 각 거래일 마커가 그 거래일 점에만 의존 →
  `cachedPast++today===all` 성립 → 과거 동결 + 당일만 재계산. **검증(perf G)**: seam 캐시경로 ~0.13ms(깊이
  무관) vs 전구간 재계산 90일 3.15ms → **25× 절감**, #56 P0 불변식 유지. (초기 평가-우선 구현은 전구간
  재계산이었으나 perf 게이트에서 6.17ms/틱(지배 항) 확인 후 seam 라우팅으로 전환.)
  동일 입력→동일 마커(결정론적).
- **margin 설정**: `chartPrefs`(ChartViewPrefs)에 `surgeMargin`(기본 0.50) 추가, 아래 사이드 메뉴에 노출.

### 라이브 설정 사이드 메뉴 (모달 → 좌측 접이식 패널)

현재 `LiveSettingsModal`(모달)을 **`LiveWorkarea` 좌측의 접이식 패널**로 교체한다. 급증 컨트롤이 들어갈
구조적 집(home)이자, 설정 항목 증가에 대비한 UX 정비.

- **레이아웃**: `LiveWorkarea`(현재 `flex`: 차트 + 우측 `LiveSidebar`)의 **좌측에 aside 추가**. 기본 **닫힘**;
  툴바 "설정" 버튼이 모달 대신 이 패널을 연다(`LivePage`의 `settingsOpen` 상태 재사용). 열리면 차트를
  밀어(push, 우측 사이드바와 대칭) 폭 확보 — lwc 리사이즈는 기존 패턴.
- **레지스트리 기반 카테고리 섹션**: 패널은 `CHART_TOGGLES`의 `category`로 섹션을 자동 구성한다(현재
  `'chart'`·`'indicators'` 이미 존재; 모달이 `'chart'`만 노출하던 것을 패널은 **전 카테고리**를 섹션으로
  렌더). `enabledBy` numeric pref는 부모 토글 아래 들여쓰기(모달 규칙 그대로 이식).
- **급증 신호 섹션**: 새 `category: 'surge'` 1개로 그룹 — 토글 `surgeMarkerEnabled`(기본 ON, `CHART_TOGGLES`
  1줄) + numeric `surgeMargin`(기본 0.50, 범위 0.30~1.00, `CHART_NUMERIC_PREFS` 1줄, `enabledBy: surgeMarkerEnabled`).
  즉 마커 표시·감도가 이 섹션에서 제어된다.
- **불변식 보존**: 설정은 여전히 **레지스트리가 단일 진실원** — 항목 추가 = 레지스트리 1줄(모달이든 패널이든
  동일 데이터). 모달 테스트(`LiveSettingsModal.test`)는 패널 테스트로 이관.

> **UI 재사용(사용자 확정)**: 패널 내부는 **기존 보조지표 설정 UI를 그대로** 쓴다 — 모달의 토글 행/
> numeric 입력/카테고리 그룹 컴포넌트를 신규 디자인 없이 좌측 패널로 이식. 새로 만드는 건 *패널 셸*
> (좌측 aside + 열기/닫기)뿐. 급증 섹션도 같은 토글/numeric 행 컴포넌트를 쓴다.
> 범위 주의: 이 사이드 메뉴는 *모든* 라이브 설정을 옮기는 UX 정비라 급증 기능보다 넓다(급증이 트리거).

## Testing

### Unit tests (`detectSurges` — 순수)

| Case | Setup | Expected |
|------|-------|----------|
| 단순 급증 | ask: 100…(래칫)→160(+60%) | ask 마커 1개, pct=60% |
| 마진 미달 | ask peak 100, v=140(+40%, margin .5) | 마커 0 |
| 래칫 디바운스 | 100→170(발사,래칫)→200(<170×1.5) | 마커 1개만 |
| 연속 에스컬레이션 | 100→160(발사)→250(=160×1.56) | 마커 2개 |
| ask/bid 독립 | ask 급증, bid 평탄 | ask만 마커, bid 0 |
| 첫 관측 무발사 | 세션 첫 포인트가 큰 값 | running_max=0 가드로 발사 0(래칫만; warmup 불필요) |
| 멀티데이 리셋 | 2세션 concat, 전일 peak 300 / 당일 v=200 | 당일 마커 0(전일 peak 비교 안 함); 세션마다 독립 |
| 마감 동시호가 제외 | 15:20–15:30 누적 큰 값 포함 | 그 구간 발사·peak갱신 0(toggle 무관) |
| 과거 동결 정합 | 과거 세그먼트 마커 == full 계산의 해당 구간 | byte-identity(Split Cache) |
| margin 손잡이 | 같은 시퀀스 margin 0.2 vs 0.8 | 발사 수 단조 감소 |

**Invariant 회귀**: ① 래칫 단조성(running_max 비감소·세션 내) ② 과거동결 == full(`frozen ++ today === all`) 프로퍼티 테스트.

### Manual verification (/live)

- /live에서 종목 전환 → 그 종목 총잔량 라인 위에 매도/매수 마커가 직전 고가 +50% 급증 지점에 뜬다.
- 라이브 틱 유입 시 새 급증에 마커가 실시간 추가된다.
- 경매 구간(숨긴 구간)엔 마커가 없다.
- margin을 바꾸면 마커 밀도가 바뀐다(평가 손잡이).

## Risks / Open questions

- **v5 마커 API 정합**: 코드베이스 테스트가 `series.setMarkers`를 목킹 → 실제 v5는 `createSeriesMarkers`.
  구현 시 실제 API 확인(둘 다 v5에 존재 가능).
- **마커 과밀**: 활발한 종목·낮은 margin에서 마커가 겹칠 수 있음 — 텍스트 라벨은 큰 급증에만, 작은 건 점만 등 표시 정책은 평가 후 정함.
- **past-cache vs live 경계**: `quote_ratio.points`가 과거캐시+라이브를 합치는 경계에서 running max 연속성 확인(자매 스펙의 시딩과 동일 정신, 여기선 패널 범위 내 데이터로 계산).
- **평가→프로덕션 이행**: 동일 `detectSurges` 순수 로직을 백엔드 감지기와 공유(또는 포팅)해 평가와 프로덕션 신호가 일치하도록.

## Out of Scope (Backlog)

- 백엔드 감지기 + 관심종목 전체 + 알림 피드/토스트/소리/로그 (자매 스펙 Phase 1/2).
- margin 외 전략(돌출도·급등)을 마커 토글로 비교 (평가 확장).
- 종목·그룹별 margin 오버라이드.
