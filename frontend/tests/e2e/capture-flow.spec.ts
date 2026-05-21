import { test, expect } from '@playwright/test';

/**
 * STATUS (Task 23): Committed as the canonical E2E contract for the Capture UI
 * happy path + cross-page pill visibility. Like the other specs in this folder,
 * it is gated on harness wiring landing.
 *
 * Required harness (see `frontend/tests/e2e/README.md`):
 *   1. Playwright `webServer` (or external) running the backend with
 *      `HOGA_ENABLE_TEST_ENDPOINTS=1` so the captures router uses
 *      `FakeHogaplayClient` (Task 11) and a fake capture finishes in ~5-10s
 *      via `_fast_test=True` injection.
 *   2. Backend writable `HOGA_DATA_DIR` pointed at a tmp dir so the fake
 *      capture's stub TSV write doesn't pollute real data.
 *   3. Frontend dev server (vite) on :5173, backend on :8000 — matches the
 *      defaults baked into `playwright.config.ts` baseURL + the frontend's
 *      `/api` proxy.
 *
 * The spec is intentionally NOT skipped: it will activate the moment the
 * harness wiring lands, matching the pattern of `replay-smoke` and
 * `multi-tab`. Without that wiring it will fail at the form-submit step
 * because the real client_factory reads `.cookie` and won't return a
 * deterministic fake job.
 */
// Serial mode required: the backend enforces one capture at a time per server
// process (singleton _latest + asyncio.Lock). With fullyParallel=true, two
// tests racing on POST /api/captures would collide on the singleton.
test.describe.configure({ mode: 'serial' });

test.describe('Capture flow', () => {
  test('happy path: form → progress → done → Open in Replay', async ({ page }) => {
    await page.goto('/capture');

    // Form is visible; Start is disabled until both fields are filled.
    await expect(page.getByTestId('capture-code')).toBeVisible();
    await expect(page.getByTestId('capture-start')).toBeDisabled();

    // Fill and start. Older date → no partial banner; allow-partial untouched.
    await page.getByTestId('capture-code').fill('005930');
    await page.getByTestId('capture-date').fill('20260520');
    await page.getByTestId('capture-start').click();

    // Phase pill appears showing capturing or parsing.
    await expect(page.getByTestId('capture-phase')).toContainText(/CAPTURING|PARSING/, {
      timeout: 5000,
    });

    // LeftNav pill is visible while running.
    await expect(page.getByTestId('capture-pill')).toBeVisible({ timeout: 5000 });

    // Wait for terminal phase (fake collector takes ~5-10s).
    await expect(page.getByText(/Open in Replay/)).toBeVisible({ timeout: 30000 });

    // Click Open in Replay (the CTA text is "Open in Replay →").
    await page.getByText('Open in Replay →').click();
    await expect(page).toHaveURL(/\/replay\?code=005930&date=20260520/);
  });

  test('pill visible from Inventory page while capturing', async ({ page }) => {
    await page.goto('/capture');
    await page.getByTestId('capture-code').fill('005930');
    await page.getByTestId('capture-date').fill('20260520');
    await page.getByTestId('capture-start').click();
    await expect(page.getByTestId('capture-pill')).toBeVisible({ timeout: 5000 });

    // Navigate to Inventory; pill stays visible across pages.
    await page.goto('/inventory');
    await expect(page.getByTestId('capture-pill')).toBeVisible();

    // Wait for finish so the next test starts clean.
    await page.goto('/capture');
    await expect(page.getByText(/Open in Replay|Retry with Resume/)).toBeVisible({
      timeout: 30000,
    });
    await page.getByText('Dismiss').click();
  });
});
