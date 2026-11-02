import { test, expect } from '@playwright/test';
import type { ScreenerResponse } from '../../src/api/screener';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact, apiPrefix } from './helpers/apiRoutes';
import { installScreenerRunsMock } from './helpers/screenerRuns';

test('page and narrow panel share dismissal controls and keep explanations in accessible help', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const response: ScreenerResponse = { status: 'ok', warnings: [],
    calculation: { policy: 'separate_bases_v2', snapshot_id: 'a'.repeat(64), adjusted_as_of: '2026-10-30',
      price_basis: 'vendor_adjusted', event_revision: 'b'.repeat(64), replayable: false },
    rows: [{ code: '005930', name: '삼성전자', market: 'KOSPI', price: 70000, change_pct: 2, trade_value_won: 1e11 }] };
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [{
    id: 'help', name: '도움말 확인', calculation_policy: 'separate_bases_v2',
    conditions: [{ id: 'a', type: 'trade_value', params: { min_eok: 100 } }],
    universe: {}, created_at_ms: 1, updated_at_ms: 1,
  }] } }));
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: { status: 'ok' } }));
  await page.route(apiPrefix('screener/exclusions'), route => route.fulfill({ json: { exclusions: [] } }));
  await page.route(apiPrefix('live/quotes'), route => route.fulfill({ json: { phase: 'open', quotes: [] } }));
  await page.route(apiExact('screener/scan'), route => route.fulfill({ json: response }));
  await installScreenerRunsMock(page, () => response);
  await page.goto('/screener');
  await page.getByRole('button', { name: '조회', exact: true }).click();
  const results = page.getByTestId('screener-results-pane');
  const dismiss = results.getByRole('button', { name: '이탈 제외', exact: true });
  await expect(dismiss).toBeVisible();
  const buttonStyle = await dismiss.evaluate(el => {
    const s = getComputedStyle(el);
    return [s.fontSize, s.padding, s.borderRadius];
  });
  await expect(results.getByText('가격·등락률:', { exact: false })).toHaveCount(0);
  const help = results.getByRole('button', { name: '결과 시세 기준', exact: true });
  await expect(help.locator('svg[data-ui-icon]')).toHaveCount(1);
  await help.hover();
  await expect(page.getByRole('tooltip')).toContainText('가격·등락률: 현재 시세');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await results.getByRole('button', { name: '조회 당시', exact: true }).click();
  await results.getByRole('button', { name: '조회 당시', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(help).toBeFocused();
  await expect(page.getByRole('tooltip')).toContainText('조회 당시 값');
  await page.keyboard.press('Escape');
  await page.getByLabel('계산 기준 펼치기', { exact: true }).click();
  await expect(page.getByRole('button', { name: '이 스냅샷으로 확정 일봉 결과 보존' })).toBeVisible();
  await page.getByLabel('계산 기준 펼치기', { exact: true }).click();
  await results.screenshot({ path: testInfo.outputPath('page-compact-help.png') });

  await page.goto('/heatmap');
  await page.getByRole('button', { name: /스크리너 패널 토글/ }).click();
  const panel = page.getByTestId('screener-panel');
  await panel.evaluate(el => { el.style.width = '260px'; });
  const panelDismiss = panel.getByRole('button', { name: '이탈 제외', exact: true });
  await expect(panelDismiss).toBeVisible();
  expect(await panelDismiss.evaluate(el => {
    const s = getComputedStyle(el);
    return [s.fontSize, s.padding, s.borderRadius];
  })).toEqual(buttonStyle);
  const panelHelp = panel.getByRole('button', { name: '패널 결과 안내', exact: true });
  await panelHelp.click();
  await expect(page.getByRole('tooltip')).toContainText('이탈한 음영 행');
  const tip = (await page.getByRole('tooltip').boundingBox())!;
  expect(tip.x).toBeGreaterThanOrEqual(0);
  expect(tip.x + tip.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.keyboard.press('Escape');
  for (const button of [panelDismiss, panelHelp, panel.getByRole('button', { name: '스크리너 결과 정렬' })]) {
    await expect(button).toBeInViewport();
    const box = (await button.boundingBox())!, bounds = (await panel.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(bounds.x);
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
  }
  await panel.screenshot({ path: testInfo.outputPath('panel-compact-help.png') });
  expect(errors).toEqual([]);
});
