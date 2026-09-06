import { describe, it, expect } from 'vitest';
import { levelAlpha, sliceDepthHeatmapRange, visibleMaxQty } from './depthHeatmapAlpha';
import type { DepthHeatmapPoint } from './depthHeatmapWire';

describe('depthHeatmapAlpha', () => {
  const pointAt = (tMs: number): DepthHeatmapPoint => ({ tMs, asks: [], bids: [], asksMax: [], bidsMax: [] });

  it('가시 구간의 양끝과 중복 시각을 모두 포함하고 원소 참조를 보존한다', () => {
    const points = [100, 200, 200, 300, 400].map(pointAt);
    const visible = sliceDepthHeatmapRange(points, 200, 300);
    expect(visible).toEqual(points.slice(1, 4));
    expect(visible[0]).toBe(points[1]);
    expect(sliceDepthHeatmapRange(points, -Infinity, Infinity)).toBe(points);
    expect(sliceDepthHeatmapRange(points, 301, 399)).toEqual([]);
    expect(sliceDepthHeatmapRange(points, 500, 600)).toEqual([]);
    expect(sliceDepthHeatmapRange(points, 0, 99)).toEqual([]);
    expect(sliceDepthHeatmapRange(points, 300, 200)).toEqual([]);
    expect(sliceDepthHeatmapRange([], 0, 100)).toEqual([]);
  });

  it('긴 이력의 좁은 구간은 전체 점을 읽지 않는다', () => {
    let reads = 0;
    const points = new Proxy(Array.from({ length: 35_100 }, (_, i) => pointAt(i)), {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(sliceDepthHeatmapRange(points, 20_000, 20_009).map((p) => p.tMs))
      .toEqual(Array.from({ length: 10 }, (_, i) => 20_000 + i));
    // 두 번의 이진 탐색 + 보이는 10개 복사. O(N) filter 회귀를 시간 측정 없이 잡는다.
    expect(reads).toBeLessThan(100);
  });
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
  it('intraMax=true면 asksMax/bidsMax 잔량으로 최대 계산', () => {
    const pts: DepthHeatmapPoint[] = [
      {
        tMs: 100,
        asks: [{ price: 10, qty: 100 }],
        bids: [{ price: 9, qty: 100 }],
        asksMax: [{ price: 10, qty: 900 }],
        bidsMax: [{ price: 9, qty: 700 }],
      },
    ];
    expect(visibleMaxQty(pts, 0, 200, 'peakSnapshot')).toBe(900);   // max 소스
    expect(visibleMaxQty(pts, 0, 200, 'close')).toBe(100);  // 종가 소스
  });
});
