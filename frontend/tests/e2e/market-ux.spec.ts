import { test, expect, type Page } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiPrefix } from './helpers/apiRoutes';

async function marketMocks(page: Page) {
  await installLiveMocks(page);
  await page.route(apiPrefix('market/'), async (route) => {
    const path = new URL(route.request().url()).pathname.split('/').at(-1);
    const responses: Record<string, unknown> = {
      sectors: { markets: { '0': { sectors: [{ code: '1', name: '긴 업종 이름', change_pct: 2 }] } }, volatility: { value: 20, change_pct: 1 } },
      'futures-quotes': { quotes: [], session: 'closed' },
      funds: { as_of: '20260904', series: [
        { date: '20260901', deposit_won: 100e12, credit_won: 30e12, cma_won: 80e12 },
        { date: '20260904', deposit_won: 93.5e12, credit_won: 31e12, cma_won: 81e12 },
      ] },
      'investor-flow': { date: '20260909', confirmed: false, markets: {}, coverage: {}, daily: [
        { date: '20260908', markets: { KOSPI: { foreign: 100, institution: -100 } } },
      ] },
      'deriv-flow': { date: '20260909', products: {}, unit: null },
      'sector-flow': { date: '20260909', markets: {} },
      program: { markets: { KOSPI: [
        { t: '200000', arb_net_eok: 100, non_arb_net_eok: -20, total_net_eok: 80 },
        { t: '182100', arb_net_eok: 50, non_arb_net_eok: -10, total_net_eok: 40 },
      ] } },
      streaks: {}, breadth: { markets: {} }, 'trade-value': { markets: {} },
    };
    await route.fulfill({ json: responses[path ?? ''] ?? {} });
  });
  await page.route(apiPrefix('live/index-quotes'), (r) => r.fulfill({ json: { quotes:
    ['KOSPI', 'KOSDAQ', 'KOSPI200', 'KOSDAQ150'].map((id) => ({ id, label: id, value: 1234.5, change: 1, change_rate: 0.1, t_ms: 1 })),
  } }));
  await page.route(apiPrefix('live/index-candles'), (r) => r.fulfill({ json: { candles: [] } }));
  await page.route(apiPrefix('live/rankings'), (r) => r.fulfill({ json: {
    rows: [{ rank: 1, code: '005930', name: '삼성전자', price: 71200, change_pct: 1, trade_value_won: 3119200000000 }],
    market_open: false, fetched_at_ms: 1, venue: 'KRX', warnings: [],
  } }));
}

for (const width of [1440, 800, 600]) {
  test(`market cards fit available width at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await marketMocks(page);
    await page.goto('/market');
    const market = page.locator('.market-page');
    await expect(market.getByText('93.5조', { exact: true })).toBeVisible();
    await expect(market.getByText('거래대금(억)')).toHaveCount(1);
    const metrics = await market.evaluate((el) => ({
      right: el.getBoundingClientRect().right,
      overflow: [...el.querySelectorAll<HTMLElement>('.market-main,.market-pair,.market-ranks,.market-indices')]
        .map((grid) => grid.scrollWidth - grid.clientWidth),
    }));
    expect(metrics.right).toBeLessThanOrEqual(width);
    expect(metrics.overflow.every((px) => px <= 1)).toBe(true);
    await market.getByText('거래대금(억)').scrollIntoViewIfNeeded();
    await expect(market.getByText('31,192', { exact: true })).toBeVisible();
  });
}

test('market empty-state action, chart keyboard inspection and after-hours axis', async ({ page }) => {
  await marketMocks(page);
  await page.goto('/market');
  const market = page.locator('.market-page');
  await expect(market.getByText('20:00', { exact: true })).toBeVisible();
  await market.getByRole('button', { name: '일별 수급 보기' }).click();
  await expect(market.getByText('09/08 기준', { exact: true })).toBeVisible();
  const chart = market.getByRole('group', { name: /차트 상세/ }).last();
  await chart.focus();
  await chart.press('Home');
  await expect(chart.getByRole('status')).toContainText('09/01');
  await chart.press('End');
  await expect(chart.getByRole('status')).toContainText('09/04');
  await expect(chart.getByRole('status')).toContainText('-6.5조원');
});
