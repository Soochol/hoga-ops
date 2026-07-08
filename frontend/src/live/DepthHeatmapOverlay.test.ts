import { describe, it, expect } from 'vitest';
import { buildDepthHeatmapCells } from './DepthHeatmapOverlay';
import type { DepthHeatmapPoint } from './depthHeatmapWire';

const axis = { toVirtual: (ms: number) => ms } as never; // identity axis

describe('buildDepthHeatmapCells', () => {
  const points: DepthHeatmapPoint[] = [
    { tMs: 60000, asks: [{ price: 1010, qty: 900 }], bids: [{ price: 1000, qty: 300 }], asksMax: [], bidsMax: [] },
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
    const pts: DepthHeatmapPoint[] = [{ tMs: 1000, asks: [{ price: 10, qty: 0 }], bids: [{ price: 9, qty: 5 }], asksMax: [], bidsMax: [] }];
    const cells = buildDepthHeatmapCells(pts, axis, 0, 2000, { bidColor: '#F04452', askColor: '#3485FA', maxOpacity: 1 });
    expect(cells.length).toBe(1);  // ask qty0 skipped
    expect(cells[0].price).toBe(9);
  });
  it('화면 밖 큰 벽은 정규화 천장을 잡지 않는다 — 화면 내 최대로 재정규화', () => {
    // tMs=60000 버킷의 벽(9000)이 화면 밖이면, 화면(tMs=180000) 안의 최대(600)가 천장.
    const pts: DepthHeatmapPoint[] = [
      { tMs: 60000, asks: [{ price: 1010, qty: 9000 }], bids: [], asksMax: [], bidsMax: [] },   // 화면 밖 거대 벽
      { tMs: 180000, asks: [{ price: 1010, qty: 600 }], bids: [{ price: 1000, qty: 600 }], asksMax: [], bidsMax: [] },
    ];
    // 화면 범위 [120000,240000] — tMs=60000 제외. 화면 내 max=600 → 두 셀 모두 full α.
    const visible = buildDepthHeatmapCells(pts, axis, 120000, 240000, {
      bidColor: '#F04452', askColor: '#3485FA', maxOpacity: 1,
    });
    expect(visible.length).toBe(2);
    expect(visible.every((c) => c.fillColor.endsWith(', 1)'))).toBe(true);
    // 대조: 전 범위면 화면 밖 9000이 천장이라 같은 600셀이 옅어진다((600/9000)^0.65 ≈ 0.15).
    const full = buildDepthHeatmapCells(pts, axis, -Infinity, Infinity, {
      bidColor: '#F04452', askColor: '#3485FA', maxOpacity: 1,
    });
    const visibleCell = full.find((c) => c.price === 1000)!;
    expect(visibleCell.fillColor).toMatch(/^rgba\(240, 68, 82, 0\.1[0-9]+\)$/);
  });
  it('intraMax=true면 asksMax/bidsMax를 소스로 셀 빌드 + max 기준 정규화', () => {
    const pts: DepthHeatmapPoint[] = [
      {
        tMs: 1000,
        asks: [{ price: 10, qty: 100 }],
        bids: [{ price: 9, qty: 100 }],
        asksMax: [{ price: 10, qty: 900 }],
        bidsMax: [{ price: 9, qty: 900 }],
      },
    ];
    const cells = buildDepthHeatmapCells(
      pts,
      axis,
      0,
      2000,
      { bidColor: '#F04452', askColor: '#3485FA', maxOpacity: 1 },
      /*intraMax*/ true,
    );
    expect(cells.length).toBe(2);
    // visibleMax=900(max소스), qty=900 → full α
    expect(cells.every((c) => c.fillColor.endsWith(', 1)'))).toBe(true);
  });
});
