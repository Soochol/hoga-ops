import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';
import { installScreenerRunsMock } from './helpers/screenerRuns';

test('historical trade value prepares automatically from a single search', async ({ page }) => {
  await installLiveMocks(page);
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [{
    id: 'money', name: '거래대금 검색', conditions: [{ id: 'tv', type: 'trade_value_period',
      params: { lookback: 60, min_eok: 1000 } }], universe: {}, created_at_ms: 1, updated_at_ms: 1,
  }] } }));
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: { status: 'ok' } }));
  let completed = false;
  const runs = await installScreenerRunsMock(page, () => ({ status: 'ok', warnings: [],
    history_coverage: { total: 1, complete: completed ? 1 : 0, incomplete: completed ? [] : [{
      code: '005930', condition_id: 'tv', missing_days: 100, required_from: '2019-01-01',
      required_to: '2022-12-31', reason: 'missing_history',
    }] },
    rows: completed ? [{ code: '005930', name: '삼성전자', market: 'KOSPI', price: 70000,
      change_pct: 0, trade_value_won: 100000000, occurrences: [{ condition_id: 'tv', condition_key: 'history-tv',
        date: '2020-03-19' }], history_matches: [{ condition_id: 'tv', date: '2020-03-19',
        trade_value_won: 150000000000 }] }] : [],
  }), () => !completed);
  await page.goto('/screener');
  await page.getByRole('combobox', { name: '거래대금 검색 기간', exact: true }).selectOption('date_range');
  await page.getByRole('button', { name: '조회', exact: true }).click();
  await expect(page.getByRole('status', { name: '조건검색 데이터 준비' })).toContainText('데이터 준비 중 1');
  completed = true;
  await expect(page.getByRole('button', { name: '삼성전자 005930 호가창 열기', exact: true })).toBeVisible();
  expect(runs.starts).toHaveLength(1);
  expect(runs.starts[0].conditions[0]).toMatchObject({ type: 'trade_value_period', params: {
    mode: 'date_range', start_date: '2019-01-01', end_date: '2022-12-31', min_eok: 1000,
  } });
});
