import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import PeakWallsConfig from './PeakWallsConfig';
import { useLivePageStore } from '../../state/livePage';

// pane 토글은 방향 공용(한 pane 에 매도·매수 두 계단)이라 매도|매수 서브탭 **바깥**
// 공용 섹션에 있어야 한다 — 탭 안에 넣으면 같은 노브가 두 번 나온다(구현 계획 §4.3).
describe('PeakWallsConfig — 최대벽 강도 pane 토글 (공용 섹션)', () => {
  beforeEach(() => {
    useLivePageStore.setState({ peakWallPaneEnabled: false, indicatorsByTimeframe: {} });
  });
  afterEach(cleanup);

  it('pane 토글이 서브탭 밖에 있어 매도·매수 어느 탭에서도 하나만 보인다', () => {
    render(<PeakWallsConfig />);
    expect(screen.getAllByTestId('settings-toggle-peakWallPaneEnabled')).toHaveLength(1);
    fireEvent.click(screen.getByRole('tab', { name: '매수' }));
    expect(screen.getAllByTestId('settings-toggle-peakWallPaneEnabled')).toHaveLength(1);
  });

  it('토글 클릭이 store 의 peakWallPaneEnabled 를 켠다 (pane 게이트가 읽는 그 키)', () => {
    render(<PeakWallsConfig />);
    // ToggleRow 는 testId 를 바깥 wrapper 에 단다 — 핸들러는 안쪽 role="switch".
    const row = screen.getByTestId('settings-toggle-peakWallPaneEnabled');
    fireEvent.click(row.querySelector('[role="switch"]') as HTMLElement);
    expect(useLivePageStore.getState().peakWallPaneEnabled).toBe(true);
  });
});
