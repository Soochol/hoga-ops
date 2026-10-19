import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';
import type { ScanRequest } from '../../src/api/screener';
import type { SavedScreener } from '../../src/api/savedScreeners';

test('expression editing, validation, reorder, persistence and drawer use the same logic', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await installLiveMocks(page);
  let saved: SavedScreener = { id: 'expression', name: '조합식 검색', conditions: [
    { id: 'amount', type: 'trade_value', params: { min_eok: 100 } },
    { id: 'high', type: 'new_high_today', params: { period: 20 } },
    { id: 'volume', type: 'new_high_vol_today', params: { period: 20 } },
  ], universe: {}, created_at_ms: 1, updated_at_ms: 1 };
  const scans: ScanRequest[] = [];
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: { status: 'ok', warnings: [] } }));
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { schema_version: 1, saves: [saved] } }));
  await page.route(apiExact('screener/saves/expression'), route => {
    saved = { ...saved, ...route.request().postDataJSON(), updated_at_ms: saved.updated_at_ms + 1 };
    return route.fulfill({ json: saved });
  });
  await page.route(apiExact('screener/scan'), route => {
    scans.push(route.request().postDataJSON());
    return route.fulfill({ json: { status: 'ok', warnings: [], rows: [], has_more: false } });
  });
  await page.goto('/screener');
  const builder = page.getByTestId('screener-builder-pane');
  const formula = builder.getByRole('textbox', { name: '조건 조합식' });
  const run = page.getByRole('button', { name: '조회', exact: true });
  const save = builder.getByRole('button', { name: '저장', exact: true });
  await expect(formula).toHaveValue('A AND B AND C');
  await formula.fill('A AND (B OR C)');
  await formula.press('End');
  await page.getByRole('button', { name: '조회', exact: true }).click();
  await expect.poll(() => scans.at(-1)?.expression).toBe('A AND (B OR C)');
  await formula.fill('A AND (B OR');
  await expect(formula).toHaveAttribute('aria-invalid', 'true');
  await expect(run).toBeDisabled();
  await expect(save).toBeDisabled();
  await expect(builder.getByRole('alert')).toBeVisible();
  await formula.fill('A OR Z');
  await expect(builder.getByRole('alert')).toContainText('Z에 해당하는 조건이 없습니다');
  await formula.fill('A AND (B OR C)');
  await expect(run).toBeEnabled();

  // The badge inserts into the selected text, preserving keyboard focus and the surrounding expression.
  await formula.focus();
  await formula.press('ControlOrMeta+A');
  await builder.getByRole('group', { name: '거래대금 조건', exact: true })
    .getByRole('button', { name: 'A 거래대금 조합식에 입력', exact: true }).click();
  await expect(formula).toHaveValue('A');
  await expect(formula).toBeFocused();
  await expect(builder.getByText('검색에 사용하지 않는 조건: B, C')).toBeVisible();
  await formula.fill('A AND (B OR C)');

  // Moving the volume condition to the top must keep the same leaf IDs in the expression.
  for (const label of ['거래대금', '신고가', '신고거래량']) {
    await builder.getByRole('button', { name: `${label} 접기`, exact: true }).click();
  }
  const volume = builder.getByRole('group', { name: '신고거래량 조건', exact: true });
  const amount = builder.getByRole('group', { name: '거래대금 조건', exact: true });
  await volume.getByRole('button', { name: '조건 순서 변경' }).dragTo(amount.getByRole('button', { name: '조건 순서 변경' }));
  await expect(formula).toHaveValue('(B AND (C OR A))');
  await save.click();
  await expect.poll(() => saved.expression).toBe('(B AND (C OR A))');
  expect(saved.conditions.map(c => c.id)).toEqual(['volume', 'amount', 'high']);
  await expect(builder.getByText('수정됨', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(formula).toHaveValue('(B AND (C OR A))');
  await run.click();
  await expect.poll(() => scans.at(-1)?.expression).toBe(saved.expression);
  for (const [theme, size] of [['trading-desk', 16], ['ledger-studio', 20]] as const) {
    await page.evaluate(({ theme, size }) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.fontSize = `${size}px`;
    }, { theme, size });
    const overflow = await formula.evaluate(element => {
      const panel = element.closest('[data-testid="screener-builder-pane"]')!;
      return element.getBoundingClientRect().right > panel.getBoundingClientRect().right;
    });
    expect(overflow).toBe(false);
    await builder.screenshot({ path: testInfo.outputPath(`expression-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = '16px'; });
  await page.getByRole('button', { name: '스크리너 패널 토글' }).click();
  const drawer = page.getByTestId('screener-panel');
  const beforeDrawer = scans.length;
  await drawer.getByTestId('screener-monitor-toggle').click();
  await expect.poll(() => scans.length).toBeGreaterThan(beforeDrawer);
  await expect.poll(() => scans.at(-1)?.expression).toBe(saved.expression);
  expect(scans.at(-1)?.conditions.map(c => c.id)).toEqual(saved.conditions.map(c => c.id));
  expect(errors).toEqual([]);
});
