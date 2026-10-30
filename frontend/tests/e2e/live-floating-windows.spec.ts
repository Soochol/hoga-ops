import { expect, test, type Page } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { WINDOW_KIND_LABEL } from '../../src/live/workspace/windowKindLabels';
const WINDOW_KINDS = Object.keys(WINDOW_KIND_LABEL);

async function seed(page: Page, kind: string) {
  await page.addInitScript(kind => sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
    windows: [
      { id: 'source', kind, group: 1, rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.6 },
        ...(kind === 'chart' ? { chart: { timeframe: 'D' } } : {}) },
      { id: 'sibling', kind: kind === 'chart' ? 'book' : 'chart', group: 1, rect: { x: 0.55, y: 0.1, w: 0.4, h: 0.6 } },
    ], zOrder: ['sibling', 'source'], groupSymbols: { 1: { code: '098460', name: '고영' } },
  })), kind);
}

for (const [index, kind] of WINDOW_KINDS.entries()) {
  test(`${kind}: 분리·크기 변경·닫기 후 원래 배치로 복귀한다`, async ({ page, context }, info) => {
    await installLiveMocks(context);
    await page.setViewportSize({ width: 1280, height: 850 });
    await seed(page, kind);
    await page.goto('/live');
    const frame = page.locator('[data-win="source"]');
    await expect(frame.getByRole('button', { name: '창 분리', exact: true })).toBeVisible();
    if (kind === 'market-indices') await expect(frame.getByTestId('major-indices-chart')).toBeVisible();
    const before = (await frame.boundingBox())!;
    const popupEvent = page.waitForEvent('popup');
    await frame.getByRole('button', { name: '창 분리', exact: true }).click();
    const popup = await popupEvent;
    await expect(popup.getByTestId('floating-workspace')).toBeVisible();
    await expect(frame).toHaveCount(0);
    await expect(popup.locator('[data-win]')).toHaveCount(1);
    await expect(popup.getByRole('navigation')).toHaveCount(0);
    await expect(popup.getByTestId('workspace-live-toolbar')).toHaveCount(0);
    await expect(popup.getByRole('button', { name: '항상 위', exact: true })).toBeDisabled();
    await popup.setViewportSize({ width: 330, height: 280 });
    await expect.poll(() => popup.locator('[data-win="source"]').evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(330);
    await expect.poll(() => popup.locator('.live-window-titlebar').evaluate(header =>
      Array.from(header.querySelectorAll('button')).every(button => {
        const bounds = button.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= window.innerWidth;
      }),
    )).toBe(true);
    await popup.screenshot({ path: info.outputPath(`${kind}-floating.png`) });
    const closed = popup.waitForEvent('close');
    if (index % 3 === 0) await popup.close();
    else if (index % 3 === 1) await popup.getByRole('button', { name: /창 닫기$/ }).click();
    else await popup.getByRole('button', { name: '원래 화면에 합치기', exact: true }).click();
    await closed;
    await expect(frame).toBeVisible();
    const restored = (await frame.boundingBox())!;
    for (const key of ['x', 'y', 'width', 'height'] as const) expect(restored[key]).toBeCloseTo(before[key], 0);
    await expect(page.getByRole('alert').filter({ hasText: '독립 창을 열지 못했습니다' })).toHaveCount(0);
  });
}

test('링크 종목·창 설정·봉 주기 변경은 분리/합치기 뒤에도 유지한다', async ({ page, context }) => {
  await installLiveMocks(context);
  await seed(page, 'chart');
  await page.goto('/live');
  const frame = page.locator('[data-win="source"]');
  const popupEvent = page.waitForEvent('popup');
  await frame.getByRole('button', { name: '창 분리', exact: true }).click();
  const popup = await popupEvent;
  await expect(popup.getByTestId('floating-workspace')).toBeVisible();
  await popup.getByRole('button', { name: '차트 설정', exact: true }).click();
  await popup.getByRole('switch', { name: '로그 스케일', exact: true }).click();
  await popup.keyboard.press('Escape');
  await popup.getByRole('button', { name: '주', exact: true }).click();
  await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore } = await import(path);
    useWorkspaceStore.getState().setGroupSymbol(1, { code: '005930', name: '삼성전자' });
  });
  await expect(popup.locator('.live-symbol-name')).toHaveText('삼성전자');
  await expect(page.locator('[data-win="sibling"] .live-symbol-name')).toHaveText('삼성전자');
  await popup.getByRole('button', { name: '원래 화면에 합치기', exact: true }).click();
  await expect(frame).toBeVisible();
  await expect(frame.getByRole('button', { name: '주', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await frame.getByRole('button', { name: '차트 설정', exact: true }).click();
  await expect(page.getByRole('switch', { name: '로그 스케일', exact: true })).toHaveAttribute('aria-checked', 'true');
});

test('팝업 차단은 원래 창과 저장 배치를 유지하고 재시도를 허용한다', async ({ page, context }) => {
  await installLiveMocks(context);
  await seed(page, 'book');
  await page.goto('/live');
  await page.evaluate(() => { window.open = () => null; });
  const frame = page.locator('[data-win="source"]');
  const before = await frame.boundingBox();
  await frame.getByRole('button', { name: '창 분리', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '팝업을 허용' })).toBeVisible();
  expect(await frame.boundingBox()).toEqual(before);
  await expect(frame).toBeVisible();
});

test('본창을 새로고침하면 분리 창을 닫고 원래 배치를 복구한다', async ({ page, context }) => {
  await installLiveMocks(context);
  await seed(page, 'book');
  await page.goto('/live');
  const frame = page.locator('[data-win="source"]');
  const popupEvent = page.waitForEvent('popup');
  await frame.getByRole('button', { name: '창 분리', exact: true }).click();
  const popup = await popupEvent;
  await expect(popup.getByTestId('floating-workspace')).toBeVisible();
  const closed = popup.waitForEvent('close');
  await page.reload();
  await closed;
  await expect(frame).toBeVisible();
});

test('두 창을 동시에 분리해도 각 창의 핀·링크 그룹·설정과 복귀가 독립적이다', async ({ page, context }) => {
  await installLiveMocks(context);
  await seed(page, 'book');
  await page.goto('/live');
  const firstEvent = page.waitForEvent('popup');
  await page.locator('[data-win="source"]').getByRole('button', { name: '창 분리', exact: true }).click();
  const first = await firstEvent;
  await expect(first.getByTestId('floating-workspace')).toBeVisible();
  const secondEvent = page.waitForEvent('popup');
  await page.locator('[data-win="sibling"]').getByRole('button', { name: '창 분리', exact: true }).click();
  const second = await secondEvent;
  await expect(second.getByTestId('floating-workspace')).toBeVisible();
  await first.getByRole('button', { name: '종목 고정', exact: true }).click();
  await expect(first.getByRole('button', { name: '종목 고정', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore } = await import(path);
    useWorkspaceStore.getState().setGroupSymbol(1, { code: '005930', name: '삼성전자' });
  });
  await expect(second.locator('.live-symbol-name')).toHaveText('삼성전자');
  await expect(first.locator('.live-symbol-name')).toHaveText('고영');
  await first.close();
  await expect(page.locator('[data-win="source"]')).toBeVisible();
  await expect(page.locator('[data-win="sibling"]')).toHaveCount(0);
  await second.close();
  await expect(page.locator('[data-win="sibling"]')).toBeVisible();
  await expect(page.locator('[data-win="source"] .live-symbol-name')).toHaveText('고영');
  await expect(page.locator('[data-win="sibling"] .live-symbol-name')).toHaveText('삼성전자');
});

test('분리된 데이터 창은 본창 차트의 링크와 커서를 계속 수신한다', async ({ page, context }) => {
  await installLiveMocks(context);
  await seed(page, 'vdist');
  await page.goto('/live');
  const popupEvent = page.waitForEvent('popup');
  await page.locator('[data-win="source"]').getByRole('button', { name: '창 분리', exact: true }).click();
  const popup = await popupEvent;
  await expect(popup.getByTestId('floating-workspace')).toBeVisible();
  await expect.poll(() => popup.evaluate(async () => {
    const path = '/src/live/workspace/groupChartLinkSource.ts';
    const { readGroupChartLinks } = await import(path);
    return readGroupChartLinks().find((link: { group: number; windowId: string }) => link.group === 1)?.windowId;
  })).toBe('sibling');
  await page.evaluate(async () => {
    const path = '/src/live/useLiveCursorStore.ts';
    const { useLiveCursorStore } = await import(path);
    useLiveCursorStore.getState().setSidebarCursor(1779840060000, { windowId: 'sibling', group: 1, code: '098460', timeframe: '1m' });
  });
  await expect.poll(() => popup.evaluate(async () => {
    const path = '/src/live/useLiveCursorStore.ts';
    const { useLiveCursorStore } = await import(path);
    return useLiveCursorStore.getState().sidebarCursorMs;
  })).toBe(1779840060000);
  await popup.close();
});

test('저장뷰의 선택 구간은 분리 창에도 유지되고 해제도 본창에 반영된다', async ({ page, context }) => {
  await installLiveMocks(context);
  await seed(page, 'chart');
  await page.goto('/live');
  await page.evaluate(async () => {
    const path = '/src/state/livePage.ts';
    const { useLivePageStore } = await import(path);
    useLivePageStore.setState({ savedRangeRequestSeq: 3, savedRangeFocus: { viewId: 'floating-range', code: '098460', label: '저장 구간',
      fromMs: 1779840000000, toMs: 1779926400000, fromDate: '20260527', toDate: '20260528', savedTimeframe: 'D', savedBarSpan: 2 } });
  });
  const popupEvent = page.waitForEvent('popup');
  await page.locator('[data-win="source"]').getByRole('button', { name: '창 분리', exact: true }).click();
  const popup = await popupEvent;
  await expect(popup.getByTestId('floating-workspace')).toBeVisible();
  await expect.poll(() => popup.evaluate(async () => {
    const path = '/src/state/livePage.ts';
    const { useLivePageStore } = await import(path);
    return useLivePageStore.getState().savedRangeFocus?.viewId;
  })).toBe('floating-range');
  await popup.evaluate(async () => {
    const path = '/src/state/livePage.ts';
    const { useLivePageStore } = await import(path);
    useLivePageStore.getState().clearSavedRange();
  });
  await expect.poll(() => page.evaluate(async () => {
    const path = '/src/state/livePage.ts';
    const { useLivePageStore } = await import(path);
    return useLivePageStore.getState().savedRangeFocus;
  })).toBeNull();
  await popup.close();
});
