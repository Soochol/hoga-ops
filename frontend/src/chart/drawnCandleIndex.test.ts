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
