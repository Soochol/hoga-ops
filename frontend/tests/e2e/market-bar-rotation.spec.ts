import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

test('one-line market bar rotates, switches on blank clicks, and keeps coverage fixed', async ({ page }) => {
  const now = Date.UTC(2026, 9, 14, 5, 20);
  await page.clock.install({ time: now });
  await installLiveMocks(page);
  const collection = {
    server_now_ms: now, collection_expected: false, poll_interval_ms: 10_000,
    stale_after_ms: 30_000,
    targets: Object.fromEntries(['KOSPI', 'KOSDAQ', 'F001'].map(key => [key, {
      status: 'closed', last_success_at_ms: now, gaps: [],
    }])),
  };
  const group = { date: '20261014', unit: 'amt_eok', confirmed: false, collection };
  const point = { t_ms: now, individual: -3240, foreign: 2180, institution: 980 };
  await page.route(apiExact('market/investor-flow-summary'), route => route.fulfill({ json: {
    stock: { ...group, markets: { KOSPI: point, KOSDAQ: point } },
    futures: { ...group, markets: { F001: point } },
  } }));
  await page.route(apiExact('live/index-quotes'), route => route.fulfill({ json: { quotes:
    ['KOSPI', 'KOSDAQ', 'KOSPI200', 'KOSDAQ150', 'KRX100'].map(id => ({
      id, label: id, value: 6082.76, change: 47.41, change_rate: 0.79, t_ms: now,
    })),
  } }));
  await page.route(apiExact('live/status'), route => route.fulfill({ json: {
    running: true, kiwoom: { connected_accounts: 1, accounts_configured: 1, subscribed_count: 330 },
  } }));
  await page.goto('/live');
  const bar = page.getByRole('contentinfo', { name: '시장지표' });
  await expect(page.getByRole('button', { name: '투자자 수급 화면으로 전환' })).toBeVisible();
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1_000);
  await expect(bar).toHaveAttribute('data-page', 'indices');
  const coverage = page.getByTestId('kiwoom-coverage-chip');
  const before = await coverage.boundingBox();
  const height = await bar.evaluate(el => el.getBoundingClientRect().height);
  await page.clock.runFor(10_000);
  await expect(bar).toHaveAttribute('data-page', 'flow');
  await expect(page.getByTestId('market-flow-KOSPI')).toContainText('외인+2,180');
  expect(await coverage.boundingBox()).toEqual(before);
  expect(await bar.evaluate(el => el.getBoundingClientRect().height)).toBe(height);
  await page.getByRole('button', { name: '지수 화면으로 전환' }).click();
  await expect(bar).toHaveAttribute('data-page', 'indices');
  await page.clock.runFor(9_000);
  await page.getByRole('button', { name: '투자자 수급 화면으로 전환' }).click();
  await page.clock.runFor(1_000);
  await expect(bar).toHaveAttribute('data-page', 'flow');
  // /live 셸은 기존 944px 최소 폭을 유지한다.
  for (const width of [1440, 1024, 960]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(coverage).toBeVisible();
    expect(await bar.evaluate(el => el.getBoundingClientRect().height)).toBe(height);
    const bounds = await bar.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
  }
});
