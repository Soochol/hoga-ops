import { expect, test } from '@playwright/test';

for (const initial of ['pending', 'failed'] as const) {
  test(`symbol counts remain selectable through ${initial} and recover`, async ({ page }) => {
    let status: 'pending' | 'ready' | 'failed' = initial;
    let retries = 0;
    let masterRefreshes = 0;
    await page.route('**/api/symbols/all', (route) => route.fulfill({ json: {
      status: 'fresh', fetched_at_ms: Date.now(), capture_counts_status: status,
      symbols: [{ code: '005930', name: '삼성전자', market: 'KOSPI', captured_count: status === 'ready' ? 7 : 0,
        capture_counts_status: status,
        captured_breakdown: { complete: status === 'ready' ? 7 : 0, source_partial: 0, client_incomplete: 0, invalid: 0 } }],
    } }));
    await page.route('**/api/symbols/capture-counts', (route) => route.fulfill({ json: { status } }));
    await page.route('**/api/symbols/capture-counts/refresh', (route) => {
      retries += 1;
      status = 'pending';
      return route.fulfill({ json: { status } });
    });
    await page.route('**/api/symbols/refresh', (route) => {
      masterRefreshes += 1;
      return route.abort();
    });
    await page.goto('/capture');
    const input = page.getByPlaceholder('종목명 또는 6자리 코드');
    await input.fill('삼성');
    const option = page.getByRole('option').filter({ hasText: '삼성전자' });
    await expect(option).toBeVisible();
    await expect(option).toContainText(initial === 'pending' ? '집계 중' : '집계 실패');
    await expect(option).not.toContainText('완결 없음');
    if (initial === 'failed') {
      await page.getByRole('button', { name: '집계 재시도' }).click();
      await expect(option).toContainText('집계 중');
      expect(retries).toBe(1);
      expect(masterRefreshes).toBe(0);
    }
    // Selection remains available while counts are unknown.
    await option.click();
    await expect(input).toHaveValue('삼성전자 005930');
    await input.fill('');
    await input.fill('삼성');
    status = 'ready';
    await expect(option).toContainText('완결 7일');
    await expect(option).not.toContainText('집계 중');
  });
}
