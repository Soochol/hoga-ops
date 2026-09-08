import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact, apiPrefix } from './helpers/apiRoutes';

const saves = [
  { id: 'first', name: '신고가, 거래대금', conditions: [{ id: 'a', type: 'trade_value', params: { min_eok: 100 } }], universe: {}, created_at_ms: 1, updated_at_ms: 1 },
  { id: 'second', name: '4일 신고가', conditions: [{ id: 'b', type: 'trade_value', params: { min_eok: 500 } }], universe: {}, created_at_ms: 1, updated_at_ms: 1 },
  ...Array.from({ length: 25 }, (_, i) => ({ id: `long-${i}`, name: `장기 조건 ${i} · 신고가, 거래대금, 이동평균과 당일 매도 총잔량을 모두 확인하는 조건`, conditions: [], universe: {}, created_at_ms: 1, updated_at_ms: 1 })),
];

test('saved-condition popup stays open and protects edits in page and rail workflows', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await installLiveMocks(page);
  await page.route(apiExact('screener/saves'), (r) => r.fulfill({ json: { schema_version: 1, saves } }));
  await page.route(apiPrefix('screener/status'), (r) => r.fulfill({ json: { status: 'ok', warnings: [], days_behind: 0 } }));
  await page.route(apiPrefix('live/quotes'), (r) => r.fulfill({ json: { phase: 'open', quotes: [] } }));
  let scans = 0;
  await page.route(apiExact('screener/scan'), (r) => { scans++; return r.fulfill({ json: { status: 'ok', warnings: [], rows: [] } }); });
  await page.goto('/screener');
  const builder = page.getByTestId('screener-builder-pane');
  const trigger = builder.getByRole('button', { name: '저장한 조건검색 선택' });
  const input = builder.getByRole('spinbutton', { name: '최소 거래대금(억)' });
  await expect(trigger).toHaveText('신고가, 거래대금⌄');
  await trigger.click();
  const search = page.getByRole('combobox', { name: '조건검색 이름 검색' });
  await expect(search).toBeFocused();
  await search.click();
  // 실제 타이머의 갱신 주기를 지나도 검색창·목록이 유지된다.
  await page.clock.install();
  await page.clock.fastForward(31_000);
  await expect(page.getByRole('listbox')).toBeVisible();
  await expect(search).toBeFocused();
  await search.fill('4일');
  await expect(page.getByRole('option')).toHaveCount(1);
  await search.press('Enter');
  await expect(trigger).toContainText('4일 신고가');
  await expect(trigger).toBeFocused();
  await expect(input).toHaveValue('500');

  await input.fill('600');
  await input.press('Tab');
  await trigger.click();
  await page.getByRole('option', { name: '신고가, 거래대금', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '미저장 변경 확인' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: '계속 편집' }).click();
  await expect(input).toHaveValue('600');
  await builder.getByRole('button', { name: '저장본으로 되돌리기' }).click();
  await confirmation.getByRole('button', { name: '변경 버리고 복원' }).click();
  await expect(input).toHaveValue('500');

  await input.fill('700');
  await input.press('Tab');
  await trigger.click();
  await page.getByRole('option', { name: '신고가, 거래대금', exact: true }).click();
  await confirmation.getByRole('button', { name: '변경 버리고 이동' }).click();
  await expect(input).toHaveValue('100');
  await builder.getByRole('button', { name: '새 조건검색' }).click();
  await expect(trigger).toContainText('새 조건 · 미저장');
  await page.reload();
  await expect(trigger).toContainText('새 조건 · 미저장');
  await expect(page.getByRole('button', { name: '조회', exact: true })).toBeDisabled();

  await trigger.click();
  await search.fill('장기 조건 24');
  const longOption = page.getByRole('option');
  await expect(longOption).toHaveCount(1);
  await expect(longOption).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('condition-search-wide.png') });
  await longOption.click();
  await expect(trigger).toHaveAttribute('title', saves.at(-1)!.name);
  await trigger.click();
  await search.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('listbox')).toHaveCount(0);

  await page.setViewportSize({ width: 944, height: 624 });
  await page.getByRole('button', { name: '스크리너 패널 토글' }).click();
  const panelTrigger = page.getByTestId('screener-panel').getByRole('button', { name: '저장한 조건검색 선택' });
  await panelTrigger.click();
  await expect(search).toBeFocused();
  await search.fill('장기 조건 24');
  await expect(page.getByRole('option')).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('condition-search-compact.png') });
  await search.press('Enter');
  await expect(panelTrigger).toHaveAttribute('title', saves.at(-1)!.name);
  await panelTrigger.click();
  await builder.getByText('조건검색', { exact: true }).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
  expect(scans).toBe(0);
  expect(errors).toEqual([]);
});
