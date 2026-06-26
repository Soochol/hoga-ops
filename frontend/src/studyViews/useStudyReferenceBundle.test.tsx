import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseQueryOptions, UseQueryResult } from '@tanstack/react-query';
import type { StudyViewReference } from '../api/studyViews';

const {
  useQueryMock,
  studyReferenceQueryOptionsMock,
} = vi.hoisted(() => ({
  useQueryMock: vi.fn(),
  studyReferenceQueryOptionsMock: vi.fn(),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: useQueryMock,
  };
});

vi.mock('./studyReferenceQueries', () => ({
  studyReferenceQueryOptions: studyReferenceQueryOptionsMock,
}));

import { useLivePageStore } from '../state/livePage';
import { useLiveVenueStore } from '../state/liveVenue';
import { useSourcePreferenceStore } from '../state/sourcePreference';
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

const rangeOptions = { queryKey: ['range-plan'], enabled: true } as unknown as UseQueryOptions;
const minuteOptions = { queryKey: ['minute-plan'], enabled: true } as unknown as UseQueryOptions;
const dailyOptions = { queryKey: ['daily-plan'], enabled: false } as unknown as UseQueryOptions;

function queryResultFor(options: UseQueryOptions): Partial<UseQueryResult> {
  if (options === minuteOptions) {
    return {
      data: { candles: [], data_warnings: ['minute-warning'] },
      isLoading: false,
      error: null,
    };
  }
  if (options === dailyOptions) {
    return {
      data: { candles: [], data_warnings: ['daily-warning'] },
      isLoading: false,
      error: null,
    };
  }
  return { data: null, isLoading: false, error: null };
}

describe('useStudyReferenceBundle', () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    studyReferenceQueryOptionsMock.mockReset();
    studyReferenceQueryOptionsMock.mockReturnValue({
      range: rangeOptions,
      minuteCandles: minuteOptions,
      dailyCandles: dailyOptions,
    });
    useQueryMock.mockImplementation(queryResultFor);
    useLiveVenueStore.setState({ venue: 'NXT' });
    useSourcePreferenceStore.setState({ sourcePreference: 'kis_api_first' });
    useLivePageStore.setState({
      tradeVolumePocEnabled: true,
      volumeDistributionEnabled: true,
      volumeDistributionRangeCount: 12,
    });
  });

  it('uses the shared study reference query plan for the active 복기뷰', () => {
    renderHook(() => useStudyReferenceBundle(save));

    expect(studyReferenceQueryOptionsMock).toHaveBeenCalledWith(save, {
      venue: 'NXT',
      sourcePref: 'kis_api_first',
      tradeVolumePocEnabled: true,
      volumeDistributionEnabled: true,
      volumeDistributionRangeCount: 12,
    });
    expect(useQueryMock).toHaveBeenNthCalledWith(1, rangeOptions);
    expect(useQueryMock).toHaveBeenNthCalledWith(2, minuteOptions);
    expect(useQueryMock).toHaveBeenNthCalledWith(3, dailyOptions);
  });
});
