import { test, expect } from '@playwright/test';
import type { ScreenerResponse } from '../../src/api/screener';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact, apiPrefix } from './helpers/apiRoutes';
import { installScreenerRunsMock } from './helpers/screenerRuns';

test('drawer keeps its compact rows, shades departures, and dismisses them together', async ({ page }, testInfo) => {
  await page.clock.install({ time: new Date('2026-11-02T01:00:00Z') });
  await installLiveMocks(page);
  const rows: ScreenerResponse['rows'] = [
    { code: '005930', name: '삼성전자', market: 'KOSPI', price: 70000, change_pct: 2.1, trade_value_won: 1e11 },
    { code: '000660', name: 'SK하이닉스', market: 'KOSPI', price: 180000, change_pct: -1.2, trade_value_won: 2e11 },
    { code: '035420', name: 'NAVER', market: 'KOSPI', price: 210000, change_pct: 1.0, trade_value_won: 3e11 },
  ];
  let matching = rows;
  let cutoff = Date.parse('2026-11-02T01:00:00Z');
  const response = (): ScreenerResponse => ({ status: 'ok', warnings: [], rows: matching, has_more: false, basis_at_ms: cutoff });
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { schema_version: 1, saves: [{
    id: 'retained', name: '거래대금', conditions: [{ id: 'a', type: 'trade_value', params: { min_eok: 100 } }],
    universe: {}, created_at_ms: 1, updated_at_ms: 1,
  }] } }));
  await page.route(apiPrefix('screener/status'), route => route.fulfill({ json: { status: 'ok', days_behind: 0 } }));
  await page.route(apiPrefix('screener/exclusions'), route => route.fulfill({ json: { schema_version: 1, exclusions: [] } }));
  await page.route(apiPrefix('live/quotes'), route => route.fulfill({ json: { phase: 'open',
    quotes: rows.map(row => ({ code: row.code, price: row.price, change_pct: row.change_pct, change_won: 0 })) } }));
  await page.route(apiExact('screener/scan'), route => route.fulfill({ json: response() }));
  await installScreenerRunsMock(page, response);
  await page.goto('/heatmap');
  await page.getByRole('button', { name: /스크리너 패널 토글/ }).click();
  const panel = page.getByTestId('screener-panel');
  await panel.evaluate(element => { element.style.width = '260px'; });
  await panel.getByRole('button', { name: /시작/ }).click();
  const samsung = panel.getByTestId('screener-row-005930');
  const sk = panel.getByTestId('screener-row-000660');
  const naver = panel.getByTestId('screener-row-035420');
  const dismiss = panel.getByRole('button', { name: '이탈 제외', exact: true });
  await expect(naver).toBeVisible();
  await expect(dismiss).toBeDisabled();
  await panel.getByRole('button', { name: '10초', exact: true }).click();
  const originalBox = (await samsung.boundingBox())!;
  const originalOrder = await panel.locator('[data-quote-row]').evaluateAll(elements => elements.map(el => el.getAttribute('data-testid')));
  // Wait for this fixture's new cutoff, including any prior in-flight response.
  // The next timeout is chained after the asynchronous scan finishes.
  const refresh = async () => {
    cutoff += 10_000;
    await expect.poll(async () => {
      await page.clock.fastForward(10_001);
      return page.evaluate(() => JSON.parse(localStorage.getItem('screenerPanel.v1')!).lastScan.basisAtMs as number);
    }).toBe(cutoff);
  };

  matching = [rows[2]];
  await refresh();
  await expect(samsung).toHaveAttribute('data-shaded', 'true');
  await expect(sk).toHaveAttribute('data-shaded', 'true');
  await expect(naver).not.toHaveAttribute('data-shaded');
  await expect(samsung).not.toContainText(/조건 충족|조건 이탈|10:00/);
  await expect(samsung.getByRole('button', { name: /제외/ })).toHaveCount(0);
  const shadedBox = (await samsung.boundingBox())!;
  expect(shadedBox.height).toBe(originalBox.height);
  expect(shadedBox.y).toBe(originalBox.y);
  expect(await panel.locator('[data-quote-row]').evaluateAll(elements => elements.map(el => el.getAttribute('data-testid')))).toEqual(originalOrder);
  await expect(dismiss).toBeInViewport();
  const buttonBox = (await dismiss.boundingBox())!, panelBox = (await panel.boundingBox())!;
  expect(buttonBox.x).toBeGreaterThanOrEqual(panelBox.x);
  expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width);
  await panel.screenshot({ path: testInfo.outputPath('retained-shading.png') });

  matching = rows;
  await refresh();
  await expect(samsung).not.toHaveAttribute('data-shaded');
  await expect(sk).not.toHaveAttribute('data-shaded');
  await expect(dismiss).toBeDisabled();
  matching = [rows[2]];
  await refresh();
  await expect(dismiss).toBeEnabled();
  await dismiss.click();
  await expect(samsung).toHaveCount(0);
  await expect(sk).toHaveCount(0);
  await expect(naver).toBeVisible();
  await expect(dismiss).toBeDisabled();
  await refresh();
  await expect(samsung).toHaveCount(0);
  matching = rows;
  await refresh();
  await expect(samsung).toBeVisible();
  await expect(sk).toBeVisible();
  await expect(samsung).not.toHaveAttribute('data-shaded');
});

test('page bulk dismissal removes shaded stocks even when hidden by the result search', async ({ page }) => {
  await installLiveMocks(page);
  const rows: ScreenerResponse['rows'] = [
    { code: '005930', name: '삼성전자', market: 'KOSPI', price: 70000, change_pct: 2.1, trade_value_won: 1e11 },
    { code: '000660', name: 'SK하이닉스', market: 'KOSPI', price: 180000, change_pct: -1.2, trade_value_won: 2e11 },
  ];
  let matching = rows;
  const response = (): ScreenerResponse => ({ status: 'ok', warnings: [], rows: matching });
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { schema_version: 1, saves: [{
    id: 'page-retained', name: '거래대금', conditions: [{ id: 'a', type: 'trade_value', params: { min_eok: 100 } }],
    universe: {}, created_at_ms: 1, updated_at_ms: 1,
  }] } }));
  await page.route(apiPrefix('screener/status'), route => route.fulfill({ json: { status: 'ok', days_behind: 0 } }));
  await page.route(apiPrefix('screener/exclusions'), route => route.fulfill({ json: { schema_version: 1, exclusions: [] } }));
  await page.route(apiExact('screener/scan'), route => route.fulfill({ json: response() }));
  await installScreenerRunsMock(page, response);
  await page.goto('/screener');
  const results = page.getByTestId('screener-results-pane');
  const samsung = results.getByRole('button', { name: '삼성전자 005930 호가창 열기', exact: true });
  const sk = results.getByRole('button', { name: 'SK하이닉스 000660 호가창 열기', exact: true });
  const query = page.getByRole('button', { name: '조회', exact: true });
  await query.click();
  await expect(samsung).toBeVisible();
  matching = [rows[1]];
  await query.click();
  await expect(samsung).toHaveAttribute('data-shaded', 'true');
  await expect(sk).not.toHaveAttribute('data-shaded');
  await results.getByRole('searchbox', { name: '결과 내 종목 검색' }).fill('SK');
  await expect(samsung).toHaveCount(0);
  await results.getByRole('button', { name: '이탈 제외', exact: true }).click();
  await expect(sk).toBeVisible();
  await expect(results.getByRole('searchbox')).toHaveValue('SK');
  await results.getByRole('searchbox').fill('');
  await expect(samsung).toHaveCount(0);
  await expect(results.getByRole('button', { name: '이탈 제외', exact: true })).toBeDisabled();
  await page.reload();
  await expect(sk).toBeVisible();
  await expect(samsung).toHaveCount(0);
  matching = rows;
  await query.click();
  await expect(samsung).toBeVisible();
  await expect(samsung).not.toHaveAttribute('data-shaded');
});
