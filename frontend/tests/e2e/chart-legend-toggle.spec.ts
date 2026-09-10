import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiPrefix } from './helpers/apiRoutes';

test('chart legends toggle independently while OHLC stays visible, including narrow headers', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 2000, height: 900 });
  await installLiveMocks(page);
  await page.route(apiPrefix('live/past-daily-candles'), r => r.fulfill({ json: {
    code: '098460', from: '20260527', to: '20260528', cached_batches: [], fresh_batches: [], data_warnings: [],
    candles: Array.from({ length: 2 }, (_, i) => ({ t_ms: Date.UTC(2026, 4, 27 + i),
      open: 35000 + i, high: 35200 + i, low: 34900 + i, close: 35100 + i, volume: 100 })),
  } }));
  await page.goto('/live?code=098460');
  await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    const charts = store.getState().windows.filter((w: { kind: string }) => w.kind === 'chart');
    if (charts.length < 2) store.getState().addWindow('chart');
    const windows = store.getState().windows.filter((w: { kind: string }) => w.kind === 'chart').slice(0, 2);
    store.setState({ windows: windows.map((w: { id: string }, i: number) => ({ ...w,
      rect: { x: i * 0.5, y: 0, w: 0.5, h: 1 }, chart: { timeframe: 'D' },
    })), zOrder: windows.map((w: { id: string }) => w.id), maximizedId: null });
    for (const w of windows) store.getState().setWindowSymbol(w.id, { code: '098460', name: '고영', kind: 'stock' });
  });
  const headers = page.getByTestId('chart-window-header');
  await expect(headers).toHaveCount(2);
  const first = headers.nth(0).locator('..');
  const second = headers.nth(1).locator('..');
  await expect(first.locator('.legend-ohlc-open')).toBeVisible();
  await expect(first.locator('.legend-row-ma')).toBeVisible();
  await headers.nth(0).getByRole('button', { name: '레전드 끄기', exact: true }).click();
  await expect(first.locator('.legend-row-ma')).toHaveCount(0);
  await expect(first.locator('.legend-ohlc-open')).toBeVisible();
  await expect(second.locator('.legend-row-ma')).toBeVisible();
  await expect(headers.nth(0).getByRole('button', { name: '레전드 켜기', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.screenshot({ path: testInfo.outputPath('legend-off.png') });
  await headers.nth(0).getByRole('button', { name: '레전드 켜기', exact: true }).click();
  await expect(first.locator('.legend-row-ma')).toBeVisible();
  for (const timeframe of ['D', '240m']) {
    await page.evaluate(async tf => {
      const path = '/src/state/workspace.ts';
      const { useWorkspaceStore: store } = await import(path);
      store.getState().setChartTimeframe(store.getState().windows[0].id, tf);
    }, timeframe);
    for (const width of [900, 400, 160]) {
      await headers.nth(0).evaluate((el, value) => { el.style.width = `${value}px`; }, width);
      if (width < 500) await expect(headers.nth(0)).toHaveAttribute('data-compact', '');
      else await expect(headers.nth(0)).not.toHaveAttribute('data-compact');
      if (width < 200) await expect(headers.nth(0)).toHaveAttribute('data-compact-timeframe', '');
      else await expect(headers.nth(0)).not.toHaveAttribute('data-compact-timeframe');
      await expect.poll(() => headers.nth(0).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      const measurement = await headers.nth(0).evaluate(el => {
        const clone = el.cloneNode(true) as HTMLElement;
        clone.style.width = 'max-content';
        clone.style.flexWrap = 'nowrap';
        clone.style.position = 'fixed';
        clone.style.visibility = 'hidden';
        for (const child of clone.children) (child as HTMLElement).style.flexWrap = 'nowrap';
        document.body.append(clone);
        const withToggle = clone.getBoundingClientRect().width;
        clone.querySelector('[aria-label="레전드 끄기"]')?.remove();
        const withoutToggle = clone.getBoundingClientRect().width;
        clone.remove();
        return { withToggle, withoutToggle };
      });
      console.log('legend-header-width', timeframe, width, measurement);
      const button = headers.nth(0).getByRole('button', { name: '레전드 끄기', exact: true });
      await expect(button).toBeInViewport();
      await button.click();
      await expect(first.locator('.legend-row-ma')).toHaveCount(0);
      await headers.nth(0).getByRole('button', { name: '레전드 켜기', exact: true }).click();
    }
  }
  await page.screenshot({ path: testInfo.outputPath('legend-narrow.png') });
});
