import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  WindowViewContext,
  useWindowView,
  useWindowIndicators,
  LIVE_WINDOW_WORKSPACE,
  type WindowViewValue,
} from './windowView';
import { useLivePageStore } from '../../state/livePage';

const windowValue: WindowViewValue = {
  windowId: 'w1',
  group: 4,
  code: '000660',
  timeframe: 'D',
  historicalFromDate: '20260101',
  workspace: LIVE_WINDOW_WORKSPACE,
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
  // 설정은 전역 1세트고 창은 봉만 고른다 — 그래서 이 훅의 계약은 "무엇을 읽는가"가
  // 아니라 "어느 버킷을 펴는가"다. 단 Provider **밖**은 종전대로 최상위 ambient
  // 투영을 읽는다(세터가 유지하는 파생값 — livePage 지표 슬라이스 주석).
  it('Provider 밖에서는 전역 ambient 투영을 반환한다', () => {
    useLivePageStore.setState({ askPeakEnabled: false, programTradeEnabled: true });
    const { result } = renderHook(() => useWindowIndicators());
    expect(result.current.askPeakEnabled).toBe(false);
    expect(result.current.programTradeEnabled).toBe(true);
  });

  it('Provider 안에서는 창의 봉 버킷을 편다 — 투영이 아니라', () => {
    useLivePageStore.setState({
      indicatorsByTimeframe: { minute: { askPeakEnabled: false }, D: { askPeakEnabled: true } },
      indicatorTimeframe: '1m',
      askPeakEnabled: false, // ambient 투영은 minute 을 가리킨다
    });
    // windowValue 의 봉은 'D' — 투영을 읽으면 false 가 나온다.
    const { result } = renderHook(() => useWindowIndicators(), { wrapper: provider(windowValue) });
    expect(result.current.askPeakEnabled).toBe(true);
  });
});
