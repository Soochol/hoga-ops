import snapshotText from '../../public/market-breadth/snapshot.json?raw';
import { describe, expect, it } from 'vitest';
import { chartPath } from './chartGeometry';
import { etfImprovementCounts, parseReport, selectedCodes, type BreadthReport } from './report';

const snapshot = JSON.parse(snapshotText) as BreadthReport;

describe('confirmed breadth report', () => {
  it('accepts the real report and reconciles both stock-level decompositions', () => {
    const r = parseReport(snapshot);
    expect(r.baseline.score).toBeCloseTo(15.6533892382949, 10);
    expect(r.funds.filter(f => f.status === 'ready')).toHaveLength(42);
    expect(r.funds.filter(f => f.status === 'ready' && f.style === 'active')).toHaveLength(4);
    for (const horizon of ['5', '20'] as const) {
      const c = r.changes[horizon];
      expect(c.stocks.reduce((sum, s) => sum + s.contribution, 0)).toBeCloseTo(c.change, 10);
      expect(c.positive + c.negative).toBeCloseTo(c.change, 10);
      expect(c.improved + c.declined + c.unchanged).toBe(477);
    }
    expect(r.changes['5']).toMatchObject({ improved: 49, declined: 61, unchanged: 367 });
    expect(r.changes['20'].cancelling).toBe(5);
  });
  it('rejects a wrong schema, series alignment, and broken attribution', () => {
    expect(() => parseReport('<html>')).toThrow();
    expect(() => parseReport({ ...snapshot, schemaVersion: 2 })).toThrow();
    expect(() => parseReport({ ...snapshot, dates: snapshot.dates.slice(1) })).toThrow();
    const broken = structuredClone(snapshot);
    broken.changes['5'].stocks[0].contribution += 1;
    expect(() => parseReport(broken)).toThrow(/합계/);
  });
  it('preserves clear-all and filters duplicate, unavailable, and malformed saved selections', () => {
    expect(selectedCodes([], snapshot.funds)).toEqual([]);
    expect(selectedCodes(['140700', '140700', null, 'invalid'], snapshot.funds)).toEqual(['140700']);
    const pending = snapshot.funds.find(f => f.status !== 'ready')!.code;
    expect(selectedCodes([pending], snapshot.funds)).toEqual([]);
    expect(selectedCodes(undefined, snapshot.funds)).toHaveLength(3);
  });
  it('breaks chart paths at missing dates, including an entirely empty series', () => {
    expect(chartPath([1, null, 3, 4], i => i, v => v)).toBe('M0.00,1.00 M2.00,3.00 L3.00,4.00');
    expect(chartPath([null, null], i => i, v => v)).toBe('');
  });
  it('keeps ETF-level spread distinct from unique-stock spread and requires the full cohort', () => {
    const five = etfImprovementCounts(snapshot.funds, 5);
    const twenty = etfImprovementCounts(snapshot.funds, 20);
    expect(five.at(-1)).toBe(10);
    expect(twenty.at(-1)).toBe(2);
    expect(five.filter(v => v !== null)).toHaveLength(19);
    expect(twenty.filter(v => v !== null)).toHaveLength(4);
    const missing = structuredClone(snapshot.funds);
    missing.find(f => f.status === 'ready')!.line[244] = null;
    expect(etfImprovementCounts(missing, 5).at(-1)).toBeNull();
  });
});
