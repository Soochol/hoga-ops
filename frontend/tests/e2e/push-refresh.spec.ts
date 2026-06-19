import { test, expect } from '@playwright/test';

/**
 * STATUS (W6.4): Live. The dev-only `POST /api/test/add-stockdate` endpoint
 * landed in W6.3 and is enabled by the Playwright `webServer` config's
 * `HOGA_ENABLE_TEST_ENDPOINTS=1` env. globalSetup seeds 005930 + 000660 first;
 * this spec then adds a third code at runtime and asserts the combobox
 * refreshes via the WebSocket event channel (ch:'event') without a page reload.
 */
test.describe('WebSocket inventory refresh', () => {
  test('inventory_added event refreshes the combobox without reload', async ({ page, request }) => {
    await page.goto('/replay');
    await page.getByRole('button', { name: /종목 선택/ }).click();
    const before = await page.locator('.combo-option').count();

    // Add a second date for 005930 (fixture exists; date differs from globalSetup's
    // 20260520, so this creates a new inventory row).
    await request.post('http://localhost:8080/api/test/add-stockdate?code=005930&date=20260521');

    await expect(page.locator('.combo-option')).toHaveCount(before + 1, { timeout: 2000 });
  });
});
