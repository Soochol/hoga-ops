import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import type { ScanRequest, VolumeParams } from '../../src/api/screener';
import { apiExact } from './helpers/apiRoutes';
import { installLiveMocks } from './helpers/liveMocks';

test('volume timeframe, candle counts and open-bar policy survive save/reload and scan', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  let saved = { id: 'bar-volume', name: '봉수 거래량', universe: {}, created_at_ms: 1, updated_at_ms: 1,
    conditions: [{ id: 'volume', type: 'new_high_vol' as const, params: { lookback: 60, period: 250, include_open_bar: false } as VolumeParams }] };
  const scans: ScanRequest[] = [];
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: { status: 'ok', warnings: [] } }));
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [saved] } }));
  await page.route(apiExact('screener/saves/bar-volume'), route => {
    saved = { ...saved, ...route.request().postDataJSON(), updated_at_ms: saved.updated_at_ms + 1 };
    return route.fulfill({ json: saved });
  });
  await page.route(apiExact('screener/scan'), route => {
    const request: ScanRequest = route.request().postDataJSON();
    scans.push(request);
    return route.fulfill({ json: { status: 'ok', warnings: ['bar_volume_partial'],
      bar_coverage: { total: 2, complete: 1,
        incomplete: [{ code: '000660', condition_id: 'volume', reason: 'missing_history' }] },
      rows: [{ code: '005930', name: '삼성전자', market: 'KOSPI', price: 70000,
        trade_value_won: 1e8, change_pct: 0, occurrences: [{ condition_id: 'volume', condition_key: 'bars',
          date: '2026-07-30', bar_start_ms: 1785373800000,
          bar_match: { timeframe: '5m', volume: 300, maximum: 300, window_start_ms: 1785373500000,
            is_open: false, fetched_at_ms: 1785374100000 } }] }] } });
  });
  // The read-only drawer must also migrate the old saved policy before a scan.
  await page.goto('/heatmap');
  await page.getByRole('button', { name: '스크리너 패널 토글' }).click();
  const panel = page.getByTestId('screener-panel');
  await panel.getByRole('button', { name: '실시간 감시 시작' }).click();
  await expect.poll(() => scans.at(-1)?.conditions[0].params).toMatchObject({ include_open_bar: true });
  await panel.getByRole('button', { name: '종료', exact: true }).click();
  await page.getByRole('button', { name: '스크리너 패널 토글' }).click();
  await page.goto('/screener');
  await expect(page.getByLabel('거래량 주기')).toHaveValue('D');
  await page.getByLabel('거래량 주기').selectOption('minute');
  await page.getByLabel('분봉 간격').selectOption('5m');
  await page.getByLabel('최근 기간(봉)').fill('3');
  await page.getByLabel('신고 기준 기간(봉)').fill('2');
  await expect(page.getByLabel('진행 중 봉 포함')).toHaveCount(0);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(() => saved.conditions[0].params).toMatchObject({ timeframe: '5m', lookback: 3, period: 2, include_open_bar: true });
  await expect(page.getByRole('button', { name: '저장본으로 되돌리기', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('분봉 간격')).toHaveValue('5m');
  await expect(page.getByLabel('최근 기간(봉)')).toHaveValue('3');
  await expect(page.getByLabel('신고 기준 기간(봉)')).toHaveValue('2');
  await expect(page.getByLabel('진행 중 봉 포함')).toHaveCount(0);
  await page.getByRole('button', { name: '조회', exact: true }).click();
  await expect(page.getByText('봉수 기준 평가 가능 1/2종목')).toBeVisible();
  expect(scans.at(-1)?.conditions[0].params).toMatchObject({ timeframe: '5m', lookback: 3, period: 2, include_open_bar: true });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '검색 결과 CSV', exact: true }).click();
  const csv = await readFile((await (await download).path())!, 'utf8');
  expect(csv).toContain('bar_start_ms');
  expect(csv).toContain('5m');
  await page.screenshot({ path: testInfo.outputPath('bar-volume-wide.png'), fullPage: true });
  for (const timeframe of ['W', 'M', 'D']) {
    await page.getByLabel('거래량 주기').selectOption(timeframe);
    await expect(page.getByLabel('최근 기간(봉)')).toHaveValue('3');
    await page.getByRole('button', { name: '조회', exact: true }).click();
    await expect.poll(() => scans.at(-1)?.conditions[0].params).toMatchObject({ timeframe, lookback: 3, period: 2 });
  }
  await page.setViewportSize({ width: 768, height: 850 });
  await page.screenshot({ path: testInfo.outputPath('bar-volume-narrow.png'), fullPage: true });
});
