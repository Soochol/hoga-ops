import { test, expect } from '@playwright/test';
import { apiExact } from './helpers/apiRoutes';
import { installLiveMocks } from './helpers/liveMocks';
import { installScreenerRunsMock } from './helpers/screenerRuns';

test('one minute search finishes the universe and survives reload with compact coverage', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: {
    status: 'ok', calculation_policies: ['legacy_v1', 'separate_bases_v2'],
  } }));
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [{
    id: 'minute', name: '당일 분봉 거래량', calculation_policy: 'separate_bases_v2', universe: {},
    conditions: [{ id: 'minute', type: 'volume_range', params: {
      timeframe: '1m', min_volume: 100, offset: 0, include_open_bar: false } }],
    created_at_ms: 1, updated_at_ms: 1,
  }] } }));
  let complete = false;
  let oldScans = 0;
  await page.route(apiExact('screener/scan'), route => {
    oldScans += 1;
    return route.fulfill({ status: 500, json: { detail: 'unexpected bounded scan' } });
  });
  const runs = await installScreenerRunsMock(page, () => ({ status: 'ok', warnings: ['bar_volume_partial'],
    basis_at_ms: Date.parse('2026-10-30T15:30:00+09:00'),
    calculation: { policy: 'separate_bases_v2', snapshot_id: 'a'.repeat(64), adjusted_as_of: '2026-10-30',
      price_basis: 'vendor_adjusted', event_revision: null, replayable: false },
    bar_coverage: { total: 130, complete: complete ? 129 : 64, trading_date: '2026-10-30',
      incomplete: complete ? [{ code: '000660', condition_id: 'minute', reason: 'insufficient_day_bars' }]
        : Array.from({ length: 66 }, (_, i) => ({ code: String(i + 65).padStart(6, '0'),
          condition_id: 'preparation', reason: 'minute_preparation_pending' })) },
    rows: [{ code: '005930', name: '삼성전자', market: 'KOSPI', price: 70000, change_pct: 0,
      trade_value_won: 1e8, occurrences: [] }],
  }), () => !complete);
  await page.goto('/screener');
  await page.getByRole('button', { name: '조회', exact: true }).click();
  const progress = page.getByRole('status', { name: '분봉 검색 진행' });
  await expect(progress).toContainText('2026-10-30 분봉 검색 중 · 처리 64/130종목');
  await expect(page.getByRole('button', { name: '삼성전자 005930 호가창 열기', exact: true })).toBeVisible();
  await page.reload();
  await expect(progress).toContainText('처리 64/130종목');
  expect(runs.starts).toHaveLength(1);
  complete = true;
  await expect(progress).toContainText('분봉 검색 종료 · 처리 130/130종목');
  await expect(progress).toContainText('판정 보류 1종목');
  await page.getByText('상세 사유 · 1종목 확인 대기·보류', { exact: true }).click();
  await expect(page.getByText('해당 거래일의 비교 봉 부족: 1종목', { exact: true })).toBeVisible();
  expect(runs.starts).toHaveLength(1);
  expect(oldScans).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('minute-complete-wide.png'), fullPage: true });
  await page.setViewportSize({ width: 768, height: 850 });
  await page.screenshot({ path: testInfo.outputPath('minute-complete-narrow.png'), fullPage: true });
  await page.goto('/heatmap');
  await page.getByRole('button', { name: '스크리너 패널 토글' }).click();
  const panel = page.getByTestId('screener-panel');
  await expect(panel.getByText('2026-10-30 분봉 · 판정 129/130종목', { exact: true })).toHaveCount(1);
  await expect(panel.getByText('해당 거래일의 비교 봉 부족: 1종목', { exact: true })).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('minute-drawer.png'), fullPage: true });
  expect(errors).toEqual([]);
});
