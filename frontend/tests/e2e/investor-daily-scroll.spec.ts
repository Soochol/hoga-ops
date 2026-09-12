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

test('일별 투자자 총매수·총매도에서 단위 전환과 과거 스크롤이 선택한 기준을 유지한다', async ({ page }) => {
  await installLiveMocks(page);
  await page.addInitScript(() => {
    localStorage.setItem('live.investorDailySpan.v1', JSON.stringify({ span: 0 }));
    localStorage.setItem('live.investorEstimateUnit.v1', JSON.stringify({ unit: 'qty' }));
  });
  const requests: { side: string; axis: string; from: string }[] = [];
  await page.route('**/api/live/past-investor-net?**', async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const from = params.get('from')!;
    const to = params.get('to')!;
    const side = params.get('trade_side') ?? 'net';
    const axis = params.get('axis') ?? 'qty';
    requests.push({ side, axis, from });
    const parseDate = (s: string) => Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}T00:00:00Z`);
    const value = side === 'buy' ? 120 : side === 'sell' ? 130 : -10;
    const points = [];
    for (let t = parseDate(from); t <= parseDate(to); t += 86400000) {
      if (![0, 6].includes(new Date(t).getUTCDay())) points.push({ t_ms: t, foreign_net: value, institution_net: value });
    }
    await route.fulfill({ json: { code: params.get('code'), from, to, trade_side: side,
      unit: axis === 'qty' ? 'qty_shares' : 'amt_mwon', points,
      cached_batches: [], fresh_batches: [], data_warnings: [] } });
  });
  await page.goto('/live?code=098460');
  await page.getByTestId('workspace-add-menu-button').click();
  await page.getByTestId('workspace-add-investor-daily').click();
  const scroller = page.getByLabel('일별 투자자 내역');
  const win = page.locator('[data-win]').filter({ has: scroller });
  const rows = win.getByTestId(/^investor-daily-row-/);
  await expect(rows).toHaveCount(60);
  for (const side of ['총매수', '총매도']) {
    await win.getByRole('button', { name: side, exact: true }).click();
    await expect(win.getByText(`일별 ${side} · 오늘은 잠정`)).toBeVisible();
    await expect(rows.first().getByRole('cell').nth(1)).toHaveText(side === '총매수' ? '120' : '130');
  }
  await win.getByRole('button', { name: /표시 단위/ }).click();
  await expect(rows.first().getByRole('cell').nth(1)).toHaveText('1.3억');
  await scroller.hover();
  await page.mouse.wheel(0, 10000);
  await expect.poll(() => rows.count()).toBeGreaterThan(60);
  await scroller.hover();
  await page.mouse.wheel(0, 10000);
  await expect.poll(() => rows.count()).toBeGreaterThan(100);
  expect(new Set(requests.filter((r) => r.side === 'sell' && r.axis === 'amount').map((r) => r.from)).size).toBeGreaterThanOrEqual(2);
  await win.getByRole('button', { name: '순매수', exact: true }).click();
  await expect(win.getByText('일별 순매수 · 오늘은 잠정')).toBeVisible();
  await expect(rows).toHaveCount(60);
});
