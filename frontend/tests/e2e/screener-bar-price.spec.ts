import { test, expect } from '@playwright/test';
import type { ConditionLeaf, ScanRequest } from '../../src/api/screener';
import { apiExact } from './helpers/apiRoutes';
import { installLiveMocks } from './helpers/liveMocks';


test('five candle conditions preserve independent timeframes, counts and policy after save/reload', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let saved = { id: 'bar-prices', name: '주기별 가격 조건', universe: {}, created_at_ms: 1, updated_at_ms: 1,
    conditions: [
      { id: 'high', type: 'new_high_today', params: { period: 20, include_open_bar: false } },
      { id: 'period-high', type: 'new_high', params: { lookback: 10, period: 60, include_open_bar: false } },
      { id: 'volume', type: 'new_high_vol_today', params: { period: 30, include_open_bar: false } },
      { id: 'near', type: 'high_off_peak', params: { period: 52, pct: 10, side: 'within', include_open_bar: false } },
      { id: 'average', type: 'ma', params: { period: 20, relation: 'above', include_open_bar: false } },
    ] as ConditionLeaf[] };
  const scans: ScanRequest[] = [];
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: { status: 'ok', warnings: [] } }));
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [saved] } }));
  await page.route(apiExact('screener/saves/bar-prices'), route => {
    const body = route.request().postDataJSON();
    saved = { ...saved, ...body, updated_at_ms: saved.updated_at_ms + 1 };
    return route.fulfill({ json: saved });
  });
  await page.route(apiExact('screener/scan'), route => {
    const request: ScanRequest = route.request().postDataJSON();
    scans.push(request);
    const evidence = { window_start_ms: 1785373200000, is_open: false, fetched_at_ms: 1785374100000 };
    return route.fulfill({ json: { status: 'ok', warnings: [], bar_coverage: { total: 1, complete: 1, incomplete: [] },
      rows: [{ code: '005930', name: '삼성전자', market: 'KOSPI', price: 70000, trade_value_won: 1e8, change_pct: 0,
        occurrences: request.conditions.map(leaf => ({ condition_id: leaf.id, condition_key: leaf.id,
          date: '2026-07-30', bar_start_ms: 1785373500000,
          ...(leaf.type === 'new_high_vol_today'
            ? { bar_match: { ...evidence, timeframe: leaf.params.timeframe, volume: 300, maximum: 300 } }
            : { bar_price_match: { ...evidence, timeframe: 'timeframe' in leaf.params ? leaf.params.timeframe : 'D',
              source: leaf.type === 'ma' ? leaf.params.source : 'high', value: 70000, reference: 69000 } }),
        })) }] } });
  });
  await page.goto('/screener');
  await expect(page.getByRole('combobox', { name: '봉 주기', exact: true })).toHaveCount(5);
  for (const [index, value] of ['5m', 'W', '3m', 'M', 'D'].entries()) {
    await page.getByRole('combobox', { name: '봉 주기', exact: true }).nth(index).selectOption(value);
    await expect(page.getByLabel('진행 중 봉 포함')).toHaveCount(0);
  }
  await page.getByLabel('최근 기간(봉)').fill('4');
  await page.getByLabel('신고 기준 기간(봉)').nth(0).fill('12');
  await page.getByLabel('MA 기준가격').selectOption('low');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(() => saved.conditions[0].params).toMatchObject({ timeframe: '5m', period: 12, include_open_bar: true });
  await expect(page.getByRole('button', { name: '저장본으로 되돌리기', exact: true })).toHaveCount(0);
  await page.reload();
  for (const [index, value] of ['5m', 'W', '3m', 'M', 'D'].entries()) {
    await expect(page.getByRole('combobox', { name: '봉 주기', exact: true }).nth(index)).toHaveValue(value);
    await expect(page.getByLabel('진행 중 봉 포함')).toHaveCount(0);
  }
  await expect(page.getByLabel('최근 기간(봉)')).toHaveValue('4');
  await expect(page.getByLabel('신고 기준 기간(봉)').nth(0)).toHaveValue('12');
  await expect(page.getByLabel('MA 기준가격')).toHaveValue('low');
  await page.getByRole('button', { name: '조회', exact: true }).click();
  await expect(page.getByText('봉 이력 충분 1/1종목')).toBeVisible();
  expect(scans.at(-1)?.conditions).toEqual(saved.conditions);
  await page.screenshot({ path: testInfo.outputPath('bar-price-wide.png'), fullPage: true });
  await page.setViewportSize({ width: 768, height: 1000 });
  for (const label of ['신고가', '기간내 신고가', '신고거래량', '신고가 대비 고가', '이동평균']) {
    const card = page.getByRole('group', { name: `${label} 조건`, exact: true });
    const control = card.getByRole('combobox', { name: '봉 주기', exact: true });
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeVisible();
    const bounds = await card.boundingBox();
    const input = await control.boundingBox();
    expect(input!.y + input!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height);
  }
  await page.screenshot({ path: testInfo.outputPath('bar-price-narrow.png'), fullPage: true });
  expect(errors).toEqual([]);
});
