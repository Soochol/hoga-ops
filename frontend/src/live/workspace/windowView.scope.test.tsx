import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  WindowViewContext,
  useIndicatorActions,
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
 * 페이지별 지표 세트의 계약 가드 (ADR-0146).
 *
 * 사용자가 실제로 하는 검수가 이 파일의 뼈대다: **`/live` 에서 지표를 바꾸고
 * `/study` 가 따라오지 않는지 보는 것**(그리고 그 역방향). 그래서 여기서 못 박는
 * 것이 셋이다.
 *
 *  ① **격리** — 한 페이지의 편집이 다른 페이지에 새지 않는다(양방향).
 *  ② **페이지 안에서는 공유** — 같은 페이지의 두 창은 여전히 같은 값을 본다.
 *     이 기능은 "창마다 따로" 가 아니다.
 *  ③ **시드는 로드 시 즉시** — 게으른 폴백이면 `/study` 가 첫 편집 전까지 `/live` 를
 *     계속 따라다니고, 그게 정확히 "분리했다는데 같이 바뀐다" 로 보인다.
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
  workspace = LIVE_WINDOW_WORKSPACE,
  timeframe: LiveTimeframe = '1m',
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

/** 한 창에서 읽고 쓰는 표면 한 묶음(지표 + 드로어 안 chartPrefs 항목). */
function renderWindow(value: WindowViewValue) {
  return renderHook(() => ({
    page: useWindowIndicatorScope(),
    actions: useIndicatorActions(),
    volumeEnabled: useWindowIndicator((s) => s.volumeEnabled),
    maPeriod: useWindowIndicator((s) => s.movingAverages[0]?.period),
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
    studyIndicatorsByTimeframe: {},
    indicatorTimeframe: '1m',
    paneOrder: normalizePaneOrder([]),
    paneStretch: {},
  });
  useChartPrefsStore.setState({
    indicatorModalByTimeframe: {},
    studyIndicatorModalByTimeframe: {},
    indicatorModalTimeframe: '1m',
    surgeMarkerEnabled: true,
  });
  seedWorkspace([chartWindow('w1'), chartWindow('w2')]);
});

describe('두 페이지는 서로 동기화하지 않는다', () => {
  it('`/live` 편집이 `/study` 에 새지 않는다', () => {
    const live = renderWindow(windowValue('w1'));
    const study = renderWindow(windowValue('s1', STUDY_WINDOW_WORKSPACE));

    live.result.current.actions.setVolumeEnabled(false);
    live.rerender();
    study.rerender();

    expect(live.result.current.volumeEnabled).toBe(false);
    expect(study.result.current.volumeEnabled).toBe(true);
  });

  it('`/study` 편집이 `/live` 에 새지 않는다', () => {
    const live = renderWindow(windowValue('w1'));
    const study = renderWindow(windowValue('s1', STUDY_WINDOW_WORKSPACE));

    study.result.current.actions.setMovingAverage('ma-1', { period: 33 });
    live.rerender();
    study.rerender();

    expect(study.result.current.maPeriod).toBe(33);
    expect(live.result.current.maPeriod).toBe(5); // 공장 기본
  });

  it('드로어 안 chartPrefs 항목도 페이지별이다 — 같은 패널의 절반만 갈리면 안 된다', () => {
    const live = renderWindow(windowValue('w1'));
    const study = renderWindow(windowValue('s1', STUDY_WINDOW_WORKSPACE));

    live.result.current.prefActions.setToggle('surgeMarkerEnabled', false);
    live.rerender();
    study.rerender();

    expect(live.result.current.surgeMarkerEnabled).toBe(false);
    expect(study.result.current.surgeMarkerEnabled).toBe(true);
  });

  it('드로어 안 chartPrefs 항목 — 역방향도 막는다(`/study` 편집이 `/live` 로)', () => {
    // 읽기만 페이지별이고 **쓰기가 `/live` 버킷으로 가면** 위 테스트는 통과한다
    // (live→study 방향만 보므로). 그 구멍을 이 케이스가 막는다.
    const live = renderWindow(windowValue('w1'));
    const study = renderWindow(windowValue('s1', STUDY_WINDOW_WORKSPACE));

    study.result.current.prefActions.setToggle('surgeMarkerEnabled', false);
    live.rerender();
    study.rerender();

    expect(study.result.current.surgeMarkerEnabled).toBe(false);
    expect(live.result.current.surgeMarkerEnabled).toBe(true);
    expect(useChartPrefsStore.getState().indicatorModalByTimeframe.minute).toBeUndefined();
  });

  it('`/study` 쓰기는 최상위 ambient 투영을 건드리지 않는다', () => {
    const study = renderWindow(windowValue('s1', STUDY_WINDOW_WORKSPACE));
    study.result.current.actions.setVolumeEnabled(false);

    // 투영은 `/live` 세트의 값이다 — 여기가 흔들리면 Provider 밖 소비자가
    // 남의 페이지 설정을 본다.
    expect(useLivePageStore.getState().volumeEnabled).toBe(true);
    expect(useLivePageStore.getState().indicatorsByTimeframe.minute).toBeUndefined();
  });
});

describe('페이지 안에서는 창들이 공유한다', () => {
  it('같은 페이지의 두 창은 서로의 편집을 따라간다 — 창별 분리가 아니다', () => {
    const a = renderWindow(windowValue('w1'));
    const b = renderWindow(windowValue('w2'));

    a.result.current.actions.setVolumeEnabled(false);
    a.rerender();
    b.rerender();

    expect(a.result.current.volumeEnabled).toBe(false);
    expect(b.result.current.volumeEnabled).toBe(false);
  });

  it('스코프는 창 id 가 아니라 페이지다', () => {
    const live = renderWindow(windowValue('same-id'));
    const study = renderWindow(windowValue('same-id', STUDY_WINDOW_WORKSPACE));

    expect(live.result.current.page).toBe('live');
    expect(study.result.current.page).toBe('study');
  });

  it('봉 축은 그대로 산다 — 페이지 × 봉 버킷', () => {
    const minute = renderWindow(windowValue('w1', LIVE_WINDOW_WORKSPACE, '1m'));
    const daily = renderWindow(windowValue('w2', LIVE_WINDOW_WORKSPACE, 'D'));

    minute.result.current.actions.setVolumeEnabled(false);
    minute.rerender();
    daily.rerender();

    expect(minute.result.current.volumeEnabled).toBe(false);
    expect(daily.result.current.volumeEnabled).toBe(true);
  });
});

describe('시드 — 기존 사용자의 설정이 두 페이지에 그대로 실린다', () => {
  it('`/study` 키가 없는 저장값은 로드 시 `/live` 에서 **즉시** 시드된다', () => {
    // 게으른 폴백이면 이 시점에 `/study` 가 아직 `/live` 를 가리키고, 사용자가
    // `/live` 를 바꾸면 `/study` 까지 따라온다 — 그게 이 기능의 인수 실패다.
    localStorage.setItem(INDICATORS_V2_STORAGE_KEY, JSON.stringify({
      paneOrder: [], paneStretch: {},
      byTimeframe: { minute: { volumeEnabled: false } },
    }));

    useLivePageStore.getState().hydrateIndicatorsFromStorage();
    const study = renderWindow(windowValue('s1', STUDY_WINDOW_WORKSPACE));

    expect(study.result.current.volumeEnabled).toBe(false); // 시드가 실렸다

    // 그리고 그 뒤 `/live` 를 바꿔도 `/study` 는 따라오지 않는다.
    const live = renderWindow(windowValue('w1'));
    live.result.current.actions.setVolumeEnabled(true);
    study.rerender();
    expect(study.result.current.volumeEnabled).toBe(false);
  });

  it('시드는 깊은 사본이다 — 버킷 참조를 공유하면 편집이 새어 간다', () => {
    localStorage.setItem(INDICATORS_V2_STORAGE_KEY, JSON.stringify({
      paneOrder: [], paneStretch: {},
      byTimeframe: { minute: { volumeEnabled: false } },
    }));
    useLivePageStore.getState().hydrateIndicatorsFromStorage();

    const s = useLivePageStore.getState();
    expect(s.studyIndicatorsByTimeframe.minute).not.toBe(s.indicatorsByTimeframe.minute);
  });

  it('공장값 사용자는 빈 `/study` 엔트리를 얻고, 그것이 왕복에서 살아남는다', () => {
    // 빈 것을 "없음" 으로 취급하면 매 로드 `/live` 값으로 덮인다.
    useLivePageStore.getState().patchIndicatorsScoped('live', '1m', { volumeEnabled: false });

    const roundTripped = storedV2();
    expect(roundTripped.studyByTimeframe).toEqual({});

    useLivePageStore.getState().hydrateIndicatorsFromStorage();
    const study = renderWindow(windowValue('s1', STUDY_WINDOW_WORKSPACE));
    expect(study.result.current.volumeEnabled).toBe(true); // `/live` 의 false 를 안 받았다
  });

  it('창별 분리 시절의 저장값(byWindow)은 조용히 버려진다', () => {
    localStorage.setItem(INDICATORS_V2_STORAGE_KEY, JSON.stringify({
      paneOrder: [], paneStretch: {},
      byTimeframe: { minute: { volumeEnabled: false } },
      byWindow: { 'live:w1': { minute: { ratioEnabled: true } } },
    }));

    const normalized = storedV2();

    expect('byWindow' in normalized).toBe(false);
    expect(normalized.byTimeframe.minute?.volumeEnabled).toBe(false);
  });
});

describe('영속화', () => {
  it('두 세트가 같은 블롭에 함께 저장된다 — 한쪽 편집이 다른 쪽을 지우지 않는다', () => {
    const live = renderWindow(windowValue('w1'));
    const study = renderWindow(windowValue('s1', STUDY_WINDOW_WORKSPACE));

    study.result.current.actions.setVolumeEnabled(false);
    live.result.current.actions.setPaneOrder(['candle', 'volume']);

    expect(storedV2().studyByTimeframe.minute?.volumeEnabled).toBe(false);
  });

  it('hydrate 는 두 세트를 함께 받는다', () => {
    localStorage.setItem(INDICATORS_V2_STORAGE_KEY, JSON.stringify({
      paneOrder: [], paneStretch: {},
      byTimeframe: { minute: { volumeEnabled: false } },
      studyByTimeframe: { minute: { ratioEnabled: true } },
    }));

    useLivePageStore.getState().hydrateIndicatorsFromStorage();

    const live = renderWindow(windowValue('w1'));
    const study = renderWindow(windowValue('s1', STUDY_WINDOW_WORKSPACE));
    expect(live.result.current.volumeEnabled).toBe(false);
    expect(study.result.current.volumeEnabled).toBe(true);
  });
});
