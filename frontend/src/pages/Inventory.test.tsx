import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import Inventory from './Inventory';

vi.mock('../api/stock-dates', () => ({
  useStockDates: vi.fn(),
}));

vi.mock('../inventory/StockDateGroupList', () => ({
  StockDateGroupList: () => <div>list stub</div>,
}));

vi.mock('../inventory/StockDateGroupDetail', () => ({
  StockDateGroupDetail: () => <div>detail stub</div>,
}));

import { useStockDates } from '../api/stock-dates';

describe('Inventory page', () => {
  beforeEach(() => {
    vi.mocked(useStockDates).mockReturnValue({
      data: [
        {
          code: '005930',
          name: '삼성전자',
          date: '20260627',
          regular_session_open_ms: 0,
          regular_session_close_ms: 0,
          data_window_first_ms: 0,
          data_window_last_ms: 0,
          price_min: 0,
          price_max: 0,
          captured_at: 1,
          total_volume: 1,
          pages_collected: 1,
          file_size_bytes: 1,
          today_open: 1,
          today_high: 1,
          today_low: 1,
          today_close: 1,
          disk_state: 'complete',
          full_capture_count: null,
          fail_streak: 0,
          blocked: false,
        },
      ],
      isLoading: false,
    } as ReturnType<typeof useStockDates>);
  });

  it('renders surfaced list and detail panes', () => {
    render(<Inventory />);

    expect(screen.getByTestId('inventory-list-pane')).toHaveClass('bg-bg-card');
    expect(screen.getByTestId('inventory-list-pane')).toHaveClass('border');
    expect(screen.getByTestId('inventory-detail-pane')).toHaveClass('bg-bg-card');
    expect(screen.getByTestId('inventory-detail-pane')).toHaveClass('border');
  });
});
