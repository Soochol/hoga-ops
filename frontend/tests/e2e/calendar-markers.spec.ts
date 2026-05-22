import { test, expect } from '@playwright/test';
import { promises as fs } from 'fs';
import path from 'path';

const DATA_DIR = '/tmp/hoga-e2e-data';

test.beforeAll(async () => {
  // 20260501 — complete: parquet/meta.json with collection_complete=true, is_partial=false
  await fs.mkdir(path.join(DATA_DIR, 'parquet/20260501/005930'), { recursive: true });
  await fs.writeFile(
    path.join(DATA_DIR, 'parquet/20260501/005930/meta.json'),
    JSON.stringify({ collection_complete: true, is_partial: false }),
  );
  // 20260502 — source_partial: collection_complete=true, is_partial=true
  await fs.mkdir(path.join(DATA_DIR, 'parquet/20260502/005930'), { recursive: true });
  await fs.writeFile(
    path.join(DATA_DIR, 'parquet/20260502/005930/meta.json'),
    JSON.stringify({ collection_complete: true, is_partial: true }),
  );
  // 20260503 — client_incomplete: raw pages, no meta
  await fs.mkdir(path.join(DATA_DIR, 'raw/20260503/005930'), { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, 'raw/20260503/005930/first_0001.tsv'), '');
});

test('calendar-markers: ✓ ⚠ ✕ render per disk_state', async ({ page }) => {
  await page.goto('/capture');
  await page.getByPlaceholder(/종목/).fill('삼성');
  await page.getByText(/삼성전자/, { exact: false }).first().click();

  // 20260501 complete (✓)
  const cell01 = page.getByTestId('calendar-cell-20260501');
  await expect(cell01).toContainText('✓');
  // 20260502 source_partial (⚠)
  await expect(page.getByTestId('calendar-cell-20260502')).toContainText('⚠');
  // 20260503 client_incomplete (✕)
  await expect(page.getByTestId('calendar-cell-20260503')).toContainText('✕');
});

test('calendar-markers: complete date Start → immediately skipped/already_complete', async ({ page }) => {
  await page.goto('/capture');
  await page.getByPlaceholder(/종목/).fill('삼성');
  await page.getByText(/삼성전자/, { exact: false }).first().click();
  await page.getByTestId('calendar-cell-20260501').click();
  await page.getByTestId('calendar-cell-20260501').click();   // single-day range
  await page.getByRole('button', { name: /Start/i }).click();
  // Row should reach skipped quickly because the disk state is COMPLETE.
  await expect(page.locator('text=/skipped/i')).toBeVisible({ timeout: 3_000 });
});

test('calendar-markers: force_retry overrides source_partial skip', async ({ page }) => {
  await page.goto('/capture');
  await page.getByPlaceholder(/종목/).fill('삼성');
  await page.getByText(/삼성전자/, { exact: false }).first().click();
  await page.getByLabel(/Force re-capture/i).check();
  await page.getByTestId('calendar-cell-20260502').click();
  await page.getByTestId('calendar-cell-20260502').click();
  await page.getByRole('button', { name: /Start/i }).click();
  await expect(page.locator('text=/done/i').first()).toBeVisible({ timeout: 10_000 });
});
