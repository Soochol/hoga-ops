import { expect, test, type Page } from '@playwright/test';
import type { IChartApi } from 'lightweight-charts';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

const accountA = `acc_${'a'.repeat(32)}`, accountB = `acc_${'b'.repeat(32)}`;
const start = Date.parse('2026-05-27T09:00:00+09:00');
type ChartsWindow = Window & { __liveCharts?: Map<string, IChartApi>; __executionPaints?: { text: string; x: number; y: number }[] };

async function fixture(page: Page, timeframe: string) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.clock.setFixedTime(new Date('2026-05-28T18:00:00+09:00'));
  await page.addInitScript(timeframe => {
    if (!sessionStorage.getItem('execution-fixture')) {
      sessionStorage.setItem('execution-fixture', '1');
      sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
        windows: [{ id: 'fills', kind: 'chart', group: 1, chart: { timeframe }, rect: { x: 0, y: 0, w: .97, h: .9 } }],
        zOrder: ['fills'], groupSymbols: { 1: { code: '098460', name: '고영' } },
      }));
    }
    const win = window as ChartsWindow;
    win.__executionPaints = [];
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, maxWidth) {
      if ((text === 'B' || text === 'S') && this.font.includes('13px')) {
        win.__executionPaints!.push({ text, x, y });
        if (win.__executionPaints!.length > 500) win.__executionPaints!.splice(0, 250);
      }
      if (maxWidth === undefined) original.call(this, text, x, y); else original.call(this, text, x, y, maxWidth);
    };
  }, timeframe);
  await installLiveMocks(page);
  await page.routeWebSocket(/\/api\/ws/, () => {});
  const step = timeframe === '3m' ? 3 : 1;
  const candles = Array.from({ length: Math.ceil(60 / step) }, (_, i) => ({
    t_ms: start + i * step * 60_000, open: 35000, close: 35100, high: 35700, low: 34500, volume: 1000,
  }));
  await page.route(apiExact('live/past-candles'), route => route.fulfill({ json: {
    code: '098460', from: '20260527', to: '20260528', candles,
    adjust_factors: { '20260527': 1 }, cached_dates: ['20260527'], fresh_dates: [], data_warnings: [],
  } }));
  await page.route(apiExact('live/past-daily-candles'), route => route.fulfill({ json: {
    code: '098460', from: '20260525', to: '20260528', candles: [0, 1, 2].map(i => ({
      t_ms: start - (2 - i) * 86_400_000, open: 17500, close: 17500, high: 18000, low: 17000, volume: 1000,
    })), cached_batches: [], fresh_batches: [], data_warnings: [],
  } }));
  await page.route(apiExact('trading/v2/accounts'), route => route.fulfill({ json: { configured: true, errors: {}, accounts: [
    { account_ref: accountA, broker: 'kiwoom', environment: 'real', label: '키움 · 실전 · ****1234', routes: ['KRX'] },
    { account_ref: accountB, broker: 'toss', environment: 'real', label: '토스 · 실전 · ****5678', routes: ['SOR'] },
  ] } }));
  await page.route(apiExact('trading/v2/executions'), route => {
    const p = new URL(route.request().url()).searchParams, account = p.get('account_ref')!, date = p.get('date')!;
    const rows = date === '20260527' ? (account === accountA ? [
      { execution_id: 'a', t_ms: start + 8 * 60_000 + 12_000, price: '35020', side: 'BUY', quantity: '10' },
      { execution_id: 'b', t_ms: start + 8 * 60_000 + 42_000, price: '35020', side: 'BUY', quantity: '5' },
      { execution_id: 'c', t_ms: start + 21 * 60_000 + 20_000, price: '35500', side: 'SELL', quantity: '15' },
    ] : [
      { execution_id: 'toss-buy', t_ms: start + 8 * 60_000 + 42_000, price: '35040.25', side: 'BUY', quantity: '30' },
      { execution_id: 'toss-sell', t_ms: start + 21 * 60_000 + 20_000, price: '35540.5', side: 'SELL', quantity: '30' },
    ]).map(r => ({ ...r, order_ref: 'order', code: '098460', trading_date: date,
      venue: account === accountA ? 'KRX' : null, basis: account === accountA ? 'execution' : 'order_average' })) : [];
    return route.fulfill({ json: { account_ref: account, code: p.get('code'), date, price_venue: p.get('venue'), raw_close: '35000',
      rows, next_cursor: null, supported: true, message: null,
      fetched_at_ms: Date.now(),
    } });
  });
}

async function markerPosition(page: Page, timeframe: string, price = 35020) {
  return page.evaluate(({ start, timeframe, price }) => {
    const chart = (window as ChartsWindow).__liveCharts?.get('fills');
    const series = chart?.panes()[0]?.getSeries().find(s => s.seriesType() === 'Candlestick');
    const rows = series?.data();
    const row = rows?.[timeframe === 'D' ? rows.length - 1 : timeframe === '3m' ? 2 : 8];
    if (!chart || !series || !row) return null;
    const x = chart.timeScale().timeToCoordinate(row.time), y = series.priceToCoordinate(timeframe === 'D' ? price / 2 : price);
    if (x === null || y === null) return null;
    const rect = chart.chartElement().getBoundingClientRect();
    return { x, y, clientX: rect.left + x, clientY: rect.top + y, start };
  }, { start, timeframe, price });
}

for (const timeframe of ['1m', '3m', 'D']) test(`${timeframe}: 설정 토글·계좌 선택·실제 체결 위치·계좌 교체`, async ({ page }, info) => {
  await fixture(page, timeframe);
  await page.goto('/live');
  const frame = page.locator('[data-win="fills"]');
  await expect(frame).toBeVisible();
  await expect(frame.getByRole('combobox', { name: '매매 계좌' })).toHaveCount(0);
  await frame.getByRole('button', { name: '차트 설정', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '차트 설정', exact: true });
  await settings.getByRole('switch', { name: '매매내역 표시', exact: true }).check();
  await page.keyboard.press('Escape');
  const selector = frame.getByRole('combobox', { name: '매매 계좌' });
  await expect(selector).toBeVisible();
  await expect(selector).toHaveValue('');
  await selector.selectOption(accountA);
  await expect.poll(() => page.evaluate(() => (window as ChartsWindow).__executionPaints?.some(p => p.text === 'B'))).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as ChartsWindow).__executionPaints?.some(p => p.text === 'S'))).toBe(true);
  const position = await markerPosition(page, timeframe);
  expect(position).not.toBeNull();
  await expect.poll(() => page.evaluate(position => (window as ChartsWindow).__executionPaints?.some(
    p => p.text === 'B' && Math.abs(p.x - position!.x) < 1 && Math.abs(p.y - position!.y) < 1), position)).toBe(true);
  await page.mouse.click(position!.clientX, position!.clientY);
  const detail = frame.getByRole('region', { name: '이 봉의 매매내역' });
  await expect(detail).toBeVisible();
  await expect(detail.getByText('35,020원', { exact: true })).toHaveCount(2);
  await expect(detail.getByText('10주', { exact: true })).toBeVisible();
  await expect(detail.getByText('5주', { exact: true })).toBeVisible();
  await detail.getByRole('button', { name: '매매내역 닫기' }).click();
  await frame.screenshot({ path: info.outputPath(`account-executions-${timeframe}.png`) });
  await page.evaluate(() => { (window as ChartsWindow).__executionPaints = []; });
  await selector.selectOption(accountB);
  await expect(detail).toHaveCount(0);
  const averagePosition = await markerPosition(page, timeframe, 35040.25);
  expect(averagePosition).not.toBeNull();
  await expect.poll(() => page.evaluate(position => (window as ChartsWindow).__executionPaints?.some(
    p => p.text === 'B' && Math.abs(p.x - position!.x) < 1 && Math.abs(p.y - position!.y) < 1), averagePosition)).toBe(true);
  await page.mouse.click(averagePosition!.clientX, averagePosition!.clientY);
  await expect(detail).toBeVisible();
  await expect(detail.getByText('주문 평균가 기준 · 마지막 체결 시각에 표시합니다.', { exact: true })).toBeVisible();
  await expect(detail.getByRole('columnheader', { name: '마지막 체결 시각', exact: true })).toBeVisible();
  await expect(detail.getByRole('columnheader', { name: '평균 체결가', exact: true })).toBeVisible();
  await expect(detail.getByText('35,040.25원', { exact: true })).toBeVisible();
  await expect(detail.getByText('30주', { exact: true }).first()).toBeVisible();
  await frame.screenshot({ path: info.outputPath(`toss-order-averages-${timeframe}.png`) });
  await selector.selectOption(accountA);
  await page.reload();
  await expect(frame.getByRole('combobox', { name: '매매 계좌' })).toHaveValue(accountA);
  if (timeframe === '1m') {
    const bounds = (await frame.boundingBox())!;
    const handle = (await frame.locator('[data-handle="e"]').boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 360 - bounds.width, handle.y + handle.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect(selector).toBeVisible();
    await expect.poll(() => selector.evaluate(el => {
      const rect = el.getBoundingClientRect(), frame = el.closest('[data-win]')!.getBoundingClientRect();
      return rect.width > 40 && rect.left >= frame.left && rect.right <= frame.right;
    })).toBe(true);
  }
  await frame.getByRole('button', { name: '차트 설정', exact: true }).click();
  await page.getByRole('dialog', { name: '차트 설정', exact: true }).getByRole('switch', { name: '매매내역 표시', exact: true }).uncheck();
  await page.keyboard.press('Escape');
  await expect(frame.getByRole('combobox', { name: '매매 계좌' })).toHaveCount(0);
  await expect(frame.getByTestId('account-execution-status')).toHaveCount(0);
  await page.evaluate(async () => {
    const win = window as ChartsWindow;
    win.__executionPaints = [];
    win.__liveCharts?.get('fills')?.timeScale().scrollToPosition(1, false);
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  expect(await page.evaluate(() => (window as ChartsWindow).__executionPaints)).toEqual([]);
});

test('과거 이동은 새 거래일만 조회하고 돌아오면 빈 날짜와 B/S를 캐시에서 복원한다', async ({ page }) => {
  await fixture(page, 'D');
  const requested: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/trading/v2/executions') requested.push(url.searchParams.get('date')!);
  });
  await page.goto('/live');
  const frame = page.locator('[data-win="fills"]');
  await expect.poll(() => page.evaluate(() => (window as ChartsWindow).__liveCharts?.get('fills')?.panes()[0]
    ?.getSeries().find(series => series.seriesType() === 'Candlestick')?.data().length ?? 0)).toBeGreaterThanOrEqual(3);
  const range = async (recent: boolean) => page.evaluate(recent => {
    const chart = (window as ChartsWindow).__liveCharts!.get('fills')!;
    const rows = chart.panes()[0].getSeries().find(series => series.seriesType() === 'Candlestick')!.data();
    chart.timeScale().setVisibleRange({ from: rows[recent ? rows.length - 2 : 0].time,
      to: rows[recent ? rows.length - 1 : 1].time });
  }, recent);
  await range(true);
  await frame.getByRole('button', { name: '차트 설정', exact: true }).click();
  await page.getByRole('dialog', { name: '차트 설정', exact: true }).getByRole('switch', { name: '매매내역 표시', exact: true }).check();
  await page.keyboard.press('Escape');
  await frame.getByRole('combobox', { name: '매매 계좌' }).selectOption(accountA);
  await expect.poll(() => [...requested]).toEqual(['20260527', '20260526']);
  await expect.poll(() => page.evaluate(() => (window as ChartsWindow).__executionPaints?.some(p => p.text === 'B'))).toBe(true);
  await range(false);
  await expect.poll(() => [...requested]).toEqual(['20260527', '20260526', '20260525']);
  await expect(frame.getByTestId('account-execution-status')).toContainText('조회된 매매내역 없음');
  await page.evaluate(() => { (window as ChartsWindow).__executionPaints = []; });
  await range(true);
  await expect(frame.getByTestId('account-execution-status')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as ChartsWindow).__executionPaints?.some(p => p.text === 'B'))).toBe(true);
  expect(requested).toEqual(['20260527', '20260526', '20260525']);
});
