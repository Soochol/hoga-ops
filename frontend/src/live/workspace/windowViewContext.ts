/**
 * WindowViewContext — 창-스코프 뷰 컨텍스트의 **런타임 최소 모듈**.
 *
 * `windowView.ts` 에서 컨텍스트 객체와 그 타입만 떼어낸 파일이다. 훅 구현은
 * 그대로 `windowView.ts` 에 있고 여기 것을 re-export 한다 — 소비자는 종전대로
 * `windowView` 에서 import 하면 된다.
 *
 * 왜 쪼개는가: `state/chartPrefs.ts` 가 창의 봉을 알아야 하는데(indicator-modal
 * prefs 의 per-timeframe 버킷 resolve), `windowView.ts` 는 livePage·workspace
 * 스토어를 **런타임** import 한다. livePage 는 다시 chartPrefs 를 import 하므로
 * chartPrefs → windowView → livePage → chartPrefs 순환이 생긴다. 이 파일은
 * 런타임 의존이 `react` 뿐이고 나머지는 전부 `import type`(컴파일 시 소거)이라
 * 순환 없이 컨텍스트를 공유할 수 있다.
 */
import { createContext } from 'react';
import type { LiveTimeframe } from '../../state/livePage';
import type { IndicatorSettings } from '../../state/indicatorSettingsV2';
import type { ChartWindowConfig, ChartWindowRuntime, GroupId } from '../../state/workspace';
import type { PaneId } from '../../chart/drawing/types';
import type { PaneStretchMap } from '../../chart/paneOrder';
import type { PresetEnableByTimeframe } from '../presets/presetFlags';

export interface WindowView {
  /** null = 전역(창 없음, Provider 밖). */
  windowId: string | null;
  group: GroupId | null;
  code: string | null;
  timeframe: LiveTimeframe;
  historicalFromDate: string | null;
}

/**
 * 창-스코프 훅이 읽고 쓰는 워크스페이스 스토어의 **최소 상태**. `/live`
 * `useWorkspaceStore` 와 `/study` `useStudyWorkspaceStore` 가 이 모양을 공유하므로
 * (#906 이 창 설정 타입을 공유하게 만든 이유) 훅은 어느 쪽인지 몰라도 된다.
 *
 * `windows` 원소를 `{id, chart?}` 로만 좁힌 게 요점이다 — `/live` 의 `group`·`rect`,
 * `/study` 의 `kind` 처럼 한쪽에만 있는 필드에 훅이 손대지 못한다.
 */
export interface WindowChartStoreState {
  windows: readonly { id: string; chart?: ChartWindowConfig }[];
  zOrder: readonly string[];
  chartRuntime: Record<string, ChartWindowRuntime>;
  patchChartIndicators: (id: string, patch: Partial<IndicatorSettings>) => void;
  patchChartIndicatorsAt: (
    id: string, timeframe: LiveTimeframe, patch: Partial<IndicatorSettings>,
  ) => void;
  setChartPaneOrder: (id: string, order: PaneId[]) => void;
  setChartPaneStretch: (id: string, patch: PaneStretchMap) => void;
  resetChartIndicators: (id: string) => void;
  applyChartIndicatorPreset: (id: string, preset: {
    paneOrder: PaneId[];
    byTimeframeEnable: PresetEnableByTimeframe;
    paneStretch: PaneStretchMap;
  }) => void;
  extendChartHistoricalRange: (id: string, date: string) => void;
  resetChartHistoricalRange: (id: string) => void;
}

/**
 * 스토어 핸들 — **zustand 훅 그대로** 여야 한다. 평범한 함수 묶음(`getState` 만
 * 가진 객체)으로 바꾸면 `useWindowLayoutSlice`·`useIsFocusedWindow` 의 selector
 * 구독이 사라져 창 설정을 바꿔도 재렌더가 안 온다(#901 이 (A)안을 "핸들 주입 +
 * 창 모양 동형화" 한 결정으로 묶은 이유).
 */
export interface WindowStoreHandle {
  <T>(selector: (state: WindowChartStoreState) => T): T;
  getState: () => WindowChartStoreState;
}

/**
 * 창-스코프 훅이 워크스페이스에 닿는 유일한 통로.
 *
 * `store` 로 덮이지 않는 축이 하나 있다: **종목 코드**. `/live` 는 창의 링크 그룹
 * (`groupSymbols[win.group]`)에서 얻지만 `/study` 에는 그룹이 없고 활성 저장뷰가
 * 소스다. 창 모양을 아무리 맞춰도 이 축만은 스토어 밖이라, 코드를 아는 쪽(Provider)이
 * 해석기를 실어 준다. 렌더 클로저가 아니라 **호출 시점** 함수여야 한다 —
 * `useWindowViewGuard` 의 존재 이유가 fresh 읽기다.
 */
export interface WindowWorkspaceAdapter {
  store: WindowStoreHandle;
  getCode: (windowId: string) => string | null;
}

/** 창이 자기 지표(resolve 된 IndicatorSettings)와 워크스페이스 통로까지 공급하는
 *  완전한 뷰 값. `workspace` 는 **필수** — 빠뜨리면 훅이 조용히 다른 스토어를 보게
 *  되는데, 그 조용한 폴백이야말로 이 작업이 없애려는 것이다(#901). */
export interface WindowViewValue extends WindowView {
  indicators: IndicatorSettings;
  workspace: WindowWorkspaceAdapter;
}

// 불변식: 한 컴포넌트 인스턴스의 windowId 는 수명 동안 바뀌지 않는다(창=컴포넌트
// 1:1, WorkspaceCanvas 가 key=win.id 로 마운트). useMemo([windowId]) 캐시·effect
// deps 생략이 이 불변식에 기댄다 — 창 재사용(id 교체) 최적화 금지.
export const WindowViewContext = createContext<WindowViewValue | null>(null);
