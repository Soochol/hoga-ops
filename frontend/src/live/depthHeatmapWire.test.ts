import { describe, it, expect } from 'vitest';
import { depthHeatmapFromWire } from './depthHeatmapWire';

describe('depthHeatmapFromWire', () => {
  it('wire 튜플을 도메인 객체로 변환한다', () => {
    const out = depthHeatmapFromWire([
      { t_ms: 100, asks: [[1000, 500], [1010, 300]], bids: [[990, 400]] },
    ]);
    expect(out).toEqual([
      { tMs: 100, asks: [{ price: 1000, qty: 500 }, { price: 1010, qty: 300 }], bids: [{ price: 990, qty: 400 }], asksMax: [], bidsMax: [] },
    ]);
  });
  it('null/undefined는 빈 배열', () => {
    expect(depthHeatmapFromWire(null)).toEqual([]);
    expect(depthHeatmapFromWire(undefined)).toEqual([]);
  });
  it('asks_max/bids_max를 asksMax/bidsMax로 변환한다', () => {
    const out = depthHeatmapFromWire([
      { t_ms: 100, asks: [[1000, 500]], bids: [[990, 400]],
        asks_max: [[1000, 900], [1010, 300]], bids_max: [[990, 800]] },
    ]);
    expect(out[0].asksMax).toEqual([{ price: 1000, qty: 900 }, { price: 1010, qty: 300 }]);
    expect(out[0].bidsMax).toEqual([{ price: 990, qty: 800 }]);
  });
  it('asks_max/bids_max 없으면 빈 배열', () => {
    const out = depthHeatmapFromWire([{ t_ms: 1, asks: [], bids: [] }]);
    expect(out[0].asksMax).toEqual([]);
    expect(out[0].bidsMax).toEqual([]);
  });
});
