import { test, expect } from '@playwright/test';

test.describe('SSE inventory refresh', () => {
  test.skip(
    true,
    'Gated on backend /api/test/add-stockdate helper or test runner fs mutation; currently no test-only mutation endpoint exists.',
  );

  test('SSE inventory_added refreshes the combobox without reload', async ({ page, request }) => {
    await page.goto('/replay');
    await page.getByRole('button', { name: /종목 선택/ }).click();
    const before = await page.locator('.combo-option').count();

    await request.post('http://localhost:8000/api/test/add-stockdate?code=999999&date=20260520');

    await expect(page.locator('.combo-option')).toHaveCount(before + 1, { timeout: 2000 });
  });
});
