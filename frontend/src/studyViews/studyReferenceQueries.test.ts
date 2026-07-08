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
  sourcePref: 'hogaplay_first' as const,
  brokerLateEntryEnabled: true,
  brokerLateEntryStartHHMM: 1000,
  volumeDistributionEnabled: true,
  tradeVolumePocEnabled: true,
  volumeDistributionRangeCount: 12,
};

describe('studyReferenceQueryOptions', () => {
  it('builds disk candle (mode=candles, hogaplay_first fixed) options for minute study views', () => {
    const options = studyReferenceQueryOptions(save, settings);

    expect(options.rangeHoga.enabled).toBe(true);
    expect(options.rangeHoga.queryKey[0]).toBe('range');
    expect(options.rangeHoga.queryKey[14]).toBe('hoga');
    expect(options.rangeSidecars.enabled).toBe(true);
    expect(options.rangeSidecars.queryKey[14]).toBe('sidecar');
    expect(options.rangeSidecars.queryKey).toContain(true);
    expect(options.rangeSidecars.queryKey).toContain(1000);
    // 캔들: mode=candles + sourcePref 'hogaplay_first' 고정 + 저장 타임프레임(5m 버킷).
    expect(options.rangeCandles.enabled).toBe(true);
    expect(options.rangeCandles.queryKey[0]).toBe('range');
    expect(options.rangeCandles.queryKey[1]).toBe('005930');
    expect(options.rangeCandles.queryKey[2]).toBe('20260616');
    expect(options.rangeCandles.queryKey[3]).toBe('20260618');
    expect(options.rangeCandles.queryKey[4]).toBe(300_000);
    expect(options.rangeCandles.queryKey[13]).toBe('hogaplay_first');
    expect(options.rangeCandles.queryKey[14]).toBe('candles');
    // 스크리너 일봉은 분봉 저장에서 비활성.
    expect(options.screenerDaily.enabled).toBe(false);
  });

  it('keeps the candle source pinned to hogaplay_first even when store pref is kis_ws_first', () => {
    const options = studyReferenceQueryOptions(save, { ...settings, sourcePref: 'kis_ws_first' });
    // 지표(hoga/sidecar)는 store pref를 따르지만, 캔들은 항상 hogaplay_first.
    expect(options.rangeHoga.queryKey[13]).toBe('kis_ws_first');
    expect(options.rangeCandles.queryKey[13]).toBe('hogaplay_first');
  });

  it('requests no broker late-entry sidecars when the indicator is disabled', () => {
    const options = studyReferenceQueryOptions(save, {
      ...settings,
      brokerLateEntryEnabled: false,
    });

    expect(options.rangeSidecars.queryKey).toContain(false);
    expect(options.rangeSidecars.queryKey).not.toContain(1000);
  });

  it('requests 1m disk candles + screener daily gap-fill for daily study views', () => {
    const options = studyReferenceQueryOptions({ ...save, timeframe: 'D' }, settings);

    expect(options.rangeHoga.enabled).toBe(false);
    expect(options.rangeSidecars.enabled).toBe(false);
    // 캔들은 1m으로 요청(프론트에서 캘린더 집계), mode=candles, hogaplay 고정.
    expect(options.rangeCandles.enabled).toBe(true);
    expect(options.rangeCandles.queryKey[4]).toBe(60_000);
    expect(options.rangeCandles.queryKey[13]).toBe('hogaplay_first');
    expect(options.rangeCandles.queryKey[14]).toBe('candles');
    // 스크리너 일봉은 저장 구간 전체를 커버(갭 채움).
    expect(options.screenerDaily.enabled).toBe(true);
    expect(options.screenerDaily.queryKey).toEqual([
      'live', 'screener-daily-candles', '005930', '20260616', '20260618',
    ]);
  });
});
