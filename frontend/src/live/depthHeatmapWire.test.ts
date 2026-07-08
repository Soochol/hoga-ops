import { describe, it, expect } from 'vitest';
import { depthHeatmapFromWire } from './depthHeatmapWire';

describe('depthHeatmapFromWire', () => {
  it('wire 튜플을 도메인 객체로 변환한다', () => {
    const out = depthHeatmapFromWire([
      { t_ms: 100, asks: [[1000, 500], [1010, 300]], bids: [[990, 400]] },
    ]);
    expect(out).toEqual([
      { tMs: 100, asks: [{ price: 1000, qty: 500 }, { price: 1010, qty: 300 }], bids: [{ price: 990, qty: 400 }] },
    ]);
  });
  it('null/undefined는 빈 배열', () => {
    expect(depthHeatmapFromWire(null)).toEqual([]);
    expect(depthHeatmapFromWire(undefined)).toEqual([]);
  });
});
