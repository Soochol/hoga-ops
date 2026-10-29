import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiCall } from '../api/client';
import { loadReviewCaptureData, reviewCandles, reviewFlow } from './reviewCaptureData';
import type { InvestorFlowResponse } from '../api/market';
import type { ReviewCaptureContext } from './reviewCaptureTypes';

vi.mock('../api/client', () => ({ apiCall: vi.fn() }));
const at = (day: string, time = '09:00') => new Date(`${day}T${time}:00+09:00`).getTime();
const candle = (day: string) => ({ t_ms: at(day), open: 100, high: 120, low: 90, close: 110, volume: 500 });
const context: ReviewCaptureContext = { name: '삼성전자', venue: 'KRX', dates: ['20260527', '20260528'], fromMs: at('2026-05-27'), toMs: at('2026-05-28') };
const flow = (): InvestorFlowResponse => ({ date: '20260529', daily: [{ date: '20260528', markets: {
  KOSPI: { foreign: 0, institution: 100, individual: -100 },
} }], unit: 'amt_eok', confirmed: false, markets: { KOSPI: [{ t_ms: at('2026-05-29'), foreign: 999, institution: 999, individual: 999 }] },
coverage: {}, session_start_sec: 32400, session_end_sec: 59400 });

beforeEach(() => vi.clearAllMocks());

describe('review snapshot data', () => {
  it('uses exact-date confirmed flow, preserves zero, and never substitutes today for a missing past date', () => {
    const result = reviewFlow(flow(), '20260528');
    expect(result.markets.KOSPI).toEqual({ foreign: 0, institution: 100, individual: -100, basis: '확정치' });
    expect(result.markets.KOSDAQ).toEqual({ foreign: null, institution: null, individual: null, basis: '자료 없음' });
    expect(reviewFlow(flow(), '20260527').markets.KOSPI.foreign).toBeNull();
  });
  it('keeps each markets own latest sample time and treats unknown units as missing', () => {
    const data = flow();
    data.markets.KOSDAQ = [{ t_ms: at('2026-05-29', '10:15'), foreign: null, institution: 0, individual: 20 }];
    const result = reviewFlow(data, '20260529');
    expect(result.markets.KOSDAQ).toEqual({ foreign: null, institution: 0, individual: 20, basis: '잠정 · 10:15 KST' });
    expect(reviewFlow({ ...data, unit: 'unknown' }, '20260529').markets.KOSPI.foreign).toBeNull();
  });
  it('filters wrong-date and invalid candles, and sorts/deduplicates the real observations', () => {
    const good = candle('2026-05-28');
    expect(reviewCandles([good, candle('2026-05-29'), { ...good, high: 80 }, { ...good, t_ms: NaN }, good], '20260528', '20260528')).toEqual([good]);
  });
  it('requests both indices on the last visible trading day and keeps the stock venue and 60 actual daily bars', async () => {
    const daily = Array.from({ length: 90 }, (_, i) => ({ ...candle('2026-05-28'), t_ms: at('2026-05-28') - i * 86400000 }));
    vi.mocked(apiCall).mockImplementation(async path => {
      if (path === '/api/live/settings') return { rest_bypass_enabled: false };
      if (path.includes('index-candles')) return { index_id: path.includes('KOSPI') ? 'KOSPI' : 'KOSDAQ', timeframe: '5m', candles: [candle('2026-05-28'), candle('2026-05-29')], data_warnings: [] };
      if (path.includes('past-daily-candles')) return { code: '005930', venue: 'UN', candles: daily, data_warnings: [] };
      return flow();
    });
    const result = await loadReviewCaptureData('005930', { ...context, venue: 'UN' });
    expect(result.date).toBe('20260528');
    expect(result.kospi.candles).toEqual([candle('2026-05-28')]);
    expect(result.daily.candles).toHaveLength(60);
    expect(result.daily.candles.at(-1)?.t_ms).toBe(at('2026-05-28'));
    const paths = vi.mocked(apiCall).mock.calls.map(call => call[0]);
    expect(paths).toContain('/api/live/index-candles?index_id=KOSDAQ&timeframe=5m&from=20260528&to=20260528');
    expect(paths.find(path => path.includes('past-daily-candles'))).toContain('venue=UN');
  });
  it('keeps failures separate from empty results without discarding the other sections', async () => {
    vi.mocked(apiCall).mockImplementation(async path => {
      if (path.includes('KOSPI')) throw new Error('network');
      if (path.includes('KOSDAQ')) return { index_id: 'KOSDAQ', timeframe: '5m', candles: [], data_warnings: [] };
      if (path.includes('settings')) return { rest_bypass_enabled: false };
      if (path.includes('daily-candles')) return { code: '005930', candles: [candle('2026-05-28')], data_warnings: [] };
      return flow();
    });
    const result = await loadReviewCaptureData('005930', context);
    expect(result.kospi.message).toContain('조회 실패');
    expect(result.kosdaq.message).toBe('자료 없음');
    expect(result.daily.candles).toHaveLength(1);
    expect(result.flow.markets.KOSPI.foreign).toBe(0);
  });
  it('honors REST bypass and never fetches KRX disk daily bars as UN prices', async () => {
    vi.mocked(apiCall).mockImplementation(async path => {
      if (path.includes('settings')) return { rest_bypass_enabled: true };
      if (path.includes('index-candles')) return { index_id: path.includes('KOSPI') ? 'KOSPI' : 'KOSDAQ', timeframe: '5m', candles: [], data_warnings: [] };
      return flow();
    });
    const result = await loadReviewCaptureData('005930', { ...context, venue: 'UN' });
    expect(result.daily.message).toContain('REST 우회');
    expect(vi.mocked(apiCall).mock.calls.some(([path]) => path.includes('daily-candles'))).toBe(false);
  });
});
