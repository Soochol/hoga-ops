import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { LiveWorkarea } from './LiveWorkarea';
import type { LiveChartRoot } from './LiveChartRoot';
import { useLivePageStore } from '../state/livePage';
import { isPointOnChart, useEntryDragStore } from '../state/entryDrag';
import { indexInstrument, stockInstrument } from './liveInstrument';
import type { IndexSectorRankingResponse } from '../api/indexSectorRankings';
import type { LiveSeriesData } from '../api/liveSeries';
import type { RangeBundle } from '../api/types';
import { DEFAULT_CARD_WEIGHTS, DEFAULT_RIGHT_PANEL_WIDTH_PX, useLiveLayoutStore } from '../state/liveLayout';

type LiveChartRootProps = Parameters<typeof LiveChartRoot>[0];
type LiveChartRootMock = (props: LiveChartRootProps) => JSX.Element;
type UseIndexSectorRankingsMock = (
  date: string | null,
  enabledByCaller?: boolean,
  todayKst?: string | null,
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
  vi.fn<UseIndexSectorRankingsMock>((date, enabledByCaller = true, todayKst = null) => {
    void date;
    void enabledByCaller;
    void todayKst;
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
const liveSidebarMock = vi.hoisted(() =>
  vi.fn((props: unknown) => {
    void props;
    return <div data-testid="sidebar-stub" />;
  }),
);

vi.mock('./LiveSidebar', () => ({
  LiveSidebar: (props: unknown) => liveSidebarMock(props),
}));
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

const resizeObserverCallbacks: ResizeObserverCallback[] = [];

if (typeof window !== 'undefined' && !window.ResizeObserver) {
  window.ResizeObserver = class ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeObserverCallbacks.push(callback);
    }

    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

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
  volume_distributions: [],
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

const INDEX_BUNDLE_WITH_TODAY_CANDLE: RangeBundle = {
  ...INDEX_BUNDLE,
  segments: [
    {
      date: '20260619',
      session_open_ms: Date.UTC(2026, 5, 19, 0, 0),
      session_close_ms: Date.UTC(2026, 5, 19, 6, 30),
    },
  ],
  candles: [
    {
      ts_ms: Date.UTC(2026, 5, 19, 0, 0),
      open: 2830,
      high: 2860,
      low: 2820,
      close: 2850,
      vol_a: 1_200_000,
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

function mockRect(
  element: Element,
  rect: { left: number; top: number; right: number; bottom: number },
) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      toJSON: () => rect,
    }),
  });
}

function triggerResize(target: Element, width: number, height = 0) {
  Object.defineProperty(target, 'clientWidth', { configurable: true, value: width });
  act(() => {
    for (const callback of resizeObserverCallbacks) {
      callback(
        [{
          target,
          contentRect: {
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            bottom: height,
            right: width,
            width,
            height,
            toJSON: () => ({}),
          },
        } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    }
  });
}

describe('LiveWorkarea gate', () => {
  beforeEach(() => {
    localStorage.clear();
    resizeObserverCallbacks.length = 0;
    liveChartRootMock.mockClear();
    liveSidebarMock.mockClear();
    useIndexSectorRankingsMock.mockClear();
    useEntryDragStore.setState({
      draggingCode: null,
      overChart: false,
      overStudy: false,
      targets: {},
      hitTestChart: null,
      hitTestStudy: null,
    });
    useLivePageStore.setState({ candleTimeframe: '1m' });
    useLiveLayoutStore.setState({
      rightPanelWidthPx: DEFAULT_RIGHT_PANEL_WIDTH_PX,
      rightCardWeights: DEFAULT_CARD_WEIGHTS,
    });
  });

  it('renders the chart when activeCode is set (even with empty watchlist)', () => {
    renderWorkarea('005930');
    expect(screen.getByTestId('chart-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('live-empty-state')).toBeNull();
  });

  it('passes program trade series to the live sidebar', () => {
    const programTrade = {
      points: [
        {
          t: new Date('2026-06-25T00:00:00Z').getTime(),
          net_qty: 10,
          net_amount: 1000,
          gap_risk: false,
        },
      ],
    };
    render(
      <LiveWorkarea
        activeCode="005930"
        bundle={{ ...INDEX_BUNDLE, code: '005930', program_trade: programTrade }}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isExtending={false}
        live={LIVE}
      />,
    );

    expect(liveSidebarMock).toHaveBeenCalledWith(
      expect.objectContaining({ programTrade }),
    );
  });

  it('renders the toolbar inside the chart panel and sidebar beside it', () => {
    render(
      <LiveWorkarea
        activeCode="005930"
        bundle={INDEX_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isExtending={false}
        live={LIVE}
        onOpenIndicators={vi.fn()}
        onOpenSettings={vi.fn()}
        studySaveControl={<button type="button">save</button>}
      />,
    );

    const chartPanel = screen.getByTestId('live-chart-panel');
    expect(chartPanel).toContainElement(screen.getByTestId('live-toolbar'));
    expect(screen.getByTestId('live-workarea-splitter')).toHaveAttribute('aria-orientation', 'vertical');
    expect(screen.getByTestId('sidebar-stub')).toBeInTheDocument();
  });

  it('resizes the detail panel from the vertical splitter', () => {
    render(
      <LiveWorkarea
        activeCode="005930"
        bundle={INDEX_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isExtending={false}
        live={LIVE}
      />,
    );

    const workarea = screen.getByTestId('live-workarea');
    Object.defineProperty(workarea, 'clientWidth', { configurable: true, value: 1200 });
    const splitter = screen.getByTestId('live-workarea-splitter');
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    const hasPointerCapture = vi.fn(() => true);
    Object.defineProperty(splitter, 'setPointerCapture', { configurable: true, value: setPointerCapture });
    Object.defineProperty(splitter, 'releasePointerCapture', { configurable: true, value: releasePointerCapture });
    Object.defineProperty(splitter, 'hasPointerCapture', { configurable: true, value: hasPointerCapture });

    fireEvent.pointerDown(splitter, { pointerId: 1, clientX: 800 });
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');
    fireEvent.pointerMove(window, { clientX: 760 });
    expect(useLiveLayoutStore.getState().rightPanelWidthPx).toBe(440);
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 760 });

    expect(setPointerCapture).toHaveBeenCalledWith(1);
    expect(hasPointerCapture).toHaveBeenCalledWith(1);
    expect(releasePointerCapture).toHaveBeenCalledWith(1);
    expect(useLiveLayoutStore.getState().rightPanelWidthPx).toBe(440);
    expect(JSON.parse(localStorage.getItem('live.layout.v1') ?? '{}').rightPanelWidthPx).toBe(440);
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });

  it('scrolls the whole detail group when Alt+wheel is used over the workarea', () => {
    render(
      <LiveWorkarea
        activeCode="005930"
        bundle={INDEX_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isExtending={false}
        live={LIVE}
      />,
    );

    const detailGroup = screen.getByRole('complementary', { name: 'Live Detail Panel' });
    Object.defineProperty(detailGroup, 'scrollTop', { configurable: true, writable: true, value: 20 });
    Object.defineProperty(detailGroup, 'scrollHeight', { configurable: true, value: 1200 });
    Object.defineProperty(detailGroup, 'clientHeight', { configurable: true, value: 300 });

    fireEvent.wheel(screen.getByTestId('live-chart-panel'), { altKey: true, deltaY: 90 });

    expect(detailGroup.scrollTop).toBe(110);
  });

  it('starts splitter drag from the rendered clamped width when the saved width is oversized', () => {
    useLiveLayoutStore.setState({
      rightPanelWidthPx: 700,
      rightCardWeights: DEFAULT_CARD_WEIGHTS,
    });

    render(
      <LiveWorkarea
        activeCode="005930"
        bundle={INDEX_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isExtending={false}
        live={LIVE}
      />,
    );

    const workarea = screen.getByTestId('live-workarea');
    Object.defineProperty(workarea, 'clientWidth', { configurable: true, value: 1100 });
    triggerResize(workarea, 1100);

    const detailPanel = screen.getByRole('complementary', { name: 'Live Detail Panel' });
    expect(detailPanel).toHaveStyle({ width: '454px' });

    const splitter = screen.getByTestId('live-workarea-splitter');
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    const hasPointerCapture = vi.fn(() => true);
    Object.defineProperty(splitter, 'setPointerCapture', { configurable: true, value: setPointerCapture });
    Object.defineProperty(splitter, 'releasePointerCapture', { configurable: true, value: releasePointerCapture });
    Object.defineProperty(splitter, 'hasPointerCapture', { configurable: true, value: hasPointerCapture });

    fireEvent.pointerDown(splitter, { pointerId: 1, clientX: 800 });
    fireEvent.pointerMove(window, { clientX: 810 });

    expect(useLiveLayoutStore.getState().rightPanelWidthPx).toBe(444);

    fireEvent.pointerUp(window, { pointerId: 1, clientX: 810 });

    expect(useLiveLayoutStore.getState().rightPanelWidthPx).toBe(444);
    expect(JSON.parse(localStorage.getItem('live.layout.v1') ?? '{}').rightPanelWidthPx).toBe(444);
  });

  it('clamps a persisted oversized detail width on mount without overwriting the saved width', () => {
    useLiveLayoutStore.setState({
      rightPanelWidthPx: 700,
      rightCardWeights: DEFAULT_CARD_WEIGHTS,
    });
    const clientWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return this instanceof HTMLElement && this.dataset.testid === 'live-workarea' ? 900 : 0;
      },
    });

    try {
      render(
        <LiveWorkarea
          activeCode="005930"
          bundle={INDEX_BUNDLE}
          clampEngaged={false}
          isPastCandlesLoading={false}
          isExtending={false}
          live={LIVE}
        />,
      );

      const detailPanel = screen.getByRole('complementary', { name: 'Live Detail Panel' });
      expect(detailPanel).toHaveStyle({ width: '320px' });
      expect(useLiveLayoutStore.getState().rightPanelWidthPx).toBe(700);
    } finally {
      if (clientWidthDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidthDescriptor);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
      }
    }
  });

  it('clamps the rendered detail width when the workarea shrinks without overwriting the saved width', () => {
    useLiveLayoutStore.setState({
      rightPanelWidthPx: 500,
      rightCardWeights: DEFAULT_CARD_WEIGHTS,
    });

    render(
      <LiveWorkarea
        activeCode="005930"
        bundle={INDEX_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isExtending={false}
        live={LIVE}
      />,
    );

    const workarea = screen.getByTestId('live-workarea');
    Object.defineProperty(workarea, 'clientWidth', { configurable: true, value: 1200 });
    triggerResize(workarea, 1200);

    const detailPanel = screen.getByRole('complementary', { name: 'Live Detail Panel' });
    expect(detailPanel).toHaveStyle({ width: '500px' });

    triggerResize(workarea, 900);

    expect(detailPanel).toHaveStyle({ width: '320px' });
    expect(useLiveLayoutStore.getState().rightPanelWidthPx).toBe(500);
  });

  it('keeps the saved detail width when representative index charts hide the panel', () => {
    useLiveLayoutStore.setState({
      rightPanelWidthPx: 700,
      rightCardWeights: DEFAULT_CARD_WEIGHTS,
    });

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

    expect(screen.queryByRole('complementary', { name: 'Live Detail Panel' })).toBeNull();
    expect(useLiveLayoutStore.getState().rightPanelWidthPx).toBe(700);
  });

  it('hides the live detail panel for representative index charts', () => {
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
        onOpenIndicators={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('sidebar-stub')).toBeNull();
    expect(screen.queryByTestId('live-workarea-splitter')).toBeNull();
    expect(screen.getByTestId('live-chart-panel')).toBeInTheDocument();
  });

  it('renders the search-prompt empty state when no activeCode', () => {
    renderWorkarea(null);
    expect(screen.getByTestId('live-empty-state')).toBeInTheDocument();
  });

  it('keeps the empty-state workarea droppable for chart-entry drags', () => {
    renderWorkarea(null);

    const chartPanel = screen.getByTestId('live-chart-panel');
    mockRect(chartPanel, { left: 40, top: 20, right: 640, bottom: 420 });

    expect(isPointOnChart({ x: 60, y: 60 })).toBe(true);
    expect(isPointOnChart({ x: 20, y: 60 })).toBe(false);
    expect(isPointOnChart({ x: 60, y: 460 })).toBe(false);
  });

  it('hit-tests the full chart panel, including toolbar, but excludes splitter and detail panel', () => {
    render(
      <LiveWorkarea
        activeCode="005930"
        bundle={INDEX_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isExtending={false}
        live={LIVE}
        onOpenIndicators={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    const chartPanel = screen.getByTestId('live-chart-panel');
    mockRect(chartPanel, { left: 0, top: 0, right: 900, bottom: 600 });

    expect(isPointOnChart({ x: 80, y: 24 })).toBe(true);
    expect(isPointOnChart({ x: 320, y: 300 })).toBe(true);
    expect(isPointOnChart({ x: 902, y: 300 })).toBe(false);
    expect(isPointOnChart({ x: 1040, y: 300 })).toBe(false);
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
    expect(useIndexSectorRankingsMock).toHaveBeenCalledWith('20260618', true, null);
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

    expect(useIndexSectorRankingsMock).toHaveBeenCalledWith('20260618', true, null);
  });

  it('passes todayKst to refresh the same-day index sector ranking', () => {
    useLivePageStore.setState({ candleTimeframe: 'D' });
    render(
      <LiveWorkarea
        activeCode="index:KOSPI"
        activeInstrument={indexInstrument('KOSPI', 'KOSPI')}
        bundle={INDEX_BUNDLE_WITH_TODAY_CANDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isExtending={false}
        live={LIVE}
        todayKst="20260619"
      />,
    );

    expect(useIndexSectorRankingsMock).toHaveBeenCalledWith('20260619', true, '20260619');
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

    expect(useIndexSectorRankingsMock).toHaveBeenCalledWith(null, true, null);
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
    expect(useIndexSectorRankingsMock).toHaveBeenLastCalledWith('20260617', true, null);

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
    expect(useIndexSectorRankingsMock).toHaveBeenLastCalledWith('20260618', true, null);
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
    expect(useIndexSectorRankingsMock).toHaveBeenLastCalledWith('20260617', true, null);

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
    expect(useIndexSectorRankingsMock).toHaveBeenLastCalledWith('20260618', true, null);
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
    expect(useIndexSectorRankingsMock).toHaveBeenCalledWith(null, false, null);
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
      expect(useIndexSectorRankingsMock).toHaveBeenCalledWith(null, false, null);
      const chartProps = liveChartRootMock.mock.calls.at(-1)?.[0] as
        | { onCandleBasisHover?: unknown; onCandleBasisClick?: unknown }
        | undefined;
      expect(chartProps?.onCandleBasisHover).toBeUndefined();
      expect(chartProps?.onCandleBasisClick).toBeUndefined();
      unmount();
    }
  });
});
