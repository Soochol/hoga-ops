import { describe, it, expect } from 'vitest';
import { buildDepthHeatmapCells } from './DepthHeatmapOverlay';
import type { DepthHeatmapPoint } from './depthHeatmapWire';

const axis = { toVirtual: (ms: number) => ms } as never; // identity axis

describe('buildDepthHeatmapCells', () => {
  const points: DepthHeatmapPoint[] = [
    { tMs: 60000, asks: [{ price: 1010, qty: 900 }], bids: [{ price: 1000, qty: 300 }] },
  ];
  it('레벨당 셀 1개, 매도=askColor 매수=bidColor, α는 visibleMax 정규화', () => {
    const cells = buildDepthHeatmapCells(points, axis, 0, 120000, {
      bidColor: '#F04452', askColor: '#3485FA', maxOpacity: 1,
    });
    expect(cells.length).toBe(2);
    const ask = cells.find((c) => c.price === 1010)!;
    const bid = cells.find((c) => c.price === 1000)!;
    // visibleMax=900 → 매도(qty900)=full α, rgb=파랑(52,133,250)
    expect(ask.fillColor).toBe('rgba(52, 133, 250, 1)');
    // 매수(qty300) α=(300/900)^0.65≈0.487, rgb=빨강(240,68,82)
    expect(bid.fillColor).toMatch(/^rgba\(240, 68, 82, 0\.4[0-9]+\)$/);
  });
  it('빈 visible 범위면 셀 없음', () => {
    const cells = buildDepthHeatmapCells(points, axis, 0, 30000, {
      bidColor: '#F04452', askColor: '#3485FA', maxOpacity: 1,
    });
    expect(cells.length).toBe(0);  // tMs=60000 밖
  });
  it('qty=0 레벨은 스킵', () => {
    const pts: DepthHeatmapPoint[] = [{ tMs: 1000, asks: [{ price: 10, qty: 0 }], bids: [{ price: 9, qty: 5 }] }];
    const cells = buildDepthHeatmapCells(pts, axis, 0, 2000, { bidColor: '#F04452', askColor: '#3485FA', maxOpacity: 1 });
    expect(cells.length).toBe(1);  // ask qty0 skipped
    expect(cells[0].price).toBe(9);
  });
});
