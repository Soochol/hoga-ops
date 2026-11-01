import { conditionDialog, openConditionSettings, closeConditionSettings } from './helpers/screenerEditor';
import { test, expect } from '@playwright/test';
import type { ConditionLeaf, ScanRequest } from '../../src/api/screener';
import { apiExact } from './helpers/apiRoutes';
import { installLiveMocks } from './helpers/liveMocks';

const conditions: ConditionLeaf[] = [
  { id: 'price', type: 'price_range', params: { min: 1000, max: 50000 } },
  { id: 'amount', type: 'trade_value', params: { min_eok: 1000, timeframe: 'W' } },
  { id: 'period-amount', type: 'trade_value_period', params: { min_eok: 500, lookback: 60 } },
  { id: 'high', type: 'new_high_today', params: { period: 200 } },
  { id: 'period-high', type: 'new_high', params: { lookback: 20, period: 500, timeframe: 'M' } },
  { id: 'volume', type: 'new_high_vol_today', params: { period: 60 } },
  { id: 'period-volume', type: 'new_high_vol', params: { lookback: 60, period: 250 } },
  { id: 'near', type: 'high_off_peak', params: { period: 250, pct: 30, side: 'within' } },
  { id: 'ask', type: 'ask_depth_new_high', params: { lookback: 20, threshold_pct: 100 } },
  { id: 'bid', type: 'bid_depth_new_high', params: { lookback: 20, threshold_pct: 120 } },
  { id: 'period-ask', type: 'ask_depth_new_high_period', params: { lookback: 5, period: 20, threshold_pct: 100 } },
  { id: 'period-bid', type: 'bid_depth_new_high_period', params: { lookback: 3, period: 15, threshold_pct: 150 } },
  { id: 'time-ask', type: 'ask_depth_renewal', params: { start_hhmm: 1200, threshold_pct: 101 } },
  { id: 'time-bid', type: 'bid_depth_renewal', params: { start_hhmm: 1330, threshold_pct: 120 } },
  { id: 'ma', type: 'ma', params: { source: 'low', period: 20, relation: 'below', timeframe: '5m' } },
  { id: 'bb-today', type: 'bollinger_breakout_today', params: { source: 'high', band_source: 'close', band: 'upper', period: 20, multiplier: 2 } },
  { id: 'bb-period', type: 'bollinger_breakout', params: { source: 'low', band_source: 'close', band: 'lower', period: 20, multiplier: 2, lookback: 5 } },
  { id: 'rate', type: 'change_pct', params: { op: 'between', lo: -5, hi: 150, change_reference: 'bar_open' } },
  { id: 'bb-position', type: 'bollinger_position_today', params: { source: 'high', band_source: 'close', band: 'upper', period: 20, multiplier: 2 } },
  { id: 'bb-period-position', type: 'bollinger_position', params: { source: 'low', band_source: 'close', band: 'lower', period: 20, multiplier: 2, lookback: 5 } },
];
const labels = ['현재가 범위', '거래대금', '기간내 거래대금', '신고가', '기간내 신고가', '신고거래량', '기간내 신고거래량',
  '신고가 대비 고가', '매도 총잔량 peak', '매수 총잔량 peak', '기간내 매도 총잔량 peak', '기간내 매수 총잔량 peak',
  '매도 총잔량 기준시각 돌파', '매수 총잔량 기준시각 돌파', '이동평균', '볼린저밴드 돌파', '기간내 볼린저밴드 돌파', '등락률', '볼린저밴드 위·아래', '기간내 볼린저밴드 위·아래'];

test('all condition editors fit the modal; search, focus, drag, save and reload work', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await installLiveMocks(page);
  let saved = { id: 'all-conditions', name: '조건 UI 검증', universe: {}, conditions, created_at_ms: 1, updated_at_ms: 1 };
  const scans: ScanRequest[] = [];
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: { status: 'ok' } }));
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [saved] } }));
  await page.route(apiExact('screener/saves/all-conditions'), route => {
    saved = { ...saved, ...route.request().postDataJSON(), updated_at_ms: 2 }; return route.fulfill({ json: saved });
  });
  await page.route(apiExact('screener/scan'), route => {
    scans.push(route.request().postDataJSON()); return route.fulfill({ json: { status: 'ok', warnings: [], rows: [] } });
  });
  await page.goto('/screener');
  const builder = page.getByTestId('screener-builder-pane');
  await expect(builder.getByRole('textbox', { name: '신고 기준 기간(봉)' })).toHaveCount(0);
  const card = await openConditionSettings(page, '신고가');
  const period = card.getByLabel('신고 기준 기간(봉)');
  await period.click(); await expect(period).toBeFocused();
  await expect(period).toHaveCSS('outline-style', 'none'); await expect(period.locator('..')).toHaveCSS('outline-style', 'solid');
  await period.press('Tab'); await expect(period).not.toBeFocused(); await page.keyboard.press('Shift+Tab'); await expect(period).toBeFocused();
  await closeConditionSettings(page);
  await page.getByRole('button', { name: '조회', exact: true }).click();
  await expect.poll(() => scans.at(-1)?.conditions).toEqual(conditions);
  const amount = await openConditionSettings(page, '거래대금');
  await amount.getByLabel('최소 거래대금(억)').fill('500');
  await closeConditionSettings(page);
  const handles = builder.getByRole('button', { name: '조건 순서 변경' });
  await handles.nth(1).dragTo(handles.nth(0));
  await expect(builder.getByRole('button', { name: 'A 거래대금 설정', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '저장', exact: true }).click();
  const expected = [{ ...conditions[1], params: { ...conditions[1].params, min_eok: 500 } }, conditions[0], ...conditions.slice(2)];
  await expect.poll(() => saved.conditions).toEqual(expected);
  await page.reload(); await openConditionSettings(page, '거래대금');
  await expect(amount.getByLabel('최소 거래대금(억)')).toHaveValue('500');
  for (const [theme, size, width] of [['trading-desk', 16, 1280], ['ledger-studio', 20, 768]] as const) {
    await page.evaluate(({ theme, size }) => { document.documentElement.dataset.theme = theme; document.documentElement.style.fontSize = `${size}px`; }, { theme, size });
    await page.setViewportSize({ width, height: 1000 });
    for (const label of labels) {
      const group = await openConditionSettings(page, label);
      const overflow = await group.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return [...element.querySelectorAll<HTMLElement>('input, select, button, .condition-unit')]
          .filter(node => node.getClientRects().length)
          .some(node => { const box = node.getBoundingClientRect(); return box.left < bounds.left - 1 || box.right > bounds.right + 1; });
      });
      expect(overflow, `${label} at ${size}px`).toBe(false);
    }
    for (const [name, modeLabel, prefix] of [['기간내 거래대금', '거래대금 검색 기간', '거래대금'], ['기간내 신고거래량', '거래량 검색 기간', '거래량']]) {
      const group = await openConditionSettings(page, name);
      await group.getByRole('combobox', { name: modeLabel, exact: true }).selectOption('date_range');
      await expect(group.getByLabel(`${prefix} 발생 시작일`)).toBeVisible();
      const datesFit = await group.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return [...element.querySelectorAll<HTMLInputElement>('input[type="date"]')].every(input => {
          const box = input.getBoundingClientRect(); return box.width > 0 && box.left >= bounds.left && box.right <= bounds.right;
        });
      });
      expect(datesFit).toBe(true);
    }
    await conditionDialog(page).screenshot({ path: testInfo.outputPath(`condition-settings-${theme}.png`) });
  }
  await closeConditionSettings(page);
  const trigger = builder.getByRole('button', { name: '조건 추가', exact: true });
  await trigger.click();
  const dialog = conditionDialog(page), search = dialog.getByRole('textbox', { name: '조건 검색' });
  await expect(search).toBeFocused(); await search.fill('기간내 등락률'); await search.press('ArrowDown');
  await expect(dialog.getByRole('button', { name: '기간내 등락률 선택', exact: true })).toBeFocused();
  await page.keyboard.press('Enter'); await expect(dialog.getByRole('heading', { name: '기간내 등락률' })).toBeVisible();
  await search.press('Escape'); await expect(search).toHaveValue(''); await expect(dialog).toBeVisible();
  await search.press('Escape'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  expect(saved.conditions).toEqual(expected); expect(errors).toEqual([]);
});

test('numeric drafts allow backspace and decimals while invalid fields block scan and save', async ({ page }) => {
  await installLiveMocks(page);
  const selected = conditions.filter(c => ['price', 'ma', 'bb-today', 'rate'].includes(c.id));
  const saved = { id: 'numeric', name: '숫자 입력 검증', universe: {}, conditions: selected, created_at_ms: 1, updated_at_ms: 1 };
  const scans: ScanRequest[] = [];
  const writes: { conditions: ConditionLeaf[] }[] = [];
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: { status: 'ok', warnings: [] } }));
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [saved] } }));
  await page.route(apiExact('screener/saves/numeric'), route => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({ json: { ...saved, ...writes.at(-1) } });
  });
  await page.route(apiExact('screener/scan'), route => {
    scans.push(route.request().postDataJSON());
    return route.fulfill({ json: { status: 'ok', warnings: [], rows: [], has_more: false } });
  });
  await page.goto('/screener');
  const scan = page.getByRole('button', { name: '조회', exact: true });
  const save = page.getByRole('button', { name: '저장', exact: true });
  await openConditionSettings(page, '이동평균');
  const period = page.getByLabel('이동평균 기간(봉)');
  await expect(period).toHaveValue('20');
  await period.click();
  await period.press('End');
  await period.press('Backspace');
  await expect(period).toHaveValue('2');
  await period.press('Backspace');
  await expect(period).toHaveValue('');
  await expect(page.getByText('값을 입력하세요.', { exact: true })).toHaveCount(0);
  await closeConditionSettings(page);
  await expect(scan).toBeDisabled();
  await expect(save).toBeDisabled();
  await openConditionSettings(page, '이동평균');
  await expect(period).toHaveValue('');
  await expect(page.getByRole('button', { name: '다른 이름으로 저장' })).toBeDisabled();
  await expect(page.getByText('값을 입력하세요.', { exact: true })).toBeVisible();
  await period.click();
  await period.press('Tab');
  await expect(period).toHaveAccessibleDescription('값을 입력하세요.');
  await period.fill('1001');
  await period.press('Enter');
  await expect(period).toHaveValue('1001');
  await expect(period).toHaveAccessibleDescription('1000 이하로 입력하세요.');
  await expect(scan).toBeDisabled();
  expect(scans).toHaveLength(0);
  expect(writes).toHaveLength(0);
  await period.fill('60');
  await expect(scan).toBeEnabled();

  await closeConditionSettings(page);
  await expect(scan).toBeEnabled();
  await openConditionSettings(page, '볼린저밴드 돌파');
  const multiplier = page.getByLabel('표준편차 배수');
  await multiplier.fill('');
  await multiplier.pressSequentially('2.');
  await expect(multiplier).toHaveValue('2.');
  await multiplier.pressSequentially('5');
  await expect(multiplier).toHaveValue('2.5');
  await openConditionSettings(page, '등락률');
  const rate = page.getByLabel('등락률 하한(%)');
  await rate.fill('');
  await rate.pressSequentially('-');
  await expect(rate).toHaveValue('-');
  await expect(scan).toBeDisabled();
  await rate.pressSequentially('0.5');
  await expect(rate).toHaveValue('-0.5');
  await rate.press('Tab');
  await openConditionSettings(page, '현재가 범위');
  await page.getByLabel('최저가(원)').fill('');
  await page.getByLabel('최고가(원)').fill('');
  await page.getByLabel('최고가(원)').press('Tab');
  await expect(page.getByText('최저가 또는 최고가를 입력하세요.')).toBeVisible();
  await expect(scan).toBeDisabled();
  await expect(save).toBeDisabled();
  await page.getByLabel('최고가(원)').fill('50000');
  await expect(scan).toBeEnabled();
  await expect(save).toBeEnabled();
  await closeConditionSettings(page);
  await scan.click();
  await expect.poll(() => scans.length).toBe(1);
  const expected = selected.map(c => c.type === 'ma' ? { ...c, params: { ...c.params, period: 60 } }
    : c.type === 'bollinger_breakout_today' ? { ...c, params: { ...c.params, multiplier: 2.5 } }
      : c.type === 'change_pct' ? { ...c, params: { ...c.params, lo: -0.5 } }
        : { ...c, params: { max: 50000 } });
  expect(scans[0].conditions).toEqual(expected);
  await save.click();
  await expect.poll(() => writes.at(-1)?.conditions).toEqual(expected);
});
