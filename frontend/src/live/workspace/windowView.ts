/**
 * WindowView — 멀티창 워크스페이스의 창-스코프 뷰 컨텍스트 (ADR-0119, PR-B).
 *
 * 차트/데이터 소비자(useLiveBundle·LivePage·LiveChartRoot…)는 지금까지 활성 뷰의
 * (code, timeframe, historicalFromDate, 지표)를 전역 `useLivePageStore` 에서 직독했다.
 * 멀티창에서는 이 값들이 창마다 달라야 하므로, 소비자를 이 컨텍스트 훅으로 절단한다.
 *
 * **핵심 계약: Provider 밖에서는 전역 스토어로 폴백한다.** 따라서 이 절단 자체는
 * 기능 무변경이다 — 아직 어떤 창도 `WindowViewContext.Provider` 로 감싸지 않으므로
 * (그건 PR-C) 항상 전역 값을 본다. `/study` 도 Provider 없이 렌더되므로 무변경.
 * 창별 Provider 가 붙는 순간(PR-C) 같은 소비자가 창의 값을 보게 된다.
 *
 * 범위: 데이터 페치 경로만(code·timeframe·historicalFromDate·지표). 크로스헤어/축
 * 동기화는 PR-D, venue 는 전역 유지(#715), ambient 투영 원본 교체는 #712/PR-C.
 *
 * (컴포넌트를 export 하지 않는 `.ts` — Provider 는 컨텍스트를 직접 쓰는 쪽[테스트·
 * PR-C]에서 `<WindowViewContext.Provider>` 로 감싼다. react-refresh 규약상 훅·컨텍스트
 * 와 컴포넌트를 한 파일에 섞지 않는다.)
 */
import { createContext, useContext, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useLivePageStore, type LiveTimeframe } from '../../state/livePage';
import {
  FACTORY_INDICATOR_SETTINGS,
  INDICATOR_SETTING_KEYS,
  resolveIndicatorSettings,
  type IndicatorSettings,
} from '../../state/indicatorSettingsV2';
import { INDICATOR_OPS, bindIndicatorOps, type BoundIndicatorOps } from '../../state/indicatorOps';
import { useWorkspaceStore, type GroupId } from '../../state/workspace';
import type { PaneId } from '../../chart/drawing/types';
import { normalizePaneOrder, type PaneStretchMap } from '../../chart/paneOrder';
import type { PanePrefKey } from '../indicators/indicatorPaneProfiles';
import type { PresetEnableByTimeframe } from '../presets/presetFlags';

export interface WindowView {
  /** null = 전역(창 없음, Provider 밖). */
  windowId: string | null;
  group: GroupId | null;
  code: string | null;
  timeframe: LiveTimeframe;
  historicalFromDate: string | null;
}

/** 창이 자기 지표(resolve 된 IndicatorSettings)까지 공급하는 완전한 뷰 값. */
export interface WindowViewValue extends WindowView {
  indicators: IndicatorSettings;
}

export const WindowViewContext = createContext<WindowViewValue | null>(null);

/**
 * 창의 (code, timeframe, historicalFromDate, group). Provider 밖에서는 전역
 * `useLivePageStore` 로 폴백 → 기존 단일 뷰 동작 그대로.
 */
export function useWindowView(): WindowView {
  const ctx = useContext(WindowViewContext);
  const code = useLivePageStore((s) => s.activeCode);
  const timeframe = useLivePageStore((s) => s.candleTimeframe);
  const historicalFromDate = useLivePageStore((s) => s.historicalFromDate);
  return useMemo(
    () => ctx ?? { windowId: null, group: null, code, timeframe, historicalFromDate },
    [ctx, code, timeframe, historicalFromDate],
  );
}

/**
 * 창의 resolve 된 IndicatorSettings. Provider 밖에서는 전역 스토어의 ambient 투영
 * (=현재 봉으로 resolve 된 최상위 IndicatorSettings 필드)으로 폴백. `useShallow` 로
 * 필드 단위 얕은 비교 → 무관한 스토어 변경에 재렌더하지 않는다.
 */
export function useWindowIndicators(): IndicatorSettings {
  const ctx = useContext(WindowViewContext);
  const global = useLivePageStore(
    useShallow((s): IndicatorSettings => {
      const out: Partial<IndicatorSettings> = {};
      for (const k of INDICATOR_SETTING_KEYS) {
        (out as Record<string, unknown>)[k] = s[k];
      }
      return out as IndicatorSettings;
    }),
  );
  return ctx ? ctx.indicators : global;
}

/**
 * 지표 설정 단일-값 selector — 오버레이/차트 소비자의 세밀 구독용.
 * Provider 안 = 창의 resolve 된 설정에서 select(창 값 변경은 어차피 서브트리
 * 재렌더). 밖 = 전역 스토어에 selector 구독을 그대로 위임해 **필드 단위 재렌더
 * 입도를 보존**한다(ctx 가 있으면 상수 selector 로 전역 구독을 무력화).
 */
export function useWindowIndicator<T>(select: (s: IndicatorSettings) => T): T {
  const ctx = useContext(WindowViewContext);
  const global = useLivePageStore(
    (s) => (ctx ? undefined : select(s as unknown as IndicatorSettings)),
  );
  return ctx ? select(ctx.indicators) : (global as T);
}

const DEFAULT_PANE_ORDER: PaneId[] = normalizePaneOrder([]);

/** pane 순서 — 레이아웃 슬라이스(IndicatorSettings 밖). 창=chart.indicators.paneOrder,
 *  밖=전역 paneOrder. 두 구독 모두 비활성 분기에서 상수 selector 로 무력화. */
export function useWindowPaneOrder(): PaneId[] {
  const ctx = useContext(WindowViewContext);
  const windowId = ctx?.windowId ?? null;
  const fromWindow = useWorkspaceStore((s) =>
    windowId ? s.windows.find((w) => w.id === windowId)?.chart?.indicators.paneOrder : undefined,
  );
  const fromGlobal = useLivePageStore((s) => (windowId ? undefined : s.paneOrder));
  return fromWindow ?? fromGlobal ?? DEFAULT_PANE_ORDER;
}

const EMPTY_PANE_STRETCH: PaneStretchMap = {};

/** pane 크기 가중치(#703) — paneOrder 와 같은 레이아웃 슬라이스 규율. */
export function useWindowPaneStretch(): PaneStretchMap {
  const ctx = useContext(WindowViewContext);
  const windowId = ctx?.windowId ?? null;
  const fromWindow = useWorkspaceStore((s) =>
    windowId ? s.windows.find((w) => w.id === windowId)?.chart?.indicators.paneStretch : undefined,
  );
  const fromGlobal = useLivePageStore((s) => (windowId ? undefined : s.paneStretch));
  return fromWindow ?? fromGlobal ?? EMPTY_PANE_STRETCH;
}

// ── 쓰기 경로 (ADR-0119 C2c-2a) ──────────────────────────────────────────────

/**
 * 지표 편집 표면 — indicatorOps 45종 + 레이아웃/버킷 관리 5종. 드로어·pane
 * 레전드·차트 내 조작이 전부 이 표면만 호출한다. Provider 안=대상 창의 봉
 * 버킷(#712 창 소유 설정), 밖=전역 `useLivePageStore`(기존 단일 뷰·`/study`).
 */
export type IndicatorActions = BoundIndicatorOps & {
  setPanePrefForTimeframe: (timeframe: LiveTimeframe, key: PanePrefKey, enabled: boolean) => void;
  setPaneOrder: (order: PaneId[]) => void;
  setPaneStretch: (patch: PaneStretchMap) => void;
  resetIndicators: () => void;
  applyIndicatorPreset: (preset: {
    paneOrder: PaneId[];
    byTimeframeEnable: PresetEnableByTimeframe;
    paneStretch: PaneStretchMap;
  }) => void;
};

function buildGlobalIndicatorActions(): IndicatorActions {
  // zustand setter 는 스토어 생성 시 1회 만들어지는 안정 참조 — 1회 pick 으로 충분.
  const s = useLivePageStore.getState();
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(INDICATOR_OPS)) {
    out[name] = (s as unknown as Record<string, unknown>)[name];
  }
  out.setPanePrefForTimeframe = s.setPanePrefForTimeframe;
  out.setPaneOrder = s.setPaneOrder;
  out.setPaneStretch = s.setPaneStretch;
  out.resetIndicators = s.resetIndicators;
  out.applyIndicatorPreset = s.applyIndicatorPreset;
  return out as unknown as IndicatorActions;
}

function buildWindowIndicatorActions(windowId: string): IndicatorActions {
  // 모든 읽기/쓰기를 호출 시점 getState() 로 — 렌더 시점 설정을 클로저에 가두면
  // 연속 편집(색상 드래그 등)에서 stale read 로 직전 값이 덮인다.
  const ws = () => useWorkspaceStore.getState();
  const readSettings = (): IndicatorSettings => {
    const win = ws().windows.find((w) => w.id === windowId);
    return win?.chart
      ? resolveIndicatorSettings(win.chart.indicators.byTimeframe, win.chart.timeframe)
      : FACTORY_INDICATOR_SETTINGS;
  };
  return {
    ...bindIndicatorOps(readSettings, (patch) => ws().patchChartIndicators(windowId, patch)),
    // 창 모드의 "현재 봉" = 창의 timeframe. 호출자가 넘긴 tf 는 구성상 항상 그와
    // 같다(드로어·pane 닫기 모두 대상 창의 tf 를 넘긴다) — 창의 tf 를 쓴다.
    setPanePrefForTimeframe: (_timeframe, key, enabled) =>
      ws().patchChartIndicators(windowId, { [key]: enabled }),
    setPaneOrder: (order) => ws().setChartPaneOrder(windowId, order),
    setPaneStretch: (patch) => ws().setChartPaneStretch(windowId, patch),
    resetIndicators: () => ws().resetChartIndicators(windowId),
    applyIndicatorPreset: (preset) => ws().applyChartIndicatorPreset(windowId, preset),
  };
}

/** 지표 편집 액션 — Provider 안=창 백엔드, 밖=전역 폴백(`/study` 무변경 계약). */
export function useIndicatorActions(): IndicatorActions {
  const ctx = useContext(WindowViewContext);
  const windowId = ctx?.windowId ?? null;
  return useMemo(
    () => (windowId ? buildWindowIndicatorActions(windowId) : buildGlobalIndicatorActions()),
    [windowId],
  );
}

/**
 * 발화 시점 fresh 뷰 가드 — 디바운스/타이머 콜백이 "이 차트의 (code, timeframe)이
 * 아직 활성인가"를 검사할 때 쓴다. 렌더 클로저가 아니라 **호출 시점 getState** 라
 * 스토어 변경 직후 React 재렌더 전에 발화해도 stale 하지 않다(전역 getState 가드의
 * 창별 대응물).
 */
type ViewGuard = () => { code: string | null; timeframe: LiveTimeframe };

function buildWindowViewGuard(windowId: string): ViewGuard {
  return () => {
    const s = useWorkspaceStore.getState();
    const win = s.windows.find((w) => w.id === windowId);
    return {
      code: win ? s.groupSymbols[win.group]?.code ?? null : null,
      timeframe: win?.chart?.timeframe ?? '1m',
    };
  };
}

const GLOBAL_VIEW_GUARD: ViewGuard = () => {
  const s = useLivePageStore.getState();
  return { code: s.activeCode, timeframe: s.candleTimeframe };
};

export function useWindowViewGuard(): ViewGuard {
  const ctx = useContext(WindowViewContext);
  const windowId = ctx?.windowId ?? null;
  return useMemo(
    () => (windowId ? buildWindowViewGuard(windowId) : GLOBAL_VIEW_GUARD),
    [windowId],
  );
}

/** 좌측 팬 딥 백필의 창별 from-date 액션 + imperative 스냅샷(effect/콜백용). */
export interface HistoricalRangeActions {
  extend: (date: string) => void;
  reset: () => void;
  snapshot: () => { historicalFromDate: string | null; lastMinuteHistoricalFromDate: string | null };
}

export function useHistoricalRangeActions(): HistoricalRangeActions {
  const ctx = useContext(WindowViewContext);
  const windowId = ctx?.windowId ?? null;
  return useMemo(() => {
    if (windowId) {
      const ws = () => useWorkspaceStore.getState();
      return {
        extend: (date: string) => ws().extendChartHistoricalRange(windowId, date),
        reset: () => ws().resetChartHistoricalRange(windowId),
        snapshot: () => ws().chartRuntime[windowId]
          ?? { historicalFromDate: null, lastMinuteHistoricalFromDate: null },
      };
    }
    const ps = () => useLivePageStore.getState();
    return {
      extend: (date: string) => ps().extendHistoricalRange(date),
      reset: () => ps().resetHistoricalRange(),
      snapshot: () => ({
        historicalFromDate: ps().historicalFromDate,
        lastMinuteHistoricalFromDate: ps().lastMinuteHistoricalFromDate,
      }),
    };
  }, [windowId]);
}
