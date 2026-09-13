import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiPrefix } from './helpers/apiRoutes';

test('daily program pane switches all three modes without fetching and restores per chart', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await installLiveMocks(page);
  const t = Date.UTC(2026, 4, 27);
  await page.route(apiPrefix('live/past-daily-candles'), r => r.fulfill({ json: {
    code: '098460', from: '20260527', to: '20260528', cached_batches: [], fresh_batches: [], data_warnings: [],
    candles: [0, 1].map(i => ({ t_ms: t + i * 86400000, open: 35000, high: 35200, low: 34900, close: 35100, volume: 100 })),
  } }));
  let requests = 0;
  await page.route('**/api/live/daily-program-trade?**', async r => {
    requests++;
    const params = new URL(r.request().url()).searchParams;
    await r.fulfill({ json: { code: '098460', from: params.get('from'), to: params.get('to'),
      points: [0, 1].map(i => ({ t_ms: t + i * 86400000, net_qty: -30, buy_qty: 100, sell_qty: 130 })),
      cached_batches: [], fresh_batches: [], data_warnings: [] } });
  });
  await page.goto('/live?code=098460');
  await page.evaluate(async () => {
    const workspacePath = '/src/state/workspace.ts';
    const indicatorPath = '/src/state/livePage.ts';
    const { useWorkspaceStore: store } = await import(workspacePath);
    const { useLivePageStore } = await import(indicatorPath);
    store.getState().addWindow('chart');
    const charts = store.getState().windows.filter((w: { kind: string }) => w.kind === 'chart').slice(0, 2);
    store.setState({ windows: charts.map((w: { id: string }, i: number) => ({ ...w,
      rect: { x: i * 0.5, y: 0, w: 0.5, h: 1 }, chart: { timeframe: 'D' } })),
      zOrder: charts.map((w: { id: string }) => w.id), maximizedId: null });
    for (const w of charts) {
      store.getState().setWindowSymbol(w.id, { code: '098460', name: '고영', kind: 'stock' });
      useLivePageStore.getState().patchIndicatorsScoped({ windowKey: `live:${w.id}` }, 'D',
        { dailyProgramEnabled: true, dailyProgramTradeSide: 'net' });
    }
  });
  const headers = page.getByTestId('chart-window-header');
  const first = headers.nth(0).locator('..');
  const second = headers.nth(1).locator('..');
  await expect(first.getByTestId('pane-chip-program-daily')).toHaveText('프로그램 순매수량');
  await expect(second.getByTestId('pane-chip-program-daily')).toHaveText('프로그램 순매수량');
  const requestCount = requests;
  await headers.nth(0).getByRole('button', { name: /보조지표/ }).click();
  const panel = page.getByTestId('indicator-panel-shell');
  await panel.getByRole('button', { name: '프로그램 순매수량', exact: true }).click();
  const mode = page.getByRole('combobox', { name: '프로그램 매매 기준' });
  await mode.selectOption('buy');
  await expect(first.getByTestId('pane-chip-program-daily')).toHaveText('프로그램 총매수량');
  await mode.selectOption('sell');
  await expect(first.getByTestId('pane-chip-program-daily')).toHaveText('프로그램 총매도량');
  await expect(second.getByTestId('pane-chip-program-daily')).toHaveText('프로그램 순매수량');
  expect(requests).toBe(requestCount);
  await panel.getByRole('button', { name: '닫기', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('daily-program-trade.png') });
  await page.reload();
  await expect(first.getByTestId('pane-chip-program-daily')).toHaveText('프로그램 총매도량');
  await expect(second.getByTestId('pane-chip-program-daily')).toHaveText('프로그램 순매수량');
  await headers.nth(0).getByRole('button', { name: /보조지표/ }).click();
  await panel.getByRole('button', { name: '프로그램 순매수량 삭제', exact: true }).click();
  await expect(first.getByTestId('pane-chip-program-daily')).toHaveCount(0);
  await panel.getByTestId('indicator-panel-mode-toggle').click();
  await panel.getByRole('button', { name: '프로그램 순매수량 추가', exact: true }).click();
  await expect(first.getByTestId('pane-chip-program-daily')).toHaveText('프로그램 총매도량');
});
