import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import type { IChartApi } from 'lightweight-charts';
import { apiExact } from './helpers/apiRoutes';
import { installLiveMocks } from './helpers/liveMocks';
import { WORKTREE_ROOT } from './worktreeEnv';

type ChartWindow = Window & { __liveCharts?: Map<string, IChartApi> };

async function snapshot(page: Page, anchor?: number) {
  return page.evaluate(anchor => {
    const chart = (window as ChartWindow).__liveCharts?.get('kospi-history');
    const series = chart?.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick');
    const rows = series?.data().filter(p => 'close' in p) ?? [];
    const ts = chart?.timeScale();
    const range = ts?.getVisibleLogicalRange();
    const selected = anchor == null
      ? rows.find(p => { const x = ts?.timeToCoordinate(p.time); return x != null && x > 100; })
      : rows.find(p => p.close === anchor);
    return { count: rows.length, anchor: selected?.close,
      x: selected ? ts?.timeToCoordinate(selected.time) : null, spacing: ts?.options().barSpacing,
      visible: rows.filter(p => { const index = ts?.timeToIndex(p.time);
        return index != null && range != null && index >= range.from && index <= range.to;
      }).length };
  }, anchor);
}

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });

test('KOSPI daily candles survive cache eviction after repeated left history drags', async ({ page }, info) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.clock.setFixedTime(new Date('2026-10-04T12:00:00+09:00'));
  await installLiveMocks(page);
  await page.routeWebSocket(/\/api\/ws/, () => {});
  await page.addInitScript(() => sessionStorage.setItem('live.workspace.v1', JSON.stringify({
    schema_version: 2, windows: [{ id: 'kospi-history', group: 1, kind: 'chart',
      chart: { timeframe: 'D' }, rect: { x: 0, y: 0, w: 1, h: 1 } }],
    zOrder: ['kospi-history'], groupSymbols: { 1: { code: 'KOSPI', name: '코스피', kind: 'index' } },
  })));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let initialFrom = '';
  let extensions = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(apiExact('live/index-candles'), async route => {
    const params = new URL(route.request().url()).searchParams;
    const from = params.get('from')!;
    initialFrom ||= from;
    const body = execFileSync('uv', ['run', 'python', 'tests/fixtures/index_history_eviction.py',
      initialFrom, from, params.get('to')!], { cwd: WORKTREE_ROOT, encoding: 'utf8' });
    if (from < initialFrom) { extensions++; await gate; }
    await route.fulfill({ contentType: 'application/json', body });
  });
  await page.goto('/live');
  await expect.poll(async () => (await snapshot(page)).count).toBeGreaterThan(100);
  await expect(page.getByTestId('chart-reveal-cover')).toHaveCSS('opacity', '0');
  const initial = await snapshot(page);
  const box = await page.evaluate(() => {
    const chart = (window as ChartWindow).__liveCharts!.get('kospi-history')!;
    chart.timeScale().setVisibleLogicalRange({ from: 100, to: 200 });
    const rect = chart.panes()[0].getHTMLElement()!.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: chart.timeScale().width(), height: rect.height };
  });
  let drags = 0;
  while (extensions === 0 && drags < 12) {
    await page.mouse.move(box.x + box.width * .35, box.y + box.height * .5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .6, box.y + box.height * .5, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    drags++;
  }
  const before = await snapshot(page);
  release();
  expect(drags).toBeGreaterThan(1);
  expect(extensions).toBeGreaterThan(0);
  await expect.poll(async () => (await snapshot(page)).count).toBeGreaterThan(initial.count);
  const after = await snapshot(page, before.anchor);
  expect(after.visible).toBeGreaterThan(0);
  expect(after.spacing).toBeCloseTo(before.spacing!, 4);
  expect(after.x).not.toBeNull();
  expect(Math.abs(after.x! - before.x!)).toBeLessThan(1);
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath('kospi-history-after-eviction.png') });
});
