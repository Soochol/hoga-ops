import { test, expect } from '@playwright/test';
import type { ConditionLeaf, ScanRequest } from '../../src/api/screener';
import { apiExact } from './helpers/apiRoutes';
import { installLiveMocks } from './helpers/liveMocks';

for (const position of [false, true]) {
  test(`Bollinger ${position ? 'position' : 'breakout'} conditions can be added, configured, saved, reloaded and scanned`, async ({ page }, testInfo) => {
    const todayName = position ? '볼린저밴드 위·아래' : '볼린저밴드 돌파';
    const recentName = `기간내 ${todayName}`;
    const priceLabel = position ? '비교가격' : '돌파 비교가격';
    const bandLabel = position ? '위치' : '돌파 밴드';
    const family = position ? 'bollinger_position' : 'bollinger_breakout';
    await installLiveMocks(page);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    let saved = { id: 'bb', name: '볼린저 돌파 검색', conditions: [] as ConditionLeaf[], universe: {},
      created_at_ms: 1, updated_at_ms: 1 };
    const scans: ScanRequest[] = [];
    await page.route(apiExact('screener/status'), route => route.fulfill({ json: { status: 'ok', warnings: [] } }));
    await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [saved] } }));
    await page.route(apiExact('screener/saves/bb'), route => {
      saved = { ...saved, ...route.request().postDataJSON(), updated_at_ms: 2 };
      return route.fulfill({ json: saved });
    });
    await page.route(apiExact('screener/scan'), route => {
      scans.push(route.request().postDataJSON());
      return route.fulfill({ json: { status: 'ok', rows: [], warnings: [], scanned_at_ms: 1785373500000,
        bar_coverage: { total: 1, complete: 1, incomplete: [] } } });
    });
    await page.goto('/screener');
    for (const name of [todayName, recentName]) {
      await page.getByRole('button', { name: '조건 추가', exact: true }).click();
      const menu = await page.getByRole('menu').boundingBox();
      expect(menu!.y).toBeGreaterThanOrEqual(0);
      expect(menu!.y + menu!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
      await page.getByRole('menuitem', { name, exact: true }).click();
    }
    const today = page.getByRole('group', { name: `${todayName} 조건`, exact: true });
    const recent = page.getByRole('group', { name: `${recentName} 조건`, exact: true });
    await today.getByLabel(priceLabel, { exact: true }).selectOption('high');
    await today.getByLabel('표준편차 배수').fill('2.5');
    await recent.getByLabel('볼린저 최근 기간').fill('7');
    await recent.getByLabel(priceLabel, { exact: true }).selectOption('low');
    await recent.getByRole('combobox', { name: bandLabel, exact: true }).selectOption('lower');
    await recent.getByLabel('볼린저 기간', { exact: true }).fill('10');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await expect.poll(() => saved.conditions.length).toBe(2);
    expect(saved.conditions[0]).toMatchObject({ type: `${family}_today`, params: { source: 'high', multiplier: 2.5 } });
    expect(saved.conditions[1]).toMatchObject({ type: family, params: { source: 'low', band: 'lower', lookback: 7, period: 10 } });
    await expect(page.getByRole('button', { name: '저장본으로 되돌리기', exact: true })).toHaveCount(0);
    await page.reload();
    await expect(today.getByLabel(priceLabel, { exact: true })).toHaveValue('high');
    await expect(today.getByLabel('표준편차 배수')).toHaveValue('2.5');
    await expect(recent.getByLabel('볼린저 최근 기간')).toHaveValue('7');
    await expect(recent.getByRole('combobox', { name: bandLabel, exact: true })).toHaveValue('lower');
    await page.getByRole('button', { name: '조회', exact: true }).click();
    await expect.poll(() => scans.length).toBe(1);
    expect(scans[0].conditions).toEqual(saved.conditions);
    await expect(page.getByText('봉 이력 충분 1/1종목')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`bollinger-${family}-wide.png`), fullPage: true });
    await page.setViewportSize({ width: 768, height: 1000 });
    for (const card of [today, recent]) {
      const band = card.getByRole('combobox', { name: bandLabel, exact: true });
      await band.scrollIntoViewIfNeeded();
      await expect(band).toBeVisible();
      const parent = await card.boundingBox();
      const child = await band.boundingBox();
      expect(child!.x + child!.width).toBeLessThanOrEqual(parent!.x + parent!.width);
      expect(child!.y + child!.height).toBeLessThanOrEqual(parent!.y + parent!.height);
    }
    await page.screenshot({ path: testInfo.outputPath(`bollinger-${family}-narrow.png`), fullPage: true });
    expect(errors).toEqual([]);
  });
}
