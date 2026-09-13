import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiPrefix } from './helpers/apiRoutes';

test('investor panes have independent modes and restore both after reload', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await installLiveMocks(page);
  const t = Date.UTC(2026, 4, 27);
  await page.route(apiPrefix('live/past-daily-candles'), r => r.fulfill({ json: {
    code: '098460', from: '20260527', to: '20260528', cached_batches: [], fresh_batches: [], data_warnings: [],
    candles: [0, 1].map(i => ({ t_ms: t + i * 86400000, open: 35000, high: 35200, low: 34900, close: 35100, volume: 100 })),
  } }));
  const requests: string[] = [];
  let releaseSell!: () => void;
  const sellReady = new Promise<void>((resolve) => { releaseSell = resolve; });
  await page.route('**/api/live/past-investor-net?**', async r => {
    const p = new URL(r.request().url()).searchParams;
    const side = p.get('trade_side') ?? 'net';
    requests.push(side);
    if (side === 'sell') await sellReady;
    const value = side === 'net' ? -10 : side === 'buy' ? 120 : 130;
    await r.fulfill({ json: { code: '098460', from: p.get('from'), to: p.get('to'), unit: 'qty_shares', trade_side: side,
      points: [0, 1].map(i => ({ t_ms: t + i * 86400000, foreign_net: value, institution_net: value * 2 })),
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
        { foreignNetEnabled: true, institutionNetEnabled: true, foreignTradeSide: 'net', institutionTradeSide: 'net' });
    }
  });
  const headers = page.getByTestId('chart-window-header');
  const first = headers.nth(0).locator('..');
  const second = headers.nth(1).locator('..');
  await expect(first.getByTestId('pane-chip-investor-foreign')).toContainText('외국인 순매수량');
  await headers.nth(0).getByRole('button', { name: /보조지표/ }).click();
  const panel = page.getByTestId('indicator-panel-shell');
  await panel.getByRole('button', { name: '외국인 순매수량', exact: true }).click();
  await page.getByRole('combobox', { name: '투자자 매매 기준' }).selectOption('sell');
  await expect(first.getByTestId('pane-chip-investor-foreign')).toHaveText('외국인 순매수량 · 조회 중');
  releaseSell();
  await expect(first.getByTestId('pane-chip-investor-foreign')).toHaveText('외국인 총매도량');
  await expect(first.getByTestId('pane-chip-investor-institution')).toHaveText('기관 순매수량');
  await expect(second.getByTestId('pane-chip-investor-foreign')).toHaveText('외국인 순매수량');
  await panel.getByRole('button', { name: '기관 순매수량', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '투자자 매매 기준' })).toHaveValue('net');
  await page.getByRole('combobox', { name: '투자자 매매 기준' }).selectOption('buy');
  await expect(first.getByTestId('pane-chip-investor-institution')).toHaveText('기관 총매수량');
  await expect(first.getByTestId('pane-chip-investor-foreign')).toHaveText('외국인 총매도량');
  expect(requests).toEqual(expect.arrayContaining(['net', 'sell', 'buy']));
  await panel.getByRole('button', { name: '닫기', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('chart-investor-buy.png') });
  await page.reload();
  await expect(first.getByTestId('pane-chip-investor-foreign')).toHaveText('외국인 총매도량');
  await expect(first.getByTestId('pane-chip-investor-institution')).toHaveText('기관 총매수량');
  await expect(second.getByTestId('pane-chip-investor-foreign')).toHaveText('외국인 순매수량');
});
