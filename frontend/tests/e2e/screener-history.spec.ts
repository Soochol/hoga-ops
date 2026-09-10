import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';
import type { HistoryJob, ScanRequest } from '../../src/api/screener';

for (const editWhileCollecting of [false, true]) {
  test(editWhileCollecting
    ? 'historical collection completion does not rescan changed conditions'
    : 'historical volume polls collection and rescans with evidence', async ({ page }, testInfo) => {
    await installLiveMocks(page);
    const condition = { id: 'v', type: 'new_high_vol', params: { lookback: 60, period: 250 } };
    await page.route(apiExact('screener/saves'), r => r.fulfill({ json: { saves: [{
      id: 'history', name: '거래량 검색', conditions: [condition], universe: {}, created_at_ms: 1, updated_at_ms: 1,
    }] } }));
    await page.route(apiExact('screener/status'), r => r.fulfill({ json: { status: 'ok', warnings: [] } }));
    let collected = false;
    let job: HistoryJob | null = null;
    let allowCompletion = false;
    let activePolls = 0;
    const scans: ScanRequest[] = [];
    await page.route(apiExact('screener/history/jobs/current'), r => {
      if (job?.status === 'collecting') {
        activePolls++;
        if (allowCompletion) {
          collected = true;
          job = { ...job, status: 'complete', done: 1, written_rows: 1475, current_code: null };
        }
      }
      return r.fulfill({ json: job });
    });
    await page.route(apiExact('screener/history/jobs'), async r => {
      const request: ScanRequest = r.request().postDataJSON();
      expect(request.conditions[0].params).toMatchObject({ record_period: { unit: 'years', value: 2 } });
      // Real Pydantic wire shape: type precedes id; request defaults are materialized.
      const normalized: ScanRequest = {
        conditions: request.conditions.map(leaf => leaf.type === 'new_high_vol'
          ? { type: leaf.type, id: leaf.id, params: leaf.params } : leaf),
        universe: { markets: [], exclude_etf: true, exclude_halted: false, scopes: [], ...request.universe },
        limit: request.limit ?? 1000, basis: request.basis ?? 'eod',
      };
      job = { id: 'job1', status: 'collecting', request: normalized, codes: ['005930'],
        total: 1, done: 0, written_rows: 0, errors: {}, current_code: '005930',
        started_at_ms: Date.now(), cancel_requested: false, coverage: null };
      await r.fulfill({ json: job });
    });
    await page.route(apiExact('screener/scan'), r => {
      scans.push(r.request().postDataJSON());
      return r.fulfill({ json: {
      status: 'ok', warnings: [], history_coverage: { total: 1, complete: collected ? 1 : 0,
        incomplete: collected ? [] : [{ code: '005930', condition_id: 'v', missing_days: 243,
          required_from: '2017-01-01', required_to: '2022-12-31', reason: 'missing_history' }] },
      rows: collected ? [{ code: '005930', name: '삼성전자', market: 'KOSPI', price: 70000,
        change_pct: 0, trade_value_won: 100000000, occurrences: [{ condition_id: 'v', condition_key: 'history', date: '2020-03-19' }], history_matches: [{ condition_id: 'v',
          date: '2020-03-19', volume: 10000000, maximum: 10000000,
          window_start: '2018-03-20', window_end: '2020-03-19' }] }] : [],
      } });
    });
    await page.goto('/screener');
    await page.getByRole('combobox', { name: '거래량 검색 기간' }).selectOption('date_range');
    await expect(page.getByLabel('거래량 발생 시작일')).toHaveValue('2019-01-01');
    await page.getByRole('button', { name: '조회', exact: true }).click();
    await expect(page.getByText('이력 확인 필요 1종목', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: '과거 일봉 수집', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '일봉 수집 · 0/1종목' })).toBeVisible();
    await expect(page.getByRole('button', { name: '수집 중단', exact: true })).toBeVisible();
    if (editWhileCollecting) {
      await page.getByLabel('거래량 발생 종료일').fill('2021-12-31');
      await expect(page.getByText(/다른 검색 조건의 수집입니다/)).toBeVisible();
    }
    allowCompletion = true;
    await expect(page.getByRole('status').filter({ hasText: '완료 · 1/1종목' })).toBeVisible();
    expect(activePolls).toBeGreaterThan(0);
    if (editWhileCollecting) {
      // The old job must leave the edited query pending until an explicit scan.
      await expect(page.getByText('2020-03-19', { exact: true })).toHaveCount(0);
      expect(scans).toHaveLength(1);
      await page.getByRole('button', { name: '조회', exact: true }).click();
    }
    await page.getByRole('button', { name: '삼성전자 발생 1건', exact: true }).click();
    await expect(page.getByText('2020-03-19', { exact: true })).toBeVisible();
    expect(scans).toHaveLength(2);
    expect(scans[1].conditions[0].params).toMatchObject({
      end_date: editWhileCollecting ? '2021-12-31' : '2022-12-31',
    });
    await expect(page.getByText('전체 기간 평가 가능 1종목', { exact: false })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('history.png'), fullPage: true });
  });
}
