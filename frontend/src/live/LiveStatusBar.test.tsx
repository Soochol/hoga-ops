import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LiveStatusBar } from './LiveStatusBar';
import type { RangeBundle } from '../api/types';

const EMPTY_BUNDLE: RangeBundle = {
  code: '005930',
  from_date: '20260527',
  to_date: '20260527',
  bucket_ms: 60_000,
  segments: [
    {
      date: '20260527',
      session_open_ms: 1748275200000,
      session_close_ms: 1748298600000,
      source: 'kis_live',
    },
  ],
  candles: [],
  quote_ratio: { bucket_ms: 60_000, points: [] },
  fill_strength: { bucket_ms: 60_000, points: [] },
  volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
  volume_profile_by_day: [],
};

function renderBar(props: { activeCode: string | null; cycleLagMs: number; bundle: RangeBundle | null }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <LiveStatusBar {...props} />
    </QueryClientProvider>,
  );
}

describe('LiveStatusBar', () => {
  beforeEach(() => {
    cleanup();
  });

  it('shows em-dash when activeCode is null', () => {
    renderBar({ activeCode: null, cycleLagMs: 0, bundle: null });
    expect(screen.getByTestId('live-status-bar').textContent).toContain('—');
  });

  it('shows the activeCode when set', () => {
    renderBar({ activeCode: '005930', cycleLagMs: 0, bundle: EMPTY_BUNDLE });
    expect(screen.getByTestId('live-status-bar').textContent).toContain('005930');
  });

  it('shows 대기 중 price placeholder when candle data is not yet available', () => {
    renderBar({ activeCode: '005930', cycleLagMs: 100, bundle: EMPTY_BUNDLE });
    expect(screen.getByTestId('live-status-bar').textContent).toContain('대기 중');
  });

  it('shows latest candle close price when data is available', () => {
    const bundle: RangeBundle = {
      ...EMPTY_BUNDLE,
      candles: [
        { ts_ms: 1000, open: 70000, high: 71000, low: 69000, close: 70500, vol_a: 1000, vol_b: 0 },
        { ts_ms: 2000, open: 70500, high: 72000, low: 70000, close: 71200, vol_a: 1500, vol_b: 0 },
      ],
    };
    renderBar({ activeCode: '005930', cycleLagMs: 50, bundle });
    expect(screen.getByTestId('live-current-price').textContent).toContain('71,200');
  });

  it('renders the kis_live source chip (ADR-0039 compliance)', () => {
    renderBar({ activeCode: '005930', cycleLagMs: 0, bundle: EMPTY_BUNDLE });
    expect(screen.getByTestId('source-chip-kis_live')).toBeTruthy();
  });
});
