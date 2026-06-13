# 호가 3종 지표를 「지표」 모달로 편입 — Design

**Date**: 2026-06-13
**Status**: Approved
**Scope**: `frontend/src/live/indicators/IndicatorPanel.tsx`, `frontend/src/live/indicators/QuoteTotalsConfig.tsx`(신규), `frontend/src/live/indicators/RatioConfig.tsx`(신규), `frontend/src/live/indicators/FillStrengthConfig.tsx`(신규), `frontend/src/state/livePage.ts`, `frontend/src/live/paneSpecsForTimeframe.ts`, `frontend/src/live/LiveChartRoot.tsx`, `frontend/src/live/LiveSettingsSections.tsx`, `frontend/src/state/chartPrefs.ts`

## Problem

/live 차트의 호가 3종 지표 — **총잔량**(매수/매도 총잔량 라인), **호가비**(bid/ask imbalance baseline), **체결강도**(매수/매도 체결량 histogram) — 는 분봉에서 **무조건 자동 표시**된다. 「지표」 모달(`IndicatorPanel`)에 항목이 없어 개별 on/off가 불가능하고, 이들의 동작설정(급증 마커·문턱, 호가비 극단값 필터, 체결강도 당일 누적선)은 **별개의 ⚙️ 설정 모달**(`LiveSettingsSections`)에 흩어져 있다.

사용자 표현: *"현재 호가 지표, 총잔량, ratio, 체결강도 3개 지표를 보조지표 ui에 추가해줘, 각 항목별로 사이드 메뉴로 만들고, 디자인은 보조지표 ui와 동일하게."* 동작설정에 대해서는 *"동작설정도 '지표' 모달로 이동"* 을 선택.

## Invariants

- **호가 pane 분봉 전용 (calendar gate)**: 총잔량·호가비·체결강도 pane은 분봉(1m–30m)에서만 마운트되고 D/W/M에서는 마운트되지 않는다 — D/W/M은 `/api/range`를 호출하지 않아 소스 데이터가 없기 때문. 근거: [paneSpecsForTimeframe.ts](../../../frontend/src/live/paneSpecsForTimeframe.ts), ADR-0041.
- **현행 자동표시**: 기존 사용자는 별도 설정 없이 분봉에서 호가 3 pane을 본다. 근거: `PANE_SPECS`가 분봉에 무조건 마운트.
- **chartPrefs = 동작설정의 단일 소스**: 급증/극단값/누적선 등의 값은 `useChartPrefsStore`에 저장되고 projector가 거기서만 읽는다. UI는 그 값을 렌더링할 뿐 별도 사본을 두지 않는다. 근거: [chartPrefs.ts](../../../frontend/src/state/chartPrefs.ts), 각 projector의 `useActivePrefs`.
- **안정 pane 배열 참조**: `paneSpecsForTimeframe`는 토글이 안 바뀌면 **동일 배열 참조**를 반환해 `RangeSeriesPane`의 spec-keyed effect가 churn하지 않는다. 근거: `PANE_SPECS_NO_VOLUME` 등 frozen 상수 패턴.
- **livePage 지표 토글 persistence**: 지표 on/off 토글은 `live.indicators.v1` localStorage에 저장되고 `mergeLiveIndicatorPrefs`가 누락 키를 기본값으로 채운다(구버전 호환). 근거: [livePage.ts](../../../frontend/src/state/livePage.ts).

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| 호가 pane 분봉 전용 (calendar gate) | preserves | 새 토글은 calendar gate와 **AND 합성** — D/W/M은 여전히 숨김. 토글은 분봉 마운트 여부만 추가로 게이트. |
| 현행 자동표시 | preserves | 새 3토글 기본값 **ON**, `mergeLiveIndicatorPrefs` 누락 시 ON → 구버전 사용자 화면 불변. |
| chartPrefs = 동작설정의 단일 소스 | preserves | 동작설정 UI의 **렌더 위치만** ⚙️→지표 모달로 이동. 상태·setter·projector는 chartPrefs 그대로. `ToggleRow`/`NumericPrefRow` 재사용으로 같은 store에 기록. |
| 안정 pane 배열 참조 | preserves | 새 toggle-off 변형도 frozen 상수로 사전 생성(volume 선례 그대로). |
| livePage 지표 토글 persistence | preserves | 3개 키를 snapshot/merge에 추가, 기존 직렬화 형식 확장(호환). |

## Goals

- 「지표」 모달 사이드 네비에 **총잔량 / 호가비 / 체결강도** 3개 활성 항목 추가 — 기존 항목과 동일한 (라벨 버튼 + CheckIcon 토글) 마크업.
- 각 항목 토글로 해당 호가 pane을 분봉에서 mount/unmount(빈 띠 아님, volume 선례).
- 각 항목의 우측 Config 디테일에 해당 동작설정을 표시(`ToggleRow`/`NumericPrefRow` 재사용).
- ⚙️ 설정 모달에서 이동된 동작설정 행 제거 — 중복 노출 0.
- 디자인 일치: 새 항목·Config가 기존 「지표」 모달과 시각적으로 구분 불가능.

## Non-Goals

- 호가 pane 자체의 렌더링·projector·데이터 흐름 변경 (총잔량 라인, 호가비 baseline, 체결강도 histogram 그대로).
- 동작설정의 **값·기본값·검증 범위** 변경 (chartPrefs 레지스트리 항목 정의 자체는 불변; `category` 필드와 렌더 위치만 조정).
- `auctionWindowMask`("동시호가 구간 숨김") 이동 — 3종 공통 단일 토글이라 ⚙️ **차트 카테고리에 유지**.
- 백엔드/캡처/WS 변경.
- D/W/M에서 호가 지표 노출 (calendar gate 유지).

## Design

### 1. 마스터 토글 — `livePage.ts` (volume 선례 복제)

`useLivePageStore`에 3개 boolean + setter 추가:

- `quoteTotalsEnabled` / `setQuoteTotalsEnabled`
- `ratioEnabled` / `setRatioEnabled`
- `fillStrengthEnabled` / `setFillStrengthEnabled`

각 setter는 `set({...})` 후 `persistIndicators()` 호출(기존 setter 패턴). `snapshotIndicators()`에 3키 추가, `mergeLiveIndicatorPrefs()`에 기본값 **`true`** + boolean 검증 추가. 구버전 localStorage에 키가 없으면 ON으로 머지 → 자동표시 보존.

### 2. Pane 게이팅 — `paneSpecsForTimeframe.ts`

`PaneToggles`에 3필드 추가 (모두 optional, 누락/true → 마운트):

```ts
export type PaneToggles = {
  foreignNet: boolean;
  institutionNet: boolean;
  volumeEnabled?: boolean;
  quoteTotalsEnabled?: boolean;
  ratioEnabled?: boolean;
  fillStrengthEnabled?: boolean;
};
```

분봉 분기에서 off인 pane을 `PANE_SPECS`(또는 no-volume 변형)에서 `filter`로 제거. **calendar(D/W/M) 분기는 무변경** — 거기엔 애초에 호가 pane이 없음(gate 합성 자동 성립).

**참조 안정화 = 모듈 레벨 memo 캐시(결정).** 토글 조합 키(`${tf}|${volumeOn?1:0}${qtOn?1:0}${ratioOn?1:0}${fsOn?1:0}`)로 `Map<string, readonly BoundPaneSpec[]>`을 캐싱해 동일 조합은 동일(frozen) 배열을 반환한다. volume의 frozen 2상수를 16개로 사전생성하는 대신 캐시로 lazy 생성 — 코드 ~5줄.

> **검증된 사실(모호성 제거)**: 반환 배열의 참조 안정성은 정합성에 **load-bearing이 아니다**. `paneSpecsForTimeframe` 결과는 어떤 `useEffect`/`useMemo` dep 배열에도 들어가지 않는다(LiveChartRoot:619 effect 내부 재계산 + :720 render inline). mount/unmount 정합성은 (a) 각 `spec`이 모듈 상수(참조 안정), (b) `<RangeSeriesPane key={spec.name}>`의 keyed reconciliation, (c) 라이프사이클 effect deps `[chart, paneIndex, spec]`로 보장된다(volume off 시 하위 pane의 `paneIndex` 변동 → effect 재실행 → 올바른 재마운트). 따라서 단순 filter도 정확하나, 코드베이스의 기존 frozen 관행과 일관성·미래 방어를 위해 memo 캐시를 택한다.

### 3. Config 디테일 3개 — 신규 `live/indicators/*Config.tsx`

`MovingAverageConfig`/`VolumeConfig` 형식. 상단 범례 + 동작설정 행(`ToggleRow`/`NumericPrefRow` 재사용, chartPrefs에 기록).

- **QuoteTotalsConfig**: 범례(매도총잔량/매수총잔량 색) + `surgeMarkerEnabled` ToggleRow + 그 아래 `surgeApproachPct`·`surgeRearmPct`·`surgeStartHHMM` NumericPrefRow(`enabledBy: surgeMarkerEnabled`로 자동 dim).
- **RatioConfig**: 범례(bid>ask 상승/ask>bid 하락) + `ratioOutlierFilterEnabled` ToggleRow + `ratioOutlierThreshold` NumericPrefRow.
- **FillStrengthConfig**: 범례(매수/매도 체결량 색) + `fillStrengthCumulative` ToggleRow.

`NumericPrefRow`는 `def`(레지스트리 항목)만 받으면 chartPrefs를 직접 읽고 쓴다 → import만으로 동작. `ToggleRow`는 stateless → `checked={prefs[key]}` / `onToggle={() => setToggle(key, !prefs[key])}` 주입.

### 4. 사이드 네비 편입 — `IndicatorPanel.tsx`

`CategoryId` 유니온에 `'quote-totals' | 'ratio' | 'fill-strength'` 추가. `CATEGORIES`에 `active:true`로 3항목 추가. 시각적 그룹핑을 위해 네비에 **"호가 지표" 서브헤더**를 기존 "상단 지표" 서브헤더와 동일 스타일로 삽입(상단 지표 그룹 뒤).

`checkedFor`/`toggleFor` switch에 3 case 추가(livePage 토글 바인딩). 우측 디테일 분기에 `selected === 'quote-totals' && <QuoteTotalsConfig />` 등 3줄 추가.

> 서브헤더 구현: 현재 네비는 단일 `CATEGORIES.map`. 그룹 구분을 위해 카테고리에 `group: '상단 지표' | '호가 지표'` 필드를 달고, map 중 그룹 경계에서 서브헤더 `<div>`를 렌더(또는 CATEGORIES를 그룹별 배열로 분리 후 순차 렌더). 기존 "상단 지표" 헤더 마크업 재사용.

### 5. ⚙️ 설정 모달에서 제거 — `LiveSettingsSections.tsx` + `chartPrefs.ts`

> **사용자 추가 지시(2026-06-13)**: *"설정 UI에 있는 보조지표, 총잔량 급증 메뉴도 보조지표(지표) 메뉴로 이동."* — 설정 모달의 **"보조지표"(`indicators` 카테고리 = `fillStrengthCumulative`)** 와 **"총잔량 급증"(`surge` 카테고리 = `surgeMarkerEnabled` + 문턱 3개)** 나브 항목 자체가 지표 모달로 이동(소멸) 대상임을 확정. 본 섹션 설계가 정확히 이를 수행한다(두 카테고리가 비워져 나브에서 사라짐).

이동된 키가 설정 모달에 더는 렌더되지 않도록:

- `surge` 카테고리(`surgeMarkerEnabled` + 3 numerics) → 「지표」 모달로 이동. `LiveSettingsSections`의 `CATEGORY_ORDER`/`LABEL`에서 `surge` 제거. (numerics는 `enabledBy`로 따라감.)
- `fillStrengthCumulative`(현 `category:'indicators'`) → 제거. 이동 후 `indicators` 카테고리가 비면 navIds 필터(`CHART_TOGGLES.some(...)`)가 자동으로 나브 항목을 숨김.
- `ratioOutlierFilterEnabled` + `ratioOutlierThreshold`(현 무카테고리 → `chart`) → 설정 모달에서 제외.

**메커니즘(결정) — 레지스트리 카테고리 재배정:** `ChartToggleCategory` 유니온에 `'indicator-modal'` 값을 추가하고, 이동 대상 3토글의 `category`를 `'indicator-modal'`로 설정:

- `surgeMarkerEnabled`: `'surge'` → `'indicator-modal'`
- `fillStrengthCumulative`: `'indicators'` → `'indicator-modal'`
- `ratioOutlierFilterEnabled`: (무카테고리→`'chart'`) → `'indicator-modal'` (명시 부여)

`LiveSettingsSections`의 `CATEGORY_ORDER`는 `'indicator-modal'`을 **포함하지 않으므로** 자동 제외. 빈 카테고리는 기존 navIds 필터(`CHART_TOGGLES.some(...)`)가 숨김 → `surge`("총잔량 급증") 나브 항목 소멸, `indicators` 카테고리 비면 소멸. numerics는 `enabledBy`로 따라가므로(토글이 안 렌더되면 numerics도 안 렌더) 별도 처리 불필요.

새 Config 컴포넌트는 **카테고리가 아닌 명시적 키**로 해당 토글/numeric을 렌더한다(총잔량→surge, 호가비→ratio filter, 체결강도→cumulative 각각 분리). 즉 `'indicator-modal'` 카테고리는 "설정 모달에서 숨김" 마커 역할이고, 어느 Config에 들어갈지는 Config가 키로 직접 결정.

남는 ⚙️ 설정: **차트**(`candleTooltipEnabled`·`highLowLabelsEnabled`·`auctionWindowMask`) + **데이터소스**.

### 데이터 흐름 요약

```
[변경 없음] /api/range + WS → buildLiveBundle → RangeBundle → projectors(quoteTotals/ratio/fillStrength)
                                                                    └ reads chartPrefs (단일 소스, 무변경)
[추가] livePage.{quoteTotals,ratio,fillStrength}Enabled ──► paneSpecsForTimeframe ──► pane mount/unmount
[이동] 동작설정 렌더: LiveSettingsSections ──삭제──►  *Config (chartPrefs 동일 store 읽기/쓰기)
```

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| 토글 OFF → pane 제거 | `quoteTotalsEnabled=false`, tf=1m | 반환 specs에 `quote-totals` 없음, 나머지 유지 |
| 토글 ON(기본) → pane 유지 | 기본 prefs, tf=1m | 5 pane 모두 존재(현행과 동일) |
| calendar gate 합성 | `quoteTotalsEnabled=true`, tf=D | 호가 pane 없음(D는 candle+volume만) — 토글 무관 |
| merge 기본값 | localStorage에 3키 없음 | merge 결과 3키 모두 `true` |
| merge 보존 | localStorage에 `ratioEnabled:false` | merge 결과 `ratioEnabled:false` 유지 |
| 안정 참조 | 동일 토글로 2회 호출 | 동일 내용(참조 안정화 방식은 구현 결정) → effect churn 없음 |
| Config가 chartPrefs 기록 | QuoteTotalsConfig에서 surge 토글 클릭 | `useChartPrefsStore.surgeMarkerEnabled` 반전 |
| 설정 모달 제외 | LiveSettingsSections 렌더 | 이동된 키의 행/나브 부재(surge 나브 없음, ratio filter·cumulative 행 없음) |
| 지표 모달 네비 | IndicatorPanel 렌더 | "호가 지표" 서브헤더 + 3 활성 항목, 각 토글 동작 |

**Invariant 회귀 테스트**:
- 현행 자동표시: 기본 prefs로 `paneSpecsForTimeframe('1m', defaults)` === 현행 5 pane.
- calendar gate: 모든 호가 토글 ON이어도 `paneSpecsForTimeframe('D'|'W'|'M')`에 호가 pane 부재.
- chartPrefs 단일 소스: Config 토글 변경이 projector가 읽는 동일 store 키를 갱신(이중 사본 부재).

### Manual verification

`/live` 분봉에서:
1. 「지표」 모달 → "호가 지표" 항목 3개 표시·토글 시 해당 pane mount/unmount.
2. 각 Config 디테일의 동작설정 변경이 차트에 즉시 반영(급증 마커, 극단값 필터, 누적선).
3. ⚙️ 설정 모달에 이동된 항목 부재, 남은 항목(캔들 툴팁·고저 라벨·동시호가 마스킹·데이터소스) 정상.
4. 토글 OFF 후 새로고침 → 상태 유지(localStorage). 구버전 상태(키 없음)로 진입 → 3종 ON.
5. D/W/M 전환 → 호가 pane·토글 영향 없음.

⚠️ 헤드리스로 토글·persistence·pane 마운트는 검증 가능하나, **차트 시각 반영은 사용자 /live 육안 확인 권장**(메모리의 호가지표 검증 관행).

## Risks / Open questions

- **[해소됨] 안정 pane 배열 참조**: 검증 결과 반환 배열은 어떤 dep 배열에도 안 들어가 load-bearing 아님(§2 참조). memo 캐시로 일관성·미래 방어만 확보, churn 부재는 회귀 테스트로 확인.
- **[해소됨] 설정 모달 잔여 "차트" 항목 경계**: 이동 후 ⚙️ 설정엔 `auctionWindowMask`(동시호가 마스킹)·`candleTooltipEnabled`(캔들 툴팁)·`highLowLabelsEnabled`(고저 극값 라벨)가 **차트** 카테고리에 남는다. **사용자 확정(2026-06-13): 차트에 그대로 유지** — "보조지표·총잔량 급증"만 이동. 이 3개는 현 스펙 범위 밖.
- **"호가 지표" 서브헤더**: 거래량·투자자 pane도 기술적으로 하단 pane이나 "상단 지표"에 있음 — 라벨이 엄밀히 정확하진 않음. 사용자 승인됨(시각 그룹핑 목적).
- **카테고리 재배정 (`'indicator-modal'`)**: `ChartToggleCategory` 유니온에 값 추가 → `categoryOf`·`DEFAULT_PREFS`·persistence 영향 점검. surge는 자체 카테고리라 깔끔, ratio filter는 무카테고리(→chart)에서 명시 재배정 필요 — 회귀 테스트로 설정 모달 부재 확인.

## Out of Scope (Backlog)

- 호가 pane의 "숨김(눈)" vs "제거(✕)" 구분(MA의 `movingAverageHidden` 같은 데이터 보존 hide) — 현 설계는 mount/unmount만.
- `auctionWindowMask`를 호가 지표 그룹으로 이동(3종 공통이라 현 차트 카테고리 유지).
- 호가 pane 높이/순서 사용자 조정.
