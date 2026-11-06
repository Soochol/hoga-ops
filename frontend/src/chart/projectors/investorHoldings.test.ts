import { describe, expect, it } from 'vitest';
import { projectInvestorHoldings, type HoldingsPaneContext } from './investorHoldings';
import { buildIndexBundle } from '../../live/buildIndexBundle';
import { createVirtualAxis } from '../../util/virtualAxis';
import { FACTORY_INDICATOR_SETTINGS } from '../../state/indicatorSettingsV2';
import { captureIndicatorSettings, makeIndicatorInstance, normalizeIndicatorInstances } from '../../state/indicatorInstances';
import { mergeLiveIndicatorPrefs } from '../../state/liveIndicatorsPersistence';
import { indicatorInstanceApplicable } from '../../live/indicators/indicatorInstancePanes';
import { DEFAULT_PREFS } from '../../state/chartPrefs';

const days = [0, 1, 2, 5, 6].map(i => Date.UTC(2026, 9, 1 + i));
const axis = createVirtualAxis(days.map((t, i) => ({ date: `2026100${i + 1}`, sessionOpenMs: t, sessionCloseMs: t + 23400000 })));
const bundle = buildIndexBundle({ indexId: 'KOSPI', from: '20261001', to: '20261007', bucketMs: 86400000,
  candles: days.map(t_ms => ({ t_ms, open: 100, high: 110, low: 90, close: 105, volume: 10 })) });
const context: HoldingsPaneContext = { settings: FACTORY_INDICATOR_SETTINGS, metric: 'quantity',
  points: days.map((t_ms, i) => ({ date: `2026100${i + 1}`, t_ms, quantity_shares: [100, 110, 0, 200, 210][i], ratio_pct: [10, 11, 0, 20, 21][i] })) };

describe('actual foreign holdings', () => {
  it('plots point-in-time balances independently from flow and selects one metric without accumulation', () => {
    const values = (ctx: HoldingsPaneContext) => projectInvestorHoldings(bundle, axis, ctx).map(p => 'value' in p ? p.value : null);
    expect(values(context)).toEqual([100, 110, 0, 200, 210]);
    expect(values({ ...context, metric: 'ratio' })).toEqual([10, 11, 0, 20, 21]);
  });
  it('breaks missing-field connectors and leaves other metrics independent, including true zero', () => {
    const points = context.points.map((p, i) => i === 1 || i === 4 ? { ...p, quantity_shares: null } : p);
    const out = projectInvestorHoldings(bundle, axis, { ...context, points });
    expect(out[0]).toHaveProperty('color', 'rgba(0,0,0,0)');
    expect(out[1]).not.toHaveProperty('value');
    expect(out[2]).toHaveProperty('value', 0);
    expect(out[3]).toHaveProperty('color', 'rgba(0,0,0,0)');
    expect(out[4]).not.toHaveProperty('value');
    expect(projectInvestorHoldings(bundle, axis, { ...context, points, metric: 'ratio' })[1]).toHaveProperty('value', 11);
  });
  it('leaves absent dates and future/foreign points empty and never uses latest or forward fills', () => {
    const points = [context.points[0], { ...context.points[2], t_ms: days[2] + 1 }];
    const out = projectInvestorHoldings(bundle, axis, { ...context, points });
    expect(out.slice(1).every(p => !('value' in p))).toBe(true);
  });
  it('rejects malformed numeric responses at the projector boundary', () => {
    const points = context.points.map((p, i) => ({ ...p, quantity_shares: [NaN, -1, 1.5, Infinity, 0][i], ratio_pct: [101, -1, Infinity, NaN, 0][i] }));
    for (const metric of ['quantity', 'ratio'] as const) {
      const out = projectInvestorHoldings(bundle, axis, { ...context, points, metric });
      expect(out.slice(0, 4).every(p => !('value' in p))).toBe(true);
      expect(out[4]).toHaveProperty('value', 0);
    }
  });
  it('persists independent units/styles/visibility and owns no flow controls', () => {
    const settings = { ...FACTORY_INDICATOR_SETTINGS, investorHoldingsEnabled: true, investorHoldingsMetric: 'ratio' as const,
      investorHoldingsWidth: 4 as const, indicatorLineVisibility: { investorHoldingsForeign: false, investorNetLineForeign: false } };
    const captured = captureIndicatorSettings('investor-holdings', settings);
    expect(captured).not.toHaveProperty('investorNetLineEnabled');
    expect(captured.indicatorLineVisibility).toEqual({ investorHoldingsForeign: false });
    const row = makeIndicatorInstance('investor-holdings', settings, DEFAULT_PREFS);
    const restored = normalizeIndicatorInstances([row], mergeLiveIndicatorPrefs);
    expect(restored[0].settings).toMatchObject({ investorHoldingsMetric: 'ratio', investorHoldingsWidth: 4 });
    expect(mergeLiveIndicatorPrefs({ investorHoldingsMetric: 'bad', investorHoldingsWidth: 8 })).toMatchObject({ investorHoldingsEnabled: false, investorHoldingsMetric: 'quantity', investorHoldingsWidth: 2 });
  });
  it('only mounts supported domestic daily stock contexts', () => {
    for (const tf of ['1s', '1m', 'W', 'M'] as const) expect(indicatorInstanceApplicable('investor-holdings', tf, true)).toBe(false);
    expect(indicatorInstanceApplicable('investor-holdings', 'D', true)).toBe(true);
    expect(indicatorInstanceApplicable('investor-holdings', 'D', false)).toBe(false);
    expect(indicatorInstanceApplicable('investor-holdings', 'D', true, true)).toBe(false);
  });
});
