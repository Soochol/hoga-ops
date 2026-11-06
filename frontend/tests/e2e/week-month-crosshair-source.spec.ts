import { expect, test } from '@playwright/test';
import type { LivePastDailyCandle } from '../../src/api/livePastDailyCandles';
import {
  expectedSyncCandle, expectSyncCandle, expectSyncPaint, hoverSyncChart, installSyncWorkspace,
  syncBus, syncPixels, syncWindows, tooltipSwitch, verifySyncChart,
  type SyncBrowser, type SyncFixtures, type SyncWindow,
} from './helpers/tooltipCrosshair';

test.use({ viewport: { width: 1800, height: 1100 }, deviceScaleFactor: 1, trace: 'on', screenshot: 'on' });
test.setTimeout(90000);

const ms = (date: string, time = '09:00') => Date.parse(`${date}T${time}:00+09:00`);
const row = (date: string, close: number, time = '09:00'): LivePastDailyCandle => ({
  t_ms: ms(date, time), open: close - 20, high: close + 100, low: close - 100, close, volume: 1000,
});
const current: SyncFixtures = {
  '1m': [row('2026-10-30', 10000), row('2026-11-02', 10100), row('2026-11-02', 10200, '09:07'), row('2026-11-03', 10300)],
  D: [row('2026-10-30', 20000), row('2026-11-02', 20100), row('2026-11-03', 20200)],
  W: [row('2026-10-27', 30000), row('2026-11-02', 30100)],
  M: [row('2026-10-02', 40000), row('2026-11-02', 40100)],
};
const crossing: SyncFixtures = {
  '1m': [row('2026-03-30', 10000), row('2026-03-30', 10100, '09:07'), row('2026-04-01', 10200), row('2026-04-01', 10300, '09:07')],
  D: [row('2026-03-30', 20000), row('2026-04-01', 20100)],
  W: [row('2026-03-23', 30000), row('2026-03-30', 30100)],
  M: [row('2026-03-03', 40000), row('2026-04-01', 40100)],
};

async function frameRows(page: Parameters<typeof syncBus>[0], windows: SyncWindow[]) {
  const expected = await page.evaluate(ids => ids.map(id => {
    const chart = (window as unknown as SyncBrowser).__liveCharts.get(id)!;
    const count = chart.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!.data().length;
    const range = { from: -2, to: count + 2 };
    chart.timeScale().setVisibleLogicalRange(range);
    return range;
  }), windows.map(w => w.id));
  await expect.poll(() => page.evaluate(ids => ids.map(id =>
    (window as unknown as SyncBrowser).__liveCharts.get(id)!.timeScale().getVisibleLogicalRange()), windows.map(w => w.id)))
    .toEqual(expected);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function publish(page: Parameters<typeof syncBus>[0], win: SyncWindow, tsMs: number, pane = 0) {
  const point = await hoverSyncChart(page, win, pane, false, tsMs);
  await expect.poll(() => syncBus(page)).toMatchObject({ ms: tsMs, origin: { windowId: win.id, timeframe: win.timeframe } });
  await expectSyncPaint(page, win.id, true, undefined, pane, point);
  return point;
}

test.afterEach(async ({ page }, info) => {
  await page.screenshot({ path: info.outputPath('workspace.png') });
  await info.attach('sync-bus', { contentType: 'application/json', body: JSON.stringify(await syncBus(page)) });
});

for (const timeframe of ['W', 'M'] as const) for (const sourceTooltip of [false, true]) for (const targetTooltip of [false, true]) {
  test(`${timeframe} actual source tooltip ${sourceTooltip} maps to minute/D/${timeframe === 'W' ? 'M' : 'W'}, target tooltip ${targetTooltip}`, async ({ page }, info) => {
    const windows = syncWindows(sourceTooltip, targetTooltip);
    windows[0].timeframe = timeframe;
    windows[1].timeframe = '1m';
    windows[2].timeframe = 'D';
    windows[3].timeframe = timeframe === 'W' ? 'M' : 'W';
    await installSyncWorkspace(page, windows, true, current);
    await frameRows(page, windows);
    const baselines = await Promise.all(windows.map(w => syncPixels(page, w.id)));
    await info.attach('pre-publication-pixels', { contentType: 'application/json', body: JSON.stringify(baselines) });
    for (const baseline of baselines) expect([baseline.priceAxis, baseline.timeAxis]).toEqual([0, 0]);
    const ranges = await page.evaluate(() => [...(window as unknown as SyncBrowser).__liveCharts.values()]
      .map(chart => chart.timeScale().getVisibleLogicalRange()));
    await publish(page, windows[0], ms('2026-11-02'));
    for (const target of windows.slice(1)) {
      await expectSyncCandle(page, target, expectedSyncCandle(ms('2026-11-02'), target.timeframe, current), !targetTooltip, baselines[windows.indexOf(target)]);
    }
    await expect(page.locator('[data-win="s"]').getByTestId('candle-tooltip')).toHaveCount(sourceTooltip ? 1 : 0);
    expect(await page.evaluate(() => [...(window as unknown as SyncBrowser).__liveCharts.values()]
      .map(chart => chart.timeScale().getVisibleLogicalRange()))).toEqual(ranges);
  });
}

for (const timeframe of ['1m', 'D'] as const) {
  test(`${timeframe} retains minute target behavior with an exact-date positive control`, async ({ page }) => {
    const windows = syncWindows();
    windows[0].timeframe = timeframe;
    windows[1].timeframe = '1m';
    await installSyncWorkspace(page, windows, true, current);
    await frameRows(page, windows);
    await publish(page, windows[0], ms('2026-11-02'));
    const target = timeframe === '1m' ? current['1m'][1] : current['1m'][2];
    await expectSyncCandle(page, windows[1], { tsMs: target.t_ms, close: target.close });
  });
}

for (const timeframe of ['W', 'M'] as const) {
  test(`${timeframe} same-period receiver uses its own noncanonical representative and close`, async ({ page }) => {
    const windows = syncWindows(true, false);
    windows[0].timeframe = timeframe;
    windows[1].timeframe = timeframe;
    const fixtures: SyncFixtures = { ...current, [timeframe]: [current[timeframe][0], row('2026-11-03', 50100)] };
    await installSyncWorkspace(page, windows, true, code => code === windows[0].code ? current : fixtures);
    await frameRows(page, windows);
    await publish(page, windows[0], ms('2026-11-02'));
    await expectSyncCandle(page, windows[1], { tsMs: ms('2026-11-03'), close: 50100 });
  });
}

test('April M retains its point through remote W resize; real W takeover selects March M', async ({ page }) => {
  const windows = syncWindows(false, false);
  windows[0].timeframe = 'M';
  windows[1].timeframe = '1m';
  await installSyncWorkspace(page, windows, true, crossing);
  await frameRows(page, windows);
  await publish(page, windows[0], ms('2026-04-01'));
  const bus = await syncBus(page);
  await expectSyncCandle(page, windows[2], { tsMs: ms('2026-03-30'), close: 30100 });
  await page.setViewportSize({ width: 1800, height: 1140 });
  await expectSyncCandle(page, windows[2], { tsMs: ms('2026-03-30'), close: 30100 });
  expect(await syncBus(page)).toEqual(bus);
  await publish(page, windows[2], ms('2026-03-30'));
  await expectSyncCandle(page, windows[0], { tsMs: ms('2026-03-03'), close: 40000 });
  await expectSyncCandle(page, windows[1], { tsMs: ms('2026-03-30', '09:07'), close: 10100 });
  await page.mouse.move(2, 2);
  await expect.poll(async () => (await syncBus(page)).ms).toBeNull();
});

for (const timeframe of ['W', 'M'] as const) {
  test(`${timeframe} stationary source survives tooltip toggles, receiver recreation, whitespace and same-candle reentry`, async ({ page }) => {
    const windows = syncWindows(false, false);
    windows[0].timeframe = timeframe;
    await installSyncWorkspace(page, windows, true, current);
    await frameRows(page, windows);
    const sourceToggle = await tooltipSwitch(page, 's');
    await publish(page, windows[0], ms('2026-11-02'), 1);
    const bus = await syncBus(page);
    await sourceToggle.focus();
    await page.keyboard.press('Space');
    await expect(sourceToggle).toHaveAttribute('aria-checked', 'true');
    expect(await syncBus(page)).toEqual(bus);
    await page.keyboard.press('Escape');
    const targetToggle = await tooltipSwitch(page, 'd');
    await publish(page, windows[0], ms('2026-11-02'));
    await targetToggle.focus();
    await page.keyboard.press('Space');
    await expectSyncPaint(page, 'd', false);
    expect(await syncBus(page)).toEqual(bus);
    await page.keyboard.press('Space');
    await expectSyncCandle(page, windows[1], expectedSyncCandle(bus.ms!, 'D', current));
    await page.keyboard.press('Escape');
    const button = page.locator('[data-win="d"]').getByRole('group', { name: 'LiveTimeframe' })
      .getByRole('button', { name: '주', exact: true });
    await publish(page, windows[0], ms('2026-11-02'));
    await button.focus();
    await page.keyboard.press('Space');
    const recreated: SyncWindow = { ...windows[1], timeframe: 'W' };
    await verifySyncChart(page, recreated);
    await expectSyncCandle(page, recreated, expectedSyncCandle(bus.ms!, 'W', current));
    expect(await syncBus(page)).toEqual(bus);
    await hoverSyncChart(page, windows[0], 0, true);
    await expect.poll(async () => (await syncBus(page)).ms).toBeNull();
    await publish(page, windows[0], ms('2026-11-02'));
    await page.mouse.move(2, 2);
    await expect.poll(async () => (await syncBus(page)).ms).toBeNull();
    await publish(page, windows[0], ms('2026-11-02'));
  });
}

for (const timeframe of ['W', 'M'] as const) for (const priorFrame of [false, true]) {
  test(`${timeframe} actual pointer survives same-frame native resize (#2439), prior frame ${priorFrame}`, async ({ page }) => {
    const windows = syncWindows();
    windows[0].timeframe = timeframe;
    await page.clock.install({ time: new Date('2026-11-05T18:00:00+09:00') });
    await installSyncWorkspace(page, windows, true, current);
    await frameRows(page, windows);
    const source = await publish(page, windows[0], ms('2026-11-02'));
    await publish(page, windows[1], ms('2026-11-02'));
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50));
    const canvasHeight = () => page.evaluate(() => (window as unknown as SyncBrowser).__liveCharts.get('s')!
      .panes()[0].getHTMLElement()!.querySelector('canvas')!.height);
    const beforeHeight = await canvasHeight();
    await page.mouse.move(source.x, source.y);
    if (priorFrame) await page.clock.runFor(64);
    await page.setViewportSize({ width: 1800, height: 1140 });
    await expect.poll(canvasHeight).toBeGreaterThan(beforeHeight);
    await page.clock.runFor(400);
    expect(await syncBus(page)).toMatchObject({ ms: ms('2026-11-02'), origin: { windowId: 's', timeframe } });
    for (const target of windows.slice(1)) await expectSyncCandle(page, target,
      expectedSyncCandle(ms('2026-11-02'), target.timeframe, current));
  });
}


for (const missing of ['internal', 'outside'] as const) {
  test(`M exact representative date ${missing} in minute/D does not substitute another source-period day`, async ({ page }) => {
    const windows = syncWindows();
    windows[0].timeframe = 'M';
    windows[1].timeframe = '1m';
    windows[2].timeframe = 'D';
    const dates = missing === 'internal' ? ['2026-11-01', '2026-11-03'] : ['2026-11-03', '2026-11-04'];
    const fixtures: SyncFixtures = { ...current,
      '1m': dates.map((date, i) => row(date, 51000 + i * 100)),
      D: dates.map((date, i) => row(date, 61000 + i * 100)),
    };
    await installSyncWorkspace(page, windows, true, fixtures);
    await frameRows(page, windows);
    const baselines = await Promise.all(windows.map(w => syncPixels(page, w.id)));
    await publish(page, windows[0], ms('2026-11-02'));
    for (const target of windows.slice(1, 3)) {
      await expectSyncPaint(page, target.id, false, undefined, 0, undefined, baselines[windows.indexOf(target)]);
      const chip = page.locator(`[data-win="${target.id}"]`).getByTestId('study-cursor-sync');
      if (missing === 'internal') await expect(chip).toHaveCount(0);
      else await expect(chip).toContainText('11/02');
    }
    await expectSyncCandle(page, windows[3], expectedSyncCandle(ms('2026-11-02'), 'M', fixtures));
  });
}

test('W/M ownership survives a foreign leave and unmount, then clears on owner unmount', async ({ page }) => {
  const windows = syncWindows();
  windows[0].timeframe = 'M';
  await installSyncWorkspace(page, windows, true, current);
  await frameRows(page, windows);
  await publish(page, windows[0], ms('2026-11-02'));
  await publish(page, windows[2], ms('2026-11-02'));
  const bus = await syncBus(page);
  await page.evaluate(() => (window as unknown as SyncBrowser).__liveCharts.get('s')!.chartElement()
    .dispatchEvent(new MouseEvent('mouseleave', { bubbles: false })));
  expect(await syncBus(page)).toEqual(bus);
  const foreignClose = page.locator('[data-win="s"]').getByRole('button', { name: /차트 창 닫기$/ });
  await foreignClose.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('[data-win="s"]')).toHaveCount(0);
  expect(await syncBus(page)).toEqual(bus);
  const ownerClose = page.locator('[data-win="w"]').getByRole('button', { name: /차트 창 닫기$/ });
  await ownerClose.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('[data-win="w"]')).toHaveCount(0);
  await expect.poll(async () => (await syncBus(page)).ms).toBeNull();
});
