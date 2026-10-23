import { test, expect } from '@playwright/test';
import type { ScreenerStatus } from '../../src/api/screener';
import { apiExact } from './helpers/apiRoutes';
import { installLiveMocks } from './helpers/liveMocks';

test('refresh shows per-symbol repair progress and restores the persisted result after reload', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let status: ScreenerStatus = { status: 'ok', last_raw_date: '20261020', updating: null };
  let posts = 0;
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: status }));
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [] } }));
  await page.route(apiExact('screener/update'), route => {
    expect(route.request().method()).toBe('POST');
    posts += 1;
    status = { ...status, updating: { done: 0, total: 0, started_ms: 1, phase: '종목 목록 확인 중' } };
    return route.fulfill({ json: { running: true, done: 0, total: 0 } });
  });
  await page.goto('/screener');
  const update = page.getByRole('button', { name: '데이터 갱신', exact: true });
  await expect(update).toHaveAttribute('data-tooltip', /최신 종목 목록.*과거 일봉/);
  await update.click();
  await expect(update).toBeDisabled();
  await expect(page.getByTestId('screener-update-progress')).toContainText('종목 목록 확인 중');
  expect(posts).toBe(1);
  status = { ...status, updating: { done: 7, total: 20, started_ms: 1, phase: '과거 일봉 보충 중' } };
  await page.reload();
  await expect(page.getByTestId('screener-update-progress')).toContainText('과거 일봉 보충 중 7/20');
  status = { ...status, updating: null, last_refresh: {
    master_refreshed: true, symbols_added: 2, written_rows: 258, checked: 20, total: 20,
    failed: 1, unavailable: 3, completed_ms: Date.now(), reason: 'partial',
  } };
  await page.reload();
  await expect(update).toBeEnabled();
  await expect(page.getByText(/종목 목록 반영 · 신규 2종목 · 일봉 258개 보충/)).toBeVisible();
  await expect(page.getByText(/실패 1종목 · 공급자 이력 미확인 3종목/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('refresh-result.png'), fullPage: true });
  expect(errors).toEqual([]);
});
