import { expect, test } from '@playwright/test';
import { apiExact } from './helpers/apiRoutes';
import { installLiveMocks } from './helpers/liveMocks';
import type { ScanRequest } from '../../src/api/screener';

test('automatic scans show server cutoff for empty, live and mixed results and retain it after reload', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  const completion = Date.UTC(2026, 9, 20, 1, 40);
  const confirmed = Date.UTC(2026, 9, 19, 6, 30);
  const live = Date.UTC(2026, 9, 20, 1, 35);
  await page.clock.setFixedTime(new Date(completion));
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: {
    status: 'ok', last_raw_date: '20261019', universe_size: 1,
  } }));
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { schema_version: 1, saves: [{
    id: 'automatic', name: '자동 기준 검색', conditions: [{ id: 'price', type: 'price_range', params: { min: 200000 } }],
    universe: {}, created_at_ms: 1, updated_at_ms: 1,
  }] } }));
  const requests: ScanRequest[] = [];
  await page.route(apiExact('screener/scan'), route => {
    requests.push(route.request().postDataJSON());
    const attempt = requests.length;
    return route.fulfill({ json: {
      status: 'ok', warnings: [], scanned_at_ms: completion,
      basis_at_ms: attempt === 1 ? confirmed : live,
      fallback_basis_at_ms: attempt === 3 ? confirmed : null,
      rows: attempt === 1 ? [] : [{ code: '005930', name: '삼성전자', market: 'KOSPI',
        price: 223500, change_pct: 3, trade_value_won: 100000000, price_date: '2026-10-20' }],
    } });
  });
  await page.goto('/screener');
  await expect(page.getByRole('button', { name: '오늘 장중', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '전일 확정', exact: true })).toHaveCount(0);
  const run = page.getByRole('button', { name: '조회', exact: true });
  const basis = page.getByTestId('screener-basis-time');
  await run.click();
  await expect(basis).toHaveText('2026-10-19 15:30 기준');
  await run.click();
  await expect(basis).toHaveText('2026-10-20 10:35 기준');
  await page.screenshot({ path: testInfo.outputPath('automatic-live-basis.png') });
  await page.reload();
  await expect(basis).toHaveText('2026-10-20 10:35 기준');
  expect(requests).toHaveLength(2);
  await run.click();
  await expect(basis).toHaveText('2026-10-19 15:30 ~ 2026-10-20 10:35 기준');
  expect(requests.map(request => request.basis)).toEqual(['auto', 'auto', 'auto']);
  await page.screenshot({ path: testInfo.outputPath('automatic-mixed-basis.png') });
});
