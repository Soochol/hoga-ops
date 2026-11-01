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
  await page.route(apiExact('screener/repair-history'), route => {
    expect(route.request().method()).toBe('POST');
    posts += 1;
    status = { ...status, updating: { done: 0, total: 0, started_ms: 1, phase: '종목 목록 확인 중' } };
    return route.fulfill({ json: { running: true, done: 0, total: 0 } });
  });
  await page.goto('/screener');
  const update = page.getByRole('button', { name: '과거 데이터 복구', exact: true });
  await expect(update).toHaveAttribute('data-tooltip', /종목 목록.*누락 일봉/);
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

test('ordinary refresh validates recent daily bars, blocks both buttons and preserves status after reload', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let status: ScreenerStatus = { status: 'ok', last_raw_date: '20261023', updating: null,
    last_refresh: { master_refreshed: true, symbols_added: 0, written_rows: 0,
      checked: 987, total: 987, failed: 987, unavailable: 0, completed_ms: 1000, reason: 'partial' } };
  let updates = 0;
  let repairs = 0;
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: status }));
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [] } }));
  await page.route(apiExact('screener/repair-history'), route => {
    repairs += 1;
    return route.fulfill({ json: { running: true, done: 0, total: 0 } });
  });
  await page.route(apiExact('screener/update'), route => {
    expect(route.request().method()).toBe('POST');
    updates += 1;
    status = { ...status, updating: { done: 7, total: 40, started_ms: Date.now(), automatic: false } };
    return route.fulfill({ json: { running: true, done: 7, total: 40, automatic: false } });
  });
  await page.goto('/screener');
  const update = page.getByRole('button', { name: '데이터 갱신', exact: true });
  const repair = page.getByRole('button', { name: '과거 데이터 복구', exact: true });
  await expect(update).toHaveAttribute('data-tooltip', /자동 갱신과 같은 절차/);
  await update.click();
  await expect(update).toBeDisabled();
  await expect(repair).toBeDisabled();
  await expect(update).toHaveAccessibleDescription(/수동 갱신 중 7\/40.*완료 후 갱신 가능/);
  await page.reload();
  await expect(page.getByTestId('screener-update-progress')).toContainText('7/40');
  await expect(update).toBeDisabled();
  await expect(repair).toBeDisabled();
  expect(updates).toBe(1);
  expect(repairs).toBe(0);
  status = { ...status, updating: null, daily_ingest: {
    attempts_today: 1, provisional: 3, confirmed: 2, quarantined: 1, legacy: 194,
    checked_on: '2026-10-24', last_trading_day: '20261023', last_attempt_at: '2026-10-24T22:00:00+09:00',
    failed_codes: 0, errors: {}, codes: 40, sample_count: 40, unavailable_codes: 0, unavailable: {},
    excluded_codes: 0, excluded_dates: 0, retryable_unavailable_codes: 0, retired_codes: 0, retired: {},
    skipped_codes: 0, provider_pages: 40, reused_samples: 0, elapsed_ms: 500, commit_pending: false,
  } };
  await page.reload();
  await expect(update).toBeEnabled();
  await expect(repair).toBeEnabled();
  await expect(page.getByText(/확정 2건 · 잠정 3건 · 충돌 격리 1건/)).toBeVisible();
  await expect(page.getByText(/실패 987종목/)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('daily-refresh-separated.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('scheduled refresh explains disabled actions and restores a dated shutdown result', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  const completedMs = Date.parse('2026-11-01T18:33:59+09:00');
  let status: ScreenerStatus = { status: 'ok', last_raw_date: '20261030',
    updating: { done: 1700, total: 4412, started_ms: completedMs + 1000, automatic: true },
    last_refresh: { master_refreshed: false, symbols_added: 0, written_rows: 0, checked: 0,
      total: 0, failed: 0, unavailable: 0, completed_ms: completedMs, reason: 'cancelled' } };
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: status }));
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [] } }));
  await page.goto('/screener');
  const update = page.getByRole('button', { name: '데이터 갱신', exact: true });
  const repair = page.getByRole('button', { name: '과거 데이터 복구', exact: true });
  await expect(update).toBeDisabled();
  await expect(repair).toBeDisabled();
  await expect(update).toHaveAccessibleDescription(/자동 갱신 중 1,700\/4,412.*완료 후 갱신 가능/);
  await expect(repair).toHaveAccessibleDescription(/자동 갱신 중 1,700\/4,412/);
  await expect(page.getByText(/갱신 중단됨|종목 목록 갱신 실패/)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('automatic-progress.png'), fullPage: true });

  status = { ...status, updating: null, last_refresh: { ...status.last_refresh!, reason: 'server_shutdown' } };
  await page.reload();
  await expect(update).toBeEnabled();
  await expect(repair).toBeEnabled();
  await expect(page.getByText(/지난 갱신 2026-11-01 18:33.*종목 목록 갱신 미완료.*서버 종료로 갱신 중단/)).toBeVisible();
  await expect(page.locator('time[datetime="2026-11-01T09:33:59.000Z"]')).toBeVisible();
  await expect(page.getByText(/종목 목록 갱신 실패/)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('shutdown-result.png'), fullPage: true });
});
