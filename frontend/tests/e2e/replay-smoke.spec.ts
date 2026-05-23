import { test, expect } from '@playwright/test';

/**
 * STATUS (Wave 5.4): Live but flaky pending backend data setup.
 *
 * The spec is no longer skipped — Playwright will attempt to run it. However,
 * the "pick stock" step depends on the running backend's stock-date inventory
 * containing the fixture codes (005930, 000660). No setup script currently
 * bootstraps `tests/fixtures/tiny_tsv_multi/<code>/*` into `data/raw/...` and
 * triggers the parser, so this test will fail at the stock combobox step in
 * a fresh environment.
 *
 * See `frontend/tests/e2e/README.md` ("Remaining gating") for the items still
 * blocking a clean run.
 */
test.describe('Replay smoke', () => {
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
    for (const pane of ['candle', 'volume', 'ratio', 'quote-totals', 'fill-strength']) {
      await expect(page.locator(`[data-pane="${pane}"]`)).toBeVisible({ timeout: 5000 });
    }

    // Sidebar 3 cards (gated on data-card attribute additions — currently data-testid)
    await expect(page.locator('[data-card="orderbook"]')).toBeVisible();
    await expect(page.locator('[data-card="brokers"]')).toBeVisible();
    await expect(page.locator('[data-card="fills"]')).toBeVisible();
  });

  test('대한항공 (003490, 2026-05-11) loads without unmounting the app', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('pageerror', (e) => consoleErrors.push(e.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto('/replay?tabs=003490:20260511:20260511&active=0');

    // 5개 차트 pane이 모두 mount되어야 한다
    for (const pane of ['candle', 'volume', 'ratio', 'quote-totals', 'fill-strength']) {
      await expect(page.locator(`[data-pane="${pane}"]`)).toBeVisible({ timeout: 5000 });
    }

    // 사이드 네비가 살아 있어야 한다 (root unmount 회귀 가드)
    await expect(page.getByRole('link', { name: 'Replay Viewer' })).toBeVisible();

    // lightweight-charts assertion 메시지가 콘솔에 떠선 안 된다
    const assertionErr = consoleErrors.find((e) =>
      e.includes('data must be asc ordered by time'),
    );
    expect(assertionErr, `unexpected chart assertion: ${assertionErr}`).toBeUndefined();
  });
});
