import { test, expect } from '@playwright/test';
import type { SavedScreener } from '../../src/api/savedScreeners';
import type { ScanRequest, ScreenerResponse, VolumePeriodParams } from '../../src/api/screener';
import { apiExact } from './helpers/apiRoutes';
import { installLiveMocks } from './helpers/liveMocks';

const old: SavedScreener = { id: 'legacy', name: '기존 거래량', universe: {}, created_at_ms: 1, updated_at_ms: 1,
  conditions: [{ id: 'v', type: 'new_high_vol_today', params: { period: 3 } }] };
const snapshot = 'a'.repeat(64);

test('copy preserves the old save, makes volume basis explicit, and carries chart reference', async ({ page }, info) => {
  await installLiveMocks(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const saves = [structuredClone(old)];
  const original = JSON.stringify(saves[0]);
  const scans: ScanRequest[] = [];
  const archives: ScanRequest[] = [];
  const answer = (request: ScanRequest): ScreenerResponse => ({ status: 'ok', warnings: [], has_more: false,
    calculation: { policy: 'separate_bases_v2', snapshot_id: snapshot, adjusted_as_of: '2026-10-23',
      price_basis: 'vendor_adjusted', event_revision: 'b'.repeat(64), replayable: false },
    bar_coverage: { total: 2, complete: 1, incomplete: [{ code: '000660', condition_id: 'v',
      reason: (request.conditions[0].params as VolumePeriodParams).volume_basis === 'raw'
        ? 'missing_history' : 'share_evidence_unavailable' }] },
    rows: [{ code: '005930', name: '삼성전자', market: 'KOSPI', price: 70000, change_pct: 0,
      trade_value_won: 100000000, occurrences: [{ condition_id: 'v', condition_key: 'v2', date: '2026-10-23',
        volume_evidence: { basis: 'raw', original_volume: '400', compared_volume: '400', maximum: '400',
          window_start: '2026-10-21', window_end: '2026-10-23', unit: 'shares' } }] }] });
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: {
    status: 'ok', calculation_policies: ['legacy_v1', 'separate_bases_v2'] } }));
  await page.route(apiExact('screener/history/jobs/current'), route => route.fulfill({ json: null }));
  await page.route(apiExact('screener/saves'), route => {
    if (route.request().method() === 'POST') {
      const created = { ...route.request().postDataJSON(), id: 'new', created_at_ms: 2, updated_at_ms: 2 } as SavedScreener;
      saves.push(created); return route.fulfill({ status: 201, json: created });
    }
    return route.fulfill({ json: { schema_version: 1, saves } });
  });
  await page.route(apiExact('screener/scan'), route => {
    const request = route.request().postDataJSON() as ScanRequest; scans.push(request);
    return route.fulfill({ json: answer(request) });
  });
  await page.route(apiExact('screener/executions'), route => {
    const request = route.request().postDataJSON() as ScanRequest; archives.push(request);
    const response = answer(request);
    response.calculation = { ...response.calculation!, replayable: true, execution_id: 'c'.repeat(64) };
    return route.fulfill({ status: 201, json: response });
  });
  await page.goto('/screener');
  await expect(page.getByText('기존 계산 기준', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '거래량 기준', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '새 기준으로 복사', exact: true }).click();
  const basis = page.getByRole('combobox', { name: '거래량 기준', exact: true });
  await expect(basis).toHaveValue('share_adjusted');
  await page.getByRole('button', { name: '조회', exact: true }).click();
  await expect(page.getByLabel('계산 기준 안내').getByText('주식 수 변환 이력 미확인: 1종목')).toBeVisible();
  await basis.selectOption('raw');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('조건검색 이름').fill('새 실제 거래량');
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(() => saves.length).toBe(2);
  expect(JSON.stringify(saves[0])).toBe(original);
  expect(saves[1].calculation_policy).toBe('separate_bases_v2');
  expect(saves[1].conditions[0].params).toMatchObject({ volume_basis: 'raw' });
  await page.getByRole('button', { name: '조회', exact: true }).click();
  await expect.poll(() => scans.at(-1)?.calculation_policy).toBe('separate_bases_v2');
  await page.getByRole('button', { name: '이 스냅샷으로 확정 일봉 결과 보존' }).click();
  await expect(page.getByText(/보존된 실행 ID/)).toBeVisible();
  expect(archives[0]).toMatchObject({ basis: 'eod', snapshot_id: snapshot });
  await page.screenshot({ path: info.outputPath('separate-bases-result.png'), fullPage: true });
  await page.getByRole('button', { name: '삼성전자 005930 호가창 열기', exact: true }).click();
  await expect(page).toHaveURL(/screener_snapshot=aaaa/);
  await expect(page.getByText('현재 기준 차트', { exact: true }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('old servers keep the new policy controls disabled', async ({ page }) => {
  await installLiveMocks(page);
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: { status: 'ok' } }));
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [old] } }));
  await page.goto('/screener');
  await expect(page.getByRole('button', { name: '새 조건검색', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '새 기준으로 복사', exact: true })).toHaveCount(0);
});
