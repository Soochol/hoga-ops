import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

// Run against the system-installed Chrome rather than Playwright's bundled
// Chromium. This worktree's OS (ubuntu 26.04) is outside Playwright's current
// browser-support matrix, so `npx playwright install chromium` refuses.
// `/opt/google/chrome` is present and works for these smoke tests; switching
// channels is scoped to this file so other specs are unaffected.
test.use({ channel: 'chrome' });

/**
 * /live page e2e smoke. Backend-independent — every endpoint LivePage
 * touches is mocked via `installLiveMocks`. See
 * `tests/e2e/helpers/liveMocks.ts` for the contract.
 *
 * Coverage:
 *   - S1: empty state → symbol select → header + chart root mount
 *   - S2: defect-banner regression for f63ed15 (excluded_dates → alert,
 *         data_warnings → status). The banner copy is the user-facing
 *         signal that the invariant-outcomes path is wired end-to-end.
 */
test.describe('/live smoke', () => {
  test('S1: empty state → select symbol → chart root mounts with kis_live header', async ({
    page,
  }) => {
    await installLiveMocks(page);
    await page.goto('/live');

    // Empty state copy is visible before any symbol is selected.
    await expect(page.getByText('관심종목을 선택해주세요')).toBeVisible();

    // Open the watchlist panel and pick the only symbol.
    await page.getByRole('button', { name: /관심종목 패널 토글/ }).click();
    await page.getByText('098460', { exact: true }).first().click();

    // Header surfaces the selected code and the data source badge.
    await expect(page.getByText('098460').first()).toBeVisible();
    await expect(page.getByText('kis_live')).toBeVisible();

    // Chart root mounts (containerRef parent — present whenever the LivePage
    // selected-symbol branch renders).
    await expect(page.locator('[data-testid="live-chart-root"]')).toBeVisible();
  });

  test('S2: range with excluded + data_warnings surfaces defect banner (f63ed15 regression)', async ({
    page,
  }) => {
    await installLiveMocks(page, { range: 'with-defects' });
    await page.goto('/live');

    await page.getByRole('button', { name: /관심종목 패널 토글/ }).click();
    await page.getByText('098460', { exact: true }).first().click();

    // Excluded → role=alert with the exact user-visible copy + invariant id.
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('데이터 결함으로 제외된 날짜');
    await expect(alert).toContainText('5/18');
    await expect(alert).toContainText('meta.close_after_open');

    // Warning → role=status with the soft-warn copy + invariant id.
    const status = page.getByRole('status');
    await expect(status).toContainText('신뢰도 낮은 날짜');
    await expect(status).toContainText('5/27');
    await expect(status).toContainText('collection.finished');
  });

  test('S3: timeframe D unmounts hoga panes without console errors (ADR-0041)', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on('pageerror', (e) => consoleErrors.push(e.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await installLiveMocks(page);
    await page.goto('/live');

    // Select the only watchlist symbol.
    await page.getByRole('button', { name: /관심종목 패널 토글/ }).click();
    await page.getByText('098460', { exact: true }).first().click();
    await expect(page.locator('[data-testid="live-chart-root"]')).toBeVisible();

    // Toggle to D and re-assert chart root mounts. No assertion on pane DOM
    // (lightweight-charts canvases don't carry stable selectors); the
    // chart-root presence + clean console is the regression guard for
    // RangeSeriesPane's dynamic unmount cleanup.
    await page.getByRole('button', { name: 'D', exact: true }).click();
    await expect(page.locator('[data-testid="live-chart-root"]')).toBeVisible();

    // Round-trip back to 1m to exercise the dynamic *remount* path of the
    // hoga panes (RangeSeriesPane mount-after-unmount) — that's the actual
    // regression class for ADR-0041's pane-set switching, and the riskier
    // branch the unmount-only case doesn't cover.
    await page.getByRole('button', { name: '1m', exact: true }).click();
    await expect(page.locator('[data-testid="live-chart-root"]')).toBeVisible();

    // No "data must be asc ordered by time" and no React boundary catch —
    // the upstream noise we'd see if the pane mount race went wrong.
    // (RangeSeriesPane's removeSeries is wrapped in try/catch and never
    // reaches console, so we don't filter for that string.)
    expect(
      consoleErrors.filter(
        (e) =>
          e.includes('asc ordered by time') ||
          e.includes('The above error occurred'),
      ),
    ).toEqual([]);
  });
});
