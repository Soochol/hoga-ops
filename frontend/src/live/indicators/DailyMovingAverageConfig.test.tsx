import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DailyMovingAverageConfig from './DailyMovingAverageConfig';
import { useLivePageStore, DEFAULT_DAILY_MAS, MA_SLOT_LIMIT } from '../../state/livePage';

describe('DailyMovingAverageConfig', () => {
  beforeEach(() => {
    useLivePageStore.setState({
      dailyMovingAverages: DEFAULT_DAILY_MAS.map((m) => ({ ...m })),
      dailyMovingAverageEnabled: false,
    });
  });

  it('renders one row per slot (period spinbutton)', () => {
    render(<DailyMovingAverageConfig />);
    expect(screen.getAllByRole('spinbutton')).toHaveLength(DEFAULT_DAILY_MAS.length);
  });

  it('"기간 추가" appends a daily slot', () => {
    render(<DailyMovingAverageConfig />);
    fireEvent.click(screen.getByRole('button', { name: /기간 추가/ }));
    expect(useLivePageStore.getState().dailyMovingAverages).toHaveLength(DEFAULT_DAILY_MAS.length + 1);
  });

  it('"기간 추가" disabled at MA_SLOT_LIMIT', () => {
    while (useLivePageStore.getState().dailyMovingAverages.length < MA_SLOT_LIMIT) {
      useLivePageStore.getState().addDailyMovingAverage();
    }
    render(<DailyMovingAverageConfig />);
    expect((screen.getByRole('button', { name: /기간 추가/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('header + 분봉 전용 안내 표시', () => {
    render(<DailyMovingAverageConfig />);
    expect(screen.getByText('일봉 이동평균선')).toBeTruthy();
    expect(screen.getByText(/분봉 차트에서만 표시/)).toBeTruthy();
  });

  it('상세 pane에서 일봉 MA 표시를 켤 수 있다', () => {
    render(<DailyMovingAverageConfig />);
    const toggle = screen.getByRole('switch', { name: '일봉 MA 표시' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);

    expect(useLivePageStore.getState().dailyMovingAverageEnabled).toBe(true);
  });
});
