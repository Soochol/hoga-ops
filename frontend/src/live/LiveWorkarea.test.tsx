import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LiveWorkarea } from './LiveWorkarea';
import { useLivePageStore } from '../state/livePage';
import { indexInstrument, stockInstrument } from './liveInstrument';
import type { LiveSeriesData } from '../api/liveSeries';
import type { RangeBundle } from '../api/types';

const liveChartRootMock = vi.hoisted(() =>
  vi.fn(() => <div data-testid="chart-stub" />),
);
const useIndexSectorRankingsMock = vi.hoisted(() =>
  vi.fn(() => ({
    data: { date: '20260619', source: 'daily_adjusted', unavailable_reason: null, sectors: [] },
    isLoading: false,
    error: null,
  })),
);

vi.mock('./LiveChartRoot', () => ({
  LiveChartRoot: (props: Record<string, unknown>) => liveChartRootMock(props),
}));
vi.mock('./LiveSidebar', () => ({ LiveSidebar: () => <div data-testid="sidebar-stub" /> }));
vi.mock('./IndexSectorRankingPane', () => ({
  IndexSectorRankingPane: () => <div data-testid="index-sector-ranking-pane" />,
}));
vi.mock('../api/indexSectorRankings', () => ({
  useIndexSectorRankings: (...args: unknown[]) => useIndexSectorRankingsMock(...args),
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
  beforeEach(() => {
    liveChartRootMock.mockClear();
    useIndexSectorRankingsMock.mockClear();
    useLivePageStore.setState({ candleTimeframe: '1m' });
  });

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
    expect(useIndexSectorRankingsMock).toHaveBeenCalledWith('20260619', true);
    const chartProps = liveChartRootMock.mock.calls.at(-1)?.[0] as
      | { onCandleBasisHover?: unknown; onCandleBasisClick?: unknown }
      | undefined;
    expect(chartProps?.onCandleBasisHover).toEqual(expect.any(Function));
    expect(chartProps?.onCandleBasisClick).toEqual(expect.any(Function));
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
    expect(useIndexSectorRankingsMock).toHaveBeenCalledWith(null, false);
    const chartProps = liveChartRootMock.mock.calls.at(-1)?.[0] as
      | { onCandleBasisHover?: unknown; onCandleBasisClick?: unknown }
      | undefined;
    expect(chartProps?.onCandleBasisHover).toBeUndefined();
    expect(chartProps?.onCandleBasisClick).toBeUndefined();
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
      expect(useIndexSectorRankingsMock).toHaveBeenCalledWith('20260619', false);
      const chartProps = liveChartRootMock.mock.calls.at(-1)?.[0] as
        | { onCandleBasisHover?: unknown; onCandleBasisClick?: unknown }
        | undefined;
      expect(chartProps?.onCandleBasisHover).toBeUndefined();
      expect(chartProps?.onCandleBasisClick).toBeUndefined();
      unmount();
    }
  });
});
