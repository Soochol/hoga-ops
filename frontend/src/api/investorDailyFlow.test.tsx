import { expect, it } from 'vitest';
import { parseInvestorDailyFlow, type InvestorDailyFlowResponse } from './investorDailyFlow';
const scope = { code: '005930', from: '20260105', to: '20260106' };
const response: InvestorDailyFlowResponse = { ...scope, source: 'kiwoom_ka10059', provider_scope: 'KRX',
  unit: 'qty_shares', trade_side: 'net', observations: [{ date: scope.from, t_ms: Date.UTC(2026, 0, 5),
    foreign_net_shares: null, institution_net_shares: 0 }], pagination: 'covered', unlocated_defect: false,
  pages_observed: 1, can_continue: false, data_warnings: [] };
it('preserves independent unknown and literal zero observations', () => {
  expect(parseInvestorDailyFlow(response, scope).observations[0]).toMatchObject({ foreign_net_shares: null, institution_net_shares: 0 });
});
it.each([
  { code: '000660' }, { from: '20260102' }, { to: '20260107' }, { source: 'other' },
  { provider_scope: 'other' }, { unit: 'amt_mwon' }, { trade_side: 'buy' }, { pages_observed: -1 },
  { observations: [{ ...response.observations[0], foreign_net_shares: Number.MAX_SAFE_INTEGER + 1 }] },
  { observations: [{ ...response.observations[0], t_ms: 0 }] },
  { observations: [{ ...response.observations[0], date: '20260230' }] },
  { observations: [{ ...response.observations[0], institution_net_shares: undefined }] },
])('rejects incompatible or malformed strict data %j', overrides => {
  expect(() => parseInvestorDailyFlow({ ...response, ...overrides }, scope)).toThrow();
});
