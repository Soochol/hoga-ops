import { test, expect } from '@playwright/test';
import type { IChartApi } from 'lightweight-charts';
import { installLiveMocks } from './helpers/liveMocks';

type ChartWindow = Window & { __liveCharts: Map<string, IChartApi> };

test('deep history: cached drag, backfill anchor, native window and latest values', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.clock.setFixedTime(new Date('2026-10-01T17:00:00+09:00'));
  await installLiveMocks(page);
  await page.routeWebSocket(/\/api\/ws/, () => {});
  const day = 86400000;
  const end = Date.UTC(2026, 9, 1);
  const ymd = (t: number) => new Date(t).toISOString().slice(0, 10).replaceAll('-', '');
  const seed = ymd(end - 120 * day);
  const candles = Array.from({ length: 180 }, (_, i) => end - (179 - i) * day)
    .filter(t => ![0, 6].includes(new Date(t).getUTCDay()))
    .flatMap((t, d) => Array.from({ length: 390 }, (_, i) => {
      const price = 35000 + d * 10 + i / 100;
      return { t_ms: t + i * 60000, open: price, high: price + 20, low: price - 20, close: price + 1, volume: i + 100 };
    }));
  let armed = false;
  let requests = 0;
  let release!: () => void;
  const responseGate = new Promise<void>(resolve => { release = resolve; });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/live/past-candles?**', async route => {
    const params = new URL(route.request().url()).searchParams;
    const from = armed ? params.get('from')! : seed;
    const to = armed ? params.get('to')! : ymd(end);
    if (armed) { requests++; await responseGate; }
    await route.fulfill({ json: {
      code: '098460', venue: 'KRX', from, to, bucket_ms: 60000,
      candles: candles.filter(c => ymd(c.t_ms) >= from && ymd(c.t_ms) <= to),
      cached_dates: [], fresh_dates: [], data_warnings: [],
    } });
  });
  await page.goto('/live?code=098460');
  await expect(page.getByTestId('chart-reveal-cover').first()).toHaveCSS('opacity', '0');
  await page.waitForFunction(() => {
    const charts = (window as unknown as ChartWindow).__liveCharts;
    return charts?.size === 1 && [...charts.values()][0].panes()[0].getSeries()
      .some(s => s.seriesType() === 'Candlestick' && s.data().length > 30000);
  });
  // The today-first response above deliberately contains a full cache. Its
  // presence does not mean the initial progressive query has finished yet.
  await expect(page.locator('[data-drawing-overlay]').first()).toHaveAttribute('data-day-extremes-ready', 'true');
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const box = await page.evaluate(() => {
    const chart = [...(window as unknown as ChartWindow).__liveCharts.values()][0];
    chart.timeScale().setVisibleLogicalRange({ from: 1000.25, to: 1150.25 });
    const rect = chart.panes()[0].getHTMLElement()!.getBoundingClientRect();
    return { x: rect.x, y: rect.y, w: chart.timeScale().width(), h: rect.height };
  });
  await expect.poll(() => page.evaluate(() => [...(window as unknown as ChartWindow).__liveCharts.values()][0]
    .timeScale().getVisibleLogicalRange()!.to)).toBeCloseTo(1150.25, 5);
  armed = true;
  const dragSamples: unknown[] = [];
  const drag = async () => {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const start = await page.evaluate(() => {
      const c = [...(window as unknown as ChartWindow).__liveCharts.values()][0];
      const ts = c.timeScale();
      const range = ts.getVisibleLogicalRange()!;
      const s = c.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!;
      const anchor = s.dataByIndex(Math.round((range.from + range.to) / 2), -1) as { time: import('lightweight-charts').Time; close: number };
      return { range, close: anchor.close, x: ts.timeToCoordinate(anchor.time)!, index: ts.timeToIndex(anchor.time) };
    });
    await page.mouse.move(box.x + box.w * .45, box.y + box.h * .6);
    await page.mouse.down();
    await page.mouse.move(box.x + box.w * .7, box.y + box.h * .6, { steps: 10 });
    // Shared union slots may arrive during a gesture even with cached candles.
    // Its global indices then change legitimately; the same dated candle must
    // still move by exactly the pointer's pixel delta.
    const readAnchor = () => page.evaluate(close => {
      const c = [...(window as unknown as ChartWindow).__liveCharts.values()][0];
      const ts = c.timeScale();
      const s = c.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!;
      const anchor = s.data().find(p => 'close' in p && p.close === close)!;
      return { x: ts.timeToCoordinate(anchor.time)!, index: ts.timeToIndex(anchor.time), range: ts.getVisibleLogicalRange()! };
    }, start.close);
    await expect.poll(async () => Math.abs((await readAnchor()).x - (start.x + box.w * .25))).toBeLessThan(1);
    dragSamples.push({ before: start, after: await readAnchor(), pointerDelta: box.w * .25 });
    await page.mouse.up();
    // Wait for the actual debounced viewport handler, including inertia.
    await page.waitForTimeout(300);
  };
  for (let i = 0; i < 5; i++) await drag(); // cross a renderer rewindow while held
  expect(requests).toBe(0); // native window edge is not the full cache edge
  const requestPath = '/src/state/workspace.ts';
  await page.evaluate(async ({ path, from }) => {
    const { useWorkspaceStore } = await import(path);
    const state = useWorkspaceStore.getState();
    const win = state.windows.find((w: { kind: string }) => w.kind === 'chart');
    state.extendChartHistoricalRange(win.id, from);
  }, { path: requestPath, from: ymd(end - 130 * day) });
  await expect.poll(() => requests).toBe(1);
  await drag(); // interaction continues while the response is waiting
  const before = await page.evaluate(() => {
    const c = [...(window as unknown as ChartWindow).__liveCharts.values()][0];
    const ts = c.timeScale();
    const range = ts.getVisibleLogicalRange()!;
    const s = c.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!;
    const anchor = s.dataByIndex(Math.round((range.from + range.to) / 2)) as { time: import('lightweight-charts').Time; close: number };
    return { close: anchor.close, x: ts.timeToCoordinate(anchor.time), range, spacing: ts.options().barSpacing, rows: s.data().length };
  });
  release();
  await expect.poll(() => page.evaluate(() => {
    const c = [...(window as unknown as ChartWindow).__liveCharts.values()][0];
    return c.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!.data().length;
  })).toBeGreaterThan(before.rows);
  const after = await page.evaluate(async before => {
    const c = [...(window as unknown as ChartWindow).__liveCharts.values()][0];
    const ts = c.timeScale();
    const s = c.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!;
    const anchor = s.data().find(p => 'close' in p && p.close === before.close)!;
    const path = '/src/chart/windowedChart.ts';
    const { windowedChartDiagnostics } = await import(path);
    const d = windowedChartDiagnostics(c);
    const native = d.nativeChart as IChartApi;
    const valuesMatch = c.panes().every((pane, i) => pane.getSeries().every((full, j) => {
      const rows = new Map(full.data().map(p => [p.time, p]));
      return native.panes()[i].getSeries()[j].data().every(p => {
        const original = rows.get(p.time)!;
        return ['open', 'high', 'low', 'close', 'value'].every(key => (p as any)[key] === (original as any)[key]);
      });
    }));
    return { x: ts.timeToCoordinate(anchor.time), spacing: ts.options().barSpacing,
      span: ts.getVisibleLogicalRange()!.to - ts.getVisibleLogicalRange()!.from,
      full: d.fullPoints, rendered: d.renderedPoints, valuesMatch, fallback: d.fallback,
    };
  }, before);
  expect(Math.abs(after.x! - before.x!)).toBeLessThan(1);
  expect(after.spacing).toBeCloseTo(before.spacing, 5);
  expect(after.span).toBeCloseTo(before.range.to - before.range.from, 5);
  expect(after.rendered).toBeLessThan(2000);
  expect(after.full).toBeGreaterThan(30000);
  expect(after.valuesMatch).toBe(true);
  expect(after.fallback).toBeNull();
  await page.evaluate(() => {
    const c = [...(window as unknown as ChartWindow).__liveCharts.values()][0];
    const s = c.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!;
    const last = s.dataByIndex(Number.MAX_SAFE_INTEGER, -1)!;
    const latest = c.timeScale().timeToIndex(last.time)!;
    c.timeScale().setVisibleLogicalRange({ from: latest - 150, to: latest + 15 });
  });
  await page.waitForTimeout(300);
  expect(requests).toBe(1);

  // Manual Y scaling still pans vertically after horizontal mouse ownership
  // moves out of lwc. Price-axis zoom/auto-scale controls remain native.
  const vertical = await page.evaluate(() => {
    const c = [...(window as unknown as ChartWindow).__liveCharts.values()][0];
    const s = c.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!;
    const scale = s.priceScale(); scale.setAutoScale(false);
    const range = scale.getVisibleRange()!;
    const top = s.priceToCoordinate(range.to)!;
    const bottom = s.priceToCoordinate(range.from)!;
    return { range, shift: 40 * (range.to - range.from) / (bottom - top) };
  });
  await page.mouse.move(box.x + box.w * .5, box.y + box.h * .5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w * .5, box.y + box.h * .5 + 40, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => [...(window as unknown as ChartWindow).__liveCharts.values()][0]
    .panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!.priceScale().getVisibleRange()!.to))
    .toBeCloseTo(vertical.range.to + vertical.shift, 4);

  // Another window can jump to an offscreen cached timestamp before it has
  // ever rendered that timestamp (the same contract used by range sync).
  await page.evaluate(async path => {
    const { useWorkspaceStore } = await import(path);
    const state = useWorkspaceStore.getState(); state.addWindow('chart');
    const wins = useWorkspaceStore.getState().windows.filter((w: { kind: string }) => w.kind === 'chart');
    useWorkspaceStore.setState({ windows: wins.map((w: any, i: number) => ({ ...w, rect: { x: i / 2, y: 0, w: .5, h: 1 } })) });
    state.setWindowSymbol(wins[1].id, { code: '098460', name: '고영', kind: 'stock' });
  }, requestPath);
  await page.waitForFunction(() => (window as unknown as ChartWindow).__liveCharts.size === 2);
  await expect.poll(() => page.evaluate(async () => {
    const c = [...(window as unknown as ChartWindow).__liveCharts.values()][1];
    const s = c.panes()[0]?.getSeries().find(s => s.seriesType() === 'Candlestick');
    if (!s || s.data().length < 30000) return false;
    const rows = s.data();
    c.timeScale().setVisibleRange({ from: rows[4000].time, to: rows[4150].time });
    const path = '/src/chart/windowedChart.ts';
    const { windowedChartDiagnostics } = await import(path);
    const d = windowedChartDiagnostics(c);
    return d.renderedPoints < 2000 && d.nativeChart.timeScale().timeToIndex(rows[4000].time) !== null;
  })).toBe(true);
  expect(requests).toBe(1);
  expect(errors).toEqual([]);
  await testInfo.attach('drag-date-anchor-samples', { body: JSON.stringify(dragSamples, null, 2), contentType: 'application/json' });
});
