import { test, expect, type Page } from '@playwright/test';

async function loadStockDate(page: Page, code: string, date: string) {
  await page.getByRole('button', { name: /종목 선택|.+/ }).first().click();
  await page.locator(`[data-stock-code="${code}"]`).click();
  await page.locator('.date-field').first().click();
  await page.getByRole('button', { name: String(parseInt(date.slice(-2), 10)) }).click();
  await page.locator('.date-field').nth(1).click();
  await page.getByRole('button', { name: String(parseInt(date.slice(-2), 10)) }).click();
  await page.getByRole('button', { name: /데이터 불러오기|Reload/ }).click();
}

test.describe('Multi-tab isolation', () => {
  test.skip(true, 'Gated on Workarea wiring + backend fixture with >=2 stocks.');

  test('two tabs with different stocks isolate bundles', async ({ page }) => {
    await page.goto('/replay');
    await loadStockDate(page, '005930', '20260520');
    await expect(page.getByText('삼성전자')).toBeVisible();

    await page.getByText('+ 새 분석').click();
    await loadStockDate(page, '000660', '20260520');
    await expect(page.getByText('SK하이닉스')).toBeVisible();

    await page.locator('.tab').first().click();
    await expect(page.locator('.tab.active .tab-code')).toHaveText('005930');

    const sessionRequests = await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .filter((r) => r.name.includes('/api/session'))
        .map((r) => r.name),
    );
    expect(sessionRequests.filter((u) => u.includes('code=005930')).length).toBeGreaterThan(0);
    expect(sessionRequests.filter((u) => u.includes('code=000660')).length).toBeGreaterThan(0);
  });
});
