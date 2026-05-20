import { test, expect } from '@playwright/test';

test.describe('Error states (404 silent vs 5xx red)', () => {
  test.skip(
    true,
    'Gated on multi-day virtual-axis stitching + per-segment status rendering (data-segment-status).',
  );

  test('5xx renders red retry segment, 404 silently drops', async ({ page }) => {
    await page.route('**/api/session*', (route, request) => {
      const url = new URL(request.url());
      if (url.searchParams.get('date') === '20260519') {
        return route.fulfill({ status: 503, body: 'overloaded' });
      }
      return route.continue();
    });

    await page.goto('/replay?tabs=005930:20260518:20260520&active=0');
    await page.getByRole('button', { name: /데이터 불러오기|Reload/ }).click();

    await expect(page.locator('[data-segment-status="error"]')).toBeVisible();
    await expect(page.getByText(/Retry/)).toBeVisible();
    await expect(page.locator('[data-segment-status="loaded"]')).toHaveCount(2);
  });

  test('404 silently drops from virtual axis', async ({ page }) => {
    await page.route('**/api/session*date=20260524*', (route) =>
      route.fulfill({ status: 404 }),
    );

    await page.goto('/replay?tabs=005930:20260520:20260524&active=0');
    await expect(page.getByText(/Load failed/)).not.toBeVisible();
    await expect(page.locator('[data-segment-status="loaded"]')).toHaveCount(1);
  });
});
