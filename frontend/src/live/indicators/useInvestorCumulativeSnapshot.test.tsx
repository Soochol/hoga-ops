import { renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { DailyFlowRequestScope, InvestorDailyFlowResponse } from '../../api/investorDailyFlow';
import { projectInvestorCumulative } from '../../chart/projectors/investorCumulative';
import { FACTORY_INDICATOR_SETTINGS } from '../../state/indicatorSettingsV2';
import { buildPriceBundle } from '../buildIndexBundle';
import { createVirtualAxis } from '../../util/virtualAxis';
import { useInvestorCumulativeSnapshot } from './useInvestorCumulativeSnapshot';

type Input = Parameters<typeof useInvestorCumulativeSnapshot>[0];
const dates = ['20260105', '20260106', '20260107'];
const ms = (date: string) => Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T00:00:00Z`);
const candleDates = dates.map(date => ({ date, t_ms: ms(date) }));
const expanded = { code: '005930', from: dates[0], to: dates[2] };
const original = { ...expanded, from: dates[1] };
function response(scope: DailyFlowRequestScope): InvestorDailyFlowResponse {
  return { ...scope, source: 'kiwoom_ka10059', provider_scope: 'KRX', unit: 'qty_shares', trade_side: 'net',
    observations: candleDates.filter(point => point.date >= scope.from).map(point => ({ ...point,
      institution_net_shares: point.date === dates[0] ? 5 : point.date === dates[1] ? 10 : 20, foreign_net_shares: -10 })),
    pagination: 'covered', unlocated_defect: false, pages_observed: 7, can_continue: false, data_warnings: [] };
}
const input = (scope: DailyFlowRequestScope, source: InvestorDailyFlowResponse | undefined): Input => ({ scope, source, subject: 'institution', candleDates });
const shares = (snapshot: ReturnType<typeof useInvestorCumulativeSnapshot>) => snapshot.points.map(p => p.kind === 'value' ? p.shares : null);

it('retains the old baseline during expansion, leaves older candles blank, and rebases once complete', () => {
  const { result, rerender } = renderHook(useInvestorCumulativeSnapshot, { initialProps: input(original, response(original)) });
  expect(shares(result.current)).toEqual([0, 20]);
  rerender(input(expanded, undefined));
  expect(result.current).toMatchObject({ kind: 'anchored', anchorDate: dates[1] });
  expect(shares(result.current)).toEqual([0, 20]);
  const bundle = buildPriceBundle({ code: original.code, from: expanded.from, to: expanded.to, bucketMs: 86400000,
    candles: candleDates.map(point => ({ t_ms: point.t_ms, open: 100, high: 110, low: 90, close: 105, volume: 10 })) });
  const axis = createVirtualAxis(candleDates.map(p => ({ date: p.date, sessionOpenMs: p.t_ms, sessionCloseMs: p.t_ms + 23400000 })));
  expect(projectInvestorCumulative(bundle, axis, { settings: FACTORY_INDICATOR_SETTINGS, snapshot: result.current })
    .map(p => 'value' in p ? p.value : null)).toEqual([null, 0, 20]);
  const partial = { ...response(expanded), pagination: 'incomplete' as const, can_continue: true };
  rerender(input(expanded, partial));
  expect(shares(result.current)).toEqual([0, 20]);
  rerender(input(expanded, { ...partial, observations: partial.observations.slice(0, 1) }));
  expect(shares(result.current)).toEqual([0, 20]);
  rerender(input(expanded, undefined));
  expect(shares(result.current)).toEqual([0, 20]);
  rerender(input(expanded, response(expanded)));
  expect(result.current).toMatchObject({ kind: 'anchored', anchorDate: dates[0] });
  expect(shares(result.current)).toEqual([0, 10, 30]);
});

it.each(['code', 'to', 'subject', 'narrower range'] as const)('does not reuse a baseline after a %s change', change => {
  const { result, rerender } = renderHook(useInvestorCumulativeSnapshot, { initialProps: input(original, response(original)) });
  const next = input(expanded, undefined);
  if (change === 'code') next.scope = { ...expanded, code: '000660' };
  if (change === 'to') next.scope = { ...expanded, to: '20260108' };
  if (change === 'subject') next.subject = 'foreign';
  if (change === 'narrower range') next.scope = { ...expanded, from: dates[2] };
  rerender(next);
  expect(result.current.kind).toBe('empty');
});

it.each(['null', 'missing', 'corrected', 'empty'] as const)('applies covered %s data even when it degrades the previous curve', change => {
  const { result, rerender } = renderHook(useInvestorCumulativeSnapshot, { initialProps: input(original, response(original)) });
  const source = response(expanded);
  if (change === 'null') source.observations[1].institution_net_shares = null;
  if (change === 'missing') source.observations.splice(1, 1);
  if (change === 'corrected') source.observations[1].institution_net_shares = 99;
  if (change === 'empty') source.observations = [];
  rerender(input(expanded, source));
  expect(shares(result.current)).toEqual(change === 'empty' ? [] : change === 'corrected' ? [0, 99, 119] : [0, null, null]);
});

it('invalidates old values when an incomplete result explicitly conflicts with them, independently per subject', () => {
  const { result, rerender } = renderHook(useInvestorCumulativeSnapshot, { initialProps: input(original, response(original)) });
  const source = { ...response(expanded), pagination: 'incomplete' as const };
  source.observations[1].institution_net_shares = null;
  rerender(input(expanded, source));
  expect(shares(result.current)).toEqual([0, null, null]);
  rerender(input(expanded, undefined));
  expect(result.current.kind).toBe('empty');
});

it('does not discard confirmed institution data for a foreign-only conflict', () => {
  const { result, rerender } = renderHook(useInvestorCumulativeSnapshot, { initialProps: input(original, response(original)) });
  const source = { ...response(expanded), pagination: 'incomplete' as const };
  source.observations[1].foreign_net_shares = null;
  rerender(input(expanded, source));
  expect(shares(result.current)).toEqual([0, 20]);
});

it('does not retain values across an unlocated source defect', () => {
  const { result, rerender } = renderHook(useInvestorCumulativeSnapshot, { initialProps: input(original, response(original)) });
  rerender(input(expanded, { ...response(expanded), pagination: 'incomplete', unlocated_defect: true }));
  expect(shares(result.current)).toEqual([0, null, null]);
});

it('rechecks retained data when new candles expose a missing day inside the old interval', () => {
  const source = response(expanded);
  source.observations.splice(1, 1);
  const initial = { ...input(expanded, source), candleDates: [candleDates[0], candleDates[2]] };
  const { result, rerender } = renderHook(useInvestorCumulativeSnapshot, { initialProps: initial });
  expect(shares(result.current)).toEqual([0, 20]);
  rerender({ ...input({ ...expanded, from: '20260104' }, undefined), candleDates });
  expect(shares(result.current)).toEqual([0, null, null]);
});
