import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LiveWorkarea } from './LiveWorkarea';
import type { LiveChartRoot } from './LiveChartRoot';
import { useLivePageStore } from '../state/livePage';
import { indexInstrument, stockInstrument } from './liveInstrument';
import type { IndexSectorRankingResponse } from '../api/indexSectorRankings';
import type { LiveSeriesData } from '../api/liveSeries';
import type { RangeBundle } from '../api/types';

type LiveChartRootProps = Parameters<typeof LiveChartRoot>[0];
type LiveChartRootMock = (props: LiveChartRootProps) => JSX.Element;
type UseIndexSectorRankingsMock = (
  date: string | null,
  enabledByCaller?: boolean,
) => {
  data: IndexSectorRankingResponse | undefined;
  isLoading: boolean;
  error: unknown;
};

const liveChartRootMock = vi.hoisted(() =>
  vi.fn((props: LiveChartRootProps): ReturnType<LiveChartRootMock> => {
    void props;
    return <div data-testid="chart-stub" />;
  }),
);
const useIndexSectorRankingsMock = vi.hoisted(() =>
  vi.fn<UseIndexSectorRankingsMock>((date, enabledByCaller = true) => {
    void date;
    void enabledByCaller;
    return {
      data: { date: '20260619', source: 'daily_adjusted', unavailable_reason: null, sectors: [] },
      isLoading: false,
      error: null,
    };
  }),
);

vi.mock('./LiveChartRoot', () => ({
  LiveChartRoot: (props: LiveChartRootProps) => liveChartRootMock(props),
}));
vi.mock('./LiveSidebar', () => ({ LiveSidebar: () => <div data-testid="sidebar-stub" /> }));
vi.mock('./IndexSectorRankingPane', () => ({
  IndexSectorRankingPane: () => <div data-testid="index-sector-ranking-pane" />,
}));
vi.mock('../api/indexSectorRankings', () => ({
  useIndexSectorRankings: (...args: Parameters<UseIndexSectorRankingsMock>) =>
    useIndexSectorRankingsMock(...args),
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

const INDEX_BUNDLE_WITH_LAST_CANDLE: RangeBundle = {
  ...INDEX_BUNDLE,
  to_date: '20260621',
  segments: [
    {
      date: '20260618',
      session_open_ms: Date.UTC(2026, 5, 18, 0, 0),
      session_close_ms: Date.UTC(2026, 5, 18, 6, 30),
    },
  ],
  candles: [
    {
      ts_ms: Date.UTC(2026, 5, 18, 0, 0),
      open: 2800,
      high: 2840,
      low: 2790,
      close: 2830,
      vol_a: 1_000_000,
      vol_b: 0,
    },
  ],
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
        bundle={INDEX_BUNDLE_WITH_LAST_CANDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isExtending={false}
        live={LIVE}
      />,
    );
    expect(screen.getByTestId('index-sector-ranking-pane')).toBeInTheDocument();
    expect(useIndexSectorRankingsMock).toHaveBeenCalledWith('20260618', true);
    const chartProps = liveChartRootMock.mock.calls.at(-1)?.[0] as
      | { onCandleBasisHover?: unknown; onCandleBasisClick?: unknown }
      | undefined;
    expect(chartProps?.onCandleBasisHover).toEqual(expect.any(Function));
    expect(chartProps?.onCandleBasisClick).toEqual(expect.any(Function));
  });

  it('uses the last loaded index candle date as the latest ranking basis', () => {
    useLivePageStore.setState({ candleTimeframe: 'D' });
    render(
      <LiveWorkarea
        activeCode="index:KOSPI"
        activeInstrument={indexInstrument('KOSPI', 'KOSPI')}
        bundle={INDEX_BUNDLE_WITH_LAST_CANDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isExtending={false}
        live={LIVE}
      />,
    );

    expect(useIndexSectorRankingsMock).toHaveBeenCalledWith('20260618', true);
  });

  it('does not fetch a latest index sector ranking without a loaded candle date', () => {
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

    expect(useIndexSectorRankingsMock).toHaveBeenCalledWith(null, true);
  });

  it('keeps ranking callbacks stable across allowed rerenders', () => {
    useLivePageStore.setState({ candleTimeframe: 'D' });
    const { rerender } = render(
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
    const firstChartProps = liveChartRootMock.mock.calls.at(-1)?.[0] as
      | { onCandleBasisHover?: unknown; onCandleBasisClick?: unknown }
      | undefined;

    rerender(
      <LiveWorkarea
        activeCode="index:KOSPI"
        activeInstrument={indexInstrument('KOSPI', 'KOSPI')}
        bundle={INDEX_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isExtending={false}
        live={{ ...LIVE }}
      />,
    );
    const secondChartProps = liveChartRootMock.mock.calls.at(-1)?.[0] as
      | { onCandleBasisHover?: unknown; onCandleBasisClick?: unknown }
      | undefined;

    expect(secondChartProps?.onCandleBasisHover).toBe(firstChartProps?.onCandleBasisHover);
    expect(secondChartProps?.onCandleBasisClick).toBe(firstChartProps?.onCandleBasisClick);
  });

  it('returns to the latest candle basis when the chart whitespace is clicked', () => {
    useLivePageStore.setState({ candleTimeframe: 'D' });
    const { rerender } = render(
      <LiveWorkarea
        activeCode="index:KOSPI"
        activeInstrument={indexInstrument('KOSPI', 'KOSPI')}
        bundle={INDEX_BUNDLE_WITH_LAST_CANDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isExtending={false}
        live={LIVE}
      />,
    );
    const chartProps = liveChartRootMock.mock.calls.at(-1)?.[0] as
      | { onCandleBasisClick?: (date: string | null) => void }
      | undefined;

    chartProps?.onCandleBasisClick?.('20260617');
    rerender(
      <LiveWorkarea
        activeCode="index:KOSPI"
        activeInstrument={indexInstrument('KOSPI', 'KOSPI')}
        bundle={INDEX_BUNDLE_WITH_LAST_CANDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isExtending={false}
        live={LIVE}
      />,
    );
    expect(useIndexSectorRankingsMock).toHaveBeenLastCalledWith('20260617', true);

    chartProps?.onCandleBasisClick?.(null);
    rerender(
      <LiveWorkarea
        activeCode="index:KOSPI"
        activeInstrument={indexInstrument('KOSPI', 'KOSPI')}
        bundle={INDEX_BUNDLE_WITH_LAST_CANDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isExtending={false}
        live={LIVE}
      />,
    );
    expect(useIndexSectorRankingsMock).toHaveBeenLastCalledWith('20260618', true);
  });

  it('returns to the latest candle basis on Escape', () => {
    useLivePageStore.setState({ candleTimeframe: 'D' });
    const { rerender } = render(
      <LiveWorkarea
        activeCode="index:KOSPI"
        activeInstrument={indexInstrument('KOSPI', 'KOSPI')}
        bundle={INDEX_BUNDLE_WITH_LAST_CANDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isExtending={false}
        live={LIVE}
      />,
    );
    const chartProps = liveChartRootMock.mock.calls.at(-1)?.[0] as
      | { onCandleBasisClick?: (date: string | null) => void }
      | undefined;

    chartProps?.onCandleBasisClick?.('20260617');
    rerender(
      <LiveWorkarea
        activeCode="index:KOSPI"
        activeInstrument={indexInstrument('KOSPI', 'KOSPI')}
        bundle={INDEX_BUNDLE_WITH_LAST_CANDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isExtending={false}
        live={LIVE}
      />,
    );
    expect(useIndexSectorRankingsMock).toHaveBeenLastCalledWith('20260617', true);

    fireEvent.keyDown(window, { key: 'Escape' });
    rerender(
      <LiveWorkarea
        activeCode="index:KOSPI"
        activeInstrument={indexInstrument('KOSPI', 'KOSPI')}
        bundle={INDEX_BUNDLE_WITH_LAST_CANDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isExtending={false}
        live={LIVE}
      />,
    );
    expect(useIndexSectorRankingsMock).toHaveBeenLastCalledWith('20260618', true);
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
      expect(useIndexSectorRankingsMock).toHaveBeenCalledWith(null, false);
      const chartProps = liveChartRootMock.mock.calls.at(-1)?.[0] as
        | { onCandleBasisHover?: unknown; onCandleBasisClick?: unknown }
        | undefined;
      expect(chartProps?.onCandleBasisHover).toBeUndefined();
      expect(chartProps?.onCandleBasisClick).toBeUndefined();
      unmount();
    }
  });
});
