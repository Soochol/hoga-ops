import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LiveWorkarea } from './LiveWorkarea';

vi.mock('./useLiveBundle', () => ({
  useLiveBundle: () => ({
    bundle: {
      code: '005930',
      from_date: '20260501',
      to_date: '20260527',
      bucket_ms: 60000,
      segments: [],
      candles: [],
      quote_ratio: { bucket_ms: 60000, points: [] },
      fill_strength: { bucket_ms: 60000, points: [] },
      volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
      volume_profile_by_day: [],
      excluded_dates: [{
        date: '20260526',
        violations: [{ invariant_id: 'meta.close_after_open', severity: 'error', message: 'x', ctx: {} }],
      }],
    },
    isLoading: false,
    error: null,
    clampEngaged: false,
    isPastCandlesLoading: false,
  }),
}));
vi.mock('./LiveChartRoot', () => ({ LiveChartRoot: () => <div data-testid="chart" /> }));
vi.mock('./LiveSidebar', () => ({ LiveSidebar: () => <div data-testid="sidebar" /> }));

describe('LiveWorkarea', () => {
  it('renders InvariantOutcomesBanner with excluded dates when bundle has them', () => {
    render(<LiveWorkarea activeCode="005930" watchlistEmpty={false} />);
    // Banner renders date as MM/DD per InvariantOutcomesBanner.fmtMD
    expect(screen.getByText(/5\/26/)).toBeInTheDocument();
  });
});
