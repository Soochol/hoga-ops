import { test, expect } from '@playwright/test';
import type { SavedScreener } from '../../src/api/savedScreeners';
import type { ScanRequest } from '../../src/api/screener';
import { apiExact } from './helpers/apiRoutes';
import { installLiveMocks } from './helpers/liveMocks';

test('add, validate, save and reload a top-200 change percentage rank, then display provider errors', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let saved: SavedScreener = { id: 'change-rank-test', name: '등락률 순위', conditions: [
    { id: 'price', type: 'price_range', params: { min: 1000 } },
  ], universe: {}, created_at_ms: 1, updated_at_ms: 1 };
  const requests: ScanRequest[] = [];
  let fail = false;
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: { status: 'ok' } }));
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [saved] } }));
  await page.route(apiExact('screener/saves/change-rank-test'), route => {
    saved = { ...saved, ...route.request().postDataJSON(), updated_at_ms: saved.updated_at_ms + 1 };
    return route.fulfill({ json: saved });
  });
  await page.route(apiExact('screener/scan'), route => {
    requests.push(route.request().postDataJSON());
    return fail
      ? route.fulfill({ status: 502, json: { detail: { code: 'screener_rank_upstream_failed',
        message: '키움 등락률 순위 조회에 실패했습니다. 다시 조회해 주세요' } } })
      : route.fulfill({ json: { status: 'ok', warnings: [], has_more: false, rows: [{
        code: '005930', name: '삼성전자', market: 'KOSPI', price: 1000, trade_value_won: 1e9, change_pct: 0,
        occurrences: [{ condition_id: saved.conditions.at(-1)!.id, condition_key: 'rank', date: '2026-10-30',
          change_pct_rank_match: { rank: 199, change_pct: 12.34, market: 'all', venue: 'KRX',
            fetched_at_ms: Date.parse('2026-10-30T10:20:00+09:00') } }],
      }] } });
  });
  await page.goto('/screener');
  await page.getByRole('button', { name: '조건 추가', exact: true }).click();
  await page.getByRole('menuitem', { name: '당일 등락률 순위', exact: true }).click();
  const card = page.getByRole('group', { name: '당일 등락률 순위 조건', exact: true });
  const input = card.getByRole('textbox', { name: '등락률 순위 상한', exact: true });
  await expect(input).toHaveValue('100');
  await expect(card.getByRole('combobox')).toHaveCount(0);
  await input.fill('1.5');
  await input.press('Tab');
  await expect(card.getByRole('alert')).toHaveText('정수로 입력하세요.');
  await expect(page.getByRole('button', { name: '조회', exact: true })).toBeDisabled();
  await input.fill('200');
  await input.press('Tab');
  await expect(page.getByRole('button', { name: '조회', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(() => saved.conditions.at(-1)).toMatchObject({ type: 'change_pct_rank', params: { top_n: 200 } });
  await page.reload();
  await expect(input).toHaveValue('200');
  await page.getByRole('button', { name: '조회', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].conditions).toEqual(saved.conditions);
  expect(requests[0].venue).toBe('KRX');
  await page.getByRole('button', { name: '삼성전자 등락률 순위 근거', exact: true }).click();
  const evidence = page.getByRole('dialog', { name: '삼성전자 등락률 순위 근거', exact: true });
  await expect(evidence).toContainText('등락률 199위');
  await expect(evidence).toContainText('전일 종가 대비 +12.34%');
  await expect(evidence).toContainText('10:20:00');
  await page.keyboard.press('Escape');
  await expect(evidence).toHaveCount(0);
  await expect(page).toHaveURL(/\/screener$/);
  await card.screenshot({ path: testInfo.outputPath('change-pct-rank.png') });
  await page.setViewportSize({ width: 768, height: 900 });
  await input.scrollIntoViewIfNeeded();
  await expect(input).toBeVisible();
  fail = true;
  await page.getByRole('button', { name: '조회', exact: true }).click();
  await expect(page.getByText(/키움 등락률 순위 조회에 실패했습니다/)).toBeVisible();
  expect(errors).toEqual([]);
});
