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
  brokerLateEntryEnabled: true,
  brokerLateEntryStartHHMM: 1000,
  volumeDistributionEnabled: true,
  tradeVolumePocEnabled: true,
  depthHeatmapEnabled: true,
  volumeDistributionRangeCount: 12,
};

describe('studyReferenceQueryOptions', () => {
  it('builds split range and minute candle options for minute study views', () => {
    const options = studyReferenceQueryOptions(save, settings);

    expect(options.rangeHoga.enabled).toBe(true);
    expect(options.rangeHoga.queryKey[0]).toBe('range');
    expect(options.rangeHoga.queryKey[14]).toBe('hoga');
    expect(options.rangeSidecars.enabled).toBe(true);
    expect(options.rangeSidecars.queryKey[0]).toBe('range');
    expect(options.rangeSidecars.queryKey[14]).toBe('sidecar');
    expect(options.rangeSidecars.queryKey).toContain(true);
    expect(options.rangeSidecars.queryKey).toContain(1000);
    expect(options.minuteCandles.enabled).toBe(true);
    expect(options.minuteCandles.queryKey).toEqual(['study', 'past-candles', '005930', '20260616', '20260618', 'KRX']);
    expect(options.dailyCandles.enabled).toBe(false);
    // depthHeatmapEnabled은 마지막 queryKey 슬롯(20)으로 사이드카에 실려 refetch를 가른다.
    expect(options.rangeSidecars.queryKey[20]).toBe(true);
  });

  it('depthHeatmapEnabled=false면 사이드카 queryKey 슬롯 20이 false로 전송된다', () => {
    const options = studyReferenceQueryOptions(save, {
      ...settings,
      depthHeatmapEnabled: false,
    });

    expect(options.rangeSidecars.queryKey[20]).toBe(false);
  });

  it('requests no broker late-entry sidecars when the indicator is disabled', () => {
    const options = studyReferenceQueryOptions(save, {
      ...settings,
      brokerLateEntryEnabled: false,
    });

    expect(options.rangeSidecars.queryKey).toContain(false);
    expect(options.rangeSidecars.queryKey).not.toContain(1000);
  });

  it('builds daily candle options and disables range for daily study views', () => {
    const options = studyReferenceQueryOptions({ ...save, timeframe: 'D' }, settings);

    expect(options.rangeHoga.enabled).toBe(false);
    expect(options.rangeSidecars.enabled).toBe(false);
    expect(options.minuteCandles.enabled).toBe(false);
    expect(options.dailyCandles.enabled).toBe(true);
    expect(options.dailyCandles.queryKey).toEqual(['study', 'past-daily-candles', '005930', '20260616', '20260618', 'KRX']);
  });
});
