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
  await expect(dialog.getByRole('button', { name: '종목 검색 닫기' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('search-results.png') });
  await dialog.getByRole('button', { name: '관심 그룹 편집' }).last().click();
  const groupInput = page.getByRole('textbox', { name: '새 그룹 만들기' });
  await groupInput.click();
  await expect(groupInput).toBeFocused();
  await expect(dialog).toBeVisible();
  await input.click();
  await expect(page.getByRole('dialog', { name: '내 관심 그룹' })).toHaveCount(0);
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
  await dialog.getByRole('button', { name: '관심 그룹 편집' }).first().click();
  const picker = page.getByRole('dialog', { name: '내 관심 그룹' });
  await expect(picker).toBeVisible();
  await picker.getByRole('textbox', { name: '새 그룹 만들기' }).press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(dialog).toBeVisible();
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

test('초성·코드 검색의 순위와 강조를 유지하고 방향키로만 종목을 바꾸지 않는다', async ({ page }, testInfo) => {
  const catalog = [
    { ...symbols[0], code: '005935', name: '삼성전자우' },
    { ...symbols[0], code: '005930', name: '삼성전자' },
  ];
  await page.route(/^https?:\/\/[^/]+\/api\/symbols\/all$/, (route) => route.fulfill({
    json: { symbols: catalog, status: 'fresh', fetched_at_ms: Date.now(), reason: null },
  }));
  await page.goto('/live');
  await page.keyboard.press('/');
  const dialog = page.getByRole('dialog', { name: '종목 검색' });
  const input = dialog.getByRole('combobox');
  const title = await page.title();
  await input.fill('ㅅㅅㅈㅈ');
  await expect(dialog.getByRole('option')).toHaveCount(2);
  await expect(dialog.getByRole('option').first()).toContainText('005930');
  await input.press('ArrowDown');
  await expect(dialog.getByText('삼성전자우 열기')).toBeVisible();
  await expect(page).toHaveTitle(title);
  await input.fill('삼성전자');
  await expect(dialog.getByRole('option', { selected: true })).toContainText('005930');
  await expect(dialog.getByRole('option').first().locator('mark')).toHaveText('삼성전자');
  await page.screenshot({ path: testInfo.outputPath('search-proposal-results.png') });
  await input.fill('005930');
  await expect(dialog.getByRole('option')).toHaveCount(1);
  await input.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveTitle(/삼성전자/);
  await page.keyboard.press('/');
  await expect(dialog.getByRole('option')).toHaveCount(1);
  await input.fill('없는종목');
  await expect(dialog.getByText('일치하는 종목이 없습니다')).toBeVisible();
  await dialog.getByRole('button', { name: '검색어 지우기' }).click();
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await expect(dialog.getByRole('option')).toHaveCount(1);
});

test('목록을 불러오지 못했을 때 빈 결과와 구분하고 다시 시도할 수 있다', async ({ page }) => {
  let ready = false;
  await page.route(/^https?:\/\/[^/]+\/api\/symbols\/all$/, (route) => route.fulfill({
    json: { symbols: ready ? symbols : [], status: ready ? 'fresh' : 'unavailable', fetched_at_ms: null, reason: null },
  }));
  await page.goto('/live');
  await page.keyboard.press('/');
  const dialog = page.getByRole('dialog', { name: '종목 검색' });
  await dialog.getByRole('combobox').fill('검색종목');
  await expect(dialog.getByRole('alert')).toContainText('종목 목록을 불러오지 못했습니다.');
  await expect(dialog.getByText('일치하는 종목이 없습니다')).toHaveCount(0);
  ready = true;
  await dialog.getByRole('button', { name: '다시 시도' }).click();
  await expect(dialog.getByRole('option')).toHaveCount(20);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('준비 중인 종목 목록은 검색창이 열린 동안 다시 확인해 결과로 바뀐다', async ({ page }) => {
  let ready = false;
  await page.route(/^https?:\/\/[^/]+\/api\/symbols\/all$/, (route) => route.fulfill({
    json: { symbols: ready ? symbols : [], status: ready ? 'fresh' : 'loading', fetched_at_ms: null, reason: null },
  }));
  await page.goto('/live');
  await page.keyboard.press('/');
  const dialog = page.getByRole('dialog', { name: '종목 검색' });
  await dialog.getByRole('combobox').fill('검색종목');
  await expect(dialog.getByRole('status')).toContainText('종목 목록을 불러오는 중입니다.');
  await expect(dialog.getByText('일치하는 종목이 없습니다')).toHaveCount(0);
  ready = true;
  await expect(dialog.getByRole('option')).toHaveCount(20);
  await expect(dialog.getByRole('status')).toHaveCount(0);
});

test('모든 종목 창이 고정되면 선택과 최근 기록을 막고 고정 해제 후 적용한다', async ({ page }) => {
  await page.goto('/live?code=098460');
  const firstWindowId = await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    const windows = store.getState().windows.map((win: { id: string; kind: string }) => win.kind === 'market-indices'
      ? win : { ...win, pinned: { code: '098460', name: '고영' } });
    store.setState({ windows });
    return windows.find((win: { kind: string }) => win.kind !== 'market-indices').id as string;
  });
  await page.keyboard.press('/');
  const dialog = page.getByRole('dialog', { name: '종목 검색' });
  const input = dialog.getByRole('combobox');
  await input.fill('검색종목');
  await expect(dialog.getByText(/모든 창이 고정되어 있습니다/)).toBeVisible();
  await expect(dialog.getByRole('option').first()).toBeDisabled();
  await input.press('Enter');
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('hoga.liveSymbolSearch.recent'))).toBeNull();
  await page.evaluate(async (id) => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    store.setState({ windows: store.getState().windows.map((win: { id: string }) => win.id === id ? { ...win, pinned: undefined } : win) });
  }, firstWindowId);
  await expect(dialog.getByRole('option').first()).toBeEnabled();
  await input.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveTitle(/검색종목00/);
});

for (const theme of ['obsidian', 'ledger', 'toss-light', 'toss-dark', 'obsidian-pro', 'ledger-studio']) {
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
