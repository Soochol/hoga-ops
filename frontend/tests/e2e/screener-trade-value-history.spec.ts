import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';
import type { HistoryJob, ScanRequest } from '../../src/api/screener';

test('historical trade value collects, rescans, and exports dated amount evidence', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  await page.route(apiExact('screener/saves'), r => r.fulfill({ json: { saves: [{
    id: 'money', name: '거래대금 검색', conditions: [{ id: 'tv', type: 'trade_value_period',
      params: { lookback: 60, min_eok: 1000 } }], universe: {}, created_at_ms: 1, updated_at_ms: 1,
  }] } }));
  await page.route(apiExact('screener/status'), r => r.fulfill({ json: { status: 'ok', warnings: [] } }));
  let job: HistoryJob | null = null;
  let allowCompletion = false;
  let collected = false;
  await page.route(apiExact('screener/history/jobs/current'), r => {
    if (job && allowCompletion) {
      collected = true;
      job = { ...job, status: 'complete', done: 1, written_rows: 984, current_code: null };
    }
    return r.fulfill({ json: job });
  });
  await page.route(apiExact('screener/history/jobs'), r => {
    const request: ScanRequest = r.request().postDataJSON();
    expect(request.conditions[0]).toMatchObject({ type: 'trade_value_period', params: {
      mode: 'date_range', start_date: '2019-01-01', end_date: '2022-12-31', min_eok: 1000,
    } });
    job = { id: 'money-job', status: 'collecting', request, codes: ['005930'], total: 1, done: 0,
      written_rows: 0, errors: {}, current_code: '005930', started_at_ms: Date.now(),
      cancel_requested: false, coverage: null };
    return r.fulfill({ json: job });
  });
  await page.route(apiExact('screener/scan'), r => r.fulfill({ json: {
    status: 'ok', warnings: [], history_coverage: { total: 1, complete: collected ? 1 : 0,
      incomplete: collected ? [] : [{ code: '005930', condition_id: 'tv', missing_days: 100,
        required_from: '2019-01-01', required_to: '2022-12-31', reason: 'missing_history' }] },
    rows: collected ? [{ code: '005930', name: '삼성전자', market: 'KOSPI', price: 70000,
      change_pct: 0, trade_value_won: 100000000, occurrences: [{ condition_id: 'tv', condition_key: 'history-tv', date: '2020-03-19' }], history_matches: [{ condition_id: 'tv',
        date: '2020-03-19', trade_value_won: 150000000000 }] }] : [],
  } }));
  await page.goto('/screener');
  await expect(page.getByLabel('최근 기간(일)')).toHaveValue('60');
  await page.getByRole('combobox', { name: '거래대금 검색 기간' }).selectOption('date_range');
  await expect(page.getByLabel('거래대금 발생 시작일')).toHaveValue('2019-01-01');
  await expect(page.getByLabel('거래대금 발생 종료일')).toHaveValue('2022-12-31');
  await page.getByRole('button', { name: '조회', exact: true }).click();
  await expect(page.getByText('이력 확인 필요 1종목', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '과거 일봉 수집', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '일봉 수집 · 0/1종목' })).toBeVisible();
  allowCompletion = true;
  await expect(page.getByText('2020-03-19', { exact: true })).toBeVisible();
  await expect(page.getByText('1,500억', { exact: true })).toBeVisible();
  await expect(page.getByText('전체 기간 평가 가능 1종목', { exact: false })).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '검색 결과 CSV', exact: true }).click();
  const file = await downloaded;
  const csv = await readFile((await file.path())!, 'utf8');
  expect(csv).toContain('과거 거래대금 조건 충족 기록');
  expect(csv).toContain('tv: 2020-03-19 150000000000원 (추정)');
  await page.screenshot({ path: testInfo.outputPath('trade-value-history.png'), fullPage: true });
});
