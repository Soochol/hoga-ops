import { describe, it, expect } from 'vitest';
import { buildDepthDeltaCells } from './DepthDeltaOverlay';
import type { DepthDeltaPoint } from './depthDelta';

const axis = { toVirtual: (ms: number) => ms } as never; // identity axis
const STYLE = { inColor: '#0D9488', outColor: '#C026D3', maxOpacity: 1 };

const lvl = (price: number, inQty: number, outQty: number) => ({ price, inQty, outQty });

describe('buildDepthDeltaCells', () => {
  it('순증가는 유입색, 순감소는 유출색으로 칠한다', () => {
    const points: DepthDeltaPoint[] = [
      { tMs: 60000, askDelta: [lvl(1010, 900, 0)], bidDelta: [lvl(1000, 0, 900)], askTick: 1, bidTick: 1 },
    ];
    const cells = buildDepthDeltaCells(points, axis, 0, 120000, STYLE);
    expect(cells.length).toBe(2);
    // |net| 최대가 900 이라 양쪽 모두 full α.
    expect(cells.find((c) => c.price === 1010)!.fillColor).toBe('rgba(13, 148, 136, 1)');
    expect(cells.find((c) => c.price === 1000)!.fillColor).toBe('rgba(192, 38, 211, 1)');
  });

  it('α 는 |net| 을 화면 내 최대 |net| 으로 정규화한다', () => {
    const points: DepthDeltaPoint[] = [
      { tMs: 60000, askDelta: [lvl(1010, 900, 0), lvl(1011, 300, 0)], bidDelta: [], askTick: 1, bidTick: 1 },
    ];
    const cells = buildDepthDeltaCells(points, axis, 0, 120000, STYLE);
    // (300/900)^0.65 ≈ 0.487
    expect(cells.find((c) => c.price === 1011)!.fillColor).toMatch(/^rgba\(13, 148, 136, 0\.4[0-9]+\)$/);
  });

  it('유출 셀이 투명해지지 않는다 (levelAlpha 의 qty<=0 가드 회피)', () => {
    // 부호를 그대로 levelAlpha 에 넘기면 음수라 α=0 이 되어 유출 절반이 통째로 사라진다.
    const points: DepthDeltaPoint[] = [
      { tMs: 1000, askDelta: [], bidDelta: [lvl(1000, 0, 500)], askTick: 1, bidTick: 1 },
    ];
    const cells = buildDepthDeltaCells(points, axis, 0, 2000, STYLE);
    expect(cells.length).toBe(1);
    expect(cells[0].fillColor).toBe('rgba(192, 38, 211, 1)');
  });

  it('순증감 0(들어온 만큼 빠진 가격)은 셀을 만들지 않는다', () => {
    const points: DepthDeltaPoint[] = [
      { tMs: 1000, askDelta: [lvl(1010, 400, 400)], bidDelta: [lvl(1000, 0, 200)], askTick: 1, bidTick: 1 },
    ];
    const cells = buildDepthDeltaCells(points, axis, 0, 2000, STYLE);
    expect(cells.map((c) => c.price)).toEqual([1000]);
  });

  it('가시 범위 밖 버킷은 제외한다', () => {
    const points: DepthDeltaPoint[] = [
      { tMs: 60000, askDelta: [lvl(1010, 900, 0)], bidDelta: [], askTick: 1, bidTick: 1 },
    ];
    expect(buildDepthDeltaCells(points, axis, 0, 30000, STYLE)).toEqual([]);
  });

  it('화면 밖 거대 증감은 정규화 천장을 잡지 않는다', () => {
    const points: DepthDeltaPoint[] = [
      { tMs: 60000, askDelta: [lvl(1010, 9000, 0)], bidDelta: [], askTick: 1, bidTick: 1 }, // 화면 밖
      { tMs: 180000, askDelta: [lvl(1010, 600, 0)], bidDelta: [], askTick: 1, bidTick: 1 },
    ];
    const cells = buildDepthDeltaCells(points, axis, 120000, 240000, STYLE);
    expect(cells.length).toBe(1);
    expect(cells[0].fillColor).toBe('rgba(13, 148, 136, 1)'); // 화면 내 최대 = 자기 자신
  });

  it('증감이 전혀 없으면 셀이 없다', () => {
    expect(buildDepthDeltaCells([], axis, 0, 1000, STYLE)).toEqual([]);
  });
});
