import { expect, it, vi } from 'vitest';
import type { SecondBar } from '../../api/secondAggregates';
import { createVirtualAxis } from '../../util/virtualAxis';
import { createSecondChartSeriesWriter } from './secondChartSeriesWriter';
import { movingAverageSeconds } from './secondAggregateProjectors';

const open = Date.parse('2026-09-30T09:00:00+09:00');
const bar = (i: number): SecondBar => ({ t_ms: open+i*1000,open: 100,high: 110,low: 90,close: 100+i%7,volume: 10,count: 1,trade_value: 1000 });
const axis = (bars: readonly SecondBar[]) => createVirtualAxis([{date: '20260930',sessionOpenMs: bars[0]?.t_ms ?? open,sessionCloseMs: bars.at(-1)?.t_ms ?? open}], bars[0]?.t_ms ?? open);
function harness() {
  const candleData = new Map<number, unknown>(), volumeData = new Map<number, unknown>(), maData = new Map<number, unknown>();
  const series = (data: Map<number, unknown>) => ({
    setData: vi.fn((points: {time: number}[]) => { data.clear(); for (const p of points) data.set(p.time,p); }),
    update: vi.fn((p: {time: number}, _historical?: boolean) => { data.set(p.time,p); }),
    options: () => ({upColor: 'red',downColor: 'blue'}),
  });
  const candles = series(candleData),volume = series(volumeData),ma = series(maData);
  const write = createSecondChartSeriesWriter({candles, volume, ma} as unknown as Parameters<typeof createSecondChartSeriesWriter>[0]);
  return {write,candles,volume,ma,candleData,volumeData,maData};
}

it('keeps MA correct for late corrections, appended bars and volume color changes', () => {
  const h = harness();
  const bars = Array.from({length: 100}, (_, i) => bar(i));
  h.write(bars,axis(bars));
  const next = [...bars.map((b, i) => i === 30 ? {...b,close: 80} : b),bar(100),bar(101)];
  h.write(next,axis(next));
  expect(h.candles.setData).toHaveBeenCalledTimes(1);
  expect(h.candles.update).toHaveBeenCalledTimes(3);
  expect(h.candles.update.mock.calls[0][1]).toBe(true);
  expect(h.volumeData.get(open/1000+30)).toMatchObject({color: 'blue'});
  expect([...h.maData.values()]).toEqual(movingAverageSeconds(next,20));
});

it('resets for insertion, removal and an axis origin change, including unchanged bar references', () => {
  const h = harness();
  const bars = Array.from({length: 30}, (_, i) => bar(i));
  h.write(bars,axis(bars));
  const inserted = [{...bar(0),t_ms: open-1000},...bars];
  h.write(inserted,axis(inserted));
  h.write(bars,axis(bars));
  h.write(bars,createVirtualAxis([{date: '20260930',sessionOpenMs: open,sessionCloseMs: bars.at(-1)!.t_ms}],0));
  expect(h.candles.setData).toHaveBeenCalledTimes(4);
  expect(h.candles.update).not.toHaveBeenCalled();
});

it('does not manufacture MA values before 20 observed bars and clears obsolete data', () => {
  const h = harness();
  const short = Array.from({length: 19}, (_, i) => bar(i));
  h.write(short,axis(short));
  expect(h.maData.size).toBe(0);
  const next = [...short,bar(19)];
  h.write(next,axis(next));
  expect([...h.maData.values()]).toEqual(movingAverageSeconds(next,20));
  h.write([],axis([]));
  expect(h.candleData.size).toBe(0);
  expect(h.volumeData.size).toBe(0);
  expect(h.maData.size).toBe(0);
});
