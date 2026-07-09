# 보조지표 레전드 (Pane Legend)

**Date:** 2026-05-31
**Scope:** frontend
**Status:** approved (brainstorming + grill)

> **2026-07-09 확장 (전 pane):** 원 스코프의 "분봉 전용 pane 범위 밖"을 되돌려 **모든 pane**
> (총잔량·호가비·체결강도·프로그램매매 추가)에 레전드를 붙였다. 이때 하드코딩된 `LegendRow`
> 열거를 **레지스트리 구동 일반형**으로 전환: 값/라벨/색은 series 정의(`SeriesSpec.legend`),
> ✕ 토글키·제목은 pane 정의(`PaneSpec.legendToggleKey`/`legendTitle`)에 콜로케이션하고,
> 마운트된 series를 `paneLegendRegistry`(RangeSeriesPane→LiveChartRoot 배선)로 등록한다.
> row 방출 게이트는 **레지스트리 존재 + 값 null-omit**로, 토글 상태를 재파생하지 않는다.
> 이후 새 pane은 projector에 `legend`/`legendToggleKey` 메타만 추가하면 레전드가 자동으로 붙는다.

## 배경 / 목적

`/live` 차트의 각 pane 좌상단에 **Pane Legend**(범례)를 추가한다. TradingView 스타일로
각 지표의 이름·색상·**커서 시점 값**을 보여주고, 아이콘으로 지표를 끄거나(✕) 숨긴다(눈).
사용자 제공 이미지 4장이 디자인 명세 — 이동평균선 / 거래량 / Live Investor Net 외국인 /
Live Investor Net 기관.

> **용어**: 새 개념은 **Pane Legend**(복합어). bare "Legend"는 Capture form의 status
> legend(`calendarStatus.ts`)와 충돌하므로 항상 "Pane Legend"로 한정한다(CONTEXT.md 등록).

## 결정 사항 (brainstorming + grill GATE)

| 항목 | 결정 |
|---|---|
| 값 표시 | **커서 따라감** — crosshair hover 시점 값, 커서 없으면 최신값. 모든 pane |
| ✕ 아이콘 | 지표 **끄기** — popover 토글 off와 양방향 연동 |
| 눈 아이콘 (MA만) | MA 선 **일시 숨김**(`movingAverageHidden`) — 설정 유지, 레전드는 남김 |
| 거래량 끄기 | `volumeEnabled`(신규, 기본 on). ✕ → series 숨김(MA 끄기와 동일 방식) |
| 거래량 "(20)" | **무시** — 거래량 값만 표시 |
| MA 값 소스 | **공유 registry 등록** — MA series를 `paneSeries`처럼 등록, 레전드가 그 값 읽기(차트와 일치, drift 없음) |
| 스코프 | MA·거래량·Live Investor Net(외국인/기관, D) 4개 pane. 분봉 전용 pane(호가비·QuoteTotals·FillStrength) 범위 밖 |

## 타입 설계 (신규)

레전드 값은 **명시 타입**으로 들고 다닌다(dict/`Record<string,number>` 금지):

```ts
type LegendMAValue = { id: string; color: string; period: number; value: number | null };
type LegendRow =
  | { paneId: 'candle'; hidden: boolean; mas: LegendMAValue[] }   // mas.length = movingAverages.length (1..8)
  | { paneId: 'volume' | 'investor-foreign' | 'investor-institution'; label: string; value: number | null };
```

- `value: number | null` — null = 커서 시점에 데이터 없음(whitespace point). 절대 untyped dict 아님.
- **MA는 고정 4개가 아니다.** 캔들 pane row는 `store.movingAverages: LiveMAConfig[]`(가변,
  최대 `MA_SLOT_LIMIT=8`, ADR-0046)를 순회 — 슬롯마다 `LegendMAValue` 한 개. `5·20·60·120`은
  `DEFAULT_LIVE_MAS` 시드일 뿐 type-level 불변식이 아니다.
- `PaneLegendOverlay` props: `{ chart: IChartApi; axis: VirtualAxis; cursorMs: number | null; paneSeries: PaneSeriesMap }`
  (값 소스는 registry된 series). MA configs는 store에서 직접 구독.

## 아키텍처

**단일 `PaneLegendOverlay`** (`LiveChartRoot` 마운트):
- pane Y-오프셋은 `chart.panes()[i].getHeight()` 누적으로 계산한다(per-pane HTML 컨테이너는 없다).
  **pane index는 런타임 `paneSpecsForTimeframe(timeframe, toggles)` 결과에서 paneId로 도출** —
  `drawing/chartCoordinates.ts`의 static `paneTopY`/`PANE_ID_TO_INDEX`는 런타임 append되는 투자자
  pane을 몰라(`return 0` fallback → 최상단 오배치) 재사용하지 않는다. 토글 조합(foreign off,
  institution on 등)도 런타임 index로 정확히. 레전드는 차트 위에 절대배치된 단일 HTML 오버레이.
- **crosshair 시간 소스 분리** (Blocker): 현재 `LiveChartRoot`의 `subscribeCrosshairMove`는
  `isMinuteTimeframe` 게이트(ADR-0044, sidebar-spot이 D parquet 없어서)라 D에서 안 발동.
  레전드는 **모든 timeframe에서 커서 시간을 발행**하되 sidebar-spot 진입은 분봉만으로 유지한다
  ("cursor 발행"과 "spot 모드 진입"을 분리). `isMinuteTimeframe` 게이트를 단순 제거하는 것은
  금지(D에서 spot 활성화 → parquet 없음).

## 컴포넌트 / 레전드 내용

각 pane 좌상단, 커서 시점 값(없으면 최신):
| pane | 아이콘 | 내용 |
|---|---|---|
| 캔들 | 👁 ✕ | `이동평균선` + `store.movingAverages` 순회: 슬롯별 [색상 period + SMA 커서값] (가변 개수) |
| 거래량 | ✕ | `거래량` + 거래량 커서값 |
| `investor-foreign`(D) | ✕ | `외국인 순매수량` + 순매수량 커서값 |
| `investor-institution`(D) | ✕ | `기관 순매수량` + 순매수량 커서값 |

- 투자자 pane은 **신규 pane이 아니라 ADR-0055 Live Investor Net pane**(D 전용, 이미
  `paneSpecsForTimeframe`로 마운트). 레전드는 readout row만 얹는다.
- **라벨 일관성**: 투자자 라벨을 `외국인 순매수량`/`기관 순매수량`(수량 명시, ADR-0055의
  수량/금액 disambiguation)으로 통일하고 `IndicatorPanel` CATEGORIES 라벨도 맞춘다.
- 스타일: `DESIGN.md` 토큰. 값 포맷터는 `volume.ts`/`investorNet.ts`에 중복된
  `Math.round(v).toLocaleString('ko-KR')`를 **공유 헬퍼로 추출**해 셋 다 import(세 번째 복사 금지).

## 데이터 흐름

- **정적 메타**: `livePage` store — `movingAverages`(색상/기간), 토글 상태.
- **동적 값 (`param.seriesData`에서 읽기)**: 레전드는 `chart.subscribeCrosshairMove`의
  `param.seriesData`(series ref → 그 시점 데이터 Map)에서 각 series 값을 읽는다 — series별 값이라
  cross-cadence(캔들·investorPoints·거래량 cadence 차이)를 자동 회피한다. 값 추출:
  `d && 'value' in d ? d.value : null`. MA series는 `maSeriesRegistry`로 식별(slot id→series),
  거래량/투자자는 pane primary series(`paneSeries`). 커서 없으면(`param.point==null`) 각 series
  마지막 점. `useLiveCursorStore.cursorMs`는 cursor 발행/sidebar 용도로 유지하되 레전드 값 자체는
  `param.seriesData`에서.
- **recompute 없음**: SMA를 레전드가 다시 계산하지 않는다(차트 series 값과 단일 출처).
- **✕ 클릭** → store 토글 off. popover ↔ 레전드 양방향.
- **눈 클릭** → `movingAverageHidden` 토글.

## 새 상태 (livePage store + persistence)

세 boolean이 "MA 선을 그리나?"를 결정 — 축을 자기설명하게:
`movingAverageEnabled`(master 끄기, ✕, popover-linked) · `cfg.enabled`(슬롯별) ·
`movingAverageHidden`(눈, 일시 숨김). **최종 draw 조건: `movingAverageEnabled && cfg.enabled && !movingAverageHidden`.**

- `volumeEnabled: boolean` (기본 **true**) — merge idiom `obj.volumeEnabled === false ? false : true`
  (movingAverageEnabled 미러). **default-true**라 기존 사용자도 거래량 유지.
- `movingAverageHidden: boolean` (기본 **false**) — merge idiom `obj.movingAverageHidden === true`
  (foreignNetEnabled 미러). default-false.
- **touchpoints (둘 다 업데이트)**: `livePage.ts` `PersistedIndicators` 타입 + `liveIndicatorsPersistence.ts`
  `PersistedIndicators` + `mergeLiveIndicatorPrefs` `build()` + `snapshotIndicators` + 새 setter.
- `IndicatorPanel`: `CategoryId` union에 `'volume'` 추가 + `checkedFor`/`toggleFor`/`CATEGORIES`(active:true).

## 차트 통합

- **거래량 끄기 (중간 pane, index 안전)**: 거래량 pane을 **항상 마운트**하되 `volumeEnabled=false`면
  series를 숨긴다(MA 끄기와 동일). pane을 조건부 제거하면 ratio/quote-totals/fill-strength index가
  밀려 `chartCoordinates.PANE_ID_TO_INDEX`(static) + `DrawingOverlay` pane-binding이 깨지므로
  **mid-array 제거 금지**. (빈 pane이 남는 것은 수용; pane stretch 처리는 plan에서.)
- **MA 숨김**: `applyOptions({ visible: false })`로 숨긴다(현재 `setData([])` 아님). 데이터를
  쿼리 가능하게 남겨 레전드 값이 유지된다(TradingView 방식; registry 읽기와 결합).
- **MA series registry**: `MovingAverageOverlay`의 슬롯 series를 `onPrimarySeriesReady`류 패턴으로
  공유 registry(`paneSeries` 또는 별도 MA registry)에 등록 → 레전드가 slot id로 값을 읽는다.
- **거래량 데이터 조건부 (paneSpecsForTimeframe 불변)**: 사용자 결정("MA처럼 series 숨김")에 따라
  거래량 pane을 제거하지 않는다. `VOLUME_SPEC.useContext = () => ({ volumeEnabled })`(기존 FillStrength
  `useContext` 패턴, `fillStrength.ts:245-256`)로 data를 조건부화: `ctx.volumeEnabled ? projectVolume(b,a) : []`.
  pane이 항상 마운트되어 `drawing/chartCoordinates.ts`의 static `PANE_ID_TO_INDEX` + `DrawingOverlay`
  pane-binding이 안전하다(mid-array 제거 회피). `paneSpecsForTimeframe` 시그니처는 **그대로** —
  PaneToggles 확장 불필요.

## 테스트

- `PaneLegendOverlay` 단위: cursorMs→per-series 값 매핑(number|null), 가변 MA 슬롯, ✕/눈 클릭 → store.
- `IndicatorPanel`: 거래량 토글(CategoryId 'volume').
- `paneSpecsForTimeframe`: `PaneToggles`, 거래량 필터(양 branch), 투자자 append.
- persistence: `volumeEnabled`(default true)/`movingAverageHidden`(default false) merge idiom + 기존 store 보존.
- 브라우저 dogfooding: 레전드 표시, 커서 이동 시 값 변화(D 포함), ✕/눈, 거래량 토글, MA 가변 슬롯.

## plan 이월 (구현 단계에서 확정)

- crosshair 분리 정확한 구현: cursor 발행(모든 tf) vs spot 진입(분봉) 분리 방식 (`useLiveCursorStore` 확장).
- MA series registry 정확한 seam: `paneSeries` 확장 vs 별도 MA registry.
- 거래량 off 시 빈 pane stretch 처리(0 또는 최소).
- 공유 priceFormat 헬퍼 위치.
- 눈 숨김 시 movingAverageHidden persist 여부(session-only vs 영속) — 영속이면 `enabled` vs `hidden` 의미 분리 문서화.
