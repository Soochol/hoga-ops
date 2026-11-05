import { expect, test } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

function bars(from: string, to: string, tf: 'D' | 'W' | 'M') {
  const parse = (s: string) => new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8))));
  const start = parse(from);
  const end = parse(to);
  if (tf === 'W') start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  if (tf === 'M') start.setUTCDate(1);
  const result = [];
  const close = tf === 'W' ? 222 : tf === 'M' ? 333 : 111;
  for (const d = new Date(start); d <= end;) {
    if (tf !== 'D' || (d.getUTCDay() !== 0 && d.getUTCDay() !== 6)) {
      result.push({ t_ms: d.getTime(), open: close - 1, high: close + 2, low: close - 2, close, volume: 777, trade_value_won: 123456789 });
    }
    if (tf === 'M') d.setUTCMonth(d.getUTCMonth() + 1);
    else d.setUTCDate(d.getUTCDate() + (tf === 'W' ? 7 : 1));
  }
  return result;
}

test('domestic D/W/M uses native periods, extends on a real left pan, and restores monthly', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  const requests: Array<{ tf: string; from: string; count: number }> = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('live.workspace.v1')) sessionStorage.setItem('live.workspace.v1', JSON.stringify({
      schema_version: 2, windows: [{ id: 'native-calendar-test', kind: 'chart', group: 1,
        rect: { x: 0, y: 0, w: 0.85, h: 0.85 }, chart: { timeframe: 'D' } }],
      zOrder: ['native-calendar-test'], groupSymbols: {},
    }));
  });
  await page.route(/\/api\/live\/past-(daily|calendar)-candles\?/, route => {
    const params = new URL(route.request().url()).searchParams;
    const tf = params.get('timeframe');
    const timeframe = tf === 'W' || tf === 'M' ? tf : 'D';
    const from = params.get('from') ?? '';
    const to = params.get('to') ?? '';
    const candles = bars(from, to, timeframe);
    requests.push({ tf: timeframe, from, count: candles.length });
    return route.fulfill({ json: { code: '005930', from, to, venue: params.get('venue'),
      ...(timeframe === 'D' ? {} : { timeframe }), candles,
      cached_batches: [], fresh_batches: [from], data_warnings: [],
    } });
  });
  await page.goto('/live?code=005930');
  const frame = page.locator('.live-window-chart');
  const control = frame.getByRole('group', { name: 'LiveTimeframe' });
  await expect(frame.getByText('111원', { exact: true })).toBeVisible();
  await control.getByRole('button', { name: '주', exact: true }).click();
  await expect(frame.getByText('222원', { exact: true })).toBeVisible();
  expect(requests.some(r => r.tf === 'W')).toBe(true);
  const previousFrom = requests.filter(r => r.tf === 'W').at(-1)!.from;
  const box = await frame.getByTestId('live-chart-root').boundingBox();
  if (!box) throw new Error('Chart has no bounds');
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.4, { steps: 30 });
  await page.mouse.up();
  await expect.poll(() => requests.some(r => r.tf === 'W' && r.from < previousFrom)).toBe(true);
  await expect(frame.getByText('222원', { exact: true })).toBeVisible();
  await control.getByRole('button', { name: '월', exact: true }).click();
  await expect(frame.getByText('333원', { exact: true })).toBeVisible();
  expect(requests.some(r => r.tf === 'M')).toBe(true);
  await control.getByRole('button', { name: '일', exact: true }).click();
  await expect(frame.getByText('111원', { exact: true })).toBeVisible();
  await control.getByRole('button', { name: '월', exact: true }).click();
  await page.reload();
  await expect(control.getByRole('button', { name: '월', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(frame.getByText('333원', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('native-calendar.png') });
  await testInfo.attach('requests', { body: JSON.stringify(requests, null, 2), contentType: 'application/json' });
});
