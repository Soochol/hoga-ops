import { describe, expect, it } from 'vitest';
import type { UTCTimestamp } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import { createVirtualAxis } from '../util/virtualAxis';
import { linkedInvestorPriceRange } from './investorPaneScale';

const DAY = 86_400_000;
const START = Date.UTC(2026, 8, 14);
const axis = createVirtualAxis([{
  date: '20260914',
  sessionOpenMs: START,
  sessionCloseMs: START + 3 * DAY,
}]);

function bundle(foreign: number[], institution: number[]): RangeBundle {
  const points = foreign.map((foreign_net, i) => ({
    t_ms: START + i * DAY,
    foreign_net,
    institution_net: institution[i],
  }));
  return {
    investorPoints: points,
    institutionInvestorPoints: points,
  } as RangeBundle;
}

describe('linkedInvestorPriceRange', () => {
  it('uses the union of foreign and institution values and includes zero', () => {
    const range = linkedInvestorPriceRange(bundle([500, -100], [200, -300]), axis, null);
    expect(range).toEqual({ from: -348, to: 548 });
  });

  it('only scales from values inside the visible time range', () => {
    const second = axis.toVirtual(START + DAY) / 1000;
    const range = linkedInvestorPriceRange(
      bundle([10_000, 100], [-20_000, -50]),
      axis,
      { from: second as UTCTimestamp, to: second as UTCTimestamp },
    );
    expect(range).toEqual({ from: -59, to: 109 });
  });

  it('returns a usable range for a flat zero window', () => {
    expect(linkedInvestorPriceRange(bundle([0], [0]), axis, null)).toEqual({ from: -1, to: 1 });
  });
});
