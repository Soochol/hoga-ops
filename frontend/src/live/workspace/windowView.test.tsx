import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  WindowViewContext,
  useWindowView,
  useWindowIndicators,
  type WindowViewValue,
} from './windowView';
import { useLivePageStore } from '../../state/livePage';
import { FACTORY_INDICATOR_SETTINGS } from '../../state/indicatorSettingsV2';

const windowValue: WindowViewValue = {
  windowId: 'w1',
  group: 4,
  code: '000660',
  timeframe: 'D',
  historicalFromDate: '20260101',
  indicators: { ...FACTORY_INDICATOR_SETTINGS, askPeakEnabled: true },
};

function provider(value: WindowViewValue) {
  return ({ children }: { children: ReactNode }) => (
    <WindowViewContext.Provider value={value}>{children}</WindowViewContext.Provider>
  );
}

describe('useWindowView — 전역 폴백(Provider 밖)', () => {
  beforeEach(() => {
    useLivePageStore.setState({
      activeCode: '005930',
      candleTimeframe: '5m',
      historicalFromDate: '20251201',
    });
  });

  it('Provider 밖에서는 전역 스토어 값을 반환한다', () => {
    const { result } = renderHook(() => useWindowView());
    expect(result.current).toEqual({
      windowId: null,
      group: null,
      code: '005930',
      timeframe: '5m',
      historicalFromDate: '20251201',
    });
  });

  it('전역 스토어 변경을 반영한다', () => {
    const { result, rerender } = renderHook(() => useWindowView());
    expect(result.current.code).toBe('005930');
    useLivePageStore.setState({ activeCode: '035420', candleTimeframe: 'W' });
    rerender();
    expect(result.current.code).toBe('035420');
    expect(result.current.timeframe).toBe('W');
  });
});

describe('useWindowView — Provider 안', () => {
  it('Provider 값을 반환하고 전역 스토어를 무시한다', () => {
    useLivePageStore.setState({ activeCode: '005930', candleTimeframe: '5m' });
    const { result } = renderHook(() => useWindowView(), { wrapper: provider(windowValue) });
    expect(result.current.code).toBe('000660'); // 창 값(전역 005930 아님)
    expect(result.current.timeframe).toBe('D');
    expect(result.current.group).toBe(4);
    expect(result.current.windowId).toBe('w1');
  });
});

describe('useWindowIndicators', () => {
  it('Provider 밖에서는 전역 ambient 투영을 반환한다', () => {
    useLivePageStore.setState({ askPeakEnabled: false, programTradeEnabled: true });
    const { result } = renderHook(() => useWindowIndicators());
    expect(result.current.askPeakEnabled).toBe(false);
    expect(result.current.programTradeEnabled).toBe(true);
  });

  it('Provider 안에서는 창의 resolve 된 지표를 반환한다', () => {
    useLivePageStore.setState({ askPeakEnabled: false }); // 전역과 다르게
    const { result } = renderHook(() => useWindowIndicators(), { wrapper: provider(windowValue) });
    expect(result.current.askPeakEnabled).toBe(true); // 창 값(전역 false 아님)
  });
});
