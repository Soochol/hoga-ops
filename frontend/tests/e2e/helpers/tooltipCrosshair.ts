import { expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { IChartApi } from 'lightweight-charts';
import { installLiveMocks } from './liveMocks';
import { apiExact } from './apiRoutes';

type Timeframe = '1m' | 'D' | 'W' | 'M';
export type SyncWindow = { id: string; timeframe: Timeframe; code: string; group: number; tooltip: boolean };
type Qa = { verify: (id: string) => { tf: string; group: number; symbol: string }; syncOverlaysAll: () => unknown };
export type SyncBrowser = Window & {
  __liveCharts: Map<string, IChartApi>;
  __qa: Qa;
  __liveCursorStore: { getState: () => { syncCursorMs: number | null; syncCursorOrigin: {
    windowId: string; timeframe: string; group: number; code: string;
  } | null } };
};

const daily = Array.from({ length: 550 }, (_, i) => Date.UTC(2025, 5, 1 + i))
  .filter(t => t <= Date.UTC(2026, 10, 4) && ![0, 6].includes(new Date(t).getUTCDay()))
  .map((t_ms, i) => ({ t_ms, open: 35000 + i * 15, high: 35100 + i * 15,
    low: 34900 + i * 15, close: 35040 + i * 15, volume: 1000 + i }));
const minute = daily.slice(-6).flatMap((d, di) => Array.from({ length: 390 }, (_, i) => ({
  t_ms: d.t_ms + i * 60000, open: 40000 + di * 10 + i / 10, high: 40100 + di * 10 + i / 10,
  low: 39900 + di * 10 + i / 10, close: 40040 + di * 10 + i / 10, volume: 1000 + i,
})));

function calendarCandles(timeframe: 'W' | 'M') {
  const buckets = new Map<string, (typeof daily)[number]>();
  for (const candle of daily) {
    const key = period(candle.t_ms, timeframe);
    const previous = buckets.get(key);
    buckets.set(key, previous ? {
      ...previous, high: Math.max(previous.high, candle.high), low: Math.min(previous.low, candle.low),
      close: candle.close, volume: previous.volume + candle.volume,
    } : { ...candle });
  }
  return [...buckets.values()];
}

const calendar = { W: calendarCandles('W'), M: calendarCandles('M') };

export function syncWindows(sourceTooltip = false, targetTooltip = false): SyncWindow[] {
  return (['1m', 'D', 'W', 'M'] as const).map((timeframe, i) => ({
    id: ['s', 'd', 'w', 'm'][i], timeframe, group: 1, code: i ? '005930' : '098460',
    tooltip: i ? targetTooltip : sourceTooltip,
  }));
}

export async function installSyncWorkspace(page: Page, windows: SyncWindow[], crossSymbol = true) {
  await page.clock.setFixedTime(new Date('2026-11-05T18:00:00+09:00'));
  await page.routeWebSocket(/\/api\/ws/, () => {});
  await installLiveMocks(page);
  for (const [endpoint, candles] of [['live/past-daily-candles', daily], ['live/past-candles', minute]] as const) {
    await page.route(apiExact(endpoint), route => route.fulfill({ json: {
      code: new URL(route.request().url()).searchParams.get('code'), from: '20250601', to: '20261104', candles,
      cached_dates: [], fresh_dates: [], cached_batches: [], fresh_batches: [], data_warnings: [],
    } }));
  }
  await page.route(apiExact('live/past-calendar-candles'), route => {
    const params = new URL(route.request().url()).searchParams;
    const timeframe = params.get('timeframe');
    if (timeframe !== 'W' && timeframe !== 'M') throw new Error(`Unexpected calendar timeframe ${timeframe}`);
    return route.fulfill({ json: {
      code: params.get('code'), timeframe, venue: params.get('venue'),
      from: '20250601', to: '20261104', candles: calendar[timeframe],
      cached_batches: [], fresh_batches: [], data_warnings: [],
    } });
  });
  await page.route(apiExact('live/series'), route => route.fulfill({ json: {
    code: new URL(route.request().url()).searchParams.get('code'), date: '20261104',
    session_open_ms: Date.UTC(2026, 10, 4), session_close_ms: Date.UTC(2026, 10, 4) + 23400000,
    is_open: false, snapshots: [], trades: [], brokers: [],
  } }));
  await page.route(apiExact('range'), route => route.fulfill({ json: {
    code: new URL(route.request().url()).searchParams.get('code'), from_date: '20261104', to_date: '20261104', bucket_ms: 60000,
    segments: [{ date: '20261104', session_open_ms: Date.UTC(2026, 10, 4), session_close_ms: Date.UTC(2026, 10, 4) + 23400000, source: 'hogaplay' }],
    candles: [], quote_ratio: { bucket_ms: 60000, points: [] }, fill_strength: { bucket_ms: 60000, points: [] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [], excluded_dates: [], data_warnings: [],
  } }));
  await page.addInitScript(({ windows, crossSymbol }) => {
    if (sessionStorage.getItem('tooltip-crosshair-seeded')) return;
    sessionStorage.setItem('tooltip-crosshair-seeded', '1');
    localStorage.setItem('hoga.chart.prefs.v1', JSON.stringify({ cursorSyncCrossSymbol: crossSymbol, rangeSyncEnabled: false }));
    localStorage.setItem('hoga.window.settings.v1', JSON.stringify({ schema_version: 1,
      byWindow: Object.fromEntries(windows.map(w => [w.id, { chart: { candleTooltipEnabled: w.tooltip } }])),
    }));
    sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
      windows: windows.map((w, i) => ({ id: w.id, kind: 'chart', group: w.group,
        chart: { timeframe: w.timeframe }, pinned: { code: w.code, name: w.code },
        rect: { x: (i % 2) * .5, y: Math.floor(i / 2) * .5, w: .49, h: .49 } })),
      zOrder: windows.map(w => w.id), groupSymbols: { 1: { code: '098460', name: '고영' }, 2: { code: '098460', name: '고영' } },
    }));
  }, { windows, crossSymbol });
  await page.goto('/live');
  await loadSyncDriver(page);
  for (const win of windows) await verifySyncChart(page, win);
}

export async function loadSyncDriver(page: Page) {
  await page.evaluate(await readFile('../docs/agents/chart-sync-qa.driver.js', 'utf8'));
}

export async function verifySyncChart(page: Page, win: SyncWindow) {
  await expect(page.locator(`[data-win="${win.id}"]`).getByTestId('chart-reveal-cover')).toHaveCSS('opacity', '0');
  await expect.poll(() => page.evaluate(id => {
    const chart = (window as unknown as SyncBrowser).__liveCharts?.get(id);
    return chart?.panes()[0]?.getSeries().some(s => s.seriesType() === 'Candlestick' && s.data().length > 0) ?? false;
  }, win.id)).toBe(true);
  const verified = await page.evaluate(id => {
    const host = window as unknown as SyncBrowser;
    const chart = host.__liveCharts.get(id)!;
    const root = chart.chartElement();
    return { ...host.__qa.verify(id), owner: root.closest<HTMLElement>('[data-win]')?.dataset.win,
      canvases: root.querySelectorAll('canvas').length };
  }, win.id);
  expect(verified).toMatchObject({ tf: win.timeframe, group: win.group, symbol: win.code, owner: win.id });
  expect(verified.canvases).toBeGreaterThan(0);
}

export async function syncPoint(page: Page, win: SyncWindow, pane = 0, whitespace = false) {
  await verifySyncChart(page, win);
  return page.evaluate(({ id, pane, whitespace }) => {
    const chart = (window as unknown as SyncBrowser).__liveCharts.get(id)!;
    const scale = chart.timeScale();
    const series = chart.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!;
    const visible = series.data().map(bar => ({ bar, x: scale.timeToCoordinate(bar.time) }))
      .filter((p): p is typeof p & { x: number } => p.x !== null && p.x > 30 && p.x < scale.width() - 30);
    const selected = visible[Math.floor(visible.length * .65)];
    if (!selected) throw new Error(`no visible candle in ${id}`);
    const top = [...chart.panes()[pane].getHTMLElement()!.querySelectorAll('canvas')]
      .find(canvas => canvas.style.zIndex === '2' && canvas.getBoundingClientRect().width > scale.width() - 2)!;
    const rect = top.getBoundingClientRect();
    const lastX = scale.timeToCoordinate(series.data().at(-1)!.time);
    const x = rect.x + (whitespace ? Math.min(scale.width() - 12, (lastX ?? scale.width()) + 40) : selected.x);
    const y = rect.y + rect.height * .65;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !chart.chartElement().contains(hit)) throw new Error(`pointer blocked over ${id}`);
    if (whitespace && (lastX === null || x - rect.x <= lastX + 5)) throw new Error(`no right whitespace in ${id}`);
    return { x, y, time: selected.bar.time };
  }, { id: win.id, pane, whitespace });
}

export async function hoverSyncChart(page: Page, win: SyncWindow, pane = 0, whitespace = false) {
  const point = await syncPoint(page, win, pane, whitespace);
  await page.mouse.move(point.x, point.y);
  return point;
}

export async function syncBus(page: Page) {
  return page.evaluate(() => {
    const bus = (window as unknown as SyncBrowser).__liveCursorStore.getState();
    return { ms: bus.syncCursorMs, origin: bus.syncCursorOrigin };
  });
}

function period(ms: number, tf: Timeframe) {
  const d = new Date(ms + 9 * 3600000);
  if (tf === 'M') return `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
  if (tf === 'W') d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, 10);
}

export function expectedSyncCandle(ms: number, timeframe: Timeframe) {
  const matches = daily.filter(d => period(d.t_ms, timeframe) === period(ms, timeframe));
  expect(matches.length).toBeGreaterThan(0);
  return { tsMs: matches[0].t_ms, close: matches.at(-1)!.close };
}

export async function syncPixels(page: Page, id: string, close?: number, pane = 0, pointer?: { x: number; y: number }) {
  return page.evaluate(({ id, close, pane, pointer }) => {
    const chart = (window as unknown as SyncBrowser).__liveCharts.get(id)!;
    const scale = chart.timeScale();
    const tops = [...chart.chartElement().querySelectorAll('canvas')].filter(c => c.style.zIndex === '2');
    const plot = [...chart.panes()[pane].getHTMLElement()!.querySelectorAll('canvas')]
      .find(c => c.style.zIndex === '2' && c.getBoundingClientRect().width > scale.width() - 2)!;
    const box = plot.getBoundingClientRect();
    const series = chart.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!;
    const candle = close === undefined ? undefined : series.data().find(b => 'close' in b && b.close === close);
    const expectedX = pointer ? pointer.x - box.x : candle ? scale.timeToCoordinate(candle.time) : null;
    const expectedY = pointer ? pointer.y - box.y : close === undefined ? null : series.priceToCoordinate(close);
    const axes = (kind: 'price' | 'time') => tops.filter(c => {
      const r = c.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (kind === 'price'
        ? r.x >= box.right - 2 && Math.abs(r.y - box.y) < 2 && r.height > 40
        : r.y >= box.bottom && r.height < 40 && r.width > scale.width() - 2);
    });
    const priceAxes = axes('price'), timeAxes = axes('time');
    const ready = box.width > 0 && box.height > 0 && priceAxes.length > 0 && timeAxes.length > 0
      && [plot, ...priceAxes, ...timeAxes].every(c => c.width > 0 && c.height > 0);
    if (!ready) return { ready: false, ink: 0, vertical: 0, horizontal: 0, atX: 0, atY: 0,
      priceAxis: 0, timeAxis: 0, expectedX, expectedY, pointerInside: chart.chartElement().matches(':hover') };
    const data = plot.getContext('2d')!.getImageData(0, 0, plot.width, plot.height).data;
    const columns = new Uint32Array(plot.width), rows = new Uint32Array(plot.height);
    let ink = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]) {
      const pixel = (i - 3) / 4; ink++; columns[pixel % plot.width]++; rows[Math.floor(pixel / plot.width)]++;
    }
    const around = (values: Uint32Array, coordinate: number | null, ratio: number) => coordinate === null ? 0
      : Math.max(0, ...values.slice(Math.max(0, Math.floor(coordinate * ratio) - 2), Math.ceil(coordinate * ratio) + 3));
    const axisInk = (canvases: HTMLCanvasElement[]) => canvases.reduce((sum, c) => {
      const pixels = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) sum++;
      return sum;
    }, 0);
    return { ready: true, ink, vertical: Math.max(0, ...columns), horizontal: Math.max(0, ...rows),
      atX: around(columns, expectedX, plot.width / box.width), atY: around(rows, expectedY, plot.height / box.height),
      priceAxis: axisInk(priceAxes), timeAxis: axisInk(timeAxes), expectedX, expectedY,
      pointerInside: chart.chartElement().matches(':hover') };
  }, { id, close, pane, pointer });
}

export async function expectSyncPaint(page: Page, id: string, visible: boolean, close?: number, pane = 0, pointer?: { x: number; y: number }) {
  if (!visible) {
    await expect.poll(async () => {
      const p = await syncPixels(page, id, close, pane, pointer);
      return [p.ready, p.ink, p.priceAxis, p.timeAxis];
    }).toEqual([true, 0, 0, 0]);
    return;
  }
  await expect.poll(async () => {
    const pixels = await syncPixels(page, id, close, pane, pointer);
    return pixels.ready && pixels.vertical > 15 && pixels.horizontal > 15 && pixels.priceAxis > 0 && pixels.timeAxis > 0
      && ((close === undefined && !pointer) || (pixels.atX > 15 && pixels.atY > 15));
  }).toBe(true);
}

export async function tooltipSwitch(page: Page, id: string) {
  await page.locator(`[data-win="${id}"]`).getByRole('button', { name: '차트 설정', exact: true }).click();
  return page.getByRole('dialog', { name: '차트 설정', exact: true }).getByRole('switch', { name: '캔들 정보 툴팁', exact: true });
}
