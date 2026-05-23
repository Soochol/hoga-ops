// Status: live but requires Playwright globalSetup / backend fixture seeding
// (same gating as replay-smoke.spec.ts and replay-zoom.spec.ts). Uses the
// `?tabs=...` URL hydration pattern to reach a loaded tab without driving
// the stock combobox, then toggles MA 20 off via the Settings modal.
//
// The store is intentionally NOT exposed on `window` in production code, so
// we verify the toggle round-trips by re-opening the modal and asserting the
// MA 20 checkbox is unchecked. This implicitly proves the change persisted
// through the zustand store (the modal reads `prefs.movingAverages[2]`).
import { test, expect } from '@playwright/test';

const CODE = '003490';
const DATE = '20260511';

test.describe('Replay viewer — indicators (Moving Average toggle)', () => {
  test('MA 20 checkbox toggles off and persists through the store', async ({ page }) => {
    await page.goto(`/replay?tabs=${CODE}:${DATE}:${DATE}:1m&active=0`);

    // Wait for the candle pane — guarantees a `loaded` tab with prefs available.
    await page.waitForSelector('[data-pane="candle"]', { timeout: 15_000 });

    // Open Settings via the gear button in the Toolbar.
    await page.getByRole('button', { name: '설정' }).click();

    // Modal is open — switch to 보조지표 category.
    const dialog = page.getByRole('dialog', { name: '설정' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '보조지표' }).click();

    // MA 20 is the 3rd row by default (periods 5 / 10 / 20 / 60 / 120).
    const ma20 = dialog.getByRole('checkbox', { name: /MA 20/i });
    await expect(ma20).toBeChecked();
    await ma20.click();
    await expect(ma20).not.toBeChecked();

    // Close the modal via the footer 닫기 button. There are two 닫기 controls
    // (header ✕ has aria-label "닫기" and the footer button has text "닫기"),
    // so pick the footer one by role+name.
    await dialog.getByRole('button', { name: '닫기' }).last().click();
    await expect(dialog).not.toBeVisible();

    // Re-open Settings → 보조지표 and verify MA 20 is still unchecked.
    // This round-trips through the zustand store: the modal re-reads
    // `prefs.movingAverages[2].enabled` from `useTabsStore` on mount.
    await page.getByRole('button', { name: '설정' }).click();
    const dialog2 = page.getByRole('dialog', { name: '설정' });
    await expect(dialog2).toBeVisible();
    await dialog2.getByRole('button', { name: '보조지표' }).click();
    const ma20Again = dialog2.getByRole('checkbox', { name: /MA 20/i });
    await expect(ma20Again).not.toBeChecked();
  });
});
