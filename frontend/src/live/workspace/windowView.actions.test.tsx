import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  WindowViewContext,
  useIndicatorActions,
  useHistoricalRangeActions,
  useWindowIndicator,
  useWindowIndicators,
  useWindowPaneOrder,
  useWindowPaneStretch,
  useWindowViewGuard,
  LIVE_WINDOW_WORKSPACE,
  type WindowViewValue,
} from './windowView';
import { useLivePageStore, type LiveTimeframe } from '../../state/livePage';
import { useWorkspaceStore, type WorkspaceWindow } from '../../state/workspace';
import { indexInstrument } from '../liveInstrument';
import {
  FACTORY_INDICATOR_SETTINGS,
  resolveIndicatorSettings,
} from '../../state/indicatorSettingsV2';
import { normalizePaneOrder } from '../../chart/paneOrder';

/**
 * 지표 편집 표면의 계약 — **백엔드는 언제나 전역 스토어**이고, 창이 정하는 것은
 * "어느 버킷인가" 뿐이다. 한때 창이 설정을 통째로 **소유**했지만(#712), 워크스페이스가
 * 탭별 sessionStorage 라 지표가 브라우저 탭마다 갈렸다. 창별 세트가 돌아온 지금도
 * (ADR-0152) 내용물은 전역 저장소에 남는다 — 창이 갖는 것은 스코프 키뿐이다.
 *
 * 그래서 여기서 못 박는 것이 둘이다:
 *  ① 창에서 편집해도 **워크스페이스는 건드리지 않는다**(전역 v2 의 창 버킷으로 간다).
 *  ② 창의 봉이 ambient 와 다르면 **다른 버킷에 쓰고 ambient 투영은 그대로**다.
 *
 * 페이지·창 축의 격리 자체는 `windowView.scope.test.tsx` 가 맡는다(ADR-0146·0152).
 */

function chartWindow(id: string, timeframe: LiveTimeframe = '5m'): WorkspaceWindow {
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

function windowValue(windowId: string, timeframe: LiveTimeframe = '5m'): WindowViewValue {
  return {
    windowId,
    group: 3,
    code: '000660',
    timeframe,
    historicalFromDate: null,
    workspace: LIVE_WINDOW_WORKSPACE,
  };
}

function provider(value: WindowViewValue) {
  return ({ children }: { children: ReactNode }) => (
    <WindowViewContext.Provider value={value}>{children}</WindowViewContext.Provider>
  );
}

/** 전역 지표 슬라이스를 공장값으로 되돌린다(스토어는 모듈 로드 시 1회 하이드레이트). */
function resetIndicatorState(): void {
  useLivePageStore.setState({
    ...FACTORY_INDICATOR_SETTINGS,
    indicatorsByTimeframe: {},
    studyIndicatorsByTimeframe: {},
    // 창 id 가 테스트 간 고정('w1')이라 여기까지 비워야 격리가 된다(ADR-0152).
    indicatorsByWindow: {},
    indicatorTimeframe: '1m',
    paneOrder: normalizePaneOrder([]),
    paneStretch: {},
    historicalFromDate: null,
    lastMinuteHistoricalFromDate: null,
  });
}

/** 창 세트의 버킷 — 창 편집은 페이지 세트가 아니라 여기로 간다(ADR-0152). */
function bucket(profile: 'minute' | 'D', windowId = 'w1') {
  return useLivePageStore.getState().indicatorsByWindow[`live:${windowId}`]?.[profile];
}

/** `/live` **페이지 세트**의 버킷 — Provider 밖(전역 ambient) 쓰기가 가는 곳. */
function pageBucket(profile: 'minute' | 'D') {
  return useLivePageStore.getState().indicatorsByTimeframe[profile];
}

beforeEach(() => {
  localStorage.clear();
  resetIndicatorState();
  seedWorkspace([chartWindow('w1')]);
});

describe('useIndicatorActions — Provider 밖(전역 ambient 봉)', () => {
  it('ambient 봉 버킷에 쓰고 최상위 투영도 갱신한다', () => {
    const { result } = renderHook(() => useIndicatorActions());
    result.current.setMovingAverageEnabled(false);
    // Provider 밖은 창이 없으므로 페이지 세트로 간다(ADR-0152 의 폴백).
    expect(pageBucket('minute')?.movingAverageEnabled).toBe(false);
    expect(useLivePageStore.getState().movingAverageEnabled).toBe(false);
    expect(useLivePageStore.getState().indicatorsByWindow).toEqual({});
  });
});

describe('useIndicatorActions — Provider 안(창의 봉 버킷)', () => {
  it('전역 v2 에 쓰고 워크스페이스 창은 건드리지 않는다', () => {
    const { result } = renderHook(() => useIndicatorActions(), {
      wrapper: provider(windowValue('w1')),
    });
    result.current.setVolumeEnabled(false);
    expect(bucket('minute')?.volumeEnabled).toBe(false);
    // 창에는 봉만 남는다 — 설정 사본이 되살아나면 다시 탭마다 갈린다.
    expect(useWorkspaceStore.getState().windows[0].chart).toEqual({ timeframe: '5m' });
  });

  it('창의 봉이 ambient 와 다르면 그 버킷에만 쓰고 투영은 그대로다', () => {
    seedWorkspace([chartWindow('wD', 'D')]);
    const { result } = renderHook(() => useIndicatorActions(), {
      wrapper: provider(windowValue('wD', 'D')),
    });
    result.current.setVolumeEnabled(false);
    expect(bucket('D', 'wD')?.volumeEnabled).toBe(false);
    expect(bucket('minute', 'wD')).toBeUndefined();
    // ambient(1m) 투영이 D 창의 편집으로 오염되면 안 된다.
    expect(useLivePageStore.getState().volumeEnabled).toBe(FACTORY_INDICATOR_SETTINGS.volumeEnabled);
  });

  it('같은 봉의 두 창은 서로를 따라가지 않는다(ADR-0152)', () => {
    seedWorkspace([chartWindow('w1'), chartWindow('w2')]);
    const editor = renderHook(() => useIndicatorActions(), {
      wrapper: provider(windowValue('w1')),
    });
    const observer = renderHook(() => useWindowIndicators(), {
      wrapper: provider(windowValue('w2')),
    });
    expect(observer.result.current.askPeakEnabled).toBe(false);
    editor.result.current.setAskPeakEnabled(true);
    observer.rerender();
    expect(observer.result.current.askPeakEnabled).toBe(false);
    // 편집은 편집한 창에만 남는다.
    expect(bucket('minute')?.askPeakEnabled).toBe(true);
    expect(bucket('minute', 'w2')).toBeUndefined();
  });

  it('enable↔hidden 결합 시맨틱이 창 편집에도 적용된다', () => {
    const { result } = renderHook(() => useIndicatorActions(), {
      wrapper: provider(windowValue('w1')),
    });
    result.current.setAskPeakHidden(true);
    result.current.setAskPeakEnabled(true); // 켜는 순간 hidden 초기화
    expect(bucket('minute')?.askPeakEnabled).toBe(true);
    expect(bucket('minute')?.askPeakHidden).toBe(false);
  });

  it('read-modify-write op 이 호출 시점 fresh 설정을 읽는다(stale closure 없음)', () => {
    const { result } = renderHook(() => useIndicatorActions(), {
      wrapper: provider(windowValue('w1')),
    });
    const baseCount = FACTORY_INDICATOR_SETTINGS.movingAverages.length;
    result.current.addMovingAverage();
    result.current.addMovingAverage(); // 두 번째 호출이 첫 결과 위에 쌓여야 한다
    const resolved = resolveIndicatorSettings(
      useLivePageStore.getState().indicatorsByWindow['live:w1'],
      '5m',
    );
    expect(resolved.movingAverages.length).toBe(baseCount + 2);
  });

  it('setPanePrefForTimeframe 은 넘겨받은 봉의 버킷에 쓴다', () => {
    const { result } = renderHook(() => useIndicatorActions(), {
      wrapper: provider(windowValue('w1')),
    });
    result.current.setPanePrefForTimeframe('D', 'ratioEnabled', true);
    expect(bucket('D')?.ratioEnabled).toBe(true);
    expect(bucket('minute')).toBeUndefined();
  });

  it('resetIndicators 는 창의 봉 버킷만 비우고 레이아웃은 보존한다', () => {
    const { result } = renderHook(() => useIndicatorActions(), {
      wrapper: provider(windowValue('w1')),
    });
    result.current.setPaneStretch({ volume: 2 } as never);
    result.current.setVolumeEnabled(false);
    result.current.setPanePrefForTimeframe('D', 'ratioEnabled', true);
    result.current.resetIndicators();
    expect(useLivePageStore.getState().paneStretch).toMatchObject({ volume: 2 });
    expect(bucket('minute')).toBeUndefined(); // 창(5m)의 버킷만 리셋
    expect(bucket('D')?.ratioEnabled).toBe(true); // 다른 봉은 그대로
  });
});

describe('useWindowIndicator', () => {
  it('Provider 안=창 봉 버킷, 밖=최상위 ambient 투영', () => {
    useLivePageStore.setState({
      indicatorsByTimeframe: { minute: { askPeakEnabled: true }, D: { askPeakEnabled: false } },
      indicatorTimeframe: 'D',
      askPeakEnabled: false, // ambient 투영(= D 버킷의 값)
    });
    const inWin = renderHook(() => useWindowIndicator((s) => s.askPeakEnabled), {
      wrapper: provider(windowValue('w1')), // 5m → minute 버킷
    });
    expect(inWin.result.current).toBe(true);

    const outside = renderHook(() => useWindowIndicator((s) => s.askPeakEnabled));
    expect(outside.result.current).toBe(false);
  });
});

describe('useWindowPaneOrder / useWindowPaneStretch', () => {
  it('창 안팎 모두 전역 레이아웃을 본다(전역 1세트)', () => {
    useLivePageStore.getState().setPaneStretch({ volume: 3 } as never);
    const inWin = renderHook(() => useWindowPaneStretch(), {
      wrapper: provider(windowValue('w1')),
    });
    expect(inWin.result.current).toMatchObject({ volume: 3 });

    const globalOrder = useLivePageStore.getState().paneOrder;
    const outside = renderHook(() => useWindowPaneOrder());
    expect(outside.result.current).toBe(globalOrder);
  });
});

describe('useHistoricalRangeActions', () => {
  it('Provider 안: extend/snapshot/reset 이 창 런타임을 본다', () => {
    const { result } = renderHook(() => useHistoricalRangeActions(), {
      wrapper: provider(windowValue('w1')),
    });
    result.current.extend('20260601');
    expect(result.current.snapshot().historicalFromDate).toBe('20260601');
    expect(useLivePageStore.getState().historicalFromDate).toBeNull();
    result.current.reset();
    expect(result.current.snapshot().historicalFromDate).toBeNull();
  });

  it('Provider 밖: 전역 스토어에 위임한다', () => {
    const { result } = renderHook(() => useHistoricalRangeActions());
    result.current.extend('20260601');
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260601');
    result.current.reset();
    expect(useLivePageStore.getState().historicalFromDate).toBeNull();
  });
});

describe('useWindowViewGuard', () => {
  it('Provider 안: 호출 시점의 워크스페이스 상태를 읽는다(렌더 이후 변경 반영)', () => {
    const { result } = renderHook(() => useWindowViewGuard(), {
      wrapper: provider(windowValue('w1')),
    });
    expect(result.current()).toEqual({ code: '000660', timeframe: '5m' });
    // 재렌더 없이 스토어만 바꿔도 fresh 하게 읽힌다 — stale 디바운스 가드 계약.
    useWorkspaceStore.getState().setChartTimeframe('w1', 'D');
    useWorkspaceStore.getState().setGroupSymbol(3, { code: '005930', name: '삼성전자' });
    expect(result.current()).toEqual({ code: '005930', timeframe: 'D' });
  });

  it('Provider 밖: 전역 스토어를 fresh 하게 읽는다', () => {
    useLivePageStore.setState({ activeCode: '000660', candleTimeframe: '3m' });
    const { result } = renderHook(() => useWindowViewGuard());
    useLivePageStore.setState({ activeCode: '005930', candleTimeframe: 'W' });
    expect(result.current()).toEqual({ code: '005930', timeframe: 'W' });
  });

  /**
   * 가드가 돌려주는 코드는 **workarea 공간**이다 — `LiveChartRoot` 의 `code` prop 과
   * 같은 공간이어야 비교가 성립한다. 지수 창에서 그룹 심볼(`'KOSPI'`)을 그대로
   * 돌려주던 시절, 가드는 `'KOSPI' !== 'index:KOSPI'` 로 **매번 반려**해 좌측 팬
   * 백필과 분봉 복원이 둘 다 죽어 있었다.
   *
   * 이 창의 `ctx.code` 는 여전히 **null** 이다(지수 = activeCode null 미러). 같은
   * 컨텍스트 안에서 두 값이 갈리는 것이 의도이고, 이 테스트가 그 의도를 고정한다.
   */
  it('Provider 안 지수: workarea 공간(`index:<id>`)을 돌려준다 — ctx.code(null)와 의도적으로 갈린다', () => {
    useWorkspaceStore.getState().setGroupSymbol(3, { code: 'KOSPI', name: '코스피', kind: 'index' });
    const value: WindowViewValue = { ...windowValue('w1'), code: null };
    const { result } = renderHook(() => useWindowViewGuard(), { wrapper: provider(value) });
    expect(result.current()).toEqual({ code: 'index:KOSPI', timeframe: '5m' });
  });

  it('Provider 밖 지수: activeCode 가 null 이어도 activeInstrument 로 같은 공간을 채운다', () => {
    useLivePageStore.setState({
      activeCode: null,
      activeInstrument: indexInstrument('KOSPI', '코스피'),
      candleTimeframe: 'D',
    });
    const { result } = renderHook(() => useWindowViewGuard());
    expect(result.current()).toEqual({ code: 'index:KOSPI', timeframe: 'D' });
  });
});
