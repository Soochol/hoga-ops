import { expect, it, vi } from 'vitest';
import type { Candle } from '../api/types';
import { createVirtualAxis } from '../util/virtualAxis';
import { drawnCandleIndex } from './drawnCandleIndex';
const open = Date.parse('2026-09-30T09:00:00+09:00');
const axisFor = (start = open) => createVirtualAxis([
  { date: '20260930', sessionOpenMs: start, sessionCloseMs: open + 23_400_000 },
], start);
const candle = (ts_ms: number, close = 100): Candle => ({ ts_ms, open: 100, high: 110, low: 90, close, vol_a: 1, vol_b: 2 });

it('shares projection, retains maps for price corrections and refreshes all candle objects', () => {
  const realAxis = axisFor();
  const project = vi.fn(realAxis.classifyAndProject);
  const axis = { ...realAxis, classifyAndProject: project };
  const source = [candle(open - 60_000), ...Array.from({ length: 1000 }, (_, i) => candle(open + i * 1000))];
  const first = drawnCandleIndex(source, axis);
  expect(drawnCandleIndex(source, axis)).toBe(first);
  project.mockClear();
  const updated = source.map((c, i) => i === 7 || i === source.length - 1 ? { ...c, close: 109 } : c);
  const next = drawnCandleIndex(updated, axis);
  expect(next.vsecToIndex).toBe(first.vsecToIndex);
  expect(next.tsMsToIndex).toBe(first.tsMsToIndex);
  expect(next.drawn[6]).toBe(updated[7]);
  expect(next.drawn.at(-1)?.close).toBe(109);
  expect(project).not.toHaveBeenCalled();
  const appended = drawnCandleIndex([...updated, candle(open + 1000_000)], axis);
  expect(project).toHaveBeenCalledTimes(1);
  expect(appended.drawn).toHaveLength(1001);
  expect(first.tsMsToIndex.has(open + 1000_000)).toBe(false);
});

it('rebuilds on timestamp changes, prepends, deletions and a different session axis', () => {
  const axis = axisFor();
  const initial = [candle(open + 60_000), candle(open + 120_000)];
  drawnCandleIndex(initial, axis);
  for (const source of [
    [candle(open), ...initial], [candle(open), candle(open + 90_000)], [candle(open + 90_000)],
  ]) {
    const index = drawnCandleIndex(source, axis);
    expect(index.drawn).toEqual(source);
    expect([...index.tsMsToIndex]).toEqual(source.map((c, i) => [c.ts_ms, i]));
    expect([...index.vsecToIndex]).toEqual(source.map((c, i) => [axis.toVirtual(c.ts_ms) / 1000, i]));
  }
  expect(drawnCandleIndex(initial, axisFor(open + 120_000)).drawn).toEqual([initial[1]]);
});

it('looks up sorted grids and retains exact missing-key and iteration semantics', () => {
  const axis = axisFor();
  const source = Array.from({ length: 1000 }, (_, i) => candle(open + i * 1000));
  const index = drawnCandleIndex(source, axis);
  for (const [lookup, key] of [[index.tsMsToIndex, open], [index.vsecToIndex, axis.toVirtual(open) / 1000]] as const) {
    const stride = lookup === index.tsMsToIndex ? 1000 : 1;
    expect(lookup.size).toBe(1000);
    expect(lookup.get(key)).toBe(0);
    expect(lookup.get(key + 500 * stride)).toBe(500);
    expect(lookup.get(key + 999 * stride)).toBe(999);
    expect(lookup.get(key - stride)).toBeUndefined();
    expect(lookup.get(key + 1000 * stride)).toBeUndefined();
    expect(lookup.get(key + stride / 2)).toBeUndefined();
    expect(lookup.has(key)).toBe(true);
    expect(lookup.has(NaN)).toBe(false);
    expect([...lookup.keys()]).toEqual(source.map((_, i) => key + i * stride));
    expect([...lookup.values()]).toEqual(source.map((_, i) => i));
    const entries: [number, number][] = [];
    lookup.forEach((value, k, map) => { expect(map).toBe(lookup); entries.push([k, value]); });
    expect(entries).toEqual([...lookup.entries()]);
  }
});

it('keeps duplicate and unsorted timestamp lookup behavior including calendar keys', () => {
  const axis = axisFor();
  const source = [candle(open + 2000), candle(open), candle(open + 2000, 105), candle(open + 1000)];
  const index = drawnCandleIndex(source, axis);
  expect([...index.tsMsToIndex]).toEqual([[open + 2000, 2], [open, 1], [open + 1000, 3]]);
  expect(index.tsMsToIndex.get(open + 2000)).toBe(2);
  expect([...index.vsecToIndex]).toEqual([...new Map(source.map((c, i) => [axis.toVirtual(c.ts_ms) / 1000, i]))]);
  const calendar = { ...axis, classifyAndProject: () => ({ contained: true, inAuction: false, virtual: 0 }) };
  const repeated = drawnCandleIndex(source, calendar);
  expect([...repeated.vsecToIndex]).toEqual([[0, 3]]);
  expect(repeated.vsecToIndex.get(0)).toBe(3);
});
