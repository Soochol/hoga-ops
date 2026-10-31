import { describe, expect, it } from 'vitest';
import snapshotText from '../../public/market-breadth/snapshot.json?raw';
import { fundStroke } from './chartGeometry';
import { nextFundSort, sortFunds } from './comparison';
import type { BreadthReport, Fund } from './report';

const ready = (JSON.parse(snapshotText) as BreadthReport).funds.filter(f => f.status === 'ready');
const sample = (code: string, changes: Partial<Fund> = {}): Fund => ({ ...ready[0], code, ...changes });

describe('ETF comparison', () => {
  it('cycles ascending, descending, default and starts a different column ascending', () => {
    const asc = nextFundSort(null, 'd5');
    expect(asc).toEqual({ key: 'd5', direction: 'ascending' });
    const desc = nextFundSort(asc, 'd5');
    expect(desc).toEqual({ key: 'd5', direction: 'descending' });
    expect(nextFundSort(desc, 'd5')).toBeNull();
    expect(nextFundSort(desc, 'name')).toEqual({ key: 'name', direction: 'ascending' });
  });

  it('sorts negative changes numerically and keeps gaps last in both directions', () => {
    const funds = [sample('000003', { d5: null }), sample('000002', { d5: -12 }), sample('000001', { d5: 3 }), sample('000004', { d5: -12 })];
    expect(sortFunds(funds, { key: 'd5', direction: 'ascending' }).map(f => f.code)).toEqual(['000002', '000004', '000001', '000003']);
    expect(sortFunds(funds, { key: 'd5', direction: 'descending' }).map(f => f.code)).toEqual(['000001', '000002', '000004', '000003']);
    expect(funds[0].code).toBe('000003');
  });

  it('sorts names in Korean order, nested persistence values, and restores the default streak order', () => {
    const funds = [
      sample('000003', { name: '다', persistence: { streak: null, up5: null, atLeast: false } }),
      sample('000002', { name: '가', persistence: { streak: 0, up5: 5, atLeast: false } }),
      sample('000001', { name: '나', persistence: { streak: 2, up5: 1, atLeast: true } }),
    ];
    expect(sortFunds(funds, { key: 'name', direction: 'ascending' }).map(f => f.name)).toEqual(['가', '나', '다']);
    expect(sortFunds(funds, { key: 'up5', direction: 'ascending' }).map(f => f.code)).toEqual(['000001', '000002', '000003']);
    expect(sortFunds(funds, null).map(f => f.code)).toEqual(['000001', '000002', '000003']);
  });

  it('assigns a defined, distinct token-color and dash combination to all 42 ready ETFs', () => {
    const strokes = ready.map((_, i) => fundStroke(i));
    expect(strokes).toHaveLength(42);
    expect(strokes.every(s => s.color.startsWith('var(--ma-'))).toBe(true);
    expect(new Set(strokes.map(s => `${s.color}:${s.dash}`)).size).toBe(42);
  });
});
