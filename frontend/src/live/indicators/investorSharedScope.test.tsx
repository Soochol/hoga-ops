import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { IChartApi } from 'lightweight-charts';
import { afterEach, expect, it, vi } from 'vitest';
import * as client from '../../api/client';
import type { InvestorDailyFlowResponse } from '../../api/investorDailyFlow';
import type { RangeBundle } from '../../api/types';
import { projectInvestorNetLine } from '../../chart/projectors/investorNetLine';
import { FACTORY_INDICATOR_SETTINGS, type IndicatorSettings } from '../../state/indicatorSettingsV2';
import { createVirtualAxis } from '../../util/virtualAxis';
import { buildPriceBundle } from '../buildIndexBundle';
import { InvestorCumulativePane } from './InvestorCumulativePane';
import { InvestorNetLinePane } from './InvestorNetLinePane';
import { IndicatorInstancePane } from './IndicatorInstancePane';
vi.mock('../../chart/RangeSeriesPane', () => ({ default: ({ bundle, axis, spec, contextOverride }: {
  bundle: RangeBundle; axis: ReturnType<typeof createVirtualAxis>; spec: { name: string }; contextOverride?: unknown;
}) => <output data-testid={spec.name}>{JSON.stringify({ flow: bundle.investorDailyFlow, context: contextOverride,
  ...(spec.name === 'investor-net-line' ? {
    foreign: projectInvestorNetLine(bundle, axis, 'foreign').map(point => 'value' in point ? point.value : null),
    institution: projectInvestorNetLine(bundle, axis, 'institution').map(point => 'value' in point ? point.value : null),
  } : {}) })}</output> }));
vi.mock('../workspace/windowView', () => ({ useWindowIndicators: () => FACTORY_INDICATOR_SETTINGS,
  useWindowIndicator: (select: (settings: IndicatorSettings) => unknown) => select(FACTORY_INDICATOR_SETTINGS) }));
vi.mock('../liveDateTime', async importOriginal => ({ ...(await importOriginal<typeof import('../liveDateTime')>()), isKrxRegularSessionNow: () => false }));
afterEach(() => vi.restoreAllMocks());
const scope = { code: '005930', from: '20260105', to: '20260107' };
const days = [5, 6, 7].map(day => Date.UTC(2026, 0, day));
const flow: InvestorDailyFlowResponse = { ...scope, source: 'kiwoom_ka10059', provider_scope: 'KRX',
  unit: 'qty_shares', trade_side: 'net', observations: days.map((t_ms, i) => ({ date: `2026010${5 + i}`, t_ms,
    institution_net_shares: [100, 7, 8][i], foreign_net_shares: [90, 4, -2][i] })),
  pagination: 'incomplete', unlocated_defect: false, pages_observed: 1, can_continue: false, data_warnings: [] };
const bundle = { ...buildPriceBundle({ code: scope.code, from: '20260106', to: scope.to, bucketMs: 86400000,
  candles: days.slice(1).map(t_ms => ({ t_ms, open: 10, high: 11, low: 9, close: 10, volume: 1 })) }),
  investorRequestScope: scope, investorDailyFlow: null };
const props = { chart: {} as IChartApi, bundle, axis: createVirtualAxis([]), paneIndex: 1, precedingPaneKey: '' };
it('line, cumulative and repeated bars use the requested investor bounds rather than candle bounds', async () => {
  const fetch = vi.spyOn(client, 'apiCall').mockResolvedValue({ ...scope, unit: 'qty_shares', trade_side: 'net',
    daily_flow: flow, points: [], cached_batches: [], fresh_batches: [], data_warnings: [] });
  const cache = new QueryClient();
  const view = render(<QueryClientProvider client={cache}>
    <InvestorNetLinePane {...props} code={scope.code} spec={{ name: 'investor-net-line', stretch: 0.5, series: [] }} />
    <InvestorCumulativePane {...props} code={scope.code} subject="institution" spec={{ name: 'institution-cumulative', stretch: 0.5, series: [] }} />
    <IndicatorInstancePane {...props} code={scope.code} spec={{ name: 'indicator:repeated:investor-institution', stretch: 0.5, series: [] }} />
  </QueryClientProvider>);
  await waitFor(() => expect(screen.getByTestId('investor-net-line')).toHaveTextContent('"pages_observed":1'));
  expect(screen.getByTestId('indicator:repeated:investor-institution')).toHaveTextContent('"pages_observed":1');
  expect(screen.getByTestId('institution-cumulative')).toHaveTextContent('"anchorDate":"20260105"');
  expect(screen.getByTestId('institution-cumulative')).toHaveTextContent('"shares":15');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toContain('from=20260105&to=20260107&axis=qty&trade_side=net');
  fetch.mockImplementation(() => new Promise(() => {}));
  const expanded = { ...props, bundle: { ...bundle, investorRequestScope: { ...scope, from: '20260102' } } };
  view.rerender(<QueryClientProvider client={cache}>
    <InvestorNetLinePane {...expanded} code={scope.code} spec={{ name: 'investor-net-line', stretch: 0.5, series: [] }} />
    <InvestorCumulativePane {...expanded} code={scope.code} subject="institution" spec={{ name: 'institution-cumulative', stretch: 0.5, series: [] }} />
    <IndicatorInstancePane {...expanded} code={scope.code} spec={{ name: 'indicator:repeated:investor-institution', stretch: 0.5, series: [] }} />
  </QueryClientProvider>);
  expect(screen.getByTestId('investor-net-line')).toHaveTextContent('"flow":null');
  expect(screen.getByTestId('indicator:repeated:investor-institution')).toHaveTextContent('"flow":null');
  expect(screen.getByTestId('institution-cumulative')).toHaveTextContent('"anchorDate":"20260105"');
  expect(fetch).toHaveBeenCalledTimes(2);
  view.unmount();
});

const grossSides = ['buy', 'sell'] as const;
it.each(grossSides.flatMap(foreignSide => grossSides.flatMap(institutionSide =>
  [true, false].map(hasGrossPoints => ({ foreignSide, institutionSide, hasGrossPoints })),
)))('net lines ignore $foreignSide/$institutionSide bars with gross points=$hasGrossPoints', async ({ foreignSide, institutionSide, hasGrossPoints }) => {
  const strictFlow: InvestorDailyFlowResponse = { ...flow, observations: days.map((t_ms, index) => ({
    date: `2026010${5 + index}`, t_ms,
    foreign_net_shares: [-24, null, 0][index], institution_net_shares: [-36, 0, null][index],
  })) };
  const fetch = vi.spyOn(client, 'apiCall').mockResolvedValue({ ...scope, unit: 'qty_shares', trade_side: 'net',
    daily_flow: strictFlow, points: [], cached_batches: [], fresh_batches: [], data_warnings: [] });
  const grossPoints = hasGrossPoints ? days.map(t_ms => ({ t_ms, foreign_net: 9_900_000, institution_net: 8_800_000 })) : [];
  const lineBundle = { ...buildPriceBundle({ code: scope.code, from: scope.from, to: scope.to, bucketMs: 86_400_000,
    candles: days.map(t_ms => ({ t_ms, open: 10, high: 11, low: 9, close: 10, volume: 1 })) }),
    investorRequestScope: scope, investorDailyFlow: null, investorPoints: grossPoints,
    institutionInvestorPoints: grossPoints, investorTradeSide: foreignSide, institutionInvestorTradeSide: institutionSide };
  const axis = createVirtualAxis(days.map((t_ms, index) => ({ date: `2026010${5 + index}`,
    sessionOpenMs: t_ms, sessionCloseMs: t_ms + 23_400_000 })));
  const cache = new QueryClient();
  const view = render(<QueryClientProvider client={cache}>
    <InvestorNetLinePane {...props} bundle={lineBundle} axis={axis} code={scope.code}
      spec={{ name: 'investor-net-line', stretch: 0.5, series: [] }} />
  </QueryClientProvider>);
  try {
    await waitFor(() => expect(screen.getByTestId('investor-net-line')).toHaveTextContent('"pages_observed":1'));
    expect(screen.getByTestId('investor-net-line')).toHaveTextContent('"foreign":[-24,null,0]');
    expect(screen.getByTestId('investor-net-line')).toHaveTextContent('"institution":[-36,0,null]');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toContain('axis=qty&trade_side=net');
  } finally {
    view.unmount();
    cache.clear();
  }
});
