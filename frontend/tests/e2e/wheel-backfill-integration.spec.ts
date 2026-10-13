import { test, expect } from '@playwright/test';
import type { IChartApi, Time } from 'lightweight-charts';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

type ChartsWindow = Window & { __liveCharts: Map<string, IChartApi> };
const dayMs = 86400000;
const end = Date.UTC(2026, 9, 1);
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');
const seedFrom = ymd(end - 60 * dayMs);
const historyFrom = ymd(end - 75 * dayMs);
const all = Array.from({ length: 90 }, (_, i) => end - (89 - i) * dayMs)
  .filter(ms => ![0, 6].includes(new Date(ms).getUTCDay()))
  .flatMap(ms => Array.from({ length: 130 }, (_, i) => {
    const t_ms = ms + i * 180000;
    const close = 350000 + (t_ms - end) / 60000;
    return { t_ms, open: close - 1, high: close + 2, low: close - 2, close, volume: 100 };
  }));

for (const ctrl of [false, true]) {
  test(`3m history response and same-frame ${ctrl ? 'Ctrl' : 'plain'} wheel preserve the viewed date`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1800, height: 1000 });
    await page.clock.setFixedTime(new Date('2026-10-01T17:00:00+09:00'));
    await installLiveMocks(page);
    await page.routeWebSocket(/\/api\/ws/, () => {});
    await page.route(apiExact('live/series'), route => route.fulfill({ json: {
      code: '098460', date: '20261001', session_open_ms: end,
      session_close_ms: end + 390 * 60000, is_open: false,
      snapshots: [], trades: [], brokers: [],
    } }));
    let armed = false;
    let requests = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route(apiExact('live/past-candles'), async route => {
      const p = new URL(route.request().url()).searchParams;
      const from = armed ? p.get('from')! : seedFrom;
      const to = p.get('to')!;
      if (armed) { requests++; await gate; }
      await route.fulfill({ json: { code: '098460', from, to, bucket_ms: 180000,
        candles: all.filter(c => ymd(c.t_ms) >= from && ymd(c.t_ms) <= to),
        cached_dates: [], fresh_dates: [], data_warnings: [] } });
    });
    await page.goto('/live?code=098460');
    const id = await page.evaluate(async () => {
      const path = '/src/state/workspace.ts';
      const { useWorkspaceStore: store } = await import(path);
      const win = store.getState().windows.find((w: { kind: string }) => w.kind === 'chart');
      store.getState().setChartTimeframe(win.id, '3m');
      return win.id as string;
    });
    const count = () => page.evaluate(id => (window as unknown as ChartsWindow).__liveCharts.get(id)
      ?.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')?.data().length ?? 0, id);
    await expect.poll(count).toBeGreaterThan(4000);
    await expect(page.getByTestId('chart-reveal-cover').first()).toHaveCSS('opacity', '0');
    await expect(page.locator('[data-drawing-overlay]').first()).toHaveAttribute('data-day-extremes-ready', 'true');
    await page.evaluate(async id => {
      const c = (window as unknown as ChartsWindow).__liveCharts.get(id)!;
      c.timeScale().setVisibleLogicalRange({ from: 1800, to: 2100 });
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }, id);
    armed = true;
    const before = await page.evaluate(({ id, ctrl }) => {
      const c = (window as unknown as ChartsWindow).__liveCharts.get(id)!;
      const s = c.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!;
      const ts = c.timeScale();
      const rect = c.chartElement().getBoundingClientRect();
      const mouseX = ts.width() * .45;
      const anchor = s.dataByIndex(ctrl ? Math.round(ts.coordinateToLogical(mouseX)!) : 2100, -1) as { time: Time; close: number };
      const read = () => {
        const row = s.data().find(p => 'close' in p && p.close === anchor.close)!;
        return { x: ts.timeToCoordinate(row.time)!, count: s.data().length };
      };
      let fired = false;
      const capture: { after?: ReturnType<typeof read> } = {};
      const initial = read();
      // The production query commit flushes the adapter before data-changed
      // callbacks. Inject the next wheel exactly in that pending-draw interval.
      s.subscribeDataChanged(() => {
        if (fired || s.data().length <= initial.count) return;
        fired = true;
        c.chartElement().querySelector('canvas')!.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true, deltaY: 120, ctrlKey: ctrl,
          clientX: rect.left + mouseX, clientY: rect.top + 100,
        }));
        requestAnimationFrame(() => requestAnimationFrame(() => { capture.after = read(); }));
      });
      (window as unknown as { wheelBackfillEvidence: typeof capture }).wheelBackfillEvidence = capture;
      return { ...initial, anchorClose: anchor.close };
    }, { id, ctrl });
    await page.evaluate(async ({ id, from }) => {
      const path = '/src/state/workspace.ts';
      const { useWorkspaceStore: store } = await import(path);
      store.getState().extendChartHistoricalRange(id, from);
    }, { id, from: historyFrom });
    await expect.poll(() => requests).toBeGreaterThan(0);
    release();
    await expect.poll(count).toBeGreaterThan(before.count);
    const readEvidence = () => page.evaluate(() => (window as unknown as {
      wheelBackfillEvidence: { after?: { x: number; count: number } };
    }).wheelBackfillEvidence.after);
    await expect.poll(readEvidence).toBeDefined();
    const after = (await readEvidence())!;
    await info.attach('backfill-anchor', { body: JSON.stringify({ ctrl, before, after }), contentType: 'application/json' });
    expect(after.count).toBeGreaterThan(before.count);
    if (ctrl) expect(Math.abs(after.x - before.x)).toBeLessThan(1);
    else {
      const rightClose = await page.evaluate(id => {
        const c = (window as unknown as ChartsWindow).__liveCharts.get(id)!;
        const s = c.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!;
        return (s.dataByIndex(Math.floor(c.timeScale().getVisibleLogicalRange()!.to), -1) as { close: number }).close;
      }, id);
      expect(rightClose).toBe(before.anchorClose);
    }
  });
}
