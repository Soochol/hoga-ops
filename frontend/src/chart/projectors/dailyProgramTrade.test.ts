import { expect, it } from 'vitest';
import type { RangeBundle } from '../../api/types';
import { createVirtualAxis } from '../../util/virtualAxis';
import { projectDailyProgramTrade } from './dailyProgramTrade';
import { paneSpecsForTimeframe } from '../../live/paneSpecsForTimeframe';

const t = Date.UTC(2026, 0, 5);
const axis = createVirtualAxis([{ date: '20260105', sessionOpenMs: t, sessionCloseMs: t + 23_400_000 }]);
const bundle = { dailyProgramPoints: [{ t_ms: t, net_qty: -30, buy_qty: 100, sell_qty: 130 }] } as RangeBundle;

it('selects real gross quantities with side colors, preserving signed net', () => {
  const net = projectDailyProgramTrade(bundle, axis)[0];
  const buy = projectDailyProgramTrade({ ...bundle, dailyProgramTradeSide: 'buy' }, axis)[0];
  const sell = projectDailyProgramTrade({ ...bundle, dailyProgramTradeSide: 'sell' }, axis)[0];
  expect([net.value, buy.value, sell.value]).toEqual([-30, 100, 130]);
  expect(net.color).toBe(sell.color);
  expect(buy.color).not.toBe(sell.color);
});

it('keeps zero, omits missing values and out-of-range dates', () => {
  const input = { ...bundle, dailyProgramPoints: [
    { t_ms: t, net_qty: 0, buy_qty: null, sell_qty: 10 },
    { t_ms: t - 86400000, net_qty: 2, buy_qty: 3, sell_qty: 1 },
  ] };
  expect(projectDailyProgramTrade(input, axis).map(p => p.value)).toEqual([0]);
  expect(projectDailyProgramTrade({ ...input, dailyProgramTradeSide: 'buy' }, axis)).toEqual([]);
});

it('is opt-in and stock daily only', () => {
  const toggles = { foreignNet: false, institutionNet: false, dailyProgramEnabled: true };
  expect(paneSpecsForTimeframe('D', toggles).map(s => s.name)).toContain('program-daily');
  expect(paneSpecsForTimeframe('D').map(s => s.name)).not.toContain('program-daily');
  for (const tf of ['1m', '5m', 'W', 'M'] as const) {
    expect(paneSpecsForTimeframe(tf, toggles).map(s => s.name)).not.toContain('program-daily');
  }
  expect(paneSpecsForTimeframe('D', { ...toggles, hogaPanes: false }).map(s => s.name)).not.toContain('program-daily');
});
