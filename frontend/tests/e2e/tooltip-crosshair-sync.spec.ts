import { expect, test } from '@playwright/test';
import {
  expectedSyncCandle, expectSyncPaint, hoverSyncChart, installSyncWorkspace, loadSyncDriver,
  syncBus, syncPixels, syncPoint, syncWindows, tooltipSwitch, verifySyncChart,
  type SyncBrowser, type SyncWindow,
} from './helpers/tooltipCrosshair';

test.use({ viewport: { width: 1800, height: 1100 }, deviceScaleFactor: 1, trace: 'on', screenshot: 'on' });
test.setTimeout(120000);

test.afterEach(async ({ page }, info) => {
  await page.screenshot({ path: info.outputPath('workspace.png') });
  await info.attach('cursor-and-pixels', { contentType: 'application/json', body: JSON.stringify(await page.evaluate(() => {
    const host = window as unknown as SyncBrowser;
    const bus = host.__liveCursorStore?.getState();
    return { ms: bus?.syncCursorMs, origin: bus?.syncCursorOrigin, overlays: host.__qa?.syncOverlaysAll() };
  })) });
});

for (const sourceTimeframe of ['1m', 'D'] as const) for (const sourceTooltip of [false, true]) for (const targetTooltip of [false, true]) {
  test(`${sourceTimeframe} source tooltip ${sourceTooltip}, D/W/M target tooltip ${targetTooltip}`, async ({ page }) => {
    const windows = syncWindows(sourceTooltip, targetTooltip);
    windows[0].timeframe = sourceTimeframe;
    await installSyncWorkspace(page, windows);
    const dailyPoint = await hoverSyncChart(page, windows[1]);
    await expectSyncPaint(page, 'd', true, undefined, 0, dailyPoint);
    const ranges = await page.evaluate(() => ['d', 'w', 'm'].map(id =>
      (window as unknown as SyncBrowser).__liveCharts.get(id)!.timeScale().getVisibleLogicalRange()));

    await hoverSyncChart(page, windows[0]);
    await expect.poll(async () => (await syncBus(page)).origin?.windowId).toBe('s');
    const bus = await syncBus(page);
    expect(bus.origin?.timeframe).toBe(sourceTimeframe);
    for (const win of windows.slice(1)) {
      const expected = expectedSyncCandle(bus.ms!, win.timeframe);
      await expectSyncPaint(page, win.id, !targetTooltip, expected.close);
      expect((await syncPixels(page, win.id)).pointerInside).toBe(false);
      await expect(page.locator(`[data-win="${win.id}"]`).getByTestId('pane-legend-rows-candle'))
        .toContainText(expected.close.toLocaleString('en-US'));
      await expect(page.locator(`[data-win="${win.id}"]`).getByTestId('candle-tooltip')).toHaveCount(0);
    }
    expect(await page.evaluate(() => ['d', 'w', 'm'].map(id =>
      (window as unknown as SyncBrowser).__liveCharts.get(id)!.timeScale().getVisibleLogicalRange()))).toEqual(ranges);
    await expect(page.locator('[data-win="s"]').getByTestId('candle-tooltip')).toHaveCount(sourceTooltip ? 1 : 0);
    const indicatorPoint = await hoverSyncChart(page, windows[0], 1);
    await expectSyncPaint(page, 's', true, undefined, 1, indicatorPoint);
  });
}

for (const crossSymbol of [false, true]) {
  test(`Code and group gates with cross-symbol ${crossSymbol}, with a daily positive receiver`, async ({ page }) => {
    const windows = syncWindows();
    windows[1].code = windows[0].code;
    windows[3].group = 2;
    windows[3].code = windows[0].code;
    await installSyncWorkspace(page, windows, crossSymbol);
    const weekPoint = await hoverSyncChart(page, windows[2]);
    await expectSyncPaint(page, 'w', true, undefined, 0, weekPoint);
    const monthPoint = await hoverSyncChart(page, windows[3]);
    await expectSyncPaint(page, 'm', true, undefined, 0, monthPoint);
    await hoverSyncChart(page, windows[0]);
    await expect.poll(async () => (await syncBus(page)).origin?.windowId).toBe('s');
    const bus = await syncBus(page);
    await expectSyncPaint(page, 'd', true, expectedSyncCandle(bus.ms!, 'D').close);
    await expectSyncPaint(page, 'w', crossSymbol, expectedSyncCandle(bus.ms!, 'W').close);
    await expectSyncPaint(page, 'm', false);
    expect((await syncBus(page)).origin).toMatchObject({ windowId: 's', group: 1, code: windows[0].code });
  });
}

test('one move into receiving D/W/M preserves local line and axis pixels while stationary (#2433)', async ({ page }) => {
  const windows = syncWindows();
  await installSyncWorkspace(page, windows);
  for (const target of windows.slice(1)) {
    await hoverSyncChart(page, windows[0]);
    await expect.poll(async () => (await syncBus(page)).origin?.windowId).toBe('s');
    await expectSyncPaint(page, target.id, true);
    const point = await syncPoint(page, target);
    await page.mouse.move(point.x, point.y);
    await expectSyncPaint(page, target.id, true, undefined, 0, point);
    await expect.poll(async () => (await syncBus(page)).origin?.windowId ?? null)
      .toBe(target.timeframe === 'D' ? target.id : null);
    await expectSyncPaint(page, target.id, true, undefined, 0, point);
    expect((await syncPixels(page, target.id)).pointerInside).toBe(true);
  }
});

test('target tooltip toggles immediately by keyboard while source pointer and origin stay unchanged', async ({ page }) => {
  const windows = syncWindows(true, false);
  await installSyncWorkspace(page, windows);
  for (const target of windows.slice(1)) {
    const toggle = await tooltipSwitch(page, target.id);
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await hoverSyncChart(page, windows[0]);
    await expect.poll(async () => (await syncBus(page)).origin?.windowId).toBe('s');
    const bus = await syncBus(page);
    const expected = expectedSyncCandle(bus.ms!, target.timeframe);
    await expectSyncPaint(page, target.id, true, expected.close);
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expectSyncPaint(page, target.id, false);
    expect(await syncBus(page)).toEqual(bus);
    expect((await syncPixels(page, 's')).pointerInside).toBe(true);
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expectSyncPaint(page, target.id, true, expected.close);
    expect(await syncBus(page)).toEqual(bus);
    await page.keyboard.press('Escape');
  }
});

test('daily publication maps into W/M, source whitespace and leave clear remote, W/M hover never publishes', async ({ page }) => {
  const windows = syncWindows(true, false);
  await installSyncWorkspace(page, windows);
  await hoverSyncChart(page, windows[1]);
  await expect.poll(async () => (await syncBus(page)).origin?.windowId).toBe('d');
  const bus = await syncBus(page);
  for (const win of windows.slice(2)) {
    await expectSyncPaint(page, win.id, true, expectedSyncCandle(bus.ms!, win.timeframe).close);
  }
  await hoverSyncChart(page, windows[1], 0, true);
  await expect.poll(async () => (await syncBus(page)).ms).toBeNull();
  for (const id of ['w', 'm']) await expectSyncPaint(page, id, false);
  await hoverSyncChart(page, windows[0]);
  await expect.poll(async () => (await syncBus(page)).origin?.windowId).toBe('s');
  await page.mouse.move(2, 2);
  await expect.poll(async () => (await syncBus(page)).ms).toBeNull();
  for (const id of ['d', 'w', 'm']) await expectSyncPaint(page, id, false);
  for (const win of windows.slice(2)) {
    const point = await hoverSyncChart(page, win);
    await expectSyncPaint(page, win.id, true, undefined, 0, point);
    expect((await syncBus(page)).ms).toBeNull();
  }
});

test('target recreation applies a stationary source after series ready; settings survive reload and new chart inheritance', async ({ page }) => {
  const windows = syncWindows(true, false);
  await installSyncWorkspace(page, windows);
  for (const [timeframe, label] of [['W', '주'], ['M', '월']] as const) {
    const previous = await page.evaluateHandle(() => (window as unknown as SyncBrowser).__liveCharts.get('d'));
    const button = page.locator('[data-win="d"]').getByRole('group', { name: 'LiveTimeframe' })
      .getByRole('button', { name: label, exact: true });
    await hoverSyncChart(page, windows[0]);
    await expect.poll(async () => (await syncBus(page)).origin?.windowId).toBe('s');
    const bus = await syncBus(page);
    await button.focus();
    await page.keyboard.press('Space');
    const recreated: SyncWindow = { ...windows[1], timeframe };
    await verifySyncChart(page, recreated);
    expect(await page.evaluate(old => old !== (window as unknown as SyncBrowser).__liveCharts.get('d'), previous)).toBe(true);
    await expectSyncPaint(page, 'd', true, expectedSyncCandle(bus.ms!, timeframe).close);
    expect(await syncBus(page)).toEqual(bus);
    expect((await syncPixels(page, 's')).pointerInside).toBe(true);
    await previous.dispose();
    windows[1] = recreated;
  }
  const toggle = await tooltipSwitch(page, 'd');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await page.reload();
  await loadSyncDriver(page);
  for (const win of windows) await verifySyncChart(page, win);
  await hoverSyncChart(page, windows[0]);
  await expect.poll(async () => (await syncBus(page)).origin?.windowId).toBe('s');
  await expectSyncPaint(page, 'd', false);
  await expectSyncPaint(page, 'w', true);
  const persistedToggle = await tooltipSwitch(page, 'd');
  await expect(persistedToggle).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  const focusPoint = await syncPoint(page, windows[1]);
  await page.mouse.click(focusPoint.x, focusPoint.y);
  await expect(page.locator('[data-win="d"] .live-window-titlebar')).toHaveAttribute('data-focused', '');
  await page.keyboard.press('n');
  await expect.poll(async () => page.evaluate(() => {
    const host = window as unknown as SyncBrowser;
    return [...host.__liveCharts.keys()].find(id => !['s', 'd', 'w', 'm'].includes(id)) ?? null;
  })).not.toBeNull();
  const id = await page.evaluate(() => [...(window as unknown as SyncBrowser).__liveCharts.keys()]
    .find(id => !['s', 'd', 'w', 'm'].includes(id))!);
  await expect(page.locator(`[data-win="${id}"]`).getByRole('group', { name: 'LiveTimeframe' })
    .getByRole('button', { name: '월', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const inherited = await tooltipSwitch(page, id);
  await expect(inherited).toHaveAttribute('aria-checked', 'true');
});
