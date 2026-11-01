import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';
import { API_URL } from './worktreeEnv';

async function openSettings(page: Page) {
  await installLiveMocks(page);
  await page.route(apiExact('live/settings'), route => route.fulfill({ json: {
    schema_version: 1, rest_bypass_enabled: false, screener_depth_autocollect: false, krx_prefer_hogaplay: false,
  } }));
  await page.goto('/live?code=098460');
  await page.getByRole('navigation', { name: '우측 레일' }).getByRole('button', { name: '설정', exact: true }).click();
  const editor = page.getByTestId('settings-shell');
  await expect(editor).toBeVisible();
  return editor;
}

for (const theme of ['toss-light', 'trading-desk']) {
  test(`${theme}: 앱 설정의 그룹명 레일·고정 푸터·좁은 화면과 테마 되돌리기를 유지한다`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript(theme => localStorage.setItem('ui.themePreference.v1', JSON.stringify({ themePreference: theme })), theme);
    const editor = await openSettings(page);
    const sync = editor.getByRole('switch', { name: '크로스헤어 동기화 — 다른 종목까지', exact: true });
    await expect(sync).toHaveCSS('width', '26px');
    await expect(sync).toHaveCSS('height', '15px');
    await expect(editor.locator('.settings-property-group-label').first()).toHaveCSS('width', '44px');
    await expect(editor.locator('.settings-row').first()).toHaveCSS('min-height', '24px');
    const before = await sync.getAttribute('aria-checked');
    await sync.focus();
    await page.keyboard.press('Space');
    await expect(sync).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true');
    await editor.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect(sync).toHaveAttribute('aria-checked', before!);
    await editor.screenshot({ path: info.outputPath(`app-settings-${theme}.png`) });

    await editor.getByTestId('settings-nav-theme').click();
    const picker = editor.getByRole('combobox', { name: '테마 선택', exact: true });
    await picker.selectOption(theme === 'toss-light' ? 'trading-desk' : 'toss-light');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', theme);
    await editor.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect(picker).toHaveValue(theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await editor.getByTestId('settings-nav-trade-window').click();
    const highlight = editor.getByRole('switch', { name: '대량 체결 강조', exact: true });
    if (await highlight.getAttribute('aria-checked') === 'true') await highlight.click();
    const amount = editor.getByRole('spinbutton', { name: '기준 금액 (만원)', exact: true });
    const color = editor.getByRole('button', { name: '대량 체결 강조 배경색 선택', exact: true });
    const savedAmount = await amount.inputValue();
    await expect(amount).toBeVisible();
    await expect(amount).toBeDisabled();
    await expect(color).toBeDisabled();
    await highlight.click();
    await expect(amount).toBeEnabled();
    await expect(amount).toHaveValue(savedAmount);
    await expect(color).toBeEnabled();
    for (const width of [1440, 640, 390, 320]) {
      await page.setViewportSize({ width, height: 760 });
      for (const id of ['chart', 'trade-window', 'data-source', 'theme', 'general']) {
        await editor.getByTestId(`settings-nav-${id}`).click();
        await expect(editor.locator(`[data-settings-section="${id}"]`)).toBeInViewport();
        await expect(async () => {
          const overflow = await editor.locator('.settings-editor-main, .settings-editor-content, .settings-property-group-body').evaluateAll(elements =>
            elements.filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.className));
          expect(overflow).toEqual([]);
        }).toPass();
        await expect(editor.locator('.settings-editor-heading')).toBeInViewport();
        await expect(editor.locator('.settings-editor-footer')).toBeInViewport();
      }
      if (width === 320) await editor.screenshot({ path: info.outputPath(`app-settings-${theme}-320.png`) });
    }
  });
}

test('데스크톱의 서버·새 창·배율 조작을 유지한다', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(apiOrigin => {
    const calls: string[] = [];
    Object.assign(window, { desktopCalls: calls });
    let factor = 1;
    window.hogaDesktop = { strictConfig: true, apiOrigin, controls: {
      getState: async () => ({ serverName: '테스트 서버', origin: location.origin, apiOrigin, zoomFactor: factor }),
      selectServer: async () => { calls.push('selectServer'); },
      newWindow: async () => { calls.push('newWindow'); },
      zoom: async command => { calls.push(command); factor = command === 'reset' ? 1 : factor + (command === 'in' ? .1 : -.1); return factor; },
      onZoomChange: () => () => {},
    } };
  }, API_URL);
  const editor = await openSettings(page);
  await editor.getByTestId('settings-nav-desktop').click();
  await expect(editor.getByText('테스트 서버', { exact: true })).toBeVisible();
  await expect(editor.getByText(/서버를 변경하면 기존 작업 창이 닫힙니다/)).toBeVisible();
  await editor.getByRole('button', { name: '서버 선택', exact: true }).click();
  await editor.getByRole('button', { name: '새 작업 창', exact: true }).click();
  const zoom = editor.getByLabel('현재 화면 배율', { exact: true });
  await editor.getByRole('button', { name: '화면 배율 확대', exact: true }).click();
  await expect(zoom).toHaveText('110%');
  await editor.getByRole('button', { name: '화면 배율 축소', exact: true }).click();
  await expect(zoom).toHaveText('100%');
  await editor.getByRole('button', { name: '100% 복원', exact: true }).click();
  expect(await page.evaluate(() => (window as Window & { desktopCalls?: string[] }).desktopCalls)).toEqual(['selectServer', 'newWindow', 'in', 'out', 'reset']);
  await editor.screenshot({ path: info.outputPath('app-settings-desktop.png') });
  await page.setViewportSize({ width: 320, height: 760 });
  await editor.getByTestId('settings-nav-desktop').click();
  await expect(editor.getByRole('button', { name: '화면 배율 확대', exact: true })).toBeInViewport();
  expect(await editor.locator('.settings-editor-content').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await editor.screenshot({ path: info.outputPath('app-settings-desktop-320.png') });
});

test('설정 파일의 내보내기·백업·두 확인 후 가져오기와 새로고침을 유지한다', async ({ page }, info) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('ui.themePreference.v1')) localStorage.setItem('ui.themePreference.v1', JSON.stringify({ themePreference: 'toss-light' }));
  });
  const editor = await openSettings(page);
  await editor.getByTestId('settings-nav-general').click();
  const exported = page.waitForEvent('download');
  await editor.getByRole('button', { name: '화면 설정 내보내기', exact: true }).click();
  const download = await exported;
  const archive = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(archive.format).toBe('hoga-user-settings');
  expect(archive.entries['ui.themePreference.v1']).toBeDefined();
  await editor.getByLabel('화면 설정 파일', { exact: true }).setInputFiles({
    name: 'settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
      format: 'hoga-user-settings', version: 1, origin: 'https://example.com', appVersion: 'test', createdAt: new Date().toISOString(),
      entries: { 'ui.themePreference.v1': { themePreference: 'ledger' } },
    })),
  });
  const apply = editor.getByRole('button', { name: '설정 적용 후 새로고침', exact: true });
  await expect(apply).toBeDisabled();
  await editor.getByRole('checkbox', { name: '이 서버의 다른 작업 창과 탭을 모두 닫았습니다.' }).check();
  await expect(apply).toBeDisabled();
  const backedUp = page.waitForEvent('download');
  await editor.getByRole('button', { name: '현재 설정 백업', exact: true }).click();
  expect((await backedUp).suggestedFilename()).toMatch(/hoga-settings-backup-/);
  await editor.getByRole('checkbox', { name: '백업 파일을 저장했습니다.' }).check();
  await expect(apply).toBeEnabled();
  await page.setViewportSize({ width: 320, height: 760 });
  await apply.scrollIntoViewIfNeeded();
  expect(await editor.locator('.settings-editor-content').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await editor.screenshot({ path: info.outputPath('app-settings-import-320.png') });
  await apply.click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'ledger');
});
