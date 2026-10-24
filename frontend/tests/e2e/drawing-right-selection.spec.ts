import { expect, test, type Page } from '@playwright/test';
import type { IChartApi } from 'lightweight-charts';
import { installLiveMocks } from './helpers/liveMocks';

type ChartWindow = Window & { __liveCharts: Map<string, IChartApi> };
const scope = '098460|minute';

async function read(page: Page) {
  return page.evaluate(async scope => {
    const path = '/src/state/drawings.ts';
    const { useDrawingsStore } = await import(path) as typeof import('../../src/state/drawings');
    const state = useDrawingsStore.getState();
    return { selected: state.selectedFor(scope), items: state.drawingsFor(scope), tool: state.activeTool };
  }, scope);
}

async function setup(page: Page) {
  await installLiveMocks(page);
  await page.goto('/live?code=098460');
  await expect(page.getByTestId('live-chart-root').first()).toBeVisible();
  const id: string = await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    const state = store.getState();
    const win = state.windows.find((w: { kind: string }) => w.kind === 'chart');
    state.setChartTimeframe(win.id, '3m');
    state.focusWindow(win.id);
    state.toggleMaximize(win.id);
    return win.id;
  });
  await expect.poll(() => page.evaluate(id => {
    const chart = (window as unknown as ChartWindow).__liveCharts?.get(id);
    return chart?.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')?.data().length ?? 0;
  }, id)).toBeGreaterThan(0);
  const geometry = await page.evaluate(async ({ id, scope }) => {
    const path = '/src/state/drawings.ts';
    const { useDrawingsStore } = await import(path) as typeof import('../../src/state/drawings');
    const chart = (window as unknown as ChartWindow).__liveCharts.get(id)!;
    const series = chart.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!;
    const bounds = document.querySelector('[data-drawing-overlay]')!.getBoundingClientRect();
    const height = chart.panes()[0].getHeight();
    const ys = [0.35, 0.53, 0.73].map(f => height * f);
    const store = useDrawingsStore.getState();
    const drawings = ys.map((y, i) => ({ id: ['a', 'b', 'c'][i],
      kind: 'hline' as const, price: Number(series.coordinateToPrice(y)), color: '#14B8A6',
      width: 2, lineStyle: 'solid' as const, paneId: 'candle' as const,
      ...(i === 2 ? { locked: true } : {}) }));
    for (const drawing of drawings) store.add(scope, drawing);
    store.setActiveTool('select');
    store.setSelection(scope, ['c']);
    return { x: bounds.left + 70, y: bounds.top, ys, height,
      axisX: bounds.left + chart.timeScale().width() + 10 };
  }, { id, scope });
  return { id, ...geometry };
}

async function rightBox(page: Page, x: number, y1: number, y2: number, shift = false) {
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(x, y1);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(x + 100, y2, { steps: 6 });
  await expect(page.locator('[data-drawing-marquee]').first()).toBeVisible();
  await page.mouse.up({ button: 'right' });
  if (shift) await page.keyboard.up('Shift');
  await expect(page.locator('[data-drawing-marquee]').first()).toBeHidden();
}

test('right selection supports bulk style, move, delete and one-step undo without panning', async ({ page }, info) => {
  const g = await setup(page);
  const range = await page.evaluate(id => (window as unknown as ChartWindow).__liveCharts.get(id)!.timeScale().getVisibleLogicalRange(), g.id);
  const before = await read(page);
  await page.mouse.move(g.x, g.y + g.ys[0] - 12);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(g.x + 100, g.y + g.ys[1] + 12, { steps: 6 });
  await expect(page.locator('[data-drawing-marquee]').first()).toBeVisible();
  await expect(page.locator('[data-drawing-marquee]').first()).toBeEmpty();
  expect((await read(page)).selected).toEqual(['c']); // Preview must not mutate selection.
  await page.mouse.up({ button: 'right' });
  await expect.poll(async () => (await read(page)).selected).toEqual(['a', 'b']);
  await expect(page.getByTestId('drawing-multi-count')).toHaveText('2개 선택');
  expect(await page.evaluate(id => (window as unknown as ChartWindow).__liveCharts.get(id)!.timeScale().getVisibleLogicalRange(), g.id)).toEqual(range);
  await page.screenshot({ path: info.outputPath('right-selection.png') });

  await page.getByTestId('drawing-color-trigger').click();
  await page.getByTestId('drawing-color-swatch-#F59E0B').click();
  await expect.poll(async () => (await read(page)).items.slice(0, 2).map(d => d.color)).toEqual(['#F59E0B', '#F59E0B']);
  expect((await read(page)).items[2]).toEqual(before.items[2]);

  // Grab a member away from the toolbar; both unlocked members must move.
  await page.mouse.move(g.x + 230, g.y + g.ys[0]);
  await expect(page.locator('[data-drawing-overlay]').first()).toHaveCSS('pointer-events', 'auto');
  await page.mouse.down();
  await page.mouse.move(g.x + 230, g.y + g.ys[0] + 16, { steps: 5 });
  await page.mouse.up();
  const moved = await read(page);
  for (const i of [0, 1]) {
    expect((moved.items[i] as { price: number }).price).not.toBe((before.items[i] as { price: number }).price);
  }
  expect(moved.items[2]).toEqual(before.items[2]);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await read(page)).items.slice(0, 2).map(d => (d as { price: number }).price))
    .toEqual(before.items.slice(0, 2).map(d => (d as { price: number }).price));

  await page.getByTestId('drawing-multi-delete').click();
  await expect.poll(async () => (await read(page)).items.map(d => d.id)).toEqual(['c']);
  await expect(page.getByText('그림 2개 삭제됨')).toBeVisible();
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect.poll(async () => (await read(page)).items.map(d => d.id)).toEqual(['a', 'b', 'c']);
});

test('Shift adds locked members, deletion preserves locks, and click/cancel/axes preserve input rules', async ({ page }) => {
  const g = await setup(page);
  await rightBox(page, g.x, g.y + g.ys[0] - 12, g.y + g.ys[1] + 12);
  await rightBox(page, g.x, g.y + g.ys[2] - 12, g.y + g.ys[2] + 12, true);
  await expect.poll(async () => (await read(page)).selected).toEqual(['a', 'b', 'c']);
  await expect(page.getByTestId('drawing-multi-count')).toHaveText('3개 선택 · 1 잠김');
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await read(page)).items.map(d => d.id)).toEqual(['c']);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await read(page)).items).toHaveLength(3);

  // Escape cancels an in-flight box and its preview without committing.
  const selected = (await read(page)).selected;
  await page.mouse.move(g.x, g.y + g.ys[0] - 12);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(g.x + 90, g.y + g.ys[1] + 12, { steps: 4 });
  await expect(page.locator('[data-drawing-marquee]').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.up({ button: 'right' });
  await expect(page.locator('[data-drawing-marquee]').first()).toBeHidden();
  expect((await read(page)).selected).toEqual(selected);

  await page.mouse.move(g.axisX, g.y + g.ys[0]);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(g.axisX, g.y + g.ys[1], { steps: 4 });
  await expect(page.locator('[data-drawing-marquee]').first()).toBeHidden();
  await page.mouse.up({ button: 'right' });

  // A sub-threshold right click clears selection. Active tools still cancel.
  await page.mouse.move(g.x, g.y + 25);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(g.x + 2, g.y + 27);
  await page.mouse.up({ button: 'right' });
  await expect.poll(async () => (await read(page)).selected).toEqual([]);
  await page.keyboard.press('Alt+t');
  await expect.poll(async () => (await read(page)).tool).toBe('text');
  await page.mouse.click(g.x, g.y + 25, { button: 'right' });
  await expect.poll(async () => (await read(page)).tool).toBe('select');
});
