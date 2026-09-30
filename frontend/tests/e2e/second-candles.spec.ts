import { test, expect } from '@playwright/test';
import { API_URL } from './worktreeEnv';
import { installLiveMocks } from './helpers/liveMocks';

test('1·5·10·30초봉은 주기를 조회하고 새로고침 후 복원하며 분봉으로 돌아간다', async ({ page }) => {
  const actual = await page.request.get(`${API_URL}/api/live/second-aggregates?code=098460&date=20260930&seconds=10`);
  expect(actual.status()).toBe(200);
  expect((await actual.json()).seconds).toBe(10);
  let stage = 'initial';
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(`${stage}: ${error.message}`));
  await installLiveMocks(page);
  let secondRequests = 0;
  const requestedSeconds = new Set<number>();
  await page.route('**/api/live/second-aggregates?**', route => {
    secondRequests++;
    const url = new URL(route.request().url());
    const seconds = Number(url.searchParams.get('seconds'));
    requestedSeconds.add(seconds);
    const step = seconds * 1000;
    const t = Math.floor(Date.now()/step)*step - 30 * step;
    return route.fulfill({ json: { code: url.searchParams.get('code'), venue: url.searchParams.get('venue'),
      date: url.searchParams.get('date'), seconds, status: 'observed', coverage: 'unverified', storage_error: null,
      first_observed_ms: t, last_observed_ms: t+29*step,
      bars: Array.from({ length: 30 }, (_, i) => ({ t_ms: t+i*step, open: 35000+i*10, high: 35100+i*10,
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
  await expect(chart.getByText('선택한 날짜에 저장된 초봉이 없습니다', { exact: true })).toHaveCount(0);
  await expect.poll(() => secondRequests).toBeGreaterThan(0);
  for (const seconds of [1, 5, 30, 10]) {
    await chart.getByRole('button', { name: /초봉 선택 열기:/ }).click();
    await page.getByRole('menuitemradio', { name: `${seconds}초`, exact: true }).click();
    await expect(chart.getByRole('button', { name: `초봉 선택 열기: ${seconds}초`, exact: true })).toBeVisible();
    await expect.poll(() => requestedSeconds.has(seconds)).toBe(true);
  }
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

test('과거 초봉 날짜는 매물대와 연동하고 빈 날짜와 오늘 복귀를 처리한다', async ({ page }) => {
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const yesterdayKey = yesterday.replaceAll('-', '');
  const historyRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await installLiveMocks(page);
  await page.route('**/api/live/second-aggregates?**', route => {
    const url = new URL(route.request().url());
    const date = url.searchParams.get('date')!;
    const seconds = Number(url.searchParams.get('seconds'));
    historyRequests.push(url.search);
    const midnight = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00+09:00`);
    const from = Number(url.searchParams.get('from_ms') ?? midnight);
    expect(from).toBeGreaterThanOrEqual(midnight);
    expect(from).toBeLessThan(midnight + 86_400_000);
    const observed = date === yesterdayKey;
    const t = midnight + 9 * 3_600_000;
    const bars = observed ? Array.from({ length: 30 }, (_, i) => ({ t_ms: t + i * seconds * 1000,
      open: 35000, high: 35100, low: 34900, close: 35050, volume: 100, count: 5, trade_value: 3500000 })) : [];
    return route.fulfill({ json: { code: url.searchParams.get('code'), venue: url.searchParams.get('venue'),
      date, seconds, coverage: 'unverified', status: observed ? 'observed' : 'unavailable', storage_error: null,
      first_observed_ms: observed ? t : null, last_observed_ms: bars.at(-1)?.t_ms ?? null,
      bars: bars.filter(bar => bar.t_ms >= from),
      prices: observed && url.searchParams.get('include_prices') === 'true'
        ? [{ t_ms: t, price: 35000, side: 1, qty: 100, count: 5 }] : [] } });
  });
  await page.goto('/live?code=098460');
  await page.getByRole('button', { name: '분봉 선택 열기: 1분', exact: true }).first().click();
  await page.getByRole('menuitemradio', { name: '10초', exact: true }).click();
  await page.getByRole('button', { name: '창 추가', exact: true }).click();
  await page.getByRole('menuitem', { name: '매물대 가격대별 체결 분포', exact: true }).click();
  const chart = page.getByTestId('second-chart');
  await chart.getByLabel('초봉 날짜', { exact: true }).fill(yesterday);
  await expect(chart.getByText('선택한 날짜에 저장된 초봉이 없습니다', { exact: true })).toHaveCount(0);
  await expect(chart.getByText('초봉 불러오는 중', { exact: true })).toHaveCount(0);
  await expect.poll(() => historyRequests.some(q => q.includes(`date=${yesterdayKey}`) && q.includes('include_prices=true'))).toBe(true);
  await chart.getByRole('button', { name: '초봉 선택 열기: 10초', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '1초', exact: true }).click();
  await expect(chart.getByLabel('초봉 날짜')).toHaveValue(yesterday);
  await expect.poll(() => historyRequests.some(q => q.includes(`date=${yesterdayKey}`) && q.includes('seconds=1&'))).toBe(true);
  await chart.getByRole('button', { name: '초봉 이전 날짜', exact: true }).click();
  await expect(chart.getByText('선택한 날짜에 저장된 초봉이 없습니다', { exact: true })).toBeVisible();
  await chart.getByRole('button', { name: '초봉 다음 날짜', exact: true }).click();
  await expect(chart.getByLabel('초봉 날짜')).toHaveValue(yesterday);
  await chart.getByRole('button', { name: '오늘', exact: true }).click();
  await expect(chart.getByLabel('초봉 날짜')).toHaveValue(today);
  await expect(chart.getByRole('button', { name: '초봉 다음 날짜', exact: true })).toBeDisabled();
  expect(pageErrors).toEqual([]);
});
