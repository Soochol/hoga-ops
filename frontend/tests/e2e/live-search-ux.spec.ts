import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

const symbols = Array.from({ length: 20 }, (_, i) => ({
  code: String(100000 + i), name: `검색종목${String(i).padStart(2, '0')}`, market: 'KOSPI',
  captured_count: 0,
  captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 },
}));

test.beforeEach(async ({ page }) => {
  await installLiveMocks(page);
  await page.route(/^https?:\/\/[^/]+\/api\/symbols\/all$/, (route) => route.fulfill({
    json: { symbols, status: 'fresh', fetched_at_ms: Date.now(), reason: null },
  }));
});

test('짧은 화면에서도 선택 결과가 스크롤되고 Escape는 검색창만 닫는다', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/live');
  const win = page.locator('[data-win]').first();
  await win.getByRole('button', { name: '창 최대화', exact: true }).click();
  const trigger = page.getByRole('button', { name: '종목 검색 열기' });
  await trigger.focus();
  await page.keyboard.press('/');
  const dialog = page.getByRole('dialog', { name: '종목 검색' });
  const input = dialog.getByRole('combobox', { name: '종목 검색' });
  await expect(input).toBeFocused();
  await input.fill('검색종목');
  const results = dialog.getByRole('option');
  await expect(results).toHaveCount(20);
  for (let i = 0; i < 19; i++) await input.press('ArrowDown');
  await expect(results.last()).toHaveAttribute('aria-selected', 'true');
  await expect(input).toHaveAttribute('aria-activedescendant', (await results.last().getAttribute('id'))!);
  await expect.poll(() => dialog.getByRole('listbox').evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const listBounds = (await dialog.getByRole('listbox').boundingBox())!;
  const lastBounds = (await results.last().boundingBox())!;
  expect(lastBounds.y).toBeGreaterThanOrEqual(listBounds.y);
  expect(lastBounds.y + lastBounds.height).toBeLessThanOrEqual(listBounds.y + listBounds.height + 1);
  await expect(dialog.getByText('닫기', { exact: false }).last()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('search-results.png') });
  await dialog.getByRole('button', { name: '관심 그룹 편집' }).last().click();
  const groupInput = page.getByRole('textbox', { name: '새 그룹 만들기' });
  await groupInput.click();
  await expect(groupInput).toBeFocused();
  await expect(dialog).toBeVisible();
  await input.click();
  await expect(page.getByRole('menu', { name: '내 관심 그룹' })).toHaveCount(0);
  await expect(results.last()).toHaveAttribute('aria-selected', 'true');
  await input.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(win.getByRole('button', { name: '원래 크기로 복원' })).toBeVisible();
});

test('최근 기록 삭제는 종목을 바꾸지 않고 남은 기록은 Enter로 적용된다', async ({ page }, testInfo) => {
  await page.addInitScript((recent) => {
    localStorage.setItem('hoga.liveSymbolSearch.recent', JSON.stringify(recent));
  }, symbols.slice(0, 2));
  await page.goto('/live');
  const beforeTitle = await page.title();
  await page.getByRole('button', { name: '종목 검색 열기' }).click();
  const dialog = page.getByRole('dialog', { name: '종목 검색' });
  await dialog.getByRole('button', { name: '검색종목00 최근 검색 삭제' }).click();
  await expect(dialog.getByRole('option')).toHaveCount(1);
  expect(await page.title()).toBe(beforeTitle);
  const input = dialog.getByRole('combobox');
  await expect(input).toBeFocused();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('hoga.liveSymbolSearch.recent')!)))
    .toEqual([symbols[1]]);
  await page.screenshot({ path: testInfo.outputPath('search-recent.png') });
  await input.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveTitle(/검색종목01/);
});

for (const theme of ['obsidian', 'ledger', 'toss-light', 'toss-dark']) {
  test(`${theme}: 긴 최근 종목명과 좁은 화면에서도 검색·삭제·닫기가 보인다`, async ({ page }, testInfo) => {
    const name = '아주 긴 종목 이름을 가진 삼성전자 단일종목 레버리지 상장지수펀드';
    await page.setViewportSize({ width: 480, height: 640 });
    await page.addInitScript(({ theme, name }) => {
      localStorage.setItem('ui.themePreference.v1', JSON.stringify({ themePreference: theme }));
      localStorage.setItem('hoga.liveSymbolSearch.recent', JSON.stringify([
        { code: '005930', name, market: 'KOSPI' },
      ]));
    }, { theme, name });
    await page.goto('/live');
    await page.keyboard.press('/');
    const dialog = page.getByRole('dialog', { name: '종목 검색' });
    await expect(dialog).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(16);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(464);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(640);
    await expect(dialog.getByRole('option', { name: new RegExp(name) })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`search-${theme}.png`) });
    await dialog.getByRole('button', { name: `${name} 최근 검색 삭제` }).click();
    await expect(dialog.getByRole('option')).toHaveCount(0);
    await dialog.getByRole('button', { name: '종목 검색 닫기' }).click();
    await expect(dialog).toHaveCount(0);
  });
}
