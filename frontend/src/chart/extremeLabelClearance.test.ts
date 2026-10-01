import { describe, expect, it } from 'vitest';
import { chooseClearExtremeLabel, extremeLabelRect } from './extremeLabelClearance';
const base = {
  place: 'above' as const, x: 100, y: 10, paneWidth: 300, paneHeight: 180,
  full: { text: '38,500원 (-2.40%)', width: 120 }, short: { text: '38,500', width: 45 },
  candles: [{ left: 95, right: 105, top: 10, bottom: 160 }], obstacles: [],
};
describe('extreme label clearance', () => {
  it('moves sideways into local clearance when the highest candle reaches the edge', () => {
    const p = chooseClearExtremeLabel(base)!;
    expect(p).not.toBeNull();
    expect(extremeLabelRect(p, p.width).left).toBeGreaterThanOrEqual(107);
  });
  it('uses price only when the available interval is too narrow for full text', () => {
    const p = chooseClearExtremeLabel({ ...base, paneWidth: 100, x: 50, candles: [], obstacles: [] })!;
    expect(p.compact).toBe(true);
  });
  it('returns no chip instead of clamping one onto candles', () => {
    expect(chooseClearExtremeLabel({ ...base, candles: [{left: 0, right: 300, top: 0, bottom: 180}] })).toBeNull();
  });
  it('does not cover a full-width legend or escape a tiny canvas', () => {
    expect(chooseClearExtremeLabel({ ...base, candles: [], obstacles: [{left: 0, right: 300, top: 0, bottom: 180}] })).toBeNull();
    expect(chooseClearExtremeLabel({ ...base, paneHeight: 20 })).toBeNull();
  });
  it('keeps a safe previous position on a tick and evicts it immediately on collision', () => {
    const previous = chooseClearExtremeLabel({ ...base, candles: [] })!;
    const stable = chooseClearExtremeLabel({ ...base, candles: [], x: 103, previous })!;
    expect(stable.x).toBe(previous.x);
    const moved = chooseClearExtremeLabel({ ...base, previous })!;
    expect(moved.x).not.toBe(previous.x);
  });
  it('rechecks changed text width, pane bounds and new annotations before reusing a chip', () => {
    const previous = chooseClearExtremeLabel({ ...base, candles: [], x: 80 })!;
    const wider = chooseClearExtremeLabel({ ...base, candles: [], previous,
      full: { text: 'a wider price', width: 190 } })!;
    expect(wider.x).toBeGreaterThanOrEqual(101);
    const smaller = chooseClearExtremeLabel({ ...base, candles: [], previous, paneWidth: 120 });
    if (smaller) expect(extremeLabelRect(smaller, smaller.width).right).toBeLessThanOrEqual(114);
    const obstacle = extremeLabelRect(previous, previous.width);
    const blocked = chooseClearExtremeLabel({ ...base, candles: [], previous, obstacles: [obstacle] });
    if (blocked) expect(blocked.x === previous.x && blocked.y === previous.y).toBe(false);
  });
  it('protects low candles symmetrically and avoids the other chip', () => {
    const p = chooseClearExtremeLabel({ ...base, place: 'below', y: 170 })!;
    expect(p).not.toBeNull();
    const next = chooseClearExtremeLabel({ ...base, place: 'below', y: 170, obstacles: [extremeLabelRect(p, p.width)] });
    if (next) expect(next.x === p.x && next.y === p.y).toBe(false);
  });
  it('produces the same placement for unordered rectangles, overlaps and invalid entries', () => {
    const candles = [
      { left: 0, right: 20, top: 20, bottom: 150 },
      { left: 10, right: 60, top: 15, bottom: 160 },
      { left: 220, right: 250, top: 10, bottom: 170 },
    ];
    const obstacles = [
      { left: 0, right: 30, top: 0, bottom: 35 },
      { left: 270, right: 300, top: 0, bottom: 180 },
    ];
    for (const place of ['above', 'below'] as const) {
      const expected = chooseClearExtremeLabel({ ...base, place, candles, obstacles });
      expect(chooseClearExtremeLabel({ ...base, place,
        candles: [...candles].reverse(),
        obstacles: [...obstacles].reverse().concat({ left: NaN, right: 300, top: 0, bottom: 180 }),
      })).toEqual(expected);
    }
  });
  it('never returns a chip intersecting candles or annotations across crowded layouts', () => {
    let seed = 47;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let run = 0; run < 200; run++) {
      const candles = Array.from({ length: 30 }, (_, i) => {
        const top = random() * 120;
        return { left: i * 10, right: i * 10 + 6, top, bottom: top + random() * (180 - top) };
      });
      const obstacles = [{ left: 0, right: random() * 300, top: 0, bottom: random() * 60 }];
      for (const place of ['above', 'below'] as const) {
        const p = chooseClearExtremeLabel({ ...base, x: random() * 300, place, candles, obstacles });
        if (!p) continue;
        const box = extremeLabelRect(p, p.width);
        expect(box.left).toBeGreaterThanOrEqual(6);
        expect(box.right).toBeLessThanOrEqual(294);
        expect(box.top).toBeGreaterThanOrEqual(6);
        expect(box.bottom).toBeLessThanOrEqual(174);
        for (const r of [...candles, ...obstacles]) {
          expect(box.left < r.right && box.right > r.left && box.top < r.bottom && box.bottom > r.top).toBe(false);
        }
      }
    }
  });
});
