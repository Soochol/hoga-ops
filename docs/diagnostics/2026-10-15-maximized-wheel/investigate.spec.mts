import { test, expect } from '../../../frontend/node_modules/@playwright/test/index.mjs';
import { installLiveMocks } from '../../../frontend/tests/e2e/helpers/liveMocks';
import { apiExact } from '../../../frontend/tests/e2e/helpers/apiRoutes';
import { writeFileSync, readFileSync } from 'node:fs';
const baseline = process.env.HOGA_WHEEL_BASELINE === '1';

for (const width of [1400, 2766]) {
  test(`measure actual maximized chart at viewport ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1100 });
    await page.clock.setFixedTime(new Date('2026-10-15T22:00:00+09:00'));
    await installLiveMocks(page);
    await page.routeWebSocket(/\/api\/ws/, () => {});
    const end = Date.UTC(2026, 9, 1);
    const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');
    const rows = JSON.parse(readFileSync(new URL('./034020-3m.json', import.meta.url), 'utf8')).candles;
    await page.route(apiExact('live/series'), route => route.fulfill({ json: {
      code: '034020', date: '20261015', session_open_ms: end,
      session_close_ms: end + 390 * 60000, is_open: false, snapshots: [], trades: [], brokers: [],
    } }));
    await page.route(apiExact('live/past-candles'), route => {
      const p = new URL(route.request().url()).searchParams;
      return route.fulfill({ json: { code: '034020', from: p.get('from'), to: p.get('to'), bucket_ms: 180000,
        candles: rows.filter(c => ymd(c.t_ms) >= p.get('from')! && ymd(c.t_ms) <= p.get('to')!),
        cached_dates: [], fresh_dates: [], data_warnings: [] } });
    });
    await page.goto('/live?code=034020');
    const id = await page.evaluate(async () => {
      const path = '/src/state/workspace.ts';
      const { useWorkspaceStore: store } = await import(path);
      const win = store.getState().windows.find(w => w.kind === 'chart');
      store.getState().setChartTimeframe(win.id, '3m');
      return win.id;
    });
    await expect.poll(() => page.evaluate(id => window.__liveCharts?.get(id)?.panes()[0]
      .getSeries().find(s => s.seriesType() === 'Candlestick')?.data().length ?? 0, id)).toBeGreaterThan(300);
    await expect(page.getByTestId('chart-reveal-cover').first()).toHaveCSS('opacity', '0');
    const results = [];
    for (const maximized of [false, true, false]) {
      if (maximized || results.length) {
        await page.evaluate(async id => {
          const path = '/src/state/workspace.ts';
          const { useWorkspaceStore: store } = await import(path);
          store.getState().toggleMaximize(id);
        }, id);
      }
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const result = await page.evaluate(async id => {
        const c = window.__liveCharts.get(id);
        const ts = c.timeScale();
        const series = c.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick');
        const last = series.data().at(-1);
        const index = ts.timeToIndex(last.time);
        const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const result = [];
        for (const historical of [false, true]) for (const span of [420, 100, 10, 3]) {
          const anchorIndex = historical ? index - 200 : index;
          const anchorTime = series.dataByIndex(anchorIndex, -1).time;
          ts.setVisibleLogicalRange(historical ? { from: anchorIndex - span, to: anchorIndex }
            : { from: index - .7 * (span + 1) + .5, to: index + .3 * (span + 1) - .5 });
          await frame(); await frame();
          const read = () => ({ x: ts.timeToCoordinate(anchorTime), width: ts.width(),
            axisWidth: c.priceScale('right').width(), minimumWidth: c.options().rightPriceScale.minimumWidth,
            range: ts.getVisibleLogicalRange(), spacing: ts.options().barSpacing });
          const samples = [read()];
          for (let i = 0; i < 10; i++) {
            const rect = c.chartElement().getBoundingClientRect();
            c.chartElement().querySelector('canvas').dispatchEvent(new WheelEvent('wheel', {
              bubbles: true, cancelable: true, deltaY: i % 2 ? 120 : -120,
              clientX: rect.left + ts.width() - 20, clientY: rect.top + 100,
            }));
            await frame(); samples.push(read());
          }
          const reference = [];
          if (historical) {
            // A diagnostic counterfactual, not a product change: fix this same
            // visible candle's centre instead of keeping the numeric `to`.
            ts.setVisibleLogicalRange({ from: anchorIndex - span, to: anchorIndex });
            await frame();
            reference.push(read());
            for (let i = 0; i < 10; i++) {
              const range = ts.getVisibleLogicalRange();
              const count = range.to - range.from + 1;
              const nextCount = count * Math.exp((i % 2 ? 120 : -120) * .001);
              const to = anchorIndex - .5 + (range.to - anchorIndex + .5) * nextCount / count;
              ts.setVisibleLogicalRange({ from: to - nextCount + 1, to });
              await frame(); reference.push(read());
            }
          }
          result.push({ historical, span, samples, reference,
            drift: Math.max(...samples.map(s => Math.abs(s.x - samples[0].x))),
            referenceDrift: reference.length ? Math.max(...reference.map(s => Math.abs(s.x - reference[0].x))) : null });
        }
        return result;
      }, id);
      results.push({ maximized, result });
    }
    writeFileSync(new URL(`./${baseline ? 'measurement' : 'fixed'}-${width}-${info.project.name}.json`, import.meta.url), JSON.stringify(results, null, 2) + '\n');
    for (const r of results) for (const s of r.result) {
      expect(new Set(s.samples.map(p => p.width)).size).toBe(1);
      if (s.historical && baseline) {
        const predicted = .5 * s.samples[0].width / (s.span + 1) * (Math.exp(.12) - 1);
        expect(s.drift).toBeCloseTo(predicted, 6);
        expect(s.referenceDrift).toBeLessThan(.01);
      } else expect(s.drift).toBeLessThan(.01);
    }
    console.log(JSON.stringify({ width, results: results.map(r => ({ maximized: r.maximized,
      spans: r.result.map(s => ({ historical: s.historical, span: s.span, drift: s.drift, width: s.samples[0].width,
        widths: [...new Set(s.samples.map(p => p.width))] })) })) }));
  });
}
