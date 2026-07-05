# Indicator Pane Timeframe Profiles — Design

**Date**: 2026-07-05
**Status**: Draft for user review
**Scope**: `frontend/src/state/livePage.ts`, `frontend/src/state/liveIndicatorsPersistence.ts`, `frontend/src/live/indicators/IndicatorPanel.tsx`, `frontend/src/live/LiveChartRoot.tsx`, `frontend/src/live/LiveWorkarea.tsx`, `frontend/src/studyViews/StudyPage.tsx`, `frontend/src/live/paneSpecsForTimeframe.ts`

## Problem

보조지표 pane 표시 설정이 현재 전역 flat setting이라, 분봉에서 맞춘 pane 조합이 일봉/주봉/월봉에도 그대로 적용된다. 사용자는 같은 `/live`/`/study` 지표 셋업을 쓰되, 분봉/일봉/주봉/월봉마다 필요한 pane 표시 조합을 다르게 저장하고 싶다.

`/study` 저장뷰는 종목, 기간, viewport 같은 복기 대상을 저장하고, 지표는 `/live`처럼 현재 셋업된 지표로 재분석해야 한다. 따라서 해결 방향은 "study 저장뷰별 indicator_state 저장"이 아니라 "live/study가 공유하는 현재 지표 설정 안에 timeframe별 pane profile을 추가"하는 것이다.

## Invariants

- **Analysis settings are shared, not tab-owned**: `/live` 탭은 종목/timeframe/viewport 같은 보는 상태를 갖고, 지표/차트 분석 설정은 전역으로 유지한다. 근거: [ADR-0069](../../adr/0069-live-multi-tab-reintroduction.md).
- **Indicator on/off and behavior knobs stay split**: `live.indicators.v1`은 어떤 지표/pane을 켜는지, `hoga.chart.prefs.v1`은 필터/누적/문턱값 같은 동작 knob을 보관한다. 근거: [ADR-0072](../../adr/0072-indicator-prefs-two-stores.md).
- **Study v2 re-analyzes with current settings**: v2 study view는 저장 당시 화면 스냅샷이 아니며, 저장된 구간을 현재 지표 셋업으로 다시 렌더한다. 근거: [ADR-0077](../../adr/0077-parquet-study-views-separate-route.md).
- **Live calendar hoga data gate wins**: `/live` D/W/M은 hoga-derived data가 없으므로 hoga pane을 빈 pane으로 mount하지 않는다. 근거: [ADR-0041](../../adr/0041-live-calendar-timeframe-panes.md).
- **Investor net remains daily-only**: 외국인/기관 순매수 pane은 일봉에서만 의미 있게 표시한다. 근거: [ADR-0055](../../adr/0055-live-investor-net-daily-only.md).

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| Analysis settings are shared, not tab-owned | preserves | profile은 tab/view 저장소가 아니라 기존 shared indicator settings 안에 추가된다. |
| Indicator on/off and behavior knobs stay split | preserves | pane mount on/off만 `live.indicators.v1`에 추가하고 `chartPrefs`는 건드리지 않는다. |
| Study v2 re-analyzes with current settings | preserves | study view schema에는 `indicator_state`를 추가하지 않는다. |
| Live calendar hoga data gate wins | preserves | profile toggle이 켜져도 `/live` D/W/M에서 data gate가 false면 hoga pane은 mount되지 않는다. |
| Investor net remains daily-only | preserves | profile에 값은 있어도 resolver가 `tf === 'D'` 조건을 최종 적용한다. |

## Goals

- `/live`와 `/study`가 공유하는 현재 지표 셋업 안에서 `분봉 / 일봉 / 주봉 / 월봉`별 pane 표시 profile을 지원한다.
- 기존 사용자 설정은 깨지지 않게 legacy flat setting을 lazy fallback으로 사용한다.
- v1 범위는 보조지표 pane의 ON/OFF에만 한정한다.
- `/study` 저장뷰에는 indicator state를 저장하지 않고, 열 때마다 현재 shared profile로 재분석한다.
- pane resolver를 한 곳에 모아 `LiveChartRoot`, `IndicatorPanel`, legend close 동작이 같은 규칙을 쓰게 한다.

## Non-Goals

- 탭별 지표 설정을 만들지 않는다.
- study 저장뷰별 indicator snapshot 또는 `indicator_state`를 저장하지 않는다.
- MA 슬롯, 색상, 두께, peak wall 스타일, ratio outlier filter, fill strength cumulative 같은 세부 동작 knob을 timeframe별로 나누지 않는다.
- `/live` D/W/M에서 hoga-derived pane을 강제로 표시하지 않는다.
- backend range/study schema를 변경하지 않는다.

## Design

### Profile model

새 module을 추가한다.

```text
frontend/src/live/indicators/indicatorPaneProfiles.ts
```

권장 type:

```ts
export type IndicatorPaneProfileKey = 'minute' | 'D' | 'W' | 'M';

export type IndicatorPanePrefs = {
  volumeEnabled: boolean;
  quoteTotalsEnabled: boolean;
  ratioEnabled: boolean;
  fillStrengthEnabled: boolean;
  programTradeEnabled: boolean;
  foreignNetEnabled: boolean;
  institutionNetEnabled: boolean;
};

export type IndicatorPanePrefsByTimeframe =
  Record<IndicatorPaneProfileKey, IndicatorPanePrefs>;
```

`profileKeyForTimeframe(tf)`는 `1m/3m/5m/10m/15m/30m`을 `minute`로 묶고, `D/W/M`은 각각 자기 key로 둔다.

### Persistence

기존 `live.indicators.v1`에 additive field를 추가한다.

```ts
panePrefsByTimeframe?: Partial<Record<IndicatorPaneProfileKey, Partial<IndicatorPanePrefs>>>;
```

Migration rule:

- 저장값에 `panePrefsByTimeframe`이 없으면 legacy flat fields를 모든 profile의 기본값으로 사용한다.
- 사용자가 특정 profile의 toggle을 변경하면 그 profile만 `panePrefsByTimeframe`에 저장한다.
- flat fields는 당장 제거하지 않는다. 구버전 fallback, 기존 selector, 점진 마이그레이션을 위해 유지한다.
- snapshot/persist는 unknown field를 만들지 않고 known shape만 저장한다.

초기 사용자 경험은 기존과 같다. 기존에 `volumeEnabled=false`였던 사용자는 분봉/일봉/주봉/월봉 모두 volume off로 보이고, 이후 일봉만 켜면 일봉 profile만 분리된다.

### Resolution rules

새 resolver가 UI profile과 data availability gate를 분리한다.

```ts
type ResolvePaneTogglesInput = {
  timeframe: LiveTimeframe;
  forceHogaPanes?: boolean;
  legacy?: PersistedIndicators;
  profiles?: Partial<Record<IndicatorPaneProfileKey, Partial<IndicatorPanePrefs>>>;
};
```

Resolver 책임:

1. `timeframe`에서 profile key를 고른다.
2. profile 값이 있으면 사용하고, 없으면 legacy flat setting을 fallback으로 쓴다.
3. `paneSpecsForTimeframe`의 data gate와 AND한다.

최종 규칙:

- `volume`: profile toggle이 최종 표시 여부를 결정한다.
- `quoteTotals`, `ratio`, `fillStrength`, `programTrade`: profile toggle이 true여도 hoga data gate가 false면 mount하지 않는다.
- `foreignNet`, `institutionNet`: profile toggle이 true여도 `tf !== 'D'`이면 mount하지 않는다.
- `forceHogaPanes=true`인 `/study`는 hoga data가 존재하는 study bundle에서 D/W/M profile의 hoga pane toggle을 적용할 수 있다.

### `/live` behavior

`LiveChartRoot`는 flat store fields를 직접 읽지 않고, active timeframe에 대한 resolved pane toggles를 읽는다. `paneSpecsForTimeframe`은 계속 최종 pane list를 결정하는 module로 남기되, 입력 toggle shape은 resolver 결과를 받도록 정리한다.

`/live` D/W/M에서는 ADR-0041이 계속 우선한다. 예를 들어 일봉 profile에서 `호가비`가 on이어도 live daily chart에 hoga data가 없으면 pane은 표시되지 않는다.

### `/study` behavior

`StudyPage`는 저장뷰에 indicator state를 추가하지 않는다. 저장뷰를 열면:

1. 저장뷰의 `timeframe`으로 profile key를 고른다.
2. 현재 shared indicator profile을 읽는다.
3. `LiveChartRoot`에 resolved profile을 전달한다.
4. `forceHogaPanes`가 필요한 existing study behavior는 유지한다.

따라서 저장뷰는 항상 "저장된 구간 + 현재 live/study 공용 지표 셋업"으로 재분석된다.

### Indicator panel UX

`IndicatorPanel`은 현재 chart timeframe을 알고 있어야 한다. 기본 selected profile은 active chart의 timeframe profile이다.

Panel 상단에 작은 segmented control을 둔다.

```text
분봉 | 일봉 | 주봉 | 월봉
```

사용자가 다른 segment를 고르면 그 profile의 pane ON/OFF를 편집한다. label은 명확히 "현재 선택한 시간봉 profile의 pane 표시"가 되도록 한다.

Phase 1에서 profile 대상은 pane 표시 toggle만이다.

- 거래량
- 총잔량
- 호가비
- 체결강도
- 프로그램 순매수
- 외국인 순매수
- 기관 순매수

MA, 일봉 MA, peak wall 세부 스타일, volume distribution 설정, ratio/fill behavior knob은 기존 global control로 유지한다.

### Legend close behavior

`PaneLegendOverlay`나 pane close button이 특정 pane을 끄는 경우, 현재 chart timeframe의 profile에 기록한다. 예를 들어 `/study` 일봉에서 `호가비` pane을 닫으면 일봉 profile의 `ratioEnabled=false`가 된다. 저장뷰 자체에는 쓰지 않는다.

### Documentation updates

구현 PR에서 다음 문서를 함께 업데이트한다.

- [CONTEXT.md](../../../CONTEXT.md): study가 "current `/live` indicator preferences"를 쓴다는 표현을 "current shared live/study indicator setup"으로 정정한다.
- [ADR-0077](../../adr/0077-parquet-study-views-separate-route.md): v2 study view가 현재 shared setup으로 재분석한다는 표현을 명확히 한다.
- [ADR-0069](../../adr/0069-live-multi-tab-reintroduction.md): "분석설정 전역"은 유지하되, 전역 설정 내부에 timeframe profile이 생긴다는 note를 추가한다.

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| Legacy fallback | `panePrefsByTimeframe` 없음, flat `volumeEnabled=false` | 모든 profile에서 volume false로 resolve |
| Profile override | flat `ratioEnabled=true`, `D.ratioEnabled=false` | D profile만 ratio false |
| Minute grouping | `1m`, `3m`, `30m` | 모두 `minute` profile 사용 |
| Live D/W/M gate | D profile `ratioEnabled=true`, `forceHogaPanes=false` | `/live` daily에서 ratio pane 미표시 |
| Study force hoga | D profile `ratioEnabled=true`, `forceHogaPanes=true` | `/study` daily에서 data가 있으면 ratio pane 표시 |
| Investor daily-only | W profile `foreignNetEnabled=true` | W에서는 investor pane 미표시 |
| Persist profile write | 일봉 profile에서 `volumeEnabled` 변경 | `panePrefsByTimeframe.D.volumeEnabled`만 저장 |
| Legend close | 일봉 chart에서 ratio pane close | D profile `ratioEnabled=false` |

### Route/component tests

- `LiveChartRoot.paneToggles.test.tsx`: `paneTogglesOverride`와 새 resolver가 충돌하지 않는지 확인한다.
- `StudyPage.test.tsx`: 저장뷰 props나 save payload에 `indicator_state`가 생기지 않는 것을 유지한다.
- `IndicatorPanel` tests: selected profile 변경, current timeframe 기본 선택, profile별 checkbox persistence를 검증한다.
- `liveIndicatorsPersistence` tests: old payload, partial profile payload, corrupt profile payload fallback을 검증한다.

### Manual verification

1. `/live` 분봉에서 `호가비` off, 일봉 profile에서 `거래량` on/off를 바꾼다.
2. 분봉으로 돌아왔을 때 분봉 pane 조합이 유지되는지 확인한다.
3. `/live` 일봉에서 hoga pane이 profile on이어도 빈 pane으로 표시되지 않는지 확인한다.
4. `/study` 일봉 저장뷰를 열고 현재 일봉 profile에 맞춰 pane이 표시되는지 확인한다.
5. 같은 저장뷰를 다시 열 때 저장 당시 지표가 아니라 현재 변경한 profile로 재분석되는지 확인한다.

## Risks / Open questions

- `IndicatorPanel`이 현재 timeframe을 모르는 entry point가 있으면 prop threading이 필요하다. 이 경우 active chart timeframe을 상위 route에서 명시적으로 넘긴다.
- `LiveChartRoot`의 기존 `paneTogglesOverride`는 테스트와 일부 route seam에서 쓰이므로 바로 제거하지 않는다. 새 resolver 결과와 병합 우선순위를 명확히 해야 한다.
- D/W/M hoga profile은 `/live`에서는 data gate 때문에 보이지 않고 `/study`에서만 의미가 있을 수 있다. UI copy가 이를 과하게 설명하면 복잡해지므로, v1은 segmented profile만 제공하고 data absence는 기존 chart behavior에 맡긴다.

## Out of Scope (Backlog)

- 지표 설정 import/export.
- profile별 MA/색상/두께/동작 knob.
- tab별 indicator setup.
- study 저장뷰별 frozen indicator snapshot.
- `/live` D/W/M hoga aggregation.
