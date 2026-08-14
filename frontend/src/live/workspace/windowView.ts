/**
 * WindowView — 멀티창 워크스페이스의 창-스코프 뷰 컨텍스트 (ADR-0119, PR-B).
 *
 * 차트/데이터 소비자(useLiveBundle·LivePage·LiveChartRoot…)는 지금까지 활성 뷰의
 * (code, timeframe, historicalFromDate, 지표)를 전역 `useLivePageStore` 에서 직독했다.
 * 멀티창에서는 이 값들이 창마다 달라야 하므로, 소비자를 이 컨텍스트 훅으로 절단한다.
 *
 * **핵심 계약: Provider 밖에서는 전역 스토어로 폴백한다.** 그래서 이 절단은 도입
 * 당시 기능 무변경이었고, 지금도 Provider 없이 렌더되는 경로(테스트·단일 차트)가
 * 종전대로 동작한다.
 *
 * **지표 스코프는 두 단계다: 봉, 그리고 창(opt-in).** 기본은 앱 전역 공용 1세트
 * (`live.indicators.v2`)이고 창이 정하는 것은 **어느 봉 버킷인가** 뿐 — 이게 종전
 * 동작이고 지금도 대부분의 창이 그렇다. 사용자가 한 창을 **명시적으로 분리**하면
 * (드로어의 "이 창만 따로") 그 창은 자기 버킷 세트를 갖는다.
 *
 * 한때 창이 설정을 통째로 소유했다가(#712) 되돌린 적이 있는데, 그 사고의 원인은
 * 창-스코프 자체가 아니라 **설정의 내용물을 창 스냅샷에 담은 것**이었다 —
 * 워크스페이스는 탭별 sessionStorage 라 지표가 브라우저 탭마다 갈렸다. 지금은
 * 내용물이 전역 localStorage 에 있고 창이 소유하는 것은 **키뿐**이라, 크로스탭
 * 동기화(`subscribeToIndicatorsStorage`)가 분리된 창까지 그대로 덮는다.
 *
 * 범위: 데이터 페치 경로만(code·timeframe·historicalFromDate·지표 resolve).
 * 크로스헤어/축 동기화는 PR-D, venue 는 전역 유지(#715).
 *
 * (컴포넌트를 export 하지 않는 `.ts` — Provider 는 컨텍스트를 직접 쓰는 쪽[테스트·
 * PR-C]에서 `<WindowViewContext.Provider>` 로 감싼다. react-refresh 규약상 훅·컨텍스트
 * 와 컴포넌트를 한 파일에 섞지 않는다.)
 */
import { useContext, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useLivePageStore, type LiveTimeframe } from '../../state/livePage';
import {
  INDICATOR_SETTING_KEYS,
  bucketsForScope,
  isWindowScopeDetached,
  resolveIndicatorSettings,
  type IndicatorSettings,
} from '../../state/indicatorSettingsV2';
import { INDICATOR_OPS, bindIndicatorOps, type BoundIndicatorOps } from '../../state/indicatorOps';
import { useWorkspaceStore } from '../../state/workspace';
import type { PaneId } from '../../chart/drawing/types';
import type { PaneStretchMap } from '../../chart/paneOrder';
import type { PanePrefKey } from '../indicators/indicatorPaneProfiles';
import type { PresetEnableByTimeframe } from '../presets/presetFlags';
import {
  WindowViewContext,
  windowScopeKey,
  type WindowView,
  type WindowWorkspaceAdapter,
} from './windowViewContext';

// 컨텍스트 객체·타입은 `windowViewContext.ts` 가 소유한다(chartPrefs 순환 회피 —
// 그 파일 상단 주석 참조). 소비자 호환을 위해 여기서 그대로 re-export 한다.
export { WindowViewContext, windowScopeKey } from './windowViewContext';
export type {
  WindowChartStoreState,
  WindowStoreHandle,
  WindowView,
  WindowViewValue,
  WindowWorkspaceAdapter,
} from './windowViewContext';

/**
 * `/live` 워크스페이스 어댑터 — `ChartWindow`·`WorkspaceIndicatorDrawer` 가 Provider
 * 값에 실어 준다. 모듈 상수라 참조가 안정적이다(useMemo 의존성으로 넣을 필요 없음).
 */
export const LIVE_WINDOW_WORKSPACE: WindowWorkspaceAdapter = {
  store: useWorkspaceStore,
  getCode: (windowId) => {
    const s = useWorkspaceStore.getState();
    const win = s.windows.find((w) => w.id === windowId);
    return win ? s.groupSymbols[win.group]?.code ?? null : null;
  },
  scopePrefix: 'live',
};

/**
 * Provider 밖(전역 경로)에서 훅 호출 횟수를 맞추기 위한 스토어.
 *
 * 창-스코프 훅들은 `windowId` 가 없어도 스토어 selector 를 **호출은 해야 한다**
 * (조건부 훅 금지). 그때 selector 는 상수를 돌려주므로 구독이 깨어나지 않아
 * 재렌더 비용이 0 이다 — 종전 `useWorkspaceStore` 하드코딩과 동작이 같다.
 */
const FALLBACK_STORE = LIVE_WINDOW_WORKSPACE.store;

/**
 * 창의 (code, timeframe, historicalFromDate, group). Provider 밖에서는 전역
 * `useLivePageStore` 로 폴백 → 기존 단일 뷰 동작 그대로.
 */
export function useWindowView(): WindowView {
  const ctx = useContext(WindowViewContext);
  // 형제 훅(useWindowIndicator·useWindowPaneOrder)과 같은 규율: Provider 안에서는
  // 상수 selector 로 전역 구독을 무력화한다(리뷰 F7). 안 그러면 미러 effect 의
  // livePage 쓰기(포커스/봉 전환 시)가 무관한 모든 차트 창의 useWindowView 구독을
  // 깨워 LiveChartRoot 서브트리를 한 패스 더 재렌더한다.
  const code = useLivePageStore((s) => (ctx ? null : s.activeCode));
  const timeframe = useLivePageStore((s) => (ctx ? '1m' : s.candleTimeframe));
  const historicalFromDate = useLivePageStore((s) => (ctx ? null : s.historicalFromDate));
  return useMemo(
    () => ctx ?? { windowId: null, group: null, code, timeframe, historicalFromDate },
    [ctx, code, timeframe, historicalFromDate],
  );
}

/**
 * 이 서브트리의 창 식별자만(null = Provider 밖 = 전역). **전역 스토어를 구독하지
 * 않는다** — 비반응형 모듈 레지스트리(`flagLegendValueRegistry`)의 스코프 키처럼
 * "어느 창인가"만 필요한 소비자용. `useWindowView().windowId` 와 값은 같지만,
 * 그쪽은 Provider 밖에서 livePage 구독 3개를 만들어 무관한 활성 종목/봉 변경에도
 * 오버레이를 재렌더시킨다(`/study`·단일 차트에서 순손해).
 */
export function useWindowScopeId(): string | null {
  return useContext(WindowViewContext)?.windowId ?? null;
}

/**
 * 이 서브트리가 편집·표시하는 지표 봉 — **창 안에서만** 의미가 있다(밖은 null).
 *
 * 지표 설정은 앱 전역 1세트(`live.indicators.v2`)이고 창이 정하는 것은 봉뿐이라,
 * "어느 창인가" 는 "어느 버킷인가" 로 축소된다. 이 훅이 그 축소를 한 곳에 모아
 * 읽기(`useWindowIndicators`)·쓰기(`useIndicatorActions`)가 같은 버킷을 향하는 것을
 * 구조로 보장한다.
 *
 * Provider **밖**은 종전대로 전역 스토어의 **ambient 투영**(최상위
 * `IndicatorSettings` 필드)을 읽는다 — 그 투영은 세터가 유지하는 파생값이고
 * (`livePage` 지표 슬라이스 주석), 여기서 버킷 resolve 로 바꾸면 투영만 세팅하는
 * 기존 소비자·픽스처가 조용히 공장값을 보게 된다.
 */
function useWindowIndicatorTimeframe(): LiveTimeframe | null {
  return useContext(WindowViewContext)?.timeframe ?? null;
}

/**
 * 이 서브트리의 지표 스코프 키(`live:<id>`/`study:<id>`) — Provider 밖은 null.
 *
 * null 은 "분리되지 않음" 이 아니라 **"창이 없다"** 는 뜻이고, 두 경우 모두 공용
 * 세트를 본다. 분리 여부는 이 키로 저장소를 조회해야 알 수 있다
 * (`useIsWindowIndicatorsDetached`) — 키를 가진 창의 대다수는 연동 상태다.
 */
export function useWindowIndicatorScope(): string | null {
  const ctx = useContext(WindowViewContext);
  return windowScopeKey(ctx?.workspace, ctx?.windowId);
}

/** 이 창이 공용 세트에서 분리됐는가 — 드로어의 "이 창만 따로" 스위치 상태. */
export function useIsWindowIndicatorsDetached(): boolean {
  const scopeKey = useWindowIndicatorScope();
  return useLivePageStore((s) => isWindowScopeDetached(s.indicatorsByWindow, scopeKey));
}

/**
 * 이 서브트리의 resolve 된 IndicatorSettings. 창 안 = 전역 버킷을 창의 봉으로 편
 * 값(`resolveIndicatorSettings` 가 버킷 단위로 캐시하므로 참조가 안정적 — 다른 봉
 * 버킷만 바뀐 변경에는 재렌더하지 않는다), 밖 = ambient 투영을 `useShallow` 로
 * 필드 비교.
 */
export function useWindowIndicators(): IndicatorSettings {
  const timeframe = useWindowIndicatorTimeframe();
  const scopeKey = useWindowIndicatorScope();
  const ambient = useLivePageStore(
    useShallow((s): IndicatorSettings | undefined => {
      if (timeframe) return undefined; // 창 안 — 상수 selector 로 구독 무력화
      const out: Partial<IndicatorSettings> = {};
      for (const k of INDICATOR_SETTING_KEYS) {
        (out as Record<string, unknown>)[k] = s[k];
      }
      return out as IndicatorSettings;
    }),
  );
  const inWindow = useLivePageStore(
    (s) => (timeframe
      ? resolveIndicatorSettings(
        bucketsForScope(s.indicatorsByTimeframe, s.indicatorsByWindow, scopeKey),
        timeframe,
      )
      : undefined),
  );
  return (inWindow ?? ambient) as IndicatorSettings;
}

/**
 * 지표 설정 단일-값 selector — 오버레이/차트 소비자의 세밀 구독용.
 * 스토어 selector 안에서 값을 뽑으므로 **필드 단위 재렌더 입도가 보존된다**
 * (선택한 값이 그대로면 다른 지표를 바꿔도 재렌더 없음).
 */
export function useWindowIndicator<T>(select: (s: IndicatorSettings) => T): T {
  const timeframe = useWindowIndicatorTimeframe();
  const scopeKey = useWindowIndicatorScope();
  return useLivePageStore((s) => select(
    timeframe
      ? resolveIndicatorSettings(
        bucketsForScope(s.indicatorsByTimeframe, s.indicatorsByWindow, scopeKey),
        timeframe,
      )
      : (s as unknown as IndicatorSettings),
  ));
}

/**
 * 이 서브트리의 창이 포커스(zOrder 최상단)인가 — Provider 밖(단일 차트)에서는
 * 항상 true. 창마다 붙는 전역 키 리스너(드로잉 undo/도구 단축키 등)가 N 개
 * 중복 발화하지 않도록 포커스 창 하나만 처리하게 게이트한다(C2c-2b).
 */
export function useIsFocusedWindow(): boolean {
  const ctx = useContext(WindowViewContext);
  const windowId = ctx?.windowId ?? null;
  const store = ctx?.workspace.store ?? FALLBACK_STORE;
  const focused = store((s) =>
    windowId ? s.zOrder[s.zOrder.length - 1] === windowId : true,
  );
  return windowId ? focused : true;
}

/**
 * pane 순서 — 전역 1세트다(봉 무관, ADR-0114 §3 / #696). 창별 사본이 있던 시절엔
 * 창-스코프 폴백이 필요했지만, 지표가 전역으로 돌아오면서 레이아웃 슬라이스도
 * 함께 돌아왔다. 이름에 `Window` 가 남은 것은 소비자 호환 때문이다.
 */
export function useWindowPaneOrder(): PaneId[] {
  return useLivePageStore((s) => s.paneOrder);
}

/** pane 크기 가중치(#703) — paneOrder 와 같은 레이아웃 슬라이스 규율. */
export function useWindowPaneStretch(): PaneStretchMap {
  return useLivePageStore((s) => s.paneStretch);
}

// ── 쓰기 경로 (ADR-0119 C2c-2a) ──────────────────────────────────────────────

/**
 * 지표 편집 표면 — indicatorOps 45종 + 레이아웃/버킷 관리 5종. 드로어·pane
 * 레전드·차트 내 조작이 전부 이 표면만 호출한다. 백엔드는 언제나 전역
 * `useLivePageStore` 이고, Provider 안이면 **대상 창의 봉 버킷**에 쓴다.
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
  /** 이 창을 공용 세트에서 분리한다(현재 유효 설정을 복사 — 화면 무변경).
   *  Provider 밖에서는 분리할 창이 없어 no-op 다. */
  detachIndicators: () => void;
  /** 분리를 취소하고 공용 세트로 되돌린다(그 창의 오버라이드는 버려진다). */
  attachIndicators: () => void;
};

/**
 * 전역(Provider 밖) 판 — 스토어 세터를 그대로 집는다. 세터는 ambient 봉 버킷에
 * 쓰고 최상위 투영을 함께 갱신하므로, read-modify-write op 도 **투영을 읽는다**.
 * (zustand setter 는 스토어 생성 시 1회 만들어지는 안정 참조 — 1회 pick 으로 충분.)
 */
function buildGlobalIndicatorActions(): IndicatorActions {
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
  // 창이 없으면 분리할 대상이 없다. UI 는 이 스위치를 창 안에서만 렌더하므로
  // (드로어는 언제나 대상 창의 Provider 안) 도달하지 않는 분기다.
  out.detachIndicators = () => {};
  out.attachIndicators = () => {};
  return out as unknown as IndicatorActions;
}

/**
 * 창 판 — 백엔드는 같은 전역 스토어이고, 대상 버킷만 **이 창의 봉**으로 고정한다.
 *
 * 모든 읽기/쓰기가 호출 시점 `getState()` 다 — 렌더 시점 값을 클로저에 가두면
 * 연속 편집(색상 드래그 등)에서 stale read 로 직전 값이 덮이고, 봉을 바꾼 직후의
 * 편집이 이전 버킷으로 간다.
 */
function buildWindowIndicatorActions(
  windowId: string,
  workspace: WindowWorkspaceAdapter,
): IndicatorActions {
  const handle = workspace.store;
  // 스코프 키는 창 수명 동안 불변이다(`windowViewContext` 말미의 windowId 불변식)
  // — 그래서 호출마다 다시 만들지 않고 여기서 한 번 굳힌다.
  const scopeKey = windowScopeKey(workspace, windowId) as string;
  const ps = () => useLivePageStore.getState();
  const tf = (): LiveTimeframe =>
    handle.getState().windows.find((w) => w.id === windowId)?.chart?.timeframe ?? '1m';
  const readSettings = (): IndicatorSettings => {
    const s = ps();
    return resolveIndicatorSettings(
      bucketsForScope(s.indicatorsByTimeframe, s.indicatorsByWindow, scopeKey),
      tf(),
    );
  };
  return {
    ...bindIndicatorOps(readSettings, (patch) => ps().patchIndicatorsScoped(scopeKey, tf(), patch)),
    // 호출자가 넘긴 tf 의 버킷에 기록한다 — 정상 경로에선 이 창의 봉과 같지만,
    // 드로어 재타깃/stale 렌더에서 어긋나도 조용히 다른 버킷을 오염시키지 않는다.
    setPanePrefForTimeframe: (timeframe, key, enabled) =>
      ps().setPanePrefScoped(scopeKey, timeframe, key, enabled),
    // 레이아웃(pane 순서·크기)은 분리 대상이 아니다 — 전역 1세트 유지(ADR-0114 §3).
    setPaneOrder: (order) => ps().setPaneOrder(order),
    setPaneStretch: (patch) => ps().setPaneStretch(patch),
    resetIndicators: () => ps().resetIndicatorsScoped(scopeKey, tf()),
    // 프리셋은 공용 세트를 갈아끼운다 — 분리된 창은 영향받지 않는다(livePage 주석).
    applyIndicatorPreset: (preset) => ps().applyIndicatorPreset(preset),
    detachIndicators: () => ps().detachWindowIndicators(scopeKey),
    attachIndicators: () => ps().attachWindowIndicators(scopeKey),
  };
}

/** 지표 편집 액션 — Provider 안=이 창의 봉 버킷, 밖=전역 ambient 경로. */
export function useIndicatorActions(): IndicatorActions {
  const ctx = useContext(WindowViewContext);
  const windowId = ctx?.windowId ?? null;
  const workspace = ctx?.workspace ?? null;
  return useMemo(
    () => (windowId && workspace
      ? buildWindowIndicatorActions(windowId, workspace)
      : buildGlobalIndicatorActions()),
    [windowId, workspace],
  );
}

/**
 * 발화 시점 fresh 뷰 가드 — 디바운스/타이머 콜백이 "이 차트의 (code, timeframe)이
 * 아직 활성인가"를 검사할 때 쓴다. 렌더 클로저가 아니라 **호출 시점 getState** 라
 * 스토어 변경 직후 React 재렌더 전에 발화해도 stale 하지 않다(전역 getState 가드의
 * 창별 대응물).
 */
type ViewGuard = () => { code: string | null; timeframe: LiveTimeframe };

function buildWindowViewGuard(
  windowId: string,
  workspace: WindowWorkspaceAdapter,
): ViewGuard {
  return () => ({
    // 코드만 어댑터에 묻는다 — 스토어 모양으로 덮이지 않는 유일한 축이다
    // (`/live`=링크 그룹, `/study`=활성 저장뷰). 상세는 어댑터 타입 주석 참조.
    code: workspace.getCode(windowId),
    timeframe: workspace.store.getState().windows
      .find((w) => w.id === windowId)?.chart?.timeframe ?? '1m',
  });
}

const GLOBAL_VIEW_GUARD: ViewGuard = () => {
  const s = useLivePageStore.getState();
  return { code: s.activeCode, timeframe: s.candleTimeframe };
};

export function useWindowViewGuard(): ViewGuard {
  const ctx = useContext(WindowViewContext);
  const windowId = ctx?.windowId ?? null;
  const workspace = ctx?.workspace ?? null;
  return useMemo(
    () => (windowId && workspace ? buildWindowViewGuard(windowId, workspace) : GLOBAL_VIEW_GUARD),
    [windowId, workspace],
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
  const workspace = ctx?.workspace ?? null;
  return useMemo(() => {
    if (windowId && workspace) {
      const ws = () => workspace.store.getState();
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
  }, [windowId, workspace]);
}
