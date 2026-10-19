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
  { id: 'rate', type: 'change_pct', params: { op: 'between', lo: -5, hi: 150, change_reference: 'bar_open' } },
];
const labels = ['현재가 범위', '거래대금', '기간내 거래대금', '신고가', '기간내 신고가', '신고거래량', '기간내 신고거래량',
  '신고가 대비 고가', '매도 총잔량 peak', '매수 총잔량 peak', '기간내 매도 총잔량 peak', '기간내 매수 총잔량 peak',
  '매도 총잔량 기준시각 돌파', '매수 총잔량 기준시각 돌파', '이동평균', '등락률'];

test('all 16 editors keep predicates through collapse, keyboard editing, reorder and scan', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await installLiveMocks(page);
  let saved = { id: 'all-conditions', name: '조건 UI 검증', universe: {}, conditions,
    created_at_ms: 1, updated_at_ms: 1 };
  const scans: ScanRequest[] = [];
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: { status: 'ok', warnings: [] } }));
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [saved] } }));
  await page.route(apiExact('screener/saves/all-conditions'), route => {
    saved = { ...saved, ...route.request().postDataJSON(), updated_at_ms: saved.updated_at_ms + 1 };
    return route.fulfill({ json: saved });
  });
  await page.route(apiExact('screener/scan'), route => {
    scans.push(route.request().postDataJSON());
    return route.fulfill({ json: { status: 'ok', warnings: [], rows: [], has_more: false } });
  });
  await page.goto('/screener');
  const builder = page.getByTestId('screener-builder-pane');
  const period = builder.getByRole('group', { name: '신고가 조건', exact: true }).getByLabel('신고 기준 기간(봉)');
  const time = builder.getByRole('group', { name: '매도 총잔량 기준시각 돌파 조건', exact: true }).getByLabel('기준 시각', { exact: true });
  for (const input of [period, time]) {
    await input.click();
    await expect(input).toBeFocused();
    await expect(input).toHaveCSS('outline-style', 'none');
    await expect(input.locator('..')).toHaveCSS('outline-style', 'solid');
    await expect(input.locator('..')).toHaveCSS('outline-width', '1px');
  }
  await period.click();
  await period.press('Tab');
  await expect(period).not.toBeFocused();
  await expect(period.locator('..')).toHaveCSS('outline-style', 'none');
  await page.keyboard.press('Shift+Tab');
  await expect(period).toBeFocused();
  await expect(period).toHaveCSS('outline-style', 'none');
  await expect(period.locator('..')).toHaveCSS('outline-style', 'solid');
  await builder.getByRole('group', { name: '신고가 조건', exact: true }).screenshot({ path: testInfo.outputPath('condition-single-focus.png') });
  for (const label of labels) {
    const card = builder.getByRole('group', { name: `${label} 조건`, exact: true });
    const toggle = card.getByRole('button', { name: `${label} 접기`, exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect(card.getByRole('spinbutton')).toHaveCount(0);
    await expect(card.getByRole('button', { name: `${label} 펼치기`, exact: true })).toHaveAttribute('aria-expanded', 'false');
  }
  await page.getByRole('button', { name: '조회', exact: true }).click();
  await expect.poll(() => scans.length).toBe(1);
  expect(scans[0].conditions).toEqual(conditions);

  const amount = builder.getByRole('group', { name: '거래대금 조건', exact: true });
  const toggle = amount.getByRole('button', { name: '거래대금 펼치기' });
  await toggle.focus();
  await page.keyboard.press('Enter');
  await amount.getByRole('button', { name: '500억', exact: true }).click();
  await expect(amount.getByLabel('최소 거래대금(억)')).toHaveValue('500');
  await amount.getByRole('button', { name: '거래대금 접기' }).click();

  // Native drag-and-drop must work with the compact rows as well as open forms.
  await amount.getByRole('button', { name: '조건 순서 변경' }).dragTo(
    builder.getByRole('group', { name: '현재가 범위 조건', exact: true }).getByRole('button', { name: '조건 순서 변경' }));
  await page.getByRole('button', { name: '저장', exact: true }).click();
  const expected = [
    { ...conditions[1], params: { ...conditions[1].params, min_eok: 500 } },
    conditions[0], ...conditions.slice(2),
  ];
  await expect.poll(() => saved.conditions).toEqual(expected);
  await page.reload();
  await expect(amount.getByLabel('최소 거래대금(억)')).toHaveValue('500');
  await page.getByRole('button', { name: '조회', exact: true }).click();
  // Hydration may replay the previous scan before the explicit, edited request.
  await expect.poll(() => scans.at(-1)?.conditions).toEqual(expected);

  // Each editor's controls must fit its actual 23rem builder at both density scales.
  for (const [theme, size] of [['trading-desk', 16], ['ledger-studio', 20]] as const) {
    await page.evaluate(([theme, size]) => {
      document.documentElement.dataset.theme = String(theme);
      document.documentElement.style.fontSize = `${size}px`;
    }, [theme, size] as const);
    await page.setViewportSize({ width: 1024, height: 900 });
    for (const label of labels) {
      const card = builder.getByRole('group', { name: `${label} 조건`, exact: true });
      await card.scrollIntoViewIfNeeded();
      const overflow = await card.evaluate(element => {
        const boundary = element.getBoundingClientRect();
        return [...element.querySelectorAll<HTMLElement>('input, select, button, .condition-unit')]
          .filter(node => node.getClientRects().length)
          .some(node => { const box = node.getBoundingClientRect(); return box.left < boundary.left - 1 || box.right > boundary.right + 1; });
      });
      expect(overflow, `${label} at ${size}px`).toBe(false);
    }
    await amount.scrollIntoViewIfNeeded();
    const amountInput = amount.getByLabel('최소 거래대금(억)');
    await amountInput.click();
    await expect(amountInput).toHaveCSS('outline-style', 'none');
    await expect(amountInput.locator('..')).toHaveCSS('outline-style', 'solid');
    await builder.screenshot({ path: testInfo.outputPath(`condition-editor-${theme}.png`) });
  }
  expect(errors).toEqual([]);
});
