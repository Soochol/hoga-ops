import { describe, expect, it } from 'vitest';
import { projectInvestorNetLine } from './investorNetLine';
import { buildIndexBundle } from '../../live/buildIndexBundle';
import { createVirtualAxis } from '../../util/virtualAxis';
import { FACTORY_INDICATOR_SETTINGS } from '../../state/indicatorSettingsV2';
import { captureIndicatorSettings, makeIndicatorInstance, normalizeIndicatorInstances } from '../../state/indicatorInstances';
import { mergeLiveIndicatorPrefs } from '../../state/liveIndicatorsPersistence';
import { indicatorInstanceApplicable } from '../../live/indicators/indicatorInstancePanes';
import { DEFAULT_PREFS } from '../../state/chartPrefs';

const days = [0, 1, 2, 5, 6].map(i => Date.UTC(2026, 9, 1 + i));
const axis = createVirtualAxis(days.map((t, i) => ({ date: `2026100${i + 1}`, sessionOpenMs: t, sessionCloseMs: t + 23400000 })));
const base = buildIndexBundle({ indexId: 'KOSPI', from: '20261001', to: '20261007', bucketMs: 86400000,
  candles: days.map(t_ms => ({ t_ms, open: 100, high: 110, low: 90, close: 105, volume: 10 })) });
const bundle = { ...base, investorTradeSide: 'net' as const, investorPoints: days.map((t_ms, i) => ({ t_ms, foreign_net: [100, -200, 0, 300, -400][i], institution_net: [-40, 30, -20, 0, 10][i] })) };

describe('daily net-buy lines', () => {
  it('preserves each signed daily quantity and zero without accumulation or holiday padding', () => {
    expect(projectInvestorNetLine(bundle, axis, 'foreign').map(p => 'value' in p ? p.value : null)).toEqual([100, -200, 0, 300, -400]);
    expect(projectInvestorNetLine(bundle, axis, 'institution').map(p => 'value' in p ? p.value : null)).toEqual([-40, 30, -20, 0, 10]);
  });
  it('breaks outgoing connectors over missing days and never fabricates zero or a future value', () => {
    const out = projectInvestorNetLine({ ...bundle, investorPoints: bundle.investorPoints.filter((_, i) => i !== 1 && i !== 2 && i !== 4) }, axis, 'foreign');
    expect(out).toEqual([
      { time: axis.toVirtual(days[0]) / 1000, value: 100, color: 'rgba(0,0,0,0)' },
      { time: axis.toVirtual(days[1]) / 1000 }, { time: axis.toVirtual(days[2]) / 1000 },
      { time: axis.toVirtual(days[3]) / 1000, value: 300, color: 'rgba(0,0,0,0)' }, { time: axis.toVirtual(days[4]) / 1000 },
    ]);
  });
  it('gaps non-finite participant values independently and ignores off-axis data', () => {
    const points = bundle.investorPoints.map((p, i) => i === 1 ? { ...p, foreign_net: NaN } : p);
    const foreign = projectInvestorNetLine({ ...bundle, investorPoints: points }, axis, 'foreign');
    expect(foreign[1]).not.toHaveProperty('value');
    expect(projectInvestorNetLine({ ...bundle, investorPoints: points }, axis, 'institution')[1]).toHaveProperty('value', 30);
    expect(projectInvestorNetLine(bundle, createVirtualAxis([]), 'foreign')).toEqual([]);
  });
  it('refuses gross histogram input', () => {
    expect(projectInvestorNetLine({ ...bundle, investorTradeSide: 'buy' }, axis, 'foreign')).toEqual([]);
    expect(projectInvestorNetLine({ ...bundle, investorTradeSide: 'sell' }, axis, 'institution')).toEqual([]);
  });
  it('isolates line instance styles, visibility and enable state from histograms on reload', () => {
    const settings = { ...FACTORY_INDICATOR_SETTINGS, investorNetLineEnabled: true, investorNetLineWidth: 4 as const,
      foreignTradeSide: 'buy' as const, indicatorLineVisibility: { investorNetLineForeign: false, quoteTotalsBid: false } };
    const captured = captureIndicatorSettings('investor-net-line', settings);
    expect(captured).not.toHaveProperty('foreignTradeSide');
    expect(captured.indicatorLineVisibility).toEqual({ investorNetLineForeign: false });
    const row = makeIndicatorInstance('investor-net-line', settings, DEFAULT_PREFS);
    const restored = normalizeIndicatorInstances([row], mergeLiveIndicatorPrefs);
    expect(restored[0].settings.investorNetLineWidth).toBe(4);
    expect(restored[0].settings.indicatorLineVisibility).toEqual({ investorNetLineForeign: false });
    expect(mergeLiveIndicatorPrefs({})).toHaveProperty('investorNetLineEnabled', false);
  });
  it('only permits domestic stock daily instances', () => {
    for (const tf of ['1s', '1m', 'W', 'M'] as const) expect(indicatorInstanceApplicable('investor-net-line', tf, true)).toBe(false);
    expect(indicatorInstanceApplicable('investor-net-line', 'D', true)).toBe(true);
    expect(indicatorInstanceApplicable('investor-net-line', 'D', false)).toBe(false);
    expect(indicatorInstanceApplicable('investor-net-line', 'D', true, true)).toBe(false);
  });
});
