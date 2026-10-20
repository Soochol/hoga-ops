import { test, expect, type Page } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

async function setup(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await installLiveMocks(page);
  await page.route(apiExact('symbols/info'), route => route.fulfill({ json: { count: 1, fetched_at_ms: Date.now(), status: 'fresh', reason: null } }));
  let settings = { schema_version: 1, rest_bypass_enabled: false, screener_depth_autocollect: false, krx_prefer_hogaplay: false };
  const patches: Record<string, boolean>[] = [];
  await page.route(apiExact('live/settings'), async route => {
    if (route.request().method() === 'PATCH') {
      const patch = route.request().postDataJSON(); patches.push(patch); settings = { ...settings, ...patch };
    }
    await route.fulfill({ json: settings });
  });
  await page.goto('/live?code=098460');
  await expect(page.getByTestId('chart-window-header').first()).toBeVisible();
  return patches;
}

test('프리셋 이름은 클릭과 Tab 이동에서 포커스 표시가 겹치지 않는다', async ({ page }) => {
  await page.route(apiExact('live-layout-presets'), route => route.fulfill({ json: { schema_version: 1, presets: [] } }));
  await setup(page);
  await page.getByTestId('layout-preset-button').click();
  await page.getByTestId('layout-preset-save-as-open').click();
  const name = page.getByTestId('layout-preset-save-as-input');
  await name.press('Tab');
  const border = await name.evaluate(el => getComputedStyle(el).borderColor);
  await name.click();
  await expect(name).toBeFocused();
  await expect(name).toHaveCSS('outline-color', 'rgba(0, 0, 0, 0)');
  await expect(name).not.toHaveCSS('border-color', border);
  await name.press('Tab');
  await expect(name).toHaveCSS('border-color', border);
  await page.keyboard.press('Shift+Tab');
  await expect(name).toBeFocused();
  await expect(name).toHaveCSS('outline-color', 'rgba(0, 0, 0, 0)');
  await expect(name).not.toHaveCSS('border-color', border);
});

test('거래소 라디오는 방향키와 Tab 이동에서 포커스 표시가 겹치지 않는다', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '설정', exact: true }).first().click();
  const editor = page.getByTestId('settings-shell');
  await editor.getByTestId('settings-nav-data-source').click();
  const krx = editor.getByTestId('live-venue-KRX');
  const nxt = editor.getByTestId('live-venue-NXT');
  await krx.click();
  await expect(krx).toBeChecked();
  await krx.press('ArrowRight');
  await expect(nxt).toBeFocused();
  await expect(nxt).toBeChecked();
  await expect(nxt).toHaveCSS('outline-color', 'rgba(0, 0, 0, 0)');
  await expect(nxt.locator('..')).toHaveCSS('outline-style', 'solid');
  await expect(nxt.locator('..')).toHaveCSS('outline-width', '2px');
  await nxt.press('Tab');
  await expect(nxt.locator('..')).toHaveCSS('outline-style', 'none');
  await page.keyboard.press('Shift+Tab');
  await expect(nxt).toBeFocused();
  await expect(nxt).toHaveCSS('outline-color', 'rgba(0, 0, 0, 0)');
  await expect(nxt.locator('..')).toHaveCSS('outline-style', 'solid');
});

for (const theme of ['toss-light', 'toss-dark']) {
  test(`${theme}: 헤더 설정에서 전역·서버 변경을 되돌리고 검색과 목차를 유지한다`, async ({ page }, testInfo) => {
    await page.addInitScript(theme => localStorage.setItem('ui.themePreference.v1', JSON.stringify({ themePreference: theme })), theme);
    const patches = await setup(page);
    await page.getByRole('button', { name: '설정', exact: true }).first().click();
    const editor = page.getByTestId('settings-shell');
    await expect(editor.getByText('앱 전체에 적용', { exact: true })).toBeVisible();
    const toggle = editor.getByRole('switch', { name: '캔들이 항상 위', exact: true });
    const old = await toggle.getAttribute('aria-checked');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', old === 'true' ? 'false' : 'true');
    await editor.getByRole('button', { name: '되돌리기' }).click();
    await expect(toggle).toHaveAttribute('aria-checked', old!);
    const search = editor.getByRole('textbox', { name: '설정 필터' });
    await search.fill('이전일 고가선');
    await expect(editor.getByTestId('settings-linestyle-highLowPriorHighLine')).toBeVisible();
    await search.press('Escape');
    await expect(search).toHaveValue('');
    await editor.getByTestId('settings-nav-data-source').click();
    const savedSource = editor.getByRole('switch', { name: '저장 데이터로 캔들 보기', exact: true });
    await savedSource.click();
    await expect(savedSource).toHaveAttribute('aria-checked', 'true');
    await expect(editor.getByRole('button', { name: '되돌리기' })).toBeEnabled();
    await editor.getByRole('button', { name: '되돌리기' }).click();
    await expect(savedSource).toHaveAttribute('aria-checked', 'false');
    expect(patches).toEqual([{ rest_bypass_enabled: true }, { rest_bypass_enabled: false }]);
    await editor.getByTestId('settings-nav-chart').click();
    await expect(toggle).toBeVisible();
    await expect.poll(async () => {
      const title = (await editor.locator('[data-settings-section="chart"]').boundingBox())!;
      const body = (await editor.locator('.settings-editor-content').boundingBox())!;
      return Math.abs(title.y - body.y - 22);
    }).toBeLessThan(3);
    await editor.screenshot({ path: testInfo.outputPath(`settings-editor-${theme}.png`) });
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);
  });
}

test('보조지표 스타일·기간 편집과 되돌리기, 반응형 배치, 재진입 저장을 확인한다', async ({ page }, testInfo) => {
  await setup(page);
  const opener = page.getByTestId('chart-window-header').first().getByRole('button', { name: /보조지표/ });
  await opener.click();
  const editor = page.getByTestId('indicator-panel-shell');
  await editor.getByRole('button', { name: '이동평균선', exact: true }).click();
  await expect(editor.getByTestId('indicator-panel-scope-badge')).toContainText('분봉');
  const preview = editor.getByTestId('indicator-style-preview');
  const path = preview.locator('[data-preview-line]').first();
  const before = await path.getAttribute('d');
  const input = editor.getByRole('spinbutton', { name: '기간1 길이', exact: true });
  const period = Number(await input.inputValue());
  await input.fill(String(period + 7)); await input.press('Enter');
  await expect(path).not.toHaveAttribute('d', before!);
  await editor.getByRole('button', { name: '되돌리기' }).click();
  await expect(input).toHaveValue(String(period));
  await expect(path).toHaveAttribute('d', before!);
  await input.fill(String(period + 1)); await input.press('Enter');
  await expect(editor.getByRole('button', { name: '되돌리기' })).toBeEnabled();
  await input.fill(String(period + 2));
  await editor.getByRole('button', { name: '되돌리기' }).click();
  await expect(input).toHaveValue(String(period + 1));
  await expect(editor.getByRole('button', { name: '되돌리기' })).toBeDisabled();
  await editor.getByRole('button', { name: 'MA 스타일 선택', exact: true }).first().click();
  const palette = page.getByRole('dialog', { name: 'MA 스타일 팔레트', exact: true });
  const oldWidth = await path.getAttribute('stroke-width');
  const nextWidth = oldWidth === '4' ? '3' : '4';
  await palette.getByRole('button', { name: `MA 굵기 ${nextWidth}px`, exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(editor).toBeVisible();
  await expect(path).toHaveAttribute('stroke-width', nextWidth);
  await editor.getByRole('button', { name: '되돌리기' }).click();
  await expect(path).toHaveAttribute('stroke-width', oldWidth!);
  for (const [width, height] of [[1440, 1100], [1024, 800], [390, 760]]) {
    await page.setViewportSize({ width, height });
    await expect(async () => {
      expect(await editor.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await editor.locator('.settings-editor-main').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }).toPass();
    await expect(editor.getByRole('button', { name: '닫기', exact: true })).toBeVisible();
    await expect(editor.getByRole('button', { name: '되돌리기', exact: true })).toBeVisible();
    await editor.screenshot({ path: testInfo.outputPath(`indicator-editor-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await input.fill(String(period + 3)); await input.press('Enter');
  await editor.getByRole('button', { name: '닫기', exact: true }).click();
  await opener.click();
  await expect(editor.getByRole('spinbutton', { name: '기간1 길이', exact: true })).toHaveValue(String(period + 3));
  await expect(editor.getByRole('button', { name: '되돌리기', exact: true })).toBeDisabled();
  await editor.getByRole('button', { name: '지표 추가', exact: true }).click();
  const navigation = editor.getByRole('navigation', { name: '지표 추가', exact: true });
  for (const width of [1440, 1024, 640, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await navigation.getByRole('button', { name: '연속체결 매물대 분포', exact: true }).scrollIntoViewIfNeeded();
    const labels = await navigation.locator('.indicator-nav-label').evaluateAll(elements => elements.map(element => {
      const row = element.closest('.indicator-nav-row')!;
      const buttons = row.querySelectorAll(':scope > button');
      const action = buttons.length > 1 ? buttons[1] : null;
      const labelBounds = element.getBoundingClientRect();
      return {
        name: element.textContent,
        unclipped: element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1,
        beforeAction: action === null || labelBounds.right <= action.getBoundingClientRect().left,
        rowFits: row.scrollWidth <= row.clientWidth + 1,
      };
    }));
    expect(labels.length).toBeGreaterThan(5);
    expect(labels.filter(label => !label.unclipped || !label.beforeAction || !label.rowFits)).toEqual([]);
    expect(await editor.locator('.settings-editor-main').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await editor.screenshot({ path: testInfo.outputPath(`indicator-list-readable-${width}.png`) });
  }
});
