import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudyViewReference } from '../api/studyViews';

const {
  useRangeMock,
  useStudyPastCandlesMock,
  useStudyPastDailyCandlesMock,
} = vi.hoisted(() => ({
  useRangeMock: vi.fn(),
  useStudyPastCandlesMock: vi.fn(),
  useStudyPastDailyCandlesMock: vi.fn(),
}));

vi.mock('../api/range', () => ({
  useRange: useRangeMock,
}));

vi.mock('../api/studyPastCandles', () => ({
  useStudyPastCandles: useStudyPastCandlesMock,
  useStudyPastDailyCandles: useStudyPastDailyCandlesMock,
}));

import { useLivePageStore } from '../state/livePage';
import { useStudyReferenceBundle } from './useStudyReferenceBundle';

const save: StudyViewReference = {
  schema_version: 2,
  id: 'ref1',
  name: '복기',
  code: '005930',
  label: '삼성전자',
  timeframe: '5m',
  range: { from_date: '20260616', to_date: '20260618', from_ms: 1_000, to_ms: 2_000 },
  viewport: { right_edge_ms: 2_000, bar_span: 120, at_live_edge: false },
  memo: '',
  tags: [],
  created_at_ms: 1,
  updated_at_ms: 2,
};

describe('useStudyReferenceBundle', () => {
  beforeEach(() => {
    useRangeMock.mockReset();
    useStudyPastCandlesMock.mockReset();
    useStudyPastDailyCandlesMock.mockReset();
    useRangeMock.mockReturnValue({ data: null, isLoading: false, error: null });
    useStudyPastCandlesMock.mockReturnValue({ data: { candles: [], data_warnings: [] }, isLoading: false, error: null });
    useStudyPastDailyCandlesMock.mockReturnValue({ data: { candles: [], data_warnings: [] }, isLoading: false, error: null });
    useLivePageStore.setState({
      tradeVolumePocEnabled: true,
      volumeDistributionEnabled: true,
      volumeDistributionRangeCount: 12,
    });
  });

  it('requests volume distribution and trade-volume POC bins from /api/range using current live indicator settings', () => {
    renderHook(() => useStudyReferenceBundle(save));

    expect(useRangeMock).toHaveBeenCalledWith(
      '005930',
      '20260616',
      '20260618',
      '5m',
      undefined,
      null,
      {
        volumeDistributionBins: 12,
        tradeVolumePocBins: 12,
        volumeDistributionPriceRange: null,
      },
    );
  });

  it('omits trade-volume POC bins when the current live setting is disabled', () => {
    useLivePageStore.setState({ tradeVolumePocEnabled: false });

    renderHook(() => useStudyReferenceBundle(save));

    expect(useRangeMock.mock.calls[0][6]).toMatchObject({ tradeVolumePocBins: null });
  });

  it('omits volume distribution bins when the current live setting is disabled', () => {
    useLivePageStore.setState({ volumeDistributionEnabled: false });

    renderHook(() => useStudyReferenceBundle(save));

    expect(useRangeMock.mock.calls[0][6]).toMatchObject({ volumeDistributionBins: null });
  });
});
