import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact, apiPrefix } from './helpers/apiRoutes';

test('narrow screener drawer keeps dated occurrences compact and exclusion usable', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  const condition = { id: 'v', type: 'new_high_vol', params: {
    mode: 'date_range', start_date: '2011-01-01', end_date: '2031-12-31', record_period: { unit: 'years', value: 2 },
  } };
  const events = ['2021-08-12', '2021-08-11'];
  const exclusions: unknown[] = [];
  await page.route(apiExact('screener/saves'), r => r.fulfill({ json: { schema_version: 1, saves: [
    { id: 's1', name: '신고가, 거래대금', conditions: [condition], universe: {}, created_at_ms: 1, updated_at_ms: 1 },
  ] } }));
  await page.route(apiPrefix('screener/status'), r => r.fulfill({ json: { status: 'ok', days_behind: 0 } }));
  await page.route(apiPrefix('live/quotes'), r => r.fulfill({ json: { phase: 'open', quotes: [
    { code: '000660', price: 1851000, change_pct: -0.27, change_won: -5000 },
  ] } }));
  await page.route(apiExact('screener/exclusions'), r => {
    if (r.request().method() === 'PUT') {
      const body = r.request().postDataJSON();
      events.splice(events.indexOf(body.date), 1);
      const entry = { ...body, id: body.date, condition_key: 'volume', created_at_ms: 1 };
      exclusions.push(entry);
      return r.fulfill({ json: entry });
    }
    return r.fulfill({ json: { schema_version: 1, exclusions } });
  });
  await page.route(apiExact('screener/scan'), r => r.fulfill({ json: { status: 'ok', warnings: [], rows: [
    { code: '000660', name: 'SK하이닉스', market: 'KOSPI', price: 1851000, change_pct: -0.27,
      trade_value_won: 1e10, occurrences: events.map(date => ({ condition_id: 'v', condition_key: 'volume', date })) },
  ] } }));
  await page.goto('/heatmap');
  await page.getByRole('button', { name: /스크리너 패널 토글/ }).click();
  const panel = page.getByTestId('screener-panel');
  // Reproduce the user's narrow rail independently of saved desktop dimensions.
  await panel.evaluate(el => { el.style.width = '260px'; });
  await panel.getByRole('button', { name: /시작/ }).click();
  const rows = panel.getByTestId('screener-row-000660');
  await expect(rows).toHaveCount(2);
  await expect.poll(async () => (await rows.first().boundingBox())!.height).toBeLessThan(36);
  await expect(rows.first().getByText('2021-08-12', { exact: true })).toHaveCount(0);
  await expect(rows.first()).not.toContainText('기간내 신고거래량');
  await rows.first().getByText('SK하이닉스', { exact: true }).hover();
  await expect(page.getByRole('tooltip')).toContainText('기간내 신고거래량');
  await page.mouse.move(0, 0);
  await expect(rows.first().getByRole('button', { name: /발생 건 제외/ })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('narrow-occurrences.png') });
  await rows.first().getByRole('button', { name: /발생 건 제외/ }).click();
  await expect(rows).toHaveCount(1);
  expect(exclusions).toHaveLength(1);
  await expect(rows.first().getByText('2021-08-11', { exact: true })).toHaveCount(0);
  await expect(rows.first().getByRole('button', { name: /2021-08-11 .* 발생 건 제외/ })).toBeVisible();
});
