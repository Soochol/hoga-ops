import { expect, test } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { installLiveWs } from './helpers/liveWs';
import { apiExact } from './helpers/apiRoutes';

test('major indices: group stock uses a hidden independent scale and shared time cursor', async ({ page }, info) => {
  const day = '20261019', open = Date.parse('2026-10-19T09:00:00+09:00');
  const now = open + 60 * 60_000;
  await page.clock.install({ time: new Date(now) });
  await page.addInitScript(() => { if (!sessionStorage.getItem('live.workspace.v1')) sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
    windows: [{ id: 'comparison', kind: 'market-indices', group: 1, rect: { x: 0, y: 0, w: .85, h: .7 } }],
    zOrder: ['comparison'], groupSymbols: { 1: { code: '005930', name: '삼성전자' }, 2: { code: '000660', name: 'SK하이닉스' } },
  })); });
  await installLiveMocks(page);
  const ws = await installLiveWs(page);
  const requests: string[] = [];
  await page.route(apiExact('live/index-candles'), route => {
    const params = new URL(route.request().url()).searchParams;
    const daily = params.get('timeframe') === 'D';
    const candles = (daily ? [0] : Array.from({ length: 61 }, (_, i) => i)).map(i => ({
      t_ms: daily ? open - 3 * 86400_000 : open + i * 60_000,
      open: 100, high: 103, low: 99, close: daily ? 100 : 100 + i / 30 + Math.sin(i / 10) * .2, volume: 10,
    }));
    return route.fulfill({ json: { index_id: params.get('index_id'), timeframe: params.get('timeframe'),
      from: params.get('from'), to: params.get('to'), candles, data_warnings: [] } });
  });
  await page.route(apiExact('live/index-quotes'), route => route.fulfill({ json: { quotes: [] } }));
  await page.route(apiExact('live/past-candles'), route => {
    const params = new URL(route.request().url()).searchParams;
    requests.push(params.get('code')!);
    const scale = params.get('code') === '005930' ? 1 : 100;
    return route.fulfill({ json: { code: params.get('code'), from: params.get('from'), to: params.get('to'),
      venue: params.get('venue'), bucket_ms: 60_000, cached_dates: [], fresh_dates: [day], data_warnings: [],
      candles: Array.from({ length: 61 }, (_, i) => {
        const price = scale * (100 + Math.sin(i / 8) * 10 + i * .1);
        return { t_ms: open + i * 60_000, open: price, high: price, low: price, close: price, volume: 10 };
      }),
    } });
  });
  await page.route(apiExact('live/series'), route => {
    const code = new URL(route.request().url()).searchParams.get('code');
    return route.fulfill({ json: { code, date: day, snapshots: [], trades: [], brokers: [], session_open_ms: open, session_close_ms: null, is_open: true } });
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/live');
  const frame = page.locator('[data-win="comparison"]');
  const svg = frame.getByRole('img');
  const stock = frame.locator('[data-stock-series]');
  const indexAxis = frame.getByTestId('major-indices-axis-labels');
  await expect(stock).toHaveAttribute('aria-label', '삼성전자 종가');
  await expect(frame.getByRole('button', { name: '링크 그룹 1 변경' })).toHaveText('1');
  const axisBefore = await indexAxis.textContent();
  const stockBefore = await stock.locator('path').getAttribute('d');
  const indexBefore = await frame.locator('[data-index-series] path').first().getAttribute('d');
  expect(await svg.locator('text').allTextContents()).not.toContain('100원');
  await svg.hover({ position: { x: 5, y: 100 } });
  await expect(frame.getByRole('tooltip')).toContainText('삼성전자100원');
  await page.mouse.move(0, 0);
  await ws.waitForSubscribe('005930');
  ws.pushLive('005930', { kind: 'trade', venue: 'KRX', t_ms: now, trades: [{ t_ms: now, price: 150, qty: 1, side: 1 }] });
  await page.clock.fastForward(200);
  await expect(stock.locator('path')).not.toHaveAttribute('d', stockBefore!);
  await expect(indexAxis).toHaveText(axisBefore!);
  await expect(frame.locator('[data-index-series] path').first()).toHaveAttribute('d', indexBefore!);

  await frame.getByRole('button', { name: '링크 그룹 1 변경' }).click();
  await page.getByRole('dialog', { name: '연결 그룹 선택' }).getByRole('button', { name: '2', exact: true }).click();
  await expect(stock).toHaveAttribute('aria-label', 'SK하이닉스 종가');
  await expect(stock.locator('path')).toHaveAttribute('d', stockBefore!);
  await expect(frame.getByRole('button', { name: '링크 그룹 2 변경' })).toHaveText('2');
  await expect(indexAxis).toHaveText(axisBefore!);
  await svg.hover({ position: { x: 5, y: 100 } });
  await expect(frame.getByRole('tooltip')).toContainText('SK하이닉스10,000원');
  expect(requests).toEqual(expect.arrayContaining(['005930', '000660']));
  expect(errors).toEqual([]);
  await page.mouse.move(0, 0);
  await frame.screenshot({ path: info.outputPath('major-indices-linked-stock.png') });
  await page.reload();
  await expect(frame.getByRole('button', { name: '링크 그룹 2 변경' })).toHaveText('2');
  await expect(stock).toHaveAttribute('aria-label', 'SK하이닉스 종가');
});
