import { expect, it } from 'vitest';
import type { InvestorDailyFlowResponse } from '../../api/investorDailyFlow';
import { buildIndexBundle } from '../../live/buildIndexBundle';
import { linkedInvestorPriceRange } from '../../live/investorPaneScale';
import { createVirtualAxis } from '../../util/virtualAxis';
import { projectInvestorNet } from './investorNet';
import { projectInvestorNetLine } from './investorNetLine';
import { buildInvestorCumulative } from './investorCumulative';
const dates = ['20261005', '20261006', '20261007', '20261008'];
const days = dates.map(date => Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T00:00:00Z`));
const axis = createVirtualAxis(days.map((t, i) => ({ date: dates[i], sessionOpenMs: t, sessionCloseMs: t + 23400000 })));
const base = buildIndexBundle({ indexId: 'KOSPI', from: dates[0], to: dates.at(-1)!, bucketMs: 86400000,
  candles: days.map(t_ms => ({ t_ms, open: 100, high: 110, low: 90, close: 105, volume: 10 })) });
const flow: InvestorDailyFlowResponse = { code: '005930', from: dates[0], to: dates.at(-1)!, source: 'kiwoom_ka10059',
  provider_scope: 'KRX', unit: 'qty_shares', trade_side: 'net', pagination: 'covered', unlocated_defect: false,
  pages_observed: 2, can_continue: false, observations: days.map((t_ms, i) => ({ date: dates[i], t_ms,
    foreign_net_shares: [50, null, 0, -4][i], institution_net_shares: [100, 5, 0, 7][i] })),
  data_warnings: [{ reason: 'duplicate_conflict', date: dates[1], subject: 'foreign', message: 'conflict' }] };
const bundle = { ...base, investorTradeSide: 'net' as const, institutionInvestorTradeSide: 'net' as const,
  investorDailyFlow: flow, investorPoints: days.map(t_ms => ({ t_ms, foreign_net: 999999, institution_net: 888888 })) };
it('daily bars and lines use strict independent subject nulls and zeros without tolerant table fallback', () => {
  expect(projectInvestorNet(bundle, axis, 'foreign').map(p => p.value)).toEqual([50, 0, -4]);
  expect(projectInvestorNet(bundle, axis, 'institution').map(p => p.value)).toEqual([100, 5, 0, 7]);
  const foreign = projectInvestorNetLine(bundle, axis, 'foreign');
  expect(foreign.map(p => 'value' in p ? p.value : null)).toEqual([50, null, 0, -4]);
  expect(foreign[0]).toHaveProperty('color', 'rgba(0,0,0,0)');
  expect(projectInvestorNetLine(bundle, axis, 'institution').map(p => 'value' in p ? p.value : null)).toEqual([100, 5, 0, 7]);
  expect(linkedInvestorPriceRange(bundle, axis, null)).toEqual({ from: -10.24, to: 106.24 });
});
it('pending canonical source stays empty while gross and legacy index sources retain their numeric input', () => {
  const pending = { ...bundle, investorDailyFlow: null };
  expect(projectInvestorNet(pending, axis, 'foreign')).toEqual([]);
  expect(projectInvestorNetLine(pending, axis, 'institution').every(p => !('value' in p))).toBe(true);
  expect(linkedInvestorPriceRange(pending, axis, null)).toBeNull();
  expect(projectInvestorNet({ ...pending, investorTradeSide: 'buy' }, axis, 'foreign').map(p => p.value)).toEqual([999999, 999999, 999999, 999999]);
  expect(projectInvestorNet({ ...bundle, investorDailyFlow: undefined }, axis, 'institution').map(p => p.value)).toEqual([888888, 888888, 888888, 888888]);
});

it('the same strict revision keeps cumulative subject conflicts independent and retains zero flows', () => {
  const candleDates = days.map((t_ms, i) => ({ date: dates[i], t_ms }));
  const values = (subject: 'foreign' | 'institution') => buildInvestorCumulative({ source: flow, candleDates, subject })
    .points.map(p => p.kind === 'value' ? p.shares : null);
  expect(values('foreign')).toEqual([0, null, null, null]);
  expect(values('institution')).toEqual([0, 5, 5, 12]);
});
