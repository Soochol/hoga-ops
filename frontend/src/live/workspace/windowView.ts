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
 * **지표 스코프는 (페이지 × 창 × 봉)이다**(ADR-0146 + ADR-0152). `/live` 와
 * `/study` 는 각각 자기 페이지 세트를 갖고 **서로 동기화하지 않으며**, 그 안에서
 * 차트 창은 **항상 자기 세트**를 갖는다. 페이지 세트는 새 창의 시드 뿌리이자
 * Provider 밖 폴백으로 남는다.
 *
 * 이 축은 한 번 되돌아온 적이 있다: 창별 분리를 만들었다가 같은 날 걷어냈고
 * (#1327 → ADR-0146) — 그때 요구는 "창마다" 가 아니라 "두 페이지가 서로 안
 * 따라오게" 였다 — ADR-0146 이 예고한 재검토 트리거("한 페이지 안에서 창마다
 * 다른 지표")가 실제로 와서 ADR-0152 로 다시 얹었다. 그보다 앞서 창이 설정을
 * 통째로 **소유**하던 시절도 있었고(#712), 그건 내용물을 창 스냅샷(탭별
 * sessionStorage)에 담아서 지표가 브라우저 탭마다 갈렸다. 지금 세 세트는 모두
 * 전역 localStorage 에 있고 창이 갖는 것은 **키뿐**이라, 크로스탭 동기화
 * (`subscribeToIndicatorsStorage`)가 창별 설정까지 그대로 덮는다.
 *
 * 범위: 데이터 페치 경로만(code·timeframe·historicalFromDate·지표 resolve).
 * 크로스헤어/축 동기화는 PR-D, venue 는 전역 유지(#715).
 *
 * (컴포넌트를 export 하지 않는 `.ts` — Provider 는 컨텍스트를 직접 쓰는 쪽[테스트·
 * PR-C]에서 `<WindowViewContext.Provider>` 로 감싼다. react-refresh 규약상 훅·컨텍스트
 * 와 컴포넌트를 한 파일에 섞지 않는다.)
 */
import { useContext, useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useLivePageStore, type LiveTimeframe } from '../../state/livePage';
import {
  INDICATOR_SETTING_KEYS,
  bucketsForScope,
  resolveIndicatorSettings,
  type IndicatorScope,
  type IndicatorSettings,
} from '../../state/indicatorSettingsV2';
import { INDICATOR_OPS, bindIndicatorOps, type BoundIndicatorOps } from '../../state/indicatorOps';
import { useWorkspaceStore, windowSymbolOf } from '../../state/workspace';
import { indexWorkareaCode, isLiveIndexId } from '../liveInstrument';
import type { PaneId } from '../../chart/drawing/types';
import type { PaneStretchMap } from '../../chart/paneOrder';
import type { PanePrefKey } from '../indicators/indicatorPaneProfiles';
import type { PresetEnableByTimeframe } from '../presets/presetFlags';
import {
  WindowViewContext,
  windowScopeKey,
  type WindowView,
} from './windowViewContext';

// 컨텍스트 객체·타입은 `windowViewContext.ts` 가 소유한다(chartPrefs 순환 회피 —
// 그 파일 상단 주석 참조). 소비자 호환을 위해 여기서 그대로 re-export 한다.
export { WindowViewContext, windowScopeKey } from './windowViewContext';
export type {
  WindowChartStoreState,
  WindowView,
  WindowViewValue,
} from './windowViewContext';

/**
 * `/live` 워크스페이스 어댑터 — `ChartWindow`·`WorkspaceIndicatorDrawer` 가 Provider
 * 값에 실어 준다. 모듈 상수라 참조가 안정적이다(useMemo 의존성으로 넣을 필요 없음).
 *
 * ⚠ **주입 seam 의 거주자가 이제 하나다**(2026-08-23). 이 어댑터는 `/live`·`/study`
 * 두 워크스페이스를 같은 훅으로 다루려고 #907 이 만든 것인데 `/study` 가 사라졌다.
 * 지금은 죽은 일반화이고, 걷는 것은 별도 정리 작업이다 — 같은 부류가 셋 더 있다
 * (`IndicatorPageScope`, `workspace/zOrder.ts`·`groupId.ts` 의 공유 헬퍼). 한꺼번에
 * 보는 편이 낫다: 삭제안 문서 §9 참조.
 *
 * 그때까지 `scopePrefix` 는 항상 `'live'` 다. 새 코드에서 `'study'` 분기를 만들지 말 것.
 */
/**
 * 이 창의 코드를 **workarea 공간**으로 — 주식=6자리 코드, 지수=`index:<id>`
 * (`liveInstrument.ts` 의 `indexWorkareaCode`).
 *
 * 이름에 공간을 박아 둔 이유: `WindowViewValue.code` 는 **다른 공간**이다(지수=null,
 * 전역 `activeCode` 미러). 둘이 갈리는 것은 의도이고, 이름이 같으면 다음 사람이 아무
 * 생각 없이 바꿔 쓴다. 실제로 그 혼동이 지수 창의 좌측 팬 백필을 통째로 죽였다 —
 * 가드가 `'KOSPI' !== 'index:KOSPI'` 로 매번 반려했다.
 *
 * ⚠ 이 함수는 어댑터 객체(`LIVE_WINDOW_WORKSPACE.getWorkareaCode`)의 필드였다.
 * 주입이었던 이유는 `/study` 가 그룹이 아니라 활성 저장뷰에서 코드를 얻었기
 * 때문인데, 그 페이지가 사라져(ADR-0157) 구현이 하나가 됐다.
 */
function liveWorkareaCode(windowId: string): string | null {
  {
    const s = useWorkspaceStore.getState();
    const win = s.windows.find((w) => w.id === windowId);
    const sym = windowSymbolOf(s, win);
    if (!sym) return null;
    // `isLiveIndexId` 까지 보는 이유: `ChartWindow` 의 instrument 생성이 **정확히 같은
    // 조건**으로 거르고(`kind==='index' && isLiveIndexId(code)` 아니면 instrument=null
    // → workareaCode=null), 여기서 조건이 한 글자라도 넓으면 그 폴백 상태에서 가드가
    // `'index:쓰레기' !== ''` 로 다시 반려한다. 생산자와 조건을 맞춘다.
    return sym.kind === 'index' && isLiveIndexId(sym.code)
      ? indexWorkareaCode(sym.code)
      : sym.code;
  }
}

/**
 * Provider 밖(전역 경로)에서 훅 호출 횟수를 맞추기 위한 스토어.
 *
 * 창-스코프 훅들은 `windowId` 가 없어도 스토어 selector 를 **호출은 해야 한다**
 * (조건부 훅 금지). 그때 selector 는 상수를 돌려주므로 구독이 깨어나지 않아
 * 재렌더 비용이 0 이다 — 종전 `useWorkspaceStore` 하드코딩과 동작이 같다.
 */
const FALLBACK_STORE = useWorkspaceStore;

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
 * 페이지 세트 안에서 창이 정하는 것은 봉뿐이라, "어느 창인가" 는 "어느 버킷인가" 로
 * 축소된다. 이 훅이 그 축소를 한 곳에 모아 읽기(`useWindowIndicators`)·쓰기
 * (`useIndicatorActions`)가 같은 버킷을 향하는 것을 구조로 보장한다.
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
 * 이 서브트리의 지표 스코프 — 창 키 하나. Provider 밖은 null.
 *
 * 매 렌더 새 객체지만 소비자가 전부 이 값을 **스토어 selector 안에서만** 쓰므로
 * (구독 identity 에 실리지 않음) 재렌더를 유발하지 않는다. `useMemo` 를 씌우면
 * 오히려 의존성 배열이 하나 늘 뿐이다.
 */
export function useWindowIndicatorScope(): IndicatorScope {
  const ctx = useContext(WindowViewContext);
  return { windowKey: windowScopeKey(ctx?.windowId) };
}

/**
 * 이 창에 자기 지표 세트가 있는지 보장하는 **마운트 안전망**(ADR-0152).
 *
 * `addWindow` 가 이미 새 창을 포커스 창에서 시드하지만, 창이 생기는 경로는 그것만이
 * 아니다 — 업그레이드 직후의 기존 창, 레이아웃 프리셋 적용, 워크스페이스 스냅샷
 * 복원, 딥링크 탭의 시드 복제, 공장 기본 배치가 전부 시드를 거치지 않는다. 그
 * 창들이 페이지 세트를 **공유**하면 이 기능이 조용히 절반만 동작한다.
 *
 * 마운트 effect 인 이유: 저장소 로드 순서에 기대지 않고(워크스페이스는 탭별
 * sessionStorage, 지표는 전역 localStorage — 하이드레이션 순서가 보장되지 않는다),
 * 창이 실제로 렌더되는 시점에 한다. 시드가 멱등이라 재마운트·탭 전환에서 사용자
 * 값을 덮지 않는다.
 *
 * 언마운트를 회수 신호로 쓰지 **않는다** — 페이지 이탈·탭 전환에서도 언마운트가
 * 나는데 그때 지우면 돌아왔을 때 이유 없이 초기화된 창을 본다. 회수는 창 닫기
 * 같은 명시적 사건에서만 한다(`indicatorScopeGc`).
 */
export function useSeedWindowIndicatorScope(windowId: string | null): void {
  const scopeKey = windowScopeKey(windowId);
  useEffect(() => {
    if (!scopeKey) return;
    useLivePageStore.getState().seedWindowIndicatorScope({ windowKey: scopeKey });
  }, [scopeKey]);
}

/**
 * 이 서브트리의 resolve 된 IndicatorSettings. 창 안 = 전역 버킷을 창의 봉으로 편
 * 값(`resolveIndicatorSettings` 가 버킷 단위로 캐시하므로 참조가 안정적 — 다른 봉
 * 버킷만 바뀐 변경에는 재렌더하지 않는다), 밖 = ambient 투영을 `useShallow` 로
 * 필드 비교.
 */
export function useWindowIndicators(): IndicatorSettings {
  const timeframe = useWindowIndicatorTimeframe();
  const scope = useWindowIndicatorScope();
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
        bucketsForScope(s.indicatorsByTimeframe, s.indicatorsByWindow, scope),
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
  const scope = useWindowIndicatorScope();
  return useLivePageStore((s) => select(
    timeframe
      ? resolveIndicatorSettings(
        bucketsForScope(s.indicatorsByTimeframe, s.indicatorsByWindow, scope),
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
  const store = FALLBACK_STORE;
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
 * 지표 편집 표면 — indicatorOps 55종 + 레이아웃/버킷 관리 5종. 드로어·pane
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
  return out as unknown as IndicatorActions;
}

/**
 * 창 판 — 백엔드는 같은 전역 스토어이고, 대상 버킷만 **이 창의 봉**으로 고정한다.
 *
 * 모든 읽기/쓰기가 호출 시점 `getState()` 다 — 렌더 시점 값을 클로저에 가두면
 * 연속 편집(색상 드래그 등)에서 stale read 로 직전 값이 덮이고, 봉을 바꾼 직후의
 * 편집이 이전 버킷으로 간다.
 */
function buildWindowIndicatorActions(windowId: string): IndicatorActions {
  const handle = useWorkspaceStore;
  // 이 창의 스코프 — 창 id 가 컴포넌트 수명 동안 불변이라(windowViewContext 하단
  // 불변식) 이 객체도 창 수명 동안 그대로다.
  const scope: IndicatorScope = { windowKey: windowScopeKey(windowId) };
  const ps = () => useLivePageStore.getState();
  const tf = (): LiveTimeframe =>
    handle.getState().windows.find((w) => w.id === windowId)?.chart?.timeframe ?? '1m';
  const readSettings = (): IndicatorSettings => {
    const s = ps();
    return resolveIndicatorSettings(
      bucketsForScope(s.indicatorsByTimeframe, s.indicatorsByWindow, scope),
      tf(),
    );
  };
  return {
    ...bindIndicatorOps(readSettings, (patch) => ps().patchIndicatorsScoped(scope, tf(), patch)),
    // 호출자가 넘긴 tf 의 버킷에 기록한다 — 정상 경로에선 이 창의 봉과 같지만,
    // 드로어 재타깃/stale 렌더에서 어긋나도 조용히 다른 버킷을 오염시키지 않는다.
    setPanePrefForTimeframe: (timeframe, key, enabled) =>
      ps().setPanePrefScoped(scope, timeframe, key, enabled),
    // 레이아웃(pane 순서·크기)은 창 축 대상이 아니다 — 전역 1세트 유지(ADR-0114 §3).
    setPaneOrder: (order) => ps().setPaneOrder(order),
    setPaneStretch: (patch) => ps().setPaneStretch(patch),
    resetIndicators: () => ps().resetIndicatorsScoped(scope, tf()),
    // 지표 프리셋은 그 **페이지 세트**를 갈아끼운다 — 즉 이 창에는 보이지 않는다.
    // 현재 UI 진입점이 없는 휴면 표면이라 그대로 두되(ADR-0152 Consequences),
    // 되살릴 때는 "호출한 창에 적용" 으로 스코프를 실을 것.
    applyIndicatorPreset: (preset) => ps().applyIndicatorPreset(preset),
  };
}

/** 지표 편집 액션 — Provider 안=이 창의 봉 버킷, 밖=전역 ambient 경로. */
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
 *
 * `code` 는 **workarea 공간**이다 — 소비처(`useViewportBackfill`·`LiveChartRoot`)가
 * `LiveChartRoot` 의 `code` prop 과 직접 비교하므로 그 공간이 아니면 비교가 성립하지
 * 않는다. 지수는 `index:<id>`, 주식은 맨 코드.
 *
 * **막는 방향**: 디바운스 대기 중 창의 종목·봉이 바뀌면 옛 차트의 dispatch 를 반려한다.
 * **못 보는 것**: 실제 fetch 성공 여부·픽셀. 코드가 맞으면 통과시킬 뿐이다.
 */
type ViewGuard = () => { code: string | null; timeframe: LiveTimeframe };

function buildWindowViewGuard(windowId: string): ViewGuard {
  return () => ({
    code: liveWorkareaCode(windowId),
    timeframe: useWorkspaceStore.getState().windows
      .find((w) => w.id === windowId)?.chart?.timeframe ?? '1m',
  });
}

const GLOBAL_VIEW_GUARD: ViewGuard = () => {
  const s = useLivePageStore.getState();
  return {
    // `activeCode` 를 base 로 유지한다 — 주식 경로의 값이 한 글자도 바뀌면 안 된다
    // (이 경로를 타는 기존 테스트들이 `activeCode` 만 세팅하고 `activeInstrument` 는
    // 비워 두므로, instrument 기반으로 갈아엎으면 전부 null 이 된다). 지수에서만
    // null 이던 구멍을 창-스코프 가드와 같은 공간으로 메운다.
    code: s.activeCode
      ?? (s.activeInstrument?.kind === 'index' ? indexWorkareaCode(s.activeInstrument.id) : null),
    timeframe: s.candleTimeframe,
  };
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
  /** 창을 앞으로 당긴다(축소). 근거는 스토어 액션 주석 참조. */
  contract: (date: string) => void;
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
        contract: (date: string) => ws().contractChartHistoricalRange(windowId, date),
        reset: () => ws().resetChartHistoricalRange(windowId),
        snapshot: () => ws().chartRuntime[windowId]
          ?? { historicalFromDate: null, lastMinuteHistoricalFromDate: null },
      };
    }
    const ps = () => useLivePageStore.getState();
    return {
      extend: (date: string) => ps().extendHistoricalRange(date),
      contract: (date: string) => ps().contractHistoricalRange(date),
      reset: () => ps().resetHistoricalRange(),
      snapshot: () => ({
        historicalFromDate: ps().historicalFromDate,
        lastMinuteHistoricalFromDate: ps().lastMinuteHistoricalFromDate,
      }),
    };
  }, [windowId]);
}
