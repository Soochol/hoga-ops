import { describe, it, expect } from 'vitest';
import { investorDailySummary, formatInvestorK } from './investorDailySummary';
import type { LivePastInvestorNetResponse } from '../api/livePastInvestorNet';

const data: LivePastInvestorNetResponse = {
  code: '005930', from: '20260914', to: '20260915', unit: 'qty_shares', trade_side: 'buy',
  points: [
    { t_ms: Date.UTC(2026, 8, 15), foreign_net: 200, institution_net: 300 },
    { t_ms: Date.UTC(2026, 8, 14), foreign_net: 100, institution_net: 400 },
  ], cached_batches: [], fresh_batches: [], data_warnings: [],
};
describe('summary date and unit alignment', () => {
  it('joins by date rather than response order and totals only displayed days', () => {
    const s = investorDailySummary(data, '005930', 'qty_shares', 'buy', ['20260914']);
    expect(s.value('20260914', 'foreign')).toBe(100);
    expect(s.total('foreign')).toBe(100);
    expect(s.value('20260913', 'foreign')).toBeNull();
  });
  it('rejects placeholder data for another code, unit, or trade side', () => {
    expect(investorDailySummary(data, '000660', 'qty_shares', 'buy', ['20260914']).total('foreign')).toBeNull();
    expect(investorDailySummary(data, '005930', 'amt_mwon', 'buy', ['20260914']).total('foreign')).toBeNull();
    expect(investorDailySummary(data, '005930', 'qty_shares', 'sell', ['20260914']).total('foreign')).toBeNull();
  });
  it('does not present incomplete days or missing breakdown as a full total', () => {
    const s = investorDailySummary(data, '005930', 'qty_shares', 'buy', ['20260913', '20260914']);
    expect(s.total('foreign')).toBeNull();
    expect(s.total('individual')).toBeNull();
  });
});
it('K formatting uses whole thousands and distinguishes zero from sub-1K quantities', () => {
  expect(formatInvestorK(85200, true)).toBe('+85K');
  expect(formatInvestorK(85000)).toBe('85K');
  expect(formatInvestorK(85600)).toBe('86K');
  expect(formatInvestorK(0, true)).toBe('0K');
  expect(formatInvestorK(1, true)).toBe('+<1K');
  expect(formatInvestorK(-999, true)).toBe('−<1K');
  expect(formatInvestorK(-1000, true)).toBe('−1K');
});
