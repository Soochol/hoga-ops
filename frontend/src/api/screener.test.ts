import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('./client', () => ({ apiCall: vi.fn(async () => ({ status: 'ok', rows: [] })) }));
import { runScreener } from './screener';
import { apiCall } from './client';

describe('runScreener', () => {
  beforeEach(() => vi.clearAllMocks());

  it('encodes the new-high filter pair and trade value', async () => {
    await runScreener({ newHigh: { lookback: 200, period: 500 }, minTradeValueEok: 50 });
    const url = (apiCall as any).mock.calls[0][0] as string;
    expect(url).toContain('nh_lookback=200');
    expect(url).toContain('nh_period=500');
    expect(url).toContain('min_trade_value_eok=50');
  });

  it('repeats markets and sets exclude_etf', async () => {
    await runScreener({ markets: ['KOSPI', 'KOSDAQ'], excludeEtf: true });
    const url = (apiCall as any).mock.calls[0][0] as string;
    expect((url.match(/markets=/g) || []).length).toBe(2);
    expect(url).toContain('exclude_etf=true');
  });
});
