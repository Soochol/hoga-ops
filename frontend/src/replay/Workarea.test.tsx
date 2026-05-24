import { render, screen, fireEvent } from '@testing-library/react';
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

import { useReplayLayoutStore } from '../state/replayLayout';

vi.mock('./CollapsedSidebarHandle', () => ({
  default: () => <div data-testid="collapsed-handle-stub" />,
}));

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

describe('Workarea — sidebar splitter + collapse wiring', () => {
  beforeEach(() => {
    useReplayLayoutStore.getState().__resetForTests();
    useTabsStore.getState().reset?.();
    const id = useTabsStore.getState().tabs[0].id;
    useTabsStore.getState().setSelection(id, {
      code: '005930',
      fromDate: '20260512',
      toDate: '20260512',
      timeframe: '1m',
    });
    (useRange as ReturnType<typeof vi.fn>).mockReturnValue({
      data: baseBundle,
      isLoading: false,
      isError: false,
      error: null,
    });
  });

  it('renders sidebar + splitter when not collapsed', () => {
    const tab = useTabsStore.getState().tabs[0];
    wrap(<Workarea tab={tab} />);
    expect(screen.getByTestId('cursor-sidebar-stub')).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: /사이드바 폭 조정/ })).toBeInTheDocument();
    expect(screen.queryByTestId('collapsed-handle-stub')).toBeNull();
  });

  it('renders only the floating handle when collapsed', () => {
    useReplayLayoutStore.getState().setSidebarCollapsed(true);
    const tab = useTabsStore.getState().tabs[0];
    wrap(<Workarea tab={tab} />);
    expect(screen.queryByTestId('cursor-sidebar-stub')).toBeNull();
    expect(screen.queryByRole('separator', { name: /사이드바 폭 조정/ })).toBeNull();
    expect(screen.getByTestId('collapsed-handle-stub')).toBeInTheDocument();
  });

  it('splitter drag updates the store sidebarPx', () => {
    const tab = useTabsStore.getState().tabs[0];
    const { container } = wrap(<Workarea tab={tab} />);
    // Stub the container's bounding rect so onDrag has a stable rect.right.
    const root = container.querySelector('[data-testid="workarea-grid"]') as HTMLElement;
    expect(root).not.toBeNull();
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 700,
      width: 1000,
      height: 700,
      toJSON: () => ({}),
    } as DOMRect);
    const sep = screen.getByRole('separator', { name: /사이드바 폭 조정/ });
    fireEvent.mouseDown(sep, { clientX: 600 });
    fireEvent.mouseMove(window, { clientX: 600 }); // rect.right=1000, splitter-half=6 → sidebar=1000-600-6=394
    fireEvent.mouseUp(window);
    expect(useReplayLayoutStore.getState().sidebarPx).toBe(394);
  });
});
