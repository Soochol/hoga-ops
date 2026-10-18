import { expect, test, type Locator, type Page } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { WINDOW_KIND_LABEL } from '../../src/live/workspace/windowKindLabels';

async function resize(page: Page, frame: Locator, width: number) {
  const bounds = (await frame.boundingBox())!;
  const handle = (await frame.locator('[data-handle="e"]').boundingBox())!;
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + width - bounds.width, y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await frame.boundingBox())!.width).toBeCloseTo(width, 0);
}

for (const kind of Object.keys(WINDOW_KIND_LABEL)) {
  test(`${kind}: 제목보다 창 버튼 공간을 우선하고 실제 부족할 때만 접는다`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript(kind => {
      sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
        windows: [{ id: 'actions-test', kind, group: 1, rect: { x: 0, y: 0, w: 0.5, h: 0.6 } }],
        zOrder: ['actions-test'], groupSymbols: { 1: { code: '098460', name: '긴종목이름테스트삼성에스디에스' } },
      }));
    }, kind);
    await installLiveMocks(page);
    await page.goto('/live');
    const frame = page.locator('[data-win="actions-test"]');
    await expect(frame).toBeVisible();
    // The lazy market window initially mounts a separate fallback frame.
    if (kind === 'market-indices') await expect(frame.getByTestId('major-indices-header')).toBeVisible();
    const maximize = frame.getByRole('button', { name: '창 최대화', exact: true });
    const onTop = frame.getByRole('button', { name: '항상 위', exact: true });
    const pin = frame.getByRole('button', { name: '종목 고정', exact: true });
    const menu = frame.getByRole('button', { name: '창 옵션', exact: true });

    for (const width of [420, 280]) {
      await resize(page, frame, width);
      await expect(maximize).toBeVisible();
      await expect(onTop).toBeVisible();
      if (kind !== 'market-indices') await expect(pin).toBeVisible();
      await expect(menu).toBeHidden();
      if (kind === 'trade') await expect(frame.getByRole('button', { name: '체결창 설정', exact: true })).toBeVisible();
      // Text must leave room for all controls, including close, without overlap.
      await expect.poll(() => frame.locator('[data-handle="move"]').evaluate(header => {
        const title = header.querySelector('.live-data-title, .live-symbol-row, .major-indices-header')!;
        const titleBounds = title.getBoundingClientRect();
        const buttons = Array.from(header.querySelectorAll('button')).filter(button => getComputedStyle(button).visibility !== 'hidden');
        const bounds = buttons.map(button => button.getBoundingClientRect()).sort((a, b) => a.left - b.left);
        return titleBounds.width > 0 && bounds.every((box, index) =>
          (index === 0 || box.left >= bounds[index - 1].right - 1)
          && (box.right <= titleBounds.left + 1 || box.left >= titleBounds.right - 1));
      })).toBe(true);
    }
    await frame.screenshot({ path: testInfo.outputPath(`${kind}-280-actions.png`) });
    await onTop.click();
    await expect(onTop).toHaveAttribute('aria-pressed', 'true');
    if (kind !== 'market-indices') {
      await pin.click();
      await expect(pin).toHaveAttribute('aria-pressed', 'true');
    }

    await resize(page, frame, 160);
    await expect(maximize).toBeHidden();
    await expect(onTop).toBeHidden();
    await expect(menu).toBeVisible();
    await menu.click();
    const dialog = page.getByRole('dialog', { name: '창 옵션', exact: true });
    await expect(dialog).toBeVisible();
    await frame.locator('.live-data-title, .live-symbol-row, .major-indices-header').click();
    await expect(dialog).toBeHidden();
    if (kind === 'trade') {
      await menu.click();
      const before = (await frame.boundingBox())!;
      const title = (await frame.locator('.live-data-title').boundingBox())!;
      await page.mouse.move(title.x + title.width / 2, title.y + title.height / 2);
      await page.mouse.down();
      await expect(dialog).toBeHidden();
      await page.mouse.move(title.x + title.width / 2 + 64, title.y + title.height / 2 + 32, { steps: 4 });
      await page.mouse.up();
      await expect.poll(async () => (await frame.boundingBox())!.x).toBeGreaterThan(before.x + 20);
    }
    await menu.click();
    await expect(dialog.getByRole('button', { name: '항상 위', exact: true })).toHaveAttribute('aria-pressed', 'true');
    if (kind !== 'market-indices') {
      await expect(dialog.getByRole('button', { name: '종목 고정', exact: true })).toHaveAttribute('aria-pressed', 'true');
    }
    await dialog.getByRole('button', { name: '창 최대화', exact: true }).click();
    await expect(frame.getByRole('button', { name: '원래 크기로 복원', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeVisible();
    await resize(page, frame, 420);
    await expect(maximize).toBeVisible();
    await expect(onTop).toHaveAttribute('aria-pressed', 'true');
    if (kind !== 'market-indices') await expect(pin).toHaveAttribute('aria-pressed', 'true');
  });
}

test('체결 기본 너비의 설정 버튼과 금액 필터 변경에 따른 액션 접힘', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
    windows: [{ id: 'trade-actions', kind: 'trade', group: 1, rect: { x: 0, y: 0, w: 0.5, h: 0.6 } }],
    zOrder: ['trade-actions'], groupSymbols: { 1: { code: '098460', name: '고영' } },
  })));
  await installLiveMocks(page);
  await page.route('**/api/symbols/all', route => route.fulfill({ json: {
    symbols: [
      { code: '098460', name: '고영', market: 'KOSDAQ' },
      { code: '018260', name: '삼성에스디에스', market: 'KOSPI' },
    ], status: 'fresh', fetched_at_ms: Date.now(), reason: null,
  } }));
  await page.goto('/live');
  const frame = page.locator('[data-win="trade-actions"]');
  await expect(frame).toBeVisible();
  const settings = frame.getByRole('button', { name: '체결창 설정', exact: true });
  const menu = frame.getByRole('button', { name: '창 옵션', exact: true });
  const maximize = frame.getByRole('button', { name: '창 최대화', exact: true });
  const dialog = page.getByRole('dialog', { name: '체결창 설정', exact: true });

  await resize(page, frame, 268);
  await expect(maximize).toBeVisible();
  await expect(settings).toBeVisible();
  await expect(menu).toBeHidden();
  await frame.screenshot({ path: testInfo.outputPath('trade-default-268.png') });
  await settings.click();
  await expect(dialog).toBeVisible();
  await frame.locator('.live-data-title').click();
  await expect(dialog).toBeHidden();
  await settings.click();
  await dialog.getByRole('button', { name: '1천만', exact: true }).click();
  await expect(frame.getByLabel('체결금액 1,000만원 이상 표시')).toBeVisible();
  await expect(maximize).toBeHidden();
  await expect(menu).toBeFocused();
  await menu.click();
  await page.getByRole('dialog', { name: '창 옵션', exact: true }).getByRole('button', { name: '설정', exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();

  // The short title fits in less than the long-name allowance, even with the filter badge.
  await resize(page, frame, 330);
  await expect(maximize).toBeVisible();
  await expect(settings).toBeVisible();
  await expect(menu).toBeHidden();
  await expect.poll(() => frame.locator('.live-symbol-name').evaluate(name => name.clientWidth >= name.scrollWidth)).toBe(true);
  await frame.screenshot({ path: testInfo.outputPath('trade-filter-330.png') });
  for (const name of ['삼성에스디에스', '고영']) {
    await page.getByRole('button', { name: '종목 검색 열기' }).click();
    const search = page.getByRole('dialog', { name: '종목 검색', exact: true });
    await search.getByRole('combobox', { name: '종목 검색', exact: true }).fill(name);
    await search.getByRole('option').first().click();
    await expect(frame.locator('.live-symbol-name')).toHaveText(name);
    if (name === '고영') await expect(settings).toBeVisible();
    else await expect(menu).toBeVisible();
  }
  await settings.click();
  await dialog.getByRole('textbox', { name: '최소 금액 직접 입력' }).fill('999999');
  await dialog.getByRole('button', { name: '적용', exact: true }).click();
  await expect(frame.getByLabel('체결금액 999,999만원 이상 표시')).toBeVisible();
  await expect(menu).toBeVisible();
  await expect(maximize).toBeHidden();
  await resize(page, frame, 420);
  await expect(settings).toBeVisible();
  await settings.click();
  await dialog.getByRole('button', { name: '전체', exact: true }).click();
  await expect(frame.getByLabel('체결금액 999,999만원 이상 표시')).toBeHidden();
  await resize(page, frame, 268);
  await expect(maximize).toBeVisible();
  await expect(settings).toBeVisible();
  await expect(menu).toBeHidden();
});
