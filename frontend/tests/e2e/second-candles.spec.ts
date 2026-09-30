import { test, expect } from '@playwright/test';
import { API_URL } from './worktreeEnv';
import { installLiveMocks } from './helpers/liveMocks';

test('10초봉은 독립 원천으로 표시하고 새로고침 후 복원하며 분봉으로 돌아간다', async ({ page }) => {
  const actual = await page.request.get(`${API_URL}/api/live/second-aggregates?code=098460&date=20260930&seconds=10`);
  expect(actual.status()).toBe(200);
  expect((await actual.json()).seconds).toBe(10);
  let stage = 'initial';
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(`${stage}: ${error.message}`));
  await installLiveMocks(page);
  let secondRequests = 0;
  await page.route('**/api/live/second-aggregates?**', route => {
    secondRequests++;
    const url = new URL(route.request().url());
    const t = Math.floor(Date.now()/10_000)*10_000 - 300_000;
    return route.fulfill({ json: { code: url.searchParams.get('code'), venue: url.searchParams.get('venue'),
      date: url.searchParams.get('date'), seconds: 10, status: 'observed', coverage: 'unverified', storage_error: null,
      first_observed_ms: t, last_observed_ms: t+290_000,
      bars: Array.from({ length: 30 }, (_, i) => ({ t_ms: t+i*10_000, open: 35000+i*10, high: 35100+i*10,
        low: 34900+i*10, close: 35050+i*10, volume: 100+i, count: 5, trade_value: 35000*(100+i) })), prices: [] } });
  });
  await page.goto('/live?code=098460');
  const control = page.getByRole('button', { name: '분봉 선택 열기: 1분', exact: true }).first();
  await control.click();
  stage = 'minute-to-seconds';
  await page.getByRole('menuitemradio', { name: '10초', exact: true }).click();
  const chart = page.getByTestId('second-chart');
  await expect(chart).toBeVisible();
  await expect(chart.locator('canvas').first()).toBeVisible();
  await expect(chart.getByText('수집된 초봉이 없습니다')).toHaveCount(0);
  await expect.poll(() => secondRequests).toBeGreaterThan(0);
  stage = 'reload';
  await page.reload();
  await expect(page.getByTestId('second-chart')).toBeVisible();
  await chart.getByRole('button', { name: '초봉 선택 열기: 10초' }).click();
  stage = 'seconds-to-minute';
  await page.getByRole('menuitemradio', { name: '1분', exact: true }).click();
  await expect(page.getByTestId('second-chart')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '분봉 선택 열기: 1분', exact: true }).first()).toBeVisible();
  expect(pageErrors).toEqual([]);
});
