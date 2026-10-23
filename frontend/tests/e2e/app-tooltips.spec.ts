import { expect, test } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

test.beforeEach(async ({ page }) => {
  await installLiveMocks(page);
  await page.routeWebSocket(/\/api\/ws/, () => {});
});

test('all feature routes use the shared text hint and leave native titles absent', async ({ page }, info) => {
  test.setTimeout(60_000);
  for (const route of ['live', 'heatmap', 'market', 'screener', 'sentiment', 'inventory', 'capture']) {
    await page.goto(`/${route}`);
    const home = page.getByRole('link', { name: 'Ticklane 홈' });
    await expect(home).toBeVisible();
    await expect(page.locator('[title]')).toHaveCount(0);
    await home.hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toHaveText('홈으로 이동');
    await expect(tooltip).toHaveClass(/tooltip-surface/);
    await expect(tooltip).toHaveCSS('font-size', '11.5px');
    await expect(tooltip).toHaveCSS('padding', '6px 10px');
    await expect(tooltip).toHaveCSS('border-radius', '6px');
    await expect(home).toHaveAttribute('aria-describedby', await tooltip.getAttribute('id') as string);
    if (route === 'market') await page.screenshot({ path: info.outputPath('app-shared-tooltip.png') });
    await page.keyboard.press('Escape');
    await expect(tooltip).toHaveCount(0);
    await page.mouse.move(0, 0);
  }
});

test('shared hints follow all seven palettes and support keyboard focus', async ({ page }, info) => {
  await page.goto('/live');
  const home = page.getByRole('link', { name: 'Ticklane 홈' });
  const tooltip = page.getByRole('tooltip');
  const backgrounds = new Set<string>();
  for (const theme of ['trading-desk', 'obsidian', 'ledger', 'toss-light', 'toss-dark', 'obsidian-pro', 'ledger-studio']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await home.hover();
    await expect(tooltip).toHaveText('홈으로 이동');
    await expect(tooltip).toHaveCSS('font-size', '11.5px');
    const style = await tooltip.evaluate(el => {
      const computed = getComputedStyle(el);
      return { background: computed.backgroundColor, text: computed.color, shadow: computed.boxShadow };
    });
    expect(style.text).not.toBe(style.background);
    expect(style.shadow).not.toBe('none');
    backgrounds.add(style.background);
    if (theme === 'ledger-studio') await page.screenshot({ path: info.outputPath('app-shared-tooltip-light.png') });
    await page.mouse.move(0, 0);
    await expect(tooltip).toHaveCount(0);
  }
  expect(backgrounds.size).toBeGreaterThanOrEqual(6);
  await home.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(home).toBeFocused();
  await expect(tooltip).toHaveText('홈으로 이동');
  await page.keyboard.press('Escape');
  await expect(tooltip).toHaveCount(0);
  await expect(page.locator('.live-window-titlebar [data-tooltip]')).toHaveCount(0);
});
