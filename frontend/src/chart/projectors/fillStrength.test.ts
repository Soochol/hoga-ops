import { describe, it, expect } from 'vitest';
import { projectBuy, projectSell } from './fillStrength';
import { createVirtualAxis } from '../../util/virtualAxis';

const sessionOpenMs = 1_779_062_400_000;
const axis = createVirtualAxis([
  { date: '20260518', sessionOpenMs, sessionCloseMs: sessionOpenMs + 23_400_000 },
]);

describe('projectBuy', () => {
  it('maps fill_strength.points to {time, buy_qty} in virtual seconds', () => {
    const bundle: any = {
      fill_strength: {
        points: [
          { t: sessionOpenMs, buy_qty: 50, sell_qty: 30 },
          { t: sessionOpenMs + 1000, buy_qty: 40, sell_qty: 60 },
        ],
      },
    };
    expect(projectBuy(bundle, axis)).toEqual([
      { time: 0, value: 50 },
      { time: 1, value: 40 },
    ]);
  });

  it('drops pre-open points via axis.contains', () => {
    const bundle: any = {
      fill_strength: {
        points: [
          { t: sessionOpenMs - 30 * 60_000, buy_qty: 1, sell_qty: 1 },
          { t: sessionOpenMs, buy_qty: 50, sell_qty: 30 },
        ],
      },
    };
    expect(projectBuy(bundle, axis)).toHaveLength(1);
    expect(projectBuy(bundle, axis)[0].value).toBe(50);
  });
});

describe('projectSell', () => {
  it('emits NEGATED sell_qty so the series mirrors below the 0 baseline', () => {
    const bundle: any = {
      fill_strength: {
        points: [
          { t: sessionOpenMs, buy_qty: 50, sell_qty: 30 },
          { t: sessionOpenMs + 1000, buy_qty: 40, sell_qty: 60 },
        ],
      },
    };
    expect(projectSell(bundle, axis)).toEqual([
      { time: 0, value: -30 },
      { time: 1, value: -60 },
    ]);
  });
});
