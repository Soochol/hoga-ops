import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

for (const timeframe of ['3m', 'D'] as const) {
  test(`${timeframe} day high/low tools create horizontal lines with undo`, async ({ page }, testInfo) => {
    await installLiveMocks(page);
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
    await expect.poll(async () => page.evaluate(() => {
      const charts = (window as unknown as { __liveCharts?: Map<string, import('lightweight-charts').IChartApi> }).__liveCharts;
      const chart = charts?.values().next().value;
      const series = chart?.panes()[0]?.getSeries().find(s => s.seriesType() === 'Candlestick');
      return series?.data().length ?? 0;
    })).toBeGreaterThan(0);
    await expect(page.locator('[data-drawing-overlay]').first()).toHaveAttribute('data-day-extremes-ready', 'true');
    const readDrawings = () => page.evaluate(async timeframe => {
      const path = '/src/state/drawings.ts';
      const { useDrawingsStore } = await import(path);
      return useDrawingsStore.getState().drawingsFor(`098460|${timeframe === 'D' ? 'D' : 'minute'}`);
    }, timeframe);
    for (const [key, side] of [['H', 'high'], ['L', 'low']] as const) {
      await page.keyboard.press(`Shift+${key}`);
      await expect(page.getByTestId('drawing-menu-trigger').first()).toHaveAttribute('aria-label', `그리기: 일자 ${side === 'high' ? '고점' : '저점'} 수평선`);
      const target = await page.evaluate(async side => {
        const charts = (window as unknown as { __liveCharts: Map<string, import('lightweight-charts').IChartApi> }).__liveCharts;
        const chart = charts.values().next().value!;
        chart.timeScale().fitContent();
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const series = chart.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!;
        const rows = series.data() as { time: import('lightweight-charts').Time; high: number; low: number }[];
        const row = rows.at(-1)!;
        const overlay = document.querySelector('[data-drawing-overlay]')!.getBoundingClientRect();
        return { x: overlay.left + chart.timeScale().timeToCoordinate(row.time)!, y: overlay.top + 70,
          price: row[side] };
      }, side);
      await page.mouse.click(target.x, target.y);
      await expect.poll(async () => (await readDrawings()).length).toBe(side === 'high' ? 1 : 2);
      expect((await readDrawings()).at(-1)).toMatchObject({ kind: 'hline', price: target.price, dayExtreme: { side } });
      await expect(page.getByTestId('drawing-menu-trigger').first()).toHaveAttribute('aria-label', '그리기');
    }
    const linePosition = await page.evaluate(() => {
      const charts = (window as unknown as { __liveCharts: Map<string, import('lightweight-charts').IChartApi> }).__liveCharts;
      const series = charts.values().next().value!.panes()[0].getSeries()
        .find(s => s.seriesType() === 'Candlestick')!;
      const rows = series.data() as readonly { low: number }[];
      const overlay = document.querySelector('[data-drawing-overlay]')!.getBoundingClientRect();
      return { x: overlay.left + 100, y: overlay.top + series.priceToCoordinate(rows.at(-1)!.low)! };
    });
    await page.mouse.move(linePosition.x, linePosition.y);
    await expect(page.locator('[data-drawing-overlay]').first()).toHaveCSS('pointer-events', 'auto');
    await page.mouse.click(linePosition.x, linePosition.y);
    const labels = page.getByRole('button', { name: '라벨 표시', exact: true });
    await expect(labels).toHaveAttribute('aria-pressed', 'true');
    await labels.click();
    await expect(labels).toHaveAttribute('aria-pressed', 'false');
    expect((await readDrawings()).at(-1)).toMatchObject({ labelHidden: true });
    await page.screenshot({ path: testInfo.outputPath('hidden-line-label.png') });
    await page.keyboard.press('Control+z');
    await expect(labels).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: testInfo.outputPath('day-extreme-lines.png') });
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await readDrawings()).length).toBe(1);
  });

}
