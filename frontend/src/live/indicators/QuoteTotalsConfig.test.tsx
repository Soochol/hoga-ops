import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import QuoteTotalsConfig from './QuoteTotalsConfig';
import { useLivePageStore } from '../../state/livePage';
import { WindowViewContext, LIVE_WINDOW_WORKSPACE, type WindowViewValue } from '../workspace/windowView';
import { STUDY_WINDOW_WORKSPACE } from '../../studyViews/studyWindowWorkspace';

/** 지표 소유 페이지를 세우는 최소 Provider — `useWindowIndicatorScope` 는
 *  `workspace.scopePrefix` 만 읽는다(ADR-0146, 어댑터에서 렌더 동기적). */
function pageProvider(workspace: typeof LIVE_WINDOW_WORKSPACE) {
  const value: WindowViewValue = {
    windowId: 'w1',
    group: 3,
    code: '000660',
    timeframe: '1m',
    historicalFromDate: null,
    workspace,
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

  // 최고 수평선은 `/live` 전용이다(기준일이 로드 구간의 끝날이라 복기와 어긋난다).
  // 켤 수는 있는데 안 그려지는 유령 토글을 남기지 않도록 설정 행 자체를 숨긴다.
  it('/study 에서는 최고 수평선 토글이 아예 없다 — 켜져 있어도', () => {
    useLivePageStore.setState({ quoteTotalsDayMaxLineEnabled: true });
    render(<QuoteTotalsConfig />, { wrapper: pageProvider(STUDY_WINDOW_WORKSPACE) });
    expect(screen.queryByTestId('settings-toggle-quoteTotalsDayMaxLineEnabled')).toBeNull();
    expect(screen.queryByText('매수 최고선')).toBeNull();
    // 대조군: 현재값 수평선은 복기에서도 남는다 — 이 게이트가 총잔량 설정을 통째로
    // 지우는 게 아니라 최고선만 겨눈다는 것을 못 박는다.
    expect(screen.getByTestId('settings-toggle-quoteTotalsLevelLineEnabled')).toBeTruthy();
  });

  it('/live scope 를 명시해도 최고 수평선 토글은 그대로 있다', () => {
    render(<QuoteTotalsConfig />, { wrapper: pageProvider(LIVE_WINDOW_WORKSPACE) });
    expect(screen.getByTestId('settings-toggle-quoteTotalsDayMaxLineEnabled')).toBeTruthy();
  });
});
