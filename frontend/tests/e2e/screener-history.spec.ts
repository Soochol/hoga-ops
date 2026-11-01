import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';
import { installScreenerRunsMock } from './helpers/screenerRuns';
import { closeConditionSettings, openConditionSettings } from './helpers/screenerEditor';

for (const editWhileCollecting of [false, true]) {
  test(editWhileCollecting ? 'editing detaches from old automatic preparation'
    : 'one historical search automatically prepares and displays evidence', async ({ page }, info) => {
    await installLiveMocks(page);
    await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [{
      id: 'history', name: '거래량 검색', conditions: [{ id: 'v', type: 'new_high_vol',
        params: { lookback: 60, period: 250 } }], universe: {}, created_at_ms: 1, updated_at_ms: 1,
    }] } }));
    await page.route(apiExact('screener/status'), route => route.fulfill({ json: { status: 'ok' } }));
    let completed = false;
    const runs = await installScreenerRunsMock(page, () => ({ status: 'ok', warnings: [],
      history_coverage: { total: 1, complete: completed ? 1 : 0, incomplete: completed ? [] : [{
        code: '005930', condition_id: 'v', missing_days: 243, required_from: '2017-01-01',
        required_to: '2022-12-31', reason: 'missing_history',
      }] },
      rows: completed ? [{ code: '005930', name: '삼성전자', market: 'KOSPI', price: 70000,
        change_pct: 0, trade_value_won: 100000000, occurrences: [{ condition_id: 'v', condition_key: 'history',
          date: '2020-03-19' }], history_matches: [{ condition_id: 'v', date: '2020-03-19',
          volume: 10000000, maximum: 10000000, window_start: '2018-03-20', window_end: '2020-03-19' }] }] : [],
    }), () => !completed);
    await page.goto('/screener');
    await openConditionSettings(page, '기간내 신고거래량');
    await page.getByRole('combobox', { name: '거래량 검색 기간', exact: true }).selectOption('date_range');
    await closeConditionSettings(page);
    expect(runs.starts).toHaveLength(0);
    await page.getByRole('button', { name: '조회', exact: true }).click();
    const status = page.getByRole('status', { name: '조건검색 데이터 준비' });
    await expect(status).toContainText('데이터 준비 중 1');
    await expect(page.getByRole('button', { name: '과거 일봉 수집', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '새 기준 일봉 준비', exact: true })).toHaveCount(0);
    if (editWhileCollecting) {
      await openConditionSettings(page, '기간내 신고거래량');
      await page.getByLabel('거래량 발생 종료일').fill('2021-12-31');
      await closeConditionSettings(page);
      await expect(status).toHaveCount(0);
    }
    completed = true;
    if (editWhileCollecting) {
      await expect(page.getByRole('button', { name: '삼성전자 005930 호가창 열기', exact: true })).toHaveCount(0);
      expect(runs.starts).toHaveLength(1);
      await page.getByRole('button', { name: '조회', exact: true }).click();
    }
    await expect(page.getByRole('button', { name: '삼성전자 005930 호가창 열기', exact: true })).toBeVisible();
    await expect(status).toContainText('평가 완료 1/1종목');
    expect(runs.starts.at(-1)?.conditions[0].params).toMatchObject({
      end_date: editWhileCollecting ? '2021-12-31' : '2022-12-31',
    });
    await page.screenshot({ path: info.outputPath('automatic-history.png'), fullPage: true });
  });
}
