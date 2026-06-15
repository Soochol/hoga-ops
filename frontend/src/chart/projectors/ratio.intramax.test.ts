import { describe, it, expect } from 'vitest';
import { projectRatioPoints, type RatioPaneContext } from './ratio';
import type { QuoteRatioPoint } from '../../api/types';
import { createVirtualAxis } from '../../util/virtualAxis';

const t0 = 1_700_000_000_000;
const pt: QuoteRatioPoint = {
  t: t0,
  bid_total: 10,
  ask_total: 20,
  bid_max: 100,
  ask_max: 20,
  imb_max_bid: 100,
  imb_max_ask: 2,
};
const axis = createVirtualAxis([
  { date: '20231114', sessionOpenMs: t0 - 60_000, sessionCloseMs: t0 + 60_000 },
]);
const base: RatioPaneContext = {
  auctionWindowMask: false,
  outlierFilterEnabled: false,
  outlierThreshold: 100,
};

describe('호가비 Intra-Bar Max 스위치', () => {
  it('intraMax=false면 종가 imbalance (ask/bid-1 = 20/10-1 = +1, 매도우위)', () => {
    expect(projectRatioPoints([pt], axis, base)[0].value).toBeCloseTo(1, 5);
  });

  it('intraMax=true면 imb_max imbalance (-(100/2-1) = -49, 매수우위, 부호 반대)', () => {
    expect(projectRatioPoints([pt], axis, { ...base, intraMax: true })[0].value).toBeCloseTo(-49, 5);
  });

  it('Outlier Mask 직교: intraMax 극값이 임계 초과면 0 (필터 ON)', () => {
    const ctx = { ...base, outlierFilterEnabled: true, outlierThreshold: 30, intraMax: true };
    expect(projectRatioPoints([pt], axis, ctx)[0].value).toBe(0);
  });
});
