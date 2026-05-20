import { test, expect } from '@playwright/test';

test.describe('Replay smoke', () => {
  test.skip(
    true,
    'Gated on Workarea wiring (ChartStage + CursorSidebarConnected mounted) and data-pane attributes on the 5 chart panes.',
  );

  test('replay viewer happy path renders all 5 panes', async ({ page }) => {
    await page.goto('/replay');
    await expect(page.getByText('분석 시작')).toBeVisible();

    // Pick stock
    await page.getByRole('button', { name: /종목 선택|005930/ }).click();
    await page.getByText('삼성전자').click();

    // Pick a single date
    await page.locator('.date-field').first().click();
    await page.getByRole('button', { name: '20' }).click();
    await page.locator('.date-field').nth(1).click();
    await page.getByRole('button', { name: '20' }).click();

    // Click Load
    await page.getByRole('button', { name: /데이터 불러오기/ }).click();

    // Verify all 5 panes render (gated on data-pane attribute additions)
    for (const pane of ['candle', 'volume', 'ratio', 'intensity', 'fill-strength']) {
      await expect(page.locator(`[data-pane="${pane}"]`)).toBeVisible({ timeout: 5000 });
    }

    // Sidebar 3 cards (gated on data-card attribute additions — currently data-testid)
    await expect(page.locator('[data-card="orderbook"]')).toBeVisible();
    await expect(page.locator('[data-card="brokers"]')).toBeVisible();
    await expect(page.locator('[data-card="fills"]')).toBeVisible();
  });
});
