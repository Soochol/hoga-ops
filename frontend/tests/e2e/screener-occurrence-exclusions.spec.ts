import { test, expect } from '@playwright/test';
import { apiExact, apiPrefix } from './helpers/apiRoutes';
import type { ScreenerExclusion, ScreenerExclusionWrite, ScanRequest } from '../../src/api/screener';

for (const total of [1, 300]) {
  test(`${total}종목 결과에서 날짜별 제외·재조회·복원`, async ({ page }, testInfo) => {
    let excluded: ScreenerExclusion[] = [];
    let failWrite = false;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(apiExact('screener/status'), r => r.fulfill({ json: { status: 'ready', days_behind: 0 } }));
    await page.route(apiExact('screener/saves'), r => r.fulfill({ json: { schema_version: 1, saves: [] } }));
    await page.route(apiPrefix('screener/exclusions'), async r => {
      if (r.request().method() === 'PUT') {
        if (failWrite) return r.fulfill({ status: 500, json: { detail: 'disk full' } });
        const body: ScreenerExclusionWrite = r.request().postDataJSON();
        const entry = { ...body, id: `${body.code}:${body.date}`, condition_key: 'trade-key', created_at_ms: Date.now() };
        excluded = [...excluded.filter(e => e.id !== entry.id), entry];
        return r.fulfill({ json: entry });
      }
      if (r.request().method() === 'DELETE') {
        const id = decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop()!);
        excluded = excluded.filter(e => e.id !== id);
        return r.fulfill({ status: 204 });
      }
      return r.fulfill({ json: { schema_version: 1, exclusions: excluded } });
    });
    await page.route(apiExact('screener/scan'), r => {
      const request: ScanRequest = r.request().postDataJSON();
      return r.fulfill({ json: { status: 'ok', warnings: [], has_more: false, scanned_at_ms: Date.now(),
        rows: Array.from({ length: total }, (_, index) => {
          const code = index === 0 ? '005930' : String(100000 + index);
          const occurrences = ['2026-09-09', '2026-09-08'].filter(date => !excluded.some(e => e.code === code && e.date === date))
            .map(date => ({ condition_id: request.conditions[0].id, condition_key: 'trade-key', date }));
          return { code, name: index === 0 ? '삼성전자' : `테스트${index}`, market: 'KOSPI',
            price: 70000, change_pct: 1, trade_value_won: 1e10, occurrences, price_date: '2026-09-09' };
        }).filter(row => row.occurrences.length > 0),
      } });
    });
    await page.addInitScript(() => localStorage.setItem('screenerDraft.v1', JSON.stringify({
      conditions: [{ id: 'v', type: 'trade_value_period', params: { lookback: 3, min_eok: 1 } }],
      universe: {}, anchorId: null, anchorName: null, dirty: true,
    })));
    await page.goto('/screener');
    await page.getByRole('button', { name: '조회', exact: true }).click();
    await page.getByLabel('삼성전자 발생 2건', { exact: true }).click();
    const removeLatest = page.getByRole('button', { name: '삼성전자 2026-09-09 기간내 거래대금 발생 건 제외', exact: true });
    await expect(removeLatest).toBeVisible();
    if (total === 300) await expect(page.getByTestId('screener-result-rows')).toHaveAttribute('data-virtualized', 'true');
    await page.getByRole('searchbox', { name: '결과 내 종목 검색' }).fill('삼성');
    await page.getByRole('checkbox', { name: '삼성전자 005930 선택', exact: true }).check();
    await page.screenshot({ path: testInfo.outputPath('occurrence-details.png'), fullPage: true });
    if (total === 1) {
      failWrite = true;
      await removeLatest.click();
      await expect(page.getByRole('alert').filter({ hasText: '저장하지 못했습니다' })).toBeVisible();
      await expect(page.getByLabel('삼성전자 발생 2건', { exact: true })).toBeVisible();
      failWrite = false;
    }
    await removeLatest.click();
    await expect(page.getByRole('button', { name: '제외한 발생 건 1', exact: true })).toBeVisible();
    await expect(page.getByLabel('삼성전자 발생 1건', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/screener$/);
    await expect(page.getByRole('searchbox', { name: '결과 내 종목 검색' })).toHaveValue('삼성');
    await expect(page.getByRole('checkbox', { name: '삼성전자 005930 선택', exact: true })).toBeChecked();
    await expect(page.getByRole('button', { name: '삼성전자 2026-09-08 기간내 거래대금 발생 건 제외', exact: true })).toBeVisible();
    await page.reload();
    await page.getByLabel('삼성전자 발생 1건', { exact: true }).click();
    await expect(page.getByRole('button', { name: /삼성전자 2026-09-09 .* 발생 건 제외/ })).toHaveCount(0);
    await page.getByRole('button', { name: '삼성전자 2026-09-08 기간내 거래대금 발생 건 제외', exact: true }).click();
    await expect(page.getByLabel('삼성전자 발생 1건', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '제외한 발생 건 2', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath('excluded-occurrences.png'), fullPage: true });
    await page.getByRole('button', { name: '삼성전자 2026-09-09 복원', exact: true }).click();
    await expect(page.getByRole('button', { name: '삼성전자 2026-09-09 복원', exact: true })).toHaveCount(0);
    await page.getByRole('dialog').getByRole('button', { name: /닫기/ }).click();
    await expect(page.getByLabel('삼성전자 발생 1건', { exact: true })).toBeVisible();
    expect(excluded.map(e => e.date)).toEqual(['2026-09-08']);
    expect(errors).toEqual([]);
  });
}
