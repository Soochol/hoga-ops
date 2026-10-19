import { test, expect, type Page } from '@playwright/test';

async function mount(page: Page) {
  await page.route(url => url.pathname === '/', route => route.fulfill({ contentType: 'text/html',
    body: '<html><body><script>window.$RefreshSig$=()=>type=>type;window.$RefreshReg$=()=>{};window.__vite_plugin_react_preamble_installed=true;</script></body></html>',
  }));
  await page.goto('/');
  await page.evaluate(async () => {
    const path = '/tests/e2e/helpers/investorEstimateRecoveryHarness.tsx';
    (await import(path)).mount();
  });
}

function response(code: string, pending: boolean) {
  const row = { slot: '090000', foreign_qty: code === '005930' ? 1234 : 5678, institution_qty: 100,
    sum_qty: 0, foreign_amt_mwon: 10, institution_amt_mwon: 20, sum_amt_mwon: 30 };
  return { code, trading_day: '20261019', fetched_at_ms: pending ? null : 1, source: 'kis',
    status: pending ? 'error' : 'ok', rows: pending ? [] : [row], latest: pending ? null : row,
    data_warning: pending ? { reason: 'request_pending', msg: 'still fetching' } : null };
}

test('a pending response stays loading then displays late rows without waiting for a minute', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/live/investor-trend-estimate?*', route => {
    const code = new URL(route.request().url()).searchParams.get('code')!;
    return route.fulfill({ json: response(code, ++calls === 1) });
  });
  await mount(page);
  await expect(page.getByText('조회 중', { exact: true })).toBeVisible();
  await expect(page.getByText('조회 실패', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('table')).toContainText('1,234', { timeout: 5_000 });
  expect(calls).toBe(2);
});

test('switching symbols cancels pending follow-up and never shows the previous rows', async ({ page }) => {
  const codes: string[] = [];
  await page.route('**/api/live/investor-trend-estimate?*', route => {
    const code = new URL(route.request().url()).searchParams.get('code')!;
    codes.push(code);
    return route.fulfill({ json: response(code, code === '005930') });
  });
  await mount(page);
  await expect(page.getByText('조회 중', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '다른 종목', exact: true }).click();
  await expect(page.getByRole('table')).toContainText('5,678');
  await page.clock.install();
  await page.clock.runFor(4_000);
  expect(codes).toEqual(['005930', '000660']);
  await expect(page.getByRole('table')).not.toContainText('1,234');
});
