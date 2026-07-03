import { describe, it, expect } from 'vitest';
import { projectBidPoints, projectAskPoints } from './quoteTotals';
import type { QuoteRatioPoint } from '../../api/types';
import { createVirtualAxis } from '../../util/virtualAxis';

const t0 = 1_700_000_000_000;
const pt: QuoteRatioPoint = {
  t: t0,
  bid_total: 10,
  ask_total: 20,
  bid_max: 900,
  ask_max: 800,
  imb_max_bid: 100,
  imb_max_ask: 2,
};
const axis = createVirtualAxis([
  { date: '20231114', sessionOpenMs: t0 - 60_000, sessionCloseMs: t0 + 60_000 },
]);

describe('총잔량 Intra-Bar Max 스위치', () => {
  it('intraMax=false면 종가(bid_total/ask_total) 렌더', () => {
    expect(projectBidPoints([pt], axis, false, false)[0].value).toBe(10);
    expect(projectAskPoints([pt], axis, false, false)[0].value).toBe(20);
  });

  it('intraMax=true면 최댓값(bid_max/ask_max) 렌더', () => {
    expect(projectBidPoints([pt], axis, false, true)[0].value).toBe(900);
    expect(projectAskPoints([pt], axis, false, true)[0].value).toBe(800);
  });

  it('intraMax=true여도 양쪽 색상을 모두 밝게 유지한다', () => {
    const bid = projectBidPoints([pt], axis, false, true)[0];
    const ask = projectAskPoints([pt], axis, false, true)[0];
    expect(bid.color).toBe('#DC2626');
    expect(ask.color).toBe('#2563EB');
  });
});
