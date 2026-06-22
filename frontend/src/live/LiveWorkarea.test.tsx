import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LiveWorkarea } from './LiveWorkarea';
import { useLivePageStore } from '../state/livePage';
import { indexInstrument, stockInstrument } from './liveInstrument';
import type { LiveSeriesData } from '../api/liveSeries';
import type { RangeBundle } from '../api/types';

vi.mock('./LiveChartRoot', () => ({ LiveChartRoot: () => <div data-testid="chart-stub" /> }));
vi.mock('./LiveSidebar', () => ({ LiveSidebar: () => <div data-testid="sidebar-stub" /> }));
vi.mock('./IndexSectorRankingPane', () => ({
  IndexSectorRankingPane: () => <div data-testid="index-sector-ranking-pane" />,
}));
vi.mock('../api/indexSectorRankings', () => ({
  useIndexSectorRankings: () => ({
    data: { date: '20260619', source: 'daily_adjusted', unavailable_reason: null, sectors: [] },
    isLoading: false,
    error: null,
  }),
}));
vi.mock('./useJumpToLive', () => ({
  useJumpToLive: () => vi.fn(),
}));

const LIVE: LiveSeriesData = {
  initial: undefined, isLoading: false, error: null, ob: [], trade: [], broker: [],
};

const INDEX_BUNDLE: RangeBundle = {
  code: 'index:KOSPI',
  from_date: '20260601',
  to_date: '20260619',
  bucket_ms: 86_400_000,
  segments: [],
  candles: [],
  quote_ratio: { bucket_ms: 60_000, points: [] },
  fill_strength: { bucket_ms: 60_000, points: [] },
  volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
  volume_profile_by_day: [],
  investorPoints: [],
  ask_peaks: [],
};

function renderWorkarea(activeCode: string | null, activeInstrument = null) {
  return render(
    <LiveWorkarea
      activeCode={activeCode}
      activeInstrument={activeInstrument}
      bundle={null}
      clampEngaged={false}
      isPastCandlesLoading={false}
      isExtending={false}
      live={LIVE}
    />,
  );
}

describe('LiveWorkarea gate', () => {
  it('renders the chart when activeCode is set (even with empty watchlist)', () => {
    renderWorkarea('005930');
    expect(screen.getByTestId('chart-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('live-empty-state')).toBeNull();
  });

  it('renders the search-prompt empty state when no activeCode', () => {
    renderWorkarea(null);
    expect(screen.getByTestId('live-empty-state')).toBeInTheDocument();
  });

  it('renders the index sector pane for index D timeframe', () => {
    useLivePageStore.setState({ candleTimeframe: 'D' });
    render(
      <LiveWorkarea
        activeCode="index:KOSPI"
        activeInstrument={indexInstrument('KOSPI', 'KOSPI')}
        bundle={INDEX_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isExtending={false}
        live={LIVE}
      />,
    );
    expect(screen.getByTestId('index-sector-ranking-pane')).toBeInTheDocument();
  });

  it('does not render the index sector pane for stock instruments', () => {
    useLivePageStore.setState({ candleTimeframe: 'D' });
    render(
      <LiveWorkarea
        activeCode="005930"
        activeInstrument={stockInstrument('005930', '삼성전자')}
        bundle={null}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isExtending={false}
        live={LIVE}
      />,
    );
    expect(screen.queryByTestId('index-sector-ranking-pane')).toBeNull();
  });

  it('does not render the index sector pane for index W and M timeframes', () => {
    for (const timeframe of ['W', 'M'] as const) {
      useLivePageStore.setState({ candleTimeframe: timeframe });
      const { unmount } = render(
        <LiveWorkarea
          activeCode="index:KOSPI"
          activeInstrument={indexInstrument('KOSPI', 'KOSPI')}
          bundle={INDEX_BUNDLE}
          clampEngaged={false}
          isPastCandlesLoading={false}
          isExtending={false}
          live={LIVE}
        />,
      );
      expect(screen.queryByTestId('index-sector-ranking-pane')).toBeNull();
      unmount();
    }
  });
});
