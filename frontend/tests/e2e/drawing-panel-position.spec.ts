import { expect, test, type Locator } from '@playwright/test';
import type { mount } from './helpers/drawingPanelHarness';
import { installLiveMocks } from './helpers/liveMocks';
import { apiPrefix } from './helpers/apiRoutes';

type HarnessWindow = Window & { drawingPanel: ReturnType<typeof mount> };
const panelOf = (chart: Locator) => chart.locator('[data-drawing-property-panel]');
async function position(chart: Locator) {
  const panel = (await panelOf(chart).boundingBox())!;
  const owner = (await chart.boundingBox())!;
  return { x: panel.x - owner.x, y: panel.y - owner.y };
}
async function move(grip: Locator, dx: number, dy: number) {
  const box = (await grip.boundingBox())!;
  const page = grip.page();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 5 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1450, height: 600 });
  await page.route(url => url.pathname === '/', route => route.fulfill({ contentType: 'text/html',
    body: '<html><body><script>window.$RefreshSig$=()=>type=>type;window.$RefreshReg$=()=>{};window.__vite_plugin_react_preamble_installed=true;</script></body></html>',
  }));
  await page.goto('/');
  await page.evaluate(async () => {
    const path = '/tests/e2e/helpers/drawingPanelHarness.tsx';
    const { mount } = await import(path);
    (window as unknown as HarnessWindow).drawingPanel = mount();
    await document.fonts.ready;
  });
});

test('positions belong to windows, survive selection/scope/remount, and reset on reload', async ({ page }, info) => {
  const first = page.getByTestId('chart-first'), second = page.getByTestId('chart-second');
  const grip = first.getByTestId('drawing-panel-grip');
  const original = await position(first), other = await position(second);
  await move(grip, -120, 80);
  const parked = await position(first);
  expect(parked.x).toBeCloseTo(original.x - 120, 0);
  expect(parked.y).toBeCloseTo(original.y + 80, 0);
  expect(await position(second)).toEqual(other);
  for (const ids of [['b'], [], ['a'], ['a', 'b'], ['a']]) {
    await page.evaluate(ids => (window as unknown as HarnessWindow).drawingPanel.select(ids), ids);
    if (ids.length) expect(await position(first)).toEqual(parked);
    else await expect(panelOf(first)).toHaveCount(0);
  }
  await page.evaluate(() => (window as unknown as HarnessWindow).drawingPanel.changeScope());
  expect(await position(first)).toEqual(parked);
  await page.evaluate(() => (window as unknown as HarnessWindow).drawingPanel.remount());
  expect(await position(first)).toEqual(parked);
  await first.getByTestId('drawing-color-trigger').click();
  await first.getByTestId('drawing-color-swatch-#14B8A6').click();
  expect(await position(first)).toEqual(parked);
  await page.screenshot({ path: info.outputPath('parked-options.png') });
  await page.reload();
  await page.evaluate(async () => {
    const path = '/tests/e2e/helpers/drawingPanelHarness.tsx';
    const { mount } = await import(path);
    (window as unknown as HarnessWindow).drawingPanel = mount();
    await document.fonts.ready;
  });
  expect(await position(first)).toEqual(original);
});

test('edges, resize, Escape and reset keep the toolbar and its menus usable', async ({ page }, info) => {
  const first = page.getByTestId('chart-first'), grip = first.getByTestId('drawing-panel-grip');
  const original = await position(first);
  await move(grip, 1000, 1000);
  const parked = await position(first);
  const assertInside = async (item: Locator) => {
    await expect.poll(async () => {
      const box = (await item.boundingBox())!, owner = (await first.boundingBox())!;
      return { left: box.x >= owner.x + 7, top: box.y >= owner.y + 7,
        right: box.x + box.width <= owner.x + owner.width - 7,
        bottom: box.y + box.height <= owner.y + owner.height - 7 };
    }).toEqual({ left: true, top: true, right: true, bottom: true });
  };
  await assertInside(panelOf(first));
  await first.getByTestId('drawing-color-trigger').click();
  await assertInside(first.getByTestId('drawing-color-swatch-#14B8A6').locator('..').locator('..'));
  await page.screenshot({ path: info.outputPath('edge-palette.png') });
  const box = (await grip.boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x - 100, box.y - 70, { steps: 5 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await position(first)).toEqual(parked);
  expect(await page.evaluate(() => (window as unknown as HarnessWindow).drawingPanel.selected())).toEqual(['a']);
  await first.evaluate(el => { el.style.width = '320px'; el.style.height = '180px'; });
  await expect.poll(async () => (await panelOf(first).boundingBox())!.width).toBeLessThan(320);
  await assertInside(panelOf(first));
  await first.evaluate(el => { el.style.width = '650px'; el.style.height = '320px'; });
  await expect.poll(() => position(first)).toEqual(parked);
  await grip.press('Home');
  expect(await position(first)).toEqual(original);
  await grip.press('Shift+ArrowDown');
  expect((await position(first)).y).toBeCloseTo(original.y + 10, 0);
  await grip.dblclick();
  expect(await position(first)).toEqual(original);
});

test('live chart passes the same window identity across timeframe changes', async ({ page }, info) => {
  await installLiveMocks(page);
  await page.route(apiPrefix('live/past-daily-candles'), route => route.fulfill({ json: {
    code: '098460', from: '20260527', to: '20260528', cached_batches: [], fresh_batches: [], data_warnings: [],
    candles: [0, 1].map(i => ({ t_ms: Date.UTC(2026, 4, 27 + i),
      open: 35000, high: 35200, low: 34900, close: 35100, volume: 100 })),
  } }));
  await page.goto('/live?code=098460');
  const id = await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    const chart = store.getState().windows.find((w: { kind: string }) => w.kind === 'chart');
    store.setState({ windows: [{ ...chart, rect: { x: 0, y: 0, w: 1, h: 1 }, chart: { timeframe: 'D' } }],
      zOrder: [chart.id], maximizedId: null });
    store.getState().setWindowSymbol(chart.id, { code: '098460', name: '고영', kind: 'stock' });
    return chart.id as string;
  });
  await expect(page.locator('.legend-ohlc-open').first()).toContainText('35');
  const select = async (timeframe: string) => {
    await page.evaluate(async ({ id, timeframe }) => {
      const workspacePath = '/src/state/workspace.ts', drawingsPath = '/src/state/drawings.ts';
      const { useWorkspaceStore } = await import(workspacePath);
      const { useDrawingsStore, drawingScopeFor } = await import(drawingsPath);
      useWorkspaceStore.getState().setChartTimeframe(id, timeframe);
      const scope = drawingScopeFor('098460', timeframe), store = useDrawingsStore.getState();
      store.setActiveScope(scope);
      if (!store.drawingsFor(scope).some((d: { id: string }) => d.id === 'live-test')) {
        store.add(scope, { id: 'live-test', kind: 'hline', price: 35100,
          color: '#14B8A6', width: 2, lineStyle: 'solid', paneId: 'candle' });
      }
      store.setActiveTool('select');
      store.setSelected(scope, 'live-test');
    }, { id, timeframe });
    await expect(page.getByTestId('drawing-property-panel')).toBeVisible();
  };
  await select('D');
  const surface = page.getByTestId('live-chart-surface').first();
  const grip = page.getByTestId('drawing-panel-grip');
  await move(grip, -100, 80);
  const parked = await position(surface);
  await select('W');
  await expect.poll(() => position(surface)).toEqual(parked);
  await page.screenshot({ path: info.outputPath('live-parked-options.png') });
});
