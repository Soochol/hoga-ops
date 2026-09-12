import { expect, test } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

test('일별 투자자 전체에서 마우스 스크롤로 과거를 추가하고 고정 기간으로 돌아간다', async ({ page }) => {
  await installLiveMocks(page);
  await page.addInitScript(() => localStorage.setItem('live.investorDailySpan.v1', JSON.stringify({ span: 0 })));
  const requests: string[] = [];
  await page.route('**/api/live/past-investor-net?**', async (route) => {
    const url = new URL(route.request().url());
    const from = url.searchParams.get('from')!;
    const to = url.searchParams.get('to')!;
    requests.push(`${from}:${to}`);
    const date = (s: string) => Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}T00:00:00Z`);
    const points = [];
    for (let t = date(from); t <= date(to); t += 86400000) {
      if ([0, 6].includes(new Date(t).getUTCDay())) continue;
      points.push({ t_ms: t, foreign_net: 100, institution_net: -100 });
    }
    await route.fulfill({ json: { code: url.searchParams.get('code'), from, to, unit: 'qty_shares',
      points, cached_batches: [], fresh_batches: [], data_warnings: [] } });
  });
  await page.goto('/live?code=098460');
  await page.getByTestId('workspace-add-menu-button').click();
  await page.getByTestId('workspace-add-investor-daily').click();
  const scroller = page.getByLabel('일별 투자자 내역');
  const win = page.locator('[data-win]').filter({ has: scroller });
  const rows = win.getByTestId(/^investor-daily-row-/);
  await expect(rows).toHaveCount(60);
  await scroller.hover();
  await page.mouse.wheel(0, 10000);
  await expect.poll(() => rows.count()).toBeGreaterThan(60);
  await scroller.hover();
  await page.mouse.wheel(0, 10000);
  await expect.poll(() => rows.count()).toBeGreaterThan(100);
  expect(new Set(requests).size).toBeGreaterThanOrEqual(2);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await win.getByRole('button', { name: '5일', exact: true }).click();
  await expect(rows).toHaveCount(5);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(0);
});
