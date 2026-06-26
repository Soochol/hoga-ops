import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import type { ComponentProps } from 'react';
import type { StudyViewReference } from '../api/studyViews';
import type { RangeBundle } from '../api/types';
import type { LiveChartRoot } from '../live/LiveChartRoot';
import { useStudyTabsStore } from '../state/studyTabs';
import { useEntryDragStore } from '../state/entryDrag';

const {
  useStudyViewsMock,
  useStudyViewMutationsMock,
  useStudyReferenceBundleMock,
  liveChartRootMock,
} = vi.hoisted(() => ({
  useStudyViewsMock: vi.fn(),
  useStudyViewMutationsMock: vi.fn(),
  useStudyReferenceBundleMock: vi.fn(),
  liveChartRootMock: vi.fn(),
}));

vi.mock('./useStudyViews', () => ({
  useStudyViews: useStudyViewsMock,
  useStudyViewMutations: useStudyViewMutationsMock,
}));

vi.mock('./useStudyReferenceBundle', () => ({
  useStudyReferenceBundle: useStudyReferenceBundleMock,
}));

vi.mock('../live/LiveChartRoot', () => ({
  LiveChartRoot: (props: ComponentProps<typeof LiveChartRoot>) => {
    liveChartRootMock(props);
    return <div data-testid="live-chart-root-stub" />;
  },
}));

import { StudyPage } from './StudyPage';

const referenceSave: StudyViewReference = {
  schema_version: 2,
  id: 'view-ref',
  name: '돌파 복기',
  code: '005930',
  label: '삼성전자',
  timeframe: '5m',
  range: { from_date: '20260616', to_date: '20260616', from_ms: 1_000, to_ms: 2_000 },
  viewport: { right_edge_ms: 2_000, bar_span: 120, at_live_edge: false },
  memo: 'memo',
  tags: [],
  created_at_ms: 1,
  updated_at_ms: 2,
};

function bundle(): RangeBundle {
  return {
    code: '005930',
    from_date: '20260616',
    to_date: '20260616',
    bucket_ms: 300_000,
    segments: [{ date: '20260616', session_open_ms: 1_000, session_close_ms: 2_000 }],
    candles: [
      { ts_ms: 1_000, open: 1, high: 2, low: 1, close: 2, vol_a: 10, vol_b: 0 },
      { ts_ms: 2_000, open: 2, high: 3, low: 2, close: 3, vol_a: 11, vol_b: 0 },
    ],
    quote_ratio: {
      bucket_ms: 300_000,
      points: [{ t: 1_000, bid_total: 100, ask_total: 90, bid_max: 0, ask_max: 0, imb_max_bid: 0, imb_max_ask: 0 }],
    },
    fill_strength: { bucket_ms: 300_000, points: [{ t: 1_000, buy_qty: 5, sell_qty: 4 }] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    volume_distributions: [],
    investorPoints: [],
    ask_peaks: [],
    bid_peaks: [],
    broker_late_entries: [],
    trade_volume_pocs: [{
      date: '20260616',
      center_price: 70_000,
      low_price: 69_500,
      high_price: 70_500,
      qty: 12_345,
      t_ms: 1_000,
      band_pct: 0.0025,
    }],
  };
}

function renderPage(initialEntry = '/study') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <StudyPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  liveChartRootMock.mockClear();
  useStudyViewsMock.mockReturnValue({
    data: { schema_version: 1, saves: [referenceSave] },
    isLoading: false,
    isError: false,
  });
  useStudyViewMutationsMock.mockReturnValue({
    updateMetadata: { mutate: vi.fn(), isPending: false },
  });
  useStudyReferenceBundleMock.mockReturnValue({
    bundle: bundle(),
    chartBundle: bundle(),
    isLoading: false,
    error: null,
    pastDataWarnings: [],
  });
  useStudyTabsStore.setState({ tabs: [], activeTabId: null });
  useEntryDragStore.setState({ draggingCode: null, overStudy: false });
});

describe('StudyPage', () => {
  it('renders an empty state without a selected view', () => {
    renderPage();

    expect(screen.getByTestId('study-page-empty')).toBeTruthy();
    expect(screen.getByText('저장된 학습뷰를 선택하세요.')).toBeTruthy();
  });

  it('renders a v2 reference view from raw range data without snapshot overrides', () => {
    renderPage('/study?view=view-ref');

    expect(screen.getByTestId('live-chart-root-stub')).toBeTruthy();
    expect(useStudyReferenceBundleMock).toHaveBeenCalledWith(referenceSave);
    const props = liveChartRootMock.mock.calls[0][0];
    expect(props.code).toBe('005930');
    expect(props.timeframe).toBe('5m');
    expect(props.restoreViewport).toEqual({ rightEdgeMs: 2_000, barSpan: 120, atLiveEdge: false });
    expect(props.todayKst).toBe('20260616');
    expect(props.tradeVolumePocs).toHaveLength(1);
    expect(props.paneTogglesOverride).toBeUndefined();
    expect(props.dailyMovingAverageOverride).toBeUndefined();
    expect(props.tradeVolumePocOverride).toBeUndefined();
  });

  it('shows loading while the reference bundle is loading', () => {
    useStudyReferenceBundleMock.mockReturnValue({
      bundle: null,
      chartBundle: null,
      isLoading: true,
      error: null,
      pastDataWarnings: [],
    });

    renderPage('/study?view=view-ref');

    expect(screen.getByTestId('study-page-loading')).toBeTruthy();
    expect(screen.getByText('학습뷰 불러오는 중...')).toBeTruthy();
  });

  it('returns to the empty state when the selected view is missing', () => {
    renderPage('/study?view=missing');

    expect(screen.getByTestId('study-page-empty')).toBeTruthy();
    expect(screen.getByText('저장된 학습뷰를 선택하세요.')).toBeTruthy();
  });
});
