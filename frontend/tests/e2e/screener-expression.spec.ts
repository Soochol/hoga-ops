import { test, expect, type Locator } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';
import { addCondition, conditionDialog, openConditionSettings, closeConditionSettings } from './helpers/screenerEditor';
import type { ScanRequest } from '../../src/api/screener';
import type { SavedScreener } from '../../src/api/savedScreeners';

async function textPoint(input: Locator, offset: number) {
  return input.evaluate((element: HTMLTextAreaElement, offset) => {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    const context = document.createElement('canvas').getContext('2d')!;
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return { x: rect.left + element.clientLeft + parseFloat(style.paddingLeft)
      + context.measureText(element.value.slice(0, offset)).width + context.measureText(element.value[offset]).width / 2,
      y: rect.top + element.clientTop + parseFloat(style.paddingTop) + parseFloat(style.lineHeight) / 2 };
  }, offset);
}
const conditions: SavedScreener['conditions'] = [
  { id: 'amount', type: 'trade_value', params: { min_eok: 100 } },
  { id: 'high', type: 'new_high_today', params: { period: 20 } },
  { id: 'volume', type: 'new_high_vol_today', params: { period: 20 } },
];

test('manual brackets, selected-token replacement, double click and undo work in the mine tab', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  const saved: SavedScreener = { id: 'manual', name: '직접 조합', conditions, expression: 'A AND B OR C', universe: {}, created_at_ms: 1, updated_at_ms: 1 };
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: { status: 'ok' } }));
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [saved] } }));
  await page.goto('/screener');
  await openConditionSettings(page, '거래대금');
  const dialog = conditionDialog(page), input = dialog.getByRole('textbox', { name: '조건 조합식' });
  await expect(dialog.getByRole('button', { name: '() 묶기', exact: true })).toHaveCount(0);
  await input.click(); await input.press('Home');
  await dialog.getByRole('button', { name: '( 조합식에 입력', exact: true }).click();
  await expect(input).toHaveValue('( A AND B OR C');
  await expect(dialog.getByRole('alert')).toContainText('닫는 괄호');
  await input.press('End');
  await dialog.getByRole('button', { name: ') 조합식에 입력', exact: true }).click();
  await expect(input).toHaveValue('( A AND B OR C )');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await input.press('ControlOrMeta+z'); await expect(input).toHaveValue('( A AND B OR C');
  await input.press('ControlOrMeta+Shift+z'); await expect(input).toHaveValue('( A AND B OR C )');

  await input.fill('A AND B OR C');
  const operator = await textPoint(input, 3);
  await page.mouse.dblclick(operator.x, operator.y);
  await expect(input).toHaveValue('A OR B OR C');
  await input.press('ControlOrMeta+z'); await expect(input).toHaveValue('A AND B OR C');
  await input.press('Home'); await input.press('ArrowRight'); await input.press('ArrowRight');
  for (let i = 0; i < 3; i++) await input.press('Shift+ArrowRight');
  await dialog.getByRole('button', { name: 'OR 조합식에 입력', exact: true }).click();
  await expect(input).toHaveValue('A OR B OR C');
  await input.press('ControlOrMeta+z'); await expect(input).toHaveValue('A AND B OR C');
  await dialog.getByRole('button', { name: '모두 OR', exact: true }).click();
  await dialog.getByRole('button', { name: '모두 OR', exact: true }).press('ControlOrMeta+z');
  await expect(input).toHaveValue('A AND B OR C');
  for (const [theme, size] of [['trading-desk', 16], ['ledger-studio', 20]] as const) {
    await page.evaluate(({ theme, size }) => { document.documentElement.dataset.theme = theme; document.documentElement.style.fontSize = `${size}px`; }, { theme, size });
    await input.fill('A AND ((B OR C))');
    await dialog.screenshot({ path: testInfo.outputPath(`manual-expression-${theme}.png`) });
  }
});

test('syntax errors block save and scan, while authored text survives parameter edits, reorder and reload', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  let saved: SavedScreener = { id: 'expression', name: '조합식 검색', conditions, universe: {}, created_at_ms: 1, updated_at_ms: 1 };
  const scans: ScanRequest[] = [];
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: { status: 'ok' } }));
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [saved] } }));
  await page.route(apiExact('screener/saves/expression'), route => {
    saved = { ...saved, ...route.request().postDataJSON(), updated_at_ms: 2 }; return route.fulfill({ json: saved });
  });
  await page.route(apiExact('screener/scan'), route => {
    scans.push(route.request().postDataJSON()); return route.fulfill({ json: { status: 'ok', rows: [], warnings: [] } });
  });
  await page.goto('/screener');
  const builder = page.getByTestId('screener-builder-pane'), dialog = conditionDialog(page);
  const input = dialog.getByRole('textbox', { name: '조건 조합식' });
  const run = page.getByRole('button', { name: '조회', exact: true }), save = builder.getByRole('button', { name: '저장', exact: true });
  await builder.getByRole('button', { name: '조건 조합 편집' }).click();
  await input.fill('A AND (B OR');
  await expect(input).toHaveAttribute('aria-invalid', 'true'); await expect(run).toBeDisabled(); await expect(save).toBeDisabled();
  await closeConditionSettings(page);
  await expect(builder.getByRole('alert')).toBeVisible(); await expect(run).toBeDisabled();
  await builder.getByRole('button', { name: '조건 조합 편집' }).click();
  await expect(input).toHaveValue('A AND (B OR');
  await input.fill('A OR Z'); await expect(dialog.getByRole('alert')).toContainText('Z에 해당하는 조건이 없습니다');
  await input.fill('A'); await expect(dialog.getByText('검색에 사용하지 않는 조건: B, C')).toBeVisible();
  const original = '  a  AND ((b OR c))  ';
  await input.fill(original);
  await dialog.getByLabel('최소 거래대금(억)').fill('300');
  await expect(input).toHaveValue(original);
  await closeConditionSettings(page);
  const handles = builder.getByRole('button', { name: '조건 순서 변경' });
  await handles.nth(2).dragTo(handles.nth(0));
  await builder.getByRole('button', { name: '조건 조합 편집' }).click();
  const reordered = '  b  AND ((c OR a))  ';
  await expect(input).toHaveValue(reordered);
  await input.press('ControlOrMeta+z'); await expect(input).toHaveValue(reordered);
  await closeConditionSettings(page);
  await addCondition(page, '현재가 범위');
  await builder.getByRole('button', { name: '조건 조합 편집' }).click();
  await expect(input).toHaveValue(`${reordered} AND D`);
  await closeConditionSettings(page);
  await save.click(); await expect.poll(() => saved.expression).toBe(`${reordered} AND D`);
  await page.reload();
  await builder.getByRole('button', { name: '조건 조합 편집' }).click();
  await expect(input).toHaveValue(saved.expression!);
  await dialog.screenshot({ path: testInfo.outputPath('expression-persisted.png') });
  await closeConditionSettings(page); await run.click();
  await expect.poll(() => scans.at(-1)?.expression).toBe(saved.expression);
  expect(scans.at(-1)?.conditions).toEqual(saved.conditions);
  await page.getByRole('button', { name: '스크리너 패널 토글' }).click();
  const before = scans.length;
  await page.getByTestId('screener-panel').getByTestId('screener-monitor-toggle').click();
  await expect.poll(() => scans.length).toBeGreaterThan(before);
  await expect.poll(() => scans.at(-1)?.expression).toBe(saved.expression);
  expect(errors).toEqual([]);
});
