import { describe, expect, it } from 'vitest';
import type { StudyViewReference } from '../api/studyViews';
import { studyReferenceQueryOptions } from './studyReferenceQueries';

const save: StudyViewReference = {
  schema_version: 2,
  id: 'view-ref',
  name: '돌파 복기',
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

const settings = {
  venue: 'KRX' as const,
  sourcePref: 'hogaplay_first' as const,
  volumeDistributionEnabled: true,
  tradeVolumePocEnabled: true,
  volumeDistributionRangeCount: 12,
};

describe('studyReferenceQueryOptions', () => {
  it('builds range and minute candle options for minute study views', () => {
    const options = studyReferenceQueryOptions(save, settings);

    expect(options.range.enabled).toBe(true);
    expect(options.range.queryKey[0]).toBe('range');
    expect(options.minuteCandles.enabled).toBe(true);
    expect(options.minuteCandles.queryKey).toEqual(['study', 'past-candles', '005930', '20260616', '20260618', 'KRX']);
    expect(options.dailyCandles.enabled).toBe(false);
  });

  it('builds daily candle options and disables range for daily study views', () => {
    const options = studyReferenceQueryOptions({ ...save, timeframe: 'D' }, settings);

    expect(options.range.enabled).toBe(false);
    expect(options.minuteCandles.enabled).toBe(false);
    expect(options.dailyCandles.enabled).toBe(true);
    expect(options.dailyCandles.queryKey).toEqual(['study', 'past-daily-candles', '005930', '20260616', '20260618', 'KRX']);
  });
});
