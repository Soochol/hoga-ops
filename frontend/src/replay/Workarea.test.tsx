import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useTabsStore } from '../state/tabs';
import type { RangeBundle } from '../api/types';

// Stub useRange so Workarea can be rendered without a real network call
vi.mock('../api/range', () => ({
  useRange: vi.fn(),
}));
import { useRange } from '../api/range';

// Mock ChartStage — lightweight-charts requires window.matchMedia which jsdom
// doesn't provide. We only care about Workarea wiring here.
vi.mock('../chart/ChartStage', () => ({
  default: () => <div data-testid="chart-stage-stub" />,
}));
// Mock CursorSidebar — depends on chart state we don't set up.
vi.mock('../sidebar/CursorSidebar', () => ({
  CursorSidebarConnected: () => <div data-testid="cursor-sidebar-stub" />,
}));

import Workarea from './Workarea';

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const baseBundle: RangeBundle = {
  code: '005930',
  from_date: '20260512',
  to_date: '20260512',
  bucket_ms: 60_000,
  segments: [
    { date: '20260512', session_open_ms: 1_715_500_000_000, session_close_ms: 1_715_523_400_000 },
  ],
  candles: [],
  quote_ratio: { bucket_ms: 60_000, points: [] },
  fill_strength: { bucket_ms: 60_000, points: [] },
  volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
  volume_profile_by_day: [],
};

describe('Workarea — useRange wiring + RangeAdjustmentNotice', () => {
  beforeEach(() => {
    useTabsStore.getState().reset?.();
    const id = useTabsStore.getState().tabs[0].id;
    useTabsStore.getState().setSelection(id, {
      code: '005930',
      fromDate: '20260512',
      toDate: '20260512',
      timeframe: '1m',
    });
  });

  it('calls useRange with selection fields', () => {
    (useRange as ReturnType<typeof vi.fn>).mockReturnValue({
      data: baseBundle,
      isLoading: false,
      isError: false,
      error: null,
    });
    const tab = useTabsStore.getState().tabs[0];
    wrap(<Workarea tab={tab} />);
    expect(useRange).toHaveBeenCalledWith('005930', '20260512', '20260512', '1m');
  });

  it('does NOT render RangeAdjustmentNotice when bundle matches selection', () => {
    (useRange as ReturnType<typeof vi.fn>).mockReturnValue({
      data: baseBundle,
      isLoading: false,
      isError: false,
      error: null,
    });
    const tab = useTabsStore.getState().tabs[0];
    wrap(<Workarea tab={tab} />);
    expect(screen.queryByText(/아직 캡처/)).toBeNull();
  });

  it('renders RangeAdjustmentNotice when first segment date > selection.fromDate', () => {
    const id = useTabsStore.getState().tabs[0].id;
    useTabsStore.getState().setSelection(id, {
      code: '005930',
      fromDate: '20260501',
      toDate: '20260512',
      timeframe: '1m',
    });
    (useRange as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { ...baseBundle, from_date: '20260501', to_date: '20260512' },
      isLoading: false,
      isError: false,
      error: null,
    });
    const tab = useTabsStore.getState().tabs.find((t) => t.id === id)!;
    wrap(<Workarea tab={tab} />);
    expect(screen.getByText(/5\/1.*아직 캡처/)).toBeInTheDocument();
  });
});
