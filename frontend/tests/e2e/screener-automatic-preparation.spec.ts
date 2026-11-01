import { test, expect } from '@playwright/test';
import { apiExact } from './helpers/apiRoutes';
import { installLiveMocks } from './helpers/liveMocks';
import { installScreenerRunsMock } from './helpers/screenerRuns';

test('new-basis search shows partial results and resumes polling after a reload without another start', async ({ page }) => {
  await installLiveMocks(page);
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [{
    id: 'price', name: '신고가 검색', calculation_policy: 'separate_bases_v2',
    conditions: [{ id: 'high', type: 'new_high_today', params: { period: 3 } }], universe: {},
    created_at_ms: 1, updated_at_ms: 1,
  }] } }));
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: {
    status: 'ok', calculation_policies: ['legacy_v1', 'separate_bases_v2'],
  } }));
  let complete = false;
  const runs = await installScreenerRunsMock(page, () => ({ status: 'ok', warnings: [],
    calculation: { policy: 'separate_bases_v2', snapshot_id: 'a'.repeat(64), adjusted_as_of: '2026-10-30',
      price_basis: 'vendor_adjusted', event_revision: null, replayable: false },
    bar_coverage: { total: 2, complete: complete ? 2 : 1, incomplete: complete ? [] : [{
      code: '000660', condition_id: 'high', reason: 'vendor_price_unavailable',
    }] },
    rows: [{ code: '005930', name: '삼성전자', market: 'KOSPI', price: 70000, change_pct: 0,
      trade_value_won: 100000000, occurrences: [] }],
  }), () => !complete);
  await page.goto('/screener');
  expect(runs.starts).toHaveLength(0);
  await page.getByRole('button', { name: '조회', exact: true }).click();
  await expect(page.getByRole('status', { name: '조건검색 데이터 준비' })).toContainText('평가 완료 1/2종목');
  await expect(page.getByRole('button', { name: '삼성전자 005930 호가창 열기', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '새 기준 일봉 준비', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('status', { name: '조건검색 데이터 준비' })).toContainText('데이터 준비 중 1');
  expect(runs.starts).toHaveLength(1);
  complete = true;
  await expect(page.getByRole('status', { name: '조건검색 데이터 준비' })).toContainText('평가 완료 2/2종목');
  expect(runs.starts).toHaveLength(1);
  expect(runs.reads()).toBeGreaterThan(0);
});
