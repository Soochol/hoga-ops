import { test, expect, request } from '@playwright/test';

const API = 'http://127.0.0.1:8765';

test('cookie-pause: 3rd request → pause banner → Resume → completes', async ({ page }) => {
  // Configure the fake to raise on the 3rd capture request.
  const api = await request.newContext();
  await api.post(`${API}/api/test/cookie_expire_at`, { data: { index: 3 } });

  await page.goto('/capture');
  await page.getByPlaceholder(/종목/).fill('삼성');
  await page.getByText(/삼성전자/, { exact: false }).first().click();

  // Pick a 5-day range.
  await page.getByTestId('calendar-cell-20260518').click();
  await page.getByTestId('calendar-cell-20260522').click();
  await page.getByRole('button', { name: /Start/i }).click();

  // After ~2 captures land, the 3rd triggers pause.
  await expect(page.locator('text=/Cookie expired/i')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('text=/PAUSED/')).toBeVisible();

  // Disable the failure-injection and click Resume.
  await api.post(`${API}/api/test/cookie_expire_at`, { data: { index: -1 } });
  await page.getByRole('button', { name: /Resume/i }).click();

  // Queue resumes; eventually all 5 done.
  await expect(page.locator('text=/5 of 5 done/')).toBeVisible({ timeout: 20_000 });
});
