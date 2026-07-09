import { describe, it, expect } from 'vitest';
import { depthHeatmapFromWire, depthPointToWire } from './depthHeatmapWire';
import type { DepthHeatmapPoint } from './depthHeatmapWire';
import type { DepthHeatmapPointWire } from '../api/types';

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

  it('동일 wire 참조는 동일 domain 객체를 반환한다(WeakMap 캐시)', () => {
    // 틱마다 새 배열이 와도 원소(wire point) 참조가 같으면 domain 을 재할당하지 않는다.
    const wire: DepthHeatmapPointWire = { t_ms: 100, asks: [[1000, 5]], bids: [[990, 4]] };
    const a = depthHeatmapFromWire([wire])[0];
    const b = depthHeatmapFromWire([wire, { t_ms: 200, asks: [], bids: [] }])[0];
    expect(b).toBe(a);
  });
});

describe('depthPointToWire', () => {
  it('동일 point 참조는 동일 wire 객체를 반환한다(WeakMap 캐시)', () => {
    const p: DepthHeatmapPoint = {
      tMs: 100,
      asks: [{ price: 1000, qty: 5 }],
      bids: [{ price: 990, qty: 4 }],
      asksMax: [{ price: 1000, qty: 9 }],
      bidsMax: [{ price: 990, qty: 8 }],
    };
    expect(depthPointToWire(p)).toBe(depthPointToWire(p));
  });

  it('값을 wire 튜플로 변환한다', () => {
    const p: DepthHeatmapPoint = {
      tMs: 100,
      asks: [{ price: 1000, qty: 5 }],
      bids: [{ price: 990, qty: 4 }],
      asksMax: [],
      bidsMax: [],
    };
    expect(depthPointToWire(p)).toEqual({
      t_ms: 100, asks: [[1000, 5]], bids: [[990, 4]], asks_max: [], bids_max: [],
    });
  });
});
