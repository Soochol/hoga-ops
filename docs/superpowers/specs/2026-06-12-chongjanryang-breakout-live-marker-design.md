# 총잔량 돌파 시그널 — /live 총잔량 지표 위 마커 표시 — Design

**Date**: 2026-06-12
**Status**: Draft
**Scope**: `frontend/src/chart/breakout/detectBreakouts.ts`(신규 순수 감지), `frontend/src/chart/projectors/quoteTotals.ts`(총잔량 패널 — 마커 부착), `frontend/src/chart/RangeSeriesPane.tsx`(마커 라이프사이클 seam), `frontend/src/state/chartPrefs.ts`(margin 설정)

> 알고리즘 본체·백엔드 전체 설계는 자매 스펙
> [`2026-06-12-chongjanryang-peak-breakout-design.md`](./2026-06-12-chongjanryang-peak-breakout-design.md).
> **이 스펙은 그 알고리즘을 /live 총잔량 지표 위에 마커로 띄우는 "평가-우선(frontend-computed)" 슬라이스**다.

## Problem

사용자 표현:

> "live page에 총잔량 지표에 표현하도록 … 내가 여러 종목 돌려보면서 평가해볼게."

확정된 돌파 알고리즘(아래 §Algorithm)을 **실제 /live 화면의 총잔량 패널 위에 시각적 마커**로 띄워서,
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
- **경매(동시호가) 마스킹**: 총잔량 라인은 `isAuctionHidden`/`maskOutgoingConnector`로 경매 구간을
  숨긴다. 근거: [quoteTotals.ts](../../../frontend/src/chart/projectors/quoteTotals.ts).
- **DESIGN.md 토큰**: 모든 색·모양은 디자인 시스템 토큰을 따른다.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| 총잔량 시계열 단일 출처 | preserves | 마커는 패널이 그리는 *바로 그* `quote_ratio.points`에서 계산 → 라인과 항상 정렬 |
| 패널 레지스트리 단일 진실원 | preserves | 새 패널을 추가하지 않음. 기존 `quote-totals` 패널의 시리즈에 마커만 부착 |
| 색 규약(KRX) | preserves | 매도 마커=파랑 계열 시리즈 위, 매수 마커=빨강 계열 시리즈 위 |
| 경매 마스킹 | preserves (정합 필요) | 감지는 마스킹된 경매 포인트를 running max·발사에서 제외(라인이 숨기는 구간엔 마커도 없음) |
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

`(side ∈ {ask, bid})` 각각 **독립** 트랙. 순수 함수:

```
detectBreakouts(points: QuoteRatioPoint[], margin=0.50, warmupK=3)
  → { ask: Marker[], bid: Marker[] }

각 side(value = ask_total 또는 bid_total)에 대해 시간순:
  running_max = 0
  for i, p in points (경매-마스킹 포인트 skip):
    v = p[side]
    if i ≥ warmupK and running_max > 0 and v > running_max * (1 + margin):
        emit marker(t=p.t, prev=running_max, pct=v/running_max - 1)
    running_max = max(running_max, v)   # 래칫
```

- **마진이 곧 디바운스**: 발사 후 running_max가 v로 올라가 다음 발사는 더 높은 고가를 또 +margin 초과해야 함.
- **무파라미터 일반화**: margin은 비율이라 종목 규모(검증: 3,895~514,127, 130배)에 자동 적응 — 종목별 설정 불필요.
- 검증된 빈도: margin 0.50 → 종목당 ~2건/일, 조용한 날 0건.

### 마커 렌더 (lightweight-charts v5)

- `quote-totals` 패널의 **ask 시리즈(파랑)** 에 매도 돌파 마커, **bid 시리즈(빨강)** 에 매수 돌파 마커를
  v5 시리즈 마커 API(`createSeriesMarkers(series, markers)`)로 부착.
- 마커 1개: `{ time, position: 'aboveBar', shape: 'arrowDown'|'circle', color: <token>, text: '+{pct}%' }`.
  매도=파랑 라인 위, 매수=빨강 라인 위 — 색·텍스트는 DESIGN.md 토큰.
- 마커 `time`은 패널과 동일한 `VirtualAxis` 투영 좌표를 써서 라인과 정확히 정렬.

### 배선 (seam)

- **신규 순수 모듈** `chart/breakout/detectBreakouts.ts` — 입력 `QuoteRatioPoint[]`+margin, 출력 마커.
  lightweight-charts 비의존(좌표 투영은 호출부에서). 단위 테스트 대상.
- `quoteTotals.ts`(또는 `RangeSeriesPane` 마커 seam)에서, 패널이 받은 동일 `points`로
  `detectBreakouts` 호출 → ask/bid 시리즈에 마커 set. 시리즈 재생성 라이프사이클(파괴/재추가)과
  같은 effect에 묶어 leak·stale 마커 방지(기존 LineSeries 라이프사이클 패턴 재사용).
- **실시간 갱신**: points가 갱신될 때 마커 재계산(≤수천 포인트라 full 재계산으로 충분). 동일 입력→동일 마커(결정론적).
- **margin 설정**: `chartPrefs`에 `breakoutMargin`(기본 0.50) 추가, 평가용 컨트롤 노출(후속 — 우선 상수 0.50로 시작 가능).

## Testing

### Unit tests (`detectBreakouts` — 순수)

| Case | Setup | Expected |
|------|-------|----------|
| 단순 돌파 | ask: 100…(래칫)→160(+60%) | ask 마커 1개, pct=60% |
| 마진 미달 | ask peak 100, v=140(+40%, margin .5) | 마커 0 |
| 래칫 디바운스 | 100→170(발사,래칫)→200(<170×1.5) | 마커 1개만 |
| 연속 에스컬레이션 | 100→160(발사)→250(=160×1.56) | 마커 2개 |
| ask/bid 독립 | ask 돌파, bid 평탄 | ask만 마커, bid 0 |
| 워밍업 | 첫 3포인트 큰 값 | 발사 0(래칫만) |
| 경매 마스킹 | 경매구간 포인트 포함 | 마스킹 포인트는 running max·발사 제외 |
| margin 손잡이 | 같은 시퀀스 margin 0.2 vs 0.8 | 발사 수 단조 감소 |

**Invariant 회귀**: 래칫 단조성(running_max 비감소) 프로퍼티 테스트.

### Manual verification (/live)

- /live에서 종목 전환 → 그 종목 총잔량 라인 위에 매도/매수 마커가 직전 고가 +50% 돌파 지점에 뜬다.
- 라이브 틱 유입 시 새 돌파에 마커가 실시간 추가된다.
- 경매 구간(숨긴 구간)엔 마커가 없다.
- margin을 바꾸면 마커 밀도가 바뀐다(평가 손잡이).

## Risks / Open questions

- **v5 마커 API 정합**: 코드베이스 테스트가 `series.setMarkers`를 목킹 → 실제 v5는 `createSeriesMarkers`.
  구현 시 실제 API 확인(둘 다 v5에 존재 가능).
- **마커 과밀**: 활발한 종목·낮은 margin에서 마커가 겹칠 수 있음 — 텍스트 라벨은 큰 돌파에만, 작은 건 점만 등 표시 정책은 평가 후 정함.
- **past-cache vs live 경계**: `quote_ratio.points`가 과거캐시+라이브를 합치는 경계에서 running max 연속성 확인(자매 스펙의 시딩과 동일 정신, 여기선 패널 범위 내 데이터로 계산).
- **평가→프로덕션 이행**: 동일 `detectBreakouts` 순수 로직을 백엔드 감지기와 공유(또는 포팅)해 평가와 프로덕션 신호가 일치하도록.

## Out of Scope (Backlog)

- 백엔드 감지기 + 관심종목 전체 + 알림 피드/토스트/소리/로그 (자매 스펙 Phase 1/2).
- margin 외 전략(돌출도·급등)을 마커 토글로 비교 (평가 확장).
- 종목·그룹별 margin 오버라이드.
