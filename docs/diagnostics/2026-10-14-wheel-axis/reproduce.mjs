import { chromium } from '../../../frontend/node_modules/playwright/index.mjs';
import { writeFile } from 'node:fs/promises';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.route('http://127.0.0.1:21044/', r => r.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"><script>window.$RefreshSig$=()=>type=>type;window.$RefreshReg$=()=>{};window.__vite_plugin_react_preamble_installed=true;</script></body></html>' }));
  await page.goto('http://127.0.0.1:21044/');
  const result = await page.evaluate(async () => {
    const { createChart, CandlestickSeries, HistogramSeries } = await import('/node_modules/lightweight-charts/dist/lightweight-charts.development.mjs');
    const { retainRightPriceScaleWidth } = await import('/src/chart/util/retainRightPriceScaleWidth.ts');
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const host = document.createElement('div'); document.body.append(host);
    const chart = createChart(host, { width: 704, height: 500, handleScale: { mouseWheel: false } });
    const series = chart.addSeries(CandlestickSeries, { priceLineVisible: false, lastValueVisible: false });
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'custom', minMove: 1, formatter: v => `${Math.round(v / 1000)}K` }, priceLineVisible: false, lastValueVisible: false }, 1);
    const events = [];
    chart.timeScale().subscribeSizeChange((width) => events.push({ plotWidth: width, expectedAxisWidth: 704 - width, reportedAxisWidth: chart.priceScale('right').width(), minimumWidth: chart.options().rightPriceScale.minimumWidth }));
    const cleanup = retainRightPriceScaleWidth(chart);
    const makeRows = price => Array.from({ length: 300 }, (_, i) => ({ time: 1700000000 + i * 60, open: price, high: price * 1.01, low: price * .99, close: price }));
    const states = [];
    for (const price of [100, 100000, 100, 100000, 100]) {
      series.setData(makeRows(price));
      volume.setData(makeRows(price).map(r => ({time: r.time, value: price})));
      chart.timeScale().setVisibleLogicalRange({from: 0, to: 420});
      await frame();
      states.push({price, plotWidth: chart.timeScale().width(), axisWidth: chart.priceScale('right').width(), minimumWidth: chart.options().rightPriceScale.minimumWidth});
    }
    cleanup(); chart.remove();
    const { mount } = await import('/tests/e2e/helpers/wheelViewportHarness.tsx');
    const h = await mount(true, 4000);
    const ts = h.chart.timeScale();
    const wheelInBlankArea = deltaY => {
      const element = h.chart.chartElement();
      const rect = element.getBoundingClientRect();
      element.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, deltaY,
        clientX: rect.left + ts.width() - 20, clientY: rect.top + 200,
      }));
    };
    const samples = [];
    for (const span of [420, 100, 30, 10, 3, 1]) {
      ts.setVisibleLogicalRange({from: 3999 - span * .7, to: 3999 + span * .3}); await h.frame();
      for (let n = 0; n < 6; n++) {
        samples.push({ span, n, range: ts.getVisibleLogicalRange(), latestX: ts.timeToCoordinate(h.rows.at(-1).time), width: ts.width(), axisWidth: h.chart.priceScale('right').width() });
        wheelInBlankArea(n % 2 === 0 ? -120 : 120); await h.frame();
      }
    }
    const corrected = [];
    for (const span of [420, 100, 30, 10, 3, 1]) {
      ts.setVisibleLogicalRange({from: 3999 - span * .7, to: 3999 + span * .3}); await h.frame();
      const beforeX = ts.timeToCoordinate(h.rows.at(-1).time);
      const positions = [beforeX];
      for (let n = 0; n < 6; n++) {
        const r = ts.getVisibleLogicalRange();
        const bars = r.to - r.from + 1;
        const nextBars = Math.max(2, bars * Math.exp((n % 2 === 0 ? -120 : 120) * .001));
        const nextTo = 3999 - .5 + (r.to - 3999 + .5) * nextBars / bars;
        ts.setVisibleLogicalRange({from: nextTo - nextBars + 1, to: nextTo});
        await h.frame(); positions.push(ts.timeToCoordinate(h.rows.at(-1).time));
      }
      corrected.push({span,positions,maxPixelDrift:Math.max(...positions.map(x => Math.abs(x - beforeX)))});
    }
    return {events,states,wheel:samples,corrected};
  });
  await writeFile(new URL('./measurements.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({axis: result.states, current: [420,100,30,10,3,1].map(span => {const xs=result.wheel.filter(s=>s.span===span).map(s=>s.latestX);return {span,pixelDrift:Math.max(...xs)-Math.min(...xs)};}), proposed: result.corrected.map(({span,maxPixelDrift})=>({span,maxPixelDrift}))}, null, 2));
} finally {
  await browser.close();
}
