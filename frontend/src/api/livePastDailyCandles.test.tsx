import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchPastDailyCandles, type LivePastDailyCandlesResponse } from './livePastDailyCandles';
import * as client from './client';

const RESPONSE: LivePastDailyCandlesResponse = {
  code: '005930',
  from: '20240101',
  to: '20240105',
  candles: [{ t_ms: 1, open: 100, high: 110, low: 95, close: 105, volume: 10 }],
  cached_batches: [],
  fresh_batches: ['20240101__20240105'],
  data_warnings: [],
};

describe('fetchPastDailyCandles', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('builds the past-daily-candles URL with code/from/to and returns the parsed body', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const res = await fetchPastDailyCandles('005930', '20240101', '20240105');
    expect(res.candles).toHaveLength(1);
    expect(spy).toHaveBeenCalledWith(
      '/api/live/past-daily-candles?code=005930&from=20240101&to=20240105',
    );
  });
});
