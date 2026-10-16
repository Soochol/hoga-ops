import { test, expect, type Page } from '@playwright/test';

async function mount(page: Page) {
  await page.route(url => url.pathname === '/', route => route.fulfill({ contentType: 'text/html',
    body: '<html><body style="margin:0"><script>window.$RefreshSig$=()=>type=>type;window.$RefreshReg$=()=>{};window.__vite_plugin_react_preamble_installed=true;</script></body></html>',
  }));
  await page.goto('/');
  await page.evaluate(async () => {
    const path = '/tests/e2e/helpers/notificationHarness.tsx';
    const { mount } = await import(path);
    mount();
    await document.fonts.ready;
  });
}

for (const theme of ['obsidian', 'ledger', 'toss-light', 'toss-dark']) {
  test(`shared notices fit a narrow viewport in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 360, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mount(page);
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const partial = page.getByRole('status', { name: '부분 성공 알림' });
    await expect(partial).toBeVisible();
    for (const action of [partial.getByRole('button'), page.getByRole('button', { name: '실행 취소', exact: true })]) {
      const box = (await action.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(360);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    const notices = page.getByRole('alert');
    const border = await notices.first().evaluate(el => getComputedStyle(el).borderColor);
    expect(await notices.last().evaluate(el => getComputedStyle(el).borderColor)).toBe(border);
    await page.screenshot({ path: info.outputPath(`notices-${theme}.png`), fullPage: true });
  });
}

test('pointer and keyboard pause the same dismissal clock; undo remains usable', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-17T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-17T00:00:01Z'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mount(page);
  const toast = page.getByRole('status', { name: '실행 취소 알림' });
  const progress = toast.locator('.toast-progress');
  await page.clock.runFor(2000);
  await toast.hover();
  await expect(progress).toHaveCSS('animation-play-state', 'paused');
  await page.clock.runFor(10000);
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: '실행 취소', exact: true }).focus();
  await page.mouse.move(1, 1);
  await page.clock.runFor(10000);
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect(page.getByText('그림을 복원했습니다')).toBeVisible();
  await expect(toast).toBeHidden();
  await page.getByRole('button', { name: '알림 표시', exact: true }).click();
  // Reappearing content can land under the pointer as the trigger moves down.
  await page.mouse.move(1, 1);
  await expect(progress).toHaveCSS('animation-play-state', 'running');
  await page.clock.runFor(4999);
  await expect(toast).toBeVisible();
  await page.clock.runFor(1);
  await expect(toast).toBeHidden();
});
