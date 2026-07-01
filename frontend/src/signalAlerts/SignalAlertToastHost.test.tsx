import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushEvent } from '../api/types';
import SignalAlertToastHost from './SignalAlertToastHost';

const subs: Array<(event: PushEvent) => void> = [];
const jumpToLive = vi.fn();

vi.mock('../api/ws', () => ({
  subscribeEvents: (cb: (event: PushEvent) => void) => {
    subs.push(cb);
    return () => {
      const index = subs.indexOf(cb);
      if (index >= 0) subs.splice(index, 1);
    };
  },
}));

vi.mock('../live/useJumpToLive', () => ({
  useJumpToLive: () => jumpToLive,
}));

describe('SignalAlertToastHost', () => {
  beforeEach(() => {
    subs.length = 0;
    jumpToLive.mockReset();
  });

  it('shows a concise toast for signal alerts, jumps on click, and auto-dismisses', () => {
    vi.useFakeTimers();
    try {
      render(<SignalAlertToastHost />);

      act(() => {
        subs[0]({
          type: 'signal_alert',
          id: 'toast-1',
          signal: 'sell_total_renewal',
          seq: 1,
          code: '005930',
          name: '삼성전자',
          t_ms: 1,
          date: '20260701',
          source: 'ws',
          value: 1234567,
          baseline: 1000000,
          ratio_pct: 123.5,
          use_intra_minute_max: true,
        });
      });

      const toast = screen.getByRole('button', { name: '삼성전자 005930 알림 열기' });
      expect(toast).toHaveTextContent('삼성전자');
      expect(toast).toHaveTextContent('매도 총잔량');
      expect(toast).toHaveTextContent('1,234,567');
      expect(toast).toHaveTextContent('123.5%');

      fireEvent.click(toast);
      expect(jumpToLive).toHaveBeenCalledWith('005930', '삼성전자');

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      expect(screen.queryByRole('button', { name: '삼성전자 005930 알림 열기' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
