import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import PeakWallsConfig from './PeakWallsConfig';
import { useLivePageStore } from '../../state/livePage';

// 「표시 위치」 섹션 — 캔들 수평선(방향별, = hidden 반전)과 전용 pane 계단(공용)을
// 한 결정으로 묶는다. pane 토글은 어느 탭에서 봐도 같은 하나의 상태다.
describe('PeakWallsConfig — 표시 위치 (캔들 수평선 · 전용 pane)', () => {
  beforeEach(() => {
    useLivePageStore.setState({
      peakWallPaneEnabled: false,
      askPeakEnabled: true,
      askPeakHidden: false,
      bidPeakEnabled: true,
      bidPeakHidden: false,
      indicatorsByTimeframe: {},
    });
  });
  afterEach(cleanup);

  // ToggleRow 는 testId 를 바깥 wrapper 에 단다 — 핸들러는 안쪽 role="switch".
  const clickSwitch = (testId: string) => {
    const row = screen.getByTestId(testId);
    fireEvent.click(row.querySelector('[role="switch"]') as HTMLElement);
  };

  it('pane 토글은 공용이라 매도·매수 어느 탭에서도 하나만 보인다', () => {
    render(<PeakWallsConfig />);
    expect(screen.getAllByTestId('settings-toggle-peakWallPaneEnabled')).toHaveLength(1);
    fireEvent.click(screen.getByRole('tab', { name: '매수' }));
    expect(screen.getAllByTestId('settings-toggle-peakWallPaneEnabled')).toHaveLength(1);
  });

  it('pane 토글 클릭이 store 의 peakWallPaneEnabled 를 켠다 (pane 게이트가 읽는 그 키)', () => {
    render(<PeakWallsConfig />);
    clickSwitch('settings-toggle-peakWallPaneEnabled');
    expect(useLivePageStore.getState().peakWallPaneEnabled).toBe(true);
  });

  it('「캔들 차트에 수평선」 끔 = 기존 눈(hidden) 켬 — 새 키가 아니라 같은 상태', () => {
    render(<PeakWallsConfig />);
    clickSwitch('settings-toggle-askPeakCandleLine');
    expect(useLivePageStore.getState().askPeakHidden).toBe(true);
    // 다시 켜면 hidden 해제.
    clickSwitch('settings-toggle-askPeakCandleLine');
    expect(useLivePageStore.getState().askPeakHidden).toBe(false);
  });

  it('캔들 수평선 토글은 방향별 — 매수 탭에서는 bidPeakHidden 을 움직인다', () => {
    render(<PeakWallsConfig />);
    fireEvent.click(screen.getByRole('tab', { name: '매수' }));
    clickSwitch('settings-toggle-bidPeakCandleLine');
    expect(useLivePageStore.getState().bidPeakHidden).toBe(true);
    expect(useLivePageStore.getState().askPeakHidden).toBe(false);
  });

  it('마스터(최대벽 표시)가 꺼져 있으면 캔들 수평선 토글은 dim(disabled)', () => {
    useLivePageStore.setState({ askPeakEnabled: false });
    render(<PeakWallsConfig />);
    const row = screen.getByTestId('settings-toggle-askPeakCandleLine');
    expect(row.querySelector('[role="switch"]')).toBeDisabled();
    // pane 토글은 공용이라 side 마스터에 물리지 않는다.
    const paneRow = screen.getByTestId('settings-toggle-peakWallPaneEnabled');
    expect(paneRow.querySelector('[role="switch"]')).not.toBeDisabled();
  });
});
