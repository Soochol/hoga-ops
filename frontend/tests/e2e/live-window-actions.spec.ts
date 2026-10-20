import { expect, test, type Locator, type Page } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { WINDOW_KIND_LABEL } from '../../src/live/workspace/windowKindLabels';
import { CHART_DISPLAY_TOGGLES } from '../../src/state/chartDisplayPrefs';

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

async function expectHeaderFits(frame: Locator) {
  await expect.poll(() => frame.locator('[data-handle="move"]').evaluate(header => {
    const title = header.querySelector('.live-data-title, .live-symbol-row, .major-indices-header')!;
    const titleBounds = title.getBoundingClientRect();
    const headerBounds = header.getBoundingClientRect();
    const actions = header.querySelector('.live-window-direct-actions')!.getBoundingClientRect();
    const close = header.lastElementChild!.getBoundingClientRect();
    const buttons = Array.from(header.querySelectorAll('button')).filter(button => button.getBoundingClientRect().width > 0);
    const bounds = buttons.map(button => button.getBoundingClientRect()).sort((a, b) => a.left - b.left);
    return close.left - actions.right <= 4.1 && bounds.every((box, index) => box.width >= 20 && box.left >= headerBounds.left && box.right <= headerBounds.right
      && (index === 0 || box.left >= bounds[index - 1].right - 1)
      && (box.right <= titleBounds.left + 1 || box.left >= titleBounds.right - 1))
      && buttons.every(button => {
        const box = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      });
  })).toBe(true);
}

for (const kind of Object.keys(WINDOW_KIND_LABEL)) {
  test(`${kind}: 최소 폭까지 제목보다 창 조작 아이콘을 우선한다`, async ({ page }, testInfo) => {
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
    if (kind === 'market-indices') await expect(frame.getByTestId('major-indices-header')).toBeVisible();
    const maximize = frame.getByRole('button', { name: '창 최대화', exact: true });
    const onTop = frame.getByRole('button', { name: '항상 위', exact: true });
    const pin = frame.getByRole('button', { name: '종목 고정', exact: true });
    for (const width of [420, 280, 200, 160]) {
      await resize(page, frame, width);
      await expect(maximize).toBeVisible();
      await expect(onTop).toBeVisible();
      if (kind !== 'market-indices') await expect(pin).toBeVisible();
      await expect(frame.getByRole('button', { name: '창 옵션', exact: true })).toHaveCount(0);
      if (kind === 'trade' || kind === 'chart' || kind === 'order') {
        const settings = frame.getByRole('button', { name: kind === 'trade' ? '체결창 설정' : kind === 'order' ? '주문 설정' : '차트 설정', exact: true });
        await expect(settings).toBeVisible();
        const settingsBounds = (await settings.boundingBox())!;
        const maximizeBounds = (await maximize.boundingBox())!;
        expect(settingsBounds.x + settingsBounds.width).toBeLessThanOrEqual(maximizeBounds.x);
      }
      await expectHeaderFits(frame);
      if (width === 160) await expect(frame.locator('.live-data-title, .live-symbol-row, .major-indices-header')).toBeHidden();
    }
    await frame.screenshot({ path: testInfo.outputPath(`${kind}-160-actions.png`) });
    await onTop.click();
    await expect(onTop).toHaveAttribute('aria-pressed', 'true');
    if (kind !== 'market-indices') {
      await pin.click();
      await expect(pin).toHaveAttribute('aria-pressed', 'true');
    }
    await maximize.click();
    await expect(frame.getByRole('button', { name: '원래 크기로 복원', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(maximize).toBeVisible();
    await expectHeaderFits(frame);
    await resize(page, frame, 420);
    await expect(onTop).toHaveAttribute('aria-pressed', 'true');
    if (kind !== 'market-indices') await expect(pin).toHaveAttribute('aria-pressed', 'true');
  });
}

test('체결 설정과 긴 금액 필터도 제목보다 아이콘 공간을 우선한다', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
    windows: [{ id: 'trade-actions', kind: 'trade', group: 1, rect: { x: 0, y: 0, w: 0.5, h: 0.6 } }],
    zOrder: ['trade-actions'], groupSymbols: { 1: { code: '098460', name: '고영' } },
  })));
  await installLiveMocks(page);
  await page.goto('/live');
  const frame = page.locator('[data-win="trade-actions"]');
  const settings = frame.getByRole('button', { name: '체결창 설정', exact: true });
  const dialog = page.getByRole('dialog', { name: '체결창 설정', exact: true });
  await resize(page, frame, 268);
  await settings.click();
  await dialog.getByRole('button', { name: '1천만', exact: true }).click();
  await expect(frame.getByLabel('체결금액 1,000만원 이상 표시')).toBeVisible();
  await expect(settings).toBeFocused();
  await expectHeaderFits(frame);
  await settings.click();
  await dialog.getByRole('textbox', { name: '최소 금액 직접 입력' }).fill('999999');
  await dialog.getByRole('button', { name: '적용', exact: true }).click();
  for (const width of [330, 268, 160]) {
    await resize(page, frame, width);
    await expectHeaderFits(frame);
    await expect(settings).toBeVisible();
  }
  await frame.screenshot({ path: testInfo.outputPath('trade-filter-160.png') });
  await settings.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings).toBeFocused();
  await resize(page, frame, 420);
  await settings.click();
  const title = (await frame.locator('.live-data-title').boundingBox())!;
  const before = (await frame.boundingBox())!;
  await page.mouse.move(title.x + title.width / 2, title.y + title.height / 2);
  await page.mouse.down();
  await expect(dialog).toBeHidden();
  await page.mouse.move(title.x + title.width / 2 + 64, title.y + title.height / 2 + 32, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await frame.boundingBox())!.x).toBeGreaterThan(before.x + 20);
});

test('차트 헤더의 축 상태는 설정을 열고 최소 폭에서도 설정 버튼으로 확인된다', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
    windows: [{ id: 'scale-status', kind: 'chart', group: 1, rect: { x: 0, y: 0, w: 0.5, h: 0.6 } }],
    zOrder: ['scale-status'], groupSymbols: { 1: { code: '098460', name: '긴종목이름테스트삼성에스디에스' } },
  })));
  await installLiveMocks(page);
  await page.goto('/live');
  const frame = page.locator('[data-win="scale-status"]');
  const header = frame.locator('.live-window-titlebar');
  const settings = header.getByRole('button', { name: '차트 설정', exact: true });
  const badge = header.locator('.live-chart-scale-status');
  const dialog = page.getByRole('dialog', { name: '차트 설정', exact: true });
  await expect(badge).toHaveCount(0);
  await settings.click();
  await dialog.getByRole('switch', { name: '로그 스케일', exact: true }).click();
  await dialog.getByRole('switch', { name: '차트 거꾸로 보기', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(badge).toHaveText('로그반전');
  const before = await frame.boundingBox();
  await badge.click();
  await expect(dialog).toBeVisible();
  expect(await frame.boundingBox()).toEqual(before);
  await page.keyboard.press('Escape');
  for (const width of [420, 280, 240, 200, 160]) {
    await resize(page, frame, width);
    if (width > 240) await expect(badge).toBeVisible();
    else await expect(badge).toBeHidden();
    await expect(settings).toBeVisible();
    await expect(settings).toHaveAttribute('title', '차트 설정 · 로그 스케일 켜짐 · 가격축 반전 켜짐 · 캔들/거래량 색상 교환 켜짐');
    await expectHeaderFits(frame);
    if (width === 420 || width === 160) await frame.screenshot({ path: testInfo.outputPath(`scale-status-${width}.png`) });
  }
  await settings.click();
  await expect(dialog.getByRole('switch', { name: '로그 스케일', exact: true })).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('switch', { name: '로그 스케일', exact: true }).click();
  await page.keyboard.press('Escape');
  await resize(page, frame, 420);
  await expect(badge).toHaveText('반전');
  await settings.click();
  await dialog.getByRole('switch', { name: '차트 거꾸로 보기', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(badge).toHaveCount(0);
  await expect(settings).toHaveAttribute('title', '차트 설정');
});

test('차트 설정은 제목줄에서 열리고 각 창에 독립적으로 저장된다', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.addInitScript(() => {
    localStorage.removeItem('hoga.chart.prefs.v1');
    sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
      windows: ['chart-a', 'chart-b'].map((id, i) => ({ id, kind: 'chart', group: 1,
        rect: { x: i * 0.5, y: 0, w: 0.48, h: 0.9 } })),
      zOrder: ['chart-a', 'chart-b'], groupSymbols: { 1: { code: '098460', name: '고영' } },
    }));
  });
  await installLiveMocks(page);
  await page.goto('/live');
  const a = page.locator('[data-win="chart-a"]');
  const b = page.locator('[data-win="chart-b"]');
  const settings = a.getByRole('button', { name: '차트 설정', exact: true });
  const dialog = page.getByRole('dialog', { name: '차트 설정', exact: true });
  await settings.click();
  await expect(dialog.getByText('이 차트에 적용')).toBeVisible();
  await expect(dialog.getByRole('switch', { includeHidden: true })).toHaveCount(CHART_DISPLAY_TOGGLES.length);
  const scale = dialog.getByRole('switch', { name: '캔들 기준 Y축', exact: true });
  await expect(scale).toHaveAttribute('aria-checked', 'false');
  await scale.click();
  await expect(scale).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('button', { name: '되돌리기', exact: true }).click();
  await expect(scale).toHaveAttribute('aria-checked', 'false');
  await scale.click();
  await page.keyboard.press('Escape');
  await expect(settings).toBeFocused();
  await b.getByRole('button', { name: '차트 설정', exact: true }).click();
  await expect(scale).toHaveAttribute('aria-checked', 'false');
  await expect(dialog.getByRole('button', { name: '되돌리기', exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('chart-titlebar-settings.png') });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('hoga.window.settings.v1') ?? '{}').byWindow?.['chart-a']?.chart?.candlePaneCandleOnlyScale)).toBe(true);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 620, height: 420 });
  await a.getByRole('button', { name: '차트 설정', exact: true }).click();
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(620);
  expect(box.y + box.height).toBeLessThanOrEqual(420);
  await expect(dialog.getByRole('button', { name: '되돌리기', exact: true })).toBeVisible();
});
