# Delete `/replay` page and migrate chart options to `/live`

**Status**: draft
**Date**: 2026-05-29
**Scope**: frontend

## Problem

`/replay` 페이지를 더 이상 사용하지 않는다. 페이지 자체 + replay 전용 상태(state, persistence, URL sync)를 모두 제거하고, replay `SettingsModal` 의 "차트" 카테고리 4개 옵션을 `/live` 페이지의 새 `LiveSettingsModal` 로 이관한다. 보조지표는 이미 `/live` 의 `IndicatorPanel` 에 존재하므로 이관 대상이 아니다.

## Goals

1. `/replay` 라우트 · 페이지 · 메뉴 · 외부 진입점(inventory 행 클릭) 완전 제거.
2. replay 전용 state 모듈 통째 삭제 (`state/tabs.ts`, `state/tabsPersistence.ts`, `state/url.ts`, `state/toolbarDraft.ts`, `state/replayLayout.ts`).
3. `chartPrefs` 를 글로벌 단일 zustand store(`useChartPrefsStore`)로 재구성. `useActivePrefs(selector)` API 시그니처는 유지하여 chart projector 계열(`ratio`, `quoteTotals`, `fillStrength`, `AuctionWindowOverlay`) 무수정.
4. `/live` 에 `LiveSettingsModal` 추가 — `LiveToolbar` 의 `[+ 보조지표]` 옆에 `[⚙ 설정]` 버튼 진입.
5. 이관 옵션이 실제로 차트에 반영되도록 정합성 보강 — `AuctionWindowOverlay` 를 `LiveChartRoot` 에 마운트.

## Drawing migration to `/live`

### 결정

Drawing 기능(수평선/추세선/자유선 차트 그림 도구)을 `/live`로 이관한다. 현재 ChartStage가 host지만 LiveChartRoot에는 없음. ChartStage 자체는 replay wrapper라 같이 삭제하되, Drawing host 책임만 LiveChartRoot로 이동.

### LiveChartRoot에 추가 마운트

- `<DrawingOverlay chart axis paneSeries />` — DPR-scaled canvas + pointer events
- `<DrawingPropertyPanel computeAnchor />` — floating property panel
- `paneSeries: Map<PaneId, ISeriesApi>` registry 신설 — 각 `RangeSeriesPane`이 mount 시 등록 (ChartStage 패턴 그대로 이전)
- `computeAnchor` 헬퍼 (ChartStage:115의 함수) — LiveChartRoot로 이전 또는 hook으로 추출

### LiveToolbar에 Drawing Tool 메뉴 추가

`[1m] [3m] [5m] [15m] [1d] | [+ 보조지표] [⚙ 설정] | [✏ 그리기]` 형태로 그리기 메뉴 버튼 추가. `replay/DrawingMenu.tsx`를 `live/LiveDrawingMenu.tsx`로 이동/리네임. `useDrawingsStore.activeTool`은 글로벌 상태(per CONTEXT.md "Drawing Tool" entry)라 그대로 사용 가능.

### Drawing의 paneId × LiveTimeframe 교차

Drawing은 paneId(`'candle'`/`'volume'`/`'ratio'`/`'quote-totals'`/`'fill-strength'`)에 묶임. Live는 timeframe에 따라 pane 구성이 다름:
- 분봉 (`1m`/`3m`/`5m`/`15m`): 5개 pane 전부 마운트 → Drawing 정상
- D/W/M: candle + volume 2개만 마운트 → ratio/quote-totals/fill-strength에 그려진 Drawing은 **렌더 대상 pane이 없음**

**처리 방침** (plan 단계 세부 결정):
- (1) D/W/M에서는 hoga pane에 묶인 Drawing을 단순히 렌더하지 않음 (paneSeries registry에 없으면 skip — 기존 ChartStage 패턴과 동일)
- (2) 사용자가 D/W/M 보는 중 새 Drawing을 그리려 하면 candle/volume에만 그릴 수 있게 DrawingMenu에서 다른 pane 선택 자체가 불가
- 데이터 손실 없음 — 분봉으로 돌아오면 hoga pane Drawing 재출현

### 영속화 키 마이그레이션

현재 키: `replay.drawings.v1.<code>` + `replay.drawingDefaults.v1`. 이름에 "replay" 박혀 있어 의미적으로 어색. 두 옵션:
- **A. 키 이름 보존** — 가장 안전, 사용자 PC의 기존 drawing 손실 없음, 다만 코드/스토리지에 "replay" 흔적 잔존. plan에서 default 선택.
- B. 새 키로 마이그레이션 — 한 번만 `replay.*` → `hoga.drawings.v1.<code>` 복사 후 이전 키 삭제. 코드는 깔끔하지만 마이그레이션 코드 작성/테스트 비용.

Plan 단계에서 final decision. 본 spec은 옵션 A를 기본으로 가정.

### Deletion list 보정 (Drawing 관련)

다음은 삭제하지 **않음** (live로 host만 이전):
- `chart/DrawingOverlay.tsx` (유지, LiveChartRoot가 마운트)
- `chart/DrawingPropertyPanel.tsx` (유지)
- `chart/drawing/` 디렉토리 전체 (types, tools, persistence, chartCoordinates — 유지)
- `state/drawings.ts` (유지)
- `chart/AuctionWindowOverlay.tsx` (이미 spec에 live 마운트 결정 — 유지)

ChartStage는 여전히 삭제 (replay 전용 wrapper). 단 ChartStage 안의 paneSeries registry + computeAnchor 패턴은 LiveChartRoot로 이전:
- `chart/ChartStage.tsx` + test — 삭제 (Drawing host 책임은 LiveChartRoot로 이전)
- 별도 `chart/drawing/chartCoordinates.ts` — DrawingOverlay가 import, 유지

### CONTEXT.md 영향

Drawing 관련 entries (Drawing / Drawing Overlay / Drawing Property Panel / Drawing Tool / Default Drawing Style) 의 "Replay Viewer toolbar" / "ChartStage" 언급을 "Live toolbar" / "LiveChartRoot" 로 갱신 필요 (plan 후 후속 작업으로 처리).

## Non-goals

- `volumeProfileMode` 는 `/live` 에 `VolumeProfileOverlay` 자체가 없으므로 이관하지 않고 관련 코드(필드, overlay 컴포넌트, modal row)도 삭제한다. Live에 volume profile을 도입하는 작업은 별도 spec.
- replay 전용 영속 키(`replay.tabs.v?` 등)의 사용자 환경 cleanup. 코드는 더 이상 읽지 않으며, 영속 키 정리는 별도 후속 작업.
- 보조지표(`fillStrengthCumulative` 외 indicator 카테고리, MA) 관련 UI 변경. 이미 `/live IndicatorPanel` 이 자체 store(`useLivePageStore`)로 관리하므로 무변경.
- replay 페이지 삭제로 사라지는 기능에 대한 일반 사용자 대상 사전 공지/툴팁. 내부 도구 성격.

## Routing & entry points

| 항목 | Before | After |
|---|---|---|
| `/` redirect 타깃 | `<Navigate to="/replay" replace />` | `<Navigate to="/live" replace />` |
| 라우트 등록 | `<Route path="replay" element={<ReplayViewer />} />` | 제거 |
| `LeftNav` 메뉴 | `<NavItem to="/replay" label="Replay Viewer" />` | 제거. Live가 Workspace 섹션 최상단 |
| `pages/ReplayViewer.tsx` | 존재 | 삭제 |
| Inventory `StockDateGroupDetail.tsx` 행 클릭 | `useTabsStore.getState().newTab()` + `navigate('/replay')` | **핸들러 자체 제거**. 행의 cursor-pointer/hover 스타일도 제거 (클릭 가능 시그널 제거) |
| `LeftNav` 헤더 카피 `orderbook replay` | 유지 (브랜드 카피, 라우트와 무관) | 유지 |

## Store architecture

### Before

```text
state/tabs.ts                    # zustand store: tabs: Tab[], activeTabId, prefs Map
state/chartPrefs.ts              # 타입 + registry + useActivePrefs (외부 store 주입 패턴)
state/tabsPersistence.ts         # tabs 배열 + activeTabId 영속화, mergePrefs validation
state/url.ts                     # parseReplayUrl / emitReplayUrl
state/toolbarDraft.ts            # Replay Toolbar commit-on-blur 드래프트
state/replayLayout.ts            # Replay Cursor Sidebar runtime layout

chart/projectors/*               # useActivePrefs((p) => ...) 로 active tab prefs 읽음
state/useAuctionMaskActive.ts    # useTabsStore 직접 참조
```

### After

```text
state/chartPrefs.ts              # 타입 + registry + DEFAULT_PREFS + zustand store + useActivePrefs
state/chartPrefsPersistence.ts   # 새 localStorage 키 + mergePrefs validation (tabsPersistence에서 이전)

chart/projectors/*               # useActivePrefs((p) => ...) 무변경
state/useAuctionMaskActive.ts    # useChartPrefsStore.auctionWindowMask 직접 읽도록 한 줄 수정
```

### `chartPrefs.ts` 확장 형태

```ts
import { create } from 'zustand';

export const CHART_TOGGLES = [...] as const;        // 기존 유지
export const CHART_NUMERIC_PREFS = [...] as const;  // 기존 유지
// movingAverages 관련(MA_SLOT_COUNT, DEFAULT_MOVING_AVERAGES, MAConfig, MAIndex)은
// 삭제 — live는 useLivePageStore에 자체 MA 관리 존재. 단,
// chart/projectors/movingAverage.ts의 외부 import 경로 검증 후 이전 필요.
// (live의 MovingAverageOverlay가 이미 useLivePageStore에서 읽으므로
// replay 전용 정적 5슬롯 모델은 호출처 없음)

export type ChartViewPrefs = {
  // volumeProfileMode 제거 (Non-goals 참조)
} & { [K in ChartToggleKey]: boolean }
  & { [K in NumericPrefKey]: number };

export const DEFAULT_PREFS: ChartViewPrefs = { ...TOGGLE_DEFAULTS, ...NUMERIC_DEFAULTS };

type ChartPrefsStore = ChartViewPrefs & {
  setToggle: (key: ChartToggleKey, value: boolean) => void;
  setNumericPref: (key: NumericPrefKey, value: number) => void;
  resetToDefaults: () => void;
};

export const useChartPrefsStore = create<ChartPrefsStore>((set) => ({
  ...DEFAULT_PREFS,
  setToggle: (key, value) => set({ [key]: value } as Partial<ChartPrefsStore>),
  setNumericPref: (key, value) => set({ [key]: value } as Partial<ChartPrefsStore>),
  resetToDefaults: () => set(DEFAULT_PREFS),
}));

// API 호환 — 호출처(chart projector, useCursor 등) 무변경
export function useActivePrefs<T>(selector: (prefs: ChartViewPrefs) => T): T {
  return useChartPrefsStore(selector);
}
```

### Store-injection seam 제거

기존 `registerTabsStore` / `_activeTabPrefsStore` 변수는 chartPrefs.ts ↔ tabs.ts 모듈 사이클을 끊기 위한 장치였다. 새 구조에서는 chartPrefs.ts가 자기 자신이 store를 소유하므로 사이클 자체가 사라진다. 두 변수와 관련 throw 가드 통째 삭제.

## Persistence

- **새 키**: `hoga.chart.prefs.v1` — debounced write, JSON 직렬화된 `ChartViewPrefs`
- **validation**: 기존 `tabsPersistence.ts` 의 `mergePrefs` 로직을 `chartPrefsPersistence.ts` 로 이전 (registry 기반 type-safe merge)
- **마이그레이션**: 없음. 첫 로드 시 `DEFAULT_PREFS` 사용. 사용자 영향: 4개 옵션이 default로 리셋 (`auctionWindowMask=true`, `ratioOutlierFilterEnabled=true`, `ratioOutlierThreshold=100`, `fillStrengthCumulative=true`)
- **이전 키 cleanup**: 별도 후속 작업 (Non-goals)

## `LiveSettingsModal` UI

### 진입점

`LiveToolbar` 에 `[⚙ 설정]` 버튼 신규 추가. 기존 `[+ 보조지표]` 옆에 동일한 시각 토큰으로 배치 (SVG gear 아이콘 + 라벨).

```text
[1m] [3m] [5m] [15m] [1d]   [+ 보조지표]  [⚙ 설정]
```

`indicatorPanelOpen` 과 동일한 패턴으로 `LivePage` 에 `[settingsOpen, setSettingsOpen]` 상태 추가, `LiveToolbar` 는 `onOpenSettings` prop 받음.

### 모달 구조 — flat 레이아웃 (카테고리 사이드바 제거)

`/replay` `SettingsModal` 은 "차트 / 보조지표" 카테고리 사이드바가 있었으나, `/live` 는 보조지표가 별도 `IndicatorPanel` 로 분리되어 카테고리가 1개. 사이드바 떼고 flat:

```text
┌──────────────────────────────────────────┐
│ 차트 설정                              ✕ │
├──────────────────────────────────────────┤
│ 동시호가 구간 지표 숨김           [ON ]  │
│   15:20–15:30 KST 동시호가 구간에서      │
│   호가비·호가총합·체결강도를 표시하지    │
│   않습니다.                              │
│                                          │
│ 호가비 극단값 필터                [ON ]  │
│   한쪽 호가가 임계 배수를 넘으면 그      │
│   시점의 호가비를 0 으로 마스킹합니다.   │
│   호가비 극단값 임계 배수    [   100  ] │
│     (2–10,000)                           │
│                                          │
│ 기본 데이터 소스 (모든 차트 공통)        │
│   ( ) hogaplay 우선                      │
│   ( ) kis_live 우선                      │
│   현재 source는 차트 상단 칩에 표시...   │
├──────────────────────────────────────────┤
│                                  [ 닫기 ]│
└──────────────────────────────────────────┘
```

### 행 컴포넌트 위치

| Component | Before | After |
|---|---|---|
| `ToggleRow` | `replay/settings/ToggleRow.tsx` | `live/settings/ToggleRow.tsx` (이동) |
| `NumericPrefRow` | `replay/SettingsModal.tsx` 내부 | `live/settings/NumericPrefRow.tsx` (추출). prop 시그니처 단순화 — `activeTabId` 제거 (글로벌 store) |
| `SourcePreferenceRadio` | `replay/SettingsModal.tsx` 내부 (named export) | `live/settings/SourcePreferenceRadio.tsx` (추출) |
| `VolumeProfileModeRow` | `replay/SettingsModal.tsx` 내부 | 삭제 (Non-goals) |

### 카테고리 필터 일관성

기존 `CHART_TOGGLES.filter((t) => categoryOf(t) === 'chart')` 패턴을 `LiveSettingsModal` 에서도 유지. `category: 'indicators'` 인 토글(예: `fillStrengthCumulative`)은 settings 모달에 노출되지 않고, 별도 `IndicatorPanel` 이 IndicatorsSection 시절과 동일하게 책임.

**점검 필요 항목** (plan 단계): `fillStrengthCumulative` 가 현재 `/live IndicatorPanel` UI에 실제로 노출되어 있는지 확인. 노출되지 않았다면 (a) `IndicatorPanel` 에 추가하거나 (b) `categoryOf` 분류를 재검토하여 정합성을 맞춤.

### 키보드/접근성

- ESC → close
- backdrop click → close
- 헤더 `✕` 버튼 → close
- `role="dialog"`, `aria-modal="true"`, `aria-label="설정"`

## Migrated options — 실제 적용 보장

| 옵션 | 적용 경로 | 작업 |
|---|---|---|
| `auctionWindowMask` (데이터 마스킹) | `RATIO_SPEC`, `QUOTE_TOTALS_SPEC`, `FILL_STRENGTH_SPEC` 모두 `useActivePrefs((p) => p.auctionWindowMask)` 호출 — `isAuctionHidden(axis, mask, t)` 로 15:20–15:30 KST 마스킹. live 분봉(`1m`/`3m`/`5m`/`15m`) `PANE_SPECS` 에 포함 | 자동 적용 (store만 교체) |
| `auctionWindowMask` (시각 음영 overlay) | `AuctionWindowOverlay` 는 `useActivePrefs((p) => p.auctionWindowMask)` 로 self-gating. 현재 `LiveChartRoot` 에 마운트되지 않음 | **`LiveChartRoot` 에 `<AuctionWindowOverlay />` 마운트 추가** (`<DayBoundaryOverlay>` 옆) |
| `ratioOutlierFilterEnabled` + `ratioOutlierThreshold` | `chart/projectors/ratio.ts` 가 두 값 모두 `useActivePrefs` 로 읽음. `RATIO_SPEC` 는 live 분봉 pane에 포함 | 자동 적용 |
| `SourcePreference (hogaplay/kis_live)` | 글로벌 `useSourcePreferenceStore` — `api/range.ts` (live `useLiveBundle` 가 호출), `api/useLiveCursor.ts` 모두 이미 읽음 | 자동 적용 (UI만 옮김) |

## Deletion list

### `replay/` 디렉토리 (전체)

- `pages/ReplayViewer.tsx`
- `replay/TabStrip.tsx` + test
- `replay/Tab.tsx`
- `replay/Toolbar.tsx` + test
- `replay/PriceStrip.tsx`
- `replay/OnboardingCard.tsx`
- `replay/Workarea.tsx` + test
- `replay/SettingsModal.tsx` + test (행 컴포넌트는 추출 후 `live/settings/` 로 이동)
- `replay/CollapsedSidebarHandle.tsx` + test
- `replay/DateRangePicker.tsx`
- `replay/DrawingMenu.tsx` → **삭제 아님. live로 이동/리네임** (`live/LiveDrawingMenu.tsx`). Drawing Tool 메뉴는 live로 이관 (Drawing migration 섹션 참조)
- `replay/InvariantOutcomesBanner.tsx` + test → **삭제 아님. live로 이동** (`live/InvariantOutcomesBanner.tsx`). 현재 `LiveWorkarea.tsx:6` 가 import 중이라 live의 invariant warning 표시가 깨지면 안 됨. test도 같이 이동
- `replay/RangeAdjustmentNotice.tsx` + test
- `replay/SourcePreferenceRadio.test.tsx` (named import는 live로 이전된 컴포넌트가 받음)
- `replay/StockCombobox.tsx`
- `replay/TimeframeSelector.tsx` + test
- `replay/settings/IndicatorsSection.tsx` + test
- `replay/settings/ToggleRow.tsx` (이동)

### State 모듈

- `state/tabs.ts`
- `state/tabsPersistence.ts`
- `state/url.ts`
- `state/toolbarDraft.ts`
- `state/replayLayout.ts`

### chartPrefs 정리

- `volumeProfileMode` 필드, `'range' | 'per-day'` 타입, 관련 default
- `movingAverages` 필드, `MAConfig`, `MAIndex`, `MA_SLOT_COUNT`, `DEFAULT_MOVING_AVERAGES`
- `chart/VolumeProfileOverlay.tsx` (호출처 없음 검증 후)
- `chart/projectors/movingAverage.ts`: live `MovingAverageOverlay` 가 자체 `useLivePageStore` 만 사용한다면 (replay `Workarea` 가 유일 소비자) 파일 통째 삭제. 만약 live가 이 모듈의 일부(예: `MOVING_AVERAGE_SPEC`, projector 함수)를 import한다면 해당 부분만 `state/tabs` import 분리하여 보존, 나머지(`MA_SLOT_COUNT` registry 등 replay-shaped 부분) 삭제. **검증은 plan 단계** (`grep -r "chart/projectors/movingAverage" frontend/src`)
- `registerTabsStore`, `_activeTabPrefsStore`, 관련 throw 가드
- `chart/ChartPrefsContext.tsx` (사용처 grep으로 확인 후 unused면 삭제)

### Inventory

- `inventory/StockDateGroupDetail.tsx` 의 `onRowClick` 핸들러 + `useTabsStore` import + `navigate('/replay')`
- 행 시각 스타일에서 cursor-pointer, hover 효과 제거

## Testing strategy

### 삭제되는 테스트

`replay/*.test.tsx` 전체 (위 deletion list와 동일). state 모듈 테스트도 함께.

### 신규/수정 테스트

- `live/LiveSettingsModal.test.tsx` (신규)
  - ⚙ 버튼 클릭 → 모달 오픈
  - 각 토글 클릭 → `useChartPrefsStore` mutation 확인
  - 숫자 입력 commit-on-blur / Enter / 범위 검증 / 무효 입력 revert
  - SourcePreferenceRadio 클릭 → `useSourcePreferenceStore` mutation
  - ESC / backdrop / `✕` 닫기
- `live/LiveToolbar.test.tsx` (수정)
  - ⚙ 버튼 노출 + 클릭 시 `onOpenSettings` 호출
- `live/LiveChartRoot.test.tsx` (수정)
  - `<AuctionWindowOverlay />` 가 분봉 timeframe에서 마운트됨을 확인 (toggle on/off 시 회색 음영 노출 분기)
- `state/chartPrefs.test.ts` (신규 또는 기존 확장)
  - store setter 동작
  - persist 키 (`hoga.chart.prefs.v1`) 검증
  - `mergePrefs` 가 invalid 값 거부 후 default 폴백
- 무수정 유지: `chart/projectors/ratio.test.ts`, `fillStrength.test.ts`, `quoteTotals.test.ts` — `useActivePrefs` 시그니처 불변

### Verification gate

- `uv run pytest` (백엔드 회귀 없음 확인)
- `cd frontend && npm run build` (타입 + 빌드 통과)
- 수동: 로컬에서 `/`, `/live`, `/replay` 접속 시 동작
  - `/` → `/live` 즉시 redirect
  - `/live` → ⚙ 모달 오픈, 4개 옵션 동작 (auctionWindowMask 토글 시 회색 음영 + 데이터 마스킹 동시 반영, ratio 필터 토글, threshold 변경, source 라디오)
  - `/replay` → 404 (또는 라우터의 fallback)

## Risks

| 위험 | 완화책 |
|---|---|
| chart/projectors 외에 `useTabsStore` 직접 참조처가 더 있을 수 있음 (예: 알려지지 않은 hook) | plan 단계에서 `grep -r "useTabsStore\|state/tabs"` 전수 조사 |
| `MovingAverages` 가 정말 live에서 무관한지 검증 | `chart/projectors/movingAverage.ts` 호출처를 `grep -r "movingAverage" frontend/src` 로 전수 조사. 결과 분기: (a) `replay/Workarea` 만 호출 → 파일 삭제, (b) live가 일부 export 사용 → 사용 부분만 `state/tabs` 의존성 끊고 보존, 나머지 삭제 |
| `categoryOf('fillStrengthCumulative') === 'indicators'` 가 live `IndicatorPanel` 에 실제로 노출되는지 | plan 단계 점검 항목으로 등록. 누락 시 IndicatorPanel에 행 추가 또는 category 재분류 |
| `state/persistentSubscriber.ts` 가 `tabsPersistence.ts` 와 `replayLayout.ts` 만 호출자라면 같이 삭제 | plan 단계 grep로 확인. 다른 호출자 없으면 삭제 |
| inventory 행 클릭 비활성화 후 사용자가 혼란 | hover 효과 / cursor 스타일도 제거하여 클릭 가능 시그널 자체 제거 |
| 기존 `replay.tabs.v?` localStorage 키 화석화 | 코드는 더 이상 읽지 않음. 명시적 cleanup은 별도 작업. 새 키(`hoga.chart.prefs.v1`)와 충돌 없음 |
| LiveSidebar/sidebar 공유 컴포넌트가 replay에 의존하지 않는지 | `sidebar/CursorSidebar`, `OrderbookTable`, `BrokerTrajectoryTable`, `TotalQtyBar` 는 `sidebar/` 디렉토리 — replay 디렉토리 밖이라 보존. 검증: `grep replay frontend/src/sidebar/` |

## Doc updates (grill-with-docs 발견)

### CONTEXT.md (자동 적용 완료)

- "Source Preference" entry — `/live` 가 Source Preference를 consult한다는 사실 반영 (`useLiveBundle` → `useRange`, `useLiveCursor`). UI 노출 위치도 `LiveSettingsModal` 로 갱신.
- "Cursor Sidebar" entry — replay 종속 표현 제거, `/live` 단일 consumer로 갱신. user-resize / collapse 기능이 사라짐을 명시.

### CONTEXT.md (plan 후속 작업)

- "Replay Tab" entry — replay 삭제와 함께 entry 자체 삭제. `ChartViewPrefs`는 "Replay Tab 한정" → "글로벌 chartPrefs" 의미로 별도 entry로 분리하거나 인라인 정의.
- "Drawing" / "Drawing Overlay" / "Drawing Property Panel" / "Drawing Tool" / "Default Drawing Style" entries — "Replay Viewer toolbar" / "ChartStage" 언급을 `/live` / `LiveChartRoot` 로 갱신.
- "Volume Profile" entry — `volumeProfileMode` 삭제와 함께 entry 삭제 (또는 wire field 정의만 남기고 UI 부분 제거).
- "Replay" 라는 단어를 prose에서 찾아 일괄 정리 (orderbook replay 라는 브랜드 카피만 남기고 나머지 정정).
- _Avoid_ 목록에서 "Replay Tab" 관련 항목 정리.

### ADR supersede (plan 후속 작업)

- **ADR-0014** (replay-single-timeframe): replay 페이지 자체가 사라지므로 status를 `superseded by /replay removal (2026-05-29)` 로 갱신. ADR의 결정 자체는 historical context로 보존.
- **ADR-0022** (runtime-sidebar-width-user-owned): `replayLayout.ts` 삭제로 결정의 implementation이 사라짐. status를 superseded로 갱신.
- **ADR-0046** (live-ma-fork-from-replay): "fork" 라는 표현 자체가 의미 무효 (one side가 사라짐). status를 superseded로 갱신, 또는 "live MA는 `useLivePageStore`에 자체 슬라이스로 존재" 라는 단순화된 진술로 갱신.

### ADR 영향 없는 것

- ADR-0026 (ratio-outlier-mask-frontend-label-units): 결정 그대로 유효. 표현만 갱신 (선택)
- ADR-0027 (chart-numeric-prefs-registry): registry 패턴 보존 — 영향 없음
- ADR-0029 (auction-mask-hide-not-zero): mask semantics 그대로 — 영향 없음
- ADR-0039 (source-preference-fallback): spec과 일치 — 영향 없음
- ADR-0041 (live-calendar-timeframe-panes): live D/W/M 결정 그대로 — 영향 없음
- ADR-0044 (live-hover-spot-from-parquet): hover 동작 그대로 — 영향 없음
- ADR-0024 / ADR-0028 / ADR-0030 / ADR-0032 (Drawing 관련): Drawing 기능이 live로 이관되므로 결정 자체 유효. 표현 정정만 plan 후속.

## Out of scope (재확인)

- `volumeProfileMode` 옵션 보존 또는 `/live` 에 VolumeProfileOverlay 도입
- replay 영속 키(`replay.tabs.v?` 등) cleanup
- MovingAverages 로직 통합 (live 자체 dynamic MA를 chartPrefs로 통합)
- `/replay` 진입 시 안내 페이지(soft-deprecation banner)
- 새 디자인 시스템 변경 — `DESIGN.md` 기반 토큰/타입/색상 그대로 사용
