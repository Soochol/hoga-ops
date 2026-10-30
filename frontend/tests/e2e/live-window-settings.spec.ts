import { expect, test } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

for (const [kind, title] of [['chart', '차트 설정'], ['order', '주문 설정'], ['trade', '체결창 설정'], ['market-indices', '주요 지수 설정']] as const) {
  test(`${title}: 공통 24px 속성표와 좁은 화면의 고정 헤더·푸터`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1100, height: 760 });
    await page.addInitScript(kind => sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
      windows: [{ id: 'settings-test', kind, group: 1, rect: { x: 0, y: 0, w: 0.6, h: 0.85 } }],
      zOrder: ['settings-test'], groupSymbols: { 1: { code: '098460', name: '고영' } },
    })), kind);
    await installLiveMocks(page);
    await page.goto('/live');
    const trigger = page.locator('[data-win="settings-test"]').getByRole('button', { name: title, exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: title, exact: true });
    await expect(dialog.locator('.window-settings-heading')).toHaveCSS('min-height', '36px');
    await expect(dialog.locator('.window-settings-footer')).toHaveCSS('min-height', '28px');
    const body = dialog.locator('.window-settings-body');
    await expect(dialog.locator('.window-settings-group').first()).toHaveCSS('display', 'grid');
    if (kind !== 'trade') await expect(dialog.locator('.settings-row').first()).toHaveCSS('min-height', '24px');

    if (kind === 'chart') {
      const log = dialog.getByRole('switch', { name: '로그 스케일', exact: true });
      // The label is a full-height native label; one click must toggle only once.
      await dialog.locator('label').filter({ hasText: /^로그 스케일$/ }).click();
      await expect(log).toHaveAttribute('aria-checked', 'true');
      await dialog.getByRole('button', { name: '되돌리기', exact: true }).click();
      await expect(log).toHaveAttribute('aria-checked', 'false');
      await dialog.getByRole('button', { name: '고저 극값 라벨 세부 설정' }).click();
      await dialog.getByRole('checkbox', { name: '고가 가격선', exact: true }).check();
      await dialog.getByRole('combobox', { name: '고가 가격선 두께' }).selectOption('3');
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('hoga.window.settings.v1')!).byWindow['settings-test'].chart.highLowHighLineWidth)).toBe(3);
    }
    for (const theme of ['toss-light', 'trading-desk']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await dialog.screenshot({ path: testInfo.outputPath(`${kind}-${theme}.png`) });
    }
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await page.setViewportSize({ width: 320, height: 360 });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.window-settings-heading')).toBeInViewport();
    await expect(dialog.locator('.window-settings-footer')).toBeInViewport();
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    expect(box.y + box.height).toBeLessThanOrEqual(360);
    expect(await body.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    if (kind === 'chart' || kind === 'order') {
      const last = dialog.getByRole('switch').last();
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeInViewport();
      await expect(dialog.locator('.window-settings-footer')).toBeInViewport();
    }
    await dialog.screenshot({ path: testInfo.outputPath(`${kind}-compact-320.png`) });
    await dialog.getByRole('button', { name: `${title} 닫기`, exact: true }).click();
    await expect(trigger).toBeFocused();
  });
}
