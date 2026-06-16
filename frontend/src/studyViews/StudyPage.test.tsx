import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ComponentProps } from 'react';
import type { ParquetStudySnapshot } from '../api/studyViews';
import type { LiveChartRoot } from '../live/LiveChartRoot';

const { useStudyViewSnapshotMock, liveChartRootMock, useLiveBundleMock, useRangeMock } = vi.hoisted(() => ({
  useStudyViewSnapshotMock: vi.fn(),
  liveChartRootMock: vi.fn(),
  useLiveBundleMock: vi.fn(),
  useRangeMock: vi.fn(),
}));

vi.mock('./useStudyViews', () => ({
  useStudyViewSnapshot: useStudyViewSnapshotMock,
}));

vi.mock('../live/LiveChartRoot', () => ({
  LiveChartRoot: (props: ComponentProps<typeof LiveChartRoot>) => {
    liveChartRootMock(props);
    return <div data-testid="live-chart-root-stub" />;
  },
}));

vi.mock('../live/useLiveBundle', () => ({
  useLiveBundle: useLiveBundleMock,
}));

vi.mock('../api/range', () => ({
  useRange: useRangeMock,
}));

import { StudyPage } from './StudyPage';
import { useLiveBundle } from '../live/useLiveBundle';
import { useRange } from '../api/range';

const snapshot: ParquetStudySnapshot = {
  schema_version: 1,
  code: '005930',
  label: '삼성전자',
  timeframe: 'D',
  snapshot_from_ms: 1_000,
  snapshot_to_ms: 2_000,
  bucket_kind: 'D',
  viewport: { right_edge_ms: 2_000, bar_span: 120, at_live_edge: false },
  indicator_state: {
    volume_enabled: false,
    quote_totals_enabled: true,
    ratio_enabled: false,
    fill_strength_enabled: true,
    aggregation_basis: 'close',
    auction_window_mask: true,
    ratio_outlier_filter_enabled: true,
    ratio_outlier_threshold: 50,
  },
  provenance: { saved_from_route: '/live', data_provenance: 'live_mixed' },
  bundle: {
    code: '005930',
    timeframe: 'D',
    snapshot_from_ms: 1_000,
    snapshot_to_ms: 2_000,
    segments: [{ date: '20260616', session_open_ms: 1_000, session_close_ms: 2_000 }],
    candles: [{ t: 1_000, open: 70_000, high: 72_000, low: 69_000, close: 71_000, volume: 100 }],
    quote_totals: [{ t: 1_000, bid_total: 100, ask_total: 120, visible: true }],
    ratio: [{ t: 1_000, value: -49, visible: true }],
    fill_strength: [{ t: 1_000, buy_qty: 30, sell_qty: 20, visible: true }],
    data_warnings: [],
  },
  captured_at_ms: 3_000,
};

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <StudyPage />
    </MemoryRouter>,
  );
}

describe('StudyPage', () => {
  beforeEach(() => {
    useStudyViewSnapshotMock.mockReset();
    liveChartRootMock.mockReset();
    useLiveBundleMock.mockReset();
    useRangeMock.mockReset();
  });

  it('renders a saved snapshot from /study?view=view1 without live or range hooks', () => {
    useStudyViewSnapshotMock.mockReturnValue({
      data: snapshot,
      isLoading: false,
      isError: false,
    });

    renderAt('/study?view=view1');

    expect(screen.getByTestId('study-page')).toBeTruthy();
    expect(screen.getByText('삼성전자')).toBeTruthy();
    expect(screen.getByTestId('live-chart-root-stub')).toBeTruthy();
    expect(useStudyViewSnapshotMock).toHaveBeenCalledWith('view1');
    expect(useLiveBundle).not.toHaveBeenCalled();
    expect(useRange).not.toHaveBeenCalled();

    const props = liveChartRootMock.mock.calls[0][0] as ComponentProps<typeof LiveChartRoot>;
    expect(props).toMatchObject({
      code: '005930',
      timeframe: 'D',
      viewIdentity: 'view1',
      clampEngaged: false,
      isPastCandlesLoading: false,
      isExtending: false,
      pastDataWarnings: [],
      restoreViewport: { rightEdgeMs: 2_000, barSpan: 120, atLiveEdge: false },
      dayAskPeaks: [],
      forceHogaPanes: true,
      paneTogglesOverride: {
        volumeEnabled: false,
        quoteTotalsEnabled: true,
        ratioEnabled: false,
        fillStrengthEnabled: true,
      },
      persistLiveViewport: false,
    });
    expect(props.bundle).toBe(props.chartBundle);
    expect(props.bundle).toMatchObject({
      code: '005930',
      from_date: '20260616',
      to_date: '20260616',
      study_ratio: { points: [{ t: 1_000, value: -49 }] },
    });
  });

  it('renders an empty state without a view param', () => {
    useStudyViewSnapshotMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    });

    renderAt('/study');

    expect(screen.getByTestId('study-page-empty')).toBeTruthy();
    expect(screen.getByText('저장된 학습뷰를 선택하세요.')).toBeTruthy();
    expect(useStudyViewSnapshotMock).toHaveBeenCalledWith(null);
    expect(liveChartRootMock).not.toHaveBeenCalled();
    expect(useLiveBundle).not.toHaveBeenCalled();
    expect(useRange).not.toHaveBeenCalled();
  });
});
