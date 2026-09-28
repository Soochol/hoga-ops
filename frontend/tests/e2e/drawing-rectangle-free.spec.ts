import { expect, test } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

for (const timeframe of ['3m', 'D'] as const) {
  test(`${timeframe} rectangle follows sub-candle positions through creation, editing and reload`, async ({ page }, testInfo) => {
    await installLiveMocks(page);
    // A previously enabled preference must no longer alter drawing input.
    await page.addInitScript(() => {
      if (!localStorage.getItem('replay.drawingDefaults.v1')) {
        localStorage.setItem('replay.drawingDefaults.v1', JSON.stringify({ v: 2, value: { magnet: true } }));
      }
    });
    await page.route(/\/api\/live\/past-daily-candles\?/, route => route.fulfill({ json: {
      code: '098460', from: '20260527', to: '20260528', candles: [
        { t_ms: 1779840000000, open: 35000, high: 35250, low: 34900, close: 35200, volume: 300 },
        { t_ms: 1779926400000, open: 35200, high: 35300, low: 35150, close: 35250, volume: 200 },
      ], cached_batches: [], fresh_batches: [], data_warnings: [],
    } }));
    await page.goto('/live?code=098460');
    await expect(page.getByTestId('live-chart-root').first()).toBeVisible();
    await page.evaluate(async timeframe => {
      const path = '/src/state/workspace.ts';
      const { useWorkspaceStore } = await import(path);
      const state = useWorkspaceStore.getState();
      const win = state.windows.find((w: { kind: string }) => w.kind === 'chart');
      state.setChartTimeframe(win.id, timeframe);
      state.focusWindow(win.id);
    }, timeframe);
    await expect.poll(() => page.evaluate(() => {
      const charts = (window as unknown as { __liveCharts?: Map<string, import('lightweight-charts').IChartApi> }).__liveCharts;
      return charts?.values().next().value?.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')?.data().length ?? 0;
    })).toBe(2);
    // Fix the viewport to make a single candle wide enough for independent aiming.
    await page.evaluate(() => {
      const chart = (window as unknown as { __liveChart: import('lightweight-charts').IChartApi }).__liveChart;
      chart.timeScale().setVisibleLogicalRange({ from: -3, to: 6 });
    });
    await expect.poll(() => page.evaluate(() => {
      const chart = (window as unknown as { __liveChart: import('lightweight-charts').IChartApi }).__liveChart;
      return chart.timeScale().getVisibleLogicalRange()?.to;
    })).toBeCloseTo(6);
    const overlay = page.locator('[data-drawing-overlay]').first();
    await expect(overlay).toBeAttached();
    const target = await page.evaluate(() => {
      const chart = (window as unknown as { __liveChart: import('lightweight-charts').IChartApi }).__liveChart;
      const bounds = document.querySelector('[data-drawing-overlay]')!.getBoundingClientRect();
      const pitch = Number(chart.timeScale().logicalToCoordinate(1 as import('lightweight-charts').Logical))
        - Number(chart.timeScale().logicalToCoordinate(0 as import('lightweight-charts').Logical));
      return { x: bounds.left + Number(chart.timeScale().logicalToCoordinate(1 as import('lightweight-charts').Logical)), y: bounds.top + 100, pitch };
    });
    const left = target.x - target.pitch * 0.4;
    const right = target.x - target.pitch * 0.15;
    await page.keyboard.press('Alt+r');
    await page.mouse.move(left, target.y);
    await page.mouse.down();
    await page.mouse.move(right, target.y + 80, { steps: 6 });
    await page.mouse.up();
    const readRect = () => page.evaluate(async timeframe => {
      const path = '/src/state/drawings.ts';
      const { useDrawingsStore } = await import(path);
      return useDrawingsStore.getState().drawingsFor(`098460|${timeframe === 'D' ? 'D' : 'minute'}`)
        .find((d: { kind: string }) => d.kind === 'rect');
    }, timeframe);
    await expect.poll(readRect).toMatchObject({ kind: 'rect', subX: { a: expect.closeTo(-0.4, 2), b: expect.closeTo(-0.15, 2) } });
    const created = await readRect();
    expect(created.a.realMs).toBe(created.b.realMs);
    await page.screenshot({ path: testInfo.outputPath('free-rectangle-created.png') });
    await page.keyboard.press('Escape');
    const centerX = (left + right) / 2;
    await page.mouse.move(centerX, target.y + 40);
    await expect(overlay).toHaveCSS('pointer-events', 'auto');
    await page.mouse.down();
    await page.mouse.move(centerX + 4, target.y + 40, { steps: 4 });
    await page.mouse.up();
    const moved = await readRect();
    expect(moved.subX.a).toBeCloseTo(created.subX.a + 4 / target.pitch, 2);
    expect(moved.subX.b).toBeCloseTo(created.subX.b + 4 / target.pitch, 2);
    // The corrected top-left handle must be hittable where it was drawn.
    await page.mouse.move(left + 4, target.y);
    await page.mouse.down();
    await page.mouse.move(left + 10, target.y + 8, { steps: 4 });
    await page.mouse.up();
    const resized = await readRect();
    expect(resized.subX.a).toBeCloseTo(moved.subX.a + 6 / target.pitch, 2);
    expect(resized.subX.b).toBeCloseTo(moved.subX.b, 2);
    await page.screenshot({ path: testInfo.outputPath('free-rectangle-edited.png') });
    // Zoom the real chart, then aim inside the corrected box on the new scale.
    await page.evaluate(() => {
      const chart = (window as unknown as { __liveChart: import('lightweight-charts').IChartApi }).__liveChart;
      chart.timeScale().setVisibleLogicalRange({ from: -1, to: 4 });
    });
    await expect.poll(() => page.evaluate(() => {
      const chart = (window as unknown as { __liveChart: import('lightweight-charts').IChartApi }).__liveChart;
      return chart.timeScale().getVisibleLogicalRange()?.to;
    })).toBeCloseTo(4);
    const zoomed = await page.evaluate(rect => {
      const chart = (window as unknown as { __liveChart: import('lightweight-charts').IChartApi }).__liveChart;
      const series = chart.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!;
      const bounds = document.querySelector('[data-drawing-overlay]')!.getBoundingClientRect();
      const anchorX = Number(chart.timeScale().logicalToCoordinate(1 as import('lightweight-charts').Logical));
      const barPx = anchorX - Number(chart.timeScale().logicalToCoordinate(0 as import('lightweight-charts').Logical));
      return { x: bounds.left + anchorX + (rect.subX.a + rect.subX.b) / 2 * barPx,
        y: bounds.top + (Number(series.priceToCoordinate(rect.a.price)) + Number(series.priceToCoordinate(rect.b.price))) / 2 };
    }, resized);
    await page.mouse.move(zoomed.x, zoomed.y);
    await expect(overlay).toHaveCSS('pointer-events', 'auto');
    await page.screenshot({ path: testInfo.outputPath('free-rectangle-zoomed.png') });

    await expect.poll(() => page.evaluate(id => Object.values(localStorage).some(value => {
      try { return JSON.parse(value)?.items?.some((item: { id: string; subX?: unknown }) => item.id === id && item.subX); }
      catch { return false; }
    }), resized.id)).toBe(true);
    await page.reload();
    await expect.poll(readRect).toEqual(resized);
  });
}
