import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import type { ConditionLeaf, ScanRequest } from '../../src/api/screener';
import { apiExact } from './helpers/apiRoutes';
import { installLiveMocks } from './helpers/liveMocks';

test('turnover, period turnover and referenced change preserve independent candle settings and CSV evidence', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let saved = { id: 'thresholds', name: '주기별 금액·등락', universe: {}, created_at_ms: 1, updated_at_ms: 1,
    conditions: [
      { id: 'amount', type: 'trade_value', params: { min_eok: 50 } },
      { id: 'period-amount', type: 'trade_value_period', params: { min_eok: 100, lookback: 60 } },
      { id: 'rate', type: 'change_pct', params: { op: 'gte', pct: 5 } },
    ] as ConditionLeaf[] };
  const scans: ScanRequest[] = [];
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: { status: 'ok', warnings: [] } }));
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [saved] } }));
  await page.route(apiExact('screener/saves/thresholds'), route => {
    saved = { ...saved, ...route.request().postDataJSON(), updated_at_ms: saved.updated_at_ms + 1 };
    return route.fulfill({ json: saved });
  });
  await page.route(apiExact('screener/scan'), route => {
    const request: ScanRequest = route.request().postDataJSON();
    scans.push(request);
    return route.fulfill({ json: { status: 'ok', warnings: [], bar_coverage: { total: 1, complete: 1, incomplete: [] },
      rows: [{ code: '005930', name: '삼성전자', market: 'KOSPI', price: 110000, trade_value_won: 1e9, change_pct: 0,
        occurrences: request.conditions.map(leaf => {
          const timeframe = 'timeframe' in leaf.params ? leaf.params.timeframe ?? 'D' : 'D';
          const date = timeframe === 'M' ? '2026-07-01' : timeframe === 'W' ? '2026-07-27' : '2026-07-30';
          return { condition_id: leaf.id, condition_key: leaf.id, date,
            bar_start_ms: Date.parse(`${date}T10:00:00+09:00`),
            ...(leaf.type === 'change_pct' ? { bar_change_match: { timeframe,
              change_reference: leaf.params.change_reference, change_pct: 100, close: 110000,
              reference_close: 55000, reference_start_ms: 0, is_open: false, fetched_at_ms: 1 } }
              : { bar_trade_value_match: { timeframe, trade_value_won: 2e10,
                method: timeframe === 'W' || timeframe === 'M' ? 'daily_estimate_sum' : 'ohlcv_estimate',
                is_open: false, fetched_at_ms: 1 } }) };
        }) }] } });
  });
  await page.goto('/screener');
  const amount = page.getByRole('group', { name: '거래대금 조건', exact: true });
  const period = page.getByRole('group', { name: '기간내 거래대금 조건', exact: true });
  const change = page.getByRole('group', { name: '등락률 조건', exact: true });
  await amount.getByLabel('봉 주기').selectOption('minute');
  await amount.getByLabel('최소 거래대금(억)').fill('1.5');
  await period.getByLabel('봉 주기').selectOption('W');
  await period.getByLabel('최근 기간(봉)').fill('4');
  await change.getByLabel('봉 주기').selectOption('M');
  await change.getByLabel('등락률 비교 기준').selectOption('previous_bar');
  await change.getByLabel('등락률(%)').fill('80');
  for (const card of [amount, period, change]) await card.getByLabel('진행 중 봉 포함').uncheck();
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(() => saved.conditions[2].params).toMatchObject({ timeframe: 'M', pct: 80,
    include_open_bar: false, change_reference: 'previous_bar' });
  await expect(page.getByRole('button', { name: '저장본으로 되돌리기', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(amount.getByLabel('분봉 간격')).toHaveValue('5m');
  await expect(period.getByLabel('봉 주기')).toHaveValue('W');
  await expect(period.getByLabel('최근 기간(봉)')).toHaveValue('4');
  await expect(change.getByLabel('등락률 비교 기준')).toHaveValue('previous_bar');
  await expect(change.getByLabel('등락률(%)')).toHaveValue('80');
  await page.getByRole('button', { name: '조회', exact: true }).click();
  await expect(page.getByText('봉수 기준 평가 가능 1/1종목')).toBeVisible();
  expect(scans.at(-1)?.conditions).toEqual(saved.conditions);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '검색 결과 CSV', exact: true }).click();
  const csv = await readFile((await (await download).path())!, 'utf8');
  for (const field of ['bar_trade_value_match', 'daily_estimate_sum', 'ohlcv_estimate', 'bar_change_match', 'previous_bar']) {
    expect(csv).toContain(field);
  }
  await period.getByLabel('거래대금 검색 기간').selectOption('date_range');
  await period.getByLabel('거래대금 발생 시작일').fill('2026-07-01');
  await period.getByLabel('거래대금 발생 종료일').fill('2026-07-30');
  await period.getByLabel('봉 주기').selectOption('M');
  await expect(period.getByLabel('진행 중 봉 포함')).not.toBeChecked();
  await change.getByLabel('등락률 비교 기준').selectOption('bar_open');
  await change.getByLabel('등락률 연산').selectOption('between');
  await change.getByLabel('등락률 하한(%)').fill('50');
  await change.getByLabel('등락률 상한(%)').fill('150');
  await page.getByRole('button', { name: '조회', exact: true }).click();
  await expect.poll(() => scans.at(-1)?.conditions[1].params).toMatchObject({ mode: 'date_range', timeframe: 'M',
    start_date: '2026-07-01', end_date: '2026-07-30', include_open_bar: false });
  expect(scans.at(-1)?.conditions[2].params).toMatchObject({ timeframe: 'M', change_reference: 'bar_open', lo: 50, hi: 150 });
  await expect(page.getByText('조건 변경됨 · 다시 조회 필요', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('bar-threshold-wide.png'), fullPage: true });
  await page.setViewportSize({ width: 768, height: 1000 });
  for (const card of [amount, period, change]) {
    const input = card.getByLabel('진행 중 봉 포함');
    await input.scrollIntoViewIfNeeded();
    await expect(input).toBeVisible();
    const bounds = await card.boundingBox();
    const check = await input.boundingBox();
    expect(check!.y + check!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height);
  }
  await page.screenshot({ path: testInfo.outputPath('bar-threshold-narrow.png'), fullPage: true });
  expect(errors).toEqual([]);
});
