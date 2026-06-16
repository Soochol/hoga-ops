# `/live` 날짜 구분선 설정 Design

## Context

`/live` 분봉 차트는 여러 거래일을 하나의 virtual axis 위에 이어 붙이고,
`frontend/src/chart/DayBoundaryOverlay.tsx`가 거래일 경계마다 세로 점선을 그린다.
현재 선은 항상 켜져 있고, 색상은 `--fg-dimmer` 토큰 fallback인 `#64748B`, 두께는 1px로 고정되어 있다.

설정 모달은 `LiveSettingsSections`에서 `차트`와 `데이터소스` 카테고리를 제공한다. 차트 표시 토글은
`frontend/src/state/chartPrefs.ts`의 `CHART_TOGGLES` registry와 `hoga.chart.prefs.v1` localStorage snapshot으로
전역 저장된다. 선 색상과 두께를 고르는 UI는 이동평균선과 당일 매도 최대벽 설정에서
`frontend/src/live/indicators/MAStylePicker.tsx`를 이미 재사용하고 있다.

## Goals

- 날짜 구분선 세로선을 설정 모달에서 on/off할 수 있다.
- 날짜 구분선의 색상과 두께를 설정 모달에서 변경할 수 있다.
- 설정은 `/live` 전체에 공통 적용되는 전역 설정이다.
- 기존 화면의 기본값은 유지한다: 켜짐, `#64748B`, 1px.
- 이동평균선 UI와 같은 색상 팔레트 및 1-4px 두께 선택 UX를 사용한다.

## Non-Goals

- 종목별, 탭별, timeframe별 날짜 구분선 설정은 추가하지 않는다.
- 선 스타일(실선/점선 패턴), dash 간격, label 표시 옵션은 추가하지 않는다.
- D/W/M 캘린더 timeframe에서 날짜 구분선을 새로 표시하지 않는다. 기존처럼 분봉 timeframe에서만 의미 있게 렌더한다.
- `MAStylePicker`의 palette 자체를 변경하지 않는다.

## Design

### Preferences

`chartPrefs`에 전역 선 설정을 추가한다.

- `dayBoundaryEnabled: boolean`
- `dayBoundaryColor: string`
- `dayBoundaryLineWidth: 1 | 2 | 3 | 4`

`dayBoundaryEnabled`는 `CHART_TOGGLES`에 `category: chart`로 등록한다. 색상과 두께는 같은 store에 명시 필드로 둔다.
현재 numeric-pref registry는 integer input row 전용이고 색상 선택을 표현하지 못하므로, 날짜 구분선 스타일은
registry에 억지로 넣지 않는다. 대신 `useChartPrefsStore`에 `setDayBoundaryStyle(patch)` setter를 추가하고,
`chartPrefsPersistence`의 snapshot/merge에서 이 두 스타일 필드를 함께 검증한다.

검증 규칙:

- `dayBoundaryColor`는 `#RRGGBB` hex 문자열만 받아들인다.
- `dayBoundaryLineWidth`는 `1`, `2`, `3`, `4`만 받아들인다.
- 저장값이 없거나 유효하지 않으면 기본값으로 fallback한다.

### Settings UI

`LiveSettingsSections`의 `차트` 상세 패널에 기존 `IndicatorPrefRows`를 유지하고, 그 아래에 날짜 구분선 스타일 행을 추가한다.

구성:

- `IndicatorPrefRows`가 `dayBoundaryEnabled` 토글을 렌더한다.
- 토글 아래에 `날짜 구분선 스타일` 라벨과 `MAStylePicker`를 렌더한다.
- `MAStylePicker`는 `label="날짜 구분선"`으로 호출해 aria-label이 `날짜 구분선 스타일 선택`, `날짜 구분선 색상 #...`, `날짜 구분선 굵기 Npx`가 되게 한다.
- 토글이 꺼져 있어도 스타일 값은 보존한다. UI는 표시해도 되지만 비활성화는 필수 요건이 아니다.

이 배치는 보조지표 모달이 아니라 설정 모달의 `차트` 카테고리에 둔다. 날짜 구분선은 지표 series가 아니라 차트 구조/가독성 옵션이기 때문이다.

### Chart Rendering

`DayBoundaryOverlay`가 `useActivePrefs`로 다음 값을 읽는다.

- `dayBoundaryEnabled`
- `dayBoundaryColor`
- `dayBoundaryLineWidth`

렌더링 규칙:

- 분봉 timeframe 게이트는 기존 `LiveChartRoot` 위치에 유지한다.
- `dayBoundaryEnabled`가 false면 `DayBoundaryOverlay`는 null을 반환한다.
- `axis.segments.length < 2`면 기존처럼 null을 반환한다.
- 색상은 `dayBoundaryColor`를 사용한다.
- 두께는 vertical div의 inline `width`로 적용한다.
- 기존 dashed vertical pattern은 유지하되, gradient 색상만 설정값으로 바꾼다.

### Data Flow

1. 사용자가 설정 모달에서 날짜 구분선 토글을 클릭한다.
2. `useChartPrefsStore.setToggle('dayBoundaryEnabled', next)`가 전역 prefs를 갱신한다.
3. 사용자가 `MAStylePicker`에서 색상 또는 두께를 고른다.
4. `setDayBoundaryStyle`이 전역 prefs를 갱신한다.
5. `attachChartPrefsPersistence`가 `hoga.chart.prefs.v1`에 debounce 저장한다.
6. `DayBoundaryOverlay`가 store 변경을 구독해 즉시 다시 렌더한다.

## Error Handling

- localStorage를 읽을 수 없거나 JSON parse가 실패하면 기존 기본값을 사용한다.
- 저장된 색상/두께가 유효하지 않으면 해당 필드만 기본값으로 fallback한다.
- chart/axis runtime 오류 처리는 기존 `ChartErrorBoundary` 범위에 맡긴다. 이 변경은 새 async 또는 network 경로를 추가하지 않는다.

## Testing

### Unit Tests

- `DEFAULT_PREFS.dayBoundaryEnabled === true`
- `DEFAULT_PREFS.dayBoundaryColor === '#64748B'`
- `DEFAULT_PREFS.dayBoundaryLineWidth === 1`
- `mergePrefs`가 유효한 날짜 구분선 색상/두께를 보존한다.
- `mergePrefs`가 잘못된 색상/두께를 기본값으로 fallback한다.
- `useChartPrefsStore.setDayBoundaryStyle`이 색상과 두께를 갱신한다.

### Component Tests

- `LiveSettingsSections`의 차트 탭에 `settings-toggle-dayBoundaryEnabled`가 보인다.
- `LiveSettingsSections`에 `날짜 구분선 스타일 선택` 버튼이 보인다.
- `DayBoundaryOverlay`는 `dayBoundaryEnabled=false`일 때 boundary element를 렌더하지 않는다.
- `DayBoundaryOverlay`는 설정된 색상과 두께를 boundary element style에 반영한다.

### Verification

- `npm run build`
- 관련 vitest 파일만 우선 실행하고, 실패가 주변 mock 설정 때문이면 범위를 넓혀 확인한다.

## Acceptance Criteria

- `/live` 설정 모달의 `차트` 섹션에서 날짜 구분선을 끄면 분봉 차트의 거래일 경계 세로선이 사라진다.
- 다시 켜면 기존 위치에 세로선이 나타난다.
- 색상과 두께 변경이 즉시 차트에 반영된다.
- 새로고침 후에도 날짜 구분선 on/off, 색상, 두께 설정이 유지된다.
- 기본 설치/초기 상태에서는 기존과 같은 1px 회색 점선이 표시된다.
