import { test, expect, type Locator } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact, apiPrefix } from './helpers/apiRoutes';

// Keep both densities above the drawer auto-collapse threshold.
test.use({ viewport: { width: 1600, height: 1000 } });

const folder = { id: 'f_0000000a', name: '이름 폭 확인', order: 0 };
const stocks = [
  { code: '006800', name: '미래에셋증권', folder_id: folder.id, order: 0 },
  { code: '012450', name: '한화에어로스페이스', folder_id: folder.id, order: 1 },
];

async function columns(row: Locator) {
  return row.evaluate(element => {
    const origin = element.getBoundingClientRect();
    const name = element.querySelector<HTMLElement>('.truncate')!;
    const price = element.querySelector<HTMLElement>('.quote-row-price')!;
    const flow = element.querySelector<HTMLElement>('.quote-row-flow')!;
    const percent = element.querySelector<HTMLElement>('.font-data.text-xs')!;
    const bounds = (node: HTMLElement) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left - origin.left, width: rect.width };
    };
    return { name: bounds(name), flow: bounds(flow), price: bounds(price), percent: bounds(percent), clipped: name.scrollWidth > name.clientWidth };
  });
}

for (const fontSize of [16, 20]) {
  test(`관심종목·히트맵은 같은 열 배치를 쓰고 수집 상태 점은 들여쓰기에 남는다 (${fontSize}px)`, async ({ page }) => {
    await installLiveMocks(page);
    await page.route(apiExact('watchlist'), route => route.fulfill({ json: {
      folders: [folder], entries: stocks.map(stock => ({ ...stock, registered_at_kst_date: '20260908', last_success_date: null })),
      memos: [], next_run_at_ms: 0,
    } }));
    await page.route(apiExact('heatmap'), route => route.fulfill({ json: {
      folders: [folder], entries: stocks, capture_markers: {}, next_run_at_ms: 0,
    } }));
    await page.route(apiPrefix('live/quotes'), route => route.fulfill({ json: {
      phase: 'open', quotes: stocks.map(stock => ({ code: stock.code, price: 123456, change_pct: 12.34, change_won: 12345 })),
    } }));
    await page.route(apiExact('live/status'), route => route.fulfill({ json: {
      running: true, started_at_ms: Date.now(), last_tick_ms: Date.now(), cycle_lag_ms: 0,
      capture_healthy: true, capture_reason: 'healthy', watchlist_count: 2, live_set: ['006800'],
    } }));
    await page.goto('/live?code=098460');
    await page.addStyleTag({ content: `:root { font-size: ${fontSize}px !important; }` });
    const watchlist = page.getByTestId('watchlist-panel');
    if (!(await watchlist.isVisible())) await page.getByRole('button', { name: /관심종목 패널 토글/ }).click();
    const normal = watchlist.getByTestId('watchlist-row-006800');
    const waiting = watchlist.getByTestId('watchlist-row-012450');
    await expect(normal).toBeVisible();
    await expect(normal.getByTestId('collection-dot-realtime')).toHaveCount(0);
    const dot = waiting.getByTestId('collection-dot-waiting_eod');
    await expect(dot).toBeVisible();
    await expect(dot).toHaveAttribute('data-tooltip', '관심종목 대기 중');
    await expect.poll(() => columns(normal).then(value => value.clipped)).toBe(false);
    const watchlistColumns = await Promise.all([columns(normal), columns(waiting)]);
    expect(watchlistColumns[0].name.width).toBeCloseTo(watchlistColumns[1].name.width, 3);
    const dotBox = await dot.boundingBox();
    const nameBox = await waiting.locator('.truncate').boundingBox();
    expect(dotBox!.x + dotBox!.width).toBeLessThan(nameBox!.x);
    await watchlist.screenshot({ path: `/tmp/hoga-watchlist-name-width-${fontSize}.png` });

    // The dragged clone must preserve the same name width and collection status.
    const box = await waiting.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 8, box!.y + box!.height / 2, { steps: 3 });
    const ghost = page.getByTestId('watchlist-drag-ghost');
    await expect(ghost).toBeVisible();
    await expect(ghost.getByTestId('collection-dot-waiting_eod')).toBeVisible();
    expect((await columns(ghost)).name.width).toBeCloseTo(watchlistColumns[1].name.width, 3);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(ghost).toHaveCount(0);
    await page.waitForTimeout(60); // dnd-kit releases document click suppression 50ms after detach.

    await page.getByRole('button', { name: /히트맵 패널 토글/ }).click();
    const heatmap = page.getByTestId('heatmap-panel');
    for (let index = 0; index < stocks.length; index++) {
      const row = heatmap.getByTestId(`heatmap-drawer-row-${stocks[index].code}`);
      await expect(row).toBeVisible();
      const heatmapColumns = await columns(row);
      for (const column of ['name', 'flow', 'price', 'percent'] as const) {
        expect(watchlistColumns[index][column].left).toBeCloseTo(heatmapColumns[column].left, 3);
        expect(watchlistColumns[index][column].width).toBeCloseTo(heatmapColumns[column].width, 3);
      }
    }
  });
}
