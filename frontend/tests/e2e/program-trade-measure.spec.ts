import { expect, test } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

test('프로그램 금액·수량은 두 조회에서 공유되고 좁은 창과 새로고침에서도 유지된다', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await installLiveMocks(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let requests = 0;
  await page.route('**/api/live/daily-program-trade?**', async route => {
    requests++;
    const params = new URL(route.request().url()).searchParams;
    const to = params.get('to')!;
    const t = Date.parse(`${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6)}T00:00:00Z`);
    await route.fulfill({ json: {
      code: params.get('code'), from: params.get('from'), to,
      points: [0, 1].map(i => ({ t_ms: t - i * 86400000,
        net_qty: -1000, buy_qty: 2000, sell_qty: 3000,
        net_amount: -100_000_000, buy_amount: 200_000_000, sell_amount: 300_000_000 })),
      cached_batches: [], fresh_batches: [], data_warnings: [],
    } });
  });
  await page.goto('/live?code=098460');
  await page.getByTestId('workspace-add-menu-button').click();
  await page.getByTestId('workspace-add-program').click();
  const frame = page.locator('.live-window-program');
  await expect(frame.getByRole('button', { name: '금액', exact: true })).toBeVisible();
  await frame.getByRole('button', { name: '일별', exact: true }).click();
  const rows = frame.getByTestId(/^program-daily-row-/);
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('-1·2·3');
  await expect(frame.getByText('단위: 억원', { exact: true })).toBeVisible();
  const count = requests;
  await frame.getByRole('button', { name: '수량', exact: true }).click();
  await expect(rows.first()).toContainText('−1·2·3');
  await expect(frame.getByText('단위: 천 주', { exact: true })).toBeVisible();
  await frame.getByRole('button', { name: '당일 누적', exact: true }).click();
  await expect(frame.getByRole('button', { name: '수량', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await frame.getByRole('button', { name: '금액', exact: true }).click();
  await frame.getByRole('button', { name: '일별', exact: true }).click();
  await expect(rows.first()).toContainText('-1·2·3');
  await expect(frame.getByText('단위: 억원', { exact: true })).toBeVisible();
  expect(requests).toBe(count);

  // Resize with the same handles as users; primary controls must stay outside the popover.
  const bounds = (await frame.boundingBox())!;
  const handle = (await frame.locator('[data-handle="e"]').boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 300 - bounds.width, handle.y + handle.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await frame.boundingBox())!.width).toBeCloseTo(300, 0);
  await expect(frame.getByRole('button', { name: '일별', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(frame.getByRole('button', { name: '금액', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(frame.getByRole('button', { name: '수량', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(frame.getByRole('button', { name: '표시 설정', exact: true })).toBeVisible();
  const unit = frame.getByText('단위: 억원', { exact: true });
  await expect(unit).toBeInViewport();
  await expect.poll(async () => {
    const label = (await unit.boundingBox())!;
    const button = (await frame.getByRole('button', { name: '금액', exact: true }).boundingBox())!;
    return Math.abs(label.y + label.height / 2 - button.y - button.height / 2);
  }).toBeLessThan(2);
  await frame.screenshot({ path: testInfo.outputPath('program-daily-amount-300px.png') });
  await frame.getByRole('button', { name: '표시 설정', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '표시 설정', exact: true });
  await expect(settings.getByRole('button', { name: 'K 단위', exact: true })).toHaveCount(0);
  await settings.getByRole('button', { name: '총매수', exact: true }).click();
  await settings.getByRole('button', { name: '표시 설정 닫기', exact: true }).click();
  await expect(rows.first().getByRole('cell')).toHaveText('2');
  await frame.getByRole('button', { name: '수량', exact: true }).click();
  await expect(rows.first().getByRole('cell')).toHaveText('2');
  await page.reload();
  await expect(frame.getByRole('button', { name: '일별', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(frame.getByRole('button', { name: '수량', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(rows.first().getByRole('cell')).toHaveText('2');
  expect(errors).toEqual([]);
});
