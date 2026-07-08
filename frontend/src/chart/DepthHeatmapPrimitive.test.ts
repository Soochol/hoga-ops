import { describe, it, expect } from 'vitest';
import { DepthHeatmapPrimitive } from './DepthHeatmapPrimitive';

describe('DepthHeatmapPrimitive', () => {
  it('setCells가 셀을 저장하고 zOrder를 반영한다', () => {
    const prim = new DepthHeatmapPrimitive({ zOrder: 'bottom' });
    prim.setCells([
      { time: 100 as never, price: 1000, halfTick: 50, fillColor: 'rgba(240,68,82,0.5)' },
    ]);
    expect(prim.cellsData().length).toBe(1);
    expect(prim.zOrder()).toBe('bottom');
  });
  it('기본 zOrder는 bottom', () => {
    const prim = new DepthHeatmapPrimitive();
    expect(prim.zOrder()).toBe('bottom');
  });
});
