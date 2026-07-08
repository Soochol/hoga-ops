import { describe, it, expect } from 'vitest';
import { levelAlpha, visibleMaxQty } from './depthHeatmapAlpha';
import type { DepthHeatmapPoint } from './depthHeatmapWire';

describe('depthHeatmapAlpha', () => {
  it('qty=visibleMax면 α=maxOpacity, qty=0이면 α=0', () => {
    expect(levelAlpha(1000, 1000, 0.7)).toBeCloseTo(0.7, 5);
    expect(levelAlpha(0, 1000, 0.7)).toBe(0);
  });
  it('감마 0.65로 중간값을 들어올린다 (선형보다 크다)', () => {
    const a = levelAlpha(500, 1000, 1);
    expect(a).toBeCloseTo(Math.pow(0.5, 0.65), 5);
    expect(a).toBeGreaterThan(0.5);
  });
  it('visibleMax=0이면 0 (0나눗셈 방어)', () => {
    expect(levelAlpha(100, 0, 0.7)).toBe(0);
  });
  it('qty가 visibleMax를 초과해도 α는 maxOpacity로 클램프', () => {
    expect(levelAlpha(2000, 1000, 0.7)).toBeCloseTo(0.7, 5);
  });
  it('visibleMaxQty는 보이는 범위 내 모든 레벨의 최대 잔량', () => {
    const points: DepthHeatmapPoint[] = [
      { tMs: 100, asks: [{ price: 10, qty: 300 }], bids: [{ price: 9, qty: 900 }], asksMax: [], bidsMax: [] },
      { tMs: 200, asks: [{ price: 11, qty: 500 }], bids: [{ price: 8, qty: 100 }], asksMax: [], bidsMax: [] },
    ];
    expect(visibleMaxQty(points, 0, 250)).toBe(900);
    expect(visibleMaxQty(points, 150, 250)).toBe(500); // tMs=100 제외
    expect(visibleMaxQty(points, 0, 50)).toBe(0);       // 아무것도 안 보임
  });
});
