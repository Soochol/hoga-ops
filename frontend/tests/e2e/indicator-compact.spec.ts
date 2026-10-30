import { expect, test } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

for (const theme of ['toss-light', 'trading-desk']) {
  test(`${theme}: 보조지표의 공통 토글·설명 접기·기존 구조와 반응형 편집`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript(theme => localStorage.setItem('ui.themePreference.v1', JSON.stringify({ themePreference: theme })), theme);
    await installLiveMocks(page);
    await page.goto('/live?code=098460');
    await page.getByTestId('live-indicators-button').click();
    const editor = page.getByTestId('indicator-panel-shell');
    await expect(editor.getByRole('navigation', { name: '내 지표', exact: true })).toBeVisible();
    await expect(editor.locator('.settings-editor-description')).toHaveCount(0);
    await expect(editor.getByTestId('indicator-style-preview').getByText('예시', { exact: true })).toBeVisible();
    await expect(editor.getByRole('status')).toContainText('즉시 반영');
    const ma = editor.getByRole('switch', { name: '기간1 표시', exact: true });
    await expect(ma).toHaveCSS('width', '26px');
    await expect(ma).toHaveCSS('height', '15px');
    await expect(editor.locator('.ma-config-row').first()).toHaveCSS('min-height', '24px');
    const before = await ma.getAttribute('aria-checked');
    await editor.locator('label.ma-config-visibility').first().click();
    await expect(ma).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true');
    await editor.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect(ma).toHaveAttribute('aria-checked', before!);
    await ma.focus(); await ma.press('Space');
    await expect(ma).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true');
    await editor.getByRole('button', { name: '되돌리기', exact: true }).click();
    await editor.getByRole('button', { name: '이동평균선 설명' }).click();
    await expect(editor.locator('.settings-editor-description')).toContainText('평균 가격');
    await editor.getByRole('button', { name: '이동평균선 설명' }).click();
    await editor.screenshot({ path: testInfo.outputPath(`indicator-simple-${theme}.png`) });

    await editor.getByRole('button', { name: '지표 추가', exact: true }).click();
    const names = await editor.locator('.indicator-nav-row > button:first-child').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')!));
    expect(names.length).toBeGreaterThan(15);
    for (const name of names) {
      await editor.getByRole('button', { name, exact: true }).click();
      await expect(editor.locator('.settings-editor-description')).toHaveCount(0);
      expect(await editor.getByRole('switch').evaluateAll(buttons => buttons.every(button => {
        const style = getComputedStyle(button);
        return button.classList.contains('window-settings-switch') && style.width === '26px' && style.height === '15px';
      }))).toBe(true);
    }
    await editor.getByRole('button', { name: '거래량', exact: true }).click();
    await expect(editor.getByText('해당 캔들의 양봉·음봉 색상으로 표시합니다.', { exact: true })).toHaveCount(0);
    await editor.getByRole('button', { name: '거래량 설명' }).click();
    await expect(editor.getByText('해당 캔들의 양봉·음봉 색상으로 표시합니다.', { exact: true })).toBeVisible();
    await expect(editor.getByRole('radio')).toHaveCount(2);

    for (const width of [640, 390, 320]) {
      await page.setViewportSize({ width, height: 760 });
      for (const name of ['이동평균선', '볼린저 밴드', '총잔량']) {
        await editor.getByRole('button', { name, exact: true }).click();
        await expect(async () => {
          expect(await editor.locator('.settings-editor-main').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
          expect(await editor.locator('.indicator-config').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        }).toPass();
        await expect(editor.locator('.settings-editor-footer')).toBeInViewport();
      }
      await editor.screenshot({ path: testInfo.outputPath(`indicator-simple-${theme}-${width}.png`) });
    }
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('.live-window-chart').first().getByRole('button', { name: '차트 설정', exact: true }).click();
    const chartToggle = page.getByRole('dialog', { name: '차트 설정', exact: true }).getByRole('switch').first();
    await expect(chartToggle).toHaveCSS('width', '26px');
    await expect(chartToggle).toHaveCSS('height', '15px');
  });
}
