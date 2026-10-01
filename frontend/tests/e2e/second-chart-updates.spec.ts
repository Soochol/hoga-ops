import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

test('초봉 증분 갱신은 실제 차트에서 지연 체결·새 봉·과거 추가 후에도 MA와 배율을 유지한다', async ({ page }) => {
  await installLiveMocks(page);
  await page.goto('/live?code=098460');
  const result = await page.evaluate(async () => {
    const chartsPath = '/node_modules/lightweight-charts/dist/lightweight-charts.development.mjs';
    const writerPath = '/src/live/workspace/secondChartSeriesWriter.ts';
    const axisPath = '/src/util/virtualAxis.ts';
    const projectorsPath = '/src/live/workspace/secondAggregateProjectors.ts';
    const { createChart, CandlestickSeries, HistogramSeries, LineSeries } = await import(chartsPath);
    const { createSecondChartSeriesWriter } = await import(writerPath);
    const { createVirtualAxis } = await import(axisPath);
    const { movingAverageSeconds } = await import(projectorsPath);
    const element = document.createElement('div');
    element.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:400px;z-index:100000';
    document.body.append(element);
    const chart = createChart(element, { width: 800, height: 400 });
    try {
      const candles = chart.addSeries(CandlestickSeries, { upColor: '#ff0000', downColor: '#0000ff' });
      const volume = chart.addSeries(HistogramSeries);
      const ma = chart.addSeries(LineSeries);
      let replacements = 0, updates = 0;
      for (const series of [candles, volume, ma]) {
        const setData = series.setData.bind(series), update = series.update.bind(series);
        series.setData = (data: unknown) => { replacements++; setData(data); };
        series.update = (point: unknown, historical: boolean) => { updates++; update(point, historical); };
      }
      const write = createSecondChartSeriesWriter({ candles, volume, ma });
      const open = Date.parse('2026-09-30T09:00:00+09:00');
      const bars = Array.from({length: 10000}, (_, i) => ({ t_ms: open+i*1000,
        open: 100,high: 110,low: 90,close: 100+i%7,volume: 10,count: 1,trade_value: 1000 }));
      const axisFor = (data: typeof bars) => createVirtualAxis([{date: '20260930',sessionOpenMs: data[0].t_ms,sessionCloseMs: data.at(-1)!.t_ms}], data[0].t_ms);
      write(bars, axisFor(bars));
      chart.timeScale().setVisibleLogicalRange({from: 9950, to: 9999});
      const spacing = chart.timeScale().options().barSpacing;
      replacements = 0; updates = 0;
      const tail = bars.map((b, i) => i === bars.length-1 ? {...b,close: 95} : b);
      write(tail, axisFor(tail));
      const tailWrites = { replacements, updates, color: volume.data().at(-1).color };
      const next = [...tail.map((b, i) => i === 30 ? {...b,close: 90} : b), {...tail.at(-1)!,t_ms: open+10000*1000,close: 102}];
      write(next,axisFor(next));
      const values = (points: {time: number; value: number}[]) => points.map(p => [p.time, p.value]);
      const maCorrect = JSON.stringify(values(ma.data())) === JSON.stringify(values(movingAverageSeconds(next,20)));
      const prepended = [{...next[0],t_ms: open-1000},...next];
      write(prepended,axisFor(prepended));
      return {tailWrites, maCorrect, bars: candles.data().length,
        spacing, finalSpacing: chart.timeScale().options().barSpacing};
    } finally { chart.remove(); element.remove(); }
  });
  expect(result.tailWrites).toEqual({replacements: 0,updates: 3,color: '#0000ff'});
  expect(result.maCorrect).toBe(true);
  expect(result.bars).toBe(10002);
  expect(result.finalSpacing).toBe(result.spacing);
});
