import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  WindowViewContext,
  useIndicatorActions,
  useIsWindowIndicatorsDetached,
  useWindowIndicator,
  useWindowIndicatorScope,
  LIVE_WINDOW_WORKSPACE,
  type WindowViewValue,
} from './windowView';
import { STUDY_WINDOW_WORKSPACE } from '../../studyViews/studyWindowWorkspace';
import { useLivePageStore, type LiveTimeframe } from '../../state/livePage';
import { useWorkspaceStore, type WorkspaceWindow } from '../../state/workspace';
import {
  FACTORY_INDICATOR_SETTINGS,
  INDICATORS_V2_STORAGE_KEY,
  normalizeIndicatorsV2,
} from '../../state/indicatorSettingsV2';
import { normalizePaneOrder } from '../../chart/paneOrder';
import {
  useActivePrefs,
  useChartPrefActions,
  useChartPrefsStore,
} from '../../state/chartPrefs';

/**
 * 창별 지표 분리(opt-in)의 계약 가드.
 *
 * 이 기능은 #712 가 되돌린 "창 소유 지표" 와 **저장 위치가 다르다**: 내용물은
 * 전역 `live.indicators.v2` 에 남고 창이 갖는 것은 키뿐이다. 그래서 여기서
 * 못 박는 것이 셋이다.
 *
 *  ① **격리** — 분리된 창의 편집은 공용 세트에도, 다른 창에도 새지 않는다.
 *     역방향도 같다(공용 편집이 분리 창을 덮지 않는다).
 *  ② **멤버십은 키의 존재** — 공장값 상태에서 분리하면 복사할 diff 가 없어
 *     엔트리가 `{}` 다. 이것이 저장 왕복에서 살아남지 않으면 분리가 조용히
 *     풀리고, 증상은 한참 뒤 공용 설정을 바꾼 순간에야 나타난다.
 *  ③ **영속화 완전성** — 분리와 무관한 액션(pane 순서 등)이 저장소의 창 맵을
 *     지우지 않는다. 지우면 다른 창의 분리 설정이 통째로 날아간다.
 */

function chartWindow(id: string, timeframe: LiveTimeframe = '1m'): WorkspaceWindow {
  return {
    id,
    kind: 'chart',
    group: 3,
    rect: { x: 0, y: 0, w: 400, h: 300 },
    chart: { timeframe },
  };
}

function seedWorkspace(windows: WorkspaceWindow[]): void {
  useWorkspaceStore.setState({
    windows,
    zOrder: windows.map((w) => w.id),
    groupSymbols: { 3: { code: '000660', name: 'SK하이닉스' } },
    chartRuntime: {},
  });
}

function windowValue(
  windowId: string,
  timeframe: LiveTimeframe = '1m',
  workspace = LIVE_WINDOW_WORKSPACE,
): WindowViewValue {
  return {
    windowId,
    group: 3,
    code: '000660',
    timeframe,
    historicalFromDate: null,
    workspace,
  };
}

function provider(value: WindowViewValue) {
  return ({ children }: { children: ReactNode }) => (
    <WindowViewContext.Provider value={value}>{children}</WindowViewContext.Provider>
  );
}

/** 창 하나의 (분리 여부, 액션, 거래량 토글 유효값) 한 묶음. */
function renderWindow(value: WindowViewValue) {
  return renderHook(() => ({
    detached: useIsWindowIndicatorsDetached(),
    scope: useWindowIndicatorScope(),
    actions: useIndicatorActions(),
    volumeEnabled: useWindowIndicator((s) => s.volumeEnabled),
    maPeriod: useWindowIndicator((s) => s.movingAverages[0]?.period),
  }), { wrapper: provider(value) });
}

/** 드로어 안 chartPrefs 항목(급증 마커)의 창 스코프 읽기·쓰기 한 묶음. */
function renderPrefsWindow(value: WindowViewValue) {
  return renderHook(() => ({
    surgeMarkerEnabled: useActivePrefs((p) => p.surgeMarkerEnabled),
    prefActions: useChartPrefActions(),
  }), { wrapper: provider(value) });
}

function storedV2() {
  return normalizeIndicatorsV2(JSON.parse(localStorage.getItem(INDICATORS_V2_STORAGE_KEY) ?? '{}'));
}

beforeEach(() => {
  localStorage.clear();
  useLivePageStore.setState({
    ...FACTORY_INDICATOR_SETTINGS,
    indicatorsByTimeframe: {},
    indicatorsByWindow: {},
    indicatorTimeframe: '1m',
    paneOrder: normalizePaneOrder([]),
    paneStretch: {},
  });
  useChartPrefsStore.setState({
    indicatorModalByTimeframe: {},
    indicatorModalByWindow: {},
    indicatorModalTimeframe: '1m',
    surgeMarkerEnabled: true,
  });
  seedWorkspace([chartWindow('w1'), chartWindow('w2')]);
});

describe('연동(기본) — 종전 동작', () => {
  it('같은 봉의 두 창은 서로의 편집을 따라간다', () => {
    const a = renderWindow(windowValue('w1'));
    const b = renderWindow(windowValue('w2'));

    a.result.current.actions.setVolumeEnabled(false);
    a.rerender();
    b.rerender();

    expect(a.result.current.volumeEnabled).toBe(false);
    expect(b.result.current.volumeEnabled).toBe(false);
    expect(a.result.current.detached).toBe(false);
  });

  it('스코프 키는 워크스페이스 접두사로 갈린다 — 창 id 가 같아도 다른 창이다', () => {
    const live = renderWindow(windowValue('same-id'));
    const study = renderWindow(windowValue('same-id', '1m', STUDY_WINDOW_WORKSPACE));

    expect(live.result.current.scope).toBe('live:same-id');
    expect(study.result.current.scope).toBe('study:same-id');
  });
});

describe('분리 — 격리', () => {
  it('분리 직후 유효 설정이 그대로다(화면 무변경)', () => {
    const a = renderWindow(windowValue('w1'));
    a.result.current.actions.setMovingAverage('ma-1', { period: 33 });
    a.rerender();
    expect(a.result.current.maPeriod).toBe(33);

    a.result.current.actions.detachIndicators();
    a.rerender();

    expect(a.result.current.detached).toBe(true);
    expect(a.result.current.maPeriod).toBe(33);
  });

  it('분리된 창의 편집이 공용 세트에도 다른 창에도 새지 않는다', () => {
    const a = renderWindow(windowValue('w1'));
    const b = renderWindow(windowValue('w2'));

    a.result.current.actions.detachIndicators();
    a.rerender();
    a.result.current.actions.setVolumeEnabled(false);
    a.rerender();
    b.rerender();

    expect(a.result.current.volumeEnabled).toBe(false);
    expect(b.result.current.volumeEnabled).toBe(true);
    expect(useLivePageStore.getState().indicatorsByTimeframe.minute).toBeUndefined();
  });

  it('공용 편집이 분리된 창을 덮지 않는다', () => {
    const a = renderWindow(windowValue('w1'));
    const b = renderWindow(windowValue('w2'));

    a.result.current.actions.detachIndicators();
    b.result.current.actions.setVolumeEnabled(false);
    a.rerender();
    b.rerender();

    expect(b.result.current.volumeEnabled).toBe(false);
    expect(a.result.current.volumeEnabled).toBe(true);
  });

  it('분리 창 쓰기는 최상위 ambient 투영을 건드리지 않는다 — 봉이 같아도', () => {
    const a = renderWindow(windowValue('w1'));
    a.result.current.actions.detachIndicators();
    a.rerender();
    a.result.current.actions.setVolumeEnabled(false);

    // 투영은 공용 세트의 ambient 봉 값이다. 여기가 흔들리면 Provider 밖
    // 소비자(단일 차트·픽스처)가 남의 창 설정을 본다.
    expect(useLivePageStore.getState().indicatorTimeframe).toBe('1m');
    expect(useLivePageStore.getState().volumeEnabled).toBe(true);
  });

  it('분리 창의 봉 버킷은 창 안에서만 갈린다', () => {
    seedWorkspace([chartWindow('w1', '1m'), chartWindow('wD', 'D')]);
    const minute = renderWindow(windowValue('w1', '1m'));
    const daily = renderWindow(windowValue('wD', 'D'));

    minute.result.current.actions.detachIndicators();
    minute.rerender();
    minute.result.current.actions.setVolumeEnabled(false);
    minute.rerender();
    daily.rerender();

    const scoped = useLivePageStore.getState().indicatorsByWindow['live:w1'];
    expect(scoped?.minute?.volumeEnabled).toBe(false);
    expect(scoped?.D).toBeUndefined();
    expect(daily.result.current.volumeEnabled).toBe(true);
  });
});

describe('드로어 혼재 방지 — chartPrefs 항목도 같이 갈린다', () => {
  it('분리 창의 「총잔량 급증 마커」가 다른 창에 새지 않는다', () => {
    const a = renderWindow(windowValue('w1'));
    const aPrefs = renderPrefsWindow(windowValue('w1'));
    const bPrefs = renderPrefsWindow(windowValue('w2'));

    a.result.current.actions.detachIndicators();
    aPrefs.rerender();
    aPrefs.result.current.prefActions.setToggle('surgeMarkerEnabled', false);
    aPrefs.rerender();
    bPrefs.rerender();

    // 같은 패널의 지표 토글은 창별인데 이 행만 전역이면, 화면에 구별이 없는 채로
    // 두 창이 서로를 덮는다 — 이 기능이 없애려는 바로 그 혼재다(ADR-0072).
    expect(aPrefs.result.current.surgeMarkerEnabled).toBe(false);
    expect(bPrefs.result.current.surgeMarkerEnabled).toBe(true);
  });

  it('분리·복귀·회수에서 두 스토어의 멤버십이 함께 움직인다', () => {
    const a = renderWindow(windowValue('w1'));
    const hasScope = () => ({
      indicators: Object.hasOwn(useLivePageStore.getState().indicatorsByWindow, 'live:w1'),
      prefs: Object.hasOwn(useChartPrefsStore.getState().indicatorModalByWindow, 'live:w1'),
    });

    a.result.current.actions.detachIndicators();
    expect(hasScope()).toEqual({ indicators: true, prefs: true });

    a.result.current.actions.attachIndicators();
    expect(hasScope()).toEqual({ indicators: false, prefs: false });

    a.result.current.actions.detachIndicators();
    useLivePageStore.getState().dropWindowIndicatorScopes(['live:w1']);
    expect(hasScope()).toEqual({ indicators: false, prefs: false });
  });
});

describe('멤버십은 키의 존재', () => {
  it('공장값 상태에서 분리해도 저장 왕복 후 분리가 유지된다', () => {
    const a = renderWindow(windowValue('w1'));
    a.result.current.actions.detachIndicators();
    a.rerender();
    expect(a.result.current.detached).toBe(true);

    // 저장 → 정규화 왕복. 빈 엔트리를 sparse 규칙으로 걷어내면 여기서 풀린다.
    const roundTripped = storedV2();
    expect(Object.hasOwn(roundTripped.byWindow, 'live:w1')).toBe(true);
    expect(roundTripped.byWindow['live:w1']).toEqual({});

    useLivePageStore.getState().hydrateIndicatorsFromStorage();
    a.rerender();
    expect(a.result.current.detached).toBe(true);
  });

  it('hydrate 는 다른 탭이 쓴 창 맵을 받아온다', () => {
    localStorage.setItem(INDICATORS_V2_STORAGE_KEY, JSON.stringify({
      paneOrder: [], paneStretch: {}, byTimeframe: {},
      byWindow: { 'live:w2': { minute: { volumeEnabled: false } } },
    }));

    useLivePageStore.getState().hydrateIndicatorsFromStorage();
    const b = renderWindow(windowValue('w2'));

    expect(b.result.current.detached).toBe(true);
    expect(b.result.current.volumeEnabled).toBe(false);
  });
});

describe('영속화 완전성', () => {
  it('분리와 무관한 액션(pane 순서)이 저장소의 창 맵을 지우지 않는다', () => {
    const a = renderWindow(windowValue('w1'));
    a.result.current.actions.detachIndicators();
    a.rerender();
    a.result.current.actions.setVolumeEnabled(false);

    a.result.current.actions.setPaneOrder(['candle', 'volume']);

    expect(storedV2().byWindow['live:w1']?.minute?.volumeEnabled).toBe(false);
  });
});

describe('되돌리기·회수', () => {
  it('연동 복귀는 창의 오버라이드를 버리고 공용 값을 다시 보게 한다', () => {
    const a = renderWindow(windowValue('w1'));
    a.result.current.actions.detachIndicators();
    a.rerender();
    a.result.current.actions.setVolumeEnabled(false);
    a.rerender();

    a.result.current.actions.attachIndicators();
    a.rerender();

    expect(a.result.current.detached).toBe(false);
    expect(a.result.current.volumeEnabled).toBe(true);
    expect(storedV2().byWindow['live:w1']).toBeUndefined();
  });

  it('분리 창의 초기화는 그 창의 버킷만 비운다 — 분리는 유지된다', () => {
    const a = renderWindow(windowValue('w1'));
    a.result.current.actions.detachIndicators();
    a.rerender();
    a.result.current.actions.setVolumeEnabled(false);
    a.rerender();

    a.result.current.actions.resetIndicators();
    a.rerender();

    // 초기화가 조용히 연동까지 풀면 사용자는 무엇을 잃었는지 모른 채 되돌릴 수 없다.
    expect(a.result.current.detached).toBe(true);
    expect(a.result.current.volumeEnabled).toBe(true);
    expect(useLivePageStore.getState().indicatorsByTimeframe.minute).toBeUndefined();
  });

  it('사라진 창의 스코프는 회수된다', () => {
    const a = renderWindow(windowValue('w1'));
    a.result.current.actions.detachIndicators();

    useLivePageStore.getState().dropWindowIndicatorScopes(['live:w1', 'live:nonexistent']);

    expect(useLivePageStore.getState().indicatorsByWindow).toEqual({});
    expect(storedV2().byWindow).toEqual({});
  });
});
