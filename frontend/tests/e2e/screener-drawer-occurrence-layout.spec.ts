import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact, apiPrefix } from './helpers/apiRoutes';

test('narrow screener drawer keeps stock rows compact and existing exclusions restorable', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  const condition = { id: 'v', type: 'new_high_vol', params: {
    mode: 'date_range', start_date: '2011-01-01', end_date: '2031-12-31', record_period: { unit: 'years', value: 2 },
  } };
  const events = Array.from({ length: 312 }, (_, i) => new Date(Date.UTC(2026, 8, 10 - i)).toISOString().slice(0, 10));
  let exclusions = [{ id: 'first', condition, code: '000660', stock_name: 'SK하이닉스',
    date: events[0], condition_key: 'volume', created_at_ms: 1 }];
  await page.route(apiExact('screener/saves'), r => r.fulfill({ json: { schema_version: 1, saves: [
    { id: 's1', name: '신고가, 거래대금', conditions: [condition], universe: {}, created_at_ms: 1, updated_at_ms: 1 },
  ] } }));
  await page.route(apiPrefix('screener/status'), r => r.fulfill({ json: { status: 'ok', days_behind: 0 } }));
  await page.route(apiPrefix('live/quotes'), r => r.fulfill({ json: { phase: 'open', quotes: [
    { code: '000660', price: 1851000, change_pct: -0.27, change_won: -5000 },
  ] } }));
  await page.route(apiPrefix('screener/exclusions'), r => {
    if (r.request().method() === 'DELETE') { exclusions = []; return r.fulfill({ status: 204 }); }
    return r.fulfill({ json: { schema_version: 1, exclusions } });
  });
  await page.route(apiExact('screener/scan'), r => r.fulfill({ json: { status: 'ok', warnings: [], rows: [
    { code: '000660', name: 'SK하이닉스', market: 'KOSPI', price: 1851000, change_pct: -0.27,
      trade_value_won: 1e10, occurrences: events.filter(date => !exclusions.some(e => e.date === date))
        .map(date => ({ condition_id: 'v', condition_key: 'volume', date })) },
  ] } }));
  await page.goto('/heatmap');
  await page.getByRole('button', { name: /스크리너 패널 토글/ }).click();
  const panel = page.getByTestId('screener-panel');
  await panel.evaluate(el => { el.style.width = '260px'; });
  await panel.getByRole('button', { name: /시작/ }).click();
  const row = panel.getByTestId('screener-row-000660');
  await expect(row).toHaveCount(1);
  await expect.poll(async () => (await row.boundingBox())!.height).toBeLessThan(36);
  await expect(row).not.toContainText('2026-09-10');
  await expect(row.getByRole('button', { name: /발생/ })).toHaveCount(0);
  await expect(panel.getByText('발생 311건', { exact: false })).toBeVisible();
  await panel.getByRole('button', { name: '제외한 발생 건 1', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '제외한 발생 건', exact: true });
  const restore = dialog.getByRole('button', { name: 'SK하이닉스 2026-09-10 복원', exact: true });
  await expect(restore).toBeInViewport();
  await restore.click();
  await expect(restore).toHaveCount(0);
  expect(exclusions).toEqual([]);
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(panel.getByText('발생 312건', { exact: false })).toBeVisible();
  await expect(row).toHaveCount(1);
  await expect.poll(async () => (await row.boundingBox())!.height).toBeLessThan(36);
  await page.screenshot({ path: testInfo.outputPath('narrow-restored.png') });
});
