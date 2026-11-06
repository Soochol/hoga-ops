import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

test('real native adapter preserves Ichimoku scale and cloud across changing nonzero window offsets', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const evidence = await page.evaluate(async () => {
    const lwcPath = '/node_modules/lightweight-charts/dist/lightweight-charts.development.mjs';
    const adapterPath = '/src/chart/windowedChart.ts', primitivePath = '/src/chart/IchimokuPrimitive.ts', projectorPath = '/src/chart/projectors/ichimoku.ts';
    const { createChart, CandlestickSeries } = await import(lwcPath);
    const { createWindowedChart, flushWindowedChart, windowedChartDiagnostics } = await import(adapterPath);
    const { IchimokuPrimitive } = await import(primitivePath), { projectIchimoku } = await import(projectorPath);
    const host = document.createElement('div');
    host.setAttribute('data-testid', 'isolated-native-ichimoku-probe');
    Object.assign(host.style, { position: 'fixed', left: '30px', top: '100px', width: '900px', height: '650px', zIndex: '9999', background: '#ffffff' });
    document.body.appendChild(host);
    const native = createChart(host, { width: 900, height: 650, layout: { background: { color: '#ffffff' }, textColor: '#333333' }, timeScale: { barSpacing: 7 } });
    const chart = createWindowedChart(native);
    const candle = chart.addSeries(CandlestickSeries, { priceLineVisible: false, lastValueVisible: false, upColor: '#777777', downColor: '#777777', wickUpColor: '#777777', wickDownColor: '#777777' });
    const rows = Array.from({ length: 8000 }, (_, i) => {
      const close = 100 + i * .01 + Math.sin(i / 20) * 5;
      return { time: 1600000000 + i * 60, open: close - .2, high: close + 1, low: close - 1, close };
    });
    candle.setData(rows); flushWindowedChart(chart);
    const nativeCandle = native.panes()[0].getSeries()[0];
    const nativeCalls: { from: number; to: number }[] = [], applicationCalls: { from: number; to: number; bounds: unknown }[] = [];
    const attach = nativeCandle.attachPrimitive.bind(nativeCandle);
    nativeCandle.attachPrimitive = (primitive: { autoscaleInfo: (from: number, to: number) => unknown }) => attach(new Proxy(primitive, {
      get(target, key) {
        if (key === 'autoscaleInfo') return (from: number, to: number) => { nativeCalls.push({ from, to }); return target.autoscaleInfo(from, to); };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      },
    }));
    const primitive = new IchimokuPrimitive(), autoscale = primitive.autoscaleInfo.bind(primitive);
    primitive.autoscaleInfo = (from: number, to: number) => { const bounds = autoscale(from, to); applicationCalls.push({ from, to, bounds }); return bounds; };
    candle.attachPrimitive(primitive);
    const model = projectIchimoku(rows.map(row => ({ virtualSecond: row.time, high: row.high, low: row.low, close: row.close, breakBefore: false })), { conversion: 9, base: 26, leadingB: 52, displacement: 26 });
    primitive.setSnapshot({ model, candleOnlyScale: false, candleAlwaysOnTop: false, style: { lineWidth: 2,
      lines: { conversion: { visible: false, color: '#F97316' }, base: { visible: false, color: '#3B82F6' }, leadingA: { visible: true, color: '#EF4444' }, leadingB: { visible: true, color: '#8B5CF6' }, lagging: { visible: false, color: '#10B981' } },
      cloud: { visible: true, positiveColor: '#EF4444', negativeColor: '#3B82F6', opacity: .2 } } });
    const steps = [];
    for (const from of [1900, 5900, 1900]) {
      nativeCalls.length = 0; applicationCalls.length = 0;
      chart.timeScale().setVisibleLogicalRange({ from, to: from + 100 }); flushWindowedChart(chart);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rawDiagnostics = windowedChartDiagnostics(chart), diagnostics = { fullPoints: rawDiagnostics.fullPoints, renderedPoints: rawDiagnostics.renderedPoints, offset: rawDiagnostics.offset, fallback: rawDiagnostics.fallback }, observed = chart.timeScale().getVisibleLogicalRange();
      const display = from + 50, a = model.lines.leadingA.values[display - 26]!, b = model.lines.leadingB.values[display - 26]!;
      const x = chart.timeScale().logicalToCoordinate(display), yA = candle.priceToCoordinate(a), yB = candle.priceToCoordinate(b);
      const canvas = [...host.querySelectorAll('canvas')].find(c => c.clientWidth >= chart.timeScale().width() - 2)!;
      const ratio = canvas.width / canvas.clientWidth;
      const pixels = canvas.getContext('2d')!.getImageData(Math.floor(x * ratio) - 4, Math.floor(yA * ratio) - 4, 9, 9).data;
      let red = false;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 200 && pixels[i + 1] < 120 && pixels[i + 2] < 120 && pixels[i + 3] > 0) red = true;
      steps.push({ requested: { from, to: from + 100 }, observed, diagnostics, nativeCalls: [...nativeCalls], applicationCalls: [...applicationCalls], sample: { display, x, a, b, yA, yB, red, height: chart.panes()[0].getHeight() }, sourceRows: candle.data().length, nativeRows: nativeCandle.data().length });
    }
    const result = { fixture: 'Separate diagnostic fixture with8000 known synthetic historical candles. No productjourney/state is replaced and no future timestamp key exists.', sourceTimeKeys: rows.length, steps };
    return result;
  });
  for (const step of evidence.steps) {
    expect(step.diagnostics.offset).toBeGreaterThan(0);
    expect(step.sourceRows).toBe(8000); expect(step.nativeRows).toBeLessThan(4000);
    expect(step.observed).toEqual(step.requested);
    expect(step.nativeCalls.length).toBeGreaterThan(0); expect(step.applicationCalls.length).toBe(step.nativeCalls.length);
    step.nativeCalls.forEach((call: { from: number; to: number }, i: number) => {
      expect(step.applicationCalls[i].from).toBe(call.from + step.diagnostics.offset);
      expect(step.applicationCalls[i].to).toBe(call.to + step.diagnostics.offset);
    });
    expect(step.sample.red).toBe(true);
    expect(step.sample.yA).toBeGreaterThan(0); expect(step.sample.yA).toBeLessThan(step.sample.height);
    expect(step.sample.yB).toBeGreaterThan(0); expect(step.sample.yB).toBeLessThan(step.sample.height);
  }
  expect(evidence.steps[0].diagnostics.offset).not.toBe(evidence.steps[1].diagnostics.offset);
  expect(evidence.steps[2].diagnostics.offset).toBe(evidence.steps[0].diagnostics.offset);
  expect(evidence.steps[2].sample).toEqual(evidence.steps[0].sample);
  mkdirSync(path.resolve('../.audit/preview'), { recursive: true });
  writeFileSync(path.resolve('../.audit/preview/native-window-offsets.json'), JSON.stringify(evidence, null, 2));
  await page.getByTestId('isolated-native-ichimoku-probe').screenshot({ path: path.resolve('../.audit/preview/ichimoku-native-window-offset.png') });
});
