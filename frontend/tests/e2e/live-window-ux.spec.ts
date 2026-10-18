import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

test('창 최대화·Escape 복원은 원래 배치를 보존한다', async ({ page }) => {
  await installLiveMocks(page);
  await page.goto('/live');
  const win = page.locator('[data-win]').first();
  await expect(win).toBeVisible();
  // Wait for toolbar mounting and the canvas ResizeObserver before measuring.
  // Operational failures now use the service status panel instead of a banner.
  await expect(page.getByTestId('workspace-live-toolbar')).toBeVisible();
  await expect.poll(() => win.evaluate((el) => Math.abs(
    el.getBoundingClientRect().height - el.parentElement!.getBoundingClientRect().height,
  ))).toBeLessThan(1);
  const before = await win.boundingBox();
  await win.getByRole('button', { name: '창 최대화', exact: true }).click();
  await expect(win.getByRole('button', { name: '원래 크기로 복원' })).toBeVisible();
  await expect.poll(async () => (await win.boundingBox())!.width).toBeGreaterThan(before!.width);
  // 확장된 rect를 이동/스냅 엔진에 저장하지 않도록 리사이즈 핸들도 비활성화한다.
  await expect(win.locator('[data-handle="e"]')).toHaveCount(0);
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: '설정', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(win.getByRole('button', { name: '원래 크기로 복원' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(win.getByRole('button', { name: '창 최대화', exact: true })).toBeVisible();
  const restored = await win.boundingBox();
  expect(restored!.x).toBeCloseTo(before!.x, 0);
  expect(restored!.y).toBeCloseTo(before!.y, 0);
  expect(restored!.width).toBeCloseTo(before!.width, 0);
  expect(restored!.height).toBeCloseTo(before!.height, 0);
});

test('좁은 작업 영역에 추가한 잠정투자자 창도 숫자에 필요한 기본 너비를 확보한다', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installLiveMocks(page);
  await page.route('**/api/live/investor-trend-estimate?**', async route => {
    await route.fulfill({ json: {
      code: '098460', trading_day: '20261018', fetched_at_ms: Date.now(), source: 'kiwoom', status: 'ok',
      data_warning: null, latest: null, rows: [{
        slot: '1', observed_at_ms: Date.now(), foreign_qty: 1500, institution_qty: -200, sum_qty: 1300,
        foreign_amt_mwon: 360, institution_amt_mwon: -48, sum_amt_mwon: 312,
      }],
    } });
  });
  await page.goto('/live?code=098460');
  await page.getByTestId('workspace-add-menu-button').click();
  await page.getByTestId('workspace-add-investor').click();
  const added = page.locator('[data-win]').last();
  await expect(added).toBeVisible();
  await expect.poll(async () => (await added.boundingBox())!.width).toBeCloseTo(400, 0);
  const rect = (await added.boundingBox())!;
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(1280);
  await expect(added.getByText('단위: 주', { exact: true })).toBeVisible();
  await added.getByRole('button', { name: '금액(억원)', exact: true }).click();
  const unit = added.getByText('단위: 억원', { exact: true });
  await expect(unit).toBeInViewport();
  await expect(added.getByRole('table')).toContainText('+3.6');
  await expect(added.getByRole('table')).not.toContainText('억');
  await expect.poll(async () => {
    const label = (await unit.boundingBox())!;
    const button = (await added.getByRole('button', { name: '금액(억원)', exact: true }).boundingBox())!;
    return Math.abs(label.y + label.height / 2 - button.y - button.height / 2);
  }).toBeLessThan(2);
  await added.screenshot({ path: testInfo.outputPath('investor-amount-unit.png') });
});
