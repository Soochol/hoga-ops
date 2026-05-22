import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// Mock ChartStage to throw — proves the boundary catches it.
vi.mock('../../src/chart/ChartStage', () => ({
  default: () => {
    throw new Error('boundary-test boom');
  },
}));
// Mock CursorSidebarConnected so it doesn't pull in network code.
vi.mock('../../src/sidebar/CursorSidebar', () => ({
  CursorSidebarConnected: () => <div data-testid="sidebar" />,
}));
// Stub useRange — replaces the long-gone useSession hook (ADR-0013).
// Bundle shape only needs `segments` to be array-shaped for Workarea's buildSegments
// call; ChartStage is mocked to throw before it consumes anything else.
vi.mock('../../src/api/range', () => ({
  useRange: () => ({
    data: {
      code: '003490',
      from_date: '20260511',
      to_date: '20260511',
      bucket_ms: 60_000,
      segments: [
        { date: '20260511', session_open_ms: 1_715_500_000_000, session_close_ms: 1_715_523_400_000 },
      ],
      candles: [],
      quote_ratio: { bucket_ms: 60_000, points: [] },
      depth_intensity_by_day: [],
      fill_strength: { bucket_ms: 60_000, points: [] },
      volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
      volume_profile_by_day: [],
    },
    isLoading: false,
    isError: false,
    error: null,
  }),
}));
vi.mock('../../src/api/stock-dates', () => ({
  useStockDates: () => ({ data: [] }),
}));

import Workarea from '../../src/replay/Workarea';

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('Workarea + ChartErrorBoundary integration', () => {
  const origErr = console.error;
  afterEach(() => {
    console.error = origErr;
  });

  it('isolates chart throws so sidebar remains rendered', () => {
    console.error = vi.fn();
    const tab: any = {
      id: 't1',
      selection: { code: '003490', fromDate: '20260511', toDate: '20260511', timeframe: '1m' },
      cursorMs: null,
      status: 'loaded',
      bundles: new Map(),
    };
    wrap(<Workarea tab={tab} />);
    expect(screen.getByText(/차트 렌더링에 실패했습니다/)).toBeInTheDocument();
    expect(screen.getByText(/boundary-test boom/)).toBeInTheDocument();
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
  });
});
