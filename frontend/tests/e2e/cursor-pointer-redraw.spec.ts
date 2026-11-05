import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import {
  expectedSyncCandle, expectSyncPaint, installSyncWorkspace, syncBus, syncPixels, syncPoint,
  syncWindows, type SyncBrowser,
} from './helpers/tooltipCrosshair';

test.use({ viewport: { width: 1800, height: 1100 }, deviceScaleFactor: 1 });

for (const control of [false, true]) {
  test(`actual pointer survives native resize, prior frame=${control}`, async ({ page }, info) => {
    const windows = syncWindows();
    await page.clock.install({ time: new Date('2026-11-05T18:00:00+09:00') });
    await installSyncWorkspace(page, windows);
    const p = await syncPoint(page, windows[0]);
    await page.mouse.move(p.x, p.y);
    await expect.poll(async () => (await syncBus(page)).origin?.windowId).toBe('s');
    await expectSyncPaint(page, 'd', true);
    const q = await syncPoint(page, windows[1]);
    await page.mouse.move(q.x, q.y);
    await expect.poll(async () => (await syncBus(page)).origin?.windowId).toBe('d');
    await expectSyncPaint(page, 'w', true);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50));
    const canvasHeight = () => page.evaluate(() =>
      (window as unknown as SyncBrowser).__liveCharts.get('s')!
        .panes()[0].getHTMLElement()!.querySelector('canvas')!.height);
    const beforeHeight = await canvasHeight();
    await page.mouse.move(p.x, p.y);
    if (control) await page.clock.runFor(64);
    await page.setViewportSize({ width: 1800, height: 1140 });
    await expect.poll(canvasHeight).toBeGreaterThan(beforeHeight);
    await page.clock.runFor(400);

    const bus = await syncBus(page);
    const pixels = Object.fromEntries(await Promise.all(windows.map(async win => {
      const close = win.id !== 's' && bus.ms !== null ? expectedSyncCandle(bus.ms, win.timeframe).close : undefined;
      return [win.id, await syncPixels(page, win.id, close)];
    })));
    const outcome = { control, bus, pixels, p, q, observer: 'none', CDP: false };
    await writeFile(info.outputPath('outcome.json'), JSON.stringify(outcome, null, 2));
    await page.screenshot({ path: info.outputPath('workspace.png') });
    await info.attach('outcome', { body: JSON.stringify(outcome), contentType: 'application/json' });

    expect(bus.origin?.windowId ?? null).toBe('s');
    for (const win of windows) {
      const paint = pixels[win.id];
      expect(paint.ready).toBe(true);
      expect(paint.vertical).toBeGreaterThan(15);
      expect(paint.horizontal).toBeGreaterThan(15);
      expect(paint.priceAxis).toBeGreaterThan(0);
      expect(paint.timeAxis).toBeGreaterThan(0);
      if (win.id !== 's') {
        expect(paint.atX).toBeGreaterThan(15);
        expect(paint.atY).toBeGreaterThan(15);
      }
    }
  });
}
