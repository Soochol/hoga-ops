import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { apiExact, apiPrefix } from './helpers/apiRoutes';
import type { ConditionLeaf, ScreenerExclusion, ScanRequest } from '../../src/api/screener';

// #1859 removed the per-stock occurrence expander. Existing exclusions still
// have a supported restore UI; verify its rescan, persistence and CSV evidence.
for (const [total, andCase] of [[1, false], [300, false], [300, true]] as const) {
  test(`${total}종목 결과에서 제외 기록 복원·재조회·CSV${andCase ? ' · AND 종목 복귀' : ''}`, async ({ page }, testInfo) => {
    const condition: ConditionLeaf = { id: 'v', type: 'trade_value_period', params: { lookback: 3, min_eok: 1 } };
    let excluded: ScreenerExclusion[] = [{ id: 'excluded-v', condition, code: '005930', stock_name: '삼성전자',
      date: '2026-09-09', condition_key: 'trade-key', created_at_ms: 1 }];
    let failRestore = false;
    let scans = 0;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(apiExact('screener/status'), r => r.fulfill({ json: { status: 'ready', days_behind: 0 } }));
    await page.route(apiExact('screener/saves'), r => r.fulfill({ json: { schema_version: 1, saves: [] } }));
    await page.route(apiPrefix('screener/exclusions'), async r => {
      if (r.request().method() === 'DELETE') {
        if (failRestore) return r.fulfill({ status: 500, json: { detail: 'disk full' } });
        const id = decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop()!);
        excluded = excluded.filter(e => e.id !== id);
        return r.fulfill({ status: 204 });
      }
      return r.fulfill({ json: { schema_version: 1, exclusions: excluded } });
    });
    await page.route(apiExact('screener/scan'), r => {
      scans++;
      const request: ScanRequest = r.request().postDataJSON();
      return r.fulfill({ json: { status: 'ok', warnings: [], has_more: false, scanned_at_ms: Date.now(),
        rows: Array.from({ length: total }, (_, index) => {
          const code = index === 0 ? '005930' : String(100000 + index);
          const occurrences = (andCase ? ['2026-09-09'] : ['2026-09-09', '2026-09-08'])
            .filter(date => !excluded.some(e => e.code === code && e.date === date))
            .map(date => ({ condition_id: request.conditions[0].id, condition_key: 'trade-key', date }));
          if (!occurrences.length) return null; // AND requires a remaining match for every condition
          if (andCase) occurrences.push({ condition_id: 'h', condition_key: 'high-key', date: '2026-09-09' });
          return { code, name: index === 0 ? '삼성전자' : `테스트${index}`, market: 'KOSPI',
            price: 70000, change_pct: 1, trade_value_won: 1e10, occurrences, price_date: '2026-09-09' };
        }).filter(Boolean),
      } });
    });
    await page.addInitScript(({ condition, andCase }) => localStorage.setItem('screenerDraft.v1', JSON.stringify({
      conditions: [condition, ...(andCase ? [{ id: 'h', type: 'new_high', params: { lookback: 3, period: 2 } }] : [])],
      universe: {}, anchorId: null, anchorName: null, dirty: true,
    })), { condition, andCase });
    await page.goto('/screener');
    await page.getByRole('button', { name: '조회', exact: true }).click();
    const samsung = page.getByRole('button', { name: '삼성전자 005930 호가창 열기', exact: true });
    await expect(samsung).toHaveCount(andCase ? 0 : 1);
    if (total === 300) await expect(page.getByTestId('screener-result-rows')).toHaveAttribute('data-virtualized', 'true');
    await page.getByRole('searchbox', { name: '결과 내 종목 검색' }).fill('삼성');
    if (!andCase) await page.getByRole('checkbox', { name: '삼성전자 005930 선택', exact: true }).check();
    await page.getByRole('button', { name: '제외한 발생 건 1', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '제외한 발생 건', exact: true });
    const restore = dialog.getByRole('button', { name: '삼성전자 2026-09-09 복원', exact: true });
    await expect(restore).toBeInViewport();
    if (total === 1) {
      failRestore = true;
      await restore.click();
      await expect(page.getByRole('alert').filter({ hasText: '저장하지 못했습니다' })).toBeVisible();
      await expect(restore).toBeVisible();
      expect(excluded).toHaveLength(1);
      failRestore = false;
    }
    const before = scans;
    await restore.click();
    await expect(restore).toHaveCount(0);
    await expect.poll(() => scans).toBeGreaterThan(before);
    expect(excluded).toEqual([]);
    await dialog.getByRole('button', { name: '닫기', exact: true }).click();
    await expect(samsung).toBeVisible();
    await expect(page.getByRole('searchbox', { name: '결과 내 종목 검색' })).toHaveValue('삼성');
    if (!andCase) await expect(page.getByRole('checkbox', { name: '삼성전자 005930 선택', exact: true })).toBeChecked();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '검색 결과 CSV', exact: true }).click();
    const csv = await readFile((await (await download).path())!, 'utf8');
    expect(csv).toContain('2026-09-09');
    expect(csv).toContain(andCase ? '""condition_key"":""high-key""' : '2026-09-08');
    await page.screenshot({ path: testInfo.outputPath('restored-occurrences.png'), fullPage: true });
    await page.reload();
    await expect(samsung).toBeVisible();
    await expect(page.getByRole('button', { name: /제외한 발생 건/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /삼성전자 발생/ })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
