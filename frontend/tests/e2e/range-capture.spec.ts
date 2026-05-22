import { test, expect } from '@playwright/test';

test('range-capture: search → pick 3 trading days → Start → queue progresses to done × 3', async ({ page }) => {
  await page.goto('/capture');

  // 1. SymbolSearch "삼성" → click 삼성전자 005930
  const input = page.getByPlaceholder(/종목/);
  await input.fill('삼성');
  await page.getByText(/삼성전자/, { exact: false }).first().click();

  // 2. Click two calendar cells (a contiguous trading-day range of 3 days).
  //    The fixture's trading-day stub uses 20260518/19/20 (Mon–Wed).
  await page.getByTestId('calendar-cell-20260518').click();
  await page.getByTestId('calendar-cell-20260520').click();

  // 3. Start.
  await page.getByRole('button', { name: /Start/i }).click();

  // 4. capture_queued SSE: 3 rows appear.
  await expect(page.getByTestId(/^queue-row-/)).toHaveCount(3, { timeout: 5_000 });

  // 5. Phase transitions visible — wait for header summary to read "3 of 3 done".
  await expect(page.locator('text=/3 of 3 done/')).toBeVisible({ timeout: 15_000 });

  // 6. Append a second symbol's range — multi-symbol queue test.
  await input.fill('SK');
  await page.getByText(/SK하이닉스/, { exact: false }).first().click();
  await page.getByTestId('calendar-cell-20260518').click();
  await page.getByTestId('calendar-cell-20260520').click();
  await page.getByRole('button', { name: /Start/i }).click();
  await expect(page.locator('text=/6 of 6 done/')).toBeVisible({ timeout: 15_000 });

  // 7. Cancel All — drains any leftover queued; verify it does not crash.
  await page.getByRole('button', { name: /Cancel All/i }).click();
  // Second click confirms (two-step destructive guard).
  await page.getByRole('button', { name: /Click again to confirm/i }).click();

  // 8. Dismiss Done — table empties.
  await page.getByRole('button', { name: /Dismiss Done/i }).click();
  await expect(page.getByTestId(/^queue-row-/)).toHaveCount(0, { timeout: 5_000 });
});
