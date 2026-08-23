import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import QuoteTotalsConfig from './QuoteTotalsConfig';
import { useLivePageStore } from '../../state/livePage';
import { WindowViewContext, type WindowViewValue } from '../workspace/windowView';

/** 창 스코프를 세우는 최소 Provider. */
function windowProvider() {
  const value: WindowViewValue = {
    windowId: 'w1',
    group: 3,
    code: '000660',
    timeframe: '1m',
    historicalFromDate: null,
  };
  return ({ children }: { children: ReactNode }) => (
    <WindowViewContext.Provider value={value}>{children}</WindowViewContext.Provider>
  );
}

describe('QuoteTotalsConfig', () => {
  afterEach(cleanup);
  // Provider 밖 렌더라 지표는 livePage 의 ambient 투영에서 온다 — 조건부 렌더를 재려면
  // 그 투영 필드를 직접 세운다(MovingAverageConfig.test 와 같은 패턴).
  beforeEach(() => {
    useLivePageStore.setState({ quoteTotalsDayMaxLineEnabled: false, quoteTotalsLevelLineEnabled: false });
  });
  it('제목·범례·급증 마커 토글을 렌더', () => {
    render(<QuoteTotalsConfig />);
    expect(screen.getByText('총잔량')).toBeTruthy();
    expect(screen.getByText(/매수 총잔량 빨강/)).toBeTruthy();
    expect(screen.getByText(/매도 총잔량 파랑/)).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-surgeMarkerEnabled')).toBeTruthy();
  });

  it('당일 최고 수평선은 opt-in — 꺼진 상태에선 스타일 피커가 없다', () => {
    render(<QuoteTotalsConfig />);
    expect(screen.getByTestId('settings-toggle-quoteTotalsDayMaxLineEnabled')).toBeTruthy();
    expect(screen.queryByText('매수 최고선')).toBeNull();
    expect(screen.queryByText('매도 최고선')).toBeNull();
  });

  it('켜면 매수·매도 최고선 스타일 피커가 드러난다', () => {
    useLivePageStore.setState({ quoteTotalsDayMaxLineEnabled: true });
    render(<QuoteTotalsConfig />);
    expect(screen.getByText('매수 최고선')).toBeTruthy();
    expect(screen.getByText('매도 최고선')).toBeTruthy();
    // 현재값 수평선과 독립 토글이다 — 최고선을 켜도 현재값 피커는 나오지 않는다.
    expect(screen.queryByText('매수 수평선')).toBeNull();
  });

  // 여기 `/study` 게이트 케이스가 있었다 — 최고 수평선이 복기에서 숨겨지는지 재던
  // 것인데, 그 페이지와 게이트가 함께 사라졌다(2026-08-23). 아래가 남는 계약 전부다.
  it('창 스코프 안에서도 최고 수평선 토글은 그대로 있다', () => {
    render(<QuoteTotalsConfig />, { wrapper: windowProvider() });
    expect(screen.getByTestId('settings-toggle-quoteTotalsDayMaxLineEnabled')).toBeTruthy();
  });
});
