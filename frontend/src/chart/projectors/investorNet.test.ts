import { describe, it, expect } from 'vitest';

import { projectInvestorNet } from './investorNet';
import { createVirtualAxis } from '../../util/virtualAxis';
import type { RangeBundle, InvestorNetPoint } from '../../api/types';

// 2024-01-05 09:00 KST == 2024-01-05 00:00 UTC (daily anchor).
const OPEN_MS = Date.UTC(2024, 0, 5, 0, 0, 0);
const CLOSE_MS = OPEN_MS + 6.5 * 3600 * 1000;

const axis = createVirtualAxis([
  { date: '20240105', sessionOpenMs: OPEN_MS, sessionCloseMs: CLOSE_MS },
]);

function bundleWith(points: InvestorNetPoint[]): RangeBundle {
  return { investorPoints: points } as unknown as RangeBundle;
}

describe('projectInvestorNet', () => {
  it('maps the foreign net-buy quantity to the histogram value', () => {
    const b = bundleWith([{ t_ms: OPEN_MS, foreign_net: 1000, institution_net: -500 }]);
    const out = projectInvestorNet(b, axis, 'foreign');
    expect(out).toHaveLength(1);
    expect(out[0].value).toBe(1000);
  });

  it('maps the institution net-buy quantity to the histogram value', () => {
    const b = bundleWith([{ t_ms: OPEN_MS, foreign_net: 1000, institution_net: -500 }]);
    const out = projectInvestorNet(b, axis, 'institution');
    expect(out[0].value).toBe(-500);
  });

  it('colors net buy (>=0) differently from net sell (<0)', () => {
    const b = bundleWith([{ t_ms: OPEN_MS, foreign_net: 1000, institution_net: -500 }]);
    const buy = projectInvestorNet(b, axis, 'foreign')[0];
    const sell = projectInvestorNet(b, axis, 'institution')[0];
    expect(buy.color).not.toBe(sell.color);
  });

  it('filters out points with no owning axis segment', () => {
    const outside = Date.UTC(2030, 0, 1, 0, 0, 0);
    const b = bundleWith([{ t_ms: outside, foreign_net: 1, institution_net: 2 }]);
    expect(projectInvestorNet(b, axis, 'foreign')).toHaveLength(0);
  });

  it('returns empty for empty investorPoints', () => {
    expect(projectInvestorNet(bundleWith([]), axis, 'foreign')).toHaveLength(0);
  });
});

it('gross sell bars remain positive and use the sell color for both investors', () => {
  const net = bundleWith([{ t_ms: OPEN_MS, foreign_net: 1000, institution_net: -500 }]);
  const sellColor = projectInvestorNet(net, axis, 'institution')[0].color;
  const buyColor = projectInvestorNet(net, axis, 'foreign')[0].color;
  const gross = bundleWith([{ t_ms: OPEN_MS, foreign_net: 1200, institution_net: 700 }]);
  gross.investorTradeSide = 'sell';
  for (const subject of ['foreign', 'institution'] as const) {
    const bar = projectInvestorNet(gross, axis, subject)[0];
    expect(bar.value).toBeGreaterThan(0);
    expect(bar.color).toBe(sellColor);
  }
  gross.investorTradeSide = 'buy';
  expect(projectInvestorNet(gross, axis, 'institution')[0].color).toBe(buyColor);
});
