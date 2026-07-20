# 단별 잔량 증감 지표 (Depth Delta Heatmap) 설계

날짜: 2026-07-20
상태: **구현 완료** (v1 — 오늘/분봉 전용). 아래 본문은 구현된 내용으로 갱신됨.
선행: 호가 잔량 히트맵 #490 · ADR-0062 v3 (동시호가 배제 공용 술어) · ADR-0118 (키움 WS 전담)

## 1. 목표와 비목표

**목표**: 10호가 각 가격 단에 잔량이 얼마나 새로 들어오고(유입) 빠졌는지(유출)를
가격×시간 격자로 보여주는 신규 지표. 기존 잔량 히트맵이 "지금 얼마나 쌓여 있나"(상태)를
보여준다면, 이 지표는 "언제 얼마나 들어오고 빠졌나"(흐름)를 보여준다 — 벽의 형성·철수
타이밍이 목적.

**비목표 (v1)**:
- 과거일 표시 — `RangeBundle`에 증감 소스가 없다 (§5). v1은 오늘(라이브) 전용
  (`all_peaks` 선례와 동일한 라이브 전용 지표).
- 취소 vs 체결소진 분해 — 0B 체결 스트림 차감이 필요한 v2 확장 (§8).
- D/W/M 표시 — 소스가 분봉 버킷이므로 기존 히트맵과 동일하게 분봉 전용.

## 2. 데이터 원천과 델타의 정의

키움 WS `0D`는 **증분이 아니라 전체 스냅샷**이다(가격 41-60 · 잔량 61-80 · 총잔량
121/125, `kiwoom_frames._parse_orderbook`). 증감은 클라이언트가 연속 스냅샷을 diff해서
만든다.

**diff 규칙** — 연속된 두 eligible 스냅샷 (prev, cur)에 대해:

1. **side별 분리 diff**: `prev.asks ∩ cur.asks`, `prev.bids ∩ cur.bids`를 각각
   가격 키로 매칭해 `Δqty(price) = cur.qty − prev.qty`. side를 합치면 현재가 이동 시
   같은 가격이 ask→bid로 넘어간 것(전혀 다른 주문들)을 연속으로 오인한다.
2. **가격 교집합만 diff**: 한쪽 스냅샷에만 있는 가격은 delta 없음. 10단 관측창이
   현재가를 따라 미끄러질 때 창에 들어오고 나가는 가격의 qty 변화는 주문 변화가 아니라
   **관측창 이동 아티팩트**다 — 이를 증감으로 계산하면 현재가가 한 틱 움직일 때마다
   거대한 가짜 유입/유출이 찍힌다. 교집합 규칙이 이를 구조적으로 배제한다.
3. **diff 체인 리셋** (prev := null): 다음 중 하나를 만나면 체인을 끊는다.
   - ineligible 스냅샷 (`isIndicatorEligibleBook` 실패 — 동시호가·3호가 붕괴·09:00 이전,
     ADR-0062 v3 공용 술어). VI 전후처럼 배제 구간을 건너뛴 diff는 창 이동이 커서
     아티팩트 위험이 크므로 건너뛰지 않고 끊는다.
   - venue 변경 (`ObSnapshot.venue` KRX↔NXT, #524 시분할) — 다른 거래소 호가장끼리의
     diff는 무의미.
   - `lastContinuousMs` 초과 (종가 동시호가 진입) · totals-only 스냅샷(asks/bids 부재).

## 3. 버킷 집계

캔들 x축 정렬을 위해 분봉 버킷(`bucketStartMs`, `aggregateCandles` 관용구)으로 집계한다.
delta pair (prev@t1, cur@t2)는 **cur의 버킷(t2)에 귀속** (변화가 관측된 시각).

버킷별·가격별로 gross 두 값을 유지한다:

- `inQty = Σ max(Δ, 0)` (유입 총량)
- `outQty = Σ |min(Δ, 0)|` (유출 총량, **양수 크기**로 보관)
- `net = inQty − outQty` (`netDeltaQty()`, 렌더 색상·강도 기준)

구현 정정: 설계 초안은 `out`을 음수로 보관했으나, 구현은 **둘 다 양수 크기**로 둔다. 부호를
값에 실으면 포매터·색 선택이 각자 부호를 재해석하다 어긋나므로, 부호 유도를 `netDeltaQty()`
한 곳으로 모았다.

net만 들면 "많이 들어오고 많이 빠진 공방 구간"과 "조용한 구간"이 구분되지 않는다.
gross는 레전드·툴팁에서 노출하고 셀 색은 net으로 그린다.

**도메인 포인트** (히트맵 `DepthHeatmapPoint` 동형):

```ts
type DepthDeltaLevel = { price: number; in: number; out: number }; // out ≤ 0
type DepthDeltaPoint = { tMs: number; asks: DepthDeltaLevel[]; bids: DepthDeltaLevel[] };
```

## 4. 계산 파이프라인 — 오라클 + 증분 미러

기존 표준(ADR-0106, `bucketDepthHeatmap` ↔ `IncrementalHogaBucketer`)을 그대로 따른다:

- **오라클**: `bucketDepthDelta(ob, bucketMs, sessionCloseMs): DepthDeltaPoint[]` —
  stateless 일괄 계산. fixture 완전 테스트 가능.
- **증분**: `IncrementalHogaBucketer`에 delta 상태를 추가한다 (별도 클래스 신설보다
  기존 append/reset 파이프 재사용). 추가 상태: `prevEligibleOb: ObSnapshot | null`
  (venue 포함), `deltaByBucket: Map<number, DepthDeltaPoint>`, `deltaOrder: number[]`.
- **오라클 대조 테스트**: 같은 입력에서 배치 == 증분 (기존 depth/quote 대조 테스트와
  나란히). reset 경로(비단조 델타·bucketMs 변경)도 오라클과 동일 결과여야 한다.
- ⚠️ **안정 참조 불변식**: 틱이 실제로 바꾼 버킷만 새 point 객체로 교체, 내부 배열
  in-place mutate 금지 — 하류 WeakMap 캐시(`depthHeatmapWire` 관용구)가 의존한다.

비용: 스냅샷당 O(20) 맵 조회 + 버킷당 가격 수십 개. 기존 히트맵과 동급.

`buildLiveBundle` 산출에 `depth_delta_today: DepthDeltaPoint[]` 필드 추가.

## 5. 과거일 (v1 제외, 선택지 기록)

`RangeBundle.depth_heatmap`은 분봉당 close/max 스냅샷만 있어 인트라분 증감이 소실된다.

- **(a) 백엔드 집계** (v2 권장): 캡처 parquet의 raw 스냅샷에서 §2 규칙으로 집계해
  `depth_delta`를 서빙. 정확(gross 포함)하지만 캡처 게이트(ADR-0115) 통과 종목만 데이터
  존재.
- **(b) 프론트 close-to-close 근사**: 분봉 close 스냅샷끼리 diff. net 근사만 가능,
  gross 소실, 분 단위 창 이동으로 교집합이 얇아짐. 싸지만 오늘과 정밀도가 달라
  같은 지표처럼 보이면 오독 위험 → 채택하지 않음.

v1은 오늘 전용으로 출시하고, 과거일은 (a)로 후속.

## 6. 렌더링

- **`DepthHeatmapPrimitive` 재사용**: 셀 모델 `{tMs, price, color}`이 동일하다.
  신규 primitive 불필요 — `DepthDeltaOverlay`는 셀 빌더만 다르게 해서 primitive를
  한 벌 더 장착한다 (캔들 pane, 기존 히트맵보다 위 z-order, 독립 토글).
- **색**: net>0 → 유입 색, net<0 → 유출 색 (기본값은 DESIGN.md 토큰에서 선정, 색상
  팝오버로 사용자 변경 — 기존 히트맵 bid/ask 색 UI와 대칭). side(매도/매수 벽)는
  가격의 현재가 대비 위치가 이미 말해주므로 색은 증/감 2색이면 충분하다.
- **정규화**: `alpha = maxOpacity · (|net| / visibleMaxAbsDelta)^0.65` —
  `levelAlpha`/`visibleMaxQty` 동형의 `visibleMaxAbsDelta` (가시범위 내 max|net|).
- **레전드**: `flagLegendValueRegistry`에 크로스헤어 시점 셀 값 등록
  (예: `70,500 +5,000 / −2,300`). ⚠️ 값 레지스트리는 비반응형 필수.

## 7. 설정·등록 (지표 7종 + 히트맵 패턴)

`liveIndicatorsPersistence` v1 코어서에 필드 추가 → v2 sparse 버킷(공장 diff)에 자동
편입:

| 키 | 공장값 | 비고 |
|---|---|---|
| `depthDeltaEnabled` | `false` | 마스터 토글 (#697 공장 off 원칙) |
| `depthDeltaHidden` | `false` | 눈 아이콘 |
| `depthDeltaInColor` / `depthDeltaOutColor` | DESIGN.md 토큰 | hex 검증 재사용 |
| `depthDeltaMaxOpacity` | 히트맵과 동일 기본 | 범위 검증 재사용 |

- 드로어 UI: `WorkspaceIndicatorDrawer` 히트맵 섹션 바로 아래 대칭 배치 (색 팝오버·
  불투명도 슬라이더 컴포넌트 재사용).
- 워크스페이스: 구독은 `useWindowIndicator` 리프 격리 (셸 구독 = 재렌더 루프 함정).
- per-timeframe: v2 버킷이 자동 처리. 분봉 전용이므로 D/W/M에서는 오버레이 미장착
  (`shouldShowDepthHeatmapOverlay` 동형 술어).

## 8. v2+ 확장 (이번 범위 아님)

- **취소 vs 체결소진 분해**: 감소분 |Δ|에서 [t1,t2] 구간 해당 가격의 0B 체결량 F를
  차감 → 취소 추정 = max(|Δ|−F, 0). best 호가 밖 깊은 단의 감소는 체결이 불가능하므로
  대부분 취소/정정이라는 구조적 힌트도 함께 사용. 순액 관측 한계(같은 구간에 신규 유입
  +체결이 겹치면 상쇄됨)는 명시적으로 문서화.
- **사이드바 호가창 증감 뱃지**: 최신 스냅샷 옆에 최근 N초 증감 페이드 표시.
- **과거일 백엔드 `depth_delta`** (§5a).

## 8.5 구현 결과 (2026-07-20)

설계 대비 확정·변경된 사항:

| 항목 | 설계안 | 구현 |
|---|---|---|
| 데이터 경로 | 미정 | **wire 왕복 없음** — 오늘 전용이라 `useLiveBundle().depthDeltaToday`로 도메인 직결. RangeBundle·rangeRequest·sidecar 플래그 전부 무변경 |
| `out` 부호 | 음수 | 양수 크기 (§3 정정) |
| 오라클/증분 공유 | 미정 | diff **규칙**(`foldLevelDiff`)만 공유, 버킷 순회는 각자 구현 — 패리티 테스트가 동어반복이 되지 않게 |
| 기본 색 | DESIGN.md에서 선정 | 유입 `#0D9488`(teal-600) / 유출 `#C026D3`(fuchsia-600), α 0.55 |
| zOrder | 히트맵 위 | `'bottom'` — 히트맵과 같음. 히트맵보다 위는 **부착 순서**로 달성 |
| 셀 높이 | (미고려) | `DepthDeltaPoint.askTick`/`bidTick` — 사다리 간격 **중앙값**을 쪽별로 전달 |
| 커버리지 | "오늘" | `depthDeltaSession` 누적 필요 — 소스 버퍼가 15분 시간창이라 (§9.5-4) |
| 설정 UI | WorkspaceIndicatorDrawer | 실제 UI는 `IndicatorPanel` → `DepthDeltaConfig.tsx` |

신설: `depthDelta.ts`, `depthDeltaSession.ts`, `depthDeltaAlpha.ts`, `DepthDeltaOverlay.tsx`,
`DepthDeltaConfig.tsx` (+ 테스트 3종). 수정: `buildLiveBundle` · `useLiveBundle` ·
`useLiveChartData` · `ChartWindow` · `LiveChartRoot` · `PaneLegendOverlay` · `legendRows` ·
`peakLegendValues` · `liveIndicatorsPersistence` · `indicatorOps` · `IndicatorPanel` ·
`presetFlags`.

검증: 전체 3,975개 vitest 통과 · `tsc -b` 통과 · `npm run build` 통과.

## 9. PR 분할

1. **PR-1 코어**: `depthDeltaBucket.ts` (diff 규칙 + `bucketDepthDelta` 오라클) +
   `IncrementalHogaBucketer` 확장 + 오라클 대조·체인 리셋·교집합 아티팩트 테스트.
   UI 없음.
2. **PR-2 설정**: 코어서 필드 + FACTORY + 드로어 섹션 + 색/불투명도 UI.
3. **PR-3 렌더**: `DepthDeltaOverlay` + 레전드 + `LiveChartRoot` 배선 +
   `LiveChartRoot.test.tsx` 토글 테스트.
4. **PR-4 후속** (옵션): §8 항목별 개별 PR.

검증: `cd frontend && npx vitest run` 관련 스위트 + `npm run build` + `/browse`로
셀 렌더·크로스헤어 레전드 도그푸딩.

## 9.5 리뷰에서 잡힌 결함 (수정 완료)

다각도 adversarial 리뷰(렌즈별 탐색 → 건당 3중 반증)에서 확정돼 고친 것:

1. **`zOrder: 'normal'` 이 캔들을 덮었다** (high). lightweight-charts 의 `'normal'` 은 "시리즈와
   같은 층"이 아니라 시리즈 paneView **다음에** 그려진다. α 0.55 teal 이 양봉 `#F04452` 위에
   합성되면 `#737070` 무채색이 되어, 호가 흐름이 가장 격렬한 봉에서 하필 등락 색이 사라진다.
   → `'bottom'` 으로 수정. 히트맵보다 위에 오는 것은 zOrder 가 아니라 **부착 순서**로 달성된다
   (같은 zOrder 안에서는 `attachPrimitive` 순서 = 그리기 순서, 히트맵이 먼저 마운트됨).
   초안 §6 이 "히트맵 대비 적층"만 따지고 "캔들 대비 적층"을 빠뜨린 것이 원인.
2. **설정 문구가 "캔들 뒤"라고 거짓 진술** (high). 1의 하위 증상 — 1을 고치니 문구가 참이 됐다.
3. **셀 높이를 희소 집합에서 역산** (medium). 히트맵은 조밀한 10단 사다리에서 틱을 역산할 수
   있지만, 증감 point 는 **변한 가격만** 남은 희소 집합이다. 한 가격만 변한 버킷은 틱을 못 구해
   0.5 로 폴백(25만원 종목에서 사실상 보이지 않는 셀), 두 가격이 3단 떨어져 변한 버킷은 셀이
   3배로 부풀어 **관측되지 않은 가격까지** 칠했다. → `ladderTick()` 으로 사다리에서 틱을 구해
   `DepthDeltaPoint.tick` 에 싣고 오버레이가 그대로 쓴다.

2차 리뷰(도메인·성능·통합·엣지 4렌즈)에서 추가로 확정돼 고친 것:

4. **커버리지가 "오늘"이 아니라 "최근 15분"이었다** (high, 3표 만장일치). `bucketDepthDelta`
   의 입력 `live.ob` 는 `RETENTION_MS = 15분` 슬라이딩 시간창이다. 히트맵은
   `mergeDepthHeatmapToday` 가 백엔드 range 와 봉합해 하루를 커버하지만 증감은 과거일 소스가
   없어 봉합 상대가 없었다. 결과: 10:30 에 09:05 구간으로 팬하면 셀이 전부 비어 "그때는 증감이
   없었다"로 오독되고, `visibleMaxAbsDelta` 재정규화가 15분마다 농도를 바꿨다.
   → `depthDeltaSession.ts` 신설. **버킷 결과만** 세션 동안 누적한다(원본 스냅샷은 그대로
   버려 메모리는 분당 point 1개). 확정 버킷은 이전 값을 지키고 활성 버킷만 갱신한다 —
   잘려나간 버킷의 축소된 재계산본이 완전값을 덮으면 과거 증감이 시간이 갈수록 줄어들기
   때문. ⚠️ 이 누적은 `IncrementalHogaBucketer` **바깥**에 둔다: 안에 넣으면 "오라클 파리티는
   현재 배열에 대해서만 정의된다"는 계약이 깨진다.
5. **`/study` 의 죽은 컨트롤** (high). /study 는 `depthDeltaToday` 를 넘기지 않아 오버레이가
   영구히 닫히는데, 레전드 행은 `applicable: isMinute` 만 보고 값 없이 렌더됐다.
   → `PaneLegendOverlay` 에 `hasDepthDelta` 를 넘겨 `applicable` 을 마운트 게이트와 같은
   3조건으로 좁혔다. 설정 설명에도 "오늘 구간에서만" 을 명시.
6. **`ladderTick` 이 호가단위 경계에서 셀을 찌그러뜨림** (medium+low). KRX 호가단위는 가격대
   경계(2천/5천/2만/5만/20만/50만)에서 바뀌어, 사다리가 경계를 걸치면 두 간격이 섞인다.
   최솟값을 쓰면 넓은 쪽 셀이 실제 틱의 절반(20만 경계는 1/5) 높이가 돼 줄무늬가 생기고,
   `Math.min` 누적이 그 값을 버킷 내내 고착시켰다. 또 매도·매수를 한 스칼라로 합쳐서, 현재가가
   경계 근처면 한쪽이 항상 찌그러졌다.
   → 간격의 **중앙값**을 쓰고(다수 간격이 이김), `askTick`/`bidTick` 을 분리했으며, 누적은
   최솟값이 아니라 **마지막 관측값**으로 바꿨다.
7. **잔량 감소의 의미** (domain). "유출" 이 체결 소진과 취소·정정을 합친 값이라는 한계를
   설정 설명에 한 문단으로 명시했다(§8 의 v2 분해 작업 전까지의 정직한 고지).

기각된 지적 18건(3중 반증 과반이 반증): 색 토큰 이탈·색각 이상·히트맵 합성색·α 예산 초과·
`formatPriceDelta` 계약·교집합 규칙의 부호 뒤집힘·gross→net 붕괴·셀 전량 재계산 비용·
누적기 메모리·정렬 비용·꺼져 있을 때의 폴드 세금·NaN 오염·거래일 경계 등 — 근거가 사실과
달랐거나 의도된 설계로 판정.

**별도 PR 로 분리**: 레전드 값 provider 레지스트리가 창 스코프가 없어 멀티창에서 다른 종목
값이 표시되는 문제(0/3 반증 = 진짜). 신규 지표가 만든 결함이 아니라 기존 6종이 공유하는
구조라, 한꺼번에 `(windowId, LegendFlagId)` 키로 옮기는 별도 작업으로 뺐다.

## 10. 리스크·함정 체크리스트

- 교집합 규칙 때문에 버킷 순증감의 텔레스코핑(합 = close−close)이 **의도적으로**
  성립하지 않는다 — 테스트에서 이를 동등성 단언으로 쓰지 말 것.
- `bundle.candles` 식별자 churn → 크로스헤어 오버레이 함정 (기존 레퍼런스 준수).
- 애프터마켓 단일가의 4~10단 `-0`(=0)은 백엔드에서 이미 0으로 정규화되나, eligibility
  술어가 어차피 배제한다.
- 기존 히트맵과 동시 on 시 셀 겹침 — z-order 증감 위, 상호 배타 강제는 하지 않음
  (독립 토글 관행). 겹침 가독성이 문제되면 후속에서 히트맵 자동 감쇠 검토.
