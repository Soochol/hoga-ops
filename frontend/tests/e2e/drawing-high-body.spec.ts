import { expect, test } from '@playwright/test';
import type { IChartApi, Logical } from 'lightweight-charts';
import { installLiveMocks } from './helpers/liveMocks';
import { apiPrefix } from './helpers/apiRoutes';

test('Shift+R draws the hovered day high candle body immediately and persists it', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  const open = Date.UTC(2026, 4, 27, 0);
  await page.route(apiPrefix('live/past-candles'), r => r.fulfill({ json: {
    code: '098460', from: '20260527', to: '20260528',
    candles: [
      { t_ms: open, open: 35000, close: 35050, high: 35100, low: 34900, volume: 100 },
      { t_ms: open + 180_000, open: 35300, close: 35350, high: 35400, low: 35200, volume: 100 },
      { t_ms: open + 360_000, open: 35100, close: 35080, high: 35500, low: 35000, volume: 100 },
      { t_ms: open + 540_000, open: 35300, close: 35400, high: 35500, low: 35200, volume: 100 },
      { t_ms: open + 86_400_000, open: 36000, close: 36200, high: 36300, low: 35900, volume: 100 },
    ], cached_dates: ['20260527'], fresh_dates: ['20260528'], data_warnings: [],
  } }));
  await page.goto('/live?code=098460');
  await expect(page.getByTestId('live-chart-root').first()).toBeVisible();
  const windowId: string = await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    const state = store.getState();
    const win = state.windows.find((w: { kind: string }) => w.kind === 'chart');
    state.setChartTimeframe(win.id, '3m');
    state.focusWindow(win.id);
    state.toggleMaximize(win.id);
    return win.id;
  });
  const overlay = page.locator('[data-drawing-overlay]').first();
  await expect(overlay).toHaveAttribute('data-day-extremes-ready', 'true');
  await expect.poll(() => page.evaluate(id => {
    const charts = (window as unknown as { __liveCharts: Map<string, IChartApi> }).__liveCharts;
    return charts?.get(id)?.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')?.data().length;
  }, windowId)).toBe(5);

  // Only the first two candles are visible. The high candle later that morning must
  // still determine the line, and the later equal high must not win the tie.
  await page.evaluate(id => {
    const chart = (window as unknown as { __liveCharts: Map<string, IChartApi> }).__liveCharts.get(id)!;
    chart.timeScale().setVisibleLogicalRange({ from: -3, to: 1 });
  }, windowId);
  await expect.poll(() => page.evaluate(id => {
    const chart = (window as unknown as { __liveCharts: Map<string, IChartApi> }).__liveCharts.get(id)!;
    return chart.timeScale().getVisibleLogicalRange()?.to;
  }, windowId)).toBeCloseTo(1);

  const target = await page.evaluate(id => {
    const chart = (window as unknown as { __liveCharts: Map<string, IChartApi> }).__liveCharts.get(id)!;
    const bounds = document.querySelector('[data-drawing-overlay]')!.getBoundingClientRect();
    return { x: bounds.left + Number(chart.timeScale().logicalToCoordinate(0 as Logical)), y: bounds.top + 80 };
  }, windowId);
  const readLines = () => page.evaluate(async () => {
    const path = '/src/state/drawings.ts';
    const { useDrawingsStore: store } = await import(path);
    return store.getState().drawingsFor('098460|minute');
  });
  await page.mouse.move(target.x, target.y);
  await page.keyboard.press('Shift+r');
  await expect.poll(readLines).toEqual([expect.objectContaining({
    kind: 'hline', paneId: 'candle', price: 35100,
    dayExtreme: { date: '20260527', side: 'high-body' },
  })]);
  await page.screenshot({ path: testInfo.outputPath('high-candle-body-line.png') });
  await page.keyboard.press('Control+z');
  await expect.poll(readLines).toHaveLength(0);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(readLines).toHaveLength(1);

  // Save/load uses the same persisted hline representation as manual drawings.
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage)
    .filter(key => key.includes('drawing') && key.includes('098460'))
    .some(key => localStorage.getItem(key)?.includes('high-body')))).toBe(true);
  await page.reload();
  await expect(page.locator('[data-drawing-overlay]').first()).toBeAttached();
  await expect.poll(readLines).toEqual([expect.objectContaining({
    kind: 'hline', price: 35100, dayExtreme: { date: '20260527', side: 'high-body' },
  })]);
});
